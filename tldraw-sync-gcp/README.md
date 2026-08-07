# tldraw sync on GCP — three deployment targets

One server, three ways to run it.

| Target                                                       | Compute                  | Room Affinity                              | Status                                                |
| ------------------------------------------------------------ | ------------------------ | ------------------------------------------ | ----------------------------------------------------- |
| [`tldraw-sync-gke/`](tldraw-sync-gke/)                       | GKE + ingress-nginx      | **Strong** — consistent hash on `$uri`     | Deployed, benchmarked (~7,000 concurrent connections) |
| [`tldraw-sync-compute-engine/`](tldraw-sync-compute-engine/) | COS VMs + own nginx tier | **Strong** — same mechanism, your own tier | Terraform written, not yet deployed                   |
| [`tldraw-sync-cloud-run/`](tldraw-sync-cloud-run/)           | Cloud Run                | **None** — single instance by necessity    | Terraform written, not yet deployed                   |

All three run **the same server**, and each directory holds its own complete
copy of it. Nothing in the application changes between targets: `PORT` comes
from the environment, the listener binds all interfaces, GCS uses Application
Default Credentials, and the container image is identical. What differs is
packaging, infrastructure, and what the platform can and cannot do for you.

Why copies rather than one shared package:
[`../docs/adr/0003-three-gcp-deployment-targets.md`](../docs/adr/0003-three-gcp-deployment-targets.md).

## The variable that matters: Room Affinity

A Room is one live in-memory document, so exactly one instance may own it at a
time. Ownership is a **Room Lock** in Redis. **Room Affinity** is the separate,
weaker property that routing sends every Session of a Room to that Room's owner
— it does not establish ownership, it only decides how often you pay for a
**Handover**.

It has to be a function of the `roomId`. The GKE target gets that from
ingress-nginx:

```yaml
nginx.ingress.kubernetes.io/upstream-hash-by: "$uri"
```

`$uri` is `/api/connect/<roomId>`, and a client cannot fail to send it.

**Google Cloud Load Balancing cannot do this.** Its affinity options hash a
header or a cookie, never the request path. Each target answers that differently,
and the answers are what make them worth comparing:

- **Compute Engine** runs its own nginx tier and hashes `$uri` exactly as GKE
  does. No client change, no cookie, no same-origin constraint. The price is a
  fixed-size app tier, because consistent hashing needs a static upstream list.
- **Cloud Run** cannot have it at all. Its session affinity is keyed on the
  _client_, and it exposes no per-instance addressing, so nginx cannot help
  either — it would have exactly one upstream. Above one instance a Room
  **livelocks**: each reconnect lands on a non-owner, forces a Handover, evicts
  everyone, and they reconnect straight back. So that target ships pinned to one
  instance, with the mechanism written out in its README.

The full reasoning, including the alternatives rejected, is in
[`../docs/adr/0004-room-affinity-per-deployment-target.md`](../docs/adr/0004-room-affinity-per-deployment-target.md).

## Choosing between them

|                | **GKE**                                   | **Compute Engine**                            | **Cloud Run**                 |
| -------------- | ----------------------------------------- | --------------------------------------------- | ----------------------------- |
| Room Affinity  | strong, server-side                       | strong, server-side                           | none                          |
| Shutdown grace | configurable (30s default)                | **~90s** — the most generous                  | **fixed 10s**, no knob        |
| Autoscaling    | HPA on CPU                                | none by design; resize and re-apply           | platform-managed, capped at 1 |
| TLS + domain   | your own cert and ingress config          | domain **required** for a managed cert        | **free** — `*.run.app`        |
| Cold start     | low, image cached on the node             | highest — boot plus `docker pull`             | lowest, with a warm instance  |
| Ops burden     | highest — cluster plus ingress controller | medium                                        | lowest                        |
| Verdict        | the reference implementation              | best operational properties for this workload | honest anti-example           |

A note on autoscaling: the GKE target's HPA scales on CPU, which is the wrong
signal for a WebSocket fan-out server — idle Sessions cost almost no CPU, so you
hit connection limits long before a CPU threshold. Neither new target inherits
that mistake.

## Layout

```
tldraw-sync-gcp/
├── tldraw-sync-gke/             # server + kubernetes/ + infra-terraform/ + docs/
├── tldraw-sync-compute-engine/  # server + infra-terraform/ (nginx tier, COS VMs)
└── tldraw-sync-cloud-run/       # server + infra-terraform/ (Cloud Run service)
```

Each target contains `src/`, `test/`, `Dockerfile`, `tldraw-client/`,
`examples/minimal-frontend/`, `stress-test/` and `scripts/`, so it stands alone.

## Running one locally

The server does not know which target it is in, so this is the same everywhere:

```bash
cd tldraw-sync-gke        # or either sibling
cp .env.example .env
docker run -d -p 6379:6379 redis
yarn install
yarn dev
```

[`tldraw-sync-gke/README.md`](tldraw-sync-gke/README.md) has the full local
setup, including the GCS emulator and the example client.

## Sharing one substrate

Each target provisions its own VPC, Memorystore instance, GCS bucket and
Artifact Registry repository by default, so it deploys end-to-end from a single
apply. Memorystore is the dominant line item, so running all three that way
means paying for it three times. Every target takes `create_substrate = false`
plus `existing_*` variables to attach to a substrate that already exists.

Doing that unlocks the clearest demonstration here: point two targets at one
Redis and open the same room against both. The second connection triggers a
**Handover across deployment targets** — a GKE pod hands the Room to a COS VM,
live, because Room Ownership is a property of the Room Lock and not of the
platform.
