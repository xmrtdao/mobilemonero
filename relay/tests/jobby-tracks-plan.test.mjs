#!/usr/bin/env node
// Tests for the pure decision logic: track selection and plan generation.
// No database, no network â€” these must stay deterministic.
import { decideTracks, explainTracks, TRACKS, BASE_TRACKS } from '../jobby/tracks.mjs';
import { buildPlan, planSummary } from '../jobby/plan.mjs';

let fails = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// â”€â”€ Track decision â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
section('base tracks for an ordinary employee resume');
{
  const d = decideTracks({
    name: 'Sam Reed', current_title: 'Software Engineer',
    skills: ['Python'], employment: [{ company: 'Acme', title: 'Software Engineer', current: true }],
  });
  check('track 3 on', d.tracks.includes(3), d.tracks);
  check('track 4 on', d.tracks.includes(4), d.tracks);
  check('track 1 off', !d.tracks.includes(1), d.tracks);
  check('track 2 off', !d.tracks.includes(2), d.tracks);
  check('does not sell services', d.sellsServices === false);
  check('base tracks are 3,4', JSON.stringify(d.tracks) === JSON.stringify(BASE_TRACKS), d.tracks);
}

section('consultant opens tracks 1 and 2');
{
  const d = decideTracks({
    name: 'Dana Fox', current_title: 'Independent Consultant',
    summary: 'Independent consultant advising fintech clients on compliance.',
  });
  check('track 1 on', d.tracks.includes(1), d.tracks);
  check('track 2 on', d.tracks.includes(2), d.tracks);
  // 1,2,3,4 â€” and NOT 5. This dossier is a compliance consultant with no
  // statement about rotating, so track 5 must stay closed. Asserting the
  // length alone would pass with a stray 5 in place of a missing 1.
  check('tracks 1,2,3,4 and no FIFO', d.tracks.length === 4 && !d.tracks.includes(5), d.tracks);
  check('sells services', d.sellsServices === true);
  check('reason explains why', /consult/i.test(d.reasons[1] || ''), d.reasons);
}

section('business owner opens tracks 1 and 2');
{
  const d = decideTracks({
    name: 'Rae Nolan', current_title: 'Founder & CEO',
    summary: 'Founder and owner of a 12-person studio. Registered as Nolan Studio LLC.',
  });
  check('track 1 on (owner)', d.tracks.includes(1), d.tracks);
  check('track 2 on', d.tracks.includes(2), d.tracks);
  check('llc signal captured', d.signals.some(s => /entity/i.test(s)), d.signals);
}

section('freelancer opens tracks 1 and 2');
{
  const d = decideTracks({
    summary: 'Freelance product designer. Self-employed, available immediately, day rate $900.',
  });
  check('track 1 on (freelance)', d.tracks.includes(1), d.tracks);
  check('track 2 on', d.tracks.includes(2), d.tracks);
}

section('senior + contract signals open the tracks');
{
  const d = decideTracks({
    current_title: 'Senior Platform Engineer',
    summary: 'Available immediately for a contract-to-hire engagement.',
  });
  check('senior + contract opens track 1', d.tracks.includes(1), { tracks: d.tracks, signals: d.signals });
}

section('seniority alone does NOT open consulting');
{
  const d = decideTracks({
    current_title: 'Senior Software Engineer',
    summary: 'Ten years building internal billing systems at a large retailer.',
  });
  check('track 1 stays closed', !d.tracks.includes(1), { tracks: d.tracks, signals: d.signals });
  check('track 2 stays closed', !d.tracks.includes(2), d.tracks);
  check('but seniority is still reported', d.signals.some(s => /senior/i.test(s)), d.signals);
}

section('temp/contract worker without seniority');
{
  const d = decideTracks({
    current_title: 'Contract Designer',
    summary: 'Six-month contract role. Worked on agency staffing for two years.',
  });
  // No senior title, no independent practice -> base tracks only.
  check('no false consulting', !d.tracks.includes(1), { tracks: d.tracks, signals: d.signals });
}

