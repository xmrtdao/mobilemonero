// ── Local Postgres client ────────────────────────────────────
// Direct pg connection to local Postgres. Used for the few
// DB-bound calls the relay makes (task status updates, etc.)
// when running in LOCAL_DB mode (no cloud Supabase REST).

import pg from 'pg';
import { POOL_CONFIG } from './pool-config.mjs';
const { Pool } = pg;

const LOCAL_DB_URL = process.env.LOCAL_DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';

let _pool = null;
let _ready = false;

export function getPool() {
  if (_pool) return _pool;
  _pool = new Pool({
    connectionString: LOCAL_DB_URL,
    ...POOL_CONFIG.localDb,
  });
  _pool.on('error', (err) => {
    console.error('[localDb] idle client error:', err?.message || err);
  });
  return _pool;
}

export async function ensureLocalDb() {
  if (_ready) return _ready;
  try {
    const pool = getPool();
    const res = await pool.query('SELECT 1 AS ok, current_database() AS db, version() AS v');
    console.log(`[localDb] connected: db=${res.rows[0].db}`);
    _ready = true;
  } catch (e) {
    console.error('[localDb] connect failed:', e?.message || e);
    _ready = false;
  }
  return _ready;
}

export const LOCAL_DB_ENABLED = (process.env.LOCAL_DB_MODE ?? 'true') === 'true';

/**
 * Run a parameterized query. Caller passes $1, $2 placeholders.
 * Returns rows array.
 */
export async function query(text, params) {
  const pool = getPool();
  const res = await pool.query(text, params);
  return res.rows;
}

export async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows[0] || null;
}

/**
 * Build a small PostgREST-compatible adapter for the relay's
 * existing supabaseFetch() calls. Accepts (method, path, opts)
 * where path looks like "tasks?id=eq.<uuid>" or "tasks".
 * Body and params match what supabaseFetch() already supplies.
 */
export async function restFetch(method, path, opts = {}) {
  const [table, queryStr = ''] = path.split('?', 2);
  // Handle schema-prefixed table names like "app.tasks"
  let schema = 'public';
  let bareTable = table;
  if (table.includes('.')) {
    const parts = table.split('.');
    schema = parts[0];
    bareTable = parts[1];
  }
  const fullTable = `"${schema}"."${bareTable}"`;
  const params = new URLSearchParams(queryStr);
  // Merge opts.params so callers (the relay) can pass filters as an object
  if (opts.params && typeof opts.params === 'object') {
    for (const [k, v] of Object.entries(opts.params)) {
      params.set(k, v);
    }
  }
  const filters = {};

  for (const [k, v] of params.entries()) {
    if (k === 'select' || k === 'order' || k === 'limit' || k === 'offset') continue;
    const m = v.match(/^(eq|neq|gt|gte|lt|lte|in|like|ilike)\.(.*)$/);
    if (m) {
      filters[k] = { op: m[1], val: m[2] };
    } else {
      filters[k] = { op: 'eq', val: v };
    }
  }

  const selectCols = params.get('select') || '*';
  // Parse order param. Supports "col", "col.desc", "col.asc", or comma-separated "col1.desc,col2"
  let orderBy = '';
  if (params.get('order')) {
    const parts = params.get('order').split(',').map((s) => s.trim()).filter(Boolean);
    orderBy = parts.map((p) => {
      const lastDot = p.lastIndexOf('.');
      if (lastDot > 0) {
        const col = p.slice(0, lastDot);
        const dir = p.slice(lastDot + 1).toLowerCase();
        if (dir === 'asc' || dir === 'desc') return `"${col}" ${dir.toUpperCase()}`;
      }
      return `"${p}" ASC`;
    }).join(', ');
    orderBy = 'ORDER BY ' + orderBy;
  }
  const limitN = parseInt(params.get('limit') || '1000', 10);
  const offsetN = parseInt(params.get('offset') || '0', 10);

  const where = [];
  const args = [];
  let i = 1;
  for (const [col, f] of Object.entries(filters)) {
    if (f.op === 'eq') {
      where.push(`"${col}" = $${i++}`);
      args.push(f.val);
    } else if (f.op === 'in') {
      const list = f.val.split(',').map((x) => x.trim()).filter(Boolean);
      const ph = list.map(() => `$${i++}`).join(',');
      where.push(`"${col}" IN (${ph})`);
      args.push(...list);
    } else if (f.op === 'like' || f.op === 'ilike') {
      where.push(`"${col}" ${f.op === 'ilike' ? 'ILIKE' : 'LIKE'} $${i++}`);
      args.push(f.val);
    } else {
      where.push(`"${col}" ${f.op} $${i++}`);
      args.push(f.val);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = orderBy;

  if (method === 'GET') {
    const sql = `SELECT ${selectCols} FROM ${fullTable} ${whereSql} ${orderSql} LIMIT ${limitN} OFFSET ${offsetN}`;
    return await query(sql, args);
  }

  if (method === 'PATCH') {
    const body = opts.body || {};
    const sets = [];
    const uargs = [];
    let j = 1;
    for (const [k, v] of Object.entries(body)) {
      sets.push(`"${k}" = $${j++}`);
      uargs.push(v);
    }
    if (!where.length) {
      throw new Error('PATCH requires a filter (e.g. ?id=eq.<uuid>)');
    }
    const allArgs = [...uargs, ...args];
    const sql = `UPDATE ${fullTable} SET ${sets.join(', ')} ${whereSql.replace(/\$(\d+)/g, (_, n) => '$' + (parseInt(n, 10) + uargs.length))} RETURNING ${selectCols}`;
    return await query(sql, allArgs);
  }

  if (method === 'POST') {
    const body = opts.body || {};
    const cols = Object.keys(body);
    const vals = cols.map((c) => body[c]);
    const ph = cols.map((_, idx) => `$${idx + 1}`);
    const sql = `INSERT INTO ${fullTable} (${cols.map((c) => '"' + c + '"').join(',')}) VALUES (${ph.join(',')}) RETURNING ${selectCols}`;
    return await query(sql, vals);
  }

  if (method === 'DELETE') {
    const sql = `DELETE FROM ${fullTable} ${whereSql}`;
    return await query(sql, args);
  }

  throw new Error(`Unsupported method: ${method}`);
}
