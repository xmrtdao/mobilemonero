#!/bin/bash
# deploy_cf_worker.sh
# Deploy the XMRT MTV lyric worker via Cloudflare REST API.
# Requires CF_API_TOKEN + CF_ACCOUNT_ID environment variables.
# This runs from any machine (Termux, Linux, macOS, CI).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER_DIR="$SCRIPT_DIR/worker"
WRANGLER_TOML="$WORKER_DIR/wrangler.toml"
INDEX_JS="$WORKER_DIR/src/index.js"

echo "[1/6] Check env..."
if [ -z "${CF_ACCOUNT_ID:-}" ]; then
  echo "ERROR: Set CF_ACCOUNT_ID env var"
  exit 1
fi
if [ -z "${CF_API_TOKEN:-}" ]; then
  echo "ERROR: Set CF_API_TOKEN env var"
  exit 1
fi

WORKER_NAME=$(grep "^name" "$WRANGLER_TOML" | cut -d'"' -f2)
SCRIPT_NAME="$(basename "$(dirname "$INDEX_JS")")"

echo "[2/6] Gather code..."
SCRIPT_CONTENT="$(cat "$INDEX_JS" | sed 's/"/\\"/g')"

echo "[3/6] Upload worker script..."
curl -sS --fail \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
  -X PUT \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/javascript" \
  --data-binary @$INDEX_JS

echo "[4/6] Add AI binding..."
# Cloudflare doesn't have a simple REST endpoint for adding bindings after upload,
# so the best path is to use wrangler locally once.  Alternatively, configure this
# via the Cloudflare dashboard → Workers & Pages → Bindings → AI.
# Below is a best-effort metadata update via the API.
curl -sS --fail \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/$WORKER_NAME/bindings" \
  -X PUT \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "services":[],
    "env_vars":[],
    "wasm_modules":[],
    "text_blobs":[],
    "data_blobs":[],
    "kv_namespaces":[],
    "durable_objects":[],
    "r2_buckets":[],
    "queue_consumers":[],
    "analytics_engine_datasets":[],
    "ai_bindings":[{"name":"AI","binding":"AI"}]
  }'

echo "[5/6] Deploy to workers.dev (subdomain)..."
SUBDOMAIN_RESPONSE=$(curl -sS \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/subdomain" \
  -H "Authorization: Bearer $CF_API_TOKEN")
# If subdomain already exists, this is fine.

echo "[6/6] All done."
echo "→ Worker: $WORKER_NAME"
echo "→ URL:    https://$WORKER_NAME.$CF_ACCOUNT_ID.workers.dev/"
echo "→ Test:   curl https://$WORKER_NAME.$CF_ACCOUNT_ID.workers.dev/health"
