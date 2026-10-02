/**
 * relay/jobby/packet.mjs — one fully-tailored artefact per opportunity
 *
 * Every application, introduction and solicitation is built for one specific,
 * validated opening. Not a template with the company name swapped in: the
 * dossier is read through the view that job is read through, the eligibility
 * check is run against that job's stated requirements, and anything the
 * candidate lacks is recorded on the application node rather than quietly
 * omitted.
 *
 * ── Why the gaps live on the application, not the dossier ──────────────────
 *
 * A missing Red Seal is not a fact about the person. It is a fact about this job
 * in this province. Putting it on the dossier would make it contaminate every
 * other application — including the ones the candidate is perfectly qualified
 * for, in jurisdictions where the ticket does not apply.
 *
 * That is the same reasoning the dossier already uses about unconfirmed fields,
 * applied one level down: the gap is scoped to what it actually blocks.
 *
 * ── Why validation is a gate and not a warning ─────────────────────────────
 *
 * The FIFO roster taught this the hard way: 70 of 88 links pointed at a careers
 * page and only 12 at a real requisition. Building a packet for an opening that
 * may not exist is wasted work presented as progress. So `validateOpportunity`
 * reports what is actually known, and `buildPacket` says plainly when it could
 * not confirm the posting — rather than producing a beautifully written
 * application for a job that has already closed.
 */

import { buildView, viewForTrack, GENERAL_VIEW } from './views.mjs';
import { matchTitles, detectTickets, knownTitle, ALL_FAMILIES } from './titles.mjs';
import { dossierText } from './tracks.mjs';

/**
 * What is actually known about this opening.
 *
 * Returns a verdict, never a boolean, because "we could not reach it" and "it is
 * closed" are different answers and the packet needs both.
 */
export function validateOpportunity(opportunity = {}) {
  const url = String(opportunity.url || '').trim();
  const role = String(opportunity.role || '').trim();
  const company = String(opportunity.company || '').trim();

  const out = {
    verdict: 'unverified',
    // What we can assert, and what we cannot.
    haveRole: !!role,
    haveCompany: !!company,
    haveUrl: !!url,
    isDirectLink: false,
    isJobBoard: false,
    reasons: [],
  };

  if (!role) out.reasons.push('No role title recorded, so there is nothing to tailor against.');
  if (!company) out.reasons.push('No employer recorded.');
  if (!url) {
    out.reasons.push('No posting URL, so I cannot confirm the opening still exists.');
    out.verdict = 'unlinked';
    return out;
  }

  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./i, '').toLowerCase();
    path = u.pathname.replace(/\/+$/, '');
  } catch {
    out.reasons.push('The posting URL is not a valid address.');
    out.verdict = 'unlinked';
    return out;
  }

  const BOARDS = /(^|\.)(indeed\.[a-z.]+|seek\.com(\.au)?|glassdoor\.[a-z.]+|ziprecruiter\.[a-z.]+|monster\.[a-z.]+|reed\.co\.uk|bayt\.com|totaljobs\.[a-z.]+|jobsite\.co\.uk|jobbank\.gc\.ca|linkedin\.com)$/i;
  out.isJobBoard = BOARDS.test(host);

  const segs = path.split('/').filter(Boolean);
  // A specific requisition, however the site names it.
  //
  // This required four or more consecutive digits in the path, which is how
  // Aplin's `/job/60828162-instrumentation-technician` looks and nothing else
  // does. DevITJobs publishes 1,821 genuine per-job pages at
  // `/jobs/Guidehouse-Data-Analyst--Power-Platform` and every one of them was
  // classed a careers page — a third of the registry's real volume, discarded,
  // by a rule written from a single example.
  //
  // So a job-shaped path segment is accepted on the strength of the path
  // itself: a segment that names a job and is specific enough to be one. A slug
  // with a company and a title in it is as much a requisition as a numeric id.
  // What is still refused is the unqualified case — a bare domain, a search
  // page, a category listing — because those are not a specific opening.
  const JOB_SEGMENT = /^(?:job|jobs|vacancy|vacancies|position|positions|opening|openings|career|careers|offering|offerings|offres|listing|listings|requisition|req|search|view|show|posting|postings|advert|advertisement|jobpage|joblisting)(?:[-_/]|$)/i;
  const slugIsSpecific = segs.length >= 2 && segs.some((s) => {
    if (!JOB_SEGMENT.test(s)) return false;
    // "/jobs" on its own is a listing page, not a posting. Needs a slug after it.
    const rest = s.replace(JOB_SEGMENT, '').replace(/^[-_/]+/, '');
    return rest.length >= 6;
  });
  // A long trailing slug on any path is a specific page: careers sites are
  // short ("/careers"), individual postings are not.
  const longTrailingSlug = segs.length >= 2 && segs[segs.length - 1].length >= 12
    && /[a-z]/i.test(segs[segs.length - 1]);

  out.isDirectLink = !out.isJobBoard && segs.length >= 2
    && (/\d{4,}/.test(path) || slugIsSpecific || longTrailingSlug);

  if (out.isJobBoard) {
    out.verdict = 'search_page';
    out.reasons.push(
      `${host} serves a search or category page, not this specific opening. `
      + 'This job may not be among the results — it needs confirming before an application is worth building.'
    );
  } else if (out.isDirectLink) {
    out.verdict = 'direct_posting';
    out.reasons.push('The link points at a specific requisition.');
  } else {
    out.verdict = 'careers_page';
    out.reasons.push(
      `${host} is the employer's careers site rather than a specific requisition. `
      + 'The employer looks right; this opening is unconfirmed.'
    );
  }

  return out;
}

