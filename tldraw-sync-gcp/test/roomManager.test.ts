import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "events"
import type { WebSocket } from "ws"
import { bus, createClient } from "./helpers/fakeRedis.js"

vi.mock("redis", () => ({ createClient }))

const fetchRoomSnapshot = vi.fn()
const persistRoomSnapshot = vi.fn()
vi.mock("../src/gcsStorage.js", () => ({ fetchRoomSnapshot, persistRoomSnapshot }))

// Stands in for TLSocketRoom. Records connected sessions and exposes the
// onSessionRemoved callback so tests can simulate clients leaving.
class FakeRoom {
  static instances: FakeRoom[] = []
  sessions = new Set<string>()
  closedSessions: string[] = []
  snapshot: unknown = { clock: 1, documents: [] }

  constructor(public config: Record<string, any>) {
    FakeRoom.instances.push(this)
  }

  getCurrentSnapshot() {
    return this.snapshot
  }

  handleSocketConnect({ sessionId }: { sessionId: string }) {
    this.sessions.add(sessionId)
  }

  handleSocketClose(sessionId: string) {
    this.closedSessions.push(sessionId)
    this.sessions.delete(sessionId)
    this.config.onSessionRemoved(this, { sessionId, numSessionsRemaining: this.sessions.size })
  }
}

vi.mock("@tldraw/sync-core", () => ({ TLSocketRoom: FakeRoom }))

const { roomManager } = await import("../src/roomManager.js")

const CHANNEL_HANDOVER_REQUEST = "room-handover"
const lockReleasedChannel = (roomId: string) => `handover-lock-released:${roomId}`
const readyChannel = (roomId: string) => `handover-ready:${roomId}`

// Every test uses a fresh roomId: the room manager is a module-level singleton
// whose in-memory maps persist for the lifetime of the file.
let roomCounter = 0
const nextRoomId = () => `room-${++roomCounter}`

function fakeSocket() {
  const socket = new EventEmitter() as unknown as WebSocket & {
    closes: Array<{ code: number; reason: string }>
  }
  socket.closes = []
  socket.close = ((code: number, reason: string) => {
    socket.closes.push({ code, reason })
    socket.emit("close")
  }) as WebSocket["close"]
  return socket
}

// Subscribers persist for the whole file, so they must tolerate traffic from
// later tests — including the deliberately malformed message.
function parseMessage(message: string): Record<string, any> | undefined {
  try {
    return JSON.parse(message)
  } catch {
    return undefined
  }
}

// Subscribes as "another pod" and collects everything published on a channel.
function watch(channel: string) {
  const messages: unknown[] = []
  bus.subscribe(channel, (message) => {
    const parsed = parseMessage(message)
    if (parsed) messages.push(parsed)
  })
  return messages
}

beforeEach(() => {
  fetchRoomSnapshot.mockReset().mockResolvedValue(undefined)
  persistRoomSnapshot.mockReset().mockResolvedValue(undefined)
  FakeRoom.instances.length = 0
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
})

describe("getOrPrepareRoom", () => {
  it("acquires the room lock and loads the stored snapshot", async () => {
    const roomId = nextRoomId()
    const stored = { clock: 42, documents: [] }
    fetchRoomSnapshot.mockResolvedValue(stored)

    const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)

    expect(isNewRoom).toBe(true)
    expect(fetchRoomSnapshot).toHaveBeenCalledWith(roomId)
    expect((room as unknown as FakeRoom).config.initialSnapshot).toBe(stored)
    expect(bus.getLockOwner(roomId)).toMatch(/^TldrawRoomManagerPod-|-/)
  })

  it("passes undefined rather than null when there is no stored snapshot", async () => {
    const roomId = nextRoomId()
    fetchRoomSnapshot.mockResolvedValue(null)

    const { room } = await roomManager.getOrPrepareRoom(roomId)

    expect((room as unknown as FakeRoom).config.initialSnapshot).toBeUndefined()
  })

  it("returns the same room instance on a second call", async () => {
    const roomId = nextRoomId()

    const first = await roomManager.getOrPrepareRoom(roomId)
    const second = await roomManager.getOrPrepareRoom(roomId)

    expect(second.room).toBe(first.room)
    expect(second.isNewRoom).toBe(false)
    expect(FakeRoom.instances).toHaveLength(1)
  })

  // Two clients hitting an unloaded room at once must not each fetch a snapshot
  // and build a room — the second would discard the first's state.
  it("deduplicates concurrent preparations of the same room", async () => {
    const roomId = nextRoomId()

    const [a, b] = await Promise.all([
      roomManager.getOrPrepareRoom(roomId),
      roomManager.getOrPrepareRoom(roomId),
    ])

    expect(a.room).toBe(b.room)
    expect(fetchRoomSnapshot).toHaveBeenCalledTimes(1)
    expect(FakeRoom.instances).toHaveLength(1)
  })

  it("renews the room lock on a heartbeat while the room is held", async () => {
    vi.useFakeTimers()
    const roomId = nextRoomId()

    await roomManager.getOrPrepareRoom(roomId)
    // Past the 10s lock lease, but heartbeats run every 5s.
    await vi.advanceTimersByTimeAsync(12_000)

    expect(bus.getLockOwner(roomId)).not.toBeNull()
  })
})

