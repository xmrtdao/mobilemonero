#!/usr/bin/env bash
# XMRT Mesh Multi-Node Launcher
# Usage: ./mesh-launcher.sh [peers]
# Example: ./mesh-launcher.sh "192.168.1.50:4002,10.0.0.12:4003"

AGENT=${1:-hermes}
PEERS=${2:-""}
BASE_PORT=4001

if [ "$AGENT" = "all" ]; then
    echo "=== XMRT Mesh: Starting ALL 3 nodes ==="
    echo "  Hermes : port 4001"
    echo "  Vex    : port 4002"
    echo "  Eliza  : port 4003"
    echo "========================================="

    # Hermes node (this device)
    echo "[1/3] Starting Hermes mesh node (port 4001)..."
    nohup python3 mesh-node.py hermes "$PEERS" > /dev/null 2>&1 &
    sleep 1
    curl -s --max-time 2 http://localhost:4001/health >/dev/null && echo "  ✅ Hermes up"

    # Vex node (simulated local for testing, external should use real IP)
    echo "[2/3] Starting Vex mesh node (port 4002)..."
    nohup python3 mesh-node.py vex "127.0.0.1:4001,127.0.0.1:4003" > /dev/null 2>&1 &
    sleep 1
    curl -s --max-time 2 http://localhost:4002/health >/dev/null && echo "  ✅ Vex up"

    # Eliza node (simulated local for testing)
    echo "[3/3] Starting Eliza mesh node (port 4003)..."
    nohup python3 mesh-node.py eliza "127.0.0.1:4001,127.0.0.1:4002" > /dev/null 2>&1 &
    sleep 1
    curl -s --max-time 2 http://localhost:4003/health >/dev/null && echo "  ✅ Eliza up"

    echo ""
    echo "=== Mesh Topology ==="
    echo "  Hermes (4001) ↔ Vex (4002) ↔ Eliza (4003)"
    echo ""
    echo "=== Test Commands ==="
    echo "  curl http://localhost:4001/health"
    echo "  curl -X POST http://localhost:4001/broadcast -H 'Content-Type: application/json' -d '{\"agent\":\"hermes\",\"message\":\"hello mesh\"}'"
    echo "  curl http://localhost:4002/messages"
    echo ""
else
    # Single node mode
    echo "Starting mesh node: agent=$AGENT, peers=$PEERS"
    python3 mesh-node.py "$AGENT" "$PEERS"
fi
