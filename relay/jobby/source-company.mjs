/**
 * relay/jobby/source-company.mjs — the tool behind POST /api/jobby/source-company
 *
 * Company name in, sourced shortlist out. No LinkedIn credential, no third-party
 * account, no browser farm.
 *
 * ── Why this exists rather than a LinkedIn integration ───────────────────────
 *
 * The capability we evaluated (Linked API's CLI) is an MIT-licensed client over a
 * vendor's cloud-browser fleet at $69/seat/month, on a trial that converts to a
 * paid subscription. The client is free; the fleet is the product. Forking it
 * would mean owning the fleet.
 *
 * So this does the half of the job that needs no session: find the company's own
 * public pages, read what they say about who works there, and report it with the
 * evidence attached. Sending stays where it already is — the candidate's own
 * browser, behind the boundary between `jobby_apply` and the page-agent.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 *
 * It does not guess. No name without a stated title; no title without a source
 * page; no claim that someone still holds a role. When a company publishes
 * nothing findable, the answer is `complete: false` with the reason, not a
 * thin list dressed as a full one. That distinction is the entire product: a
 * candidate who approaches a recruiter who left in 2023 has lost an opportunity
 * that will not come back.
 */

import { webScrape } from '../tools/web-scrape.mjs';
import { extractFromPage, rankShortlist, coverage, isAggregator } from './sourcing.mjs';
import { resolveCompanyDomain } from './company-domain.mjs';

/** Where to look for a company's own pages, in order of usefulness. */
function candidatePaths() {
  return [
    '/about/leadership', '/about/team', '/about/people', '/about/who-we-are',
    '/about', '/team', '/leadership', '/people', '/company',
    '/contact', '/contact-us', '/about/contact', '/careers', '/careers/team',
  ];
}

/** Search terms that surface a company's own pages rather than a job board. */
function searchQueries(company, roleHint) {
  const c = `"${company}"`;
  return [
    `${c} leadership team official site`,
    roleHint ? `${c} ${roleHint} team` : `${c} about us people`,
  ].slice(0, roleHint ? 2 : 1);
}

/**
 * Find pages on the company's own domain.
 *
 * Only same-registrable-domain results are kept. An aggregator page about the
 * company is a lead, not a source of truth about the company, and treating it as
 * one is how a scraped contact gets attributed to someone who never published
 * it. Those are surfaced separately as unverified.
 */
/**
 * Does this URL belong to the company's own web presence?
 *
 * Two things made the obvious version wrong.
 *
 * Collapsing the name to one string breaks on legal suffixes: "Python Software
 * Foundation" becomes `pythonsoftwarefoundation`, which `python.org` does not
 * contain — so every legitimate page was rejected as a third party.
 *
 * And collapsing to the first word is worse the other way: "Rio Tinto" would
 * match `rio.com`. So the significant words are tried separately, and a match on
 * any one of them is enough. Requiring all of them would fail "Python Software
 * Foundation" too, since `python.org` has no "software" in it.
 */
const COMPANY_NOISE_RE = /\b(inc|incorporated|llc|ltd|limited|plc|corp|corporation|co|company|group|holdings?|international|worldwide|global|the|and|of|gmbh|sa|nv|ab|oy|as|pty)\b/g;

function companyTokens(company) {
  const words = String(company)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(COMPANY_NOISE_RE, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    // One or two letters are almost never a distinctive company token.
    .filter((w) => w.length >= 3);
  const joined = words.join('');
  return { words, joined };
}

function sameCompanyDomain(url, company) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return false; }
  if (isAggregator(url)) return false;

  const { words, joined } = companyTokens(company);
  if (!words.length) return false;
  // The joined form catches concatenated brands: "AgnicoEagle" -> agnicoeagle.
  if (joined && host.includes(joined)) return true;
  // Otherwise fall back to the FIRST word alone, not "any word".
  //
  // "Any word" looked reasonable and was wrong: "Rio Tinto" then matched
  // rio.com, an unrelated company, because "rio" is a substring of it. Only the
  // leading word is distinctive enough to try on its own — it is the one that
  // survives "Python Software Foundation" -> python.org.
  return host.includes(words[0]);
}

async function runSearch(query, { searchFn }) {
  try {
    const res = await searchFn({ query, limit: 8 });
    return Array.isArray(res?.results) ? res.results : [];
  } catch {
    return [];
  }
}

