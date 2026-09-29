// The field-naming failures, replayed as the model actually sent them.
//
// Three separate live incidents produced the same class of failure, and this file
// exists because the third one proved the first two fixes were too narrow:
//
//   "I founded Party Favor Photo in 2015"
//     -> sent `github` and `employment[0].startDate`, both refused
//   "update the headline in the identity section to <phrase>"
//     -> sent `identity.headline`, refused: "identity is not a dossier field"
//
// Each refusal was individually defensible. Together they meant a candidate
// retyping a clear sentence because the tool knew what was meant and would not say
// so. The rule this file pins down: a word that names a real field is not a bad
// path, and a refusal must say which field was meant.
import { parsePath, applyEdits, WRITABLE_PATHS } from '../jobby/dossier.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

section('the exact strings the model sent are accepted');
{
  // Incident 2, verbatim.
  const h = parsePath('identity.headline');
  check('`identity.headline` is accepted', h.ok === true, h.error);
  check('and resolves to current_title', h.ok && h.root === 'current_title', JSON.stringify(h.parts));

  // Incident 1, verbatim.
  const g = parsePath('github');
  check('`github` is accepted', g.ok === true, g.error);
  check('and resolves to links.github', g.ok && h && g.root === 'links', JSON.stringify(g.parts));

  const s = parsePath('employment[0].startDate');
  check('`employment[0].startDate` is accepted', s.ok === true, s.error);
  check('and normalises to start', s.ok && s.parts[2] === 'start', JSON.stringify(s.parts));
}

section('section prefixes are stripped, whatever the panel is called');
{
  for (const p of ['identity.name', 'contact.email', 'personal.phone', 'profile.location',
    'basics.summary', 'about.headline']) {
    const r = parsePath(p);
    check(`${p} resolves`, r.ok === true, r.error);
  }
  // A section name on its own is not a field, and must not become one.
  const bare = parsePath('identity');
  check('`identity` alone is still refused', bare.ok === false, bare.ok ? 'was accepted' : '');
}

section('plain-language names for real fields');
{
  const cases = [
    ['headline', 'current_title'], ['current role', null], ['company', 'current_company'],
    ['employer', 'current_company'], ['org', 'current_company'],
    ['bio', 'summary'], ['professional summary', null],
    ['years of experience', null], ['skills list', null],
  ];
  for (const [word, want] of cases) {
    const r = parsePath(word);
    check(`"${word}" resolves`, r.ok === true, r.error);
    if (r.ok && want) check(`  to ${want}`, r.root === want, r.root);
  }
  check('`current_title` is unchanged', parsePath('current_title').root === 'current_title');
  check('`summary` is unchanged', parsePath('summary').root === 'summary');
}

section('inherited property names are refused, not resolved');
{
  // The alias tables were plain objects, so ROOT_ALIASES['toString'] returned
  // Object.prototype.toString and the path resolved to a function mid-validation.
  // The same trap this file already guards for __proto__, walked into again by a
  // table that did not use Object.hasOwn. Both tables are Maps now; this pins it.
  for (const p2 of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
    let threw = false;
    let r = null;
    try { r = parsePath(p2); } catch (e) { threw = true; }
    check(`${p2} does not throw`, threw === false, threw ? 'threw during validation' : '');
    check(`  and is refused`, r !== null && r.ok === false, r && r.ok ? 'was accepted' : '');
  }
}

section('ambiguous words are still refused rather than guessed');
{
  // `title` at the root could be the person's current title or a job title, and
  // quietly choosing is exactly the failure this table exists to prevent. The
  // model is told the two real keys instead.
  const r = parsePath('title');
  check('a bare `title` is refused, not guessed', r.ok === false, r.ok ? `went to ${r.root}` : '');
  check('and the refusal names a real field', /current_title|role/.test(r.error || ''), r.error);
  // Inside a role it is unambiguous, and there the alias already handles it.
  const inRole = parsePath('employment[0].title');
  check('`employment[0].title` is accepted', inRole.ok === true, inRole.error);
}

section('genuinely unknown fields are refused, with a suggestion');
{
  for (const p of ['salary', 'references', 'hobbies', 'github_handle', 'nickname']) {
    const r = parsePath(p);
    check(`${p} is refused`, r.ok === false, r.ok ? 'was accepted' : '');
  }
  // The message has to be actionable. "Writable: name, current_title, ..." is
  // true and useless when the model was reaching for one specific word.
  const near = parsePath('emial');
  check('a near miss suggests the right field', /Did you mean "email"/.test(near.error || ''), near.error);
  const near2 = parsePath('curent_title');
  check('a typo of a real field is caught', /Did you mean/.test(near2.error || ''), near2.error);
}

section('the headline edit lands, end to end');
{
  const before = { name: 'Joseph Andrew Lee', current_title: 'Founder', summary: 'Sales and media.' };
  const r = applyEdits(JSON.parse(JSON.stringify(before)), [
    { op: 'set', path: 'identity.headline', value: 'Consultative Sales Lead' },
  ]);
  check('the edit applies', r.ok === true, r.error);
  check('and the headline changed', r.dossier?.current_title === 'Consultative Sales Lead',
    JSON.stringify(r.dossier?.current_title));
  check('and nothing else moved', r.dossier?.name === 'Joseph Andrew Lee' && r.dossier?.summary === 'Sales and media.');
  check('the audit records the canonical path, not the UI one',
    JSON.stringify(r.audits).includes('current_title'), JSON.stringify(r.audits).slice(0, 160));
}

section('the writable list still tells the truth');
{
  for (const p of ['current_title', 'links.github', 'employment.start', 'summary', 'skills']) {
    check(`${p} is writable`, WRITABLE_PATHS.includes(p), WRITABLE_PATHS.filter(x => x.startsWith(p.slice(0, 6))).join(', '));
  }
  check('the list has no duplicates', new Set(WRITABLE_PATHS).size === WRITABLE_PATHS.length);
}

console.log(fails === 0
  ? '\n  a word that names a real field is accepted, and a refusal teaches'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
