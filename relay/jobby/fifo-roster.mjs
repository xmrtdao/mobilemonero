/**
 * relay/jobby/fifo-roster.mjs — Track 5, FIFO / remote-site roles
 *
 * 88 roles across mining, offshore oil and gas, polar stations, remote trades,
 * merchant marine, mega-construction and shipboard work. Every field here came
 * from the Grok-built roster in grok-workspace.zip (`src/data/jobs.ts`, ids
 * R001–R088), extracted verbatim. Nothing was invented, upgraded or inferred.
 *
 * ── What this file is careful about ─────────────────────────────────────────
 *
 * Two things in the source roster would mislead a job seeker if carried over as
 * written, so they are made explicit here rather than smoothed over.
 *
 * 1. LINK CONFIDENCE. All 88 entries carry an `applyUrl`, which reads as "here
 *    is the posting". 35 of them are a deep link to a specific requisition. 53
 *    point at an employer careers *landing page* — real domains, real employers,
 *    but not this job. Grok's own `applyLabel` says so ("Agnico Eagle careers")
 *    and `status` says "Posted listing", which overstates it. Presented to a
 *    candidate as "here is the job, click to apply", a landing page drops them
 *    into a search box with no indication the opening is unconfirmed. That is
 *    the false-success shape, so it is surfaced as a third state rather than
 *    flattened into a link.
 *
 * 2. PAY IS PARTLY MODELLED. `payUsdLow`/`payUsdHigh` are Grok's normalisation of
 *    local ranges into USD, not employer-quoted figures. Some pairs round
 *    suspiciously (126000, 140000), which is consistent with estimation. Shown
 *    as a quote it would be a claim about someone's income that no employer
 *    made. Carried as an estimate, labelled as one, and always shown with the
 *    original local string beside it so the candidate sees what was actually
 *    written.
 *
 * `entryPossible` and `visa` are likewise the source's own judgement flags, not
 * verified employer requirements. They drive search and are labelled as signals.
 */

export const FIFO_ROSTER_VERSION = 'grok-workspace 2026-09-28, ids R001-R088';

/**
 * How much to trust that `applyUrl` reaches this specific opening.
 *
 * Three cases, because lumping the two weak ones together hides the difference:
 * an employer careers page at least points at the right employer, while a job
 * board search page points at nobody in particular and may show a hundred
 * unrelated openings.
 */
export const LINK_CONFIDENCE = {
  specific_posting: {
    key: 'specific_posting',
    label: 'Direct posting',
    candidateSees: 'Direct link to the posting',
    agentMay: 'Apply directly and follow the employer\'s instructions.',
  },
  employer_careers: {
    key: 'employer_careers',
    label: 'Employer careers page',
    candidateSees: 'Employer careers page — the opening is unconfirmed, so search for it there',
    agentMay: 'Open the careers page and locate the role before applying.',
  },
  board_search: {
    key: 'board_search',
    label: 'Job board search page',
    candidateSees: 'Job board search page — many openings, this one not linked',
    agentMay: 'Search the board for the role; do not treat the first result as this job.',
  },
};

/**
 * Job boards whose URLs are searches or category listings rather than postings.
 *
 * Detected from the host, not the path depth, because a board will happily serve
 * a three-segment URL that is still a search ("au.seek.com/fifo-operator-jobs/
 * full-time" is two segments and is a category page, not a vacancy).
 */
const JOB_BOARDS = [
  /(^|\.)indeed\.[a-z.]+$/i,
  /(^|\.)seek\.com$/i,
  /(^|\.)glassdoor\.[a-z.]+$/i,
  /(^|\.)ziprecruiter\.[a-z.]+$/i,
  /(^|\.)monster\.[a-z.]+$/i,
  /(^|\.)jobbank\.[a-z.]+$/i,
  /(^|\.)totaljobs\.[a-z.]+$/i,
  /(^|\.)reed\.co\.uk$/i,
  /(^|\.)bayt\.com$/i,
  /(^|\.)naukri\.com$/i,
  /(^|\.)jobs\.[a-z.]+$/i,
];

/**
 * Classify a URL by how specific it is.
 *
 * Order matters: a board is checked before the depth heuristic, because board
 * URLs are frequently deep enough to look like requisitions while being
 * category or search pages.
 *
 * The depth test is deliberately conservative. A careers-page link mistaken for
 * a posting wastes the candidate's afternoon; the reverse only costs a search.
 */
