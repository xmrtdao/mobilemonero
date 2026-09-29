// Fuzzy, conservative role matching, for merging resumes that describe the same
// job in different words.
//
// The duplicate this exists to prevent is concrete. Two resumes for the same
// person produced, from the same underlying CV, all of these at once:
//
//   PARTY FAVOR PHOTO          / Founder & Managing Director
//   Party Favor Photo          / Founder & Managing Director
//   Cuttlefish Labs / XMRT DAO / Multi-Agent Systems Architect & Founder
//   CUTTLEFISH LABS / XMRT DAO / Multi-Agent Systems Architect & Founder
//   United Service Organizations (USO) / Senior Multimedia Journalist & Content Strategist
//   United Service Organizations (USO) / Senior Multimedia Journalist
//
// A key built on exact strings makes six rows out of three jobs, and a
// recruiter-facing dossier that lists the same employer twice reads as careless
// at best. But the opposite failure is worse: a narrow resume that lists one role
// the broad resume omits must ADD it, and a matcher loose enough to absorb that
// would silently delete a real job.
//
// Three signals decide it, and they are not equally trusted:
//
//   employer  - necessary but not sufficient. Two people hold the same job title
//               at different companies; a "founder" is not automatically a
//               "managing director".
//   title     - necessary but not sufficient. The same title recurs across every
//               employer a person has had.
//   dates     - what settles it, and the reason dates are consulted at all. Two
//               entries at one employer over the same years are the same job
//               however differently it is worded; two entries at one employer in
//               different years are two tenures, not one restated twice.
//
// So a match needs the employer, and then EITHER the title agreeing with the dates
// not contradicting, OR the dates agreeing closely enough to stand in for the
// title. Disagreeing dates are never resolved automatically: the real data contains
// a user asserting 2015 against every extraction saying 2025, and silently picking
// either would put a false claim on a job application.

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function fold(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Words that carry no identifying weight in a job title.
 *
 * Seniority words are deliberately NOT here. "Lead" is a real job title - Lead
 * Lighting Artist, Lead Recruiter - and dropping it made every title consisting
 * of one word fold to the empty set, which scored two identical titles as 0.00
 * overlap. Containment already handles the case that motivated dropping them:
 * "Senior Multimedia Journalist" inside "Senior Multimedia Journalist & Content
 * Strategist" scores on the words they share, seniority included.
 */
const TITLE_NOISE = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'at', 'in', 'for', 'to', 'with']);

/**
 * Company words that are suffixes, alternates or legal forms rather than part of
 * the identity. "Cuttlefish Labs" and "Cuttlefish Labs / XMRT DAO" are one
 * employer; "Party Favor Photo LLC" and "Party Favor Photo" are one employer.
 */
const COMPANY_NOISE = new Set([
  'llc', 'inc', 'incorporated', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'gmbh', 'plc', 'sa', 'bv', 'ag', 'lp', 'llp', 'pllc',
  'group', 'holdings', 'labs', 'laboratories', 'technologies', 'technology',
  'systems', 'solutions', 'ventures', 'partners', 'studio', 'studios', 'the',
]);

function tokens(s, noise) {
  return fold(s).split(' ').filter(w => w && !noise.has(w));
}

/**
 * Jaccard-style overlap, biased so that a shorter title contained in a longer one
 * still scores highly. A two-role resume says "Director" where a four-role resume
 * says "Director of Photography"; that is the same job, said briefly.
 */
export function titleOverlap(a, b) {
  const A = new Set(tokens(a, TITLE_NOISE));
  const B = new Set(tokens(b, TITLE_NOISE));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  if (!shared) return 0;
  const jaccard = shared / (A.size + B.size - shared);
  const containment = shared / Math.min(A.size, B.size);
  return Math.max(jaccard, containment * 0.92);
}

/** Employer similarity, where a suffix or an appended alternate name is free. */
export function companyOverlap(a, b) {
  const A = new Set(tokens(a, COMPANY_NOISE));
  const B = new Set(tokens(b, COMPANY_NOISE));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  if (!shared) return 0;
  const jaccard = shared / (A.size + B.size - shared);
  const containment = shared / Math.min(A.size, B.size);
  return Math.max(jaccard, containment * 0.9);
}

