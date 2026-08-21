// The public registry surface: shared config plus whichever backend is in use.
//
// Both backends answer the same three questions — who owns this Room, which
// workers exist, and how do I change either — so the router tier never learns
// which one is running. resolve.ts stays pure and both transports are identical
// either way. The measured win (Rooms stop moving when you scale) comes from
// routing resolving an authoritative record, not from where that record lives.
import type { RegistryBackend } from "./registryConfig.js"

export {
  HEARTBEAT_INTERVAL_MS,
  MEMBER_POLL_INTERVAL_MS,
  MEMBER_TTL_MS,
  OWNERSHIP_RECHECK_INTERVAL_MS,
  liveMembers,
  type Member,
  type OwnerRecord,
  type RegistryBackend,
} from "./registryConfig.js"

// Dynamic so the unused backend never initialises: registryS3 throws at import
// when S3_BUCKET_NAME is unset, and registryRedis dials on import.
const backend: RegistryBackend =
  process.env.REGISTRY_BACKEND === "redis"
    ? await import("./registryRedis.js")
    : await import("./registryS3.js")

export const readOwner = backend.readOwner
export const casOwner = backend.casOwner
export const putMember = backend.putMember
export const listMembers = backend.listMembers
export const deleteMember = backend.deleteMember
