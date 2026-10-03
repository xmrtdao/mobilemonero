// ──────────────────────────────────────────────────────────────
// /functions/v1/<name> — edge function runner
//
// Each Supabase edge function in suite/supabase/functions/<name>/
// is an index.ts file that calls `serve((req) => ...)` or
// `Deno.serve((req) => ...)` at the top level. We need to capture
// the handler without starting a server (we want to start it on
// our own port).
//
// Approach: we read the function source, find the top-level
// `serve(` or `Deno.serve(` call, extract the handler argument
// using balanced-paren matching, and rewrite the source so the
// call becomes an assignment to `globalThis.__h`. We import the
// transformed source and serve the captured handler.
//
// If a function file doesn't exist locally, return a stub
// response so the suite's UI doesn't break for missing functions.
// ──────────────────────────────────────────────────────────────

import { Router } from 'express';
import { spawn } from 'child_process';
import { existsSync, readdirSync, statSync, writeFileSync, unlinkSync, readFileSync, mkdirSync, createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

let _funcCache = null;

// Connection-scoped headers that must not be forwarded to the upstream Deno
// process. undici's fetch throws UND_ERR_NOT_SUPPORTED on several of these
// (notably `expect`), so leaving them in turns any client that sends them into
// a 502 "fetch failed".
const HOP_BY_HOP_HEADERS = new Set([
  'expect',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// ── Persistent Deno process pool ──────────────────────────────
// Each function gets one long-lived Deno process on a fixed port.
// The process is started on first request and kept alive for reuse.
const denoPool = new Map(); // name -> { proc, port, startTime, lastUsed }

// ── Per-function startup mutex ────────────────────────────────
// Concurrent requests for the same function all see the pooled process as
// "not healthy yet" during startup and each try to kill+respawn on the same
// fixed port → port-conflict churn, "pooled process dead, restarting" spam,
// timeouts, and memory drain (the dashboard crash trigger). This map holds an
// in-flight startup promise per function so only ONE process is ever spawned
// for a given function at a time; the rest await the same promise.
const functionStarting = new Map(); // name -> Promise<entry>

// Wrap the actual spawn (ensureFunctionProcess body) with a per-function mutex.
// Returns the shared pool entry for concurrent callers.
async function ensureFunctionProcessMutex(name, funcFile, functionsDir, denoPath) {
  const inFlight = functionStarting.get(name);
  if (inFlight) {
    // A startup is already in progress for this function — wait for it.
    try { return await inFlight; } catch { /* failed spawn; fall through to retry */ }
  }
  const p = ensureFunctionProcess(name, funcFile, functionsDir, denoPath)
    .finally(() => { functionStarting.delete(name); });
  functionStarting.set(name, p);
  return await p;
}


// ── Idle process reaper ──────────────────────────────────────
// Kill pooled Deno processes that haven't been called in IDLE_TIMEOUT_MS.
// Hot functions (frequently used) are exempt and stay alive forever.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes idle -> kill
const REAPER_INTERVAL_MS = 60 * 1000;    // check every 60 seconds
const HOT_FUNCTIONS = new Set([
  'ai-chat', 'system-status', 'eliza-relay', 'system-diagnostics',
  'eliza-ping', 'agent-manager', 'knowledge-manager', 'task-orchestrator',
  'cron-proxy', 'mining-proxy'
]);

function startIdleReaper() {
  setInterval(() => {
    const now = Date.now();
    for (const [name, entry] of denoPool) {
      if (HOT_FUNCTIONS.has(name)) continue;
      const idleMs = now - (entry.lastUsed || entry.startTime || now);
      if (idleMs > IDLE_TIMEOUT_MS) {
        console.log(`[functions] ${name}: idle for ${Math.round(idleMs/1000)}s, reaping (port ${entry.port})`);
        killPoolEntry(name);
      }
    }
  }, REAPER_INTERVAL_MS);
  console.log(`[functions] idle reaper started (timeout: ${IDLE_TIMEOUT_MS/1000}s, interval: ${REAPER_INTERVAL_MS/1000}s, hot: ${HOT_FUNCTIONS.size} exempt)`);
}

// Derive a stable port from the function name (37000-37999 range)
function functionPort(name) {
  const hash = createHash('md5').update(name).digest('hex');
  return 37000 + (parseInt(hash.slice(0, 4), 16) % 1000);
}

// Health-check a running Deno process
async function isProcessHealthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/_health`, { method: 'GET', signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

// Kill and remove a pooled process
function killPoolEntry(name) {
  const entry = denoPool.get(name);
  if (!entry) return;
  try { entry.proc.kill(); } catch {}
  denoPool.delete(name);
  console.log(`[functions] ${name}: killed pooled process (port ${entry.port})`);
}
function discoverFunctions(dir) {
  if (!existsSync(dir)) return {};
  const out = {};
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, 'index.ts'))) out[name] = join(p, 'index.ts');
    else if (existsSync(join(p, 'index.js'))) out[name] = join(p, 'index.js');
    else if (existsSync(join(p, 'mod.ts'))) out[name] = join(p, 'mod.ts');
    else if (existsSync(join(p, 'mod.js'))) out[name] = join(p, 'mod.js');
  }
  return out;
}
function getFunctions(dir) {
  if (!_funcCache) _funcCache = discoverFunctions(dir);
  return _funcCache;
}
// Clear cache on file changes (called after each request to pick up new .ts files)
function clearFunctionCache() { _funcCache = null; }

// Extract the top-level serve() handler from function source.
// Returns the handler text (the function expression inside serve(...))
// or null if no top-level serve call is found.
function extractServeHandler(src) {
  // Strip comments and strings to find call positions safely
  let i = 0;
  let inStr = null;
  const cleanChars = new Array(src.length).fill(false); // true = inside string/comment
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      cleanChars[i] = true;
      if (c === '\\') { cleanChars[i + 1] = true; i += 2; continue; }
      if (c === inStr) inStr = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cleanChars[i] = true; i++; continue; }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { cleanChars[i] = true; i++; }
      continue;
    }
    if (c === '/' && n === '*') {
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) { cleanChars[i] = true; i++; }
      cleanChars[i] = true; cleanChars[i + 1] = true; i += 2; continue;
    }
    i++;
  }
  // Build a "cleaned" view for regex matching
  let cleaned = '';
  for (let k = 0; k < src.length; k++) cleaned += cleanChars[k] ? ' ' : src[k];

  // Find all top-level "serve(" or "Deno.serve("
  // Skip matches that are inside import statements
  const re = /\b(?:Deno\.)?serve\s*\(/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    // Skip if this serve() is inside an import statement (check the match's own line)
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const lineEnd = src.indexOf('\n', m.index);
    const thisLine = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);
    if (/\bimport\b/.test(thisLine)) continue;
    
    const openParenIdx = m.index + m[0].length - 1; // index of '(' in src
    // Paren-match on the CLEANED view (strings/comments replaced with spaces)
    // so that parens appearing inside string/template-literal content
    // (e.g. `${expr.foo(bar)}`) don't throw off the depth count.
    // Track BOTH paren depth and brace depth — we only count parens at
    // the top brace level, so nested parens inside function bodies don't
    // cause early termination.
    let parenDepth = 1;
    let braceDepth = 0;
    let j = openParenIdx + 1;
    let inS = null;
    while (j < cleaned.length) {
      const c = cleaned[j];
      if (inS) {
        if (c === '\\') { j += 2; continue; }
        if (c === inS) inS = null;
        j++; continue;
      }
      if (c === '"' || c === "'" || c === '`') { inS = c; j++; continue; }
      if (c === '{') braceDepth++;
      else if (c === '}') braceDepth--;
      else if (c === '(' && braceDepth === 0) parenDepth++;
      else if (c === ')' && braceDepth === 0) {
        parenDepth--;
        if (parenDepth === 0) break;
      }
      j++;
    }
    if (parenDepth !== 0) continue; // unbalanced, skip
    // Slice the handler from RAW src using the position we found in cleaned
    // (cleaned and src are 1:1 in length since cleanChars keeps whitespace).
    const handlerText = src.slice(openParenIdx + 1, j);
    return { handlerText, callStart: m.index, callEnd: j + 1 };
  }
  return null;
}

