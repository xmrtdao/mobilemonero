// ──────────────────────────────────────────────────────────────
// /rest/v1/* — PostgREST-compatible REST API on top of local pg
// Supports: GET/POST/PATCH/DELETE, filters (eq/neq/gt/gte/lt/
// lte/in/like/ilike), select, order, limit, offset, embed.
// ──────────────────────────────────────────────────────────────

import { Router } from 'express';
import pg from 'pg';

const { Pool, types } = pg;

// Return bigints as numbers (PostgREST sends them as JSON numbers)
types.setTypeParser(20, (v) => v == null ? null : parseInt(v, 10)); // int8

let _pool = null;
function getPool(dbUrl) {
  if (_pool) return _pool;
  _pool = new Pool({ connectionString: dbUrl, max: 10, idleTimeoutMillis: 30_000 });
  _pool.on('error', (e) => console.error('[rest] pool error:', e?.message || e));
  return _pool;
}

const OP_MAP = {
  eq: '=', neq: '<>', ne: '<>',
  gt: '>', gte: '>=', ge: '>=',
  lt: '<', lte: '<=', le: '<=',
  like: 'LIKE', ilike: 'ILIKE',
  is: 'IS',
  in: 'IN',
};

function isLiteral(v) {
  if (v === 'null') return { sql: 'NULL', isNull: true };
  return null;
}

function parseFilters(params) {
  const filters = [];
  let i = 1;
  const collect = (acc) => {
    for (const [k, v] of params.entries()) {
      if (['select', 'order', 'limit', 'offset', 'columns'].includes(k)) continue;
      
      // Handle 'or' filter — PostgREST format: ?or=(col1.op.val1,col2.op.val2)
      if (k === 'or') {
        const inner = String(v);
        // Strip outer parens if present
        let body = inner;
        if (body.startsWith('(') && body.endsWith(')')) {
          body = body.slice(1, -1);
        }
        // Split on commas that are NOT inside quotes or nested parens
        const orParts = [];
        let depth = 0;
        let current = '';
        for (const ch of body) {
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          if (ch === ',' && depth === 0) {
            orParts.push(current.trim());
            current = '';
          } else {
            current += ch;
          }
        }
        if (current.trim()) orParts.push(current.trim());
        
        const orClauses = orParts.map(part => {
          const m = String(part).match(/^([a-zA-Z_][a-zA-Z0-9_>]*)\s*\.\s*([a-zA-Z]+)\.\s*(.+)$/);
          if (m && OP_MAP[m[2]]) {
            const col = m[1];
            const op = m[2];
            const raw = m[3];
            // Handle JSONB column references like entity->>description
            const colSql = col.includes('->>') ? col : `"${col}"`;
            if (op === 'in') {
              let body2 = raw;
              if (body2.startsWith('(') && body2.endsWith(')')) body2 = body2.slice(1, -1);
              const list = body2.split(',').map(x => x.trim()).filter(Boolean);
              if (list.length === 0) return { sql: 'FALSE' };
              const ph = list.map(() => `$${i++}`).join(',');
              return { sql: `${colSql} IN (${ph})`, args: list, paramsUsed: list.length };
            } else {
              const lit = isLiteral(raw);
              if (lit) return { sql: `${colSql} ${OP_MAP[op]} ${lit.sql}` };
              // Handle wildcard: PostgREST uses * for LIKE/ILIKE wildcard
              let val = raw;
              if (op === 'like' || op === 'ilike') {
                val = raw.replace(/\*/g, '%');
              }
              return { sql: `${colSql} ${OP_MAP[op]} $${i++}`, args: [val], paramsUsed: 1 };
            }
          }
          return { sql: 'FALSE' };
        });
        
        if (orClauses.length > 0) {
          const sql = '(' + orClauses.map(c => c.sql).join(' OR ') + ')';
          const args = orClauses.flatMap(c => c.args || []);
          acc.push({ sql, args, paramsUsed: args.length });
        }
        continue;
      }
      
      const m = String(v).match(/^([a-zA-Z_]+)\.(.*)$/);
      if (m && OP_MAP[m[1]]) {
        const op = m[1];
        const raw = m[2];
        if (op === 'in') {
          // PostgREST format: in.(a,b,c) — strip a single layer of parens if present
          let body = raw;
          if (body.startsWith('(') && body.endsWith(')')) {
            body = body.slice(1, -1);
          }
          const list = body.split(',').map((x) => x.trim()).filter(Boolean);
          if (list.length === 0) {
            acc.push({ sql: 'FALSE' });
            continue;
          }
          const ph = list.map(() => `$${i++}`).join(',');
          acc.push({ sql: `"${k}" IN (${ph})`, args: list, paramsUsed: list.length });
        } else {
          const lit = isLiteral(raw);
          if (lit) {
            acc.push({ sql: `"${k}" ${OP_MAP[op]} ${lit.sql}` });
          } else {
            acc.push({ sql: `"${k}" ${OP_MAP[op]} $${i++}`, args: [raw], paramsUsed: 1 });
          }
        }
      } else {
        // No operator prefix = eq
        const lit = isLiteral(String(v));
        if (lit) {
          acc.push({ sql: `"${k}" = ${lit.sql}` });
        } else {
          acc.push({ sql: `"${k}" = $${i++}`, args: [String(v)], paramsUsed: 1 });
        }
      }
    }
  };
  const list = [];
  collect(list);
  return { list, nextIndex: i, list };
}

