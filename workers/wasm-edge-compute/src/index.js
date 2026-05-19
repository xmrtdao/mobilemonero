/**
 * WASM Edge Compute Stub Worker
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

  // POST /wasm/monero/derive-address
  if (path === "/wasm/monero/derive-address" && request.method === "POST") {
    try {
      var body = await request.json();
      return jsonResponse({ status: "stub — WASM module pending" });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // POST /wasm/monero/verify-tx
  if (path === "/wasm/monero/verify-tx" && request.method === "POST") {
    try {
      var body = await request.json();
      return jsonResponse({ status: "stub — WASM module pending" });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  return jsonResponse({ error: "Not found", paths: ["/wasm/monero/derive-address", "/wasm/monero/verify-tx"] }, 404);
}
