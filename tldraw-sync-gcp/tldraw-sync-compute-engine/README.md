# tldraw-sync-compute-engine

The tldraw sync backend on **Compute Engine**: Container-Optimized OS VMs
running the container directly, behind an nginx routing tier that
consistent-hashes on the request path.

> One of three GCP deployment targets. The server here is a byte-identical copy
> of the one in [`../tldraw-sync-gke`](../tldraw-sync-gke) and
> [`../tldraw-sync-cloud-run`](../tldraw-sync-cloud-run) — see
> [the GCP README](../README.md) for how to choose, and
> [`../../docs/adr/0003-three-gcp-deployment-targets.md`](../../docs/adr/0003-three-gcp-deployment-targets.md)
> for why they are copies rather than one shared package.

**This is the target with the best operational properties for this workload.**
It reproduces GKE's Room Affinity exactly, and it has the most generous
shutdown budget of the three, which is what bounds how much work a Room can
lose when an instance goes away.

## Architecture

```
                         clients (wss://)
                                │
                                ▼
              ┌─────────────────────────────────┐
              │  Global external ALB            │  managed cert, :443
              │  no session affinity — see below│
              └─────────────────────────────────┘
                                │
                                ▼
              ┌─────────────────────────────────┐
              │  nginx MIG   hash $uri consistent│  autohealed, rolling updates
              └─────────────────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
        ┌───────────┐     ┌───────────┐     ┌───────────┐
        │ app VM 0  │     │ app VM 1  │     │ app VM 2  │  COS + cloud-init
        └─────┬─────┘     └─────┬─────┘     └─────┬─────┘  fixed size
              └─────────────────┼─────────────────┘
                                ▼
                 Memorystore (Room Locks, Handover pub/sub)
                 GCS          (Snapshots, Assets)
```

### Why the nginx tier exists

Room Affinity has to be a function of the `roomId`. The GKE target gets that
from ingress-nginx:

```yaml
nginx.ingress.kubernetes.io/upstream-hash-by: "$uri"
```

`$uri` is `/api/connect/<roomId>`, so every Session of a Room lands on that
Room's Room Owner and a Handover only happens when the hash ring actually
reshuffles.

**Google Cloud Load Balancing cannot do this.** Its session affinity options are
`CLIENT_IP`, `GENERATED_COOKIE`, `HTTP_COOKIE`, `HEADER_FIELD` and
`STRONG_COOKIE_AFFINITY` — a header or a cookie, never the request path. So the
load balancer alone can only give you affinity keyed on the _client_, which is
the wrong axis: two clients in the same Room get sent to different VMs, and each
new arrival drags the Room across with a Handover that evicts everyone already
in it.

Running nginx ourselves puts the hash back on the `roomId`. The load balancer
then has nothing to be sticky about — every nginx VM hashes identically, so it
does not matter which one a request reaches. That is why there is no
`session_affinity` on the backend service.

The alternative we rejected — `HTTP_COOKIE` + `RING_HASH` on the load balancer,
with the client setting a cookie carrying the `roomId` — is recorded in
[`../../docs/adr/0004-room-affinity-per-deployment-target.md`](../../docs/adr/0004-room-affinity-per-deployment-target.md).

### Why the app tier is a fixed set of VMs and not a MIG

Consistent hashing in OSS nginx needs a **static list of upstream addresses**. A
regional managed instance group assigns names and IPs at create time, so they are
not knowable when the nginx config is rendered; you would need a sidecar that
polls the MIG, rewrites `nginx.conf` and reloads — a bespoke component to write,
test and explain, and the piece most likely to be subtly wrong.

So the app tier is `google_compute_instance` × N with predictable names, and the
upstream list is a plan-time value. **The nginx tier is still a MIG**, with
autohealing and rolling updates, because it is stateless and any instance can
serve any Room.

What this costs, stated plainly:

- **No autohealing on the app tier.** A wedged VM stays wedged until you replace
  it (`terraform taint` + apply). systemd `Restart=always` covers the common case
  of the container dying.
- **No autoscaling on the app tier.** Resizing is editing `app_instance_count`.

For this workload that is a smaller loss than it looks. Every change to the
instance set reshuffles the hash ring, and every Room whose hash moves pays a
Handover — so membership changes _should_ be deliberate. And CPU, the signal the
GKE target's HPA scales on, is the wrong signal here anyway: idle Sessions cost
almost no CPU, so you hit connection limits long before a CPU threshold.

## Deploying

You need a **domain you control**. `wss://` requires TLS and a Google-managed
certificate requires DNS validation.

