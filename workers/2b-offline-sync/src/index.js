/**
 * Offline Sync Worker
 * Mesh message buffer for offline-first sync.
 * Uses KV for persistent storage with 24h TTL.
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

// KV namespace: MESH_BUFFER
// Messages stored with key format: "msg:{recipient}:{msgId}"
// Recipient inbox key format: "inbox:{recipient}" -> JSON array of msgIds

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

  // POST /mesh/buffer — Store message for offline recipient
  if (path === "/mesh/buffer" && method === "POST") {
    try {
      var body = await request.json();
      var recipient = body.recipient;
      var sender = body.sender || "unknown";
      var message = body.message;
      var topic = body.topic || "general";

      if (!recipient || !message) {
        return jsonResponse({ error: "recipient and message required" }, 400);
      }

      var msgId = crypto.randomUUID();
      var ts = Date.now();
      var entry = { msg_id: msgId, sender: sender, recipient: recipient, message: message, topic: topic, ts: ts };

      // Store message with 24h TTL
      await MESH_BUFFER.put("msg:" + recipient + ":" + msgId, JSON.stringify(entry), { expirationTtl: 86400 });

      // Add to recipient's inbox index
      var inboxKey = "inbox:" + recipient;
      var inboxRaw = await MESH_BUFFER.get(inboxKey);
      var inbox = inboxRaw ? JSON.parse(inboxRaw) : [];
      inbox.push(msgId);
      if (inbox.length > 100) inbox = inbox.slice(-100);
      await MESH_BUFFER.put(inboxKey, JSON.stringify(inbox), { expirationTtl: 86400 });

      return jsonResponse({ msg_id: msgId, status: "stored" });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // POST /mesh/poll — Retrieve messages for recipient
  if (path === "/mesh/poll" && method === "POST") {
    try {
      var body = await request.json();
      var recipient = body.recipient;
      if (!recipient) return jsonResponse({ error: "recipient required" }, 400);

      var inboxKey = "inbox:" + recipient;
      var inboxRaw = await MESH_BUFFER.get(inboxKey);
      var inbox = inboxRaw ? JSON.parse(inboxRaw) : [];

      if (inbox.length === 0) {
        return jsonResponse({ recipient: recipient, messages: [] });
      }

      // Fetch all messages in inbox
      var messages = [];
      for (var i = 0; i < inbox.length; i++) {
        var msgKey = "msg:" + recipient + ":" + inbox[i];
        var msgRaw = await MESH_BUFFER.get(msgKey);
        if (msgRaw) messages.push(JSON.parse(msgRaw));
      }

      return jsonResponse({ recipient: recipient, messages: messages, count: messages.length });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // DELETE /mesh/buffer/:id — Acknowledge and remove message
  if (path.startsWith("/mesh/buffer/") && method === "DELETE") {
    try {
      var parts = path.split("/");
      var msgId = parts[3];
      var recipient = parts[4]; // optional: ?recipient=name

      if (!msgId) return jsonResponse({ error: "msg_id required" }, 400);

      // Get recipient from query param or search all
      var recipient = new URL(request.url).searchParams.get("recipient");
      if (!recipient) return jsonResponse({ error: "recipient query param required" }, 400);

      // Delete the message
      await MESH_BUFFER.delete("msg:" + recipient + ":" + msgId);

      // Remove from inbox index
      var inboxKey = "inbox:" + recipient;
      var inboxRaw = await MESH_BUFFER.get(inboxKey);
      if (inboxRaw) {
        var inbox = JSON.parse(inboxRaw);
        inbox = inbox.filter(function(id) { return id !== msgId; });
        if (inbox.length > 0) {
          await MESH_BUFFER.put(inboxKey, JSON.stringify(inbox), { expirationTtl: 86400 });
        } else {
          await MESH_BUFFER.delete(inboxKey);
        }
      }

      return jsonResponse({ msg_id: msgId, status: "deleted" });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // Health check
  if (path === "/health") {
    return jsonResponse({ ok: true, worker: "offline-sync", kv: "MESH_BUFFER" });
  }

  return jsonResponse({ error: "Not Found", paths: ["/mesh/buffer", "/mesh/poll", "/mesh/buffer/:id", "/health"] }, 404);
}
