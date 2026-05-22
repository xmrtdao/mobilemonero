/**
 * ZKP Verification Worker
 * Verifies zero-knowledge proofs for transaction and balance privacy.
 * 
 * When a WASM module is bound via Cloudflare Dashboard (Settings -> WASM),
 * this worker will use it for real verification. Without WASM, it returns
 * structured stubs describing the expected proof format.
 * 
 * WASM binding name: ZKP_WASM (set in Cloudflare Dashboard)
 * Circuit: circuits/main.nr (Noir v0.33+)
 * Compile: cd circuits && nargo compile && nargo prove
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

  // Health — detect if WASM is bound
  if (path === "/health") {
    try {
      var hasWasm = typeof ZKP_WASM !== 'undefined' && ZKP_WASM !== null;
      return jsonResponse({ ok: true, worker: "zkp-verification", wasm_loaded: hasWasm });
    } catch(e) {
      return jsonResponse({ ok: true, worker: "zkp-verification", wasm_loaded: false });
    }
  }

  // POST /verify/tx — Verify a zero-knowledge transaction proof
  if (path === "/verify/tx" && method === "POST") {
    try {
      var body = await request.json();
      var proof = body.proof;
      var public_inputs = body.public_inputs || [];

      try {
        var hasWasm = typeof ZKP_WASM !== 'undefined' && ZKP_WASM !== null;
      } catch(e) { var hasWasm = false; }

      if (hasWasm) {
        // Real verification with bound WASM module
        var wasmInstance = await WebAssembly.instantiate(ZKP_WASM);
        var valid = wasmInstance.exports.verify(proof, JSON.stringify(public_inputs));
        return jsonResponse({ valid: Boolean(valid), proof_type: "zkp" });
      }

      // No WASM bound — return schema info
      return jsonResponse({
        valid: false,
        error: "ZKP_WASM not bound",
        setup_instructions: {
          1: "Download WASM from GitHub Actions: zero-claw → Actions → Build WASM Modules → artifacts",
          2: "Upload to Cloudflare Dashboard: Workers → zkp-verification → Settings → WASM → name: ZKP_WASM",
          3: "Worker will then use Noir verification circuit automatically"
        },
        expected_proof_format: {
          proof: "Hex-encoded proof bytes (from nargo prove output)",
          public_inputs: ["proposal_hash (string)", "nullifier_hash (string)", "vote_commitment (string)"],
          circuit: "zero_claw (Noir v0.33+)"
        }
      }, 200);
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // POST /verify/balance — Verify a range proof (bulletproof)
  if (path === "/verify/balance" && method === "POST") {
    try {
      var body = await request.json();
      try { var hasWasm = typeof ZKP_WASM !== 'undefined' && ZKP_WASM !== null; } catch(e) { var hasWasm = false; }

      if (hasWasm) {
        var wasmInstance = await WebAssembly.instantiate(ZKP_WASM);
        var valid = wasmInstance.exports.verify_balance(JSON.stringify(body));
        return jsonResponse({ valid: Boolean(valid), proof_type: "range_proof" });
      }

      return jsonResponse({
        valid: false,
        error: "ZKP_WASM not bound",
        expected_inputs: {
          commitment: "Pedersen commitment to balance (64 hex chars)",
          proof: "Bulletproof range proof (variable length hex)",
          min_balance: "Minimum balance to prove (unsigned integer)"
        },
        note: "Range proof circuit pending — compile circuits/range_proof.nr when available"
      }, 200);
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  return jsonResponse({ error: "Not found", paths: ["/verify/tx", "/verify/balance", "/health"] }, 404);
}
