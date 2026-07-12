#!/usr/bin/env node
/**
 * relay/cron-engine-v2.mjs — Local cron job executor
 *
 * Replaces cron-engine.mjs (which used `psql -U postgres` and
 * `cmd.exe` spawns that hung waiting for a password). The old
 * engine referenced a non-existent `pg/bin/` path; this v2
 * connects to the embedded PG via the `pg` npm client using
 * the same connection string as the rest of the system:
 *
 *   postgres://postgres:postgres@localhost:5432/postgres
 *
 * It also uses the local edge function runtime at port 8090
 * (suite/runtime/manager.mjs) for "edge function" cron jobs
 * instead of proxying to the dead Supabase.
 *
 * Run with --once to execute due jobs once and exit, or as a
 * daemon that polls every 30s.
 */

import pg from 'pg';
const { Client } = pg;
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'relay-data');
const LOG_FILE = join(DATA_DIR, 'cron-engine-v2.log');
const STATE_FILE = join(DATA_DIR, 'cron-engine-v2-state.json');

// ── Text Sanitization ──────────────────────────────────────────
function sanitizeText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\uFFFD/g, '-')
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u2022/g, '*')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'relay-data');
const LOG_FILE = join(DATA_DIR, 'cron-engine-v2.log');
const STATE_FILE = join(DATA_DIR, 'cron-engine-v2-state.json');
mkdirSync(DATA_DIR, { recursive: true });

// Prefer LOCAL_DATABASE_URL (the convention used in relay/.env) over
// DATABASE_URL. The default fallback pointed at the empty `postgres`
// database, which caused every cron tick to log
// "relation/function/schema does not exist" even when the objects
// existed in xmrt_suite. Accept either env var to avoid breaking
// environments that only set DATABASE_URL.
const PG_URL = process.env.LOCAL_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';
// 2026-06-10: Default to local-sb (54321) instead of suite/runtime/manager.mjs
// (8090). The 8090 runtime is not running in the current local stack; local-sb
// on 54321 is the actual edge function host. Override with LOCAL_RUNTIME_URL
// env var if the suite runtime comes back.
const RUNTIME_URL = process.env.LOCAL_RUNTIME_URL || 'http://127.0.0.1:54321';

function log(msg, level = 'INFO') {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + '\n', { flag: 'a' }); } catch {}
}

function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { error: `Invalid cron: ${expr}` };
  const now = new Date();
  const minute = now.getMinutes();
  const hour = now.getHours();
  const day = now.getDate();
  const month = now.getMonth() + 1;
  const dow = now.getDay();
  const match = (field, value) => {
    if (field === '*') return true;
    if (field.startsWith('*/')) return value % parseInt(field.slice(2)) === 0;
    if (field.includes(',')) return field.split(',').map(Number).includes(value);
    if (field.includes('-')) {
      const [lo, hi] = field.split('-').map(Number);
      return value >= lo && value <= hi;
    }
    return parseInt(field) === value;
  };
  return {
    match: match(parts[0], minute) && match(parts[1], hour) &&
           match(parts[2], day) && match(parts[3], month) && match(parts[4], dow)
  };
}

