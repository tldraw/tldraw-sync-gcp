# Graceful Scale-Down Implementation

## Problem Statement

When Kubernetes scales down the deployment (via HPA or manual intervention), users connected to rooms on the terminated pod experience an abrupt disconnection. They see a "disconnect" message and immediately reconnect to another pod. This creates a poor user experience, especially during collaborative sessions.

**Observed behavior:**
```
User drawing in room → Pod selected for termination → SIGTERM → 
Immediate disconnect → User sees error → Reconnects to new pod
```

**Desired behavior:**
```
User drawing in room → Pod selected for termination → SIGTERM →
Pod stops accepting NEW connections → Existing users continue working →
Users naturally leave → Room empties → Pod terminates cleanly
```

## Solution Overview

We implemented a two-part strategy:

1. **Pod Deletion Cost** (Preventive) - Make Kubernetes prefer to delete pods with fewer active rooms
2. **Graceful Drain** (Reactive) - When a pod must terminate, wait for rooms to empty naturally

## Why This Approach?

### Kubernetes Scale-In Algorithm

When Kubernetes needs to reduce replicas, it doesn't pick pods randomly. According to the [ReplicaSet controller source code](https://rpadovani.com/k8s-algorithm-pick-pod-scale-in), pods are sorted by these criteria (in order):

1. Unassigned pods first
2. Pending → Unknown → Running
3. Not ready → Ready
4. **Lower `pod-deletion-cost` annotation → Higher cost**
5. More related pods on same node first
6. Shorter ready time first
7. Higher restart count first
8. Newer creation time first

The `controller.kubernetes.io/pod-deletion-cost` annotation (criterion #4) is the only user-controllable factor. By dynamically updating this value based on active room count, we influence which pod Kubernetes selects for termination.

### Why Not Just Use preStop Hooks?

A `preStop` hook alone has limitations:
- It delays termination but doesn't prevent pod selection
- The pod is already marked for termination when the hook runs
- New connections may still arrive during the hook execution

Our approach combines proactive prevention (deletion cost) with reactive handling (drain logic).

## Implementation Details

### Component 1: Pod Deletion Cost Annotation

**File:** `src/podAnnotator.ts`

The pod periodically updates its own `pod-deletion-cost` annotation based on active room count:

```
Active Rooms    Deletion Cost    Effect
-----------     -------------    ------
0 rooms         0                Most likely to be deleted
5 rooms         5,000            Protected
20 rooms        20,000           Highly protected
```

**How it works:**
1. On startup, the pod initializes a Kubernetes API client using in-cluster credentials
2. Every 30 seconds, it calculates: `cost = activeRooms × 1000`
3. It patches its own pod annotation via the Kubernetes API
4. When shutting down, it sets cost to 0 (making itself preferred for deletion)

**Requirements:**
- `POD_NAME` and `POD_NAMESPACE` environment variables (via Downward API)
- RBAC permissions to `get` and `patch` pods in its namespace

### Component 2: Graceful Drain on Shutdown

**File:** `src/roomManager.ts`

When SIGTERM is received:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Set isShuttingDown = true                                │
│ 2. Stop accepting new WebSocket connections                 │
│ 3. Enter drain loop:                                        │
│    ├── Check activeRooms.size every 1 second                │
│    ├── If size === 0 → proceed to finalize                  │
│    └── If 270 seconds elapsed → timeout, force finalize     │
│ 4. Finalize:                                                │
│    ├── Save all remaining room snapshots to GCS             │
│    ├── Release all Redis locks                              │
│    └── Exit process                                         │
└─────────────────────────────────────────────────────────────┘
```

**Key constants:**
- `MAX_DRAIN_WAIT_BEFORE_TERMINATION_MS`: 270,000ms (4.5 minutes)
- `terminationGracePeriodSeconds`: 300 (5 minutes in K8s)
- Buffer of 30 seconds for final cleanup operations

### Component 3: Connection Rejection During Drain

**File:** `src/index.ts`

During shutdown, new WebSocket upgrade requests are rejected immediately:

```typescript
server.on("upgrade", (request, socket, head) => {
  if (roomManager.isShuttingDown) {
    socket.destroy();
    return;
  }
  // ... normal handling
});
```

This ensures:
- No new rooms are created on a draining pod
- Existing rooms can naturally empty out
- Clients retry and connect to healthy pods

## File Changes Summary

| File | Purpose |
|------|---------|
| `src/podAnnotator.ts` | New module for K8s annotation management |
| `src/roomManager.ts` | Added drain logic and shutdown coordination |
| `src/index.ts` | Connection rejection during drain, annotator integration |
| `kubernetes/deployment.yaml` | Added `terminationGracePeriodSeconds`, Downward API env vars |
| `kubernetes/rbac.yaml` | New RBAC Role/RoleBinding for pod patching |
| `package.json` | Added `@kubernetes/client-node` dependency |

## Configuration

### Environment Variables

| Variable | Source | Purpose |
|----------|--------|---------|
| `POD_NAME` | Downward API | Pod self-identification for annotation updates |
| `POD_NAMESPACE` | Downward API | Namespace for K8s API calls |

### Kubernetes Resources

**RBAC (kubernetes/rbac.yaml):**
```yaml
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "patch"]
```

**Deployment (kubernetes/deployment.yaml):**
```yaml
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 300
      containers:
      - env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
