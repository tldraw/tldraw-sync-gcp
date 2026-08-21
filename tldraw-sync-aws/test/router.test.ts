import { beforeEach, describe, expect, it, vi } from "vitest"

const listMembers = vi.fn()
const readOwner = vi.fn()
const casOwner = vi.fn()

vi.mock("../src/registry.js", () => ({
  listMembers,
  readOwner,
  casOwner,
  liveMembers: (members: { addr: string; updatedAt: number }[], now: number) =>
    members.filter((m) => now - m.updatedAt < 8000),
  MEMBER_POLL_INTERVAL_MS: 2000,
  MEMBER_TTL_MS: 8000,
}))

const notifyOwnershipLost = vi.fn()
vi.mock("../src/router/ownership.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/router/ownership.js")>()
  return { ...actual, notifyOwnershipLost }
})

vi.mock("../src/metrics.js", () => ({
  register: { contentType: "text/plain", metrics: async () => "" },
  membersLiveGauge: { set: vi.fn() },
  routerResolveDuration: { startTimer: () => () => undefined },
  routerRetriesCounter: { inc: vi.fn() },
}))

const { MemberCache } = await import("../src/router/memberCache.js")
const { resolveForConnect } = await import("../src/router/proxy.js")

const A = "http://10.0.1.7:3001"
const B = "http://10.0.1.8:3001"

beforeEach(() => {
  listMembers.mockReset().mockResolvedValue([])
  readOwner.mockReset().mockResolvedValue(null)
  casOwner.mockReset().mockResolvedValue("ok")
})

describe("MemberCache", () => {
  it("exposes only members inside the TTL", async () => {
    listMembers.mockResolvedValueOnce([
      { addr: A, updatedAt: Date.now() },
      { addr: B, updatedAt: Date.now() - 9000 },
    ])
    const cache = new MemberCache()
    await cache.refresh()
    expect(cache.live().map((m) => m.addr)).toEqual([A])
  })

  it("keeps the last good list when a poll fails, rather than emptying", async () => {
    listMembers.mockResolvedValueOnce([{ addr: A, updatedAt: Date.now() }])
    const cache = new MemberCache()
    await cache.refresh()
    listMembers.mockRejectedValueOnce(new Error("network"))
    await cache.refresh()
    expect(cache.live().map((m) => m.addr)).toEqual([A])
  })

  it("keeps an unreachable worker live — reachability is not liveness", async () => {
    listMembers.mockResolvedValueOnce([{ addr: A, updatedAt: Date.now() }])
    const cache = new MemberCache()
    await cache.refresh()
    cache.markUnreachable(A)
    expect(cache.live().map((m) => m.addr)).toEqual([A])
  })

  it("drops an unreachable worker from allocation candidates", async () => {
    listMembers.mockResolvedValueOnce([
      { addr: A, updatedAt: Date.now() },
      { addr: B, updatedAt: Date.now() },
    ])
    const cache = new MemberCache()
    await cache.refresh()
    cache.markUnreachable(A)
    expect(cache.routable().map((m) => m.addr)).toEqual([B])
  })

  it("forgets unreachability once the worker heartbeats again", async () => {
    listMembers.mockResolvedValue([{ addr: A, updatedAt: Date.now() }])
    const cache = new MemberCache()
    await cache.refresh()
    cache.markUnreachable(A)
    expect(cache.routable()).toHaveLength(0)
    await cache.refresh()
    expect(cache.routable().map((m) => m.addr)).toEqual([A])
  })
})

describe("resolveForConnect", () => {
  async function cacheWith(addrs: string[]) {
    listMembers.mockResolvedValueOnce(
      addrs.map((addr) => ({ addr, updatedAt: Date.now() })),
    )
    const cache = new MemberCache()
    await cache.refresh()
    return cache
  }

  it("routes to a live recorded owner without writing anything", async () => {
    readOwner.mockResolvedValueOnce({ owner: A, etag: '"e1"' })
    expect(await resolveForConnect("room-1", await cacheWith([A, B]))).toEqual({ addr: A })
    expect(casOwner).not.toHaveBeenCalled()
  })

  it("claims an unowned room and routes to the winner", async () => {
    const cache = await cacheWith([A, B])
    const result = await resolveForConnect("room-1", cache)
    expect(casOwner).toHaveBeenCalledWith("room-1", null, expect.any(String))
    expect(result).toHaveProperty("addr")
  })

  it("uses the winner's answer after a lost CAS instead of its own pick", async () => {
    readOwner.mockResolvedValueOnce(null).mockResolvedValueOnce({ owner: B, etag: '"e2"' })
    casOwner.mockResolvedValueOnce("conflict")
    expect(await resolveForConnect("room-1", await cacheWith([A, B]))).toEqual({ addr: B })
  })

  it("returns 503 when nothing is live, rather than dialling a dead address", async () => {
    readOwner.mockResolvedValueOnce({ owner: A, etag: '"e1"' })
    expect(await resolveForConnect("room-1", await cacheWith([]))).toEqual({ error: 503 })
  })

  it("honours a live owner this router cannot reach, and does not reallocate it", async () => {
    readOwner.mockResolvedValueOnce({ owner: A, etag: '"e1"' })
    const cache = await cacheWith([A, B])
    cache.markUnreachable(A)
    expect(await resolveForConnect("room-1", cache)).toEqual({ addr: A })
    expect(casOwner).not.toHaveBeenCalled()
  })

  it("avoids an unreachable worker when allocating an unclaimed room", async () => {
    const cache = await cacheWith([A, B])
    cache.markUnreachable(A)
    expect(await resolveForConnect("room-1", cache)).toEqual({ addr: B })
  })

  it("returns 503 rather than a bad route when the bucket read fails", async () => {
    readOwner.mockRejectedValueOnce(new Error("network"))
    expect(await resolveForConnect("room-1", await cacheWith([A]))).toEqual({ error: 503 })
  })
})

describe("telling a worker it lost a room", () => {
  async function cacheWith(addrs: string[]) {
    listMembers.mockResolvedValueOnce(
      addrs.map((addr) => ({ addr, updatedAt: Date.now() })),
    )
    const cache = new MemberCache()
    await cache.refresh()
    return cache
  }

  beforeEach(() => notifyOwnershipLost.mockReset())

  // Only fires when a Room is taken from a worker that had it. A worker that
  // drained has already vacated, so there is nobody to tell — which is why this
  // path is quiet in normal operation and exists for the case where a router
  // with a stale member view reallocates a Room from a worker that is alive.
  it("notifies the previous owner when it reallocates their room", async () => {
    readOwner.mockResolvedValueOnce({ owner: A, etag: '"e1"' })
    // A is recorded but not live, so the Room is up for reallocation.
    await resolveForConnect("room-1", await cacheWith([B]))
    expect(notifyOwnershipLost).toHaveBeenCalledWith(A, "room-1")
  })

  it("says nothing when the record was vacant, since nobody lost anything", async () => {
    readOwner.mockResolvedValueOnce({ owner: null, etag: '"e2"' })
    await resolveForConnect("room-1", await cacheWith([A]))
    expect(notifyOwnershipLost).not.toHaveBeenCalled()
  })

  it("says nothing when there was no record at all", async () => {
    await resolveForConnect("room-1", await cacheWith([A]))
    expect(notifyOwnershipLost).not.toHaveBeenCalled()
  })

  it("says nothing when it merely routes to the existing owner", async () => {
    readOwner.mockResolvedValueOnce({ owner: A, etag: '"e3"' })
    await resolveForConnect("room-1", await cacheWith([A]))
    expect(notifyOwnershipLost).not.toHaveBeenCalled()
  })
})
