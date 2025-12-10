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

const schema = createTLSchema({
  shapes: { ...defaultShapeSchemas },
});

const LOCK_TIMEOUT_SEC = 10;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redisClient = createClient({ url: REDIS_URL });

redisClient.on("error", () => {});

(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    process.exit(1);
  }
})();

class RoomManager {
  private activeRooms = new Map<string, TLSocketRoom<TLRecord, void>>();

  public async getOrCreateRoom(
    roomId: string,
    ws: WebSocket,
    sessionId: string
  ) {
    let room = this.activeRooms.get(roomId);

    if (room) {
      room.handleSocketConnect({ socket: ws as any, sessionId });
      this.setupSocketCleanup(roomId, ws, room);
      return;
    }

    const lockKey = `lock:room:${roomId}`;
    try {
      const lockAcquired = await redisClient.set(lockKey, "locked", {
        EX: LOCK_TIMEOUT_SEC,
        NX: true,
      });

      if (!lockAcquired) {
        ws.close(1013, "Room is hosted on another server, please retry.");
        return;
      }

      room = await this.createRoom(roomId);
      this.activeRooms.set(roomId, room);
      activeRoomsGauge.inc();

      room.handleSocketConnect({ socket: ws as any, sessionId });

      const lockHeartbeat = setInterval(() => {
        redisClient.set(lockKey, "locked", {
          EX: LOCK_TIMEOUT_SEC,
          XX: true,
        });
      }, (LOCK_TIMEOUT_SEC / 2) * 1000);

      this.setupSocketCleanup(roomId, ws, room, () => {
        clearInterval(lockHeartbeat);
        this.activeRooms.delete(roomId);
        redisClient.del(lockKey);
        activeRoomsGauge.dec();
      });
    } catch (err) {
      ws.close(1011, "Failed to initialize room");
    }
  }

  private setupSocketCleanup(
    roomId: string,
    ws: WebSocket,
    room: TLSocketRoom<TLRecord, void>,
    onEmpty?: () => void
  ) {
    ws.on("close", () => {
      setTimeout(() => {
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

    let room: TLSocketRoom<TLRecord, void>;

    const saveToGCSThrottled = throttle(() => {
      if (room) {
        persistRoomSnapshot(roomId, room.getCurrentSnapshot());
      }
    }, 10_000);

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
