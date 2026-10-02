#!/usr/bin/env node
/**
 * fleet-memory.mjs — shared memory helpers for the local-sb fleet
 *
 * Talks to app.fleet_memory (created in 2026-06-10_fleet_memory.sql).
 * Schema: agent_id, agent_role, memory_type, scope, title, body, payload, refs, confidence, ttl_at
 *
 * Design notes:
 *   - All agents write structured observations here; everyone reads.
 *   - Use trigram search (title/body) for "what did we say about X" since
 *     pgvector isn't installed. See supabase/local-migrations/...
 *   - preferLocal() falls back to the cloud Supabase URL only if the local
 *     server is unreachable, so the app can still work without the local stack.
 *   - All writes go through writeMemory() which clamps the body length, sets
 *     defaults, and returns the inserted row.
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

const LOCAL_URL = process.env.LOCAL_SUPABASE_URL || 'http://127.0.0.1:54321';
const LOCAL_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || 'local-dev-no-auth';
const CLOUD_URL = process.env.SUPABASE_URL || '';
const CLOUD_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const DEFAULT_AGENT_ROLE = 'observer';
const MAX_BODY = 4000;     // keep entries readable
const MAX_TITLE = 200;
const DEFAULT_TTL_HOURS = 168; // 7 days for working memory

// ── HTTP helpers (tiny — no fetch dependency surprises) ─────
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      timeout: options.timeout || 10_000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const code = res.statusCode;
        if (code >= 200 && code < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve({ raw: data, status: code }); }
        } else {
          reject(new Error(`HTTP ${code}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

async function postgrest(opts) {
  const { base, key } = await resolveBase();
  const url = `${base}/rest/v1/${opts.path}`;
  return request(url, {
    method: opts.method || 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(opts.prefer ? { Prefer: opts.prefer } : {}),
    },
    body: opts.body,
    timeout: opts.timeout,
  });
}

// ── Local-first with cloud fallback ─────────────────────────
let cachedBase = null;
let cachedKey = null;
let cachedAt = 0;
const RESOLVE_TTL_MS = 30_000;

async function resolveBase() {
  // Cache the working base for 30s to avoid hammering health checks
  if (cachedBase && Date.now() - cachedAt < RESOLVE_TTL_MS) {
    return { base: cachedBase, key: cachedKey };
  }
  // Try local first — probe the fleet_memory table so we know it's the
  // real local stack (not just a process on the port).
  try {
    const r = await request(`${LOCAL_URL}/rest/v1/fleet_memory?select=id&limit=1`, {
      method: 'GET',
      headers: { apikey: LOCAL_KEY, Authorization: `Bearer ${LOCAL_KEY}` },
      timeout: 3000,
    });
    // If we get an array (even empty) or a non-error response, the local
    // stack has the table. Treat 200/206 as "ok". PostgREST may return []
    // for empty results.
    cachedBase = LOCAL_URL;
    cachedKey = LOCAL_KEY;
    cachedAt = Date.now();
    return { base: cachedBase, key: cachedKey };
  } catch (e) {
    // fall through to cloud
  }
  // Cloud fallback
  if (CLOUD_URL && CLOUD_KEY) {
    cachedBase = CLOUD_URL;
    cachedKey = CLOUD_KEY;
    cachedAt = Date.now();
    return { base: cachedBase, key: cachedKey };
  }
  throw new Error('No Supabase available (local + cloud both unreachable)');
}

// ── Public API ──────────────────────────────────────────────

/**
 * Write a single memory entry.
 * @param {object} entry
 *   agent_id (req) agent_role, memory_type, scope, title (req), body (req),
 *   payload, refs, confidence, ttl_hours (default 168 = 7d)
 * @returns {object} inserted row, or null on failure
 */
