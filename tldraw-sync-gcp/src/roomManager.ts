import { TLSocketRoom } from "@tldraw/sync-core"
import { type TLRecord, createTLSchema, defaultShapeSchemas } from "@tldraw/tlschema"
import { WebSocket } from "ws"
import { createClient } from "redis"
import { fetchRoomSnapshot, persistRoomSnapshot } from "./gcsStorage.js"
import throttle from "lodash.throttle"
import {
  activeRoomsGauge,
  handoverRequestsCounter,
  handoverSuccessCounter,
  handoverTimeoutCounter,
  handoverDurationHistogram,
  lockLostCounter,
} from "./metrics.js"
import { randomUUID } from "crypto"

// --- Constants ---
const LOCK_TIMEOUT_SEC = 10
const THROTTLE_SAVE_MS = 10_000
const HEARTBEAT_INTERVAL_MS = (LOCK_TIMEOUT_SEC / 2) * 1000
const HANDOVER_TIMEOUT_MS = 5000
const HANDOVER_READY_TIMEOUT_MS = 10000

const CHANNEL_HANDOVER_REQUEST = "room-handover"
const CHANNEL_LOCK_RELEASED_PREFIX = "handover-lock-released:"
const CHANNEL_READY_PREFIX = "handover-ready:"

// --- Unique Pod Identity ---
// Ensures every pod instance has a unique ID, preventing "Split Brain"
const BASE_POD_NAME = process.env.HOSTNAME || "TldrawRoomManagerPod"
const POD_NAME = `${BASE_POD_NAME}-${randomUUID().slice(0, 8)}`

console.log(`[RoomManager] Pod identity: ${POD_NAME}`)

// --- Interfaces ---
interface TldrawWebSocket extends WebSocket {
  sessionId: string
  roomId: string
  isAlive: boolean
}

interface HandoverRequest {
  roomId: string
  targetPodId: string
}

const schema = createTLSchema({
  shapes: { ...defaultShapeSchemas },
})

// --- Redis Setup ---
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379"

// 1. Client for standard commands (SET, GET, DEL)
const redisClient = createClient({ url: REDIS_URL })
// 2. Client dedicated to room-handover subscriptions
const subClient = redisClient.duplicate()
// 3. Client for publishing
const pubClient = redisClient.duplicate()
// 4. Client for dynamic handover-complete subscriptions (separate to avoid blocking)
const handoverSubClient = redisClient.duplicate()

redisClient.on("error", (err) => console.error("[Redis] Client Error:", err))
subClient.on("error", (err) => console.error("[Redis] Sub Client Error:", err))
pubClient.on("error", (err) => console.error("[Redis] Pub Client Error:", err))
handoverSubClient.on("error", (err) => console.error("[Redis] Handover Sub Client Error:", err))
;(async () => {
  try {
    await Promise.all([
      redisClient.connect(),
      subClient.connect(),
      pubClient.connect(),
      handoverSubClient.connect(),
    ])
    console.log("[Redis] All clients connected successfully")
  } catch (err) {
    console.error("[Redis] CRITICAL: Failed to connect on startup:", err)
    process.exit(1)
  }
})()

const lockKey = (roomId: string) => `lock:room:${roomId}`

// Redis has no compare-and-set, so renewing and releasing a Room Lock run as
// Lua: read the owner and act on it in one atomic step.
//
// `SET key POD_NAME EX n XX` is NOT good enough for renewal. XX asserts only
// that the key exists, not that we still hold it — so if our lease lapses and
// another pod acquires the Room, an XX renewal overwrites their lock with our
// name and both pods believe they own the Room. Likewise a bare DEL on release
// can drop a lock that now belongs to someone else.
const RENEW_IF_OWNER = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  else
    return 0
  end`

const RELEASE_IF_OWNER = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  else
    return 0
  end`

/** Extends our lease. False means the lock is gone or owned by another pod. */
async function renewLockIfOwner(roomId: string): Promise<boolean> {
  const result = await redisClient.eval(RENEW_IF_OWNER, {
    keys: [lockKey(roomId)],
    arguments: [POD_NAME, String(LOCK_TIMEOUT_SEC * 1000)],
  })
  return result === 1
}

