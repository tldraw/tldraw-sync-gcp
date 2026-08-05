import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ServiceException,
} from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { RoomSnapshot } from "@tldraw/sync-core"
import type { Request, Response } from "express"
import { PassThrough, Readable } from "stream"

// S3_ENDPOINT points the client at a local emulator (e.g. MinIO) for
// development/verification. Leave unset in production, where the real endpoint
// and the default credential chain (IRSA on EKS) are used.
// Path-style addressing is required by MinIO, which has no per-bucket DNS.
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

// Helper: HTTP status of an AWS SDK v3 error.
// NOTE: unlike @google-cloud/storage, the v3 SDK does not put a numeric status
// on `error.code` — it lives on `$metadata.httpStatusCode`, with a symbolic
// `name` (e.g. "NoSuchKey", "NotFound"). Getting this wrong makes a missing
// snapshot throw instead of returning undefined, which breaks room creation.
function httpStatusOf(error: unknown): number | undefined {
  const e = error as Partial<S3ServiceException> | undefined
  return e?.$metadata?.httpStatusCode
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name
  return name === "NoSuchKey" || name === "NotFound" || httpStatusOf(error) === 404
}

// Helper: Retry logic for transient S3 errors
async function retryOperation<T>(
  operation: () => Promise<T>,
  retries = 3,
  delay = 1000,
): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    if (retries <= 0) throw err
    console.warn(`[S3] Operation failed, retrying in ${delay}ms... (${retries} attempts left)`)
    await new Promise((res) => setTimeout(res, delay))
    return retryOperation(operation, retries - 1, delay * 2)
  }
}

const getRoomSnapshotName = (roomId: string) => `rooms/${roomId}`

export async function fetchRoomSnapshot(roomId: string): Promise<RoomSnapshot | undefined> {
  try {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: getRoomSnapshotName(roomId) }),
    )
    const body = await result.Body?.transformToString()
    if (!body) return undefined
    return JSON.parse(body) as RoomSnapshot
  } catch (error: unknown) {
    // 404 is expected (new room), but other errors should be logged
    if (isNotFound(error)) {
      return undefined
    }
    console.error(`[S3] Failed to fetch snapshot for room ${roomId}:`, error)
    throw error
  }
}

export async function persistRoomSnapshot(roomId: string, snapshot: RoomSnapshot) {
  try {
    // Attempt to save with retry logic
    await retryOperation(async () => {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: getRoomSnapshotName(roomId),
          Body: JSON.stringify(snapshot),
          ContentType: "application/json",
        }),
      )
    })
  } catch (err) {
    // Log the error clearly so it isn't "silent"
    console.error(
      `[S3] CRITICAL: Failed to persist snapshot for room ${roomId} after retries.`,
      err,
    )
  }
}

const getAssetObjectName = (uploadId: string) =>
  `uploads/${uploadId.replace(/[^a-zA-Z0-9._-]+/g, "_")}`

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }))
    return true
  } catch (error: unknown) {
    if (isNotFound(error)) return false
    throw error
  }
}

export async function handleAssetUpload(req: Request, res: Response) {
  const { uploadId } = req.params
  if (!uploadId) {
    return res.status(400).send("Missing uploadId")
  }

  const contentType = req.headers["content-type"]
  if (!contentType?.startsWith("image/") && !contentType?.startsWith("video/")) {
    return res.status(400).send("Invalid content type")
  }

  const objectName = getAssetObjectName(uploadId)

  try {
    // S3 PUTs are unconditional overwrites, so the "already exists" case that
    // GCS reports as a 409 has to be checked for explicitly. (Conditional
    // writes via IfNoneMatch exist on S3 but aren't supported by all
    // S3-compatible emulators, so a HEAD keeps local dev honest.)
    if (await objectExists(objectName)) {
      return res.status(409).send("Upload already exists")
    }

    const passthroughStream = new PassThrough()
    req.pipe(passthroughStream)

    // S3 has no createWriteStream equivalent — lib-storage's Upload handles the
    // multipart mechanics for a streaming body of unknown length.
    await new Upload({
      client: s3,
      params: {
        Bucket: BUCKET_NAME,
        Key: objectName,
        Body: passthroughStream,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      },
    }).done()

    res.status(200).send({ ok: true })
  } catch (error: unknown) {
    // Log unexpected errors
    console.error(`[S3] Asset Upload Failed for ${uploadId}:`, error)
    res.status(500).send("Asset upload failed")
  }
}

export async function handleAssetDownload(req: Request, res: Response) {
  const { uploadId } = req.params
  if (!uploadId) {
    return res.status(400).send("Missing uploadId")
  }

  try {
    const objectName = getAssetObjectName(uploadId)
    const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: objectName }))

    res.setHeader("Content-Type", result.ContentType || "application/octet-stream")
    if (result.ContentLength !== undefined) {
      res.setHeader("Content-Length", String(result.ContentLength))
    }
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable")
    if (result.ETag) res.setHeader("ETag", result.ETag)

    if (!result.Body) {
      return res.status(404).send("Not found")
    }
    ;(result.Body as Readable).pipe(res)
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return res.status(404).send("Not found")
    }
    // Log unexpected errors
    console.error(`[S3] Asset Download Failed for ${uploadId}:`, error)
    res.status(500).send("Asset download failed")
  }
}
