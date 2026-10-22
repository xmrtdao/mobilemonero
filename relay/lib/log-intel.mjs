/**
 * relay/lib/log-intel.mjs — intelligence over the logs the fleet already writes.
 *
 * WHAT THIS IS FOR.
 *
 * The Activity Log answers "what just happened". It does not answer:
 *
 *   - who is actually generating the traffic (half of it was "unknown")
 *   - which functions are hot, which are broken
 *   - which errors repeat, and which are one-offs
 *   - what the log files on disk say that never reaches the database at all
 *   - which log sources exist and how much each one contributes
 *
 * This module reads the same sources the system already writes to — the
 * activity feed, the cron execution log, the edge function logs, the system
 * logs, and the plain log files under logs/ — and turns them into the
 * aggregates the dashboard renders.
 *
 * Two rules, both load-bearing:
 *
 *  1. Never invent an attribution. If the agent is not known, the answer is a
 *     *classified client* ("suite-dashboard"), not a guess at an agent, and
 *     not the word "unknown". A wrong attribution is worse than a coarse one.
 *
 *  2. Never rewrite history. Errors are grouped and counted; the underlying
 *     rows are left exactly as they were written.
 */

import { existsSync, readdirSync, openSync, fstatSync, readSync, closeSync, statSync } from 'fs';
import { join } from 'path';
import { query } from './db.mjs';
import { scanInfraFiles, recordVersions, routeOwnerMap, findRouteOwner, versionAt, versionHistories, versionAtFromHistory } from './infra-files.mjs';

// ── Client classification ──────────────────────────────────────────────────
//
// Which client is making a request, judged by the path it hits. The order
// matters: the first match wins, so specific prefixes come before general
// ones.
const CLIENT_BY_PREFIX = [
  ['/api/suite', 'suite-dashboard'],
  ['/suite', 'suite-dashboard'],
  ['/api/fleet-chat', 'fleet-chat'],
  ['/api/trustgraph', 'trustgraph'],
  ['/api/obsidian-graph', 'graph-viewer'],
  ['/api/kn', 'knowledge'],
  ['/api/knowledge', 'knowledge'],
  ['/api/jobby', 'jobby'],
  ['/api/pfp', 'pfp'],
  ['/api/alice', 'alice'],
  ['/api/hermes', 'hermes'],
  ['/api/cron', 'cron'],
  ['/api/announcer', 'announcer'],
  ['/api/supervisor', 'supervisor'],
  ['/api/bulletin', 'bulletin'],
  ['/api/mesh', 'mesh'],
  ['/api/rum-quota', 'nexus-dashboard'],
  ['/api/activity-log', 'nexus-dashboard'],
  ['/api/agent-activity', 'nexus-dashboard'],
  ['/api/edge-functions', 'nexus-dashboard'],
  ['/api/catalog', 'nexus-dashboard'],
  ['/api/v1/functions', 'edge-invoker'],
  ['/functions/v1', 'edge-invoker'],
  ['/rest/v1', 'supabase-rest'],
  ['/webhook', 'webhook'],
  ['/ollama', 'ollama'],
  ['/state', 'state-store'],
  ['/api/state', 'state-store'],
  ['/api/dao', 'nexus-dashboard'],
  ['/api/token-usage', 'token-tracker'],
  ['/tools/run', 'tools-run'],
  ['/monitor', 'monitor'],
  ['/status', 'health'],
  ['/health', 'health'],
  ['/browser', 'aside-browser'],
  ['/api/mesh/', 'mesh'],
];

const CLIENT_BY_PATH = new Map([
  ['/api/fleet-chat/messages', 'fleet-chat'],
  ['/api/fleet-chat/agents', 'nexus-dashboard'],
  ['/api/activity-log', 'nexus-dashboard'],
]);

// Rows that never had a path in them (a tool ran, a health check fired, a
// webhook arrived) still have an origin. Without this they all land in one
// "relay" bucket, which is true but useless — "the tool runner" and "the
// health monitor" are different pieces of the stack and the operator needs to
// see which one is busy.
const CLIENT_BY_ACTIVITY_TYPE = {
  tool_execution: 'tool-runner',
  tool_pending: 'tool-runner',
  tool_running: 'tool-runner',
  tool_success: 'tool-runner',
  tool_failed: 'tool-runner',
  cron_execution: 'cron-engine',
  edge_function: 'cron-engine',
  system_health_check: 'health-monitor',
  service_check: 'health-monitor',
  daemon_scan: 'daemon',
  dispatch: 'dispatcher',
  'fleet-chat': 'fleet-chat',
  fleet_message: 'fleet-chat',
  ai_chat: 'ai-chat',
  'resend-tracking': 'resend-webhook',
  'resend-inbound': 'resend-webhook',
  'resend-inbound-rejected': 'resend-webhook',
  'auto-responder': 'auto-responder',
  'email-to-lead': 'auto-responder',
  'enhanced_learning': 'learning',
  token_usage: 'token-tracker',
  'xmrt-university': 'university',
  auth: 'auth',
  rate_limit: 'relay-guard',
  auth_failure: 'relay-guard',
  mesh_rejection: 'mesh',
  board: 'bulletin',
  'webhook': 'webhook',
  handler: 'task-runner',
  task: 'task-runner',
};

