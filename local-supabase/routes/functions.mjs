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
import { existsSync, readdirSync, statSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

let _funcCache = null;

// ── Persistent Deno process pool ──────────────────────────────
// Each function gets one long-lived Deno process on a fixed port.
// The process is started on first request and kept alive for reuse.
const denoPool = new Map(); // name -> { proc, port, startTime, lastUsed }

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
  }
  return out;
}
function getFunctions(dir) {
  if (!_funcCache) _funcCache = discoverFunctions(dir);
  return _funcCache;
}

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
  const re = /\b(?:Deno\.)?serve\s*\(/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const openParenIdx = m.index + m[0].length - 1; // index of '(' in src
    // Paren-match on the CLEANED view (strings/comments replaced with spaces)
    // so that parens appearing inside string/template-literal content
    // (e.g. `${expr.foo(bar)}`) don't throw off the depth count.
    let depth = 1;
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
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
      j++;
    }
    if (depth !== 0) continue; // unbalanced, skip
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
Deno.serve({ port }, handler);
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderrBuf = '';
  proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  proc.stdout.on('data', () => {});

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
  let poolEntry;
  try {
    poolEntry = await ensureFunctionProcess(name, funcFile, functionsDir, denoPath);
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
    console.error(e.stack);
    try { res.status(502).json({ error: 'function_proxy_failed', details: e.message }); }
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
