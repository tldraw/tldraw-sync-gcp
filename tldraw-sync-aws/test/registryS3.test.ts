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
  it("encodes the address and the room count into the key", async () => {
    send.mockResolvedValueOnce({})
    await putMember("http://10.0.1.7:3001", 14)
    expect(send.mock.calls[0][0].input.Key).toBe("members/http%3A%2F%2F10.0.1.7%3A3001,14")
  })

  it("deletes the key it previously wrote when the count changes", async () => {
    send.mockResolvedValue({})
    await putMember("http://10.0.2.1:3001", 3)
    send.mockClear()
    await putMember("http://10.0.2.1:3001", 4)
    const calls = send.mock.calls.map((call) => [call[0].kind, call[0].input.Key])
    // PUT first, then DELETE: never a moment with no key at all.
    expect(calls).toEqual([
      ["put", "members/http%3A%2F%2F10.0.2.1%3A3001,4"],
      ["delete", "members/http%3A%2F%2F10.0.2.1%3A3001,3"],
    ])
  })

  it("does not delete anything while the count is unchanged", async () => {
    send.mockResolvedValue({})
    await putMember("http://10.0.2.2:3001", 5)
    send.mockClear()
    await putMember("http://10.0.2.2:3001", 5)
    expect(send.mock.calls.map((call) => call[0].kind)).toEqual(["put"])
  })

  it("writes unconditionally, because a worker is the only writer of its own key", async () => {
    send.mockResolvedValueOnce({})
    await putMember("http://10.0.1.7:3001", 0)
    const { input } = send.mock.calls[0][0]
    expect(input.IfMatch).toBeUndefined()
    expect(input.IfNoneMatch).toBeUndefined()
  })

  it("reads address, freshness and room count from LIST alone, with no body fetch", async () => {
    const modified = new Date("2026-08-21T10:00:00.000Z")
    send.mockResolvedValueOnce({
      Contents: [
        { Key: "members/http%3A%2F%2F10.0.1.7%3A3001,14", LastModified: modified },
        { Key: "members/http%3A%2F%2F10.0.1.8%3A3001,0", LastModified: modified },
      ],
    })
    expect(await listMembers()).toEqual([
      { addr: "http://10.0.1.7:3001", updatedAt: modified.getTime(), rooms: 14 },
      { addr: "http://10.0.1.8:3001", updatedAt: modified.getTime(), rooms: 0 },
    ])
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].input).toMatchObject({ Prefix: "members/" })
  })

  it("reads a key with no count as zero rooms rather than dropping the worker", async () => {
    send.mockResolvedValueOnce({
      Contents: [{ Key: "members/http%3A%2F%2F10.0.1.7%3A3001", LastModified: new Date() }],
    })
    expect((await listMembers())[0]).toMatchObject({ addr: "http://10.0.1.7:3001", rooms: 0 })
  })

  it("keeps only the freshest key when an address appears twice", async () => {
    send.mockResolvedValueOnce({
      Contents: [
        { Key: "members/http%3A%2F%2F10.0.1.7%3A3001,14", LastModified: new Date(1000) },
        { Key: "members/http%3A%2F%2F10.0.1.7%3A3001,15", LastModified: new Date(2000) },
      ],
    })
    expect(await listMembers()).toEqual([
      { addr: "http://10.0.1.7:3001", updatedAt: 2000, rooms: 15 },
    ])
  })

  it("breaks a LastModified tie towards the higher count, deterministically", async () => {
    // S3 stamps LastModified to whole seconds, so two writes inside one second
    // are indistinguishable by age. Any deterministic rule keeps every router
    // agreeing; the higher count is chosen as the pessimistic weight.
    const modified = new Date("2026-08-21T10:00:00.000Z")
    send.mockResolvedValueOnce({
      Contents: [
        { Key: "members/http%3A%2F%2F10.0.1.7%3A3001,15", LastModified: modified },
        { Key: "members/http%3A%2F%2F10.0.1.7%3A3001,14", LastModified: modified },
      ],
    })
    expect(await listMembers()).toEqual([
      { addr: "http://10.0.1.7:3001", updatedAt: modified.getTime(), rooms: 15 },
    ])
  })

  it("skips entries with no key or no timestamp rather than inventing one", async () => {
    send.mockResolvedValueOnce({ Contents: [{ Key: "members/x" }, { LastModified: new Date() }] })
    expect(await listMembers()).toEqual([])
  })

  it("returns an empty list when the prefix has never been written", async () => {
    send.mockResolvedValueOnce({})
    expect(await listMembers()).toEqual([])
  })

  it("removes every key for the address on drain, not just the last one written", async () => {
    send.mockResolvedValueOnce({
      Contents: [
        { Key: "members/http%3A%2F%2F10.0.1.7%3A3001,14" },
        { Key: "members/http%3A%2F%2F10.0.1.7%3A3001,15" },
      ],
    })
    send.mockResolvedValue({})
    await deleteMember("http://10.0.1.7:3001")
    const calls = send.mock.calls.map((call) => [
      call[0].kind,
      call[0].input.Key ?? call[0].input.Prefix,
    ])
    expect(calls).toEqual([
      // The comma is part of the prefix: without it, an address that is a
      // string-prefix of another would match the other's keys too.
      ["list", "members/http%3A%2F%2F10.0.1.7%3A3001,"],
      ["delete", "members/http%3A%2F%2F10.0.1.7%3A3001,14"],
      ["delete", "members/http%3A%2F%2F10.0.1.7%3A3001,15"],
    ])
  })
})

describe("liveMembers", () => {
  const now = 1_000_000

  it("keeps entries inside the TTL", () => {
    const members = [{ addr: "http://a:1", updatedAt: now - (MEMBER_TTL_MS - 1), rooms: 0 }]
    expect(liveMembers(members, now)).toHaveLength(1)
  })

  it("drops entries at or past the TTL", () => {
    const members = [{ addr: "http://a:1", updatedAt: now - MEMBER_TTL_MS, rooms: 0 }]
    expect(liveMembers(members, now)).toHaveLength(0)
  })

  it("tolerates a record stamped slightly ahead, since S3's clock is not ours", () => {
    const members = [{ addr: "http://a:1", updatedAt: now + 500, rooms: 0 }]
    expect(liveMembers(members, now)).toHaveLength(1)
  })
})
