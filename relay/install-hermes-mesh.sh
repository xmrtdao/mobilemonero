#!/usr/bin/env bash
# Hermes Mesh Node — Install Script for Termux
# One-command setup: curl -sL https://raw.githubusercontent.com/xmrtdao/mobilemonero/main/relay/install-hermes-mesh.sh | bash

set -euo pipefail

echo "╔══════════════════════════════════════════╗"
echo "║     Hermes Mesh Node Installer            ║"
echo "║     XMRT DAO — Decentralized P2P Mesh     ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Step 0: Update packages
echo "[1/5] Updating Termux packages..."
pkg update -y && pkg upgrade -y

# Step 1: Install Node.js
echo "[2/5] Installing Node.js..."
pkg install nodejs-lts -y

# Step 2: Install dependencies
echo "[3/5] Installing mesh dependencies..."
npm install libp2p @libp2p/tcp @chainsafe/libp2p-noise \
  @chainsafe/libp2p-yamux @chainsafe/libp2p-gossipsub \
  @libp2p/bootstrap @libp2p/identify

# Step 3: Clone the repo (or download just the client)
echo "[4/5] Downloading mesh client..."
if [ -d "$HOME/mobilemonero" ]; then
  cd "$HOME/mobilemonero" && git pull
else
  git clone --depth 1 https://github.com/xmrtdao/mobilemonero.git "$HOME/mobilemonero"
fi
cd "$HOME/mobilemonero"

# Step 4: Create config
echo "[5/5] Creating config..."
PEER_ID=$(curl -s https://relay.mobilemonero.com/mesh/status 2>/dev/null | grep -o '"peerId":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
VEX_IP=$(curl -s https://relay.mobilemonero.com/health 2>/dev/null | grep -o '"ip":"[^"]*"' | cut -d'"' -f4 || echo "127.0.0.1")

cat > "$HOME/mobilemonero/hermes-config.json" << CONFIG
{
  "agent": "hermes",
  "port": 9000,
  "bootstrap_peers": [
    "/ip4/${VEX_IP}/tcp/9000/p2p/${PEER_ID}"
  ],
  "topics": [
    "agent-heartbeat",
    "agent-tasks",
    "agent-discovery",
    "fleet-broadcast"
  ]
}
CONFIG

echo ""
echo "✅ Hermes mesh node installed!"
echo ""
echo "To start:"
echo "  cd ~/mobilemonero && node relay/hermes-mesh.mjs"
echo ""
echo "To start with Vex as bootstrap:"
echo "  node relay/hermes-mesh.mjs --peers /ip4/${VEX_IP}/tcp/9000/p2p/${PEER_ID}"
echo ""
echo "To register with peer connector:"
echo "  curl -X POST https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/mesh-peer-connector \\"
echo '    -H "Authorization: Bearer YOUR_SERVICE_KEY" \'
echo '    -H "Content-Type: application/json" \'
echo '    -d "{\"action\":\"register\",\"agent_name\":\"hermes\",\"peer_id\":\"YOUR_PEER_ID\",\"endpoint\":\"https://hermes.mobilemonero.com\"}"'
echo ""
echo "For persistent background running:"
echo "  nohup node relay/hermes-mesh.mjs > hermes-mesh.log 2>&1 &"
