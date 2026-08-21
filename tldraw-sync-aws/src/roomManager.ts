import { TLSocketRoom } from "@tldraw/sync-core"
import { type TLRecord, createTLSchema, defaultShapeSchemas } from "@tldraw/tlschema"
import { WebSocket } from "ws"
import throttle from "lodash.throttle"
import { fetchRoomSnapshot, persistRoomSnapshot } from "./s3Storage.js"
import { OWNERSHIP_RECHECK_INTERVAL_MS, casOwner, readOwner } from "./registry.js"
import { Membership, defaultAdvertiseAddr } from "./membership.js"
import {
  activeRoomsGauge,
  roomCasConflictsCounter,
  roomClaimsCounter,
  roomOwnershipLostCounter,
  roomReclaimsCounter,
} from "./metrics.js"

const THROTTLE_SAVE_MS = 10_000
const RECONNECT_REASON = "Room reallocated to another server, please reconnect"
// Consecutive failed Snapshot writes before a worker declares itself unfit to
// own anything. Each attempt has already burned four tries and ~8s of backoff,
// so three in a row is a sustained outage, not a blip.
const MAX_CONSECUTIVE_SAVE_FAILURES = 3

const schema = createTLSchema({ shapes: { ...defaultShapeSchemas } })

interface TldrawWebSocket extends WebSocket {
  sessionId: string
  roomId: string
}

/**
 * Refusal carrying the correction. The worker answers the upgrade with 409 and
 * `x-room-owner`, so a router in mode B can retry against the named address on
 * the same client connection instead of the client seeing an error.
 */
export class NotOwnerError extends Error {
  constructor(readonly owner: string | null) {
    super("NOT_OWNER")
    this.name = "NotOwnerError"
  }
}

class RoomManager {
  /** Owner Identity: the same string that appears in members/ and owners/. */
  readonly addr = defaultAdvertiseAddr()

  private activeRooms = new Map<string, TLSocketRoom<TLRecord, void>>()
  private roomSockets = new Map<string, Set<TldrawWebSocket>>()
  // One timer for the whole worker, not one per Room: the re-check is a single
  // batched question to the router now, so per-Room timers would only fan a
  // single request back out into many.
  private recheckTimer?: NodeJS.Timeout
  // Kept so a pending trailing save can be cancelled the moment we stop owning
  // a Room; it would otherwise land on top of the next owner's state.
  private roomSaves = new Map<string, { cancel: () => void }>()
  private loadingRooms = new Map<string, Promise<TLSocketRoom<TLRecord, void>>>()

  // Ownership says a worker MAY hold a Room; being able to persist is what
  // makes that worth anything. With the S3 registry those were the same
  // question, because the heartbeat and the Snapshot went to the same bucket.
  // With the Redis registry they are not: a worker cut off from S3 keeps its
  // ownership records happily and accumulates edits it can never save. So the
  // capability is tested directly rather than inferred from a shared channel.
  private consecutiveSaveFailures = 0
  private canPersist = true

  readonly membership = new Membership(
    this.addr,
    () => this.roomCount(),
    () => void this.recheckAll(),
  )

  roomCount(): number {
    return this.activeRooms.size
  }

  /** False once this worker has proved it cannot save. Fails the liveness probe. */
  public get healthy(): boolean {
    return this.canPersist
  }

  /**
   * Claim the record if it is absent or vacant, serve if it names us, refuse if
   * it names someone else. One code path that works with a router in front and
   * in bare `yarn dev` with no router at all.
   */
  public async getOrPrepareRoom(
    roomId: string,
  ): Promise<{ room: TLSocketRoom<TLRecord, void>; isNewRoom: boolean }> {
    const existing = this.activeRooms.get(roomId)
    if (existing) return { room: existing, isNewRoom: false }

    const loading = this.loadingRooms.get(roomId)
    if (loading) return { room: await loading, isNewRoom: false }

    const loadPromise = (async () => {
      await this.claimOwnership(roomId)
      const room = await this.createRoom(roomId)
      this.activeRooms.set(roomId, room)
      activeRoomsGauge.inc()
      this.startRecheckLoop()
      return room
    })()

    this.loadingRooms.set(roomId, loadPromise)
    try {
      return { room: await loadPromise, isNewRoom: true }
    } finally {
      this.loadingRooms.delete(roomId)
    }
  }

  private async claimOwnership(roomId: string): Promise<void> {
    const record = await readOwner(roomId)

    if (record?.owner === this.addr) return
    if (record?.owner) throw new NotOwnerError(record.owner)

    // Absent record claims with "must not exist"; a vacated one reallocates
    // against its etag. `owner: null` and "no record" mean the same to a
    // reader, but not to a conditional write.
    const result = await casOwner(roomId, record ? record.etag : null, this.addr)
    if (result === "ok") {
      // An existing record belonged to a dead or drained owner; an absent one is
      // a Room nobody has held before. The dashboard cares about the difference.
      if (record) roomReclaimsCounter.inc()
      else roomClaimsCounter.inc()
      return
    }

    roomCasConflictsCounter.inc()
    const winner = await readOwner(roomId)
    if (winner?.owner === this.addr) return
    throw new NotOwnerError(winner?.owner ?? null)
  }

