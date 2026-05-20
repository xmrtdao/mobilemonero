/**
 * Hermes Agent Worker — Direct endpoint for fleet interaction
 * hermes.mobilemonero.com
 * Service Worker syntax (ES modules not supported via simple REST upload)
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status) {
  status = status || 200;
  return new Response(JSON.stringify(data), {
    status: status,
    headers: Object.assign({"Content-Type": "application/json"}, CORS_HEADERS),
  });
}

// Simple in-memory stores
var messageLog = [];
var agentHeartbeats = {};
var MAX_MSG = 500;

addEventListener("fetch", function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  var url = new URL(request.url);
  var path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (path === "/health" && request.method === "GET") {
    return json({
      ok: true,
      worker: "hermes-direct",
      ts: Date.now(),
      agents: Object.keys(agentHeartbeats),
      messages: messageLog.length,
    });
  }

  if (path === "/fleet/status" && request.method === "GET") {
    var agentStatus = {};
    for (var a in agentHeartbeats) {
      agentStatus[a] = {
        last_seen: agentHeartbeats[a],
        alive: Date.now() - agentHeartbeats[a] < 300000,
      };
    }
    return json({
      relay: "hermes-direct",
      port: 443,
      agents: agentStatus,
      messages: messageLog.length,
    });
  }

  if (path === "/fleet/broadcast" && request.method === "POST") {
    try {
      var body = await request.json();
      var msg = {
        id: messageLog.length + 1,
        ts: new Date().toISOString(),
        agent: body.agent || "unknown",
        message: body.message || "",
        type: body.type || "broadcast",
      };
      messageLog.push(msg);
      if (messageLog.length > MAX_MSG) messageLog.shift();
      if (body.agent) agentHeartbeats[body.agent] = Date.now();
      return json({ ok: true, logged: true, msg_id: msg.id });
    } catch (e) {
      return json({ error: "Invalid JSON" }, 400);
    }
  }

  if (path === "/fleet/messages" && request.method === "GET") {
    var limit = parseInt(url.searchParams.get("limit")) || 50;
    var offset = parseInt(url.searchParams.get("offset")) || 0;
    var total = messageLog.length;
    var start = Math.max(0, total - limit - offset);
    var end = Math.max(0, total - offset);
    return json({ messages: messageLog.slice(start, end), total: total });
  }

  // AGENT -> HERMES
  if (path === "/to/hermes" && request.method === "POST") {
    try {
      var body = await request.json();
      var msg = {
        id: messageLog.length + 1,
        ts: new Date().toISOString(),
        from: body.agent || body.from || "unknown",
        to: "hermes",
        message: body.message || "",
        type: body.type || "direct",
      };
      messageLog.push(msg);
      if (messageLog.length > MAX_MSG) messageLog.shift();
      if (body.agent) agentHeartbeats[body.agent] = Date.now();
      return json({ ok: true, logged: true, msg_id: msg.id });
    } catch (e) {
      return json({ error: "Invalid JSON" }, 400);
    }
  }

  // HERMES -> AGENT (poll)
  if (path.startsWith("/from/hermes/") && request.method === "GET") {
    var toAgent = path.split("/")[3];
    var limit2 = parseInt(url.searchParams.get("limit")) || 50;
    var out = [];
    for (var i = 0; i < messageLog.length; i++) {
      if (messageLog[i].to === toAgent) out.push(messageLog[i]);
    }
    if (out.length > limit2) out = out.slice(-limit2);
    return json({ messages: out, total: out.length });
  }

  // HERMES -> AGENT (send)
  if (path === "/from/hermes" && request.method === "POST") {
    try {
      var body2 = await request.json();
      var msg2 = {
        id: messageLog.length + 1,
        ts: new Date().toISOString(),
        from: "hermes",
        to: body2.to || body2.agent || "unknown",
        message: body2.message || "",
        type: body2.type || "direct",
      };
      messageLog.push(msg2);
      if (messageLog.length > MAX_MSG) messageLog.shift();
      return json({ ok: true, logged: true, msg_id: msg2.id });
    } catch (e) {
      return json({ error: "Invalid JSON" }, 400);
    }
  }

  if (path === "/fleet/heartbeat" && request.method === "GET") {
    var hbAgent = url.searchParams.get("agent") || "unknown";
    agentHeartbeats[hbAgent] = Date.now();
    return json({
      ok: true,
      agent: hbAgent,
      status: "alive",
      ts: new Date().toISOString(),
      fleet: Object.keys(agentHeartbeats),
    });
  }

  if (path === "/" || path === "") {
    return new Response(
      '<!DOCTYPE html><html><head><title>Hermes</title></head><body style="font-family:monospace;background:#0a0a0f;color:#4ade80;padding:2rem"><h1>hermes.mobilemonero.com</h1><p>Fleet Direct Endpoint</p><pre>GET  /health<br>GET  /fleet/status<br>GET  /fleet/messages?limit=50<br>POST /fleet/broadcast     {agent, message, type}<br>POST /to/hermes           {agent, message, type}   # agent → hermes<br>POST /from/hermes         {to, message, type}      # hermes → agent<br>GET  /from/hermes/:agent                       # poll messages for agent<br>GET  /fleet/heartbeat?agent=vexx</pre></body></html>',
      { status: 200, headers: Object.assign({"Content-Type": "text/html"}, CORS_HEADERS) }
    );
  }

  return json({ error: "Not Found", path: path }, 404);
}
