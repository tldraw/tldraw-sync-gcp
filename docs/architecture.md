# tldraw-sync-gcp Architecture

This document provides a comprehensive overview of the tldraw-sync-gcp application structure, implementation details, and design decisions.

## Table of Contents

1. [Overview](#overview)
2. [High-Level Architecture](#high-level-architecture)
3. [Project Structure](#project-structure)
4. [Backend Components](#backend-components)
5. [Room Management & Locking](#room-management--locking)
6. [Data Persistence](#data-persistence)
7. [Kubernetes Infrastructure](#kubernetes-infrastructure)
8. [Request Flow](#request-flow)
9. [Known Limitations](#known-limitations)

---

## Overview

tldraw-sync-gcp is a **horizontally scalable sync backend** for [tldraw](https://tldraw.com), designed to run on Google Kubernetes Engine (GKE). It enables real-time collaboration by synchronizing drawing state across multiple clients via WebSocket connections.

### Key Technologies

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 20 |
| HTTP Server | Express 5 |
| WebSocket | ws library |
| Sync Protocol | @tldraw/sync-core |
| Distributed Locking | Redis |
| Persistence | Google Cloud Storage |
| Metrics | Prometheus (prom-client) |
| Container Orchestration | Kubernetes (GKE) |
| Ingress | NGINX Ingress Controller |

---

## High-Level Architecture

```
                                    EXTERNAL CLIENTS
                                           │
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              NGINX Ingress                                    │
│                    (TLS termination, consistent hashing by URI)              │
│                         nginx.ingress.kubernetes.io/upstream-hash-by: "$uri" │
└──────────────────────────────────────────────────────────────────────────────┘
                                           │
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           ClusterIP Service                                   │
│                             (tldraw-svc:80)                                   │
└──────────────────────────────────────────────────────────────────────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
             ┌───────────┐          ┌───────────┐          ┌───────────┐
             │   Pod A   │          │   Pod B   │          │   Pod C   │
             │  :3001    │          │  :3001    │          │  :3001    │
             └─────┬─────┘          └─────┬─────┘          └─────┬─────┘
                   │                      │                      │
                   └──────────────────────┼──────────────────────┘
                                          │
                         ┌────────────────┴────────────────┐
                         ▼                                 ▼
                  ┌─────────────┐                  ┌──────────────┐
                  │    Redis    │                  │     GCS      │
                  │   (Locks)   │                  │  (Snapshots) │
                  └─────────────┘                  └──────────────┘
```

---

## Project Structure

```
tldraw-sync-gcp/
├── src/                        # Backend source code
│   ├── index.ts                # Application entry point
│   ├── roomManager.ts          # Room lifecycle & Redis locking
│   ├── gcsStorage.ts           # GCS persistence layer
│   ├── metrics.ts              # Prometheus metrics definitions
│   └── unfurl.ts               # URL metadata extraction
│
├── kubernetes/                 # K8s manifests
│   ├── deployment.yaml         # Deployment + HPA
│   ├── ingress.yaml            # Ingress + ClusterIP Service
│   ├── service-account.yaml    # GCP Workload Identity
│   └── pod-monitor.yaml        # GCP Managed Prometheus
│
├── tldraw-client/              # Example React client
│   └── src/
│       ├── multiplayerAssetStore.ts
│       └── getBookmarkPreview.ts
│
├── infra-terraform/            # Terraform modules for GCP
│   ├── gcp/
│   └── modules/
│
├── Dockerfile                  # Multi-stage build
├── package.json
└── tsconfig.json
```

---

## Backend Components

### 1. Entry Point (`src/index.ts`)

The main application file that orchestrates all components:

```typescript
// Key responsibilities:
// 1. Express HTTP server setup
// 2. WebSocket server (noServer mode)
// 3. Route definitions
// 4. Graceful shutdown handling
```

#### HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check for K8s probes |
| `/metrics` | GET | Prometheus metrics endpoint |
| `/api/uploads/:uploadId` | POST | Asset upload to GCS |
| `/api/uploads/:uploadId` | GET | Asset download from GCS |
| `/api/unfurl` | GET | URL metadata extraction |
| `/api/connect/:roomId` | WS | WebSocket connection for room sync |

#### WebSocket Upgrade Flow

```typescript
server.on("upgrade", (request, socket, head) => {
  // 1. Parse URL: /api/connect/{roomId}?sessionId={sessionId}
  // 2. Validate roomId and sessionId exist
  // 3. Upgrade connection via wss.handleUpgrade()
  // 4. Emit 'connection' event with room context
});
```

#### Graceful Shutdown

On `SIGTERM` or `SIGINT`:
1. Stop accepting new connections
2. Call `roomManager.shutdown()` to save all rooms and release locks
3. Exit process

---

### 2. Room Manager (`src/roomManager.ts`)

The core component managing room lifecycle, distributed locking, and real-time sync.

#### Constants

```typescript
const LOCK_TIMEOUT_SEC = 10;        // Redis lock TTL
const THROTTLE_SAVE_MS = 10_000;    // GCS save frequency
const HEARTBEAT_INTERVAL_MS = 5000; // Lock renewal interval
const SOCKET_CLEANUP_DELAY_MS = 2000; // Delay before room cleanup
```

#### Pod Identity

Each pod generates a unique identifier on startup:

```typescript
const POD_NAME = `TldrawRoomManagerPod-${randomUUID().slice(0, 8)}`;
```

This ensures correct lock ownership identification across pod restarts.

#### Redis Client Architecture

Three separate Redis connections are used:

```typescript
const redisClient = createClient({ url: REDIS_URL }); // Commands (SET, GET, DEL)
const subClient = redisClient.duplicate();             // Pub/Sub subscriptions
const pubClient = redisClient.duplicate();             // Pub/Sub publishing
```

This separation is required because Redis Pub/Sub puts the connection into a blocking subscriber mode.

#### Room Acquisition Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        getOrCreateRoom(roomId, ws, sessionId)           │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                        ┌────────────────────────┐
                        │ Room in activeRooms?   │
                        └───────────┬────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
                   YES                              NO
                    │                               │
                    ▼                               ▼
            Connect socket              ┌────────────────────────┐
            immediately                 │ Room in loadingRooms?  │
                                        └───────────┬────────────┘
                                                    │
                                    ┌───────────────┴───────────────┐
                                    ▼                               ▼
                                   YES                              NO
                                    │                               │
                                    ▼                               ▼
                            Await existing              Try Redis lock (SETNX)
                            load promise                        │
                                                    ┌───────────┴───────────┐
                                                    ▼                       ▼
                                                 ACQUIRED               DENIED
                                                    │                       │
                                                    ▼                       ▼
                                            Load from GCS          Publish handover
                                            Start heartbeat        request, close
                                            Connect socket         with 1013
```

#### Lock Heartbeat

While a room is active, the lock is renewed every 5 seconds:

```typescript
const lockHeartbeat = setInterval(() => {
  redisClient.set(lockKey, POD_NAME, { EX: LOCK_TIMEOUT_SEC, XX: true });
}, HEARTBEAT_INTERVAL_MS);
```

The `XX` flag ensures we only update if the key exists (we still own it).

#### Room Handover Mechanism

When a pod receives a connection for a room owned by another pod:

1. The new pod publishes a handover request via Redis Pub/Sub
2. The owning pod receives the message and calls `releaseRoom()`
3. `releaseRoom()` saves snapshot to GCS, clears heartbeat, deletes lock
4. The new pod's client receives `1013` and retries

```typescript
// Handover listener
await subClient.subscribe("room-handover", async (message) => {
  const request = JSON.parse(message);
  if (this.activeRooms.has(request.roomId)) {
    await this.releaseRoom(request.roomId);
  }
});
```

---

### 3. GCS Storage (`src/gcsStorage.ts`)

Handles persistence of room snapshots and user-uploaded assets.

#### Room Snapshots

```typescript
// Storage path: gs://{bucket}/rooms/{roomId}
const getRoomSnapshotName = (roomId: string) => `rooms/${roomId}`;

// Fetch: Returns undefined for new rooms (404 is expected)
export async function fetchRoomSnapshot(roomId: string): Promise<RoomSnapshot | undefined>

// Persist: Saves with retry logic (3 attempts, exponential backoff)
export async function persistRoomSnapshot(roomId: string, snapshot: RoomSnapshot)
```

#### Asset Storage

```typescript
// Storage path: gs://{bucket}/uploads/{sanitized-uploadId}
const getAssetObjectName = (uploadId: string) => 
  `uploads/${uploadId.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;

// Upload: Streams request body directly to GCS
export async function handleAssetUpload(req: Request, res: Response)

// Download: Streams GCS object directly to response
export async function handleAssetDownload(req: Request, res: Response)
```

#### Retry Logic

Transient GCS errors are retried with exponential backoff:

```typescript
async function retryOperation<T>(
  operation: () => Promise<T>,
  retries = 3,
  delay = 1000
): Promise<T>
```

---

### 4. Metrics (`src/metrics.ts`)

Prometheus metrics for observability:

| Metric | Type | Description |
|--------|------|-------------|
| `tldraw_active_rooms` | Gauge | Rooms currently in memory |
| `tldraw_active_connections` | Gauge | Active WebSocket connections |
| `tldraw_room_latency` | Histogram | HTTP request duration |
| `tldraw_error_rate` | Counter | Error count by type |

Plus default Node.js metrics (memory, CPU, event loop, etc.).

---

### 5. URL Unfurling (`src/unfurl.ts`)

Extracts Open Graph metadata for link previews:

```typescript
// GET /api/unfurl?url=https://example.com
// Returns: { title, description, image, favicon }
```

Uses `open-graph-scraper` library.

---

## Room Management & Locking

### Why Distributed Locking?

In a multi-pod deployment, without coordination:
- Multiple pods could load the same room simultaneously
- Each would have divergent state
- Clients on different pods would see different data (split-brain)

### Lock Design

```
Redis Key:    lock:room:{roomId}
Value:        {pod-unique-id}
TTL:          10 seconds
Renewal:      Every 5 seconds
```

### Lock Lifecycle

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   ACQUIRE    │ ──► │    RENEW     │ ──► │   RELEASE    │
│   (SETNX)    │     │   (SET XX)   │     │    (DEL)     │
└──────────────┘     └──────────────┘     └──────────────┘
      │                    │                     │
      │                    │                     │
      ▼                    ▼                     ▼
   On first             Every 5s            On shutdown,
   connection           while active        last client leaves,
                                            or handover
```

### Failure Scenarios

| Scenario | Behavior |
|----------|----------|
| Pod crashes | Lock expires after 10s, another pod can acquire |
| Network partition | Lock expires, GCS has last saved state |
| Graceful shutdown | Lock deleted immediately, snapshot saved |

---

## Data Persistence

### Snapshot Strategy

- **Trigger**: On any data change
- **Frequency**: Throttled to max once per 10 seconds
- **Format**: JSON serialization of `RoomSnapshot`
- **Location**: `gs://{bucket}/rooms/{roomId}`

### Persistence Flow

```
User draws something
        │
        ▼
TLSocketRoom.onDataChange()
        │
        ▼
saveToGCSThrottled() [lodash.throttle, 10s]
        │
        ▼
persistRoomSnapshot()
        │
        ▼
GCS: rooms/{roomId}
```

### Data Recovery

On room load:
1. Fetch snapshot from GCS
2. If exists, initialize `TLSocketRoom` with `initialSnapshot`
3. If 404, start with empty room

---

## Kubernetes Infrastructure

### Deployment (`kubernetes/deployment.yaml`)

```yaml
spec:
  replicas: 3
  containers:
  - name: tldraw-sync
    resources:
      requests: { memory: "256Mi", cpu: "500m" }
      limits: { memory: "512Mi", cpu: "1000m" }
    livenessProbe:
      httpGet: { path: /metrics, port: 3001 }
    readinessProbe:
      httpGet: { path: /metrics, port: 3001 }
```

### HorizontalPodAutoscaler

```yaml
spec:
  minReplicas: 1
  maxReplicas: 10
  metrics:
  - type: Resource
    resource: { name: cpu, target: { averageUtilization: 70 } }
  - type: Resource
    resource: { name: memory, target: { averageUtilization: 70 } }
```

### Ingress (`kubernetes/ingress.yaml`)

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/upstream-hash-by: "$uri"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

**Key annotation**: `upstream-hash-by: "$uri"` enables consistent hashing based on the request URI, attempting to route requests for the same room to the same pod.

### Service Account (`kubernetes/service-account.yaml`)

Uses GKE Workload Identity to grant pods access to GCS without service account keys:

```yaml
annotations:
  iam.gke.io/gcp-service-account: "tldraw-sync-sa@{project}.iam.gserviceaccount.com"
```

---

## Request Flow

### New User Joining Existing Room

```
1. Client: WebSocket connect to wss://gcp-sync.tldraw.xyz/api/connect/room-abc?sessionId=xyz

2. NGINX: Hashes "room-abc" → routes to Pod B

3. Pod B (index.ts):
   - Parses roomId="room-abc", sessionId="xyz"
   - Upgrades HTTP to WebSocket
   - Emits 'connection' event

4. Pod B (roomManager.ts):
   - Checks activeRooms: not found
   - Checks loadingRooms: not found
   - Tries Redis SETNX on "lock:room:room-abc"
   
5a. Lock acquired:
    - Fetches snapshot from GCS
    - Creates TLSocketRoom
    - Starts lock heartbeat
    - Connects socket to room
    
5b. Lock denied (another pod owns it):
    - Publishes handover request
    - Closes socket with 1013 "Try Again Later"
    - Client retries (goes back to step 1)
```

### Asset Upload

```
1. Client: POST /api/uploads/my-image.png
   Body: <binary image data>

2. Pod (gcsStorage.ts):
   - Validates content-type (image/* or video/*)
   - Sanitizes uploadId
   - Streams body to GCS
   - Returns { ok: true }

3. Later references: GET /api/uploads/my-image.png
   - Streams from GCS with caching headers
```

---

## Known Limitations

### 1. Hash Ring Rebalancing During Scaling (RESOLVED)

**Problem**: NGINX consistent hashing (`upstream-hash-by: "$uri"`) recalculates when pods are added/removed. This causes the room-to-pod mapping to change, routing new connections to a different pod than the current room owner.

**Root Cause Analysis**:

The TLDraw Ingress Configuration previously stated "The same hash always maps to the same pod, ensuring consistency" - this assumption is **incorrect** for dynamic pod counts.

```
Example: Scale-up from 2 to 3 pods

Before:  hash("room-xyz") mod 2 = Pod A
After:   hash("room-xyz") mod 3 = Pod C  ← CHANGED

Pod A still holds the Redis lock, but new connections go to Pod C.
```

**Solution**: Coordinated Handover Protocol

When a pod receives a connection for a room owned by another pod:

1. Receiving pod detects lock conflict via Redis SETNX
2. Subscribes to completion channel `handover-complete:{roomId}`
3. Publishes handover request to `room-handover` channel
4. Owning pod saves state to GCS, releases lock, publishes completion
5. Receiving pod acquires lock, loads state, handles connection

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│   Pod C      │         │    Redis     │         │   Pod A      │
│  (new target)│         │              │         │   (owner)    │
└──────┬───────┘         └──────┬───────┘         └──────┬───────┘
       │                        │                        │
       │  SETNX lock:room:xyz   │                        │
       │───────────────────────►│                        │
       │◄───────────────────────│  DENIED                │
       │                        │                        │
       │  SUBSCRIBE             │                        │
       │  handover-complete:xyz │                        │
       │───────────────────────►│                        │
       │                        │                        │
       │  PUBLISH room-handover │                        │
       │───────────────────────►│───────────────────────►│
       │                        │                        │
       │                        │          Save to GCS   │
       │                        │          DEL lock      │
       │                        │◄───────────────────────│
       │                        │                        │
       │                        │  PUBLISH               │
       │  Receive completion    │  handover-complete:xyz │
       │◄───────────────────────│◄───────────────────────│
       │                        │                        │
       │  SETNX lock:room:xyz   │                        │
       │───────────────────────►│                        │
       │◄───────────────────────│  ACQUIRED              │
       │                        │                        │
       │  Load from GCS         │                        │
       │  Handle connection     │                        │
       ▼                        ▼                        ▼
```

**Existing User Migration**: When the owning pod releases the room, it closes all WebSocket connections with code `1013`. The tldraw client automatically reconnects, and NGINX routes them to the new owner pod. All users end up on the same room.

**Timeout Handling**: If handover doesn't complete within 5 seconds (owner crashed/unresponsive), the lock TTL (10s) ensures eventual acquisition.

**Metrics**: `tldraw_handover_*` metrics track frequency, success rate, and duration.

See `docs/hash-ring-rebalancing-proposal-presentation.md` for the original analysis.

### 2. No Active Room Migration

Rooms are not proactively migrated when pods scale down. The handover mechanism is reactive (triggered by conflicting connection attempts). This is acceptable because:

- Scale-down triggers graceful shutdown, releasing locks immediately
- New connections acquire locks normally on remaining pods
- Existing connections on terminated pods reconnect automatically

### 3. Single Region

The current design assumes single-region deployment. Multi-region would require additional coordination for Redis and GCS.

### 4. No Room TTL

Empty rooms are cleaned up when the last user leaves, but there's no automatic cleanup for abandoned rooms in GCS.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3001 | HTTP/WS server port |
| `REDIS_URL` | No | redis://localhost:6379 | Redis connection string |
| `GCS_BUCKET_NAME` | **Yes** | - | GCS bucket for persistence |
| `NODE_ENV` | No | - | Set to "production" in container |

---

## Dependencies

### Runtime

| Package | Purpose |
|---------|---------|
| `@tldraw/sync-core` | Room sync protocol implementation |
| `@tldraw/tlschema` | tldraw data schema |
| `@google-cloud/storage` | GCS SDK |
| `redis` | Redis client |
| `express` | HTTP server |
| `ws` | WebSocket server |
| `prom-client` | Prometheus metrics |
| `lodash.throttle` | Throttle GCS saves |
| `open-graph-scraper` | URL unfurling |

### Development

| Package | Purpose |
|---------|---------|
| `tsx` | TypeScript execution with watch mode |
| `typescript` | Type checking and compilation |
