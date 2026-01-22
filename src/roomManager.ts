import { TLSocketRoom } from "@tldraw/sync-core";
import {
  type TLRecord,
  createTLSchema,
  defaultShapeSchemas,
} from "@tldraw/tlschema";
import { WebSocket } from "ws";
import { createClient } from "redis";
import { fetchRoomSnapshot, persistRoomSnapshot } from "./gcsStorage.js";
import throttle from "lodash.throttle";
import { activeRoomsGauge } from "./metrics.js";

// --- Constants ---
const LOCK_TIMEOUT_SEC = 10;
const THROTTLE_SAVE_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = (LOCK_TIMEOUT_SEC / 2) * 1000;
const SOCKET_CLEANUP_DELAY_MS = 2000;
const POD_NAME = process.env.POD_NAME || "unknown-pod";

// --- Interfaces ---
interface TldrawWebSocket extends WebSocket {
  sessionId: string;
  roomId: string;
  isAlive: boolean;
}

interface HandoverRequest {
  roomId: string;
  targetPodId: string;
}

const schema = createTLSchema({
  shapes: { ...defaultShapeSchemas },
});

// --- Redis Setup (Dual Connections for Pub/Sub) ---
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// 1. Client for standard commands (SET, GET, SETNX)
const redisClient = createClient({ url: REDIS_URL });
// 2. Client dedicated to subscriptions (Blocking)
const subClient = redisClient.duplicate();
// 3. Client for publishing
const pubClient = redisClient.duplicate();

redisClient.on("error", (err) => console.error("[Redis] Client Error:", err));
subClient.on("error", (err) => console.error("[Redis] Sub Client Error:", err));

(async () => {
  try {
    await Promise.all([
      redisClient.connect(),
      subClient.connect(),
      pubClient.connect(),
    ]);
  } catch (err) {
    console.error("[Redis] CRITICAL: Failed to connect on startup:", err);
    process.exit(1);
  }
})();

class RoomManager {
  private activeRooms = new Map<string, TLSocketRoom<TLRecord, void>>();
  private roomHeartbeats = new Map<string, NodeJS.Timeout>();

  // NEW: Cache to deduplicate concurrent loading requests
  private loadingRooms = new Map<
    string,
    Promise<TLSocketRoom<TLRecord, void>>
  >();

  constructor() {
    this.initHandoverListener();
  }

  // --- Handover Listener ---
  private async initHandoverListener() {
    await subClient.subscribe("room-handover", async (message) => {
      try {
        const request: HandoverRequest = JSON.parse(message);
        if (this.activeRooms.has(request.roomId)) {
          await this.releaseRoom(request.roomId);
        }
      } catch (err) {
        console.error("[Handover] Failed to parse message:", err);
      }
    });
  }

  // --- Release Room Logic ---
  private async releaseRoom(roomId: string) {
    const room = this.activeRooms.get(roomId);
    if (!room) return;

    // 1. Force Save Snapshot to GCS
    const snapshot = room.getCurrentSnapshot();
    if (snapshot) {
      await persistRoomSnapshot(roomId, snapshot);
    }

    // 2. Cleanup Memory and Heartbeats
    const heartbeat = this.roomHeartbeats.get(roomId);
    if (heartbeat) clearInterval(heartbeat);
    this.roomHeartbeats.delete(roomId);
    this.activeRooms.delete(roomId);
    activeRoomsGauge.dec();

    // 3. Delete the Lock from Redis
    const lockKey = `lock:room:${roomId}`;
    await redisClient.del(lockKey);
  }

