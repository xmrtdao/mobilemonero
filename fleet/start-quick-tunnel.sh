#!/bin/bash
# Quick Cloudflare Tunnel for Hermes Relay (no named tunnel required)
# Uses quick-tunnel mode for immediate public URL
# For permanent tunnel, use create-tunnel.sh

set -e

PORT=9090
LOG_FILE="/data/data/com.termux/files/home/.cloudflared/quick-tunnel.log"

echo "=== Starting Cloudflare Quick Tunnel ==="
echo "Routing to: http://localhost:$PORT"
echo "Log: $LOG_FILE"
echo ""

# Check if relay is running
if ! curl -s http://localhost:$PORT/health > /dev/null 2>&1; then
    echo "ERROR: Fleet Relay not running on port $PORT"
    echo "Start it first: cd ~/mobilemonero/fleet && python3 hermes_relay_listener.py &"
    exit 1
fi

echo "Relay is UP. Starting tunnel..."

# Start quick tunnel in background
nohup cloudflared tunnel --url http://localhost:$PORT > $LOG_FILE 2>&1 &
TUNNEL_PID=$!

echo "Tunnel started with PID: $TUNNEL_PID"
echo ""
echo "Waiting for Cloudflare to assign URL..."
sleep 5

# Extract the public URL from logs
if [ -f "$LOG_FILE" ]; then
    PUBLIC_URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' $LOG_FILE | tail -1)
    if [ -n "$PUBLIC_URL" ]; then
        echo "=== Tunnel Active ==="
        echo "Public URL: $PUBLIC_URL"
        echo ""
        echo "This URL is temporary (changes on restart)."
        echo "For a permanent URL, run: ./create-tunnel.sh"
        echo ""
        echo "Logs: tail -f $LOG_FILE"
        echo "Stop:  kill $TUNNEL_PID"
    else
        echo "Tunnel starting... check logs: tail -f $LOG_FILE"
    fi
else
    echo "ERROR: Log file not created"
    exit 1
fi
