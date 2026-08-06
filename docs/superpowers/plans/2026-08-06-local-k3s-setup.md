# Local k3s Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local k3d cluster running both tldraw sync demos behind ingress-nginx with production-faithful consistent-hash routing, plus Prometheus + Grafana monitoring, per the spec at `docs/superpowers/specs/2026-08-06-local-k3s-setup-design.md`.

**Architecture:** One k3d cluster (1 server + 3 agents), one Helm chart per demo living at `tldraw-sync-aws/chart/` and `tldraw-sync-gcp/chart/`, each chart a complete stack (app + Redis + storage emulator, values-gated for later EKS/GKE use). Shared infra (cluster config, ingress-nginx, kube-prometheus-stack, Makefile) lives in `local-cluster/`. **Deviation from spec:** Redis and the emulators are plain in-chart templates using official images (`redis:7-alpine`, `minio/minio`, `fsouza/fake-gcs-server`) instead of Bitnami subcharts — the Bitnami public catalog was moved/deprecated in 2025 and these are the exact images the demos' READMEs already use for local dev. The values-gating (`redis.enabled`, `emulator.enabled`) is unchanged.

**Tech Stack:** k3d ≥ 5.6, Helm 3, kubectl, Docker, ingress-nginx (upstream chart), kube-prometheus-stack + prometheus-operator-crds (prometheus-community charts), Node 20 + the demos' existing `verify-sync.mjs`.

## Global Constraints

- Cluster name: `tldraw-local`; kube context: `k3d-tldraw-local`. All kubectl/helm calls in the Makefile must pass `--context`/`--kube-context` explicitly.
- Namespaces: `tldraw-aws`, `tldraw-gcp`, `ingress-nginx`, `monitoring`.
- Hosts: `aws.localhost`, `gcp.localhost`, `grafana.localhost`, all on host port `8080`.
- Ingress annotations, exactly as production (ADR 0002 / GKE manifests): `nginx.ingress.kubernetes.io/upstream-hash-by: "$uri"`, `proxy-read-timeout: "3600"`, `proxy-send-timeout: "3600"`.
- App listens on port 3001; health at `/api/health`; metrics at `/metrics`. Bucket name default: `tldraw-test-bucket`.
- `terminationGracePeriodSeconds: 60` on both app Deployments (spec).
- App Deployments default to 2 replicas.
- Charts must stay cloud-portable: `redis.enabled: false` + `redis.url` must swap in an external Redis; `emulator.enabled: false` must remove the emulator, its credentials env vars, and the bucket-create Job.
- Emulator credentials: `minioadmin`/`minioadmin` (MinIO defaults). fake-gcs-server is unauthenticated.
- No changes to app source code, the GCP demo's existing `kubernetes/` manifests, or CI.
- Makefile recipes must be indented with real tabs.
- Helm chart versions are unpinned (local-only tooling); if drift ever breaks the setup, pinning is the fix, not vendoring.
- `.localhost` subdomains may not resolve via macOS getaddrinfo. Task 1 checks this and, if needed, documents the one-line `/etc/hosts` fix. Do not assume browser behavior (browsers resolve `*.localhost` internally; curl/node may not).

---

### Task 1: k3d cluster + ingress-nginx foundation

**Files:**
- Create: `local-cluster/k3d-config.yaml`
- Create: `local-cluster/ingress-nginx-values.yaml`
- Create: `local-cluster/Makefile`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `make cluster` / `make cluster-down` targets; a running cluster with context `k3d-tldraw-local`, prometheus-operator CRDs (so later PodMonitors/ServiceMonitors apply cleanly), and ingress-nginx serving host port 8080 with ingressClass `nginx`. Makefile variables later tasks extend: `CLUSTER_NAME`, `KUBE_CONTEXT`, `KUBECTL`, `HELM`.

- [ ] **Step 1: Verify prerequisites exist**

Run: `k3d version && helm version --short && docker info --format '{{.ServerVersion}}' && kubectl version --client`
Expected: all four print versions. If k3d is missing: `brew install k3d`.

- [ ] **Step 2: Write the k3d config**

`local-cluster/k3d-config.yaml`:

```yaml
apiVersion: k3d.io/v1alpha5
kind: Simple
metadata:
  name: tldraw-local
servers: 1
agents: 3
ports:
  # host 8080 -> k3d loadbalancer :80 -> svclb -> ingress-nginx controller
  - port: 8080:80
    nodeFilters:
      - loadbalancer
options:
  k3s:
    extraArgs:
      # ingress-nginx replaces the bundled Traefik (parity with GKE/EKS, ADR 0002)
      - arg: "--disable=traefik"
        nodeFilters:
          - server:*
```

- [ ] **Step 3: Write the ingress-nginx values**

`local-cluster/ingress-nginx-values.yaml`:

```yaml
controller:
  metrics:
    enabled: true
    serviceMonitor:
      enabled: true
  # LoadBalancer type is default; k3s svclb binds :80/:443 on nodes,
  # which the k3d loadbalancer forwards to (see k3d-config.yaml ports).
```

- [ ] **Step 4: Write the Makefile with cluster targets**

`local-cluster/Makefile`:

```make
CLUSTER_NAME := tldraw-local
KUBE_CONTEXT := k3d-$(CLUSTER_NAME)
KUBECTL      := kubectl --context $(KUBE_CONTEXT)
HELM         := helm --kube-context $(KUBE_CONTEXT)
# New tag per deploy so pods always roll onto the freshly imported image.
# ':=' (immediate) so build and helm --set see the SAME timestamp; still
# overridable from the command line: make deploy-aws IMAGE_TAG=mytag
IMAGE_TAG    := $(shell date +%Y%m%d%H%M%S)

.PHONY: cluster cluster-down

cluster: ## Create the k3d cluster with prometheus CRDs and ingress-nginx
	k3d cluster create --config k3d-config.yaml --wait
	helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update
	helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update
	helm repo update prometheus-community ingress-nginx
	$(HELM) upgrade --install prometheus-operator-crds prometheus-community/prometheus-operator-crds
	$(HELM) upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
		--namespace ingress-nginx --create-namespace \
		-f ingress-nginx-values.yaml --wait --timeout 5m

cluster-down: ## Delete the k3d cluster
	k3d cluster delete $(CLUSTER_NAME)
```

