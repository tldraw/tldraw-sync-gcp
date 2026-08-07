# local-cluster

A local Kubernetes cluster that runs both tldraw sync demos — [`tldraw-sync-aws`](../tldraw-sync-aws/) and [`tldraw-sync-gcp`](../tldraw-sync-gcp/) — side by side, wired up the same way as their real EKS/GKE deployments: ingress-nginx with production-style consistent-hash routing, and Prometheus/Grafana watching pod counts, handovers, and 5xx rate. It exists so you can watch **availability during scaling** on a laptop — scale a deployment up or down and see the coordinated handover happen on a dashboard — without touching real cloud infrastructure. It's also the foundation the future k6 load-testing spec will automate. See the design doc: [`../docs/superpowers/specs/2026-08-06-local-k3s-setup-design.md`](../docs/superpowers/specs/2026-08-06-local-k3s-setup-design.md).

## Prerequisites

- Docker (running)
- [k3d](https://k3d.io/) ≥ 5.6
- Helm 3 or later
- kubectl
- Node 20+ (for the demo clients and verification scripts)

Both demos are reached through `*.localhost` hostnames (`aws.localhost:8080`, `gcp.localhost:8080`, `grafana.localhost:8080`). Most systems resolve `*.localhost` to `127.0.0.1` natively, so this usually needs no setup. If `curl http://aws.localhost:8080` fails to resolve, add the hosts explicitly:

```bash
echo '127.0.0.1 aws.localhost gcp.localhost grafana.localhost' | sudo tee -a /etc/hosts
```

## Quickstart

```bash
cd local-cluster
make cluster          # k3d + CRDs + ingress-nginx
make monitoring       # Prometheus + Grafana + dashboard
make deploy-aws       # AWS demo -> http://aws.localhost:8080
make deploy-gcp       # GCP demo -> http://gcp.localhost:8080
make verify-aws verify-gcp
```

Grafana is at `http://grafana.localhost:8080` (login `admin` / `tldraw`); the "tldraw scaling" dashboard is provisioned automatically.

To point a real tldraw client at a running demo instead of using `make verify-*`:

```bash
cd ../tldraw-sync-aws/tldraw-client && VITE_PUBLIC_API_URL=http://aws.localhost:8080 npm run dev
```

(swap `aws` for `gcp` and the path for `../tldraw-sync-gcp/tldraw-client` to hit the other demo).

## The handover drill

This is the manual version of the availability check the future k6 spec will automate: scale a demo's deployment and confirm clients survive the handover with no sustained errors.

A handover is triggered by a *new* connection request landing on a pod that doesn't own the room — it isn't something that happens automatically to a socket that's already open. So the drill needs a room that (a) stays open across the scale event and (b) gets a fresh connection afterwards (a second client joining, or the first client reconnecting):

1. Point a client at `http://aws.localhost:8080` (see Quickstart above), open a document, and leave the tab open — this is the room's one connection. (`make verify-aws` alone won't leave anything to hand over: its two clients disconnect as soon as the script finishes, which releases the room immediately.)
2. Open the Grafana dashboard **tldraw scaling** (`http://grafana.localhost:8080`).
3. Scale the AWS deployment up:
   ```bash
   kubectl --context k3d-tldraw-local -n tldraw-aws scale deployment tldraw-aws-app --replicas=3
   ```
4. Open a second tab on the same room URL (or refresh the first tab). This new connection is what actually triggers the handover — only the ingress's *next* request for that room routes against the reshuffled hash ring. Not every room moves on every scale event: with 2→3 replicas, roughly a third of rooms hash to the new pod, so if nothing moves, retry with another room or another replica bump.
5. Watch the dashboard: **"App replicas available"** steps 2→3 for `tldraw-aws`; **"Handover rate (req / success / timeout)"** ticks up on requested/succeeded (the old owner saves a snapshot, releases the lock, and the new owner signals ready); the original tab's socket closes with WebSocket code `1013` and reconnects into the new owner; **"Ingress 5xx rate by host"** stays flat throughout.
6. Scale back down and repeat step 4 (a fresh connection) to watch the same in reverse:
   ```bash
   kubectl --context k3d-tldraw-local -n tldraw-aws scale deployment tldraw-aws-app --replicas=2
   ```

If you can't have a browser open on Grafana, the same signals are queryable straight from Prometheus (port-forward `svc/monitoring-kube-prometheus-prometheus` 9090 and pass `-g`/`--globoff` to curl since the query URLs contain `{}`):

```bash
kubectl --context k3d-tldraw-local -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090 &
curl -sg 'http://localhost:9090/api/v1/query?query=kube_deployment_status_replicas_available{deployment="tldraw-aws-app"}'
curl -sg 'http://localhost:9090/api/v1/query?query=tldraw_handover_requests_total{namespace="tldraw-aws"}'
curl -sg 'http://localhost:9090/api/v1/query?query=tldraw_handover_success_total{namespace="tldraw-aws"}'
```

Handover metrics only appear once a handover has actually fired — an idle deployment with no active rooms can scale up and down without one, since there's no room ownership to move.

**If handovers never succeed** (requests tick up but success stays at 0 and every attempt times out), suspect a pod whose Redis connection raced the Redis pod's own startup: check `kubectl -n tldraw-aws logs <pod> | grep Redis` for `ECONNREFUSED` around startup. The client's TCP connection auto-reconnects, but the handover pub/sub subscription doesn't re-establish itself, so that pod silently never hears handover requests for rooms it owns. `kubectl --context k3d-tldraw-local -n tldraw-aws rollout restart deployment tldraw-aws-app` gets every pod a clean subscription. This is rare on a fresh `make cluster && make monitoring && make deploy-aws` run (Redis is already up by the time the app deploys) — it mainly shows up on long-uptime dev clusters that outlive a Redis pod restart.

## Teardown

```bash
make cluster-down
```

Deletes the k3d cluster and everything in it.

## Cloud values

Locally, each chart runs its own Redis and object-store emulator (`redis.enabled=true`, `emulator.enabled=true`). Pointed at a real cloud, the same chart runs unmodified against managed services by flipping those gates: `redis.enabled=false` with `redis.url=<managed redis>`, and `emulator.enabled=false` so the app's default AWS/GCP credential chain (IRSA / Workload Identity) takes over. Writing and testing the actual EKS/GKE values files is future work — see the design doc's "Out of scope".