  public async getOrCreateRoom(
    roomId: string,
    ws: WebSocket,
    sessionId: string,
  ) {
    const safeWs = ws as TldrawWebSocket;
    safeWs.sessionId = sessionId;
    safeWs.roomId = roomId;
    safeWs.isAlive = true;

    safeWs.on("pong", () => {
      safeWs.isAlive = true;
    });

    // 1. Check Local Memory (Fast Path)
    let room = this.activeRooms.get(roomId);
    if (room) {
      room.handleSocketConnect({ socket: safeWs, sessionId });
      this.setupSocketCleanup(roomId, safeWs, room);
      return;
    }

    // 2. Check Pending Loads (Deduplication Fix)
    // If another client is already loading this room, wait for their promise!
    if (this.loadingRooms.has(roomId)) {
      try {
        room = await this.loadingRooms.get(roomId);
        if (room) {
          room.handleSocketConnect({ socket: safeWs, sessionId });
          this.setupSocketCleanup(roomId, safeWs, room);
        } else {
          safeWs.close(1011, "Room load failed");
        }
        return;
      } catch (err) {
        console.error("Error waiting for room load:", err);
        safeWs.close(1011, "Room load error");
        return;
      }
    }

    // 3. Start Loading Process (Wrapped in a Promise)
    const loadPromise = (async () => {
      const lockKey = `lock:room:${roomId}`;

      // A. Try to Acquire Lock
      const lockAcquired = await redisClient.set(lockKey, POD_NAME, {
        EX: LOCK_TIMEOUT_SEC,
        NX: true,
      });

      // B. Lock Failed Logic
      if (!lockAcquired) {
        const currentOwner = await redisClient.get(lockKey);

        // If I don't own it, trigger Handover
        if (currentOwner !== POD_NAME) {
          await pubClient.publish(
            "room-handover",
            JSON.stringify({
              roomId,
              targetPodId: POD_NAME,
            }),
          );
          // Throwing allows us to catch it below and close the socket
          throw new Error("MIGRATION_NEEDED");
        }
      }

      // C. Create Room (Only one execution per pod reaches here)
      const newRoom = await this.createRoom(roomId);
      this.activeRooms.set(roomId, newRoom);
      activeRoomsGauge.inc();

      // Start Heartbeat
      const lockHeartbeat = setInterval(() => {
        redisClient.set(lockKey, POD_NAME, {
          EX: LOCK_TIMEOUT_SEC,
          XX: true,
        });
      }, HEARTBEAT_INTERVAL_MS);

      this.roomHeartbeats.set(roomId, lockHeartbeat);

      return newRoom;
    })();

    // 4. Store the promise so others can wait
    this.loadingRooms.set(roomId, loadPromise);

    try {
      room = await loadPromise;

      // Connect the socket (The FIRST user)
      room.handleSocketConnect({ socket: safeWs, sessionId });

      this.setupSocketCleanup(roomId, safeWs, room, () => {
        const heartbeat = this.roomHeartbeats.get(roomId);
        if (heartbeat) clearInterval(heartbeat);
        this.roomHeartbeats.delete(roomId);
        this.activeRooms.delete(roomId);
        redisClient.del(`lock:room:${roomId}`);
        activeRoomsGauge.dec();
      });
    } catch (err: any) {
      if (err.message === "MIGRATION_NEEDED") {
        safeWs.close(1013, "Migrating room to new pod... please retry.");
      } else {
        console.error(`[RoomManager] Failed to init room ${roomId}:`, err);
        safeWs.close(1011, "Internal Error");
      }
    } finally {
      // 5. Cleanup the pending promise
      this.loadingRooms.delete(roomId);
    }
  }

  // Graceful Shutdown
  public async shutdown() {
    const promises: Promise<void>[] = [];

    for (const [roomId, room] of this.activeRooms) {
      const timer = this.roomHeartbeats.get(roomId);
      if (timer) clearInterval(timer);

      const snapshot = room.getCurrentSnapshot();
      if (snapshot) {
        promises.push(persistRoomSnapshot(roomId, snapshot));
      }
      promises.push(redisClient.del(`lock:room:${roomId}`).then(() => {}));
    }

    await Promise.allSettled(promises);
    await Promise.all([redisClient.quit(), subClient.quit(), pubClient.quit()]);
  }

  private setupSocketCleanup(
    roomId: string,
    ws: TldrawWebSocket,
    room: TLSocketRoom<TLRecord, void>,
    onEmpty?: () => void,
  ) {
    ws.on("close", () => {
      room.handleSocketClose(ws.sessionId);
      setTimeout(() => {
        const socketCount =
          (room as any).sockets?.size ?? (room as any).allSockets?.size ?? 0;
        if (socketCount === 0 && onEmpty) {
          onEmpty();
        }
      }, SOCKET_CLEANUP_DELAY_MS);
    });
  }

  private async createRoom(
    roomId: string,
  ): Promise<TLSocketRoom<TLRecord, void>> {
    const initialSnapshot = await fetchRoomSnapshot(roomId);
    let room: TLSocketRoom<TLRecord, void>;

    const saveToGCSThrottled = throttle(() => {
      if (room) {
        const snapshot = room.getCurrentSnapshot();
        if (snapshot) persistRoomSnapshot(roomId, snapshot);
      }
    }, THROTTLE_SAVE_MS);

    room = new TLSocketRoom<TLRecord, void>({
      schema,
      initialSnapshot: initialSnapshot || undefined,
      onDataChange: () => saveToGCSThrottled(),
    });
    return room;
  }
}

export const roomManager = new RoomManager();