export function classifyApplyUrl(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return 'employer_careers';
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return 'employer_careers';
  }
  const host = parsed.hostname;
  const path = parsed.pathname.replace(/\/+$/, '');

  // 1. Job board search or category page.
  if (JOB_BOARDS.some((re) => re.test(host))) return 'board_search';

  // 2. A requisition-level deep link: a long numeric id, or a /jobs/<slug> path.
  const segments = path.split('/').filter(Boolean);
  const hasRequisitionId = /\d{4,}/.test(path) || /job(s)?\/[^/]+/i.test(path)
    || /career(s)?\/[^/]+\/(apply|job|vacanc)/i.test(path);
  if (hasRequisitionId && segments.length >= 2) return 'specific_posting';

  // 3. Everything else: a real employer, but not this opening.
  return 'employer_careers';
}

/** Present one role the way a candidate should see it, with nothing overclaimed. */
export function describeFifoRole(role) {
  const confidence = LINK_CONFIDENCE[classifyApplyUrl(role.applyUrl)];
  const caveats = [];
  if (confidence.key === 'employer_careers') {
    caveats.push('Link goes to the employer careers page, not this posting. The opening is unconfirmed.');
  } else if (confidence.key === 'board_search') {
    caveats.push('Link is a job board search page. It may show many openings and this one may not be among them.');
  }
  caveats.push('Pay is an estimate converted from the local range shown, not a figure the employer quoted.');
  if (role.entryPossible === false && role.experience === 'Entry') {
    caveats.push('Marked "Entry" experience but not open to entrants — worth confirming with the employer.');
  }
  return {
    id: role.id,
    title: role.title,
    employer: role.employer,
    sector: role.sector,
    site: role.site,
    roster: role.roster,
    austerity: role.austerity,
    // The employer's own wording, preserved. Never replaced by the USD estimate.
    payAsStated: role.pay,
    payUsdEstimate: { low: role.payUsdLow, high: role.payUsdHigh, isEstimate: true },
    covered: {
      flights: !!role.flights,
      housing: !!role.housing,
      meals: !!role.meals,
      medical: !!role.medical,
      notes: role.otherCovered || null,
    },
    visa: !!role.visa,
    entryPossible: !!role.entryPossible,
    experience: role.experience,
    requirements: role.requirements,
    applyUrl: role.applyUrl,
    applyLabel: role.applyLabel,
    linkConfidence: confidence.key,
    linkConfidenceLabel: confidence.label,
    candidateSees: confidence.candidateSees,
    status: role.status,
    verified: role.verified,
    notes: role.notes,
    caveats,
  };
}

/**
 * The roster shape, for the session payload and the plan.
 *
 * Lives here, in the module that owns the roster, rather than being computed at
 * each call site. server.js built its own copy for `/api/jobby/session` and
 * plan.mjs used the raw `fifoSummary` instead — two shapes of the same fact,
 * within ten minutes of each other, and the page rendered `directPostings` from
 * the one that lacked it and got `undefined`. One brief, measured from the
 * roster, with the caveat attached.
 *
 * Cached because it is a function of a committed constant file. The failure mode
 * is reported, not thrown: a candidate must still get their session and plan if
 * the roster will not load.
 */
let _brief = null;
export async function fifoBrief() {
  if (_brief) return _brief;
  try {
    const { FIFO_ROSTER } = await import('./fifo-data.mjs');
    const s = fifoSummary(FIFO_ROSTER);
    _brief = {
      total: s.total,
      sectors: Object.entries(s.bySector)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
      visaSponsoring: s.visaSponsoring,
      entryPossible: s.entryPossible,
      linkConfidence: s.linkConfidence,
      // The honest part: how many links actually reach a specific requisition.
      // The page shows this rather than implying all 88 are one click away.
      directPostings: s.linkConfidence.specific_posting,
      caveat:
        'Pay figures are converted estimates, not employer-quoted numbers. ' +
        'Most links point at a careers page or a job board search, not a specific posting.',
    };
  } catch (e) {
    _brief = { unavailable: true, reason: String(e.message || e).slice(0, 120) };
  }
  return _brief;
}

/** Aggregate counts, derived from the roster rather than asserted. */
export function fifoSummary(roles) {
  const by = (key) => {
    const out = {};
    for (const r of roles) {
      const k = typeof key === 'function' ? key(r) : r[key];
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  };
  const conf = {};
  for (const r of roles) {
    const c = classifyApplyUrl(r.applyUrl);
    conf[c] = (conf[c] || 0) + 1;
  }
  return {
    total: roles.length,
    bySector: by('sector'),
    byAusterity: by('austerity'),
    byRegion: by('region'),
    visaSponsoring: roles.filter(r => r.visa).length,
    entryPossible: roles.filter(r => r.entryPossible).length,
    linkConfidence: conf,
  };
}
