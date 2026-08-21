// Timings and types shared by both registry backends.
//
// This is deliberately a leaf module: the backends must not import from
// registry.ts, which selects a backend, or importing either one would drag the
// other in — and registryS3 throws at import when S3_BUCKET_NAME is unset.

const ms = (name: string, fallback: number) => Number(process.env[name] ?? fallback)

export const HEARTBEAT_INTERVAL_MS = ms("HEARTBEAT_INTERVAL_MS", 2_000)
export const MEMBER_POLL_INTERVAL_MS = ms("MEMBER_POLL_INTERVAL_MS", 2_000)
// Four missed heartbeats, not three: a 2-3s event-loop stall must not evict a
// worker that is fine, because its Rooms get reallocated underneath it. On the
// S3 backend the usable margin is really ~7s, because LastModified is reported
// to whole seconds; Redis has no such tax.
export const MEMBER_TTL_MS = ms("MEMBER_TTL_MS", 8_000)
// A backstop for pushes the router failed to deliver, not the mechanism — the
// router tells a worker the moment it takes a Room away. At 5s and one read per
// Room this was the largest single line in the request bill; at 30s and one
// batched question to the router it is a rounding error.
export const OWNERSHIP_RECHECK_INTERVAL_MS = ms("OWNERSHIP_RECHECK_INTERVAL_MS", 30_000)

export interface OwnerRecord {
  owner: string | null
  /** Opaque to callers: an S3 ETag, or a Redis version counter. */
  etag: string
}

export interface Member {
  addr: string
  updatedAt: number
  /** Rooms held, as last heartbeated: the weight input for allocation. */
  rooms: number
}

export interface RegistryBackend {
  readOwner(roomId: string): Promise<OwnerRecord | null>
  casOwner(roomId: string, expect: string | null, owner: string | null): Promise<"ok" | "conflict">
  putMember(addr: string, rooms: number): Promise<void>
  listMembers(): Promise<Member[]>
  deleteMember(addr: string): Promise<void>
}

export function liveMembers(members: Member[], now: number): Member[] {
  return members.filter((member) => now - member.updatedAt < MEMBER_TTL_MS)
}
