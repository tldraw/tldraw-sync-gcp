import { describe, expect, it } from "vitest"
import { rendezvousPick, resolve } from "../src/router/resolve.js"

const member = (addr: string) => ({ addr })
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
