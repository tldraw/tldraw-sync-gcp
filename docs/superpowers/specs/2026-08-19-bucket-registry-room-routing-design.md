# Bucket-backed worker registry and room-routing proxy

**TL;DR** — Redis goes away, and so does the proxy tier. The bucket becomes the single source of truth for two things: which worker owns a Room (`owners/{roomId}`) and which workers exist (`members/{addr}`). Ownership is written with conditional PUT — no leases on Rooms, no deletes, no Lua. A single ~250-line Node service, the **room-router**, answers one question: which worker owns this Room? Envoy **replaces ingress-nginx** and asks that question via `ext_authz` on EKS, GKE and GCE; on Cloud Run and Docker the router proxies the WebSocket itself by splicing sockets. Both are thin shells over the same pure `resolve()`. Nothing performs service discovery, and no code branches on which cloud it is running on.

> Status: **implemented for AWS** (`tldraw-sync-aws/`) and verified on `local-cluster` — see the plan at [`../plans/2026-08-21-bucket-registry-room-routing.md`](../plans/2026-08-21-bucket-registry-room-routing.md). EKS, GKE, GCE and Cloud Run remain to be deployed and verified. The GCP demo is untouched by this change.
>
> Co-authored by Claude (Opus 5) with Niall Drievers.

---

## Vocabulary note

This doc says **sync worker** for what [`CONTEXT.md`](../../../CONTEXT.md) calls a *server instance* — the process that holds a `TLSocketRoom` in memory. "Pod" appears only in the Kubernetes sections; on GCE there are no pods. Everything else uses [`CONTEXT.md`](../../../CONTEXT.md) terms: **Room**, **Session**, **Room Owner**, **Snapshot**, **Room Affinity**.

Two of those definitions change meaning here, and [`CONTEXT.md`](../../../CONTEXT.md) will need updating:

- **Room Lock** is defined as "held for a fixed lease and renewed while owned". There is no lease and no renewal on Rooms.
- **Room Affinity** is described as a hint that "reshuffles whenever we scale". It becomes a guarantee resolved from an authoritative record.

---

## The problem this solves

Today's routing is consistent hashing on the request path (`nginx.ingress.kubernetes.io/upstream-hash-by: "$uri"`). The hash ring reshuffles on every scale event, so Sessions of one Room routinely land on a worker that does not own it. The entire two-phase coordinated handover protocol — Redis pub/sub, `handover-lock-released:*`, `handover-ready:*`, the `1013` close dance — exists to survive that.

If routing instead resolves an *authoritative* record, a live worker never receives a connection for a Room another live worker owns. Ownership moves only when the previous owner is gone. That deletes the handover protocol outright, and Redis with it.

---

## Architecture

```
                    ┌──────────────── bucket ────────────────┐
                    │  members/{addr}    owners/{roomId}     │
                    └────▲───────────────────▲───────────────┘
          heartbeat ─────┘                   │ read / CAS
                         │                   │
   ┌─────────────────────┴┐          ┌───────┴──────────────┐
   │   sync workers       │          │   room-router        │
   │   (N replicas)       │          │   resolve(roomId)    │
   └──────────▲───────────┘          └───────▲──────────────┘
              │                              │
              │  A: ext_authz  ──────────────┘ (EKS / GKE / GCE)
              │     ┌──────────────────────────┐
              └─────│  Envoy  (replaces nginx) │◀── cloud LB ◀── clients
                    └──────────────────────────┘

              │  B: proxy mode (Cloud Run / Docker) — router splices directly
              └──────────────────  room-router  ◀── cloud LB ◀── clients
```

Two processes, one of them new. The router's *decision* is identical in both shells; only the transport differs.

### 1. The membership registry — `members/{addr}`

Each worker registers itself and refreshes on a heartbeat:

```json
{ "addr": "http://10.0.1.7:3001", "startedAt": "2026-08-19T09:58:02.104Z",
  "updatedAt": "2026-08-19T10:04:11.812Z", "rooms": 14 }
```

`addr` is a **dialable endpoint, not an IP** — `http://10.0.1.7:3001` on EKS, GKE, GCE and Docker; `https://sync-3-xyz.run.app` on Cloud Run, where individual instances are not addressable at all. The router dials whatever it finds. This is the only concession the design makes to any runtime, and it is a widening rather than a branch: no code tests which cloud it is on.

- **Write:** unconditional PUT every `HEARTBEAT_INTERVAL` (default 2s). Unconditional is correct — a worker is the only writer of its own key.
- **Read:** the router `LIST`s `members/` on a 2s poll and caches. Entries older than `MEMBER_TTL` (default 8s) are dead.
- **Deregister:** DELETE on drain. Unconditional delete is safe here, unlike `owners/` — nobody else writes this key.

Cost is per-*worker*, not per-Room, which is why the lease rejected for ownership is fine here: 10 workers at 2s is 5 PUT/s. The equivalent per-Room lease at 1,000 Rooms would be 200 PUT/s at a *slower* 5s renewal — forty times more, and growing with Rooms rather than workers.

**Liveness is the heartbeat**, not an active health check. A hung worker stops heartbeating and is evicted in ≤8s.

The obvious alternative is to have the router *ping* the workers instead, and it does detect faster — a failed dial is immediate where a TTL has to elapse. It is rejected for a reason that is not cost: **the heartbeat measures the exact capability that ownership requires, and a ping measures a different one.** A worker is entitled to own a Room because it can persist that Room's Snapshot, and the heartbeat is a PUT to the same bucket, over the same credentials, along the same path as that Snapshot write. "Still heartbeating" and "still able to persist" are therefore one signal with one failure domain. A ping measures *reachable from the router*, which splits that domain in two:

