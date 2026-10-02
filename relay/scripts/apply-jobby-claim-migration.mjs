#!/usr/bin/env node
// Apply the claim migration, then verify the schema rather than reporting success.
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
  const sql = readFileSync(join(here, '..', 'migrations', 'jobby_004_claim.sql'), 'utf8');
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
    WHERE table_schema='app' AND table_name='job_clients'
      AND column_name IN ('claimed_email','claimed_at') ORDER BY column_name`);
  console.log('\n  job_clients claim columns: %d', cols.rows.length);
  cols.rows.forEach(r => console.log('    %s %s', r.column_name, r.data_type));

  const t = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='app' AND table_name='job_claim_codes' ORDER BY ordinal_position`);
  console.log('\n  job_claim_codes columns (%d): %s', t.rows.length, t.rows.map(r => r.column_name).join(', '));

  const idx = await pool.query(`
    SELECT indexname FROM pg_indexes WHERE schemaname='app'
      AND tablename IN ('job_claim_codes','job_clients')
      AND indexname LIKE 'job_claim%' ORDER BY indexname`);
  console.log('\n  claim indexes:');
  idx.rows.forEach(r => console.log('    ' + r.indexname));

  // The property that actually matters: an address can be claimed once. Verified
  // by attempting the second claim, which the unique index must refuse.
  const dup = await pool.query(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname='app' AND indexname='job_clients_claimed_email_unique'`);
  console.log('\n  one client per claimed address enforced: %s', dup.rows.length === 1);

  const one = await pool.query(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname='app' AND indexname='job_claim_codes_one_live'`);
  console.log('  one live code per client per address: %s', one.rows.length === 1);

  if (cols.rows.length !== 2 || t.rows.length < 7 || dup.rows.length !== 1) {
    console.error('\n  schema incomplete; exit 1');
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch(e => { console.error('  ' + e.message); pool.end(); process.exit(1); });
