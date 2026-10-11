/**
 * relay/harness-proxy.mjs — loopback reverse proxies for the agent
 * harnesses, so they can be embedded in the Nexus dashboard's aside
 * browser pane.
 *
 * Why this exists: opencode (:4096) and the dsh web harness (:3080) are
 * local UIs with auth quirks that break plain iframes:
 *
 *   - opencode's web UI is actually anonymous (its walled /api/* namespace
 *     is unused by the UI), but it sends CSP default-src 'self' —
 *     framing works only if we don't touch paths, so the proxy mainly
 *     strips frame-blocking headers.
 *   - dsh uses a one-time ?token= that 303s to / and sets a SameSite=Strict
 *     cookie. Inside a cross-site iframe Strict cookies are never sent,
 *     which turns token-follow into an infinite redirect loop. So the proxy
 *     does the token handshake ITSELF at startup and injects the resulting
 *     dsh-auth cookie server-side on every request — the browser never
 *     sees a credential or a redirect.
 *
 *   127.0.0.1:4130 → 127.0.0.1:4096  (opencode)
 *   127.0.0.1:4131 → 127.0.0.1:3080  (dsh)
 *
 * Both pipe WebSocket upgrades (mirroring the /realtime/v1 upgrade proxy
 * in server.js).
 *
 * Loopback note: the proxies listen on 127.0.0.1 deliberately. The harness
 * processes are local; the pane is for operating THIS machine's stack. A
 * viewer on another device has no harness behind their loopback, and the
 * pane's note says so.
 */

import http from 'http';
import net from 'net';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';

// Pull the newest one-time token dsh wrote to its launch log. The launcher
// appends a "dsh web: http://127.0.0.1:3080/?token=..." line per launch, so
// the LAST match in the file is the live one. Cached on mtime.
let __dshTokenCache = { mtimeMs: 0, token: null };
function latestDshToken(logPath) {
  try {
    const st = statSync(logPath);
    if (__dshTokenCache.token && st.mtimeMs === __dshTokenCache.mtimeMs) return __dshTokenCache.token;
    const tail = readFileSync(logPath, 'utf8').slice(-8192);
    const matches = [...tail.matchAll(/token=([A-Za-z0-9_-]+)/g)];
    const token = matches.length ? matches[matches.length - 1][1] : null;
    __dshTokenCache = { mtimeMs: st.mtimeMs, token };
    return token;
  } catch {
    return __dshTokenCache.token;
  }
}

function makeHarnessProxy({ name, listenPort, targetPort, prepare, getInjectedHeaders, onUnauthorized, logger }) {
  const targetHostHeader = `127.0.0.1:${targetPort}`;

  const server = http.createServer(async (req, res) => {
    try {
      // prepare() lets a proxy establish server-side state (dsh's cookie
      // handshake) before the first request goes upstream.
      if (prepare) await prepare();
    } catch { /* a failed prepare is not fatal; the request still goes out */ }

    const injected = getInjectedHeaders ? getInjectedHeaders(req) : {};
    const headers = { ...req.headers, host: targetHostHeader, ...injected };
    delete headers['connection'];

    const up = http.request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers },
      (upRes) => {
        if (upRes.statusCode === 401 && onUnauthorized) onUnauthorized();
        const h = { ...upRes.headers };
        // Frame-blocking headers would blank the iframe; the proxy IS the
        // security boundary here (loopback only, auth injected), so dropping
        // them is safe for this use.
        delete h['content-security-policy'];
        delete h['x-frame-options'];
        // Keep redirects inside the proxy.
        if (typeof h.location === 'string') {
          h.location = h.location
            .replace(`http://${targetHostHeader}`, `http://127.0.0.1:${listenPort}`)
            .replace(`https://${targetHostHeader}`, `http://127.0.0.1:${listenPort}`);
        }
        res.writeHead(upRes.statusCode || 502, h);
        upRes.pipe(res);
      }
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><body style="background:#0d0d14;color:#c0c0d0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">` +
        `<div style="text-align:center;"><div style="font-size:32px;">🔌</div>` +
        `<h2 style="margin:8px 0;">${name} is not reachable</h2>` +
        `<p style="color:#948d9e;">127.0.0.1:${targetPort} refused the connection.<br>The supervisor will restart it, or check the service tile.</p></div></body>`
      );
    });
    req.pipe(up);
  });

  // WebSocket / upgrade piping (same shape as the /realtime/v1 proxy).
  server.on('upgrade', (req, socket, head) => {
    const injected = getInjectedHeaders ? getInjectedHeaders(req) : {};
    const upstream = net.connect(targetPort, '127.0.0.1');
    upstream.on('connect', () => {
      const rn = '\r\n';
      let request = req.method + ' ' + req.url + ' HTTP/1.1' + rn;
      const skip = new Set(['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'host', ...Object.keys(injected).map(k => k.toLowerCase())]);
      for (const h of Object.keys(req.headers)) {
        if (skip.has(h)) continue;
        request += h + ': ' + req.headers[h] + rn;
      }
      for (const [k, v] of Object.entries(injected)) request += k + ': ' + v + rn;
      request += 'Host: ' + targetHostHeader + rn;
      request += 'Connection: Upgrade' + rn;
      request += 'Upgrade: ' + (req.headers['upgrade'] || 'websocket') + rn;
      if (req.headers['sec-websocket-key']) request += 'Sec-WebSocket-Key: ' + req.headers['sec-websocket-key'] + rn;
      request += 'Sec-WebSocket-Version: ' + (req.headers['sec-websocket-version'] || '13') + rn;
      const wsProto = req.headers['sec-websocket-protocol'];
      if (wsProto) request += 'Sec-WebSocket-Protocol: ' + wsProto + rn;
      request += rn;
      upstream.write(request);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => { try { socket.destroy(); } catch {} });
    upstream.on('close', () => { try { socket.end(); } catch {} });
    socket.on('error', () => { try { upstream.destroy(); } catch {} });
    socket.on('close', () => { try { upstream.end(); } catch {} });
  });

  server.on('error', (e) => {
    logger.warn?.(`[harness-proxy] ${name} proxy on :${listenPort} failed to listen: ${e.message}`);
  });
  server.listen(listenPort, '127.0.0.1', () => {
    logger.log?.(`[harness-proxy] ${name}: http://127.0.0.1:${listenPort} → 127.0.0.1:${targetPort}`);
  });
  return server;
}