```bash
# 1. Build and push the image
gcloud auth configure-docker europe-west1-docker.pkg.dev
docker build --platform linux/amd64 \
  -t europe-west1-docker.pkg.dev/$PROJECT_ID/tldraw-sync/tldraw-gcp:$(git rev-parse --short HEAD) .
docker push europe-west1-docker.pkg.dev/$PROJECT_ID/tldraw-sync/tldraw-gcp:$(git rev-parse --short HEAD)

# 2. Apply
cd infra-terraform
terraform init -backend-config="bucket=$PROJECT_ID-tf-state"
terraform apply \
  -var="project_id=$PROJECT_ID" \
  -var="domain=gce-sync.example.com" \
  -var="image=europe-west1-docker.pkg.dev/$PROJECT_ID/tldraw-sync/tldraw-gcp:$(git rev-parse --short HEAD)"

# 3. Point DNS at the address, then wait for the cert (15-60 min)
terraform output load_balancer_ip
gcloud compute ssl-certificates describe tldraw-sync-gce-cert --global --format='value(managed.status)'

# 4. Check
curl https://gce-sync.example.com/api/health
```

The Artifact Registry repository is created by step 2, so on a first run push
after an initial `terraform apply -target=google_artifact_registry_repository.images`,
or create the repository by hand.

### Sharing one substrate with the other targets

By default this target provisions its own VPC, Memorystore instance, GCS bucket
and Artifact Registry repository, so it deploys end-to-end from one apply.
Memorystore is the dominant line item, so running all three targets that way
means paying for it three times. To attach to an existing substrate instead:

```hcl
create_substrate         = false
existing_network_name    = "tldraw-sync-gce"
existing_subnet_name     = "tldraw-sync-gce"
existing_redis_url       = "redis://10.x.x.x:6379"
existing_gcs_bucket_name = "my-project-room-data"
```

Sharing also unlocks the clearest demo in this repo: point two targets at one
Redis and open the same room against both. The second connection triggers a
**Handover across deployment targets** — a GKE pod hands the Room to a COS VM,
live. Room Ownership is a property of the Room Lock, not of the platform.

## Configuration

| Variable               | Default         | Notes                                        |
| ---------------------- | --------------- | -------------------------------------------- |
| `app_instance_count`   | `3`             | Fixed. Changing it reshuffles the hash ring. |
| `app_machine_type`     | `e2-standard-2` |                                              |
| `nginx_instance_count` | `2`             | Stateless; scale freely.                     |
| `image`                | —               | Required. The VMs pull this on boot.         |
| `domain`               | —               | Required. Managed cert + `wss://`.           |
| `create_substrate`     | `true`          | See above.                                   |

The server itself reads only `PORT`, `REDIS_URL`, `GCS_BUCKET_NAME`,
`GCS_API_ENDPOINT` (local emulator) and `HOSTNAME`. The cloud-init unit passes
the first three plus `HOSTNAME=%H`, so the VM name shows up as the Owner
Identity in Handover logs.

## Operational notes

**Container startup.** This target does **not** use `gce-container-declaration`
or `gcloud compute instances create-with-container`. The container startup agent
(konlet) was shut down for new VMs and MIGs on **2026-07-31**; Google's
documented replacement is a startup script or cloud-init, and this uses
cloud-init with a systemd unit. See
[`infra-terraform/templates/app-cloud-init.yaml.tftpl`](infra-terraform/templates/app-cloud-init.yaml.tftpl).

**Shutdown budget.** `TimeoutStopSec=90` around `docker stop --time=60`. A single
Room can need ~8s to persist in the worst case (three retries with 1s+2s+4s
backoff), and `shutdown()` runs every held Room in parallel, so 60s is generous.
This is the main advantage over Cloud Run, whose 10-second grace period is fixed
and not configurable.

**No Spot VMs.** A preemption gives ~30 seconds and arrives without warning,
which makes losing a Snapshot routine and discards the one property that makes
this target better than Cloud Run.

**Health checks are deliberately dumb.** `/api/health` returns 200 without
checking Redis or GCS. Making it Redis-aware would turn a 60-second Memorystore
blip into a simultaneous rebuild of the whole fleet, and a Redis-aware load
balancer check would convert "new Sessions fail" into "the load balancer 502s
everyone". The reasoning is written out in
[`infra-terraform/healthchecks.tf`](infra-terraform/healthchecks.tf); the real
signal lives in `/metrics`.

**Rolling the nginx tier** surges rather than removing capacity, because
replacing an nginx VM drops the Sessions it was proxying and they all reconnect
at once.

**Resizing the app tier** re-renders `nginx.conf`, which rolls the nginx MIG.
That is the intended chain. Watch `tldraw_handover_requests_total` rise and
`tldraw_handover_success_total` track it exactly, with
`tldraw_handover_timeouts_total` and `tldraw_room_lock_lost_total` flat.

## Running locally

Identical to the other targets — the server does not know which one it is in.

```bash
cp .env.example .env
docker run -d -p 6379:6379 redis
yarn install
yarn dev
```

See [`../tldraw-sync-gke/README.md`](../tldraw-sync-gke/README.md) for the full
local setup including the GCS emulator, and
[`tldraw-client/`](tldraw-client/) for the example frontend.
