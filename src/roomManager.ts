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

// --- Interfaces ---
interface TldrawWebSocket extends WebSocket {
  sessionId: string;
  roomId: string;
  isAlive: boolean;
}

const schema = createTLSchema({
  shapes: { ...defaultShapeSchemas },
});

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const redisClient = createClient({ url: REDIS_URL });

redisClient.on("error", (err) => {
  console.error("[Redis] Client Error:", err);
});

(async () => {
  try {
    await redisClient.connect();
    console.log("[Redis] Connected successfully.");
  } catch (err) {
    console.error("[Redis] CRITICAL: Failed to connect on startup:", err);
    process.exit(1);
  }
})();

class RoomManager {
  private activeRooms = new Map<string, TLSocketRoom<TLRecord, void>>();
  private roomHeartbeats = new Map<string, NodeJS.Timeout>();

  public async getOrCreateRoom(
    roomId: string,
    ws: WebSocket,
    sessionId: string
  ) {
    const safeWs = ws as TldrawWebSocket;
    safeWs.sessionId = sessionId;
    safeWs.roomId = roomId;
    safeWs.isAlive = true;

    safeWs.on("pong", () => {
      safeWs.isAlive = true;
    });

    let room = this.activeRooms.get(roomId);

    if (room) {
      room.handleSocketConnect({ socket: safeWs, sessionId });
      this.setupSocketCleanup(roomId, safeWs, room);
      return;
    }

    const lockKey = `lock:room:${roomId}`;
    try {
      const lockAcquired = await redisClient.set(lockKey, "locked", {
        EX: LOCK_TIMEOUT_SEC,
        NX: true,
      });

      if (!lockAcquired) {
        safeWs.close(1013, "Room is hosted on another server, please retry.");
        return;
      }

      room = await this.createRoom(roomId);
      this.activeRooms.set(roomId, room);
      activeRoomsGauge.inc();

      room.handleSocketConnect({ socket: safeWs, sessionId });

      // Start Heartbeat to keep lock alive
      const lockHeartbeat = setInterval(() => {
        redisClient.set(lockKey, "locked", {
          EX: LOCK_TIMEOUT_SEC,
          XX: true,
        });
      }, HEARTBEAT_INTERVAL_MS);

      this.roomHeartbeats.set(roomId, lockHeartbeat);

      this.setupSocketCleanup(roomId, safeWs, room, () => {
        clearInterval(lockHeartbeat);
        this.roomHeartbeats.delete(roomId); // Clean up map
        this.activeRooms.delete(roomId);
        redisClient.del(lockKey);
        activeRoomsGauge.dec();
      });
    } catch (err) {
      console.error(`[RoomManager] Failed to initialize room ${roomId}:`, err);
      safeWs.close(1011, "Failed to initialize room");
    }
  }

  // NEW: Graceful Shutdown Method
  public async shutdown() {
    console.log(
      `[RoomManager] Starting shutdown for ${this.activeRooms.size} rooms...`
    );

    const promises: Promise<void>[] = [];

    for (const [roomId, room] of this.activeRooms) {
      // 1. Stop the heartbeat so lock doesn't auto-renew
      const timer = this.roomHeartbeats.get(roomId);
      if (timer) clearInterval(timer);

      // 2. Force save current state to GCS
      const snapshot = room.getCurrentSnapshot();
      if (snapshot) {
        console.log(`[RoomManager] Saving snapshot for room: ${roomId}`);
        promises.push(persistRoomSnapshot(roomId, snapshot));
      }

      // 3. Release Redis Lock immediately so other pods can pick it up
      promises.push(redisClient.del(`lock:room:${roomId}`).then(() => {}));
    }

    // Wait for all saves and unlocks to finish
    await Promise.allSettled(promises);

    // Close Redis connection
    await redisClient.quit();
    console.log("[RoomManager] Shutdown complete. Redis disconnected.");
  }

  private setupSocketCleanup(
    roomId: string,
    ws: TldrawWebSocket,
    room: TLSocketRoom<TLRecord, void>,
    onEmpty?: () => void
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
    roomId: string
  ): Promise<TLSocketRoom<TLRecord, void>> {
    const initialSnapshot = await fetchRoomSnapshot(roomId);
    let room: TLSocketRoom<TLRecord, void>;

    const saveToGCSThrottled = throttle(() => {
      if (room) {
        const snapshot = room.getCurrentSnapshot();
        if (snapshot) {
          persistRoomSnapshot(roomId, snapshot);
        }
      }
    }, THROTTLE_SAVE_MS);

    room = new TLSocketRoom<TLRecord, void>({
      schema,
      initialSnapshot: initialSnapshot || undefined,
      onDataChange: () => {
        saveToGCSThrottled();
      },
    });

    return room;
  }
}

export const roomManager = new RoomManager();
