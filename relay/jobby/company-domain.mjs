/**
 * relay/jobby/company-domain.mjs — company name to the company's own website
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 *
 * `source-company.mjs` discovers a company's pages by searching the web and
 * keeping results on the company's own domain. Its search backend is the relay's
 * `web-search`, which scrapes DuckDuckGo's HTML endpoint. That endpoint now
 * answers **403 Forbidden** to every request.
 *
 * So the discovery step returned nothing, no page was ever fetched, and
 * `jobby_source_company` reported `complete: false` for every company it was ever
 * asked about — Mozilla, Discord, Agnico Eagle, all of them — while its own
 * `caveat` read like a careful researcher who had checked and found nothing.
 *
 * That is the failure mode worth naming: a broken input path wearing the
 * confidence of a completed search. `pagesFetched: 0` is not a finding about the
 * company. It is a finding about us.
 *
 * ── What a human agent does instead ──────────────────────────────────────────
 *
 * Nobody Googles "Mozilla Corporation leadership" to work out that Mozilla's
 * website is mozilla.org. The name *is* the address. You type it, the site loads,
 * and you read the leadership page.
 *
 * So this makes that step directly: turn the name into candidate hostnames, prune
 * the ones that do not resolve, then **verify** the survivors by fetching them
 * and checking the company's own name is actually on the page. Search stays as
 * the fallback for the genuinely hard cases — a trading name that is nothing like
 * the brand, or an obscure company with no guessable domain.
 *
 * ── Why every candidate is verified ──────────────────────────────────────────
 *
 * Because a name maps to several real domains, and only one is the employer.
 * `mozilla.com` resolves and serves a page; it is not Mozilla Corporation. So a
 * resolved domain proves nothing on its own, and a guessed domain reported as
 * fact is exactly the invented-fact failure this repo is built to prevent.
 *
 * Verification here is deliberately strict: the page must load *and* name the
 * company. A parked domain, a TLD marketplace and a redirect-to-hub all fail it.
 * A domain that fails is discarded and the next candidate is tried — so the
 * answer, when it comes, is a site we have actually read.
 *
 * ── The blocked case is a result, not a failure ───────────────────────────────
 *
 * Agnico Eagle's careers pages answer 403 to non-browser clients. Having found
 * the right domain and been refused by it is genuinely useful information — it
 * says "this employer needs a different route", which is the caller's cue to try
 * another approach rather than conclude the company publishes nothing. It is
 * reported as `blocked`, separately from `not found`, because the two lead to
 * opposite next steps.
 */

import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * TLDs tried, in the order a company's own site most often turns out to use.
 *
 * `.com` first because it still is, most of the time. `.org` second because a
 * great many employers are foundations, associations or public-interest bodies —
 * Mozilla, Wikipedia, the EFF — and would otherwise be missed behind a parked or
 * unrelated `.com`.
 */
const TLDS = ['com', 'org', 'io', 'co', 'net', 'ai', 'dev', 'co.uk', 'ca', 'com.au'];

/**
 * Words that carry no identity in a company name.
 *
 * The same list `source-company.mjs` uses when deciding whether a URL is the
 * company's own. Deliberately not shared by import: that function matches a host
 * against a name and needs to be conservative about substring collisions, while
 * this one builds a hostname and needs to be conservative about padding. Sharing
 * them would tie two different mistakes together.
 */
const COMPANY_NOISE_RE =
  /\b(inc|incorporated|llc|ltd|limited|plc|corp|corporation|co|company|group|holdings?|international|worldwide|global|the|and|of|gmbh|sa|nv|ab|oy|as|pty|technologies|technology|solutions|services|systems)\b/g;

/**
 * Reduce a company name to the words that might carry its identity.
 *
 * One or two letters are dropped: "HP" and "3M" are real company names but make
 * hopeless hostnames, and guessing `hp.com` for either gets a different employer.
 * A name reduced to nothing here is a name that needs search, not a guess.
 *
 * @param {string} company
 * @returns {{ words: string[], joined: string }}
 */
