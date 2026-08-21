import { beforeEach, describe, expect, it, vi } from "vitest"
import { bus, createClient } from "./helpers/fakeRedis.js"

vi.mock("redis", () => ({ createClient }))

const A = "http://10.0.1.7:3001"
const B = "http://10.0.1.8:3001"

const { readOwner, casOwner, putMember, listMembers, deleteMember } =
  await import("../src/registryRedis.js")

beforeEach(() => bus.reset())

// The whole point of a second backend is that it answers identically to the
// first. These mirror test/registry.test.ts case for case.
describe("readOwner", () => {
  it("returns null when no record exists", async () => {
    expect(await readOwner("room-1")).toBeNull()
  })

  it("returns the owner and the version as the etag", async () => {
    await casOwner("room-1", null, A)
    expect(await readOwner("room-1")).toEqual({ owner: A, etag: "1" })
  })

  it("treats a vacated record as an existing record with a null owner", async () => {
    await casOwner("room-1", null, A)
    await casOwner("room-1", "1", null)
    expect(await readOwner("room-1")).toEqual({ owner: null, etag: "2" })
  })
})

describe("casOwner", () => {
  it("claims an absent record", async () => {
    expect(await casOwner("room-1", null, A)).toBe("ok")
    expect(bus.ownerOf("room-1")).toBe(A)
  })

  it("refuses a second claim of the same record", async () => {
    await casOwner("room-1", null, A)
    expect(await casOwner("room-1", null, B)).toBe("conflict")
    expect(bus.ownerOf("room-1")).toBe(A)
  })

  it("reallocates against the current version", async () => {
    await casOwner("room-1", null, A)
    expect(await casOwner("room-1", "1", B)).toBe("ok")
    expect(bus.ownerOf("room-1")).toBe(B)
  })

  it("refuses a stale version", async () => {
    await casOwner("room-1", null, A)
    await casOwner("room-1", "1", B)
    expect(await casOwner("room-1", "1", A)).toBe("conflict")
    expect(bus.ownerOf("room-1")).toBe(B)
  })

  it("bumps the version on every write, so an etag is never reusable", async () => {
    await casOwner("room-1", null, A)
    expect(bus.versionOf("room-1")).toBe("1")
    await casOwner("room-1", "1", B)
    expect(bus.versionOf("room-1")).toBe("2")
  })

  it("vacates by writing an empty owner, never by deleting the key", async () => {
    await casOwner("room-1", null, A)
    expect(await casOwner("room-1", "1", null)).toBe("ok")
    // The record must still exist: a vacated Room is reclaimed by CAS, and a
    // deleted one would let two workers both "create" it.
    expect(await readOwner("room-1")).not.toBeNull()
  })

  it("requires the etag to reclaim a vacated record, not must-not-exist", async () => {
    await casOwner("room-1", null, A)
    await casOwner("room-1", "1", null)
    expect(await casOwner("room-1", null, B)).toBe("conflict")
    expect(await casOwner("room-1", "2", B)).toBe("ok")
  })
})

describe("membership", () => {
  it("lists what has been written", async () => {
    await putMember(A, 3)
    await putMember(B, 7)
    expect((await listMembers()).map((m) => m.addr).sort()).toEqual([A, B].sort())
  })

  it("keeps the room count for later, without putting it on the hot path", async () => {
    await putMember(A, 14)
    expect(bus.roomsFor(A)).toBe("14")
  })

  it("returns each member's room count, for the allocation weight", async () => {
    await putMember(A, 3)
    await putMember(B, 7)
    const members = await listMembers()
    expect(members.find((m) => m.addr === A)?.rooms).toBe(3)
    expect(members.find((m) => m.addr === B)?.rooms).toBe(7)
  })

  it("drops entries older than the TTL", async () => {
    await putMember(A, 0)
    bus.advance(9000)
    await putMember(B, 0)
    expect((await listMembers()).map((m) => m.addr)).toEqual([B])
  })

  it("keeps entries that are still inside the TTL", async () => {
    await putMember(A, 0)
    bus.advance(7000)
    expect((await listMembers()).map((m) => m.addr)).toEqual([A])
  })

  it("refreshes an existing member rather than duplicating it", async () => {
    await putMember(A, 0)
    bus.advance(5000)
    await putMember(A, 1)
    bus.advance(5000)
    // Would have expired at 10s had the second heartbeat not moved the score.
    expect((await listMembers()).map((m) => m.addr)).toEqual([A])
  })

  it("expresses Redis's clock in local terms, so liveMembers still works", async () => {
    await putMember(A, 0)
    bus.advance(3000)
    const [member] = await listMembers()
    // Written 3s ago on the server, so it should read as ~3s ago locally, even
    // though the two clocks share no origin.
    expect(Date.now() - member.updatedAt).toBeGreaterThan(2500)
    expect(Date.now() - member.updatedAt).toBeLessThan(3500)
  })

  it("returns an empty list when nothing has ever registered", async () => {
    expect(await listMembers()).toEqual([])
  })

  it("removes a member on drain", async () => {
    await putMember(A, 0)
    await putMember(B, 0)
    await deleteMember(A)
    expect((await listMembers()).map((m) => m.addr)).toEqual([B])
  })
})
