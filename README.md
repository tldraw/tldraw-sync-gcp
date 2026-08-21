# tldraw sync — cloud demos

Self-contained demos of a horizontally scalable [tldraw](https://tldraw.com) sync backend, one directory per cloud:

| Cloud                                  | Deployment targets                                        | Status                                                                                                              |
| -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`tldraw-sync-gcp/`](tldraw-sync-gcp/) | GKE, Compute Engine, Cloud Run — all on Memorystore + GCS | GKE deployed and benchmarked (~7,000 concurrent connections); the other two have Terraform but are not yet deployed |
| [`tldraw-sync-aws/`](tldraw-sync-aws/) | EKS + S3 (no Redis)                                       | Server, router, Helm chart and local verification; runs on `local-cluster`. EKS infra not yet written                |

GCP has three **deployment targets** because the interesting question — can the platform give you Room Affinity? — has three different answers. See [`tldraw-sync-gcp/README.md`](tldraw-sync-gcp/README.md) for the comparison.

## The shared design

Both demos implement **Stateful Room Ownership**. A room is a single live `TLSocketRoom` instance, so exactly one server instance may own it at a time. Durable state is object storage: a room snapshot written every 10s while the room is active, plus user assets uploaded through the server.

**The two demos now answer ownership differently**, and that is the most interesting thing in the repo.

**GCP — ownership is a lease, routing is a hint.** Ownership is a Redis lock (`lock:room:{roomId}`, 10s TTL, renewed every 5s). Routing is consistent-hashed on the request path (ingress-nginx `upstream-hash-by: "$uri"`), so clients of one room *normally* land on its owner. When they don't — the hash ring reshuffles on every scale event — a **two-phase coordinated handover** over Redis pub/sub moves ownership: the incoming pod asks for the room, the outgoing owner persists the snapshot and releases the lock, the incoming pod loads the snapshot and signals ready, and only then are the old sockets closed with `1013`. Written up in [`tldraw-sync-gcp/tldraw-sync-gke/docs/coordinated-handover.md`](tldraw-sync-gcp/tldraw-sync-gke/docs/coordinated-handover.md).

Whether routing can do that is a property of the deployment target, not of the server. Only two of GCP's three targets can: Google Cloud Load Balancing hashes a header or a cookie but never the request path, so Compute Engine runs its own nginx tier to get it back, and Cloud Run cannot get it at all and is pinned to a single instance. See [`docs/adr/0004-room-affinity-per-deployment-target.md`](docs/adr/0004-room-affinity-per-deployment-target.md).

**AWS — ownership is a record, routing resolves it.** There is no Redis. Ownership is one object per room in the same bucket that holds snapshots, written by conditional PUT with no lease and no delete; liveness is answered separately by a per-worker heartbeat that also replaces service discovery. A small **room-router** answers "which worker owns this room?", and Envoy asks it once per connection — **replacing ingress-nginx rather than sitting behind it**. Because routing resolves an authoritative record, a live worker never receives a connection for a room another live worker owns, so the handover protocol is deleted outright: ownership moves only when the previous owner is gone. See [`docs/adr/0005-room-ownership-in-the-bucket-routed-by-envoy.md`](docs/adr/0005-room-ownership-in-the-bucket-routed-by-envoy.md).

The difference is measurable. Scaling 2→3→4→3→2 with 24 active rooms, measuring what clients actually feel: **26 room moves and 26 disruptions on GCP-style hash routing, 0 and 0 on AWS.** Scaling up now disturbs nothing at all; scaling down disturbs only the rooms the terminating worker was really holding.

The demos share no code — see [`docs/adr/0001-duplicate-per-cloud-demos.md`](docs/adr/0001-duplicate-per-cloud-demos.md) for why, and [`docs/adr/0003-three-gcp-deployment-targets.md`](docs/adr/0003-three-gcp-deployment-targets.md) for why that extends to targets within a cloud. That ADR asked for the storage module to stay the *only* intentional difference, and named a second diverging file as the signal to revisit: `roomManager.ts` is now that file, and the routing tier diverges with it. Accepted while AWS leads; porting the design to GCP is when 0001 should be reopened rather than quietly ignored.

## Running them

Every target runs standalone from its own directory, with a local object-store emulator (fake-gcs-server for GCP, LocalStack for AWS). GCP also needs a local Redis; AWS does not need anything else. See [`tldraw-sync-gcp/README.md`](tldraw-sync-gcp/README.md) and [`tldraw-sync-aws/README.md`](tldraw-sync-aws/README.md).

To run **both demos in a local Kubernetes cluster** (k3d + Prometheus/Grafana, with GCP behind ingress-nginx and AWS behind Envoy, each wired the way its real deployment is), see [`local-cluster/`](local-cluster/). `make drill-aws` there measures room movement and client disruption across a scale cycle.

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
