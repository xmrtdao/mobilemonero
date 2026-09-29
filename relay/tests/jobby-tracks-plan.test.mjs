#!/usr/bin/env node
// Tests for the pure decision logic: track selection and plan generation.
// No database, no network — these must stay deterministic.
import { decideTracks, explainTracks, TRACKS, BASE_TRACKS } from '../jobby/tracks.mjs';
import { buildPlan, planSummary } from '../jobby/plan.mjs';

let fails = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ── Track decision ──────────────────────────────────────────────────────
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
  check('all four tracks', d.tracks.length === 4, d.tracks);
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

// ── Plan ────────────────────────────────────────────────────────────────
section('plan for an employee resume');
{
  const dossier = {
    name: 'Jordan Ellis', email: 'john@example.com', phone: '(804) 555-0142',
    location: 'Richmond, VA', current_title: 'Lead Platform Engineer',
    current_company: 'Acme Systems',
    not_stated: ['seniority'],
    target_roles: ['Platform Engineer'],
  };
  const plan = buildPlan(dossier);
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
  const plan = buildPlan({ name: 'No Contact' });
  const gap = plan.actions.find(a => /gap/i.test(a.title));
  check('gap action exists', !!gap);
  check('names email as missing', /email/.test(gap.detail), gap.detail);
  check('names phone as missing', /phone/.test(gap.detail), gap.detail);
}

section('plan for a consultant includes the offer action');
{
  const plan = buildPlan({ name: 'Dana Fox', current_title: 'Independent Consultant' });
  check('four tracks', plan.tracks.length === 4, plan.tracks);
  check('consulting offer action', plan.actions.some(a => /consulting offer/i.test(a.title)));
  check('contract conversion action', plan.actions.some(a => /convert open contracts/i.test(a.title)));
  check('second income stream action', plan.actions.some(a => /second income/i.test(a.title)));
}

section('plan always covers post-placement work');
{
  const plan = buildPlan({ name: 'X' });
  check('offer protection', plan.actions.some(a => /protect the offer/i.test(a.title)));
  check('cadence', plan.actions.some(a => /cadence/i.test(a.title)));
  check('daily pipeline', plan.actions.some(a => /pipeline daily/i.test(a.title)));
}

section('plan is deterministic');
{
  const d = { name: 'A', current_title: 'Consultant' };
  const a = JSON.stringify(buildPlan(d).actions.map(x => x.title));
  const b = JSON.stringify(buildPlan(d).actions.map(x => x.title));
  check('same input, same plan', a === b);
}

section('plan with explicit tracks');
{
  const plan = buildPlan({ name: 'A' }, { tracks: [1, 2, 3, 4] });
  check('respects explicit tracks', plan.tracks.length === 4, plan.tracks);
  check('sourcing action per track', [1, 2, 3, 4].every(t =>
    plan.actions.some(a => a.track === t && /Source/.test(a.title))));
}

console.log('\n' + (fails === 0 ? 'all track/plan tests passed' : fails + ' FAILED'));
process.exit(fails === 0 ? 0 : 1);
