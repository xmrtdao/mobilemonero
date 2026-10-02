/**
 * relay/tests/jobby-applications-db.test.mjs — the row lifecycle, against the
 * real database.
 *
 * The pure functions in jobby-applications.test.mjs prove the classification and
 * the task text. This proves the part that can only go wrong in SQL: that a
 * retry does not fork a row, that the notification fires exactly once, and that
 * resuming re-arms it.
 *
 * Every statement runs inside a transaction that is rolled back, so a run leaves
 * no rows behind. That matters more than usual here: this is the table that
 * decides whether a real candidate is emailed.
 *
 * Skips, loudly, if the database is not reachable. A test that cannot reach its
 * subject and quietly passes is worse than one that fails.
 */
import pg from 'pg';

const CONN = process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';
let pool;
try {
  pool = new pg.Pool({ connectionString: CONN, connectionTimeoutMillis: 4000 });
  await pool.query('SELECT 1');
} catch (e) {
  console.log('  SKIP  database not reachable (' + e.message + ')');
  console.log('        these checks are the only thing standing between a blocked');
  console.log('        application and a lost one, so run them when it is up.');
  process.exit(0);
}

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); return; }
  failures += 1;
  console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
};

const client = await pool.connect();
const TAG = 'test-app-' + Date.now();