/**
 * Check the candidate against this job's stated requirements.
 *
 * Two kinds of finding, and the difference is the whole point:
 *
 *  - `missing` — the job asks for something and the dossier does not have it.
 *    This blocks an application, so it goes on the application node.
 *  - `unevidenced` — the dossier has nothing either way. A gap in the record, not
 *    a gap in the candidate. Says so, because "you have no Red Seal" and "your
 *    resume does not mention one" are different facts and only the second is
 *    true of a resume we parsed.
 */
export function assessEligibility(dossier, opportunity = {}) {
  const d = dossier && typeof dossier === 'object' ? dossier : {};
  const text = dossierText(d);
  const hay = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;

  const ticketsHeld = detectTickets(text);
  const held = new Set(ticketsHeld.map((t) => t.ticket));

  // What this job is asking for. Taken from the opportunity record only —
  // never from a general notion of the role. That is the whole discipline here:
  // if the posting did not state it, no amount of guessing about what the job
  // "probably" wants can stand in, and a manufactured requirement produces a
  // manufactured gap on the candidate's application.
  //
  // `required_tickets` has no column of its own — it arrives in the evidence
  // jsonb, or from the agent passing it directly — so both are read. Reading
  // only the top level would have made every requirement silently empty.
  const ev = (opportunity.evidence && typeof opportunity.evidence === 'object')
    ? opportunity.evidence : {};
  const fromEvidence = [
    ...(Array.isArray(ev.required_tickets) ? ev.required_tickets : []),
    ...(Array.isArray(ev.required_certifications) ? ev.required_certifications : []),
    ...(ev.requires_visa ? ['visa_sponsorship'] : []),
  ];
  const requiredRaw = [
    ...(Array.isArray(opportunity.required_tickets) ? opportunity.required_tickets : []),
    ...(opportunity.requires_visa ? ['visa_sponsorship'] : []),
    ...(Array.isArray(opportunity.required_certifications) ? opportunity.required_certifications : []),
    ...fromEvidence,
  ];
  const required = [...new Set(requiredRaw.map((r) => String(r).toLowerCase().trim()).filter(Boolean))];

  // Where the requirements came from, so a candidate reading the packet can tell
  // a stated requirement from one the agent inferred.
  const requirementsFrom = opportunity.required_tickets || opportunity.required_certifications
    || fromEvidence.length ? 'this posting' : 'none recorded';

  const missing = [];
  const satisfied = [];

  for (const req of required) {
    // Does the dossier state this ticket at all?
    const known = detectTickets(req);
    const matchedTicket = known.length ? known[0].ticket : null;
    const mentioned = matchedTicket
      ? held.has(matchedTicket)
      : new RegExp(`(^|[^a-z0-9])${req.replace(/[^a-z0-9]+/g, '|')}([^a-z0-9]|$)`, 'i').test(hay);

    if (matchedTicket && held.has(matchedTicket)) satisfied.push({ requirement: req, via: matchedTicket });
    else if (mentioned) satisfied.push({ requirement: req, via: 'named in your dossier' });
    else missing.push({
      requirement: req,
      // The distinction that keeps this honest.
      status: matchedTicket ? 'not_held' : 'unevidenced',
      note: matchedTicket
        ? `This job lists ${req}. Your dossier does not record it.`
        : `This job lists ${req} and your resume does not mention it either way — `
          + 'that is a gap in what I have written down, not proof you lack it. Tell me and I will record it.',
    });
  }

  // Consent, not eligibility — but it blocks an application just as hard.
  const blockers = [];
  if (opportunity.requires_visa) {
    const statesVisa = /\b(?:visa|sponsorship|work\s*permit|citizen|pr\s+only|security\s+clearance)\b/i.test(
      `${opportunity.description || ''} ${opportunity.requirements || ''}`
    );
    if (!statesVisa) {
      blockers.push({
        kind: 'visa_unknown',
        detail: 'This is a role that may need visa sponsorship and the posting does not say either way. '
          + 'Check before spending an application on it.',
      });
    }
  }

  return {
    required,
    requirementsFrom,
    satisfied,
    missing,
    blockers,
    ticketsHeld: ticketsHeld.map((t) => ({ ticket: t.ticket, label: t.label, evidence: t.evidence })),
    // Nothing asked for and nothing known: an honest pass, not a manufactured one.
    verdict: required.length === 0
      ? 'unknown_requirements'
      : missing.length === 0 && blockers.length === 0 ? 'eligible' : 'gaps',
  };
}

