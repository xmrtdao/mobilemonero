/**
 * WebRTC Signaling Worker
 * Stores and retrieves SDP offers by room_id via Cloudflare KV.
 * KV binding: WEBRTC_KV
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

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  // Health check
  if (url.pathname === "/health") {
    return jsonResponse({ ok: true, worker: "webrtc-signaling", kv: "WEBRTC_KV" });
  }

  var match = url.pathname.match(/^\/webrtc\/signal\/([^\/]+)$/);

  if (!match) {
    return jsonResponse({ error: "Not found", paths: ["/webrtc/signal/:room_id", "/health"] }, 404);
  }

  var room_id = match[1];

  // POST /webrtc/signal/{room_id} — store SDP offer
  if (request.method === "POST") {
    try {
      var body = await request.json();
      var sdp = body.sdp;
      var agent = body.agent || "unknown";
      if (!sdp) {
        return jsonResponse({ error: "Missing sdp field" }, 400);
      }
      // Store with 5min TTL (typical WebRTC timeout)
      await WEBRTC_KV.put("sdp:" + room_id, JSON.stringify({ sdp: sdp, agent: agent, ts: Date.now() }), { expirationTtl: 300 });
      return jsonResponse({ ok: true, room_id: room_id, status: "stored" });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // GET /webrtc/signal/{room_id} — retrieve SDP offer
  if (request.method === "GET") {
    try {
      var raw = await WEBRTC_KV.get("sdp:" + room_id);
      if (!raw) {
        return jsonResponse({ error: "No offer found for room", room_id: room_id }, 404);
      }
      var data = JSON.parse(raw);
      return jsonResponse({ ok: true, room_id: room_id, sdp: data.sdp, agent: data.agent });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}
