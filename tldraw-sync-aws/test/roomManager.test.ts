import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "events"
import type { WebSocket } from "ws"

const readOwner = vi.fn()
const casOwner = vi.fn()

vi.mock("../src/registry.js", () => ({
  readOwner,
  casOwner,
  OWNERSHIP_RECHECK_INTERVAL_MS: 5000,
}))

const fetchRoomSnapshot = vi.fn()
const persistRoomSnapshot = vi.fn()
vi.mock("../src/s3Storage.js", () => ({ fetchRoomSnapshot, persistRoomSnapshot }))

const ME = "http://10.0.1.7:3001"
const THEM = "http://10.0.1.8:3001"
vi.mock("../src/membership.js", () => ({
  defaultAdvertiseAddr: () => ME,
  Membership: class {
    constructor(
      readonly addr: string,
      readonly roomCount: () => number,
      readonly onEvicted: () => void,
    ) {}
    start() {}
    async stop() {}
  },
}))

// Stands in for TLSocketRoom. Same shape as the pre-existing fake.
class FakeRoom {
  static instances: FakeRoom[] = []
  sessions = new Set<string>()
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
    this.sessions.delete(sessionId)
    this.config.onSessionRemoved(this, { sessionId, numSessionsRemaining: this.sessions.size })
  }
}
vi.mock("@tldraw/sync-core", () => ({ TLSocketRoom: FakeRoom }))

const { roomManager, NotOwnerError } = await import("../src/roomManager.js")

// The manager is a module-level singleton whose maps live for the whole file.
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

async function connect(roomId: string) {
  const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)
  const socket = fakeSocket()
  roomManager.connectSocket(room, roomId, socket, `session-${roomId}`, isNewRoom)
  return socket
}

beforeEach(() => {
  readOwner.mockReset().mockResolvedValue(null)
  casOwner.mockReset().mockResolvedValue("ok")
  fetchRoomSnapshot.mockReset().mockResolvedValue(undefined)
  persistRoomSnapshot.mockReset().mockResolvedValue(true)
})

describe("claiming a room", () => {
  it("claims an absent record with the must-not-exist precondition", async () => {
    const roomId = nextRoomId()
    await roomManager.getOrPrepareRoom(roomId)
    expect(casOwner).toHaveBeenCalledWith(roomId, null, ME)
  })

  it("serves without a CAS when the record already names us", async () => {
    const roomId = nextRoomId()
    readOwner.mockResolvedValueOnce({ owner: ME, etag: '"e1"' })
    await roomManager.getOrPrepareRoom(roomId)
    expect(casOwner).not.toHaveBeenCalled()
  })

  it("reallocates a dead owner's record against its etag", async () => {
    const roomId = nextRoomId()
    readOwner.mockResolvedValueOnce({ owner: null, etag: '"e2"' })
    await roomManager.getOrPrepareRoom(roomId)
    expect(casOwner).toHaveBeenCalledWith(roomId, '"e2"', ME)
  })

  it("refuses with the correction when the record names someone else", async () => {
    const roomId = nextRoomId()
    readOwner.mockResolvedValue({ owner: THEM, etag: '"e1"' })
    await expect(roomManager.getOrPrepareRoom(roomId)).rejects.toThrow(NotOwnerError)
    await expect(roomManager.getOrPrepareRoom(roomId)).rejects.toMatchObject({ owner: THEM })
  })

  it("re-reads after a lost CAS and refuses with the winner's address", async () => {
    const roomId = nextRoomId()
    readOwner.mockResolvedValueOnce(null).mockResolvedValueOnce({ owner: THEM, etag: '"e3"' })
    casOwner.mockResolvedValueOnce("conflict")
    await expect(roomManager.getOrPrepareRoom(roomId)).rejects.toMatchObject({ owner: THEM })
  })

  it("serves after a lost CAS that the re-read shows we won anyway", async () => {
    const roomId = nextRoomId()
    readOwner.mockResolvedValueOnce(null).mockResolvedValueOnce({ owner: ME, etag: '"e4"' })
    casOwner.mockResolvedValueOnce("conflict")
    await expect(roomManager.getOrPrepareRoom(roomId)).resolves.toMatchObject({ isNewRoom: true })
  })

  it("collapses concurrent connects for one room into a single claim", async () => {
    const roomId = nextRoomId()
    await Promise.all([
      roomManager.getOrPrepareRoom(roomId),
      roomManager.getOrPrepareRoom(roomId),
      roomManager.getOrPrepareRoom(roomId),
    ])
    expect(casOwner).toHaveBeenCalledTimes(1)
  })
})

