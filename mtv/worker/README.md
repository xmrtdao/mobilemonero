# XMRT MTV Lyric Worker

Cloudflare Worker that generates ${genre} song lyrics via Workers AI (LLaMA 3 8B), and builds MiniMax music-2.6 payloads.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/` | Docs |
| POST | `/generate` | Generate lyrics from theme+genre |
| POST | `/music-payload` | Build MiniMax music-2.6 payload |
| POST | `/ai-call` | Raw CF Workers AI call (testing) |

## Usage

```bash
curl -X POST https://<worker>.<account>.workers.dev/generate \
  -H "Content-Type: application/json" \
  -d '{"theme":"mesh networks","genre":"cyberpunk hiphop","title":"MeshFire"}'
```

## Deploy

### Option A: wrangler (recommended — macOS/Linux/Windows)
```bash
cd mtv/worker
wrangler login
wrangler deploy
```

### Option B: REST API curl (from Termux or CI)
```bash
export CF_ACCOUNT_ID="<your-account-id>"
export CF_API_TOKEN="<your-api-token>"
cd mtv
bash deploy_cf_worker.sh
```

### Option C: GitHub Actions
Push to `main` with `CF_API_TOKEN` and `CF_ACCOUNT_ID` in repo secrets.

## Worker Scopes Required

Cloudflare API token needs:
- Cloudflare Workers:Edit
- Account:Read
- Cloudflare AI:Read (if using AI binding)

## Files

- `src/index.js` — worker logic
- `wrangler.toml` — config + AI binding
- `deploy_cf_worker.sh` — shell deploy script
- `.github/workflows/deploy-cf-worker.yml` — GitHub Actions

## License

MIT © XMRT DAO
