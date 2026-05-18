# WASM Edge Compute Stub Worker

Cloudflare Worker stub for Monero WASM edge compute operations.

## Endpoints

- `POST /wasm/monero/derive-address`
  - Stub that returns `{ status: "stub — WASM module pending" }`.
  - Expected input (when WASM ready):
    ```json
    { "view_key": "hex", "spend_key": "hex", "index": 0 }
    ```
  - Expected output (when WASM ready):
    ```json
    { "address": "4...", "index": 0 }
    ```

- `POST /wasm/monero/verify-tx`
  - Stub that returns `{ status: "stub — WASM module pending" }`.
  - Expected input (when WASM ready):
    ```json
    { "tx_hex": "...", "outputs": [ ... ], "proofs": [ ... ] }
    ```
  - Expected output (when WASM ready):
    ```json
    { "valid": true/false, "details": "..." }
    ```

## Deploy

```bash
export CF_ACCOUNT_ID=...
export CF_API_TOKEN=...
./deploy.sh
```
