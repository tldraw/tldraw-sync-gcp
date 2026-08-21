import { createHash } from "crypto"

// Pure. No I/O and no import from registry.ts — the point of this file is that
// both transports share one decision that can be tested without mocks.

export interface LiveMember {
  addr: string
}

export type Resolution =
  | { action: "use"; addr: string }
  | { action: "claim"; addr: string; expect: string | null }
  | { action: "unavailable" }

// Rendezvous (highest random weight) hashing: score every member against the
// room and take the winner. Two routers racing the same unclaimed Room reach
// the same answer without talking to each other, and adding a member moves
// only the rooms that member itself wins.
function score(roomId: string, addr: string): string {
  return createHash("sha1").update(`${roomId} ${addr}`).digest("hex")
}

export function rendezvousPick(roomId: string, live: LiveMember[]): string | null {
  let bestAddr: string | null = null
  let bestScore = ""

  for (const member of live) {
    const memberScore = score(roomId, member.addr)
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
