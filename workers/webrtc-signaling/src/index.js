/**
 * WebRTC Signaling Worker
 * Converted to addEventListener syntax for API deployment.
 * Stores and retrieves SDP offers by room_id via Cloudflare KV.
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
  var match = url.pathname.match(/^\/webrtc\/signal\/([^\/]+)$/);

  if (!match) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  var room_id = match[1];

  // POST /webrtc/signal/{room_id} — store SDP offer
  if (request.method === "POST") {
    try {
      var body = await request.json();
      var sdp = body.sdp;
      if (!sdp) {
        return jsonResponse({ error: "Missing sdp field" }, 400);
      }
      // KV binding required: env.WEBRTC_KV
      // Stub for now without KV
      return jsonResponse({ ok: true, room_id: room_id, note: "KV binding required for storage" });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // GET /webrtc/signal/{room_id} — retrieve SDP offer
  if (request.method === "GET") {
    // KV binding required for retrieval
    return jsonResponse({ error: "KV binding required", room_id: room_id }, 500);
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}
