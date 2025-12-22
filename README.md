# tldraw-sync-gcp

A **production-ready, horizontally scalable sync backend** for [tldraw](https://tldraw.com), designed to run on **Google Cloud Platform (GKE)**.

This project implements a **Stateful Room Ownership model** to safely support real-time collaboration at scale.

---

## ✨ Key Features

- 🧠 **Stateful Room Architecture**
  - Each room is owned by a single pod at any given time.
  - Prevents split-brain and data corruption.

- 🔐 **Redis Distributed Locking**
  - Guarantees exclusive room ownership across pods.
  - Auto-renewed locks with safe expiration handling.

- ☁️ **Google Cloud Storage Persistence**
  - Room snapshots and assets are persisted to GCS.
  - Ensures durability across pod restarts and deployments.

- 🔌 **WebSocket-based Sync**
  - Powered by `@tldraw/sync-core`.
  - Low-latency real-time collaboration.

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
GCP Load Balancer (Sticky Sessions)
        |
        v
GKE Pods (Node.js)
        |
        | Redis Lock (room ownership)
        v
Redis
        |
        | Snapshots / Assets
        v
Google Cloud Storage
```

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

Example React integration using `@tldraw/sync`.

```tsx
import { useSync } from "@tldraw/sync";
import { Tldraw } from "tldraw";

const roomId = "room-123";

const WORKER_URL = import.meta.env.PROD
  ? "https://your-gcp-loadbalancer.com"
  : "http://localhost:3001";

export function CollaborationRoom() {
  const wsUri = `${WORKER_URL.replace("http", "ws")}/api/connect/${roomId}`;

  const store = useSync({
    uri: wsUri,
  });

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Tldraw store={store} />
    </div>
  );
}
```

---

## 🚢 Deployment (GCP)

### Docker Build

```bash
docker build -t tldraw-sync-gcp .
docker run -p 3001:3001 --env-file .env tldraw-sync-gcp
```

---

### GKE Deployment Flow

Typical CI/CD pipeline:

1. Build Docker image
2. Push to **Google Artifact Registry**
3. Deploy to **GKE**
4. Rolling update with zero downtime

⚠️ **Important:**  
Ensure **Session Affinity (Sticky Sessions)** is enabled on your Load Balancer.

---

## 🛠 Troubleshooting

### Common Errors

| Code | Meaning | Cause | Resolution |
|----|-------|------|-----------|
| **1013** | Try Again Later | Room lock owned by another pod | Client auto-retries. Enable sticky sessions |
| **1011** | Internal Error | Redis or GCS unreachable | Verify env variables |
| **503** | Unavailable | Pod shutting down or overloaded | Client will reconnect |

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
https://github.com/tldraw/tldraw-sync-gcp

---

## 🧠 Notes

- Smart autoscaling and empty-room draining are intentionally **not implemented**
- This design favors **correctness and safety over aggressive scaling**
- Ideal for production collaborative environments

---

## 📄 License

MIT