// The lock is what decides the Room Owner. Renewing or releasing it without
// proving we still hold it is how two pods end up serving one Room.
describe("lock ownership", () => {
  it("does not renew a lock that another pod has taken over", async () => {
    vi.useFakeTimers()
    const roomId = nextRoomId()
    await roomManager.getOrPrepareRoom(roomId)

    // Our lease lapses and another pod legitimately acquires the room.
    bus.setLock(roomId, "usurper-pod", 600)
    await vi.advanceTimersByTimeAsync(6_000)

    // A `SET ... XX` heartbeat would have overwritten this with our pod name,
    // leaving both pods convinced they own the room.
    expect(bus.getLockOwner(roomId)).toBe("usurper-pod")
  })

  it("gives up the room and evicts its sessions when the lock is lost", async () => {
    vi.useFakeTimers()
    const roomId = nextRoomId()
    const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)
    const socket = fakeSocket()
    roomManager.connectSocket(room, roomId, socket, "session-1", isNewRoom)

    bus.setLock(roomId, "usurper-pod", 600)
    await vi.advanceTimersByTimeAsync(6_000)

    // Clients are told to reconnect, and land on whoever holds the lock now.
    expect(socket.closes[0]?.code).toBe(1013)
    // The stale in-memory copy must not be written over the new owner's state.
    expect(persistRoomSnapshot).not.toHaveBeenCalled()
  })

  it("does not write a stale snapshot after losing the lock", async () => {
    vi.useFakeTimers()
    const roomId = nextRoomId()
    const { room } = await roomManager.getOrPrepareRoom(roomId)
    const fake = room as unknown as FakeRoom

    // The first edit saves immediately (leading edge, while the room is still
    // ours); the second queues a trailing save 10s out.
    fake.config.onDataChange()
    fake.config.onDataChange()
    const writesWhileOwned = persistRoomSnapshot.mock.calls.length

    // The lock is taken over, and the heartbeat notices 5s in.
    bus.setLock(roomId, "usurper-pod", 600)
    await vi.advanceTimersByTimeAsync(6_000)

    // Past the trailing save's deadline: it must have been cancelled, or it
    // lands on top of everything the new owner has written since.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(persistRoomSnapshot).toHaveBeenCalledTimes(writesWhileOwned)
  })

  it("does not delete another pod's lock when releasing a room", async () => {
    const roomId = nextRoomId()
    const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)
    roomManager.connectSocket(room, roomId, fakeSocket(), "session-1", isNewRoom)

    // Our lease lapsed and another pod took over, but a handover request for
    // the room we still hold in memory arrives anyway.
    bus.setLock(roomId, "usurper-pod", 600)
    bus.publish(CHANNEL_HANDOVER_REQUEST, JSON.stringify({ roomId, targetPodId: "third-pod" }))
    await vi.waitFor(() => expect(persistRoomSnapshot).toHaveBeenCalled())

    expect(bus.getLockOwner(roomId)).toBe("usurper-pod")
  })

  it("does not delete another pod's lock when the last session leaves", async () => {
    const roomId = nextRoomId()
    const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)
    const socket = fakeSocket()
    roomManager.connectSocket(room, roomId, socket, "session-1", isNewRoom)

    bus.setLock(roomId, "usurper-pod", 600)
    socket.emit("close")
    await vi.waitFor(() => expect(bus.getLockOwner(roomId)).toBe("usurper-pod"))
  })
})

describe("acquiring a room owned by another pod", () => {
  it("requests a handover and takes the room once the lock is released", async () => {
    const roomId = nextRoomId()
    bus.setLock(roomId, "other-pod")

    const requests = watch(CHANNEL_HANDOVER_REQUEST)
    const readySignals = watch(readyChannel(roomId))

    // The other pod plays its part of the protocol: on request, drop the lock
    // and announce it.
    bus.subscribe(CHANNEL_HANDOVER_REQUEST, (message) => {
      const request = parseMessage(message)
      if (request?.roomId !== roomId) return
      bus.deleteLock(roomId)
      bus.publish(lockReleasedChannel(roomId), JSON.stringify({ roomId }))
    })

    const { room } = await roomManager.getOrPrepareRoom(roomId)

    expect(room).toBeDefined()
    expect(requests).toContainEqual(expect.objectContaining({ roomId }))
    expect(bus.getLockOwner(roomId)).not.toBe("other-pod")
    // The incoming owner must announce readiness, or the outgoing owner holds
    // its clients open for the full ready timeout.
    expect(readySignals).toHaveLength(1)
  })

  it("fails the connection when the other pod never releases the lock", async () => {
    vi.useFakeTimers()
    const roomId = nextRoomId()
    bus.setLock(roomId, "stubborn-pod", 600)

    const prepared = roomManager.getOrPrepareRoom(roomId)
    const assertion = expect(prepared).rejects.toThrow("LOCK_ACQUISITION_FAILED")

    await vi.advanceTimersByTimeAsync(6_000)
    await assertion
    expect(bus.getLockOwner(roomId)).toBe("stubborn-pod")
  })
})

