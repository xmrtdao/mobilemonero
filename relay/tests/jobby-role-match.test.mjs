// The role matcher, against the real collisions and the real non-collisions.
//
// A duplicate-role merge is a quiet, permanent corruption of the record a job
// application is built from, so both directions are asserted: the same job in
// different words must collapse to one entry, and a different job must survive
// even when it looks similar. Every pair below is taken from real extractions of
// one person's CVs, not invented.
import { sameRole, titleOverlap, companyOverlap, fold } from '../jobby/role-match.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');
const R = (company, title, extra = {}) => ({ company, title, ...extra });

section('the same role in different words is one role');
{
  // All four of these came out of the same person's documents.
  const pairs = [
    ['case only', R('PARTY FAVOR PHOTO', 'Founder & Managing Director'), R('Party Favor Photo', 'Founder & Managing Director')],
    ['legal suffix', R('Party Favor Photo LLC', 'Founder'), R('Party Favor Photo', 'Founder & Managing Director')],
    ['subset title', R('United Service Organizations (USO)', 'Senior Multimedia Journalist & Content Strategist'), R('United Service Organizations (USO)', 'Senior Multimedia Journalist')],
    ['acronym in company', R('United Service Organizations (USO)', 'Senior Multimedia Journalist'), R('USO', 'Senior Multimedia Journalist')],
    ['ampersand vs and', R('Sales & Marketing', 'Lead'), R('Sales and Marketing', 'Lead')],
  ];
  for (const [label, a, b] of pairs) {
    const r = sameRole(a, b);
    check(`${label} matches`, r.same === true, `company ${r.company.toFixed(2)} title ${r.title.toFixed(2)}`);
  }
}

section('different jobs are never merged');
{
  // The dangerous direction. Each of these is a distinct role in the real data,
  // and collapsing any of them would delete a job from the record.
  const pairs = [
    ['two different employers', R('Party Favor Photo', 'Founder'), R('Cuttlefish Labs', 'Founder')],
    ['same employer, different role', R('Party Favor Photo', 'Founder'), R('Party Favor Photo', 'Photographer')],
    ['founder vs managing director at one employer', R('Acme', 'Founder'), R('Acme', 'Managing Director')],
    ['the LVS role is its own job', R('1st Surveillance, Reconnaissance', 'LVS Operator'), R('United States Marine Corps', 'Combat Correspondent')],
    ['two consulting firms', R('Whitfield Advisory LLC', 'Principal Consultant'), R('Smith & Co', 'Consultant')],
  ];
  for (const [label, a, b] of pairs) {
    const r = sameRole(a, b);
    check(`${label} stays separate`, r.same === false, `company ${r.company.toFixed(2)} title ${r.title.toFixed(2)}`);
  }
}

section('a shared title alone is not enough');
{
  // "Consultant" appears at several of this person's employers. Title overlap is
  // near-total; company overlap is near-zero. The matcher must refuse.
  const r = sameRole(R('Whitfield Advisory LLC', 'Consultant'), R('Cuttlefish Labs', 'Consultant'));
  check('identical titles at different employers do not match', r.same === false, JSON.stringify(r));
  check('and it is the company signal that failed, not the title',
    r.title > 0.9 && r.company < 0.5, `title ${r.title.toFixed(2)} company ${r.company.toFixed(2)}`);
}

section('a shared employer alone is not enough');
{
  const r = sameRole(R('Party Favor Photo', 'Founder'), R('Party Favor Photo', 'Director of Photography'));
  check('the same employer with an unrelated title does not match', r.same === false,
    `title ${r.title.toFixed(2)}`);
}

section('disagreeing dates are reported, never silently resolved');
{
  // This is the real correction: the user says Party Favor Photo began in 2015,
  // while every extraction from the document says 2025. Picking either one
  // without asking would put a false claim on a job application.
  const r = sameRole(
    R('Party Favor Photo', 'Founder & Managing Director', { start: '2015', current: true }),
    R('Party Favor Photo', 'Founder & Managing Director', { start: '2025', current: true }),
  );
  check('the roles are recognised as the same job', r.same === true, JSON.stringify(r));
  check('but the date disagreement is flagged', r.dateConflict !== null, JSON.stringify(r.dateConflict));
  check('and it names the start field', r.dateConflict?.field === 'start', JSON.stringify(r.dateConflict));
}

section('"2015" and "January 2015" are not a disagreement');
{
  const r = sameRole(
    R('Acme', 'Director', { start: '2015', end: '2018' }),
    R('Acme', 'Director', { start: 'January 2015', end: 'August 2018' }),
  );
  check('the same year in two formats is agreement', r.dateConflict === null, JSON.stringify(r.dateConflict));
}