/** Releases our lease. False means it had already lapsed or been taken over. */
async function releaseLockIfOwner(roomId: string): Promise<boolean> {
  const result = await redisClient.eval(RELEASE_IF_OWNER, {
    keys: [lockKey(roomId)],
    arguments: [POD_NAME],
  })
  return result === 1
}

class RoomManager {
  private activeRooms = new Map<string, TLSocketRoom<TLRecord, void>>()
  private roomHeartbeats = new Map<string, NodeJS.Timeout>()
  // Track raw WebSockets for handover (need to close with 1013)
  private roomSockets = new Map<string, Set<TldrawWebSocket>>()
  // Throttled snapshot writers, kept so they can be cancelled the moment we
  // stop owning a Room — a pending trailing save would otherwise land on top
  // of the next owner's state.
  private roomSaves = new Map<string, { cancel: () => void }>()

  private loadingRooms = new Map<string, Promise<TLSocketRoom<TLRecord, void>>>()

  constructor() {
    this.initHandoverListener()
  }

  // --- Handover Listener ---
  // Listens for requests from other pods wanting to take over a room
  private async initHandoverListener() {
    await subClient.subscribe("room-handover", async (message) => {
      try {
        const request: HandoverRequest = JSON.parse(message)
        console.log(
          `[Handover] Received request for room ${request.roomId} from ${request.targetPodId}`,
        )

        // Only release if WE actually have the room active in memory
        if (this.activeRooms.has(request.roomId)) {
          console.log(`[Handover] We own room ${request.roomId}, initiating release...`)
          await this.releaseRoom(request.roomId)
          console.log(`[Handover] Room ${request.roomId} released successfully`)
        } else {
          console.log(`[Handover] We don't own room ${request.roomId}, ignoring`)
        }
      } catch (err) {
        console.error("[Handover] Failed to process message:", err)
      }
    })
  }

  private async releaseRoom(roomId: string) {
    const room = this.activeRooms.get(roomId)
    if (!room) return

    const lockReleasedChannel = `${CHANNEL_LOCK_RELEASED_PREFIX}${roomId}`
    const readyChannel = `${CHANNEL_READY_PREFIX}${roomId}`
    const sockets = this.roomSockets.get(roomId)
    const socketCount = sockets?.size || 0

    console.log(`[Handover] Phase 1: Releasing room ${roomId} with ${socketCount} connected users`)

    try {
      const snapshot = room.getCurrentSnapshot()
      if (snapshot) {
        await persistRoomSnapshot(roomId, snapshot)
        console.log(`[Handover] Saved snapshot for room ${roomId}`)
      }

      this.dropRoom(roomId)

      if (await releaseLockIfOwner(roomId)) {
        console.log(`[Handover] Released lock for room ${roomId}`)
      } else {
        // Our lease had already lapsed and someone else holds the Room now.
        // Deleting the key here would drop *their* lock.
        console.warn(`[Handover] Lock for room ${roomId} was no longer ours to release`)
      }

      const readyWaiter = this.waitForReadySignal(readyChannel)

      await pubClient.publish(
        lockReleasedChannel,
        JSON.stringify({
          roomId,
          previousOwner: POD_NAME,
          timestamp: Date.now(),
        }),
      )
      console.log(
        `[Handover] Phase 2: Published lock-released, waiting for new owner ready signal...`,
      )

      const isReady = await readyWaiter

      if (isReady) {
        console.log(
          `[Handover] New owner ready for room ${roomId}, closing ${socketCount} connections`,
        )
      } else {
        console.log(
          `[Handover] Timeout waiting for ready signal for room ${roomId}, closing connections anyway`,
        )
      }

      if (sockets && sockets.size > 0) {
        for (const ws of sockets) {
          try {
            ws.close(1013, "Room migrated to another server, please reconnect")
          } catch (e) {
            // Socket may already be closed
          }
        }
        this.roomSockets.delete(roomId)
      }
    } catch (err) {
      console.error(`[Handover] Error releasing room ${roomId}:`, err)
      this.forceCloseSockets(roomId)
    }
  }

  private waitForReadySignal(channel: string): Promise<boolean> {
    return new Promise((resolve) => {
      let resolved = false
      let timeoutId: NodeJS.Timeout

      const messageHandler = () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeoutId)
          handoverSubClient.unsubscribe(channel).catch(() => {})
          resolve(true)
        }
      }