describe("responding to a handover request", () => {
  it("persists the snapshot, releases the lock and evicts clients with 1013", async () => {
    const roomId = nextRoomId()
    const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)
    const socket = fakeSocket()
    roomManager.connectSocket(room, roomId, socket, "session-1", isNewRoom)

    const released = watch(lockReleasedChannel(roomId))
    // Stand in for the incoming owner: acknowledge as soon as the lock drops.
    bus.subscribe(lockReleasedChannel(roomId), () => {
      bus.publish(readyChannel(roomId), JSON.stringify({ roomId, newOwner: "new-pod" }))
    })

    bus.publish(CHANNEL_HANDOVER_REQUEST, JSON.stringify({ roomId, targetPodId: "new-pod" }))
    await vi.waitFor(() => expect(socket.closes).toHaveLength(1))

    expect(persistRoomSnapshot).toHaveBeenCalledWith(roomId, (room as unknown as FakeRoom).snapshot)
    expect(released).toHaveLength(1)
    expect(bus.getLockOwner(roomId)).toBeNull()
    expect(socket.closes[0].code).toBe(1013)
  })

  it("evicts clients anyway when the incoming owner never signals ready", async () => {
    vi.useFakeTimers()
    const roomId = nextRoomId()
    const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)
    const socket = fakeSocket()
    roomManager.connectSocket(room, roomId, socket, "session-1", isNewRoom)

    bus.publish(CHANNEL_HANDOVER_REQUEST, JSON.stringify({ roomId, targetPodId: "new-pod" }))

    await vi.advanceTimersByTimeAsync(11_000)
    expect(socket.closes[0]?.code).toBe(1013)
  })

  it("ignores a request for a room it does not hold", async () => {
    const roomId = nextRoomId()
    bus.setLock(roomId, "other-pod")

    bus.publish(CHANNEL_HANDOVER_REQUEST, JSON.stringify({ roomId, targetPodId: "third-pod" }))
    await vi.waitFor(() => expect(persistRoomSnapshot).not.toHaveBeenCalled())

    expect(bus.getLockOwner(roomId)).toBe("other-pod")
  })

  it("survives a malformed handover message", async () => {
    const roomId = nextRoomId()
    await roomManager.getOrPrepareRoom(roomId)

    bus.publish(CHANNEL_HANDOVER_REQUEST, "not json")
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled())

    expect(bus.getLockOwner(roomId)).not.toBeNull()
  })
})

describe("connectSocket", () => {
  it("registers the session with the room", async () => {
    const roomId = nextRoomId()
    const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)
    const socket = fakeSocket()

    roomManager.connectSocket(room, roomId, socket, "session-1", isNewRoom)

    expect((room as unknown as FakeRoom).sessions.has("session-1")).toBe(true)
    expect((socket as unknown as { sessionId: string }).sessionId).toBe("session-1")
  })

  it("tells the room when a socket closes", async () => {
    const roomId = nextRoomId()
    const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)
    const fake = room as unknown as FakeRoom
    const first = fakeSocket()
    const second = fakeSocket()

    roomManager.connectSocket(room, roomId, first, "session-1", isNewRoom)
    roomManager.connectSocket(room, roomId, second, "session-2", false)
    first.emit("close")

    expect(fake.closedSessions).toEqual(["session-1"])
  })

  // The lock must not outlive the last client, or the room stays pinned to a
  // pod that is no longer serving it.
  it("releases the room lock once the last session leaves", async () => {
    const roomId = nextRoomId()
    const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)
    const socket = fakeSocket()
    roomManager.connectSocket(room, roomId, socket, "session-1", isNewRoom)
    expect(bus.getLockOwner(roomId)).not.toBeNull()

    socket.emit("close")
    await vi.waitFor(() => expect(bus.getLockOwner(roomId)).toBeNull())

    // The room is gone from memory, so the next connection rebuilds it.
    const reopened = await roomManager.getOrPrepareRoom(roomId)
    expect(reopened.isNewRoom).toBe(true)
  })

  it("keeps the room while other sessions remain", async () => {
    const roomId = nextRoomId()
    const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)
    const first = fakeSocket()
    const second = fakeSocket()
    roomManager.connectSocket(room, roomId, first, "session-1", isNewRoom)
    roomManager.connectSocket(room, roomId, second, "session-2", false)

    first.emit("close")

    expect(bus.getLockOwner(roomId)).not.toBeNull()
    expect((await roomManager.getOrPrepareRoom(roomId)).room).toBe(room)
  })
})

describe("shutdown", () => {
  it("persists every held room and releases its lock", async () => {
    const roomIds = [nextRoomId(), nextRoomId()]
    for (const roomId of roomIds) {
      const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)
      roomManager.connectSocket(room, roomId, fakeSocket(), `session-${roomId}`, isNewRoom)
    }

    await roomManager.shutdown()

    for (const roomId of roomIds) {
      expect(persistRoomSnapshot).toHaveBeenCalledWith(roomId, expect.anything())
      expect(bus.getLockOwner(roomId)).toBeNull()
    }
  })
})
