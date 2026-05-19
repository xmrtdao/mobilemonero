#!/bin/bash
# Check health of all XMRT DAO Workers
# Usage: ./check-workers.sh [--verbose]
set -euo pipefail

VERBOSE=false
if [ "${1:-}" = "--verbose" ]; then
  VERBOSE=true
fi

echo "=== XMRT DAO Worker Health Check ==="
echo ""

WORKERS=(
  "fleet-status"
  "api-gateway"
  "ai-gateway"
  "1d-price-ticker"
  "2a-mtt-registry"
  "2b-offline-sync"
  "wasm-edge-compute"
  "webrtc-signaling"
  "zkp-verification"
  "mtv-lyrics"
)

BASE_URL="https://xmrtdao-xmrt-dao-nb.workers.dev"

UP=0
DOWN=0

for WORKER in "${WORKERS[@]}"; do
  URL="$BASE_URL/$WORKER/health"
  
  # Try to fetch health endpoint
  if HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$URL" 2>/dev/null); then
    if [ "$HTTP_CODE" = "200" ]; then
      echo "✓ $WORKER: UP ($HTTP_CODE)"
      ((UP++)) || true
    else
      echo "⚠ $WORKER: $HTTP_CODE"
      ((DOWN++)) || true
    fi
  else
    echo "✗ $WORKER: TIMEOUT"
    ((DOWN++)) || true
  fi
  
  if [ "$VERBOSE" = true ]; then
    RESPONSE=$(curl -s --max-time 5 "$URL" 2>/dev/null || echo "{}")
    echo "  Response: $RESPONSE" | head -c 200
    echo ""
  fi
done

echo ""
echo "=== Summary ==="
echo "UP: $UP"
echo "DOWN: $DOWN"
echo ""

if [ "$DOWN" -gt 0 ]; then
  echo "Workers may need deployment. Run:"
  echo "  cd ~/mobilemonero/workers"
  echo "  bash deploy-all.sh"
fi
