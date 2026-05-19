---
title: "Fleet Contact: Hermes Agent Endpoints + Dashboard"
labels: ["fleet", "documentation", "workers"]
assignees: []
---

## Hermes Agent Fleet Contact Info

This issue documents how to contact the Hermes agent and access all deployed worker endpoints.

---

## Fleet Agents

| Agent | Role | Status |
|-------|------|--------|
| **Vex** | Primary relay | Active |
| **Eliza-Cloud** | Cloud Eliza instance | Active |
| **Hermes** | MobileMonero CLI agent | Active (this issue) |

---

## Hermes Contact Methods

### 1. Fleet Relay (Port 9090)
```bash
POST http://relay.mobilemonero.com:9090/fleet/broadcast
Content-Type: application/json

{"agent": "vex", "message": "Hello fleet", "type": "status"}
```

### 2. Worker Endpoints (mobilemonero.com)

| Endpoint | Purpose | Example |
|----------|---------|----------|
| `https://api.mobilemonero.com/health` | API Gateway health | `curl https://api.mobilemonero.com/health` |
| `https://ai.mobilemonero.com/health` | AI Gateway health | `curl https://ai.mobilemonero.com/health` |
| `https://fleet.mobilemonero.com/health` | Fleet status | `curl https://fleet.mobilemonero.com/health` |
| `https://price.mobilemonero.com/price/xmr` | Monero price | `curl https://price.mobilemonero.com/price/xmr` |
| `https://mtv.mobilemonero.com/health` | MTV lyrics | `curl https://mtv.mobilemonero.com/health` |

### 3. API Gateway Routes

The API Gateway proxies requests to backend services:

| Route | Backend |
|-------|----------|
| `/relay/*` | relay.mobilemonero.com:9090 |
| `/supabase/*` | Supabase project |
| `/hf/*` | Hugging Face API |
| `/github/*` | GitHub API |
| `/minimax/*` | MiniMax API |
| `/ai/*` | Cloudflare Workers AI |

Example:
```bash
curl https://api.mobilemonero.com/github/repos/xmrtdao/mobilemonero
```

### 4. AI Gateway

Generate text, music, images, video:

```bash
curl -X POST https://ai.mobilemonero.com/ai/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_CF_TOKEN" \
  -d '{"type": "text", "prompt": "Your prompt here"}'
```

Supported types: `text`, `music`, `image`, `video`

---

## Hermes Dashboard

A live dashboard is available showing all endpoints and real-time status.

**Dashboard Files:**
- Markdown: `~/mobilemonero/FLEET_DASHBOARD.md`
- HTML: `~/mobilemonero/fleet/dashboard.html`

### Dashboard Features
- Worker health status
- Fleet agent status
- Message broadcast interface
- API documentation

---

## Worker Deployment Status

| Worker | Domain | Status | Notes |
|--------|--------|--------|-------|
| fleet-status | fleet.mobilemonero.com | ✅ LIVE | Health checks |
| api-gateway | api.mobilemonero.com | ✅ LIVE | Backend proxy |
| ai-gateway | ai.mobilemonero.com | ✅ LIVE | AI generation |
| 1d-price-ticker | price.mobilemonero.com | ✅ LIVE | CoinGecko prices |
| mtv-lyrics | mtv.mobilemonero.com | ✅ LIVE | Lyrics generation |
| 2a-mtt-registry | (workers.dev) | ⚠️ STUB | Needs KV binding |
| 2b-offline-sync | (workers.dev) | ⚠️ STUB | Needs KV binding |
| webrtc-signaling | (workers.dev) | ⚠️ STUB | Needs KV binding |
| wasm-edge-compute | (workers.dev) | ⚠️ STUB | Needs WASM module |
| zkp-verification | (workers.dev) | ⚠️ STUB | Needs WASM module |

---

## Environment Variables

Hermes uses these CF credentials (stored in `~/.bash_profile`):

```bash
export CF_ACCOUNT_ID="ef8e3637c4a00a43860b679ecd138a05"
export CF_API_TOKEN="cfut_..."
```

Zone ID: `8710927c035b113b585b1d09403f7034` (mobilemonero.com)

---

## Files Created

| File | Path | Purpose |
|------|------|----------|
| `hermes_relay_listener.py` | `~/mobilemonero/fleet/` | Fleet relay server (port 9090) |
| `create-tunnel.sh` | `~/mobilemonero/fleet/` | Cloudflare tunnel setup |
| `start-tunnel.sh` | `~/mobilemonero/fleet/` | Start permanent tunnel |
| `deploy-all.sh` | `~/mobilemonero/workers/` | Deploy all workers |
| `check-workers.sh` | `~/mobilemonero/workers/` | Health check all workers |
| `FLEET_DASHBOARD.md` | `~/mobilemonero/` | Full documentation |
| `dashboard.html` | `~/mobilemonero/fleet/` | Web dashboard |
| `config.yaml` | `~/.hermes/` | Hermes agent config |
| `SOUL.md` | `~/.hermes/` | Hermes persona config |

---

## Contact

- **Owner:** Joseph Andrew Lee (DevGruGold)
- **Repo:** github.com/xmrtdao/mobilemonero
- **Relay:** relay.mobilemonero.com:9090
- **Dashboard:** https://fleet.mobilemonero.com/

---

**Created:** 2026-05-18  
**Last Updated:** 2026-05-18
