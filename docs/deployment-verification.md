# Deployment & Verification Guide

This document provides steps to deploy and verify the coordinated handover solution.

## Pre-Deployment Checklist

- [ ] Redis is accessible from all pods
- [ ] GCS bucket is configured and accessible
- [ ] Docker image built successfully
- [ ] Kubernetes manifests updated (if needed)

## Build & Deploy

```bash
# 1. Build locally to verify no errors
npx tsc

# 2. Build Docker image
docker build -t tldraw-sync-gcp:latest .

# 3. Tag and push to Artifact Registry
docker tag tldraw-sync-gcp:latest europe-west1-docker.pkg.dev/<project-id>/tldraw-sync/tldraw-gcp:v3
docker push europe-west1-docker.pkg.dev/<project-id>/tldraw-sync/tldraw-gcp:v3

# 4. Update deployment image tag
kubectl set image deployment/tldraw-sync-deployment tldraw-sync=europe-west1-docker.pkg.dev/<project-id>/tldraw-sync/tldraw-gcp:v3

# 5. Watch rollout
kubectl rollout status deployment/tldraw-sync-deployment
```

## Verification Tests

### Test 1: Basic Connectivity

```bash
# Connect to a room
wscat -c "wss://gcp-sync.tldraw.xyz/api/connect/test-room-1?sessionId=user-1"
```

Expected: Connection established, no errors.

### Test 2: Handover After Scale-Up

```bash
# Terminal 1: Connect user and keep connection open
wscat -c "wss://gcp-sync.tldraw.xyz/api/connect/handover-test?sessionId=user-1"

# Terminal 2: Scale up
kubectl scale deployment/tldraw-sync-deployment --replicas=4

# Terminal 3: Connect second user (may trigger handover)
wscat -c "wss://gcp-sync.tldraw.xyz/api/connect/handover-test?sessionId=user-2"
```

Expected:
- User 1 may see connection close with code 1013 (then auto-reconnect)
- User 2 connects successfully
- Both users end up on same room

### Test 3: Run Integration Test

```bash
node test-handover.js wss://gcp-sync.tldraw.xyz
```

Expected: All tests pass.

### Test 4: Check Metrics

```bash
# Port-forward to a pod
kubectl port-forward deployment/tldraw-sync-deployment 3001:3001

# Check metrics
curl localhost:3001/metrics | grep tldraw_handover
```

Expected output:
```
# HELP tldraw_handover_requests_total Total handover requests initiated
# TYPE tldraw_handover_requests_total counter
tldraw_handover_requests_total 0

# HELP tldraw_handover_success_total Successful handovers completed
# TYPE tldraw_handover_success_total counter
tldraw_handover_success_total 0

# HELP tldraw_handover_timeouts_total Handovers that timed out
# TYPE tldraw_handover_timeouts_total counter
tldraw_handover_timeouts_total 0

# HELP tldraw_handover_duration_seconds Time taken for handover coordination
# TYPE tldraw_handover_duration_seconds histogram
```

### Test 5: Check Logs During Handover

```bash
# Follow logs from all pods
kubectl logs -l app=tldraw-sync -f | grep -E "\[Handover\]|\[Lock\]"
```

Expected log sequence during handover:
```
[Lock] Room xyz owned by pod-a-xxx, initiating handover...
[Handover] Received request for room xyz from pod-b-yyy
[Handover] We own room xyz, initiating release...
[Handover] Releasing room xyz with 5 connected users
[Handover] Saved snapshot for room xyz
[Handover] Released lock for room xyz
[Handover] Published completion for room xyz
[Handover] Closing 5 WebSocket connections for room xyz
[Handover] Room xyz released successfully
[Handover] Received completion for room xyz
[Lock] Handover completed for room xyz in 0.15s
[Lock] Acquired lock for room xyz after handover
```

## Rollback Procedure

If issues are detected:

```bash
# Rollback to previous version
kubectl rollout undo deployment/tldraw-sync-deployment

# Or rollback to specific revision
kubectl rollout undo deployment/tldraw-sync-deployment --to-revision=2
```

## Monitoring Alerts (Recommended)

Add these alerts in GCP Cloud Monitoring:

### High Handover Timeout Rate
```yaml
Condition: tldraw_handover_timeouts_total / tldraw_handover_requests_total > 0.1
Duration: 5 minutes
Severity: Warning
```

### Slow Handovers
```yaml
Condition: histogram_quantile(0.95, tldraw_handover_duration_seconds) > 3
Duration: 5 minutes  
Severity: Warning
```

### Handover Errors in Logs
```yaml
Log filter: resource.type="k8s_container" AND "[Handover] Error"
Severity: Error
```

## Verifying the Fix for Google Partner

After deployment, you can demonstrate:

1. **Scale-up scenario**: Add a new pod while users are active
2. **Show logs**: Handover coordination happening
3. **Show metrics**: `tldraw_handover_success_total` incrementing
4. **User experience**: Brief reconnect, no data loss, all users in same room

## Files Changed

| File | Changes |
|------|---------|
| `src/roomManager.ts` | Coordinated handover with subscription-before-publish pattern |
| `src/metrics.ts` | Added 4 handover metrics |
| `docs/architecture.md` | Updated Known Limitations section |
| `docs/coordinated-handover.md` | New protocol documentation |
| `test-handover.js` | New integration test |
| `docs/deployment-verification.md` | This file |
