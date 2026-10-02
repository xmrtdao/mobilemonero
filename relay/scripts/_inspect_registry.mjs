#!/usr/bin/env node
// Ad-hoc read-only inspection of the agent registry and related tables.
// Used while wiring Jobby in as a first-class relay agent.
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });

async function show(label, sql, params = []) {
  const r = await pool.query(sql, params);
  console.log(`\n=== ${label} (${r.rowCount}) ===`);
  if (!r.rows.length) { console.log('  (none)'); return r; }
  console.log(Object.keys(r.rows[0]).join(' | '));
  r.rows.forEach(row => {
    console.log('  ' + Object.values(row).map(v =>
      v === null || v === undefined ? '-' : (typeof v === 'object' ? JSON.stringify(v) : String(v).slice(0, 60))
    ).join(' | '));
  });
  return r;
}

async function main() {
  await show('cuttlefish_agents', `SELECT did, name, role, agent_type, cac_tier, trust_score, status, lifecycle_status FROM public.registry_agents ORDER BY name`);

  await show('job-* tables', `SELECT table_name FROM information_schema.tables WHERE table_schema='app' AND (table_name LIKE '%job%' OR table_name LIKE '%lead%' OR table_name LIKE '%candidate%' OR table_name LIKE '%opportunit%' OR table_name LIKE '%application%' OR table_name LIKE '%resume%' OR table_name LIKE '%track%' OR table_name LIKE '%dossier%') ORDER BY table_name`);

  await show('all app tables', `SELECT table_name FROM information_schema.tables WHERE table_schema='app' ORDER BY table_name`);

  await pool.end();
}

main().catch(e => { console.error(e.message); pool.end(); process.exit(1); });
