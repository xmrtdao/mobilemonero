# Fleet Status Health Proxy Worker

Checks health of core fleet services using Service Worker syntax.

## Endpoints

- GET /health        - Worker health
- GET /fleet/status  - JSON with relay, supabase, and mtv-lyrics status

## Fleet Checks

- relay      - http://relay.mobilemonero.com:9090/json_rpc (Monero get_info)
- supabase   - https://vawouugtzwmejxqkeqqj.supabase.co
- mtv_lyrics - https://mtv-lyrics.xmrtdao-xmrt-dao-nb.workers.dev/health

## Deploy

export CF_ACCOUNT_ID=ef8e3637c4a00a43860b679ecd138a05
export CF_API_TOKEN=your_token
bash deploy.sh

## Custom Domain

Map worker-name.mobilemonero.com via Cloudflare dashboard or API after workers.dev activation.
