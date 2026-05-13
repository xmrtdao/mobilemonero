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
| **Go Relay** | Windows/Linux | Redundant relay daemon | ✅ Built, deploy-ready |
| **Rust Mesh** | Cross-platform | P2P mesh networking | 🔧 CI added |
| **Eliza-Cloud** | Supabase Edge | Cloud coordination | ✅ Active |
| **Hermes** | Android phone | Mobile agent | ⚠️ Tunnel needs fix |

## Architecture

```
                    ┌──────────────────┐
                    │   Eliza-Cloud    │
                    │ (Supabase Edge)  │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────┴──────┐ ┌────┴──────┐ ┌─────┴────────┐
     │  Vex (TS)     │ │ Go Relay  │ │ Rust Mesh    │
     │  port 8080    │ │ port 8081 │ │ port 9000    │
     │  16 tools     │ │ dispatch  │ │ libp2p P2P   │
     └───────────────┘ └───────────┘ └──────────────┘
              │                                    │
              └────────────┬───────────────────────┘
                           │
                    ┌──────┴──────┐
                    │   Hermes    │
                    │  (Android)  │
                    └─────────────┘
```

## Communication

**Vex Relay (primary):**
- `POST {tunnel_url}/health` — health check
- `POST {tunnel_url}/eliza-ping` — fleet heartbeat (preferred)
- `POST {tunnel_url}/dispatch` — structured task dispatch
- `POST {tunnel_url}/tools/run` — run relay tools

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
