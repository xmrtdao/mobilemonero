/**
 * ZKP Verification Worker
 * Verifies zero-knowledge proofs for transaction and balance privacy.
 * 
 * Expected proof format (Noir barretenberg):
 *   { proof: Uint8Array, public_inputs: string[], proof_type: "tx" | "balance" }
 * 
 * When the Noir circuit is compiled to WASM via nargo compile,
 * this worker will load the verification WASM and verify proofs.
 * 
 * Circuit: circuits/main.nr (Noir)
 * Compile: cd circuits && nargo compile --package zero_claw
 * WASM: target/zero_claw.wasm
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

  // Health check
  if (path === "/health") {
    return jsonResponse({ ok: true, worker: "zkp-verification", circuit: "Noir/barretenberg", status: "stub" });
  }

  // POST /verify/tx — Verify a transaction proof
  if (path === "/verify/tx" && method === "POST") {
    try {
      var body = await request.json();
      var proof = body.proof;
      var public_inputs = body.public_inputs || [];
      var expected_schema = {
        proof: "Uint8Array (hex or base64 encoded)",
        public_inputs: ["proposal_hash (string)", "nullifier_hash (string)", "vote_commitment (string)"],
        circuit: "zero_claw (Noir v0.33+)"
      };
      if (!proof) {
        return jsonResponse({
          valid: false,
          error: "proof field required",
          expected_schema: expected_schema,
          note: "Compile Noir circuit and deploy verification WASM to activate"
        }, 400);
      }
      return jsonResponse({
        valid: false,
        note: "Verification WASM not deployed. Run: cd circuits && nargo compile && cp target/*.wasm ../workers/zkp-verification/wasm/",
        proof_received: typeof proof,
        inputs_received: public_inputs.length,
        expected_schema: expected_schema
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // POST /verify/balance — Verify a balance proof (range proof / bulletproof)
  if (path === "/verify/balance" && method === "POST") {
    try {
      var body = await request.json();
      return jsonResponse({
        valid: false,
        note: "Balance verification requires Bulletproofs++ circuit. Circuit spec in circuits/README.md",
        expected_inputs: {
          commitment: "Pedersen commitment to balance (hex)",
          proof: "Bulletproof range proof (hex)",
          min: "Minimum balance to prove (integer)"
        }
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  return jsonResponse({ error: "Not found", paths: ["/verify/tx", "/verify/balance", "/health"] }, 404);
}
