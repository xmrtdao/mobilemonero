# XMRT DAO Worker Fleet

9 Cloudflare Workers for XMRT DAO / MobileMonero ecosystem.

## Workers

| Worker | Status | Purpose | KV/R2 |
|--------|--------|---------|-------|
| `fleet-status` | Ready | Health proxy for fleet agents | No |
| `api-gateway` | Ready | Reverse proxy to backends (relay, Supabase, HF, GitHub, MiniMax, CF AI) | No |
| `ai-gateway` | Ready | Unified AI generation (text/music/image/video) | No |
| `1d-price-ticker` | Ready | Monero price + 24h change (CoinGecko cache) | Yes (KV) |
| `2a-mtt-registry` | Ready | Music Track Token metadata registry | Yes (KV/R2) |
| `2b-offline-sync` | Ready | Mesh message buffer for offline-first sync | Yes (KV) |
| `wasm-edge-compute` | Stub | Monero WASM operations (derive-address, verify-tx) | No |
| `webrtc-signaling` | Ready | WebRTC SDP offer storage | Yes (KV) |
| `zkp-verification` | Stub | ZKP proof verification (tx, balance) | No |

**Already deployed:**
- `mtv-lyrics` — LIVE at mtv-lyrics.mobilemonero.com (lyrics generation via CF AI)

---

## Quick Start

### 1. Set Environment Variables
```bash
export CF_ACCOUNT_ID="your-account-id"
export CF_API_TOKEN="your-api-token"
```

### 2. Deploy All Workers
```bash
cd ~/mobilemonero/workers
bash deploy-all.sh
```

### 3. Check Health
```bash
bash check-workers.sh --verbose
```

---

## Deploy Individual Worker
```bash
cd ~/mobilemonero/workers/fleet-status
bash deploy.sh
```

---

## KV Namespace Bindings

Workers requiring KV need manual binding in Dashboard:

1. Go to Workers → `<worker-name>` → Settings
2. Scroll to "KV Namespace Bindings"
3. Add binding:
   - Variable name: `KV` (or `R2` for R2 buckets)
   - Namespace: select the created namespace

| Worker | Binding | Namespace |
|--------|---------|-----------|
| `1d-price-ticker` | KV | `price_ticker_kv` |
| `2a-mtt-registry` | KV or R2 | `mtt_registry_kv` |
| `2b-offline-sync` | KV | `offline_sync_kv` |
| `webrtc-signaling` | KV | `webrtc_kv` (create manually) |

---

## Custom Domains

To add custom domains (e.g., `api.mobilemonero.com`):

**Option A: Cloudflare Dashboard**
1. Workers → `<worker>` → Triggers
2. Add Custom Route: `api.mobilemonero.com/*`

**Option B: Cloudflare CLI** (if you have zone token)
```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/routes" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pattern":"api.mobilemonero.com/*","script":"api-gateway"}'
```

---

## Architecture

```
                    ┌─────────────────┐
                    │   Client Apps   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  api-gateway    │ ← Routes to all backends
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
  ┌──────▼──────┐   ┌───────▼───────┐   ┌──────▼──────┐
  │fleet-status │   │  ai-gateway   │   │1d-price-    │
  │  (health)   │   │  (AI router)  │   │  ticker     │
  └─────────────┘   └───────┬───────┘   └─────────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
       ┌──────▼──────┐ ┌───▼────┐ ┌─────▼─────┐
       │   mtv-      │ │ image  │ │  video    │
       │   lyrics    │ │ (HF)   │ │ (MiniMax) │
       └─────────────┘ └────────┘ └───────────┘
```

---

## API Endpoints

### fleet-status
- `GET /health` — Worker health check
- `GET /` — Available routes

### api-gateway
- `GET /health`
- `GET|POST /relay/*` → relay.mobilemonero.com:9090
- `GET|POST /supabase/*` → Supabase project
- `GET|POST /hf/*` → Hugging Face API
- `GET|POST /github/*` → GitHub API
- `GET|POST /minimax/*` → MiniMax API
- `GET|POST /ai/*` → Cloudflare Workers AI

### ai-gateway
- `GET /health`
- `POST /ai/generate` — `{type: "text|music|image|video", prompt, ...}`

### 1d-price-ticker
- `GET /price/xmr` — `{price_usd, updated}`
- `GET /price/change` — `{change_24h, updated}`

### 2a-mtt-registry
- `POST /track/register` — Register track metadata
- `GET /track/:id` — Retrieve track metadata

### 2b-offline-sync
- `POST /mesh/buffer` — Store message
- `POST /mesh/poll` — Poll messages for recipient
- `DELETE /mesh/buffer/:id` — Acknowledge receipt

### wasm-edge-compute
- `POST /wasm/monero/derive-address` — Stub (WASM pending)
- `POST /wasm/monero/verify-tx` — Stub (WASM pending)

### webrtc-signaling
- `POST /webrtc/signal/:room_id` — Store SDP offer
- `GET /webrtc/signal/:room_id` — Retrieve SDP offer

### zkp-verification
- `POST /verify/tx` — Stub (WASM pending)
- `POST /verify/balance` — Stub (WASM pending)

---

## Files

| File | Purpose |
|------|---------|
| `deploy-all.sh` | Deploy all workers in sequence |
| `check-workers.sh` | Health check all workers |
| `*/deploy.sh` | Individual worker deploy script |
| `*/src/index.js` | Worker code (Service Worker syntax) |
| `*/wrangler.toml` | Worker config (for reference, not used in Termux) |

---

## Troubleshooting

**Worker returns 500:**
- Check KV bindings in Dashboard
- Verify CF_API_TOKEN has Workers:Edit scope

**KV binding errors:**
- Ensure namespace created (deploy.sh attempts this)
- Bind in Dashboard: Workers → Settings → KV Namespace Bindings

**Custom domain not routing:**
- Check DNS CNAME record points to Cloudflare
- Verify route pattern in Workers → Triggers

---

Created: 2026-05-18
Part of XMRT DAO / MobileMonero
