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
import {
  activeRoomsGauge,
  proxyConnectionsCounter,
  proxyErrorsCounter,
} from "./metrics.js";

const LOCK_TIMEOUT_SEC = 10;
const THROTTLE_SAVE_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = (LOCK_TIMEOUT_SEC / 2) * 1000;
const SOCKET_CLEANUP_DELAY_MS = 2000;
const DRAIN_CHECK_INTERVAL_MS = 1000;
const MAX_DRAIN_WAIT_BEFORE_TERMINATION_MS = 270_000;
const PROXY_HANDSHAKE_TIMEOUT_MS = 5000;

const POD_NAME = process.env.POD_NAME || `local-${process.pid}`;
const POD_NAMESPACE = process.env.POD_NAMESPACE || "default";
const HEADLESS_SERVICE = process.env.HEADLESS_SERVICE || "tldraw-sync-headless";

function getPodAddress(): string {
  return `${POD_NAME}.${HEADLESS_SERVICE}.${POD_NAMESPACE}.svc.cluster.local`;
}

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
  private _isShuttingDown = false;

  public get isShuttingDown(): boolean {
    return this._isShuttingDown;
  }

  public getActiveRoomCount(): number {
    return this.activeRooms.size;
  }

  public async getOrCreateRoom(
    roomId: string,
    ws: WebSocket,
    sessionId: string,
    isProxied: boolean = false
  ): Promise<void> {
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
    const myAddress = getPodAddress();

    try {
      const lockAcquired = await redisClient.set(lockKey, myAddress, {
        EX: LOCK_TIMEOUT_SEC,
        NX: true,
      });

      if (!lockAcquired) {
        const ownerAddress = await redisClient.get(lockKey);

        if (!ownerAddress) {
          return this.getOrCreateRoom(roomId, ws, sessionId, isProxied);
        }

        if (ownerAddress === myAddress) {
          const existingRoom = this.activeRooms.get(roomId);
          if (existingRoom) {
            existingRoom.handleSocketConnect({ socket: safeWs, sessionId });
            this.setupSocketCleanup(roomId, safeWs, existingRoom);
            return;
          }
        }

        if (isProxied) {
          console.error(`[RoomManager] Proxy loop detected for room ${roomId}. Owner: ${ownerAddress}, Me: ${myAddress}`);
          safeWs.close(1011, "Proxy loop detected");
          return;
        }

        this.proxyToOwner(ownerAddress, roomId, safeWs, sessionId);
        return;
      }

      room = await this.createRoom(roomId);
      this.activeRooms.set(roomId, room);
      activeRoomsGauge.inc();

      room.handleSocketConnect({ socket: safeWs, sessionId });

      const lockHeartbeat = setInterval(() => {
        redisClient.set(lockKey, myAddress, {
          EX: LOCK_TIMEOUT_SEC,
          XX: true,
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
      console.error(`[RoomManager] Failed to initialize room ${roomId}:`, err);
      safeWs.close(1011, "Failed to initialize room");
    }
  }

  public async shutdown(): Promise<void> {
    this._isShuttingDown = true;
    console.log(
      `[RoomManager] Starting graceful drain with ${this.activeRooms.size} active rooms...`
    );

    if (this.activeRooms.size > 0) {
      await this.waitForRoomsToDrain();
    }

    await this.finalizeShutdown();
  }

  private waitForRoomsToDrain(): Promise<void> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const remaining = this.activeRooms.size;

        console.log(
          `[RoomManager] Draining: ${remaining} rooms remaining, ${Math.round(elapsed / 1000)}s elapsed`
        );

        if (remaining === 0) {
          clearInterval(checkInterval);
          console.log("[RoomManager] All rooms drained. Proceeding with shutdown.");
          resolve();
          return;
        }

        if (elapsed >= MAX_DRAIN_WAIT_BEFORE_TERMINATION_MS) {
          clearInterval(checkInterval);
          console.log(
            `[RoomManager] Drain timeout reached (${MAX_DRAIN_WAIT_BEFORE_TERMINATION_MS / 1000}s). Force shutting down ${remaining} rooms.`
          );
          resolve();
        }
      }, DRAIN_CHECK_INTERVAL_MS);
    });
  }

  private async finalizeShutdown(): Promise<void> {
    console.log(`[RoomManager] Finalizing shutdown for ${this.activeRooms.size} remaining rooms...`);

    const promises: Promise<void>[] = [];

    for (const [roomId, room] of this.activeRooms) {
      const timer = this.roomHeartbeats.get(roomId);
      if (timer) clearInterval(timer);

      const snapshot = room.getCurrentSnapshot();
      if (snapshot) {
        console.log(`[RoomManager] Saving snapshot for room: ${roomId}`);
        promises.push(persistRoomSnapshot(roomId, snapshot));
      }

      promises.push(redisClient.del(`lock:room:${roomId}`).then(() => {}));
    }

    await Promise.allSettled(promises);
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

  private proxyToOwner(
    ownerAddress: string,
    roomId: string,
    clientWs: TldrawWebSocket,
    sessionId: string
  ): void {
    const targetUrl = `ws://${ownerAddress}:3001/api/connect/${roomId}?sessionId=${sessionId}&proxied=true`;
    const targetWs = new WebSocket(targetUrl, {
      handshakeTimeout: PROXY_HANDSHAKE_TIMEOUT_MS,
    });

    let isConnected = false;

    targetWs.on("open", () => {
      isConnected = true;
      proxyConnectionsCounter.inc();
      console.log(`[Proxy] Connected to owner ${ownerAddress} for room ${roomId}`);

      clientWs.on("message", (data, isBinary) => {
        if (targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(data, { binary: isBinary });
        }
      });

      targetWs.on("message", (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });
    });

    clientWs.on("close", (code, reason) => {
      if (targetWs.readyState === WebSocket.OPEN || targetWs.readyState === WebSocket.CONNECTING) {
        targetWs.close(code, reason);
      }
    });

    targetWs.on("close", (code, reason) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(code, reason);
      }
    });

    targetWs.on("error", async (err) => {
      proxyErrorsCounter.inc();
      console.error(`[Proxy] Failed to connect to ${ownerAddress} for room ${roomId}:`, err.message);

      if (!isConnected) {
        await redisClient.del(`lock:room:${roomId}`);
        clientWs.close(1013, "Room owner unreachable, please reconnect");
      }
    });

    clientWs.on("error", (err) => {
      console.error(`[Proxy] Client WebSocket error for room ${roomId}:`, err.message);
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.close(1011, "Client connection error");
      }
    });
  }
}

export const roomManager = new RoomManager();
