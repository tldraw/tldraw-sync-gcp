import { MEMBER_POLL_INTERVAL_MS, listMembers, liveMembers, type Member } from "../registry.js"
import { membersLiveGauge } from "../metrics.js"
import type { LiveMember } from "./resolve.js"

// How long a failed dial keeps a worker out of allocation. Short: this is a
// routing preference, not a verdict, and a fresh heartbeat clears it anyway.
const UNREACHABLE_COOLDOWN_MS = 5_000

/**
 * The router's view of the fleet.
 *
 * Two lists, and the difference between them is the whole safety property:
 * `live()` answers "does the recorded owner still count", and a worker this
 * router cannot dial stays in it. `routable()` answers "who should take a Room
 * nobody owns", and there it is fair to skip one we cannot reach. Reachability
 * never evicts and never triggers a CAS.
 */
export class MemberCache {
  private members: Member[] = []
  private unreachableUntil = new Map<string, number>()
  private draining = new Set<string>()
  private timer?: NodeJS.Timeout

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), MEMBER_POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async refresh(): Promise<void> {
    try {
      const members = await listMembers()
      this.members = members
      for (const member of members) {
        // A fresh heartbeat is better evidence than our last failed dial.
        this.unreachableUntil.delete(member.addr)
        // A worker that deregistered will not reappear in a poll, so this only
        // fires if it changed its mind — a cancelled drain.
        this.draining.delete(member.addr)
      }
      membersLiveGauge.set(this.live().length)
    } catch (error) {
      // Keep the previous list. An empty one would 503 every connect on a blip.
      console.error("[Router] Member poll failed, using last known list:", error)
    }
  }

  live(): LiveMember[] {
    return liveMembers(this.members, Date.now())
      .filter((member) => !this.draining.has(member.addr))
      .map(({ addr }) => ({ addr }))
  }

  /**
   * The worker told us it is going away. Unlike unreachability, this IS
   * evidence about ownership: the worker is speaking about itself, and is about
   * to vacate its records anyway. Removing it early is conservative — the worst
   * case is that new Rooms land elsewhere slightly sooner.
   */
  markDraining(addr: string): void {
    this.draining.add(addr)
  }

  routable(): LiveMember[] {
    const now = Date.now()
    return this.live().filter((member) => (this.unreachableUntil.get(member.addr) ?? 0) <= now)
  }

  markUnreachable(addr: string): void {
    this.unreachableUntil.set(addr, Date.now() + UNREACHABLE_COOLDOWN_MS)
  }
}
