#!/usr/bin/env bash
#
# Enforces the duplication invariant from docs/adr/0001 and docs/adr/0003.
#
# Every deployment target ships its own copy of the server. That is deliberate,
# but its known cost is silent drift: a fix applied to one copy and not the
# others. The per-package test matrix cannot catch that — each copy passes its
# own tests perfectly well while saying something different from its siblings.
# This does catch it.
#
# Two rules:
#
#   1. The three GCP targets must be byte-identical in src/ and test/. There is
#      no per-target difference to express — ADR 0003's whole claim is that the
#      application does not change between them.
#
#   2. AWS and GCP may differ in exactly one thing: the storage module. Once
#      those identifiers are normalised away, every shared file must match.
#
# Run it locally the same way CI does: .github/scripts/check-cross-port.sh

set -uo pipefail

GKE=tldraw-sync-gcp/tldraw-sync-gke
GCP_SIBLINGS=(
  tldraw-sync-gcp/tldraw-sync-compute-engine
  tldraw-sync-gcp/tldraw-sync-cloud-run
)
AWS=tldraw-sync-aws

# Files shared between the clouds. The storage module and its test are excluded:
# they are the one sanctioned difference.
SHARED_FILES=(
  src/index.ts
  src/roomManager.ts
  src/metrics.ts
  src/unfurl.ts
  test/index.test.ts
  test/roomManager.test.ts
  test/unfurl.test.ts
  test/helpers/fakeRedis.ts
  test/helpers/http.ts
)

failed=0

fail() {
  failed=1
  printf '\n\033[31mDRIFT\033[0m %s\n' "$1"
}

# Collapses the sanctioned per-cloud difference so everything else must match.
normalise() {
  sed -e 's/s3Storage/STORAGE/g' \
    -e 's/gcsStorage/STORAGE/g' \
    -e 's/saveToS3Throttled/saveToStorageThrottled/g' \
    -e 's/saveToGCSThrottled/saveToStorageThrottled/g' \
    "$1"
}

echo "==> The three GCP targets must be byte-identical"
for sibling in "${GCP_SIBLINGS[@]}"; do
  for dir in src test; do
    if ! diff -r "$GKE/$dir" "$sibling/$dir" >/tmp/cross-port-diff 2>&1; then
      fail "$sibling/$dir differs from $GKE/$dir"
      cat /tmp/cross-port-diff
    fi
  done
  [ "$failed" -eq 0 ] && echo "    ok  $sibling"
done

echo "==> AWS and GCP may differ only in the storage module"
for file in "${SHARED_FILES[@]}"; do
  if [ ! -f "$AWS/$file" ] || [ ! -f "$GKE/$file" ]; then
    fail "$file is missing from one of $AWS or $GKE"
    continue
  fi
  if ! diff <(normalise "$GKE/$file") <(normalise "$AWS/$file") >/tmp/cross-port-diff; then
    fail "$file differs between $AWS and $GKE beyond the storage module"
    cat /tmp/cross-port-diff
  fi
done
[ "$failed" -eq 0 ] && echo "    ok  ${#SHARED_FILES[@]} shared files"

if [ "$failed" -ne 0 ]; then
  cat <<'EOF'

A change landed in one copy of the server but not the others.

The duplication is deliberate (docs/adr/0001, docs/adr/0003) and so is this
check: cross-porting is the cost that decision accepted, and it is a four-way
obligation. Apply the same change to every copy, then re-run.

If the divergence is intentional, it is a decision that needs recording — see
the tripwire in docs/adr/0003.
EOF
  exit 1
fi

echo
echo "All copies are in step."
