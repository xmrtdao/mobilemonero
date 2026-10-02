#!/usr/bin/env node
/**
 * ef:warm-pool-lease-manager — Warm Agent Pool lease manager (MVP)
 *
 * Google SAM-inspired pattern: a pool of identical stateless "workers"
 * (here: our existing expensive edge-function/tool capabilities) leased out
 * one job at a time so agents can run parallel batch work instead of the
 * serialized single-shot tool calls we have today.
 *
 * NAMING: MUST be `warm-pool-lease-manager` — NOT `lease-manager`. The Elze
 * Contract Suite owns lease_analyzer / elze-templates / elze-lease-writer
 * (legal real-estate leases, VA Ch 54.1). This is CONCURRENCY leasing (fencing
 * tokens for agent scheduling) — unrelated domain, distinct prefix.
 *
 * MVP design (no Go/libp2p):
 *  - Workers are named capability slots backed by our existing tools
 *    (python-exec, web-scrape, vision, db-query, shell-exec). Each slot runs
 *    one lease at a time; a worker is "busy" while a lease is held.
 *  - Single-threaded synchronous lease acquisition (no double-lease).
 *  - Fencing tokens: each lease gets a short-lived HMAC token; release must
 *    present a matching token or it's rejected (fail-closed). A stale/stolen
 *    token cannot free a newer holder's lease.
 *
 * Actions:
 *   list                 -> pool status: workers, free/busy, held leases
 *   acquire              -> { worker, max_seconds } -> { lease_id, fencing_token, expires_at }
 *   call                 -> { lease_id, fencing_token, tool, args } -> run the tool on the worker, auto-release
 *   release              -> { lease_id, fencing_token } -> free the worker
 *   status               -> { lease_id } -> lease info / heartbeat
 *
 * Returns { success, ... } on OK, or { success:false, error }.
 */

import crypto from 'crypto';

const META = {
  description: 'Warm Agent Pool lease manager. Acquire a fencing-token lease on a warm worker slot (python-exec, web-scrape, vision, db-query, shell-exec) to run parallel batch jobs; acquire -> call -> release. Fencing tokens prevent stale releases. Use for parallel batch work (mining, review, content pipelines).',
  category: 'infra',
  version: '0.1.0',
  author: 'hermes-agent',
  dependencies: [],
};

// ── In-memory pool state ────────────────────────────────────
// Worker slots. Each maps to a real relay tool we can invoke.
const WORKERS = {
  'python-exec': { tool: 'python-exec', max_seconds: 120 },
  'web-scrape':  { tool: 'web-scrape',  max_seconds: 60 },
  'vision':      { tool: 'vex-vision',  max_seconds: 180 },
  'db-query':    { tool: 'db-query',    max_seconds: 30 },
  'shell-exec':  { tool: 'shell-exec',  max_seconds: 120 },
};

// lease_id -> { worker, tool, tokenHash, acquiredAt, expiresAt, agent }
const LEASES = new Map();
// worker -> lease_id currently held (or null)
const workerHolders = new Map(Object.keys(WORKERS).map(w => [w, null]));

const HMAC_SECRET = process.env.WARM_POOL_HMAC_SECRET || 'warm-pool-dev-secret';
const DEFAULT_LEASE_SECONDS = 120;
const MAX_LEASE_SECONDS = 600;

function hmac(value) {
  return crypto.createHmac('sha256', HMAC_SECRET).update(String(value)).digest('hex').slice(0, 32);
}

function issueToken(leaseId, worker, expiresAt) {
  // Short-lived fencing token: HMAC over lease_id + worker + expiry.
  // Expiry bakes into the token so a stale token (past expiry) fails closed.
  return `${leaseId}.${worker}.${expiresAt}.${hmac(`${leaseId}:${worker}:${expiresAt}`)}`;
}

function verifyToken(leaseId, token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 4) return false;
  const [tl, tw, texp, tsig] = parts;
  if (tl !== leaseId) return false;
  const expected = hmac(`${tl}:${tw}:${texp}`);
  if (tsig !== expected) return false; // tampered / wrong secret
  if (Number(texp) < Date.now()) return false; // expired -> fail closed
  return { worker: tw };
}

function freeWorker(worker, leaseId) {
  if (workerHolders.get(worker) === leaseId) workerHolders.set(worker, null);
}

