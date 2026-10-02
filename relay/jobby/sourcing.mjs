/**
 * relay/jobby/sourcing.mjs — turn a company name into a sourced shortlist
 *
 * This replaces the LinkedIn capability without a LinkedIn credential.
 *
 * ── Why this shape and not a LinkedIn integration ────────────────────────────
 *
 * The paid CLI we evaluated is a thin client over a vendor's cloud-browser
 * fleet ($69/seat/month, trial converting to a paid subscription). The expensive
 * part is the browser farm, not the client. So this module does the half of the
 * job that needs no session and no proxy: finding who works at a company, and
 * being honest about how well each fact is evidenced.
 *
 * Sending stays where it already is — the candidate's own browser, behind the
 * same boundary that separates `jobby_apply` from the page-agent. Nothing here
 * authenticates as anybody.
 *
 * ── The rule that matters most ──────────────────────────────────────────────
 *
 * EVERY fact carries its evidence: the URL it came from and when it was seen.
 * A name with no source is not returned as a name. `confidence: 'unknown'` is a
 * real and common answer here, and the reason string says what is missing, so a
 * thin result reads as thin rather than as complete.
 *
 * This is the same discipline the dossier already uses: "not stated in resume"
 * rather than a guess. Public sources genuinely have gaps — an org chart may be
 * two years old, a press release may be the only mention of a role at all — and
 * presenting those as current fact is how a candidate ends up addressing someone
 * who left in 2023.
 */

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

/** Role words that suggest someone actually decides who gets hired. */
const HIRING_TITLE_RE = /\b(recruit(?:er|ing|ment)?|talent|acquisition|head\s+of\s+people|chief\s+people|hiring\s+manager|hr\b|human\s+resources|people\s+ops|talent\s+acquisition|staffing)\b/i;

/** Seniority that means a decision is likely theirs. */
const SENIOR_TITLE_RE = /\b(chief|c[toimvp]\w*|ceo|cto|cfo|cro|coo|president|vice\s+president|head\s+of|director|partner|founder|owner)\b/i;

/**
 * Title patterns we will actually look for, with the reason we care about each.
 * Deliberately conservative: a name is only ever paired with a title we matched.
 */
const ROLE_PATTERNS = [
  { id: 'recruiter', label: 'Recruiter or talent acquisition', re: HIRING_TITLE_RE },
  { id: 'people_leader', label: 'Head of people / HR', re: /\b(head\s+of\s+people|chief\s+people|hr\s+director|director.{0,12}human\s+resources|people\s+lead)\b/i },
  { id: 'hiring_manager', label: 'Hiring manager for the team', re: /\b(hiring\s+manager|recruiting\s+manager|talent\s+partner)\b/i },
];

/**
 * Domains we will not treat as a company's own pages. A contact scraped from a
 * job board is not the company's contact, and attributing one to them is wrong.
 */
const AGGREGATOR_HOSTS = [
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'monster.com',
  'seek.com.au', 'seek.com', 'jobbank.gc.ca', 'reed.co.uk', 'bayt.com', 'naukri.com',
  'totaljobs.com', 'jobsite.co.uk', 'crunchbase.com', 'apollo.io', 'zoominfo.com',
  'signalhire.com', 'rocketreach.co', 'hunter.io', 'lead411.com', 'pitchbook.com',
  'bloomberg.com', 'wikipedia.org', 'x.com', 'twitter.com', 'facebook.com',
];

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return ''; }
}

export function isAggregator(url) {
  const h = hostOf(url);
  return AGGREGATOR_HOSTS.some((d) => h === d || h.endsWith('.' + d));
}

/**
 * Evidence tiers, weakest first. The tier travels with every fact so the
 * candidate and Jobby can both see how solid it is.
 */
export const EVIDENCE = {
  // A named person with a job title, on the company's own site.
  company_page: {
    key: 'company_page',
    label: "Stated on the company's own site",
    weight: 0.9,
  },
  // A company email address on the company's own domain.
  company_email: {
    key: 'company_email',
    label: 'Company-domain email published by the company',
    weight: 0.85,
  },
  // A general address (info@, careers@) — real, but not a person.
  general_inbox: {
    key: 'general_inbox',
    label: 'General company inbox, not an individual',
    weight: 0.6,
  },
  // Only aggregators mentioned it. Useful lead, unverified by the company.
  third_party: {
    key: 'third_party',
    label: 'Only found on a third-party site — unverified',
    weight: 0.3,
  },
};

