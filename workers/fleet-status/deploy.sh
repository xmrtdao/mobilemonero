#!/bin/bash
# deploy_cf_worker.sh
# Deploy this worker via Cloudflare REST API.
# Requires CF_API_TOKEN + CF_ACCOUNT_ID environment variables.
# Runs from any machine (Termux, Linux, macOS, CI).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER_DIR="$SCRIPT_DIR"
WRANGLER_TOML="$WORKER_DIR/wrangler.toml"
INDEX_JS="$WORKER_DIR/src/index.js"

echo "[1/4] Check env..."
if [ -z "${CF_ACCOUNT_ID:-}" ]; then
  echo "ERROR: Set CF_ACCOUNT_ID env var"
  exit 1
fi
if [ -z "${CF_API_TOKEN:-}" ]; then
  echo "ERROR: Set CF_API_TOKEN env var"
  exit 1
fi

WORKER_NAME=$(grep "^name" "$WRANGLER_TOML" | cut -d'"' -f2)

echo "[2/4] Gather code..."
echo "[3/4] Upload worker script '$WORKER_NAME' to account $CF_ACCOUNT_ID..."
curl -sS --fail \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
  -X PUT \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/javascript" \
  --data-binary @$INDEX_JS

echo ""
echo "[4/4] Worker uploaded and deployed."
echo "→ Worker: $WORKER_NAME"
echo "→ Dashboard: https://dash.cloudflare.com/$CF_ACCOUNT_ID/workers/services/view/$WORKER_NAME"
echo ""
echo "NOTE: If your workers.dev subdomain is not active, visit:"
echo "  https://dash.cloudflare.com/?to=/:account/workers/workers-and-pages"
echo "to activate it. Once active, your worker will be live at:"
echo "  https://$WORKER_NAME.xmrtdao-xmrt-dao-nb.workers.dev/health"
echo ""
echo "To add a custom domain (e.g. $WORKER_NAME.mobilemonero.com), provide a token with Zone:Edit scope and run domain mapping separately."
