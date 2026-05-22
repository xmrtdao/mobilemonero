/**
 * WASM Edge Compute Worker
 * Executes Monero WASM operations (address derivation, transaction verification).
 * 
 * When a WASM module is bound via Cloudflare Dashboard (Settings -> WASM),
 * this worker will use it for real Monero operations. Without WASM, it returns
 * structured stubs describing the expected inputs.
 * 
 * WASM binding name: MONERO_WASM (set in Cloudflare Dashboard)
 * Source: github.com/monero-ecosystem/monero-javascript
 * Build: wasm-pack build --target web
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

function hasWasm() {
  try { return typeof MONERO_WASM !== 'undefined' && MONERO_WASM !== null; } catch(e) { return false; }
}

async function healthCheck() {
  return jsonResponse({ ok: true, worker: "wasm-edge-compute", wasm_loaded: hasWasm() });
}

// POST /wasm/monero/derive-address — Derive Monero address from keys
async function deriveAddress(body) {
  var spend_key = body.spend_key;
  var view_key = body.view_key;
  var network = body.network || "mainnet";
  
  if (!spend_key || !view_key) {
    return jsonResponse({
      error: "spend_key and view_key required",
      expected: { spend_key: "64-char hex string", view_key: "64-char hex string", network: "mainnet|stagenet|testnet" }
    }, 400);
  }

  if (hasWasm()) {
    // Real address derivation with bound WASM module
    var wasmInstance = await WebAssembly.instantiate(MONERO_WASM);
    var address = wasmInstance.exports.derive_address(spend_key, view_key, network);
    return jsonResponse({ address: address, network: network });
  }

  return jsonResponse({
    address: null,
    network: network,
    note: "MONERO_WASM not bound. Download from GitHub Actions → zero-claw → Build WASM Modules → artifacts",
    setup: {
      1: "Download monero_wasm.wasm artifact",
      2: "Upload to Cloudflare Dashboard: Workers → wasm-edge-compute → Settings → WASM → name: MONERO_WASM"
    }
  });
}

// POST /wasm/monero/verify-tx — Verify a Monero transaction
async function verifyTx(body) {
  var tx_hex = body.tx_hex;
  var network = body.network || "mainnet";
  
  if (!tx_hex) {
    return jsonResponse({
      error: "tx_hex required",
      expected: { tx_hex: "raw transaction hex", network: "mainnet|stagenet|testnet" }
    }, 400);
  }

  if (hasWasm()) {
    var wasmInstance = await WebAssembly.instantiate(MONERO_WASM);
    var result = wasmInstance.exports.verify_transaction(tx_hex, network);
    return jsonResponse({ valid: result.valid, outputs: result.outputs, fee: result.fee });
  }

  return jsonResponse({
    valid: null,
    network: network,
    note: "MONERO_WASM not bound"
  });
}

addEventListener("fetch", function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  var url = new URL(request.url);
  var path = url.pathname;
  var method = request.method;

  if (method === "OPTIONS") return new Response(null, { headers: CORS });

  if (path === "/health") return await healthCheck();

  if (path === "/wasm/monero/derive-address" && method === "POST") {
    try { return await deriveAddress(await request.json()); }
    catch (e) { return jsonResponse({ error: e.message }, 500); }
  }

  if (path === "/wasm/monero/verify-tx" && method === "POST") {
    try { return await verifyTx(await request.json()); }
    catch (e) { return jsonResponse({ error: e.message }, 500); }
  }

  return jsonResponse({ error: "Not found", paths: ["/wasm/monero/derive-address", "/wasm/monero/verify-tx", "/health"] }, 404);
}