  /**
   * Re-read the record. If it moved, the in-memory copy is no longer
   * authoritative: drop it *without saving* and tell Sessions to reconnect.
   * A read failure is not a loss — the record is durable and a blip proves
   * nothing, so keep serving and try again next tick.
   */
  private async recheckOwnership(roomId: string): Promise<void> {
    if (!this.activeRooms.has(roomId)) return

    let record
    try {
      record = await readOwner(roomId)
    } catch (error) {
      console.error(`[Ownership] Re-read failed for room ${roomId}, still serving:`, error)
      return
    }

    if (record?.owner === this.addr) return

    this.giveUpRoom(roomId, `record names ${record?.owner ?? "nobody"}`)
  }

  private startRecheckLoop(): void {
    if (this.recheckTimer) return
    this.recheckTimer = setInterval(() => void this.recheckAll(), OWNERSHIP_RECHECK_INTERVAL_MS)
  }

  /**
   * Confirm we still own what we are holding.
   *
   * This is a **backstop**, not the mechanism. The router pushes
   * `/internal/lost` the moment it takes a Room away, so this only catches
   * pushes that went missing — which is why it can run every 30s rather than
   * every 5s, and why moving it off the bucket was the single largest saving in
   * the request bill.
   *
   * One batched question to the router when there is one; a direct read per
   * Room otherwise, so bare `yarn dev` with no router still works.
   */
  public async recheckAll(): Promise<void> {
    const roomIds = [...this.activeRooms.keys()]
    if (roomIds.length === 0) return

    const routerUrl = process.env.ROUTER_INTERNAL_URL
    if (routerUrl) {
      const lost = await this.askRouterWhatWeLost(routerUrl, roomIds)
      // null means we could not get an answer. A blip is not evidence of loss,
      // so keep serving and ask again next tick.
      if (lost === null) return
      for (const roomId of lost) this.giveUpRoom(roomId, "router says it moved")
      return
    }

    await Promise.all(roomIds.map((roomId) => this.recheckOwnership(roomId)))
  }

