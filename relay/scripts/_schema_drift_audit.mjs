#!/usr/bin/env node
/**
 * relay/scripts/_schema_drift_audit.mjs — is app/public actually the same?
 *
 * ── Why this exists rather than `_inspect_schema.mjs` ───────────────────────
 *
 * There are already twenty tables with the same name in more than one schema. Two
 * of them bit during the fleet work: `public.fleet_messages` is the live fleet
 * board, `app.fleet_messages` does not exist, and the drift checker's own table
 * list in server.js names the `public` one. But `app.tasks` and `app.agents`
 * returned exactly the row counts of their `public` twins — which is the
 * dangerous shape. A duplicate that answers identically is not a loud failure; it
 * is a working query that will start answering something else the moment the two
 * copies diverge, and nothing will say so.
 *
 * `_inspect_schema.mjs` dumps columns for tables named in advance. That cannot
 * answer "which of these twenty duplicates are safe", because the question needs
 * to be asked of all of them, including the ones nobody suspects.
 *
 * So this asks three questions of the whole estate rather than a hand-picked list:
 *
 *   1. Which tables exist in more than one schema, and do the copies AGREE?
 *      Compared by column set and row count, because identical counts with
 *      different columns is the case that fools a reader.
 *   2. Which tables carry no `tenant_id`? A shared table with no tenant column is
 *      readable by every tenant, and that is the cross-tenant drift the owner is
 *      actually asking about.
 *   3. For the tables this session touches, which schema is real — base table,
 *      view, or something information_schema lists but a query cannot read?
 *
 * Read-only. It SELECTs and introspects, and creates nothing.
 *
 * Run: node relay/scripts/_schema_drift_audit.mjs
 * Env: LOCAL_DATABASE_URL (falls back to the shipped inspector's local URL)
 */

import fs from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

