#!/usr/bin/env bash
# E2E verify for the AWS demo running in k3d: runs the demo's own
# verify-sync.mjs against Envoy on :8081, with LocalStack port-forwarded so the
# script's direct S3 checks (snapshot landed, cold-room restore) work.
# AWS does not go through ingress-nginx any more; GCP still does.
set -euo pipefail

CTX=k3d-tldraw-local
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIENT_DIR="$ROOT/tldraw-sync-aws/tldraw-client"

kubectl --context "$CTX" -n tldraw-aws port-forward svc/tldraw-aws-localstack 4566:4566 >/dev/null 2>&1 &
PF=$!
trap 'kill "$PF" 2>/dev/null || true' EXIT
sleep 3

cd "$CLIENT_DIR"
[ -d node_modules ] || npm install --no-audit --no-fund

AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
S3_ENDPOINT=http://localhost:4566 \
S3_BUCKET_NAME=tldraw-test-bucket \
AWS_REGION=us-east-1 \
node verify-sync.mjs "${AWS_URL:-http://localhost:8081}"