```

## Deployment Steps

```bash
# 1. Apply RBAC permissions
kubectl apply -f kubernetes/rbac.yaml

# 2. Build and push new image
docker build -t <registry>/tldraw-gcp:v3 .
docker push <registry>/tldraw-gcp:v3

# 3. Update deployment image tag and apply
kubectl apply -f kubernetes/deployment.yaml
```

## Behavior Scenarios

### Scenario 1: Scale-down with idle pod available

```
State: Pod A (5 rooms), Pod B (0 rooms), Pod C (3 rooms)
HPA decides: scale from 3 → 2 replicas

Kubernetes selection:
  Pod A: cost=5000
  Pod B: cost=0     ← Selected (lowest cost)
  Pod C: cost=3000

Result: Pod B terminated immediately (no active users affected)
```

### Scenario 2: Scale-down, all pods have rooms

```
State: Pod A (5 rooms), Pod B (2 rooms), Pod C (3 rooms)
HPA decides: scale from 3 → 2 replicas

Kubernetes selection:
  Pod A: cost=5000
  Pod B: cost=2000  ← Selected (lowest cost)
  Pod C: cost=3000

Pod B receives SIGTERM:
  1. Sets cost=0, stops new connections
  2. Waits for 2 rooms to empty
  3. Users in those rooms finish and close tabs
  4. Rooms empty → Pod B exits cleanly

Result: Users experienced no interruption
```

### Scenario 3: Scale-down, users don't leave

```
Pod B selected, has 2 persistent rooms
Users don't leave for 4.5 minutes

Drain timeout reached:
  1. Force-save both room snapshots to GCS
  2. Release Redis locks
  3. Exit

Result: Users disconnected after 4.5min, but data preserved
        They reconnect to Pod A or C and resume
```

## Monitoring

The existing metrics can help monitor drain behavior:

- `tldraw_active_rooms` - Track room count during drain
- `tldraw_active_connections` - Track connection count

Consider adding:
- Drain duration histogram
- Forced termination counter (when timeout is reached)

## Limitations

1. **Maximum drain time**: Capped at 4.5 minutes to stay within `terminationGracePeriodSeconds`
2. **Persistent users**: If users never leave, they will eventually be disconnected
3. **Rapid scale-down**: Multiple pods terminating simultaneously may still cause disruption
4. **Local development**: Pod annotator is disabled when `POD_NAME` is not set

## Future Improvements

1. **Proactive room migration**: Before SIGTERM, migrate rooms to other pods
2. **Custom metrics for HPA**: Scale based on room count, not just CPU/memory
3. **Pod Disruption Budget**: Limit concurrent pod terminations
4. **Client-side handling**: Improve reconnection UX with seamless handoff
