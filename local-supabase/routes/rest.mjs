// ──────────────────────────────────────────────────────────────
// /rest/v1/* — PostgREST-compatible REST API on top of local pg
// Supports: GET/POST/PATCH/DELETE, filters (eq/neq/gt/gte/lt/
// lte/in/like/ilike), select, order, limit, offset, embed.
// ──────────────────────────────────────────────────────────────

import { Router } from 'express';
import pg from 'pg';
import { POOL_CONFIG } from '../../relay/lib/pool-config.mjs';

const { Pool, types } = pg;

// Return bigints as numbers (PostgREST sends them as JSON numbers)
types.setTypeParser(20, (v) => v == null ? null : parseInt(v, 10)); // int8

let _pool = null;
function getPool(dbUrl) {
  if (_pool) return _pool;
  _pool = new Pool({ connectionString: dbUrl, ...POOL_CONFIG.rest });
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
  cs: '@>',      // jsonb contains (PostgREST cs.)
  cd: '<@',      // jsonb contained by
  ov: '?',       // jsonb key exists
  'contains': '@>',
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
          const m = String(part).match(/^([a-zA-Z_][\w>-]*)\s*\.\s*([a-zA-Z]+)\.\s*(.+)$/);
          if (m && OP_MAP[m[2]]) {
            const col = m[1];
            const op = m[2];
            const raw = m[3];
            // Handle JSONB column references like entity->>description
            // PG requires the key after ->> to be a string literal: entity->>'description'
            let colSql;
            if (col.includes('->>')) {
              const arrowIdx = col.indexOf('->>');
              const jsonbCol = col.slice(0, arrowIdx);
              const jsonbKey = col.slice(arrowIdx + 3);
              colSql = `"${jsonbCol}"->>'${jsonbKey}'`;
            } else {
              colSql = `"${col}"`;
            }
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
              if (['cs', 'cd', 'ov', 'contains'].includes(op)) {
                return { sql: `${colSql} ${OP_MAP[op]} $${i++}::jsonb`, args: [val], paramsUsed: 1 };
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
          } else if (['cs', 'cd', 'ov', 'contains'].includes(op)) {
            // jsonb operators: the right-hand operand must be cast to jsonb
            acc.push({ sql: `"${k}" ${OP_MAP[op]} $${i++}::jsonb`, args: [raw], paramsUsed: 1 });
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
      //
      // That fallback is fine for a read and is the actual mechanism of the
      // write hole: when `SET LOCAL role` failed, the request continued on the
      // superuser connection with no role at all, so the requested privileges
      // were the connection's rather than the caller's. A caller whose role
      // could not be applied must be refused on writes, not quietly upgraded -
      // failing open on an auth failure is the bug, not the design.
      console.warn(`[rest] could not apply role "${role}": ${e.message}`);
      const isWrite = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(
        String(req.method || '').toUpperCase());
      if (isWrite && role !== 'service_role') {
        throw Object.assign(new Error('role could not be applied to a write'), { statusCode: 500 });
      }
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
      // Validate table name (only letters, digits, underscore, and dot for schema prefix)
      if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(table)) {
        return res.status(400).json({ error: 'invalid_table_name' });
      }

      // ── Anonymous writes to authority tables are refused ──────────────
      //
      // This router had no authorisation check at all: no 401, no 403, and
      // `supabaseCtx` was read but never consulted. `clientWithAuth` does try
      // `SET LOCAL role`, but that call is wrapped in a catch that swallows
      // failure and continues on the superuser connection - so a role that
      // cannot be set silently becomes unrestricted access.
      //
      // That made `anon` able to INSERT and DELETE on every table. Proven on the
      // public relay with no credentials:
      //   DELETE /rest/v1/agents?id=eq.<nonexistent>      -> 200 []
      //   DELETE /rest/v1/suite_leads?id=eq.999999999     -> 200 []
      // (200 with an empty array is PostgREST's "authorised, matched nothing";
      // a permission failure would be 401/403/425. Nothing was deleted.)
      //
      // Why this table and not blanket-deny: the Suite SPA reads and writes
      // through /rest/v1 with the anon key, so refusing every anonymous write
      // would break product features whose legitimate write set has never been
      // enumerated. Authority tables are different in kind - they confer
      // capability - and they are the ones where an anonymous write escalates.
      // The rest is logged below so the allowlist can be built from evidence
      // rather than guesswork.
      const AUTHORITY_TABLES = new Set([
        'agents', 'cuttlefish_agents',
        'cuttlefish_trust_events',
        'xmrt_university_enrollments',
        'xmrt_university_courses',
      ]);
      const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
      const role = (req.supabaseCtx && req.supabaseCtx.role) || 'anon';
      const bare = table.includes('.') ? table.split('.').pop() : table;

      if (WRITE_METHODS.has(method) && role !== 'service_role') {
        if (AUTHORITY_TABLES.has(table) || AUTHORITY_TABLES.has(bare)) {
          console.warn(
            `[rest] REFUSED anonymous ${method} on authority table "${table}" ` +
            `(role=${role}) - anonymous writes to authority tables are not permitted`
          );
          return res.status(403).json({
            error: 'forbidden',
            detail: `"${table}" confers agent authority and cannot be written without a service-role credential.`,
          });
        }
        // Not refused yet, but recorded. This log is the input to the write
        // allowlist: whatever appears here is either a legitimate anon write
        // that needs allowlisting, or a hole.
        console.warn(
          `[rest] anon ${method} on "${table}" - allowed for now, ` +
          `recorded so the write allowlist can be built from evidence`
        );
      }
      // Handle schema-prefixed table names like "app.tasks"
      let schemaOverride = null;
      let bareTable = table;
      if (table.includes('.')) {
        const parts = table.split('.');
        schemaOverride = parts[0];
        bareTable = parts[1];
      }
      // Resolve which schema a bare table name lives in. Real PostgREST exposes
      // a configured list via `db-schemas`; we mirror that by looking up the
      // table in information_schema so any non-public schema (app, sandbox,
      // util, storage) the user creates works automatically.
      //
      // SCHEMA PRECEDENCE (2026-08-28, fixed): prefer the schema that actually
      // has DATA, so a bare-name read returns the authoritative copy instead of
      // an empty/partial one. The classic case is shared_context: it exists in
      // both `public` (8 rows) and `knowledge` (110 rows) — the old fixed order
      // `app > public > ...` resolved to `public` and silently returned 8 rows
      // when the real data lived in `knowledge`. We count rows per candidate
      // schema and pick the richest; ties break to the legacy precedence
      // (app > public > knowledge) for determinism.
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
                 table_schema`,
        [bareTable]
      );
      // Pick the candidate schema with the most rows (data-rich = authoritative).
      // An explicit schemaOverride (e.g. `knowledge.shared_context`) always wins.
      let resolvedSchema = schemaOverride || 'public';
      if (!schemaOverride && tableExistsRes.rows.length) {
        let richest = tableExistsRes.rows[0].table_schema;
        let richestCount = -1;
        for (const cand of tableExistsRes.rows) {
          const s = cand.table_schema;
          try {
            const cnt = await pool.query(`SELECT count(*) AS c FROM "${s}"."${bareTable}"`);
            const n = Number(cnt.rows[0]?.c || 0);
            if (n > richestCount) { richestCount = n; richest = s; }
          } catch { /* skip schemas we can't count */ }
        }
        resolvedSchema = richest;
      }
      const fullTable = `"${resolvedSchema}"."${bareTable}"`;

      // ── Unmapped / missing table detection (Vex: inverse-drift visibility) ──
      // If a bare table resolves to a schema but doesn't actually exist there
      // (phantom), or a schema-overridden table is absent, log it so the
      // missing-reference 500 class is visible in ship logs even though it
      // isn't boot-time fatal. Catches the "no map entry at all" case (e.g.
      // interaction_patterns) that the boot-time drift check cannot see.
      if (!tableExistsRes.rows.length) {
        console.warn(`[rest-resolver] ⚠️ table "${bareTable}" not found in any schema (requested ${req.method} ${req.path}). Phantom-relation 500 likely.`);
      } else if (schemaOverride && !tableExistsRes.rows.some(r => r.table_schema === schemaOverride)) {
        console.warn(`[rest-resolver] ⚠️ "${schemaOverride}.${bareTable}" does not exist (schema-overridden reference resolves to ${tableExistsRes.rows[0].table_schema}).`);
      }

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
            const setArgs = cols.map((c) => {
              const val = body[c];
              // pg serializes JS arrays as PG array literals ({1,2,3}) instead of
              // JSON ([1,2,3]). For jsonb columns we need the JSON form, so
              // stringify any array/object value before passing to pg.query().
              // But for integer[] / text[] columns, we need PG array format.
              if (Array.isArray(val)) {
                // Convert JS array to PG array literal: [1,2,3] -> {1,2,3}
                return '{' + val.map(v => typeof v === 'string' ? `"${v.replace(/"/g, '\\"')}"` : v).join(',') + '}';
              }
              if (typeof val === 'object' && val !== null) {
                return JSON.stringify(val);
              }
              return val;
            });
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