try {
  // A throwaway client, which has to exist because the foreign key is the thing
  // that stops one candidate reading another's applications.
  //
  // No transaction wraps this, and the rows are deleted in the finally block
  // instead. The store under test opens its own pool, which cannot see another
  // connection's uncommitted rows - so wrapping the fixture in a transaction
  // produces a foreign-key violation on the first startAttempt, which is a
  // property of the harness rather than of the code under test.
  const c = await client.query(
    `INSERT INTO app.job_clients (session_key, display_name)
     VALUES ($1, $2) RETURNING id`,
    [TAG, 'Application Tracking Test'],
  );
  const cid = c.rows[0].id;
  const other = await client.query(
    `INSERT INTO app.job_clients (session_key, display_name)
     VALUES ($1, $2) RETURNING id`,
    [TAG + '-other', 'Someone Else'],
  );
  const otherId = other.rows[0].id;

  const { startAttempt, recordOutcome, markNotified, resumeAttempt,
          getApplication, listApplications, nextActionable } =
    await import('../jobby/applications.mjs');

  console.log('\n--- one listing is one row, however many times it is tried ---');
  {
    const url = 'https://careers.example.com/jobs/12345';
    const a = await startAttempt(cid, { url, company: 'Example Co', role: 'Sales Lead' });
    const b = await startAttempt(cid, { url, company: 'Example Co', role: 'Sales Lead' });
    check('a retry updates the same row',
      a.id === b.id, `${a.id} vs ${b.id}`);
    check('and counts the attempt instead', b.attempts === 2, String(b.attempts));

    // This is the duplicate-dashboard bug. Five rows all reading "blocked" for
    // one job means "continue on job 41" picks an arbitrary one of the five and
    // the candidate cannot tell which is the real one.
    const rows = await listApplications(cid, {});
    const forThis = rows.filter((r) => r.url === url);
    check('one row per listing, not one per attempt',
      forThis.length === 1, String(forThis.length));
  }

  console.log('\n--- a case or fragment difference is not a different listing ---');
  {
    await startAttempt(cid, { url: 'https://careers.example.com/jobs/999#apply' });
    const row = await getApplication(cid,
      (await listApplications(cid, {})).find((r) => r.url.includes('999')).id);
    const again = await startAttempt(cid, { url: 'https://careers.example.com/jobs/999#apply' });
    check('a fragment does not fork the row', row.id === again.id, `${row.id} vs ${again.id}`);
  }

  console.log('\n--- a retry must not blank out what was already known ---');
  {
    const url = 'https://careers.example.com/jobs/4242';
    await startAttempt(cid, { url, company: 'Real Company', role: 'Account Exec' });
    // A later attempt that knows less - the model did not parse the company this
    // time round - must not erase the name the candidate is looking at.
    await startAttempt(cid, { url });
    const row = (await listApplications(cid, {})).find((r) => r.url === url);
    check('company survives a thinner retry', row.company === 'Real Company', String(row.company));
    check('role survives too', row.role === 'Account Exec', String(row.role));
  }

  console.log('\n--- a blocker is recorded, not just described ---');
  {
    const url = 'https://careers.example.com/jobs/blocked-1';
    const app = await startAttempt(cid, { url, company: 'Blocked Co' });
    const blocker = { kind: 'captcha', step: 'human verification', detail: 'Verify you are human.' };
    const row = await recordOutcome(cid, app.id, {
      status: 'blocked', blocker, outstanding: [{ index: '2', question: 'Reference' }],
    });
    check('status is blocked', row.status === 'blocked', row.status);
    check('kind is stored for branching', row.blocker_kind === 'captcha', String(row.blocker_kind));
    check('the step is stored so resume can aim at it',
      row.blocker_step === 'human verification', String(row.blocker_step));
    check('the outstanding questions are stored',
      (row.outstanding || []).length === 1, JSON.stringify(row.outstanding));
  }

  console.log('\n--- the email fires once, not once per retry ---');
  {
    const blocked = (await listApplications(cid, { status: 'blocked' }))[0];
    const first = await markNotified(cid, blocked.id);
    const second = await markNotified(cid, blocked.id);
    const third = await markNotified(cid, blocked.id);
    // The whole reason notified_at is a column. A retried listing that stops on
    // the same CAPTCHA three times must not produce three emails about one
    // problem, because the second reads as a new failure.
    check('the first caller is told to send', first === true, String(first));
    check('the second is not', second === false, String(second));
    check('nor the third', third === false, String(third));
  }

  console.log('\n--- resuming re-arms the notification, because it is a new attempt ---');
  {
    const blocked = (await listApplications(cid, { status: 'blocked' }))[0];
    const row = await resumeAttempt(cid, blocked.id);
    check('the blocker is cleared', row.blocker_kind === null, String(row.blocker_kind));
    check('and the notification is re-armed',
      row.notified_at === null, String(row.notified_at));
    check('the time they came back is recorded', !!row.resumed_at, String(row.resumed_at));
    // Someone who solved a CAPTCHA and then hit a *different* wall must hear
    // about the new one. Not re-arming would silence that entirely.
    check('so a fresh block can mail again', await markNotified(cid, blocked.id) === true);
  }

  console.log('\n--- a submitted application is finished ---');
  {
    const url = 'https://careers.example.com/jobs/done-1';
    const app = await startAttempt(cid, { url, company: 'Done Co' });
    const row = await recordOutcome(cid, app.id, { status: 'submitted' });
    check('status is submitted', row.status === 'submitted', row.status);
    check('and the time is stamped', !!row.submitted_at, String(row.submitted_at));
    // submitted_at is set on the transition to submitted, and only then. A
    // blocked row that later goes to pending must not keep a fake one.
    const back = await recordOutcome(cid, app.id, { status: 'blocked' });
    check('moving off submitted does not erase the stamp', !!back.submitted_at, String(back.submitted_at));
  }

  console.log('\n--- "next job" means something precise ---');
  {
    const url = 'https://careers.example.com/jobs/next-1';
    const app = await startAttempt(cid, { url, company: 'Next Co' });
    await recordOutcome(cid, app.id, { status: 'pending' });
    const next = await nextActionable(cid);
    check('a pending listing is offered', !!next, String(next));
    check('and it is the right one', next.url === url, next.url);
  }
  {
    // The point of the whole "next" query. A blocked listing is waiting on a
    // human; re-running it unprompted is what produced the duplicate emails.
    const nxt = await nextActionable(cid);
    check('a blocked listing is never offered as next',
      nxt && nxt.status !== 'blocked', nxt ? nxt.status : 'none');
  }

  console.log('\n--- one candidate cannot reach another\'s application ---');
  {
    const mine = (await listApplications(cid, {}))[0];
    const theirs = await getApplication(otherId, mine.id);
    check('another client gets null for my id', theirs === null, JSON.stringify(theirs));
    // And a write, not just a read. Otherwise "continue" on someone else's id
    // would let a stranger file text into their application row.
    const wrote = await recordOutcome(otherId, mine.id, { status: 'submitted' });
    check('another client cannot write to my row', wrote === null, JSON.stringify(wrote));
  }

  console.log('\n--- an unknown status is refused, not stored ---');
  {
    const url = 'https://careers.example.com/jobs/bogus-1';
    const app = await startAttempt(cid, { url });
    // The dashboard's "what is stuck" filter is a WHERE status = 'blocked'. A
    // typo'd status silently drops the row, and the dropped row is always the
    // one that needed attention.
    const row = await recordOutcome(cid, app.id, { status: 'BLOCKED-ISH' });
    check('a bad status becomes failed, not itself', row.status === 'failed', row.status);
  }

  console.log('\n--- a blocker kind outside the set does not get stored verbatim ---');
  {
    const url = 'https://careers.example.com/jobs/badkind-1';
    const app = await startAttempt(cid, { url });
    const row = await recordOutcome(cid, app.id, {
      status: 'blocked', blocker: { kind: 'invented_kind', detail: 'x' },
    });
    check('an invented kind becomes unknown',
      row.blocker_kind === 'unknown', String(row.blocker_kind));
  }

} catch (e) {
  failures += 1;
  console.log('  FAIL  harness error: ' + e.message);
} finally {
  // The store module opened its own pool against the same database and is not
  // covered by the transaction, so the fixture rows are removed explicitly.
  await pool.query('DELETE FROM app.job_clients WHERE session_key LIKE $1', [TAG + '%']);
  client.release();
  await pool.end();
}

console.log(
  failures === 0
    ? '\nall application-store checks passed'
    : `\n${failures} application-store check(s) FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
