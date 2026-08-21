import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ServiceException,
} from "@aws-sdk/client-s3"
import type { Member, OwnerRecord } from "./registryConfig.js"

// Mirrors src/s3Storage.ts: S3_ENDPOINT points at LocalStack for local use and
// is unset in production, where IRSA supplies credentials.
const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.S3_ENDPOINT
    ? {
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
      }
    : {}),
})

const BUCKET_NAME = process.env.S3_BUCKET_NAME
if (!BUCKET_NAME) {
  throw new Error("S3_BUCKET_NAME environment variable not set")
}

const MEMBER_PREFIX = "members/"

// roomId is left unencoded to match `rooms/{roomId}` in s3Storage.ts. addr is
// encoded because it is a URL: the scheme's slashes would otherwise land in
// the key and break the prefix listing. The room count rides in the key after
// a comma — a character encodeURIComponent always escapes, so the last comma
// is unambiguous — which is what lets listMembers read each worker's load from
// the LIST it already makes, with no body fetch and no extra request.
const ownerKey = (roomId: string) => `owners/${roomId}`
const memberKey = (addr: string, rooms: number) =>
  `${MEMBER_PREFIX}${encodeURIComponent(addr)},${rooms}`

// The key changes whenever the count does, so remember what we last wrote in
// order to delete it. A worker is the only writer of its own membership, so a
// module-level map is the entire bookkeeping.
const lastMemberKey = new Map<string, string>()

function statusOf(error: unknown): number | undefined {
  return (error as Partial<S3ServiceException> | undefined)?.$metadata?.httpStatusCode
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name
  return name === "NoSuchKey" || name === "NotFound" || statusOf(error) === 404
}

// S3 answers a lost race with 412, and a genuinely concurrent conditional write
// with 409. Both mean the same thing here: someone else won, go and read it.
function isConflict(error: unknown): boolean {
  const status = statusOf(error)
  return status === 412 || status === 409
}

export async function readOwner(roomId: string): Promise<OwnerRecord | null> {
  try {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: ownerKey(roomId) }),
    )
    const body = await result.Body?.transformToString()
    const parsed = body ? (JSON.parse(body) as { owner?: string | null }) : {}
    // The ETag keeps its quotes: If-Match expects the same form it was given.
    return { owner: parsed.owner ?? null, etag: result.ETag ?? "" }
  } catch (error: unknown) {
    if (isNotFound(error)) return null
    throw error
  }
}

/**
 * The one ownership primitive. `expect: null` means "must not exist"; any other
 * value is an ETag that must still be current. Writing `owner: null` vacates.
 *
 * There is deliberately no delete: an unconditional one is a split-brain (a
 * draining worker erasing a record already reallocated to someone else), and a
 * conditional one returns 501 on the LocalStack version this repo pins.
 */
export async function casOwner(
  roomId: string,
  expect: string | null,
  owner: string | null,
): Promise<"ok" | "conflict"> {
  const precondition = expect === null ? { IfNoneMatch: "*" } : { IfMatch: expect }
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: ownerKey(roomId),
        Body: JSON.stringify({ owner, updatedAt: new Date().toISOString() }),
        ContentType: "application/json",
        ...precondition,
      }),
    )
    return "ok"
  } catch (error: unknown) {
    if (isConflict(error)) return "conflict"
    throw error
  }
}

/**
 * Unconditional by design: a worker is the only writer of its own key, so there
 * is no race to guard against. PUT the new key before deleting the old so there
 * is never a moment with no key at all; a missed delete is harmless, because
 * listMembers keeps only the freshest key per address and the TTL ages the
 * stale one out. The body duplicates the key's fields for humans only.
 */
export async function putMember(addr: string, rooms: number): Promise<void> {
  const key = memberKey(addr, rooms)
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: JSON.stringify({ addr, rooms, updatedAt: new Date().toISOString() }),
      ContentType: "application/json",
    }),
  )
  const previous = lastMemberKey.get(addr)
  lastMemberKey.set(addr, key)
  if (previous && previous !== key) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: previous }))
    } catch (error) {
      console.error("[Registry/S3] Failed to delete superseded member key:", error)
    }
  }
}

/**
 * One request, whatever the worker count: freshness comes from the LastModified
 * that LIST already returns, so no member body is ever fetched. A side benefit
 * is that every timestamp is stamped by S3, so worker clocks never have to
 * agree with each other.
 */
export async function listMembers(): Promise<Member[]> {
  const result = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: MEMBER_PREFIX }),
  )
  const freshest = new Map<string, Member>()
  for (const object of result.Contents ?? []) {
    if (!object.Key || !object.LastModified) continue
    const raw = object.Key.slice(MEMBER_PREFIX.length)
    const comma = raw.lastIndexOf(",")
    const count = comma === -1 ? 0 : Number(raw.slice(comma + 1))
    const addr = decodeURIComponent(comma === -1 ? raw : raw.slice(0, comma))
    if (!addr) continue
    const member = {
      addr,
      updatedAt: object.LastModified.getTime(),
      rooms: Number.isFinite(count) ? count : 0,
    }
    // An address can appear under two keys for up to a TTL after its count
    // changes. Keep the freshest; on a LastModified tie — S3 stamps to whole
    // seconds — take the higher count, so every router breaks it the same way.
    const existing = freshest.get(addr)
    if (
      !existing ||
      member.updatedAt > existing.updatedAt ||
      (member.updatedAt === existing.updatedAt && member.rooms > existing.rooms)
    ) {
      freshest.set(addr, member)
    }
  }
  return [...freshest.values()]
}

/**
 * Safe unconditionally, unlike owners/: nobody else writes these keys. LIST
 * then delete every key for the address — not just the last one this process
 * wrote — so a fast restart's leftovers cannot keep a drained worker looking
 * live. The comma stays in the prefix: without it, an address that is a
 * string-prefix of another would match the other's keys too. Rare path, and
 * S3 prices DELETE at zero.
 */
export async function deleteMember(addr: string): Promise<void> {
  const prefix = `${MEMBER_PREFIX}${encodeURIComponent(addr)},`
  const result = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix }))
  for (const object of result.Contents ?? []) {
    if (!object.Key) continue
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: object.Key }))
  }
  lastMemberKey.delete(addr)
}