async function loadJobsFromPg() {
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  try {
    // The supabase schema has cron jobs in cron.job (pg_cron). The
    // local PG might or might not have pg_cron installed; if not,
    // we fall back to reading from a JSON file the relay maintains.
    let rows;
    try {
      const r = await c.query("SELECT jobid as id, schedule, command FROM cron.job ORDER BY jobid");
      rows = r.rows;
      // Detect type: SQL or edge function (SELECT extensions.http)
      rows = rows.map((j) => ({
        ...j,
        type: /^SELECT\s+extensions\.http/i.test(j.command || '') ? 'edge' : 'sql',
      }));
    } catch (e) {
      // pg_cron not available; read from relay-data/cron-jobs.json
      const f = join(DATA_DIR, 'cron-jobs.json');
      if (!existsSync(f)) {
        log('no cron.job table and no cron-jobs.json; nothing to do', 'WARN');
        return [];
      }
      rows = JSON.parse(readFileSync(f, 'utf8'));
      // Normalize field names: source has {id, schedule, type, sql/fn}
      // runtime expects {id, schedule, type, command: (sql) or fn+body}
      rows = rows.map((j) => {
        if (j.type === 'sql' && j.sql) {
          return { id: j.id, schedule: j.schedule, type: 'sql', command: j.sql, name: j.name, disabled: j.disabled };
        }
        if (j.type === 'ef' && j.fn) {
          return { id: j.id, schedule: j.schedule, type: 'edge', fn: j.fn, body: j.body || {}, name: j.name, disabled: j.disabled };
        }
        return j;
      });
    }
    return rows;
  } finally {
    await c.end();
  }
}

async function runSql(sql) {
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  try {
    const r = await c.query(sql);
    return { ok: true, rows: r.rowCount };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await c.end();
  }
}

async function runEdgeFunctionByName(fnName, body = {}) {
  const target = `${RUNTIME_URL}/functions/v1/${fnName}`;
  try {
    const r = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: safeJsonStringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, preview: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Safe JSON serializer — never produces [object Object] */
function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj, (_key, value) => {
      if (value === undefined) return null;
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) return { name: value.name, message: value.message };
      return value;
    });
  } catch (e) {
    console.error('safeJsonStringify failed:', e.message);
    return JSON.stringify({ error: 'serialization_failed' });
  }
}

async function runEdgeFunction(job) {
  // Legacy: parse the command string for the function name.
  const m = job.command?.match(/functions\/v1\/([a-zA-Z0-9_-]+)/);
  if (!m) return { ok: false, error: 'no function name in command' };
  return runEdgeFunctionByName(m[1], {});
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { lastRun: {} }; }
}
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

async function tick() {
  const jobs = await loadJobsFromPg();
  if (!jobs.length) {
    log('no jobs registered');
    return;
  }
  log(`loaded ${jobs.length} jobs (${jobs.filter(j => j.type === 'sql').length} sql, ${jobs.filter(j => j.type === 'edge').length} edge)`);
  const state = loadState();
  for (const job of jobs) {
    if (job.disabled) continue;
    const c = parseCron(job.schedule);
    if (c.error) {
      log(`job ${job.id} bad cron: ${c.error}`, 'WARN');
      continue;
    }
    if (!c.match) continue;
    const lastMin = state.lastRun[job.id];
    const thisMin = Math.floor(Date.now() / 60000);
    if (lastMin === thisMin) continue; // already ran this minute
    const label = job.name || job.fn || `job-${job.id}`;
    log(`[${job.id}] ${job.type}: ${label}`);
    let res;
    if (job.type === 'sql') {
      res = await runSql(job.command);
    } else if (job.type === 'edge' && job.fn) {
      res = await runEdgeFunctionByName(job.fn, job.body);
    } else {
      res = { ok: false, error: `unknown type: ${job.type}` };
    }
    state.lastRun[job.id] = thisMin;
    if (res.ok) {
      log(`[${job.id}] OK (${res.rows ?? res.status ?? '?'} rows/ms)`);
    } else {
      log(`[${job.id}] FAIL: ${res.error}`, 'WARN');
    }
  }
  saveState(state);
}

export async function runOnce() {
  await tick();
}

export function runDaemon() {
  log('daemon starting (poll every 30s)');
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    try { await tick(); } catch (e) { log('tick error: ' + e.message, 'WARN'); }
    setTimeout(loop, 30_000);
  };
  loop();
  return () => { stopped = true; };
}

// CLI mode
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  if (process.argv.includes('--once')) {
    runOnce().then(() => process.exit(0));
  } else if (process.argv.includes('--list')) {
    loadJobsFromPg().then((j) => { console.log(JSON.stringify(j, null, 2)); process.exit(0); });
  } else {
    runDaemon();
  }
}