describe("losing ownership", () => {
  it("drops the room without saving and closes sessions 1013", async () => {
    const roomId = nextRoomId()
    const socket = await connect(roomId)
    persistRoomSnapshot.mockClear()

    readOwner.mockResolvedValue({ owner: THEM, etag: '"e5"' })
    await roomManager.recheckAll()

    expect(persistRoomSnapshot).not.toHaveBeenCalled()
    expect(socket.closes).toEqual([
      { code: 1013, reason: "Room reallocated to another server, please reconnect" },
    ])
  })

  it("keeps serving when the ownership read fails, since a blip is not a loss", async () => {
    const roomId = nextRoomId()
    const socket = await connect(roomId)
    readOwner.mockRejectedValue(new Error("network"))
    await roomManager.recheckAll()
    expect(socket.closes).toEqual([])
  })

  it("keeps serving while the record still names us", async () => {
    const roomId = nextRoomId()
    const socket = await connect(roomId)
    readOwner.mockResolvedValue({ owner: ME, etag: '"e6"' })
    await roomManager.recheckAll()
    expect(socket.closes).toEqual([])
  })
})

describe("draining", () => {
  // drain() drains every active Room, and the manager is a module-level
  // singleton, so Rooms from earlier tests are still held here. Assertions are
  // therefore scoped to the Room under test rather than to the whole call.
  it("persists before vacating, never the other way round", async () => {
    const roomId = nextRoomId()
    await connect(roomId)
    const order: string[] = []
    persistRoomSnapshot.mockImplementation(async (id: string) => {
      order.push(`persist:${id}`)
      return true
    })
    readOwner.mockResolvedValue({ owner: ME, etag: '"e7"' })
    casOwner.mockImplementation(async (id: string) => {
      order.push(`vacate:${id}`)
      return "ok"
    })

    await roomManager.drain()

    const persisted = order.indexOf(`persist:${roomId}`)
    const vacated = order.indexOf(`vacate:${roomId}`)
    expect(persisted).toBeGreaterThanOrEqual(0)
    expect(vacated).toBeGreaterThan(persisted)
  })

  it("vacates by CAS to null against the current etag", async () => {
    const roomId = nextRoomId()
    await connect(roomId)
    readOwner.mockResolvedValue({ owner: ME, etag: '"e8"' })
    await roomManager.drain()
    expect(casOwner).toHaveBeenCalledWith(roomId, '"e8"', null)
  })

  it("does not vacate a record that has already moved on", async () => {
    const roomId = nextRoomId()
    await connect(roomId)
    casOwner.mockClear()
    readOwner.mockResolvedValue({ owner: THEM, etag: '"e9"' })
    await roomManager.drain()
    expect(casOwner.mock.calls.filter(([id]) => id === roomId)).toEqual([])
  })

  it("closes drained sessions 1013 so clients reconnect elsewhere", async () => {
    const roomId = nextRoomId()
    const socket = await connect(roomId)
    readOwner.mockResolvedValue({ owner: ME, etag: '"e10"' })
    await roomManager.drain()
    expect(socket.closes[0]).toMatchObject({ code: 1013 })
  })
})

describe("snapshot writes", () => {
  it("re-reads ownership before persisting and skips the write if it moved", async () => {
    const roomId = nextRoomId()
    await connect(roomId)
    persistRoomSnapshot.mockClear()

    readOwner.mockResolvedValue({ owner: THEM, etag: '"e11"' })
    await roomManager.saveRoom(roomId)

    expect(persistRoomSnapshot).not.toHaveBeenCalled()
  })

  it("persists when the record still names us", async () => {
    const roomId = nextRoomId()
    await connect(roomId)
    persistRoomSnapshot.mockClear()
    readOwner.mockResolvedValue({ owner: ME, etag: '"e12"' })
    await roomManager.saveRoom(roomId)
    expect(persistRoomSnapshot).toHaveBeenCalledWith(roomId, { clock: 1, documents: [] })
  })
})

describe("roomCount", () => {
  it("reports how many rooms are held, for the heartbeat body", async () => {
    const before = roomManager.roomCount()
    await connect(nextRoomId())
    expect(roomManager.roomCount()).toBe(before + 1)
  })
})

