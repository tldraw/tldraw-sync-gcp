# Bucket-backed registry and room routing — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Redis from `tldraw-sync-aws/` by making the S3 bucket the source of truth for Room ownership and worker membership, and routing every connection to the owning worker through a new room-router.

**Architecture:** Two S3 key prefixes carry all coordination — `owners/{roomId}` (conditional PUT, no lease, no delete) and `members/{addr}` (unconditional PUT on a 2s heartbeat, liveness by object age). A new stateless service, the **room-router**, wraps one pure function `resolve()` in either an Envoy `ext_authz` endpoint (mode A) or a socket-splicing WebSocket proxy (mode B). One package, two entrypoints, one image. The two-phase coordinated Handover protocol is deleted outright.

**Tech Stack:** Node 20, TypeScript 5.4 (strict, ESM), yarn 4.11.0, vitest 4, `@aws-sdk/client-s3` ^3.700.0, `ws` ^8.18, express 5, prom-client 15, Envoy v1.34, LocalStack 4.14.0, Helm 3, k3d.

**Design doc:** [`../specs/2026-08-19-bucket-registry-room-routing-design.md`](../specs/2026-08-19-bucket-registry-room-routing-design.md)
**Decision record:** [`../../adr/0005-room-ownership-in-the-bucket-routed-by-envoy.md`](../../adr/0005-room-ownership-in-the-bucket-routed-by-envoy.md)

## Scope

**In scope:** the registry, the worker rewrite, both router modes, the Envoy config, Docker compose (mode B), the Helm chart, `local-cluster` (mode A), metrics, and docs.

**Out of scope — a follow-up plan:** production deployment of EKS, GKE, GCE and Cloud Run. The design doc lists Cloud Run as wholly unverified and GCE as needing a firewall rule; those targets need their own plan with their own verification. This plan ends with the AWS demo running Redis-free and verified in two places: `docker compose` and `local-cluster`.

**Untouched:** `tldraw-sync-gcp/` in its entirety. It keeps Redis, keeps ingress-nginx, and keeps hash-based affinity.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Timings, exact.** `HEARTBEAT_INTERVAL` 2s · `MEMBER_POLL_INTERVAL` 2s · `MEMBER_TTL` 8s · `OWNERSHIP_RECHECK_INTERVAL` 5s. All overridable by env var, all defaulting to these values in one place (`src/registry.ts`).
- **There is exactly one Owner Identity string.** The value in `members/` (`addr`) and the value in `owners/` (`owner`) are byte-identical: a dialable URL with scheme and port, e.g. `http://10.0.1.7:3001`. The design doc's two JSON examples disagree on this (one shows a scheme, the other does not); the scheme-ful form is correct and both must use it. Never store a bare IP.
- **Never issue a conditional DELETE.** LocalStack 4.14.0 returns `501 Not Implemented`. Vacating ownership is a CAS to `owner: null`. Only `members/` is ever deleted, and only unconditionally.
- **Ownership transitions are the only conditional writes.** `If-None-Match: *` to claim, `If-Match: <etag>` to reallocate or vacate. A `412` is never an error — it means re-read and use the winner's answer.
- **`LastModified` is second-granular.** Verified against LocalStack 4.14.0: three writes inside one second all report the same timestamp, each up to 999ms older than the write. An 8s `MEMBER_TTL` is therefore ~7s of real margin. Do not tighten it without re-doing this arithmetic.
- **Liveness is object age, read from `LIST`.** `listMembers()` must not GET member bodies on the hot path; it uses the `LastModified` that `ListObjectsV2` already returns. This keeps the poll at one request regardless of worker count, and it means freshness is judged against S3's clock rather than each worker's, removing clock skew between workers.
- **Reachability never decides ownership.** A failed dial removes a worker from *new connection* consideration only. It must never evict from the live set and never trigger a CAS.
- **Node 20 / ESM.** All relative imports carry the `.js` extension, matching the existing source. `strict: true` — no `any` outside test doubles.
- **Formatting.** `yarn format` (prettier) before every commit. Note `yarn format:check` **fails on `chart/templates/*.yaml` regardless of your changes** — prettier cannot parse Go templating — so it is not a useful gate, and CI does not run it.
- **`yarn build` must pass, not just `yarn typecheck`.** They use different tsconfigs: `typecheck` runs `tsconfig.test.json` with `noEmit`, while `build` runs `tsconfig.json` and emits to `dist/`. CI runs `yarn install --immutable`, `yarn typecheck`, `yarn build`, `yarn test` — a task is not done until all four are clean.
- **LocalStack stays pinned at `4.14.0`.** Newer tags require a paid auth token.

---

## File structure

**New, `tldraw-sync-aws/src/`:**

| File | Responsibility |
|---|---|
| `registry.ts` | All S3 coordination I/O and the tuning constants. Ownership CAS, membership read/write/delete. Nothing else knows about conditional headers. |
| `membership.ts` | The worker's own heartbeat loop and its membership self-check. |
| `router/resolve.ts` | The pure decision. No I/O, no imports from `registry.ts`. |
| `router/memberCache.ts` | The router's view of the fleet: the member poll, plus which workers it can currently reach. |
| `router/proxy.ts` | Mode B — WebSocket proxy by socket splicing. |
| `router/extAuthz.ts` | Mode A — the `ext_authz` HTTP endpoint. |
| `router/index.ts` | Router entrypoint. Picks a transport from `ROUTER_MODE`. |

**New, elsewhere:** `tldraw-sync-aws/envoy.yaml` · `tldraw-sync-aws/compose.yaml` · `tldraw-sync-aws/chart/templates/envoy.yaml`

**Modified:** `src/roomManager.ts` (Redis excised) · `src/index.ts` (409 refusal, drain order) · `src/metrics.ts` · `Dockerfile` · `package.json` · `chart/values.yaml` · `chart/templates/deployment.yaml` · `local-cluster/k3d-config.yaml` · `local-cluster/Makefile` · `local-cluster/scripts/verify-aws.sh` · `local-cluster/dashboards/tldraw-scaling-dashboard.yaml` · `CONTEXT.md` · both READMEs

**Deleted:** `chart/templates/redis.yaml` · `chart/templates/ingress.yaml` · `test/helpers/fakeRedis.ts` · `test-handover.js` · `test-lock.js` · `docs/coordinated-handover.md` (rewritten in place as a drain-and-reclaim doc)

---

## Tasks

### Task 1: The registry — ownership CAS and membership over S3

**Files:**
- Create: `tldraw-sync-aws/src/registry.ts`
- Test: `tldraw-sync-aws/test/registry.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `HEARTBEAT_INTERVAL_MS`, `MEMBER_POLL_INTERVAL_MS`, `MEMBER_TTL_MS`, `OWNERSHIP_RECHECK_INTERVAL_MS: number`
  - `interface OwnerRecord { owner: string | null; etag: string }`
  - `interface Member { addr: string; updatedAt: number }`
  - `readOwner(roomId: string): Promise<OwnerRecord | null>`
  - `casOwner(roomId: string, expect: string | null, owner: string | null): Promise<"ok" | "conflict">`
  - `putMember(addr: string, rooms: number): Promise<void>`
  - `listMembers(): Promise<Member[]>`
  - `deleteMember(addr: string): Promise<void>`
  - `liveMembers(members: Member[], now: number): Member[]`

**Background you need:** the AWS SDK v3 puts HTTP status on `error.$metadata.httpStatusCode`, *not* on `error.code` — `src/s3Storage.ts` already has `httpStatusOf`/`isNotFound` helpers doing this, and getting it wrong makes an absent record throw instead of returning `null`. `GetObjectCommand` returns `ETag` **with surrounding quotes**; pass it back to `IfMatch` verbatim, never trimmed.

- [ ] **Step 1: Write the failing test**

`tldraw-sync-aws/test/registry.test.ts`:

```ts
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

const { readOwner, casOwner, putMember, listMembers, deleteMember, liveMembers, MEMBER_TTL_MS } =
  await import("../src/registry.js")

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tldraw-sync-aws && yarn vitest run test/registry.test.ts`
Expected: FAIL — `Cannot find module '../src/registry.js'`

- [ ] **Step 3: Write the implementation**

`tldraw-sync-aws/src/registry.ts`:

```ts
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ServiceException,
} from "@aws-sdk/client-s3"

// --- Tuning. One place, all overridable. See the design doc's config table. ---
const ms = (name: string, fallback: number) => Number(process.env[name] ?? fallback)

export const HEARTBEAT_INTERVAL_MS = ms("HEARTBEAT_INTERVAL_MS", 2_000)
export const MEMBER_POLL_INTERVAL_MS = ms("MEMBER_POLL_INTERVAL_MS", 2_000)
// Four missed heartbeats, not three: a 2-3s event-loop stall must not evict a
// worker that is fine, because its Rooms get reallocated underneath it.
export const MEMBER_TTL_MS = ms("MEMBER_TTL_MS", 8_000)
export const OWNERSHIP_RECHECK_INTERVAL_MS = ms("OWNERSHIP_RECHECK_INTERVAL_MS", 5_000)

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

export interface OwnerRecord {
  owner: string | null
  etag: string
}

export interface Member {
  addr: string
  updatedAt: number
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

export function liveMembers(members: Member[], now: number): Member[] {
  return members.filter((member) => now - member.updatedAt < MEMBER_TTL_MS)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tldraw-sync-aws && yarn vitest run test/registry.test.ts`
Expected: PASS, 18 tests

- [ ] **Step 5: Typecheck and format**

Run: `cd tldraw-sync-aws && yarn typecheck && yarn format`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add tldraw-sync-aws/src/registry.ts tldraw-sync-aws/test/registry.test.ts
git commit -m "feat(aws): add bucket-backed registry for room ownership and membership"
```

---

### Task 2: `resolve()` — the pure routing decision

**Files:**
- Create: `tldraw-sync-aws/src/router/resolve.ts`
- Test: `tldraw-sync-aws/test/resolve.test.ts`

**Interfaces:**
- Consumes: the *shape* of `OwnerRecord` and `Member` from Task 1, but **imports nothing** — this file stays free of I/O so it can be tested without mocks.
- Produces:
  - `interface LiveMember { addr: string }`
  - `type Resolution = { action: "use"; addr: string } | { action: "claim"; addr: string; expect: string | null } | { action: "unavailable" }`
  - `resolve(roomId: string, record: { owner: string | null; etag: string } | null, live: LiveMember[]): Resolution`
  - `rendezvousPick(roomId: string, live: LiveMember[]): string | null`

**Why rendezvous and not least-loaded:** rendezvous hashing gives a stable answer for a given (roomId, member set) without coordination, so two routers racing the same unclaimed Room pick the *same* worker and only one CAS is needed. It also avoids the thundering herd onto a freshly started worker that a least-loaded rule would cause. The design doc leaves load-aware allocation open; this implements the stable default, and `rooms` is still written to the member body if that changes.

- [ ] **Step 1: Write the failing test**

`tldraw-sync-aws/test/resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { rendezvousPick, resolve } from "../src/router/resolve.js"

const member = (addr: string) => ({ addr })
const A = "http://10.0.1.7:3001"
const B = "http://10.0.1.8:3001"
const C = "http://10.0.1.9:3001"

describe("rendezvousPick", () => {
  it("returns null when nothing is live", () => {
    expect(rendezvousPick("room-1", [])).toBeNull()
  })

  it("is deterministic for the same room and member set", () => {
    const first = rendezvousPick("room-1", [member(A), member(B), member(C)])
    const second = rendezvousPick("room-1", [member(A), member(B), member(C)])
    expect(first).toBe(second)
  })

  it("does not depend on the order members arrive in", () => {
    const forwards = rendezvousPick("room-1", [member(A), member(B), member(C)])
    const backwards = rendezvousPick("room-1", [member(C), member(B), member(A)])
    expect(forwards).toBe(backwards)
  })

  it("keeps a room where it was unless the new member wins it outright", () => {
    const before = rendezvousPick("room-1", [member(A), member(B)])
    const after = rendezvousPick("room-1", [member(A), member(B), member(C)])
    expect(after === before || after === C).toBe(true)
  })

  it("spreads rooms across members rather than piling onto one", () => {
    const picks = new Set(
      Array.from({ length: 60 }, (_, i) =>
        rendezvousPick(`room-${i}`, [member(A), member(B), member(C)]),
      ),
    )
    expect(picks.size).toBe(3)
  })
})

describe("resolve", () => {
  it("uses the recorded owner when it is live", () => {
    expect(resolve("room-1", { owner: A, etag: '"e1"' }, [member(A), member(B)])).toEqual({
      action: "use",
      addr: A,
    })
  })

  it("claims with expect=null when there is no record at all", () => {
    expect(resolve("room-1", null, [member(A), member(B)])).toMatchObject({
      action: "claim",
      expect: null,
    })
  })

  it("reallocates against the current etag when the owner is not live", () => {
    expect(resolve("room-1", { owner: "http://10.0.9.9:3001", etag: '"e1"' }, [member(A)])).toEqual({
      action: "claim",
      addr: A,
      expect: '"e1"',
    })
  })

  it("claims a vacated record against its etag, not as an absent one", () => {
    expect(resolve("room-1", { owner: null, etag: '"e2"' }, [member(A)])).toEqual({
      action: "claim",
      addr: A,
      expect: '"e2"',
    })
  })

  it("is unavailable when nothing is live, rather than naming a dead owner", () => {
    expect(resolve("room-1", { owner: A, etag: '"e1"' }, [])).toEqual({ action: "unavailable" })
  })

  it("picks the same worker as a bare rendezvous when claiming", () => {
    const live = [member(A), member(B), member(C)]
    expect(resolve("room-1", null, live)).toMatchObject({ addr: rendezvousPick("room-1", live) })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tldraw-sync-aws && yarn vitest run test/resolve.test.ts`
Expected: FAIL — `Cannot find module '../src/router/resolve.js'`

- [ ] **Step 3: Write the implementation**

`tldraw-sync-aws/src/router/resolve.ts`:

```ts
import { createHash } from "crypto"

// Pure. No I/O and no import from registry.ts — the point of this file is that
// both transports share one decision that can be tested without mocks.

export interface LiveMember {
  addr: string
}

export type Resolution =
  | { action: "use"; addr: string }
  | { action: "claim"; addr: string; expect: string | null }
  | { action: "unavailable" }

// Rendezvous (highest random weight) hashing: score every member against the
// room and take the winner. Two routers racing the same unclaimed Room reach
// the same answer without talking to each other, and adding a member moves
// only the rooms that member itself wins.
function score(roomId: string, addr: string): string {
  return createHash("sha1").update(`${roomId} ${addr}`).digest("hex")
}

export function rendezvousPick(roomId: string, live: LiveMember[]): string | null {
  let bestAddr: string | null = null
  let bestScore = ""

  for (const member of live) {
    const memberScore = score(roomId, member.addr)
    // Tie-break on the address so the result cannot depend on iteration order.
    if (memberScore > bestScore || (memberScore === bestScore && member.addr > (bestAddr ?? ""))) {
      bestAddr = member.addr
      bestScore = memberScore
    }
  }

  return bestAddr
}

/**
 * Which worker should serve this Room?
 *
 * A recorded owner wins outright while it is live — that is the guarantee the
 * whole design exists for. Otherwise the Room is up for allocation, and the
 * caller must CAS the answer in before trusting it: `expect` carries the
 * precondition, null meaning "there was no record".
 */
export function resolve(
  roomId: string,
  record: { owner: string | null; etag: string } | null,
  live: LiveMember[],
): Resolution {
  if (record?.owner && live.some((member) => member.addr === record.owner)) {
    return { action: "use", addr: record.owner }
  }

  const pick = rendezvousPick(roomId, live)
  if (!pick) return { action: "unavailable" }

  // A vacated record still exists, so it is reallocated against its etag. Only
  // a genuinely absent record uses the "must not exist" precondition.
  return { action: "claim", addr: pick, expect: record ? record.etag : null }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tldraw-sync-aws && yarn vitest run test/resolve.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
cd tldraw-sync-aws && yarn typecheck && yarn format
git add tldraw-sync-aws/src/router/resolve.ts tldraw-sync-aws/test/resolve.test.ts
git commit -m "feat(aws): add pure resolve() with rendezvous allocation"
```

---
### Task 3: Worker membership — heartbeat and self-check

**Files:**
- Create: `tldraw-sync-aws/src/membership.ts`
- Test: `tldraw-sync-aws/test/membership.test.ts`

**Interfaces:**
- Consumes: `HEARTBEAT_INTERVAL_MS`, `MEMBER_POLL_INTERVAL_MS`, `putMember`, `listMembers`, `liveMembers`, `deleteMember` from Task 1.
- Produces:
  - `defaultAdvertiseAddr(): string`
  - `class Membership` with `constructor(addr: string, roomCount: () => number, onEvicted: () => void)`, `readonly addr: string`, `start(): void`, `beat(): Promise<void>`, `selfCheck(): Promise<void>`, `stop(): Promise<void>`

**Two rules that are easy to get wrong and are the reason this is its own file:**

1. **Never call `onEvicted` before the first heartbeat has landed.** At startup the worker is legitimately absent from `members/`; firing eviction there would drop every Room it just claimed.
2. **A failed `listMembers()` must fail open.** A bucket blip is not evidence of eviction. Only a *successful* read that does not contain us counts.

- [ ] **Step 1: Write the failing test**

`tldraw-sync-aws/test/membership.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest"

const putMember = vi.fn()
const listMembers = vi.fn()
const deleteMember = vi.fn()

vi.mock("../src/registry.js", () => ({
  putMember,
  listMembers,
  deleteMember,
  liveMembers: (members: { addr: string; updatedAt: number }[]) => members,
  HEARTBEAT_INTERVAL_MS: 2000,
  MEMBER_POLL_INTERVAL_MS: 2000,
  MEMBER_TTL_MS: 8000,
}))

const { Membership, defaultAdvertiseAddr } = await import("../src/membership.js")

const ME = "http://10.0.1.7:3001"

beforeEach(() => {
  putMember.mockReset().mockResolvedValue(undefined)
  listMembers.mockReset().mockResolvedValue([])
  deleteMember.mockReset().mockResolvedValue(undefined)
})

describe("defaultAdvertiseAddr", () => {
  it("prefers an explicit ADVERTISE_ADDR", () => {
    process.env.ADVERTISE_ADDR = "https://sync-3-xyz.run.app"
    expect(defaultAdvertiseAddr()).toBe("https://sync-3-xyz.run.app")
    delete process.env.ADVERTISE_ADDR
  })

  it("otherwise builds a dialable URL with a scheme and the listen port", () => {
    delete process.env.ADVERTISE_ADDR
    process.env.PORT = "3001"
    expect(defaultAdvertiseAddr()).toMatch(/^http:\/\/.+:3001$/)
  })
})

describe("beat", () => {
  it("writes the current room count", async () => {
    const membership = new Membership(ME, () => 14, vi.fn())
    await membership.beat()
    expect(putMember).toHaveBeenCalledWith(ME, 14)
  })

  it("swallows a failed write so the loop keeps running", async () => {
    putMember.mockRejectedValueOnce(new Error("SlowDown"))
    const membership = new Membership(ME, () => 0, vi.fn())
    await expect(membership.beat()).resolves.toBeUndefined()
  })
})

describe("selfCheck", () => {
  it("does nothing before the first heartbeat has landed", async () => {
    const onEvicted = vi.fn()
    const membership = new Membership(ME, () => 0, onEvicted)
    await membership.selfCheck()
    expect(listMembers).not.toHaveBeenCalled()
    expect(onEvicted).not.toHaveBeenCalled()
  })

  it("stays quiet while it can find itself in the live set", async () => {
    const onEvicted = vi.fn()
    const membership = new Membership(ME, () => 0, onEvicted)
    await membership.beat()
    listMembers.mockResolvedValueOnce([{ addr: ME, updatedAt: Date.now() }])
    await membership.selfCheck()
    expect(onEvicted).not.toHaveBeenCalled()
  })

  it("reports eviction when a successful read does not contain it", async () => {
    const onEvicted = vi.fn()
    const membership = new Membership(ME, () => 0, onEvicted)
    await membership.beat()
    listMembers.mockResolvedValueOnce([{ addr: "http://10.0.1.8:3001", updatedAt: Date.now() }])
    await membership.selfCheck()
    expect(onEvicted).toHaveBeenCalledTimes(1)
  })

  it("fails open when the read itself fails, since a blip is not an eviction", async () => {
    const onEvicted = vi.fn()
    const membership = new Membership(ME, () => 0, onEvicted)
    await membership.beat()
    listMembers.mockRejectedValueOnce(new Error("network"))
    await membership.selfCheck()
    expect(onEvicted).not.toHaveBeenCalled()
  })
})

describe("stop", () => {
  it("deregisters so routers drop it at their next poll, without waiting out the TTL", async () => {
    const membership = new Membership(ME, () => 0, vi.fn())
    membership.start()
    await membership.stop()
    expect(deleteMember).toHaveBeenCalledWith(ME)
  })

  it("stops heartbeating after stop, so the record cannot come back", async () => {
    vi.useFakeTimers()
    const membership = new Membership(ME, () => 0, vi.fn())
    membership.start()
    await membership.stop()
    putMember.mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(putMember).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tldraw-sync-aws && yarn vitest run test/membership.test.ts`
Expected: FAIL — `Cannot find module '../src/membership.js'`

- [ ] **Step 3: Write the implementation**

`tldraw-sync-aws/src/membership.ts`:

```ts
import { networkInterfaces } from "os"
import {
  HEARTBEAT_INTERVAL_MS,
  MEMBER_POLL_INTERVAL_MS,
  deleteMember,
  listMembers,
  liveMembers,
  putMember,
} from "./registry.js"

/**
 * The worker's Owner Identity: a dialable URL, scheme and port included. This
 * exact string is what lands in both members/ and owners/, so there is one
 * notion of identity and it cannot drift.
 *
 * ADVERTISE_ADDR is set explicitly where the primary NIC is not the right
 * answer — on Kubernetes from status.podIP, and on Cloud Run to the per-worker
 * service URL, since instances there are not individually addressable.
 */
export function defaultAdvertiseAddr(): string {
  if (process.env.ADVERTISE_ADDR) return process.env.ADVERTISE_ADDR

  const port = process.env.PORT || "3001"
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return `http://${address.address}:${port}`
      }
    }
  }
  return `http://127.0.0.1:${port}`
}

