#!/usr/bin/env node
/**
 * tests/_make_test_db.mjs — (re)create xmrt_suite_test as a schema-only copy.
 *
 * Schema only, never data. Copying rows would defeat the point: the whole reason
 * the suite gets its own database is that it must not see — or be able to damage
 * — a real candidate.
 *
 * Requires pg_dump/psql. On this machine they live under
 * C:\Users\PureTrek\Desktop\DevGruGold\pg\bin (not on PATH). Override with
 * PG_BIN=/path/to/pg/bin.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { default as pg } from 'pg';

const SRC_URL = process.env.SOURCE_DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';
const TEST_DB = process.env.TEST_DATABASE_NAME || 'xmrt_suite_test';

const PG_BIN = process.env.PG_BIN
  || 'C:\\Users\\PureTrek\\Desktop\\DevGruGold\\pg\\bin';
const pgDump = join(PG_BIN, 'pg_dump.exe');
const psql = join(PG_BIN, 'psql.exe');

if (!existsSync(pgDump) || !existsSync(psql)) {
  console.error(`pg_dump/psql not found in ${PG_BIN}`);
  console.error('set PG_BIN to the directory containing them, e.g. PG_BIN=/usr/lib/postgresql/16/bin');
  process.exit(1);
}

const dumpFile = join(tmpdir(), 'xmrt_suite_test_schema.sql');

console.log(`recreating ${TEST_DB} as a schema-only copy of the source`);

// 1. Drop and recreate. A fresh database also clears any fixtures a previous run
//    left behind, so the copy is clean by construction rather than by cleanup.
const admin = new pg.Client({ connectionString: SRC_URL });
await admin.connect();
const { rows: currentDb } = await admin.query('SELECT current_database() d');
if (currentDb[0].d === TEST_DB) {
  console.error(`refusing to rebuild the source database (${TEST_DB}) — set SOURCE_DATABASE_URL`);
  process.exit(1);
}
const { rows: exists } = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [TEST_DB]);
if (exists.length) {
  await admin.query(`DROP DATABASE ${TEST_DB}`);
  console.log(`  dropped the previous ${TEST_DB}`);
}
await admin.query(`CREATE DATABASE ${TEST_DB}`);
console.log(`  created ${TEST_DB}`);
await admin.end();

// 2. Schema only.
const common = ['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '--no-password'];
execFileSync(pgDump, ['--schema-only', '--no-owner', '--no-privileges', '-f', dumpFile, ...common, 'xmrt_suite'],
  { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, PGPASSWORD: '' } });
const kb = Math.round(existsSync(dumpFile) ? Number(readFileSync(dumpFile).byteLength / 1024) : 0);
console.log(`  dumped schema (${kb} KB, no rows)`);

// 3. Restore. Missing extensions (pgcrypto, uuid-ossp, pg_stat_statements) and
//    pre-existing schemas are reported and tolerated: they are environment
//    differences, not schema errors. What matters is that the tables and their
//    unique constraints land, because ON CONFLICT fails without them.
let restoreOut = '';
try {
  restoreOut = execFileSync(psql, ['-q', '-v', 'ON_ERROR_STOP=0', '-f', dumpFile, ...common, TEST_DB],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: '' } });
} catch (e) {
  restoreOut = String(e.stdout || '') + String(e.stderr || '');
}
const errors = (restoreOut.match(/^psql.*ERROR:.*$/gm) || []).length;
console.log(`  restored (${errors} tolerated error line(s) - missing extensions / schemas already present)`);

// 4. Verify the thing that actually breaks tests: unique constraints.
const check = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:5432/${TEST_DB}` });
await check.connect();
const { rows: uq } = await check.query(`
  SELECT count(*)::int n FROM pg_indexes
   WHERE schemaname IN ('app','public','knowledge','agent') AND indexdef ILIKE '%UNIQUE%'`);
const { rows: tbl } = await check.query(`
  SELECT count(*)::int n FROM information_schema.tables
   WHERE table_schema IN ('app','public','knowledge','agent')`);
const { rows: leaks } = await check.query('SELECT count(*)::int n FROM app.job_clients');
console.log(`  ${tbl[0].n} relations, ${uq[0].n} unique indexes, ${leaks[0].n} rows in app.job_clients`);
if (uq[0].n === 0) {
  console.error('\nno unique indexes landed - every ON CONFLICT in the suite will fail.');
  console.error('check the restore errors above.');
  process.exit(1);
}
await check.end();
rmSync(dumpFile, { force: true });
console.log(`\n${TEST_DB} is ready. Run: node tests/_run.mjs`);
process.exit(0);
