# Hash Ring Rebalancing: Issue Analysis & Proposed Solution

## Executive Summary

The current NGINX consistent hashing implementation does not guarantee stable room-to-pod mapping during scaling events. This document analyzes the issue and proposes a server-side proxying solution that ensures correct routing without client-side changes.

---

## The Problem

### Current Architecture

```
┌─────────────┐     WebSocket      ┌─────────────────────────────────┐
│   Client    │ ─────────────────► │         NGINX Ingress           │
│  (Browser)  │                    │   upstream-hash-by: "$uri"      │
└─────────────┘                    └───────────────┬─────────────────┘
                                                   │
                                                   ▼
                                   ┌───────────────────────────────┐
                                   │      ClusterIP Service        │
                                   └───────────────┬───────────────┘
                                                   │
                        ┌──────────────────────────┼──────────────────────────┐
                        ▼                          ▼                          ▼
                   ┌─────────┐                ┌─────────┐                ┌─────────┐
                   │  Pod A  │                │  Pod B  │                │  Pod C  │
                   └─────────┘                └─────────┘                └─────────┘
                        │                          │                          │
                        └──────────────────────────┼──────────────────────────┘
                                                   │
                                                   ▼
                                            ┌───────────┐
                                            │   Redis   │
                                            │  (Locks)  │
                                            └───────────┘
```

### Current Assumptions

The TLDraw Ingress Configuration document states:

> "The same hash always maps to the same pod, ensuring consistency"

**This assumption is incorrect.**

### Why It Fails

NGINX uses a **ring-based hash space** for consistent hashing. When the number of backend pods changes, the hash ring is recalculated, and **key-to-pod mappings can change**.

#### Failure Scenario: Scale-Up

```
Timeline:

T0: 2 Pods Running (A, B)
    ┌─────────────────────────────────────────┐
    │  Hash Ring: [0-50%] → A, [50-100%] → B  │
    │  Room "xyz" (hash: 35%) → Pod A         │
    │  Pod A holds Redis lock for "xyz"       │
    │  Users actively collaborating on Pod A  │
    └─────────────────────────────────────────┘

T1: Scale-Up - Pod C Added
    ┌─────────────────────────────────────────┐
    │  Hash Ring Recalculated:                │
    │  [0-33%] → A, [33-66%] → C,[66-100%] → B│
    │  Room "xyz" (hash: 35%) → NOW Pod C     │
    └─────────────────────────────────────────┘

T2: New User Tries to Join Room "xyz"
    ┌─────────────────────────────────────────┐
    │  NGINX routes to Pod C (new hash)       │
    │  Pod C tries to acquire Redis lock      │
    │  Lock held by Pod A → DENIED            │
    │  Pod C returns: 1013 "Try Again Later"  │
    │  Client retries → NGINX → Pod C → 1013  │
    │  ∞ Retry loop until Pod A releases lock │
    └─────────────────────────────────────────┘
```

### Impact Analysis

| Scenario | Affected Users | Duration | Severity |
|----------|----------------|----------|----------|
| New user joins active room after scale-up | New users only | Until room empties on original pod | **High** |
| New user joins inactive room | None | N/A | None |
| Existing users in room | None (WebSocket established) | N/A | None |
| Scale-down with graceful shutdown | Brief interruption | ~2-5 seconds | Low |
| Pod crash | Brief interruption | ~10 seconds (lock TTL) | Medium |

### Root Cause

**Two independent systems that don't communicate:**

1. **NGINX Hash Ring** — Decides where requests are routed
2. **Redis Locks** — Decides who owns rooms

When pods scale, the hash ring changes but Redis locks remain unchanged. There is no synchronization mechanism.

---

## Current Code Analysis

### Room Lock Acquisition (`src/roomManager.ts`)

```typescript
const lockKey = `lock:room:${roomId}`;
const lockAcquired = await redisClient.set(lockKey, "locked", {
  EX: LOCK_TIMEOUT_SEC,  // 10 seconds
  NX: true,              // Only if Not eXists
});

if (!lockAcquired) {
  // No information about which pod owns the room
  // No way to redirect or proxy to correct pod
  safeWs.close(1013, "Room is hosted on another server, please retry.");
  return;
}
```

### What's Missing

1. **No pod identity in lock** — Lock value is just `"locked"`, not which pod owns it
2. **No routing intelligence** — Pod can't redirect/proxy to the correct owner
3. **No internal addressing** — Pods can't communicate directly with each other

---

## Proposed Solution: Server-Side Proxying

### Architecture Overview

```
                                      EXTERNAL
                                          │
                                          ▼
┌────────────────────────────────────────────────────────────────────┐
│                          NGINX Ingress                             │
│                (TLS termination, external entry point)             │
│                    Routes to: tldraw-svc (ClusterIP)               │
└────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌────────────────────────────────────────────────────────────────────┐
│                       ClusterIP Service                            │
│                      (tldraw-svc, port 80)                         │
└────────────────────────────────────────────────────────────────────┘
                                          │
                                      INTERNAL
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
              ▼                           ▼                           ▼
         ┌─────────┐                 ┌─────────┐                 ┌─────────┐
         │  Pod A  │ ◄─────────────► │  Pod B  │ ◄─────────────► │  Pod C  │
         └─────────┘                 └─────────┘                 └─────────┘
              ▲           Headless Service            ▲
              │        (internal pod-to-pod)          │
              │                                       │
              └───────────────┬───────────────────────┘
                              │
                              ▼
                        ┌───────────┐
                        │   Redis   │
                        │  (Locks)  │
                        └───────────┘
```

