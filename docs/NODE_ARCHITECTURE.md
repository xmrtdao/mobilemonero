# XMRT DAO Node Architecture
> *Complete operational reference for running an XMRT DAO agent node.*
> *Targets: Windows laptop (Vex), Android Termux (Hermes), Cloud droplets (Eliza), XMRT Stick/Charger*

---

## 1. Node Components — What Runs Where

Every XMRT DAO node runs a **stack of processes** that together form a complete agent. Below is every process, its port, runtime, and role.

### Core Processes (Required)

| # | Process | Port | Runtime | Role | Required? |
|---|---------|------|---------|------|-----------|
| 1 | **Relay Server** | `8080` | Node.js 20+ | Central HTTP/REST agent — webhooks, tools, fleet chat, state, task dispatch | ✅ YES |
| 2 | **Gossipsub Mesh** | `9000` | Node.js (libp2p) | P2P pubsub mesh via `@chainsafe/libp2p-gossipsub` — 4 topics: heartbeat, tasks, discovery, broadcast | ✅ YES |
| 3 | **Python P2P Mesh** | `4001-4003` | Python 3.9+ | HTTP-based P2P fallback mesh with dedup + propagation (Mesh v2.1) | ✅ YES |
| 4 | **Cloudflare Tunnel** | — | cloudflared binary | Public ingress via `relay.mobilemonero.com` — exposes relay to fleet | ✅ YES |

### Supporting Processes (Optional)

| # | Process | Port | Runtime | Role | Required? |
|---|---------|------|---------|------|-----------|
| 5 | **Ollama** | `11434` | Go binary | Local LLM inference — 13 models (gemma4:e2b, etc.) | 🔶 Optional |
| 6 | **Go Relay Daemon** | `8081` | Go binary | Alternative relay with WebSocket + priority queue (redundant) | 🔶 Optional |
| 7 | **Rust Mesh Node** | `9000` | Rust binary | Native libp2p gossipsub (faster, for embedded/hardware) | 🔶 Optional |
| 8 | **CDP Browser** | `9222` | Chromium | Browser automation for form fills, PDF rendering | 🔶 Optional |
| 9 | **MCP Agent** | — | Node.js | MCP tool server for desktop automation | 🔶 Optional |

---

## 2. Port Map — One Node

```
┌─────────────────────────────────────────────────────┐
│                  XMRT DAO NODE                       │
│                                                      │
│  TCP Ports:                                          │
│    ┌────────┐                                        │
│    │  :8080  │  Relay Server (Express.js)            │
│    │         │  - Fleet chat send/receive            │
│    │         │  - Web search & scrape                │
│    │         │  - Tool dispatch                      │
│    │         │  - GitHub integration                 │
│    │         │  - Typefully scheduling               │
│    │         │  - Emoji-safe send endpoint           │
│    └────────┘                                        │
│                                                      │
│    ┌────────┐                                        │
│    │  :9000  │  Gossipsub P2P Mesh (libp2p TCP)     │
│    │         │  Topics:                              │
│    │         │   agent-heartbeat                     │
│    │         │   agent-tasks                         │
│    │         │   agent-discovery                     │
│    │         │   fleet-broadcast                     │
│    └────────┘                                        │
│                                                      │
│    ┌────────┐                                        │
│    │ :4001-3 │  Python P2P Mesh (HTTP fallback)     │
│    │         │  Hermes=4001, Vex=4002, Eliza=4003    │
│    │         │  SHA256 dedup + hop propagation       │
│    └────────┘                                        │
│                                                      │
│    ┌────────┐                                        │
│    │ :11434  │  Ollama (local LLM inference)         │
│    └────────┘                                        │
│                                                      │
│  Cloudflare Tunnel → relay.mobilemonero.com:443      │
│    (Proxies external traffic to :8080)               │
└─────────────────────────────────────────────────────┘
```

### Agent Port Assignments

| Agent | Gossipsub | Python Mesh | Relay | Notes |
|-------|-----------|-------------|-------|-------|
| **Vex** (Windows laptop) | `:9000` | `:4002` | `:8080` | Primary relay + mesh |
| **Hermes** (Android Termux) | `:9000` | `:4001` | — | Uses CF Worker for relay |
| **Eliza-Cloud** | `:9000` | `:4003` | — | Cloud VM |
| **Go Relay** (any) | `:9000` | — | `:8081` | Alternative relay daemon |

