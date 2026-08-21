import { networkInterfaces } from "os"
import {
  HEARTBEAT_INTERVAL_MS,
  MEMBER_POLL_INTERVAL_MS,
  deleteMember,
  listMembers,
  liveMembers,
  putMember,
} from "./registry.js"

/**
 * The worker's Owner Identity: a dialable URL, scheme and port included. This
 * exact string is what lands in both members/ and owners/, so there is one
 * notion of identity and it cannot drift.
 *
 * ADVERTISE_ADDR is set explicitly where the primary NIC is not the right
 * answer — on Kubernetes from status.podIP, and on Cloud Run to the per-worker
 * service URL, since instances there are not individually addressable.
 */
export function defaultAdvertiseAddr(): string {
  if (process.env.ADVERTISE_ADDR) return process.env.ADVERTISE_ADDR

  const port = process.env.PORT || "3001"
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return `http://${address.address}:${port}`
      }
    }
  }
  return `http://127.0.0.1:${port}`
}

export class Membership {
  private heartbeatTimer?: NodeJS.Timeout
  private selfCheckTimer?: NodeJS.Timeout
  // Until the first heartbeat lands we are legitimately absent from members/,
  // and reading that absence as eviction would drop every Room we just claimed.
  private registered = false
  private stopped = false

  constructor(
    readonly addr: string,
    private readonly roomCount: () => number,
    private readonly onEvicted: () => void,
  ) {}

  start(): void {
    void this.beat()
    this.heartbeatTimer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS)
    this.selfCheckTimer = setInterval(() => void this.selfCheck(), MEMBER_POLL_INTERVAL_MS)
  }

  /** Unconditional PUT. A failure is logged and retried on the next tick. */
  async beat(): Promise<void> {
    if (this.stopped) return
    try {
      await putMember(this.addr, this.roomCount())
      this.registered = true
    } catch (error) {
      console.error("[Membership] Heartbeat failed:", error)
    }
  }

  /**
   * Read the same list the router reads and look for ourselves in it. If we
   * are missing, routers have already stopped considering us live and our
   * Rooms are being reallocated — react now rather than waiting out the
   * per-Room re-read cycle.
   *
   * Costs one LIST per worker per poll: O(workers), not O(Rooms).
   */
  async selfCheck(): Promise<void> {
    if (this.stopped || !this.registered) return

    let live
    try {
      live = liveMembers(await listMembers(), Date.now())
    } catch (error) {
      // Fail open. A bucket blip is not evidence that we were evicted, and
      // acting on it would drop healthy Rooms.
      console.error("[Membership] Self-check read failed, assuming still live:", error)
      return
    }

    if (!live.some((member) => member.addr === this.addr)) {
      console.warn(`[Membership] ${this.addr} is not in the live set; re-reading owned Rooms`)
      this.onEvicted()
    }
  }

  /**
   * Deregister. Routers drop us at their next poll, which is why a clean drain
   * never waits out MEMBER_TTL — the record is gone rather than stale.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.selfCheckTimer) clearInterval(this.selfCheckTimer)
    try {
      await deleteMember(this.addr)
    } catch (error) {
      console.error("[Membership] Deregister failed:", error)
    }
  }
}
