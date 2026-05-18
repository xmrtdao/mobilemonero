#!/bin/bash
set -e

cd "$(dirname "$0")"

if [ -z "$CF_ACCOUNT_ID" ]; then
  echo "Error: CF_ACCOUNT_ID not set"
  exit 1
fi

if [ -z "$CF_API_TOKEN" ]; then
  echo "Error: CF_API_TOKEN not set"
  exit 1
fi

echo "Deploying WASM Edge Compute Stub Worker..."
wrangler deploy src/index.js --name wasm-edge-compute \
  --compatibility-date $(date +%Y-%m-%d)

echo "Done."
