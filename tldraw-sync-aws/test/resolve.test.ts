import { describe, expect, it } from "vitest"
import { rendezvousPick, resolve } from "../src/router/resolve.js"

const member = (addr: string, rooms = 0) => ({ addr, rooms })
const A = "http://10.0.1.7:3001"
const B = "http://10.0.1.8:3001"
const C = "http://10.0.1.9:3001"

describe("rendezvousPick", () => {
  it("returns null when nothing is live", () => {
    expect(rendezvousPick("room-1", [])).toBeNull()
  })

  it("is deterministic for the same room and member set", () => {
    const first = rendezvousPick("room-1", [member(A), member(B), member(C)])
    const second = rendezvousPick("room-1", [member(A), member(B), member(C)])
    expect(first).toBe(second)
  })

  it("does not depend on the order members arrive in", () => {
    const forwards = rendezvousPick("room-1", [member(A), member(B), member(C)])
    const backwards = rendezvousPick("room-1", [member(C), member(B), member(A)])
    expect(forwards).toBe(backwards)
  })

  it("keeps a room where it was unless the new member wins it outright", () => {
    const before = rendezvousPick("room-1", [member(A), member(B)])
    const after = rendezvousPick("room-1", [member(A), member(B), member(C)])
    expect(after === before || after === C).toBe(true)
  })

  it("spreads rooms across members rather than piling onto one", () => {
    const picks = new Set(
      Array.from({ length: 60 }, (_, i) =>
        rendezvousPick(`room-${i}`, [member(A), member(B), member(C)]),
      ),
    )
    expect(picks.size).toBe(3)
  })
})

describe("resolve", () => {
  it("uses the recorded owner when it is live", () => {
    expect(resolve("room-1", { owner: A, etag: '"e1"' }, [member(A), member(B)])).toEqual({
      action: "use",
      addr: A,
    })
  })

  it("claims with expect=null when there is no record at all", () => {
    expect(resolve("room-1", null, [member(A), member(B)])).toMatchObject({
      action: "claim",
      expect: null,
    })
  })

  it("reallocates against the current etag when the owner is not live", () => {
    expect(resolve("room-1", { owner: "http://10.0.9.9:3001", etag: '"e1"' }, [member(A)])).toEqual(
      {
        action: "claim",
        addr: A,
        expect: '"e1"',
      },
    )
  })

  it("claims a vacated record against its etag, not as an absent one", () => {
    expect(resolve("room-1", { owner: null, etag: '"e2"' }, [member(A)])).toEqual({
      action: "claim",
      addr: A,
      expect: '"e2"',
    })
  })

  it("is unavailable when nothing is live, rather than naming a dead owner", () => {
    expect(resolve("room-1", { owner: A, etag: '"e1"' }, [])).toEqual({ action: "unavailable" })
  })

  it("picks the same worker as a bare rendezvous when claiming", () => {
    const live = [member(A), member(B), member(C)]
    expect(resolve("room-1", null, live)).toMatchObject({ addr: rendezvousPick("room-1", live) })
  })
})

// The weighting is deterministic — SHA-1 over fixed inputs — so these
// distribution assertions are exact re-runs, not statistical flake.
describe("weighted allocation", () => {
  const share = (picks: (string | null)[], addr: string) =>
    picks.filter((pick) => pick === addr).length / picks.length

  it("allocates evenly when members carry equal load", () => {
    const live = [member(A, 5), member(B, 5), member(C, 5)]
    const picks = Array.from({ length: 3000 }, (_, i) => rendezvousPick(`room-${i}`, live))
    for (const addr of [A, B, C]) {
      expect(share(picks, addr)).toBeGreaterThan(0.29)
      expect(share(picks, addr)).toBeLessThan(0.38)
    }
  })

  it("gives a lightly loaded member proportionally more of the new rooms", () => {
    // Weight is 1/(1+rooms): A at 1 and B at 1/2, so A should take ~2/3.
    const live = [member(A, 0), member(B, 1)]
    const picks = Array.from({ length: 2000 }, (_, i) => rendezvousPick(`room-${i}`, live))
    expect(share(picks, A)).toBeGreaterThan(0.62)
    expect(share(picks, A)).toBeLessThan(0.72)
  })

  it("moves rooms only to or from the member whose load changed", () => {
    const before = [member(A, 0), member(B, 0), member(C, 0)]
    const after = [member(A, 0), member(B, 0), member(C, 9)]
    const moves = Array.from({ length: 900 }, (_, i) => `room-${i}`)
      .map((roomId) => ({
        was: rendezvousPick(roomId, before),
        now: rendezvousPick(roomId, after),
      }))
      .filter(({ was, now }) => was !== now)
    // C got heavier, so rooms must actually leave it...
    expect(moves.length).toBeGreaterThan(0)
    // ...and every move involves C: nothing shuffles between A and B.
    for (const { was, now } of moves) expect(was === C || now === C).toBe(true)
  })
})