export class Membership {
  private heartbeatTimer?: NodeJS.Timeout
  private selfCheckTimer?: NodeJS.Timeout
  // Until the first heartbeat lands we are legitimately absent from members/,
  // and reading that absence as eviction would drop every Room we just claimed.
  private registered = false
  private stopped = false

  constructor(
    readonly addr: string,
    private readonly roomCount: () => number,
    private readonly onEvicted: () => void,
  ) {}

  start(): void {
    void this.beat()
    this.heartbeatTimer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS)
    this.selfCheckTimer = setInterval(() => void this.selfCheck(), MEMBER_POLL_INTERVAL_MS)
  }

  /** Unconditional PUT. A failure is logged and retried on the next tick. */
  async beat(): Promise<void> {
    if (this.stopped) return
    try {
      await putMember(this.addr, this.roomCount())
      this.registered = true
    } catch (error) {
      console.error("[Membership] Heartbeat failed:", error)
    }
  }

  /**
   * Read the same list the router reads and look for ourselves in it. If we
   * are missing, routers have already stopped considering us live and our
   * Rooms are being reallocated — react now rather than waiting out the
   * per-Room re-read cycle.
   *
   * Costs one LIST per worker per poll: O(workers), not O(Rooms).
   */
  async selfCheck(): Promise<void> {
    if (this.stopped || !this.registered) return

    let live
    try {
      live = liveMembers(await listMembers(), Date.now())
    } catch (error) {
      // Fail open. A bucket blip is not evidence that we were evicted, and
      // acting on it would drop healthy Rooms.
      console.error("[Membership] Self-check read failed, assuming still live:", error)
      return
    }

    if (!live.some((member) => member.addr === this.addr)) {
      console.warn(`[Membership] ${this.addr} is not in the live set; re-reading owned Rooms`)
      this.onEvicted()
    }
  }

  /**
   * Deregister. Routers drop us at their next poll, which is why a clean drain
   * never waits out MEMBER_TTL — the record is gone rather than stale.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.selfCheckTimer) clearInterval(this.selfCheckTimer)
    try {
      await deleteMember(this.addr)
    } catch (error) {
      console.error("[Membership] Deregister failed:", error)
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tldraw-sync-aws && yarn vitest run test/membership.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
cd tldraw-sync-aws && yarn typecheck && yarn format
git add tldraw-sync-aws/src/membership.ts tldraw-sync-aws/test/membership.test.ts
git commit -m "feat(aws): add worker heartbeat and membership self-check"
```

---

### Task 4: Rewrite `roomManager.ts` — Redis out, ownership records in

**Files:**
- Modify: `tldraw-sync-aws/src/roomManager.ts` (delete Redis wholesale; ~651 lines becomes ~260)
- Rewrite: `tldraw-sync-aws/test/roomManager.test.ts`
- Delete: `tldraw-sync-aws/test/helpers/fakeRedis.ts`

**Interfaces:**
- Consumes: `readOwner`, `casOwner`, `OWNERSHIP_RECHECK_INTERVAL_MS` (Task 1); `Membership`, `defaultAdvertiseAddr` (Task 3); metrics from Task 5 — **write Task 5 first if you are executing out of order**, or stub the counters.
- Produces:
  - `class NotOwnerError extends Error` with `readonly owner: string | null`
  - `roomManager.getOrPrepareRoom(roomId: string): Promise<{ room; isNewRoom: boolean }>` — throws `NotOwnerError` when the record names someone else
  - `roomManager.connectSocket(room, roomId, ws, sessionId, isNewRoom): void` — unchanged signature
  - `roomManager.roomCount(): number`
  - `roomManager.recheckAll(): Promise<void>`
  - `roomManager.drain(): Promise<void>`
  - `roomManager.addr: string`

**What is being deleted:** all four Redis clients, both Lua scripts, `CHANNEL_HANDOVER_REQUEST` / `CHANNEL_LOCK_RELEASED_PREFIX` / `CHANNEL_READY_PREFIX`, `initHandoverListener`, `releaseRoom`, `waitForReadySignal`, `subscribeToLockReleased`, `signalReady`, `acquireLockWithHandover`, `renewRoomLock`, `POD_NAME`. Identity is now the advertise address, not a random UUID suffix.

**The one ordering rule to preserve:** a Snapshot must land *before* ownership is given up. It is why `shutdown()` in the current file persists before releasing, and it survives unchanged into `drain()`.

- [ ] **Step 1: Write the failing test**

Replace `tldraw-sync-aws/test/roomManager.test.ts` entirely:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "events"
import type { WebSocket } from "ws"

const readOwner = vi.fn()
const casOwner = vi.fn()

vi.mock("../src/registry.js", () => ({
  readOwner,
  casOwner,
  OWNERSHIP_RECHECK_INTERVAL_MS: 5000,
}))

const fetchRoomSnapshot = vi.fn()
const persistRoomSnapshot = vi.fn()
vi.mock("../src/s3Storage.js", () => ({ fetchRoomSnapshot, persistRoomSnapshot }))

const ME = "http://10.0.1.7:3001"
const THEM = "http://10.0.1.8:3001"
vi.mock("../src/membership.js", () => ({
  defaultAdvertiseAddr: () => ME,
  Membership: class {
    constructor(
      readonly addr: string,
      readonly roomCount: () => number,
      readonly onEvicted: () => void,
    ) {}
    start() {}
    async stop() {}
  },
}))

// Stands in for TLSocketRoom. Same shape as the pre-existing fake.
class FakeRoom {
  static instances: FakeRoom[] = []
  sessions = new Set<string>()
  snapshot: unknown = { clock: 1, documents: [] }
  constructor(public config: Record<string, any>) {
    FakeRoom.instances.push(this)
  }
  getCurrentSnapshot() {
    return this.snapshot
  }
  handleSocketConnect({ sessionId }: { sessionId: string }) {
    this.sessions.add(sessionId)
  }
  handleSocketClose(sessionId: string) {
    this.sessions.delete(sessionId)
    this.config.onSessionRemoved(this, { sessionId, numSessionsRemaining: this.sessions.size })
  }
}
vi.mock("@tldraw/sync-core", () => ({ TLSocketRoom: FakeRoom }))

const { roomManager, NotOwnerError } = await import("../src/roomManager.js")

// The manager is a module-level singleton whose maps live for the whole file.
let roomCounter = 0
const nextRoomId = () => `room-${++roomCounter}`

function fakeSocket() {
  const socket = new EventEmitter() as unknown as WebSocket & {
    closes: Array<{ code: number; reason: string }>
  }
  socket.closes = []
  socket.close = ((code: number, reason: string) => {
    socket.closes.push({ code, reason })
    socket.emit("close")
  }) as WebSocket["close"]
  return socket
}

async function connect(roomId: string) {
  const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)
  const socket = fakeSocket()
  roomManager.connectSocket(room, roomId, socket, `session-${roomId}`, isNewRoom)
  return socket
}

beforeEach(() => {
  readOwner.mockReset().mockResolvedValue(null)
  casOwner.mockReset().mockResolvedValue("ok")
  fetchRoomSnapshot.mockReset().mockResolvedValue(undefined)
  persistRoomSnapshot.mockReset().mockResolvedValue(undefined)
})

describe("claiming a room", () => {
  it("claims an absent record with the must-not-exist precondition", async () => {
    const roomId = nextRoomId()
    await roomManager.getOrPrepareRoom(roomId)
    expect(casOwner).toHaveBeenCalledWith(roomId, null, ME)
  })

  it("serves without a CAS when the record already names us", async () => {
    const roomId = nextRoomId()
    readOwner.mockResolvedValueOnce({ owner: ME, etag: '"e1"' })
    await roomManager.getOrPrepareRoom(roomId)
    expect(casOwner).not.toHaveBeenCalled()
  })

  it("reallocates a dead owner's record against its etag", async () => {
    const roomId = nextRoomId()
    readOwner.mockResolvedValueOnce({ owner: null, etag: '"e2"' })
    await roomManager.getOrPrepareRoom(roomId)
    expect(casOwner).toHaveBeenCalledWith(roomId, '"e2"', ME)
  })

  it("refuses with the correction when the record names someone else", async () => {
    const roomId = nextRoomId()
    readOwner.mockResolvedValueOnce({ owner: THEM, etag: '"e1"' })
    await expect(roomManager.getOrPrepareRoom(roomId)).rejects.toThrow(NotOwnerError)
    await expect(roomManager.getOrPrepareRoom(roomId)).rejects.toMatchObject({ owner: THEM })
  })

  it("re-reads after a lost CAS and refuses with the winner's address", async () => {
    const roomId = nextRoomId()
    readOwner.mockResolvedValueOnce(null).mockResolvedValueOnce({ owner: THEM, etag: '"e3"' })
    casOwner.mockResolvedValueOnce("conflict")
    await expect(roomManager.getOrPrepareRoom(roomId)).rejects.toMatchObject({ owner: THEM })
  })

  it("serves after a lost CAS that the re-read shows we won anyway", async () => {
    const roomId = nextRoomId()
    readOwner.mockResolvedValueOnce(null).mockResolvedValueOnce({ owner: ME, etag: '"e4"' })
    casOwner.mockResolvedValueOnce("conflict")
    await expect(roomManager.getOrPrepareRoom(roomId)).resolves.toMatchObject({ isNewRoom: true })
  })

  it("collapses concurrent connects for one room into a single claim", async () => {
    const roomId = nextRoomId()
    await Promise.all([
      roomManager.getOrPrepareRoom(roomId),
      roomManager.getOrPrepareRoom(roomId),
      roomManager.getOrPrepareRoom(roomId),
    ])
    expect(casOwner).toHaveBeenCalledTimes(1)
  })
})

describe("losing ownership", () => {
  it("drops the room without saving and closes sessions 1013", async () => {
    const roomId = nextRoomId()
    const socket = await connect(roomId)
    persistRoomSnapshot.mockClear()

    readOwner.mockResolvedValueOnce({ owner: THEM, etag: '"e5"' })
    await roomManager.recheckAll()

    expect(persistRoomSnapshot).not.toHaveBeenCalled()
    expect(socket.closes).toEqual([
      { code: 1013, reason: "Room reallocated to another server, please reconnect" },
    ])
  })

  it("keeps serving when the ownership read fails, since a blip is not a loss", async () => {
    const roomId = nextRoomId()
    const socket = await connect(roomId)
    readOwner.mockRejectedValueOnce(new Error("network"))
    await roomManager.recheckAll()
    expect(socket.closes).toEqual([])
  })

  it("keeps serving while the record still names us", async () => {
    const roomId = nextRoomId()
    const socket = await connect(roomId)
    readOwner.mockResolvedValueOnce({ owner: ME, etag: '"e6"' })
    await roomManager.recheckAll()
    expect(socket.closes).toEqual([])
  })
})

describe("draining", () => {
  it("persists before vacating, never the other way round", async () => {
    const roomId = nextRoomId()
    await connect(roomId)
    const order: string[] = []
    persistRoomSnapshot.mockImplementationOnce(async () => void order.push("persist"))
    readOwner.mockResolvedValueOnce({ owner: ME, etag: '"e7"' })
    casOwner.mockImplementationOnce(async () => {
      order.push("vacate")
      return "ok"
    })

    await roomManager.drain()
    expect(order).toEqual(["persist", "vacate"])
  })

  it("vacates by CAS to null against the current etag", async () => {
    const roomId = nextRoomId()
    await connect(roomId)
    readOwner.mockResolvedValueOnce({ owner: ME, etag: '"e8"' })
    await roomManager.drain()
    expect(casOwner).toHaveBeenCalledWith(roomId, '"e8"', null)
  })

  it("does not vacate a record that has already moved on", async () => {
    const roomId = nextRoomId()
    await connect(roomId)
    casOwner.mockClear()
    readOwner.mockResolvedValueOnce({ owner: THEM, etag: '"e9"' })
    await roomManager.drain()
    expect(casOwner).not.toHaveBeenCalled()
  })

  it("closes drained sessions 1013 so clients reconnect elsewhere", async () => {
    const roomId = nextRoomId()
    const socket = await connect(roomId)
    readOwner.mockResolvedValueOnce({ owner: ME, etag: '"e10"' })
    await roomManager.drain()
    expect(socket.closes[0]).toMatchObject({ code: 1013 })
  })
})

describe("snapshot writes", () => {
  it("re-reads ownership before persisting and skips the write if it moved", async () => {
    const roomId = nextRoomId()
    await connect(roomId)
    const room = FakeRoom.instances[FakeRoom.instances.length - 1]
    persistRoomSnapshot.mockClear()

    readOwner.mockResolvedValueOnce({ owner: THEM, etag: '"e11"' })
    await roomManager.saveRoom(roomId)

    expect(persistRoomSnapshot).not.toHaveBeenCalled()
    expect(room).toBeDefined()
  })

  it("persists when the record still names us", async () => {
    const roomId = nextRoomId()
    await connect(roomId)
    persistRoomSnapshot.mockClear()
    readOwner.mockResolvedValueOnce({ owner: ME, etag: '"e12"' })
    await roomManager.saveRoom(roomId)
    expect(persistRoomSnapshot).toHaveBeenCalledWith(roomId, { clock: 1, documents: [] })
  })
})

describe("roomCount", () => {
  it("reports how many rooms are held, for the heartbeat body", async () => {
    const before = roomManager.roomCount()
    await connect(nextRoomId())
    expect(roomManager.roomCount()).toBe(before + 1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tldraw-sync-aws && yarn vitest run test/roomManager.test.ts`
Expected: FAIL — the current `roomManager.ts` still imports `redis` and exports no `NotOwnerError`.

- [ ] **Step 3: Write the implementation**

Replace `tldraw-sync-aws/src/roomManager.ts` entirely:

```ts
import { TLSocketRoom } from "@tldraw/sync-core"
import { type TLRecord, createTLSchema, defaultShapeSchemas } from "@tldraw/tlschema"
import { WebSocket } from "ws"
import throttle from "lodash.throttle"
import { fetchRoomSnapshot, persistRoomSnapshot } from "./s3Storage.js"
import { OWNERSHIP_RECHECK_INTERVAL_MS, casOwner, readOwner } from "./registry.js"
import { Membership, defaultAdvertiseAddr } from "./membership.js"
import {
  activeRoomsGauge,
  roomCasConflictsCounter,
  roomClaimsCounter,
  roomOwnershipLostCounter,
  roomReclaimsCounter,
} from "./metrics.js"

const THROTTLE_SAVE_MS = 10_000
const RECONNECT_REASON = "Room reallocated to another server, please reconnect"

const schema = createTLSchema({ shapes: { ...defaultShapeSchemas } })

interface TldrawWebSocket extends WebSocket {
  sessionId: string
  roomId: string
}

/**
 * Refusal carrying the correction. The worker answers the upgrade with 409 and
 * `x-room-owner`, so a router in mode B can retry against the named address on
 * the same client connection instead of the client seeing an error.
 */