// ── Helpers to invoke a worker tool on the relay ────────────
// The edge function runs INSIDE the relay (relay/functions/*.mjs), so we can
// call the tool handler directly via the relay's /tools/run route (async,
// no deadlock — the relay is already running us).
async function callRelayTool(tool, args, agent) {
  const base = `http://127.0.0.1:${process.env.PORT || 8080}`;
  const res = await fetch(`${base}/tools/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-id': agent || 'hermes' },
    body: JSON.stringify({ tool, args: { ...args, _agent: { id: agent || 'hermes' } } }),
    signal: AbortSignal.timeout((args?.timeout || 30) * 1000 + 5000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`tool ${tool} returned ${res.status}: ${txt.slice(0, 200)}`);
  }
  return await res.json();
}

// ── Actions ─────────────────────────────────────────────────
function actionList() {
  const workers = Object.entries(WORKERS).map(([name, cfg]) => ({
    name,
    tool: cfg.tool,
    status: workerHolders.get(name) ? 'busy' : 'free',
    heldLeaseId: workerHolders.get(name),
  }));
  return {
    success: true,
    pool: {
      total: workers.length,
      free: workers.filter(w => w.status === 'free').length,
      busy: workers.filter(w => w.status === 'busy').length,
    },
    workers,
    leases: Array.from(LEASES.values()).map(l => ({
      lease_id: l.leaseId, worker: l.worker, agent: l.agent,
      acquired_at: l.acquiredAt, expires_at: l.expiresAt,
    })),
  };
}

function actionAcquire(args) {
  const worker = args?.worker;
  if (!worker || !WORKERS[worker]) {
    return { success: false, error: `unknown worker '${worker}'. Available: ${Object.keys(WORKERS).join(', ')}` };
  }
  if (workerHolders.get(worker)) {
    return { success: false, error: `worker '${worker}' is busy (lease ${workerHolders.get(worker)})` };
  }
  const cfg = WORKERS[worker];
  const maxSeconds = Math.min(parseInt(args?.max_seconds) || DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS);
  const leaseId = `wpl-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const acquiredAt = Date.now();
  const expiresAt = acquiredAt + maxSeconds * 1000;

  workerHolders.set(worker, leaseId);
  LEASES.set(leaseId, {
    leaseId, worker, tool: cfg.tool, agent: args?.agent || args?._agent?.id || 'unknown',
    acquiredAt, expiresAt, tokenHash: null,
  });

  const fencingToken = issueToken(leaseId, worker, expiresAt);
  return {
    success: true,
    lease_id: leaseId,
    worker,
    tool: cfg.tool,
    fencing_token: fencingToken,
    acquired_at: acquiredAt,
    expires_at: expiresAt,
    max_seconds: maxSeconds,
  };
}

async function actionCall(args) {
  const { lease_id, fencing_token, tool, agent_args, agent } = args;
  const lease = LEASES.get(lease_id);
  if (!lease) return { success: false, error: 'unknown lease_id (expired or never issued)' };
  const verified = verifyToken(lease_id, fencing_token);
  if (!verified) return { success: false, error: 'invalid or expired fencing token (fail-closed). Release/reacquire.' };
  if (Date.now() > lease.expiresAt) {
    // Lease expired -> free worker, reject call.
    freeWorker(lease.worker, lease_id);
    LEASES.delete(lease_id);
    return { success: false, error: 'lease expired' };
  }
  // The lease's worker defines the tool; caller may override tool name if it
  // maps to the same worker capability, but default to the worker's tool.
  const workerTool = lease.tool;
  const effectiveTool = tool || workerTool;
  try {
    const result = await callRelayTool(effectiveTool, agent_args || {}, agent || lease.agent);
    // Auto-release after the call (one-shot job pattern).
    freeWorker(lease.worker, lease_id);
    LEASES.delete(lease_id);
    return { success: true, lease_id, worker: lease.worker, released: true, result };
  } catch (err) {
    freeWorker(lease.worker, lease_id);
    LEASES.delete(lease_id);
    return { success: false, lease_id, worker: lease.worker, released: true, error: err.message };
  }
}

function actionRelease(args) {
  const { lease_id, fencing_token } = args;
  const lease = LEASES.get(lease_id);
  if (!lease) return { success: false, error: 'unknown lease_id' };
  const verified = verifyToken(lease_id, fencing_token);
  if (!verified) {
    return { success: false, error: 'invalid fencing token — release rejected (fail-closed)' };
  }
  freeWorker(lease.worker, lease_id);
  LEASES.delete(lease_id);
  return { success: true, lease_id, worker: lease.worker, released: true };
}

function actionStatus(args) {
  const { lease_id } = args;
  const lease = LEASES.get(lease_id);
  if (!lease) return { success: false, error: 'unknown lease_id' };
  const expired = Date.now() > lease.expiresAt;
  return {
    success: true,
    lease_id,
    worker: lease.worker,
    tool: lease.tool,
    agent: lease.agent,
    acquired_at: lease.acquiredAt,
    expires_at: lease.expiresAt,
    expired,
    seconds_left: Math.max(0, Math.floor((lease.expiresAt - Date.now()) / 1000)),
  };
}

// ── Handler (dual-mode: relay Express (req,res) or direct (args)) ──
export async function handler(reqOrArgs, res) {
  let args;
  if (res) {
    try { args = reqOrArgs?.body || {}; } catch { args = {}; }
  } else {
    args = reqOrArgs || {};
  }
  const action = args?.action || 'list';
  let result;
  try {
    switch (action) {
      case 'list': result = actionList(); break;
      case 'acquire': result = actionAcquire(args); break;
      case 'call': result = await actionCall(args); break;
      case 'release': result = actionRelease(args); break;
      case 'status': result = actionStatus(args); break;
      default: result = { success: false, error: `unknown action '${action}'` };
    }
  } catch (err) {
    result = { success: false, error: err.message };
  }
  if (res) return res.json(result);
  return result;
}

export { META };

/* ── CLI execution ─────────────────────────────────────────── */
if (process.argv[1] && (process.argv[1].includes('warm-pool-lease-manager') || process.argv[1].includes('_local_shim'))) {
  const args = { action: 'list' };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = process.argv[i + 1];
      if (val && !val.startsWith('--')) { args[key] = val; i++; } else { args[key] = true; }
    }
  }
  handler(args).then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); });
}