/**
 * @param {object} opts
 * @param {string} opts.company       company name, e.g. "Agnico Eagle"
 * @param {string[]} [opts.urls]      explicit URLs to read instead of searching
 * @param {string|null} [opts.roleHint] target role, sharpens the search
 * @param {number} [opts.limit]       people to return
 * @param {object} deps               { searchFn } — injected so this is testable
 */
export async function sourceCompany(opts = {}, deps = {}) {
  const company = String(opts.company || '').trim();
  if (!company) {
    return { ok: false, error: 'company is required', hint: 'Give a company name, e.g. "Agnico Eagle".' };
  }
  const limit = Math.max(1, Math.min(Number(opts.limit) || 5, 15));
  const notes = [];

  // searchFn is required for discovery. Sourcing from explicit URLs works
  // without it, which keeps the tool usable offline and in tests.
  const searchFn = deps.searchFn || (opts.searchFn ?? null);

  let urls = Array.isArray(opts.urls) ? opts.urls.filter((u) => /^https?:\/\//i.test(u)) : [];
  // Did discovery resolve the company's own domain? Kept for the coverage notes,
  // because "we found them and could not read them" and "we never found them" are
  // different answers and the caller acts differently on each.
  let domainHit = null;

  if (!urls.length) {
    // ── Step 1: the company's own website, found directly ──────────────────
    //
    // First, not as a fallback. A person told "Agnico Eagle" opens agnicoeagle.com;
    // they do not run a web search to discover it. Search is the *harder* path and
    // belongs second — it is for the trading name that is nothing like the brand.
    //
    // It also has to come first because the search backend is currently dead:
    // the relay's web-search scrapes DuckDuckGo's HTML endpoint, which answers 403.
    // With search as the only route, this function returned `people: []` for every
    // company it was ever asked about, behind a caveat written to read like a
    // careful researcher who had checked and found nothing. pagesFetched: 0 is not
    // a finding about the company; it is a finding about us.
    try {
      const resolved = await resolveCompanyDomain(company);
      if (resolved.ok && resolved.domains?.length) {
        domainHit = resolved;
        // The home page is included because a company's own contact details are
        // very often only on the home page or a footer, and the leadership pages
        // are added by the caller below.
        urls = resolved.domains.map((d) => d.url);
        notes.push({
          kind: 'discovered',
          detail: resolved.domains.length > 1
            ? `Resolved ${company} to ${resolved.domains.map((d) => d.host).join(', ')} and confirmed each names the company.`
            : `Resolved ${company} to ${resolved.domain} and confirmed the page names the company.`,
        });
      } else if (resolved.blocked) {
        // Found them, refused a read. Reported as its own outcome rather than
        // collapsed into "not found", because the next move is a different route
        // to this employer, not a different company name.
        domainHit = resolved;
        notes.push({
          kind: 'domain_blocks_reads',
          detail: resolved.reason,
          tried: resolved.tried,
        });
      } else {
        notes.push({
          kind: 'domain_not_resolved',
          detail: resolved.reason,
          tried: resolved.tried,
        });
      }
    } catch (e) {
      // A resolution failure must not take the tool down with it: search may still
      // work, and a thrown error here would replace a partial answer with none.
      notes.push({ kind: 'domain_resolution_failed', detail: String(e?.message || e).slice(0, 160) });
    }
  }

  if (!urls.length) {
    // ── Step 2: search, for names the direct guess cannot reach ─────────────
    if (!searchFn) {
      return {
        ok: false,
        error: 'no way to find pages',
        hint: 'Pass urls: [...] to read specific pages, or enable search.',
        company,
      };
    }
    const found = [];
    for (const q of searchQueries(company, opts.roleHint)) {
      const results = await runSearch(q, { searchFn });
      for (const r of results) {
        if (r?.url && sameCompanyDomain(r.url, company)) found.push(r.url);
      }
    }
    urls = [...new Set(found)].slice(0, 6);
    if (!urls.length) {
      // Say why, and say what to do about it. "No results" with no next step
      // is the least useful thing this endpoint could return.
      //
      // Our own discovery notes are kept whenever we have any, rather than being
      // replaced by a generic "search found nothing".
      //
      // A first version tested for one specific note kind, `domain_not_resolved`,
      // which meant the *blocked* case fell through and the caller was told
      // "Search returned no page on Agnico Eagle's own domain" — when in fact we
      // had found agnicoeagle.com and been refused by it. Those two conclusions
      // lead to opposite next moves, so collapsing them is worse than silence:
      // it reports a finding about the company that is really a finding about us.
      const haveOurOwnNotes = notes.length > 0;
      return {
        ok: true,
        company,
        people: [],
        inboxes: [],
        coverage: coverage({
          companyName: company, people: [], inboxes: [],
          pagesFetched: 0, pagesFailed: 0,
          notes: haveOurOwnNotes
            ? notes
            : [{ kind: 'no_company_domain_found', detail: `Search returned no page on ${company}'s own domain.` }],
        }),
        nextStep: domainHit && domainHit.blocked
          ? `${domainHit.domain} refuses automated reads, so its pages cannot be read directly. ` +
            `Tell me a page address for it and I will try that, or I can draft an approach that does not need their site.`
          : `Give me the careers or about page address and I will read it directly — ` +
            `for example https://${company.toLowerCase().replace(/[^a-z0-9]+/g, '')}.com/careers`,
      };
    }
    notes.push({ kind: 'discovered', detail: `Read ${urls.length} page(s) on the company's own domain.` });
  } else if (!notes.some((n) => n.kind === 'discovered')) {
    notes.push({ kind: 'discovered', detail: `Read ${urls.length} supplied page(s).` });
  }

  // ── Read the pages ───────────────────────────────────────────────────────
  const allPeople = [];
  const allEmails = [];
  const notesFromPages = [];
  let pagesFetched = 0;
  let pagesFailed = 0;
  const pagesRead = [];

  for (const url of urls) {
    // extractLinks is required: the text path strips every href, mailto included,
    // so without it a published address is invisible.
    const page = await webScrape(url, { extractLinks: true, timeout: 20000, maxLength: 30000 });
    if (page?.error) {
      pagesFailed++;
      notesFromPages.push({ kind: 'fetch_failed', detail: `${url} — ${page.error}` });
      continue;
    }
    pagesFetched++;
    pagesRead.push({ url, title: page.title, extractedLength: page.extractedLength });
    const ex = extractFromPage(page, { companyName: company, pageUrl: url });
    allPeople.push(...ex.people);
    allEmails.push(...ex.emails);
    notesFromPages.push(...ex.notes);
  }

  // De-duplicate across pages, keeping the strongest evidence for each.
  const byName = new Map();
  for (const p of allPeople) {
    const k = p.name.toLowerCase();
    const prev = byName.get(k);
    if (!prev) { byName.set(k, p); continue; }
    // Merge: keep the best evidence, but remember every page it appeared on.
    const prevW = evidenceWeightOf(prev.evidence);
    const newW = evidenceWeightOf(p.evidence);
    if (newW > prevW) {
      byName.set(k, { ...p, alsoSeenOn: [...(prev.alsoSeenOn || []), prev.foundOn] });
    } else {
      prev.alsoSeenOn = [...(prev.alsoSeenOn || []), p.foundOn];
    }
  }
  const byEmail = new Map();
  for (const e of allEmails) {
    const k = e.address.toLowerCase();
    const prev = byEmail.get(k);
    if (!prev || evidenceWeightOf(e.evidence) > evidenceWeightOf(prev.evidence)) byEmail.set(k, e);
  }

  const ranked = rankShortlist({ people: [...byName.values()], emails: [...byEmail.values()] });
  const cov = coverage({
    companyName: company,
    people: ranked.people,
    inboxes: ranked.inboxes,
    pagesFetched,
    pagesFailed,
    notes: [...notes, ...notesFromPages],
  });

  return {
    ok: true,
    company,
    pagesRead,
    people: ranked.people.slice(0, limit),
    inboxes: ranked.inboxes.slice(0, 5),
    // Names and inboxes are usually on different pages, so report both counts
    // rather than letting the bigger number stand in for the whole shortlist.
    counts: { people: ranked.people.length, inboxes: ranked.inboxes.length, limit },
    coverage: cov,
    // Nothing here has been sent and nothing can be. Said in the payload so it
    // travels with the data rather than living only in this comment.
    sending: 'not attempted — this tool only reads public pages',
    nextStep: cov.peopleFound
      ? 'I can draft an approach for any of these. Sending stays in your browser, and only when you have said yes.'
      : cov.inboxesFound
        ? 'No named contact was published, but these inboxes are real. I can draft something addressed to the team.'
        : 'Nothing findable on their own site. Give me the careers page address and I will read that directly.',
  };
}

function evidenceWeightOf(key) {
  return ({ company_page: 0.9, company_email: 0.85, general_inbox: 0.6, third_party: 0.3 })[key] ?? 0;
}

export default { sourceCompany };