export async function writeMemory(entry) {
  if (!entry || !entry.agent_id || !entry.title || !entry.body) {
    throw new Error('writeMemory: agent_id, title, and body are required');
  }
  const row = {
    agent_id: entry.agent_id,
    agent_role: entry.agent_role || DEFAULT_AGENT_ROLE,
    memory_type: entry.memory_type || 'observation',
    scope: entry.scope || 'fleet',
    title: String(entry.title).slice(0, MAX_TITLE),
    body: String(entry.body).slice(0, MAX_BODY),
    payload: entry.payload || {},
    refs: entry.refs || [],
    confidence: typeof entry.confidence === 'number' ? entry.confidence : 1.0,
  };
  if (entry.ttl_hours || entry.ttl_hours === 0) {
    const hours = entry.ttl_hours;
    if (hours > 0) {
      row.ttl_at = new Date(Date.now() + hours * 3_600_000).toISOString();
    }
  } else if (row.ttl_at === undefined) {
    row.ttl_at = new Date(Date.now() + DEFAULT_TTL_HOURS * 3_600_000).toISOString();
  }
  try {
    const data = await postgrest({
      path: 'fleet_memory',
      method: 'POST',
      prefer: 'return=representation',
      body: [row],
    });
    return Array.isArray(data) ? data[0] : data;
  } catch (e) {
    console.error('[fleet-memory] write failed:', e.message);
    return null;
  }
}

/**
 * Bulk write — used at end of each cycle. Returns count of successful writes.
 */
export async function writeMemoryBatch(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return { written: 0 };
  const rows = entries
    .filter(e => e && e.agent_id && e.title && e.body)
    .map(e => ({
      agent_id: e.agent_id,
      agent_role: e.agent_role || DEFAULT_AGENT_ROLE,
      memory_type: e.memory_type || 'observation',
      scope: e.scope || 'fleet',
      title: String(e.title).slice(0, MAX_TITLE),
      body: String(e.body).slice(0, MAX_BODY),
      payload: e.payload || {},
      refs: e.refs || [],
      confidence: typeof e.confidence === 'number' ? e.confidence : 1.0,
      ttl_at: e.ttl_hours
        ? new Date(Date.now() + e.ttl_hours * 3_600_000).toISOString()
        : new Date(Date.now() + DEFAULT_TTL_HOURS * 3_600_000).toISOString(),
    }));
  if (rows.length === 0) return { written: 0 };
  try {
    await postgrest({
      path: 'fleet_memory',
      method: 'POST',
      prefer: 'return=minimal',
      body: rows,
    });
    return { written: rows.length };
  } catch (e) {
    console.error('[fleet-memory] batch write failed:', e.message);
    return { written: 0, error: e.message };
  }
}

/**
 * Read recent memories. Optional filter: scope, agent_id, memory_type, hours.
 */
export async function readRecent({ scope, agent_id, memory_type, hours = 24, limit = 50 } = {}) {
  const filters = [];
  if (scope) filters.push(`scope=eq.${encodeURIComponent(scope)}`);
  if (agent_id) filters.push(`agent_id=eq.${encodeURIComponent(agent_id)}`);
  if (memory_type) filters.push(`memory_type=eq.${encodeURIComponent(memory_type)}`);
  filters.push(`created_at=gte.${new Date(Date.now() - hours * 3_600_000).toISOString()}`);
  filters.push(`order=created_at.desc`);
  filters.push(`limit=${limit}`);
  try {
    const data = await postgrest({
      path: `fleet_memory?${filters.join('&')}`,
      method: 'GET',
    });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[fleet-memory] read failed:', e.message);
    return [];
  }
}

/**
 * Trigram search across title + body. Use this for "what did we say about X".
 * Returns the top N rows ordered by trigram similarity (PostgREST rpc would be
 * faster; this is a simple ilike fallback that still works with the GIN index).
 */
export async function searchText(query, { hours = 168, limit = 20 } = {}) {
  if (!query || query.length < 2) return [];
  const q = query.replace(/[%_]/g, '\\$&');
  const filters = [
    `or=(title.ilike.*${encodeURIComponent(q)}*,body.ilike.*${encodeURIComponent(q)}*)`,
    `created_at=gte.${new Date(Date.now() - hours * 3_600_000).toISOString()}`,
    `order=created_at.desc`,
    `limit=${limit}`,
  ];
  try {
    const data = await postgrest({
      path: `fleet_memory?${filters.join('&')}`,
      method: 'GET',
    });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[fleet-memory] search failed:', e.message);
    return [];
  }
}

/**
 * Read the open_questions view — questions/contradictions from the last 7d.
 * Used by the daily goal-tender (future) and the on-demand mention handler.
 */
export async function readOpenQuestions({ limit = 20 } = {}) {
  try {
    const data = await postgrest({
      path: `fleet_memory_open_questions?order=created_at.desc&limit=${limit}`,
      method: 'GET',
    });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[fleet-memory] open_questions failed:', e.message);
    return [];
  }
}

export const _internals = { resolveBase, request, postgrest };
