/**
 * relay/tests/jobby-role-date-conflict.test.mjs — a merge may not invent a tenure
 *
 * The regression this exists to prevent is concrete and it reached production.
 * Two of the candidate's own resumes described one job differently:
 *
 *   "Senior Multimedia Journalist & Content Strategist"  2015 - 2021
 *   "Senior Multimedia Journalist"                        2009 - 2019
 *
 * sameRole() matched them, correctly - same employer, near-identical title,
 * overlapping years. But it reported only ONE disagreeing date field, and the
 * merge protects exactly the fields it was told about and overwrites the rest.
 * `end` was reported and survived; `start` was not reported and was replaced
 * with 2009. The dossier then said 2015 -> 2019, a tenure that appears in
 * NEITHER document.
 *
 * A recruiter reads that as a claim the candidate made. It was a merge artefact,
 * and the rule the whole system is built on is that a dossier never contains a
 * claim nobody made.
 *
 * The fix has two halves and both are checked here, because either alone leaves
 * the bug alive: sameRole() must report every disagreement, and the merge must
 * protect every reported one.
 */
import { sameRole } from '../jobby/role-match.mjs';
import { mergeDossiers } from '../jobby/dossier-merge.mjs';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); return; }
  failures += 1;
  console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
};

const USO = 'United Service Organizations (USO)';

// The two descriptions, exactly as the two resumes carried them.
const A = { title: 'Senior Multimedia Journalist & Content Strategist', company: USO, start: '2015', end: '2021', current: false };
const B = { title: 'Senior Multimedia Journalist', company: 'USO (United Service Organizations)', start: '2009', end: '2019', current: false };

console.log('\n--- every disagreeing field is reported, not just the last ---');
{
  const r = sameRole(A, B);
  check('the two are still recognised as the same role', r.same === true, JSON.stringify(r));
  check('both dates are reported as conflicting',
    Array.isArray(r.dateConflicts) && r.dateConflicts.length === 2,
    JSON.stringify(r.dateConflicts));
  const fields = (r.dateConflicts || []).map((c) => c.field).sort().join(',');
  check('start and end are both listed', fields === 'end,start', fields);
  check('the single-field form is still available for old callers',
    r.dateConflict && typeof r.dateConflict.field === 'string', JSON.stringify(r.dateConflict));
}

console.log('\n--- the merge does not blend two tenures into a third ---');
{
  const m = mergeDossiers({ employment: [A] }, { employment: [B] });
  const role = (m.dossier.employment || [])[0];
  check('the role is still one row', (m.dossier.employment || []).length === 1,
    String((m.dossier.employment || []).length));
  // The specific corruption: start replaced with 2009, end left at 2021.
  check('the start is untouched', String(role.start) === '2015', String(role.start));
  check('the end is untouched', String(role.end) === '2021', String(role.end));
  check('so no tenure was invented',
    !(String(role.start) === '2009' && String(role.end) === '2021'),
    `${role.start}-${role.end}`);
}

console.log('\n--- and the disagreement is reported to the candidate ---');
{
  const m = mergeDossiers({ employment: [A] }, { employment: [B] });
  // The conflict has to reach the changes list, or it is protected but invisible:
  // the record keeps one version and nobody is ever told the documents differed.
  const conf = (m.changes || []).filter((c) => c.op === 'conflict');
  check('the conflict is surfaced as a change', conf.length > 0, JSON.stringify(m.changes).slice(0, 200));
  check('and the stats count it', (m.stats?.conflicts ?? 0) > 0, String(m.stats?.conflicts));
}

console.log('\n--- a role only ONE date disagrees on is still protected ---');
{
  // The single-disagreement case is the one the old code handled correctly, and
  // it is the one most likely to regress while fixing the two-field case.
  const C = { title: 'Combat Correspondent', company: 'U.S. Marine Corps', start: '1997', end: '2007' };
  const D = { title: 'Combat Correspondent', company: 'United States Marine Corps', start: '1997', end: '2010' };
  const r = sameRole(C, D);
  // "U.S." has to be understood as "United States" first, or the pair is scored
  // as two unrelated employers and never reaches the date logic at all. That was
  // its own bug: the punctuation stripper turned "U.S." into the noise tokens
  // "u s", scoring 0.45 against a 0.72 threshold, so the two spellings of the
  // same employer were reported as different companies.
  check('the two spellings of the same employer are recognised',
    r.same === true, 'company=' + r.company.toFixed(2));
  check('the end disagreement is reported', r.dateConflicts?.length === 1, JSON.stringify(r.dateConflicts));
  check('and it names the end', r.dateConflicts?.[0]?.field === 'end', JSON.stringify(r.dateConflicts));
  const m = mergeDossiers({ employment: [C] }, { employment: [D] });
  const role = (m.dossier.employment || [])[0];
  check('and the end survives', String(role.end) === '2007', String(role.end));
}

console.log('\n--- a matching pair still merges cleanly ---');
{
  // The fix must not stop legitimate merges. Same employer, same title, same
  // years, different wording - the case the matcher exists for.
  const C = { title: 'Director of Photography', company: 'Party Favor Photo', start: '2020', end: '2022' };
  const D = { title: 'Director', company: 'Party Favor Photo LLC', start: '2020', end: '2022' };
  const r = sameRole(C, D);
  check('a genuine match is still a match', r.same === true, JSON.stringify(r));
  check('with no conflicts to report', (r.dateConflicts || []).length === 0,
    JSON.stringify(r.dateConflicts));
  const m = mergeDossiers({ employment: [C] }, { employment: [D] });
  check('and it collapses to one row', (m.dossier.employment || []).length === 1,
    String((m.dossier.employment || []).length));
}

console.log(failures === 0
  ? '\nno merge invents a tenure'
  : `\n${failures} tenure check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