### Solution Components

| Component | Purpose | Status |
|-----------|---------|--------|
| NGINX Ingress | External traffic, TLS termination | Existing (no changes) |
| ClusterIP Service | Load balancing to pods | Existing (no changes) |
| **Headless Service** | Internal pod-to-pod direct addressing | **New** |
| **Pod Identity in Locks** | Track which pod owns each room | **New** |
| **WebSocket Proxying** | Forward connections to correct owner | **New** |

### Request Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              REQUEST FLOW                                  │
└────────────────────────────────────────────────────────────────────────────┘

1. Client connects via NGINX
   │
   ▼
2. NGINX routes to Pod B (via hash or round-robin)
   │
   ▼
3. Pod B checks Redis: "Who owns room xyz?"
   │
   ├─► Nobody owns it
   │   └─► Pod B acquires lock, handles connection directly
   │
   ├─► Pod B owns it
   │   └─► Pod B handles connection directly
   │
   └─► Pod A owns it
       └─► Pod B proxies WebSocket to Pod A via headless service
           Client is unaware of internal routing
```

---

## Implementation Details

### 1. Headless Service (New Kubernetes Resource)

```yaml
# kubernetes/headless-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: tldraw-sync-headless
  labels:
    app: tldraw-sync
spec:
  clusterIP: None  # Headless - enables direct pod DNS
  selector:
    app: tldraw-sync
  ports:
  - name: http
    port: 3001
    targetPort: 3001
    protocol: TCP
```

This enables pods to be addressed directly:
```
<pod-name>.tldraw-sync-headless.<namespace>.svc.cluster.local:3001
```

### 2. Pod Identity in Redis Locks

```typescript
// src/roomManager.ts

// Get pod identity from Kubernetes downward API or hostname
const POD_NAME = process.env.HOSTNAME || os.hostname();
const HEADLESS_SERVICE = process.env.HEADLESS_SERVICE || 'tldraw-sync-headless';
const NAMESPACE = process.env.NAMESPACE || 'default';

function getPodAddress(): string {
  return `${POD_NAME}.${HEADLESS_SERVICE}.${NAMESPACE}.svc.cluster.local`;
}

// When acquiring lock, store pod identity
const lockAcquired = await redisClient.set(lockKey, getPodAddress(), {
  EX: LOCK_TIMEOUT_SEC,
  NX: true,
});
```

---

## Trade-offs & Considerations

### Advantages

| Benefit | Description |
|---------|-------------|
| **No client changes** | External interface unchanged |
| **No NGINX changes** | Can even simplify to round-robin |
| **Guaranteed correctness** | Redis is single source of truth |
| **Graceful degradation** | Hash routing still reduces proxy frequency |
| **Simple implementation** | ~100 lines of new code |

### Disadvantages

| Drawback | Mitigation |
|----------|------------|
| Extra network hop when proxied | Internal networking is fast (<1ms); only affects initial connection |
| Proxy pod becomes intermediary | WebSocket is long-lived; overhead is minimal after connection |
| Additional K8s resource | Single simple manifest |

### Performance Characteristics

| Scenario | Latency Impact |
|----------|----------------|
| Request routed to correct pod | None |
| Request proxied to different pod | +0.5-2ms (internal network) |
| Ongoing WebSocket messages | None (direct connection or stable proxy) |

---

## Alternative Solutions Considered

| Approach | Complexity | Why Not Chosen |
|----------|------------|----------------|
| **Client-side redirect** | Medium | Client can't connect to internal K8s DNS; requires exposing pods externally |
| **Service mesh (Envoy/Istio)** | High | Overkill for this specific problem; adds infrastructure complexity |
| **Room handoff protocol** | Very High | Complex coordination; race conditions; requires pods to track hash ring state |
| **Accept limitation** | None | Unacceptable UX; users stuck in retry loops |

---

## Open Questions for Discussion

1. **Proxy timeout**: What timeout should we use for the internal proxy connection?
2. **Metrics**: Should we track proxy frequency as a metric?
3. **Circuit breaker**: Should we add circuit breaker logic if owner pod is unreachable?
4. **NGINX simplification**: Should we remove hash-based routing entirely and use round-robin?

---

## Appendix: Current vs Proposed Lock Behavior

### Current
```
Redis Key: lock:room:xyz
Value: "locked"
TTL: 10 seconds

→ No way to know which pod owns the room
```

### Proposed
```
Redis Key: lock:room:xyz
Value: "pod-abc123.tldraw-sync-headless.default.svc.cluster.local"
TTL: 10 seconds

→ Any pod can look up the owner and proxy to them
```
