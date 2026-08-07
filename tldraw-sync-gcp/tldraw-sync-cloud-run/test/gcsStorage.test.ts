import { beforeEach, describe, expect, it, vi } from "vitest"
import { PassThrough, Readable } from "stream"
import { fakeRequest, fakeResponse } from "./helpers/http.js"

// The GCS client is replaced with a fake bucket whose file handles are spies
// the tests program per case.
const download = vi.fn()
const save = vi.fn()
const getMetadata = vi.fn()
const createReadStream = vi.fn()
const createWriteStream = vi.fn()
const requestedFiles: string[] = []

vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket() {
      return {
        file: (name: string) => {
          requestedFiles.push(name)
          return { download, save, getMetadata, createReadStream, createWriteStream }
        },
      }
    }
  },
}))

process.env.GCS_BUCKET_NAME = "test-bucket"

const { fetchRoomSnapshot, persistRoomSnapshot, handleAssetUpload, handleAssetDownload } =
  await import("../src/gcsStorage.js")

function gcsError(code: number) {
  return Object.assign(new Error(`gcs ${code}`), { code })
}

// A write stream that accepts the piped body and reports success.
function acceptingWriteStream() {
  const stream = new PassThrough()
  stream.resume()
  return stream
}

beforeEach(() => {
  download.mockReset()
  save.mockReset().mockResolvedValue(undefined)
  getMetadata.mockReset()
  createReadStream.mockReset()
  createWriteStream.mockReset().mockImplementation(acceptingWriteStream)
  requestedFiles.length = 0
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("fetchRoomSnapshot", () => {
  it("parses the stored snapshot", async () => {
    download.mockResolvedValue([Buffer.from('{"clock":7,"documents":[]}')])

    await expect(fetchRoomSnapshot("room-1")).resolves.toEqual({ clock: 7, documents: [] })
    expect(requestedFiles[0]).toBe("rooms/room-1")
  })

  // A missing snapshot is how a brand new room presents itself; if this threw,
  // no room could ever be created.
  it("returns undefined when the snapshot does not exist", async () => {
    download.mockRejectedValue(gcsError(404))

    await expect(fetchRoomSnapshot("missing")).resolves.toBeUndefined()
  })

  it("rethrows errors that are not a missing snapshot", async () => {
    download.mockRejectedValue(gcsError(403))

    await expect(fetchRoomSnapshot("room-1")).rejects.toThrow("gcs 403")
  })
})

describe("persistRoomSnapshot", () => {
  const snapshot = { clock: 1, documents: [] } as never

  it("writes the snapshot as JSON under the room key", async () => {
    await persistRoomSnapshot("room-1", snapshot)

    expect(requestedFiles[0]).toBe("rooms/room-1")
    expect(JSON.parse(save.mock.calls[0][0] as string)).toEqual({ clock: 1, documents: [] })
    expect(save.mock.calls[0][1]).toMatchObject({ contentType: "application/json" })
  })

  it("retries a transient failure and succeeds", async () => {
    save.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined)

    await persistRoomSnapshot("room-1", snapshot)

    expect(save).toHaveBeenCalledTimes(2)
  })

  // Documents current behaviour: a persist that exhausts its retries resolves
  // as if it succeeded. Callers therefore cannot tell a saved room from a lost
  // one — see the handover finding in the analysis.
  it("swallows the error after exhausting retries", async () => {
    vi.useFakeTimers()
    save.mockRejectedValue(new Error("gcs down"))

    const persisted = persistRoomSnapshot("room-1", snapshot)
    // 1s + 2s + 4s of exponential backoff between the four attempts.
    await vi.advanceTimersByTimeAsync(8_000)

    await expect(persisted).resolves.toBeUndefined()
    expect(save).toHaveBeenCalledTimes(4)
    vi.useRealTimers()
  })
})

describe("handleAssetUpload", () => {
  it("rejects a request with no uploadId", async () => {
    const res = fakeResponse()

    await handleAssetUpload(fakeRequest({ headers: { "content-type": "image/png" } }), res)

    expect(res.statusCode).toBe(400)
  })

  it.each(["text/html", "application/json", undefined])(
    "rejects content type %s",
    async (contentType) => {
      const res = fakeResponse()

      await handleAssetUpload(
        fakeRequest({
          params: { uploadId: "a1" },
          headers: contentType ? { "content-type": contentType } : {},
        }),
        res,
      )

      expect(res.statusCode).toBe(400)
      expect(createWriteStream).not.toHaveBeenCalled()
    },
  )

  it.each(["image/png", "video/mp4"])("accepts content type %s", async (contentType) => {
    const res = fakeResponse()

    await handleAssetUpload(
      fakeRequest({
        params: { uploadId: "a1" },
        headers: { "content-type": contentType },
        body: "bytes",
      }),
      res,
    )

    expect(res.statusCode).toBe(200)
    expect(createWriteStream.mock.calls[0][0].metadata).toMatchObject({ contentType })
  })

  it("sanitises the uploadId into the object key", async () => {
    await handleAssetUpload(
      fakeRequest({
        params: { uploadId: "../../etc/passwd" },
        headers: { "content-type": "image/png" },
        body: "bytes",
      }),
      fakeResponse(),
    )

    expect(requestedFiles[0]).toBe("uploads/.._.._etc_passwd")
  })

  it("reports a failed upload as a 500", async () => {
    createWriteStream.mockImplementation(() => {
      const stream = new PassThrough()
      queueMicrotask(() => stream.emit("error", new Error("write failed")))
      return stream
    })

    const res = fakeResponse()
    await handleAssetUpload(
      fakeRequest({
        params: { uploadId: "a1" },
        headers: { "content-type": "image/png" },
        body: "bytes",
      }),
      res,
    )

    expect(res.statusCode).toBe(500)
  })

  it("reports a rejected overwrite as a 409", async () => {
    createWriteStream.mockImplementation(() => {
      const stream = new PassThrough()
      queueMicrotask(() => stream.emit("error", gcsError(409)))
      return stream
    })

    const res = fakeResponse()
    await handleAssetUpload(
      fakeRequest({
        params: { uploadId: "a1" },
        headers: { "content-type": "image/png" },
        body: "bytes",
      }),
      res,
    )

    expect(res.statusCode).toBe(409)
  })
})

describe("handleAssetDownload", () => {
  it("streams the asset with its stored metadata", async () => {
    getMetadata.mockResolvedValue([{ contentType: "image/png", size: "11", etag: '"abc"' }])
    createReadStream.mockReturnValue(Readable.from(["asset-bytes"]))

    const res = fakeResponse()
    await handleAssetDownload(fakeRequest({ params: { uploadId: "a1" } }), res)
    await res.whenFinished()

    expect(res.headers["content-type"]).toBe("image/png")
    expect(res.headers["content-length"]).toBe("11")
    expect(res.headers["etag"]).toBe('"abc"')
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable")
    expect(res.streamed()).toBe("asset-bytes")
  })

  it("falls back to a generic content type", async () => {
    getMetadata.mockResolvedValue([{}])
    createReadStream.mockReturnValue(Readable.from(["x"]))

    const res = fakeResponse()
    await handleAssetDownload(fakeRequest({ params: { uploadId: "a1" } }), res)

    expect(res.headers["content-type"]).toBe("application/octet-stream")
  })

  it("returns 404 for a missing asset", async () => {
    getMetadata.mockRejectedValue(gcsError(404))

    const res = fakeResponse()
    await handleAssetDownload(fakeRequest({ params: { uploadId: "gone" } }), res)

    expect(res.statusCode).toBe(404)
  })

  it("returns 500 for an unexpected storage error", async () => {
    getMetadata.mockRejectedValue(gcsError(403))

    const res = fakeResponse()
    await handleAssetDownload(fakeRequest({ params: { uploadId: "a1" } }), res)

    expect(res.statusCode).toBe(500)
  })

  it("rejects a request with no uploadId", async () => {
    const res = fakeResponse()

    await handleAssetDownload(fakeRequest(), res)

    expect(res.statusCode).toBe(400)
  })
})
