/**
 * Inbox CF Worker — MobileMonero / Party Favor Photo
 * Receives Resend inbound webhooks, stores in-memory, exposes query endpoints.
 *
 * Endpoints:
 *   POST /webhook/resend-inbound        — PFP inbound emails
 *   POST /webhook/resend-mobilemonero   — XMRT inbound emails
 *   GET /inbox/pfp?limit=N&offset=N   — list PFP emails
 *   GET /inbox/mobilemonero?limit=N&offset=N  — list XMRT emails
 *   GET /sent?limit=N&offset=N        — sent emails (placeholder)
 *   GET /inbox/brief                  — counts + latest subject
 *   GET /health                       — alive check
 */

const SHARED_SECRET = "mmx-shared-2026-inbox-v1"; // rotate via CF secret later

// In-memory stores (per-isolate, lost on deploy/restart)
const PFP_INBOX = [];
const XMRT_INBOX = [];
const SENT_EMAILS = [];

function now() {
  return new Date().toISOString();
}

function auth_fail() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" }
  });
}

function check_auth(request) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  return token === SHARED_SECRET;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

function handleWebhook(body, store) {
  // Resend webhook shape (inbound): { from, to, subject, text, html, headers... }
  const record = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    from: body.from || body.senderEmail || "",
    to: body.to || "",
    subject: body.subject || "",
    text: body.text || "",
    html: body.html || "",
    created_at: body.created_at || now(),
    raw: body
  };
  store.unshift(record);
  if (store.length > 5000) store.length = 5000; // cap memory
  return jsonResponse({ ok: true, id: record.id });
}

function listInbox(store, url, max = 50) {
  if (!check_auth) return auth_fail();
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const items = store.slice(offset, offset + limit).map(e => ({
    id: e.id,
    from: e.from,
    to: e.to,
    subject: e.subject,
    created_at: e.created_at
  }));
  return jsonResponse({
    total: store.length,
    limit,
    offset,
    items
  });
}

function brief() {
  const latestPfp = PFP_INBOX[0];
  const latestXmrt = XMRT_INBOX[0];
  return jsonResponse({
    pfp: { count: PFP_INBOX.length, latest_subject: latestPfp ? latestPfp.subject : null },
    mobilemonero: { count: XMRT_INBOX.length, latest_subject: latestXmrt ? latestXmrt.subject : null },
    sent: { count: SENT_EMAILS.length }
  });
}

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const method = request.method;

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
  }

  try {
    // Webhooks (no auth — called by Resend; basic origin check if needed)
    if (method === "POST" && url.pathname === "/webhook/resend-inbound") {
      const body = await request.json().catch(() => ({}));
      return handleWebhook(body, PFP_INBOX);
    }
    if (method === "POST" && url.pathname === "/webhook/resend-mobilemonero") {
      const body = await request.json().catch(() => ({}));
      return handleWebhook(body, XMRT_INBOX);
    }

    // Health
    if (method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "inbox", uptime: "∞", version: "1.0.0" });
    }

    // Brief (public-ish summary, no auth required)
    if (method === "GET" && url.pathname === "/inbox/brief") {
      return brief();
    }

    // Auth-protected reads
    if (!check_auth(request)) return auth_fail();

    if (method === "GET" && (url.pathname === "/inbox/pfp" || url.pathname === "/inbox/pfp/")) {
      return listInbox(PFP_INBOX, url);
    }
    if (method === "GET" && (url.pathname === "/inbox/mobilemonero" || url.pathname === "/inbox/mobilemonero/")) {
      return listInbox(XMRT_INBOX, url);
    }
    if (method === "GET" && (url.pathname === "/sent" || url.pathname === "/sent/")) {
      return listInbox(SENT_EMAILS, url);
    }

    // Add sent-email (POST /sent — relay or agent can call this)
    if (method === "POST" && url.pathname === "/sent") {
      const body = await request.json().catch(() => ({}));
      SENT_EMAILS.unshift({
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        to: body.to || "",
        subject: body.subject || "",
        created_at: now(),
        raw: body
      });
      if (SENT_EMAILS.length > 2500) SENT_EMAILS.length = 2500;
      return jsonResponse({ ok: true, count: SENT_EMAILS.length });
    }

    // Get single email by ID (any inbox)
    if (method === "GET" && url.pathname.startsWith("/inbox/pfp/")) {
      const id = url.pathname.split("/").pop();
      const item = PFP_INBOX.find(e => e.id === id);
      return item ? jsonResponse(item) : jsonResponse({ error: "not found" }, 404);
    }
    if (method === "GET" && url.pathname.startsWith("/inbox/mobilemonero/")) {
      const id = url.pathname.split("/").pop();
      const item = XMRT_INBOX.find(e => e.id === id);
      return item ? jsonResponse(item) : jsonResponse({ error: "not found" }, 404);
    }

    return jsonResponse({ error: "not found" }, 404);

  } catch (e) {
    return jsonResponse({ error: "Server error", detail: String(e) }, 500);
  }
}
