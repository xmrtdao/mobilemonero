/**
 * relay/tests/fleet-chat-dedupe.test.mjs — the nudge spam loop, stopped
 *
 * On 2026-10-17 the fleet chat received, in four hours:
 *
 *   * 27 copies of "Task created from fleet discussion: Investigate cron job
 *     errors"
 *   * a task-announcer message listing "Investigate cron job errors - PENDING"
 *     four times inside one message
 *   * a task-nudge every 30 minutes listing the same ten tasks, four of which
 *     had not been touched for 12 to 21 days
 *
 * Three separate causes, each sufficient on its own:
 *
 *   1. fleet-chat-task-creator derived its task title by keyword-matching the
 *      last twenty fleet-chat messages. Each task it created was announced to
 *      fleet chat; each announcement contained the words "cron" and "error".
 *      It was reading its own output and filing the next copy. 27 times.
 *
 *   2. task-announcer selected "tasks updated in the last 30 minutes" from a
 *      job scheduled every 15 minutes, so every change was announced twice,
 *      with no memory of what it had already said.
 *
 *   3. task-nudge kept a 15-minute per-task cooldown and no cap, so a task
 *      nobody was ever going to touch was nudged every 15 minutes for as long
 *      as it existed.
 *
 * The load-bearing fix is the database index. The three emitters are cleaned
 * up too, but a rule that only lives in the calling code is a rule the next
 * writer will not know about.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { localDbUrl, isScratchDatabase } from '../lib/local-db-url.mjs';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); return; }
  failures += 1;
  console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
};
const skip = (name, why) => console.log('  SKIP  ' + name + ' — ' + why);

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY = join(__dirname, '..');
const MIGRATION = join(RELAY, 'migrations', 'jobby_010_task_dedupe.sql');
const JOBS_FILE = join(RELAY, '..', 'relay-data', 'cron-jobs.json');

// The connection comes from the repo's own resolver, which always yields a
// URL.
//
// It used to be `process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL`,
// which is undefined when neither is set. An undefined connectionString
// makes libpq fall back to the OS username, and the cluster answered
// `FATAL: role "PureTrek" does not exist` — a failure that says nothing
// about the thing being tested. The resolver's fallback names the role
// explicitly, so the test either connects or says why it cannot.
const pool = new pg.Pool({
  connectionString: localDbUrl(),
  connectionTimeoutMillis: 5000,
});
const PROBE = 'zz-dedupe-test-' + Date.now();

// The database-mutating half of this test applies a migration and writes
// rows. Against the live database that is a side effect on production, so
// it only runs against a scratch database — which is what `tests/_run.mjs`
// arranges by pointing LOCAL_DATABASE_URL at xmrt_suite_test.
const scratch = isScratchDatabase();

try {
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- one open task per title, enforced by the database ---');
  if (!scratch) {
    skip('the database checks', 'this test writes rows and applies a migration, so it needs a scratch database. '
      + 'Run `node tests/_run.mjs fleet-chat-dedupe` (it points LOCAL_DATABASE_URL at xmrt_suite_test).');
  } else {
    await pool.query(readFileSync(MIGRATION, 'utf8'));

    const mk = () => pool.query(
      `INSERT INTO app.tasks (id, title, status, stage, priority, updated_at)
       VALUES ($1,$2,'PENDING','DISCUSS',3,now())`,
      ['dd-' + Math.random().toString(36).slice(2, 10), PROBE]);

    await mk();
    let refused = null;
    try { await mk(); } catch (e) {
      refused = /tasks_one_open_per_title/.test(String(e.message));
    }
    check('a second OPEN task with the same title is refused', refused === true,
      refused === false ? 'the duplicate was accepted' : String(refused));

    // Case-insensitive, because the three writers disagree about
    // capitalisation. Tested while the original is still OPEN - a DONE row is
    // deliberately outside the index, so testing this after closing the first
    // row would pass for the wrong reason.
    let refusedCase = null;
    try {
      await pool.query(
        `INSERT INTO app.tasks (id, title, status, stage, priority, updated_at)
         VALUES ($1,$2,'PENDING','DISCUSS',3,now())`,
        ['dd-case', PROBE.toUpperCase()]);
    } catch (e) {
      refusedCase = /tasks_one_open_per_title/.test(String(e.message));
    }
    check('a differently-cased copy is the same title', refusedCase === true,
      refusedCase === false ? 'accepted' : String(refusedCase));

    // Closing it must let the same incident be filed again, or the index is
    // just "never file this title twice", which is not the same rule.
    //
    // A task is only allowed to reach DONE with an artifact that points at
    // the work, so the probe is given one. That is not decoration: a
    // completion the database refuses is not a completion, and the test used
    // to assert the index's behaviour while taking the completion on trust.
    await pool.query(`DELETE FROM app.tasks WHERE lower(title)=lower($1)`, [PROBE]);
    await mk();
    await pool.query(
      `INSERT INTO app.task_artifacts (task_id, artifact_type, artifact_url, description)
       SELECT id, 'test', 'https://example.com/dedupe-probe', 'evidence for the dedupe probe'
         FROM app.tasks WHERE lower(title)=lower($1)`,
      [PROBE]);
    await pool.query(`UPDATE app.tasks SET status='DONE' WHERE title=$1`, [PROBE]);
    const closed = await pool.query(
      `SELECT status FROM app.tasks WHERE lower(title)=lower($1)`, [PROBE]);
    check('the probe really closed', closed.rows[0]?.status === 'DONE', closed.rows[0]?.status);
    let recurrenceRefused = false;
    try {
      await pool.query(
        `INSERT INTO app.tasks (id, title, status, stage, priority, updated_at)
         VALUES ($1,$2,'PENDING','DISCUSS',3,now())`,
        ['dd-again', PROBE]);
    } catch (e) {
      recurrenceRefused = /tasks_one_open_per_title/.test(String(e.message));
    }
    check('but a resolved incident may be re-filed', recurrenceRefused === false,
      recurrenceRefused ? 'the index blocked a genuine recurrence' : 'accepted');

    await pool.query(`DELETE FROM app.tasks WHERE lower(title)=lower($1)`, [PROBE]);
  }

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- the creator stops feeding itself ---');
  {
    const src = readFileSync(join(RELAY, 'cron-engine-v2.mjs'), 'utf8');
    check('it checks for an existing open task before creating one',
      /Already tracked/.test(src));
    check('it treats a 409 as the loop closing, not as a failure',
      /status === 409/.test(src));
    check('it reports the HTTP status instead of a bare "Failed"',
      /Failed to create task \(HTTP/.test(src));
  }

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- the announcer remembers what it said ---');
  {
    const src = readFileSync(join(RELAY, 'task-announcer.mjs'), 'utf8');
    check('it keeps a record of announced tasks', /announced/.test(src) && /task-announcer-state\.json/.test(src));
    check('it announces only tasks changed since the last announcement',
      /updated_at\)\.getTime\(\) > new Date\(prev\)\.getTime\(\)/.test(src));
    check('the read window is no longer wider than the job interval',
      /AND updated_at > NOW\(\) - INTERVAL '(\d+) minutes'/.test(src)
        && !/AND updated_at > NOW\(\) - INTERVAL '(?:3\d|[4-9]\d|\d{3,}) minutes'/.test(src),
      'still asks for a window wider than its 30-minute interval');
    check('a failed post is not recorded, so it can be retried',
      /if \(res\.ok\)[\s\S]{0,400}for \(const t of tasks\) state\.announced/.test(src));
  }

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- the nudge gives up ---');
  {
    const src = readFileSync(join(RELAY, 'task-nudge.mjs'), 'utf8');
    const num = (name) => {
      // `parseInt(process.env.NAME || '360', 10)`
      const m = src.match(new RegExp(name + "\\s*=\\s*parseInt\\([^)]*\\|\\|\\s*'(\\d+)'"));
      return m ? Number(m[1]) : null;
    };
    const cooldown = num('NUDGE_COOLDOWN_MINS');
    const max = num('MAX_NUDGES');
    const abandoned = num('ABANDONED_HRS');

    check('the cooldown is hours, not 15 minutes', cooldown !== null && cooldown >= 120,
      `${cooldown} min`);
    check('there is a cap on how many times a task is nudged', max !== null && max <= 5,
      `MAX_NUDGES=${max}`);
    check('a task older than a few days is abandoned, not stalled',
      abandoned !== null && abandoned <= 96, `ABANDONED_HRS=${abandoned}`);
    check('the cap is actually enforced in the filter', /count >= MAX_NUDGES/.test(src));
    check('the age limit is actually enforced in the filter', /ageHrs >= ABANDONED_HRS/.test(src));
    check('the nudge count survives a restart',
      /count: \(prev\.count \|\| 0\) \+ 1/.test(src));
    check('the old bare-timestamp state format is still readable',
      /typeof raw === 'number'/.test(src));
  }

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- the cadence ---');
  {
    const parsed = JSON.parse(readFileSync(JOBS_FILE, 'utf8'));
    const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || Object.values(parsed).flat());
    const find = id => jobs.find(j => Number(j.id) === Number(id));

    const creator = find(227);
    check('the task creator is not on a 10-minute schedule',
      creator && creator.schedule !== '*/10 * * * *', creator?.schedule);

    const announcer = find(5);
    if (announcer) {
      check('the announcer is not on a 15-minute schedule',
        announcer.schedule !== '*/15 * * * *', announcer.schedule);
    } else {
      // JSON id 5 was a `SELECT 1` placeholder shadowed by cron.job and was
      // removed on 2026-10-19. The announcer now exists only in cron.job, so
      // its schedule is read from the live database - cron.job is production
      // configuration, and the test database is a schema-only copy whose
      // cron.job has no rows at all.
      const live = new pg.Pool({
        connectionString: process.env.LIVE_DATABASE_URL
          || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
      });
      try {
        const r = await live.query(
          `SELECT schedule FROM cron.job WHERE name = 'task-discussion-announcer' AND enabled ORDER BY id LIMIT 1`);
        if (r.rows.length === 0) {
          console.log('  SKIP  the announcer schedule: no enabled job by that name in cron.job');
        } else {
          check('the announcer is not on a 15-minute schedule',
            r.rows[0].schedule !== '*/15 * * * *', r.rows[0].schedule);
          check('the announcer still has five cron fields',
            String(r.rows[0].schedule).trim().split(/\s+/).length === 5, r.rows[0].schedule);
        }
      } catch (e) {
        console.log('  SKIP  the announcer schedule: cron.job not reachable: ' + e.message);
      } finally {
        await live.end().catch(() => {});
      }
    }

    // Every job still parses as a cron expression: five fields.
    for (const id of [227]) {
      const j = find(id);
      check(`job ${id} still has five cron fields`,
        j && j.schedule.trim().split(/\s+/).length === 5, j?.schedule);
    }
  }
} catch (e) {
  failures += 1;
  console.log('  FAIL  suite threw: ' + (e && e.stack ? e.stack : e));
} finally {
  await pool.query(`DELETE FROM app.tasks WHERE lower(title)=lower($1)`, [PROBE]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(failures === 0
  ? '\nfleet-chat-dedupe: all checks passed'
  : `\nfleet-chat-dedupe: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);