export function startHarnessProxies({ root, logger = console }) {
  const servers = [];

  // opencode web UI. Verified 2026-10-10: the UI and everything it polls
  // (/config, /session, /event, /provider, /path) are anonymous; only the
  // /api/* namespace is auth-walled and the UI doesn't use it. The proxy
  // therefore injects nothing — it exists to strip frame-blocking headers.
  servers.push(makeHarnessProxy({
    name: 'opencode',
    listenPort: 4130,
    targetPort: 4096,
    logger,
  }));

  // dsh (deepseek harness) web UI. Server-side token handshake:
  //   1. read the latest one-time token from the launch log
  //   2. fetch /?token=<t> ourselves, capture the dsh-auth cookie
  //   3. inject that cookie on every proxied request
  // If upstream still says 401 (dsh restarted, cookie invalidated), drop
  // the cached cookie — the next request re-handshakes.
  const dshLog = join(root, 'dsh', 'dsh-web-harness.log');
  let dshCookie = null;
  let dshHandshakeInFlight = null;

  function ensureDshCookie() {
    if (dshCookie) return Promise.resolve(dshCookie);
    if (dshHandshakeInFlight) return dshHandshakeInFlight;
    const token = latestDshToken(dshLog);
    if (!token) return Promise.resolve(null);
    dshHandshakeInFlight = new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: 3080, path: '/?token=' + token }, (res) => {
        const sc = res.headers['set-cookie'] || [];
        res.resume(); // drain
        const c = sc.find(c => c.startsWith('dsh-auth-'));
        resolve(c ? c.split(';')[0] : null);
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    }).then((cookie) => {
      dshHandshakeInFlight = null;
      if (cookie) {
        dshCookie = cookie;
        logger.log?.('[harness-proxy] dsh: token handshake complete, auth cookie cached');
      }
      return cookie;
    });
    return dshHandshakeInFlight;
  }

  servers.push(makeHarnessProxy({
    name: 'dsh',
    listenPort: 4131,
    targetPort: 3080,
    prepare: ensureDshCookie,
    getInjectedHeaders: (req) => {
      // Client already has a dsh-auth cookie (e.g. opened dsh directly
      // before) — let it win over our cached one.
      if (/dsh-auth-/.test(req.headers.cookie || '')) return {};
      return dshCookie ? { 'Cookie': dshCookie } : {};
    },
    onUnauthorized: () => { dshCookie = null; },
    logger,
  }));

  return servers;
}