section('dates carry weight, not just conflict detection');
{
  // A genuinely WEAK title match at one employer - "Marketing Director" against
  // "Director, Brand Strategy" shares one word of four. It is accepted only
  // because the dates line up, and refused once they are removed. That is the
  // date signal doing the work rather than the title.
  //
  // A strong containment match is the opposite case and must NOT depend on dates:
  // "Founder" inside "Founder & Managing Director" is the same job said briefly,
  // and a tailored resume will often drop the dates along with the words.
  const weak = sameRole(
    R('Party Favor Photo', 'Marketing Director', { start: '2025', end: 'Present' }),
    R('Party Favor Photo', 'Director, Brand Strategy', { start: '2025', end: 'Present' }),
  );
  check('a weak title match is accepted when the dates agree', weak.same === true,
    `title ${weak.title.toFixed(2)} dates ${weak.dates}`);

  const weakNoDates = sameRole(
    R('Party Favor Photo', 'Marketing Director'),
    R('Party Favor Photo', 'Director, Brand Strategy'),
  );
  check('and refused when neither document states dates', weakNoDates.same === false,
    `title ${weakNoDates.title.toFixed(2)} dates ${weakNoDates.dates}`);

  const contained = sameRole(
    R('Party Favor Photo', 'Founder & Managing Director'),
    R('Party Favor Photo', 'Founder'),
  );
  check('a contained title matches with no dates at all', contained.same === true,
    `title ${contained.title.toFixed(2)}`);
}

section('two tenures at one employer are two roles');
{
  // Same company, overlapping titles, provably different years. This is the case
  // that makes dates worth consulting at all.
  const r = sameRole(
    R('Acme', 'Director', { start: '2015', end: '2018' }),
    R('Acme', 'Director', { start: '2020', end: 'Present' }),
  );
  check('provably disjoint tenures do not match', r.same === false, `dates ${r.dates}`);
  check('and the dates are reported as disjoint', r.dates === 0, r.dates);

  // Overlapping tenures at one employer with the same title are the same job.
  const o = sameRole(
    R('Acme', 'Director', { start: '2015', end: '2018' }),
    R('Acme', 'Director', { start: '2016', end: '2019' }),
  );
  check('overlapping tenures do match', o.same === true, `dates ${o.dates}`);
}

section('two current roles at one employer are flagged, not merged blindly');
{
  const r = sameRole(
    R('Studio One', 'Producer', { start: '2020', current: true }),
    R('Studio One', 'Producer', { start: '2020', current: true }),
  );
  check('the pair is recognised as the same title', r.title >= 0.95, r.title.toFixed(2));
  check('and reported as ambiguous rather than silently merged', r.ambiguous === true,
    JSON.stringify({ same: r.same, ambiguous: r.ambiguous }));
}

section('the similarity primitives behave');
{
  check('folding is case and punctuation insensitive',
    fold('PARTY FAVOR Photo') === fold('Party Favor Photo'), fold('PARTY FAVOR Photo'));
  check('folding strips accents',
    fold('José Ramírez') === fold('Jose Ramirez'), fold('José Ramírez'));
  // The legal suffix is handled by the matcher, not by fold, which is a raw
  // normaliser and keeps every word it is given.
  check('fold keeps the suffix; the matcher discounts it',
    fold('Party Favor Photo LLC') !== fold('Party Favor Photo')
    && companyOverlap('Party Favor Photo LLC', 'Party Favor Photo') > 0.7,
    companyOverlap('Party Favor Photo LLC', 'Party Favor Photo').toFixed(2));
  check('a contained title scores high',
    titleOverlap('Senior Multimedia Journalist & Content Strategist', 'Senior Multimedia Journalist') > 0.6,
    titleOverlap('Senior Multimedia Journalist & Content Strategist', 'Senior Multimedia Journalist').toFixed(2));
  check('a one-word title is not folded away',
    titleOverlap('Lead', 'Lead') === 1, titleOverlap('Lead', 'Lead').toFixed(2));
  check('an unrelated title scores low',
    titleOverlap('Founder', 'Marine Combat Correspondent') < 0.3,
    titleOverlap('Founder', 'Marine Combat Correspondent').toFixed(2));
  check('company suffixes are discounted',
    companyOverlap('Cuttlefish Labs', 'Cuttlefish Labs / XMRT DAO') > 0.7,
    companyOverlap('Cuttlefish Labs', 'Cuttlefish Labs / XMRT DAO').toFixed(2));
  check('unrelated companies score low',
    companyOverlap('Party Favor Photo', 'Harvard University') < 0.3,
    companyOverlap('Party Favor Photo', 'Harvard University').toFixed(2));
}

console.log(fails === 0
  ? '\n  the matcher collapses restatements and preserves distinct jobs'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
