import { Storage } from "@google-cloud/storage";
import { RoomSnapshot } from "@tldraw/sync-core";
import type { Request, Response } from "express";
import { PassThrough } from "stream";

const storage = new Storage();

const BUCKET_NAME = process.env.GCS_BUCKET_NAME;
if (!BUCKET_NAME) {
  throw new Error("GCS_BUCKET_NAME environment variable not set");
}
const bucket = storage.bucket(BUCKET_NAME);

const getRoomSnapshotName = (roomId: string) => `rooms/${roomId}`;

export async function getRoomSnapshot(
  roomId: string
): Promise<RoomSnapshot | undefined> {
  try {
    const file = bucket.file(getRoomSnapshotName(roomId));
    const [data] = await file.download();
    return JSON.parse(data.toString()) as RoomSnapshot;
  } catch (error: any) {
    if (error.code === 404) {
      return undefined;
    }
    throw error;
  }
}

export async function persistRoomSnapshot(
  roomId: string,
  snapshot: RoomSnapshot
) {
  try {
    const file = bucket.file(getRoomSnapshotName(roomId));
    await file.save(JSON.stringify(snapshot), {
      contentType: "application/json",
      preconditionOpts: {},
    });
  } catch (error) {
  }
}

const getAssetObjectName = (uploadId: string) =>
  `uploads/${uploadId.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;

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

  const passthroughStream = new PassThrough();
  req.pipe(passthroughStream);

  try {
    await new Promise((resolve, reject) => {
      const gcsStream = file.createWriteStream({
        metadata: {
          contentType: contentType,
          cacheControl: "public, max-age=31536000, immutable",
        },
      });
      gcsStream.on("error", reject);
      gcsStream.on("finish", resolve);
      passthroughStream.pipe(gcsStream);
    });

    res.status(200).send({ ok: true });
  } catch (error: any) {
    if (error.code === 409) {
      return res.status(409).send("Upload already exists");
    }
    res.status(500).send("Asset upload failed");
  }
}

export async function handleAssetDownload(req: Request, res: Response) {
  const { uploadId } = req.params;
  if (!uploadId) {
    return res.status(400).send("Missing uploadId");
  }

  try {
    const objectName = getAssetObjectName(uploadId);
    const file = bucket.file(objectName);
    const [metadata]: any = await file.getMetadata();

    res.setHeader(
      "Content-Type",
      metadata.contentType || "application/octet-stream"
    );
    res.setHeader("Content-Length", metadata.size);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", metadata.etag);

    file.createReadStream().pipe(res);
  } catch (error: any) {
    if (error.code === 404) {
      return res.status(404).send("Not found");
    }
    res.status(500).send("Asset download failed");
  }
}
