# tldraw sync — cloud demos

Two self-contained demos of a horizontally scalable [tldraw](https://tldraw.com) sync backend, one per cloud:

| Demo                                   | Target                        | Status                                                       |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------------ |
| [`tldraw-sync-gcp/`](tldraw-sync-gcp/) | GKE + Memorystore Redis + GCS | Deployed, benchmarked (~7,000 concurrent connections)        |
| [`tldraw-sync-aws/`](tldraw-sync-aws/) | EKS + ElastiCache + S3        | Server + clients + local verification; infra not yet written |

## The shared design

Both demos implement the same **Stateful Room Ownership** model. A room is a single live `TLSocketRoom` instance, so exactly one pod may own it at a time; ownership is a Redis lock (`lock:room:{roomId}`, 10s TTL, renewed every 5s by the owner). Durable state is object storage: a room snapshot written every 10s while the room is active, plus user assets uploaded through the server.

Routing is consistent-hashed on the request path (ingress-nginx `upstream-hash-by: "$uri"`), so clients of one room normally land on that room's owner. When they don't — the hash ring reshuffles on every scale event — a **two-phase coordinated handover** over Redis pub/sub moves ownership: the incoming pod asks for the room, the outgoing owner persists the snapshot and releases the lock, the incoming pod loads the snapshot and signals ready, and only then are the old sockets closed with WebSocket code `1013` so clients reconnect into the new owner. The protocol is written up in [`tldraw-sync-gcp/docs/coordinated-handover.md`](tldraw-sync-gcp/docs/coordinated-handover.md).

The two demos share no code — see [`docs/adr/0001-duplicate-per-cloud-demos.md`](docs/adr/0001-duplicate-per-cloud-demos.md) for why. In practice `src/s3Storage.ts` vs `src/gcsStorage.ts` is the only application difference; everything else diverges only in infrastructure.

## Running them

Each demo runs standalone from its own directory, with a local Redis plus a local object-store emulator (fake-gcs-server for GCP, MinIO for AWS). See [`tldraw-sync-gcp/README.md`](tldraw-sync-gcp/README.md) and [`tldraw-sync-aws/README.md`](tldraw-sync-aws/README.md).

## Repo layout

```
.
├── CONTEXT.md                    # shared vocabulary
├── docs/adr/                     # decisions that span both demos
├── .github/workflows/            # CI lives here (GitHub only reads the root);
│                                 # deploy-gcp.yaml is path-filtered to tldraw-sync-gcp/
├── tldraw-sync-gcp/
└── tldraw-sync-aws/
```