// ── Start a persistent Deno process for a function ────────────
async function ensureFunctionProcess(name, funcFile, functionsDir, denoPath) {
  // Check pool first
  const existing = denoPool.get(name);
  if (existing) {
    const healthy = await isProcessHealthy(existing.port);
    if (healthy) {
      existing.lastUsed = Date.now();
      return existing;
    }
    // Process died — clean up and restart
    console.log(`[functions] ${name}: pooled process dead, restarting`);
    killPoolEntry(name);
  }

  const port = functionPort(name);
  const src = readFileSync(funcFile, 'utf8');
  const extracted = extractServeHandler(src);
  if (!extracted) {
    // Debug: log the first 200 chars of the source to see what's being parsed
    console.log(`[functions] ${name}: extractServeHandler failed. Source preview:`, src.slice(0, 200).replace(/\n/g, '\\n'));
    throw new Error(`Function ${name} has no top-level serve() call`);
  }

  const transformedSrc = src.slice(0, extracted.callStart) +
    `globalThis.__h = (${extracted.handlerText})` +
    src.slice(extracted.callEnd);

  const funcDir = dirname(funcFile);
  const shimPath = join(funcDir, '._local_shim.ts');
  const transformedPath = join(funcDir, '._local_transformed.ts');
  try { unlinkSync(shimPath); } catch {}
  try { unlinkSync(transformedPath); } catch {}
  writeFileSync(transformedPath, transformedSrc, 'utf8');

  // Build file:/// URL for Deno import (Windows needs the full file:///C:/... form)
  const transformedUrl = 'file:///' + transformedPath.replace(/\\/g, '/');
  const shim = `// Auto-generated shim — do not edit
globalThis.__h = null;
await import("${transformedUrl}");
const handler = globalThis.__h;
try { await Deno.remove("${transformedUrl}"); } catch {}
if (typeof handler !== "function") {
  console.error("shim: no handler captured from ${name}");
  Deno.exit(2);
}
const port = ${port};
console.log("shim: serving ${name} on port " + port);
// Intercept the pool's health probe (/_health) and answer immediately with an
// empty 200 — WITHOUT invoking the function handler. The local-sb pool calls
// GET /_health to decide if a pooled process is alive; heavy functions like
// ai-chat treat it as a real request and run DB queries that hang under load,
// so the pool falsely declares them dead, SIGTERM-kills them, and respawns on
// the same port -> the "0ms startup" + "pooled process dead, restarting"
// crash loop. Short-circuiting here stops the kill-loop for ALL functions.
const wrapped = (req) => {
  try {
    if (req && req.method === 'GET') {
      const u = new URL(req.url);
      if (u.pathname === '/_health' || u.pathname === '/_ping') {
        return new Response('{"status":"ok"}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
  } catch {}
  return handler(req);
};
Deno.serve({ port }, wrapped);
`;
  writeFileSync(shimPath, shim, 'utf8');

  const localSupabaseUrl = `http://127.0.0.1:${process.env.LOCAL_SUPABASE_PORT || 54321}`;
    // Use real service role key from env, fall back to placeholder
    const localServiceKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || 'eyJhbG...MMpM';
    const proc = spawn(denoPath, [
      'run',
      '--no-config',
      '--no-check',
      '--allow-net', '--allow-read', '--allow-write', '--allow-env', '--allow-run', '--allow-sys',
      '--allow-import',
      shimPath,
    ], {
      cwd: funcDir,
      env: {
        ...process.env,
        DENO_DIR: join(functionsDir, '..', '.deno_cache'),
        SUPABASE_URL: localSupabaseUrl,
        NEXT_PUBLIC_SUPABASE_URL: localSupabaseUrl,
        SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'local-anon-key',
        SUPABASE_SERVICE_ROLE_KEY: localServiceKey,
        SUPABASE_DB_URL: process.env.LOCAL_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
        // Pass Ollama API keys to edge functions
        OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || '',
        OLLAMA_XMRT_API_KEY: process.env.OLLAMA_XMRT_API_KEY || '',
        OLLAMA_3RD_API_KEY: process.env.OLLAMA_3RD_API_KEY || '',
        OLLAMA_HERMES_API_KEY: process.env.OLLAMA_HERMES_API_KEY || '',
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
        // OpenCode Zen — tier 1 of the edge-function AI cascade
        OPENCODE_API_KEY: process.env.OPENCODE_API_KEY || '',
        OPENCODE_BASE_URL: process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/v1',
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'minimax/minimax-m3:free',
        OLLAMA_LOCAL_MODEL: process.env.OLLAMA_LOCAL_MODEL || 'gemma3:1b',
        LOCAL_OLLAMA_ONLY: process.env.LOCAL_OLLAMA_ONLY || '',
        AI_CHAT_DEBUG_LOG: process.env.AI_CHAT_DEBUG_LOG || '',
        RELAY_BASE_URL: process.env.RELAY_BASE_URL || 'http://127.0.0.1:8080',
        SUPABASE_LOCAL_URL: localSupabaseUrl,
        SUPABASE_LOCAL_ANON: process.env.SUPABASE_ANON_KEY || 'local-anon-key',
        PARAGRAPH_API_KEY: process.env.PARAGRAPH_API_KEY || '',
        PARAGRAPH_PUBLICATION: process.env.PARAGRAPH_PUBLICATION || '',
        PARAGRAPH_COIN_SYMBOL: process.env.PARAGRAPH_COIN_SYMBOL || '',
        PARAGRAPH_DEFAULT_AUTHOR: process.env.PARAGRAPH_DEFAULT_AUTHOR || '',
        PARAGRAPH_PUBLICATION_HANDLE: process.env.PARAGRAPH_PUBLICATION_HANDLE || '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

  let stderrBuf = '';
  proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  // Deno stdout used to be discarded entirely, which made edge-function
  // internals (ai-chat's provider routing, tool counts, iteration counts)
  // completely invisible. ai-chat takes 90s+ per request, and the only way to
  // find out WHY was to add ad-hoc DB writes. Tee the child's stdout to a
  // per-function log file, with a size cap so it can't grow unbounded.
  // functionsDir is <repo>/suite/supabase/functions, so the repo root is three
  // levels up. Keep these next to relay.log / local-sb.log rather than in
  // suite/logs, which is the DB manager's own log directory.
  const fnLogPath = join(functionsDir, '..', '..', '..', 'logs', `function-${name}.log`);
  let fnLogStream = null;
  try {
    mkdirSync(dirname(fnLogPath), { recursive: true });
    // Rotate at 5 MB so a chatty function can't fill the disk.
    try {
      if (existsSync(fnLogPath) && statSync(fnLogPath).size > 5 * 1024 * 1024) {
        writeFileSync(fnLogPath, '');
      }
    } catch {}
    fnLogStream = createWriteStream(fnLogPath, { flags: 'a' });
  } catch {
    fnLogStream = null; // Logging is best-effort; never block a spawn on it.
  }
  if (fnLogStream) {
    proc.stdout.on('data', (d) => {
      try { fnLogStream.write(d); } catch {}
    });
  } else {
    proc.stdout.on('data', () => {});
  }
  // Log WHY a pooled process died (health-check kills or crashes). Without
  // this, a process that starts OK then dies under load leaves no trace —
  // the dashboard crash signature ("0ms startup" + "proxy error: fetch
  // failed") was impossible to root-cause before this.
  proc.on('exit', (code, signal) => {
    console.log(`[functions] ${name}: pooled process EXITED code=${code} signal=${signal}`);
    if (fnLogStream) { try { fnLogStream.end(); } catch {} }
    if (stderrBuf.trim()) {
      console.log(`[functions] ${name} STDERR (last 1200):\n${stderrBuf.slice(-1200)}`);
    }
  });

  const ready = await waitForPort(port, 60000);
  if (!ready) {
    try { proc.kill(); } catch {}
    try { unlinkSync(shimPath); } catch {}
    try { unlinkSync(transformedPath); } catch {}
    throw new Error(`Deno failed to start for ${name}: ${stderrBuf.slice(0, 500)}`);
  }

  const entry = { proc, port, startTime: Date.now(), lastUsed: Date.now() };
  denoPool.set(name, entry);
  console.log(`[functions] ${name}: started persistent process on port ${port} (${Date.now() - entry.startTime}ms)`);

  // Clean up shim files after successful start
  try { unlinkSync(shimPath); } catch {}
  try { unlinkSync(transformedPath); } catch {}

  return entry;
}

async function handleFunctionCall(req, res, { functionsDir, denoPath }) {
  const name = req.params.name;
  // Clear cache each time to pick up new .ts files (cache was stale when .js was replaced with .ts)
  clearFunctionCache();
  const funcs = getFunctions(functionsDir);
  const funcFile = funcs[name];

  if (!funcFile) {
    console.log(`[functions] ${name}: not found locally, returning stub`);
    return res.json({
      stub: true,
      function: name,
      message: 'Edge function not implemented in local stack. Add to suite/supabase/functions/' + name + '/index.ts',
      received: { method: req.method, query: req.query, body: req.body },
    });
  }

  if (!existsSync(denoPath)) {
    return res.status(503).json({ error: 'deno_not_found', denoPath });
  }

  // Get or start the persistent Deno process
  // Use the per-function mutex so concurrent requests don't each spawn a
  // duplicate Deno process on the same fixed port (the crash trigger).
  let poolEntry;
  try {
    poolEntry = await ensureFunctionProcessMutex(name, funcFile, functionsDir, denoPath);
  } catch (e) {
    console.error(`[functions] ${name}: ${e.message}`);
    return res.status(502).json({ error: 'function_start_failed', details: e.message });
  }

  const { port } = poolEntry;

  // Forward the request
  const targetUrl = `http://127.0.0.1:${port}${req.originalUrl}`;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  // Strip hop-by-hop and framing headers. undici's fetch REJECTS several of
  // these outright rather than ignoring them: an inbound `Expect: 100-continue`
  // made every edge function fail with "UND_ERR_NOT_SUPPORTED: expect header
  // not supported", which surfaced as an opaque 502 "fetch failed" for all of
  // ai-chat, paragraph-publisher, xmrt-university, etc. Only delete host and
  // content-length was ever handled, so the rest were passed straight through.
  for (const h of Object.keys(headers)) {
    const lh = h.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lh) || lh.startsWith('proxy-')) delete headers[h];
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined :
        (Buffer.isBuffer(req.body) ? req.body :
          typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})),
      redirect: 'manual',
    });
    res.status(upstream.status);
    const buf = Buffer.from(await upstream.arrayBuffer());
    for (const [k, v] of upstream.headers) {
      const lk = k.toLowerCase();
      if (['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(lk)) continue;
      res.setHeader(k, v);
    }
    if (buf.length > 0) res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Connection', 'close');
    req.socket.setKeepAlive(false);
    res.end(buf);
  } catch (e) {
    console.error(`[functions] ${name} proxy error:`, e.message);
    // undici puts the real transport-level reason in `cause` (ECONNREFUSED,
    // ECONNRESET, UND_ERR_SOCKET, invalid header value, ...). Without it every
    // failure collapses to the same useless "fetch failed" string.
    if (e.cause) {
      console.error(`[functions] ${name} proxy cause:`, e.cause.code || '', e.cause.message || e.cause);
    }
    console.error(`[functions] ${name} proxy target:`, targetUrl);
    console.error(e.stack);
    try { res.status(502).json({ error: 'function_proxy_failed', details: e.message, cause: e.cause?.code || e.cause?.message || null }); }
    catch { /* already sent */ }
  }
}

