/**
 * WASM Edge Compute Stub Worker
 * Stub endpoints for Monero WASM operations on Cloudflare Workers.
 * The actual WASM module compilation is pending.
 *
 * Expected schema for /wasm/monero/derive-address:
 *   Input:  { "view_key": "hex", "spend_key": "hex", "index": number }
 *   Output: { "address": "...", "index": number }
 *
 * Expected schema for /wasm/monero/verify-tx:
 *   Input:  { "tx_hex": "...", "outputs": [...], "proofs": [...] }
 *   Output: { "valid": true/false, "details": "..." }
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // POST /wasm/monero/derive-address
    if (url.pathname === "/wasm/monero/derive-address" && request.method === "POST") {
      try {
        const body = await request.json();
        /* Expected input schema:
         * {
         *   "view_key": "hex_string",
         *   "spend_key": "hex_string",
         *   "index": 0
         * }
         * Expected output schema (when WASM ready):
         * {
         *   "address": "4...",
         *   "index": 0
         * }
         */
        return new Response(
          JSON.stringify({ status: "stub — WASM module pending" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // POST /wasm/monero/verify-tx
    if (url.pathname === "/wasm/monero/verify-tx" && request.method === "POST") {
      try {
        const body = await request.json();
        /* Expected input schema:
         * {
         *   "tx_hex": "...",
         *   "outputs": [ ... ],
         *   "proofs": [ ... ]
         * }
         * Expected output schema (when WASM ready):
         * {
         *   "valid": true/false,
         *   "details": "..."
         * }
         */
        return new Response(
          JSON.stringify({ status: "stub — WASM module pending" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
