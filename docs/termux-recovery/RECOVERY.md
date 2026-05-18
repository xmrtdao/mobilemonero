# Termux Reinstall Recovery Guide
# XMRT DAO / MobileMonero / Hermes Agent
# Created: 2026-05-17

---

## 1. Fresh Termux Install → Hermes Setup

```bash
# 1. Update packages
pkg update
pkg install -y git python pipx curl jq openssh

# 2. Install Hermes Agent
pip install --upgrade hermes-agent

# 3. Login to Hermes
hermes login

# 4. Restore config (from this repo)
cp ~/mobilemonero/docs/termux-recovery/hermes-config.yaml ~/.hermes/config.yaml
```

---

## 2. Clone Repositories

```bash
mkdir -p ~/projects
cd ~/projects
git clone https://github.com/xmrtdao/mobilemonero.git
# or
cd ~ && git clone https://github.com/xmrtdao/mobilemonero.git
```

---

## 3. Environment Variables

**CRITICAL:** These are NOT in the repo (secrets). Recreate `~/.bash_profile`:

```bash
# XMRT DAO / MobileMonero API Keys — SET THESE MANUALLY AFTER CLONE
# GitHub PAT (gh auth login or export from GitHub Settings → Developer Settings → Tokens)
# export GH_PAT="YOUR_GH_PAT_HERE"

# Supabase project URLs — get from Supabase Dashboard → Settings → API
# export SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
# export SUPABASE_TOKEN="YOUR_SUPABASE_SERVICE_ROLE_TOKEN"
# export SUPABASE_API_KEY="YOUR_SUPABASE_ANON_KEY"

# MiniMax (music generation) — get from platform.minimaxi.com
# Currently BLOCKED (no active Token Plan). Re-enable after top-up.
# export MINIMAX_API_KEY="YOUR_MINIMAX_KEY"

# Cloudflare Workers — get from Cloudflare Dashboard → My Profile → API Tokens
# export CF_ACCOUNT_ID="YOUR_CF_ACCOUNT_ID"
# export CF_API_TOKEN="YOUR_CF_API_TOKEN"
# export CF_ZONE_ID="YOUR_CF_ZONE_ID"

# Hugging Face — get from huggingface.co/settings/tokens
# export HF_TOKEN="YOUR_HF_TOKEN"

# Ollama (local inference — hangs on this device due to RAM limits, use CF AI instead)
export OLLAMA_HOST="127.0.0.1:11434"

# Path
export PATH="$HOME/.local/bin:$PATH"
```

Source it:
```bash
source ~/.bash_profile
```

---

## 4. Ollama (Local LLM)

```bash
pkg install -y proot-distro
pkg install -y ollama   # or build from source if pkg unavailable
ollama serve &
ollama pull llama3-chatqa
ollama pull gemma4      # 9.6GB — only if you have space
```

**Note:** Local Ollama hangs on this device (low RAM). Use Cloudflare Workers AI (`kimi-k2.6:cloud` through Hermes) as primary model.

---

## 5. Install CLI Tools

```bash
# Node.js / npm (for wrangler, though wrangler doesn't work on Android)
pkg install -y nodejs

# mmx-cli (MiniMax helper)
npm install -g mmx-cli

# GitHub CLI
pkg install -y gh
gh auth login  # or export GH_PAT and run: gh auth login --with-token < <(echo $GH_PAT)

# Python dependencies for pipeline
pip install requests
```

---

## 6. Cloudflare Workers Deployment

**Termux cannot run wrangler CLI** (workerd binary is incompatible with Android arm64).

**Use bash + curl REST API instead:**

```bash
cd ~/mobilemonero/workers/api-gateway
bash deploy.sh
```

All deploy scripts at `workers/*/deploy.sh` use the Cloudflare REST API directly.

---

## 7. SSH Keys (for GitHub push access)

```bash
ssh-keygen -t ed25519 -C "devgrugold@xmrtdao.com"
cat ~/.ssh/id_ed25519.pub
# Add to GitHub: Settings → SSH and GPG keys → New SSH key
```

Or use HTTPS with token:
```bash
git remote set-url origin https://$GH_PAT@github.com/xmrtdao/mobilemonero.git
```

---

## 8. Fleet Relay

The Hermes relay listener (`hermes_relay_listener.py`) and dashboard (`dashboard.html`) run on port 9090.

To restore:
```bash
cd ~/mobilemonero/fleet
python3 hermes_relay_listener.py &
# Dashboard served alongside relay on port 9090
```

**Note:** Old `dashboard-relay-v3.py` on port 8443 has been killed. Use unified port 9090.

---

## 9. Cloudflared Tunnels

```bash
pkg install -y cloudflared
cloudflared --version
# Use named tunnel config.yml to route to localhost:9090
```

---