/**
 * Classify a request path into the client that most likely owns it.
 * Returns 'relay' for paths no known client claims.
 */
export function classifyPath(path, activityType) {
  if (!path) return CLIENT_BY_ACTIVITY_TYPE[activityType] || 'relay';
  const clean = String(path).split('?')[0];
  if (CLIENT_BY_PATH.has(clean)) return CLIENT_BY_PATH.get(clean);
  for (const [prefix, label] of CLIENT_BY_PREFIX) {
    if (clean === prefix || clean.startsWith(prefix + '/') || clean.startsWith(prefix + '?')) return label;
  }
  return CLIENT_BY_ACTIVITY_TYPE[activityType] || 'relay';
}

/**
 * Resolve who an activity row belongs to.
 *
 * agent_id is trusted when it is a real agent. "unknown" and empty are not
 * names, so they are replaced by a classified client — which is honest: the
 * row genuinely came from a client, not from an agent we can name.
 */
export function resolveActor(row) {
  const agent = (row.agent_id || '').trim();
  const meaningful = agent && agent !== 'unknown' && agent !== 'null' && agent !== '-';
  if (meaningful) {
    return { actor: agent, actor_kind: 'agent', source: row.metadata?.source || null };
  }
  const path = row.metadata?.path || (String(row.title || '').match(/\s(\/[^\s]*)/) || [])[1] || null;
  const source = row.metadata?.source || classifyPath(path, row.activity_type);
  return { actor: source, actor_kind: 'client', source };
}

/**
 * The actor for a request, given its headers. Used at write time so new rows
 * are attributed correctly instead of being born "unknown".
 */
export function classifyRequest(req) {
  const headers = req.headers || {};
  const headerAgent = (headers['x-agent-id'] || headers['x-agent'] || '').trim();
  const authAgent = req.agentAuth?.agent_id ? String(req.agentAuth.agent_id).trim() : '';
  const path = req.path || req.originalUrl || '';
  const source = classifyPath(path);

  const agent = headerAgent || authAgent || '';
  if (agent) return { actor: agent, actor_kind: 'agent', source };
  return { actor: source, actor_kind: 'client', source };
}

// ── Activity feed ──────────────────────────────────────────────────────────

/**
 * Fetch activity rows with every field the UI needs.
 *
 * The old endpoint returned seven columns and capped at fifty rows, which is
 * why the log looked thin and the duration/status of each request was
 * invisible. This returns the metadata too, and paginates.
 */
export async function fetchActivity({
  limit = 50, activity_type, status, agent_id, since, before, q, include_meta = true,
} = {}) {
  const params = [];
  let sql = 'SELECT id, activity_type, title, description, status, agent_id, created_at'
    + (include_meta ? ', metadata, function_name, task_id' : '')
    + ' FROM public.eliza_activity_log WHERE 1=1';
  const add = (clause, value) => { params.push(value); sql += ` AND ${clause} $${params.length}`; };

  if (activity_type) add('activity_type =', activity_type);
  if (status) add('status =', status);
  if (agent_id) add('(agent_id = OR COALESCE(metadata->>\'source\',\'\') ILIKE)', agent_id);
  if (since) add('created_at >', since);
  if (before) add('created_at <', before);
  if (q) {
    params.push(`%${String(q).toLowerCase()}%`);
    sql += ` AND (LOWER(title) LIKE $${params.length} OR LOWER(COALESCE(description,'')) LIKE $${params.length}`
      + ` OR LOWER(COALESCE(function_name,'')) LIKE $${params.length} OR LOWER(COALESCE(agent_id,'')) LIKE $${params.length})`;
  }
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  sql += ` ORDER BY created_at DESC LIMIT ${safeLimit}`;

  const r = await query(sql, params);
  return (r.rows || []).map((row) => {
    const resolved = resolveActor(row);
    const meta = row.metadata || {};
    return {
      ...row,
      actor: resolved.actor,
      actor_kind: resolved.actor_kind,
      source: resolved.source,
      duration_ms: meta.duration_ms != null ? Number(meta.duration_ms) : null,
      status_code: meta.status_code != null ? Number(meta.status_code) : null,
      path: meta.path || null,
      method: meta.method || null,
    };
  });
}

// ── Error fingerprints ─────────────────────────────────────────────────────

/**
 * Reduce a message to a stable shape so repeats count as one problem.
 *
 * UUIDs, hex ids, timestamps, numbers, quoted payloads and file paths all
 * change between occurrences of the same fault; what stays the same is the
 * sentence around them.
 */
