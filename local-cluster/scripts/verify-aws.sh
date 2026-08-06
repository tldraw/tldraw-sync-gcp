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