/**
 * A finding is only reported once we know what it is. Nothing here guesses.
 */
function makeFinding({ kind, name, title, email, url, detail }) {
  const out = { kind, url, detail: detail || null };
  if (name) out.name = name;
  if (title) out.title = title;
  if (email) out.email = email;
  return out;
}

/**
 * Pull people and addresses out of one fetched page.
 *
 * `page` is the webScrape result, which must have been fetched with
 * `extractLinks: true` — the text content alone has every href stripped.
 *
 * Returns { people, emails, notes } where notes records what we could not
 * determine, because a silent short list is indistinguishable from a full one.
 */
export function extractFromPage(page, { companyName = '', pageUrl = '' } = {}) {
  const notes = [];
  const people = [];
  const emails = [];
  if (!page || page.error) {
    notes.push({ kind: 'fetch_failed', detail: page?.error || 'no page' });
    return { people, emails, notes };
  }

  const url = pageUrl || page.url;
  const fromCompany = url ? !isAggregator(url) : false;
  if (!fromCompany) {
    notes.push({
      kind: 'third_party_only',
      detail: `${hostOf(url)} is an aggregator, so anything on it is unverified by the company`,
    });
  }

  const text = page.content || '';

  // ── Addresses ────────────────────────────────────────────────────────────
  // Prefer the links array: it has the anchors, with the address the page
  // intended. The text fallback exists for pages that print an address bare.
  const seenEmail = new Set();
  for (const l of (page.links || [])) {
    if (l.kind !== 'mailto') continue;
    const addr = l.href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (!EMAIL_RE.test(addr) || seenEmail.has(addr)) continue;
    seenEmail.add(addr);
    const domain = hostOf(url).replace(/^www\./i, '');
    const onCompanyDomain = !domain || addr.endsWith('@' + domain) || addr.endsWith('@' + companyName.replace(/\s+/g, '') + '.com');
    const general = /^(info|contact|careers|jobs|hr|recruit|recruiting|talent|hiring|hello|admin|office|press|sales|support)@/i.test(addr);
    const evidence = !fromCompany ? EVIDENCE.third_party : general ? EVIDENCE.general_inbox : EVIDENCE.company_email;
    emails.push({
      address: addr,
      evidence: evidence.key,
      evidenceLabel: evidence.label,
      onCompanyDomain,
      foundOn: url,
      // Anchor text often names the person. If it does, that is a real link.
      anchorText: (l.text || '').slice(0, 120),
      kind: general ? 'general_inbox' : 'named_contact',
    });
  }
  for (const m of text.matchAll(new RegExp(EMAIL_RE.source, 'g'))) {
    const addr = m[0].toLowerCase();
    if (seenEmail.has(addr)) continue;
    seenEmail.add(addr);
    emails.push({
      address: addr,
      evidence: fromCompany ? EVIDENCE.general_inbox.key : EVIDENCE.third_party.key,
      evidenceLabel: fromCompany ? EVIDENCE.general_inbox.label : EVIDENCE.third_party.label,
      onCompanyDomain: false,
      foundOn: url,
      anchorText: null,
      kind: 'printed_address',
      note: 'Printed as plain text rather than a mailto link.',
    });
  }

  // ── People ───────────────────────────────────────────────────────────────
  // Only a Name paired with a title we matched. No title, no person: an
  // unlabelled name on a staff page is not evidence of a role.
  // Two passes, because these pages put name and title in two different shapes.
  //
  // Pass 1 — "Name — Title" or "Name | Title" on one line. The common case.
  //
  // The title pattern stops at a newline. On a two-column staff table the
  // scraped text arrives as "Eileen Evans\n\n\n \n \n\n \nAt Large Director",
  // so a `[^\n|]` title class returned an empty string and the record carried a
  // name with no title — which then failed the seniority test on the next pass
  // and was dropped. The newline is a layout artefact, not a boundary.
  const nameTitleRe = new RegExp(
    String.raw`\b([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){1,2})\b\s*[—–\-|,:]{1,2}\s*([^|\n]{2,90})`,
    'g'
  );
  for (const m of text.matchAll(nameTitleRe)) {
    const name = m[1].trim();
    // A scraped two-column table arrives with the cell boundary as a run of
    // newlines, spaces and pipes. Collapsing only \s+ left "At \n Large Director"
    // and, worse, matched the same person twice from the two halves of the
    // layout. Take the first clean run of text that actually reads as a title.
    const rawTitle = firstTitleRun(m[2]);
    if (!rawTitle) continue;
    if (!SENIOR_TITLE_RE.test(rawTitle) && !HIRING_TITLE_RE.test(rawTitle)) continue;
    if (EMAIL_RE.test(name)) continue;
    // A title match alone is not a person. This matcher ran over prose and
    // produced "User Group — looking to start a user group" as a person on the
    // PostgreSQL contact page, because "User Group" is capitalised and the text
    // after it happened to contain a recruiting-adjacent word.
    //
    // A real person's name is two or three capitalised words, carries no
    // organisational noun, and the title after it reads as a title rather than a
    // sentence. Anything failing those is not a person, and guessing here is the
    // exact failure the rest of this module is built to avoid.
    if (!looksLikeAPersonName(name)) continue;
    if (!looksLikeATitle(rawTitle)) continue;
    const matched = ROLE_PATTERNS.find((r) => r.re.test(rawTitle));
    const evidence = fromCompany ? EVIDENCE.company_page : EVIDENCE.third_party;
    people.push({
      name,
      title: rawTitle.replace(/\s+/g, ' ').slice(0, 90),
      role: matched ? matched.id : null,
      roleLabel: matched ? matched.label : 'Senior title, hiring function not stated',
      evidence: evidence.key,
      evidenceLabel: evidence.label,
      foundOn: url,
      // The one thing a candidate cannot verify from here: whether this person
      // still works there. Said rather than assumed.
      currency: 'unknown',
      note: fromCompany
        ? 'Stated on the company site. Whether they still hold the role is not shown anywhere public.'
        : 'Third-party listing only. Treat as a lead to verify, not as a fact.',
    });
  }

  // De-duplicate people by name, keeping the strongest evidence.
  const byName = new Map();
  for (const p of people) {
    const key = p.name.toLowerCase();
    const prev = byName.get(key);
    if (!prev || evidenceWeight(p.evidence) > evidenceWeight(prev.evidence)) byName.set(key, p);
  }

  return { people: [...byName.values()], emails, notes };
}