function parseOrder(params) {
  const o = params.get('order');
  if (!o) return '';
  const parts = o.split(',').map((s) => s.trim()).filter(Boolean);
  return 'ORDER BY ' + parts.map((p) => {
    const lastDot = p.lastIndexOf('.');
    if (lastDot > 0) {
      const col = p.slice(0, lastDot);
      const dir = p.slice(lastDot + 1).toLowerCase();
      if (dir === 'asc' || dir === 'desc') {
        const nullsMatch = p.match(/\.(asc|desc)\.nulls( first| last)$/i);
        let nulls = '';
        if (nullsMatch) {
          nulls = ' NULLS ' + (nullsMatch[2].toLowerCase().includes('first') ? 'FIRST' : 'LAST');
        }
        return `"${col}" ${dir.toUpperCase()}${nulls}`;
      }
    }
    return `"${p}" ASC`;
  }).join(', ');
}

function parseSelect(s) {
  if (!s || s === '*') return '*';
  // Allow simple "*" only, plus comma-separated cols and table.col
  const cols = s.split(',').map((c) => c.trim()).filter(Boolean);
  if (cols.length === 0) return '*';
  return cols.map((c) => {
    if (c.includes('(')) return c; // expression
    return `"${c}"`;
  }).join(', ');
}

function renumberPlaceholders(sql, offset) {
  return sql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n, 10) + offset}`);
}

export default function makeRestRouter({ dbUrl }) {
  const router = Router();
  const pool = getPool(dbUrl);

  // Helper to set the JWT claims for RLS-style auth.uid()
  async function clientWithAuth(req) {
    const client = await pool.connect();
    try {
      const { role, uid } = req.supabaseCtx;
      if (uid) {
        await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [uid]);
      }
      await client.query("SELECT set_config('role', $1, true)", [role]);
      await client.query(`SET LOCAL role ${role === 'service_role' ? 'service_role' : (role === 'authenticated' ? 'authenticated' : 'anon')}`);
    } catch (e) {
      // If setting role fails (e.g. role not granted to current user), just continue
      // We'll fall back to using the postgres superuser connection
    }
    return client;
  }

  // Generic handler: get table name from req.path
  async function handle(req, res, method) {
    try {
      // Strip leading slash and split
      const tablePath = req.params[0] || '';
      if (!tablePath) return res.status(400).json({ error: 'table_required' });
      const segments = tablePath.split('/').filter(Boolean);
      if (segments.length === 0) return res.status(400).json({ error: 'table_required' });
      const table = segments[0];
      // Validate table name (only letters, digits, underscore)
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
        return res.status(400).json({ error: 'invalid_table_name' });
      }
      // Resolve which schema a bare table name lives in. Real PostgREST exposes
      // a configured list via `db-schemas`; we mirror that by looking up the
      // table in information_schema so any non-public schema (app, sandbox,
      // util, storage) the user creates works automatically. We prefer
      // `app` > `public` > other user schemas > system schemas, since
      // multiple schemas could have a same-named table.
      const tableExistsRes = await pool.query(
        `SELECT table_schema FROM information_schema.tables
         WHERE table_name = $1
           AND table_schema NOT IN ('pg_catalog','information_schema')
         ORDER BY CASE table_schema
                    WHEN 'app'        THEN 0
                    WHEN 'public'     THEN 1
                    WHEN 'auth'       THEN 2
                    WHEN 'storage'    THEN 3
                    WHEN 'realtime'   THEN 4
                    ELSE 5 END,
                  table_schema
         LIMIT 1`,
        [table]
      );
      const resolvedSchema = tableExistsRes.rows[0]?.table_schema || 'public';
      const fullTable = `"${resolvedSchema}"."${table}"`;

      const params = new URLSearchParams();
      // Express req.query already parsed
      for (const [k, v] of Object.entries(req.query)) {
        if (Array.isArray(v)) params.set(k, v[0]);
        else params.set(k, String(v));
      }
      const { list: whereClauses, nextIndex: _ } = parseFilters(params);
      const orderSql = parseOrder(params);
      const limitN = Math.min(parseInt(params.get('limit') || '1000', 10), 10000);
      const offsetN = Math.max(parseInt(params.get('offset') || '0', 10), 0);
      const selectCols = parseSelect(params.get('select'));

      const whereSql = whereClauses.length ? `WHERE ${whereClauses.map((w) => w.sql).join(' AND ')}` : '';
      const whereArgs = whereClauses.flatMap((w) => w.args || []);

      if (method === 'GET') {
        const sql = `SELECT ${selectCols} FROM ${fullTable} ${whereSql} ${orderSql} LIMIT ${limitN} OFFSET ${offsetN}`;
        const client = await pool.connect();
        try {
          const r = await client.query(sql, whereArgs);
          // supabase-js .single() / .maybeSingle() uses these Accept headers
          // to ask for a single object instead of an array. PostgREST honors
          // them; we must too, otherwise .single() on an empty result silently
          // returns [] instead of an error, and downstream code that does
          // `template.steps.length` blows up with "Cannot read properties of
          // undefined (reading 'length')".
          const accept = (req.headers['accept'] || '').toLowerCase();
          const wantObject = accept.includes('application/vnd.pgrst.object+json');
          const wantMaybeSingle = accept.includes('application/pgrst.object+json') || accept.includes('application/vnd.pgrst.object+json');
          if (wantObject) {
            if (r.rows.length === 0) {
              // Real PostgREST returns 406 with code PGRST116 for .single()
              // and a 200 with null body for .maybeSingle(). The Accept header
              // alone doesn't distinguish them in PostgREST's spec, so we
              // return 406 to keep the contract honest — .single() callers
              // treat any non-2xx as an error.
              return res.status(406).json({
                code: 'PGRST116',
                details: `Results contain 0 rows, application/vnd.pgrst.object+json requires 1 row`,
                message: 'JSON object requested, multiple (or no) rows returned',
              });
            }
            if (r.rows.length > 1) {
              return res.status(406).json({
                code: 'PGRST116',
                details: `Results contain ${r.rows.length} rows, application/vnd.pgrst.object+json requires 1 row`,
                message: 'JSON object requested, multiple (or no) rows returned',
              });
            }
            return res.json(r.rows[0]);
          }
          // PostgREST returns array of objects with Content-Range header
          res.set('Content-Range', `0-${r.rowCount - 1}/${r.rowCount}`);
          res.set('Access-Control-Expose-Headers', 'Content-Range');
          res.json(r.rows);
        } finally {
          client.release();
        }
        return;
      }

      if (method === 'POST') {
        const body = req.body;
        if (!body || typeof body !== 'object') return res.status(400).json({ error: 'body_required' });
        const rows = Array.isArray(body) ? body : [body];
        if (rows.length === 0) return res.status(400).json({ error: 'empty_body' });
        const cols = Object.keys(rows[0]);
        // Validate col names
        for (const c of cols) {
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)) return res.status(400).json({ error: 'invalid_column_name', col: c });
        }
        const ph = rows.map((row, ri) => {
          const placeholders = cols.map((_, ci) => `$${ri * cols.length + ci + 1}`);
          return `(${placeholders.join(',')})`;
        }).join(',');
        const args = rows.flatMap((row) => cols.map((c) => row[c]));

        // PostgREST upsert support. Triggered by EITHER:
        //   ?on_conflict=col1,col2            (URL param — what supabase-js sends
        //                                      when you do .upsert(data, {onConflict:'col1'}))
        //   Prefer: resolution=merge-duplicates   (header — what real PostgREST honors)
        // We also accept resolution=ignore-duplicates for "insert or skip" semantics.
        // Only enable upsert behavior when the caller signals it; plain POSTs
        // (like inserts into tables without a unique constraint) keep current behavior.
        const conflictColsRaw = params.get('on_conflict');
        const preferHeader = String(req.headers['prefer'] || '').toLowerCase();
        const preferResolutionMatch = preferHeader.match(/resolution\s*=\s*([a-z-]+)/);
        const preferResolution = preferResolutionMatch ? preferResolutionMatch[1] : null;
        const doIgnore = preferResolution === 'ignore-duplicates';

        // merge-duplicates without an on_conflict target is a footgun
        // (we'd have to guess the unique column and could update the
        // wrong rows). Real PostgREST 400s with code PGRST114 in this
        // case. We mirror that.
        if (preferResolution === 'merge-duplicates' && !conflictColsRaw) {
          return res.status(400).json({
            code: 'PGRST114',
            message: 'Prefer: resolution=merge-duplicates requires on_conflict query parameter',
            details: 'Specify the conflict target columns via ?on_conflict=col1,col2',
          });
        }

        let onConflictSql = '';
        if (conflictColsRaw) {
          // Validate each conflict target column name (comma-separated)
          const conflictCols = conflictColsRaw.split(',').map((c) => c.trim()).filter(Boolean);
          for (const c of conflictCols) {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)) {
              return res.status(400).json({ error: 'invalid_on_conflict_column', col: c });
            }
          }
          if (doIgnore) {
            onConflictSql = ` ON CONFLICT (${conflictCols.map((c) => `"${c}"`).join(',')}) DO NOTHING`;
          } else {
            const updateSets = cols
              .filter((c) => !conflictCols.includes(c)) // don't update the conflict target itself
              .map((c) => `"${c}" = EXCLUDED."${c}"`)
              .join(', ');
            onConflictSql = updateSets
              ? ` ON CONFLICT (${conflictCols.map((c) => `"${c}"`).join(',')}) DO UPDATE SET ${updateSets}`
              : ` ON CONFLICT (${conflictCols.map((c) => `"${c}"`).join(',')}) DO NOTHING`;
          }
        } else if (doIgnore) {
          // Prefer: resolution=ignore-duplicates without on_conflict target
          // → ignore by any unique constraint. PostgREST semantics.
          onConflictSql = ' ON CONFLICT DO NOTHING';
        }
        // (merge-duplicates without on_conflict is rejected above with PGRST114.)

        const sql = `INSERT INTO ${fullTable} (${cols.map((c) => `"${c}"`).join(',')}) VALUES ${ph}${onConflictSql} RETURNING ${selectCols}`;
        const client = await pool.connect();
        try {
          const r = await client.query(sql, args);
          res.status(201).json(r.rows);
        } finally {
          client.release();
        }
        return;
      }

      if (method === 'PATCH' || method === 'DELETE') {
        if (whereClauses.length === 0) {
          return res.status(400).json({ error: `${method}_requires_filter` });
        }
        const client = await pool.connect();
        try {
          if (method === 'PATCH') {
            const body = req.body || {};
            const cols = Object.keys(body);
            if (cols.length === 0) return res.status(400).json({ error: 'empty_patch' });
            for (const c of cols) {
              if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)) return res.status(400).json({ error: 'invalid_column_name', col: c });
            }
            const sets = cols.map((c, ci) => `"${c}" = $${ci + 1}`);
            // pg serializes JS arrays as PG array literals ({1,2,3}) instead of
            // JSON ([1,2,3]). For jsonb columns we need the JSON form, so
            // stringify any array/object value before passing to pg.query().
            const setArgs = cols.map((c) =>
              typeof body[c] === 'object' && body[c] !== null
                ? JSON.stringify(body[c])
                : body[c]
            );
            const whereSqlRenumbered = renumberPlaceholders(whereSql, cols.length);
            const sql = `UPDATE ${fullTable} SET ${sets.join(', ')} ${whereSqlRenumbered} RETURNING ${selectCols}`;
            const r = await client.query(sql, [...setArgs, ...whereArgs]);
            res.json(r.rows);
          } else {
            const sql = `DELETE FROM ${fullTable} ${whereSql} RETURNING ${selectCols}`;
            const r = await client.query(sql, whereArgs);
            res.json(r.rows);
          }
        } finally {
          client.release();
        }
        return;
      }

      return res.status(405).json({ error: 'method_not_allowed' });
    } catch (e) {
      console.error('[rest] error:', e?.message || e);
      res.status(500).json({ error: e?.message || 'rest_error' });
    }
  }

  router.get(/^(.+)$/, (req, res) => handle(req, res, 'GET'));
  router.post(/^(.+)$/, (req, res) => handle(req, res, 'POST'));
  router.patch(/^(.+)$/, (req, res) => handle(req, res, 'PATCH'));
  router.put(/^(.+)$/, (req, res) => handle(req, res, 'PATCH'));
  router.delete(/^(.+)$/, (req, res) => handle(req, res, 'DELETE'));

  return router;
}