## 10. Quick Validation (After Setup)

```bash
# Test 1: Git works
git -C ~/mobilemonero status

# Test 2: Pipeline dry-run
python3 ~/mobilemonero/mtv/mtv_pipeline.py --track meshfire --lyrics --dry-run

# Test 3: Worker health (via direct IP because Termux can't resolve)
curl --resolve mtv-lyrics.mobilemonero.com:443:104.21.17.92 \
  https://mtv-lyrics.mobilemonero.com/health

# Test 4: Fleet relay up
curl http://localhost:9090/health

# Test 5: Hermes login works
hermes whoami
```

---

## 11. Hermes Configuration Summary

| File | Path | Notes |
|------|------|-------|
| Main config | `~/.hermes/config.yaml` | Saved in repo at `docs/termux-recovery/` |
| SOUL.md | `~/.hermes/SOUL.md` | Saved in repo |
| Skills | `~/.hermes/skills/` | 25 skills — restore via `skills_list` then re-add |
| State DB | `~/.hermes/state.db` | NOT saved (ephemeral session data) |
| Memories | `~/.hermes/memories/` | NOT saved (will rebuild from conversation) |
| Sessions | `~/.hermes/sessions/` | NOT saved (history is lost on reinstall) |

---

## 12. Key Files in This Repo

| Path | What |
|------|------|
| `mtv/mtv_pipeline.py` | AI MTV Pipeline — music generation, lyrics via CF Worker |
| `mtv/mtv_tracks.json` | Track definitions (meshfire, cryptonight, zeroclaw) |
| `mtv/mtv_lyrics.md` | Lyric drafts + MiniMax schema docs |
| `mtv/worker/src/index.js` | Live lyric generation CF Worker |
| `mtv/deploy_cf_worker.sh` | Bash REST API deploy script |
| `workers/` | **9 CF Workers scaffolded** (api-gateway, ai-gateway, fleet-status, price-ticker, mtt-registry, offline-sync, webrtc-signaling, zkp-verification, wasm-edge-compute) |
| `docs/cf-worker-evaluation.md` | Full architectural rationale |
| `docs/termux-recovery/` | **This recovery guide + hermes-config.yaml + SOUL.md** |
| `.github/workflows/deploy-cf-worker.yml` | GitHub Actions auto-deploy for MTV worker |
| `fleet/hermes_relay_listener.py` | Fleet relay + dashboard (port 9090) |

---

## 13. External Dependencies (NOT in repo)

These need manual setup on fresh install:

| Service | Setup Required | Status |
|---------|---------------|--------|
| MiniMax Token Plan | platform.minimaxi.com → subscribe | BLOCKED (needs top-up) |
| Cloudflare zone DNS | Cloudflare Dashboard → CNAME records | ACTIVE (handled by Worker deploy scripts) |
| Hugging Face Spaces | `HF_TOKEN` → `huggingface-cli login` | CONFIGURED in GitHub secrets |
| Supabase edge functions | Supabase Dashboard / CLI | ACTIVE |
| Ollama local models | `ollama pull <model>` | HANGS (low RAM, use cloud models) |
| Meshtastic meshnet | `pip install meshtastic` → connect radio | NOT YET SET UP |
| GitHub PAT | `gh auth login` or set `GH_PAT` env | WORKING |

---

## 14. Known Limitations

| Limitation | Cause | Workaround |
|------------|-------|------------|
| Termux can't resolve `.mobilemonero.com` domains | Android libc DNS in container | Use `curl --resolve` with explicit IP or the API Gateway worker |
| Ollama (local) hangs | Insufficient RAM (~5.8GB free, gemma4 needs 9.6GB) | Use Cloudflare Workers AI (kimi-k2.6:cloud) |
| Wrangler can't run | Android arm64 incompatible with `workerd` binary | Use `deploy.sh` bash scripts with REST API |
| MiniMax music blocked | No active Token Plan subscription | Use CF Workers AI for text/lyrics; music gen pending top-up |
| 95% disk full | Phone storage constraint | Don't cargo build locally; delegate builds to cloud |

---

## 15. One-Command Recovery

```bash
# After cloning this repo and setting env vars:
cd ~/mobilemonero
bash docs/termux-recovery/recover.sh  # (create this script if you want one-step)
```

---

## 16. Contact / Reference

- Owner: Joseph Andrew Lee (DevGruGold) — xmrtdao.com
- Repo: github.com/xmrtdao/mobilemonero
- Relay: relay.mobilemonero.com:9090 (Eliza-Dev PureTrek v2.0.0)
- Status: `fleet-status` worker (when deployed)
- AI: `ai-gateway` worker (when deployed)
- API: `api.mobilemonero.com` (when api-gateway deployed)

---

**Last updated:** 2026-05-17 by Hermes Agent after CF Worker fleet scaffold