---

## 3. Runtime Dependencies

### Node.js (Core)
```
express             ^4.22.2     HTTP server
node-fetch          ^3.3.2      HTTP requests
sharp               ^0.34.5     Image processing
libp2p              2.x         P2P networking
@libp2p/tcp                    TCP transport
@chainsafe/libp2p-noise        Noise encryption
@chainsafe/libp2p-yamux        Stream multiplexing
@chainsafe/libp2p-gossipsub   v14.1.1  Pubsub mesh
@libp2p/bootstrap              Peer discovery
@libp2p/identify               Peer identification
```

### Python 3.9+ (Mesh v2.1)
```
requests                        HTTP for mesh propagation
```

### System Binaries
```
cloudflared                     Cloudflare Tunnel (Argo)
ollama                          Local LLM server (optional)
git                             Version control
```

### Cloud Dependencies (External)
```
Supabase                        Database + edge functions + auth
Cloudflare Workers              Edge compute fleet
GitHub                          Repos + CI/CD + issues
Stripe                          Payment processing
Resend                          Email delivery
Paragraph.xyz                   Content publishing
Typefully                       Social media scheduling
```

---

## 4. Startup Sequence

Starting a node from cold boot, in order:

```bash
# Step 1: Cloudflare Tunnel (public ingress)
cloudflared tunnel run relay-tunnel &
# → relay.mobilemonero.com → localhost:8080

# Step 2: Ollama (optional, for local AI)
ollama serve &
# → localhost:11434

# Step 3: Python P2P Mesh (fallback)
python mesh-node.py vex "hermes-ip:4001,eliza-ip:4003" &
# → localhost:4002

# Step 4: Relay Server (core agent)
node server.js &
# → localhost:8080
#   - Auto-initializes Cloudflare tunnel on startup
#   - Registers webhook endpoints

# Step 5: Gossipsub Mesh (primary P2P)
curl -X POST http://localhost:8080/mesh/init \
  -H "Content-Type: application/json" \
  -d '{"port": 9000, "agentName": "vex"}'
# → localhost:9000 (via libp2p TCP)
#   - Subscribes to 4 topics
#   - Starts 30s heartbeat publishing
```

**Total: 4-5 processes minimum** for a fully operational node.

---

## 5. File Layout

```
relay/                          # Relay server + mesh
├── server.js                   # Express relay (core agent)
├── package.json                # Node dependencies
├── .env                        # API keys & config
├── mesh-node.py                # Python P2P Mesh v2.1
├── lib/
│   ├── state.mjs               # Persistent key-value store
│   ├── task-runner.mjs         # Task execution engine
│   ├── auto-responder.mjs      # Email auto-responder
│   └── mesh-router.mjs         # Gossipsub mesh module
├── tools/                      # Tool scripts (47+)
│   ├── send.mjs                # UTF-8 safe fleet chat sender
│   ├── web-search.mjs
│   ├── web-scrape.mjs
│   ├── monitor.mjs
│   └── ...
├── relay-data/                 # Persistent state
│   ├── state.json
│   ├── cron-state.json
│   └── knowledge/
└── mesh/                       # Mesh documentation
    ├── mesh-node.py            # (synced from mobilemonero)
    ├── mesh-fleet-bridge.py    # Bridge mesh ↔ relay
    └── DISTRIBUTE.md           # Peer setup instructions
```

---

## 6. Health Check & Monitoring

Every node should expose and verify these endpoints:

```bash
# Relay health
curl http://localhost:8080/health
# → {"status":"ok","uptime":12345,"version":"5.0.0","tools":47}

# Gossipsub mesh status
curl http://localhost:8080/mesh/status
# → {"ok":true,"status":"running","peerId":"12D3...","peers":2,"topics":4}

# Python mesh health
curl http://localhost:4002/health
# → {"ok":true,"agent":"vex","port":4002,"peers":[...],"messages":42}

# Cloudflare tunnel (public)
curl https://relay.mobilemonero.com/health
# → {"status":"ok","uptime":12345,...}

# Ollama health (optional)
curl http://localhost:11434/api/tags
# → {"models":[...]}
```