export class NotOwnerError extends Error {
  constructor(readonly owner: string | null) {
    super("NOT_OWNER")
    this.name = "NotOwnerError"
  }
}

class RoomManager {
  /** Owner Identity: the same string that appears in members/ and owners/. */
  readonly addr = defaultAdvertiseAddr()

  private activeRooms = new Map<string, TLSocketRoom<TLRecord, void>>()
  private roomSockets = new Map<string, Set<TldrawWebSocket>>()
  private roomRechecks = new Map<string, NodeJS.Timeout>()
  // Kept so a pending trailing save can be cancelled the moment we stop owning
  // a Room; it would otherwise land on top of the next owner's state.
  private roomSaves = new Map<string, { cancel: () => void }>()
  private loadingRooms = new Map<string, Promise<TLSocketRoom<TLRecord, void>>>()

  readonly membership = new Membership(
    this.addr,
    () => this.roomCount(),
    () => void this.recheckAll(),
  )

  roomCount(): number {
    return this.activeRooms.size
  }

  /**
   * Claim the record if it is absent or vacant, serve if it names us, refuse if
   * it names someone else. One code path that works with a router in front and
   * in bare `yarn dev` with no router at all.
   */
  public async getOrPrepareRoom(
    roomId: string,
  ): Promise<{ room: TLSocketRoom<TLRecord, void>; isNewRoom: boolean }> {
    const existing = this.activeRooms.get(roomId)
    if (existing) return { room: existing, isNewRoom: false }

    const loading = this.loadingRooms.get(roomId)
    if (loading) return { room: await loading, isNewRoom: false }

    const loadPromise = (async () => {
      await this.claimOwnership(roomId)
      const room = await this.createRoom(roomId)
      this.activeRooms.set(roomId, room)
      activeRoomsGauge.inc()
      this.roomRechecks.set(
        roomId,
        setInterval(() => void this.recheckOwnership(roomId), OWNERSHIP_RECHECK_INTERVAL_MS),
      )
      return room
    })()

    this.loadingRooms.set(roomId, loadPromise)
    try {
      return { room: await loadPromise, isNewRoom: true }
    } finally {
      this.loadingRooms.delete(roomId)
    }
  }

  private async claimOwnership(roomId: string): Promise<void> {
    const record = await readOwner(roomId)

    if (record?.owner === this.addr) return
    if (record?.owner) throw new NotOwnerError(record.owner)

    // Absent record claims with "must not exist"; a vacated one reallocates
    // against its etag. `owner: null` and "no record" mean the same to a
    // reader, but not to a conditional write.
    const result = await casOwner(roomId, record ? record.etag : null, this.addr)
    if (result === "ok") {
      // An existing record belonged to a dead or drained owner; an absent one is
      // a Room nobody has held before. The dashboard cares about the difference.
      if (record) roomReclaimsCounter.inc()
      else roomClaimsCounter.inc()
      return
    }

    roomCasConflictsCounter.inc()
    const winner = await readOwner(roomId)
    if (winner?.owner === this.addr) return
    throw new NotOwnerError(winner?.owner ?? null)
  }

  /**
   * Re-read the record. If it moved, the in-memory copy is no longer
   * authoritative: drop it *without saving* and tell Sessions to reconnect.
   * A read failure is not a loss — the record is durable and a blip proves
   * nothing, so keep serving and try again next tick.
   */
  private async recheckOwnership(roomId: string): Promise<void> {
    if (!this.activeRooms.has(roomId)) return

    let record
    try {
      record = await readOwner(roomId)
    } catch (error) {
      console.error(`[Ownership] Re-read failed for room ${roomId}, still serving:`, error)
      return
    }

    if (record?.owner === this.addr) return

    console.error(`[Ownership] Lost room ${roomId} to ${record?.owner ?? "nobody"}, giving it up`)
    roomOwnershipLostCounter.inc()
    this.dropRoom(roomId)
    this.closeSockets(roomId)
  }

  /** Called by the membership self-check: react at poll speed, not re-read speed. */
  public async recheckAll(): Promise<void> {
    await Promise.all([...this.activeRooms.keys()].map((roomId) => this.recheckOwnership(roomId)))
  }

  /**
   * Persist a Room, but only after confirming the record still names us. A Room
   * whose ownership moved must not clobber the new owner's Snapshot.
   */
  public async saveRoom(roomId: string): Promise<void> {
    const room = this.activeRooms.get(roomId)
    if (!room) return

    let record
    try {
      record = await readOwner(roomId)
    } catch (error) {
      console.error(`[Snapshot] Ownership check failed for room ${roomId}, skipping save:`, error)
      return
    }
    if (record?.owner !== this.addr) return

    const snapshot = room.getCurrentSnapshot()
    if (snapshot) await persistRoomSnapshot(roomId, snapshot)
  }

  public connectSocket(
    room: TLSocketRoom<TLRecord, void>,
    roomId: string,
    ws: WebSocket,
    sessionId: string,
    isNewRoom: boolean,
  ): void {
    const socket = ws as TldrawWebSocket
    socket.sessionId = sessionId
    socket.roomId = roomId

    console.log(
      isNewRoom
        ? `[Room] User ${sessionId} created new room ${roomId}`
        : `[Room] User ${sessionId} joined room ${roomId}`,
    )

    room.handleSocketConnect({ socket, sessionId })

    if (!this.roomSockets.has(roomId)) this.roomSockets.set(roomId, new Set())
    this.roomSockets.get(roomId)!.add(socket)

    socket.on("close", () => {
      this.roomSockets.get(roomId)?.delete(socket)
      this.activeRooms.get(roomId)?.handleSocketClose(sessionId)
    })
  }

  /**
   * Drain. The caller must already have deregistered from members/ and waited
   * for routers to notice — see the shutdown handler in index.ts. Here we only
   * do the per-Room part, and the ordering is load-bearing: the Snapshot must
   * land before ownership is given up, or the next owner can claim the Room and
   * load a stale Snapshot while our write is still in flight.
   */
  public async drain(): Promise<void> {
    console.log(`[RoomManager] Draining ${this.activeRooms.size} rooms`)

    await Promise.allSettled(
      [...this.activeRooms.keys()].map(async (roomId) => {
        await this.saveRoom(roomId)
        await this.vacate(roomId)
        this.dropRoom(roomId)
        this.closeSockets(roomId)
      }),
    )

    console.log("[RoomManager] Drain complete")
  }

  /** CAS to vacant. Never a delete: an unconditional one is a split-brain. */
  private async vacate(roomId: string): Promise<void> {
    try {
      const record = await readOwner(roomId)
      if (record?.owner !== this.addr) return
      await casOwner(roomId, record.etag, null)
    } catch (error) {
      console.error(`[Ownership] Failed to vacate room ${roomId}:`, error)
    }
  }

  /** Forget a Room in memory. Touches neither the record nor its Sessions. */
  private dropRoom(roomId: string): void {
    const wasActive = this.activeRooms.delete(roomId)

    const recheck = this.roomRechecks.get(roomId)
    if (recheck) clearInterval(recheck)
    this.roomRechecks.delete(roomId)

    // A trailing throttled save would otherwise fire seconds from now and put
    // our stale state on top of the next owner's.
    this.roomSaves.get(roomId)?.cancel()
    this.roomSaves.delete(roomId)

    if (wasActive) activeRoomsGauge.dec()
  }

  private closeSockets(roomId: string): void {
    const sockets = this.roomSockets.get(roomId)
    if (!sockets?.size) return
    for (const socket of sockets) {
      try {
        socket.close(1013, RECONNECT_REASON)
      } catch {
        // Already closed.
      }
    }
    this.roomSockets.delete(roomId)
  }

  private async createRoom(roomId: string): Promise<TLSocketRoom<TLRecord, void>> {
    const initialSnapshot = await fetchRoomSnapshot(roomId)

    const saveThrottled = throttle(() => void this.saveRoom(roomId), THROTTLE_SAVE_MS)
    this.roomSaves.set(roomId, saveThrottled)

    return new TLSocketRoom<TLRecord, void>({
      schema,
      initialSnapshot: initialSnapshot || undefined,
      onDataChange: () => saveThrottled(),
      onSessionRemoved: (_room, { sessionId, numSessionsRemaining }) => {
        console.log(`[Room] Session ${sessionId} left ${roomId}, ${numSessionsRemaining} remaining`)
        if (numSessionsRemaining === 0) void this.cleanupRoom(roomId)
      },
    })
  }

  /** Last Session left: persist, vacate so another worker can take it, forget. */
  private async cleanupRoom(roomId: string): Promise<void> {
    await this.saveRoom(roomId)
    await this.vacate(roomId)
    this.dropRoom(roomId)
    this.roomSockets.delete(roomId)
  }
}

export const roomManager = new RoomManager()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tldraw-sync-aws && yarn vitest run test/roomManager.test.ts`
Expected: PASS, 18 tests

- [ ] **Step 5: Delete the Redis test double**

```bash
rm tldraw-sync-aws/test/helpers/fakeRedis.ts
```

- [ ] **Step 6: Drop the vitest fork-pool comment that no longer applies**

In `tldraw-sync-aws/vitest.config.ts`, replace the comment above `pool: "forks"`. Keep `pool: "forks"` itself — the room manager is still a module-level singleton.

```ts
    // Each file imports the room manager singleton, which starts timers and
    // reads module-level config at load; separate processes keep that module
    // state from leaking between files.
    pool: "forks",
```

- [ ] **Step 7: Commit**

```bash
cd tldraw-sync-aws && yarn typecheck && yarn format
git add tldraw-sync-aws/src/roomManager.ts tldraw-sync-aws/test/roomManager.test.ts tldraw-sync-aws/vitest.config.ts
git rm tldraw-sync-aws/test/helpers/fakeRedis.ts
git commit -m "refactor(aws): replace Redis locks and handover with bucket ownership records"
```

---
### Task 5: Swap the handover metrics for ownership and router metrics

**Files:**
- Modify: `tldraw-sync-aws/src/metrics.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (all registered on the existing `register`):
  - `roomClaimsCounter` — `tldraw_room_claims_total`
  - `roomReclaimsCounter` — `tldraw_room_reclaims_total`
  - `roomCasConflictsCounter` — `tldraw_room_cas_conflicts_total`
  - `roomOwnershipLostCounter` — `tldraw_room_ownership_lost_total`
  - `membersLiveGauge` — `tldraw_members_live`
  - `routerResolveDuration` — `tldraw_router_resolve_duration_seconds`
  - `routerRetriesCounter` — `tldraw_router_retries_total`
