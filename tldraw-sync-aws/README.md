# tldraw-sync-aws

A horizontally scalable sync backend for [tldraw](https://tldraw.com), targeting **AWS (EKS + S3 + ElastiCache)**.

> This is the AWS demo. The GCP demo lives alongside it in [`../tldraw-sync-gcp`](../tldraw-sync-gcp); see the [repo README](../README.md) for how the two relate. The application layer is a deliberate copy of the GCP demo (`../tldraw-sync-gcp/tldraw-sync-gke/src`) — see [`../docs/adr/0001-duplicate-per-cloud-demos.md`](../docs/adr/0001-duplicate-per-cloud-demos.md).
>
> **Status:** the server, clients, and local verification are implemented and tested. Infrastructure-as-code (Terraform), Kubernetes manifests, and the deploy workflow are **not yet written** — see [Deployment](#deployment) for the intended target.

## What it does

The same Stateful Room Ownership model as the GCP demo:

- **One pod owns a room at a time**, enforced by a Redis lock (`lock:room:{roomId}`, 10s TTL, renewed every 5s).
- **Two-phase coordinated handover** over Redis pub/sub moves ownership safely when routing sends a client to a different pod; the outgoing owner persists the snapshot and only closes sockets (code `1013`) once the new owner reports ready. Full protocol in [`docs/coordinated-handover.md`](docs/coordinated-handover.md).
- **S3 holds all durable state**: room snapshots at `rooms/{roomId}` (throttled to every 10s) and user assets at `uploads/{id}`.
- **Graceful shutdown** on SIGTERM force-saves every active room and releases its lock.

Only the storage layer differs from the GCP demo: [`src/s3Storage.ts`](src/s3Storage.ts) replaces `gcsStorage.ts`, exposing the same four functions (`fetchRoomSnapshot`, `persistRoomSnapshot`, `handleAssetUpload`, `handleAssetDownload`). `roomManager.ts`, `index.ts`, `metrics.ts`, `unfurl.ts` and both clients are unchanged.

## HTTP / WebSocket surface

| Endpoint                             | Purpose                                        |
| ------------------------------------ | ---------------------------------------------- |
| `WS /api/connect/:roomId?sessionId=` | Join a room                                    |
| `POST\|GET /api/uploads/:uploadId`   | Asset upload / download (streamed via S3)      |
| `GET /api/unfurl?url=`               | Open Graph metadata for bookmark shapes        |
| `GET /api/health`                    | Health check                                   |
| `GET /metrics`                       | Prometheus metrics (incl. `tldraw_handover_*`) |

## Running locally

```bash
cp .env.example .env

docker run -d --name tldraw-redis -p 6379:6379 redis:7-alpine
docker run -d --name tldraw-minio -p 9000:9000 -p 9001:9001 \
  minio/minio server /data --console-address ":9001"

yarn install

# create the bucket (MinIO console is on http://localhost:9001, minioadmin/minioadmin)
export AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin
node -e 'const {S3Client,CreateBucketCommand}=require("@aws-sdk/client-s3");new S3Client({region:"us-east-1",endpoint:"http://localhost:9000",forcePathStyle:true}).send(new CreateBucketCommand({Bucket:"tldraw-test-bucket"}))'

yarn dev          # backend on http://localhost:3001
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
| `REDIS_URL`           | `redis://localhost:6379`         | Room locks + handover pub/sub (`rediss://` for TLS)      |
| `S3_BUCKET_NAME`      | — (required)                     | Bucket for `rooms/` snapshots and `uploads/` assets      |
| `AWS_REGION`          | `us-east-1`                      | S3 client region                                         |
| `S3_ENDPOINT`         | unset                            | Local emulator only (MinIO). Unset in production         |
| `S3_FORCE_PATH_STYLE` | `true` when `S3_ENDPOINT` is set | Path-style addressing, required by MinIO                 |
| `HOSTNAME`            | pod name                         | Pod identity for lock ownership (injected by Kubernetes) |
| `VITE_PUBLIC_API_URL` | `http://localhost:3001`          | Client-side: where the backend lives                     |

Credentials are never read by application code — the AWS SDK's default provider chain resolves them (IRSA in EKS, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or a profile locally).

## Verification

```bash
yarn build
cd tldraw-client && node verify-sync.mjs
```

Drives the real `TLSyncClient` against the local server: two clients join, a shape syncs A→B, an edit syncs B→A, the snapshot lands in S3, and a fresh client restores it from a cold room.

## Deployment

Not yet implemented. The intended target, mirroring the GCP demo:

| GCP demo                                   | AWS target                                       |
| ------------------------------------------ | ------------------------------------------------ |
| GKE                                        | EKS                                              |
| ingress-nginx (`upstream-hash-by: "$uri"`) | ingress-nginx behind an NLB, same annotation     |
| Memorystore Redis                          | ElastiCache for Redis, **cluster mode disabled** |
| GCS bucket                                 | S3 bucket                                        |
| Artifact Registry                          | ECR                                              |
| Workload Identity                          | IRSA (or EKS Pod Identity)                       |
| Google Managed Prometheus `PodMonitoring`  | AMP + `ServiceMonitor`                           |

Two constraints worth stating up front:

- **Room affinity needs consistent hashing on the request path.** ALB offers only per-client cookie stickiness, which would scatter clients of the same room across pods and make handover the steady state instead of the exception. Hence ingress-nginx behind an NLB — see [`../docs/adr/0002-nginx-ingress-on-eks-for-room-affinity.md`](../docs/adr/0002-nginx-ingress-on-eks-for-room-affinity.md).
- **ElastiCache cluster mode must stay disabled.** `roomManager.ts` uses four plain `createClient()` connections with global-channel pub/sub; cluster mode would require `createCluster()` and sharded pub/sub, i.e. a real code change.
