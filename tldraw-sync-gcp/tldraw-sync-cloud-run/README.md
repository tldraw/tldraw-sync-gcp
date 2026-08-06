# tldraw-sync-cloud-run

The tldraw sync backend on **Cloud Run**. Same server as the other two targets,
byte for byte — no code changes were needed to run it here.

> One of three GCP deployment targets, alongside
> [`../tldraw-sync-gke`](../tldraw-sync-gke) and
> [`../tldraw-sync-compute-engine`](../tldraw-sync-compute-engine). See
> [the GCP README](../README.md) for how to choose between them.

## Read this first: Cloud Run cannot provide Room Affinity

**This target ships with `max_instances = 1`, and that is not a placeholder.**

Room Affinity is the routing property that sends every Session of one Room to
the same server instance. It has to be a function of the `roomId`. Cloud Run
offers session affinity, but it is keyed on the **client** — a cookie identifying
one browser — and Google documents it as best-effort:

> you cannot assume that a client will always reconnect to the same instance,
> _even when session affinity is enabled_

There is no path-based hashing, and Cloud Run exposes **no per-instance
addressing**: all traffic goes through Cloud Run's own frontend, which chooses an
instance itself. That last point is what closes off the escape hatch the Compute
Engine target uses — you cannot put nginx in front and hash on `$uri`, because
nginx would have exactly one upstream (the `run.app` URL) and Cloud Run would
re-scatter behind it.

### What happens above one instance

Client-keyed affinity is not merely weaker than Room-keyed affinity. It is the
wrong axis, and above one instance it makes Handover self-sustaining:

1. Client **A** pins to instance 1, opens room R, takes the Room Lock.
2. Client **B** pins to instance 2, opens room R. Instance 2 is not the Room
   Owner, so it requests a Handover. Instance 1 persists the Snapshot, releases
   the lock, and closes A's socket with code `1013`.
3. **A reconnects — and its affinity cookie sends it back to instance 1.**
   Instance 1 is now not the owner, so it requests a Handover back. Instance 2
   persists, releases, and closes **B's** socket with `1013`.
4. B reconnects, back to instance 2 by cookie. Go to 2.

The Room ping-pongs at roughly **0.5–2 Handovers per second**, each one a full
GCS write plus a GCS read plus a Redis round trip, each one evicting _every_
Session in the Room. Nothing converges.

Turning session affinity **off** does not fix it — it randomises which instance
each reconnect lands on, and the probability that all `S` Sessions of a Room
independently land on the current owner is `(1/N)^(S-1)`.

Even before the livelock starts, filling a Room costs Handovers: each arriving
Session lands on the owner with probability about `1/N`, so admitting `S`
Sessions costs roughly `(S-1)·(1-1/N)` Handovers. With `upstream-hash-by: "$uri"`
on GKE it costs **zero**.

### Try it yourself

```bash
terraform apply -var="max_instances=4" ...
```

Then graph these from `/metrics` while two browsers sit in one room:

- `tldraw_handover_requests_total`
- `tldraw_handover_duration_seconds`
- `tldraw_room_lock_lost_total`

Expect a ramp with **no plateau**. That is the shape of an unbounded Handover
rate, and it is why the default is 1.

### What this target actually teaches

It is a genuinely useful demo, not a broken one, and it makes the sharpest point
in this repo:

> **The Room Lock alone is sufficient for correctness.** Run this on Cloud Run
> with four instances and you will not lose an edit, never see two owners of one
> Room, and never see a Snapshot written by a stale owner. The Lua
> compare-and-set on renew and release, and the persist-before-release ordering
> in `releaseRoom()`, see to that.
>
> **Room Affinity is purely economic.** What this target shows is that
> "economic" does not mean "safe to skip". When affinity is keyed on the client
> rather than the Room, the price is not a higher Handover rate — it is an
> unbounded one.

One instance at concurrency 80 is a real small deployment, not a toy. And you
still get one clean Handover demo for free: a revision rollout runs the old and
new instances concurrently while the old one drains, so every Room hands over
exactly once, correctly.

## Other limitations worth knowing

