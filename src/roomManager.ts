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
  handoverRequestsCounter,
  handoverSuccessCounter,
  handoverTimeoutCounter,
  handoverDurationHistogram,
} from "./metrics.js";
import { randomUUID } from "crypto";

// --- Constants ---
const LOCK_TIMEOUT_SEC = 10;
const THROTTLE_SAVE_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = (LOCK_TIMEOUT_SEC / 2) * 1000;
const SOCKET_CLEANUP_DELAY_MS = 2000;
const HANDOVER_TIMEOUT_MS = 5000; // Max time to wait for handover completion
const HANDOVER_CHANNEL_PREFIX = "handover-complete:";

// --- Unique Pod Identity ---
// Ensures every pod instance has a unique ID, preventing "Split Brain"
const BASE_POD_NAME = process.env.HOSTNAME || "TldrawRoomManagerPod";
const POD_NAME = `${BASE_POD_NAME}-${randomUUID().slice(0, 8)}`;

console.log(`[RoomManager] Pod identity: ${POD_NAME}`);

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

// --- Redis Setup ---
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// 1. Client for standard commands (SET, GET, DEL)
const redisClient = createClient({ url: REDIS_URL });
// 2. Client dedicated to room-handover subscriptions
const subClient = redisClient.duplicate();
// 3. Client for publishing
const pubClient = redisClient.duplicate();
// 4. Client for dynamic handover-complete subscriptions (separate to avoid blocking)
const handoverSubClient = redisClient.duplicate();

redisClient.on("error", (err) => console.error("[Redis] Client Error:", err));
subClient.on("error", (err) => console.error("[Redis] Sub Client Error:", err));
pubClient.on("error", (err) => console.error("[Redis] Pub Client Error:", err));
handoverSubClient.on("error", (err) => console.error("[Redis] Handover Sub Client Error:", err));

(async () => {
  try {
    await Promise.all([
      redisClient.connect(),
      subClient.connect(),
      pubClient.connect(),
      handoverSubClient.connect(),
    ]);
    console.log("[Redis] All clients connected successfully");
  } catch (err) {
    console.error("[Redis] CRITICAL: Failed to connect on startup:", err);
    process.exit(1);
  }
})();

class RoomManager {
  private activeRooms = new Map<string, TLSocketRoom<TLRecord, void>>();
  private roomHeartbeats = new Map<string, NodeJS.Timeout>();
  private roomSockets = new Map<string, Set<TldrawWebSocket>>();

  private loadingRooms = new Map<
    string,
    Promise<TLSocketRoom<TLRecord, void>>
  >();

  constructor() {
    this.initHandoverListener();
  }

  // --- Handover Listener ---
  // Listens for requests from other pods wanting to take over a room
  private async initHandoverListener() {
    await subClient.subscribe("room-handover", async (message) => {
      try {
        const request: HandoverRequest = JSON.parse(message);
        console.log(`[Handover] Received request for room ${request.roomId} from ${request.targetPodId}`);
        
        // Only release if WE actually have the room active in memory
        if (this.activeRooms.has(request.roomId)) {
          console.log(`[Handover] We own room ${request.roomId}, initiating release...`);
          await this.releaseRoom(request.roomId);
          console.log(`[Handover] Room ${request.roomId} released successfully`);
        } else {
          console.log(`[Handover] We don't own room ${request.roomId}, ignoring`);
        }
      } catch (err) {
        console.error("[Handover] Failed to process message:", err);
      }
    });
  }

  private async releaseRoom(roomId: string) {
    const room = this.activeRooms.get(roomId);
    if (!room) return;

    const lockKey = `lock:room:${roomId}`;
    const completionChannel = `${HANDOVER_CHANNEL_PREFIX}${roomId}`;
    const sockets = this.roomSockets.get(roomId);
    const socketCount = sockets?.size || 0;

    console.log(`[Handover] Releasing room ${roomId} with ${socketCount} connected users`);

    try {
      const snapshot = room.getCurrentSnapshot();
      if (snapshot) {
        await persistRoomSnapshot(roomId, snapshot);
        console.log(`[Handover] Saved snapshot for room ${roomId}`);
      }

      const heartbeat = this.roomHeartbeats.get(roomId);
      if (heartbeat) clearInterval(heartbeat);
      this.roomHeartbeats.delete(roomId);
      this.activeRooms.delete(roomId);
      activeRoomsGauge.dec();

      await redisClient.del(lockKey);
      console.log(`[Handover] Released lock for room ${roomId}`);

      await pubClient.publish(completionChannel, JSON.stringify({
        roomId,
        previousOwner: POD_NAME,
        timestamp: Date.now(),
      }));
      console.log(`[Handover] Published completion for room ${roomId}`);

      if (sockets && sockets.size > 0) {
        console.log(`[Handover] Closing ${sockets.size} WebSocket connections for room ${roomId}`);
        for (const ws of sockets) {
          try {
            ws.close(1013, "Room migrated to another server, please reconnect");
          } catch (e) {
            // Socket may already be closed
          }
        }
        this.roomSockets.delete(roomId);
      }
      
    } catch (err) {
      console.error(`[Handover] Error releasing room ${roomId}:`, err);
      await pubClient.publish(completionChannel, JSON.stringify({
        roomId,
        previousOwner: POD_NAME,
        error: true,
        timestamp: Date.now(),
      })).catch(() => {});
    }
  }

