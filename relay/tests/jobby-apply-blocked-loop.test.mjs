/**
 * relay/tests/jobby-apply-blocked-loop.test.mjs — the whole loop, end to end
 *
 * The other two application tests check the parts: classification, task text,
 * SQL. This one checks that they are actually wired to each other, because the
 * failure mode nobody notices is three individually-correct pieces that were
 * never connected to the tool.
 *
 * It runs the real `jobby_apply` with the browser stubbed. That means no real
 * site, no real employer and no real mailbox is involved - but the database
 * writes, the classification and the email body are all the real code paths,
 * and the assertions are about the promise the feature makes to a person:
 *
 *   "Jobby stopped on a CAPTCHA, emailed me about it, told me which job it was,
 *    and did not email me again when it retried."
 *
 * A stub is required rather than a real page for a mundane reason: this has to
 * be safe to run on a machine where a real application could actually go out.
 */
import pg from 'pg';

const CONN = process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';
let pool;
try {
  pool = new pg.Pool({ connectionString: CONN, connectionTimeoutMillis: 4000 });
  await pool.query('SELECT 1');
} catch (e) {
  console.log('  SKIP  database not reachable (' + e.message + ')');
  process.exit(0);
}

let fails = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); return; }
  fails += 1;
  console.log('  FAIL  ' + name + (extra ? '  -> ' + String(extra).slice(0, 220) : ''));
};

const TAG = 'test-loop-' + Date.now();
const made = await pool.query(
  `INSERT INTO app.job_clients (session_key, display_name) VALUES ($1, $2) RETURNING id`,
  [TAG, 'Loop Test'],
);
const cid = made.rows[0].id;

const { createJobbyTools } = await import('../jobby/tools.mjs');
const { getApplication, listApplications } = await import('../jobby/applications.mjs');

// A realistic stopped report: the agent ran, filled what it could, and stopped.
// The file-input line is in here deliberately - "could not attach" is phrased
// like a missing fact, and the classifier has to keep the two apart.
const STOPPED = [
  'I opened the application and filled in the fields I had answers for.',
  '',
  '**Fields Filled**',
  '- [1] Full Name: Loop Test',
  '- [2] Email: loop@example.com',
  '- [3] Phone: +1 202 555 0100',
  '',
  '**Fields NOT Filled (require action)**',
  '- [4] Resume: could not attach, the file input opens a native dialog',
  '',
  '**Blocked**',
  'The site then showed a Cloudflare "verify you are human" check before the',
  'Submit button. I did not attempt to get past it.',
].join('\n');

