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

import { TRACKS, decideTracks, FIFO_TRACK } from './tracks.mjs';
import { fifoBrief } from './fifo-roster.mjs';

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
// Async because fifoBrief() is: it imports the roster and measures it, and it
// returns `unavailable` rather than throwing so a candidate still gets their
// plan. There is exactly one caller (chat.mjs) and it already awaits.
export async function buildPlan(dossier, opts = {}) {
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
  // Track 5 has a lower count on purpose. The FIFO roster is 88 hand-sourced
  // roles rather than an open job board, so the work is qualification rather than
  // volume, and padding the target would just mean applications at postings the
  // candidate is not ticketed for.
  const targetCounts = { 1: 20, 2: 25, 3: 40, 4: 60, 5: 12 };
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

  // ── Track 5 specifics. Only when the track is actually open. ──────────
  //
  // These exist because the roster's weak links are the thing most likely to
  // waste a candidate's time, and the candidate is the only one who can resolve
  // them. 74 of the 88 roster entries do not link to a specific requisition, so
  // "apply to this" would usually mean "go and look for this".
  const rosterSummary = tracks.includes(FIFO_TRACK) ? await fifoBrief() : null;
  if (tracks.includes(FIFO_TRACK)) {
    const summary = rosterSummary;
    add({
      priority: 2,
      track: FIFO_TRACK,
      title: 'Confirm the rotation pattern before you apply anywhere',
      detail:
        `These are fly-in/fly-out and remote-site roles: fixed weeks on site, camp or ` +
        `bunk accommodation, and a season-length contract rather than a permanent post. ` +
        (summary.unavailable
          // Say the roster is unavailable rather than quoting a number I do not have.
          ? 'I cannot read the FIFO roster right now, so I am not going to tell you how many ' +
            'roles it holds. Ask me again in a moment.'
          : `The roster has ${summary.total} across ${summary.sectors.length} sectors, ` +
            `${summary.visaSponsoring} that will consider a visa, ${summary.entryPossible} open to ` +
            `people without a ticket. `) +
        `Check which pattern you can actually live with — this is your call, not mine, and ` +
        `it is the one thing that makes this track unsuitable or not.`,
    });

    const ticketNote = decision.fifo?.tickets?.length
      ? `Your resume already shows: ${decision.fifo.tickets.join(', ')}.`
      : 'Your resume does not show a trade ticket, medical certification or a rigging ticket. '
        + 'That is not a blocker — several roster entries say "some experience" — but the ones '
        + 'asking for ticketed trades are not for you, and I will not put them in front of you '
        + 'as though they were.';

    add({
      priority: 2,
      track: FIFO_TRACK,
      title: 'Get the certifications the roster actually names',
      detail:
        `${ticketNote} The roster asks for Red Seal, current medical certification, ` +
        `rigging/slinging tickets, blasting licences, and H2S/SCBA or confined-space cards. ` +
        `I have not assumed which apply to you — tell me what you hold and I will filter on it.`,
    });

    if (!summary.unavailable) {
      add({
        priority: 2,
        track: FIFO_TRACK,
        title: 'Check every link before you rely on it',
        detail:
          `${summary.linkConfidence.employer_careers} of ${summary.total} roster entries link to an ` +
          `employer's careers page rather than the posting, and ${summary.linkConfidence.board_search} ` +
          `link to a job board search. Only ${summary.directPostings} reach a specific requisition. ` +
          `I will not present the rest as "apply here". Pay figures are converted estimates, not ` +
          `employer-quoted numbers — the employer's own wording is always shown beside them.`,
      });
    }
  } else if (decision.fifo?.offeredByExperience) {
    // Offered but not opened. This is the note that makes the closed track
    // actionable rather than merely absent.
    add({
      priority: 3,
      title: 'Fly-in/fly-out track is closed — your background would fit it',
      detail:
        `I have kept track 5 closed because you have not said you want to rotate, but your ` +
        `resume fits it: ${decision.fifo.supporting.join('; ')}. Rotations mean weeks away ` +
        `from home at camp. If that works for you, say so and I will open it and start ` +
        `sourcing the 88-role roster.`,
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
    // Track 5 detail, so a consumer can render the closed-but-offered case
    // without re-deriving it. Null when track 5 is closed with no supporting
    // signals, which is the common case and needs no extra surface.
    //
    // Built from the same fifoBrief() the session route uses, so the plan and
    // the dashboard cannot disagree about how many roles there are or how many
    // links actually reach a posting. They were separate call sites for about
    // ten minutes and the two shapes drifted, which is how a "directPostings"
    // field ends up undefined on a page that renders it.
    fifo: tracks.includes(FIFO_TRACK)
      // `rosterSummary`, not a fresh fifoBrief() call: this was returning a
      // Promise, so every consumer read `.directPostings` and `.sectors` off a
      // pending object and got undefined for both. One measurement, reused.
      ? { open: true, roster: rosterSummary, tickets: decision.fifo?.tickets || [] }
      : decision.fifo?.offeredByExperience
        ? { open: false, offeredByExperience: true, supporting: decision.fifo.supporting }
        : null,
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
