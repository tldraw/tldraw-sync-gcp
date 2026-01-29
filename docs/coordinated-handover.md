# Two-Phase Coordinated Handover Protocol

This document describes the two-phase coordinated handover mechanism that ensures reliable room routing during Kubernetes scaling events.

## Problem Statement

When using NGINX consistent hashing (`upstream-hash-by: "$uri"`), the hash ring recalculates when pods are added or removed. This causes the room-to-pod mapping to change:

```
Before scale-up (2 pods):
  hash("room-xyz") → Pod A

After scale-up (3 pods):
  hash("room-xyz") → Pod C  ← Changed!
```

Without coordination, new connections route to the wrong pod, which cannot acquire the Redis lock (held by the original owner), resulting in infinite retry loops.

## Solution: Two-Phase Coordinated Handover

The handover uses a two-phase commit pattern to ensure users are only disconnected **after** the new owner is ready to serve them:

### Phase 1: Lock Transfer

1. **Detect conflict**: New pod (Pod C) fails to acquire lock via `SETNX`
2. **Subscribe first**: Pod C subscribes to `handover-lock-released:{roomId}` channel
3. **Request handover**: Pod C publishes request to `room-handover` channel
4. **Owner prepares**: Pod A saves state to GCS, releases lock
5. **Signal lock released**: Pod A publishes to `handover-lock-released:{roomId}`

### Phase 2: Ready Confirmation

6. **Acquire lock**: Pod C acquires lock after receiving lock-released signal
7. **Load state**: Pod C loads room state from GCS
8. **Signal ready**: Pod C publishes to `handover-ready:{roomId}`
9. **Close connections**: Pod A receives ready signal, NOW closes WebSocket connections
10. **Users reconnect**: Users automatically reconnect to Pod C (which is ready)

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
         │  handover-lock-released:xyz                           │
         │──────────────────────────►│                           │
         │                           │                           │
         │  PUBLISH room-handover    │                           │
         │  {roomId, targetPodId}    │                           │
         │──────────────────────────►│──────────────────────────►│
         │                           │                           │
         │                           │           Save to GCS     │
         │                           │           DEL lock        │
         │                           │           SUBSCRIBE       │
         │                           │           handover-ready  │
         │                           │◄──────────────────────────│
         │                           │                           │
         │                           │  PUBLISH                  │
         │  Receive lock-released    │  handover-lock-released   │
         │◄──────────────────────────│◄──────────────────────────│
         │                           │                           │
         │  SETNX lock:room:xyz      │                           │
         │──────────────────────────►│                           │
         │◄──────────────────────────│                           │
         │         ACQUIRED          │                           │
         │                           │                           │
         │  Load from GCS            │                           │
         │                           │                           │
         │  PUBLISH handover-ready   │                           │
         │──────────────────────────►│──────────────────────────►│
         │                           │                           │
         │                           │       Receive ready       │
         │                           │       Close 5 sockets     │
         │                           │        (code 1013)        │
         │                           │                           │
         │◄─────────────────────────────────────────────────────────────────
         │  Users 1-5 reconnect      │                           │
         │  (Pod C is READY)         │                           │
         │                           │                           │
         │  All 6 users now on Pod C │                           │
         ▼                           ▼                           ▼
