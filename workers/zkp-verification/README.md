# ZKP Verification Stub Worker

Cloudflare Worker stub for Zero-Knowledge Proof verification.

## Endpoints

- `POST /verify/tx`
  - Accepts JSON transaction proof.
  - Returns `{ valid: false, note: "stub — real verification WASM not yet compiled" }`.

- `POST /verify/balance`
  - Accepts JSON balance proof.
  - Returns `{ valid: false, note: "stub — real verification WASM not yet compiled" }`.

## Deploy

```bash
export CF_ACCOUNT_ID=...
export CF_API_TOKEN=...
./deploy.sh
```