  private async subscribeToHandoverCompletion(
    roomId: string
  ): Promise<{ wait: () => Promise<boolean>; cleanup: () => void }> {
    const channel = `${HANDOVER_CHANNEL_PREFIX}${roomId}`;
    let resolved = false;
    let resolvePromise: (value: boolean) => void;
    let timeoutId: NodeJS.Timeout;

    const resultPromise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
    });

    const messageHandler = (message: string) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        console.log(`[Handover] Received completion for room ${roomId}`);
        handoverSuccessCounter.inc();
        resolvePromise(true);
      }
    };

    await handoverSubClient.subscribe(channel, messageHandler);

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
      }
      handoverSubClient.unsubscribe(channel).catch(() => {});
    };

    const wait = (): Promise<boolean> => {
      timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.log(`[Handover] Timeout waiting for room ${roomId}`);
          handoverTimeoutCounter.inc();
          handoverSubClient.unsubscribe(channel).catch(() => {});
          resolvePromise(false);
        }
      }, HANDOVER_TIMEOUT_MS);

      return resultPromise;
    };

    return { wait, cleanup };
  }

  // --- Acquire Lock with Coordinated Handover ---
  // Tries to acquire lock, if held by another pod, coordinates handover
  private async acquireLockWithHandover(roomId: string): Promise<boolean> {
    const lockKey = `lock:room:${roomId}`;
    const startTime = Date.now();

    // 1. Try direct acquisition
    const lockAcquired = await redisClient.set(lockKey, POD_NAME, {
      EX: LOCK_TIMEOUT_SEC,
      NX: true,
    });

    if (lockAcquired) {
      console.log(`[Lock] Acquired lock for room ${roomId} (direct)`);
      return true;
    }

    // 2. Lock held by another pod - check who owns it
    const currentOwner = await redisClient.get(lockKey);
    
    // Edge case: we already own it (shouldn't happen, but handle gracefully)
    if (currentOwner === POD_NAME) {
      console.log(`[Lock] We already own lock for room ${roomId}`);
      return true;
    }

    // Edge case: lock expired between SETNX and GET
    if (!currentOwner) {
      const retryAcquired = await redisClient.set(lockKey, POD_NAME, {
        EX: LOCK_TIMEOUT_SEC,
        NX: true,
      });
      if (retryAcquired) {
        console.log(`[Lock] Acquired lock for room ${roomId} (after expiry)`);
        return true;
      }
    }

    console.log(`[Lock] Room ${roomId} owned by ${currentOwner}, initiating handover...`);
    handoverRequestsCounter.inc();

    const subscription = await this.subscribeToHandoverCompletion(roomId);

    await pubClient.publish("room-handover", JSON.stringify({
      roomId,
      targetPodId: POD_NAME,
    }));

    const handoverCompleted = await subscription.wait();
    const duration = (Date.now() - startTime) / 1000;
    handoverDurationHistogram.observe(duration);

    if (handoverCompleted) {
      console.log(`[Lock] Handover completed for room ${roomId} in ${duration.toFixed(2)}s`);
    } else {
      console.log(`[Lock] Handover timeout for room ${roomId}, attempting acquisition anyway...`);
    }

    // 6. Try to acquire lock again
    // Whether handover succeeded or timed out, we try to acquire
    // If timeout, the original owner may have crashed and lock may have expired
    const retryAcquired = await redisClient.set(lockKey, POD_NAME, {
      EX: LOCK_TIMEOUT_SEC,
      NX: true,
    });

    if (retryAcquired) {
      console.log(`[Lock] Acquired lock for room ${roomId} after handover`);
      return true;
    }

    // 7. Still couldn't acquire - another pod beat us to it
    console.log(`[Lock] Failed to acquire lock for room ${roomId} after handover`);
    return false;
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

    let room = this.activeRooms.get(roomId);
    if (room) {
      const currentSockets = this.roomSockets.get(roomId)?.size ?? 0;
      console.log(`[Room] User ${sessionId} joining existing room ${roomId} (${currentSockets} users already connected)`);
      room.handleSocketConnect({ socket: safeWs, sessionId });
      this.setupSocketCleanup(roomId, safeWs, room);
      return;
    }

    // 2. Check Pending Loads (Deduplication)
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
      } catch (err: any) {
        if (err.message === "LOCK_ACQUISITION_FAILED") {
          safeWs.close(1013, "Room is being migrated, please retry.");
        } else {
          console.error("Error waiting for room load:", err);
          safeWs.close(1011, "Room load error");
        }
        return;
      }
    }

    // 3. Start Loading Process (Wrapped in a Promise)
    const loadPromise = (async () => {
      const lockKey = `lock:room:${roomId}`;

      // A. Try to Acquire Lock (with coordinated handover if needed)
      const lockAcquired = await this.acquireLockWithHandover(roomId);

      if (!lockAcquired) {
        // Even after handover attempt, we couldn't get the lock
        // Another pod beat us - client should retry
        throw new Error("LOCK_ACQUISITION_FAILED");
      }

      // B. Create Room
      const newRoom = await this.createRoom(roomId);
      this.activeRooms.set(roomId, newRoom);
      activeRoomsGauge.inc();

      // C. Start Heartbeat to maintain lock
      const lockHeartbeat = setInterval(() => {
        redisClient.set(lockKey, POD_NAME, {
          EX: LOCK_TIMEOUT_SEC,
          XX: true, // Only update if exists (we still own it)
        });
      }, HEARTBEAT_INTERVAL_MS);

      this.roomHeartbeats.set(roomId, lockHeartbeat);

      return newRoom;
    })();

    // 4. Store the promise so concurrent requests can wait
    this.loadingRooms.set(roomId, loadPromise);

    try {
      room = await loadPromise;

      console.log(`[Room] User ${sessionId} created new room ${roomId}`);
      room.handleSocketConnect({ socket: safeWs, sessionId });

      this.setupSocketCleanup(roomId, safeWs, room, () => {
        const heartbeat = this.roomHeartbeats.get(roomId);
        if (heartbeat) clearInterval(heartbeat);
        this.roomHeartbeats.delete(roomId);
        this.activeRooms.delete(roomId);
        this.roomSockets.delete(roomId);
        redisClient.del(`lock:room:${roomId}`);
        activeRoomsGauge.dec();
      });
    } catch (err: any) {
      if (err.message === "LOCK_ACQUISITION_FAILED") {
        safeWs.close(1013, "Room is being migrated, please retry.");
      } else {
        console.error(`[RoomManager] Failed to init room ${roomId}:`, err);
        safeWs.close(1011, "Internal Error");
      }
    } finally {
      // 5. Cleanup the pending promise
      this.loadingRooms.delete(roomId);
    }
  }

  // --- Graceful Shutdown ---
  public async shutdown() {
    console.log(`[RoomManager] Shutting down, saving ${this.activeRooms.size} rooms...`);
    const promises: Promise<void>[] = [];

    for (const [roomId, room] of this.activeRooms) {
      const timer = this.roomHeartbeats.get(roomId);
      if (timer) clearInterval(timer);

      const snapshot = room.getCurrentSnapshot();
      if (snapshot) {
        promises.push(persistRoomSnapshot(roomId, snapshot));
      }
      // Release lock immediately so other pods can acquire
      promises.push(redisClient.del(`lock:room:${roomId}`).then(() => {}));
    }

    await Promise.allSettled(promises);
    console.log("[RoomManager] All rooms saved, closing Redis connections...");
    
    await Promise.all([
      redisClient.quit(),
      subClient.quit(),
      pubClient.quit(),
      handoverSubClient.quit(),
    ]);
    console.log("[RoomManager] Shutdown complete");
  }

  private setupSocketCleanup(
    roomId: string,
    ws: TldrawWebSocket,
    room: TLSocketRoom<TLRecord, void>,
    onEmpty?: () => void,
  ) {
    if (!this.roomSockets.has(roomId)) {
      this.roomSockets.set(roomId, new Set());
    }
    this.roomSockets.get(roomId)!.add(ws);

    ws.on("close", () => {
      this.roomSockets.get(roomId)?.delete(ws);
      room.handleSocketClose(ws.sessionId);
      setTimeout(() => {
        const socketCount = this.roomSockets.get(roomId)?.size ?? 0;
        console.log(`[Room] Socket closed for ${roomId}, remaining sockets: ${socketCount}`);
        if (socketCount === 0 && onEmpty) {
          console.log(`[Room] No sockets remaining, cleaning up room ${roomId}`);
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