**The 10-second SIGTERM grace is fixed and not configurable.** On shutdown the
server persists a Snapshot for every Room it holds. `persistRoomSnapshot` retries
three times with 1s+2s+4s of backoff, so one Room can legitimately need ~8
seconds; Rooms are persisted in parallel, so the healthy case fits comfortably
and the case the retries exist for does not. There is no knob.

The mitigation is `concurrency = 80`, which bounds an instance to about 80 Rooms
and keeps the shutdown fan-out small. The residual risk is the system's already
stated envelope for ungraceful termination: up to 10 seconds of edits lost (the
snapshot throttle interval) and a Room Lock unavailable for up to 10 seconds (the
lease). Cloud Run just makes ungraceful termination more likely.

Note what we did **not** do: lower the retry count to fit. That would weaken GKE
and Compute Engine, which have 60–90 seconds, to accommodate this target.

**The 60-minute request cap** force-closes every Session at least hourly. At one
instance this is a non-event — the client reconnects in about half a second and
returns to the only instance, which still owns the Room.

**Cost shape.** `cpu_idle = false` plus `min_instance_count = 1` means you pay
VM-shaped money for a serverless product. Most of Cloud Run's cost advantage does
not apply to this workload. CPU has to be always-allocated because there is a
window in `releaseRoom()` where an instance holds a Room Lock with no socket of
its own open; throttled CPU there stalls past the 10-second lease and triggers a
lock loss, and lock loss drops the Room **without saving**.

**No load balancer.** Fronting Cloud Run with a global external ALB would buy
nothing: serverless NEG backends do not expose `localityLbPolicy` or
`consistentHash`, so it cannot help with the only property that matters here.
`*.run.app` is already managed HTTPS, which is what `wss://` needs. For a custom
domain use `google_cloud_run_domain_mapping` and know that it changes nothing
about routing.

## Deploying

```bash
# 1. Build and push
gcloud auth configure-docker europe-west1-docker.pkg.dev
docker build --platform linux/amd64 \
  -t europe-west1-docker.pkg.dev/$PROJECT_ID/tldraw-sync/tldraw-gcp:$(git rev-parse --short HEAD) .
docker push europe-west1-docker.pkg.dev/$PROJECT_ID/tldraw-sync/tldraw-gcp:$(git rev-parse --short HEAD)

# 2. Apply
cd infra-terraform
terraform init -backend-config="bucket=$PROJECT_ID-tf-state"
terraform apply \
  -var="project_id=$PROJECT_ID" \
  -var="image=europe-west1-docker.pkg.dev/$PROJECT_ID/tldraw-sync/tldraw-gcp:$(git rev-parse --short HEAD)"

# 3. Check
curl "$(terraform output -raw sync_url)/api/health"
```

No domain and no certificate to arrange — `*.run.app` is managed HTTPS, which is
the one place this target is genuinely the easiest of the three.

A misconfigured Direct VPC egress fails loudly rather than silently: the server
calls `process.exit(1)` if it cannot reach Redis at startup, so the revision
fails at deploy time with a clear log line instead of serving broken WebSockets.
That fail-fast behaviour is worth keeping.

### Sharing one substrate with the other targets

By default this target provisions its own VPC, Memorystore instance, GCS bucket
and Artifact Registry repository. To attach to an existing one:

```hcl
create_substrate         = false
existing_network_name    = "tldraw-sync-gce"
existing_redis_url       = "redis://10.x.x.x:6379"
existing_gcs_bucket_name = "my-project-room-data"
```

Sharing Redis with another target lets you watch a Room hand over **between
deployment targets** — open the same room against Cloud Run and against the
Compute Engine target and the Room Lock moves ownership live.

## Configuration

| Variable           | Default     | Notes                                    |
| ------------------ | ----------- | ---------------------------------------- |
| `max_instances`    | `1`         | See the top of this file before raising. |
| `concurrency`      | `80`        | Also bounds the shutdown fan-out.        |
| `cpu` / `memory`   | `2` / `1Gi` |                                          |
| `image`            | —           | Required.                                |
| `create_substrate` | `true`      |                                          |

## Running locally

Identical to the other targets.

```bash
cp .env.example .env
docker run -d -p 6379:6379 redis
yarn install
yarn dev
```

See [`../tldraw-sync-gke/README.md`](../tldraw-sync-gke/README.md) for the full
local setup including the GCS emulator.
