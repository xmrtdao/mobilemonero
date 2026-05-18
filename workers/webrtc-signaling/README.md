# WebRTC Signaling Worker

Cloudflare Worker for WebRTC SDP offer storage and retrieval using KV.

## Endpoints

- `POST /webrtc/signal/{room_id}`
  - Body: `{ "sdp": "..." }`
  - Stores the SDP offer in KV keyed by `room_id`.

- `GET /webrtc/signal/{room_id}`
  - Retrieves the stored SDP offer for the room.

## Environment

- `WEBRTC_KV`: Cloudflare KV namespace binding.

## Deploy

```bash
export CF_ACCOUNT_ID=...
export CF_API_TOKEN=...
export WEBRTC_KV_NAMESPACE_ID=...
./deploy.sh
```
