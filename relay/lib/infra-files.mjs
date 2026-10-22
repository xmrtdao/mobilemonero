/**
 * relay/lib/infra-files.mjs — what version of the code was live, and when.
 *
 * WHY THIS EXISTS.
 *
 * The Activity Log tells you a request failed. It does not tell you whether
 * the code that failed was the code you are looking at now. The relay's
 * server.js is ~940KB and gets refactored; the ai-chat edge function is
 * ~315KB and gets refactored more often than anything else in the stack.
 * When an error fires at 14:02 and you open the file at 14:20, the lines you
 * are reading may be the ones that caused it, or may have been rewritten
 * twice since. There was no way to tell the difference, and guessing wrong
 * costs an hour.
 *
 * So each key file is fingerprinted (content hash) and snapshotted whenever
 * it changes. A snapshot row is the answer to "which version of the file was
 * live at 14:02" — the row in effect at that instant.
 *
 * The file list is deliberately small and hand-picked: the files that are
 * regularly upgraded, refactored, or that own a route a lot of traffic hits.
 * Watching every file in the repo would produce a table nobody reads.
 *
 * Two kinds of lookup are supported:
 *
 *   - versionAt(path, timestamp)  — the snapshot in effect at that moment.
 *   - routeOwner(path)            — which file registers a given HTTP route,
 *                                    so an http_error can name the file that
 *                                    owns the route it hit (and "no file owns
 *                                    this route" is itself a finding).
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { query } from './db.mjs';

// ── The files worth watching ───────────────────────────────────────────────
//
// kind: 'relay'  — the relay process itself
//       'page'   — what the operator's browser loads
//       'edge'   — a Supabase edge function
//       'cron'   — a scheduled job's implementation
//
// repo: 'root'  — the xmrtdao git repo
//       'suite' — the suite git repo (separate history)
export const KEY_INFRA_FILES = [
  { path: 'relay/server.js', label: 'relay/server.js', kind: 'relay', repo: 'root' },
  { path: 'relay/public/dashboard.js', label: 'dashboard.js', kind: 'page', repo: 'root' },
  { path: 'relay/campus-page.mjs', label: 'campus-page.mjs', kind: 'page', repo: 'root' },
  { path: 'relay/lib/db.mjs', label: 'lib/db.mjs', kind: 'relay', repo: 'root' },
  { path: 'relay/cron-engine-v2.mjs', label: 'cron-engine-v2.mjs', kind: 'cron', repo: 'root' },
  { path: 'relay/supervisor.mjs', label: 'supervisor.mjs', kind: 'relay', repo: 'root' },
  { path: 'relay/lib/log-intel.mjs', label: 'lib/log-intel.mjs', kind: 'relay', repo: 'root' },
  { path: 'suite/supabase/functions/ai-chat/index.ts', repoPath: 'supabase/functions/ai-chat/index.ts', label: 'ai-chat', kind: 'edge', repo: 'suite' },
  { path: 'suite/supabase/functions/vectorize-memory/index.ts', repoPath: 'supabase/functions/vectorize-memory/index.ts', label: 'vectorize-memory', kind: 'edge', repo: 'suite' },
  { path: 'suite/supabase/functions/extract-knowledge/index.ts', repoPath: 'supabase/functions/extract-knowledge/index.ts', label: 'extract-knowledge', kind: 'edge', repo: 'suite' },
];

// ── Caches ─────────────────────────────────────────────────────────────────
//
// Content hashing a 940KB file on every dashboard poll would be wasteful, so
// every derived value is keyed by (mtime, size). Touch a file and everything
// about it is recomputed; leave it alone and nothing is.
const statCache = new Map();     // path -> { mtimeMs, size, bytes, lines, version, functions, routes, hash }
const gitCache = new Map();      // path -> { at, data }
const GIT_TTL_MS = 60_000;

function hashOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// ── Source scanning ────────────────────────────────────────────────────────

const FN_PATTERNS = [
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\(/g,
  /(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
];
const ROUTE_PATTERN = /\b(?:app|router)\.(get|post|put|patch|delete|use|all)\(\s*['"`]([^'"`]+)['"`]/g;

function scanSource(text) {
  const functions = [];
  const seenFn = new Set();
  for (const re of FN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!seenFn.has(m[1])) {
        seenFn.add(m[1]);
        functions.push(m[1]);
      }
      if (functions.length >= 600) break;
    }
  }
  const routes = [];
  const seenRoute = new Set();
  ROUTE_PATTERN.lastIndex = 0;
  let r;
  while ((r = ROUTE_PATTERN.exec(text)) !== null) {
    const key = r[1].toUpperCase() + ' ' + r[2];
    if (seenRoute.has(key)) continue;
    seenRoute.add(key);
    routes.push({ method: r[1].toUpperCase(), path: r[2] });
    if (routes.length >= 600) break;
  }
  return { functions, routes };
}

// ── Git ────────────────────────────────────────────────────────────────────

function gitFor(relPath, repo) {
  const now = Date.now();
  const key = `${repo}:${relPath}`;
  const cached = gitCache.get(key);
  if (cached && now - cached.at < GIT_TTL_MS) return cached.data;

  let data = null;
  const cwd = repo === 'suite' ? (process.env.XMRT_SUITE_ROOT || 'suite') : '.';
  // The path git wants is relative to the repository, not to the workspace.
  // The suite is its own repository, so 'suite/supabase/functions/ai-chat' is
  // 'supabase/functions/ai-chat' as far as git is concerned — and asking git
  // for the wrong path returns nothing at all, which looks exactly like a
  // file that has never been committed.
  const gitPath = repo === 'suite' ? relPath.replace(/^suite\//, '') : relPath;
  const fmt = '%H%x1f%h%x1f%an%x1f%aI%x1f%s';
  try {
    const out = execFileSync('git', ['log', '-1', `--format=${fmt}`, '--', gitPath], {
      cwd,
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      const [sha, short, author, date, subject] = out.split('\x1f');
      // How many times this file changed in the last week — churn is a decent
      // proxy for "this file is the one being refactored right now".
      let weekCount = 0;
      try {
        const week = execFileSync('git', ['log', '--since=7.days', '--oneline', '--', gitPath], {
          cwd,
          encoding: 'utf8',
          timeout: 4000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        weekCount = week ? week.split('\n').length : 0;
      } catch { /* no week history */ }
      data = { sha, short, author, date, subject, week_commits: weekCount };
    }
  } catch { /* not a git repo, or git unavailable */ }

  gitCache.set(key, { at: now, data });
  return data;
}

