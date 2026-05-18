/**
 * WebRTC Signaling Worker
 * Stores and retrieves SDP offers by room_id via Cloudflare KV.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/webrtc\/signal\/([^\/]+)$/);

    if (!match) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const room_id = match[1];

    // POST /webrtc/signal/{room_id} — store SDP offer
    if (request.method === "POST") {
      try {
        const body = await request.json();
        const sdp = body.sdp;
        if (!sdp) {
          return new Response(JSON.stringify({ error: "Missing sdp field" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        await env.WEBRTC_KV.put(room_id, JSON.stringify({ sdp, timestamp: Date.now() }));
        return new Response(JSON.stringify({ ok: true, room_id }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // GET /webrtc/signal/{room_id} — retrieve SDP offer
    if (request.method === "GET") {
      try {
        const value = await env.WEBRTC_KV.get(room_id);
        if (!value) {
          return new Response(JSON.stringify({ error: "Room not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(value, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  },
};
