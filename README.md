# tldraw sync — cloud demos

Self-contained demos of a horizontally scalable [tldraw](https://tldraw.com) sync backend, one directory per cloud:

| Cloud                                  | Deployment targets                                        | Status                                                                                                              |
| -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`tldraw-sync-gcp/`](tldraw-sync-gcp/) | GKE, Compute Engine, Cloud Run — all on Memorystore + GCS | GKE deployed and benchmarked (~7,000 concurrent connections); the other two have Terraform but are not yet deployed |
| [`tldraw-sync-aws/`](tldraw-sync-aws/) | EKS + ElastiCache + S3                                    | Server + clients + local verification; infra not yet written                                                        |

GCP has three **deployment targets** because the interesting question — can the platform give you Room Affinity? — has three different answers. See [`tldraw-sync-gcp/README.md`](tldraw-sync-gcp/README.md) for the comparison.

## The shared design

Both demos implement the same **Stateful Room Ownership** model. A room is a single live `TLSocketRoom` instance, so exactly one pod may own it at a time; ownership is a Redis lock (`lock:room:{roomId}`, 10s TTL, renewed every 5s by the owner). Durable state is object storage: a room snapshot written every 10s while the room is active, plus user assets uploaded through the server.

Routing is consistent-hashed on the request path (ingress-nginx `upstream-hash-by: "$uri"`), so clients of one room normally land on that room's owner. When they don't — the hash ring reshuffles on every scale event — a **two-phase coordinated handover** over Redis pub/sub moves ownership: the incoming pod asks for the room, the outgoing owner persists the snapshot and releases the lock, the incoming pod loads the snapshot and signals ready, and only then are the old sockets closed with WebSocket code `1013` so clients reconnect into the new owner. The protocol is written up in [`tldraw-sync-gcp/tldraw-sync-gke/docs/coordinated-handover.md`](tldraw-sync-gcp/tldraw-sync-gke/docs/coordinated-handover.md).

Routing that way is a property of the deployment target, not of the server. Only two of the four targets can actually provide it: Google Cloud Load Balancing hashes a header or a cookie but never the request path, so the Compute Engine target runs its own nginx tier to get it back, and the Cloud Run target cannot get it at all and is pinned to a single instance. See [`docs/adr/0004-room-affinity-per-deployment-target.md`](docs/adr/0004-room-affinity-per-deployment-target.md).

The demos share no code — see [`docs/adr/0001-duplicate-per-cloud-demos.md`](docs/adr/0001-duplicate-per-cloud-demos.md) for why, and [`docs/adr/0003-three-gcp-deployment-targets.md`](docs/adr/0003-three-gcp-deployment-targets.md) for why that extends to targets within a cloud. In practice `src/s3Storage.ts` vs `src/gcsStorage.ts` is the only application difference anywhere; the three GCP copies are byte-identical and everything else diverges only in infrastructure.

## Running them

Every target runs standalone from its own directory, with a local Redis plus a local object-store emulator (fake-gcs-server for GCP, LocalStack for AWS). See [`tldraw-sync-gcp/README.md`](tldraw-sync-gcp/README.md) and [`tldraw-sync-aws/README.md`](tldraw-sync-aws/README.md).

To run **both demos in a local Kubernetes cluster** (k3d + ingress-nginx with production-style consistent-hash routing + Prometheus/Grafana), see [`local-cluster/`](local-cluster/).

## Repo layout

```
.
├── CONTEXT.md                    # shared vocabulary
├── docs/adr/                     # decisions that span the demos
├── .github/workflows/            # CI lives here (GitHub only reads the root);
│                                 # deploy-gke.yaml is path-filtered to the GKE target
├── tldraw-sync-gcp/
│   ├── tldraw-sync-gke/
│   ├── tldraw-sync-compute-engine/
│   └── tldraw-sync-cloud-run/
└── tldraw-sync-aws/
```