- [ ] **Step 5: Run it and verify the cluster**

Run: `cd local-cluster && make cluster`
Expected: exits 0. Then:

Run: `kubectl --context k3d-tldraw-local get nodes`
Expected: 4 nodes (1 `k3d-tldraw-local-server-0`, 3 agents), all `Ready`.

Run: `kubectl --context k3d-tldraw-local get pods -n ingress-nginx`
Expected: `ingress-nginx-controller-...` is `Running`, and no Traefik pods exist in `kube-system` (`kubectl --context k3d-tldraw-local get pods -n kube-system | grep -i traefik` prints nothing).

- [ ] **Step 6: Verify ingress reachability and host resolution**

Run: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080`
Expected: `404` (nginx default backend — controller reachable, no Ingress yet).

Run: `curl -s -o /dev/null -w '%{http_code}\n' http://aws.localhost:8080`
Expected: `404`. If instead curl reports `Could not resolve host`, append the hosts entries and re-check:

```bash
echo '127.0.0.1 aws.localhost gcp.localhost grafana.localhost' | sudo tee -a /etc/hosts
```

Record which path was needed — Task 7 documents it in the README.

- [ ] **Step 7: Verify idempotency of cluster-down/up**

Run: `make cluster-down && make cluster`
Expected: both succeed; cluster is recreated cleanly.

- [ ] **Step 8: Commit**

```bash
git add local-cluster/k3d-config.yaml local-cluster/ingress-nginx-values.yaml local-cluster/Makefile
git commit -m "feat(local-cluster): k3d cluster with ingress-nginx and prometheus CRDs"
```

---

### Task 2: Monitoring stack (kube-prometheus-stack)

**Files:**
- Create: `local-cluster/monitoring-values.yaml`
- Modify: `local-cluster/Makefile` (add `monitoring` target)

**Interfaces:**
- Consumes: `make cluster` (Task 1) — CRDs and ingress-nginx must exist.
- Produces: `make monitoring` target; Prometheus (release name `monitoring`, namespace `monitoring`) that scrapes **all** PodMonitors/ServiceMonitors cluster-wide; Grafana at `http://grafana.localhost:8080` (admin / `tldraw`), with the dashboard sidecar watching for ConfigMaps labeled `grafana_dashboard: "1"` (Task 6 uses this).

- [ ] **Step 1: Write the monitoring values**

`local-cluster/monitoring-values.yaml`:

```yaml
alertmanager:
  enabled: false

prometheus:
  prometheusSpec:
    retention: 24h
    # Select every PodMonitor/ServiceMonitor in the cluster, regardless of
    # release labels — the app charts' monitors live in other namespaces.
    podMonitorSelectorNilUsesHelmValues: false
    serviceMonitorSelectorNilUsesHelmValues: false

grafana:
  adminPassword: tldraw
  ingress:
    enabled: true
    ingressClassName: nginx
    hosts:
      - grafana.localhost
  sidecar:
    dashboards:
      enabled: true
      label: grafana_dashboard
      searchNamespace: monitoring
```

- [ ] **Step 2: Add the Makefile target**

Append to `local-cluster/Makefile` (add `monitoring` to `.PHONY`):

```make
monitoring: ## Install Prometheus + Grafana (kube-prometheus-stack)
	$(HELM) upgrade --install monitoring prometheus-community/kube-prometheus-stack \
		--namespace monitoring --create-namespace \
		-f monitoring-values.yaml --wait --timeout 10m
```

- [ ] **Step 3: Install and verify pods**

Run: `cd local-cluster && make monitoring`
Expected: exits 0. Then:

Run: `kubectl --context k3d-tldraw-local get pods -n monitoring`
Expected: prometheus, grafana, kube-state-metrics, node-exporter pods all `Running`; no alertmanager pod.

- [ ] **Step 4: Verify Grafana through the ingress**

Run: `curl -s -o /dev/null -w '%{http_code}\n' http://grafana.localhost:8080/login`
Expected: `200`.

- [ ] **Step 5: Verify Prometheus scrapes ingress-nginx**