// ── Scanning ───────────────────────────────────────────────────────────────

/**
 * Fingerprint one file: size, line count, content hash, the functions it
 * defines and the routes it registers.
 */
export function scanFile(absPath) {
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const cached = statCache.get(absPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;

  let bytes = st.size;
  let lines = 0;
  let version = null;
  let functions = [];
  let routes = [];
  try {
    const text = readFileSync(absPath, 'utf8');
    bytes = Buffer.byteLength(text, 'utf8');
    lines = text.length ? text.split('\n').length : 0;
    version = hashOf(text);
    const scanned = scanSource(text);
    functions = scanned.functions;
    routes = scanned.routes;
  } catch {
    /* unreadable (locked, binary) — the stat is still worth reporting */
  }

  const entry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    bytes,
    lines,
    version,
    functions,
    routes,
  };
  statCache.set(absPath, entry);
  return entry;
}

/**
 * Scan every key file. Returns one record per file, including files that are
 * missing (those are reported as missing rather than dropped, because a key
 * file that has gone missing is a finding).
 */
export function scanInfraFiles(root) {
  const out = [];
  for (const def of KEY_INFRA_FILES) {
    const abs = join(root, def.path);
    const exists = existsSync(abs);
    const scanned = exists ? scanFile(abs) : null;
    const git = exists ? gitFor(def.path, def.repo) : null;
    out.push({
      path: def.path,
      label: def.label,
      kind: def.kind,
      repo: def.repo,
      exists,
      bytes: scanned?.bytes ?? null,
      lines: scanned?.lines ?? null,
      version: scanned?.version ?? null,
      mtime: exists ? new Date(scanned.mtimeMs).toISOString() : null,
      age_minutes: exists ? Math.round((Date.now() - scanned.mtimeMs) / 60000) : null,
      functions: scanned?.functions ?? [],
      function_count: scanned?.functions?.length ?? 0,
      routes: scanned?.routes ?? [],
      route_count: scanned?.routes?.length ?? 0,
      git: git || null,
    });
  }
  // Prime the route map with the root that was actually scanned. Without
  // this, findRouteOwner() falls back to the process working directory, and
  // a caller that scanned the repository from anywhere else would get an
  // empty map and no owner for any route — a silent wrong answer rather
  // than an obvious failure.
  routeOwnerMap(root);
  return out;
}

