# Coordinated Handover Protocol

This document describes the coordinated handover mechanism that ensures reliable room routing during Kubernetes scaling events.

## Problem Statement

When using NGINX consistent hashing (`upstream-hash-by: "$uri"`), the hash ring recalculates when pods are added or removed. This causes the room-to-pod mapping to change:

```
Before scale-up (2 pods):
  hash("room-xyz") → Pod A

After scale-up (3 pods):
  hash("room-xyz") → Pod C  ← Changed!
```

Without coordination, new connections route to the wrong pod, which cannot acquire the Redis lock (held by the original owner), resulting in infinite retry loops.

## Solution: Coordinated Handover

Instead of immediately rejecting connections when the lock is held by another pod, the receiving pod coordinates a handover:

1. **Detect conflict**: New pod fails to acquire lock via `SETNX`
2. **Subscribe first**: Subscribe to completion channel before requesting handover
3. **Request handover**: Publish request to `room-handover` channel
4. **Owner releases**: Original pod saves state, releases lock, publishes completion
5. **Acquire lock**: New pod acquires lock after receiving completion signal
6. **Handle connection**: New pod loads state from GCS and handles the client

## Protocol Flow

```
┌──────────────────┐          ┌──────────────┐          ┌──────────────────┐
│     Pod C        │          │    Redis     │          │      Pod A       │
│  (new target)    │          │              │          │  (owner, 5 users)│
│   User 6 joins   │          │              │          │                  │
└────────┬─────────┘          └──────┬───────┘          └────────┬─────────┘
         │                           │                           │
         │  SETNX lock:room:xyz      │                           │
         │──────────────────────────►│                           │
         │◄──────────────────────────│                           │
         │         DENIED            │                           │
         │                           │                           │
         │  SUBSCRIBE                │                           │
         │  handover-complete:xyz    │                           │
         │──────────────────────────►│                           │
         │                           │                           │
         │  PUBLISH room-handover    │                           │
         │  {roomId, targetPodId}    │                           │
         │──────────────────────────►│──────────────────────────►│
         │                           │                           │
         │                           │           Save to GCS     │
         │                           │           DEL lock        │
         │                           │           Close 5 sockets │
         │                           │            (code 1013)    │
         │                           │◄──────────────────────────│
         │                           │                           │
         │                           │  PUBLISH                  │
         │  Receive completion       │  handover-complete:xyz    │
         │◄──────────────────────────│◄──────────────────────────│
         │                           │                           │
         │  SETNX lock:room:xyz      │                           │
         │──────────────────────────►│                           │
         │◄──────────────────────────│                           │
         │         ACQUIRED          │                           │
         │                           │                           │
         │  Load from GCS            │                           │
         │  Handle User 6            │                           │
         │                           │                           │
         │◄─────────────────────────────────────────────────────────────────
         │  Users 1-5 reconnect      │                           │
         │  (NGINX routes to Pod C)  │                           │
         │                           │                           │
         │  All 6 users now on Pod C │                           │
         ▼                           ▼                           ▼
```

## Critical: Existing User Migration

When Pod A releases a room, it **must close all existing WebSocket connections** with code `1013`. This triggers the tldraw client's automatic reconnection:

1. Users 1-5 receive WebSocket close with code 1013
2. tldraw client automatically reconnects
3. NGINX routes reconnection to Pod C (new hash mapping)
4. Users 1-5 join room on Pod C
5. All 6 users are now collaborating on the same room

## Redis Channels

| Channel | Purpose | Message Format |
|---------|---------|----------------|
| `room-handover` | Request room release from current owner | `{ roomId, targetPodId }` |
| `handover-complete:{roomId}` | Signal that handover is complete | `{ roomId, previousOwner, timestamp }` |

## Timeout Handling

The handover has a 5-second timeout. If completion is not received:

1. **Owner crashed**: Lock TTL (10s) ensures eventual expiry
2. **Network issue**: Retry acquisition anyway (may succeed if lock expired)
3. **Owner slow**: Extra wait, but eventually succeeds or client retries

```typescript
const HANDOVER_TIMEOUT_MS = 5000;
const LOCK_TIMEOUT_SEC = 10;
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Owner crashes mid-handover | Timeout expires, lock TTL expires, new pod acquires |
| Multiple pods request same room | All wait, first to acquire after release wins, others retry |
| Lock expires during wait | Acquisition succeeds immediately after timeout |
| Owner has no room (stale lock) | Handover request ignored, timeout, lock may be stale |
| Network partition | Timeout, attempt acquisition anyway |

## Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `tldraw_handover_requests_total` | Counter | Handover requests initiated |
| `tldraw_handover_success_total` | Counter | Handovers completed successfully |
| `tldraw_handover_timeouts_total` | Counter | Handovers that timed out |
| `tldraw_handover_duration_seconds` | Histogram | Time taken for handover |

### Alerting Recommendations

```yaml
# High timeout rate may indicate network issues or pod health problems
- alert: HighHandoverTimeoutRate
  expr: rate(tldraw_handover_timeouts_total[5m]) / rate(tldraw_handover_requests_total[5m]) > 0.1
  for: 5m
  annotations:
    summary: "High handover timeout rate"

# Handover taking too long
- alert: SlowHandovers
  expr: histogram_quantile(0.95, tldraw_handover_duration_seconds_bucket) > 3
  for: 5m
  annotations:
    summary: "Handovers taking longer than expected"
```

## Redis Client Architecture

Four Redis connections are used to avoid blocking issues:

```typescript
const redisClient = createClient();      // Commands (SET, GET, DEL)
const subClient = redisClient.duplicate(); // room-handover subscription
const pubClient = redisClient.duplicate(); // Publishing
const handoverSubClient = redisClient.duplicate(); // Dynamic completion subscriptions
```

The separation is necessary because Redis subscriptions put the connection into a special mode where only subscription commands are allowed.

## Testing

Run the handover integration test:

```bash
# Local testing
node test-handover.js ws://localhost:3001

# Production testing
node test-handover.js wss://gcp-sync.tldraw.xyz
```

The test verifies:
1. First user establishes room ownership
2. Second user triggers handover coordination
3. Both users end up connected to the same room

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `HOSTNAME` | Auto-generated | Pod identifier (set by Kubernetes) |

## Comparison with Alternatives

| Approach | Latency | Complexity | Reliability |
|----------|---------|------------|-------------|
| **Coordinated Handover** | +0-5s on conflict | Medium | High |
| Server-side proxy | +1ms always | Medium | Medium (proxy SPOF) |
| HTTP redirect | +50ms redirect | High (NGINX config) | High |
| Client retry only | Infinite loop | Low | **Broken** |

## Implementation Files

- `src/roomManager.ts` - Core handover logic
- `src/metrics.ts` - Handover metrics
- `test-handover.js` - Integration test