Run:
```bash
kubectl --context k3d-tldraw-local -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090 >/dev/null 2>&1 &
PF=$!; sleep 3
curl -s 'http://localhost:9090/api/v1/query?query=up{job=~".*ingress-nginx.*"}' | grep -o '"value":\[[^]]*\]'
kill $PF
```
Expected: at least one result with value `"1"` — the ingress-nginx ServiceMonitor (enabled in Task 1's values) is being scraped.

- [ ] **Step 6: Commit**

```bash
git add local-cluster/monitoring-values.yaml local-cluster/Makefile
git commit -m "feat(local-cluster): kube-prometheus-stack with Grafana on grafana.localhost"
```

---

### Task 3: tldraw-sync-aws Helm chart + deploy target

**Files:**
- Create: `tldraw-sync-aws/chart/Chart.yaml`
- Create: `tldraw-sync-aws/chart/values.yaml`
- Create: `tldraw-sync-aws/chart/templates/deployment.yaml`
- Create: `tldraw-sync-aws/chart/templates/service.yaml`
- Create: `tldraw-sync-aws/chart/templates/ingress.yaml`
- Create: `tldraw-sync-aws/chart/templates/podmonitor.yaml`
- Create: `tldraw-sync-aws/chart/templates/redis.yaml`
- Create: `tldraw-sync-aws/chart/templates/minio.yaml`
- Create: `tldraw-sync-aws/chart/templates/create-bucket-job.yaml`
- Modify: `tldraw-sync-aws/.dockerignore` (add `chart/`)
- Modify: `local-cluster/Makefile` (add `build-aws`, `deploy-aws` targets)

**Interfaces:**
- Consumes: Task 1's Makefile variables (`KUBECTL`, `HELM`, `CLUSTER_NAME`, `IMAGE_TAG`); the demo's existing `Dockerfile` and env contract (`REDIS_URL`, `S3_BUCKET_NAME`, `AWS_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`); PodMonitor CRD from Task 1.
- Produces: release `tldraw-aws` in namespace `tldraw-aws` with resources `tldraw-aws-app` (Deployment/Service, Service port 80 → 3001), `tldraw-aws-redis` (Service port 6379), `tldraw-aws-minio` (Service port 9000), Ingress host `aws.localhost`, PodMonitor selecting label `app: tldraw-aws-app`. Task 5's verify script port-forwards `svc/tldraw-aws-minio`.

- [ ] **Step 1: Write Chart.yaml and values.yaml**

`tldraw-sync-aws/chart/Chart.yaml`:

```yaml
apiVersion: v2
name: tldraw-sync-aws
description: >
  tldraw sync backend for AWS (EKS + S3 + ElastiCache). With redis.enabled
  and emulator.enabled (the defaults) it is a self-contained local stack
  running Redis and MinIO in-cluster.
type: application
version: 0.1.0
appVersion: "1.0.0"
```

`tldraw-sync-aws/chart/values.yaml`:

```yaml
replicaCount: 2

image:
  repository: tldraw-sync-aws
  tag: local
  pullPolicy: IfNotPresent

ingress:
  enabled: true
  host: aws.localhost

env:
  s3BucketName: tldraw-test-bucket
  awsRegion: us-east-1

# In-cluster Redis for local use. On EKS set enabled: false and url to the
# ElastiCache endpoint (rediss:// if TLS).
redis:
  enabled: true
  url: ""

# In-cluster MinIO standing in for S3. On EKS set enabled: false; the AWS SDK
# default provider chain (IRSA) supplies credentials and no endpoint is set.
emulator:
  enabled: true
  accessKey: minioadmin
  secretKey: minioadmin

podMonitor:
  enabled: true

resources:
  requests:
    memory: 256Mi
    cpu: 250m
  limits:
    memory: 512Mi
    cpu: "1"
```

- [ ] **Step 2: Write the app templates**

`tldraw-sync-aws/chart/templates/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-app
  labels:
    app: {{ .Release.Name }}-app
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app: {{ .Release.Name }}-app
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}-app
    spec:
      # Graceful shutdown force-saves every active Room and releases its lock
      terminationGracePeriodSeconds: 60
      containers:
        - name: app
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 3001
          env:
            - name: PORT
              value: "3001"
            # Pod Identity for Room Locks
            - name: HOSTNAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: REDIS_URL
              {{- if .Values.redis.enabled }}
              value: "redis://{{ .Release.Name }}-redis:6379"
              {{- else }}
              value: {{ required "redis.url is required when redis.enabled=false" .Values.redis.url | quote }}
              {{- end }}
            - name: S3_BUCKET_NAME
              value: {{ .Values.env.s3BucketName | quote }}
            - name: AWS_REGION
              value: {{ .Values.env.awsRegion | quote }}
            {{- if .Values.emulator.enabled }}
            - name: S3_ENDPOINT
              value: "http://{{ .Release.Name }}-minio:9000"
            - name: S3_FORCE_PATH_STYLE
              value: "true"
            - name: AWS_ACCESS_KEY_ID
              value: {{ .Values.emulator.accessKey | quote }}
            - name: AWS_SECRET_ACCESS_KEY
              value: {{ .Values.emulator.secretKey | quote }}
            {{- end }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          readinessProbe:
            httpGet:
              path: /api/health
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /api/health
              port: http
            initialDelaySeconds: 15
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
```

`tldraw-sync-aws/chart/templates/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-app
  labels:
    app: {{ .Release.Name }}-app
spec:
  type: ClusterIP
  selector:
    app: {{ .Release.Name }}-app
  ports:
    - name: http
      port: 80
      targetPort: 3001
      protocol: TCP
```

`tldraw-sync-aws/chart/templates/ingress.yaml`:

```yaml
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Release.Name }}
  annotations:
    # Room Affinity: all Sessions of one Room hash to the same pod (ADR 0002)
    nginx.ingress.kubernetes.io/upstream-hash-by: "$uri"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
spec:
  ingressClassName: nginx
  rules:
    - host: {{ .Values.ingress.host }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ .Release.Name }}-app
                port:
                  number: 80
{{- end }}
```

`tldraw-sync-aws/chart/templates/podmonitor.yaml`:

```yaml
{{- if .Values.podMonitor.enabled }}
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: {{ .Release.Name }}
  labels:
    app: {{ .Release.Name }}-app
spec:
  selector:
    matchLabels:
      app: {{ .Release.Name }}-app
  podMetricsEndpoints:
    - port: http
      path: /metrics
      interval: 15s
{{- end }}
```

- [ ] **Step 3: Write the values-gated Redis and MinIO templates**

`tldraw-sync-aws/chart/templates/redis.yaml`:

```yaml
{{- if .Values.redis.enabled }}
# Room Locks + Handover pub/sub. Single instance, no persistence — the lock
# and pub/sub state is ephemeral by design (10s TTL, renewed every 5s).
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-redis
  labels:
    app: {{ .Release.Name }}-redis
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Release.Name }}-redis
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}-redis
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-redis
spec:
  selector:
    app: {{ .Release.Name }}-redis
  ports:
    - port: 6379
      targetPort: 6379
{{- end }}
```

`tldraw-sync-aws/chart/templates/minio.yaml`:

```yaml
{{- if .Values.emulator.enabled }}
# S3 stand-in. No persistent volume: Snapshots are disposable locally (spec).
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-minio
  labels:
    app: {{ .Release.Name }}-minio
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Release.Name }}-minio
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}-minio
    spec:
      containers:
        - name: minio
          image: minio/minio:latest
          args: ["server", "/data"]
          env:
            - name: MINIO_ROOT_USER
              value: {{ .Values.emulator.accessKey | quote }}
            - name: MINIO_ROOT_PASSWORD
              value: {{ .Values.emulator.secretKey | quote }}
          ports:
            - containerPort: 9000
          readinessProbe:
            httpGet:
              path: /minio/health/ready
              port: 9000
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-minio
spec:
  selector:
    app: {{ .Release.Name }}-minio
  ports:
    - port: 9000
      targetPort: 9000
{{- end }}
```

`tldraw-sync-aws/chart/templates/create-bucket-job.yaml`:

```yaml
{{- if .Values.emulator.enabled }}
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ .Release.Name }}-create-bucket
  annotations:
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: 6
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: mc
          image: minio/mc:latest
          command: ["/bin/sh", "-c"]
          args:
            - |
              until mc alias set local http://{{ .Release.Name }}-minio:9000 \
                {{ .Values.emulator.accessKey }} {{ .Values.emulator.secretKey }}; do
                echo "waiting for minio"; sleep 2
              done
              mc mb --ignore-existing local/{{ .Values.env.s3BucketName }}
{{- end }}
```

- [ ] **Step 4: Lint and template-test the chart (fast, no cluster)**

Run: `helm lint tldraw-sync-aws/chart`
Expected: `1 chart(s) linted, 0 chart(s) failed`.

Run: `helm template tldraw-aws tldraw-sync-aws/chart | grep -c 'upstream-hash-by'`
Expected: `1`.

Run: `helm template tldraw-aws tldraw-sync-aws/chart --set redis.enabled=false --set emulator.enabled=false --set redis.url=rediss://example:6379 | grep -cE 'kind: (Job|StatefulSet)|minio|redis:7'`
Expected: `0` — cloud mode renders no Redis, no MinIO, no bucket Job.

Run: `helm template tldraw-aws tldraw-sync-aws/chart --set redis.enabled=false --set emulator.enabled=false 2>&1 | grep -c 'redis.url is required'`
Expected: `1` — missing external Redis URL fails loudly.

- [ ] **Step 5: Keep the chart out of the Docker build context**

Append to `tldraw-sync-aws/.dockerignore`:

```
chart/
```

- [ ] **Step 6: Add Makefile targets**

Append to `local-cluster/Makefile` (add `build-aws deploy-aws` to `.PHONY`):

```make
build-aws: ## Build the AWS demo image and import it into the cluster
	docker build -t tldraw-sync-aws:$(IMAGE_TAG) ../tldraw-sync-aws
	k3d image import --cluster $(CLUSTER_NAME) tldraw-sync-aws:$(IMAGE_TAG)

deploy-aws: build-aws ## Build, import, and helm-upgrade the AWS demo
	$(HELM) upgrade --install tldraw-aws ../tldraw-sync-aws/chart \
		--namespace tldraw-aws --create-namespace \
		--set image.tag=$(IMAGE_TAG) --wait --timeout 5m
```

- [ ] **Step 7: Deploy and verify end-to-end**

Run: `cd local-cluster && make deploy-aws`
Expected: exits 0 (image builds, imports, helm waits for readiness — including the bucket Job hook).

Run: `kubectl --context k3d-tldraw-local -n tldraw-aws get pods`
Expected: 2× `tldraw-aws-app-*` Running/Ready, 1× `tldraw-aws-redis-*`, 1× `tldraw-aws-minio-*`.

Run: `curl -s http://aws.localhost:8080/api/health`
Expected: HTTP 200 with the health body.

Run: `curl -s http://aws.localhost:8080/metrics | grep -c tldraw_active_rooms`
Expected: ≥ 1.

- [ ] **Step 8: Verify Prometheus picked up the PodMonitor**

Run:
```bash
kubectl --context k3d-tldraw-local -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090 >/dev/null 2>&1 &
PF=$!; sleep 3
curl -s 'http://localhost:9090/api/v1/query?query=tldraw_active_rooms{namespace="tldraw-aws"}' | grep -c '"__name__"'
kill $PF
```
Expected: ≥ 1 (one series per app pod).

- [ ] **Step 9: Commit**

```bash
git add tldraw-sync-aws/chart tldraw-sync-aws/.dockerignore local-cluster/Makefile
git commit -m "feat(aws): Helm chart with values-gated Redis and MinIO, deploy-aws target"
```

---

### Task 4: tldraw-sync-gcp Helm chart + deploy target

**Files:**
- Create: `tldraw-sync-gcp/chart/Chart.yaml`
- Create: `tldraw-sync-gcp/chart/values.yaml`
- Create: `tldraw-sync-gcp/chart/templates/deployment.yaml`
- Create: `tldraw-sync-gcp/chart/templates/service.yaml`
- Create: `tldraw-sync-gcp/chart/templates/ingress.yaml`
- Create: `tldraw-sync-gcp/chart/templates/podmonitor.yaml`
- Create: `tldraw-sync-gcp/chart/templates/redis.yaml`
- Create: `tldraw-sync-gcp/chart/templates/gcs.yaml`
- Create: `tldraw-sync-gcp/chart/templates/create-bucket-job.yaml`
- Modify: `tldraw-sync-gcp/.dockerignore` (add `chart/`)
- Modify: `local-cluster/Makefile` (add `build-gcp`, `deploy-gcp` targets)

The existing `tldraw-sync-gcp/kubernetes/` manifests are the deployed GKE reference — do not touch them.

**Interfaces:**
- Consumes: Task 1's Makefile variables; the demo's env contract (`REDIS_URL`, `GCS_BUCKET_NAME`, `GCS_API_ENDPOINT`); PodMonitor CRD.
- Produces: release `tldraw-gcp` in namespace `tldraw-gcp` with `tldraw-gcp-app`, `tldraw-gcp-redis`, `tldraw-gcp-gcs` (Service port 4443), Ingress host `gcp.localhost`. Task 5's verify script port-forwards `svc/tldraw-gcp-gcs`.

- [ ] **Step 1: Write Chart.yaml and values.yaml**

`tldraw-sync-gcp/chart/Chart.yaml`:

```yaml
apiVersion: v2
name: tldraw-sync-gcp
description: >
  tldraw sync backend for GCP (GKE + GCS + Memorystore). With redis.enabled
  and emulator.enabled (the defaults) it is a self-contained local stack
  running Redis and fake-gcs-server in-cluster.
type: application
version: 0.1.0
appVersion: "1.0.0"
```

`tldraw-sync-gcp/chart/values.yaml`:

```yaml
replicaCount: 2

image:
  repository: tldraw-sync-gcp
  tag: local
  pullPolicy: IfNotPresent

ingress:
  enabled: true
  host: gcp.localhost

env:
  gcsBucketName: tldraw-test-bucket

# In-cluster Redis for local use. On GKE set enabled: false and url to the
# Memorystore instance address.
redis:
  enabled: true
  url: ""

# In-cluster fake-gcs-server standing in for GCS. On GKE set enabled: false;
# Workload Identity (ADC) supplies credentials and no endpoint is set.
emulator:
  enabled: true

podMonitor:
  enabled: true

resources:
  requests:
    memory: 256Mi
    cpu: 250m
  limits:
    memory: 512Mi
    cpu: "1"
```

- [ ] **Step 2: Write the app templates**

`tldraw-sync-gcp/chart/templates/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-app
  labels:
    app: {{ .Release.Name }}-app
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app: {{ .Release.Name }}-app
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}-app
    spec:
      # Graceful shutdown force-saves every active Room and releases its lock
      terminationGracePeriodSeconds: 60
      containers:
        - name: app
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 3001
          env:
            - name: PORT
              value: "3001"
            # Pod Identity for Room Locks
            - name: HOSTNAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: REDIS_URL
              {{- if .Values.redis.enabled }}
              value: "redis://{{ .Release.Name }}-redis:6379"
              {{- else }}
              value: {{ required "redis.url is required when redis.enabled=false" .Values.redis.url | quote }}
              {{- end }}
            - name: GCS_BUCKET_NAME
              value: {{ .Values.env.gcsBucketName | quote }}
            {{- if .Values.emulator.enabled }}
            - name: GCS_API_ENDPOINT
              value: "http://{{ .Release.Name }}-gcs:4443"
            {{- end }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          readinessProbe:
            httpGet:
              path: /api/health
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /api/health
              port: http
            initialDelaySeconds: 15
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
```

`tldraw-sync-gcp/chart/templates/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-app
  labels:
    app: {{ .Release.Name }}-app
spec:
  type: ClusterIP
  selector:
    app: {{ .Release.Name }}-app
  ports:
    - name: http
      port: 80
      targetPort: 3001
      protocol: TCP
```

`tldraw-sync-gcp/chart/templates/ingress.yaml`:

```yaml
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Release.Name }}
  annotations:
    # Room Affinity: all Sessions of one Room hash to the same pod (ADR 0002)
    nginx.ingress.kubernetes.io/upstream-hash-by: "$uri"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
spec:
  ingressClassName: nginx
  rules:
    - host: {{ .Values.ingress.host }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ .Release.Name }}-app
                port:
                  number: 80
{{- end }}
```

`tldraw-sync-gcp/chart/templates/podmonitor.yaml`:

```yaml
{{- if .Values.podMonitor.enabled }}
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: {{ .Release.Name }}
  labels:
    app: {{ .Release.Name }}-app
spec:
  selector:
    matchLabels:
      app: {{ .Release.Name }}-app
  podMetricsEndpoints:
    - port: http
      path: /metrics
      interval: 15s
{{- end }}
```

- [ ] **Step 3: Write the values-gated Redis and fake-gcs templates**

`tldraw-sync-gcp/chart/templates/redis.yaml`:

```yaml
{{- if .Values.redis.enabled }}
# Room Locks + Handover pub/sub. Single instance, no persistence — the lock
# and pub/sub state is ephemeral by design (10s TTL, renewed every 5s).
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-redis
  labels:
    app: {{ .Release.Name }}-redis
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Release.Name }}-redis
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}-redis
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-redis
spec:
  selector:
    app: {{ .Release.Name }}-redis
  ports:
    - port: 6379
      targetPort: 6379
{{- end }}
```

`tldraw-sync-gcp/chart/templates/gcs.yaml`:

```yaml
{{- if .Values.emulator.enabled }}
# GCS stand-in. No persistent volume: Snapshots are disposable locally (spec).
# public-host/external-url use the in-cluster Service name so URLs the
# emulator hands back (e.g. resumable uploads) work for the app pods.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-gcs
  labels:
    app: {{ .Release.Name }}-gcs
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Release.Name }}-gcs
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}-gcs
    spec:
      containers:
        - name: fake-gcs
          image: fsouza/fake-gcs-server:latest
          args:
            - "-scheme"
            - "http"
            - "-port"
            - "4443"
            - "-public-host"
            - "{{ .Release.Name }}-gcs:4443"
            - "-external-url"
            - "http://{{ .Release.Name }}-gcs:4443"
          ports:
            - containerPort: 4443
          readinessProbe:
            httpGet:
              path: /storage/v1/b
              port: 4443
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-gcs
spec:
  selector:
    app: {{ .Release.Name }}-gcs
  ports:
    - port: 4443
      targetPort: 4443
{{- end }}
```

`tldraw-sync-gcp/chart/templates/create-bucket-job.yaml`:

```yaml
{{- if .Values.emulator.enabled }}
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ .Release.Name }}-create-bucket
  annotations:
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: 6
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: create-bucket
          image: curlimages/curl:latest
          command: ["/bin/sh", "-c"]
          args:
            - |
              until curl -sf "http://{{ .Release.Name }}-gcs:4443/storage/v1/b?project=local" \
                -H 'Content-Type: application/json' \
                -d '{"name": "{{ .Values.env.gcsBucketName }}"}' ; do
                # 409 (already exists) also lands here; treat it as success
                code=$(curl -s -o /dev/null -w '%{http_code}' \
                  "http://{{ .Release.Name }}-gcs:4443/storage/v1/b/{{ .Values.env.gcsBucketName }}")
                [ "$code" = "200" ] && exit 0
                echo "waiting for fake-gcs"; sleep 2
              done
{{- end }}
```

- [ ] **Step 4: Lint and template-test the chart (fast, no cluster)**

Run: `helm lint tldraw-sync-gcp/chart`
Expected: `1 chart(s) linted, 0 chart(s) failed`.

Run: `helm template tldraw-gcp tldraw-sync-gcp/chart | grep -c 'upstream-hash-by'`
Expected: `1`.

Run: `helm template tldraw-gcp tldraw-sync-gcp/chart --set redis.enabled=false --set emulator.enabled=false --set redis.url=redis://10.0.0.5:6379 | grep -cE 'kind: Job|fake-gcs|redis:7|GCS_API_ENDPOINT'`
Expected: `0` — cloud mode renders no Redis, no emulator, no bucket Job, no endpoint override.

- [ ] **Step 5: Keep the chart out of the Docker build context**

Append to `tldraw-sync-gcp/.dockerignore`:

```
chart/
```

- [ ] **Step 6: Add Makefile targets**

Append to `local-cluster/Makefile` (add `build-gcp deploy-gcp` to `.PHONY`):

```make
build-gcp: ## Build the GCP demo image and import it into the cluster
	docker build -t tldraw-sync-gcp:$(IMAGE_TAG) ../tldraw-sync-gcp
	k3d image import --cluster $(CLUSTER_NAME) tldraw-sync-gcp:$(IMAGE_TAG)

deploy-gcp: build-gcp ## Build, import, and helm-upgrade the GCP demo
	$(HELM) upgrade --install tldraw-gcp ../tldraw-sync-gcp/chart \
		--namespace tldraw-gcp --create-namespace \
		--set image.tag=$(IMAGE_TAG) --wait --timeout 5m
```

- [ ] **Step 7: Deploy and verify end-to-end**

Run: `cd local-cluster && make deploy-gcp`
Expected: exits 0.

Run: `kubectl --context k3d-tldraw-local -n tldraw-gcp get pods`
Expected: 2× `tldraw-gcp-app-*` Running/Ready, 1× `tldraw-gcp-redis-*`, 1× `tldraw-gcp-gcs-*`.

Run: `curl -s http://gcp.localhost:8080/api/health && curl -s http://gcp.localhost:8080/metrics | grep -c tldraw_active_rooms`
Expected: health 200, metric count ≥ 1.

Run (confirm the AWS release is untouched): `curl -s -o /dev/null -w '%{http_code}\n' http://aws.localhost:8080/api/health`
Expected: `200` — both demos serve side by side through one ingress.

- [ ] **Step 8: Commit**

```bash
git add tldraw-sync-gcp/chart tldraw-sync-gcp/.dockerignore local-cluster/Makefile
git commit -m "feat(gcp): Helm chart with values-gated Redis and fake-gcs-server, deploy-gcp target"
```

---

### Task 5: End-to-end verify targets

**Files:**
- Create: `local-cluster/scripts/verify-aws.sh`
- Create: `local-cluster/scripts/verify-gcp.sh`
- Modify: `local-cluster/Makefile` (add `verify-aws`, `verify-gcp` targets)

**Interfaces:**
- Consumes: deployed releases from Tasks 3–4 (`svc/tldraw-aws-minio` port 9000 in `tldraw-aws`, `svc/tldraw-gcp-gcs` port 4443 in `tldraw-gcp`); each demo's existing `tldraw-client/verify-sync.mjs`, which takes the server URL as `argv[2]` and reads the emulator endpoint from env (`S3_ENDPOINT` / `GCS_API_ENDPOINT`).
- Produces: `make verify-aws` / `make verify-gcp` — exit 0 means two clients synced a Room through the ingress and the Snapshot round-tripped through the emulator.

- [ ] **Step 1: Write the AWS verify script**

`local-cluster/scripts/verify-aws.sh`:

```bash
#!/usr/bin/env bash
# E2E verify for the AWS demo running in k3d: runs the demo's own
# verify-sync.mjs against the ingress, with MinIO port-forwarded so the
# script's direct S3 checks (snapshot landed, cold-room restore) work.
set -euo pipefail

CTX=k3d-tldraw-local
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIENT_DIR="$ROOT/tldraw-sync-aws/tldraw-client"

kubectl --context "$CTX" -n tldraw-aws port-forward svc/tldraw-aws-minio 9000:9000 >/dev/null 2>&1 &
PF=$!
trap 'kill "$PF" 2>/dev/null || true' EXIT
sleep 3

cd "$CLIENT_DIR"
[ -d node_modules ] || npm install --no-audit --no-fund

AWS_ACCESS_KEY_ID=minioadmin \
AWS_SECRET_ACCESS_KEY=minioadmin \
S3_ENDPOINT=http://localhost:9000 \
S3_BUCKET_NAME=tldraw-test-bucket \
AWS_REGION=us-east-1 \
node verify-sync.mjs http://aws.localhost:8080
```

- [ ] **Step 2: Write the GCP verify script**

`local-cluster/scripts/verify-gcp.sh`:

```bash
#!/usr/bin/env bash
# E2E verify for the GCP demo running in k3d: runs the demo's own
# verify-sync.mjs against the ingress, with fake-gcs port-forwarded so the
# script's direct GCS checks (snapshot landed, cold-room restore) work.
set -euo pipefail

CTX=k3d-tldraw-local
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIENT_DIR="$ROOT/tldraw-sync-gcp/tldraw-client"

kubectl --context "$CTX" -n tldraw-gcp port-forward svc/tldraw-gcp-gcs 4443:4443 >/dev/null 2>&1 &
PF=$!
trap 'kill "$PF" 2>/dev/null || true' EXIT
sleep 3

cd "$CLIENT_DIR"
[ -d node_modules ] || npm install --no-audit --no-fund

GCS_API_ENDPOINT=http://localhost:4443 \
GCS_BUCKET_NAME=tldraw-test-bucket \
node verify-sync.mjs http://gcp.localhost:8080
```

- [ ] **Step 3: Make them executable and add Makefile targets**

Run: `chmod +x local-cluster/scripts/verify-aws.sh local-cluster/scripts/verify-gcp.sh`

Append to `local-cluster/Makefile` (add `verify-aws verify-gcp` to `.PHONY`):

```make
verify-aws: ## E2E sync verification for the AWS demo through the ingress
	./scripts/verify-aws.sh

verify-gcp: ## E2E sync verification for the GCP demo through the ingress
	./scripts/verify-gcp.sh
```

- [ ] **Step 4: Run both and confirm they pass**

Run: `cd local-cluster && make verify-aws`
Expected: the script's own success output (two clients join, shape syncs A→B, edit syncs B→A, snapshot in storage, cold-room restore) and exit 0.

Run: `cd local-cluster && make verify-gcp`
Expected: same, exit 0. Known risk: fake-gcs `-public-host` is set to the in-cluster Service name; if the host-side script fails on URL rewriting during its direct-GCS checks, the fix is to compare against the app-side behavior — the app's writes must keep working in-cluster, so adjust the *script env* (not the emulator args) first, and only touch `-public-host` if both sides can tolerate it.

- [ ] **Step 5: Commit**

```bash
git add local-cluster/scripts local-cluster/Makefile
git commit -m "feat(local-cluster): make verify-aws / verify-gcp e2e sync checks"
```

---

### Task 6: Grafana "tldraw scaling" dashboard

**Files:**
- Create: `local-cluster/dashboards/tldraw-scaling-dashboard.yaml`
- Modify: `local-cluster/Makefile` (add `dashboard` target; hook it into `monitoring`)

**Interfaces:**
- Consumes: Grafana dashboard sidecar from Task 2 (watches ConfigMaps labeled `grafana_dashboard: "1"` in namespace `monitoring`); metric names from the apps (`tldraw_active_rooms`, `tldraw_active_connections`, `tldraw_handover_requests_total`, `tldraw_handover_success_total`, `tldraw_handover_timeouts_total`, `tldraw_handover_duration_seconds`), kube-state-metrics (`kube_deployment_status_replicas_available`), and ingress-nginx (`nginx_ingress_controller_requests`).
- Produces: a "tldraw scaling" dashboard visible in Grafana — the panel set the future k6 spec watches during load tests.

- [ ] **Step 1: Write the dashboard ConfigMap**

`local-cluster/dashboards/tldraw-scaling-dashboard.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tldraw-scaling-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  tldraw-scaling.json: |
    {
      "uid": "tldraw-scaling",
      "title": "tldraw scaling",
      "schemaVersion": 39,
      "refresh": "10s",
      "time": { "from": "now-30m", "to": "now" },
      "panels": [
        {
          "id": 1, "type": "timeseries", "title": "Active rooms per pod",
          "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
          "targets": [
            { "expr": "tldraw_active_rooms{namespace=~\"tldraw-.*\"}",
              "legendFormat": "{{namespace}}/{{pod}}" }
          ]
        },
        {
          "id": 2, "type": "timeseries", "title": "Active connections (Sessions) per pod",
          "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
          "targets": [
            { "expr": "tldraw_active_connections{namespace=~\"tldraw-.*\"}",
              "legendFormat": "{{namespace}}/{{pod}}" }
          ]
        },
        {
          "id": 3, "type": "timeseries", "title": "Handover rate (req / success / timeout)",
          "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
          "targets": [
            { "expr": "sum by (namespace) (rate(tldraw_handover_requests_total[1m]))",
              "legendFormat": "{{namespace}} requested" },
            { "expr": "sum by (namespace) (rate(tldraw_handover_success_total[1m]))",
              "legendFormat": "{{namespace}} succeeded" },
            { "expr": "sum by (namespace) (rate(tldraw_handover_timeouts_total[1m]))",
              "legendFormat": "{{namespace}} timed out" }
          ]
        },
        {
          "id": 4, "type": "timeseries", "title": "Handover duration p95",
          "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
          "targets": [
            { "expr": "histogram_quantile(0.95, sum by (namespace, le) (rate(tldraw_handover_duration_seconds_bucket[5m])))",
              "legendFormat": "{{namespace}} p95" }
          ]
        },
        {
          "id": 5, "type": "timeseries", "title": "App replicas available",
          "gridPos": { "h": 8, "w": 12, "x": 0, "y": 16 },
          "targets": [
            { "expr": "kube_deployment_status_replicas_available{deployment=~\"tldraw-(aws|gcp)-app\"}",
              "legendFormat": "{{namespace}}" }
          ]
        },
        {
          "id": 6, "type": "timeseries", "title": "Ingress 5xx rate by host",
          "gridPos": { "h": 8, "w": 12, "x": 12, "y": 16 },
          "targets": [
            { "expr": "sum by (host) (rate(nginx_ingress_controller_requests{status=~\"5..\"}[1m]))",
              "legendFormat": "{{host}}" }
          ]
        }
      ]
    }
```

- [ ] **Step 2: Add the Makefile target and hook it into monitoring**

In `local-cluster/Makefile`, add `dashboard` to `.PHONY`, append:

```make
dashboard: ## Install/refresh the Grafana "tldraw scaling" dashboard
	$(KUBECTL) apply -f dashboards/tldraw-scaling-dashboard.yaml
```

and change the `monitoring` target's recipe to end with the dashboard apply:

```make
monitoring: ## Install Prometheus + Grafana (kube-prometheus-stack)
	$(HELM) upgrade --install monitoring prometheus-community/kube-prometheus-stack \
		--namespace monitoring --create-namespace \
		-f monitoring-values.yaml --wait --timeout 10m
	$(KUBECTL) apply -f dashboards/tldraw-scaling-dashboard.yaml
```

- [ ] **Step 3: Apply and verify in Grafana**

Run: `cd local-cluster && make dashboard && sleep 30`
Then:
```bash
curl -s -u admin:tldraw http://grafana.localhost:8080/api/dashboards/uid/tldraw-scaling | grep -o '"title":"tldraw scaling"'
```
Expected: `"title":"tldraw scaling"` — the sidecar loaded the dashboard.

- [ ] **Step 4: Verify panels have data**

Open `http://grafana.localhost:8080/d/tldraw-scaling` (admin / `tldraw`) in a browser. With both demos deployed, "Active rooms per pod" and "App replicas available" must show series (rooms may be 0 — the series existing is what matters). Alternatively, confirm via the Prometheus API that `kube_deployment_status_replicas_available{deployment=~"tldraw-(aws|gcp)-app"}` returns 2 series, as in Task 3 Step 8.

- [ ] **Step 5: Commit**

```bash
git add local-cluster/dashboards local-cluster/Makefile
git commit -m "feat(local-cluster): Grafana tldraw scaling dashboard"
```

---

### Task 7: Documentation + handover drill

**Files:**
- Create: `local-cluster/README.md`
- Modify: `README.md` (root — add a pointer to `local-cluster/`)

**Interfaces:**
- Consumes: everything built in Tasks 1–6.
- Produces: the runbook a newcomer follows, and the manual handover drill the future k6 spec automates.

- [ ] **Step 1: Write local-cluster/README.md**

Content must cover, in this order (write real prose, not headers-only):

1. **What this is** — one paragraph: local k3d cluster mirroring the GKE/EKS deployments for both demos, built for watching availability during scaling; link to the spec (`../docs/superpowers/specs/2026-08-06-local-k3s-setup-design.md`).
2. **Prerequisites** — Docker, k3d ≥ 5.6, helm 3, kubectl, Node 20+. Include the `/etc/hosts` note from Task 1 Step 6: if `curl http://aws.localhost:8080` cannot resolve, run `echo '127.0.0.1 aws.localhost gcp.localhost grafana.localhost' | sudo tee -a /etc/hosts`.
3. **Quickstart** — the exact command sequence:
   ```bash
   cd local-cluster
   make cluster          # k3d + CRDs + ingress-nginx
   make monitoring       # Prometheus + Grafana + dashboard
   make deploy-aws       # AWS demo -> http://aws.localhost:8080
   make deploy-gcp       # GCP demo -> http://gcp.localhost:8080
   make verify-aws verify-gcp
   ```
   Plus: Grafana at `http://grafana.localhost:8080` (admin / `tldraw`), and how to point a tldraw client at a demo: `cd ../tldraw-sync-aws/tldraw-client && VITE_PUBLIC_API_URL=http://aws.localhost:8080 npm run dev`.
4. **The handover drill** — the manual procedure from the spec, written as numbered steps:
   1. Open `http://aws.localhost:8080` room via the client (or run `make verify-aws` once to create a room).
   2. Open the Grafana dashboard `tldraw scaling`.
   3. `kubectl --context k3d-tldraw-local -n tldraw-aws scale deployment tldraw-aws-app --replicas=3`
   4. Watch: "Handover rate" shows requested/succeeded ticks; "App replicas available" steps 2→3; connected clients briefly disconnect (WebSocket close `1013`) and reconnect into the new Room Owner; "Ingress 5xx rate" stays flat.
   5. Scale back to 2 and watch the same in reverse.
5. **Teardown** — `make cluster-down`.
6. **Cloud values** — one short paragraph: each chart runs on its real cloud by setting `redis.enabled=false`, `redis.url=<managed redis>`, `emulator.enabled=false`; writing/testing those values files is future work (spec: out of scope).

- [ ] **Step 2: Add the pointer in the root README**

In root `README.md`, add one row/sentence under "Running them" (after the existing paragraph about per-demo local runs):

```markdown
To run **both demos in a local Kubernetes cluster** (k3d + ingress-nginx with production-style consistent-hash routing + Prometheus/Grafana), see [`local-cluster/`](local-cluster/).
```

- [ ] **Step 3: Execute the handover drill once, as written**

Follow your own README steps 1–5 exactly. 
Expected: the drill works as documented — handover metrics tick on the dashboard, replicas step 2→3→2, no sustained 5xx. If any step's wording doesn't match reality (resource names, URLs, panel titles), fix the README now.

- [ ] **Step 4: Commit**

```bash
git add local-cluster/README.md README.md
git commit -m "docs(local-cluster): runbook, handover drill, root README pointer"
```