  private async askRouterWhatWeLost(
    routerUrl: string,
    roomIds: string[],
  ): Promise<string[] | null> {
    try {
      const response = await fetch(`${routerUrl}/internal/ownership`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addr: this.addr, roomIds }),
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) {
        // Loudly: a persistent non-OK here means the backstop is silently doing
        // nothing, which looks exactly like everything being fine.
        console.error(
          `[Ownership] Router re-check answered ${response.status} at ${routerUrl}; ` +
            "no rooms were checked",
        )
        return null
      }
      const body = (await response.json()) as { lost?: string[] }
      return Array.isArray(body.lost) ? body.lost : null
    } catch (error) {
      console.error("[Ownership] Router re-check failed, still serving:", error)
      return null
    }
  }

  /**
   * The router told us, unprompted, that it took a Room from us. Acting on it
   * immediately is the whole point: the alternative is serving state we no
   * longer own until the next backstop poll.
   */
  public onOwnershipLost(roomId: string): void {
    if (!this.activeRooms.has(roomId)) return
    this.giveUpRoom(roomId, "router reallocated it")
  }

  /** Drop without saving — our copy is no longer authoritative. */
  private giveUpRoom(roomId: string, why: string): void {
    console.error(`[Ownership] Giving up room ${roomId}: ${why}`)
    roomOwnershipLostCounter.inc()
    this.dropRoom(roomId)
    this.closeSockets(roomId)
  }

  /**
   * Persist a Room, but only after confirming the record still names us. A Room
   * whose ownership moved must not clobber the new owner's Snapshot.
   */
  public async saveRoom(roomId: string): Promise<void> {
    const room = this.activeRooms.get(roomId)
    if (!room) return

    let record
    try {
      record = await readOwner(roomId)
    } catch (error) {
      console.error(`[Snapshot] Ownership check failed for room ${roomId}, skipping save:`, error)
      return
    }
    if (record?.owner !== this.addr) return

    const snapshot = room.getCurrentSnapshot()
    if (!snapshot) return

    if (await persistRoomSnapshot(roomId, snapshot)) {
      this.consecutiveSaveFailures = 0
      return
    }

    this.consecutiveSaveFailures++
    console.error(
      `[Snapshot] Write failed for room ${roomId} ` +
        `(${this.consecutiveSaveFailures}/${MAX_CONSECUTIVE_SAVE_FAILURES} consecutive)`,
    )
    if (this.consecutiveSaveFailures >= MAX_CONSECUTIVE_SAVE_FAILURES) {
      await this.surrenderRooms()
    }
  }

  /**
   * Give up everything, because we cannot save it.
   *
   * Ownership is vacated rather than merely dropped: the record is written
   * through the registry, which is still reachable in the case this exists for
   * — Redis up, S3 down — so another worker can take the Rooms immediately
   * instead of waiting out a TTL. Sessions are closed `1013` and reconnect
   * onto a worker that can actually persist.
   *
   * The worker then fails its liveness probe. There is no way back from here
   * under its own power, and a restart is the honest response: holding Rooms
   * we cannot write is strictly worse than not running.
   */
  private async surrenderRooms(): Promise<void> {
    this.canPersist = false
    console.error(
      `[Snapshot] Cannot persist; surrendering ${this.activeRooms.size} rooms and failing health`,
    )

    await Promise.allSettled(
      [...this.activeRooms.keys()].map(async (roomId) => {
        // Deliberately no saveRoom() here: saving is the thing that is broken.
        await this.vacate(roomId)
        this.dropRoom(roomId)
        this.closeSockets(roomId)
      }),
    )
  }

  public connectSocket(
    room: TLSocketRoom<TLRecord, void>,
    roomId: string,
    ws: WebSocket,
    sessionId: string,
    isNewRoom: boolean,
  ): void {
    const socket = ws as TldrawWebSocket
    socket.sessionId = sessionId
    socket.roomId = roomId

    console.log(
      isNewRoom
        ? `[Room] User ${sessionId} created new room ${roomId}`
        : `[Room] User ${sessionId} joined room ${roomId}`,
    )

    room.handleSocketConnect({ socket, sessionId })

    if (!this.roomSockets.has(roomId)) this.roomSockets.set(roomId, new Set())
    this.roomSockets.get(roomId)!.add(socket)

    socket.on("close", () => {
      this.roomSockets.get(roomId)?.delete(socket)
      this.activeRooms.get(roomId)?.handleSocketClose(sessionId)
    })
  }

  /**
   * Drain. The caller must already have deregistered from members/ and waited
   * for routers to notice — see the shutdown handler in index.ts. Here we only
   * do the per-Room part, and the ordering is load-bearing: the Snapshot must
   * land before ownership is given up, or the next owner can claim the Room and
   * load a stale Snapshot while our write is still in flight.
   */
  public async drain(): Promise<void> {
    console.log(`[RoomManager] Draining ${this.activeRooms.size} rooms`)

    await Promise.allSettled(
      [...this.activeRooms.keys()].map(async (roomId) => {
        await this.saveRoom(roomId)
        await this.vacate(roomId)
        this.dropRoom(roomId)
        this.closeSockets(roomId)
      }),
    )

    console.log("[RoomManager] Drain complete")
  }

  /** CAS to vacant. Never a delete: an unconditional one is a split-brain. */
  private async vacate(roomId: string): Promise<void> {
    try {
      const record = await readOwner(roomId)
      if (record?.owner !== this.addr) return
      await casOwner(roomId, record.etag, null)
    } catch (error) {
      console.error(`[Ownership] Failed to vacate room ${roomId}:`, error)
    }
  }

  /** Forget a Room in memory. Touches neither the record nor its Sessions. */
  private dropRoom(roomId: string): void {
    const wasActive = this.activeRooms.delete(roomId)

    // Last Room gone: stop asking about an empty list.
    if (this.activeRooms.size === 0 && this.recheckTimer) {
      clearInterval(this.recheckTimer)
      this.recheckTimer = undefined
    }

    // A trailing throttled save would otherwise fire seconds from now and put
    // our stale state on top of the next owner's.
    this.roomSaves.get(roomId)?.cancel()
    this.roomSaves.delete(roomId)

    if (wasActive) activeRoomsGauge.dec()
  }

  private closeSockets(roomId: string): void {
    const sockets = this.roomSockets.get(roomId)
    if (!sockets?.size) return
    for (const socket of sockets) {
      try {
        socket.close(1013, RECONNECT_REASON)
      } catch {
        // Already closed.
      }
    }
    this.roomSockets.delete(roomId)
  }

  private async createRoom(roomId: string): Promise<TLSocketRoom<TLRecord, void>> {
    const initialSnapshot = await fetchRoomSnapshot(roomId)

    const saveThrottled = throttle(() => void this.saveRoom(roomId), THROTTLE_SAVE_MS)
    this.roomSaves.set(roomId, saveThrottled)

    return new TLSocketRoom<TLRecord, void>({
      schema,
      initialSnapshot: initialSnapshot || undefined,
      onDataChange: () => saveThrottled(),
      onSessionRemoved: (_room, { sessionId, numSessionsRemaining }) => {
        console.log(`[Room] Session ${sessionId} left ${roomId}, ${numSessionsRemaining} remaining`)
        if (numSessionsRemaining === 0) void this.cleanupRoom(roomId)
      },
    })
  }

  /** Last Session left: persist, vacate so another worker can take it, forget. */
  private async cleanupRoom(roomId: string): Promise<void> {
    await this.saveRoom(roomId)
    await this.vacate(roomId)
    this.dropRoom(roomId)
    this.roomSockets.delete(roomId)
  }
}

export const roomManager = new RoomManager()
