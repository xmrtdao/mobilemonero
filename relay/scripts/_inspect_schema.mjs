#!/usr/bin/env node
// Read-only schema inspection for the Jobby wiring.
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });

async function cols(label, table) {
  const r = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns WHERE table_schema='app' AND table_name=$1
     ORDER BY ordinal_position`, [table]);
  console.log(`\n=== ${label} :: app.${table} (${r.rowCount} cols) ===`);
  r.rows.forEach(c => console.log(`  ${c.column_name.padEnd(28)} ${c.data_type.padEnd(26)} ${c.is_nullable === 'NO' ? 'NOT NULL' : ''} ${c.column_default || ''}`));
}

async function rows(label, sql) {
  const r = await pool.query(sql);
  console.log(`\n=== ${label} (${r.rowCount}) ===`);
  r.rows.forEach(row => console.log('  ' + JSON.stringify(row).slice(0, 400)));
}

async function main() {
  await rows('app.agents', `SELECT * FROM app.agents ORDER BY 1 LIMIT 30`);
  await cols('agents', 'agents');
  await cols('cuttlefish_agents', 'cuttlefish_agents');
  await cols('suite_leads', 'suite_leads');
  await cols('suite_pipeline_stages', 'suite_pipeline_stages');
  await rows('suite_leads sample', `SELECT * FROM app.suite_leads ORDER BY 1 LIMIT 5`);
  await rows('pipeline stages', `SELECT * FROM app.suite_pipeline_stages`);
  await rows('conversations', `SELECT * FROM app.conversations ORDER BY 1 LIMIT 5`);
  await cols('conversations', 'conversations');
  await cols('messages', 'messages');
  await pool.end();
}
main().catch(e => { console.error(e.message); pool.end(); process.exit(1); });
