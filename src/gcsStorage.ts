import { Storage } from "@google-cloud/storage"
import { RoomSnapshot } from "@tldraw/sync-core"
import type { Request, Response } from "express"
import { PassThrough } from "stream"

const storage = new Storage()

const BUCKET_NAME = process.env.GCS_BUCKET_NAME
if (!BUCKET_NAME) {
  throw new Error("GCS_BUCKET_NAME environment variable not set")
}
const bucket = storage.bucket(BUCKET_NAME)

// Helper: Type Guard for GCS Errors
function isGoogleCloudError(error: unknown): error is { code: number; message: string } {
  return typeof error === "object" && error !== null && "code" in error
}

// Helper: Retry logic for transient GCS errors
async function retryOperation<T>(
  operation: () => Promise<T>,
  retries = 3,
  delay = 1000,
): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    if (retries <= 0) throw err
    console.warn(`[GCS] Operation failed, retrying in ${delay}ms... (${retries} attempts left)`)
    await new Promise((res) => setTimeout(res, delay))
    return retryOperation(operation, retries - 1, delay * 2)
  }
}

const getRoomSnapshotName = (roomId: string) => `rooms/${roomId}`

export async function fetchRoomSnapshot(roomId: string): Promise<RoomSnapshot | undefined> {
  try {
    const file = bucket.file(getRoomSnapshotName(roomId))
    const [data] = await file.download()
    return JSON.parse(data.toString()) as RoomSnapshot
  } catch (error: unknown) {
    // 404 is expected (new room), but other errors should be logged
    if (isGoogleCloudError(error) && error.code === 404) {
      return undefined
    }
    console.error(`[GCS] Failed to fetch snapshot for room ${roomId}:`, error)
    throw error
  }
}

export async function persistRoomSnapshot(roomId: string, snapshot: RoomSnapshot) {
  try {
    const file = bucket.file(getRoomSnapshotName(roomId))

    // Attempt to save with retry logic
    await retryOperation(async () => {
      await file.save(JSON.stringify(snapshot), {
        contentType: "application/json",
        resumable: false, // optimize for smaller files
      })
    })
  } catch (err) {
    // Log the error clearly so it isn't "silent"
    console.error(
      `[GCS] CRITICAL: Failed to persist snapshot for room ${roomId} after retries.`,
      err,
    )
  }
}

const getAssetObjectName = (uploadId: string) =>
  `uploads/${uploadId.replace(/[^a-zA-Z0-9._-]+/g, "_")}`

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
  const file = bucket.file(objectName)

  const passthroughStream = new PassThrough()
  req.pipe(passthroughStream)

  try {
    await new Promise((resolve, reject) => {
      const gcsStream = file.createWriteStream({
        metadata: {
          contentType: contentType,
          cacheControl: "public, max-age=31536000, immutable",
        },
      })
      gcsStream.on("error", reject)
      gcsStream.on("finish", resolve)
      passthroughStream.pipe(gcsStream)
    })

    res.status(200).send({ ok: true })
  } catch (error: unknown) {
    if (isGoogleCloudError(error) && error.code === 409) {
      return res.status(409).send("Upload already exists")
    }
    // Log unexpected errors
    console.error(`[GCS] Asset Upload Failed for ${uploadId}:`, error)
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
    const file = bucket.file(objectName)
    const [metadata] = await file.getMetadata()

    res.setHeader("Content-Type", metadata.contentType || "application/octet-stream")
    if (metadata.size) res.setHeader("Content-Length", metadata.size)
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable")
    if (metadata.etag) res.setHeader("ETag", metadata.etag)

    file.createReadStream().pipe(res)
  } catch (error: unknown) {
    if (isGoogleCloudError(error) && error.code === 404) {
      return res.status(404).send("Not found")
    }
    // Log unexpected errors
    console.error(`[GCS] Asset Download Failed for ${uploadId}:`, error)
    res.status(500).send("Asset download failed")
  }
}
