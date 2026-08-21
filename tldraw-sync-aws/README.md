# tldraw-sync-aws

A horizontally scalable sync backend for [tldraw](https://tldraw.com), targeting **AWS (EKS + S3)**. No Redis: Room ownership and worker membership live in the same bucket as Snapshots.

> This is the AWS demo. The GCP demo lives alongside it in [`../tldraw-sync-gcp`](../tldraw-sync-gcp); see the [repo README](../README.md) for how the two relate.
>
> **The AWS demo has diverged from the GCP one.** It was a copy with `s3Storage.ts` swapped in ([ADR 0001](../docs/adr/0001-duplicate-per-cloud-demos.md)); `roomManager.ts` and the whole routing tier are now materially different ([ADR 0005](../docs/adr/0005-room-ownership-in-the-bucket-routed-by-envoy.md)).
>
> **Status:** server, router, clients, Helm chart and local verification are implemented and tested, and the stack runs on `local-cluster`. Infrastructure-as-code (Terraform) and the EKS deploy workflow are **not yet written** — see [Deployment](#deployment).

## What it does

Stateful Room Ownership, with **the bucket as the only coordination store**:

- **One worker owns a Room at a time**, recorded at `owners/{roomId}` and written by conditional PUT — `If-None-Match: *` to claim, `If-Match: <etag>` to reallocate or vacate. No lease, no renewal, no delete.
- **Which workers exist** is `members/{addr}`, written unconditionally on a 2s heartbeat and read by one `LIST` on a 2s poll; entries older than 8s are dead. This replaces service discovery entirely — nothing queries the Kubernetes API or DNS.
- **Routing resolves ownership, it does not guess it.** A small stateless service, the **room-router**, answers "which worker owns this Room?". Envoy asks it via `ext_authz` and routes the WebSocket through an `ORIGINAL_DST` cluster; **Envoy replaces ingress-nginx rather than sitting behind it.** On Cloud Run and in local Docker the same decision is wrapped in a proxy that splices the sockets itself.
- **S3 holds all durable state**: Snapshots at `rooms/{roomId}` (throttled to every 10s) and assets at `uploads/{id}`.
- **There is no coordinated handover.** Ownership moves only when the previous owner is gone, which needs no cross-worker signalling — see [`docs/drain-and-reclaim.md`](docs/drain-and-reclaim.md).

How this design was arrived at, which alternatives were measured, and what the numbers were: [`docs/approaches-and-measurements.md`](docs/approaches-and-measurements.md).

Measured on `local-cluster` across a 2→3→4→3→2 scale cycle with 24 Rooms: **26 Room moves and 26 client disruptions under the old hash routing, 0 and 0 now.** Scaling up disturbs nothing; scaling down disturbs only the Rooms the terminating worker actually held.

## HTTP / WebSocket surface

| Endpoint                             | Purpose                                        |
| ------------------------------------ | ---------------------------------------------- |
| `WS /api/connect/:roomId?sessionId=` | Join a room                                    |
| `POST\|GET /api/uploads/:uploadId`   | Asset upload / download (streamed via S3)      |
| `GET /api/unfurl?url=`               | Open Graph metadata for bookmark shapes        |
| `GET /api/health`                    | Health check                                   |
| `GET /metrics`                       | Prometheus metrics (incl. `tldraw_room_*`)     |

## Running locally

```bash
cp .env.example .env

docker run -d --name tldraw-localstack -p 4566:4566 localstack/localstack:4.14.0

yarn install

# create the bucket (LocalStack accepts any credentials; "test" is its convention)
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
docker exec tldraw-localstack awslocal s3 mb s3://tldraw-test-bucket

yarn dev          # a worker on http://localhost:3001
```

A single worker needs no router: it claims Rooms itself when the record is absent, which is the same code path that runs with a router in front. For multi-worker routing, run the router too:

```bash
yarn dev:router   # proxy mode on http://localhost:8080
```

Then a client:

```bash
cd tldraw-client && npm install && npm run dev    # http://localhost:5173
# or the ~100-line reference client:
cd examples/minimal-frontend && npm install && npm run dev
```

## Configuration

| Variable              | Default                          | Purpose                                                  |
| --------------------- | -------------------------------- | -------------------------------------------------------- |
| `PORT`                | `3001`                           | HTTP/WebSocket listen port                               |
| `S3_BUCKET_NAME`      | — (required)                     | Bucket for `rooms/`, `uploads/`, `owners/` and `members/` |
| `AWS_REGION`          | `us-east-1`                      | S3 client region                                         |
| `S3_ENDPOINT`         | unset                            | Local emulator only (LocalStack). Unset in production    |
| `S3_FORCE_PATH_STYLE` | `true` when `S3_ENDPOINT` is set | Path-style addressing, required by the emulator          |
| `ADVERTISE_ADDR`      | primary IPv4 + `PORT`            | Owner Identity — a dialable URL, written to both `owners/` and `members/` |
| `ROUTER_MODE`         | `proxy`                          | Router only: `proxy` splices WebSockets, `ext-authz` answers Envoy |
| `HEARTBEAT_INTERVAL_MS` | `2000`                         | How often a worker refreshes its membership record       |
| `MEMBER_POLL_INTERVAL_MS` | `2000`                       | How often a router re-reads `members/`                   |
| `MEMBER_TTL_MS`       | `8000`                           | Age at which a member is dead. Four missed beats — see the design doc for why not six |
| `OWNERSHIP_RECHECK_INTERVAL_MS` | `5000`                 | How often an owner re-reads its own records              |
| `VITE_PUBLIC_API_URL` | `http://localhost:3001`          | Client-side: where the backend lives                     |

Credentials are never read by application code — the AWS SDK's default provider chain resolves them (IRSA in EKS, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or a profile locally).

## Verification

```bash
yarn build
cd tldraw-client && node verify-sync.mjs
```

Drives the real `TLSyncClient` against the local server: two clients join, a shape syncs A→B, an edit syncs B→A, the snapshot lands in S3, and a fresh client restores it from a cold room.

To measure what a client feels while the deployment scales — Rooms moved, Sessions disrupted, recovery time — use the scale drill against a running `local-cluster`:

```bash
cd ../../local-cluster && make drill-aws
```

## Deployment

Not yet implemented. The intended target, mirroring the GCP demo:

| GCP demo                                   | AWS target                                       |
| ------------------------------------------ | ------------------------------------------------ |
| GKE                                        | EKS                                              |
| ingress-nginx (`upstream-hash-by: "$uri"`) | **Envoy + room-router behind an NLB** (no ingress controller) |
| Memorystore Redis                          | **nothing — ownership is in the bucket**         |
| GCS bucket                                 | S3 bucket                                        |
| Artifact Registry                          | ECR                                              |
| Workload Identity                          | IRSA (or EKS Pod Identity)                       |
| Google Managed Prometheus `PodMonitoring`  | AMP + `ServiceMonitor`                           |

Two constraints worth stating up front:

- **Worker addresses must be routable from the router**, which dials them verbatim with no load balancer in between. The VPC CNI gives Pod IPs that are reachable from any pod with no extra configuration, so EKS satisfies this natively. Keep the ClusterIP Service for `kubectl port-forward` and the PodMonitor; it is no longer on the request path.
- **The router needs bucket permissions of its own** — `s3:GetObject`, `s3:PutObject` and `s3:ListBucket` on `owners/*` and `members/*`. Workers need those plus the existing `rooms/*` and `uploads/*`. Same IRSA mechanism as before.

[ADR 0002](../docs/adr/0002-nginx-ingress-on-eks-for-room-affinity.md), which chose ingress-nginx because ALB and NLB cannot hash on the request path, is superseded: affinity now comes from a record rather than a hash, so nothing needs to hash anything.
