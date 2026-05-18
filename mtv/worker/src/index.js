/**
 * XMRT DAO MTV Lyric Generator Worker
 * Deploy to Cloudflare Workers with AI binding
 * Routes:
 *   GET  /       - docs
 *   GET  /health - health check
 *   POST /generate        - generate lyrics via CF Workers AI
 *   POST /music-payload   - build MiniMax music-2.6 payload
 *   POST /ai-call         - proxy call to CF Workers AI (for testing)
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function parseLyrics(text) {
  const sections = [];
  const lines = text.split("\n");
  let current = null;
  for (const line of lines) {
    const m = line.match(/^\[(Intro|Verse|Chorus|Bridge|Outro|Hook|Pre-Chorus)\d*\]$/i);
    if (m) {
      current = { tag: m[1].toLowerCase(), lines: [] };
      sections.push(current);
    } else if (current && line.trim()) {
      current.lines.push(line.trim());
    }
  }
  return sections;
}

function buildPrompt(body) {
  const { theme, genre, title, vibe = "dark tech-noir", sections = ["Intro","Verse","Chorus","Verse","Chorus","Outro"] } = body;
  return `You are XMRT DAO's AI songwriter. Write original ${genre} lyrics about ${theme}.
${title ? `Title: ${title}` : ""}
Vibe: ${vibe}.
Structure: ${sections.join(", ")}.
Rules:
- Use section tags exactly like [Intro], [Verse], [Chorus], [Bridge], [Outro].
- Each tag on its own line. Lyrics follow immediately after each tag.
- No extra commentary. No introductory text. Return ONLY the tagged lyrics.`;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // health
    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, worker: "mtv-lyrics", ts: Date.now() });
    }

    // docs
    if (url.pathname === "/" || url.pathname === "") {
      return jsonResponse({
        worker: "mtv-lyrics",
        routes: {
          "/health": "GET health check",
          "/generate": "POST {theme, genre, title?, sections?, vibe?} → lyrics JSON",
          "/music-payload": "POST {prompt, duration?} → MiniMax music-2.6 payload",
          "/ai-call": "POST {messages[], model?} → raw CF AI response",
        },
      });
    }

    // generate lyrics
    if (url.pathname === "/generate" && request.method === "POST") {
      try {
        const body = await request.json();
        const { theme, genre } = body;
        if (!theme || !genre) {
          return jsonResponse({ error: "theme and genre are required" }, 400);
        }

        if (!env.AI) {
          return jsonResponse({ error: "AI binding not configured. Add [ai] binding = \"AI\" in wrangler.toml" }, 500);
        }

        const prompt = buildPrompt(body);
        const model = body.model || "@cf/meta/llama-3-8b-instruct";

        const aiRes = await env.AI.run(model, {
          messages: [{ role: "user", content: prompt }],
        });

        const rawText = aiRes.response || aiRes.result?.response || JSON.stringify(aiRes);
        const sections = parseLyrics(rawText);

        return jsonResponse({
          title: body.title || `${theme} (${genre})`,
          genre,
          theme,
          vibe: body.vibe || "dark tech-noir",
          model,
          lyrics_raw: rawText,
          sections,
          generated_at: new Date().toISOString(),
        });
      } catch (e) {
        return jsonResponse({ error: e.message, stack: e.stack }, 500);
      }
    }

    // build MiniMax payload
    if (url.pathname === "/music-payload" && request.method === "POST") {
      try {
        const body = await request.json();
        const { prompt, duration = 30 } = body;
        if (!prompt) {
          return jsonResponse({ error: "prompt is required" }, 400);
        }
        return jsonResponse({
          model: "music-2.6",
          prompt,
          duration,
          source: "mtv-worker",
          minimax_endpoint: "https://api.minimaxi.chat/v1/music_generation",
        });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // raw ai-call proxy (useful for testing the binding)
    if (url.pathname === "/ai-call" && request.method === "POST") {
      try {
        const body = await request.json();
        const model = body.model || "@cf/meta/llama-3-8b-instruct";
        if (!env.AI) {
          return jsonResponse({ error: "AI binding not configured" }, 500);
        }
        const aiRes = await env.AI.run(model, body);
        return jsonResponse({ model, result: aiRes });
      } catch (e) {
        return jsonResponse({ error: e.message, stack: e.stack }, 500);
      }
    }

    return jsonResponse({ error: "Not Found", paths: ["/", "/health", "/generate", "/music-payload", "/ai-call"] }, 404);
  },
};
