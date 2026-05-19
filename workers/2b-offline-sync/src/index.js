/**
 * Offline Sync Worker
 * Converted to addEventListener syntax for API deployment.
 * Mesh message buffer for offline-first sync.
 */

var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

  // POST /mesh/buffer — Store message
  if (path === "/mesh/buffer" && method === "POST") {
    try {
      var body = await request.json();
      var recipient = body.recipient;
      if (!recipient) {
        return jsonResponse({ error: "recipient required" }, 400);
      }
      // KV binding required - stub for now
      var ts = Date.now();
      var msgId = recipient + ":" + ts + ":stub";
      return jsonResponse({ msg_id: msgId, status: "stored (stub - KV binding required)" });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // POST /mesh/poll — Retrieve messages
  if (path === "/mesh/poll" && method === "POST") {
    try {
      var body = await request.json();
      var recipient = body.recipient;
      if (!recipient) {
        return jsonResponse({ error: "recipient required" }, 400);
      }
      // KV binding required - stub for now
      return jsonResponse({ recipient: recipient, messages: [], note: "KV binding required" });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // DELETE /mesh/buffer/:id — Acknowledge receipt
  if (path.startsWith("/mesh/buffer/") && method === "DELETE") {
    var msgId = path.split("/")[3];
    if (!msgId) {
      return jsonResponse({ error: "msg_id required" }, 400);
    }
    // KV binding required - stub for now
    return jsonResponse({ msg_id: msgId, status: "deleted (stub - KV binding required)" });
  }

  return jsonResponse({ error: "Not Found", paths: ["/mesh/buffer", "/mesh/poll", "/mesh/buffer/:id"] }, 404);
}
