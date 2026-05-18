# API Gateway Worker

Proxies requests to backend services using Service Worker syntax.

## Endpoints

- GET /health - Health check
- /relay      -> relay.mobilemonero.com:9090
- /supabase/* -> vawouugtzwmejxqkeqqj.supabase.co
- /hf/*       -> huggingface.co
- /github/*   -> api.github.com
- /minimax/*  -> api.minimaxi.chat
- /ai/*       -> Cloudflare Workers AI

## Deploy

export CF_ACCOUNT_ID=ef8e3637c4a00a43860b679ecd138a05
export CF_API_TOKEN=your_token
bash deploy.sh

## Custom Domain

Map worker-name.mobilemonero.com via Cloudflare dashboard or API after workers.dev activation.