function evidenceWeight(key) {
  for (const e of Object.values(EVIDENCE)) if (e.key === key) return e.weight;
  return 0;
}

/**
 * Nouns that are never a person's name, however they are capitalised.
 * Section headings and org vocabulary: "User Group", "Contact Form",
 * "Mailing List", "Board of Directors".
 *
 * The second half of the list was added after this filter let "Big Tech" through
 * on mozilla.com and returned it as a person with the title "communities turn to
 * data collectives for control". Both halves are two ordinary capitalised words,
 * so every other test in this module passed them: the shape is right, the parts
 * are the right part-of-speech, and only the vocabulary is wrong. That is the
 * failure this list exists to stop, and it was incomplete in the direction that
 * matters — descriptive adjectives that head a prose heading, and the industry
 * words those headings are built from.
 *
 * All of these are unambiguous. None is a plausible name part, so the risk of
 * rejecting a real person is close to zero, which is the right side to err on:
 * a missed name costs a page the reader can scroll, and a wrong name costs a
 * candidate an approach to somebody who does not hold the role.
 */
const NOT_A_NAME_RE = /^(user|contact|mail|mailing|office|team|staff|board|directory|group|list|news|events|about|home|careers|jobs|press|faq|support|legal|privacy|terms|security|donate|member|members|public|general|customer|partner|partners|admin|main|site|page|chapter|committee|council|chief|president|vice|director|officer|chair|treasurer|secretary|head|lead|manager|coordinator|executive|program|project|volunteer|fellow|big|small|large|new|old|open|free|best|top|next|more|less|other|another|every|each|both|all|some|any|our|your|their|its|his|her|this|that|these|those|here|there|now|today|tech|technology|business|industry|industries|digital|data|cloud|mobile|social|media|marketing|sales|service|services|solutions|products|product|company|companies|firm|agency|studio|studios|lab|labs|school|university|college|institute|foundation|association|organization|organisation|group|platform|systems|network|networks|venture|capital|fund|partnership|teamwork|growth|innovation|impact|community|communities|future|world|global|local|national|international|public|private|government|nonprofit|startup|scale|success|results|impact|center|centre|centre)$/i;

