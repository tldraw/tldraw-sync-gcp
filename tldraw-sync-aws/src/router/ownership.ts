import { readOwner } from "../registry.js"

// How long a cached ownership answer is trusted. Short: this only exists to
// collapse the reads that several workers and connects make for the same Room
// at almost the same moment. It is not a substitute for the record.
const CACHE_TTL_MS = Number(process.env.OWNERSHIP_CACHE_TTL_MS ?? 3_000)

interface Entry {
  owner: string | null
  at: number
}

/**
 * The router's view of who owns what.
 *
 * Workers used to answer "do I still own this Room?" by reading the bucket
 * themselves, once per Room every few seconds — which was the single largest
 * line in the request bill. The router already reads these records on every
 * connect, so it is the natural place to answer the question once and share it.
 *
 * The cache is never authoritative. A miss reads the record; the answer is only
 * reused for a few seconds; and a CAS invalidates the entry it changed. What
 * makes the low poll rate safe is not this cache but the push in
 * `notifyOwnershipLost` — the router tells a worker the moment it takes a Room
 * away, so polling is a backstop for missed pushes rather than the mechanism.
 */
export class OwnershipCache {
  private entries = new Map<string, Entry>()

  /** Record what a read or a write just established. */
  note(roomId: string, owner: string | null): void {
    this.entries.set(roomId, { owner, at: Date.now() })
  }

  invalidate(roomId: string): void {
    this.entries.delete(roomId)
  }

  async ownerOf(roomId: string): Promise<string | null> {
    const cached = this.entries.get(roomId)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.owner

    const record = await readOwner(roomId)
    const owner = record?.owner ?? null
    this.note(roomId, owner)
    return owner
  }

  /**
   * Which of these Rooms does `addr` no longer own?
   *
   * Answering the negative is deliberate. A worker acting on "you have lost
   * room X" drops a Room it may still hold, and reclaims it on the next
   * connect — recoverable. A worker acting on "you still own room X" keeps
   * serving one that has moved, which is not.
   */
  async lostBy(addr: string, roomIds: string[]): Promise<string[]> {
    const owners = await Promise.all(roomIds.map((roomId) => this.ownerOf(roomId)))
    return roomIds.filter((_, index) => owners[index] !== addr)
  }
}

/**
 * Tell the previous owner it has lost a Room, the moment we take it.
 *
 * Best-effort: the worker's backstop poll catches anything this misses, so a
 * failure here costs latency, never correctness. Never await this on the
 * connect path — a client is waiting.
 */
export async function notifyOwnershipLost(previousOwner: string, roomId: string): Promise<void> {
  try {
    await fetch(`${previousOwner}/internal/lost`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId }),
      signal: AbortSignal.timeout(1000),
    })
  } catch {
    // The worker will find out at its next backstop poll.
  }
}