export function companyWords(company) {
  const words = String(company || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(COMPANY_NOISE_RE, ' ')
    .split(/[\s-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);

  return { words, joined: words.join('') };
}

/**
 * The hostnames a company name might be, most likely first.
 *
 * Pure and exported so the ordering can be asserted in a test without a network.
 *
 * Ordering matters more than coverage here. Each candidate that resolves but is
 * the wrong company costs a full HTTP verification, so the guesses a person would
 * make first — the concatenated brand, then the hyphenated brand, then the leading
 * word on its own — are tried first.
 *
 * @param {string} company
 * @returns {string[]}
 */
export function domainCandidates(company) {
  const { words, joined } = companyWords(company);
  if (!words.length) return [];

  const stems = [];
  const push = (s) => {
    // A stem of one or two characters would produce a hostname that collides with
    // an unrelated TLD-level domain, so it is not a guess worth making.
    if (s && s.length >= 3 && !stems.includes(s)) stems.push(s);
  };

  push(joined);                                  // agnicoeagle, pythonsoftwarefoundation
  push(words.join('-'));                         // python-software-foundation
  // Only the leading word alone: "Rio Tinto" must not resolve to rio.com, and the
  // leading word is the one that usually survives as the brand.
  push(words[0]);                                // discord, mozilla

  const hosts = [];
  for (const stem of stems) {
    for (const tld of TLDS) {
      const host = `${stem}.${tld}`;
      if (!hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts;
}

/**
 * The string a page must contain for a domain to count as the company's own.
 *
 * Prefers the full joined brand, because "agnicoeagle" appearing on a page is
 * strong evidence, while the single leading word is a weaker test and is only
 * used when there is nothing else. Compared without spaces and punctuation so
 * "Agnico Eagle", "agnico-eagle" and "AGNICOEAGLE" all match.
 *
 * @param {string} company
 * @returns {string}
 */
export function matchNeedle(company) {
  const { words, joined } = companyWords(company);
  return (joined || words[0] || String(company || '').toLowerCase()).replace(/[^a-z0-9]/g, '');
}

/**
 * Does this fetched page actually belong to the named company?
 *
 * @param {{ title?: string, content?: string }} page
 * @param {string} needle   from matchNeedle, lowercased and unpunctuated
 * @param {string} [company] the original name, for the all-words fallback
 */
export function pageNamesCompany(page, needle, company = '') {
  if (!needle) return false;
  const hay = `${page?.title || ''} ${page?.content || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!hay) return false;

  if (hay.includes(needle)) return true;

  // The full brand did not appear. Before giving up, accept a page that carries
  // every significant word — "Rio Tinto" on a page about Rio Tinto, even if the
  // two words are never adjacent. Requires all of them, so rio.com still fails
  // for Rio Tinto because it has no "tinto".
  const { words } = companyWords(company);
  if (words.length > 1 && words.every((w) => hay.includes(w))) return true;

  return false;
}

/** Number of DNS lookups and HTTP fetches a single call will spend. */
const DNS_BUDGET = 24;

/** How many *verified* domains to return, so the caller can try a second one. */
const DOMAIN_BUDGET = 3;

/**
 * Resolve a company name to its own website, if it can be found and verified.
 *
 * Never guesses. A returned `domain` has been fetched, has answered, and has been
 * found to name the company on the page. Everything else is reported as a miss
 * with the reason, so the caller can distinguish "could not find them" from
 * "found them, could not read them".
 *
 * @param {string} company
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]  injected for tests
 * @param {Function}     [opts.lookupImpl] injected for tests; (host) => Promise<string[]>
 * @param {number}       [opts.timeout]    per-request ms
 * @returns {Promise<{
 *   ok: boolean, domain: string|null, url: string|null, page: object|null,
 *   blocked: boolean, reason: string|null, tried: Array<object>
 * }>}
 */
export async function resolveCompanyDomain(company, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    lookupImpl = dnsLookup,
    timeout = 9000,
  } = opts;

  const needle = matchNeedle(company);
  const hosts = domainCandidates(company);
  const tried = [];

  if (!hosts.length) {
    return {
      ok: false, domain: null, url: null, page: null, blocked: false,
      reason: 'The company name has no usable words to build a web address from — it may need search.',
      tried,
    };
  }

  // ── Step 1: prune with DNS ────────────────────────────────────────────────
  //
  // Cheaper than HTTP by an order of magnitude, needs no rate-limit budget, and
  // answers the only question that eliminates most candidates outright: does this
  // hostname exist at all. Run concurrently because each one is a round trip.
  const budget = hosts.slice(0, DNS_BUDGET);
  const resolved = await Promise.all(
    budget.map(async (host) => {
      try {
        return (await hasAddress(host, lookupImpl)) ? host : null;
      } catch {
        return null; // NXDOMAIN or no A record — the common case, not an error
      }
    })
  );
  const live = budget.filter((_, i) => resolved[i]);

  // ── Step 2: verify the survivors by fetching ──────────────────────────────
  //
  // Sequential, not concurrent. Verification is the expensive step and the point
  // is to stop early; firing all of them at once would spend the whole budget on
  // candidates that lose anyway.
  //
  // Every live candidate is checked, not just the first plausible one, and a
  // refusal does not stop the walk. Both of those were bugs:
  //
  //   - `python.com` answers 403 as a parking page, and returning on the first
  //     403 abandoned the walk before `python.org` — the actual Python Software
  //     Foundation — was ever tried. A refusal by one candidate is information
  //     about that candidate, not about the company.
  //
  //   - `mozilla.com` is genuinely Mozilla's, and genuinely loads, and genuinely
  //     names Mozilla — but it is the Firefox consumer site. The leadership page
  //     a caller actually needs lives on `mozilla.org`. Stopping at the first
  //     verified host would report the right company and the wrong website, and
  //     the caller would then read a leadership page that does not exist there.
  //
  // So the result is a short ranked list of hosts that verifiably belong to the
  // company, and the caller walks it until one actually answers the question.
  const verifiedHosts = [];
  let blockedHost = null;

  for (const host of live) {
    if (verifiedHosts.length >= DOMAIN_BUDGET) break;
    const url = `https://${host}/`;
    const record = { host, dns: 'ok', http: null, verified: false };
    let page = null;

    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      const res = await fetchImpl(url, {
        signal: ctl.signal,
        redirect: 'follow',
        headers: {
          // Named as a browser, because some corporate sites serve a stripped page
          // or a 403 to anything that admits what it is. Nothing about the request
          // is deceptive beyond that header, and nothing is submitted.
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
      }).finally(() => clearTimeout(timer));

      record.http = res.status;

      if (!res.ok) {
        // A refusal from a real domain is information, not nothing: it means this
        // route to the company is closed. Recorded, and the walk continues.
        record.note = res.status === 403
          ? 'Domain resolves but refuses automated reads (403).'
          : `Domain resolves but answered HTTP ${res.status}.`;
        if ((res.status === 403 || res.status === 401 || res.status === 429) && !blockedHost) {
          blockedHost = { host, status: res.status };
        }
        tried.push(record);
        continue;
      }

      const html = await res.text();
      page = { title: titleOf(html), content: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
    } catch (e) {
      record.http = 'error';
      record.note = e?.name === 'AbortError' ? 'Timed out.' : String(e?.message || e).slice(0, 80);
      tried.push(record);
      continue;
    }

    record.verified = pageNamesCompany(page, needle, company);
    if (!record.verified) {
      // The domain is real but belongs to somebody else. The commonest version of
      // this is a parked domain or a TLD marketplace: the name was never the
      // company's to have.
      record.note = 'Resolves and loads, but the page does not name this company.';
    }
    tried.push(record);

    if (record.verified) verifiedHosts.push({ host, url, page });
  }

  if (verifiedHosts.length) {
    return {
      ok: true,
      // `domain` stays the best single answer for callers that only want one.
      // `domains` is the ranked list, for callers that need to try more than one —
      // see the Mozilla note above: a real company can own a marketing site and a
      // corporate site, and only one of them is where the answer lives.
      domain: verifiedHosts[0].host,
      domains: verifiedHosts.map((v) => ({ host: v.host, url: v.url })),
      url: verifiedHosts[0].url,
      page: verifiedHosts[0].page,
      blocked: false,
      reason: null,
      tried,
    };
  }

  if (blockedHost) {
    return {
      ok: false, domain: blockedHost.host, domains: [], url: null, page: null, blocked: true,
      reason: `Found ${blockedHost.host}, but it refuses automated reads (HTTP ${blockedHost.status}).`,
      tried,
    };
  }

  // Every hostname either failed to resolve, refused, or turned out to belong to
  // another company. That is a genuine miss and is reported as one — with the
  // detail, so the caller can tell the candidate cases apart.
  const gotPastDns = live.length;
  return {
    ok: false, domain: null, domains: [], url: null, page: null, blocked: false,
    reason: gotPastDns
      ? `Tried ${gotPastDns} web address${gotPastDns === 1 ? '' : 'es'} derived from the name; none of them turned out to be ${company}'s own site.`
      : `No web address for "${company}" resolved. The company may use a trading name quite unlike its brand, which needs search.`,
    tried,
  };
}

/** Best-effort <title> out of raw HTML, for the verification comparison. */
function titleOf(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html || '');
  return m ? m[1] : '';
}

/**
 * Did this hostname resolve?
 *
 * Written against the shape rather than a truthiness test, because `dns.lookup`
 * has returned three different shapes and this is exactly where that bites:
 *
 *   node:dns/promises  lookup(host)                 -> { address, family }
 *   node:dns/promises  lookup(host, { all: true })  -> [ { address, family }, ... ]
 *   node:dns           lookup(host)                 -> string
 *
 * A first version asked `addr.length`, which is `undefined` on the object the
 * promises API actually returns. Every candidate then looked unresolvable and the
 * resolver reported "no web address for Mozilla resolved" for mozilla.org — a
 * confident, wrong, and completely silent failure. The shape is now handled
 * explicitly so an injected test double cannot reintroduce it.
 *
 * @param {string} host
 * @param {Function} lookupImpl
 */
async function hasAddress(host, lookupImpl) {
  const addr = await lookupImpl(host);
  if (!addr) return false;
  if (typeof addr === 'string') return addr.length > 0;
  if (Array.isArray(addr)) return addr.length > 0;
  if (typeof addr === 'object') return Boolean(addr.address || addr.family);
  return false;
}