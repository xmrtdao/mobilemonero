#!/bin/bash
# Create permanent Cloudflare Tunnel for XMRT DAO Fleet Relay
# Run this ONCE to authenticate and create the tunnel

set -e

echo "=== XMRT DAO Fleet Tunnel Setup ==="
echo ""

# Step 1: Authenticate with Cloudflare
echo "Step 1: Authenticating with Cloudflare..."
echo "This will open a browser window. Login with your Cloudflare account."
echo ""
cloudflared tunnel login

# Step 2: Create the tunnel
echo ""
echo "Step 2: Creating tunnel 'hermes-relay'..."
cloudflared tunnel create hermes-relay

# Step 3: Copy credentials file
echo ""
echo "Step 3: Copying credentials file..."
# The credentials file is created in ~/.cloudflared/<tunnel-id>.json
# We need to rename it to match our config
TUNNEL_ID=$(cloudflared tunnel list | grep hermes-relay | awk '{print $1}')
if [ -n "$TUNNEL_ID" ]; then
    cp ~/.cloudflared/${TUNNEL_ID}.json ~/.cloudflared/hermes-relay.json
    echo "Credentials saved to ~/.cloudflared/hermes-relay.json"
else
    echo "ERROR: Could not find tunnel ID. Check 'cloudflared tunnel list'"
    exit 1
fi

# Step 4: Route DNS
echo ""
echo "Step 4: Routing DNS..."
echo "Routing relay.mobilemonero.com -> tunnel"
cloudflared tunnel route dns hermes-relay relay.mobilemonero.com

echo ""
echo "Routing fleet.mobilemonero.com -> tunnel"
cloudflared tunnel route dns hermes-relay fleet.mobilemonero.com

echo ""
echo "Routing health.mobilemonero.com -> tunnel"
cloudflared tunnel route dns hermes-relay health.mobilemonero.com

# Step 5: Start the tunnel
echo ""
echo "=== Setup Complete! ==="
echo ""
echo "To start the tunnel permanently:"
echo "  cloudflared tunnel run hermes-relay"
echo ""
echo "Or as a background service (Termux):"
echo "  nohup cloudflared tunnel run hermes-relay > ~/.cloudflared/tunnel.log 2>&1 &"
echo ""
echo "To check status:"
echo "  cloudflared tunnel list"
echo "  cloudflared tunnel info hermes-relay"
echo ""
