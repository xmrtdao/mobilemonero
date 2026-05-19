#!/bin/bash
# Start Hermes Relay Tunnel (after initial setup)
# Usage: ./start-tunnel.sh

set -e

TUNNEL_NAME="hermes-relay"
CONFIG_FILE="/data/data/com.termux/files/home/.cloudflared/config.yml"
LOG_FILE="/data/data/com.termux/files/home/.cloudflared/tunnel.log"

echo "=== Starting XMRT DAO Fleet Tunnel ==="
echo "Tunnel: $TUNNEL_NAME"
echo "Config: $CONFIG_FILE"
echo "Log: $LOG_FILE"
echo ""

# Check if credentials exist
if [ ! -f "/data/data/com.termux/files/home/.cloudflared/hermes-relay.json" ]; then
    echo "ERROR: Tunnel credentials not found."
    echo "Run ./create-tunnel.sh first to authenticate and create the tunnel."
    exit 1
fi

# Check if tunnel is already running
if pgrep -f "cloudflared tunnel run $TUNNEL_NAME" > /dev/null 2>&1; then
    echo "Tunnel is already running."
    cloudflared tunnel list
    exit 0
fi

# Start the tunnel in background
echo "Starting tunnel..."
nohup cloudflared tunnel run $TUNNEL_NAME > $LOG_FILE 2>&1 &
TUNNEL_PID=$!

echo "Tunnel started with PID: $TUNNEL_PID"
echo ""
echo "Waiting for tunnel to connect..."
sleep 5

# Check if it's running
if ps -p $TUNNEL_PID > /dev/null 2>&1; then
    echo "Tunnel is running."
    echo ""
    echo "Endpoints:"
    echo "  - https://relay.mobilemonero.com"
    echo "  - https://fleet.mobilemonero.com"
    echo "  - https://health.mobilemonero.com"
    echo ""
    echo "Logs: tail -f $LOG_FILE"
    echo "Stop:  kill $TUNNEL_PID"
else
    echo "ERROR: Tunnel failed to start. Check logs:"
    tail -20 $LOG_FILE
    exit 1
fi
