# AI Gateway Worker

Routes AI generation requests to the best available backend using Service Worker syntax.

## Endpoints

- GET /health       - Health check
- POST /ai/generate - {type, prompt?, messages?, model?, duration?}

## Type Routing

- text  -> Cloudflare Workers AI (Authorization: Bearer <CF_API_TOKEN>)
- music -> MiniMax actual music generation (X-MiniMax-Token)
- image -> Hugging Face inference (X-HF-Token)
- video -> MiniMax video generation (X-MiniMax-Token)

## Deploy

export CF_ACCOUNT_ID=ef8e3637c4a00a43860b679ecd138a05
export CF_API_TOKEN=your_token
bash deploy.sh

## Custom Domain

Map worker-name.mobilemonero.com via Cloudflare dashboard or API after workers.dev activation.