section('user override');
{
  const d = decideTracks({ current_title: 'Engineer' }, { userOverride: [1, 2] });
  check('override adds 1 and 2', d.tracks.includes(1) && d.tracks.includes(2), d.tracks);
  check('override keeps base', d.tracks.includes(3) && d.tracks.includes(4), d.tracks);
  check('sorted', JSON.stringify(d.tracks) === '[1,2,3,4]', d.tracks);
  check('override reason recorded', !!d.reasons[1], d.reasons);
  const bad = decideTracks({ current_title: 'Engineer' }, { userOverride: [1, 99, 'x'] });
  check('invalid track numbers dropped', !bad.tracks.includes(99), bad.tracks);
  const fifo = decideTracks({ current_title: 'Engineer' }, { userOverride: [5] });
  check('override can open track 5', fifo.tracks.includes(5), fifo.tracks);
}

// â”€â”€ Track 5. The load-bearing case is what must NOT open it. â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// "Has done site work" and "wants to do site work" are different claims. An
// earlier cut opened track 5 on the first, which put fly-in/fly-out roles in
// front of people who have dependants and never asked for a rotation.
section('FIFO opens only on a stated willingness');
{
  const opens = [
    ['fly-in/fly-out named', { summary: 'Open to fly-in fly-out rotations.' }],
    ['seeking remote site work', { summary: 'Looking for remote site work in mining.' }],
    ['willing to travel', { summary: 'Willing to travel for the right role.' }],
    ['willing to relocate', { summary: 'Willing to relocate.' }],
    ['happy relocating', { summary: 'Happy relocating.' }],
    ['available for rotations', { summary: 'Can do rotations, available immediately.' }],
    ['seeking offshore', { summary: 'Seeking offshore roles.' }],
  ];
  for (const [label, dossier] of opens) {
    const d = decideTracks(dossier);
    check(`opens: ${label}`, d.tracks.includes(5), { tracks: d.tracks, signals: d.fifo.signals });
  }
}

section('FIFO stays closed on site experience alone');
{
  const staysClosed = [
    ['northern mine camp', { summary: 'Red Seal electrician. Five years at a northern mine camp.' }],
    ['offshore rig tech', { summary: 'Offshore rig technician, HSE.' }],
    ['merchant marine', { summary: 'Merchant marine engineer, AB.' }],
    ['polar station', { summary: 'Technician, Antarctic research station.' }],
    ['journeyperson welder', { summary: 'Journeyperson welder, Red Seal.' }],
    ['oil sands driller', { summary: 'Driller, oil sands.' }],
    ['remote construction', { summary: 'Steel erector on remote construction camp.' }],
  ];
  for (const [label, dossier] of staysClosed) {
    const d = decideTracks(dossier);
    check(`closed: ${label}`, !d.tracks.includes(5), { tracks: d.tracks, signals: d.signals });
  }
}

section('FIFO is offered, not opened, when experience fits but nothing was asked');
{
  const d = decideTracks({ summary: 'Red Seal electrician. Five years at a northern mine camp.' });
  check('track 5 closed', !d.tracks.includes(5), d.tracks);
  check('offered by experience', d.fifo.offeredByExperience === true, d.fifo);
  check('supporting signals recorded', d.fifo.supporting.length > 0, d.fifo);
  check('no reason recorded for a closed track', !d.reasons[5], d.reasons);
}

section('FIFO does not open on vague availability');
{
  for (const dossier of [
    { summary: 'Open to new opportunities in software.' },
    { summary: 'Available immediately for a new role.' },
    { summary: 'Fast learner who can move quickly.' },
    { summary: 'Camping enthusiast.' },
    { current_title: 'Software Engineer' },
  ]) {
    const d = decideTracks(dossier);
    check('not opened by: ' + JSON.stringify(dossier.summary || dossier.current_title),
      !d.tracks.includes(5), { tracks: d.tracks, signals: d.signals });
  }
}

section('FIFO tickets are reported, not used as a gate');
{
  const d = decideTracks({ summary: 'Red Seal electrician and H2S/SCBA certified.' });
  check('tickets detected', d.fifo.tickets.length > 0, d.fifo.tickets);
  check('tickets do not open the track', !d.tracks.includes(5), d.tracks);
}

