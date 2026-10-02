#!/usr/bin/env node
/**
 * tests/_run.mjs — run the relay test suite against a THROWAWAY database.
 *
 * Why this exists
 * ---------------
 * The suite used to run against the live database, and several files wrote real
 * rows into app.job_clients to get past `assertCanRepresent`. That left 3,288
 * synthetic candidates sitting beside one real one, and 1,037 synthetic dossiers.
 * The leak was found and fixed, but nothing stopped the next test from doing the
 * same thing again — the fix was per-file, and there were three files.
 *
 * So the suite gets its own database. `xmrt_suite_test` holds a schema-only copy:
 * every table, every constraint, zero rows. Nothing a test writes can reach a
 * real candidate, and a failure that leaks rows is contained.
 *
 * Usage
 * -----
 *   node tests/_run.mjs                 run everything
 *   node tests/_run.mjs jobby-mailbox   run files whose name contains the arg
 *
 * Creating or refreshing the test database:
 *   node tests/_make_test_db.mjs
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_DB = 'xmrt_suite_test';

// jobby/store.mjs reads LOCAL_PG_URL first and falls back to a hard-coded
// production URL. Pointing LOCAL_PG_URL at the test database is therefore enough
// to move every consumer that goes through the store.
const TEST_URL = process.env.TEST_DATABASE_URL
  || `postgres://postgres@127.0.0.1:5432/${TEST_DB}`;

const filter = process.argv[2];
const files = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!files.length) {
  console.log(`no test files matched ${JSON.stringify(filter)}`);
  process.exit(1);
}

console.log(`running ${files.length} test file(s) against ${TEST_DB}`);
console.log('  (run `node tests/_make_test_db.mjs` first if it does not exist)\n');

let passed = 0;
const failed = [];

for (const file of files) {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, file)], {
      env: { ...process.env, LOCAL_PG_URL: TEST_URL, LOCAL_DATABASE_URL: TEST_URL },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('close', resolve);
  });
  if (code === 0) {
    passed++;
    console.log(`  PASS  ${file}`);
  } else {
    failed.push(file);
    console.log(`  FAIL  ${file}`);
  }
}

console.log(`\n${passed} passed, ${failed.length} failed, ${files.length} total`);
if (failed.length) {
  console.log('failed:');
  failed.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}
