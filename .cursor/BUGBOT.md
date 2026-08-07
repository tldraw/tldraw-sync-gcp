# Review context for tldraw-sync-cloud

Reference demos of a tldraw sync backend, deploying the same server to
different clouds and — on GCP — to different compute services. Read `CONTEXT.md`
for the domain vocabulary (Room, Session, Snapshot, Room Owner, Room Lock,
Owner Identity, Handover, Room Affinity, Deployment Target) and use those terms
in review comments.

There are **four copies of the server**:

```
tldraw-sync-aws/
tldraw-sync-gcp/tldraw-sync-gke/
tldraw-sync-gcp/tldraw-sync-compute-engine/
tldraw-sync-gcp/tldraw-sync-cloud-run/
```

## The duplication is deliberate

`roomManager.ts`, `index.ts`, `metrics.ts` and `unfurl.ts` are intentional
byte-identical copies across all four; the storage module (`s3Storage.ts` vs
`gcsStorage.ts`) is the only sanctioned difference anywhere, and the three GCP
copies have no differences at all. See
`docs/adr/0001-duplicate-per-cloud-demos.md` and
`docs/adr/0003-three-gcp-deployment-targets.md`.

Do **not** file "duplicated code, extract a shared package" findings — not
across clouds, and not across the three GCP deployment targets either. Do flag
the opposite, which is now a **four-way** check: a change to a shared file in
one copy that was not cross-ported to the other three. CI builds and tests each
copy independently and cannot detect this; review is the only thing that can.

A GCP-target-specific difference in `src/` is itself a finding: the whole point
of ADR 0003 is that the application does not change between targets, so a fork
there means either a bug or a decision that needs recording.

## What matters most here

**Room ownership.** A Room is held in memory by exactly one pod, guarded by a
Redis lock at `lock:room:<roomId>` on a 10s lease renewed every 5s. Two pods
serving the same Room means divergent state and lost drawings. Scrutinise any
`SET`/`DEL` on a lock key for whether it proves ownership before acting —
`XX` asserts existence, not that we are still the owner.

**Handover.** Transferring a Room is a two-phase protocol over Redis pub/sub:
the incoming owner publishes on `room-handover`; the outgoing owner persists
the Snapshot, drops the lock, publishes `handover-lock-released:<roomId>`,
waits for `handover-ready:<roomId>`, then closes Sessions with code 1013.
Look for subscribe-after-publish ordering races, waiters that never
unsubscribe, and timeout budgets that do not add up (the requester's wait must
exceed the owner's worst-case persist time, including storage retry backoff).

**Snapshot durability.** The Snapshot is the only durable form of a Room.
Flag anything that lets a stale in-memory writer overwrite a newer Snapshot
after a Handover — in particular throttled or debounced saves that are not
cancelled when a Room is released — and any persist failure that is swallowed
so callers believe a save succeeded.

**Lifecycle leaks.** Rooms, heartbeat intervals, socket sets and pub/sub
subscriptions are held in `Map`s keyed by roomId. Flag paths that remove a
Room from one map but not the others, or that leave an interval running.

**Untrusted input reaches infrastructure keys.** `roomId` comes straight from
the WebSocket upgrade URL and `uploadId` from the request path; both are
interpolated into object storage keys, Redis keys and pub/sub channel names.
Flag missing validation or sanitisation on those paths.

**Public surface.** The asset upload/download and unfurl endpoints are
unauthenticated and CORS-open. Flag SSRF reachability, unbounded request
bodies, and stored content types that are echoed back on download.

**Streams.** Asset handlers pipe request and storage streams directly. An
unhandled `error` event on any of them takes the pod down; flag pipes with no
error handler.

**Metrics.** Prometheus labels must come from bounded sets. Flag anything that
labels a metric with a raw path, roomId, or other unbounded value.

## Style

Tests live in `test/` and run under Vitest; source stays in `src/` so the
Docker build is unaffected. Formatting is Prettier with the repo's
`.prettierrc` (no semicolons, double quotes, width 100) — do not raise
formatting-only findings.