export default function makeFunctionsRouter({ functionsDir, denoPath }) {
  const router = Router();
  startIdleReaper();

  // GET /functions/v1 — list
  router.get('/', (_req, res) => {
    const funcs = getFunctions(functionsDir);
    res.json({ count: Object.keys(funcs).length, functions: Object.keys(funcs) });
  });

  router.all('/:name', async (req, res) => {
    try {
      await handleFunctionCall(req, res, { functionsDir, denoPath });
    } catch (e) {
      console.error(`[functions] outer error for ${req.params.name}:`, e.message);
      console.error(e.stack);
      try { res.status(500).json({ error: 'function_handler_error', details: e.message }); }
      catch { /* already sent */ }
    }
  });

  // Tolerant variant: /functions/v1/<name>/<sub>  (e.g. gossip-hub/history)
  // Strips the subpath and forwards to the same function, so functions that
  // expect a sub-route still get invoked at their root handler.
  router.all('/:name/:sub', async (req, res) => {
    try {
      // Re-stitch the URL without the subpath so the function sees a normal
      // request to /functions/v1/<name> with the original query string.
      const originalUrl = req.originalUrl;
      const subIdx = originalUrl.indexOf(`/${req.params.sub}`);
      const trimmed = subIdx > 0 ? originalUrl.slice(0, subIdx) : originalUrl;
      req.originalUrl = trimmed;
      req.url = trimmed;
      await handleFunctionCall(req, res, { functionsDir, denoPath });
    } catch (e) {
      console.error(`[functions] outer error for ${req.params.name}/${req.params.sub}:`, e.message);
      console.error(e.stack);
      try { res.status(500).json({ error: 'function_handler_error', details: e.message }); }
      catch { /* already sent */ }
    }
  });

  return router;
}

async function waitForPort(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/_health`, { method: 'GET' });
      return true;  // any response = ready
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
