// Merging a second resume into a dossier that already exists.
//
// The case this is built for is real: the same person, two CVs, the same four jobs
// written five different ways between them, plus one job that appears on only one
// of them. The first resume establishes the record; the second must round it out.
// Neither replacing it nor duplicating it is acceptable.
import { mergeDossiers } from '../jobby/dossier-merge.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const R = (company, title, extra = {}) => ({ company, title, ...extra });

// The broad CV: all four jobs, full detail, the whole skill list.
const BROAD = {
  name: 'Joseph Andrew Lee',
  email: 'joeyleepcs@gmail.com',
  phone: '+1-202-798-0610',
  summary: 'High-impact communicator and entrepreneur with 15+ years across media and high-value sales.',
  skills: ['Consultative Selling', 'Objection handling', 'CRM pipeline management', 'Public speaking'],
  links: { linkedin: 'linkedin.com/in/joecodes', github: null, portfolio: null, website: null },
  employment: [
    R('Party Favor Photo', 'Founder & Managing Director', { start: '2025', end: 'Present', current: true, highlights: ['Founded a media venture'] }),
    R('Cuttlefish Labs / XMRT DAO', 'Multi-Agent Systems Architect & Founder', { start: '2024', end: 'Present', current: true, highlights: ['Architected agent systems'] }),
    R('United Service Organizations (USO)', 'Senior Multimedia Journalist & Content Strategist', { start: '2015', end: '2021', highlights: ['Published in People Magazine'] }),
    R('United States Marine Corps', 'Combat Correspondent & Media Liaison (Sergeant / E-5)', { start: '2004', end: '2014', highlights: ['Wikipedia Featured Picture'] }),
  ],
  education: [{ institution: 'Harvard University', degree: "Master's Degree", field: 'Journalism & Advanced Communication', year: null }],
  not_stated: ['github', 'portfolio', 'website', 'seniority'],
  sourceFilename: 'Joseph Andrew Lee Resume - Sales ELVTR.docx',
};

// The tailored CV: aimed at a different kind of work. Same person, and it adds a
// role the broad one never mentions.
const TAILORED = {
  name: 'Joseph Andrew Lee',
  email: 'joeyleepcs@gmail.com',
  phone: '+1-202-798-0610',
  summary: 'Sales leader focused on consultative closing and high-ticket conversions.',
  skills: ['High-ticket program conversions', 'Consultative discovery', 'Referral generation'],
  links: { linkedin: 'linkedin.com/in/joecodes', github: 'github.com/xmrtdao' },
  employment: [
    // Same job, shorter title, all-caps employer, no dates restated.
    R('PARTY FAVOR PHOTO', 'Founder', { start: '2025', end: 'Present', current: true, highlights: ['Top-tier retention'] }),
    // Same job, acronym for the employer, a shorter title.
    R('USO', 'Senior Multimedia Journalist', { start: '2015', end: '2021' }),
    // A role that exists only in this document. It must be added, not folded
    // into a neighbour.
    R('1st Surveillance, Reconnaissance Group', 'LVS Operator', { start: '1997', end: '2004' }),
  ],
  education: [{ institution: 'Harvard University', degree: "Master's", field: 'Journalism', year: null }],
  not_stated: ['portfolio', 'website', 'seniority'],
  sourceFilename: 'Joseph Andrew Lee Resume - Media Relations.docx',
};

section('a first upload is stored as-is');
{
  const { dossier, changes, stats } = mergeDossiers(null, BROAD);
  check('nothing is lost', JSON.stringify(dossier) === JSON.stringify(BROAD));
  check('it is reported as a creation', changes[0].op === 'created', JSON.stringify(changes[0]));
  check('with no conflicts', stats.conflicts === 0);
}

section('a second resume augments rather than replaces');
{
  const { dossier: first } = mergeDossiers(null, BROAD);
  const { dossier: merged, stats } = mergeDossiers(first, TAILORED);

  check('every role from the first resume survives',
    ['Party Favor Photo', 'Cuttlefish Labs / XMRT DAO', 'United Service Organizations (USO)',
      'United States Marine Corps'].every(c => merged.employment.some(e => e.company === c)),
    merged.employment.map(e => e.company).join(' | '));

  check('the role only the second resume mentions is added',
    merged.employment.some(e => e.company.includes('Surveillance')),
    merged.employment.map(e => e.company).join(' | '));

  check('no employer is listed twice',
    new Set(merged.employment.map(e => e.company.toLowerCase().replace(/[^a-z]/g, ''))).size === merged.employment.length,
    merged.employment.map(e => e.company).join(' | '));

  check('the four original jobs plus the new one make five',
    merged.employment.length === 5, String(merged.employment.length));

  check('highlights from both documents are combined, not replaced',
    merged.employment[0].highlights.length === 2,
    JSON.stringify(merged.employment[0].highlights));
}

