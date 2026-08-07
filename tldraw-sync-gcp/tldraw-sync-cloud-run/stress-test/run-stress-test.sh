#!/bin/bash

set -e

ROOMS=${ROOMS:-100}
USERS_PER_ROOM=${USERS_PER_ROOM:-100}
DURATION=${DURATION:-5m}
RAMP_UP=${RAMP_UP:-2m}
BASE_URL=${BASE_URL:-wss://gcp-sync.tldraw.xyz}
TEST_NAME=${TEST_NAME:-default}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORTS_DIR="${SCRIPT_DIR}/reports"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_PREFIX="${TEST_NAME}-${TIMESTAMP}"

mkdir -p "${REPORTS_DIR}"

echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║                    TLDRAW SYNC STRESS TEST                           ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Configuration:"
echo "  Test Name:       $TEST_NAME"
echo "  Base URL:        $BASE_URL"
echo "  Rooms:           $ROOMS"
echo "  Users per room:  $USERS_PER_ROOM"
echo "  Total VUs:       $((ROOMS * USERS_PER_ROOM))"
echo "  Duration:        $DURATION"
echo "  Ramp-up:         $RAMP_UP"
echo ""
echo "Output: ${REPORTS_DIR}/${REPORT_PREFIX}-*"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "${SCRIPT_DIR}:/scripts:ro" \
    -v "${REPORTS_DIR}:/reports" \
    -e REPORT_PREFIX="${REPORT_PREFIX}" \
    grafana/k6 run \
    -e BASE_URL="$BASE_URL" \
    -e ROOMS="$ROOMS" \
    -e USERS_PER_ROOM="$USERS_PER_ROOM" \
    -e DURATION="$DURATION" \
    -e RAMP_UP="$RAMP_UP" \
    -e REPORT_PREFIX="$REPORT_PREFIX" \
    /scripts/k6-stress-with-report.js

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Reports:"
ls -la "${REPORTS_DIR}/${REPORT_PREFIX}"* 2>/dev/null || echo "  (check ${REPORTS_DIR})"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