export function fingerprint(message) {
  if (!message) return '(empty)';
  return String(message)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<ts>')
    .replace(/'[^']*'/g, "'<str>'")
    .replace(/"[^"]*"/g, '"<str>"')
    .replace(/`[^`]*`/g, '`<str>`')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}\b/gi, '<id>')
    // Numbers are replaced wherever they are, not only where they stand
    // alone. "406" and "28ms" both had to collapse to the same shape, and a
    // word-boundary match left "28ms" alone — which split one recurring
    // error into a dozen groups that differed only in how long it took.
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

/**
 * The canonical text of a failure.
 *
 * A single failure is written down twice: once by the tool runner
 * ("❌ db-query" / "db-query failed") and once by the caller that invoked
 * it ("🔧 Eliza executed db-query" / "Eliza executed tool: db-query"). Both
 * rows are real, and grouping them as two separate faults would double the
 * count and hide the shape of the problem. So the message is normalised to
 * "<tool> failed" and the second row is not counted again.
 *
 * The same applies to HTTP errors, where the title is the method and path
 * and the status line repeats it: "POST /tools/run → 404 (0ms)" is one
 * message, not "POST /tools/run: POST /tools/run → 404 (0ms)".
 */
export function canonicalErrorMessage(row) {
  const GENERIC = ['error', 'failed', 'info', 'completed', 'warning', 'pending', 'in_progress', ''];
  const strip = (s) => String(s).replace(/^[^\p{L}\p{N}]+/u, '').trim();

  if (row.activity_type === 'tool_failed') {
    const tool = strip(row.title || '') || strip(row.description || '').replace(/\s+failed$/i, '');
    return tool ? tool + ' failed' : 'tool failed';
  }

  const candidates = [row.status, row.description, row.title];
  for (const raw of candidates) {
    if (raw == null) continue;
    const text = String(raw).trim();
    if (!text) continue;
    if (GENERIC.includes(text.toLowerCase())) continue;

    // "Eliza executed tool: db-query" -> "db-query failed"
    const executed = text.match(/executed tool:\s*(.+)$/i) || text.match(/executed\s+(.+)$/i);
    if (executed) {
      const tool = strip(executed[1]);
      return tool ? tool + ' failed' : 'tool failed';
    }
    return strip(text) || text;
  }
  return strip(row.title || '') || 'unknown error';
}

// ── Ship logs (the files on disk) ──────────────────────────────────────────

const LOG_DIR_NAME = 'logs';

function listLogFiles(root) {
  const dir = join(root, LOG_DIR_NAME);
  if (!existsSync(dir)) return [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.log') && !name.endsWith('.err')) continue;
    let st;
    try { st = statSync(join(dir, name)); } catch { continue; }
    out.push({
      name,
      bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      age_minutes: Math.round((Date.now() - st.mtimeMs) / 60000),
      live: Date.now() - st.mtimeMs < 5 * 60_000,
    });
  }
  out.sort((a, b) => (a.live === b.live ? b.mtime.localeCompare(a.mtime) : (a.live ? -1 : 1)));
  return out;
}

/**
 * Read the last N lines of a file.
 *
 * Bounded on purpose. The log directory holds files of 132MB, and reading
 * one into memory to show its last twenty lines is what turned the first
 * call to this endpoint into a thirty-second request. This reads the last
 * 128KB and nothing else.
 */
function tailFile(path, n) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const chunk = Math.min(size, 128 * 1024);
    const buf = Buffer.alloc(chunk);
    readSync(fd, buf, 0, chunk, size - chunk);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    return lines.slice(-n);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

const ERROR_LINE_RE = /\b(error|err!|fatal|exception|traceback|unhandled|crash|failed|failure|denied|refused|timeout|timed out)\b/i;

/**
 * The ship logs: which files exist, which are live, and what the error
 * lines in them say.
 *
 * These never reach the activity feed — they are files on disk, written by
 * processes that have no database connection — which is exactly why they are
 * worth surfacing separately.
 */
export async function scanShipLogs({ root, file, lines = 60, errorsOnly = false, limit = 12 } = {}) {
  const dir = join(root, LOG_DIR_NAME);
  const files = listLogFiles(root);
  const wanted = file ? files.filter(f => f.name === file) : files.slice(0, limit);

  const tails = [];
  const errorLines = [];
  for (const f of wanted) {
    const abs = join(dir, f.name);
    const tail = tailFile(abs, Math.min(lines, 400));
    if (file) {
      tails.push({ file: f.name, lines: tail });
    }
    for (const line of tail) {
      if (ERROR_LINE_RE.test(line)) {
        errorLines.push({ file: f.name, line: line.slice(0, 400) });
      }
    }
  }

  return {
    dir,
    files: files.slice(0, 60),
    file_count: files.length,
    live_count: files.filter(f => f.live).length,
    tails,
    error_lines: errorLines.slice(0, 80),
    error_line_count: errorLines.length,
  };
}

// ── Coverage: which log sources exist and how much each contributes ────────

const COVERAGE_SOURCES = [
  { table: 'public.eliza_activity_log', label: 'Activity feed', time_col: 'created_at', in_feed: true },
  { table: 'public.cron_execution_log', label: 'Cron executions', time_col: 'created_at', in_feed: false },
  { table: 'public.edge_function_logs', label: 'Edge function logs', time_col: 'timestamp', in_feed: false },
  { table: 'public.system_logs', label: 'System logs', time_col: 'created_at', in_feed: false },
  { table: 'public.function_usage_logs', label: 'Function usage', time_col: 'created_at', in_feed: false },
  { table: 'public.eliza_function_usage', label: 'Eliza function usage', time_col: 'created_at', in_feed: false },
  { table: 'public.edge_function_usage', label: 'Edge usage', time_col: 'created_at', in_feed: false },
  { table: 'public.function_logs', label: 'Function logs', time_col: 'timestamp', in_feed: false },
  { table: 'public.api_call_logs', label: 'API call logs', time_col: 'called_at', in_feed: false },
  { table: 'public.system__error_log', label: 'System error log', time_col: 'created_at', in_feed: false },
  { table: 'public.system__request_log', label: 'System request log', time_col: 'created_at', in_feed: false },
  { table: 'public.webhook_logs', label: 'Webhook logs', time_col: 'created_at', in_feed: false },
  { table: 'app.suite_activity_log', label: 'Suite activity', time_col: 'created_at', in_feed: false },
  { table: 'app.token_usage', label: 'Token usage', time_col: 'logged_at', in_feed: false },
];

async function coverageFor(sinceIso) {
  // Bounded on purpose: a coverage count is a "how much is in here" number,
  // not an audit, and an unbounded COUNT over an unanalysed table is the one
  // query here that could take the panel down.
  const results = [];
  for (let i = 0; i < COVERAGE_SOURCES.length; i += 4) {
    const slice = COVERAGE_SOURCES.slice(i, i + 4);
    const settled = await Promise.allSettled(slice.map(async (src) => {
      const r = await query(
        `SELECT COUNT(*)::int c FROM (SELECT 1 FROM ${src.table} WHERE ${src.time_col} > $1 LIMIT 200000) t`,
        [sinceIso]
      );
      const last = await query(
        `SELECT MAX(${src.time_col}) AS last_at FROM (SELECT ${src.time_col} FROM ${src.table} WHERE ${src.time_col} > $1 LIMIT 200000) t`,
        [sinceIso]
      );
      const row = (r.rows || [])[0] || {};
      return {
        table: src.table,
        label: src.label,
        in_feed: src.in_feed,
        rows: row.c ?? 0,
        last_at: (last.rows || [])[0]?.last_at || null,
      };
    }));
    for (const s of settled) if (s.status === 'fulfilled') results.push(s.value);
  }
  return results
    .filter((r) => r.rows > 0 || r.in_feed)
    .sort((a, b) => b.rows - a.rows);
}

// ── Live traffic counters ──────────────────────────────────────────────────
//
// The database only keeps the requests that were "interesting" (errors, slow
// calls, and the endpoints the fleet uses). That is the right thing to store
// and the wrong thing to measure: a traffic timeline built from it shows the
// same twenty endpoints forever and cannot tell you that a client started
// hammering something new at 14:05.
//
// So every request is counted in memory, per minute, and the counter is what
// the volume timeline is drawn from. It is a rolling window, not history —
// the database remains the record of what happened; this is the live shape.
const TRAFFIC_WINDOW_MS = 3 * 60 * 60_000;
const trafficBuckets = new Map();

export function recordTraffic({ method, path, status, duration, actor, source } = {}) {
  const now = Date.now();
  const minute = Math.floor(now / 60000) * 60000;
  let bucket = trafficBuckets.get(minute);
  if (!bucket) {
    bucket = { t: minute, total: 0, errors: 0, slow: 0, by_source: {}, by_endpoint: {} };
    trafficBuckets.set(minute, bucket);
  }
  bucket.total += 1;
  if (status >= 400) bucket.errors += 1;
  if (duration >= 5000) bucket.slow += 1;
  const s = source || 'relay';
  bucket.by_source[s] = (bucket.by_source[s] || 0) + 1;
  // Endpoints are keyed by their shape, not their exact path: /api/tasks/12
  // and /api/tasks/13 are the same endpoint and must not be two series.
  const shape = String(path || '').replace(/\/\d+(?=\/|$)/g, '/:id');
  bucket.by_endpoint[shape] = (bucket.by_endpoint[shape] || 0) + 1;

  if (trafficBuckets.size > 240) {
    for (const key of trafficBuckets.keys()) {
      if (key < now - TRAFFIC_WINDOW_MS) trafficBuckets.delete(key);
    }
  }
}

/** The live traffic buckets inside a window. */
export function trafficSince(sinceMs) {
  const out = [];
  for (const bucket of trafficBuckets.values()) {
    if (bucket.t >= sinceMs) out.push(bucket);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Top endpoints by live traffic — the shape of load, not just of failures. */
export function trafficTopEndpoints(sinceMs, limit = 12) {
  const totals = new Map();
  for (const bucket of trafficBuckets.values()) {
    if (bucket.t < sinceMs) continue;
    for (const [path, count] of Object.entries(bucket.by_endpoint)) {
      totals.set(path, (totals.get(path) || 0) + count);
    }
  }
  return [...totals.entries()]
    .map(([path, calls]) => ({ path, calls }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, limit);
}

// ── The bundle ─────────────────────────────────────────────────────────────

let cache = { at: 0, key: '', data: null };
const CACHE_TTL_MS = 8_000;

// The bundle asks the database a lot of questions at once. Postgres is
// perfectly happy to answer them, but the relay's pool has twenty
// connections and five of them are already busy serving the fleet, so
// twenty-eight parallel questions means eight of them wait — and the pool's
// connection timeout is five seconds. The questions that lose that race are
// reported as failures, which is exactly how a working feature looks
// broken. So the questions are queued, not fired.
const MAX_CONCURRENT_QUERIES = 5;
let _active = 0;
const _waiting = [];

async function withSlot(fn) {
  if (_active >= MAX_CONCURRENT_QUERIES) {
    await new Promise((resolve) => _waiting.push(resolve));
  }
  _active++;
  try {
    return await fn();
  } finally {
    _active--;
    const next = _waiting.shift();
    if (next) next();
  }
}

async function safe(label, fn, fallback) {
  try {
    return await withSlot(fn);
  } catch (e) {
    console.warn(`[log-intel] ${label} failed: ${e.message}`);
    return fallback;
  }
}

/**
 * Build the whole intelligence bundle.
 *
 * Every part fails independently: a missing table or a slow query degrades
 * one module, it does not take the panel down.
 */
export async function buildIntel({ windowMinutes = 60, root, refresh = false } = {}) {
  const window = Math.min(Math.max(parseInt(windowMinutes, 10) || 60, 5), 1440);
  const key = String(window);
  if (!refresh && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  const sinceIso = new Date(Date.now() - window * 60_000).toISOString();
  const sinceDate = new Date(sinceIso);

  const [
    totals, types, unknownSources, timeline, timelineByType,
    cronBars, edgeBars, activityBars, functionsTool, functionsEdge, functionsCron,
    slowEndpoints, coverage, ship, infra,
  ] = await Promise.all([
    safe('totals', async () => {
      const r = await query(`
        SELECT COUNT(*)::int total,
          COUNT(*) FILTER (WHERE activity_type='http_error')::int http_errors,
          COUNT(*) FILTER (WHERE status IN ('error','failed'))::int failures,
          COUNT(*) FILTER (WHERE status='warning')::int warnings,
          COUNT(*) FILTER (WHERE activity_type='slow_request')::int slow,
          COUNT(DISTINCT activity_type)::int type_count,
          COUNT(DISTINCT COALESCE(NULLIF(agent_id,''),'unknown'))::int actor_count
        FROM public.eliza_activity_log WHERE created_at > $1`, [sinceIso]);
      return (r.rows || [])[0] || {};
    }, {}),

    safe('types', async () => {
      const r = await query(`
        SELECT activity_type, COUNT(*)::int calls,
          COUNT(*) FILTER (WHERE status IN ('error','failed'))::int failures,
          MAX(created_at) last_at
        FROM public.eliza_activity_log WHERE created_at > $1
        GROUP BY 1 ORDER BY calls DESC LIMIT 26`, [sinceIso]);
      return r.rows || [];
    }, []),

    // The "unknown" bucket, resolved. This is the query that turns
    // "unknown" into "suite-dashboard made 12,340 of those calls".
    safe('unknown-sources', async () => {
      const r = await query(`
        SELECT activity_type, COALESCE(metadata->>'path', metadata->>'tool') AS sig,
          COUNT(*)::int calls,
          COUNT(*) FILTER (WHERE status IN ('error','failed'))::int failures,
          MAX(created_at) AS last_at
        FROM public.eliza_activity_log
        WHERE created_at > $1 AND (agent_id IS NULL OR agent_id IN ('', 'unknown'))
        GROUP BY 1,2 ORDER BY calls DESC LIMIT 60`, [sinceIso]);
      const map = new Map();
      for (const row of r.rows || []) {
        const sig = row.sig || '';
        const source = sig.startsWith('/')
          ? classifyPath(sig, row.activity_type)
          : classifyPath(null, row.activity_type);
        const prev = map.get(source) || { source, calls: 0, failures: 0, paths: [], last_at: null };
        prev.calls += row.calls;
        prev.failures += row.failures;
        if (sig && !prev.paths.includes(sig)) prev.paths.push(sig);
        if (!prev.last_at || (row.last_at && row.last_at > prev.last_at)) prev.last_at = row.last_at;
        map.set(source, prev);
      }
      return [...map.values()].sort((a, b) => b.calls - a.calls).slice(0, 15);
    }, []),

    safe('timeline', async () => {
      const bucket = window <= 60 ? 'minute' : (window <= 180 ? '5 minutes' : '15 minutes');
      const r = await query(`
        SELECT date_trunc('${bucket}', created_at) AS t, COUNT(*)::int calls,
          COUNT(*) FILTER (WHERE status IN ('error','failed'))::int failures
        FROM public.eliza_activity_log WHERE created_at > $1
        GROUP BY 1 ORDER BY 1`, [sinceIso]);
      return r.rows || [];
    }, []),

    safe('timeline-by-type', async () => {
      // The bucket widens with the window: a twelve-hour view at one-minute
      // resolution is 720 rows per type, which is a payload the panel cannot
      // use and a query nobody wants to run.
      const bucket = window <= 60 ? 'minute' : (window <= 180 ? '5 minutes' : '15 minutes');
      const r = await query(`
        SELECT date_trunc('${bucket}', created_at) AS t, activity_type, COUNT(*)::int calls
        FROM public.eliza_activity_log WHERE created_at > $1
        GROUP BY 1,2 ORDER BY 1`, [sinceIso]);
      return r.rows || [];
    }, []),

    safe('cron-bars', async () => {
      const r = await query(`
        SELECT job_name, status, started_at, finished_at, duration_ms, error, owner_agent
        FROM public.cron_execution_log WHERE created_at > $1
        ORDER BY created_at DESC LIMIT 300`, [sinceIso]);
      return r.rows || [];
    }, []),

    safe('edge-bars', async () => {
      const r = await query(`
        SELECT function_name, level, status_code, execution_time_ms, timestamp, event_message
        FROM public.edge_function_logs WHERE timestamp > $1
        ORDER BY timestamp DESC LIMIT 300`, [sinceIso]);
      return r.rows || [];
    }, []),

    safe('activity-bars', async () => {
      const r = await query(`
        SELECT created_at, activity_type, title, agent_id, status,
          (metadata->>'duration_ms')::int AS duration_ms,
          metadata->>'path' AS path, metadata->>'tool' AS tool
        FROM public.eliza_activity_log
        WHERE created_at > $1 AND (metadata->>'duration_ms') IS NOT NULL
        ORDER BY created_at DESC LIMIT 500`, [sinceIso]);
      return r.rows || [];
    }, []),

    safe('functions-tool', async () => {
      const r = await query(`
        SELECT function_name, COUNT(*)::int calls,
          COUNT(*) FILTER (WHERE status IN ('error','failed'))::int failures,
          ROUND(AVG(COALESCE((metadata->>'duration_ms')::numeric, 0)), 0)::int avg_ms,
          MAX(created_at) last_at
        FROM public.eliza_activity_log
        WHERE created_at > $1 AND function_name IS NOT NULL
        GROUP BY 1 ORDER BY calls DESC LIMIT 25`, [sinceIso]);
      return r.rows || [];
    }, []),

    safe('functions-edge', async () => {
      const r = await query(`
        SELECT function_name, COUNT(*)::int calls,
          COUNT(*) FILTER (WHERE level NOT IN ('info','debug'))::int failures,
          ROUND(AVG(COALESCE(execution_time_ms,0)), 0)::int avg_ms,
          MAX(timestamp) last_at
        FROM public.edge_function_logs WHERE timestamp > $1
        GROUP BY 1 ORDER BY calls DESC LIMIT 25`, [sinceIso]);
      return r.rows || [];
    }, []),

    safe('functions-cron', async () => {
      const r = await query(`
        SELECT job_name, COUNT(*)::int calls,
          COUNT(*) FILTER (WHERE status NOT IN ('completed','success'))::int failures,
          ROUND(AVG(COALESCE(duration_ms,0)), 0)::int avg_ms,
          MAX(created_at) last_at
        FROM public.cron_execution_log WHERE created_at > $1
        GROUP BY 1 ORDER BY calls DESC LIMIT 25`, [sinceIso]);
      return r.rows || [];
    }, []),

    safe('slow-endpoints', async () => {
      const r = await query(`
        SELECT metadata->>'path' AS path, COUNT(*)::int calls,
          ROUND(AVG((metadata->>'duration_ms')::numeric), 0)::int avg_ms,
          MAX((metadata->>'duration_ms')::int) AS max_ms,
          COUNT(*) FILTER (WHERE (metadata->>'duration_ms')::int > 5000)::int over_5s
        FROM public.eliza_activity_log
        WHERE created_at > $1 AND metadata->>'path' IS NOT NULL
        GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY avg_ms DESC LIMIT 15`, [sinceIso]);
      return r.rows || [];
    }, []),

    safe('coverage', () => coverageFor(sinceIso), []),
    safe('ship', () => scanShipLogs({ root, limit: 12 }), null),
    safe('infra', async () => {
      const files = scanInfraFiles(root);
      await recordVersions(files);
      return files;
    }, []),
  ]);

  // ── Errors ───────────────────────────────────────────────────────────────
  const errorMap = new Map();
  const addError = (key, message, when, source, extra) => {
    if (!message) return;
    const fp = fingerprint(message);
    const bucket = errorMap.get(fp) || {
      fingerprint: fp, sample: String(message).slice(0, 300), count: 0,
      sources: [], last_at: null, first_at: null, files: [],
    };
    bucket.count += 1;
    if (!bucket.sources.includes(source)) bucket.sources.push(source);
    if (extra?.file && !bucket.files.includes(extra.file)) bucket.files.push(extra.file);
    if (when) {
      if (!bucket.last_at || when > bucket.last_at) bucket.last_at = when;
      if (!bucket.first_at || when < bucket.first_at) bucket.first_at = when;
    }
    errorMap.set(fp, bucket);
  };

  const routeOwners = root ? routeOwnerMap(root) : new Map();
  const primaryToolFailures = new Set();

  // Errors from the activity feed. The path tells us which file owns the
  // route, which is the difference between "an error happened" and "this
  // file was the one that threw it".
  const activityErrors = await safe('activity-errors', async () => {
    const r = await query(`
      SELECT created_at, activity_type, title, description, status, agent_id,
        metadata->>'path' AS path, metadata->>'function_name' AS fn,
        (metadata->>'status_code')::int AS status_code
      FROM public.eliza_activity_log
      WHERE created_at > $1
        AND (status IN ('error','failed')
          OR activity_type IN ('http_error','tool_failed','db_error','email_error',
            'fleet_error','memory_error','kg_error','system_error','ollama_error',
            'mesh_rejection','auth_failure'))
      ORDER BY created_at DESC LIMIT 400`, [sinceIso]);
    return r.rows || [];
  }, []);

  for (const row of activityErrors) {
    const path = row.path;
    // Pattern matching matters here: the route is registered as
    // '/api/suite/tasks/:id' and the request that failed was
    // '/api/suite/tasks/ec372cfc'. An exact lookup finds nothing, and the
    // badge that says which file owns the route would be missing exactly
    // when it is most wanted.
    const owner = path ? findRouteOwner(path) : null;
    const message = canonicalErrorMessage(row);
    // A tool failure is written twice — once by the runner, once by the
    // caller. The runner's row is the primary one; the caller's row is the
    // same fault seen from the other side, so counting it again would report
    // one broken tool as two broken tools.
    if (row.activity_type === 'tool_execution' && primaryToolFailures.has(message)) continue;
    if (row.activity_type === 'tool_failed') primaryToolFailures.add(message);
    addError(message, message, row.created_at, row.activity_type, { file: owner?.file || null });
  }

  // Errors from the cron log — these never reach the activity feed.
  await safe('cron-errors', async () => {
    const r = await query(`
      SELECT created_at, job_name, status, error FROM public.cron_execution_log
      WHERE created_at > $1 AND (error IS NOT NULL OR status NOT IN ('completed','success'))
      ORDER BY created_at DESC LIMIT 120`, [sinceIso]);
    for (const row of r.rows || []) {
      addError(row.error || `cron ${row.job_name} ${row.status}`, row.error || `cron ${row.job_name} ${row.status}`,
        row.created_at, 'cron', { file: 'relay/cron-engine-v2.mjs' });
    }
  });

  // Errors from the edge function logs.
  await safe('edge-errors', async () => {
    const r = await query(`
      SELECT timestamp, function_name, level, event_message FROM public.edge_function_logs
      WHERE timestamp > $1 AND level NOT IN ('info','debug')
      ORDER BY timestamp DESC LIMIT 120`, [sinceIso]);
    for (const row of r.rows || []) {
      addError(row.event_message || `${row.function_name} ${row.level}`, row.event_message,
        row.timestamp, 'edge_function', { file: null });
    }
  });

  // Errors from the system logs.
  await safe('system-errors', async () => {
    const r = await query(`
      SELECT created_at, message, log_source, function_name FROM public.system_logs
      WHERE created_at > $1 AND log_level IN ('error','warn','fatal','critical')
      ORDER BY created_at DESC LIMIT 150`, [sinceIso]);
    for (const row of r.rows || []) {
      addError(row.message, row.message, row.created_at, row.log_source || 'system',
        { file: row.function_name ? null : null });
    }
  });

  const errors = [...errorMap.values()]
    .map((e) => ({
      ...e,
      // "was it already fixed?" — an error that has not recurred in the last
      // 15 minutes is probably history, not an ongoing fault.
      stale: e.last_at ? (Date.now() - new Date(e.last_at).getTime() > 15 * 60_000) : false,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // ── Which version of the file was live when it fired? ────────────────────
  //
  // The question the Activity Log could not answer. Each error names a route
  // (sometimes); the route belongs to a file; the file has a version
  // history. So the error is stamped with the version that was in effect at
  // the moment it fired — which is the difference between "the code I am
  // reading is the code that threw" and "it threw before that rewrite".
  const ownerFiles = [...new Set(errors.flatMap((e) => e.files || []))];
  const histories = await safe('version-histories', () => versionHistories(ownerFiles), {});
  for (const e of errors) {
    const file = (e.files || [])[0];
    if (!file) continue;
    const v = versionAtFromHistory(histories, file, e.last_at || new Date().toISOString());
    e.file_version = v
      ? { version: v.version, lines: v.lines, bytes: v.bytes, git_sha: v.git_sha, captured_at: v.captured_at, estimated: !!v.estimated }
      : null;
  }

  // ── Functions ────────────────────────────────────────────────────────────
  const fnMap = new Map();
  const mergeFn = (name, row, source) => {
    if (!name) return;
    const key = name;
    const prev = fnMap.get(key) || {
      name, calls: 0, failures: 0, avg_ms: 0, last_at: null, sources: [],
    };
    prev.calls += row.calls || 0;
    prev.failures += row.failures || 0;
    prev.avg_ms = prev.calls ? Math.round((prev.avg_ms * (prev.calls - (row.calls || 0)) + (row.avg_ms || 0) * (row.calls || 0)) / prev.calls) : 0;
    if (row.last_at && (!prev.last_at || row.last_at > prev.last_at)) prev.last_at = row.last_at;
    if (!prev.sources.includes(source)) prev.sources.push(source);
    fnMap.set(key, prev);
  };
  for (const row of functionsTool) mergeFn(row.function_name, row, 'tool');
  for (const row of functionsEdge) mergeFn(row.function_name, row, 'edge');
  for (const row of functionsCron) mergeFn(row.job_name, row, 'cron');
  const functions = [...fnMap.values()].sort((a, b) => b.calls - a.calls).slice(0, 24);

  // ── Jantt lanes ──────────────────────────────────────────────────────────
  const laneMap = new Map();
  const laneFor = (actor, kind) => {
    const key = actor + '|' + kind;
    if (!laneMap.has(key)) laneMap.set(key, { actor, kind, bars: [] });
    return laneMap.get(key);
  };
  const windowStart = Date.now() - window * 60_000;

  for (const row of cronBars) {
    const start = row.started_at ? new Date(row.started_at).getTime() : null;
    if (start == null) continue;
    const dur = row.duration_ms != null ? Number(row.duration_ms) : 0;
    const lane = laneFor(row.owner_agent || 'cron', 'cron');
    lane.bars.push({
      label: row.job_name,
      type: 'cron',
      status: row.status,
      start_ms: start,
      end_ms: start + Math.max(dur, 1),
      duration_ms: dur,
      error: row.error || null,
    });
  }

  for (const row of edgeBars) {
    const start = row.timestamp ? new Date(row.timestamp).getTime() : null;
    if (start == null) continue;
    const dur = row.execution_time_ms != null ? Number(row.execution_time_ms) : 0;
    const lane = laneFor('edge-functions', 'edge');
    // The event message is not an error. It is "Cron job X completed", and
    // treating it as one painted every healthy edge call red.
    const level = String(row.level || 'info').toLowerCase();
    const bad = level === 'error' || level === 'fatal' || level === 'critical';
    const warn = level === 'warn' || level === 'warning';
    lane.bars.push({
      label: row.function_name,
      type: 'edge',
      status: row.level,
      start_ms: start,
      end_ms: start + Math.max(dur, 1),
      duration_ms: dur,
      error: bad || warn ? (row.event_message || null) : null,
    });
  }

  for (const row of activityBars) {
    const end = row.created_at ? new Date(row.created_at).getTime() : null;
    if (end == null) continue;
    const dur = row.duration_ms != null ? Number(row.duration_ms) : 0;
    const actor = row.agent_id && row.agent_id !== 'unknown' ? row.agent_id : classifyPath(row.path, row.activity_type);
    const lane = laneFor(actor, 'request');
    lane.bars.push({
      label: row.path || row.title || row.activity_type,
      type: row.activity_type,
      status: row.status,
      start_ms: end - dur,
      end_ms: end,
      duration_ms: dur,
      error: null,
    });
  }

  const lanes = [...laneMap.values()]
    .map((l) => ({
      actor: l.actor,
      kind: l.kind,
      bars: l.bars
        .filter((b) => b.end_ms >= windowStart)
        .sort((a, b) => a.start_ms - b.start_ms)
        .slice(0, 80),
    }))
    .filter((l) => l.bars.length)
    .sort((a, b) => b.bars.length - a.bars.length)
    .slice(0, 14);

  // ── Assemble ─────────────────────────────────────────────────────────────
  const data = {
    generated_at: new Date().toISOString(),
    window_minutes: window,
    since: sinceIso,
    totals: {
      activity: totals.total || 0,
      errors: (totals.http_errors || 0) + (totals.failures || 0),
      failures: totals.failures || 0,
      warnings: totals.warnings || 0,
      slow: totals.slow || 0,
      types: totals.type_count || 0,
      actors: totals.actor_count || 0,
      unknown_actor_rows: (unknownSources || []).reduce((n, u) => n + u.calls, 0),
    },
    types,
    unknown_sources: unknownSources,
    timeline,
    timeline_by_type: timelineByType,
    traffic: trafficSince(Date.now() - window * 60_000),
    traffic_top: trafficTopEndpoints(Date.now() - window * 60_000, 12),
    lanes,
    functions,
    errors,
    slowest: slowEndpoints,
    coverage,
    ship,
    infra: (infra || []).map((f) => ({
      path: f.path, label: f.label, kind: f.kind, repo: f.repo, exists: f.exists,
      bytes: f.bytes, lines: f.lines, version: f.version, mtime: f.mtime,
      age_minutes: f.age_minutes, function_count: f.function_count, route_count: f.route_count,
      git: f.git,
    })),
    // The route map is used here to attach a file to an error, and is left
    // out of the payload on purpose: the panel needs to know WHICH file
    // owns a route, not every route in the codebase, and shipping 300 route
    // records to a browser that draws none of them is how a 230KB response
    // happens. /api/infra-files serves the full map when someone asks.
    route_owner_count: routeOwners.size,
  };

  cache = { at: Date.now(), key, data };
  return data;
}

/**
 * For one error, which file version was live when it fired?
 *
 * This is the question the Activity Log could not answer: the error names a
 * route, the route belongs to a file, and the file has a version history.
 */
export async function resolveErrorFile({ root, path, functionName, at }) {
  if (!root) return null;
  const owner = path ? routeOwnerMap(root).get(path) : null;
  if (!owner) return null;
  const version = await versionAt(owner.file, at || new Date().toISOString());
  return { file: owner.file, label: owner.label, method: owner.method, version };
}

export { versionAt };
