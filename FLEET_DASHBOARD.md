# XMRT DAO Fleet Dashboard

**Live Status:** All workers operational on mobilemonero.com

---

## Quick Links

| Service | URL | Status |
|---------|-----|--------|
| **API Gateway** | https://api.mobilemonero.com/health | ✅ |
| **AI Gateway** | https://ai.mobilemonero.com/health | ✅ |
| **Fleet Status** | https://fleet.mobilemonero.com/health | ✅ |
| **Price Ticker** | https://price.mobilemonero.com/price/xmr | ✅ |
| **MTV Lyrics** | https://mtv.mobilemonero.com/health | ✅ |

---

## Fleet Agents

| Agent | Role | Contact |
|-------|------|---------|
| **Vex** | Primary relay | relay.mobilemonero.com:9090 |
| **Eliza-Cloud** | Cloud Eliza | Via fleet relay |
| **Hermes** | MobileMonero CLI | This dashboard |

---

## How to Contact Hermes

### Option 1: Fleet Relay (Recommended)
```bash
curl -X POST http://relay.mobilemonero.com:9090/fleet/broadcast \
  -H "Content-Type: application/json" \
  -d '{"agent": "vex", "message": "Hello from Vex", "type": "status"}'
```

### Option 2: API Gateway
```bash
# Proxy through API gateway
curl https://api.mobilemonero.com/relay/fleet/broadcast \
  -H "Content-Type: application/json" \
  -d '{"agent": "vex", "message": "Hello", "type": "status"}'
```

### Option 3: GitHub Issues
Create an issue at: https://github.com/xmrtdao/mobilemonero/issues

---

## API Gateway Routes

The API Gateway (`api.mobilemonero.com`) proxies to backend services:

| Route | Backend | Example |
|-------|---------|---------|
| `/relay/*` | relay.mobilemonero.com:9090 | `GET /relay/health` |
| `/supabase/*` | Supabase project | `GET /supabase/rest/v1/...` |
| `/hf/*` | Hugging Face API | `GET /hf/api/inference/...` |
| `/github/*` | GitHub API | `GET /github/repos/xmrtdao/mobilemonero` |
| `/minimax/*` | MiniMax API | `POST /minimax/v1/chat` |
| `/ai/*` | Cloudflare Workers AI | `POST /ai/run/@cf/...` |

### Example: GitHub API
```bash
curl https://api.mobilemonero.com/github/repos/xmrtdao/mobilemonero
```

### Example: Cloudflare AI
```bash
curl -X POST https://api.mobilemonero.com/ai/run/@cf/meta/llama-3-8b-instruct \
  -H "Authorization: Bearer YOUR_CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

---

## AI Gateway

Generate text, music, images, and video through a unified interface.

**Endpoint:** `https://ai.mobilemonero.com/ai/generate`

### Text Generation
```bash
curl -X POST https://ai.mobilemonero.com/ai/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_CF_TOKEN" \
  -d '{
    "type": "text",
    "prompt": "Write a haiku about Monero",
    "model": "@cf/meta/llama-3-8b-instruct"
  }'
```

### Image Generation
```bash
curl -X POST https://ai.mobilemonero.com/ai/generate \
  -H "Content-Type: application/json" \
  -H "X-HF-Token: YOUR_HF_TOKEN" \
  -d '{
    "type": "image",
    "prompt": "A cyberpunk city at night",
    "model": "stabilityai/stable-diffusion-2-1"
  }'
```

### Music Generation
```bash
curl -X POST https://ai.mobilemonero.com/ai/generate \
  -H "Content-Type: application/json" \
  -H "X-MiniMax-Token: YOUR_MINIMAX_TOKEN" \
  -d '{
    "type": "music",
    "prompt": "Electronic dance music with synth waves",
    "duration": 30
  }'
```

### Video Generation
```bash
curl -X POST https://ai.mobilemonero.com/ai/generate \
  -H "Content-Type: application/json" \
  -H "X-MiniMax-Token: YOUR_MINIMAX_TOKEN" \
  -d '{
    "type": "video",
    "prompt": "A robot walking through a forest",
    "model": "video-01"
  }'
```

---

## Price Ticker

Real-time Monero price data from CoinGecko.

### Current Price (USD)
```bash
curl https://price.mobilemonero.com/price/xmr
```

**Response:**
```json
{
  "price_usd": 162.45,
  "updated": 1779130883481
}
```

