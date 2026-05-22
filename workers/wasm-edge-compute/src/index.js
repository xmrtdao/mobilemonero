/**
 * WASM Edge Compute Worker
 * Executes Monero WASM operations (address derivation, transaction verification).
 * 
 * Expected WASM module (compiled from monero-ts or monero-javascript):
 *   - derive_address(private_spend_key, private_view_key) -> (public_addr, public_spend, public_view)
 *   - verify_transaction(tx_hex, network_type) -> { valid: bool, outputs: [], fee: u64 }
 * 
 * Compile pipeline:
 *   1. git clone https://github.com/monero-ecosystem/monero-javascript
 *   2. cd monero-javascript && npm install
 *   3. npx wasm-pack build --target web
 *   4. cp pkg/monero_wasm.wasm ../workers/wasm-edge-compute/wasm/
 *   5. Upload wasm as binding via Cloudflare Dashboard
 */

var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status) {
  status = status || 200;
  var h = { "Content-Type": "application/json" };
  for (var k in CORS) { h[k] = CORS[k]; }
  return new Response(JSON.stringify(data), { status: status, headers: h });
}

addEventListener("fetch", function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  var url = new URL(request.url);
  var path = url.pathname;
  var method = request.method;

  if (method === "OPTIONS") return new Response(null, { headers: CORS });

  if (path === "/health") {
    return jsonResponse({ ok: true, worker: "wasm-edge-compute", wasm: "pending", note: "Requires monero-js WASM compile" });
  }

  // POST /wasm/monero/derive-address — Derive Monero address from keys
  if (path === "/wasm/monero/derive-address" && method === "POST") {
    try {
      var body = await request.json();
      var spend_key = body.spend_key;
      var view_key = body.view_key;
      var network = body.network || "mainnet";
      
      if (!spend_key || !view_key) {
        return jsonResponse({
          error: "spend_key and view_key required",
          expected: { spend_key: "hex string (64 chars)", view_key: "hex string (64 chars)", network: "mainnet | stagenet | testnet" },
          note: "Compile monero-javascript WASM to activate"
        }, 400);
      }
      return jsonResponse({
        address: null,
        network: network,
        note: "WASM module not deployed. See compile pipeline in worker header comments."
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // POST /wasm/monero/verify-tx — Verify a Monero transaction
  if (path === "/wasm/monero/verify-tx" && method === "POST") {
    try {
      var body = await request.json();
      var tx_hex = body.tx_hex;
      var network = body.network || "mainnet";
      
      if (!tx_hex) {
        return jsonResponse({
          error: "tx_hex required",
          expected: { tx_hex: "raw transaction hex", network: "mainnet | stagenet | testnet" },
          note: "Compile monero-javascript WASM to activate"
        }, 400);
      }
      return jsonResponse({
        valid: null,
        network: network,
        note: "WASM module not deployed"
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  return jsonResponse({ error: "Not found", paths: ["/wasm/monero/derive-address", "/wasm/monero/verify-tx", "/health"] }, 404);
}