- Unchanged and still used: `register`, `activeRoomsGauge`, `activeConnectionsGauge`, `httpRequestDurationMicroseconds`, `errorCounter`.
- **Removed:** `handoverRequestsCounter`, `handoverSuccessCounter`, `handoverTimeoutCounter`, `handoverDurationHistogram`, `lockLostCounter`. Nothing may import these after Task 4.

- [ ] **Step 1: Delete the handover metrics**

In `tldraw-sync-aws/src/metrics.ts`, delete the five exports named above — every `handover*` metric plus `lockLostCounter`. Leave everything above them untouched.

- [ ] **Step 2: Add the replacements**

Append to `tldraw-sync-aws/src/metrics.ts`:

```ts
// --- Ownership (worker) ---

export const roomClaimsCounter = new client.Counter({
  name: "tldraw_room_claims_total",
  help: "Rooms claimed that had no ownership record at all",
  registers: [register],
})

export const roomReclaimsCounter = new client.Counter({
  name: "tldraw_room_reclaims_total",
  help: "Rooms reallocated from a dead or drained owner",
  registers: [register],
})

export const roomCasConflictsCounter = new client.Counter({
  name: "tldraw_room_cas_conflicts_total",
  help: "Conditional writes that lost the race and were re-read",
  registers: [register],
})

export const roomOwnershipLostCounter = new client.Counter({
  name: "tldraw_room_ownership_lost_total",
  help: "Rooms given up because the record no longer named this worker",
  registers: [register],
})

// --- Routing (router) ---

export const membersLiveGauge = new client.Gauge({
  name: "tldraw_members_live",
  help: "Workers currently inside MEMBER_TTL, as seen by this router",
  registers: [register],
})

export const routerResolveDuration = new client.Histogram({
  name: "tldraw_router_resolve_duration_seconds",
  help: "Time to answer which worker owns a room, including any CAS",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
})

export const routerRetriesCounter = new client.Counter({
  name: "tldraw_router_retries_total",
  help: "Connections retried against a corrected owner after a 409",
  registers: [register],
})
```

- [ ] **Step 3: Verify nothing still imports a deleted metric**

Run: `cd tldraw-sync-aws && grep -rn "handover\|lockLost" src/ test/ ; yarn typecheck`
Expected: grep prints nothing, typecheck passes.

- [ ] **Step 4: Commit**

```bash
cd tldraw-sync-aws && yarn format
git add tldraw-sync-aws/src/metrics.ts
git commit -m "feat(aws): replace handover metrics with ownership and router metrics"
```

---

### Task 6: Worker HTTP surface — refuse with a correction, and drain in order

**Files:**
- Modify: `tldraw-sync-aws/src/index.ts`
- Modify: `tldraw-sync-aws/test/index.test.ts` (add blocks; keep the existing mock scaffolding)

**Interfaces:**
- Consumes: `roomManager`, `NotOwnerError` (Task 4); `MEMBER_POLL_INTERVAL_MS` (Task 1).
- Produces: no new exports. Behaviour: `409` + `x-room-owner` on a refused upgrade, `/api/health` failing during drain, and the four-step drain order.

**The drain order is load-bearing and non-obvious.** On `SIGTERM`:

1. `DELETE members/{addr}` and start failing `/api/health`
2. **wait `2 × MEMBER_POLL_INTERVAL_MS`** so every router has dropped us from its live set
3. per Room: persist Snapshot → CAS record to `owner: null` → close Sessions `1013`
4. close the server and exit

Skip step 2 and routers cheerfully reallocate Rooms straight back onto the worker that is shutting down. The wait keys off the *poll* interval, not `MEMBER_TTL` — the record is deleted rather than left to go stale.

- [ ] **Step 1: Write the failing tests**

In `tldraw-sync-aws/test/index.test.ts`, change the `roomManager` mock to the new surface and add the blocks below. The existing mock line:

```ts
const getOrPrepareRoom = vi.fn()
const connectSocket = vi.fn()
const shutdown = vi.fn()
vi.mock("../src/roomManager.js", () => ({
  roomManager: { getOrPrepareRoom, connectSocket, shutdown },
}))
```

becomes:

```ts
const getOrPrepareRoom = vi.fn()
const connectSocket = vi.fn()
const drain = vi.fn()
const membershipStart = vi.fn()
const membershipStop = vi.fn()

class NotOwnerError extends Error {
  constructor(readonly owner: string | null) {
    super("NOT_OWNER")
    this.name = "NotOwnerError"
  }
}

vi.mock("../src/roomManager.js", () => ({
  NotOwnerError,
  roomManager: {
    getOrPrepareRoom,
    connectSocket,
    drain,
    addr: "http://10.0.1.7:3001",
    membership: { start: membershipStart, stop: membershipStop },
  },
}))

vi.mock("../src/registry.js", () => ({ MEMBER_POLL_INTERVAL_MS: 2000 }))
```

Then append these blocks:

```ts
// A raw upgrade socket: records what the server wrote before destroying it.
function fakeUpgradeSocket() {
  const socket = new EventEmitter() as unknown as import("stream").Duplex & {
    written: string
    ended: boolean
    destroyed: boolean
  }
  socket.written = ""
  socket.ended = false
  socket.destroyed = false
  socket.end = ((chunk?: string) => {
    if (chunk) socket.written += chunk
    socket.ended = true
    return socket
  }) as never
  socket.destroy = (() => {
    socket.destroyed = true
    return socket
  }) as never
  return socket
}

function upgradeRequest(url: string) {
  return { url, headers: { host: "localhost:3001" } } as import("http").IncomingMessage
}

describe("refusing a room this worker does not own", () => {
  it("answers 409 with the owner's address so a router can retry", async () => {
    getOrPrepareRoom.mockRejectedValueOnce(new NotOwnerError("http://10.0.1.8:3001"))
    const socket = fakeUpgradeSocket()

    fakeServer.emit("upgrade", upgradeRequest("/api/connect/room-1?sessionId=s1"), socket, Buffer.alloc(0))
    await vi.waitFor(() => expect(socket.ended).toBe(true))

    expect(socket.written).toContain("HTTP/1.1 409 Conflict")
    expect(socket.written.toLowerCase()).toContain("x-room-owner: http://10.0.1.8:3001")
    expect(handleUpgrade).not.toHaveBeenCalled()
  })

  it("still answers 409 when the record names nobody, with no owner header", async () => {
    getOrPrepareRoom.mockRejectedValueOnce(new NotOwnerError(null))
    const socket = fakeUpgradeSocket()

    fakeServer.emit("upgrade", upgradeRequest("/api/connect/room-2?sessionId=s1"), socket, Buffer.alloc(0))
    await vi.waitFor(() => expect(socket.ended).toBe(true))

    expect(socket.written).toContain("HTTP/1.1 409 Conflict")
    expect(socket.written.toLowerCase()).not.toContain("x-room-owner")
  })

  it("destroys the socket on any other failure rather than speaking HTTP", async () => {
    getOrPrepareRoom.mockRejectedValueOnce(new Error("S3 down"))
    const socket = fakeUpgradeSocket()

    fakeServer.emit("upgrade", upgradeRequest("/api/connect/room-3?sessionId=s1"), socket, Buffer.alloc(0))
    await vi.waitFor(() => expect(socket.destroyed).toBe(true))
    expect(socket.written).toBe("")
  })
})

describe("health during drain", () => {
  it("is ok while serving", async () => {
    const res = fakeResponse()
    await routes.get("GET /api/health")!(fakeRequest(), res)
    expect(res.statusCode).toBe(200)
  })
})

describe("drain order", () => {
  it("deregisters, waits for routers to notice, then drains rooms", async () => {
    vi.useFakeTimers()
    const order: string[] = []
    membershipStop.mockImplementation(async () => void order.push("deregister"))
    drain.mockImplementation(async () => void order.push("drain"))

    const shutdown = handleShutdownFor("SIGTERM")

    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(["deregister"])

    // 2 x MEMBER_POLL_INTERVAL_MS must elapse before any Room is given up.
    await vi.advanceTimersByTimeAsync(3999)
    expect(order).toEqual(["deregister"])

    await vi.advanceTimersByTimeAsync(1)
    await shutdown
    expect(order).toEqual(["deregister", "drain"])
    vi.useRealTimers()
  })
})
```

`handleShutdownFor` is a helper you add near the other test helpers in the file. `src/index.ts` registers its signal handlers with `process.on`, so capture them the same way the file already captures express routes:

```ts
// Near the top of the file, alongside the other capture scaffolding:
const signalHandlers = new Map<string, () => Promise<void>>()
const realProcessOn = process.on.bind(process)
vi.spyOn(process, "on").mockImplementation(((event: string, handler: any) => {
  if (event === "SIGTERM" || event === "SIGINT") signalHandlers.set(event, handler)
  return realProcessOn(event, handler)
}) as never)

// ...and with the helpers:
function handleShutdownFor(signal: string) {
  return signalHandlers.get(signal)!()
}
```

Note: `process.exit` must be stubbed for these tests — add `vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)` alongside the other mocks.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd tldraw-sync-aws && yarn vitest run test/index.test.ts`
Expected: FAIL — the upgrade handler destroys the socket instead of writing `409`, and there is no drain wait.

- [ ] **Step 3: Update the implementation**

In `tldraw-sync-aws/src/index.ts`, replace the imports of `roomManager` and add the registry import:

```ts
import { NotOwnerError, roomManager } from "./roomManager.js"
import { MEMBER_POLL_INTERVAL_MS } from "./registry.js"
import type { Duplex } from "stream"
```

Add, above the `/api/health` route:

```ts
// Flipped at the very start of drain so routers and probes stop sending work
// here while Rooms are still being handed back.
let draining = false

/**
 * Answer a WebSocket upgrade with a plain HTTP response. `ws` never sees the
 * socket, so the status line has to be written by hand.
 */
function refuseUpgrade(
  socket: Duplex,
  status: number,
  statusText: string,
  headers: Record<string, string> = {},
) {
  const head = [
    `HTTP/1.1 ${status} ${statusText}`,
    "Connection: close",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ]
  socket.end(`${head.join("\r\n")}\r\n\r\n`)
}
```

Replace the `/api/health` handler:

```ts
app.get("/api/health", (req, res) => {
  if (draining) return res.status(503).send("draining")
  res.status(200).send("ok")
})
```

Replace the `catch` block of the `upgrade` handler:

```ts
  } catch (err: unknown) {
    errorCounter.inc({ type: "websocket_error" })

    // Refusal carries the correction rather than just failing: a mode B router
    // retries against the named address on the same client connection, so the
    // race is invisible to the client.
    if (err instanceof NotOwnerError) {
      refuseUpgrade(socket, 409, "Conflict", err.owner ? { "x-room-owner": err.owner } : {})
      return
    }

    console.error(`[WebSocket] Failed to prepare room ${roomId}:`, err)
    socket.destroy()
  }
```

Replace `handleShutdown` entirely:

```ts
// The order here is load-bearing. Deregistering first and waiting for routers
// to notice is what stops a Room being reallocated straight back onto the
// worker that is shutting down. The wait keys off the router's poll interval,
// not MEMBER_TTL: the record is deleted, not left to go stale.
async function handleShutdown(signal: string) {
  console.log(`\n[${signal}] Signal received. Starting graceful shutdown...`)
  draining = true

  // 1. Leave the live set and start failing health checks.
  await roomManager.membership.stop()

  // 2. Give every router at least two polls to see us go.
  await new Promise((resolve) => setTimeout(resolve, 2 * MEMBER_POLL_INTERVAL_MS))

  // 3. Persist, vacate, and close Sessions 1013.
  try {
    await roomManager.drain()
  } catch (err) {
    console.error("Error draining rooms:", err)
    process.exit(1)
  }

  // 4. Stop accepting anything new and go.
  server.close(() => console.log("HTTP/WS server closed."))
  console.log("Graceful shutdown successful. Exiting.")
  process.exit(0)
}
```

Finally, start the heartbeat when the server is up:

```ts
server.listen(port, () => {
  roomManager.membership.start()
  console.log(`Server listening on port ${port} as ${roomManager.addr}`)
})
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tldraw-sync-aws && yarn vitest run test/index.test.ts`
Expected: PASS

- [ ] **Step 5: Run the whole suite**

Run: `cd tldraw-sync-aws && yarn test`
Expected: PASS — `registry`, `resolve`, `membership`, `roomManager`, `index`, `s3Storage`, `unfurl`

- [ ] **Step 6: Commit**

```bash
cd tldraw-sync-aws && yarn typecheck && yarn format
git add tldraw-sync-aws/src/index.ts tldraw-sync-aws/test/index.test.ts
git commit -m "feat(aws): refuse foreign rooms with 409 and drain in router-safe order"
```

---

### Task 7: The room-router, mode B — proxy by socket splicing

**Files:**
- Create: `tldraw-sync-aws/src/router/memberCache.ts`
- Create: `tldraw-sync-aws/src/router/proxy.ts`
- Create: `tldraw-sync-aws/src/router/index.ts`
- Test: `tldraw-sync-aws/test/router.test.ts`

**Interfaces:**
- Consumes: `listMembers`, `liveMembers`, `readOwner`, `casOwner`, `MEMBER_POLL_INTERVAL_MS` (Task 1); `resolve`, `LiveMember` (Task 2); `membersLiveGauge`, `routerResolveDuration`, `routerRetriesCounter`, `register` (Task 5).
- Produces:
  - `class MemberCache` — `start()`, `stop()`, `live(): LiveMember[]`, `routable(): LiveMember[]`, `markUnreachable(addr: string): void`, `refresh(): Promise<void>`
  - `resolveForConnect(roomId: string, cache: MemberCache): Promise<{ addr: string } | { error: 503 }>`
  - `startProxy(cache: MemberCache, port: number): Server`

**The rule this task exists to enforce:** reachability informs *routing*, never *ownership*. `live()` is what decides whether a recorded owner still counts — a worker this router cannot dial stays in it. `routable()` is used only when picking a worker for an *unclaimed* Room. A failed dial never triggers a CAS and never evicts.

- [ ] **Step 1: Write the failing test**

`tldraw-sync-aws/test/router.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest"

const listMembers = vi.fn()
const readOwner = vi.fn()
const casOwner = vi.fn()

vi.mock("../src/registry.js", () => ({
  listMembers,
  readOwner,
  casOwner,
  liveMembers: (members: { addr: string; updatedAt: number }[], now: number) =>
    members.filter((m) => now - m.updatedAt < 8000),
  MEMBER_POLL_INTERVAL_MS: 2000,
  MEMBER_TTL_MS: 8000,
}))

vi.mock("../src/metrics.js", () => ({
  register: { contentType: "text/plain", metrics: async () => "" },
  membersLiveGauge: { set: vi.fn() },
  routerResolveDuration: { startTimer: () => () => undefined },
  routerRetriesCounter: { inc: vi.fn() },
}))

const { MemberCache } = await import("../src/router/memberCache.js")
const { resolveForConnect } = await import("../src/router/proxy.js")

const A = "http://10.0.1.7:3001"
const B = "http://10.0.1.8:3001"

beforeEach(() => {
  listMembers.mockReset().mockResolvedValue([])
  readOwner.mockReset().mockResolvedValue(null)
  casOwner.mockReset().mockResolvedValue("ok")
})

