/**
 * MTT Registry Worker
 * Converted to addEventListener syntax for API deployment.
 * Stores Music Track Token metadata.
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

  // POST /track/register
  if (path === "/track/register" && request.method === "POST") {
    try {
      var body = await request.json();
      // KV/R2 binding required - stub for now
      var id = "stub-" + Date.now();
      return jsonResponse({ id: id, status: "registered (stub - KV binding required)" });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // GET /track/:id
  if (path.startsWith("/track/") && request.method === "GET") {
    var id = path.split("/")[2];
    // KV/R2 binding required - stub for now
    return jsonResponse({ error: "Not found (stub - KV binding required)", id: id }, 404);
  }

  return jsonResponse({ error: "Not Found", paths: ["/track/register", "/track/:id"] }, 404);
}
