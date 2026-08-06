# Local k3s setup for both sync demos

**Date:** 2026-08-06
**Status:** Approved

## Goal

A local k3s cluster that mirrors the real deployments (GKE + Memorystore + GCS, EKS + ElastiCache + S3) as closely as possible, running both demos side by side. The cluster is the foundation for a later spec: k6 load tests that measure availability while pods scale up and down.

## Decisions made during brainstorming

- **Both demos** run in one cluster, in separate namespaces, mirroring their real independence (separate Redis, separate buckets).
- **k3d** (k3s in Docker) hosts the cluster: fast to recreate, scriptable, and multi-node so scaling crosses real node boundaries.
- **Helm charts for everything**, one chart per demo, living inside each demo's directory. Charts are values-gated so the same chart can later target EKS/GKE with real cloud services.
- **Monitoring is in scope** (Prometheus + Grafana); k6 itself is not.

## Repo layout

```
tldraw-sync-aws/
└── chart/                  # Helm chart: app + Redis + MinIO (values-gated)
tldraw-sync-gcp/
└── chart/                  # Helm chart: app + Redis + fake-gcs-server (values-gated)
local-cluster/
├── Makefile                # cluster up/down, image build+import, deploy, verify
├── k3d-config.yaml         # 1 server + 3 agents, host port 8080 → ingress
├── ingress-nginx-values.yaml
└── monitoring-values.yaml  # kube-prometheus-stack values
```

Only what both demos genuinely share (cluster, ingress, monitoring) lives in `local-cluster/`. The GCP demo's existing `kubernetes/` manifests are the deployed GKE reference and stay untouched; its chart is templated from them.

## Cluster topology

- k3d cluster: 1 server + 3 agent nodes, so pods spread across nodes and scaling triggers genuine cross-node Handovers.
- k3s's bundled Traefik is disabled (`--disable=traefik`); ingress-nginx is installed from its upstream chart — the controller both real targets use (ADR 0002).
- Namespaces: `tldraw-aws`, `tldraw-gcp`, `ingress-nginx`, `monitoring`.
- Images are built from each demo's existing Dockerfile and loaded with `k3d image import`; no external registry.
- Flow: `make cluster` → `make deploy-aws` / `make deploy-gcp`.

## Per-demo Helm charts

Each chart is a complete standalone stack.

**App resources**

- Deployment: default 2 replicas; resource requests/limits; `HOSTNAME` from the pod name (Pod Identity for Room Locks); readiness/liveness probes on `/api/health`; `terminationGracePeriodSeconds: 60` so graceful shutdown has time to force-save Rooms and release locks.
- Service, Ingress (see routing below), and a PodMonitor for `/metrics`, adapted from `tldraw-sync-gcp/kubernetes/pod-monitor.yaml`.

**Values-gated dependencies (cloud portability)**

- `redis.enabled: true` locally → single-instance Redis (Bitnami subchart, no persistence — locks and pub/sub are ephemeral by design). On EKS/GKE: `redis.enabled: false` + `redisUrl` pointing at ElastiCache/Memorystore.
- `emulator.enabled: true` locally → MinIO (AWS chart) or fake-gcs-server (GCP chart), plus a one-shot Job that creates the bucket. On real clouds: `emulator.enabled: false`; the SDK default credential chain (IRSA / Workload Identity) resolves credentials, as the app already expects.

**Config surface** mirrors each demo's `.env.example`, injected as env vars: `REDIS_URL`, `S3_BUCKET_NAME` / `S3_ENDPOINT` / `S3_FORCE_PATH_STYLE` (AWS) or the GCS equivalents (GCP). Emulator credentials (`minioadmin` etc.) are chart defaults, used only in emulator mode.

## Ingress and routing

Room Affinity drives everything the load tests will measure, so routing must match production:

- Each Ingress carries the production annotation `nginx.ingress.kubernetes.io/upstream-hash-by: "$uri"`, so all Sessions of a Room hash to one pod, and scaling reshuffles the ring — exercising the coordinated Handover exactly as a real scale event does.
- WebSocket-friendly timeouts: `proxy-read-timeout` / `proxy-send-timeout` raised well above defaults for long-lived sync connections.
- Host-based separation: `aws.localhost:8080` and `gcp.localhost:8080` (both resolve to 127.0.0.1 on macOS, no `/etc/hosts` edits). The ingress controller is exposed via k3d's port mapping on host port 8080.
- tldraw clients run on the host (`npm run dev`) with `VITE_PUBLIC_API_URL` pointed at those URLs; they are dev tools, not cluster workloads.

## Monitoring

- **kube-prometheus-stack** in the `monitoring` namespace, trimmed for local use: short retention, no Alertmanager, no persistence.
- Prometheus discovers each demo's PodMonitor automatically, surfacing the apps' existing metrics — including `tldraw_handover_*` — per pod.
- ingress-nginx controller metrics are enabled: request and upgrade error rates at the ingress are the client's-eye availability signal.
- Grafana at `grafana.localhost:8080` with one provisioned dashboard, **"tldraw scaling"**: active rooms and sessions per pod, handover counts and durations, WebSocket reconnects (code 1013 closures), pod count, ingress 5xx/connection errors. This is the dashboard to watch while k6 runs and pods scale.
- No app code or metrics changes in this spec. Missing metrics discovered during load testing are follow-ups.

## Verification

- `make verify-aws` / `make verify-gcp`: run each demo's existing `verify-sync.mjs` from the host against the ingress URL — two clients join a Room, shapes sync both ways, the Snapshot lands in MinIO/fake-gcs, a cold Room restores it.
- Manual handover drill (documented in the README): open a Room, `kubectl scale deployment` 2→3, confirm on the Grafana dashboard that a Handover occurred and the client reconnected. This is the drill the future k6 spec automates.

## Failure modes

- **Pod killed mid-ownership:** Redis lock TTL (10s) expires and another pod claims the Room. Nothing local-specific; the dashboard makes it observable.
- **Emulator restarts lose data:** accepted — MinIO/fake-gcs run without persistent volumes; Snapshots are disposable locally. A values toggle can add a PVC later if needed.
- **Image drift:** `make deploy-*` always rebuilds and re-imports the image before upgrading the release, so the cluster never silently runs a stale build.
- **Host port collisions:** the single mapped port (8080) is defined once in `k3d-config.yaml`.

## Out of scope

- k6 scenarios and the scaling/availability test harness (next spec, once this cluster exists).
- App code or metrics changes.
- Real EKS/GKE values files — the charts support them by design, but writing and testing those values is future work.
- CI integration.
