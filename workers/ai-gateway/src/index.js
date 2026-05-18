/**
 * AI Gateway Worker
 * Service Worker syntax. Routes /ai/generate to the best available backend.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-HF-Token, X-MiniMax-Token",
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
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  var url = new URL(request.url);
  var path = url.pathname;

  if (path === "/health") {
    return jsonResponse({ ok: true, worker: "ai-gateway", ts: Date.now() });
  }

  if ((path === "/" || path === "") && request.method === "GET") {
    return jsonResponse({
      worker: "ai-gateway",
      routes: {
        "/health": "GET health check",
        "/ai/generate": "POST {type: text|music|image|video, prompt?, messages?, model?, ...}"
      },
      backends: {
        text: "Cloudflare Workers AI (requires Authorization: Bearer <CF_API_TOKEN>)",
        music: "MiniMax actual music generation (requires X-MiniMax-Token)",
        image: "Hugging Face inference (requires X-HF-Token)",
        video: "MiniMax video generation (requires X-MiniMax-Token)"
      }
    });
  }

  if (path === "/ai/generate" && request.method === "POST") {
    try {
      var body = await request.json();
      var type = body.type;
      if (!type) {
        return jsonResponse({ error: "type is required (text|music|image|video)" }, 400);
      }

      var authHeader = request.headers.get("Authorization") || "";
      var cfToken = authHeader.replace(/^Bearer\s+/, "");

      var targetUrl;
      var targetHeaders = new Headers();
      targetHeaders.set("Content-Type", "application/json");

      if (type === "text") {
        var model = body.model || "@cf/meta/llama-3-8b-instruct";
        targetUrl = "https://api.cloudflare.com/client/v4/accounts/ef8e3637c4a00a43860b679ecd138a05/ai/run/" + model;
        if (!cfToken) {
          return jsonResponse({ error: "Authorization: Bearer <CF_API_TOKEN> required for type=text" }, 401);
        }
        targetHeaders.set("Authorization", "Bearer " + cfToken);
        var payload = body.messages ? { messages: body.messages } : { messages: [{ role: "user", content: body.prompt || "" }] };
        var res = await fetch(targetUrl, { method: "POST", headers: targetHeaders, body: JSON.stringify(payload) });
        var json = await res.json();
        return jsonResponse({ type: type, backend: "cf-ai", model: model, result: json });
      } else if (type === "image") {
        var hfModel = body.model || "stabilityai/stable-diffusion-2-1";
        targetUrl = "https://api-inference.huggingface.co/models/" + hfModel;
        var hfToken = request.headers.get("X-HF-Token") || "";
        if (hfToken) { targetHeaders.set("Authorization", "Bearer " + hfToken); }
        var imgPayload = { inputs: body.prompt || "" };
        var res = await fetch(targetUrl, { method: "POST", headers: targetHeaders, body: JSON.stringify(imgPayload) });
        var blob = await res.blob();
        var outHeaders = new Headers({ "Content-Type": blob.type || "image/png" });
        for (var k in CORS) { outHeaders.set(k, CORS[k]); }
        return new Response(blob, { status: res.status, headers: outHeaders });
      } else if (type === "music") {
        targetUrl = "https://api.minimaxi.chat/v1/music_generation";
        var minimaxToken = request.headers.get("X-MiniMax-Token") || "";
        if (minimaxToken) { targetHeaders.set("Authorization", "Bearer " + minimaxToken); }
        var musicPayload = {
          model: "music-2.6",
          prompt: body.prompt || "",
          duration: body.duration || 30
        };
        var res = await fetch(targetUrl, { method: "POST", headers: targetHeaders, body: JSON.stringify(musicPayload) });
        var json = await res.json();
        return jsonResponse({ type: type, backend: "minimax", result: json });
      } else if (type === "video") {
        targetUrl = "https://api.minimaxi.chat/v1/video_generation";
        var minimaxToken = request.headers.get("X-MiniMax-Token") || "";
        if (minimaxToken) { targetHeaders.set("Authorization", "Bearer " + minimaxToken); }
        var videoPayload = {
          model: body.model || "video-01",
          prompt: body.prompt || ""
        };
        var res = await fetch(targetUrl, { method: "POST", headers: targetHeaders, body: JSON.stringify(videoPayload) });
        var json = await res.json();
        return jsonResponse({ type: type, backend: "minimax", result: json });
      } else {
        return jsonResponse({ error: "Unknown type. Expected text|music|image|video" }, 400);
      }
    } catch (e) {
      return jsonResponse({ error: e.message, stack: e.stack }, 500);
    }
  }

  return jsonResponse({ error: "Not Found", paths: ["/", "/health", "/ai/generate"] }, 404);
}
