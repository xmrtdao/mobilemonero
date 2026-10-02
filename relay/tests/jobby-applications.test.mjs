/**
 * relay/tests/jobby-applications.test.mjs — the blocker/resume contract
 *
 * These are the checks that matter for a feature whose whole purpose is to be
 * trusted at the moment it is inconvenient: a run stopped by a CAPTCHA at 2am
 * has to produce a record the candidate can act on six hours later. The tests
 * concentrate on the three ways that silently breaks:
 *
 *   1. A blocked run that is not recorded, or recorded as submitted.
 *   2. A blocker classified as the wrong kind, so the candidate is told to do
 *      the wrong thing.
 *   3. A resume task that navigates, throwing away the form the candidate came
 *      back to help with.
 *
 * No database and no browser. The classification and the task text are pure
 * functions precisely so they can be tested here, without a live candidate's
 * application sitting in the way.
 */
import {
  BLOCKER_KINDS, buildResumeTask, classifyBlocker,
} from '../jobby/applications.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log('  PASS  ' + name); return; }
  failures += 1;
  console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
}

/* ── Classification: which wall is it? ─────────────────────────────────── */

console.log('\n--- a CAPTCHA is a CAPTCHA, whatever else the page says ---');
{
  // A Cloudflare interstitial mentions logging in AND verifying. Checking for
  // the login first tells the candidate to go and find a password they do not
  // need, when all they have to do is click a box.
  const r = classifyBlocker({
    report: 'The form is filled but Cloudflare asks me to verify you are human. '
      + 'You may need to sign in again.',
  });
  check('captcha wins over a login mentioned alongside it', r.kind === 'captcha', r.kind);
  check('captcha names the step', r.step === 'human verification', String(r.step));
  check('captcha tells the candidate to carry on with other jobs',
    /next job|carries on/i.test(r.detail), r.detail);
}

{
  const r = classifyBlocker({ report: 'reCAPTCHA: press and hold until the square is full' });
  check('reCAPTCHA recognised', r.kind === 'captcha', r.kind);
}
{
  const r = classifyBlocker({ report: 'Verify you are human to continue' });
  check('plain "verify you are human" recognised', r.kind === 'captcha', r.kind);
}

console.log('\n--- a sign-in is not a question the dossier can answer ---');
{
  const r = classifyBlocker({ report: 'The site asks me to log in to continue the application.' });
  check('login recognised', r.kind === 'login', r.kind);
  check('login refuses to handle the password',
    /will not enter or ask for your password/i.test(r.detail), r.detail);
}
{
  const r = classifyBlocker({ report: 'It wants a one-time code for two-factor authentication.' });
  check('2FA counts as a login', r.kind === 'login', r.kind);
}

console.log('\n--- a CV upload wall is neither of the above ---');
{
  // This is the one that matters most in practice: almost every real form has a
  // file input. Misfiled as an unanswerable question, the candidate is told to
  // type a fact into a box that wanted a PDF.
  const r = classifyBlocker({
    report: 'I could not attach the CV - clicking the file input opens a native dialog.',
    outstanding: [{ index: '3', question: 'Resume', why: 'file input' }],
  });
  check('file upload beats a parsed outstanding field', r.kind === 'file_upload', r.kind);
  check('file upload says what to actually do',
    /attach your resume in that tab/i.test(r.detail), r.detail);
}

console.log('\n--- an unanswerable question carries its exact wording ---');
{
  const r = classifyBlocker({
    report: 'Fields NOT Filled (require action):\n- [4] Work authorisation: not listed in the dossier',
    outstanding: [{ index: '4', question: 'Work authorisation', why: 'not listed in the dossier' }],
  });
  check('classified as an unanswerable question', r.kind === 'unanswerable_question', r.kind);
  check('the question is quoted verbatim',
    r.detail.includes('"Work authorisation"'), r.detail);
  check('the step is the field, so resume can aim at it',
    r.step === 'Work authorisation', String(r.step));
}

{
  // Two questions at once is the normal case, not an edge case. Only reporting
  // the first means the candidate fixes one, comes back, and immediately hits
  // the second.
  const r = classifyBlocker({
    report: 'stopped',
    outstanding: [
      { index: '4', question: 'Work authorisation', why: 'unknown' },
      { index: '9', question: 'Notice period', why: 'not stated' },
    ],
  });
  check('a second question is surfaced too',
    r.detail.includes('Notice period'), r.detail);
  check('the first is still the step to aim at',
    r.step === 'Work authorisation', String(r.step));
}

