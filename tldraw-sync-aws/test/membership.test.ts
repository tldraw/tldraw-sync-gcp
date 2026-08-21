import { beforeEach, describe, expect, it, vi } from "vitest"

const putMember = vi.fn()
const listMembers = vi.fn()
const deleteMember = vi.fn()

vi.mock("../src/registry.js", () => ({
  putMember,
  listMembers,
  deleteMember,
  liveMembers: (members: { addr: string; updatedAt: number }[]) => members,
  HEARTBEAT_INTERVAL_MS: 2000,
  MEMBER_POLL_INTERVAL_MS: 2000,
  MEMBER_TTL_MS: 8000,
}))

const { Membership, defaultAdvertiseAddr } = await import("../src/membership.js")

const ME = "http://10.0.1.7:3001"

beforeEach(() => {
  putMember.mockReset().mockResolvedValue(undefined)
  listMembers.mockReset().mockResolvedValue([])
  deleteMember.mockReset().mockResolvedValue(undefined)
})

describe("defaultAdvertiseAddr", () => {
  it("prefers an explicit ADVERTISE_ADDR", () => {
    process.env.ADVERTISE_ADDR = "https://sync-3-xyz.run.app"
    expect(defaultAdvertiseAddr()).toBe("https://sync-3-xyz.run.app")
    delete process.env.ADVERTISE_ADDR
  })

  it("otherwise builds a dialable URL with a scheme and the listen port", () => {
    delete process.env.ADVERTISE_ADDR
    process.env.PORT = "3001"
    expect(defaultAdvertiseAddr()).toMatch(/^http:\/\/.+:3001$/)
  })
})

describe("beat", () => {
  it("writes the current room count", async () => {
    const membership = new Membership(ME, () => 14, vi.fn())
    await membership.beat()
    expect(putMember).toHaveBeenCalledWith(ME, 14)
  })

  it("swallows a failed write so the loop keeps running", async () => {
    putMember.mockRejectedValueOnce(new Error("SlowDown"))
    const membership = new Membership(ME, () => 0, vi.fn())
    await expect(membership.beat()).resolves.toBeUndefined()
  })
})

describe("selfCheck", () => {
  it("does nothing before the first heartbeat has landed", async () => {
    const onEvicted = vi.fn()
    const membership = new Membership(ME, () => 0, onEvicted)
    await membership.selfCheck()
    expect(listMembers).not.toHaveBeenCalled()
    expect(onEvicted).not.toHaveBeenCalled()
  })

  it("stays quiet while it can find itself in the live set", async () => {
    const onEvicted = vi.fn()
    const membership = new Membership(ME, () => 0, onEvicted)
    await membership.beat()
    listMembers.mockResolvedValueOnce([{ addr: ME, updatedAt: Date.now() }])
    await membership.selfCheck()
    expect(onEvicted).not.toHaveBeenCalled()
  })

  it("reports eviction when a successful read does not contain it", async () => {
    const onEvicted = vi.fn()
    const membership = new Membership(ME, () => 0, onEvicted)
    await membership.beat()
    listMembers.mockResolvedValueOnce([{ addr: "http://10.0.1.8:3001", updatedAt: Date.now() }])
    await membership.selfCheck()
    expect(onEvicted).toHaveBeenCalledTimes(1)
  })

  it("fails open when the read itself fails, since a blip is not an eviction", async () => {
    const onEvicted = vi.fn()
    const membership = new Membership(ME, () => 0, onEvicted)
    await membership.beat()
    listMembers.mockRejectedValueOnce(new Error("network"))
    await membership.selfCheck()
    expect(onEvicted).not.toHaveBeenCalled()
  })
})

describe("stop", () => {
  it("deregisters so routers drop it at their next poll, without waiting out the TTL", async () => {
    const membership = new Membership(ME, () => 0, vi.fn())
    membership.start()
    await membership.stop()
    expect(deleteMember).toHaveBeenCalledWith(ME)
  })

  it("stops heartbeating after stop, so the record cannot come back", async () => {
    vi.useFakeTimers()
    const membership = new Membership(ME, () => 0, vi.fn())
    membership.start()
    await membership.stop()
    putMember.mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(putMember).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
