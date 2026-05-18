/**
 * API Gateway Worker
 * Service Worker syntax. Proxies requests to backend services.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data, status) {
  status = status || 200;
  var h = { "Content-Type": "application/json" };
  for (var k in CORS) { h[k] = CORS[k]; }
  return new Response(JSON.stringify(data), { status: status, headers: h });
}

function errorResponse(msg, status) {
  status = status || 500;
  var h = { "Content-Type": "application/json" };
  for (var k in CORS) { h[k] = CORS[k]; }
  return new Response(JSON.stringify({ error: msg }), { status: status, headers: h });
}

addEventListener("fetch", function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  var url = new URL(request.url);
  var path = url.pathname;

  if (path === "/health") {
    return jsonResponse({ ok: true, worker: "api-gateway", ts: Date.now() });
  }

  if (path === "/" || path === "") {
    return jsonResponse({
      worker: "api-gateway",
      routes: {
        "/health": "GET health check",
        "/relay": "→ relay.mobilemonero.com:9090",
        "/supabase/*": "→ vawouugtzwmejxqkeqqj.supabase.co",
        "/hf/*": "→ huggingface.co",
        "/github/*": "→ api.github.com",
        "/minimax/*": "→ api.minimaxi.chat",
        "/ai/*": "→ Cloudflare Workers AI (api.cloudflare.com)"
      }
    });
  }

  var targetUrl;
  if (path.startsWith("/relay")) {
    targetUrl = "http://relay.mobilemonero.com:9090" + path.slice("/relay".length) + url.search;
  } else if (path.startsWith("/supabase/")) {
    targetUrl = "https://vawouugtzwmejxqkeqqj.supabase.co" + path.slice("/supabase".length) + url.search;
  } else if (path.startsWith("/hf/")) {
    targetUrl = "https://huggingface.co" + path.slice("/hf".length) + url.search;
  } else if (path.startsWith("/github/")) {
    targetUrl = "https://api.github.com" + path.slice("/github".length) + url.search;
  } else if (path.startsWith("/minimax/")) {
    targetUrl = "https://api.minimaxi.chat" + path.slice("/minimax".length) + url.search;
  } else if (path.startsWith("/ai/")) {
    targetUrl = "https://api.cloudflare.com/client/v4/accounts/ef8e3637c4a00a43860b679ecd138a05/ai" + path.slice("/ai".length) + url.search;
  } else {
    return errorResponse("Not Found. Valid paths: /relay, /supabase/*, /hf/*, /github/*, /minimax/*, /ai/*", 404);
  }

  try {
    var headers = new Headers();
    request.headers.forEach(function(value, key) {
      if (key.toLowerCase() !== "cf-ray" && key.toLowerCase() !== "cf-connecting-ip") {
        headers.set(key, value);
      }
    });

    var body = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = request.body;
    }

    var res = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body: body,
      redirect: "follow"
    });

    var resHeaders = new Headers(res.headers);
    for (var k in CORS) {
      resHeaders.set(k, CORS[k]);
    }

    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: resHeaders });
  } catch (e) {
    return errorResponse("Proxy error: " + e.message, 502);
  }
}