{
  const r = classifyBlocker({
    report: 'I could not answer that field, it is not stated anywhere.',
    outstanding: [],
  });
  check('prose-only "cannot answer" still classified',
    r.kind === 'unanswerable_question', r.kind);
  check('with no invented question text',
    !/"[^"]+"/.test(r.detail), r.detail);
}

console.log('\n--- nothing is invented for an unrecognised stop ---');
{
  const r = classifyBlocker({ report: 'Something unexpected happened on the page.' });
  check('an unknown stop is "unknown", not a guess', r.kind === 'unknown', r.kind);
  check('and it admits it does not know', /could not say why/i.test(r.detail), r.detail);
}

console.log('\n--- a transport failure is not a wall for the candidate ---');
{
  // The run never happened. Telling the candidate they need to do something
  // about a listing that was never touched sends them to fix the wrong thing.
  const r = classifyBlocker({ error: 'Hub is not connected. Is the extension running?' });
  check('no report means the agent never ran',
    r.kind === 'browser_unavailable', r.kind);
  check('and the fix is on the machine, not the form',
    /Chrome is open/i.test(r.detail), r.detail);
}

console.log('\n--- every kind is one of the declared ones ---');
{
  const samples = [
    'captcha: verify you are human',
    'please log in to continue',
    'could not attach the resume, native file dialog',
    'the form asks for my work authorisation',
    'nothing happened',
  ];
  const kinds = samples.map((report) => classifyBlocker({ report }).kind);
  const allDeclared = kinds.every((k) => BLOCKER_KINDS.includes(k));
  check('all samples land in the closed set', allDeclared, kinds.join(', '));
  check('the set is actually discriminating', new Set(kinds).size >= 3, kinds.join(', '));
}

/* ── The resume task must not navigate ────────────────────────────────── */

console.log('\n--- resume must not throw the form away ---');
{
  const app = {
    id: 41,
    url: 'https://example.com/apply',
    blocker_step: 'human verification',
    blocker_detail: 'The site put up a human-verification step.',
  };
  const task = buildResumeTask(app, {
    facts: { full_name: 'A Person', email: 'a@example.com' },
    answers: { 'Work authorisation': 'UK citizen' },
  });

  // The load-bearing property. An LLM told to "carry on with the application"
  // will otherwise open the URL on its own initiative, and the candidate's
  // half-filled form and solved CAPTCHA are both gone.
  check('says not to navigate', /do not navigate/i.test(task));
  check('says not to reload', /do not reload/i.test(task));
  check('says not to start over', /start the form over/i.test(task));
  check('tells it to work with the page as it is', /exactly as it is/i.test(task));
  check('mentions the person is watching', /looking at it right now/i.test(task));
}

{
  const task = buildResumeTask({ id: 41, blocker_step: 'human verification' }, {
    facts: { full_name: 'A Person' }, answers: { 'Work authorisation': 'UK citizen' },
  });
  check('the candidate answer is passed through', task.includes('UK citizen'), task);
  check('labelled so it is not filed under the wrong box',
    /work authorisation: uk citizen/i.test(task), task);
  check('the blocked step is named, so it resumes at the right place',
    task.includes('human verification'), task);
}

{
  // The rule that keeps it honest on the resumed run too. A resume is not a
  // loophole: a question the dossier still cannot answer stops the run again.
  const task = buildResumeTask({ id: 41 }, { facts: {}, answers: {} });
  check('still refuses to guess on a resume', /never guess/i.test(task));
  check('still stops for a CAPTCHA on a resume',
    /captcha/i.test(task) && /stop and report/i.test(task), task);
  check('still tells it to submit, not to ask permission',
    /finish the form and press submit/i.test(task), task);
}

{
  // A nested answer would stringify to [object Object] and end up on a form.
  const task = buildResumeTask({ id: 1 }, {
    facts: {}, answers: { good: 'fine', bad: { nested: 'x' } },
  });
  check('a nested answer is dropped, not stringified',
    !task.includes('[object Object]'), task);
  check('the flat one survives', task.includes('fine'), task);
}

{
  const task = buildResumeTask({ id: 41 }, { facts: { email: null, phone: '' }, answers: {} });
  check('empty facts are not rendered as "email: null"',
    !/email: null/i.test(task) && !/phone: $/m.test(task), task);
}

console.log(
  failures === 0
    ? '\nall application-tracking checks passed'
    : `\n${failures} application-tracking check(s) FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
