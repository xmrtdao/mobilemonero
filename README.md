---
title: MobileMonero
emoji: 🏴
colorFrom: gray
colorTo: green
sdk: docker
app_port: 7860
---

# XMRT DAO Hub

[![🤗 HF Space](https://img.shields.io/badge/🤗%20HF%20Space-blue)](https://huggingface.co/spaces/XMRTDAO/mobilemonero)
[![GitHub](https://img.shields.io/badge/GitHub-Repo-black)](https://github.com/xmrtdao/mobilemonero)
[Edit in StackBlitz next generation editor ⚡️](https://stackblitz.com/~/github.com/xmrtdao/mobilemonero)

Central coordination hub for the XMRT DAO agent fleet. This repo tracks issues, architecture decisions, and fleet coordination for the decentralized Monero mining ecosystem.

## Fleet

| Agent | Platform | Role | Status |
|-------|----------|------|--------|
| **Vex** (TS Relay) | Windows laptop | Primary relay + Gossipsub mesh node | ✅ Active |
| **Eliza-Cloud** | Supabase Edge | Cloud coordination + mesh bridge | ✅ Active |
| **Hermes** | Android / Termux | Mobile agent, CF Worker, Python P2P mesh | ✅ Active |
| **Go Relay** | Windows/Linux | Redundant relay daemon | 🔧 Built, deploy-ready |
| **Rust Mesh** | Cross-platform | Native libp2p gossipsub | 🔧 CI added |

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                 GOSSUB MESH (libp2p)                  │
│  Topics: agent-heartbeat | agent-tasks               │
│          agent-discovery | fleet-broadcast           │
│  Port 9000 — Noise encryption — Yamux multiplexing   │
└──────────────────────┬───────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         │             │             │
┌────────┴──────┐ ┌────┴──────┐ ┌───┴──────────┐
│  Vex (relay)  │ │Go Relay   │ │Hermes (Termux)│
│  port 8080    │ │ port 8081 │ │ port 4001     │
│  gossipsub    │ │ WebSocket │ │ Python/P2P    │
│  :9000        │ │ dispatch  │ │ CF Worker     │
└───────┬───────┘ └───────────┘ └──────┬────────┘
        │                              │
        │     ┌──────────────────┐      │
        └─────│  Eliza-Cloud     │──────┘
              │  (Supabase/Deno) │
              │  mesh-bridge EF  │
              └──────────────────┘

HTTP P2P FALLBACK (Mesh v2.1):
  Vex:4002 ←→ Hermes:4001 ←→ Eliza:4003
  SHA256 dedup + hop propagation (≤10 hops)
  LAN/offline use — bridged to cloud via mesh-fleet-bridge.py

CLOUDFLARE WORKERS (mobilemonero.com):
  api-gateway | ai-gateway | fleet-status | price-ticker
  mtv-lyrics  | hermes     | inbox        | offline-sync (mesh)
```

## Communication

### Vex Relay (primary — tunnel: relay.mobilemonero.com)
- `GET /health` — health check
- `POST /eliza-ping` — fleet heartbeat
- `POST /dispatch` — structured task dispatch
- `POST /tools/run` — run relay tools
- `POST /api/fleet-chat/send` — send fleet message
- `GET /api/fleet-chat/messages` — read fleet messages

### Hermes Fleet Worker (primary CF Worker)
- `https://hermes.mobilemonero.com/fleet/broadcast` — broadcast fleet message
- `https://hermes.mobilemonero.com/fleet/messages` — poll fleet chat
- `https://hermes.mobilemonero.com/from/hermes` — DMs to Hermes
- `https://hermes.mobilemonero.com/health` — service status

### Gossipsub Mesh (port 9000 — via relay proxy)
- `POST /mesh/init` — initialize gossipsub node
- `POST /mesh/publish` — publish to topic
- `GET /mesh/status` — node status + peer info
- `GET /mesh/messages` — recent mesh messages
- Topics: `agent-heartbeat`, `agent-tasks`, `agent-discovery`, `fleet-broadcast`

### HTTP P2P Fallback (port 4001-4003)
- `POST /broadcast` — proxy to Python mesh node (via relay)
- `GET /api/p2p/health` — Python mesh health
- `GET /api/p2p/messages` — Python mesh message log

### Workers (all at *.mobilemonero.com)
| Worker | Endpoint | Purpose | Status |
|--------|----------|---------|--------|
| api-gateway | `api.mobilemonero.com` | API proxy, DNS-override for Termux | ✅ Active |
| ai-gateway | `ai.mobilemonero.com` | AI completions (kimi-k2.6:cloud) | ✅ Active |
| fleet-status | `fleet.mobilemonero.com` | Fleet heartbeat dashboard | ✅ Active |
| 1d-price-ticker | `price.mobilemonero.com` | XMR/USD price (3-source fallback) | ✅ Active |
| mtv-lyrics | `mtv.mobilemonero.com` | AI lyrics pipeline for MTV tracks | ✅ Active |
| hermes | `hermes.mobilemonero.com` | Fleet chat relay (hybrid persistence) | ✅ Active |
| inbox | `inbox.mobilemonero.com` | Resend webhook receiver + query API | ✅ Active |

### Go Relay (redundant)
- Same REST endpoints as Vex relay
- WebSocket (`/ws`) for agent connections
- Webhook (`/webhook/task`) for Supabase task callback

### Rust Mesh (P2P — native)
- mDNS + Gossipsub for peer discovery
- Request-response for task dispatch
- Noise encryption + Yamux multiplexing

## Core Repos

| Repo | Description |
|------|-------------|
| `mobilemonero` | Fleet coordination hub (this repo) |
| `relay-go` | Go Relay Agent Daemon — WebSocket + REST dispatch |
| `xmrt-mesh` | Rust P2P Mesh Node — libp2p agent meshnet |
| `agent-status` | Supabase edge function for agent status updates |
| `suite` | Suite AI monorepo — frontend, backend, mining proxy |
| `cashdapp` | Mobile gateway to Monero and XMRT DAO |
| `zero-claw` | Zero-Knowledge multi-agent DAO governance |

## Mesh Networking

Two P2P mesh layers connect the fleet:

### Layer 1: Gossipsub (libp2p) — Primary
- **Protocol:** `@chainsafe/libp2p-gossipsub` v14.1.1
- **Port:** 9000 (TCP)
- **Transport:** Noise encryption + Yamux multiplexing
- **Topics:** `agent-heartbeat`, `agent-tasks`, `agent-discovery`, `fleet-broadcast`
- **Node:** `relay/lib/mesh-router.mjs` — see [Node Architecture](docs/NODE_ARCHITECTURE.md)
- **Status:** ✅ Vex relay running. Hermes connecting via HTTP proxy.

### Layer 2: HTTP P2P (Mesh v2.1) — Fallback
- **Protocol:** Python HTTP server with SHA256 dedup + hop propagation
- **Ports:** Hermes=4001, Vex=4002, Eliza=4003
- **Code:** `mesh/mesh-node.py` (in this repo)
- **Bridge:** `mesh-fleet-bridge.py` relays mesh ↔ cloud
- **Status:** ✅ Vex + Hermes nodes running locally. Cross-internet P2P pending tunnel setup.

### For Cloud Agents (Eliza, fleet)
Cloud agents without persistent processes interact with the mesh through the Vex relay:
```
POST https://relay.mobilemonero.com/mesh/publish
  {"topic":"fleet-broadcast","payload":{"agent":"eliza","message":"..."}}

GET https://relay.mobilemonero.com/mesh/messages
GET https://relay.mobilemonero.com/mesh/status
```

## PFP Toolkit

Hermes drives PartyFavorPhoto operations — automated quoting, contract delivery, venue lead scraping.

- **Scraper**: Hourly Exa.ai venue contact runs via cron (`~/.hermes/scripts/pfp_exa_scraper.py`)
- **Contacts**: Uploaded to `partyfavorphoto/data/contacts/<city>-<date>.json`
- **Inbox**: Resend webhooks → `inbox.mobilemonero.com` (hermes can query via `/inbox/pfp`)

```bash
# SDK for fleet chat
source ~/mobilemonero/fleet/sdk/hermes-client.sh
hermes_broadcast "Hello fleet"
hermes_to_hermes "vex" "Direct message"
hermes_poll
```

## MTV Pipeline

Tracks: **MeshFire**, **CryptoNight**, **ZeroClaw**
- Lyrics: generated via `mtv-lyrics` CF Worker
- Music: MiniMax music-2.6 API (BLOCKED — pending top-up)
- Pipeline script: `mtt/mtv_pipeline.py --lyrics`

## Documentation

| File | Description |
|------|-------------|
| [`docs/NODE_ARCHITECTURE.md`](docs/NODE_ARCHITECTURE.md) | Complete node architecture — every process, port, deploy target |
| [`relay/lib/mesh-router.mjs`](relay/lib/mesh-router.mjs) | Gossipsub mesh node (Phase 1 of Issue #13) |
| [`relay/node-health.sh`](relay/node-health.sh) | 13-check health probe for any XMRT DAO node |

## Quick Start

```bash
# Clone fleet repos
git clone https://github.com/xmrtdao/mobilemonero.git
git clone https://github.com/xmrtdao/relay-go.git
git clone https://github.com/xmrtdao/xmrt-mesh.git

# Build Go relay
cd relay-go && go build -o relayd.exe ./cmd/relayd/

# Build Rust mesh
cd xmrt-mesh && cargo build --release
```

## Issues

The [issue tracker](https://github.com/xmrtdao/mobilemonero/issues) is our primary coordination surface. Key labels:

- `P0` — Critical path, blocking
- `P1` — High priority
- `fleet` — Fleet-wide coordination
- `gossipsub` — Mesh networking
- `edge-function` — Supabase edge functions
- `communication` — Agent-to-agent channels
- `infrastructure` — Relay, tunnel, deployment
