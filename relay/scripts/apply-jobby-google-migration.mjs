#!/usr/bin/env node
// Apply the Jobby Google OAuth migration. Idempotent.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });

const TABLES = ['job_google_accounts', 'job_oauth_states', 'job_sent_messages', 'job_seen_replies'];

async function main() {
  const sql = readFileSync(join(ROOT, 'migrations', 'jobby_001_google.sql'), 'utf8');
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

  const t = await pool.query(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = ANY($1::text[]) ORDER BY table_name`,
    [TABLES],
  );
  console.log('\ntables:');
  for (const r of t.rows) console.log('  ' + r.table_name);

  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'app' AND tablename = ANY($1::text[]) ORDER BY indexname`,
    [TABLES],
  );
  console.log('\nindexes:');
  for (const r of idx.rows) console.log('  ' + r.indexname);

  // Prove the token columns exist and are bytea, which is what sealToken writes.
  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'job_google_accounts'
       AND column_name LIKE '%_enc'`,
  );
  console.log('\ntoken columns:');
  for (const r of cols.rows) console.log(`  ${r.column_name}: ${r.data_type}`);

  await pool.end();
}
main().catch(e => { console.error(e.message); pool.end(); process.exit(1); });
