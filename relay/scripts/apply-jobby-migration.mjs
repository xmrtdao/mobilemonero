#!/usr/bin/env node
// Apply the Jobby migration. Safe to re-run: every statement is IF NOT EXISTS
// or an idempotent upsert.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const pool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });

async function main() {
  const sql = readFileSync(join(here, '..', 'migrations', 'jobby_001_agent.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('migration applied');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('migration FAILED:', e.message);
    process.exitCode = 1;
    return;
  } finally {
    client.release();
  }

  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='app' AND table_name LIKE 'job_%' ORDER BY table_name`);
  console.log('\njob_* tables:');
  tables.rows.forEach(r => console.log('  ' + r.table_name));

  const ag = await pool.query(
    `SELECT id, name, role, status, skills FROM app.agents WHERE id='jobby-001'`);
  console.log('\napp.agents:');
  console.log('  ' + JSON.stringify(ag.rows[0]));

  const cf = await pool.query(
    `SELECT did, name, role, trust_score, trust_band, cac_tier, status, metadata
     FROM public.registry_agents WHERE did='did:xmrt:jobby'`);
  console.log('\ncuttlefish_agents:');
  console.log('  ' + JSON.stringify(cf.rows[0]));

  await pool.end();
}

main().catch(e => { console.error(e.message); pool.end(); process.exit(1); });