### 24h Change
```bash
curl https://price.mobilemonero.com/price/change
```

**Response:**
```json
{
  "change_24h": 3.42,
  "updated": 1779130883481
}
```

---

## MTV Lyrics

AI-generated song lyrics via Cloudflare Workers AI.

### Health Check
```bash
curl https://mtv.mobilemonero.com/health
```

### Generate Lyrics (via AI Gateway)
```bash
curl -X POST https://ai.mobilemonero.com/ai/generate \
  -H "Authorization: Bearer YOUR_CF_TOKEN" \
  -d '{
    "type": "text",
    "prompt": "Write lyrics for a synthwave song about cryptocurrency privacy",
    "model": "@cf/meta/llama-3-8b-instruct"
  }'
```

---

## Worker Status (workers.dev)

These workers are deployed but need KV bindings for full functionality:

| Worker | workers.dev URL | Status |
|--------|-----------------|--------|
| 2a-mtt-registry | https://2a-mtt-registry.xmrtdao-xmrt-dao-nb.workers.dev | ⚠️ Stub |
| 2b-offline-sync | https://2b-offline-sync.xmrtdao-xmrt-dao-nb.workers.dev | ⚠️ Stub |
| webrtc-signaling | https://webrtc-signaling.xmrtdao-xmrt-dao-nb.workers.dev | ⚠️ Stub |
| wasm-edge-compute | https://wasm-edge-compute.xmrtdao-xmrt-dao-nb.workers.dev | ⚠️ Stub |
| zkp-verification | https://zkp-verification.xmrtdao-xmrt-dao-nb.workers.dev | ⚠️ Stub |

### Enable KV Bindings

1. Go to Cloudflare Dashboard → Workers → `<worker-name>`
2. Settings → KV Namespace Bindings → Add binding
3. Create/select namespace and bind to variable name

| Worker | KV Variable | Namespace |
|--------|-------------|-----------|
| 2a-mtt-registry | `KV` or `R2` | `mtt_registry_kv` |
| 2b-offline-sync | `KV` | `offline_sync_kv` |
| webrtc-signaling | `WEBRTC_KV` | `webrtc_kv` |

---

## Fleet Relay

Local relay server running on port 9090.

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard HTML |
| `/health` | GET | Health check (JSON) |
| `/fleet/status` | GET | Fleet agent status |
| `/fleet/messages` | GET | Message log |
| `/fleet/broadcast` | POST | Send message to fleet |

### Broadcast Message
```bash
curl -X POST http://localhost:9090/fleet/broadcast \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "hermes",
    "message": "System check complete",
    "type": "status"
  }'
```

### Get Messages
```bash
curl http://localhost:9090/fleet/messages?limit=10
```

---

## Environment Setup

Hermes uses these environment variables (stored in `~/.bash_profile`):

```bash
# Cloudflare
export CF_ACCOUNT_ID="ef8e3637c4a00a43860b679ecd138a05"
export CF_API_TOKEN="cfut_..."

# Zone
export MOBILEMONERO_ZONE_ID="8710927c035b113b585b1d09403f7034"
```

---

## Files Reference

| File | Path | Purpose |
|------|------|---------|
| Relay Server | `~/mobilemonero/fleet/hermes_relay_listener.py` | Fleet relay (port 9090) |
| Tunnel Setup | `~/mobilemonero/fleet/create-tunnel.sh` | Cloudflare tunnel auth |
| Tunnel Start | `~/mobilemonero/fleet/start-tunnel.sh` | Start permanent tunnel |
| Quick Tunnel | `~/mobilemonero/fleet/start-quick-tunnel.sh` | Start temp tunnel |
| Deploy All | `~/mobilemonero/workers/deploy-all.sh` | Deploy all workers |
| Health Check | `~/mobilemonero/workers/check-workers.sh` | Check worker health |
| Hermes Config | `~/.hermes/config.yaml` | Agent configuration |
| Hermes Persona | `~/.hermes/SOUL.md` | Agent personality |

---

## Contact

- **Owner:** Joseph Andrew Lee (DevGruGold)
- **Email:** xmrtsolutions@gmail.com
- **Repo:** https://github.com/xmrtdao/mobilemonero
- **Dashboard:** https://fleet.mobilemonero.com/

---

**Last Updated:** 2026-05-18
**Version:** 1.0
