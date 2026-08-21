import { createHash } from "crypto"

// Pure. No I/O and no import from registry.ts — the point of this file is that
// both transports share one decision that can be tested without mocks.

export interface LiveMember {
  addr: string
  /** How many Rooms this worker currently holds; the input to its weight. */
  rooms: number
}

export type Resolution =
  | { action: "use"; addr: string }
  | { action: "claim"; addr: string; expect: string | null }
  | { action: "unavailable" }

// Weighted rendezvous (highest random weight) hashing: score every member
// against the room and take the winner. Two routers with the same member view
// reach the same answer without talking to each other; where their views of a
// weight briefly differ, the CAS arbitrates exactly as it does for any other
// disagreement. The -w/ln(h) form is the standard one because it keeps both
// properties that matter here: a member wins new rooms in exact proportion to
// its weight, and changing one member's weight only moves rooms to or from
// that member — never between bystanders.
//
// The weight itself is the policy: 1/(1+rooms) fills the least-loaded worker
// fastest and converges as counts equalise. It is the only line to tune.
function score(roomId: string, member: LiveMember): number {
  const hex = createHash("sha1").update(`${roomId} ${member.addr}`).digest("hex")
  // 52 bits of hash, offset so h is strictly inside (0, 1): ln(h) is then
  // always finite and negative, and the score always finite and positive.
  const h = (parseInt(hex.slice(0, 13), 16) + 0.5) / 2 ** 52
  return -(1 / (1 + member.rooms)) / Math.log(h)
}

export function rendezvousPick(roomId: string, live: LiveMember[]): string | null {
  let bestAddr: string | null = null
  let bestScore = -Infinity

  for (const member of live) {
    const memberScore = score(roomId, member)
    // Tie-break on the address so the result cannot depend on iteration order.
    if (memberScore > bestScore || (memberScore === bestScore && member.addr > (bestAddr ?? ""))) {
      bestAddr = member.addr
      bestScore = memberScore
    }
  }

  return bestAddr
}

/**
 * Which worker should serve this Room?
 *
 * A recorded owner wins outright while it is live — that is the guarantee the
 * whole design exists for. Otherwise the Room is up for allocation, and the
 * caller must CAS the answer in before trusting it: `expect` carries the
 * precondition, null meaning "there was no record".
 */
export function resolve(
  roomId: string,
  record: { owner: string | null; etag: string } | null,
  live: LiveMember[],
): Resolution {
  if (record?.owner && live.some((member) => member.addr === record.owner)) {
    return { action: "use", addr: record.owner }
  }

  const pick = rendezvousPick(roomId, live)
  if (!pick) return { action: "unavailable" }

  // A vacated record still exists, so it is reallocated against its etag. Only
  // a genuinely absent record uses the "must not exist" precondition.
  return { action: "claim", addr: pick, expect: record ? record.etag : null }
}