// Prefer the same env the relay uses, so this audits the database the relay
// actually talks to rather than a hardcoded localhost guess.
function connectionString() {
  if (process.env.LOCAL_DATABASE_URL) return process.env.LOCAL_DATABASE_URL;
  const envPath = new URL('../../relay/.env', import.meta.url);
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    const m = raw.match(/^LOCAL_DATABASE_URL=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return 'postgres://postgres@127.0.0.1:5432/xmrt_suite';
}

const SCHEMAS = ['app', 'public', 'knowledge', 'auth'];
const pool = new Pool({ connectionString: connectionString() });

const safe = async (sql, params = []) => {
  try { return await pool.query(sql, params); }
  catch (e) { return { rows: [], failed: e.code || e.message }; }
};

async function main() {
  console.log('='.repeat(74));
  console.log('  SCHEMA DRIFT AUDIT');
  console.log(`  ${new Date().toISOString()}`);
  console.log('='.repeat(74));

  // ── 1. duplicates ─────────────────────────────────────────────────────────
  const dupes = await pool.query(`
    SELECT table_name,
           array_agg(DISTINCT table_schema ORDER BY table_schema) AS schemas
      FROM information_schema.tables
     WHERE table_type = 'BASE TABLE' AND table_schema = ANY($1)
     GROUP BY table_name
    HAVING count(DISTINCT table_schema) > 1
    ORDER BY table_name`, [SCHEMAS]);

  const identical = [];
  const drifted = [];
  // Tables that live in knowledge/public etc. but not app/public — not drift,
  // just multi-schema. Listed separately so the number means something.
  const onlyElsewhere = [];

  // array_agg over text returns a Postgres array literal like {app,public}, which
// pg hands back as a plain string — not a JS array. So parse the literal rather
// than checking Array.isArray, which sent all twenty tables down the wrong branch
// and reported "0 app/public pairs" while the very next lines listed app/public
// pairs. A drift report that contradicts itself is worse than no report.
const parseSchemaList = (v) => {
  if (Array.isArray(v)) return v.filter(Boolean);
  const s = String(v ?? '').trim();
  const inner = s.replace(/^\{|\}$/g, '');
  return inner ? inner.split(',').map((x) => x.trim()).filter(Boolean) : [];
};

for (const d of dupes.rows) {
    const name = d.table_name;
    const schemaList = parseSchemaList(d.schemas);

    // Only compare the two schemas that actually both hold this table. The first
    // version hardcoded app-vs-public, so every knowledge/public pair was reported
    // as "app raised not-exist" — a real fact, but framed as drift when it is just
    // me asking the wrong question. Ten of the twenty findings were that mistake.
    if (!(schemaList.includes('app') && schemaList.includes('public'))) {
      onlyElsewhere.push({ name, schemas: schemaList.join(', ') });
      continue;
    }

    const cols = async (schema) => {
      const r = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, name]);
      return r.rows.map((x) => x.column_name);
    };
    const ca = await cols('app');
    const cp = await cols('public');
    const onlyApp = ca.filter((c) => !cp.includes(c));
    const onlyPub = cp.filter((c) => !ca.includes(c));

    const ra = await safe(`SELECT count(*)::int n FROM app."${name}"`);
    const rp = await safe(`SELECT count(*)::int n FROM public."${name}"`);

    const entry = {
      name,
      schemas: schemaList.join(', '),
      onlyApp, onlyPub,
      appRows: ra.rows[0]?.n ?? null,
      publicRows: rp.rows[0]?.n ?? null,
      appReadable: !ra.failed, publicReadable: !rp.failed,
    };
    // "Identical" requires the same columns AND the same count AND both readable.
    const agree = entry.appReadable && entry.publicReadable
      && !onlyApp.length && !onlyPub.length
      && entry.appRows === entry.publicRows;
    (agree ? identical : drifted).push(entry);
  }

  console.log(`\n  TABLES IN MORE THAN ONE SCHEMA: ${dupes.rows.length}`);
  console.log(`    app/public pairs, agreeing today : ${identical.length}`);
  console.log(`    app/public pairs, NOT agreeing   : ${drifted.length}`);
  console.log(`    live only outside app/public      : ${onlyElsewhere.length}`);
  if (onlyElsewhere.length) {
    console.log('      (multi-schema, not drift — e.g. knowledge+public pairs):');
    onlyElsewhere.forEach((t) => console.log(`        ${t.name.padEnd(32)} [${t.schemas}]`));
  }

  if (identical.length) {
    console.log('\n  ── agreeing, but duplicated. Any query written against either ──');
    console.log('     one keeps working until they diverge, and nothing will say so. ──');
    identical.forEach((t) => console.log(`     ${t.name.padEnd(34)} [${t.schemas}]  ${t.appRows} rows`));
  }

  if (drifted.length) {
    console.log('\n  ── NOT identical. Treat these as a bug already, not a risk. ──');
    drifted.forEach((t) => {
      const rows = t.appReadable && t.publicReadable ? `${t.appRows} app / ${t.publicRows} public`
        : `UNREADABLE — ${t.appReadable ? 'public' : 'app'} raised ${(t.publicReadable ? 'app' : 'public')} not-exist`;
      console.log(`     ${t.name.padEnd(34)} [${t.schemas}]  ${rows}`);
      if (t.onlyApp.length) console.log(`        app only    : ${t.onlyApp.join(', ')}`);
      if (t.onlyPub.length) console.log(`        public only : ${t.onlyPub.join(', ')}`);
    });
  }

  // ── 2. tenant coverage ────────────────────────────────────────────────────
  const tenantless = await pool.query(`
    SELECT n.nspname AS schema, c.relname AS table
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r'
       AND n.nspname = ANY($1)
       AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                          AND NOT a.attisdropped)
       AND c.relname NOT LIKE 'flyway_%'
     ORDER BY 1, 2`, [SCHEMAS]);

  console.log(`\n  TABLES WITH NO tenant_id COLUMN: ${tenantless.rows.length}`);
  console.log('    shared across every tenant by construction.');
  tenantless.rows.forEach((t) => console.log(`     ${t.schema}.${t.table}`));

  // ── 3. what the fleet work actually touches ───────────────────────────────
  console.log('\n  ── the fleet tables this session depends on ──');
  for (const t of ['fleet_messages', 'tasks', 'agents', 'fleet_memory', 'fleet_attachments']) {
    const where = await pool.query(`
      SELECT table_schema FROM information_schema.tables
       WHERE table_name = $1 AND table_schema = ANY($2) ORDER BY table_schema`, [t, SCHEMAS]);
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = $1 AND table_schema = ANY($2)`, [t, SCHEMAS]);
    const hasTenant = cols.rows.some((r) => r.column_name === 'tenant_id');
    const schemas = where.rows.map((r) => r.table_schema).join(', ') || 'NOWHERE';
    console.log(`     ${t.padEnd(20)} [${schemas.padEnd(13)}] tenant_id=${hasTenant ? 'yes' : 'NO'}`);
  }

  await pool.end();

  // Exit non-zero when there is something a human must decide. A drift report
  // that always exits 0 gets ignored, which is the same failure as not writing it.
  process.exit(drifted.length ? 1 : 0);
}

main().catch((e) => { console.error('  audit failed: ' + e.message); pool.end(); process.exit(2); });