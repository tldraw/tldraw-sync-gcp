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
// the key and break the prefix listing.
const ownerKey = (roomId: string) => `owners/${roomId}`
const memberKey = (addr: string) => `${MEMBER_PREFIX}${encodeURIComponent(addr)}`

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
 * is no race to guard against. `rooms` is written for humans and for a possible
 * load-aware allocator later; nothing on the hot path reads this body.
 */
export async function putMember(addr: string, rooms: number): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: memberKey(addr),
      Body: JSON.stringify({ addr, rooms, updatedAt: new Date().toISOString() }),
      ContentType: "application/json",
    }),
  )
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
  return (result.Contents ?? []).flatMap((object) => {
    if (!object.Key || !object.LastModified) return []
    const addr = decodeURIComponent(object.Key.slice(MEMBER_PREFIX.length))
    if (!addr) return []
    return [{ addr, updatedAt: object.LastModified.getTime() }]
  })
}

/** Safe unconditionally, unlike owners/: nobody else writes this key. */
export async function deleteMember(addr: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: memberKey(addr) }))
}