### Quick Health Check Script
```bash
#!/usr/bin/env bash
# node-health.sh — Check all services on this node
for check in \
  "Relay:8080/health" \
  "Gossipsub:8080/mesh/status" \
  "PythonMesh:4002/health" \
  "Tunnel:relay.mobilemonero.com/health" \
  "Ollama:11434/api/tags"; do
  name="${check%%:*}"
  endpoint="${check#*:}"
  if echo "$endpoint" | grep -q '\.'; then
    result=$(curl -s --max-time 3 "https://$endpoint" 2>/dev/null || echo "FAIL")
  else
    port="${endpoint%%/*}"
    path="/${endpoint#*/}"
    result=$(curl -s --max-time 2 "http://localhost:$port$path" 2>/dev/null || echo "FAIL")
  fi
  status=$(echo "$result" | grep -c '"ok":true\|"status":"ok"\|"models"' || echo "0")
  [ "$status" -gt 0 ] && echo "✅ $name" || echo "❌ $name — $result"
done
```

---

## 7. Deployment Targets

### Target A: Cloud Droplet (DigitalOcean/Linode/Vultr)
- **OS:** Ubuntu 24.04 LTS
- **Runtime:** Node.js 20+, Python 3.10+, cloudflared
- **Setup:** Clone repo → `npm install` → configure `.env` → run startup sequence
- **Advantage:** Public IP, no tunnel needed for mesh, full compute
- **Cost:** ~$6-24/mo

### Target B: XMRT Stick / XMRT Charger (Embedded)
- **OS:** Linux (ARM64, Raspberry Pi OS or custom Yocto)
- **Runtime:** Node.js 20+ (ARM64), Python 3.9+, cloudflared
- **Storage:** 32GB+ microSD or eMMC
- **Mesh:** Rust binary (cross-compiled) for lower resource usage
- **LLM:** None / remote via Ollama on cloud
- **Startup:** Systemd units for each process

### Target C: Android Termux (Hermes)
- **Runtime:** Node.js (Termux), Python 3.11+, cloudflared
- **Constraints:** Limited disk (32GB phone), battery-aware, ARM64
- **Mesh:** Python HTTP P2P (tested), Rust binary from CI (when available)
- **Relay:** Cloudflare Worker instead of local Express
- **Tunnel:** CF Tunnel or direct Worker routing

### Target D: Windows Laptop (Vex / Eliza-Dev)
- **Runtime:** Node.js 20+, Python 3.12+, cloudflared.exe
- **Current deployment:** This machine
- **Constraints:** Firewall, sleep/suspend, MINGW64 shell quirks

---

## 8. Key Operational Notes

### Emoji / UTF-8 Encoding
- **Windows curl** corrupts UTF-8 emojis (CP1252 encoding)
- **Fix:** Use `node tools/send.mjs "message 🚀"` instead of `curl`
- The Node.js sender computes correct `Content-Length` with `Buffer.byteLength(payload, 'utf8')`

### Process Persistence
- Python mesh node runs in background via `nohup` or `start /B` (Windows)
- Relay auto-starts cloudflared tunnel on boot
- Gossipsub mesh is initialized via API call after relay starts
- **No systemd** on Windows — processes managed manually or via startup scripts

### Mesh Topology (Current)
```
Vex (relay.mobilemonero.com) → Hermes (hermes.mobilemonero.com)
  Gossipsub :9000             Gossipsub :9000
  Python    :4002             Python    :4001
  HTTP bridge via mesh-fleet-bridge.py
```

### Security
- Mesh traffic encrypted via Noise protocol (libp2p)
- Python HTTP mesh is plaintext — use only on trusted networks or via CF tunnel
- API keys stored in `.env` (never committed)
- CVE-2026-34219 and CVE-2026-33040 patched in rust-libp2p >= 0.49.4
- `@chainsafe/libp2p-gossipsub` v14.1.1 is JS-based, not affected

---

## 9. Future: Unified Launcher

Eventual goal — a single command to bring up a full node:

```bash
# Start everything on this machine
xmrtd start

# Check all services
xmrtd status

# Stop everything gracefully
xmrtd stop

# Configure peer mesh endpoints
xmrtd mesh peer add hermes 192.168.1.50:9000
xmrtd mesh peer add eliza cloud-vm:9000
```

This would be a Node.js or Go binary that orchestrates the process lifecycle.

---

*Documented 2026-05-21 by Vex. Part of the XMRT DAO agent fleet architecture.*
*Next: Package into `xmrtd` CLI for one-command node deployment.*
