import { Storage } from "@google-cloud/storage";
import { RoomSnapshot } from "@tldraw/sync-core";
import type { Request, Response } from "express";
import { PassThrough } from "stream";

// 1. Initialize GCS client. It will automatically use
// credentials from the environment (e.g., gcloud auth).
const storage = new Storage();

// 2. Get bucket name from environment variables
const BUCKET_NAME = process.env.GCS_BUCKET_NAME;
if (!BUCKET_NAME) {
  // Don't run the server if the bucket name isn't set
  throw new Error("GCS_BUCKET_NAME environment variable not set");
}
const bucket = storage.bucket(BUCKET_NAME);

// --- Room Snapshot Storage ---
// (Replaces logic from TldrawDurableObject.ts)

const getRoomSnapshotName = (roomId: string) => `rooms/${roomId}`;

/**
 * Fetches a room snapshot from GCS.
 * Replaces: r2.get(`rooms/${roomId}`)
 */
export async function getRoomSnapshot(
  roomId: string
): Promise<RoomSnapshot | undefined> {
  try {
    const file = bucket.file(getRoomSnapshotName(roomId));
    const [data] = await file.download();
    // Snapshots are stored as JSON strings
    return JSON.parse(data.toString()) as RoomSnapshot;
  } catch (error: any) {
    if (error.code === 404) {
      // This is not an error, it just means the room is new
      console.log(`No snapshot found for room ${roomId}, creating new.`);
      return undefined;
    }
    console.error(`Error fetching snapshot for room ${roomId}:`, error);
    throw error;
  }
}

/**
 * Persists a room snapshot to GCS.
 * Replaces: r2.put(`rooms/${roomId}`, snapshot)
 */
export async function persistRoomSnapshot(
  roomId: string,
  snapshot: RoomSnapshot
) {
  try {
    const file = bucket.file(getRoomSnapshotName(roomId));
    await file.save(JSON.stringify(snapshot), {
      contentType: "application/json",
      // This helps avoid race conditions, but we'll also use Redis locking
      preconditionOpts: {},
    });
  } catch (error) {
    console.error(`Error persisting snapshot for room ${roomId}:`, error);
  }
}

// --- Asset Storage ---
// (Replaces logic from assetUploads.ts)

const getAssetObjectName = (uploadId: string) =>
  `uploads/${uploadId.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;

/**
 * Handles uploading an asset (image/video) to GCS.
 * Replaces: handleAssetUpload
 */
export async function handleAssetUpload(req: Request, res: Response) {
  const { uploadId } = req.params;
  if (!uploadId) {
    return res.status(400).send("Missing uploadId");
  }

  const contentType = req.headers["content-type"];
  if (
    !contentType?.startsWith("image/") &&
    !contentType?.startsWith("video/")
  ) {
    return res.status(400).send("Invalid content type");
  }

  const objectName = getAssetObjectName(uploadId);
  const file = bucket.file(objectName);

  // We'll stream the request body (the file) directly to GCS
  const passthroughStream = new PassThrough();
  req.pipe(passthroughStream);

  console.log(`[GCS] Uploading asset ${objectName}...`);

  try {
    await new Promise((resolve, reject) => {
      const gcsStream = file.createWriteStream({
        metadata: {
          contentType: contentType,
          // From the original implementation, good for caching
          cacheControl: "public, max-age=31536000, immutable",
        },
      });
      gcsStream.on("error", reject);
      gcsStream.on("finish", resolve);
      passthroughStream.pipe(gcsStream);
    });

    console.log(`[GCS] Upload complete for ${objectName}`);
    res.status(200).send({ ok: true });
  } catch (error: any) {
    console.error(`[GCS] Error uploading asset ${uploadId}:`, error);
    if (error.code === 409) {
      return res.status(409).send("Upload already exists");
    }
    res.status(500).send("Asset upload failed");
  }
}

/**
 * Handles downloading an asset from GCS.
 * Replaces: handleAssetDownload
 */
export async function handleAssetDownload(req: Request, res: Response) {
  const { uploadId } = req.params;
  if (!uploadId) {
    return res.status(400).send("Missing uploadId");
  }

  try {
    const objectName = getAssetObjectName(uploadId);
    const file = bucket.file(objectName);
    const [metadata]: any = await file.getMetadata();

    // Set headers based on the file's metadata
    res.setHeader(
      "Content-Type",
      metadata.contentType || "application/octet-stream"
    );
    res.setHeader("Content-Length", metadata.size);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", metadata.etag);

    // Stream the file from GCS straight to the client's response
    file.createReadStream().pipe(res);
  } catch (error: any) {
    console.error(`[GCS] Error downloading asset ${uploadId}:`, error);
    if (error.code === 404) {
      return res.status(404).send("Not found");
    }
    res.status(500).send("Asset download failed");
  }
}