/**
 * Build the packet for one opening.
 *
 * @param dossier    the candidate's dossier
 * @param opportunity  {role, company, url, track, description, requirements, ...}
 * @param opts       { viewId }
 */
export function buildPacket(dossier, opportunity = {}, opts = {}) {
  const d = dossier && typeof dossier === 'object' ? dossier : {};
  const role = String(opportunity.role || '').trim();
  const company = String(opportunity.company || '').trim();

  const validation = validateOpportunity(opportunity);

  // Which slice of the dossier this job is read through.
  //
  // Falls back to a general reading when the track is unknown, because otherwise
  // the packet comes out empty: the agent often has a URL and a role but no
  // track, and viewForTrack(null) is null, so sections was an empty array and the
  // candidate got a document with nothing in it while the dossier sat there full.
  // An empty packet is worse than a plain one — it reads as "nothing about you
  // applies", which is a claim, and a false one.
  const viewId = opts.viewId || viewForTrack(opportunity.track) || GENERAL_VIEW;
  const view = buildView(d, viewId);
  const viewIsFallback = !opts.viewId && !viewForTrack(opportunity.track);
  const eligibility = assessEligibility(d, opportunity);

  // The title this job is asking for, matched against the library — so the
  // packet can say whether the candidate's background reaches it, rather than
  // the agent assuming it does.
  const titles = matchTitles(`${role} ${company} ${opportunity.description || ''}`, { limit: 3 });

  const sections = [];
  for (const s of view ? view.sections : []) {
    sections.push({
      field: s.field,
      label: s.label,
      lead: s.lead,
      value: s.value,
      derivedFrom: s.derivedFrom || null,
      alsoShows: s.alsoShows || null,
    });
  }

  // The opener, assembled from the view rather than written. Each piece is a fact
  // already in the dossier; the sentence joining them is the only new thing, and
  // it is left for the agent to phrase in its own voice rather than shipped as a
  // fixed line that would read as a template.
  const lead = sections.filter((s) => s.lead).slice(0, 4).map((s) => s.label);

  return {
    opportunity: { role, company, url: opportunity.url || null, id: opportunity.id ?? null },
    viewUsed: viewId,
    viewLabel: view ? view.label : null,
    // True when no track was known and the neutral reading was used. Surfaced so
    // the agent can say "I have not matched this to a track yet" instead of
    // presenting a generic reading as though it were tailored.
    viewIsFallback,
    sections,
    leadingWith: lead,
    // What this job's title maps to in the library, and whether the candidate's
    // own recorded titles reach it. This was computed and then dropped on the
    // floor — the one place the packet could say "this posting asks for X, and
    // here is what you have" rather than leaving the agent to assume the fit.
    titles: {
      // Field names taken from matchTitles' actual shape: name, not title. The
      // first version read t.title and produced an array of undefined, which
      // reads as "no match found" and is indistinguishable from a real miss.
      matched: titles.map((t) => ({
        name: t.name,
        family: t.family ?? null,
        score: t.score ?? null,
        // Whether the posting named this outright or the match is inferred.
        namedDirectly: t.namedDirectly ?? null,
        confidence: t.confidence ?? null,
        evidence: t.evidence ?? [],
      })),
      // True when at least one library title was found for this posting.
      recognised: titles.length > 0,
      // What the dossier's own titles are, so the comparison is two lists rather
      // than an assertion. Deduplicated, unsorted, no invention.
      candidateTitles: [...new Set(
        [...(Array.isArray(d.employment) ? d.employment : []).map((e) => e?.title), d.current_title]
          .filter((t) => typeof t === 'string' && t.trim())
          .map((t) => t.trim())
      )],
    },
    // What the packet deliberately does NOT contain.
    omitted: {
      gaps: view ? view.whatItCannotShow : [],
      note: 'Nothing in this packet was inferred from the job description. If a section is '
        + 'missing, it was missing from the dossier.',
    },
    validation,
    eligibility,
    // The per-application notes. This is the record the candidate needs: not
    // "unqualified", but "this posting asks for X and your dossier does not
    // record it — here is what to do about it".
    notes: buildNotes({ validation, eligibility, view, opportunity }),
    canApply: eligibility.verdict === 'eligible' && eligibility.blockers.length === 0,
    // Whether it is worth building at all.
    worthBuilding: validation.verdict === 'direct_posting',
    guidance:
      validation.verdict === 'search_page'
        ? 'Confirm the opening exists before spending an application on it. This link is a search page.'
        : validation.verdict === 'careers_page'
          ? 'Find the specific requisition on their careers site first. I have not assumed it is the one you saw.'
          : validation.verdict === 'unlinked'
            ? 'This has no link, so I cannot tell you whether the opening is live.'
            : 'The link is to a specific requisition.',
  };
}