section('skills accumulate across resumes');
{
  const { dossier: first } = mergeDossiers(null, BROAD);
  const { dossier: merged, stats } = mergeDossiers(first, TAILORED);
  const skills = merged.skills;
  check('the first resume skills are all still there',
    ['Consultative Selling', 'Objection handling', 'CRM pipeline management', 'Public speaking'].every(s => skills.includes(s)),
    skills.join(' | '));
  check('and the second resume added its own',
    ['High-ticket program conversions', 'Consultative discovery', 'Referral generation'].every(s => skills.includes(s)),
    skills.join(' | '));
  check('with no duplicates', new Set(skills.map(s => s.toLowerCase())).size === skills.length, skills.join(' | '));
  check('and the count is reported', stats.added_skills === 3, String(stats.added_skills));
}

section('a gap closed by the second resume is closed');
{
  const { dossier: first } = mergeDossiers(null, BROAD);
  check('github is a gap before the second resume', first.not_stated.includes('github'), first.not_stated.join(', '));
  const { dossier: merged } = mergeDossiers(first, TAILORED);
  check('the GitHub handle is stored', merged.links.github === 'github.com/xmrtdao', merged.links.github);
  check('and the gap is no longer listed',
    !merged.not_stated.includes('github'), merged.not_stated.join(', '));
  check('while the gaps that remain are still listed',
    ['portfolio', 'website', 'seniority'].every(g => merged.not_stated.includes(g)), merged.not_stated.join(', '));
  // A union here would leave "github" listed forever while the dossier held the
  // URL - a record that contradicts itself and would show the candidate a false
  // gap in every review.
}

section('a disagreement about a date is surfaced, not decided');
{
  const corrected = {
    ...TAILORED,
    employment: [R('Party Favor Photo', 'Founder & Managing Director', { start: '2015', end: 'Present', current: true })],
  };
  const { dossier: first } = mergeDossiers(null, BROAD);
  const { dossier: merged, changes, stats } = mergeDossiers(first, corrected);

  check('the start date on file is untouched', merged.employment[0].start === '2025', merged.employment[0].start);
  const conflict = changes.find(c => c.op === 'conflict');
  check('the disagreement is reported', !!conflict, JSON.stringify(changes.filter(c => c.op === 'conflict')));
  check('it names the field', conflict?.field === 'start', JSON.stringify(conflict));
  check('and shows both values', conflict?.have === '2025' && conflict?.incoming === '2015', JSON.stringify(conflict));
  check('and is counted', stats.conflicts === 1, String(stats.conflicts));
}

section('a narrow resume cannot delete a broad one');
{
  const { dossier: first } = mergeDossiers(null, BROAD);
  // The narrowest possible document: one role, no summary, no education.
  const tiny = {
    name: 'Joseph Andrew Lee',
    employment: [R('Party Favor Photo', 'Founder', { start: '2025', current: true })],
    skills: ['Consultative Selling'],
  };
  const { dossier: merged, stats } = mergeDossiers(first, tiny);
  check('all four roles remain', merged.employment.length === 4, String(merged.employment.length));
  check('the summary is not emptied', !!merged.summary, merged.summary);
  check('the education is not emptied', merged.education.length === 1, String(merged.education.length));
  check('the LinkedIn link is not emptied', merged.links.linkedin === 'linkedin.com/in/joecodes');
  check('and the preserved count reflects it', stats.preserved > 0, String(stats.preserved));
}

section('every source document is remembered');
{
  const { dossier: first } = mergeDossiers(null, BROAD);
  const { dossier: merged } = mergeDossiers(first, TAILORED);
  check('both filenames are on the record',
    (merged.sourceFilenames || []).length === 2, JSON.stringify(merged.sourceFilenames));
  check('and the newest is also current', merged.sourceFilename === TAILORED.sourceFilename, merged.sourceFilename);
}

section('merging is idempotent');
{
  // The same resume uploaded twice must not double the skills or the roles. An
  // ingest that retried, or a user who re-uploaded by mistake, is routine.
  const { dossier: first } = mergeDossiers(null, BROAD);
  const once = mergeDossiers(first, TAILORED).dossier;
  const twice = mergeDossiers(once, TAILORED).dossier;
  check('the second merge changes nothing',
    JSON.stringify(once) === JSON.stringify(twice),
    `roles ${once.employment.length} -> ${twice.employment.length}, skills ${once.skills.length} -> ${twice.skills.length}`);
}

console.log(fails === 0
  ? '\n  a second resume rounds out the dossier without duplicating or erasing it'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
