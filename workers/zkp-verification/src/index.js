/**
 * ZKP Verification Stub Worker
 * Converted to addEventListener syntax for API deployment.
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

  // POST /verify/tx
  if (path === "/verify/tx" && request.method === "POST") {
    try {
      var proof = await request.json();
      return jsonResponse({ valid: false, note: "stub — real verification WASM not yet compiled" });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // POST /verify/balance
  if (path === "/verify/balance" && request.method === "POST") {
    try {
      var proof = await request.json();
      return jsonResponse({ valid: false, note: "stub — real verification WASM not yet compiled" });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  return jsonResponse({ error: "Not found", paths: ["/verify/tx", "/verify/balance"] }, 404);
}
