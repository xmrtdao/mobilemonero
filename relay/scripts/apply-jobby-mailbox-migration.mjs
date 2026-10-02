#!/usr/bin/env node
// Apply the per-candidate mailbox migration.
//
// Safe to re-run: every statement is IF NOT EXISTS. Reports what it actually
// found afterwards rather than only that it succeeded, because "applied" and "the
// column exists" are different claims and only the second one is worth having.
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
  const sql = readFileSync(join(here, '..', 'migrations', 'jobby_002_mailbox.sql'), 'utf8');
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

  // Verify rather than assume. A migration that reports success but leaves the
  // schema unchanged is the failure mode worth catching.
  const cols = await pool.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='app'
      AND ((table_name='job_clients' AND column_name='mailbox')
        OR (table_name='job_outreach' AND column_name='from_address'))
    ORDER BY table_name`);
  console.log('\n  columns added:');
  cols.rows.forEach(r => console.log('    %s.%s  %s', r.table_name, r.column_name, r.data_type));
  if (cols.rows.length !== 2) {
    console.error(`    expected 2 columns, found ${cols.rows.length}`);
    process.exitCode = 1;
  }

  const idx = await pool.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname='app' AND tablename='job_clients' AND indexname LIKE '%mailbox%'
    ORDER BY indexname`);
  console.log('\n  job_clients mailbox indexes:');
  idx.rows.forEach(r => console.log('    ' + r.indexname));
  // One is the uniqueness guarantee, one is the lookup the webhook does on every
  // inbound message. Neither is optional.
  if (idx.rows.length < 2) {
    console.error(`    expected 2 mailbox indexes, found ${idx.rows.length}`);
    process.exitCode = 1;
  }

  const dupes = await pool.query(`
    SELECT lower(mailbox) AS m, count(*) FROM app.job_clients
    WHERE mailbox IS NOT NULL GROUP BY lower(mailbox) HAVING count(*) > 1`);
  console.log('\n  duplicate mailboxes already present: %d', dupes.rows.length);
  dupes.rows.forEach(r => console.log('    %s x%s', r.m, r.count));

  const existing = await pool.query(`
    SELECT count(*)::int AS n FROM app.job_clients WHERE mailbox IS NOT NULL`);
  console.log('  clients with an address already: %d', existing.rows[0].n);

  await pool.end();
}

main().catch(e => { console.error('  ' + e.message); pool.end(); process.exit(1); });