      handoverSubClient
        .subscribe(channel, messageHandler)
        .then(() => {
          timeoutId = setTimeout(() => {
            if (!resolved) {
              resolved = true
              handoverSubClient.unsubscribe(channel).catch(() => {})
              resolve(false)
            }
          }, HANDOVER_READY_TIMEOUT_MS)
        })
        .catch(() => {
          resolve(false)
        })
    })
  }

  /**
   * Extend our claim on a Room, and give the Room up if the claim is gone.
   *
   * A renewal only fails when another pod has become the Room Owner, which
   * means our in-memory copy is no longer authoritative. Persisting it here
   * would overwrite the new owner's Snapshot, so the Room is dropped without
   * saving and its Sessions are told to reconnect — they will land on whoever
   * holds the lock now.
   */
  private async renewRoomLock(roomId: string) {
    let renewed: boolean
    try {
      renewed = await renewLockIfOwner(roomId)
    } catch (err) {
      // A Redis blip is not evidence that we lost the Room; the lease still has
      // half its life left, so keep serving and retry on the next tick.
      console.error(`[Lock] Failed to renew lock for room ${roomId}:`, err)
      return
    }

    if (renewed) return

    console.error(`[Lock] Lost lock for room ${roomId} to another pod, giving up the room`)
    lockLostCounter.inc()
    this.dropRoom(roomId)
    this.forceCloseSockets(roomId)
  }

  /**
   * Stop owning a Room in memory: cancel its pending Snapshot write, stop its
   * heartbeat and forget it. Does not touch the Room Lock or its Sessions —
   * callers decide what those deserve.
   */
  private dropRoom(roomId: string): boolean {
    const wasActive = this.activeRooms.delete(roomId)

    const heartbeat = this.roomHeartbeats.get(roomId)
    if (heartbeat) clearInterval(heartbeat)
    this.roomHeartbeats.delete(roomId)

    // A trailing throttled save would otherwise fire seconds from now and put
    // our stale state on top of the next owner's.
    this.roomSaves.get(roomId)?.cancel()
    this.roomSaves.delete(roomId)

    if (wasActive) activeRoomsGauge.dec()
    return wasActive
  }

  private forceCloseSockets(roomId: string) {
    const sockets = this.roomSockets.get(roomId)
    if (sockets && sockets.size > 0) {
      console.log(`[Handover] Force closing ${sockets.size} sockets for room ${roomId}`)
      for (const ws of sockets) {
        try {
          ws.close(1013, "Room migrated to another server, please reconnect")
        } catch (e) {
          // Socket may already be closed
        }
      }
      this.roomSockets.delete(roomId)
    }
  }

  private async subscribeToLockReleased(
    roomId: string,
  ): Promise<{ wait: () => Promise<boolean>; cleanup: () => void }> {
    const channel = `${CHANNEL_LOCK_RELEASED_PREFIX}${roomId}`
    let resolved = false
    let resolvePromise: (value: boolean) => void
    let timeoutId: NodeJS.Timeout

    const resultPromise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve
    })

    const messageHandler = () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeoutId)
        console.log(`[Handover] Received lock-released for room ${roomId}`)
        resolvePromise(true)
      }
    }

    await handoverSubClient.subscribe(channel, messageHandler)

    const cleanup = () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeoutId)
      }
      handoverSubClient.unsubscribe(channel).catch(() => {})
    }

    const wait = (): Promise<boolean> => {
      timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true
          console.log(`[Handover] Timeout waiting for lock-released for room ${roomId}`)
          handoverTimeoutCounter.inc()
          handoverSubClient.unsubscribe(channel).catch(() => {})
          resolvePromise(false)
        }
      }, HANDOVER_TIMEOUT_MS)

      return resultPromise
    }

    return { wait, cleanup }
  }

  private async acquireLockWithHandover(
    roomId: string,
  ): Promise<{ acquired: boolean; shouldSignalReady: boolean }> {
    const startTime = Date.now()

    const lockAcquired = await redisClient.set(lockKey(roomId), POD_NAME, {
      EX: LOCK_TIMEOUT_SEC,
      NX: true,
    })

    if (lockAcquired) {
      console.log(`[Lock] Acquired lock for room ${roomId} (direct)`)
      return { acquired: true, shouldSignalReady: false }
    }

    const currentOwner = await redisClient.get(lockKey(roomId))

    if (currentOwner === POD_NAME) {
      console.log(`[Lock] We already own lock for room ${roomId}`)
      return { acquired: true, shouldSignalReady: false }
    }

    if (!currentOwner) {
      const retryAcquired = await redisClient.set(lockKey(roomId), POD_NAME, {
        EX: LOCK_TIMEOUT_SEC,
        NX: true,
      })
      if (retryAcquired) {
        console.log(`[Lock] Acquired lock for room ${roomId} (after expiry)`)
        return { acquired: true, shouldSignalReady: false }
      }
    }

    console.log(`[Lock] Room ${roomId} owned by ${currentOwner}, initiating two-phase handover...`)
    handoverRequestsCounter.inc()

    const subscription = await this.subscribeToLockReleased(roomId)

    await pubClient.publish(
      CHANNEL_HANDOVER_REQUEST,
      JSON.stringify({
        roomId,
        targetPodId: POD_NAME,
      }),
    )

    const lockReleased = await subscription.wait()
    const duration = (Date.now() - startTime) / 1000
    handoverDurationHistogram.observe(duration)

    if (lockReleased) {
      console.log(
        `[Lock] Lock released signal received for room ${roomId} in ${duration.toFixed(2)}s`,
      )
    } else {
      console.log(
        `[Lock] Timeout waiting for lock release for room ${roomId}, attempting acquisition anyway...`,
      )
    }

    const retryAcquired = await redisClient.set(lockKey(roomId), POD_NAME, {
      EX: LOCK_TIMEOUT_SEC,
      NX: true,
    })

    if (retryAcquired) {
      console.log(`[Lock] Acquired lock for room ${roomId} after handover`)
      handoverSuccessCounter.inc()
      return { acquired: true, shouldSignalReady: true }
    }

    console.log(`[Lock] Failed to acquire lock for room ${roomId} after handover`)
    return { acquired: false, shouldSignalReady: false }
  }

  private async signalReady(roomId: string) {
    const readyChannel = `${CHANNEL_READY_PREFIX}${roomId}`
    await pubClient.publish(
      readyChannel,
      JSON.stringify({
        roomId,
        newOwner: POD_NAME,
        timestamp: Date.now(),
      }),
    )
    console.log(`[Handover] Published ready signal for room ${roomId}`)
  }

  /**
   * Get or create a room. This is async and should be called BEFORE
   * accepting the WebSocket connection to avoid race conditions.
   *
   * @returns The room and whether this call created it
   */
  public async getOrPrepareRoom(
    roomId: string,
  ): Promise<{ room: TLSocketRoom<TLRecord, void>; isNewRoom: boolean }> {
    // 1. Check if room already exists
    let room = this.activeRooms.get(roomId)
    if (room) {
      return { room, isNewRoom: false }
    }

    // 2. Check if room is currently being loaded (deduplication)
    if (this.loadingRooms.has(roomId)) {
      room = await this.loadingRooms.get(roomId)
      if (room) {
        return { room, isNewRoom: false }
      }
      throw new Error("ROOM_LOAD_FAILED")
    }

    // 3. Create the room
    const loadPromise = (async () => {
      const { acquired, shouldSignalReady } = await this.acquireLockWithHandover(roomId)

      if (!acquired) {
        throw new Error("LOCK_ACQUISITION_FAILED")
      }

      const newRoom = await this.createRoom(roomId)
      this.activeRooms.set(roomId, newRoom)
      activeRoomsGauge.inc()

      const lockHeartbeat = setInterval(() => {
        void this.renewRoomLock(roomId)
      }, HEARTBEAT_INTERVAL_MS)

      this.roomHeartbeats.set(roomId, lockHeartbeat)

      if (shouldSignalReady) {
        await this.signalReady(roomId)
      }

      return newRoom
    })()

    // Store the promise so concurrent requests can wait
    this.loadingRooms.set(roomId, loadPromise)

    try {
      room = await loadPromise
      return { room, isNewRoom: true }
    } finally {
      this.loadingRooms.delete(roomId)
    }
  }

  /**
   * Connect a WebSocket to an existing room. This should be called
   * AFTER the WebSocket is accepted and the room is ready.
   * This is synchronous - the room must already exist.
   */
  public connectSocket(
    room: TLSocketRoom<TLRecord, void>,
    roomId: string,
    ws: WebSocket,
    sessionId: string,
    isNewRoom: boolean,
  ) {
    const safeWs = ws as TldrawWebSocket
    safeWs.sessionId = sessionId
    safeWs.roomId = roomId
    safeWs.isAlive = true

    safeWs.on("pong", () => {
      safeWs.isAlive = true
    })

    const currentSockets = this.roomSockets.get(roomId)?.size ?? 0
    if (isNewRoom) {
      console.log(`[Room] User ${sessionId} created new room ${roomId}`)
    } else {
      console.log(
        `[Room] User ${sessionId} joining existing room ${roomId} (${currentSockets} users already connected)`,
      )
    }

    room.handleSocketConnect({ socket: safeWs, sessionId })

    // Track raw socket for handover (need to close with 1013)
    this.trackSocket(roomId, safeWs)
  }

  // --- Graceful Shutdown ---
  public async shutdown() {
    console.log(`[RoomManager] Shutting down, saving ${this.activeRooms.size} rooms...`)

    const rooms = [...this.activeRooms]
    const promises = rooms.map(async ([roomId, room]) => {
      const snapshot = room.getCurrentSnapshot()
      if (snapshot) {
        // The Snapshot must land before the lock goes, or the next owner can
        // acquire the Room and load a stale Snapshot while our write is still
        // in flight — and then our write lands on top of theirs.
        await persistRoomSnapshot(roomId, snapshot)
      }
      this.dropRoom(roomId)
      await releaseLockIfOwner(roomId)
    })

    await Promise.allSettled(promises)
    console.log("[RoomManager] All rooms saved, closing Redis connections...")

    await Promise.all([
      redisClient.quit(),
      subClient.quit(),
      pubClient.quit(),
      handoverSubClient.quit(),
    ])
    console.log("[RoomManager] Shutdown complete")
  }

  /**
   * Track raw WebSocket for handover purposes (need to close with 1013).
   * Also notifies the room when socket closes, which triggers onSessionRemoved.
   */
  private trackSocket(roomId: string, ws: TldrawWebSocket) {
    if (!this.roomSockets.has(roomId)) {
      this.roomSockets.set(roomId, new Set())
    }
    this.roomSockets.get(roomId)!.add(ws)

    ws.on("close", () => {
      this.roomSockets.get(roomId)?.delete(ws)
      // Notify room of socket close - this triggers onSessionRemoved
      const room = this.activeRooms.get(roomId)
      if (room) {
        room.handleSocketClose(ws.sessionId)
      }
    })
  }

  private async createRoom(roomId: string): Promise<TLSocketRoom<TLRecord, void>> {
    const initialSnapshot = await fetchRoomSnapshot(roomId)
    let room: TLSocketRoom<TLRecord, void>

    const saveToGCSThrottled = throttle(() => {
      // Only the Room Owner may write; dropRoom() cancels this, but a save
      // already queued before that can still be in flight.
      if (room && this.activeRooms.get(roomId) === room) {
        const snapshot = room.getCurrentSnapshot()
        if (snapshot) persistRoomSnapshot(roomId, snapshot)
      }
    }, THROTTLE_SAVE_MS)

    this.roomSaves.set(roomId, saveToGCSThrottled)

    room = new TLSocketRoom<TLRecord, void>({
      schema,
      initialSnapshot: initialSnapshot || undefined,
      onDataChange: () => saveToGCSThrottled(),
      onSessionRemoved: (_room, { sessionId, numSessionsRemaining }) => {
        console.log(
          `[Room] Session ${sessionId} removed from ${roomId}, ${numSessionsRemaining} remaining`,
        )
        if (numSessionsRemaining === 0) {
          console.log(`[Room] No sessions remaining, cleaning up room ${roomId}`)
          this.cleanupRoom(roomId)
        }
      },
    })
    return room
  }

  private cleanupRoom(roomId: string) {
    this.dropRoom(roomId)
    this.roomSockets.delete(roomId)
    releaseLockIfOwner(roomId).catch((err) =>
      console.error(`[Lock] Failed to release lock for room ${roomId}:`, err),
    )
  }
}

export const roomManager = new RoomManager()
