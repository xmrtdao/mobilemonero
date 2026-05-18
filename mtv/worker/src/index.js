/**
 * XMRT DAO MTV Lyric Generator Worker
 * Service Worker syntax.  Reads CF Workers AI token from Authorization header.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data, status) {
  status = status || 200;
  var h = { "Content-Type": "application/json" };
  for (var k in CORS) { h[k] = CORS[k]; }
  return new Response(JSON.stringify(data), { status: status, headers: h });
}

function parseLyrics(text) {
  var sections = [];
  var lines = text.split("\n");
  var current = null;
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\[(Intro|Verse|Chorus|Bridge|Outro|Hook|Pre-Chorus)\d*\]$/i);
    if (m) {
      current = { tag: m[1].toLowerCase(), lines: [] };
      sections.push(current);
    } else if (current && lines[i].trim()) {
      current.lines.push(lines[i].trim());
    }
  }
  return sections;
}

function buildPrompt(body) {
  var theme = body.theme || "";
  var genre = body.genre || "";
  var title = body.title || "";
  var vibe = body.vibe || "dark tech-noir";
  var sections = body.sections || ["Intro","Verse","Chorus","Verse","Chorus","Outro"];
  return "You are XMRT DAO's AI songwriter. Write original " + genre + " lyrics about " + theme + "."
    + (title ? "\nTitle: " + title : "")
    + "\nVibe: " + vibe + "."
    + "\nStructure: " + sections.join(", ") + "."
    + "\nRules:"
    + "\n- Use section tags exactly like [Intro], [Verse], [Chorus], [Bridge], [Outro]."
    + "\n- Each tag on its own line. Lyrics follow immediately after each tag."
    + "\n- No extra commentary. No introductory text. Return ONLY the tagged lyrics.";
}

addEventListener("fetch", function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  var url = new URL(request.url);
  if (url.pathname === "/health") {
    return jsonResponse({ ok: true, worker: "mtv-lyrics", ts: Date.now() });
  }

  if (url.pathname === "/" || url.pathname === "") {
    return jsonResponse({
      worker: "mtv-lyrics",
      routes: {
        "/health": "GET health check",
        "/generate": "POST {theme, genre, title?, sections?, vibe?} + Authorization: Bearer <cf_token>",
        "/music-payload": "POST {prompt, duration?} → MiniMax music-2.6 payload",
        "/ai-call": "POST {messages[], model?} + Authorization: Bearer <cf_token>",
      },
    });
  }

  if (url.pathname === "/generate" && request.method === "POST") {
    try {
      var body = await request.json();
      var theme = body.theme;
      var genre = body.genre;
      if (!theme || !genre) {
        return jsonResponse({ error: "theme and genre are required" }, 400);
      }

      var authHeader = request.headers.get("Authorization") || "";
      var cfToken = authHeader.replace(/^Bearer\s+/, "");
      if (!cfToken) {
        return jsonResponse({ error: "Missing Authorization: Bearer <CF_API_TOKEN> header" }, 401);
      }

      var model = body.model || "@cf/meta/llama-3-8b-instruct";
      var prompt = buildPrompt(body);

      var aiRes = await fetch(
        "https://api.cloudflare.com/client/v4/accounts/ef8e3637c4a00a43860b679ecd138a05/ai/run/" + model,
        {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + cfToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
        }
      );

      var aiJson = await aiRes.json();
      var rawText = (aiJson.result && aiJson.result.response)
        ? aiJson.result.response
        : JSON.stringify(aiJson);
      var sections = parseLyrics(rawText);

      return jsonResponse({
        title: body.title || (theme + " (" + genre + ")"),
        genre: genre,
        theme: theme,
        vibe: body.vibe || "dark tech-noir",
        model: model,
        lyrics_raw: rawText,
        sections: sections,
        generated_at: new Date().toISOString(),
      });
    } catch (e) {
      return jsonResponse({ error: e.message, stack: e.stack }, 500);
    }
  }

  if (url.pathname === "/music-payload" && request.method === "POST") {
    try {
      var body = await request.json();
      var prompt = body.prompt;
      var duration = body.duration || 30;
      if (!prompt) {
        return jsonResponse({ error: "prompt is required" }, 400);
      }
      return jsonResponse({
        model: "music-2.6",
        prompt: prompt,
        duration: duration,
        source: "mtv-worker",
        minimax_endpoint: "https://api.minimaxi.chat/v1/music_generation",
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (url.pathname === "/ai-call" && request.method === "POST") {
    try {
      var body = await request.json();
      var model = body.model || "@cf/meta/llama-3-8b-instruct";
      var authHeader = request.headers.get("Authorization") || "";
      var cfToken = authHeader.replace(/^Bearer\s+/, "");
      if (!cfToken) {
        return jsonResponse({ error: "Missing Authorization: Bearer <CF_API_TOKEN> header" }, 401);
      }
      var aiRes = await fetch(
        "https://api.cloudflare.com/client/v4/accounts/ef8e3637c4a00a43860b679ecd138a05/ai/run/" + model,
        {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + cfToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );
      var aiJson = await aiRes.json();
      return jsonResponse({ model: model, result: aiJson });
    } catch (e) {
      return jsonResponse({ error: e.message, stack: e.stack }, 500);
    }
  }

  return jsonResponse({ error: "Not Found", paths: ["/", "/health", "/generate", "/music-payload", "/ai-call"] }, 404);
}