describe("MemberCache", () => {
  it("exposes only members inside the TTL", async () => {
    listMembers.mockResolvedValueOnce([
      { addr: A, updatedAt: Date.now() },
      { addr: B, updatedAt: Date.now() - 9000 },
    ])
    const cache = new MemberCache()
    await cache.refresh()
    expect(cache.live().map((m) => m.addr)).toEqual([A])
  })

  it("keeps the last good list when a poll fails, rather than emptying", async () => {
    listMembers.mockResolvedValueOnce([{ addr: A, updatedAt: Date.now() }])
    const cache = new MemberCache()
    await cache.refresh()
    listMembers.mockRejectedValueOnce(new Error("network"))
    await cache.refresh()
    expect(cache.live().map((m) => m.addr)).toEqual([A])
  })

  it("keeps an unreachable worker live — reachability is not liveness", async () => {
    listMembers.mockResolvedValueOnce([{ addr: A, updatedAt: Date.now() }])
    const cache = new MemberCache()
    await cache.refresh()
    cache.markUnreachable(A)
    expect(cache.live().map((m) => m.addr)).toEqual([A])
  })

  it("drops an unreachable worker from allocation candidates", async () => {
    listMembers.mockResolvedValueOnce([
      { addr: A, updatedAt: Date.now() },
      { addr: B, updatedAt: Date.now() },
    ])
    const cache = new MemberCache()
    await cache.refresh()
    cache.markUnreachable(A)
    expect(cache.routable().map((m) => m.addr)).toEqual([B])
  })

  it("forgets unreachability once the worker heartbeats again", async () => {
    listMembers.mockResolvedValue([{ addr: A, updatedAt: Date.now() }])
    const cache = new MemberCache()
    await cache.refresh()
    cache.markUnreachable(A)
    expect(cache.routable()).toHaveLength(0)
    await cache.refresh()
    expect(cache.routable().map((m) => m.addr)).toEqual([A])
  })
})