/** A year, from whatever shape the document used. Null when there is not one. */
function year(v) {
  if (v === null || v === undefined || v === true || v === false) return null;
  const m = String(v).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

const PRESENT = /present|current|now|today|ongoing/i;

/**
 * The span a role occupies, as [from, to]. `to` is null for a role that is
 * current, which is the open-ended case the date signal has to handle: a current
 * role and a role that ended three years ago cannot be the same tenure.
 */
export function spanOf(entry) {
  const from = year(entry.start);
  const rawEnd = entry.end;
  const isCurrent = entry.current === true || PRESENT.test(String(rawEnd ?? ''));
  const to = isCurrent ? null : year(rawEnd);
  return { from, to, isCurrent, known: from !== null || to !== null };
}

/**
 * How much two roles' tenures coincide, 0 to 1, or null when neither states dates.
 *
 * 1.0 means the spans are the same years. 0.0 means provably disjoint - which is
 * itself informative, because two entries at one employer in different years are
 * two tenures rather than one job described twice.
 */
export function dateOverlap(a, b) {
  const A = spanOf(a), B = spanOf(b);
  if (!A.known || !B.known) return null;
  if (A.from === null || B.from === null) return null;

  // An open-ended role runs to "now", not to infinity. Using Infinity here made
  // two current roles compute Infinity - Infinity = NaN for the tenure length, and
  // NaN fails every comparison downstream, so dateOverlap returned NaN instead of
  // a number and the matcher's date signal silently stopped working for exactly
  // the case it matters most: two current roles described across two resumes.
  const now = new Date().getFullYear();
  const aTo = A.to === null ? now : A.to;
  const bTo = B.to === null ? now : B.to;

  const lo = Math.max(A.from, B.from);
  const hi = Math.min(aTo, bTo);
  if (lo > hi) return 0;

  // Overlap as a fraction of the shorter tenure: two roles that share all three
  // of their years score 1 even if one ran for ten and the other for one. The
  // +1 keeps a single-year role from dividing by zero.
  const shorter = Math.min(aTo - A.from, bTo - B.from) + 1;
  const shared = hi - lo + 1;
  const ratio = shared / shorter;
  if (!Number.isFinite(ratio)) return null;
  return Math.max(0, Math.min(1, ratio));
}

const COMPANY_MIN = 0.72;
const TITLE_STRONG = 0.62;
const TITLE_WEAK = 0.45;
const DATES_DECISIVE = 0.75;

/**
 * Do these two entries describe the same role?
 *
 * @returns {{same: boolean, ambiguous: boolean, score: number, company: number,
 *            title: number, dates: number|null,
 *            dateConflict: null|{field:string, a:*, b:*}}}
 */
export function sameRole(a, b) {
  const company = companyOverlap(a.company, b.company);
  const title = titleOverlap(a.title, b.title);
  const dates = dateOverlap(a, b);

  if (company < COMPANY_MIN) {
    return { same: false, ambiguous: false, score: 0, company, title, dates, dateConflict: null };
  }

  // The employer agrees. Now either the title agrees and the dates do not
  // contradict it, or the dates agree closely enough to stand in for a title the
  // two documents worded differently.
  const titleAgrees = title >= TITLE_STRONG;
  const titleWeaklyAgrees = title >= TITLE_WEAK;
  const datesAgree = dates !== null && dates >= DATES_DECISIVE;

  let same = false;
  if (dates === 0) {
    // Provably disjoint tenures at one employer: two jobs, not one job twice.
    same = false;
  } else if (titleAgrees) {
    same = true;
  } else if (titleWeaklyAgrees && datesAgree) {
    same = true;
  }

  // Two current roles at one employer with the same title are genuinely
  // indistinguishable from one role restated. Merging them would risk losing a
  // job, and keeping them risks a duplicate; neither is safe to do silently, so
  // this is reported for the candidate to settle.
  const A = spanOf(a), B = spanOf(b);
  const ambiguous = same && A.isCurrent && B.isCurrent && title >= 0.95;

  let dateConflict = null;
  if (same) {
    for (const field of ['start', 'end']) {
      const av = a[field], bv = b[field];
      const avNull = av === null || av === undefined || av === '' || av === true;
      const bvNull = bv === null || bv === undefined || bv === '' || bv === true;
      if (avNull || bvNull) continue;
      const ay = year(av), by = year(bv);
      if (ay && by) {
        if (ay !== by) dateConflict = { field, a: av, b: bv };
      } else if (String(av).trim() !== String(bv).trim()) {
        dateConflict = { field, a: av, b: bv };
      }
    }
  }

  const score = company * 0.4 + title * 0.3 + (dates === null ? 0.15 : dates * 0.3);
  return { same, ambiguous, score, company, title, dates, dateConflict };
}
