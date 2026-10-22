/**
 * relay/tests/cron-classify.test.mjs — what the runner thinks a command is
 *
 * Two defects, both found on 2026-10-17 by reading cron_execution_log rather
 * than by reading the code.
 *
 * 1. `py` WAS NOT IN THE SHELL CLASSIFIER. On Windows `py` is the launcher, and
 *    arch-ecosystem-scanner is written as
 *      py relay/cron-python/arch-ecosystem-scanner.py
 *    It did not match /^(python3?|node|cd\s|bash|sh\s)/, so it was classified
 *    sql and handed to Postgres, which answered
 *      syntax error at or near "py"
 *    187 times. Every six hours. The only evidence in the log was a database
 *    error that says nothing about the real cause - a misclassification that
 *    reports itself as a database problem is worse than no classification.
 *
 * 2. THE JSON FALLBACK REPLACED INSTEAD OF MERGING. loadJobsFromPg() read
 *    relay-data/cron-jobs.json only when cron.job was EMPTY. cron.job had 56
 *    rows, so the 84 hand-maintained jobs stopped being scheduled - including
 *    303 jobby-heartbeat, 304 the morning summary, 305 the evening summary. The
 *    daemon logged a healthy-looking job count the whole time.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { classifyCommand } from '../cron-engine-v2.mjs';
import { localDbUrl } from '../lib/local-db-url.mjs';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); return; }
  failures += 1;
  console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY = join(__dirname, '..');
const JOBS_FILE = join(RELAY, '..', 'relay-data', 'cron-jobs.json');

// cron.job is production configuration, not candidate data, and the test
// database is a schema-only copy whose cron.job is empty by design. A job
// that lives only in cron.job therefore has to be read from the live
// database to be checked at all.
const LIVE_DATABASE_URL = process.env.LIVE_DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';

// ───────────────────────────────────────────────────────────────────────
console.log('\n--- the command that was failing every 6 hours ---');
{
  const cmd = 'py relay/cron-python/arch-ecosystem-scanner.py';
  check(`"${cmd}" classifies as shell, not sql`,
    classifyCommand(cmd) === 'shell', `got ${classifyCommand(cmd)}`);
}

console.log('\n--- every interpreter, classified ---');
{
  const shell = [
    'py relay/cron-python/x.py',
    'py -3 relay/cron-python/x.py',
    'python x.py', 'python3 x.py',
    'node -e "x"', 'node script.js',
    'cd /tmp && ls', 'bash run.sh', 'sh run.sh',
    'pwsh -File x.ps1', 'powershell -Command x',
  ];
  for (const c of shell) {
    check(`shell: ${c.slice(0, 42)}`, classifyCommand(c) === 'shell', `got ${classifyCommand(c)}`);
  }

  console.log('\n--- and everything else stays sql ---');
  const sql = [
    'SELECT 1',
    'SELECT 1 FROM app.tasks LIMIT 1',
    'UPDATE app.tasks SET stage = $1',
    'DELETE FROM app.tasks WHERE id = $1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
  ];
  for (const c of sql) {
    check(`sql: ${c.slice(0, 42)}`, classifyCommand(c) === 'sql', `got ${classifyCommand(c)}`);
  }

  console.log('\n--- edge functions stay edge ---');
  check('SELECT extensions.http is edge',
    classifyCommand('SELECT extensions.http(\'url\')') === 'edge');
}

console.log('\n--- the trailing \\s stops prefix words being captured ---');
{
  // These all BEGIN with a token in the pattern. Without the \s they would be
  // mis-captured as shell and handed to a shell instead of to Postgres.
  const traps = ['payload_schema', 'sharding_key', 'node_count', 'bash_history', 'shadow_table'];
  for (const t of traps) {
    check(`"${t}" is not captured as shell`, classifyCommand(t) === 'sql',
      `got ${classifyCommand(t)}`);
  }
  check('null/empty are sql, not a throw',
    classifyCommand(null) === 'sql' && classifyCommand('') === 'sql' && classifyCommand(undefined) === 'sql');
}

console.log('\n--- no live command is mis-classified ---');
{
  // The repo's own resolver, so the connection always names a role. An
  // undefined connectionString falls back to the OS username, and the
  // cluster answers `role "<os user>" does not exist` — which the catch
  // below turns into a silent SKIP, so the check quietly stops checking
  // anything at all.
  const pool = new pg.Pool({ connectionString: localDbUrl(), connectionTimeoutMillis: 5000 });
  try {
    const r = await pool.query(
      'SELECT id, name, command FROM cron.job WHERE command IS NOT NULL ORDER BY id');
    const INTERP = /^(?:python3?|py|node|cd|bash|sh|pwsh|powershell)$/i;
    const bad = r.rows.filter((j) => INTERP.test(j.command.trim().split(/\s+/)[0]) && classifyCommand(j.command) === 'sql');
    check(`no cron.job interpreter command is classified sql (${r.rowCount} scanned)`,
      bad.length === 0, bad.map(b => `${b.id}:${b.name}`).join(', '));

    const arch = r.rows.find((x) => /arch-ecosystem/.test(x.name || ''));
    if (arch) {
      check('arch-ecosystem-scanner in the live table is shell',
        classifyCommand(arch.command) === 'shell', `got ${classifyCommand(arch.command)}`);
    } else {
      console.log('  SKIP  arch-ecosystem-scanner not in cron.job in this database');
    }
  } catch (e) {
    console.log('  SKIP  cron.job not reachable: ' + e.message);
  } finally {
    await pool.end().catch(() => {});
  }
}

console.log('\n--- the JSON is merged, not used as a replacement ---');
{
  const src = readFileSync(join(RELAY, 'cron-engine-v2.mjs'), 'utf8');
  check('the loader concatenates the JSON-only jobs',
    /rows = rows\.concat\(jsonOnly\)/.test(src));
  check('it no longer falls back only when cron.job is empty',
    !/if \(rows\.length === 0\)/.test(src), 'the empty-only fallback is still there');
  check('it logs how many jobs came from each source',
    /merged cron-jobs\.json/.test(src) && /cron\.job has \$\{tableOnly\.length\}/.test(src));

  console.log('\n--- and the Jobby jobs are actually in the JSON ---');
  const parsed = JSON.parse(readFileSync(JOBS_FILE, 'utf8'));
  const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || Object.values(parsed).flat());
  for (const id of [303, 304, 305]) {
    const j = jobs.find((x) => Number(x.id) === id);
    check(`job ${id} is present`, !!j, 'missing from cron-jobs.json');
    if (j) check(`  and has an action`, typeof j.action === 'string' && j.action.length > 0, JSON.stringify(j.action));
  }

  console.log('\n--- and the chat cadences are retuned in the JSON ---');
  const creator = jobs.find((x) => Number(x.id) === 227);
  check('fleet-chat-task-creator is not every 10 minutes',
    creator && creator.schedule !== '*/10 * * * *', creator?.schedule);
  const announcer = jobs.find((x) => Number(x.id) === 5);
  if (announcer) {
    check('task-discussion-announcer is not every 15 minutes',
      announcer.schedule !== '*/15 * * * *', announcer.schedule);
  } else {
    // 2026-10-19: JSON id 5 was a `SELECT 1` placeholder shadowed by cron.job
    // and was removed. The announcer now exists only in cron.job, so check the
    // effective schedule there instead of failing on a deleted no-op.
    //
    // It is read from the LIVE database: the test database is a schema-only
    // copy and its cron.job has no rows, so asking it would have proved
    // nothing about the schedule that actually runs.
    const pool = new pg.Pool({ connectionString: LIVE_DATABASE_URL });
    try {
      const r = await pool.query(
        `SELECT schedule FROM cron.job WHERE name = 'task-discussion-announcer' AND enabled ORDER BY id LIMIT 1`);
      if (r.rows.length === 0) {
        console.log('  SKIP  task-discussion-announcer schedule: no enabled job by that name in cron.job');
      } else {
        check('task-discussion-announcer is not every 15 minutes (cron.job)',
          r.rows[0].schedule !== '*/15 * * * *',
          r.rows[0].schedule);
      }
    } catch (e) {
      console.log('  SKIP  task-discussion-announcer schedule: cron.job not reachable: ' + e.message);
    } finally {
      await pool.end().catch(() => {});
    }
  }
}

console.log(failures === 0
  ? '\ncron-classify: all checks passed'
  : `\ncron-classify: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);