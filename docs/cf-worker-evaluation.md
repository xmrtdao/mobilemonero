# XMRT DAO — Cloudflare Worker Use-Case Evaluation

## Current State

| Worker | Status | Domain | Purpose |
|--------|--------|--------|---------|
| **mtv-lyrics** | LIVE | mtv-lyrics.mobilemonero.com | AI lyric generation via CF Workers AI (LLaMA-3-8B) |

**Capabilities proven:**
- Worker deployed via REST API from Termux (wrangler incompatible on Android)
- Custom CNAME + proxied routing working
- CF Workers AI inference (text) working  ~1-3s latency
- Header-based auth (reads `Authorization: Bearer <cf_token>`)
- Direct MiniMax music payload builder endpoint

---

## 1. Quick-Wins (Low Effort, High Value)

### 1a. API Gateway / Reverse Proxy
**What:** Route `api.mobilemonero.com` through a Worker to unify all backend endpoints (relay, Supabase, HF, MiniMax, GitHub, etc.)

**Why:**
- Your phone can't resolve DNS properly (Termux libc issue), but Workers can
- All external services become reachable from the phone via one endpoint
- You can add rate-limiting / API key auth at the edge

**Routes:**
- `POST /api/eliza/relay` -> relay.mobilemonero.com:9090
- `POST /api/github/*` -> api.github.com (authenticated via Worker secret)
- `POST /api/supabase/*` -> vawouugtzwmejxqkeqqj.supabase.co
- `POST /api/hf/inference` -> HuggingFace Inference API

**Complexity:** Low (just `fetch()` relay)
**Value:** Very high — fixes your Termux DNS issue permanently

---

### 1b. Crypto Price / Monero Ticker Worker
**What:** Worker caches Monero price + on-chain stats from CoinGecko / mempool.space for fast mobile display

**Why:**
- Your dashboard (`dashboard.html`) needs real-time data
- Edge caching reduces mobile bandwidth
- Worker KV can store 1-hour TTL cache

**Endpoints:**
- `GET /price/xmr` -> cached XMR/USD price
- `GET /price/change` -> 24h % change
- `GET /mempool/fees` -> fee estimates

**Complexity:** Low
**Value:** Medium (drives dashboard adoption)

---

### 1c. Fleet Relay Health Proxy
**What:** Worker that health-checks your fleet (relay.mobilemonero.com, Supabase, the new `hermes_relay_listener.py`) and returns a JSON status board

**Why:**
- You can run this from your phone without needing local fleet dashboard server
- Your `status.mobilemonero.com` site can be a static page + JS fetch to this Worker

**Endpoints:**
- `GET /fleet/status` -> `{relay: "UP", supabase: "UP", hermes: "UP|DOWN"}`
- `GET /fleet/nodes` -> list of active agents

**Complexity:** Low-Medium
**Value:** High (replaces dependency on local `dashboard.html` running on port 9090)

---

## 2. Strategic Workers (Medium-High Effort)

### 2a. AI Gateway / Orchestrator
**What:** Single Worker that routes generative AI requests to the best available backend:

**Routing logic:**
- Text generation (lyrics, code, chat) -> CF Workers AI (free tier, fast)
- Music generation -> MiniMax (after top-up) via passthrough or direct
- Image generation -> `stabilityai/stable-diffusion-xl-base-1.0` via HF Inference API
- Fallback to Ollama (if local) or other cloud providers

**Endpoints:**
- `POST /ai/generate` `{type: "text|music|image|video", ...}`
- `POST /ai/status` check which backends are up

**Why:** This lets all XMRT DAO tools (CashDApp, MobileMonero, Hermes relay) share one AI backend without hardcoding multiple API keys in the client

**Complexity:** Medium (request routing + error handling + retries)
**Value:** Very high (architectural backbone)

---

### 2b. MTT (Music Track Token) Metadata Worker
**What:** Worker that stores and serves immutable per-track metadata on CF KV + R2

**What it stores per track:**
- JSON with title, theme, lyrics_hash, music_hash, created_at, tx_id (when minted)
- Maps IPFS / R2 audio URL to track_id

**Endpoints:**
- `POST /track/register` -> store metadata
- `GET  /track/:id` -> retrieve metadata
- `GET  /track/:id/audio` -> redirect to R2 / IPFS URL
- `GET  /track/:id/lyrics` -> plaintext or JSON lyrics

**Why:** When you mint Music NFTs or MTT tokens, this stores the off-chain metadata. You can later point on-chain NFT metadata URIs to this Worker.

**Complexity:** Medium (KV schema + upload flow)
**Value:** High (enables tokenized music tracks)

---

### 2c. Offline-First Sync Worker
**What:** Worker that acts as a message queue for devices when meshnet is offline

**How:**
- Devices (via mobile web app) POST encrypted messages to Worker
- Worker stores them in KV with TTL (e.g., 24h)
- Recipient devices poll Worker and retrieve messages when mesh connection drops
- When mesh resumes, mesh routing takes over

