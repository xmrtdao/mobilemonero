/**
 * Fleet Status Health Proxy Worker
 * Service Worker syntax.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

async function checkHealth(name, url, options) {
  var start = Date.now();
  try {
    var res = await fetch(url, options || { method: "GET" });
    var latency = Date.now() - start;
    return { status: "up", latency_ms: latency, http_status: res.status };
  } catch (e) {
    return { status: "down", latency_ms: Date.now() - start, error: e.message };
  }
}

async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  var url = new URL(request.url);
  var path = url.pathname;

  if (path === "/health") {
    return jsonResponse({ ok: true, worker: "fleet-status", ts: Date.now() });
  }

  if ((path === "/" || path === "") && request.method === "GET") {
    return jsonResponse({
      worker: "fleet-status",
      routes: {
        "/health": "GET worker health",
        "/fleet/status": "GET fleet health check (relay, supabase, mtv-lyrics)"
      }
    });
  }

  if (path === "/fleet/status" && request.method === "GET") {
    var results = await Promise.all([
      checkHealth("relay", "http://relay.mobilemonero.com:9090/json_rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "get_info" })
      }),
      checkHealth("supabase", "https://vawouugtzwmejxqkeqqj.supabase.co"),
      checkHealth("mtv_lyrics", "https://mtv-lyrics.xmrtdao-xmrt-dao-nb.workers.dev/health")
    ]);

    return jsonResponse({
      fleet: {
        relay: results[0],
        supabase: results[1],
        mtv_lyrics: results[2]
      },
      ts: Date.now()
    });
  }

  return jsonResponse({ error: "Not Found", paths: ["/", "/health", "/fleet/status"] }, 404);
}
