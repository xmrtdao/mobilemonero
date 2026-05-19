# XMRT DAO Fleet Relay

Hermes relay listener + Cloudflare tunnel for the Fleet (Vex, Eliza-Cloud, Hermes).

## Quick Start

### 1. Start the Relay
```bash
cd ~/mobilemonero/fleet
python3 hermes_relay_listener.py &
```

### 2. Start Cloudflare Tunnel

**Quick (temporary URL):**
```bash
bash start-quick-tunnel.sh
# Returns a trycloudflare.com URL (changes on restart)
```

**Permanent (requires Cloudflare account):**
```bash
bash create-tunnel.sh  # Run ONCE to authenticate
bash start-tunnel.sh   # Start the permanent tunnel
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `/` | Dashboard HTML |
| `/health` | Health check (JSON) |
| `/fleet/status` | Fleet agent status |
| `/fleet/messages` | Message log (GET) |
| `/fleet/broadcast` | Send message (POST) |

## Fleet Agents

- **Vex** — Primary relay agent
- **Eliza-Cloud** — Cloud-based Eliza instance
- **Hermes** — This agent (MobileMonero)

## Files

| File | Purpose |
|------|---------|
| `hermes_relay_listener.py` | Python HTTP server (port 9090) |
| `create-tunnel.sh` | One-time Cloudflare tunnel setup |
| `start-tunnel.sh` | Start permanent tunnel |
| `start-quick-tunnel.sh` | Start quick tunnel (temp URL) |
| `README.md` | This file |

## Configuration

Cloudflare config: `~/.cloudflared/config.yml`
Tunnel credentials: `~/.cloudflared/hermes-relay.json`
Tunnel logs: `~/.cloudflared/tunnel.log`

## Testing

```bash
# Health check
curl http://localhost:9090/health

# Fleet status
curl http://localhost:9090/fleet/status

# Broadcast a message
curl -X POST http://localhost:9090/fleet/broadcast \
  -H "Content-Type: application/json" \
  -d '{"agent":"hermes","message":"Fleet check-in","type":"status"}'

# Get messages
curl http://localhost:9090/fleet/messages?limit=10
```

## Permanent Tunnel Domains

After running `create-tunnel.sh`:
- relay.mobilemonero.com
- fleet.mobilemonero.com
- health.mobilemonero.com

## Troubleshooting

**Tunnel won't start:**
```bash
# Check credentials exist
ls -la ~/.cloudflared/hermes-relay.json

# Check tunnel list
cloudflared tunnel list

# View logs
tail -f ~/.cloudflared/tunnel.log
```

**Relay not responding:**
```bash
# Check if running
curl http://localhost:9090/health

# Restart relay
pkill -f hermes_relay_listener.py
python3 hermes_relay_listener.py &
```

---

Created: 2026-05-18
Part of XMRT DAO / MobileMonero