/** Verb-ish and connective words that mean the "title" is a sentence. */
const SENTENCE_RE = /\b(looking|if\s+you|need|want|please|contact\s+us|for\s+(a|an|the|more|any|questions|info)|to\s+(start|learn|find|apply|join|volunteer|donate|get|read|see|know)|and\s+or|or\s+else|questions|about|regarding|subject)\b/i;

function looksLikeAPersonName(name) {
  const parts = name.split(/\s+/);
  if (parts.length < 2 || parts.length > 3) return false;
  if (parts.some((p) => NOT_A_NAME_RE.test(p) || p.length < 2)) return false;
  // Titles and honorifics are not names.
  if (/\b(mr|mrs|ms|dr|prof|sir|lord)\b\.?$/i.test(name)) return false;
  // Every part must look like a name token, not ALL-CAPS or a sentence word.
  return parts.every((p) => /^[A-Z][a-z'’-]+$/.test(p));
}

/**
 * Pull the first readable title out of a scraped table cell.
 *
 * Scraped tables produce " \n \n\n \nAt Large Director" — the cell boundary is a
 * run of whitespace and pipes. Split on the layout, take the first fragment that
 * survives looksLikeATitle, and stop. Taking the whole run instead produced
 * "At\n \n Large Director" as a title and matched the same person twice.
 */
function firstTitleRun(raw) {
  const fragments = String(raw || '')
    .split(/[|\n]+/)
    .map((f) => f.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  for (const f of fragments) {
    if (looksLikeATitle(f)) return f;
  }
  return fragments[0] || null;
}

function looksLikeATitle(title) {
  const t = title.trim();
  if (SENTENCE_RE.test(t)) return false;
  // A title is short and title-shaped. A sentence is not.
  if (t.length > 70) return false;
  const words = t.split(/\s+/).length;
  if (words > 9) return false;
  // Must not read as prose: lowercase function words are a bad sign.
  if (/^(and|or|but|if|so|the|a|an|to|for|with|at|on|in|of|by|from)\b/i.test(t)) return false;
  return true;
}

/**
 * Rank a shortlist. Relevance first, then evidence strength.
 *
 * A named recruiter with a company-domain address outranks a generic inbox,
 * which outranks an unverified third-party hit. That ordering is the whole
 * point of carrying evidence around.
 */
export function rankShortlist({ people = [], emails = [] } = {}) {
  const scored = people.map((p) => {
    let score = evidenceWeight(p.evidence) * 60;
    if (p.role) score += 25;
    else if (SENIOR_TITLE_RE.test(p.title || '')) score += 12;
    if (HIRING_TITLE_RE.test(p.title || '')) score += 18;
    // Someone already carrying a company email is reachable today.
    if (emails.some((e) => e.onCompanyDomain && e.kind === 'named_contact')) score += 8;
    return { ...p, score: Math.round(score) };
  });
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const inboxes = emails
    .map((e) => ({ ...e, score: Math.round(evidenceWeight(e.evidence) * 60) + (e.onCompanyDomain ? 20 : 0) }))
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));

  return { people: scored, inboxes };
}

/**
 * The honest coverage report. A short list that does not say it is short is the
 * failure mode this whole module is built to avoid.
 */
export function coverage({ companyName, people, inboxes, pagesFetched, pagesFailed, notes }) {
  const gaps = [];
  if (!people.length) {
    gaps.push('No named person with a stated job title was found on the pages fetched.');
  }
  if (!inboxes.length) {
    gaps.push('No email address was found. Most companies publish only a contact form.');
  }
  if (pagesFailed) {
    gaps.push(`${pagesFailed} page(s) could not be fetched, so this list is incomplete.`);
  }
  if (people.length && people.every((p) => p.currency === 'unknown')) {
    gaps.push('Whether any of these people still work at the company is not established by anything public.');
  }
  return {
    company: companyName,
    peopleFound: people.length,
    inboxesFound: inboxes.length,
    pagesFetched,
    pagesFailed,
    complete: gaps.length === 0,
    gaps,
    notes: notes || [],
    caveat:
      'Sourced from public pages only, with no LinkedIn access. Every fact carries its ' +
      'source URL. Treat titles as unverified for currency and confirm before approaching ' +
      'anyone — reaching the wrong person costs the candidate a real opportunity.',
  };
}

export default { extractFromPage, rankShortlist, coverage, EVIDENCE, isAggregator };