// ── Route ownership ────────────────────────────────────────────────────────

let routeMapCache = null;
let routeRegexCache = null;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile every watched route into a matcher.
 *
 * An exact lookup is not enough: the route is registered as
 * '/api/suite/tasks/:id' and the request that 404s is
 * '/api/suite/tasks/ec372cfc'. Without this, the panel could not say which
 * file owns the route an error hit, which was the whole point of the badge.
 */
function routeMatchers() {
  if (routeRegexCache && Date.now() - routeRegexCache.at < 30_000) return routeRegexCache.list;
  const root = routeMapCache?.root || process.cwd();
  const map = routeOwnerMap(root);
  const list = [];
  for (const [path, owner] of map.entries()) {
    // The pattern is rebuilt segment by segment rather than by escaping the
    // whole path and patching it afterwards. Escaping leaves ':' alone (it is
    // not a regex metacharacter), so a patch that looks for a backslash
    // before ':' never matched and every parameterised route stayed
    // unmatchable — which is precisely the route shape that needed matching.
    let pattern;
    if (path.includes(':') || path.includes('*')) {
      const segments = path.split('/').map((seg) => {
        if (seg.startsWith(':')) return '[^/]+';
        if (seg === '*') return '.*';
        return escapeRe(seg);
      });
      pattern = '^' + segments.join('/') + '$';
    } else {
      pattern = '^' + escapeRe(path) + '$';
    }
    // A mounted router with a prefix: '/api/x' + '/y' registers as '/api/x/y'.
    if (path.endsWith('/')) pattern = pattern.replace(/\/$/, '(?:/.*)?$');
    try {
      list.push({ re: new RegExp(pattern), owner, path });
    } catch { /* an unparseable route is not a reason to fail the map */ }
  }
  routeRegexCache = { at: Date.now(), list };
  return list;
}

/**
 * path -> the file that registers it.
 *
 * Used to answer "which file owns the route that 404'd". A route that no
 * watched file registers is reported as unowned, which is exactly the signal
 * you want for a caller hitting an endpoint that was never wired up.
 */
export function routeOwnerMap(root) {
  if (routeMapCache && Date.now() - routeMapCache.at < 30_000) return routeMapCache.map;
  const map = new Map();
  for (const def of KEY_INFRA_FILES) {
    const abs = join(root, def.path);
    const scanned = scanFile(abs);
    if (!scanned) continue;
    for (const r of scanned.routes) {
      if (!map.has(r.path)) map.set(r.path, { file: def.path, label: def.label, method: r.method, kind: def.kind });
    }
  }
  routeMapCache = { at: Date.now(), map, root };
  routeRegexCache = null;
  return map;
}

/**
 * Find the owner of a route, exact match first and pattern match second.
 */
export function findRouteOwner(path) {
  if (!path) return null;
  try {
    const root = routeMapCache?.root || process.cwd();
    const map = routeOwnerMap(root);
    const exact = map.get(path);
    if (exact) return exact;
    for (const m of routeMatchers()) {
      if (m.re.test(path)) return m.owner;
    }
  } catch {
    /* a broken route map must not take the error panel down with it */
  }
  return null;
}

// ── Version history ────────────────────────────────────────────────────────

const TABLE = 'app.infra_file_versions';
let tableReady = null;

/**
 * Create the snapshot table if it is missing.
 *
 * Self-healing on purpose: the relay already creates app.inbox_emails at
 * runtime for the same reason (a migration that never ran must not take the
 * feature down with it).
 */