describe("persistence health check", () => {
  // Ownership says a worker MAY hold a Room; being able to save is what makes
  // that worth anything. With the Redis registry those are separate questions,
  // so the capability is tested rather than inferred.
  //
  // The manager is a module-level singleton, so the failure counter carries
  // between tests: every case below starts with a successful save to zero it.
  // Surrender is deliberately one-way, so the case that triggers it comes last
  // and asserts everything about it at once.
  async function healthyRoom(etag: string) {
    const roomId = nextRoomId()
    const socket = await connect(roomId)
    readOwner.mockResolvedValue({ owner: ME, etag })
    persistRoomSnapshot.mockResolvedValue(true)
    await roomManager.saveRoom(roomId)
    return { roomId, socket }
  }

  it("stays healthy while writes land", async () => {
    const { roomId } = await healthyRoom('"h1"')
    await roomManager.saveRoom(roomId)
    expect(roomManager.healthy).toBe(true)
  })

  it("tolerates failures below the threshold", async () => {
    const { roomId } = await healthyRoom('"h2"')
    persistRoomSnapshot.mockResolvedValue(false)
    await roomManager.saveRoom(roomId)
    await roomManager.saveRoom(roomId)
    expect(roomManager.healthy).toBe(true)
  })

  it("counts consecutively, so a success in between clears the tally", async () => {
    const { roomId } = await healthyRoom('"h3"')

    persistRoomSnapshot.mockResolvedValue(false)
    await roomManager.saveRoom(roomId)
    await roomManager.saveRoom(roomId)
    persistRoomSnapshot.mockResolvedValue(true)
    await roomManager.saveRoom(roomId)
    persistRoomSnapshot.mockResolvedValue(false)
    await roomManager.saveRoom(roomId)
    await roomManager.saveRoom(roomId)

    // Five failures overall but never three in a row.
    expect(roomManager.healthy).toBe(true)
  })

  it("surrenders every room, vacates ownership and fails health at the threshold", async () => {
    const { roomId, socket } = await healthyRoom('"h4"')
    casOwner.mockClear()
    persistRoomSnapshot.mockResolvedValue(false)

    await roomManager.saveRoom(roomId)
    await roomManager.saveRoom(roomId)
    await roomManager.saveRoom(roomId)

    expect(roomManager.healthy).toBe(false)
    expect(roomManager.roomCount()).toBe(0)
    expect(socket.closes[0]).toMatchObject({ code: 1013 })
    // The registry is still reachable in the case this exists for (Redis up,
    // S3 down), so Rooms are handed back rather than left to time out.
    expect(casOwner).toHaveBeenCalledWith(roomId, '"h4"', null)
  })
})

describe("router-backed ownership re-check", () => {
  // The push is the mechanism; this poll is the backstop for pushes that went
  // missing. One batched question replaces one read per Room.
  const ROUTER = "http://router.internal:8081"
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env.ROUTER_INTERNAL_URL = ROUTER
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    delete process.env.ROUTER_INTERNAL_URL
    vi.unstubAllGlobals()
  })

  it("asks the router once for every room it holds, not once per room", async () => {
    const first = nextRoomId()
    const second = nextRoomId()
    await connect(first)
    await connect(second)
    readOwner.mockClear()
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ lost: [] }) })

    await roomManager.recheckAll()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${ROUTER}/internal/ownership`)
    const body = JSON.parse(init.body)
    expect(body.addr).toBe(ME)
    expect(body.roomIds).toEqual(expect.arrayContaining([first, second]))
    // The whole point: no per-Room reads against the store.
    expect(readOwner).not.toHaveBeenCalled()
  })

  it("gives up exactly the rooms the router says have moved", async () => {
    const kept = nextRoomId()
    const lost = nextRoomId()
    const keptSocket = await connect(kept)
    const lostSocket = await connect(lost)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ lost: [lost] }) })

    await roomManager.recheckAll()

    expect(lostSocket.closes[0]).toMatchObject({ code: 1013 })
    expect(keptSocket.closes).toEqual([])
  })

  it("keeps serving when the router cannot answer, since a blip is not a loss", async () => {
    const roomId = nextRoomId()
    const socket = await connect(roomId)
    fetchMock.mockResolvedValue({ ok: false, status: 503 })

    await roomManager.recheckAll()

    expect(socket.closes).toEqual([])
  })

  it("keeps serving when the router is unreachable", async () => {
    const roomId = nextRoomId()
    const socket = await connect(roomId)
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"))

    await roomManager.recheckAll()

    expect(socket.closes).toEqual([])
  })

  it("falls back to reading each record when no router is configured", async () => {
    delete process.env.ROUTER_INTERNAL_URL
    const roomId = nextRoomId()
    const socket = await connect(roomId)
    readOwner.mockResolvedValue({ owner: THEM, etag: '"r1"' })

    await roomManager.recheckAll()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(socket.closes[0]).toMatchObject({ code: 1013 })
  })
})

describe("ownership loss pushed by the router", () => {
  it("drops the room immediately, without saving", async () => {
    const roomId = nextRoomId()
    const socket = await connect(roomId)
    persistRoomSnapshot.mockClear()

    roomManager.onOwnershipLost(roomId)

    expect(socket.closes[0]).toMatchObject({ code: 1013 })
    expect(persistRoomSnapshot).not.toHaveBeenCalled()
  })

  it("ignores a push for a room it is not holding", async () => {
    expect(() => roomManager.onOwnershipLost("never-heard-of-it")).not.toThrow()
  })
})
