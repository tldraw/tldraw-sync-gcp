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
