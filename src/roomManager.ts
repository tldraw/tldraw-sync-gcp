import { RoomSnapshot, TLSocketRoom } from "@tldraw/sync-core";
import {
  type TLRecord,
  createTLSchema,
  defaultShapeSchemas,
} from "@tldraw/tlschema";
import { WebSocket } from "ws";
import { createClient } from "redis";
import { getRoomSnapshot, persistRoomSnapshot } from "./gcsStorage.js";
import throttle from "lodash.throttle";
import { activeRoomsGauge } from "./metrics.js";

// Create the Tldraw schema
const schema = createTLSchema({
  shapes: { ...defaultShapeSchemas },
});

// --- Redis Client Setup ---
const LOCK_TIMEOUT_SEC = 10;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redisClient = createClient({ url: REDIS_URL });

redisClient.on("error", (err) => console.error("[Redis] Client Error", err));

// Connect to Redis immediately
(async () => {
  try {
    await redisClient.connect();
    console.log("[Redis] Connected successfully");
  } catch (err) {
    console.error("[Redis] Could not connect:", err);
    process.exit(1);
  }
})();

// --- Room Manager Class ---

class RoomManager {
  // Holds all room instances that are active on this server pod
  private activeRooms = new Map<string, TLSocketRoom<TLRecord, void>>();

  public async getOrCreateRoom(
    roomId: string,
    ws: WebSocket,
    sessionId: string
  ) {
    let room = this.activeRooms.get(roomId);

    // 1. If room exists locally, connect to it
    if (room) {
      console.log(
        `[RoomManager] Connecting client ${sessionId} to existing room: ${roomId}`
      );
      room.handleSocketConnect({ socket: ws as any, sessionId });
      this.setupSocketCleanup(roomId, ws, room);
      return;
    }

    // 2. If not, try to acquire distributed lock
    const lockKey = `lock:room:${roomId}`;
    try {
      const lockAcquired = await redisClient.set(lockKey, "locked", {
        EX: LOCK_TIMEOUT_SEC,
        NX: true,
      });

      if (!lockAcquired) {
        console.warn(
          `[RoomManager] Lock for room ${roomId} held by another pod. Rejecting.`
        );
        ws.close(1013, "Room is hosted on another server, please retry.");
        return;
      }

      console.log(
        `[RoomManager] Acquired lock for room: ${roomId}. Creating...`
      );

      // 3. Create the new room
      room = await this.createRoom(roomId);
      this.activeRooms.set(roomId, room);
      activeRoomsGauge.inc();
      console.log(`[RoomManager] Room created: ${roomId}`);

      // 4. Connect the client
      room.handleSocketConnect({ socket: ws as any, sessionId });

      // 5. Start Heartbeat to keep the lock alive
      const lockHeartbeat = setInterval(() => {
        redisClient.set(lockKey, "locked", {
          EX: LOCK_TIMEOUT_SEC,
          XX: true, // Only set if it already exists
        });
      }, (LOCK_TIMEOUT_SEC / 2) * 1000);

      // 6. Setup Cleanup
      this.setupSocketCleanup(roomId, ws, room, () => {
        console.log(`[RoomManager] Last client left ${roomId}. Cleaning up.`);
        clearInterval(lockHeartbeat);
        this.activeRooms.delete(roomId);
        redisClient.del(lockKey);
        activeRoomsGauge.dec();
      });
    } catch (err) {
      console.error(`[RoomManager] Error acquiring lock for ${roomId}:`, err);
      ws.close(1011, "Failed to initialize room");
    }
  }

  // Helper to handle socket disconnection and room cleanup
  private setupSocketCleanup(
    roomId: string,
    ws: WebSocket,
    room: TLSocketRoom<TLRecord, void>,
    onEmpty?: () => void
  ) {
    ws.on("close", () => {
      // We verify the room count after a brief tick to ensure the
      // TLSocketRoom has processed the disconnect internally.
      setTimeout(() => {
        // Access internal socket map safely
        const socketCount =
          (room as any).sockets?.size ?? (room as any).allSockets?.size ?? 0;

        if (socketCount === 0 && onEmpty) {
          onEmpty();
        }
      }, 0);
    });
  }

  private async createRoom(
    roomId: string
  ): Promise<TLSocketRoom<TLRecord, void>> {
    const initialSnapshot = await getRoomSnapshot(roomId);

    // We use a "late binding" trick here.
    // 'room' will be undefined when this closure is created,
    // but it will be defined by the time onDataChange actually fires.
    let room: TLSocketRoom<TLRecord, void>;

    const saveToGCSThrottled = throttle(() => {
      if (room) {
        persistRoomSnapshot(roomId, room.getCurrentSnapshot());
      }
    }, 10_000);

    // Create room with the callback defined in the constructor options
    room = new TLSocketRoom<TLRecord, void>({
      schema,
      initialSnapshot,
      onDataChange: () => {
        saveToGCSThrottled();
      },
    });

    return room;
  }
}

export const roomManager = new RoomManager();