/**
 * The notes that live on this application node.
 *
 * Deliberately written as things to *do*, because "you are missing X" leaves a
 * candidate stuck and "here is what to do about X" does not. Where the honest
 * answer is that the record is incomplete rather than the person being
 * unqualified, that is what it says.
 */
function buildNotes({ validation, eligibility, view, opportunity }) {
  const notes = [];

  if (validation.verdict !== 'direct_posting') {
    notes.push({
      kind: 'unconfirmed_opening',
      severity: 'info',
      detail: validation.reasons.join(' '),
    });
  }

  for (const m of eligibility.missing) {
    notes.push({
      kind: m.status === 'unevidenced' ? 'unevidenced_requirement' : 'missing_requirement',
      severity: m.status === 'not_held' ? 'blocking' : 'needs_answer',
      requirement: m.requirement,
      detail: m.status === 'not_held'
        ? `${m.requirement}: the posting asks for this and your dossier does not record it. `
          + 'Check whether you hold it under another name or jurisdiction, or whether this posting is not for you.'
        : `${m.requirement}: the posting asks for this and your resume does not mention it. `
          + 'That is not the same as not having it — tell me and I will write it in.',
      action: m.status === 'not_held'
        ? 'Confirm before applying, or skip this one.'
        : 'Answer the question and the note updates itself.',
    });
  }

  for (const b of eligibility.blockers) {
    notes.push({ kind: b.kind, severity: 'blocking', detail: b.detail });
  }

  if (view && view.whatItCannotShow.length) {
    notes.push({
      kind: 'view_gaps',
      severity: 'info',
      detail: `Reading this as a ${view.label.toLowerCase()} role, the dossier cannot show: `
        + `${view.whatItCannotShow.join(', ')}.`,
    });
  }

  if (opportunity.match_notes) {
    notes.push({ kind: 'prior_note', severity: 'info', detail: opportunity.match_notes });
  }

  return notes;
}

export default {
  validateOpportunity, assessEligibility, buildPacket, buildNotes,
};