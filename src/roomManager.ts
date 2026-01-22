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

  constructor() {
    this.initHandoverListener();
  }

  // --- Handover Listener ---
  // Listens for requests from other pods to release a room
  private async initHandoverListener() {
    await subClient.subscribe("room-handover", async (message) => {
      try {
        const request: HandoverRequest = JSON.parse(message);

        // If I own the room requested, I must release it immediately
        if (this.activeRooms.has(request.roomId)) {
          await this.releaseRoom(request.roomId);
        }
      } catch (err) {
        console.error("[Handover] Failed to parse message:", err);
      }
    });
  }

  // --- Release Room Logic ---
  // Force saves state and releases the lock so the new owner can take it
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

    // 1. Check Local Memory
    let room = this.activeRooms.get(roomId);
    if (room) {
      room.handleSocketConnect({ socket: safeWs, sessionId });
      this.setupSocketCleanup(roomId, safeWs, room);
      return;
    }

    const lockKey = `lock:room:${roomId}`;

    // 2. Try to Acquire Lock
    const lockAcquired = await redisClient.set(lockKey, POD_NAME, {
      EX: LOCK_TIMEOUT_SEC,
      NX: true,
    });

    // 3. Lock Failed Logic (Handover Trigger)
    if (!lockAcquired) {
      const currentOwner = await redisClient.get(lockKey);

      if (currentOwner === POD_NAME) {
        // I own the lock (likely recovering/restarting), proceed to load.
      } else {
        // Someone else owns it, BUT Nginx routed the user here.
        // This means the Hash Ring changed (Scale Up/Down).
        // I should be the new owner, so I request a handover.

        await pubClient.publish(
          "room-handover",
          JSON.stringify({
            roomId,
            targetPodId: POD_NAME,
          }),
        );

        // Tell client to retry in a moment (Client should have auto-reconnect logic)
        safeWs.close(1013, "Migrating room to new pod... please retry.");
        return;
      }
    }

    // 4. Create Room (Standard Flow)
    try {
      room = await this.createRoom(roomId);
      this.activeRooms.set(roomId, room);
      activeRoomsGauge.inc();

      room.handleSocketConnect({ socket: safeWs, sessionId });

      // Start Heartbeat to keep the lock alive
      const lockHeartbeat = setInterval(() => {
        redisClient.set(lockKey, POD_NAME, {
          EX: LOCK_TIMEOUT_SEC,
          XX: true, // Only update if it exists
        });
      }, HEARTBEAT_INTERVAL_MS);

      this.roomHeartbeats.set(roomId, lockHeartbeat);

      this.setupSocketCleanup(roomId, safeWs, room, () => {
        clearInterval(lockHeartbeat);
        this.roomHeartbeats.delete(roomId);
        this.activeRooms.delete(roomId);
        redisClient.del(lockKey);
        activeRoomsGauge.dec();
      });
    } catch (err) {
      console.error(`[RoomManager] Failed to init room ${roomId}:`, err);
      safeWs.close(1011, "Internal Error");
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
      // Release lock immediately
      promises.push(redisClient.del(`lock:room:${roomId}`).then(() => {}));
    }

    await Promise.allSettled(promises);

    // Close all Redis connections
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
