/**
 * MTT Registry Worker
 * Stores Music Track Token metadata via Cloudflare KV.
 * KV binding: MTT_KV (set via Cloudflare Dashboard → Workers → 2a-mtt-registry → Settings → KV)
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

// KV helpers - works if MTT_KV is bound, falls back gracefully if not
function getKV() {
  try { return typeof MTT_KV !== 'undefined' ? MTT_KV : null; } catch(e) { return null; }
}

addEventListener("fetch", function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  var url = new URL(request.url);
  var path = url.pathname;
  var method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (path === "/health") {
    return jsonResponse({ ok: true, worker: "mtt-registry", kv: !!getKV() });
  }

  // POST /track/register — Register a new track token
  if (path === "/track/register" && method === "POST") {
    try {
      var body = await request.json();
      var id = body.id || "mtt-" + crypto.randomUUID().slice(0, 8);
      var track = {
        id: id,
        title: body.title || "Untitled",
        artist: body.artist || "Unknown",
        genre: body.genre || "Electronic",
        ipfs_hash: body.ipfs_hash || null,
        duration: body.duration || null,
        bpm: body.bpm || null,
        registered_at: new Date().toISOString()
      };
      var kv = getKV();
      if (kv) {
        await kv.put("track:" + id, JSON.stringify(track), { expirationTtl: 31536000 });
        return jsonResponse({ ok: true, id: id, track: track });
      } else {
        return jsonResponse({ ok: true, id: id, track: track, note: "KV binding not configured - in-memory only" });
      }
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // GET /track/:id
  if (path.startsWith("/track/") && method === "GET") {
    var id = path.split("/")[2];
    try {
      var kv = getKV();
      if (kv) {
        var raw = await kv.get("track:" + id);
        if (!raw) return jsonResponse({ error: "Track not found", id: id }, 404);
        return jsonResponse({ ok: true, track: JSON.parse(raw) });
      } else {
        return jsonResponse({ error: "KV binding not configured", id: id }, 500);
      }
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  return jsonResponse({ error: "Not Found", paths: ["/track/register", "/track/:id", "/health"] }, 404);
}