describe("resolveForConnect", () => {
  async function cacheWith(addrs: string[]) {
    listMembers.mockResolvedValueOnce(addrs.map((addr) => ({ addr, updatedAt: Date.now() })))
    const cache = new MemberCache()
    await cache.refresh()
    return cache
  }

  it("routes to a live recorded owner without writing anything", async () => {
    readOwner.mockResolvedValueOnce({ owner: A, etag: '"e1"' })
    expect(await resolveForConnect("room-1", await cacheWith([A, B]))).toEqual({ addr: A })
    expect(casOwner).not.toHaveBeenCalled()
  })

  it("claims an unowned room and routes to the winner", async () => {
    const cache = await cacheWith([A, B])
    const result = await resolveForConnect("room-1", cache)
    expect(casOwner).toHaveBeenCalledWith("room-1", null, expect.any(String))
    expect(result).toHaveProperty("addr")
  })

  it("uses the winner's answer after a lost CAS instead of its own pick", async () => {
    readOwner.mockResolvedValueOnce(null).mockResolvedValueOnce({ owner: B, etag: '"e2"' })
    casOwner.mockResolvedValueOnce("conflict")
    expect(await resolveForConnect("room-1", await cacheWith([A, B]))).toEqual({ addr: B })
  })

  it("returns 503 when nothing is live, rather than dialling a dead address", async () => {
    readOwner.mockResolvedValueOnce({ owner: A, etag: '"e1"' })
    expect(await resolveForConnect("room-1", await cacheWith([]))).toEqual({ error: 503 })
  })

  it("honours a live owner this router cannot reach, and does not reallocate it", async () => {
    readOwner.mockResolvedValueOnce({ owner: A, etag: '"e1"' })
    const cache = await cacheWith([A, B])
    cache.markUnreachable(A)
    expect(await resolveForConnect("room-1", cache)).toEqual({ addr: A })
    expect(casOwner).not.toHaveBeenCalled()
  })

  it("avoids an unreachable worker when allocating an unclaimed room", async () => {
    const cache = await cacheWith([A, B])
    cache.markUnreachable(A)
    const result = await resolveForConnect("room-1", cache)
    expect(result).toEqual({ addr: B })
  })

  it("returns 503 rather than a bad route when the bucket read fails", async () => {
    readOwner.mockRejectedValueOnce(new Error("network"))
    expect(await resolveForConnect("room-1", await cacheWith([A]))).toEqual({ error: 503 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tldraw-sync-aws && yarn vitest run test/router.test.ts`
Expected: FAIL — `Cannot find module '../src/router/proxy.js'`

- [ ] **Step 3: Write the implementation**

`tldraw-sync-aws/src/router/memberCache.ts`:

```ts
import {
  MEMBER_POLL_INTERVAL_MS,
  listMembers,
  liveMembers,
  type Member,
} from "../registry.js"
import { membersLiveGauge } from "../metrics.js"
import type { LiveMember } from "./resolve.js"

// How long a failed dial keeps a worker out of allocation. Short: this is a
// routing preference, not a verdict, and a fresh heartbeat clears it anyway.
const UNREACHABLE_COOLDOWN_MS = 5_000

/**
 * The router's view of the fleet.
 *
 * Two lists, and the difference between them is the whole safety property:
 * `live()` answers "does the recorded owner still count", and a worker this
 * router cannot dial stays in it. `routable()` answers "who should take a Room
 * nobody owns", and there it is fair to skip one we cannot reach. Reachability
 * never evicts and never triggers a CAS.
 */
export class MemberCache {
  private members: Member[] = []
  private unreachableUntil = new Map<string, number>()
  private timer?: NodeJS.Timeout

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), MEMBER_POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async refresh(): Promise<void> {
    try {
      const members = await listMembers()
      this.members = members
      // A fresh heartbeat is better evidence than our last failed dial.
      for (const member of members) this.unreachableUntil.delete(member.addr)
      membersLiveGauge.set(this.live().length)
    } catch (error) {
      // Keep the previous list. An empty one would 503 every connect on a blip.
      console.error("[Router] Member poll failed, using last known list:", error)
    }
  }

  live(): LiveMember[] {
    return liveMembers(this.members, Date.now()).map(({ addr }) => ({ addr }))
  }

  routable(): LiveMember[] {
    const now = Date.now()
    return this.live().filter((member) => (this.unreachableUntil.get(member.addr) ?? 0) <= now)
  }

  markUnreachable(addr: string): void {
    this.unreachableUntil.set(addr, Date.now() + UNREACHABLE_COOLDOWN_MS)
  }
}
```

`tldraw-sync-aws/src/router/proxy.ts`:

```ts
import { createServer, type IncomingMessage, type Server } from "http"
import { connect as netConnect } from "net"
import type { Duplex } from "stream"
import { URL } from "url"
import { casOwner, readOwner } from "../registry.js"
import { register, routerResolveDuration, routerRetriesCounter } from "../metrics.js"
import { resolve } from "./resolve.js"
import { MemberCache } from "./memberCache.js"

/**
 * Which worker should this connection go to? Reads the record, resolves, and
 * CASes if the Room is up for allocation. One retry on a lost CAS: re-read and
 * use the winner's answer rather than our own pick.
 */
export async function resolveForConnect(
  roomId: string,
  cache: MemberCache,
): Promise<{ addr: string } | { error: 503 }> {
  const done = routerResolveDuration.startTimer()
  try {
    const record = await readOwner(roomId)
    const live = cache.live()

    let resolution = resolve(roomId, record, live)

    // Only allocation may prefer a reachable worker. Honouring a recorded owner
    // must use the full live set, or a network blip starts moving Rooms.
    if (resolution.action === "claim") {
      const routable = cache.routable()
      if (routable.length > 0) resolution = resolve(roomId, record, routable)
    }

    if (resolution.action === "unavailable") return { error: 503 }
    if (resolution.action === "use") return { addr: resolution.addr }

    if ((await casOwner(roomId, resolution.expect, resolution.addr)) === "ok") {
      return { addr: resolution.addr }
    }

    const winner = await readOwner(roomId)
    if (winner?.owner) return { addr: winner.owner }
    return { error: 503 }
  } catch (error) {
    console.error(`[Router] Failed to resolve room ${roomId}:`, error)
    return { error: 503 }
  } finally {
    done()
  }
}

const roomIdOf = (url: string) =>
  new URL(url, "http://router").pathname.match(/\/api\/connect\/(.+)/)?.[1]

function writeStatus(socket: Duplex, status: number, statusText: string) {
  socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n\r\n`)
}

/**
 * Replay the client's upgrade at the owner and splice the two sockets. After
 * the 101 this is byte plumbing in Node's stream path — the router never parses
 * a WebSocket frame, so its cost is per-chunk, not per-edit.
 */
function splice(
  request: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  addr: string,
  cache: MemberCache,
  onRetry: (owner: string) => void,
) {
  const target = new URL(addr)
  const upstream = netConnect(
    { host: target.hostname, port: Number(target.port || 80) },
    () => {
      const headers = Object.entries(request.headers)
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`)
        .join("\r\n")
      upstream.write(`GET ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`)
      if (head.length) upstream.write(head)
    },
  )

  upstream.on("error", () => {
    // A failed dial is a routing signal only: never a CAS, never an eviction.
    cache.markUnreachable(addr)
    if (!clientSocket.destroyed) writeStatus(clientSocket, 503, "Service Unavailable")
  })

  let buffered = Buffer.alloc(0)
  let spliced = false

  upstream.on("data", (chunk: Buffer) => {
    if (spliced) return
    buffered = Buffer.concat([buffered, chunk])
    const headEnd = buffered.indexOf("\r\n\r\n")
    if (headEnd === -1) return

    const responseHead = buffered.subarray(0, headEnd).toString()

    // The worker refused because the record moved between our resolve and its
    // connect. It told us who owns it now; retry there on the same client
    // connection, so the race stays invisible to the client.
    if (responseHead.startsWith("HTTP/1.1 409")) {
      const owner = responseHead.match(/x-room-owner:\s*(\S+)/i)?.[1]
      upstream.destroy()
      if (owner) onRetry(owner)
      else writeStatus(clientSocket, 503, "Service Unavailable")
      return
    }

    spliced = true
    clientSocket.write(buffered)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })

  clientSocket.on("error", () => upstream.destroy())
  upstream.on("close", () => clientSocket.destroy())
}

export function startProxy(cache: MemberCache, port: number): Server {
  const server = createServer(async (request, response) => {
    if (request.url === "/metrics") {
      response.setHeader("Content-Type", register.contentType)
      response.end(await register.metrics())
      return
    }
    if (request.url === "/api/health") {
      response.end("ok")
      return
    }

    // Plain HTTP needs no affinity: any routable member will do.
    const candidates = cache.routable()
    if (candidates.length === 0) {
      response.statusCode = 503
      response.end("no live workers")
      return
    }
    const target = candidates[Math.floor(Math.random() * candidates.length)].addr
    response.statusCode = 307
    response.setHeader("Location", `${target}${request.url}`)
    response.end()
  })

  server.on("upgrade", async (request, clientSocket, head) => {
    const roomId = request.url ? roomIdOf(request.url) : undefined
    if (!roomId) {
      clientSocket.destroy()
      return
    }

    const resolution = await resolveForConnect(roomId, cache)
    if ("error" in resolution) {
      writeStatus(clientSocket, 503, "Service Unavailable")
      return
    }

    // Bounded to a single retry: the corrected owner is authoritative, and a
    // second bounce would mean the record is moving faster than we can follow.
    splice(request, clientSocket, head, resolution.addr, cache, (owner) => {
      routerRetriesCounter.inc()
      splice(request, clientSocket, head, owner, cache, () =>
        writeStatus(clientSocket, 503, "Service Unavailable"),
      )
    })
  })

  server.listen(port, () => console.log(`[Router] proxy mode listening on ${port}`))
  return server
}
```

`tldraw-sync-aws/src/router/index.ts`:

```ts
import { MemberCache } from "./memberCache.js"
import { startProxy } from "./proxy.js"

// One package, two entrypoints: src/index.ts is the worker, this is the router.
// They share registry.ts, so there is one CAS implementation and one install.
const port = Number(process.env.PORT || 8080)
const cache = new MemberCache()
cache.start()

startProxy(cache, port)

process.on("SIGTERM", () => {
  cache.stop()
  process.exit(0)
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tldraw-sync-aws && yarn vitest run test/router.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 5: Add the router build entrypoint**

In `tldraw-sync-aws/package.json`, add to `scripts`:

```json
    "dev:router": "tsx watch --clear-screen=false --env-file=.env src/router/index.ts",
    "start:router": "node dist/router/index.js",
```

- [ ] **Step 6: Commit**

```bash
cd tldraw-sync-aws && yarn typecheck && yarn format
git add tldraw-sync-aws/src/router tldraw-sync-aws/test/router.test.ts tldraw-sync-aws/package.json
git commit -m "feat(aws): add room-router with socket-splicing proxy mode"
```

---
### Task 8: The room-router, mode A — `ext_authz` behind Envoy

**Files:**
- Create: `tldraw-sync-aws/src/router/extAuthz.ts`
- Create: `tldraw-sync-aws/envoy.yaml`
- Modify: `tldraw-sync-aws/src/router/index.ts`
- Test: `tldraw-sync-aws/test/extAuthz.test.ts`

**Interfaces:**
- Consumes: `MemberCache` (Task 7), `resolveForConnect` (Task 7), `register` (Task 5).
- Produces: `hostPort(addr: string): string`, `startExtAuthz(cache: MemberCache, port: number): Server`.

**Three findings from the spike that will cost you an afternoon if you rediscover them:**

- **`x-envoy-original-dst-host` takes `host:port`, with no scheme.** The Owner Identity is a full URL, so it must be reduced. That is what `hostPort()` is for, and it is the only place the two representations meet.
- **Envoy does not forward the `Upgrade` header to the authz service by default** — the spike saw `upgrade=-`. Resolution here is by path, so it does not matter; anything that later needs to tell a WS upgrade from a plain GET must add `authorization_request.allowed_headers`.
- **Envoy lowercases response header names.** Harmless, but it breaks any case-sensitive assertion.

`ORIGINAL_DST` with no header returns `503 no healthy upstream`, which is the correct fail-closed behaviour when the router has no live members — observed, not assumed.

- [ ] **Step 1: Write the failing test**

`tldraw-sync-aws/test/extAuthz.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest"

const resolveForConnect = vi.fn()
vi.mock("../src/router/proxy.js", () => ({ resolveForConnect }))
vi.mock("../src/metrics.js", () => ({
  register: { contentType: "text/plain", metrics: async () => "" },
}))
vi.mock("../src/router/memberCache.js", () => ({ MemberCache: class {} }))

const { hostPort, handleAuthz } = await import("../src/router/extAuthz.js")

beforeEach(() => resolveForConnect.mockReset())

describe("hostPort", () => {
  it("strips the scheme, because Envoy wants host:port", () => {
    expect(hostPort("http://10.0.1.7:3001")).toBe("10.0.1.7:3001")
  })

  it("defaults the port when the URL omits it", () => {
    expect(hostPort("http://worker.internal")).toBe("worker.internal:80")
  })

  it("defaults an https URL to 443", () => {
    expect(hostPort("https://sync-3-xyz.run.app")).toBe("sync-3-xyz.run.app:443")
  })
})

describe("handleAuthz", () => {
  const cache = { routable: () => [{ addr: "http://10.0.1.9:3001" }] } as never

  it("allows an affinity route and names the owner as host:port", async () => {
    resolveForConnect.mockResolvedValueOnce({ addr: "http://10.0.1.7:3001" })
    expect(await handleAuthz("/api/connect/room-1?sessionId=s1", cache)).toEqual({
      status: 200,
      headers: { "x-envoy-original-dst-host": "10.0.1.7:3001" },
    })
  })

  it("fails closed with 503 when the room cannot be resolved", async () => {
    resolveForConnect.mockResolvedValueOnce({ error: 503 })
    expect(await handleAuthz("/api/connect/room-1", cache)).toMatchObject({ status: 503 })
  })

  it("resolves a non-affinity route to any routable member, with no bucket read", async () => {
    expect(await handleAuthz("/api/unfurl?url=x", cache)).toEqual({
      status: 200,
      headers: { "x-envoy-original-dst-host": "10.0.1.9:3001" },
    })
    expect(resolveForConnect).not.toHaveBeenCalled()
  })

  it("fails closed on a non-affinity route when nothing is routable", async () => {
    const empty = { routable: () => [] } as never
    expect(await handleAuthz("/metrics", empty)).toMatchObject({ status: 503 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tldraw-sync-aws && yarn vitest run test/extAuthz.test.ts`
Expected: FAIL — `Cannot find module '../src/router/extAuthz.js'`

- [ ] **Step 3: Write the implementation**

`tldraw-sync-aws/src/router/extAuthz.ts`:

```ts
import { createServer, type Server } from "http"
import { URL } from "url"
import { register } from "../metrics.js"
import type { MemberCache } from "./memberCache.js"
import { resolveForConnect } from "./proxy.js"

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" }

/**
 * Envoy's ORIGINAL_DST header takes host:port and refuses a scheme. The Owner
 * Identity is a full URL, so this is the one place the two representations
 * meet — keep it here rather than letting bare host:port leak into the registry.
 */
export function hostPort(addr: string): string {
  const url = new URL(addr)
  return `${url.hostname}:${url.port || DEFAULT_PORTS[url.protocol] || "80"}`
}

export interface AuthzDecision {
  status: number
  headers?: Record<string, string>
}

/**
 * One call per connection, never per message — which is the property mode A
 * exists for. Envoy does the proxying, so the router holds zero sockets and
 * its cost is O(connects per second).
 */
export async function handleAuthz(url: string, cache: MemberCache): Promise<AuthzDecision> {
  const { pathname } = new URL(url, "http://router")
  const roomId = pathname.match(/\/api\/connect\/(.+)/)?.[1]

  if (roomId) {
    const resolution = await resolveForConnect(roomId, cache)
    if ("error" in resolution) return { status: 503 }
    return { status: 200, headers: { "x-envoy-original-dst-host": hostPort(resolution.addr) } }
  }

  // /api/uploads, /api/unfurl, /api/health, /metrics: no affinity, no bucket
  // read. Naming an upstream here too is what lets Envoy hold exactly one
  // cluster and perform no service discovery at all.
  const candidates = cache.routable()
  if (candidates.length === 0) return { status: 503 }

  const target = candidates[Math.floor(Math.random() * candidates.length)].addr
  return { status: 200, headers: { "x-envoy-original-dst-host": hostPort(target) } }
}

export function startExtAuthz(cache: MemberCache, port: number): Server {
  const server = createServer(async (request, response) => {
    if (request.url === "/metrics") {
      response.setHeader("Content-Type", register.contentType)
      response.end(await register.metrics())
      return
    }

    const decision = await handleAuthz(request.url ?? "/", cache)
    response.statusCode = decision.status
    for (const [name, value] of Object.entries(decision.headers ?? {})) {
      response.setHeader(name, value)
    }
    response.end()
  })

  server.listen(port, () => console.log(`[Router] ext_authz mode listening on ${port}`))
  return server
}
```

Replace `tldraw-sync-aws/src/router/index.ts`:

```ts
import { MemberCache } from "./memberCache.js"
import { startExtAuthz } from "./extAuthz.js"
import { startProxy } from "./proxy.js"

// One package, two entrypoints: src/index.ts is the worker, this is the router.
// They share registry.ts, so there is one CAS implementation and one install.
//
// The transport differs; the decision does not. Both shells call the same
// resolve() over the same registry, and neither performs service discovery.
const mode = process.env.ROUTER_MODE === "ext-authz" ? "ext-authz" : "proxy"
const port = Number(process.env.PORT || 8080)

const cache = new MemberCache()
cache.start()

const server = mode === "ext-authz" ? startExtAuthz(cache, port) : startProxy(cache, port)

process.on("SIGTERM", () => {
  cache.stop()
  server.close(() => process.exit(0))
})
```

- [ ] **Step 4: Write the Envoy config**

`tldraw-sync-aws/chart/files/envoy.yaml`. **It must live inside the chart directory.** Helm's `.Files.Get` cannot read anything above the chart root, and a path outside it renders an *empty* ConfigMap with no error at all — Envoy then dies on an empty config, which looks like a crashloop rather than a templating mistake:

```yaml
# Envoy replaces ingress-nginx; it is not an added tier. It performs no service
# discovery at all: ext_authz names an upstream for every route, affinity or
# not, so there is exactly one cluster with no endpoint configuration.
admin:
  address:
    socket_address: { address: 127.0.0.1, port_value: 9901 }

static_resources:
  listeners:
    - name: ingress
      address:
        socket_address: { address: 0.0.0.0, port_value: 8080 }
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: ingress_http
                # WebSockets are long-lived; neither Envoy nor the route may
                # time them out.
                stream_idle_timeout: 0s
                upgrade_configs:
                  - upgrade_type: websocket
                route_config:
                  name: all
                  # Only ext_authz may choose an upstream. Envoy already strips
                  # x-envoy-* from non-internal addresses; doing it explicitly
                  # makes that a property of this config, not of a default.
                  # NOTE: this belongs on the route config, NOT on the
                  # connection manager, which has no such field. The design doc
                  # says "on the listener" and is wrong; Envoy rejects it with
                  # "no such field: 'request_headers_to_remove'".
                  request_headers_to_remove:
                    - x-envoy-original-dst-host
                  virtual_hosts:
                    - name: all
                      domains: ["*"]
                      routes:
                        - match: { prefix: "/" }
                          route: { cluster: tldraw_workers, timeout: 0s }
                http_filters:
                  - name: envoy.filters.http.ext_authz
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz
                      # Never guess an upstream. With no live members the
                      # router 503s and so does Envoy.
                      failure_mode_allow: false
                      http_service:
                        server_uri:
                          uri: http://127.0.0.1:8081
                          cluster: room_router
                          timeout: 2s
                        authorization_response:
                          allowed_upstream_headers:
                            patterns:
                              - exact: x-envoy-original-dst-host
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router

  clusters:
    # Dictated by the router, never discovered. This is the only cluster that
    # carries traffic, and it has no endpoints.
    - name: tldraw_workers
      type: ORIGINAL_DST
      lb_policy: CLUSTER_PROVIDED
      connect_timeout: 2s
      original_dst_lb_config:
        use_http_header: true
        http_header_name: x-envoy-original-dst-host

    # The router itself, over loopback in the same pod.
    - name: room_router
      type: STATIC
      connect_timeout: 1s
      load_assignment:
        cluster_name: room_router
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address: { address: 127.0.0.1, port_value: 8081 }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd tldraw-sync-aws && yarn vitest run test/extAuthz.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 6: Validate the Envoy config without running it**

Run: `docker run --rm -v "$PWD/chart/files/envoy.yaml:/envoy.yaml:ro" envoyproxy/envoy:v1.34-latest --mode validate -c /envoy.yaml`
Expected: `configuration '/envoy.yaml' OK`

**Do not skip this and deploy instead.** A rejected field surfaces in the cluster as a two-container pod stuck at 1/2 in CrashLoopBackOff, and the actual reason is buried under about eighty lines of Envoy extension listing.

- [ ] **Step 7: Commit**

```bash
cd tldraw-sync-aws && yarn typecheck && yarn format
git add tldraw-sync-aws/src/router tldraw-sync-aws/test/extAuthz.test.ts tldraw-sync-aws/envoy.yaml
git commit -m "feat(aws): add ext_authz router mode and Envoy config"
```

---

### Task 9: Docker compose — the whole thing running, mode B

**Files:**
- Create: `tldraw-sync-aws/compose.yaml`
- Modify: `tldraw-sync-aws/Dockerfile`
- Modify: `tldraw-sync-aws/.env.example`
- Delete: `tldraw-sync-aws/test-handover.js`, `tldraw-sync-aws/test-lock.js`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: `docker compose up -d --scale app=3` giving a working, Redis-free stack on `localhost:8080`.

**This is the first end-to-end verification.** Tasks 1–8 tested decisions in isolation; this is where the socket splicing, the real handshake, and the real conditional writes against LocalStack are exercised together.

- [ ] **Step 1: Teach the Dockerfile about the second entrypoint**

`src/router/**` compiles into `dist/router/**` already — `tsconfig.json` has `rootDir: "src"` and includes `src/**/*.ts`, so no build change is needed. Only the default command needs to stay the worker, with the router overriding it. Confirm by running `yarn build && ls dist/router/index.js`.

Replace the last line of `tldraw-sync-aws/Dockerfile`:

```dockerfile
# Two entrypoints from one image: the worker by default, the router by
# overriding the command. One install, one test suite, one thing to push.
CMD ["yarn", "start"]
```

- [ ] **Step 2: Write the compose file**

`tldraw-sync-aws/compose.yaml`:

```yaml
# Mode B: the router proxies WebSockets by splicing sockets, so there is no
# Envoy here. Locally the edit-run loop is worth more than the availability
# property, since nothing stays established long enough to care.
name: tldraw-sync-aws

services:
  room-router:
    build: .
    command: ["yarn", "start:router"]
    ports:
      - "8080:8080"
    environment:
      PORT: "8080"
      ROUTER_MODE: proxy
      S3_BUCKET_NAME: tldraw-test-bucket
      AWS_REGION: us-east-1
      S3_ENDPOINT: http://localstack:4566
      S3_FORCE_PATH_STYLE: "true"
      AWS_ACCESS_KEY_ID: test
      AWS_SECRET_ACCESS_KEY: test
    depends_on:
      localstack:
        condition: service_healthy

  app:
    build: .
    # No published port: reached only by the router, on the compose network.
    environment:
      PORT: "3001"
      S3_BUCKET_NAME: tldraw-test-bucket
      AWS_REGION: us-east-1
      S3_ENDPOINT: http://localstack:4566
      S3_FORCE_PATH_STYLE: "true"
      AWS_ACCESS_KEY_ID: test
      AWS_SECRET_ACCESS_KEY: test
    depends_on:
      localstack:
        condition: service_healthy
    # Container IPs on the shared network are routable from the router, so
    # ADVERTISE_ADDR is left unset and the primary-NIC default is correct.

  localstack:
    # Pinned deliberately: LocalStack merged its community and pro images in
    # 2026.3.0, so :latest and :stable exit 55 without an auth token. 4.14.0 is
    # the newest tag that still runs unauthenticated.
    image: localstack/localstack:4.14.0
    environment:
      SERVICES: s3
      EAGER_SERVICE_LOADING: "1"
    volumes:
      - ./scripts/create-bucket.sh:/etc/localstack/init/ready.d/create-bucket.sh:ro
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4566/_localstack/health"]
      interval: 5s
      retries: 30
```

`tldraw-sync-aws/scripts/create-bucket.sh` (new, mode `0755`):

```sh
#!/bin/sh
# Runs each time S3 comes up. There is no volume behind the emulator, so a
# restarted container would otherwise come back bucketless.
awslocal s3 mb s3://tldraw-test-bucket || true
```

- [ ] **Step 3: Bring it up and verify sync end to end**

```bash
cd tldraw-sync-aws
docker compose up -d --build --scale app=3
sleep 20
cd tldraw-client && npm install --no-audit --no-fund
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
  S3_ENDPOINT=http://localhost:4566 S3_BUCKET_NAME=tldraw-test-bucket AWS_REGION=us-east-1 \
  node verify-sync.mjs http://localhost:8080
```

Expected: the script's existing pass output — two clients sync, the Snapshot lands in S3, and a cold room restores.

- [ ] **Step 4: Verify room affinity is a guarantee, not a hash**

```bash
cd tldraw-sync-aws
# Which worker owns each room, straight from the bucket.
docker compose exec localstack awslocal s3 ls s3://tldraw-test-bucket/owners/
docker compose exec localstack awslocal s3 ls s3://tldraw-test-bucket/members/
```

Expected: one object under `members/` per running `app` container, and one under `owners/` per room touched.

Now scale up and confirm nothing moves — this is the headline behavioural change:

```bash
docker compose exec localstack awslocal s3 cp s3://tldraw-test-bucket/owners/<roomId> - # note the owner
docker compose up -d --scale app=5
sleep 10
docker compose exec localstack awslocal s3 cp s3://tldraw-test-bucket/owners/<roomId> - # unchanged
```

Expected: **the same owner**. Under hash routing a 3→5 scale moved roughly a third of rooms; here scaling up disturbs nothing.

- [ ] **Step 5: Verify reclaim after a kill**

```bash
docker compose exec localstack awslocal s3 cp s3://tldraw-test-bucket/owners/<roomId> -  # note owner
docker kill "$(docker compose ps -q app | head -1)"
sleep 12
# reconnect a client, then:
docker compose exec localstack awslocal s3 cp s3://tldraw-test-bucket/owners/<roomId> -
```

Expected: the record now names a different worker, reallocated within roughly `MEMBER_TTL` (8s) of the kill plus one poll.

- [ ] **Step 6: Delete the Redis-era scratch scripts**

```bash
git rm tldraw-sync-aws/test-handover.js tldraw-sync-aws/test-lock.js
```

- [ ] **Step 7: Update `.env.example`**

Replace the `REDIS_URL` block in `tldraw-sync-aws/.env.example`:

```
# Room ownership and worker membership live in the same bucket as snapshots,
# under owners/ and members/. There is no Redis and no service discovery.

# How this worker advertises itself. Must be dialable by the router, and it is
# also the Owner Identity written into owners/. Defaults to the primary
# non-loopback IPv4 plus PORT, which is correct for Docker and bare local runs.
# ADVERTISE_ADDR=http://10.0.1.7:3001

# Router only. "proxy" splices WebSockets itself (Cloud Run, Docker);
# "ext-authz" answers Envoy and holds no sockets (EKS, GKE, GCE).
# ROUTER_MODE=proxy

# Timings. Defaults shown; see the design doc for why 2s/8s and not 2s/6s.
# HEARTBEAT_INTERVAL_MS=2000
# MEMBER_POLL_INTERVAL_MS=2000
# MEMBER_TTL_MS=8000
# OWNERSHIP_RECHECK_INTERVAL_MS=5000
```

- [ ] **Step 8: Commit**

```bash
git add tldraw-sync-aws/compose.yaml tldraw-sync-aws/scripts/create-bucket.sh tldraw-sync-aws/Dockerfile tldraw-sync-aws/.env.example
git commit -m "feat(aws): add compose stack for Redis-free local development"
```

---

### Task 10: The Helm chart — Redis and the Ingress out, Envoy in

**Files:**
- Create: `tldraw-sync-aws/chart/templates/envoy.yaml`
- Modify: `tldraw-sync-aws/chart/values.yaml`, `tldraw-sync-aws/chart/templates/deployment.yaml`
- Delete: `tldraw-sync-aws/chart/templates/redis.yaml`, `tldraw-sync-aws/chart/templates/ingress.yaml`

**Interfaces:**
- Consumes: the image from Task 9.
- Produces: a chart that deploys workers plus an Envoy/router sidecar pair, reachable on a `LoadBalancer` Service at port 8081.

**Why the `Ingress` is deleted rather than re-annotated:** pointing a de-hashed nginx Ingress at Envoy would preserve the `aws.localhost:8080` URL, but it would make this the one place in the repo where Envoy is genuinely an added tier — demonstrating the opposite of the design. See ADR 0005.

- [ ] **Step 1: Delete the Redis and Ingress templates**

```bash
git rm tldraw-sync-aws/chart/templates/redis.yaml tldraw-sync-aws/chart/templates/ingress.yaml
```

- [ ] **Step 2: Update values**

In `tldraw-sync-aws/chart/values.yaml`, delete the whole `redis:` block and the `ingress:` block, and add:

```yaml
# Envoy + room-router as a sidecar pair. This REPLACES ingress-nginx for the
# AWS demo rather than sitting behind it — see ADR 0005.
router:
  replicaCount: 2
  # Port published by the Service. Not :80, which k3s svclb has already bound
  # for the nginx controller that still serves the GCP demo and Grafana.
  port: 8081
  envoyImage: envoyproxy/envoy:v1.34-latest

# Timings. See the design doc for why 2s/8s and not 2s/6s.
timings:
  heartbeatIntervalMs: 2000
  memberPollIntervalMs: 2000
  memberTtlMs: 8000
  ownershipRecheckIntervalMs: 5000
```

- [ ] **Step 3: Update the worker Deployment**

In `tldraw-sync-aws/chart/templates/deployment.yaml`:

Delete the whole `REDIS_URL` env entry. Replace the `HOSTNAME` entry — identity is no longer a pod name — and add the timings:

```yaml
            # Owner Identity: the exact string written into both members/ and
            # owners/. Pod IPs are routable from any pod under the VPC CNI, so
            # Envoy dials this directly with no Service in the path.
            - name: ADVERTISE_ADDR
              value: "http://$(POD_IP):3001"
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
            - name: HEARTBEAT_INTERVAL_MS
              value: {{ .Values.timings.heartbeatIntervalMs | quote }}
            - name: MEMBER_POLL_INTERVAL_MS
              value: {{ .Values.timings.memberPollIntervalMs | quote }}
            - name: MEMBER_TTL_MS
              value: {{ .Values.timings.memberTtlMs | quote }}
            - name: OWNERSHIP_RECHECK_INTERVAL_MS
              value: {{ .Values.timings.ownershipRecheckIntervalMs | quote }}
```

**`$(POD_IP)` interpolation requires `POD_IP` to be declared before `ADVERTISE_ADDR` in the list** — Kubernetes resolves `$(VAR)` only against variables defined earlier. Order the two entries as shown, `POD_IP` first, then `ADVERTISE_ADDR`. (The snippet above lists them the other way for readability; put `POD_IP` first in the file.)

Also raise the grace period, since drain now waits two router polls before touching a Room:

```yaml
      # Drain deregisters, waits ~2x the router poll so every router drops us,
      # then persists and vacates every Room.
      terminationGracePeriodSeconds: 90
```

- [ ] **Step 4: Add the Envoy + router pair**

`tldraw-sync-aws/chart/templates/envoy.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-envoy
data:
  envoy.yaml: |
{{ .Files.Get "envoy.yaml" | indent 4 }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-router
  labels:
    app: {{ .Release.Name }}-router
spec:
  replicas: {{ .Values.router.replicaCount }}
  selector:
    matchLabels:
      app: {{ .Release.Name }}-router
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}-router
    spec:
      containers:
        # Envoy reaches the router over loopback; nothing reaches either the
        # admin port or the ext_authz port from outside the pod.
        - name: envoy
          image: {{ .Values.router.envoyImage | quote }}
          args: ["-c", "/etc/envoy/envoy.yaml"]
          ports:
            - name: http
              containerPort: 8080
          volumeMounts:
            - name: envoy-config
              mountPath: /etc/envoy
        - name: router
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          command: ["yarn", "start:router"]
          ports:
            - name: authz
              containerPort: 8081
          env:
            - name: PORT
              value: "8081"
            - name: ROUTER_MODE
              value: ext-authz
            - name: S3_BUCKET_NAME
              value: {{ .Values.env.s3BucketName | quote }}
            - name: AWS_REGION
              value: {{ .Values.env.awsRegion | quote }}
            - name: MEMBER_POLL_INTERVAL_MS
              value: {{ .Values.timings.memberPollIntervalMs | quote }}
            - name: MEMBER_TTL_MS
              value: {{ .Values.timings.memberTtlMs | quote }}
            {{- if .Values.emulator.enabled }}
            - name: S3_ENDPOINT
              value: "http://{{ .Release.Name }}-localstack:4566"
            - name: S3_FORCE_PATH_STYLE
              value: "true"
            - name: AWS_ACCESS_KEY_ID
              value: {{ .Values.emulator.accessKey | quote }}
            - name: AWS_SECRET_ACCESS_KEY
              value: {{ .Values.emulator.secretKey | quote }}
            {{- end }}
      volumes:
        - name: envoy-config
          configMap:
            name: {{ .Release.Name }}-envoy
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-router
spec:
  type: LoadBalancer
  selector:
    app: {{ .Release.Name }}-router
  ports:
    - name: http
      port: {{ .Values.router.port }}
      targetPort: 8080
```

- [ ] **Step 5: Verify the chart renders and has no Redis left**

```bash
cd tldraw-sync-aws
helm template test chart/ | grep -i redis   # expect no output
helm template test chart/ | grep -c "kind: Deployment"   # expect 3: app, router, localstack
helm lint chart/
```

- [ ] **Step 6: Commit**

```bash
git add tldraw-sync-aws/chart
git commit -m "feat(aws): replace Redis and Ingress with an Envoy plus room-router pair"
```

---

### Task 11: `local-cluster` — AWS off the nginx path

**Files:**
- Modify: `local-cluster/k3d-config.yaml`, `local-cluster/scripts/verify-aws.sh`, `local-cluster/dashboards/tldraw-scaling-dashboard.yaml`, `local-cluster/README.md`, `local-cluster/Makefile`
- Use (already written; it produced the baseline below): `tldraw-sync-aws/tldraw-client/scale-drill.mjs`

**Interfaces:**
- Consumes: the chart from Task 10.
- Produces: `make deploy-aws && make verify-aws` passing against `http://localhost:8081`, the GCP demo untouched on `gcp.localhost:8080`, and `make drill-aws` beating the recorded baseline below.

### The baseline this task must beat

Measured on the Redis implementation before any of this work, with `scale-drill.mjs --rooms 24 --steps 3,4,3,2`. The drill holds real `TLSyncClient` sessions, walks the replica count, and opens a fresh session per Room at each step to force re-resolution. (A raw WebSocket will not do: `TLSocketRoom` prunes a session that has not sent a connect message within 10s, so bare sockets die before the scale event finishes and every number after that is fiction.)

| Step | Move | Rooms moved | Sessions disrupted | Recovery p50 |
|---|---|---|---|---|
| 1 | 2→3 up | 11/24 (46%) | 11 | 506ms |
| 2 | 3→4 up | 2/24 (8%) | 2 | 507ms |
| 3 | 4→3 down | 2/24 (8%) | 2 | 766ms |
| 4 | 3→2 down | 11/24 (46%) | 11 | 781ms |

Totals: **26 room moves, 26 session disruptions**, 0 never recovered, 0/120 failed connects. Rooms moved equalled sessions disrupted in every single step — each Room the hash ring drags costs exactly one client a reconnect. The path is mirrored (11, 2, 2, 11) because returning to N replicas restores the ring, so a scale up/down cycle pays twice.

**Acceptance criteria:**

- **Steps 1 and 2 (scale up) must be 0 moved and 0 disrupted.** Existing Rooms keep their owner; only new Rooms land on new workers. Anything above zero means routing is not resolving an authoritative record, and this task is not done.
- **Steps 3 and 4 (scale down) measure nothing on their own in this shape, and that is a trap.** Every Room is claimed at the start while only 2 workers exist, so scaling up hands the new workers nothing, and Kubernetes then terminates those same newest-and-empty workers on the way back down. The result is a truthful 0 that has not exercised the drain path at all. To actually test draining, claim the Rooms at 4 replicas and scale *down*: `node scale-drill.mjs --rooms 24 --steps 3,2` starting from 4. Ownership then moves only for Rooms the dying worker really held.
- **No connect may fail, and no session may fail to recover.**
- **Connect p50 will rise** from the baseline's 20–40ms: one bucket GET per connect replaces an nginx hash. Record it. There is no target, but a p50 above ~150ms is worth investigating before calling this done.

The honest headline is *scale-up became free*, not *scaling became free*.

**ingress-nginx stays.** It cannot go: the GCP demo still hashes `$uri` on it for Room Affinity, and Grafana is served through it at `grafana.localhost`. Only AWS traffic leaves it.

- [ ] **Step 1: Add the Envoy port mapping**

In `local-cluster/k3d-config.yaml`, add to `ports`:

```yaml
  # host 8081 -> Envoy Service for the AWS demo. It needs a port of its own
  # rather than :80, which k3s svclb has already bound for ingress-nginx.
  # nginx still serves gcp.localhost and grafana.localhost on 8080.
  - port: 8081:8081
    nodeFilters:
      - loadbalancer
```

- [ ] **Step 2: Recreate the cluster and redeploy**

The port mapping is fixed at cluster creation, so this needs a rebuild:

```bash
cd local-cluster
make cluster-down && make cluster && make monitoring
make deploy-aws && make deploy-gcp
```

- [ ] **Step 3: Point the AWS verify script at Envoy**

In `local-cluster/scripts/verify-aws.sh`, change the final line:

```bash
node verify-sync.mjs http://localhost:8081
```

Also update the comment at the top of the file — it says "runs the demo's own verify-sync.mjs against the ingress", which is no longer where AWS traffic goes:

```bash
# E2E verify for the AWS demo running in k3d: runs the demo's own
# verify-sync.mjs against Envoy on :8081, with LocalStack port-forwarded so the
# script's direct S3 checks (snapshot landed, cold-room restore) work.
# AWS does not go through ingress-nginx any more; GCP still does.
```

- [ ] **Step 4: Verify both demos**

```bash
cd local-cluster
make verify-aws     # -> http://localhost:8081, through Envoy
make verify-gcp     # -> http://gcp.localhost:8080, through nginx, unchanged
```

Expected: both pass. If `verify-gcp` broke, the nginx changes went too far — the GCP Ingress and its `upstream-hash-by` annotation must be untouched.

- [ ] **Step 5: Fix the dashboard's 5xx panel**

In `local-cluster/dashboards/tldraw-scaling-dashboard.yaml`, the panel titled `Ingress 5xx rate by host` has one target. Left alone it silently goes half-blind: still drawing GCP, simply omitting AWS. Retitle it and add a second target:

```json
          "id": 6, "type": "timeseries", "title": "5xx rate by tier",
          "targets": [
            { "expr": "sum by (host) (rate(nginx_ingress_controller_requests{status=~\"5..\"}[1m]))",
              "legendFormat": "nginx {{host}}" },
            { "expr": "sum(rate(envoy_http_downstream_rq_xx{envoy_response_code_class=\"5\"}[1m]))",
              "legendFormat": "envoy (aws)" }
          ],
```

- [ ] **Step 6: Replace the handover panels with reclaim panels**

Still in the dashboard, the `tldraw_handover_*` panels now refer to metrics nobody emits. Replace their expressions:

| Old expression | New expression | New title |
|---|---|---|
| `rate(tldraw_handover_requests_total[1m])` | `rate(tldraw_room_reclaims_total[1m])` | Room reclaim rate |
| `rate(tldraw_handover_timeouts_total[1m])` | `rate(tldraw_room_ownership_lost_total[1m])` | Ownership lost rate |
| `histogram_quantile(0.95, rate(tldraw_handover_duration_seconds_bucket[5m]))` | `histogram_quantile(0.95, rate(tldraw_router_resolve_duration_seconds_bucket[5m]))` | Resolve duration p95 |

Add one new panel, which is the whole point of the change:

```json
{ "id": 20, "type": "timeseries", "title": "Live members",
  "targets": [{ "expr": "max(tldraw_members_live)", "legendFormat": "workers" }] }
```

- [ ] **Step 7: Add a `drill-aws` target**

In `local-cluster/Makefile`, add `drill-aws` to `.PHONY` and append:

```makefile
drill-aws: ## Scale drill for the AWS demo: 2->3->4->3->2, measuring what clients feel
	cd ../tldraw-sync-aws/tldraw-client && [ -d node_modules ] || npm install --no-audit --no-fund
	cd ../tldraw-sync-aws/tldraw-client && node scale-drill.mjs \
		--url http://localhost:8081 --rooms 24 --steps 3,4,3,2 \
		--json ../../local-cluster/drill-latest.json
```

Add `local-cluster/drill-latest.json` to `.gitignore` — it is a measurement, not a source file.

- [ ] **Step 8: Run the drill and compare against the baseline**

```bash
cd local-cluster && make dashboard && make drill-aws
```

The drill auto-detects the ownership store, so no flag is needed: it finds the `owners/` prefix in the bucket and reads records instead of Redis keys. **Confirm the header says `owner probe  bucket`** — if it says `redis`, the AWS demo is still running the old implementation and every number below is meaningless.

Check the result against **The baseline this task must beat** above. The two scale-up rows are the gate: `moved 0/24`, `disrupted 0/24`. If either is non-zero, stop and diagnose rather than proceeding — the likely causes are the router serving a stale member list, or `resolve()` falling through to allocation because the recorded owner is missing from `live()`.

- [ ] **Step 9: Run the kill drill**

Scaling is no longer where the interesting failure lives; a dead owner is.

```bash
kubectl --context k3d-tldraw-local -n tldraw-aws delete pod <an-app-pod> --grace-period=0 --force
```

Expected: `tldraw_members_live` dips and recovers, `tldraw_room_reclaims_total` rises for the Rooms that pod held, and clients reconnect within roughly `MEMBER_TTL` (8s) plus one poll. `--grace-period=0 --force` skips the drain deliberately: this is the crash path, not the drain path.

- [ ] **Step 10: Update the local-cluster README**

In `local-cluster/README.md`, change the AWS URL in the Quickstart, the `*.localhost` paragraph, and the handover drill section. The demo is now reached at `http://localhost:8081`; `aws.localhost` no longer resolves to anything. Rewrite the drill (currently "scale up and hope your Room rehashes") as "kill a worker and watch its Rooms get reclaimed", and say plainly that scaling up is now expected to change nothing.

- [ ] **Step 11: Commit**

```bash
git add local-cluster/ .gitignore
git commit -m "feat(local-cluster): route the AWS demo through Envoy on 8081"
```

---

### Task 12: Documentation

**Files:**
- Modify: `CONTEXT.md`, `tldraw-sync-aws/README.md`, `README.md`
- Rewrite: `tldraw-sync-aws/docs/coordinated-handover.md`
- Modify: `docs/adr/0005-room-ownership-in-the-bucket-routed-by-envoy.md` (status line), `docs/superpowers/specs/2026-08-19-bucket-registry-room-routing-design.md` (status line)

- [ ] **Step 1: Amend `CONTEXT.md`, and say which demo it describes**

Two definitions are now wrong for AWS and still right for GCP, so the vocabulary has to name the demo:

- **Room Lock** — currently "held for a fixed lease and renewed while owned". True for GCP. For AWS, ownership is a bucket record with no lease and no renewal; liveness comes from worker membership instead.
- **Room Affinity** — currently a hint that "reshuffles whenever we scale". True for GCP. For AWS it is a guarantee resolved from an authoritative record.
- The example dialogue turns on "affinity is a hint, not a guarantee — the hash ring reshuffles whenever we scale". Keep it, labelled as the GCP behaviour, and add the AWS answer beside it.

- [ ] **Step 2: Rewrite `tldraw-sync-aws/docs/coordinated-handover.md`**

The protocol it documents no longer exists. Replace it with a much shorter drain-and-reclaim doc covering: the drain order and why step 2 exists; what happens on a crash (heartbeat stops, evicted in ≤8s, reclaimed by CAS, Snapshot reloaded, up to 10s of edits lost — the same as before); and the `1013` close. Rename the file to `docs/drain-and-reclaim.md` and fix inbound links.

Run: `grep -rn "coordinated-handover" --include="*.md" .` and update every hit.

- [ ] **Step 3: Update `tldraw-sync-aws/README.md`**

Remove the ElastiCache row from the deployment table and every `REDIS_URL` mention. Add the router to the architecture description, and document the two modes. Replace the local-dev instructions with `docker compose up -d --scale app=3`.

- [ ] **Step 4: Update the root `README.md`**

The AWS demo is no longer "the GCP demo with `s3Storage.ts` swapped in". Say what diverged and point at ADR 0005.

- [ ] **Step 5: Flip both status lines**

In the design doc and ADR 0005, replace `Status: design, not yet implemented` with a note that AWS is implemented, and that EKS, GKE, GCE and Cloud Run remain to be deployed and verified.

- [ ] **Step 6: Final full verification**

```bash
cd tldraw-sync-aws && yarn install --immutable && yarn typecheck && yarn build && yarn test
grep -rn "redis\|Redis\|REDIS" src/ test/ chart/ package.json   # expect no output
cd ../local-cluster && make verify-aws && make verify-gcp && make drill-aws
```

(`yarn format:check` is deliberately absent: it fails on the Helm templates whatever you do, and CI does not run it.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: replace handover docs with drain-and-reclaim, amend CONTEXT vocabulary"
```

---

## Self-review

Checked against the design doc:

**Covered:** membership registry (T1, T3) · ownership record and CAS semantics (T1) · the router and `resolve()` (T2, T7, T8) · reachability as a routing preference only (T7) · the worker's claim/serve/refuse path and both re-read rules (T4) · `409` + `x-room-owner` and the mode B retry (T4, T6, T7) · drain order (T6) · everything under "What gets deleted" (T4, T5, T9, T10) · everything under "What gets added" (T1–T8) · one package, two entrypoints (T7, T9) · observability (T5, T11) · Docker mode B (T9) · EKS-shaped mode A chart (T10) · local-cluster (T11) · the CONTEXT.md and handover-doc consequences (T12).

**Deliberately not covered, and why:** GKE, GCE and Cloud Run deployment. The design doc lists Cloud Run as wholly unverified — `--no-cpu-throttling` keeping heartbeats alive on an idle worker, and ID-token-authenticated WebSocket splicing, have both never been tried — and GCE needs a firewall rule and a Terraform-rendered instance group. Each needs its own verification, so they belong in a follow-up plan rather than as unverifiable steps here. The chart built in Task 10 is EKS-shaped, so that target is a values change plus IRSA rather than new code.

**Two things this plan settles that the design doc left open:**

1. **`listMembers()` reads `LastModified` from `LIST` and never fetches a member body.** That keeps the poll at one request and removes worker clock skew, but it means the `rooms` count is not available to the allocator. Task 2 therefore implements **pure rendezvous hashing**, which is one branch of the design doc's remaining open question about load-aware allocation. `rooms` is still written to the body, so reversing this costs a body fetch, not a redesign.
2. **The two JSON examples in the design doc disagree about whether the Owner Identity carries a scheme** (`http://10.0.1.7:3001` under `members/`, `10.0.1.7:3001` under `owners/`). The scheme-ful form wins everywhere, and `hostPort()` in Task 8 is the single place it is reduced for Envoy. The design doc's `owners/` example should be corrected to match.

---

## Execution

Task order is the dependency order, with one exception: **Task 5 (metrics) must land before Task 4 (roomManager)**, since `roomManager.ts` imports the new counters. Either run 5 before 4, or stub the counters in 4 and fill them in at 5.

Tasks 1, 2 and 5 are independent of each other and can run in parallel. Tasks 9, 10 and 11 are each gated on all the code tasks.

---

### Task 13: Push the drain, instead of sleeping through it

**Files:**
- Modify: `tldraw-sync-aws/src/router/proxy.ts`, `tldraw-sync-aws/src/router/extAuthz.ts`, `tldraw-sync-aws/src/router/memberCache.ts`, `tldraw-sync-aws/src/index.ts`, `tldraw-sync-aws/chart/templates/deployment.yaml`
- Test: `tldraw-sync-aws/test/router.test.ts` (extend)

**The problem.** Drain sleeps `2 × MEMBER_POLL_INTERVAL` — about 4s of dead time — purely so every router notices the worker leaving. On a ten-pod rolling update that is ~40s of pure waiting per deploy.

**The rule that makes this safe.** Push is safe in the *removal* direction and unsafe in the *addition* direction:

- **"I am leaving"** — a router acting on it drops a worker slightly early, which is conservative. A router that misses it falls back to the poll and behaves exactly as today. No divergence.
- **"I exist"** — a router acting on it now disagrees with the store. Two routers with different views will reallocate a Room whose owner is alive, which is the split-brain the authoritative record exists to prevent.

So **the store decides and push only accelerates.** A worker may shorten its own removal; it may never assert existence that a router cannot otherwise confirm. Do not be tempted to extend this to registration — the fact that it would "obviously work the same way" is exactly the trap.

- [ ] **Step 1: Write the failing test**

Append to `tldraw-sync-aws/test/router.test.ts`:

```ts
describe("drain push", () => {
  it("drops a worker from routing as soon as it says it is leaving", async () => {
    listMembers.mockResolvedValueOnce([
      { addr: A, updatedAt: Date.now() },
      { addr: B, updatedAt: Date.now() },
    ])
    const cache = new MemberCache()
    await cache.refresh()

    cache.markDraining(A)

    expect(cache.routable().map((m) => m.addr)).toEqual([B])
  })

  it("keeps a draining worker out of the live set too, unlike unreachability", async () => {
    listMembers.mockResolvedValueOnce([{ addr: A, updatedAt: Date.now() }])
    const cache = new MemberCache()
    await cache.refresh()
    cache.markDraining(A)
    // Draining is the worker's own statement about itself, so it is evidence
    // about ownership in a way a failed dial is not.
    expect(cache.live()).toEqual([])
  })

  it("forgets draining once the worker reappears in a poll", async () => {
    listMembers.mockResolvedValue([{ addr: A, updatedAt: Date.now() }])
    const cache = new MemberCache()
    await cache.refresh()
    cache.markDraining(A)
    expect(cache.live()).toEqual([])
    await cache.refresh()
    expect(cache.live().map((m) => m.addr)).toEqual([A])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd tldraw-sync-aws && yarn vitest run test/router.test.ts`
Expected: FAIL — `cache.markDraining is not a function`

- [ ] **Step 3: Add `markDraining` to `MemberCache`**

In `src/router/memberCache.ts`, add alongside `unreachableUntil`:

```ts
  private draining = new Set<string>()

  /**
   * The worker told us it is going away. Unlike unreachability, this IS
   * evidence about ownership: the worker is speaking about itself, and it is
   * about to vacate its records anyway. Removing it early is conservative --
   * the worst case is that we allocate new Rooms elsewhere slightly sooner.
   */
  markDraining(addr: string): void {
    this.draining.add(addr)
  }
```

Filter it out of `live()`, and clear it in `refresh()` when the worker is still present, next to the `unreachableUntil.delete` line:

```ts
  live(): LiveMember[] {
    return liveMembers(this.members, Date.now())
      .filter((member) => !this.draining.has(member.addr))
      .map(({ addr }) => ({ addr }))
  }
```

```ts
      for (const member of members) {
        this.unreachableUntil.delete(member.addr)
        // A worker that deregistered will not come back in a poll, so this only
        // fires if it changed its mind -- a cancelled drain.
        this.draining.delete(member.addr)
      }
```

- [ ] **Step 4: Accept the push on both transports**

The endpoint must be **removal-only**: it takes an address and marks it draining. It never adds. Add to `startProxy` in `src/router/proxy.ts`, and the same block to `startExtAuthz` in `src/router/extAuthz.ts`, before their other route handling:

```ts
    // Removal-only, by design. A worker may shorten its own removal; nothing
    // here may add a member, because two routers disagreeing about who exists
    // is what reallocates a live worker's Rooms out from under it.
    if (request.method === "POST" && request.url === "/internal/draining") {
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        try {
          const { addr } = JSON.parse(body) as { addr?: string }
          if (addr) cache.markDraining(addr)
        } catch {
          // A malformed push is ignored: the poll is the fallback.
        }
        response.statusCode = 204
        response.end()
      })
      return
    }
```

- [ ] **Step 5: Push on SIGTERM, and keep the sleep as a fallback**

In `src/index.ts`, add above `handleShutdown`:

```ts
/**
 * Tell the routers we are going before they could work it out from the poll.
 * Best-effort by design: a router that misses this falls back to noticing our
 * deleted membership record, which is exactly today's behaviour.
 */
async function pushDraining(): Promise<void> {
  const url = process.env.ROUTER_INTERNAL_URL
  if (!url) return
  try {
    await fetch(`${url}/internal/draining`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addr: roomManager.addr }),
      signal: AbortSignal.timeout(1000),
    })
  } catch {
    // Fallback is the poll. Never block a drain on this.
  }
}
```

Then in `handleShutdown`, between deregistering and the wait:

```ts
  await roomManager.membership.stop()
  await pushDraining()

  // Still sleep, but only long enough for routers that missed the push. The
  // push is an optimisation; correctness still rests on the poll.
  await new Promise((resolve) => setTimeout(resolve, 2 * MEMBER_POLL_INTERVAL_MS))
```

**Note the sleep stays.** A Service address reaches one router, not all of them, so the push is never a guarantee — it just means most routers act immediately and the sleep covers the rest. Removing the sleep would make correctness depend on every router having received a best-effort HTTP call.

- [ ] **Step 6: Wire the router URL into the chart**

In `chart/templates/deployment.yaml`, add to the app container's env:

```yaml
            - name: ROUTER_INTERNAL_URL
              value: "http://{{ .Release.Name }}-router:{{ .Values.router.port }}"
```

- [ ] **Step 7: Verify and commit**

Run: `cd tldraw-sync-aws && yarn vitest run test/router.test.ts && yarn typecheck && yarn build`
Expected: PASS

```bash
git add tldraw-sync-aws/src tldraw-sync-aws/test tldraw-sync-aws/chart
git commit -m "feat(aws): let a draining worker push its own removal to routers"
```

---

### Task 14: A Redis-backed registry, measured against the bucket

**Files:**
- Create: `tldraw-sync-aws/src/registryRedis.ts`, `tldraw-sync-aws/test/registryRedis.test.ts`, `tldraw-sync-aws/test/helpers/fakeRedis.ts`
- Rename: `tldraw-sync-aws/src/registry.ts` → `tldraw-sync-aws/src/registryS3.ts`
- Create: `tldraw-sync-aws/src/registry.ts` (timings, types, backend selection)

**Why.** The measured win — 26 Room moves and 26 disruptions down to 0 — comes entirely from *routing resolving an authoritative record*, not from where that record lives. Those are separable decisions and the design bundled them. Redis is a legitimate place to keep the record, and on three axes it is the better one: reads are sub-millisecond rather than ~10–40ms, cost is flat rather than ~$0.29/hr at 1,000 Rooms, and its CAS primitives (Lua, `HSET`) are stronger than S3 conditional PUT. Millisecond TTLs also remove the `LastModified` second-granularity tax that costs the bucket design ~1s of its 8s margin.

**What it gives up, and the mitigation.** The bucket's best property is that liveness and persistence share a channel: "still heartbeating" means "still able to persist". Split them and a worker partitioned from S3 but reaching Redis keeps its lock, keeps accepting edits, and can never save them — unbounded loss instead of the bucket's ~10s. **Task 14 must therefore also add a persistence health check**: after N consecutive `persistRoomSnapshot` failures the worker gives up its Rooms, releases them and closes Sessions `1013`. That tests the capability directly rather than inferring it from a shared channel, and is arguably better than the property it replaces.

**The router tier does not change.** `resolve.ts` is pure; `memberCache.ts`, `proxy.ts` and `extAuthz.ts` only call functions from `registry.ts`. Keep that surface byte-identical and this is a drop-in.

- [ ] **Step 1: Split the backend out**

```bash
cd tldraw-sync-aws
git mv src/registry.ts src/registryS3.ts
```

Delete the timing constants from `registryS3.ts` (they move to `registry.ts`) and import them instead:

```ts
import { MEMBER_TTL_MS } from "./registry.js"
```

Leave everything else in that file untouched.

- [ ] **Step 2: Write the new `registry.ts`**

```ts
// The public registry surface. Timings and types live here; the storage
// backend is chosen once, at import.
//
// Both backends answer the same three questions -- who owns this Room, which
// workers exist, and how do I change either -- so the router tier never learns
// which one is in use. resolve.ts stays pure and the transports stay identical.
const ms = (name: string, fallback: number) => Number(process.env[name] ?? fallback)

export const HEARTBEAT_INTERVAL_MS = ms("HEARTBEAT_INTERVAL_MS", 2_000)
export const MEMBER_POLL_INTERVAL_MS = ms("MEMBER_POLL_INTERVAL_MS", 2_000)
export const MEMBER_TTL_MS = ms("MEMBER_TTL_MS", 8_000)
export const OWNERSHIP_RECHECK_INTERVAL_MS = ms("OWNERSHIP_RECHECK_INTERVAL_MS", 5_000)

export interface OwnerRecord {
  owner: string | null
  /** Opaque to callers: an S3 ETag, or a Redis version counter. */
  etag: string
}

export interface Member {
  addr: string
  updatedAt: number
}

export interface RegistryBackend {
  readOwner(roomId: string): Promise<OwnerRecord | null>
  casOwner(roomId: string, expect: string | null, owner: string | null): Promise<"ok" | "conflict">
  putMember(addr: string, rooms: number): Promise<void>
  listMembers(): Promise<Member[]>
  deleteMember(addr: string): Promise<void>
}

// Dynamic so the unused backend never initialises -- registryS3 throws at
// import when S3_BUCKET_NAME is unset, and registryRedis dials on import.
const backend: RegistryBackend =
  process.env.REGISTRY_BACKEND === "redis"
    ? await import("./registryRedis.js")
    : await import("./registryS3.js")

export const readOwner = backend.readOwner
export const casOwner = backend.casOwner
export const putMember = backend.putMember
export const listMembers = backend.listMembers
export const deleteMember = backend.deleteMember

export function liveMembers(members: Member[], now: number): Member[] {
  return members.filter((member) => now - member.updatedAt < MEMBER_TTL_MS)
}
```

- [ ] **Step 3: Write the Redis backend**

See `src/registryRedis.ts` in the implementation. Three properties it must have:

1. **Ownership CAS is a Lua script over a hash**, `owners:{roomId}` with `owner` and `version` fields. `version` is the ETag: `expect: null` requires the key absent; any other value must equal the current version. Redis executes Lua atomically, so this is a genuine compare-and-set with no window.
2. **Membership is a sorted set scored by Redis's own clock**, read with `TIME` inside the same script. Worker clocks never have to agree with each other, and precision is milliseconds rather than the whole seconds S3's `LastModified` reports.
3. **Scores are translated into the caller's clock before returning** — `updatedAt = Date.now() - (serverNow - score)` — so `liveMembers(members, Date.now())` keeps working unchanged for both backends.

- [ ] **Step 4: Add the persistence health check**

This is not optional; it is what pays for splitting liveness from persistence. In `src/roomManager.ts`:

```ts
  private consecutiveSaveFailures = 0
```

`persistRoomSnapshot` currently swallows its own errors, so have it report instead — change `saveRoom` to count outcomes and give up the Rooms when the count crosses the threshold, releasing ownership and closing Sessions `1013`. A worker that cannot persist has no business owning a Room, whichever store says it does.

- [ ] **Step 5: Deploy Redis and run the identical drill**

Re-add a minimal `chart/templates/redis.yaml` gated on `redis.enabled` (default `false`), set `REGISTRY_BACKEND=redis`, and run **the same drill against the same cluster**:

```bash
cd local-cluster
make deploy-aws
make drill-aws
```

Compare three numbers against the bucket run: Rooms moved on scale up (must stay **0**), connect p50 (expect a fall from ~45ms toward ~25ms), and recovery p50 (expect no change, ~530ms).

- [ ] **Step 6: Record the comparison and choose**

Put the two drill results side by side in ADR 0005 and pick a backend. The decision is not "which is faster" — both hit 0 on the metric that matters — but whether the shared-liveness-and-persistence channel is worth ~$0.25/hr and ~20ms per connect. Write down whichever way it goes, because the next reader will ask.
