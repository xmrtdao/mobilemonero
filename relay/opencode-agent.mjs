#!/usr/bin/env node
/**
 * OpenCode Agent Daemon
 *
 * Polls agent-inbox/opencode/ for queued prompts, executes them with the
 * OpenCode server, and writes results to agent-outbox/opencode/.
 *
 * WHY IT USES HTTP AND NOT THE CLI
 * --------------------------------
 * This used to spawn `opencode run --model <model> --auto --format json`.
 * That never answered: the CLI starts its own background service, the server
 * the fleet actually runs is a different one, and the two disagreed about the
 * password - so the CLI either refused the connection or waited on a service
 * that was not the one doing the work.
 *
 * The server is reachable over HTTP, and the loopback proxy injects its
 * credential, so this path carries no secret and cannot drift out of step
 * with the server the way a second, separately-authenticated client did.
 *
 * The proxy is the same one the operator's dashboard opencode button points
 * at, so the fleet and the operator use one harness and one way in.
 */

import { startAgentDaemon } from './lib/agent-bridge.mjs';
import { acquireOpencodeLock } from './lib/opencode-lock.mjs';
import { runOpencodePrompt } from './lib/opencode-runner.mjs';
import { join } from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// The lock that keeps one agent at a time on this machine. The harness is a
// node process with a tool-calling loop, and this box has 8GB with most of
// it already in use. The board is the queue; this is what makes "one at a
// time" true of everything that reaches the harness.
const LOCK_PATH = process.env.OPENCODE_LOCK_PATH || join(ROOT, 'relay-data', 'opencode.lock');
// Someone is WAITING for the answer here, so this one holds its place for a
// while rather than standing down. The executor, which has a queue of tasks
// behind it, does not wait - it takes the next task next cycle.
const LOCK_WAIT_MS = Number(process.env.OPENCODE_AGENT_LOCK_WAIT_MS || 90_000);

// The loopback proxy. It injects the server's credential for requests that
// arrive without one, so nothing here has to know a password.
const BASE = (process.env.OPENCODE_PROXY_URL || 'http://127.0.0.1:4130').replace(/\/$/, '');

// Left empty on purpose: the server picks the model, and what it picks
// (ollama-cloud/minimax-m3.1-flash) is free and answers in seconds. Forcing
// opencode-go's slug here asks for a subscription this account does not have,
// and the worker comes back empty.
const MODEL = process.env.OPENCODE_AGENT_MODEL || '';

const MAX_WAIT_MS = Number(process.env.OPENCODE_AGENT_TIMEOUT_MS || 5 * 60 * 1000);

// A health endpoint, so the supervisor can tell "running" from "running and
// broken". A daemon with no way to be checked is a daemon that is either
// restarted for no reason or left broken for no reason.
const HEALTH_PORT = Number(process.env.OPENCODE_AGENT_PORT || 9335);

let inFlight = 0;
let lastPromptAt = null;
let lastError = null;

async function api(method, path, body, timeoutMs = 120000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const txt = await r.text();
    if (!r.ok) return null;
    try { return JSON.parse(txt); } catch { return null; }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function executePrompt(entry) {
  const prompt = entry.prompt;
  console.log(`[opencode-agent] executing prompt ${entry.id} (${prompt.length} chars)`);
  inFlight++;
  lastPromptAt = new Date().toISOString();
  lastError = null;
  try {
    return await runPrompt(prompt);
  } catch (e) {
    lastError = e?.message || String(e);
    throw e;
  } finally {
    inFlight--;
  }
}

async function runPrompt(prompt) {
  // Take the harness, or wait for it. One agent at a time, and the wait is
  // bounded so a stuck holder cannot hold this agent forever.
  const deadline = Date.now() + LOCK_WAIT_MS;
  let lock = null;
  for (;;) {
    lock = acquireOpencodeLock(LOCK_PATH, { label: 'inbox-daemon' });
    if (lock.ok) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `the OpenCode harness is in use by ${lock.heldBy} and only one agent may use it `
        + `at a time - I will take this again shortly`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  try {
    return await runPromptLocked(prompt);
  } finally {
    lock.release();
  }
}

async function runPromptLocked(prompt) {
  const r = await runOpencodePrompt(prompt, {
    base: BASE,
    model: MODEL,
    timeoutMs: MAX_WAIT_MS,
  });
  return [r.text, r.tools.length ? `Tools used: ${r.tools.join('; ')}` : '']
    .filter(Boolean).join('\n').trim();
}

startAgentDaemon({
  agent: 'opencode',
  handler: executePrompt,
  pollMs: 3000,
  maxConcurrent: 1,
});

// The health endpoint. Loopback only, like the other control surfaces.
http.createServer((req, res) => {
  if (req.url === '/health') {
    const body = JSON.stringify({
      ok: true,
      agent: 'opencode',
      base: BASE,
      inFlight,
      lastPromptAt,
      lastError,
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}).listen(HEALTH_PORT, '127.0.0.1', () => {
  console.log(`[opencode-agent] health on http://127.0.0.1:${HEALTH_PORT}/health`);
});
