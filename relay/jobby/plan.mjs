/**
 * relay/jobby/plan.mjs — Turn a dossier into an executable search plan
 *
 * Runs the moment a resume is parsed, because the client is unemployed and the
 * clock is the enemy. The plan is ordered by what unblocks income soonest, not
 * by what is easiest to do well.
 *
 * Every action is concrete enough to start immediately. "Improve your profile"
 * is not an action; "Confirm the four fields the resume never stated" is.
 */

import { TRACKS, decideTracks } from './tracks.mjs';

/** Fields worth pressing the client on: they gate outreach quality. */
const OUTREACH_CRITICAL = [
  'email', 'phone', 'location', 'current_title', 'current_company',
];
const TARGETING_CRITICAL = ['target_roles', 'roles_in_resume', 'domain_expertise'];

function firstOf(dossier, ...keys) {
  for (const k of keys) {
    const v = dossier?.[k];
    if (Array.isArray(v) && v.length) return v;
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/**
 * Build the plan.
 * @param dossier  the parsed dossier
 * @param opts.tracks  explicit track set, or null to decide from the dossier
 */
export function buildPlan(dossier, opts = {}) {
  const decision = opts.tracks
    ? decideTracks(dossier, { userOverride: opts.tracks })
    : decideTracks(dossier);
  const tracks = decision.tracks;

  const missing = Array.isArray(dossier?.not_stated) ? dossier.not_stated : [];
  const missingOutreach = OUTREACH_CRITICAL.filter(
    f => !dossier?.[f] && !missing.includes(f));
  const missingTargeting = TARGETING_CRITICAL.filter(
    f => !firstOf(dossier, f));

  const roles = firstOf(dossier, 'target_roles', 'roles_in_resume') || [];
  const name = dossier?.name || 'you';
  const actions = [];
  const add = (a) => actions.push({ priority: 3, track: null, ...a });

  // ── P0: today. Nothing else works until these are settled. ───────────
  if (missingOutreach.length || missingTargeting.length) {
    const parts = [...missingOutreach, ...missingTargeting];
    add({
      priority: 1,
      title: `Close ${parts.length} gap${parts.length === 1 ? '' : 's'} in your dossier`,
      detail:
        `The resume never stated: ${parts.join(', ')}. Outreach that guesses your ` +
        `phone number or misnames your title gets you filtered out, and I will not ` +
        `invent them. Confirm these in chat and I will write them in.`,
    });
  }

  add({
    priority: 1,
    title: 'Confirm your target roles and rate floor',
    detail:
      `Tell me the roles you want and the number you need per ${dossier?.employment?.[0]?.current === false ? 'day' : 'year'}. ` +
      `Current read from the resume: ${roles.length ? roles.slice(0, 4).join(', ') : 'nothing yet'}. ` +
      `I will not apply you to roles below your floor.`,
  });

  // ── P1: this week. Build the packet that every application reuses. ────
  add({
    priority: 1,
    title: 'Lock the canonical application packet',
    detail:
      'One resume, one contact block, one summary — used everywhere so every ' +
      'application is recognisably the same person. Built from the dossier, ' +
      'with your wording.',
  });

  if (tracks.includes(1)) {
    add({
      priority: 1,
      track: 1,
      title: 'Build the consulting offer',
      detail:
        'Name the outcomes you sell, the rate, and who pays for them. A ' +
        'consultant with a one-line offer books meetings; a consultant with a ' +
        'CV does not.',
    });
  }

  // ── P2: sourcing, per active track. ───────────────────────────────────
  const targetCounts = { 1: 20, 2: 25, 3: 40, 4: 60 };
  for (const t of tracks) {
    const meta = TRACKS[t];
    add({
      priority: 2,
      track: t,
      title: `Source ${targetCounts[t] || 30} ${meta.name.toLowerCase()} opportunities`,
      detail:
        `${meta.blurb} ${decision.reasons[t] || ''}`.trim(),
    });
    add({
      priority: 2,
      track: t,
      title: `Research each target before contacting anyone (track ${t})`,
      detail:
        'Who funds the work, who decides, what they shipped recently, and why ' +
        'this candidate is a fit. No blind applications.',
    });
  }

  // ── P3: the ongoing loop. ─────────────────────────────────────────────
  add({
    priority: 3,
    title: 'Run the outreach cadence',
    detail:
      'Contact in priority order, record every send, follow up on a schedule. ' +
      'Silence is data — a no-response threshold triggers a rewrite, not more volume.',
  });

  add({
    priority: 3,
    title: 'Work the pipeline daily',
    detail:
      'New applications, replies, interview prep, and follow-ups. I will tell you ' +
      'the number that matters each morning.',
  });

  if (tracks.includes(1) || tracks.includes(2)) {
    add({
      priority: 3,
      title: 'Convert open contracts into extensions or permanent offers',
      detail:
        'A contract that ends is income that stops. Every live engagement gets an ' +
        'extension conversation before its end date.',
    });
  }

  // ── P4: after placement. The job does not end the mission. ───────────
  add({
    priority: 4,
    title: 'Protect the offer: review, equity, and the 90-day plan',
    detail:
      'Once income is secured the priority shifts to not losing it — comp review ' +
      'date, notice period, and what would make you want to stay.',
  });
  add({
    priority: 4,
    title: 'Keep the second income stream running',
    detail:
      'Retain the consulting and contract pipeline alongside the role. Two ' +
      'incomes is the difference between a bad quarter and a missed mortgage.',
  });

  actions.sort((a, b) => a.priority - b.priority);

  return {
    tracks,
    trackReasons: decision.reasons,
    signals: decision.signals,
    sellsServices: decision.sellsServices,
    actions,
    generatedAt: new Date().toISOString(),
  };
}

/** One-paragraph summary for chat and the portal header. */
export function planSummary(plan, dossier) {
  const byTrack = {};
  for (const a of plan.actions) {
    const key = a.track || 0;
    (byTrack[key] ||= []).push(a.title);
  }
  const trackLines = plan.tracks
    .map(t => `Track ${t} (${TRACKS[t].name}): ${(byTrack[t] || []).length} actions`)
    .join('\n');
  return [
    `Plan ready for ${dossier?.name || 'this client'}. ${plan.actions.length} actions across ${plan.tracks.length} tracks.`,
    trackLines,
    '',
    'Start here:',
    ...plan.actions.filter(a => a.priority === 1).slice(0, 3).map(a => `  - ${a.title}`),
  ].join('\n');
}
