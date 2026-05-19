#!/bin/bash
# Deploy API Gateway Worker via Cloudflare REST API
# Termux-compatible (no wrangler)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER_NAME="api-gateway"
INDEX_JS="$SCRIPT_DIR/src/index.js"

echo "[1/3] Check env..."
if [ -z "${CF_ACCOUNT_ID:-}" ]; then
  echo "ERROR: Set CF_ACCOUNT_ID env var"
  exit 1
fi
if [ -z "${CF_API_TOKEN:-}" ]; then
  echo "ERROR: Set CF_API_TOKEN env var"
  exit 1
fi

echo "[2/3] Uploading worker '$WORKER_NAME'..."
curl -sS --fail \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
  -X PUT \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/javascript" \
  --data-binary @"$INDEX_JS"

echo ""
echo "[3/3] Deployed!"
echo "→ Worker: $WORKER_NAME"
echo "→ Dashboard: https://dash.cloudflare.com/$CF_ACCOUNT_ID/workers/services/view/$WORKER_NAME"
echo "→ Test: https://$WORKER_NAME.xmrtdao-xmrt-dao-nb.workers.dev/health"