```

## Why Two-Phase?

The original single-phase handover had a critical flaw: Pod A would close user connections **before** Pod C was ready. If Pod C crashed or was slow, users would be stuck in retry loops.

| Scenario                     | Single-Phase                  | Two-Phase                          |
| ---------------------------- | ----------------------------- | ---------------------------------- |
| Pod C healthy                | Users briefly disconnected    | Users disconnected only when ready |
| Pod C crashes after handover | Users stuck retrying (bad UX) | Same (unavoidable)                 |
| Pod C slow to load           | Users retry to unready pod    | Users stay connected until ready   |

## Redis Channels

| Channel                           | Direction     | Purpose                            |
| --------------------------------- | ------------- | ---------------------------------- |
| `room-handover`                   | Pod C → Pod A | Request room release               |
| `handover-lock-released:{roomId}` | Pod A → Pod C | Lock is free, acquire now          |
| `handover-ready:{roomId}`         | Pod C → Pod A | Ready to serve, close your sockets |

## Timeout Handling

Two separate timeouts provide safety:

| Timeout                     | Duration | Purpose                                |
| --------------------------- | -------- | -------------------------------------- |
| `HANDOVER_TIMEOUT_MS`       | 5s       | Pod C waiting for lock-released signal |
| `HANDOVER_READY_TIMEOUT_MS` | 10s      | Pod A waiting for ready signal         |

### Timeout Scenarios

| Scenario                       | Behavior                                                            |
| ------------------------------ | ------------------------------------------------------------------- |
| Pod A crashes before releasing | Timeout (5s), Pod C attempts SETNX, lock TTL (10s) expires, acquire |
| Pod C crashes after acquiring  | Timeout (10s), Pod A closes sockets, users reconnect elsewhere      |
| Network partition              | Both timeout, users retry, system self-heals                        |
| Pod C slow to load             | Pod A waits up to 10s, then closes sockets anyway                   |

```typescript
const HANDOVER_TIMEOUT_MS = 5000 // Wait for lock release
const HANDOVER_READY_TIMEOUT_MS = 10000 // Wait for new owner ready
const LOCK_TIMEOUT_SEC = 10 // Redis lock TTL
```

## Edge Cases

| Scenario                        | Behavior                                                       |
| ------------------------------- | -------------------------------------------------------------- |
| Owner crashes mid-handover      | Lock-released timeout, attempt acquisition, lock TTL expires   |
| Multiple pods request same room | All wait for lock-released, first to SETNX wins, others retry  |
| Lock expires during wait        | Acquisition succeeds immediately                               |
| Ready signal lost               | Timeout (10s), Pod A closes sockets anyway, users reconnect    |
| Network partition               | Timeouts on both sides, users reconnect, eventually consistent |

## Metrics

| Metric                             | Type      | Description                                        |
| ---------------------------------- | --------- | -------------------------------------------------- |
| `tldraw_handover_requests_total`   | Counter   | Handover requests initiated                        |
| `tldraw_handover_success_total`    | Counter   | Handovers completed (lock acquired after handover) |
| `tldraw_handover_timeouts_total`   | Counter   | Lock-released timeouts                             |
| `tldraw_handover_duration_seconds` | Histogram | Time from request to lock acquisition              |

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
const redisClient = createClient() // Commands (SET, GET, DEL)
const subClient = redisClient.duplicate() // room-handover subscription
const pubClient = redisClient.duplicate() // Publishing
const handoverSubClient = redisClient.duplicate() // Dynamic per-room subscriptions
```

The separation is necessary because Redis subscriptions put the connection into a special mode where only subscription commands are allowed.

## WebSocket Keep-Alive

To prevent GCP Load Balancer idle timeouts (default 30s) from killing WebSocket connections, the server implements server-side ping:

```typescript
const PING_INTERVAL_MS = 25000 // 25 seconds, under GCP's 30s timeout

wss.on("connection", (ws) => {
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping()
    }
  }, PING_INTERVAL_MS)

  ws.on("close", () => clearInterval(pingInterval))
})
```

This is critical for handover reliability:

- Long-running connections stay alive during normal operation
- Users remain connected while waiting for handover to complete
- Only code `1013` from the server (after ready signal) triggers reconnection

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

| Environment Variable | Default                  | Description                        |
| -------------------- | ------------------------ | ---------------------------------- |
| `REDIS_URL`          | `redis://localhost:6379` | Redis connection string            |
| `HOSTNAME`           | Auto-generated           | Pod identifier (set by Kubernetes) |

## Comparison with Alternatives

| Approach               | Latency            | Complexity | Reliability         |
| ---------------------- | ------------------ | ---------- | ------------------- |
| **Two-Phase Handover** | +0-10s on conflict | Medium     | High                |
| Single-phase handover  | +0-5s on conflict  | Medium     | Medium (UX gap)     |
| Server-side proxy      | +1ms always        | Medium     | Medium (proxy SPOF) |
| Client retry only      | Infinite loop      | Low        | **Broken**          |

## Implementation Files

- `src/roomManager.ts` - Core two-phase handover logic
- `src/metrics.ts` - Handover metrics
- `test-handover.js` - Integration test

## Data Safety Guarantees

1. **State is always saved before lock release**: GCS snapshot persisted in Phase 1
2. **One owner at a time**: Redis SETNX ensures mutual exclusion
3. **Eventual consistency**: Timeouts ensure system recovers from any failure
4. **No data loss**: Users reconnect to fresh state from GCS
