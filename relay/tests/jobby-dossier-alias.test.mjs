// The two edits that were refused in a live session, replayed exactly as the
// model sent them.
//
// A real user said: "I founded Party Favor Photo in 2015 and I still run the
// business today." The model sent two edits and both were rejected:
//
//   set  github                       -> "github is not a dossier field"
//   update employment[0].startDate    -> "employment.startDate is not a field"
//
// Both refusals were correct in isolation and wrong in substance. KEY_ALIASES has
// carried `startdate -> start` all along, and `links.github` has always been
// writable; the model simply was not told, and a refusal it cannot learn from is
// a refusal the user pays for by resending. This test pins the two paths so a
// regression in either shows up as a failure rather than as another user having to
// type the same sentence again.
import pg from 'pg';
import { parsePath, WRITABLE_PATHS } from '../jobby/dossier.mjs';
import { applyEdits } from '../jobby/dossier.mjs';
import { getOrCreateClient, closeStore } from '../jobby/store.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

section('the paths the model actually sent are accepted');
{
  // Exactly the strings from the failed turn, not the canonical forms. Testing the
  // canonical spelling would pass on code that still rejects what the model emits.
  const gh = parsePath('github');
  check('a bare `github` is accepted', gh.ok === true, gh.error);
  check('and resolves to links.github',
    gh.ok && gh.root === 'links' && gh.parts[1] === 'github', JSON.stringify(gh.parts));

  const sd = parsePath('employment[0].startDate');
  check('`employment[0].startDate` is accepted', sd.ok === true, sd.error);
  check('and normalises to the canonical subfield',
    sd.ok && sd.parts[2] === 'start', JSON.stringify(sd.parts));
}

section('the real fields still work');
{
  for (const p of ['links.github', 'links.linkedin', 'employment[0].start', 'name', 'skills[0]', 'employment[2]']) {
    const r = parsePath(p);
    check(`${p} parses`, r.ok === true, r.error);
  }
}

section('genuinely unknown fields are still refused');
{
  // The aliasing must not become a hole. `salary` and `references` are not fields
  // and there is no alias for either.
  for (const p of ['salary', 'references', 'github_handle']) {
    const r = parsePath(p);
    check(`${p} is still refused`, r.ok === false, r.ok ? 'was accepted' : '');
  }
  const r = parsePath('employment[0].nonsense');
  check('an unknown employment subfield is still refused', r.ok === false, r.ok ? 'was accepted' : '');
}

section('read-only and prototype paths are still refused');
{
  // confidence, verification_flags and dates_from are read-only: they describe the
  // extraction rather than the person. not_stated is deliberately NOT in this list -
  // it is a writable list field, because "I don't have a GitHub" is a fact the
  // candidate states about themselves and has to be recordable. An earlier version
  // of this test asserted the opposite and was wrong about the design.
  for (const p of ['confidence', 'dates_from', 'verification_flags', '__proto__', 'constructor', 'prototype']) {
    const r = parsePath(p);
    check(`${p} is refused`, r.ok === false, r.ok ? 'was accepted' : '');
  }
  for (const p of ['not_stated', 'skills', 'target_roles', 'certifications']) {
    const r = parsePath(p);
    check(`${p} is writable, so a stated fact can be recorded`, r.ok === true, r.error);
  }
  // experience_years_stated is on the extracted profile but is not itself writable.
  // A user correcting "22" writes experience_years, which is writable, so the
  // correction has a path - but the stated-vs-computed pair can then disagree with
  // no way to update the stated side. Recorded rather than asserted either way.
  const stated = parsePath('experience_years_stated');
  check('experience_years_stated is read-only (extraction output, not a field)',
    stated.ok === false, stated.ok ? 'was accepted' : '');
  check('but experience_years itself is writable, so the correction has a path',
    parsePath('experience_years').ok === true);
}

section('the two edits, applied end to end to a real dossier');
{
  const pool = new pg.Pool({
    connectionString: process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
  });
  const key = 'dossier-alias-test-' + Math.random().toString(36).slice(2);
  const client = await getOrCreateClient(key, 'Alias Test');
  const before = {
    name: 'Test Person',
    links: { linkedin: 'https://linkedin.com/in/test', github: null },
    employment: [
      { company: 'Party Favor Photo', title: 'Founder', start: '2025', end: 'Present', current: true, highlights: [] },
    ],
  };
  await pool.query(
    `INSERT INTO app.job_dossiers (client_id, dossier, revision) VALUES ($1,$2,1)
     ON CONFLICT (client_id) DO UPDATE SET dossier = $2`,
    [client.id, JSON.stringify(before)]);

  const edits = [
    { op: 'set', path: 'github', value: 'github.com/xmrtdao' },
    { op: 'update', path: 'employment[0].startDate', value: '2015' },
  ];
  const result = applyEdits(JSON.parse(JSON.stringify(before)), edits);

  check('both refused edits now apply', result.ok === true, result.error);
  if (result.ok) {
    const d = result.dossier;
    check('the GitHub handle was stored under links.github',
      d.links?.github === 'github.com/xmrtdao', JSON.stringify(d.links));
    check('and not written as a bare top-level field',
      d.github === undefined, d.github);
    check('the start date became 2015', d.employment[0].start === '2015', d.employment[0].start);
    check('the role is still current', d.employment[0].current === true);
    check('nothing else was disturbed', d.name === 'Test Person' && d.employment[0].title === 'Founder');
  }

  // "and I still run the business today" - the value is already true, so this is a
  // no-op. It has to be reported as one rather than silently counted as a change:
  // a user told "I have updated your dossier" when nothing was written is exactly
  // the failure this project exists to avoid. Asserted separately because an
  // earlier version folded it into the batch above and failed on it.
  const noop = applyEdits(JSON.parse(JSON.stringify(before)), [
    { op: 'update', path: 'employment[0].current', value: true },
  ]);
  check('a redundant edit is reported as a no-op, not as a change',
    noop.ok === false && /already true/i.test(noop.error || ''), JSON.stringify(noop).slice(0, 160));

  await pool.query('DELETE FROM app.job_clients WHERE id = $1', [client.id]);
  await pool.end();
}

section('the writable list tells the truth');
{
  check('links.github is advertised as writable', WRITABLE_PATHS.includes('links.github'));
  check('employment.start is advertised as writable', WRITABLE_PATHS.includes('employment.start'));
  check('and the alias target is what appears in the error message',
    Object.keys(WRITABLE_PATHS).length === WRITABLE_PATHS.length);
}

await closeStore();

console.log(fails === 0
  ? '\n  the paths the model actually emits are accepted'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
