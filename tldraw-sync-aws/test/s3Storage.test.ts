import { beforeEach, describe, expect, it, vi } from "vitest"
import { Readable } from "stream"
import { fakeRequest, fakeResponse } from "./helpers/http.js"

// The S3 client is replaced wholesale: every command class is a tagged marker
// object, and `send` is a spy the tests program per case.
const send = vi.fn()

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      send = send
    },
    GetObjectCommand: class extends Command {
      readonly kind = "get"
    },
    HeadObjectCommand: class extends Command {
      readonly kind = "head"
    },
    PutObjectCommand: class extends Command {
      readonly kind = "put"
    },
  }
})

const uploadDone = vi.fn()
vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    constructor(public options: { params: Record<string, unknown> }) {
      uploads.push(this.options.params)
    }
    done = uploadDone
  },
}))

const uploads: Record<string, unknown>[] = []

process.env.S3_BUCKET_NAME = "test-bucket"

const { fetchRoomSnapshot, persistRoomSnapshot, handleAssetUpload, handleAssetDownload } =
  await import("../src/s3Storage.js")

function notFoundError(name: string, status = 404) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })
}

function commandKind(callIndex: number) {
  return send.mock.calls[callIndex]?.[0]?.kind
}

beforeEach(() => {
  send.mockReset()
  uploadDone.mockReset().mockResolvedValue(undefined)
  uploads.length = 0
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("fetchRoomSnapshot", () => {
  it("parses the stored snapshot", async () => {
    send.mockResolvedValue({
      Body: { transformToString: async () => '{"clock":7,"documents":[]}' },
    })

    await expect(fetchRoomSnapshot("room-1")).resolves.toEqual({ clock: 7, documents: [] })
    expect(send.mock.calls[0][0].input.Key).toBe("rooms/room-1")
  })

  // A missing snapshot is how a brand new room presents itself; if this threw,
  // no room could ever be created.
  it.each([
    ["NoSuchKey", notFoundError("NoSuchKey")],
    ["NotFound", notFoundError("NotFound")],
    ["a 404 with an unfamiliar name", notFoundError("SomethingElse", 404)],
  ])("returns undefined for %s", async (_label, error) => {
    send.mockRejectedValue(error)

    await expect(fetchRoomSnapshot("missing")).resolves.toBeUndefined()
  })

  it("rethrows errors that are not a missing snapshot", async () => {
    send.mockRejectedValue(notFoundError("AccessDenied", 403))

    await expect(fetchRoomSnapshot("room-1")).rejects.toThrow("AccessDenied")
  })

  it("returns undefined for an empty body rather than throwing on JSON.parse", async () => {
    send.mockResolvedValue({ Body: { transformToString: async () => "" } })

    await expect(fetchRoomSnapshot("room-1")).resolves.toBeUndefined()
  })
})

describe("persistRoomSnapshot", () => {
  const snapshot = { clock: 1, documents: [] } as never

  it("writes the snapshot as JSON under the room key", async () => {
    send.mockResolvedValue({})

    await persistRoomSnapshot("room-1", snapshot)

    const input = send.mock.calls[0][0].input
    expect(input.Key).toBe("rooms/room-1")
    expect(input.ContentType).toBe("application/json")
    expect(JSON.parse(input.Body as string)).toEqual({ clock: 1, documents: [] })
  })

  it("retries a transient failure and succeeds", async () => {
    send.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({})

    await persistRoomSnapshot("room-1", snapshot)

    expect(send).toHaveBeenCalledTimes(2)
  })

  // Documents current behaviour: a persist that exhausts its retries resolves
  // as if it succeeded. Callers therefore cannot tell a saved room from a lost
  // one — see the handover finding in the analysis.
  it("swallows the error after exhausting retries", async () => {
    vi.useFakeTimers()
    send.mockRejectedValue(new Error("s3 down"))

    const persisted = persistRoomSnapshot("room-1", snapshot)
    // 1s + 2s + 4s of exponential backoff between the four attempts.
    await vi.advanceTimersByTimeAsync(8_000)

    await expect(persisted).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledTimes(4)
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
      expect(send).not.toHaveBeenCalled()
    },
  )

  it.each(["image/png", "video/mp4"])("accepts content type %s", async (contentType) => {
    send.mockRejectedValue(notFoundError("NotFound"))

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
    expect(uploads[0].ContentType).toBe(contentType)
  })

  it("sanitises the uploadId into the object key", async () => {
    send.mockRejectedValue(notFoundError("NotFound"))

    await handleAssetUpload(
      fakeRequest({
        params: { uploadId: "../../etc/passwd" },
        headers: { "content-type": "image/png" },
        body: "bytes",
      }),
      fakeResponse(),
    )

    expect(uploads[0].Key).toBe("uploads/.._.._etc_passwd")
  })

  it("refuses to overwrite an existing asset", async () => {
    send.mockResolvedValue({})

    const res = fakeResponse()
    await handleAssetUpload(
      fakeRequest({
        params: { uploadId: "a1" },
        headers: { "content-type": "image/png" },
        body: "bytes",
      }),
      res,
    )

    expect(commandKind(0)).toBe("head")
    expect(res.statusCode).toBe(409)
    expect(uploads).toHaveLength(0)
  })

  it("reports a failed upload as a 500", async () => {
    send.mockRejectedValue(notFoundError("NotFound"))
    uploadDone.mockRejectedValue(new Error("upload failed"))

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
})

describe("handleAssetDownload", () => {
  it("streams the asset with its stored metadata", async () => {
    send.mockResolvedValue({
      Body: Readable.from(["asset-bytes"]),
      ContentType: "image/png",
      ContentLength: 11,
      ETag: '"abc"',
    })

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
    send.mockResolvedValue({ Body: Readable.from(["x"]) })

    const res = fakeResponse()
    await handleAssetDownload(fakeRequest({ params: { uploadId: "a1" } }), res)

    expect(res.headers["content-type"]).toBe("application/octet-stream")
  })

  it("returns 404 for a missing asset", async () => {
    send.mockRejectedValue(notFoundError("NoSuchKey"))

    const res = fakeResponse()
    await handleAssetDownload(fakeRequest({ params: { uploadId: "gone" } }), res)

    expect(res.statusCode).toBe(404)
  })

  it("returns 500 for an unexpected storage error", async () => {
    send.mockRejectedValue(notFoundError("AccessDenied", 403))

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