export async function ensureVersionTable() {
  if (tableReady) return tableReady;
  tableReady = (async () => {
    try {
      await query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        id BIGSERIAL PRIMARY KEY,
        path TEXT NOT NULL,
        version TEXT NOT NULL,
        lines INTEGER,
        bytes BIGINT,
        git_sha TEXT,
        git_subject TEXT,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_infra_file_versions_path ON ${TABLE}(path, captured_at DESC)`);
      return true;
    } catch (e) {
      console.warn('[infra-files] version table unavailable:', e.message);
      return false;
    }
  })();
  return tableReady;
}

/**
 * Record a snapshot for every file whose content changed since last time.
 * Only changes are written: a file that did not change keeps its current row.
 */
export async function recordVersions(files) {
  const ok = await ensureVersionTable();
  if (!ok) return 0;
  let written = 0;
  for (const f of files) {
    if (!f.exists || !f.version) continue;
    try {
      const existing = await query(
        `SELECT id FROM ${TABLE} WHERE path=$1 AND version=$2 LIMIT 1`,
        [f.path, f.version]
      );
      if (existing.rows.length) continue;
      await query(
        `INSERT INTO ${TABLE} (path, version, lines, bytes, git_sha, git_subject, captured_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [f.path, f.version, f.lines, f.bytes, f.git?.sha || null, f.git?.subject || null]
      );
      written++;
    } catch (e) {
      console.warn('[infra-files] snapshot write failed:', e.message);
    }
  }
  return written;
}

/**
 * The version of a file that was live at a given moment.
 *
 * Snapshots are captured when the content changes, so "in effect at T" means
 * the newest snapshot captured at or before T — and if the file had never
 * changed since before T, that is the version that was live.
 */
export async function versionAt(path, timestamp) {
  const ok = await ensureVersionTable();
  if (!ok) return null;
  try {
    const r = await query(
      `SELECT path, version, lines, bytes, git_sha, git_subject, captured_at
       FROM ${TABLE} WHERE path=$1 AND captured_at <= $2 ORDER BY captured_at DESC LIMIT 1`,
      [path, timestamp]
    );
    if (r.rows.length) return r.rows[0];
    // No snapshot before that moment: fall back to the earliest one, and say
    // so, because "we started watching later" is different from "no change".
    const first = await query(
      `SELECT path, version, lines, bytes, git_sha, git_subject, captured_at
       FROM ${TABLE} WHERE path=$1 ORDER BY captured_at ASC LIMIT 1`,
      [path]
    );
    if (first.rows.length) return { ...first.rows[0], estimated: true };
    return null;
  } catch {
    return null;
  }
}

/**
 * Version history for one file: every recorded change, newest first.
 */
export async function versionHistory(path, limit = 25) {
  const ok = await ensureVersionTable();
  if (!ok) return [];
  try {
    const r = await query(
      `SELECT version, lines, bytes, git_sha, git_subject, captured_at
       FROM ${TABLE} WHERE path=$1 ORDER BY captured_at DESC LIMIT $2`,
      [path, Math.min(limit, 100)]
    );
    return r.rows;
  } catch {
    return [];
  }
}

/**
 * Version histories for several files at once.
 *
 * The errors panel asks "which version was live when this fired" for every
 * error it shows, and one query per error would be a dozen queries for one
 * panel. This fetches the whole history of the files involved and the
 * caller resolves the timestamps in memory.
 */
export async function versionHistories(paths) {
  const list = [...new Set((paths || []).filter(Boolean))];
  if (!list.length) return {};
  const ok = await ensureVersionTable();
  if (!ok) return {};
  try {
    const r = await query(
      `SELECT path, version, lines, bytes, git_sha, git_subject, captured_at
       FROM ${TABLE} WHERE path = ANY($1) ORDER BY captured_at DESC`,
      [list]
    );
    const out = {};
    for (const row of r.rows) {
      (out[row.path] = out[row.path] || []).push(row);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The version in effect at a moment, from a fetched history.
 *
 * Returns the newest snapshot at or before the moment, and says whether it
 * is an estimate — a file that was already being watched, but whose first
 * snapshot is later than the moment asked about, is an estimate and not an
 * answer.
 */
export function versionAtFromHistory(history, path, timestamp) {
  const rows = history?.[path];
  if (!rows || !rows.length) return null;
  const t = new Date(timestamp).getTime();
  for (const row of rows) {
    if (new Date(row.captured_at).getTime() <= t) return { ...row, estimated: false };
  }
  return { ...rows[rows.length - 1], estimated: true };
}
