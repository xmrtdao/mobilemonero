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
| **Vex** (TS Relay) | Windows laptop | Primary relay, orchestration | ✅ Active |
| **Eliza-Cloud** | Supabase Edge | Cloud coordination | ⚠️ Token-limited |
| **Hermes** | Android / Termux | Mobile agent, CF Worker | ✅ Active — `hermes.mobilemonero.com` |
| **Go Relay** | Windows/Linux | Redundant relay daemon | 🔧 Built, deploy-ready |
| **Rust Mesh** | Cross-platform | P2P mesh networking | 🔧 CI added |

## Architecture

```
                    ┌──────────────────────────────┐
                    │          Hermes              │
                    │   CF Worker (persistent)     │
                    │ hermes.mobilemonero.com       │
                    │ writes → relay.mobilemonero   │
                    └────────────┬───────────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              │                                     │
     ┌────────┴──────┐                     ┌──────┴────────┐
     │  Vex (TS)     │       Eliza-Cloud   │  Inbox Worker │
     │  port 8080    │                     │ inbox.mobile  │
     │  16 tools     │                     │ Resend webhooks │
     └───────────────┘                     └───────────────┘
              │
              └───────────────────┐
                                  │
     ┌──────────────────────────┼──────────┐
     │  CF Workers (Edge)       │          │
     │  api  ai  fleet  price   │   mtv    │
     │  hermes  inbox           │          │
     └──────────────────────────┴──────────┘
```

## Communication

**Hermes Fleet Worker (primary):**
- `https://hermes.mobilemonero.com/fleet/broadcast` — broadcast fleet message
- `https://hermes.mobilemonero.com/fleet/messages` — poll fleet chat
- `https://hermes.mobilemonero.com/from/hermes` — DMs to Hermes
- `https://hermes.mobilemonero.com/health` — service status

**Workers (all at *.mobilemonero.com):**
| Worker | Endpoint | Status |
|--------|----------|--------|
| api-gateway | `/health` | ✅ Active |
| 1d-price-ticker | `/price/xmr` | ✅ Live price feed |
| fleet-status | `/health` | ✅ Active |
| mtv-lyrics | `/health` | ✅ Active |
| inbox | `/health` | ✅ Active |

**Relay (when up):**
- `POST relay.mobilemonero.com/api/fleet-chat/send-email` — persistent message log
- `GET relay.mobilemonero.com/api/fleet-chat` — retrieve history

**Go Relay (redundant):**
- Same endpoints as Vex relay
- WebSocket (`/ws`) for agent connections
- Webhook (`/webhook/task`) for Supabase task callback

**Rust Mesh (P2P):**
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

## Deployed Workers

All workers run on Cloudflare edge compute (`mobilemonero.com` zone).

```bash
# Deploy any worker via REST API (Termux-compatible)
cd workers/<name> && python3 deploy.py
```

| Worker | Route | Purpose | Deployed |
|--------|-------|---------|----------|
| `api-gateway` | `api.mobilemonero.com` | API proxy, DNS-override for Termux | ✅ |
| `ai-gateway` | `ai.mobilemonero.com` | AI completions (kimi-k2.6:cloud) | ✅ |
| `fleet-status` | `fleet.mobilemonero.com` | Fleet heartbeat dashboard | ✅ |
| `1d-price-ticker` | `price.mobilemonero.com` | XMR/USD price (3-source fallback) | ✅ |
| `mtv-lyrics` | `mtv.mobilemonero.com` | AI lyrics pipeline for MTV tracks | ✅ |
| `hermes` | `hermes.mobilemonero.com` | Fleet chat relay (hybrid persistence) | ✅ |
| `inbox` | `inbox.mobilemonero.com` | Resend webhook receiver + query API | ✅ |

## PFP Toolkit

Hermes also drives PartyFavorPhoto operations — automated quoting, contract delivery, venue lead scraping.

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
