import { beforeEach, describe, expect, it, vi } from "vitest"

// Same idiom as test/s3Storage.test.ts: every command class is a tagged marker
// object and `send` is a spy the tests program per case.
const send = vi.fn()

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(public input: Record<string, any>) {}
  }
  return {
    S3Client: class {
      send = send
    },
    GetObjectCommand: class extends Command {
      readonly kind = "get"
    },
    PutObjectCommand: class extends Command {
      readonly kind = "put"
    },
    DeleteObjectCommand: class extends Command {
      readonly kind = "delete"
    },
    ListObjectsV2Command: class extends Command {
      readonly kind = "list"
    },
  }
})

process.env.S3_BUCKET_NAME = "test-bucket"

const { readOwner, casOwner, putMember, listMembers, deleteMember } =
  await import("../src/registryS3.js")
const { liveMembers, MEMBER_TTL_MS } = await import("../src/registryConfig.js")

// The SDK signals a failed precondition with a status on $metadata, not a code.
function awsError(status: number, name: string) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })
}

beforeEach(() => {
  send.mockReset()
})

describe("readOwner", () => {
  it("returns null when no record exists", async () => {
    send.mockRejectedValueOnce(awsError(404, "NoSuchKey"))
    expect(await readOwner("room-1")).toBeNull()
  })

  it("returns the owner and the etag verbatim, quotes included", async () => {
    send.mockResolvedValueOnce({
      ETag: '"abc123"',
      Body: { transformToString: async () => JSON.stringify({ owner: "http://10.0.1.7:3001" }) },
    })
    expect(await readOwner("room-1")).toEqual({
      owner: "http://10.0.1.7:3001",
      etag: '"abc123"',
    })
  })

  it("treats a vacated record as an existing record with a null owner", async () => {
    send.mockResolvedValueOnce({
      ETag: '"def456"',
      Body: { transformToString: async () => JSON.stringify({ owner: null }) },
    })
    expect(await readOwner("room-1")).toEqual({ owner: null, etag: '"def456"' })
  })

  it("rethrows errors that are not a missing key", async () => {
    send.mockRejectedValueOnce(awsError(500, "InternalError"))
    await expect(readOwner("room-1")).rejects.toThrow("InternalError")
  })
})

describe("casOwner", () => {
  it("claims an absent record with If-None-Match", async () => {
    send.mockResolvedValueOnce({})
    expect(await casOwner("room-1", null, "http://10.0.1.7:3001")).toBe("ok")
    expect(send.mock.calls[0][0].input).toMatchObject({
      Key: "owners/room-1",
      IfNoneMatch: "*",
    })
    expect(send.mock.calls[0][0].input.IfMatch).toBeUndefined()
  })

  it("reallocates an existing record with If-Match", async () => {
    send.mockResolvedValueOnce({})
    expect(await casOwner("room-1", '"abc123"', "http://10.0.1.8:3001")).toBe("ok")
    expect(send.mock.calls[0][0].input).toMatchObject({ IfMatch: '"abc123"' })
    expect(send.mock.calls[0][0].input.IfNoneMatch).toBeUndefined()
  })

  it("vacates by writing a null owner, never by deleting", async () => {
    send.mockResolvedValueOnce({})
    await casOwner("room-1", '"abc123"', null)
    const { kind, input } = send.mock.calls[0][0]
    expect(kind).toBe("put")
    expect(JSON.parse(input.Body).owner).toBeNull()
  })

  it("reports 412 as a conflict rather than throwing", async () => {
    send.mockRejectedValueOnce(awsError(412, "PreconditionFailed"))
    expect(await casOwner("room-1", null, "http://10.0.1.7:3001")).toBe("conflict")
  })

  it("reports 409 as a conflict, which S3 uses for concurrent conditional writes", async () => {
    send.mockRejectedValueOnce(awsError(409, "ConditionalRequestConflict"))
    expect(await casOwner("room-1", '"abc"', "http://10.0.1.7:3001")).toBe("conflict")
  })

  it("rethrows anything that is not a precondition failure", async () => {
    send.mockRejectedValueOnce(awsError(503, "SlowDown"))
    await expect(casOwner("room-1", null, "http://a:1")).rejects.toThrow("SlowDown")
  })
})

describe("membership", () => {
  it("encodes the address into the key, since it contains a scheme", async () => {
    send.mockResolvedValueOnce({})
    await putMember("http://10.0.1.7:3001", 14)
    expect(send.mock.calls[0][0].input.Key).toBe("members/http%3A%2F%2F10.0.1.7%3A3001")
  })

  it("writes unconditionally, because a worker is the only writer of its own key", async () => {
    send.mockResolvedValueOnce({})
    await putMember("http://10.0.1.7:3001", 0)
    const { input } = send.mock.calls[0][0]
    expect(input.IfMatch).toBeUndefined()
    expect(input.IfNoneMatch).toBeUndefined()
  })

  it("reads addresses and freshness from LIST alone, with no body fetch", async () => {
    const modified = new Date("2026-08-21T10:00:00.000Z")
    send.mockResolvedValueOnce({
      Contents: [
        { Key: "members/http%3A%2F%2F10.0.1.7%3A3001", LastModified: modified },
        { Key: "members/http%3A%2F%2F10.0.1.8%3A3001", LastModified: modified },
      ],
    })
    expect(await listMembers()).toEqual([
      { addr: "http://10.0.1.7:3001", updatedAt: modified.getTime() },
      { addr: "http://10.0.1.8:3001", updatedAt: modified.getTime() },
    ])
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].input).toMatchObject({ Prefix: "members/" })
  })

  it("skips entries with no key or no timestamp rather than inventing one", async () => {
    send.mockResolvedValueOnce({ Contents: [{ Key: "members/x" }, { LastModified: new Date() }] })
    expect(await listMembers()).toEqual([])
  })

  it("returns an empty list when the prefix has never been written", async () => {
    send.mockResolvedValueOnce({})
    expect(await listMembers()).toEqual([])
  })

  it("deletes unconditionally on drain", async () => {
    send.mockResolvedValueOnce({})
    await deleteMember("http://10.0.1.7:3001")
    const { kind, input } = send.mock.calls[0][0]
    expect(kind).toBe("delete")
    expect(input.Key).toBe("members/http%3A%2F%2F10.0.1.7%3A3001")
  })
})

describe("liveMembers", () => {
  const now = 1_000_000

  it("keeps entries inside the TTL", () => {
    const members = [{ addr: "http://a:1", updatedAt: now - (MEMBER_TTL_MS - 1) }]
    expect(liveMembers(members, now)).toHaveLength(1)
  })

  it("drops entries at or past the TTL", () => {
    const members = [{ addr: "http://a:1", updatedAt: now - MEMBER_TTL_MS }]
    expect(liveMembers(members, now)).toHaveLength(0)
  })

  it("tolerates a record stamped slightly ahead, since S3's clock is not ours", () => {
    const members = [{ addr: "http://a:1", updatedAt: now + 500 }]
    expect(liveMembers(members, now)).toHaveLength(1)
  })
})
