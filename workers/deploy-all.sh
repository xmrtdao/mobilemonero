#!/bin/bash
# Deploy ALL XMRT DAO Cloudflare Workers
# Termux-compatible (no wrangler)
# Usage: ./deploy-all.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=false

if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
  echo "=== DRY RUN MODE ==="
  echo ""
fi

echo "=== XMRT DAO Worker Fleet Deployment ==="
echo ""

# Check env
echo "[PRE] Checking environment..."
if [ -z "${CF_ACCOUNT_ID:-}" ]; then
  echo "ERROR: Set CF_ACCOUNT_ID env var"
  echo "  export CF_ACCOUNT_ID='your-account-id'"
  exit 1
fi
if [ -z "${CF_API_TOKEN:-}" ]; then
  echo "ERROR: Set CF_API_TOKEN env var"
  echo "  export CF_API_TOKEN='your-api-token'"
  exit 1
fi
echo "✓ CF_ACCOUNT_ID: ${CF_ACCOUNT_ID:0:8}..."
echo "✓ CF_API_TOKEN: ${CF_API_TOKEN:0:8}..."
echo ""

# Worker list (order matters for dependencies)
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
)

DEPLOYED=0
FAILED=0

for WORKER in "${WORKERS[@]}"; do
  DEPLOY_SCRIPT="$SCRIPT_DIR/$WORKER/deploy.sh"
  
  if [ ! -f "$DEPLOY_SCRIPT" ]; then
    echo "⊘ $WORKER: No deploy.sh found (skipping)"
    continue
  fi
  
  echo "→ Deploying: $WORKER"
  
  if [ "$DRY_RUN" = true ]; then
    echo "  [DRY RUN] Would run: bash $DEPLOY_SCRIPT"
    ((DEPLOYED++)) || true
  else
    if bash "$DEPLOY_SCRIPT" 2>&1; then
      echo "  ✓ $WORKER deployed"
      ((DEPLOYED++)) || true
    else
      echo "  ✗ $WORKER failed"
      ((FAILED++)) || true
    fi
  fi
  
  echo ""
done

echo "=== Summary ==="
echo "Deployed: $DEPLOYED"
echo "Failed: $FAILED"
echo ""

if [ "$DRY_RUN" = false ]; then
  echo "Workers live at:"
  for WORKER in "${WORKERS[@]}"; do
    echo "  https://$WORKER.xmrtdao-xmrt-dao-nb.workers.dev/health"
  done
  echo ""
  echo "To add custom domains (e.g. api.mobilemonero.com):"
  echo "  cloudflared tunnel route dns $WORKER api.mobilemonero.com"
  echo "  OR use Cloudflare Dashboard → Workers → Add Route"
fi