- **Worker healthy, router cannot reach it.** Evicted, Rooms reallocated — while it still holds Sessions reached by another path and can still write to the bucket. Two writers, both able to persist. Compare the bucket-partition row in [Failure modes](#failure-modes): that case is only safe because the worker that stops heartbeating is the same worker that has stopped being able to clobber anything.
- **Worker reachable, partitioned from the bucket.** Passes every ping, stays in the live set indefinitely, and silently loses every edit it accepts.

A ping also answers the wrong question. It says whether an address responds, not **which addresses exist** — and that is what `members/` is primarily for. Keeping the roster in the bucket but dropping the TTL does not survive a crash: nothing deletes the record, so tombstones accumulate and every router pings every address that has ever existed. Having the router reap after N failed pings fixes the litter by turning the first failure mode above into a destructive write.

It would also break the self-check in [the worker](#4-the-worker), which works only because a worker reads the same signal the router reads and independently reaches the same verdict about itself. Under pings, only the router holds the verdict, so it would have to tell the worker — a cross-node signalling channel, which is the thing this design deleted.

The request-count difference is real — `N workers × M routers` per interval against `O(N)` total — but it is the least of the reasons, and on price it argues the other way: the pings would be free intra-cluster HTTP, while the heartbeat is billed S3 PUTs.

**`MEMBER_TTL` is a false-positive threshold, not just a detection latency.** The expensive case is not a dead worker lingering in the live set — it is a *live* worker evicted from it, because its Rooms are then reallocated while it still holds Sessions. So the TTL is not "lower is safer": lowering it buys faster crash recovery by making spurious eviction more likely. **2s / 8s is four missed beats**, chosen over a tighter 2s / 6s so that a 2–3 second event-loop stall — a large Snapshot serialisation, a bucket latency spike — does not evict a worker that is fine, while still reclaiming inside 10s. Ten seconds is the number that matters for the drill this design is demonstrated by: "kill a worker and watch its Rooms get reclaimed" has to look like recovery rather than a hang. Cost is not the deciding factor at either setting — moving the heartbeat from 5s to 2s takes ten workers from 2 PUT/s to 5 PUT/s, roughly $0.04/hr to $0.09/hr.

**`LastModified` is second-granular, so the TTL silently loses up to a second.** S3 truncates the timestamp `LIST` returns down to the second, and this was measured against LocalStack 4.14.0 rather than assumed: three writes inside one second all reported the same `LastModified`, each up to 999ms *older* than the write actually was. Liveness is therefore always read up to 1s more stale than reality, so an 8s TTL is really about 7s of margin — 3.5 missed beats rather than 4. The choice still holds, and this is another argument against the tighter setting: at 2s/6s the same truncation leaves ~5s, or 2.5 beats, which is below the three the design would claim.

**Clean drains do not wait out the TTL at all.** A draining worker `DELETE`s its member record, so routers drop it at the next 2s poll — see [Drain order](#drain-order). `MEMBER_TTL` governs only crash and hang detection, which is the rarer path. Tuning it trades against spurious eviction, not against deploy speed.

`rooms` is no longer advisory: allocation weighs members by `1/(1 + rooms)` via weighted rendezvous, and the count rides in the member key (`members/{addr},{rooms}`) so the `LIST` still carries everything — see ADR 0005's amendment of 2026-08-21.

### 2. The ownership record — `owners/{roomId}`

```json
{ "owner": "http://10.0.1.7:3001", "updatedAt": "2026-08-19T10:04:11.812Z" }
```

Every transition is the same primitive — a conditional PUT:

| Transition | Precondition | Written by |
|---|---|---|
| **claim** (no record) | `If-None-Match: *` | router (or worker, when there is no router) |
| **reallocate** (owner not in the live set) | `If-Match: <etag>` | router |
| **vacate** (drain) | `If-Match: <etag>`, `owner: null` | worker |

`412 Precondition Failed` means another writer won: re-read and use their answer. `owner: null` and "no record" are the same thing to the router.

No TTL. No renewal. No delete. **Verified against LocalStack 4.14.0** (the version the repo pins):

| Operation | Result |
|---|---|
| `PUT If-None-Match: *` on absent key | `200` ✅ |
| `PUT If-None-Match: *` on existing key | `412` ✅ |
| `PUT If-Match: <wrong etag>` | `412` ✅ |
| `PUT If-Match: <correct etag>` | `200` ✅ |
| `DELETE If-Match: <etag>` | **`501 Not Implemented`** ❌ |

That last row is why release is a CAS-to-`null` rather than a delete. Real S3 has supported conditional delete since Nov 2024; LocalStack has not implemented it. And an *unconditional* delete here is a genuine split-brain — worker A drains and deletes a record already reallocated to B, so the next connect allocates C while B is still serving. CAS-to-vacant needs one primitive, has no such race, and behaves identically locally and in production.

Records accumulate one small object per Room ever created; a bucket lifecycle rule on `owners/` sweeps them. Stale vacant records are harmless — they are just a CAS starting point.

**Storage sits behind one interface**, so GCS is a drop-in:

```ts
interface Registry {
  readOwner(roomId: string): Promise<{ owner: string | null; etag: string } | null>
  casOwner(roomId: string, expect: string | null, owner: string | null): Promise<"ok" | "conflict">
  putMember(addr: string, body: Member): Promise<void>
  listMembers(): Promise<Member[]>
  deleteMember(addr: string): Promise<void>
}
```

`expect: null` means "must not exist" (`If-None-Match: *`). Both clouds satisfy this — see [GKE](#gke) for the GCS mapping.

### 3. The room-router

One stateless Node service. Its core is a **pure function** — `resolve(roomId, record, liveMembers) → addr` — wrapped in one of two transports. For `/api/connect/:roomId`:

1. parse `roomId` from the path
2. `readOwner()`
3. if `owner` is non-null **and** present in the live member set → use it
4. otherwise pick from the live set — **rendezvous hash** of `roomId`, tie-broken by `rooms` count — and `casOwner()` it in; on `conflict`, re-read and use the winner
Then, depending on the transport:

**Mode A — `ext_authz` (EKS, GKE, GCE).** Respond `200` with `x-envoy-original-dst-host: <addr>`. Envoy does the proxying. The router holds **zero sockets** for the session; its cost is O(connects per second), not O(concurrent connections).

**Mode B — proxy (Cloud Run, Docker).** Open a socket to the owner, replay the upgrade request verbatim, then splice:

```js
clientSock.pipe(upstream); upstream.pipe(clientSock)
```

**In neither mode does the router parse a WebSocket frame.** In mode B, after the `101` it is byte splicing in Node's stream path, so proxying cost is per-chunk, not per-edit.

Plain HTTP routes (`/api/uploads`, `/api/unfurl`, `/api/health`, `/metrics`) need no affinity and resolve to any live member, round-robin, with no bucket read. Routing them through the same path is what lets Envoy hold exactly one cluster and perform **no service discovery at all**.

**Reachability informs routing, never ownership.** In mode B the router dials the owner itself, so a failed dial is directly observable. When it happens the router stops offering that worker *new* connections — `503` for a Room it owns, skipped when allocating an unclaimed one — but it does **not** drop it from the live set and does **not** reallocate its Rooms. Refusing to route is recoverable: the client retries and the record is untouched. Reallocating ownership is destructive, and a failed dial is not evidence that the owner has stopped being able to persist — only that this router could not reach it just now. In mode A the router never dials at all; Envoy does, and an unreachable `ORIGINAL_DST` upstream already returns `503` on its own, so mode A gets the same behaviour for free. In both, this is the whole of what reachability may safely conclude.

No owner cache: one bucket GET per connect is always correct and costs ~$0.0004/1000. A single-flight map keyed on `roomId` collapses reconnect storms into one read. Only the member list is cached.

### 4. The worker

`roomManager.ts` loses Redis entirely — four clients, two Lua scripts, all pub/sub, the two-phase protocol. What replaces it:

- **Heartbeat** `members/{addr}` every 2s. `addr` comes from `ADVERTISE_ADDR`, defaulting to the primary non-loopback IPv4 plus `PORT`. This address is the worker's **Owner Identity** — the same string that appears in `owners/`, so there is exactly one notion of identity and it cannot drift.
- **On connect:** claim the record if absent; serve if it names me; refuse if it names someone else. One code path that works with a router in front *and* in bare `yarn dev` with no router at all.
- **Refusal carries the correction.** Rather than destroying the socket, the worker answers the upgrade with `409 Conflict` and `x-room-owner: <addr>`. In mode B the router retries against that address on the same client connection, so the race is invisible to the client; bounded to one retry. In mode A ext_authz runs once per request and cannot re-resolve, so the race costs one client reconnect — rare, since it needs the record to move between resolve and connect.
- **Every `OWNERSHIP_RECHECK_INTERVAL` (5s) while a Room has Sessions:** re-read the record. If it moved, drop the Room *without saving* and close Sessions `1013`. This evicts a worker that is alive but no longer trusted, before it can diverge from the new owner.
- **Every 2s, one membership self-check.** The worker runs the same `listMembers()` the router does and looks for *itself* inside `MEMBER_TTL`. If it cannot find itself live, it re-reads every Room it holds at once instead of waiting out the 5s cycle. This is what keeps the stale-serving window near the 2s poll rather than the 5s re-read, and it costs **one LIST per worker per 2s — O(workers), not O(Rooms)**. Simply running the per-Room re-read on a 2s timer would close the same window, but it multiplies the design's dominant read term by 2.5× to keep watch on a case that is rare, so the cheap check does the watching and the expensive one only fires when there is something to look at.
- **Immediately before every Snapshot write:** re-read. A Room whose ownership moved must not clobber the new owner's Snapshot.

### Drain order

Non-obvious and load-bearing. On `SIGTERM`:

1. **`DELETE members/{addr}` first**, and fail `/api/health`
2. **wait ~2× the router's member-poll interval** (~5s) so every router has dropped the worker from its live set
3. then per Room: persist Snapshot → CAS record to `owner: null` → close Sessions `1013`

Skip step 2 and routers cheerfully reallocate Rooms straight back onto the worker that is shutting down.

That wait keys off `MEMBER_POLL_INTERVAL`, **not `MEMBER_TTL`** — the record is deleted rather than left to go stale, so a clean drain never waits out the TTL and is unaffected by how it is tuned.

---

## Envoy replaces nginx — it is not an added tier

The AWS demo already runs a self-managed proxy tier: `NLB → ingress-nginx → pods`. [ADR 0002](../../adr/0002-nginx-ingress-on-eks-for-room-affinity.md) notes this is "surprising" to a reader expecting an AWS-native stack. Envoy does not sit on top of that — it takes its place. `NLB → Envoy → pods`.

Costed against today's baseline rather than against nothing:

| | today | mode A (Envoy) | mode B (proxy) |
|---|---|---|---|
| proxy tiers | 1 (nginx) | 1 (Envoy) | 0 |
| affinity by | `upstream-hash-by: $uri` | ext_authz → record | record |
| new processes | — | router (sidecar) | router |
| removed | — | ingress-nginx chart, controller, `Ingress` | ditto, plus the proxy tier |

Everything nginx does today ports directly: `upstream-hash-by: "$uri"` → ext_authz, `proxy-read-timeout: 3600` → `stream_idle_timeout: 0s`, host routing → `virtual_hosts`. The difference is that nginx can only hash a path, while Envoy can ask a question — which is the whole point.

### Why both modes exist

Mode A keeps Node off the byte path, which matters at scale and matters more for availability:

| | mode A (ext_authz) | mode B (proxy) |
|---|---|---|
| router sockets at 7k Sessions | **0** | ~14,000 |
| router memory | flat, tens of MB | 400–800MB, grows with connections |
| byte path | Envoy (C++, no GC) | Node (a GC pause hits every Room) |
| **router restart / rolling update** | **established Sessions keep flowing** | its Sessions drop and reconnect |
| resolve-race recovery | client reconnects | `409` retry, invisible to client |
| moving parts | 2 + ~60 lines YAML | 1 |

The restart row is the decisive one. Under mode A, a routine router deploy costs established Sessions nothing, because Envoy is holding them. Under mode B, every router deploy drops every Session it carries — they reconnect and resolve to the *same* workers, since ownership is in the bucket, so no Room moves and no Handover occurs, but it is a visible blip on every deploy instead of none.

Mode B is not a fallback, though. It is strictly better on the two targets that use it:

- **Cloud Run** has no addressable instances, so members are URLs. Envoy would need `DYNAMIC_FORWARD_PROXY` rather than `ORIGINAL_DST`, plus a TLS context — and Cloud Run already provides a managed frontend, so Envoy would be a tier bought for nothing.
- **Docker local** wants one container and no YAML. The fastest possible edit-run loop is worth more locally than the availability property, since nothing is established for long enough to care.

The divergence is in transport only. Both shells call the same `resolve()`, so behaviour — allocation, CAS, retry-on-conflict, drain — is tested once and shared.

### The mode A Envoy config

Envoy performs **no service discovery**: ext_authz names an upstream for every route, so there is one cluster and no endpoint configuration.

```yaml
route_config:                       # every route, affinity or not
  virtual_hosts:
    - name: all
      domains: ["*"]
      routes: [{ match: { prefix: "/" }, route: { cluster: tldraw_workers, timeout: 0s } }]

http_filters:
  - name: envoy.filters.http.ext_authz
    typed_config:
      "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz
      failure_mode_allow: false     # never guess an upstream
      http_service:
        server_uri: { uri: http://127.0.0.1:8081, cluster: room_router, timeout: 2s }
        authorization_response:
          allowed_upstream_headers: { patterns: [{ exact: x-envoy-original-dst-host }] }
  - name: envoy.filters.http.router

clusters:
  - name: tldraw_workers
    type: ORIGINAL_DST              # dictated by the router, never discovered
    lb_policy: CLUSTER_PROVIDED
    original_dst_lb_config: { use_http_header: true, http_header_name: x-envoy-original-dst-host }
```

Plus, on the listener: `upgrade_configs: [{ upgrade_type: websocket }]`, `stream_idle_timeout: 0s`, and `request_headers_to_remove: [x-envoy-original-dst-host]` so only ext_authz can choose an upstream. Envoy already strips `x-envoy-*` from non-internal addresses; stripping it explicitly makes that a property of this config rather than an inherited default. Even a forged header would only reach a worker that refuses any Room the record does not assign to it.

**The proxy mechanism for mode B is verified, not assumed.** A spike ran a real WebSocket handshake and real frames through a splicing Node proxy against two workers:

```
room=alpha  [HTTP/1.1 101 Switching Protocols] accept-valid=true
            hello from worker-A, path=/api/connect/alpha
            worker-A echoes: ping from client
room=beta   → worker-B
room=alpha  → worker-A                      (stable, as required)
```

`accept-valid=true` is the client validating the `Sec-WebSocket-Accept` computed by the **worker**, through the proxy — a genuine end-to-end handshake.

## Why not DNS, and why not xDS

Worth recording, because both were considered and rejected on evidence.

`STRICT_DNS` — pointing a proxy at a headless Service or Docker's embedded DNS — works. Verified: a compose service scaled 3 → 5 → 2 resolves to exactly 3, 5 and 2 A records, tracked live. It is also worth being precise that this is *not* "DNS balancing": Envoy resolves the name to the full set and runs its own load balancing; it never round-robins on resolution order.

It was still rejected:

- **UDP truncation.** DNS responses truncate at 512 bytes, capping a name at roughly 25–30 A records before resolvers fall back to TCP or silently truncate. A low ceiling for a system whose point is horizontal scale.
- **No metadata.** An address and nothing else — no room counts for load-aware allocation, no start time, no draining flag.
- **No drain signal.** A record disappears on scale-down; there is no way to say "stop sending me new Rooms, I am finishing the ones I have."
- **TTL lag**, stacked on the proxy's own refresh interval.
- **GCE has no group-level A record at all.** A Managed Instance Group publishes per-instance names only, so GCE needed Service Directory, or a Terraform-rendered static list, or a file-EDS agent — three answers, one not dynamic.

A real xDS control plane fixes the first four and none of the fifth: something still has to *discover* endpoints, meaning a Kubernetes informer here and a GCE API client there — precisely the runtime-specific code this design exists to avoid.

The bucket registry fixes all five, adds no infrastructure, and is the same store the design already depends on for correctness. If the bucket is unavailable the system is already degraded; making membership depend on it adds no new failure mode.

---

## How this is deployed per runtime

Because nothing performs discovery, **the router binary and its configuration are identical in all six runtimes** — only the transport shell and the packaging differ.

Constant across all six:

| Setting | Value |
|---|---|
| `S3_BUCKET_NAME` / bucket | the same bucket as snapshots and assets |
| `HEARTBEAT_INTERVAL` | 2s |
| `MEMBER_POLL_INTERVAL` | 2s |
| `MEMBER_TTL` | 8s |
| `OWNERSHIP_RECHECK_INTERVAL` | 5s |
| listen | `0.0.0.0:8080` |

**The one prerequisite every runtime must satisfy** is that worker addresses are directly routable from the router — it dials the address verbatim, with no LB in between. Four of the six satisfy this natively — GCE needs a firewall rule and Cloud Run needs per-worker service URLs; it is called out per section because it is the assumption that can break.

TLS terminates at the cloud LB in every case, and the router speaks plain HTTP behind it. A WebSocket is just TCP after the upgrade, so an L4 load balancer carries it without special configuration.

### EKS

**Mode A.** Envoy + router as a sidecar pair in one Deployment (2+ replicas), fronted by `Service type: LoadBalancer` with NLB annotations and an ACM certificate. Envoy reaches the router over loopback; nothing reaches Envoy's admin port.

**This replaces ingress-nginx outright** — the Helm release, the controller and the `Ingress` resource all go. Tier count is unchanged from today.

Workers are a separate Deployment with no Service in the request path — Envoy dials Pod IPs directly, which the VPC CNI makes routable from any pod with no extra configuration. Keep the existing ClusterIP Service for `kubectl port-forward` and the PodMonitor; it is no longer on the request path.

Workers set `ADVERTISE_ADDR` from `status.podIP` via `fieldRef` — an env var, not an API call.

IAM (IRSA, unchanged mechanism): the router needs `s3:GetObject`/`s3:PutObject`/`s3:ListBucket` on `owners/*` and `members/*`; workers need those plus the existing `rooms/*` and `uploads/*`.

**This supersedes [ADR 0002](../../adr/0002-nginx-ingress-on-eks-for-room-affinity.md).** ingress-nginx was chosen because ALB and NLB cannot hash on the request path; that reasoning is moot now that affinity comes from a record rather than a hash. The ADR's closing note about ElastiCache cluster mode becomes irrelevant — there is no ElastiCache.

### GKE

**Mode A, structurally identical to EKS** — same sidecar pair, same manifests, same `fieldRef`, same Envoy config. Only the LoadBalancer annotation differs. That is the payoff of hanging membership off the bucket rather than a cloud API.

Pod IPs are routable from any pod on a **VPC-native (alias IP)** cluster, which is the default and the one to target.

The registry backend is the real difference, and GCS satisfies the same interface:

| Operation | S3 | GCS |
|---|---|---|
| claim (must not exist) | `If-None-Match: *` | `ifGenerationMatch: 0` |
| CAS (must be unchanged) | `If-Match: <etag>` | `ifGenerationMatch: <generation>` |
| conflict | `412` | `412` |
| list membership | `ListObjectsV2` (strongly consistent since 2020) | `list` (always strongly consistent) |

GCS generations are cleaner than ETags — a monotonic integer rather than an opaque string — so `etag` in the interface is an opaque precondition token carrying either. `@google-cloud/storage` exposes both as preconditions on `file.save()`.

Applying this to the GCP demo is a **follow-up, not this change**; see [Consequences](#consequences).

### GCE

The runtime that made DNS untenable is the one that gains most: bucket membership needs no group-level DNS name, no Service Directory, and no MIG API client.

- **Workers:** a MIG running the app, with no load balancer in front — Envoy dials instance IPs directly.
- **Routing tier:** a separate MIG running the Envoy + router pair (mode A), behind a forwarding rule.
- `ADVERTISE_ADDR` from the metadata server (`instance/network-interfaces/0/ip`), or the default primary-NIC detection.
- **A firewall rule must allow routing-tier→worker on `3001`.** This is the one runtime where routability is a rule you write rather than a property you inherit.
- Credentials: the VM service account via the default provider chain. No key material.

The existing GCE target runs its own nginx tier to recover path hashing, since Google Cloud Load Balancing hashes a header or a cookie but never the path ([ADR 0004](../../adr/0004-room-affinity-per-deployment-target.md)). That nginx tier becomes the Envoy tier — again a swap, not an addition — and the reason changes: not to recover a hash, but to resolve a record.

### Cloud Run

**Mode B.** The hardest target, and the one that forced `addr` to be a URL: **a specific Cloud Run instance cannot be addressed.** You address a service, and Google's frontend picks an instance. Direct-address proxying is impossible, which is why [ADR 0004](../../adr/0004-room-affinity-per-deployment-target.md) pinned this target to a single instance.

The way through is to make **each worker its own single-instance Cloud Run service**, which gives it a stable, dialable URL:

- `sync-worker-0` … `sync-worker-N`, each deployed with `--min-instances=1 --max-instances=1`. `max=1` is a correctness requirement, not a tuning knob: two instances behind one URL would be two owners sharing one member record.
- **`--no-cpu-throttling` (CPU always allocated) is mandatory.** The default allocates CPU only during request processing, which would freeze the heartbeat on a worker with no open Sessions and get it evicted from the live set while perfectly healthy. The same throttling would stall Snapshot timers.
- `--min-instances=1` keeps it warm; a cold start inside a Room claim is a bad time to pay 2s.
- The router is an ordinary Cloud Run service, autoscaled normally, since it is stateless. No Envoy: instances are addressed by URL, which would need `DYNAMIC_FORWARD_PROXY` plus a TLS context rather than `ORIGINAL_DST`, and Cloud Run already provides the managed frontend Envoy would be there to be.

Each worker self-registers its own service URL, which it reads from the `K_SERVICE` metadata plus the resolved hostname, or simply from `ADVERTISE_ADDR` set at deploy time — the latter is one line of Terraform and avoids a metadata lookup.

Two limits to design around:

- **60-minute request cap.** Cloud Run terminates any request, WebSocket included, at 60 minutes. Sessions will drop hourly and reconnect. `TLSyncClient` already reconnects, and the reconnect resolves to the same worker because ownership lives in the bucket — so the Room does not move. It is a blip, not a Handover, but it must be documented rather than discovered in a demo.
- **Service-to-service auth.** Set worker ingress to internal and have the router mint an ID token per target URL, attached as `Authorization` when replaying the upgrade request. Splicing is unaffected — the header goes on the initial handshake and the socket is spliced afterwards as normal.

Scaling is deploying more worker services rather than raising a replica count, so this target trades elasticity for addressability. That is a real limitation, but it is a far better position than one instance: **Cloud Run can now provide Room Affinity**, which [ADR 0004](../../adr/0004-room-affinity-per-deployment-target.md) says it cannot.

### Docker (local)

**Mode B.** Three compose services: `room-router`, `app` (scaled), `localstack`. Publish `8080` only. No Envoy and no YAML — locally the edit-run loop is worth more than the availability property, since nothing stays established long enough to care.

Container IPs on the shared compose network are routable from the router container, so `ADVERTISE_ADDR` resolves correctly from the default primary-NIC detection and no configuration is needed at all.

```bash
docker compose up -d --scale app=3
docker compose up -d --scale app=1   # watch Rooms get reclaimed
```

The fastest way to exercise multi-worker routing and the fastest reproduction of the reclaim path — no cluster required.

> **ECS** was raised earlier and is not a target here. For the record it would be the EKS story: task IPs under `awsvpc` are routable, and the router is a separate service.

### local-cluster (k3d)

**Mode A**, the same sidecar pair as EKS — because this cluster exists to be faithful to production. Its README's claim is that both demos are "wired up the same way as their real EKS/GKE deployments", and mode A is what that means for AWS now.

**ingress-nginx stays in the cluster and leaves the AWS path.** It cannot simply be deleted: the GCP demo still hashes `$uri` on it for Room Affinity — [ADR 0004](../../adr/0004-room-affinity-per-deployment-target.md), untouched by this design — and Grafana is served through it at `grafana.localhost`. What changes is that no AWS traffic crosses it.

- `local-cluster/k3d-config.yaml` gains a second port mapping, `8081:8081`, onto an Envoy `Service type: LoadBalancer`. It needs a port of its own rather than `:80`, which k3s svclb has already bound for the nginx controller. The existing `8080:80` stays exactly as it is, serving `gcp.localhost` and `grafana.localhost`. (Unrelated to the `127.0.0.1:8081` in the Envoy config above — that one is the router on pod loopback, and the two never meet.)
- `tldraw-sync-aws/chart/templates/ingress.yaml` is **deleted, not re-annotated.** Pointing a de-hashed nginx Ingress at Envoy would work, and it would preserve the `aws.localhost:8080` URL, but it would make the local cluster the one place in the repo where Envoy really is an added tier — demonstrating the opposite of the thing this document argues.
- `local-cluster/scripts/verify-aws.sh` targets `http://localhost:8081` in place of `http://aws.localhost:8080`.
- The dashboard's **"Ingress 5xx rate by host"** panel splits in two: `nginx_ingress_controller_requests{status=~"5.."}` keeps serving GCP, and AWS moves to Envoy's own `envoy_http_downstream_rq_xx{envoy_response_code_class="5"}`. Left alone the panel would quietly go half-blind — still drawing GCP, simply omitting AWS — which is worse than a panel that visibly changed. It is also a better signal than the one it replaces, since it measures the tier that actually resolves ownership.

Envoy dials Pod IPs directly, as on EKS; k3d's default flannel backend makes them routable across nodes with no extra configuration.

### Summary

| Runtime | Mode | Discovery | Router config delta | Replaces | Routability |
|---|---|---|---|---|---|
| EKS | A — Envoy | none | none | ingress-nginx | Pod IPs, VPC CNI |
| GKE | A — Envoy | none | none | ingress-nginx | Pod IPs, VPC-native |
| GCE | A — Envoy | none | none | its nginx tier | instance IPs + firewall rule |
| Cloud Run | B — proxy | none | none | single-instance pin | per-worker service URLs |
| Docker | B — proxy | none | none | — | container IPs |
| local-cluster (k3d) | A — Envoy | none | none | its AWS `Ingress` | Pod IPs, flannel |

An empty "config delta" column is the deliverable. The "replaces" column is why mode A costs no extra tier anywhere.

### Platform matrix — before and after

The same targets, against what the hash-ring design could offer on each, and where each stands today. A "should work" is reasoned, not demonstrated.

| Platform | Hash-ring design | This design | Status |
|---|---|---|---|
| local-cluster (k3d) | ingress-nginx | mode A | **verified** — the only one so far |
| EKS | self-managed ingress-nginx, because ALB/NLB cannot hash a path (ADR 0002) | mode A | designed, not deployed |
| GKE | ingress-nginx | mode A | designed, not deployed |
| GCE MIG | hand-rolled nginx VM tier with a static upstream list, no autoscaling (ADR 0004) | mode A — membership replaces MIG discovery, so autoscaling becomes possible | designed, not deployed |
| Cloud Run | **incompatible**: no per-instance addressing, so pinned to one instance (ADR 0004) | mode B — each worker its own single-instance service, addr = its service URL | designed, not deployed |
| Docker / bare `yarn dev` | — | mode B; bare dev needs no router at all | implemented |
| ECS / Fargate | effectively impossible — ingress-nginx is Kubernetes-only | untargeted, but should work under mode A: `awsvpc` tasks have dialable IPs and nothing here queries a Kubernetes API | untested |

The requirement set behind every row is deliberately small: workers reach the bucket, every worker has a dialable address (or is given its own service URL), and there is somewhere to run Envoy and the router — or just the router in mode B. No Kubernetes API, no cloud DNS, no per-cloud discovery. That is why runtimes this repo never targeted (ECS, Nomad, plain VMs) fall out without new code, where the hash-ring design was structurally Kubernetes-shaped.

---

## What gets deleted

`redis` dependency · all four Redis clients · both Lua scripts (`RENEW_IF_OWNER`, `RELEASE_IF_OWNER`) · `CHANNEL_HANDOVER_REQUEST` / `CHANNEL_LOCK_RELEASED_PREFIX` / `CHANNEL_READY_PREFIX` and every subscription · `acquireLockWithHandover` · `releaseRoom` · `waitForReadySignal` · `subscribeToLockReleased` · `signalReady` · `initHandoverListener` · `test/helpers/fakeRedis.ts` · `test-handover.js` · `test-lock.js` · `chart/templates/redis.yaml` · `chart/templates/ingress.yaml` · `REDIS_URL` · the `tldraw_handover_*` metrics · the ElastiCache row of the AWS README's deployment table.

## What gets added

`src/registry.ts` (~120 lines: ownership CAS + membership) · `src/membership.ts` (worker heartbeat) · `src/router/resolve.ts` (pure, unit-testable) · `src/router/extAuthz.ts` (mode A, ~40 lines) · `src/router/proxy.ts` (mode B, ~110 lines) · `envoy.yaml` · `compose.yaml` · `chart/templates/envoy.yaml` · new metrics: `tldraw_room_claims_total`, `tldraw_room_reclaims_total`, `tldraw_room_cas_conflicts_total`, `tldraw_room_ownership_lost_total`, `tldraw_members_live`, `tldraw_router_resolve_duration_seconds`, `tldraw_router_retries_total`.

Packaging: **one package, two entrypoints** — `src/index.ts` (worker) and `src/router/index.ts` (router) sharing `src/registry.ts`. One image, one install, one test suite; `CMD` differs. A separate router package would mean a second install and a duplicated CAS implementation.

---

## Observability

The local-cluster Grafana dashboard exists to answer "what does a client feel while we scale?" That question survives; the answers get better, and the panels change.

Under hash routing, scaling 2→3 reshuffles the ring and drags roughly a third of Rooms across workers. Under record routing, **scaling up disturbs nothing** — existing Rooms keep their owner, only new Rooms land on the new worker. Scaling down disturbs only Rooms on terminating workers, which drain cleanly.

So `tldraw_handover_*` panels become reclaim rate, reclaim duration, live member count and `1013` closes — and the headline result is a flat line where there used to be a spike. The manual drill changes from "scale up and hope your Room rehashes" to "kill a worker and watch its Rooms get reclaimed", which is both more deterministic and more honest about what the system now guarantees.

---

## Failure modes

| Scenario | Behaviour |
|---|---|
| Worker crashes | Heartbeat stops; evicted from the live set in ≤8s. Next connect finds a dead owner, reallocates by CAS, new owner loads the last Snapshot. Loses up to 10s of edits — same as today. |
| Worker hung (event loop blocked) | Same as a crash — the heartbeat is the liveness signal, so hangs and crashes are indistinguishable and both handled. |
| Worker partitioned from the bucket | Stops heartbeating → evicted, Rooms reallocated. It cannot persist Snapshots either, so it cannot clobber the new owner; it serves stale state to existing Sessions until the partition heals, then discovers it lost the Rooms and closes them `1013`. |
| Live worker stalls past `MEMBER_TTL` and is wrongly evicted | Its Rooms are reallocated while it still holds Sessions. Its own 2s membership self-check fails to find it live, so it re-reads its records immediately, finds them moved, and closes those Sessions `1013` without saving. Stale-serving window is ~2s rather than the 5s re-read cycle. This is the case the four-missed-beats margin exists to make rare. |
| Record moves between resolve and connect | Worker answers `409` with `x-room-owner`; router retries once against the named address on the same client connection. Invisible to the client. |
| Two routers race a claim | Both CAS; one gets `412`, re-reads, uses the winner. |
| Bucket unavailable | New connects fail. Established Sessions keep working; the 5s ownership read fails open — a blip is not evidence of lost ownership, matching today's Redis-blip handling. |
| Router dies (mode A) | ext_authz fails closed: new connects 503 on that replica. **Established Sessions are unaffected** — Envoy holds them. |
| Router dies (mode B) | Its spliced sockets drop; clients reconnect through the LB into a surviving router and resolve to the *same* workers, since ownership is in the bucket. No Rooms move — a blip, not a Handover. |
| Router cannot dial a live worker (mode B) | It stops offering that worker new connections and leaves both the live set and the ownership records untouched. Sessions already established elsewhere are unaffected, and no Rooms move; the client retries and either reaches the worker through a router that can still see it, or gets `503` until reachability returns. |
| All workers dead | Router has an empty live set and returns 503 rather than proxying to a dead address. |

**The one hole worth naming:** the window between "record says I own this" and the Snapshot PUT landing is milliseconds, but non-zero. This is a check-then-write, not a mutual exclusion. The current Redis design has exactly the same hole — it is not a regression — but the ADR should say so rather than imply that conditional writes made it airtight.

---

## Consequences

- **This supersedes [ADR 0002](../../adr/0002-nginx-ingress-on-eks-for-room-affinity.md).** ingress-nginx is no longer needed for Room Affinity on any runtime.
- **[ADR 0001](../../adr/0001-duplicate-per-cloud-demos.md) weakens.** The AWS demo stops being "the GCP demo with `s3Storage.ts` swapped in" — `roomManager.ts` diverges materially, and so does the whole routing tier. Fine while AWS leads, but a real change to the repo's stated premise, and better recorded than discovered.
- **[ADR 0004](../../adr/0004-room-affinity-per-deployment-target.md) is partly invalidated.** Its claim is that Room Affinity is a property of the deployment target. Under this design affinity is a property of the *application*, and every target that can route to an instance address can provide it — including the Cloud Run target currently pinned to one instance — see [Cloud Run](#cloud-run) for what that costs.
- **[CONTEXT.md](../../../CONTEXT.md) needs updating.** *Room Lock* is no longer a renewed lease; *Room Affinity* is no longer a hint. The example dialogue's "affinity is a hint, not a guarantee — the hash ring reshuffles whenever we scale" exchange becomes wrong for AWS and right for GCP, so the vocabulary has to name which demo it describes.
- **[`docs/drain-and-reclaim.md`](../../../tldraw-sync-aws/docs/drain-and-reclaim.md) replaces `coordinated-handover.md`**, which documented a protocol that no longer exists.
- **Mode B puts this repo's code on the data path.** Every byte of every Session crosses the router on Cloud Run and Docker. That is not true in mode A, and not true of ingress-nginx today — nginx proxies, but it is not code this repo maintains. It is the price of the two targets where a proxy tier cannot or should not exist.
- **Cost.** Reads dominate: one GET per connect, one per Room per 5s while occupied, one before each Snapshot write, plus one LIST per router per 2s and one per worker per 2s. At 1,000 concurrent Rooms and 10 workers that is roughly $0.15/hr. A per-Room lease would have cost ~$3.60/hr in PUTs at 5s renewal — ~25× more — which is most of why there is no lease on Rooms.

---

## Verification status

**Verified:**
- **S3 conditional PUT semantics on LocalStack 4.14.0** — create, contention, CAS, and the `501` on conditional delete. This is the correctness core.
- **Mode A end to end**, against real Envoy v1.34 with two workers and a stub router: a WebSocket *upgrade* proxied via `ext_authz` → `ORIGINAL_DST`, `Sec-WebSocket-Accept` valid end to end, room-stable routing (`alpha`→A, `beta`→B, `alpha`→A), rendezvous allocation for a room with no record (`gamma`→B), a forged `x-envoy-original-dst-host` defeated by `request_headers_to_remove`, and a non-affinity HTTP route resolved to any member.
- **Mode B**, WebSocket proxying by socket splicing in Node — real handshake, real frames, room-stable routing across two workers.
- Docker embedded DNS returns one A record per replica and tracks scaling. *(Verified, then rejected — see [Why not DNS](#why-not-dns-and-why-not-xds). Recorded as the evidence behind the rejection, not behind the design.)*

### Implementation notes from the mode A spike

- **Exactly one ext_authz call per connection**, never per message — confirming the router's cost is O(connects per second). This is the property mode A exists for.
- **Envoy does not forward the `Upgrade` header to the authz service by default** (the stub saw `upgrade=-`). Resolution is by path so this does not matter here, but anything needing to distinguish a WS upgrade from a plain GET must add `authorization_request.allowed_headers`.
- **`ORIGINAL_DST` with no header returns `503 no healthy upstream`** — the correct fail-closed behaviour when the router has no live members, and now observed rather than assumed.
- **Envoy lowercases response header names.** Harmless, but it will break any case-sensitive assertion in tests written against the handshake.

**Not yet verified:**
- Throughput and memory of the mode B splicing router under the existing `stress-test/` at a few thousand concurrent Sessions — the number that decides whether mode B is viable beyond Docker and Cloud Run.
- The `409` + `x-room-owner` retry path against a real worker (mode B).
- The failed-dial routing preference: that skipping an unreachable worker for new connections, without touching its records, behaves as described under a partial network partition.
- That a worker under the existing `stress-test/` load never stalls past the 8s `MEMBER_TTL`. The four-missed-beats margin is reasoned from typical Node stall behaviour, not measured, and `local-cluster` is where to measure it.
- Behaviour of long-lived spliced sockets across a router rolling update — expected to drop and reconnect, which is acceptable, but it should be observed rather than assumed.
- Cloud Run end to end: that `--no-cpu-throttling` really does keep the heartbeat running on a worker with zero open Sessions, and that an ID-token-authenticated WebSocket upgrade splices cleanly. Both are load-bearing for that target and neither has been tried.

---

## Open questions

1. Does the ADR land as one record or two? These are not separable decisions — routing cannot resolve owners without a CAS-able record — so one seems right, but it is a large ADR.
2. Should the router prefer least-loaded workers using the `rooms` count, or is pure rendezvous hashing — stable, no thundering herd onto a fresh worker — the better default?

### Resolved

- **`local-cluster`'s entry point** *(was Q2)* — ingress-nginx stays in the cluster, because GCP and Grafana both still need it, and the AWS demo gets its own k3d port straight to Envoy rather than being forwarded through it. See [local-cluster (k3d)](#local-cluster-k3d).
- **Heartbeat and TTL** *(was Q3)* — **2s heartbeat / 8s TTL**, four missed beats, rather than either the original 5s/15s or the tighter 2s/6s. The per-Room ownership re-read stays at 5s; a 2s membership self-check closes the eviction window without paying O(Rooms) for it. See [the membership registry](#1-the-membership-registry--membersaddr) and [the worker](#4-the-worker).