section('robustness');
{
  check('null dossier does not throw', decideTracks(null).tracks.length === 2);
  check('undefined dossier does not throw', decideTracks(undefined).tracks.length === 2);
  check('empty dossier does not throw', decideTracks({}).tracks.length === 2);
  const nested = decideTracks({ employment: [{ company: null, title: null }] });
  check('nested nulls safe', nested.tracks.length === 2, nested.tracks);
  check('explainTracks returns text', typeof explainTracks(decideTracks({})) === 'string');
  check('explainTracks mentions closed tracks', /tracks 1 and 2 stay closed/.test(explainTracks(decideTracks({}))));
}

// â”€â”€ Plan â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
section('plan for an employee resume');
{
  const dossier = {
    name: 'Jordan Ellis', email: 'john@example.com', phone: '(804) 555-0142',
    location: 'Richmond, VA', current_title: 'Lead Platform Engineer',
    current_company: 'Acme Systems',
    not_stated: ['seniority'],
    target_roles: ['Platform Engineer'],
  };
  const plan = await buildPlan(dossier);
  check('tracks 3,4 only', JSON.stringify(plan.tracks) === '[3,4]', plan.tracks);
  check('has actions', plan.actions.length > 5, plan.actions.length);
  check('every action has a title', plan.actions.every(a => a.title && a.title.length > 5));
  check('every action has detail', plan.actions.every(a => a.detail && a.detail.length > 10));
  check('priorities sorted', plan.actions.every((a, i, arr) => i === 0 || arr[i - 1].priority <= a.priority));
  check('track actions are valid tracks',
    plan.actions.filter(a => a.track).every(a => a.track >= 1 && a.track <= 4));
  check('no consulting action when track 1 off',
    !plan.actions.some(a => a.title.includes('consulting offer')));
  check('gaps action present', plan.actions.some(a => /gap/i.test(a.title)));
  check('summary is a string', typeof planSummary(plan, dossier) === 'string');
}

section('plan surfaces missing contact fields');
{
  const plan = await buildPlan({ name: 'No Contact' });
  const gap = plan.actions.find(a => /gap/i.test(a.title));
  check('gap action exists', !!gap);
  check('names email as missing', /email/.test(gap.detail), gap.detail);
  check('names phone as missing', /phone/.test(gap.detail), gap.detail);
}

section('plan for a consultant includes the offer action');
{
  const plan = await buildPlan({ name: 'Dana Fox', current_title: 'Independent Consultant' });
  check('four tracks', plan.tracks.length === 4, plan.tracks);
  check('consulting offer action', plan.actions.some(a => /consulting offer/i.test(a.title)));
  check('contract conversion action', plan.actions.some(a => /convert open contracts/i.test(a.title)));
  check('second income stream action', plan.actions.some(a => /second income/i.test(a.title)));
}

section('plan always covers post-placement work');
{
  const plan = await buildPlan({ name: 'X' });
  check('offer protection', plan.actions.some(a => /protect the offer/i.test(a.title)));
  check('cadence', plan.actions.some(a => /cadence/i.test(a.title)));
  check('daily pipeline', plan.actions.some(a => /pipeline daily/i.test(a.title)));
}

section('plan is deterministic');
{
  const d = { name: 'A', current_title: 'Consultant' };
  const first = await buildPlan(d);
  const second = await buildPlan(d);
  const a = JSON.stringify(first.actions.map(x => x.title));
  const b = JSON.stringify(second.actions.map(x => x.title));
  check('same input, same plan', a === b);
}

section('plan with explicit tracks');
{
  const plan = await buildPlan({ name: 'A' }, { tracks: [1, 2, 3, 4] });
  check('respects explicit tracks', plan.tracks.length === 4, plan.tracks);
  check('sourcing action per track', [1, 2, 3, 4].every(t =>
    plan.actions.some(a => a.track === t && /Source/.test(a.title))));
}

console.log('\n' + (fails === 0 ? 'all track/plan tests passed' : fails + ' FAILED'));
process.exit(fails === 0 ? 0 : 1);