**Endpoints:**
- `POST /mesh/buffer` -> store message
- `POST /mesh/poll` -> retrieve messages for recipient_id
- `DELETE /mesh/buffer/:msg_id` -> acknowledge receipt

**Why:** This supports your long-term offline-first vision. The Worker is a cloud-backed buffer for mesh peers that occasionally lose direct connectivity.

**Complexity:** Medium-High (encryption, TTL eviction, deduplication)
**Value:** Very high (core to CashDApp offline architecture)

---

## 3. Advanced Workers (High Effort, Long-Term)

### 3a. Zero-Knowledge Proof (ZKP) Verification Worker
**What:** Worker that verifies zero-knowledge proofs submitted by MobileMonero clients

**Use cases:**
- Verify Monero transaction proof-of-payment without revealing amounts or addresses
- Verify eligibility for access control (e.g., "has min 1 XMR in wallet")

**Endpoints:**
- `POST /verify/tx` -> verify proof
- `POST /verify/balance` -> verify balance proof

**Why:** Enables privacy-preserving payments in CashDApp. Customers prove they paid without revealing who they are.

**Complexity:** High (needs WASM or Rust ZKP verification compiled to WebAssembly, running in Worker)
**Value:** Very high (core differentiator)

---

### 3b. WebAssembly (WASM) Edge Compute Worker
**What:** Worker that loads and executes WASM modules for Monero client-side operations

**WASM modules you could run:**
- Monero wallet creation / address derivation (monero-ts compiled to WASM)
- Bulletproof verification
- Seed phrase generation
- QR encode/decode

**Endpoints:**
- `POST /wasm/monero/derive-address` `{spendkey, viewkey}` -> address
- `POST /wasm/monero/verify-tx` `{tx_hex, key_images}` -> valid/invalid

**Why:** Moves sensitive crypto operations to the edge while keeping them server-side (vs. pure client JS which could be tampered). Faster than running WASM on the phone.

**Complexity:** High (needs toolchain: Rust -> wasm-pack -> Cloudflare)
**Value:** High (performance + security for mobile wallet)

---

### 3c. WebRTC SFU / Coordination Worker
**What:** Worker that coordinates mesh-to-web peer discovery (NOT actual media routing, but signaling)

**Why:** Meshtastic/Bluetooth is local. If two phones aren't in physical range, you need a signaling server to bootstrap a direct WebRTC connection. Worker is perfect for this — it just exchanges SDP offers/answers via KV.

**Endpoints:**
- `POST /webrtc/signal` -> register SDP offer
- `GET /webrtc/signal/:room_id` -> retrieve SDP answer

**Complexity:** Medium-High (WebRTC signaling protocol)
**Value:** Medium-High (extends mesh to be "online-assisted mesh")

---

## 4. Priority Ranking

| # | Worker | Effort | Value | Do First? |
|---|--------|--------|-------|-----------|
| 1 | **API Gateway / Reverse Proxy** | Low | Very High | YES (fixes DNS issue) |
| 2 | **AI Gateway (text + music)** | Medium | Very High | YES (next sprint) |
| 3 | **Fleet Health Proxy** | Low | High | YES (dashboard reliability) |
| 4 | **Monero Price Ticker + Cache** | Low | Medium | Soon (dashboard data) |
| 5 | **MTT Metadata + R2 Storage** | Medium | High | After music gen works |
| 6 | **Offline Sync Buffer** | Medium-High | Very High | After mesh MVP |
| 7 | **ZKP Verification** | High | Very High | Long-term (Monero privacy) |
| 8 | **WASM Edge Compute** | High | High | Long-term (performance) |
| 9 | **WebRTC Signaling** | Medium-High | Medium-High | After P2P prototype |

---

## 5. Implementation Notes

### Naming Convention
Use subdomains under `mobilemonero.com` for consistency:
- `api.mobilemonero.com` → API Gateway
- `ai.mobilemonero.com` → AI Gateway
- `status.mobilemonero.com` → Fleet Health
- `data.mobilemonero.com` → Price ticker + metadata
- `mesh.mobilemonero.com` → Offline sync + WebRTC signaling

### Deploy Pattern
All workers follow the same deploy flow (no wrangler needed):
1. Write `src/index.js` (Service Worker syntax)
2. `deploy_cf_worker.sh` with the env vars
3. Add subdomain CNAME + route via Cloudflare Dashboard
4. GitHub Actions auto-deploy on push to `workers/**`

### KV / R2 Needs
Some workers above need KV (key-value) or R2 (object storage):
- KV: caching, message queues, session state (very cheap)
- R2: audio files, video clips, WASM modules

Both are configured in the Cloudflare Dashboard and bound in the Worker via wrangler.toml or the Upload Script API.

---

## 6. Suggested Next Action

Build the **API Gateway Worker** (`api.mobilemonero.com`) first. It:
- Solves your immediate Termux DNS problem
- Creates the pattern for all future workers
- Gives `relay.mobilemonero.com`, Supabase, and HF Inference a stable edge entry point
- Takes ~1 hour to implement (it's just `fetch()` relaying with some path mapping)

Would you like me to scaffold it?
