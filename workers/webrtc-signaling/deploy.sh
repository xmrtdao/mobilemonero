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

echo "Deploying WebRTC Signaling Worker..."
wrangler deploy src/index.js --name webrtc-signaling \
  --compatibility-date $(date +%Y-%m-%d) \
  --kv-namespaces WEBRTC_KV:id=${WEBRTC_KV_NAMESPACE_ID}

echo "Done."
