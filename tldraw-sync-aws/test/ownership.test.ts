import { beforeEach, describe, expect, it, vi } from "vitest"

const readOwner = vi.fn()
vi.mock("../src/registry.js", () => ({ readOwner }))

const { OwnershipCache } = await import("../src/router/ownership.js")

const A = "http://10.0.1.7:3001"
const B = "http://10.0.1.8:3001"

beforeEach(() => {
  readOwner.mockReset().mockResolvedValue(null)
})

describe("OwnershipCache", () => {
  it("reads the record on a miss", async () => {
    readOwner.mockResolvedValueOnce({ owner: A, etag: "1" })
    expect(await new OwnershipCache().ownerOf("room-1")).toBe(A)
    expect(readOwner).toHaveBeenCalledWith("room-1")
  })

  it("serves a second question for the same room without reading again", async () => {
    readOwner.mockResolvedValue({ owner: A, etag: "1" })
    const cache = new OwnershipCache()
    await cache.ownerOf("room-1")
    await cache.ownerOf("room-1")
    expect(readOwner).toHaveBeenCalledTimes(1)
  })

  it("trusts what a resolve just established, with no read at all", async () => {
    const cache = new OwnershipCache()
    cache.note("room-1", A)
    expect(await cache.ownerOf("room-1")).toBe(A)
    expect(readOwner).not.toHaveBeenCalled()
  })

  it("re-reads once an entry is older than its TTL", async () => {
    vi.useFakeTimers()
    readOwner.mockResolvedValue({ owner: A, etag: "1" })
    const cache = new OwnershipCache()
    await cache.ownerOf("room-1")
    vi.advanceTimersByTime(4000)
    await cache.ownerOf("room-1")
    expect(readOwner).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it("re-reads after an invalidate, because a CAS changed the record", async () => {
    readOwner.mockResolvedValue({ owner: A, etag: "1" })
    const cache = new OwnershipCache()
    await cache.ownerOf("room-1")
    cache.invalidate("room-1")
    await cache.ownerOf("room-1")
    expect(readOwner).toHaveBeenCalledTimes(2)
  })

  it("treats an absent record as owned by nobody", async () => {
    readOwner.mockResolvedValueOnce(null)
    expect(await new OwnershipCache().ownerOf("room-1")).toBeNull()
  })
})

describe("lostBy", () => {
  // Answering the negative is deliberate: acting on "you lost it" costs a
  // reclaim, acting on a stale "you still own it" means serving a moved Room.
  it("names only the rooms the caller no longer owns", async () => {
    const cache = new OwnershipCache()
    cache.note("mine-1", A)
    cache.note("mine-2", A)
    cache.note("theirs", B)
    cache.note("nobodys", null)

    expect(await cache.lostBy(A, ["mine-1", "theirs", "mine-2", "nobodys"])).toEqual([
      "theirs",
      "nobodys",
    ])
  })

  it("returns nothing when the caller still owns everything", async () => {
    const cache = new OwnershipCache()
    cache.note("mine-1", A)
    cache.note("mine-2", A)
    expect(await cache.lostBy(A, ["mine-1", "mine-2"])).toEqual([])
  })

  it("propagates a read failure rather than reporting a room as lost", async () => {
    readOwner.mockRejectedValueOnce(new Error("bucket down"))
    // The caller turns this into a 503, which tells the worker to keep serving.
    await expect(new OwnershipCache().lostBy(A, ["room-1"])).rejects.toThrow("bucket down")
  })
})
