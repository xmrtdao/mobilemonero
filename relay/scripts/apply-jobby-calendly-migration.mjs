#!/usr/bin/env node
// Apply the Calendly migration, then verify the schema rather than reporting success.
//
// Same shape as the other appliers: idempotent statements, and a check afterwards
// that the things it claims to have added are actually there. "Applied" and "the
// table is correct" are different claims and only the second is worth making.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const pool = new Pool({
  connectionString: process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
});

async function main() {
  const sql = readFileSync(join(here, '..', 'migrations', 'jobby_003_calendly.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('  migration applied');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('  migration FAILED:', e.message);
    process.exitCode = 1;
    await pool.end();
    return;
  } finally {
    client.release();
  }

  const cols = await pool.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='app' AND table_name='job_calendly_accounts'
    ORDER BY ordinal_position`);
  console.log('\n  job_calendly_accounts columns (%d):', cols.rows.length);
  cols.rows.forEach(r => console.log('    %s %s', r.column_name, r.data_type));

  const idx = await pool.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname='app' AND tablename='job_calendly_accounts' ORDER BY indexname`);
  console.log('\n  indexes:');
  idx.rows.forEach(r => console.log('    ' + r.indexname));

  const pkce = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='app' AND table_name='job_oauth_states'
      AND column_name='code_verifier'`);
  console.log('\n  job_oauth_states.code_verifier present: %s', pkce.rows.length === 1);

  // The one-active-per-client guarantee is the constraint that stops the code
  // having to decide which scheduling link to send.
  const one = await pool.query(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname='app' AND indexname='job_calendly_accounts_one_active'`);
  console.log('  one active account per client enforced: %s', one.rows.length === 1);

  const chk = await pool.query(`
    SELECT conname FROM pg_constraint
    WHERE conname='job_calendly_revoked_has_no_token'`);
  console.log('  a revoked row cannot retain a token: %s', chk.rows.length === 1);

  if (cols.rows.length < 15 || pkce.rows.length !== 1) {
    console.error('\n  schema incomplete; exit 1');
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch(e => { console.error('  ' + e.message); pool.end(); process.exit(1); });
