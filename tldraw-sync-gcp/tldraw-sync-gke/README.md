# tldraw-sync-gke

A **production-ready, horizontally scalable sync backend** for [tldraw](https://tldraw.com), running on **Google Kubernetes Engine**.

> This is the GKE deployment target. Two sibling targets run the same server on
> other GCP compute: [`../tldraw-sync-cloud-run`](../tldraw-sync-cloud-run) and
> [`../tldraw-sync-compute-engine`](../tldraw-sync-compute-engine). See
> [the GCP README](../README.md) for how to choose between them, and the
> [repo README](../../README.md) for how GCP relates to AWS. All paths and
> commands below are relative to this directory.
>
> This is the only target with **strong Room Affinity**: ingress-nginx
> consistent-hashes on the request path, which carries the `roomId`, so every
> Session of a Room lands on its Room Owner and Handovers only happen when the
> hash ring reshuffles.

This project implements a **Stateful Room Ownership model** to safely support real-time collaboration at scale.

---

## ✨ Key Features

- 🧠 **Stateful Room Architecture**
  - Each room is owned by a single pod at any given time.
  - Prevents split-brain and data corruption.

- 🔐 **Redis Distributed Locking**
  - Guarantees exclusive room ownership across pods.
  - Auto-renewed locks with safe expiration handling.

- 🔄 **Two-Phase Coordinated Handover**
  - Safe room migration during scaling events.
  - Users disconnected only after new pod is ready.
  - Zero data loss during pod transitions.

- ☁️ **Google Cloud Storage Persistence**
  - Room snapshots and assets are persisted to GCS.
  - Ensures durability across pod restarts and deployments.

- 🔌 **WebSocket-based Sync**
  - Powered by `@tldraw/sync-core`.
  - Low-latency real-time collaboration.
  - Server-side keep-alive to prevent idle timeouts.

- ♻️ **Graceful Shutdown**
  - Active rooms are force-saved on shutdown.
  - Redis locks are released immediately to allow fast reconnection.

- 🐳 **Container & GKE Ready**
  - Designed for Docker, GKE, and CI/CD pipelines.

---

## 🧱 Architecture Overview

```text
tldraw-client (Example App)
        |
        | WebSocket
        v
GCP Network Load Balancer
        |
        v
NGINX Ingress Controller (Consistent Hashing by URI)
        |
        v
GKE Pods (Node.js)
        |
        | Redis Lock (room ownership)
        | Redis Pub/Sub (handover coordination)
        v
Redis
        |
        | Snapshots / Assets
        v
Google Cloud Storage
```

**Key**: NGINX uses `upstream-hash-by: "$uri"` to route requests for the same room to the same pod. When pods scale, a coordinated handover protocol ensures safe room migration.

---

## 🚀 Getting Started

### 1. Prerequisites

- Node.js **v20+**
- Yarn **v4.11.0+**
- Redis (local or Docker)
- Google Cloud Storage bucket
- `gcloud` CLI (recommended)

---

### 2. Environment Setup

```bash
cp .env.example .env
```

#### Required Environment Variables

```env
# Server
PORT=3001
NODE_ENV=development

# Redis (Room Locking)
REDIS_URL=redis://localhost:6379

# Google Cloud Storage
GCS_BUCKET_NAME=your-tldraw-bucket-name

# Optional (local dev only)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

---

### 3. Running the Backend Locally

#### Install Dependencies

```bash
yarn install
```

#### Start Redis

```bash
docker run --name tldraw-redis -p 6379:6379 -d redis
```

#### Start the Backend Server

```bash
yarn dev
```

Backend will be available at:

```
http://localhost:3001
```

---

## 🧪 Example Client: `tldraw-client`

This repository includes a **fully working example frontend** located in:

```
/tldraw-client
```

The client demonstrates **real-world integration** with this sync backend using
`@tldraw/sync` and can be used to quickly validate your setup.

### Running the Example Client

> ⚠️ Ensure the backend server is already running before starting the client.

```bash
cd tldraw-client
npm install
npm run dev
```

The client will start (usually on):

```
http://localhost:5173
```

### What This Client Demonstrates

- WebSocket connection to `/api/connect/:roomId`
- Automatic reconnect handling
- Real-time multi-user collaboration
- Compatibility with Redis room locking & GCS persistence

This client is intended for **testing, debugging, and reference** — not production deployment.

---

## 🔌 Custom Frontend Integration

For a minimal, fully-commented example that wires up all three integration
points (sync WebSocket, asset uploads, bookmark unfurling), see:

📖 **[examples/minimal-frontend](examples/minimal-frontend/)**

The gist of it, using `@tldraw/sync`:

```tsx
import { useSync } from "@tldraw/sync"
import { Tldraw } from "tldraw"

const roomId = "room-123"

const WORKER_URL = import.meta.env.PROD
  ? "https://your-gcp-loadbalancer.com"
  : "http://localhost:3001"

export function CollaborationRoom() {
  const wsUri = `${WORKER_URL.replace("http", "ws")}/api/connect/${roomId}`

  const store = useSync({
    uri: wsUri,
  })

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Tldraw store={store} />
    </div>
  )
}
```

---

## 🚢 Deployment (GCP)

### Manual Deployment to a New GCP Project

For a complete step-by-step guide to deploy from scratch, see:

📖 **[Manual GCP Deployment Guide](docs/manual-gcp-deployment.md)**

This covers:

- GCP project setup and API enablement
- Terraform infrastructure provisioning
- GKE cluster configuration
- NGINX Ingress installation
- Docker image build and push
- Kubernetes manifest deployment

---

### Docker Build (Local)

```bash
docker build -t tldraw-sync-gke .
docker run -p 3001:3001 --env-file .env tldraw-sync-gke
```

---

### CI/CD Deployment Flow

For existing deployments, the typical CI/CD pipeline:

1. Build Docker image (with `--platform linux/amd64`)
2. Push to **Google Artifact Registry**
3. Deploy to **GKE** via `kubectl set image`
4. Rolling update with zero downtime

See `../../.github/workflows/deploy-gke.yaml` for the GitHub Actions workflow (workflows live at the repo root; it only runs on changes under `tldraw-sync-gcp/tldraw-sync-gke/`).

⚠️ **Important:**  
Ensure NGINX Ingress is configured with `upstream-hash-by: "$uri"` for consistent room routing. See `kubernetes/ingress.yaml`.

---

## 🛠 Troubleshooting

### Common Errors

| Code     | Meaning         | Cause                                           | Resolution                                                     |
| -------- | --------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| **1013** | Try Again Later | Room migration in progress (two-phase handover) | Client auto-retries. Normal during scaling events.             |
| **1011** | Internal Error  | Redis or GCS unreachable                        | Verify env variables                                           |
| **1005** | Idle Timeout    | Connection idle too long                        | Server keep-alive should prevent this. Check PING_INTERVAL_MS. |
| **503**  | Unavailable     | Pod shutting down or overloaded                 | Client will reconnect                                          |

---

## ❤️ Health Check

```http
GET /api/health
200 OK
```

Used by GCP Load Balancers and Kubernetes probes.

---

## 🔐 Room Locking Details

- Lock Key: `lock:room:{roomId}`
- TTL: **10 seconds**
- Renew Interval: **5 seconds**
- Locks are released immediately on shutdown

---

## 🧯 Graceful Shutdown Flow

On `SIGTERM`:

1. Stop accepting new connections
2. Save all active rooms to GCS
3. Release Redis locks
4. Exit process cleanly

This ensures **zero data loss** during rolling deployments.

---

## 📦 Repository

GitHub:  
https://github.com/tldraw/tldraw-sync-cloud

---

## 📊 Performance & Capacity

Tested with k6 stress tests from within GCP:

| Concurrent Users | Rooms × Users | Success Rate             |
| ---------------- | ------------- | ------------------------ |
| 5,000            | 50 × 100      | **100%**                 |
| 7,000            | 100 × 70      | **99.99%**               |
| 10,000           | 100 × 100     | ~30% (exceeded capacity) |

**Tested infrastructure**: 5 NGINX Ingress replicas, 10 app pods, 3× e2-medium nodes

**Connection latency**: ~235ms (normal load), ~10-20s (under heavy load)

See `stress-test/README.md` for running your own benchmarks.

---

## 🧠 Notes

- Smart autoscaling and empty-room draining are intentionally **not implemented**
- This design favors **correctness and safety over aggressive scaling**
- Ideal for production collaborative environments

---

## 📄 License

MIT