const emails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  // success:false WITH a result is the hub's way of saying "it ran and stopped",
  // which is the case this feature exists for. Treating it as a crash is the
  // bug the two-value split in jobby_apply was written to avoid.
  if (u.includes('38401') && u.includes('/api/execute')) {
    return new Response(JSON.stringify({ success: false, result: STOPPED }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (u.includes('/api/status')) {
    return new Response(JSON.stringify({ connected: true, busy: false, generation: 9 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(url, opts);
};

// The gate is NOT stubbed. `assertCanRepresent` is imported from inside the tool
// body, and an ES module namespace is read-only, so it cannot be replaced - and
// replacing it would be the wrong thing to do anyway. It reads `claimed_email`
// off the client row, so setting that column is enough to pass the real gate:
// this test then exercises the real check rather than asserting against a
// pretend one.
await pool.query('UPDATE app.job_clients SET claimed_email = $2, claimed_at = now() WHERE id = $1',
  [cid, 'loop@example.com']);

const ctx = {
  clientId: cid,
  email: 'loop@example.com',
  sessionCookie: null,
  deliver: async (m) => { emails.push(m); return { providerId: 'stub-' + emails.length }; },
};

try {
  const tools = createJobbyTools({});

  console.log('\n--- the verified-address gate is real, and it passes ---');
  {
    const { assertCanRepresent } = await import('../jobby/claim.mjs');
    const gate = await assertCanRepresent(cid);
    check('a proved address passes the real gate', gate.ok === true, JSON.stringify(gate));
  }

  console.log('\n--- a run that stops is recorded, not just described ---');
  const r1 = await tools.jobby_apply({
    url: 'https://careers.example.com/jobs/loop-test-1',
    company: 'Example Co', role: 'Sales Lead',
  }, ctx);

  check('reported as stopped', r1.stopped === true, JSON.stringify(r1).slice(0, 160));
  check('never reported as submitted', r1.submitted === false, String(r1.submitted));
  check('hands back an application id', Number.isInteger(r1.applicationId), String(r1.applicationId));
  check('status is blocked', r1.applicationStatus === 'blocked', String(r1.applicationStatus));
  // The classification decides what the candidate is told to go and do, so a
  // CAPTCHA misfiled as a missing fact sends them to fill in paperwork.
  check('classified as a captcha', r1.blockerKind === 'captcha', String(r1.blockerKind));
  check('the outstanding field is still extracted', r1.outstanding.length >= 1,
    JSON.stringify(r1.outstanding));

  const row = await getApplication(cid, r1.applicationId);
  check('the row exists', !!row);
  check('blocked in the database', row.status === 'blocked', String(row && row.status));
  check('with the blocker kind stored', row.blocker_kind === 'captcha', String(row && row.blocker_kind));
  check('and a step, so a resume knows where to aim',
    String(row && row.blocker_step || '').length > 0, String(row && row.blocker_step));
  check('the company was captured for the email', row.company === 'Example Co', String(row.company));
  check('one attempt counted', row.attempts === 1, String(row.attempts));

  console.log('\n--- the candidate is told, once, in terms they can act on ---');
  check('exactly one email went out', emails.length === 1, String(emails.length));
  const mail = emails[0] || {};
  check('it names the job', /Sales Lead|Example Co/.test(mail.subject || ''), mail.subject);
  check('it quotes the job number, the only handle they will have',
    String(mail.body || '').includes('job ' + r1.applicationId), String(mail.body).slice(0, 220));
  check('it says the application is saved, not lost',
    /not lost/i.test(mail.body || ''), String(mail.body).slice(0, 220));
  check('it gives the exact words to come back with',
    /continue on job/i.test(mail.body || ''), String(mail.body).slice(0, 220));
  check('it says nothing reached the employer',
    /nothing was sent to the employer/i.test(mail.body || ''), String(mail.body).slice(0, 220));

  console.log('\n--- a retry does not re-mail about the same wall ---');
  const r2 = await tools.jobby_apply({
    url: 'https://careers.example.com/jobs/loop-test-1',
    company: 'Example Co', role: 'Sales Lead',
  }, ctx);
  check('the retry lands on the same row', r2.applicationId === r1.applicationId,
    `${r1.applicationId} vs ${r2.applicationId}`);
  check('and sends no second email', emails.length === 1, String(emails.length));
  const after = await getApplication(cid, r1.applicationId);
  check('the attempt is counted instead', after.attempts === 2, String(after.attempts));
  const listed = await listApplications(cid, {});
  check('the dashboard shows one row, not two',
    listed.filter((x) => x.url.includes('loop-test-1')).length === 1);

  console.log('\n--- what the model is told to do next ---');
  check('the reply names the job number', /job \d+/.test(String(r1.nextStep)), String(r1.nextStep));
  check('and tells it to move on rather than wait',
    /next job/i.test(String(r1.nextStep)), String(r1.nextStep));
} catch (e) {
  fails += 1;
  console.log('  FAIL  harness error: ' + e.message);
  console.log('        ' + String(e.stack || '').split('\n').slice(1, 3).join('\n        '));
} finally {
  globalThis.fetch = realFetch;
  await pool.query('DELETE FROM app.job_clients WHERE session_key = $1', [TAG]);
  await pool.end();
}

console.log(fails === 0
  ? '\nall apply-blocked-loop checks passed'
  : `\n${fails} apply-blocked-loop check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
