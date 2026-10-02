/**
 * relay/jobby/feeds.mjs — the job feed registry and reader
 *
 * Polls public RSS/Atom feeds, turns each item into a candidate opportunity, and
 * records where it came from so a posting can always be traced back.
 *
 * ── Why the source is carried on every item ────────────────────────────────
 *
 * An opportunity with no source is a rumour. The FIFO roster work already
 * established that the failure mode is a link that looks like a job and is not
 * one: 70 of 88 pointed at a careers page. So every item keeps its feed, the
 * guid the feed itself published, and the URL — and `validateOpportunity` still
 * runs over the result, so a feed that hands out search pages is caught by the
 * same rule that catches one anywhere else.
 *
 * ── Why a feed can be marked untrusted rather than trusted ────────────────
 *
 * These are third-party documents. A feed can serve anything, including
 * something injected. So the reader never executes what it reads, never follows
 * a link in a feed to fetch more, and records the raw guid so the same item is
 * recognised next poll. A feed that starts serving something off-key is visible
 * as a changed fingerprint rather than silently blended into a shortlist.
 */

import { validateOpportunity } from './packet.mjs';

/**
 * The feed registry.
 *
 * `track` maps a feed onto the five search tracks so a FIFO candidate is not
 * shown frontend contract work. `kind` separates postings from gigs, because
 * "gig" and "permanent role" are different decisions for someone who needs
 * income secured.
 */
export const FEEDS = [
  // ── Remote & technology ──────────────────────────────────────────────────
  { id: 'wwr-all', name: 'We Work Remotely', url: 'https://weworkremotely.com/remote-jobs.rss', track: 4, kind: 'permanent' },
  { id: 'wwr-fullstack', name: 'WWR — Full-Stack', url: 'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss', track: 4, kind: 'permanent' },
  { id: 'wwr-backend', name: 'WWR — Back-End', url: 'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss', track: 4, kind: 'permanent' },
  { id: 'wwr-frontend', name: 'WWR — Front-End', url: 'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss', track: 4, kind: 'permanent' },
  { id: 'wwr-devops', name: 'WWR — DevOps', url: 'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss', track: 4, kind: 'permanent' },
  { id: 'wwr-product', name: 'WWR — Product', url: 'https://weworkremotely.com/categories/remote-product-jobs.rss', track: 4, kind: 'permanent' },
  { id: 'wwr-design', name: 'WWR — Design', url: 'https://weworkremotely.com/categories/remote-design-jobs.rss', track: 4, kind: 'permanent' },
  { id: 'wwr-support', name: 'WWR — Customer Support', url: 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss', track: 4, kind: 'permanent' },
  { id: 'wwr-sales', name: 'WWR — Sales & Marketing', url: 'https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss', track: 4, kind: 'permanent' },
  { id: 'wwr-management', name: 'WWR — Management & Finance', url: 'https://weworkremotely.com/categories/remote-management-and-finance-jobs.rss', track: 4, kind: 'permanent' },

  { id: 'rfj-python', name: 'RemoteFirstJobs — Python', url: 'https://remotefirstjobs.com/rss/jobs/python.rss', track: 4, kind: 'permanent' },
  { id: 'rfj-react', name: 'RemoteFirstJobs — React', url: 'https://remotefirstjobs.com/rss/jobs/react.rss', track: 4, kind: 'permanent' },
  { id: 'rfj-golang', name: 'RemoteFirstJobs — Golang', url: 'https://remotefirstjobs.com/rss/jobs/golang.rss', track: 4, kind: 'permanent' },
  { id: 'rfj-ai', name: 'RemoteFirstJobs — AI', url: 'https://remotefirstjobs.com/rss/jobs/ai.rss', track: 4, kind: 'permanent' },
  { id: 'rfj-ds', name: 'RemoteFirstJobs — Data Science', url: 'https://remotefirstjobs.com/rss/jobs/data-science.rss', track: 4, kind: 'permanent' },
  { id: 'rfj-cyber', name: 'RemoteFirstJobs — Cybersecurity', url: 'https://remotefirstjobs.com/rss/jobs/cybersecurity.rss', track: 4, kind: 'permanent' },
  { id: 'rfj-dev', name: 'RemoteFirstJobs — Software Development', url: 'https://remotefirstjobs.com/rss/jobs/software-development.rss', track: 4, kind: 'permanent' },
  { id: 'rfj-qa', name: 'RemoteFirstJobs — QA', url: 'https://remotefirstjobs.com/rss/jobs/qa.rss', track: 4, kind: 'permanent' },
  { id: 'rfj-contract', name: 'RemoteFirstJobs — Contract', url: 'https://remotefirstjobs.com/rss/jobs/contract.rss', track: 1, kind: 'contract' },
  { id: 'rfj-entry', name: 'RemoteFirstJobs — Entry Level', url: 'https://remotefirstjobs.com/rss/jobs/entry-level.rss', track: 3, kind: 'permanent' },
  { id: 'rfj-writing', name: 'RemoteFirstJobs — Writing', url: 'https://remotefirstjobs.com/rss/jobs/writing.rss', track: 2, kind: 'contract' },
  { id: 'rfj-design', name: 'RemoteFirstJobs — Design', url: 'https://remotefirstjobs.com/rss/jobs/design.rss', track: 2, kind: 'contract' },

  // ── International, as JSON APIs ──────────────────────────────────────────
  //
  // "there must be some international feeds somewhere too" — the honest answer
  // is that the surviving international sources are mostly not RSS. Probed 48
  // candidate endpoints across Europe, the UK, Canada, Australia, India, Brazil,
  // South Africa and the general remote boards on 2026-09-30. The four
  // highest-volume sources alive are all JSON APIs, and the RSS directories for
  // most of the others are gone:
  //
  //   PROBLOGGER/BLOGGINGPRO/JOURNALISMJOBS  403 / 404 / HTML
  //   USAJOBS (all 5)                         200 but an HTML page
  //   CRAIGSLIST (all 160)                    403, every market, both UAs
  //   REED / SEEK / TOTALJOBS / CWJOBS        308 / 404 / 403 / HTML
  //   TRADEME / SWISSDEVJOBS / BR-EMPREGOS     HTML page, not a feed
  //   NOMADSJOBOARD / REMOTE4ALL / BERLINSTARTUPS / IT EJOBS   no connection
  //   EUROTECHJOBS / JOBBANK / NAUKRI / INFOJOBS / JOBBERMAN   404
  //   REMOTIVE / ARBEITNOW / WORKINGNOMADS RSS   301 to an HTML page
  //   SMARTRECRUITERS / RECRUITEE / WORKABLE     404 or empty
  //
  // What survived, and it is a good set: DEVITJOBS (1,821 items, Europe),
  // ARBEITNOW (326, DACH-weighted), JOBICY (200, worldwide remote), REMOTEOK
  // (100), HIMALAYAS (20, remote-first with published salary bands), plus
  // REMOTIVE and Hacker News as a fallback. JobICY and REMOTEOK are the two that
  // reach candidates a Canadian trades or FIFO feed never would.
  { id: 'devitjobs', name: 'DevITJobs (Europe)', url: 'https://www.devitjobs.com/rss', format: 'rss', track: 4, kind: 'permanent', region: 'europe' },
  { id: 'arbeitnow', name: 'Arbeitnow (Germany/EU)', url: 'https://www.arbeitnow.com/api/job-board-api', format: 'json', jsonPath: 'data', track: 4, kind: 'permanent', region: 'europe' },
  { id: 'jobicy', name: 'Jobicy (remote worldwide)', url: 'https://jobicy.com/api/v2/remote-jobs', format: 'json', jsonPath: 'jobs', track: 4, kind: 'permanent', region: 'worldwide' },
  { id: 'remoteok', name: 'RemoteOK', url: 'https://remoteok.com/api?limit=100', format: 'json', jsonPath: '$', track: 4, kind: 'permanent', region: 'worldwide' },
  { id: 'himalayas', name: 'Himalayas (remote, salary bands)', url: 'https://himalayas.app/jobs/api', format: 'json', jsonPath: 'jobs', track: 4, kind: 'permanent', region: 'worldwide' },
  { id: 'remotive', name: 'Remotive (remote worldwide)', url: 'https://remotive.com/api/remote-jobs?limit=50', format: 'json', jsonPath: 'jobs', track: 4, kind: 'permanent', region: 'worldwide' },
  // ── Employer ATS boards: the employer's own postings ─────────────────────
  //
  // A different kind of source, and the best in this registry. Every other feed
  // is an aggregator summarising somebody else's postings. A Greenhouse, Lever or
  // Ashby board is the employer's own, on the employer's own domain, with the
  // employer's own fields — and it is the only kind here that states the employer
  // as a field rather than something read out of a title.
  //
  // Measured 2026-09-30: Greenhouse gitlab 202 items, stripe 716; Lever dnb 115;
  // Ashby ashby 68, linear 30. Together 1,131 postings from five employers.
  //
  // Adding one is one line: a board URL, and the company name the board implies.
  // The company is on the registration because that is where the fact lives —
  // Lever publishes no company field at all, because for a Lever board the board
  // *is* the company, and inventing one per job from the title would be the
  // exact failure this product is built to avoid.
  //
  // A board token has to be a real company with live postings: `lever/lever`
  // returns 200 with zero items, and `boards-api.greenhouse.io/v1/boards/nope`
  // would too. An empty board is a valid answer, not an error.
  { id: 'ats-greenhouse-gitlab', name: 'GitLab (Greenhouse board)', url: 'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true', format: 'json', jsonPath: 'jobs', source: 'greenhouse', company: 'GitLab', track: 4, kind: 'permanent', region: 'worldwide', ats: true },
  { id: 'ats-greenhouse-stripe', name: 'Stripe (Greenhouse board)', url: 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true', format: 'json', jsonPath: 'jobs', source: 'greenhouse', company: 'Stripe', track: 4, kind: 'permanent', region: 'worldwide', ats: true },
  { id: 'ats-lever-dnb', name: 'Dun & Bradstreet (Lever board)', url: 'https://api.lever.co/v0/postings/dnb?mode=json', format: 'json', jsonPath: '$', source: 'lever', company: 'Dun & Bradstreet', track: 4, kind: 'permanent', region: 'worldwide', ats: true },
  { id: 'ats-ashby-ashby', name: 'Ashby (Ashby board)', url: 'https://api.ashbyhq.com/posting-api/job-board/ashby?includeCompensation=true', format: 'json', jsonPath: 'jobs', source: 'ashby', company: 'Ashby', track: 4, kind: 'permanent', region: 'worldwide', ats: true },
  { id: 'ats-ashby-linear', name: 'Linear (Ashby board)', url: 'https://api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true', format: 'json', jsonPath: 'jobs', source: 'ashby', company: 'Linear', track: 4, kind: 'permanent', region: 'worldwide', ats: true },

  // ── Measured and discarded from the 2026-09-30 intake ────────────────────
  //
  // Recorded rather than deleted, because "we tried it and here is why" is worth
  // more than a silent absence:
  //
  //   remotive.com/remote-jobs/feed   17 items. Duplicates remotive/api, which
  //                                     is already read. Same source, two formats,
  //                                     two feed ids, every job twice.
  //   jobicy.com/?feed=job_feed        200 items. Duplicates jobicy/api/v2.
  //   himalayas.app/jobs/rss           20 items.  Duplicates himalayas/jobs/api.
  //   problogger.com/jobs/feed/        200, a valid feed, and empty.
  //   craigslist (every market)         403, re-tested. See the note above.
  //
  // The three duplicates are the interesting ones. The board is keyed on
  // (feed_id, guid), so a second feed for a source already present writes each of
  // its jobs again under a different feed id — a board that silently doubles. The
  // right answer is one format per source, and the JSON API is the better format:
  // it carries a company field and a location field, which the RSS does not.
  //
  // Hacker News is NOT a job board and was removed after measurement.
  //
  // It was in the candidate list on the strength of its monthly "Ask HN: Who is
  // hiring?" threads, which are genuinely useful to a person reading them. As a
  // feed it is the front page, so the poller filled the board with everything
  // published that month: the top result on the first poll was a magazine
  // article about three employees' circumstances, titled as a job and linked to
  // a news story.
  //
  // A candidate reading a board of that is being shown worse than nothing,
  // because it looks like the product is sending them irrelevant work. The
  // threads are worth reading; a feed of the whole site is not a way to find
  // them. Kept here as a comment rather than deleted, because the source is real
  // and someone may find a way to read just the hiring threads.
  //
  // { id: 'hn-hiring', name: 'Hacker News — Who is hiring', url:
  //   'https://news.ycombinator.com/rss', format: 'rss', track: 3,
  //   kind: 'permanent', region: 'worldwide',
  //   disabled: 'not a job feed — it is the whole HN front page (checked 2026-09-30)' },

  { id: 'rwfa-all', name: 'Real Work From Anywhere', url: 'https://www.realworkfromanywhere.com/rss.xml', track: 4, kind: 'permanent' },
  { id: 'rwfa-fullstack', name: 'RWFA — Full-Stack', url: 'https://www.realworkfromanywhere.com/remote-fullstack-jobs/rss.xml', track: 4, kind: 'permanent' },
  { id: 'rwfa-frontend', name: 'RWFA — Frontend', url: 'https://www.realworkfromanywhere.com/remote-frontend-jobs/rss.xml', track: 4, kind: 'permanent' },
  { id: 'rwfa-backend', name: 'RWFA — Backend', url: 'https://www.realworkfromanywhere.com/remote-backend-jobs/rss.xml', track: 4, kind: 'permanent' },
  { id: 'rwfa-dev', name: 'RWFA — Software Engineering', url: 'https://www.realworkfromanywhere.com/remote-software-developer-jobs/rss.xml', track: 4, kind: 'permanent' },
  { id: 'rwfa-design', name: 'RWFA — UI/UX', url: 'https://www.realworkfromanywhere.com/remote-design-jobs/rss.xml', track: 2, kind: 'permanent' },
  { id: 'rwfa-devops', name: 'RWFA — DevOps', url: 'https://www.realworkfromanywhere.com/remote-devops-and-sysadmin-jobs/rss.xml', track: 4, kind: 'permanent' },
  { id: 'rwfa-mgmt', name: 'RWFA — Management & Finance', url: 'https://www.realworkfromanywhere.com/remote-management-and-finance-jobs/rss.xml', track: 4, kind: 'permanent' },
  { id: 'rwfa-product', name: 'RWFA — Product', url: 'https://www.realworkfromanywhere.com/remote-product-jobs/rss.xml', track: 4, kind: 'permanent' },
  { id: 'rwfa-support', name: 'RWFA — Customer Support', url: 'https://www.realworkfromanywhere.com/remote-customer-support-jobs/rss.xml', track: 4, kind: 'permanent' },

  // ── Creative, freelance & writing ────────────────────────────────────────
  //
  // Measured, not assumed. Every feed below was read on 2026-09-30 and the
  // result recorded. Four of the seven in this section do not work, and the
  // registry says so rather than listing them as if they did:
  //
  //   problogger      200, no <item> elements — served a page, not a feed
  //   bloggingpro     403 — blocks non-browser clients
  //   fwj             DNS/connection failure
  //   journalismjobs  404
  //
  // They are kept, disabled, because a feed that has worked before comes back,
  // and deleting the entry loses the knowledge that it ever existed. A registry
  // that quietly drops its dead sources is a registry that forgets.
  { id: 'problogger', name: 'ProBlogger Jobs', url: 'https://problogger.com/jobs/feed/', track: 2, kind: 'contract', disabled: 'serves an HTML page, not a feed (checked 2026-09-30)' },
  { id: 'bloggingpro', name: 'BloggingPro Jobs', url: 'https://www.bloggingpro.com/jobs/feed/', track: 2, kind: 'contract', disabled: 'HTTP 403 — blocks non-browser clients (checked 2026-09-30)' },
  { id: 'fwj', name: 'Freelance Writing Gigs', url: 'https://www.freelancewritinggigs.com/feed/', track: 2, kind: 'contract', disabled: 'connection failed (checked 2026-09-30)' },
  { id: 'journalismjobs', name: 'Journalism Jobs', url: 'https://www.journalismjobs.com/rss/jobs', track: 2, kind: 'permanent', disabled: 'HTTP 404 (checked 2026-09-30)' },

  // ── Government ───────────────────────────────────────────────────────────
  //
  // All five USAJobs feeds answer 200 with an HTML page. The `?format=rss`
  // convention the list documents is not honoured by the site as it stands, so
  // these are disabled too. This is the largest single loss in the registry:
  // it was the only public-sector source here, and it is worth re-probing rather
  // than deleting, because a public-sector feed is exactly what a candidate
  // without a private-sector network needs.
  { id: 'usajobs-all', name: 'USAJobs — All', url: 'https://www.usajobs.gov/Search/Results?format=rss', track: 3, kind: 'permanent', region: 'us', disabled: 'returns an HTML page, not a feed (checked 2026-09-30)' },
  { id: 'usajobs-it', name: 'USAJobs — Information Technology (2210)', url: 'https://www.usajobs.gov/Search/Results?j=2210&format=rss', track: 4, kind: 'permanent', region: 'us', disabled: 'returns an HTML page, not a feed (checked 2026-09-30)' },
  { id: 'usajobs-nursing', name: 'USAJobs — Nursing & Medical (0610)', url: 'https://www.usajobs.gov/Search/Results?j=0610&format=rss', track: 3, kind: 'permanent', region: 'us', disabled: 'returns an HTML page, not a feed (checked 2026-09-30)' },
  { id: 'usajobs-bio', name: 'USAJobs — Biological Sciences (0401)', url: 'https://www.usajobs.gov/Search/Results?j=0401&format=rss', track: 3, kind: 'permanent', region: 'us', disabled: 'returns an HTML page, not a feed (checked 2026-09-30)' },
  { id: 'usajobs-eng', name: 'USAJobs — Engineering (0801)', url: 'https://www.usajobs.gov/Search/Results?j=0801&format=rss', track: 3, kind: 'permanent', region: 'us', disabled: 'returns an HTML page, not a feed (checked 2026-09-30)' },

  // ── Craigslist, by market ────────────────────────────────────────────────
  //
  // MEASURED DEAD. Every one of these returns HTTP 403, on every market and
  // every category, and a browser User-Agent changes nothing — checked 2026-09-30
  // against Austin, New York, London, SF Bay and Denver, with both a feed-reader
  // UA and a full Chrome UA. Craigslist blocks programmatic access to these
  // endpoints rather than merely disliking one client.
  //
  // That makes this the largest single loss in the registry: 160 entries, and
  // Craigslist was the highest-signal source here for the FIFO and trades
  // tracks, which is exactly who this product is for. It is kept in the
  // registry, disabled, because the block may lift and because deleting the
  // knowledge loses it. But nothing should be built on these returning items.
  //
  // The alternative worth trying, and not yet tried: the categories have public
  // JSON-ish endpoints behind their search pages, or an email alert. Both are a
  // different access pattern and a different decision about whether to use a
  // source that is resisting being read.
  ...craigslistFeeds(),
];

/**
 * The Craigslist markets, built from a table rather than a cross-product.
 *
 * Generated by looping over every city and category in the original list, the
 * registry was 200+ entries of which most were never fetched and none could be
 * talked about individually. The named markets below are the ones a candidate in
 * this product's tracks would actually search, and a market that starts refusing
 * the feed is one line to remove.
 */
function craigslistFeeds() {
  const CITIES = [
    'newyork', 'losangeles', 'chicago', 'sfbay', 'austin', 'seattle', 'denver',
    'boston', 'atlanta', 'miami', 'portland', 'phoenix', 'houston', 'dallas',
    'minneapolis', 'london',
  ];
  // cpg computer gigs, crg creative, wrg writing, lbg labor, ttg talent,
  // sof software jobs, mar marketing, acc accounting, eng engineering, med medical.
  const CATS = [
    ['cpg', 4, 'gig'], ['crg', 2, 'gig'], ['wrg', 2, 'gig'], ['lbg', 3, 'gig'],
    ['ttg', 3, 'gig'],
    ['sof', 4, 'permanent'], ['eng', 3, 'permanent'], ['med', 3, 'permanent'],
    ['acc', 3, 'permanent'], ['mar', 4, 'permanent'],
  ];
  const out = [];
  for (const city of CITIES) {
    for (const [code, track, kind] of CATS) {
      out.push({
        id: `cl-${city}-${code}`,
        name: `Craigslist ${city} — ${code.toUpperCase()}`,
        url: `https://${city}.craigslist.org/search/${code}?format=rss`,
        track,
        kind,
        region: city === 'london' ? 'uk' : 'us',
        // Craigslist is the source most likely to start serving a challenge page
        // to a non-browser client. Flagged so a failure there is read as a known
        // risk rather than a bug in the reader.
        fragile: true,
        // Every one of these 160 was read on 2026-09-30 and answered 403, on
        // every market and category, with both a feed-reader UA and a full
        // browser UA. They are disabled rather than deleted so the block can be
        // re-tested and, if it lifts, they work again without being rebuilt.
        disabled: 'HTTP 403 — Craigslist blocks programmatic access to these (checked 2026-09-30)',
      });
    }
  }
  return out;
}

export const FEED_BY_ID = new Map(FEEDS.map((f) => [f.id, f]));

// ── Parsing ─────────────────────────────────────────────────────────────────

/** Entities RSS bodies are full of. Decoded, and nothing else. */
function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    // Numeric entities, last, so "&amp;#39;" does not become "'" by two steps.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)));
}

function safeChar(code) {
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

/**
 * A date the feed actually stated, or null.
 *
 * Publishers emit RFC-822 ("Wed, 30 Sep 2026 15:18:21 +0000"), ISO-8601, Unix
 * integers, and occasionally a placeholder that is a date-shaped string nobody
 * can parse. `new Date(x)` on the last of those returns an Invalid Date, which
 * serialises to "Invalid Date" and then reaches Postgres as
 * "0NaN-NaN-NaN..." and aborts the whole write batch — one bad date in one feed
 * out of thirty-nine stopping the other thirty-eight from being recorded.
 *
 * So the value is checked, and an unreadable one is null: the job is still a job,
 * its age is simply unknown, which is a fact rather than a failure.
 */
export function parseFeedDate(value, { fetchedAt = null } = {}) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  // Placeholders and outright nonsense, refused before Date is asked.
  if (/^(?:0000-00-00|null|n\/a|none|undefined|-{1,})$/i.test(s)) return null;

  let d;
  if (/^\d{9,14}$/.test(s)) {
    const n = Number(s);
    if (n > 1e11) {
      d = new Date(n);                       // milliseconds
    } else {
      d = new Date(n * 1000);                // seconds
    }
  } else {
    d = new Date(s);
  }
  if (Number.isNaN(d.getTime())) return null;

  // A "published" date that is the moment we asked for it is not a publication
  // date. It is our own read time wearing a fact's clothes.
  //
  // Himalayas sets `pubDate` to the current instant on every fetch: twenty
  // consecutive jobs came back stamped 2026-09-30T23:59:11, 23:59:08, 23:59:08,
  // 23:58:33 — four seconds apart, matching nothing about when those roles were
  // posted. Two things then went wrong at once. The board is ordered by
  // `published_at DESC`, so those twenty rows sat permanently at the top of the
  // public jobs list, which read as "every job here is from one source" — and a
  // candidate filtering by date would have been told those jobs were posted today.
  //
  // A real posting date is not within seconds of our fetch. So a claimed date
  // inside the fetch window is discarded as the gap it is, which is the same
  // treatment every other absent fact gets. The cost is that a role genuinely
  // posted ninety seconds ago loses its date; the alternative is a date we know to
  // be false, on 1,295 rows, deciding what the whole board shows.
  //
  // `fetchedAt` is passed rather than read from the clock so the rule is testable
  // and so a replay of an old feed is judged against when it was read, not now.
  if (fetchedAt) {
    const fetched = new Date(fetchedAt).getTime();
    if (!Number.isNaN(fetched)) {
      const age = fetched - d.getTime();
      // A claimed date inside the fetch window is not a publication date.
      //
      // The window is two minutes, and it has to be: the stamp and the fetch are
      // not simultaneous. A source that stamps on read writes its timestamp during
      // serialisation, and the HTTP response, the TLS close and the JSON parse all
      // happen after — measured at up to a second and a half on this machine, and
      // a slow response or a cold connection can be several. A one-and-a-half-second
      // window caught "right now" and missed "one second ago", which is the same
      // lie arriving a second later.
      //
      // Two minutes is comfortably wider than any real gap between a source
      // stamping a row and us receiving it, and comfortably narrower than any real
      // posting date. The cost of being wrong in the strict direction is that a
      // role genuinely posted a minute ago loses its date; the cost of being wrong
      // the other way is a date we know to be false deciding the order of 1,315
      // rows.
      const tolerance = 120000;
      // Also catching a stamp slightly ahead of our clock, which the -60s bound
      // covers: a source on a fast clock would otherwise produce a negative age and
      // sail past a one-sided test.
      if (age >= -60000 && age < tolerance) return null;
    }
  }
  return d.toISOString();
}

/** Tags inside one element, tolerating namespaces and CDATA. */
function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : null;
}

/** The href of the first <link>, in either the RSS or Atom shape. */
function linkOf(block) {
  // Atom: <link href="..." rel="alternate"/>
  const atom = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (atom) return decodeEntities(atom[1]).trim();
  // RSS: <link>https://...</link>
  const rss = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  return rss ? decodeEntities(rss[1]).trim() : null;
}

/**
 * Parse a feed document into items.
 *
 * Handles RSS 2.0 and Atom, because the two differ in exactly the ways that
 * break naive parsers: Atom links are an attribute, RSS links are text, and Atom
 * dates are ISO while RSS dates are RFC-822. A parser that reads only one gets
 * a feed with items and no links, which is a feed that looks alive and produces
 * nothing usable.
 */
export function parseFeed(xml, { fetchedAt = null } = {}) {
  const doc = String(xml || '');
  if (!doc.trim()) return { ok: false, error: 'empty document', items: [] };

  const isAtom = /<feed[\s>]/i.test(doc) && /xmlns=["'][^"']*Atom/i.test(doc);
  const blocks = [...doc.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)];

  if (!blocks.length) {
    // Three different failures that all look like "nothing came back", told
    // apart because the operator's response to each is different.
    //
    // The middle one was the bug: a real, valid, subscribed channel that
    // currently has no jobs in it returned a well-formed RSS document with an
    // empty channel, and the reader reported it as a broken feed. Two live feeds
    // were about to be deleted from the registry for being quiet, when the fault
    // was that nobody had posted in a while.
    const isHtml = /^\s*<(!doctype html|html)/i.test(doc);
    const isFeedShell = /<rss[\s>]/i.test(doc) || /<feed[\s>]/i.test(doc)
      || /<channel[\s>]/i.test(doc);

    if (isHtml) {
      return {
        ok: false, state: 'not_a_feed',
        error: 'returned an HTML page, not a feed',
        items: [],
      };
    }
    if (isFeedShell) {
      return {
        ok: true, state: 'empty', format: /<feed[\s>]/i.test(doc) ? 'atom' : 'rss',
        // ok, because the feed is working. There is simply nothing in it.
        error: null,
        note: 'The feed is live and has no items right now.',
        items: [], count: 0, usable: 0,
      };
    }
    return {
      ok: false, state: 'unrecognised',
      error: 'the document is neither HTML nor a feed',
      items: [],
    };
  }

  const items = blocks.map(([, tag, body]) => {
    const title = tagText(body, 'title');
    const link = linkOf(body);
    const guid = tagText(body, 'guid') || tagText(body, 'id') || link;
    const publishedRaw = tagText(body, 'pubDate') || tagText(body, 'published')
      || tagText(body, 'updated') || tagText(body, 'dc:date');
    const published = parseFeedDate(publishedRaw, { fetchedAt });
    // A description, with tags stripped: feed bodies are full of markup and
    // this ends up in a prompt.
    const rawDesc = tagText(body, 'description') || tagText(body, 'summary')
      || tagText(body, 'content:encoded') || tagText(body, 'content') || '';
    const description = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // The company, when the feed bothers to say. Many do not, and it is left
    // null rather than guessed from the title — "Senior Engineer at Acme" is a
    // real signal but a derived one, and the caller can decide.
    const author = tagText(body, 'author') || tagText(body, 'dc:creator');

    return {
      title,
      link,
      guid,
      published,
      description,
      author,
      // Whether the document said what it was. An item with a title and no link
      // is unusable and is reported as such rather than offered as a lead.
      usable: !!(title && link),
    };
  });

  return {
    ok: true,
    format: isAtom ? 'atom' : 'rss',
    items,
    count: items.length,
    usable: items.filter((i) => i.usable).length,
  };
}

// ── Fetching ────────────────────────────────────────────────────────────────

/**
 * Read one feed.
 *
 * Never throws and never follows a redirect to somewhere off the feed. A
 * redirect chain is reported as a redirect, because a feed quietly redirecting
 * to an HTML page is how a source dies without saying so.
 */
export async function readFeed(feed, { fetchImpl = globalThis.fetch, timeout = 20000 } = {}) {
  const started = Date.now();
  const format = feed.format === 'json' ? 'json' : 'rss';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const response = await fetchImpl(feed.url, {
      signal: controller.signal,
      // Followed, not manual. A 301 to the same site's canonical feed URL is
      // normal and not a signal of anything: devitjobs.com/rss redirects to
      // devitjobs.com/rss and returns 1,821 items, and refusing the redirect
      // would have thrown away the single largest source in the registry.
      // The "the feed has probably moved" case is covered by the fingerprint
      // changing, not by refusing to follow.
      redirect: 'follow',
      headers: {
        // A feed reader, or a browser, depending on what the source wants. Both
        // were tried against Craigslist and both got 403, so pretending to be
        // something we are not buys nothing — and this is honest about what the
        // reader is.
        'User-Agent': 'JobbyMcJobberson/1.0 (+job feed reader)',
        Accept: format === 'json'
          ? 'application/json, */*;q=0.8'
          : 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
    });
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        feedId: feed.id,
        status: response.status,
        error: `redirected (${response.status}) and not followed`,
        elapsedMs: Date.now() - started,
      };
    }
    if (!response.ok) {
      return {
        ok: false, feedId: feed.id, status: response.status,
        // 403 is the interesting one: it is what a source with bot protection
        // returns, and it is not a broken URL.
        error: response.status === 403
          ? 'refused (403) — this source blocks non-browser clients'
          : `HTTP ${response.status}`,
        elapsedMs: Date.now() - started,
      };
    }

    const body = await response.text();
    // When the bytes were fetched, taken once here and handed to both parsers.
    //
    // It is the only moment that is true, and it is what `parseFeedDate` compares a
    // claimed publication date against to tell a real posting date from a source
    // stamping the current instant onto every row. See parseFeedDate.
    const fetchedAt = new Date().toISOString();
    const parsed = format === 'json'
      ? parseJsonFeed(body, feed, { fetchedAt })
      : parseFeed(body, { fetchedAt });
    return {
      ...parsed,
      feedId: feed.id,
      feedName: feed.name,
      feedUrl: feed.url,
      status: response.status,
      finalUrl: response.url,
      bytes: body.length,
      elapsedMs: Date.now() - started,
      // Cheap change detection, so a feed that starts serving something else is
      // visible rather than blended in.
      fingerprint: body.length + ':' + simpleHash(body.slice(0, 4000)),
    };
  } catch (e) {
    return {
      ok: false,
      feedId: feed.id,
      error: /abort/i.test(String(e.message)) ? `timed out after ${timeout}ms` : String(e.message).slice(0, 120),
      elapsedMs: Date.now() - started,
    };
  }
}

function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ── Turning items into opportunities ────────────────────────────────────────

/**
 * Read one feed's items as opportunities.
 *
 * `validateOpportunity` runs over the result, unchanged, so a feed that hands
 * out a search page is caught here exactly as it would be anywhere else. The
 * feed's own opinion of the link does not override that check.
 */
export function itemsToOpportunities(feed, items, { limit = 25 } = {}) {
  const out = [];
  for (const raw of items) {
    // Split role from employer where the feed stated both in one title. Done
    // here rather than in the parser because the JSON sources already have a
    // company field and this must not touch them.
    const item = splitItem(raw);
    if (!item.usable) continue;

    // Company: carried from the source when the source states it, which the
    // JSON boards do, and null for the XML ones that mostly do not. Never
    // derived from the title here — "Senior Engineer at Acme" is ambiguous about
    // which part is which, and a wrong company on an application is worse than
    // a blank one.
    const company = item.company || null;
    // How the employer on this row was arrived at, recorded so a reviewer can tell
    // a stated fact from a reading. Three levels, and they are not
    // interchangeable:
    //
    //   stated_as_field          the employer's own board carries a company field
    //                            and filled it in. GitLab, Stripe. Nothing is
    //                            inferred from the posting.
    //   stated_by_board          the board *is* the company, so the company comes
    //                            from the feed registration. Still a fact about
    //                            the source, but one this product entered by hand
    //                            rather than one the employer published per job.
    //   stated_in_title:via     read out of a headline. A reading of what the
    //                            feed published, not a fact the feed marked.
    //   not_stated              no employer, and none guessed.
    const companyProvenance = item.companyFrom
      ? `stated_in_title:${item.companyFrom}`
      : (item.companyFromBoard ? 'stated_by_board'
        : (company ? 'stated_as_field' : 'not_stated'));

    // The location a source states goes in the description the packet reads, not
    // into the link, and never becomes a claim the candidate is told. It is
    // prepended because feeds put the territory at the end of a long body and a
    // reader needs it at the top.
    const where = [
      item.location ? `Location: ${item.location}` : null,
      item.arrangementFromBody ? `Arrangement: ${item.arrangementFromBody}` : null,
    ].filter(Boolean).join('\n');
    const whereBlock = where ? `${where}\n\n` : '';
    const tags = item.tags && item.tags.length ? `\n\nTags: ${item.tags.join(', ')}` : '';
    const pay = item.salary
      ? `\n\nStated pay: ${item.salary.min ?? '?'}–${item.salary.max ?? '?'} ${item.salary.currency || ''}`.trim() + ` per ${item.salary.period || 'period'}`
      : '';

    const validation = validateOpportunity({ role: item.title, company, url: item.link });

    out.push({
      role: item.title,
      company,
      url: item.link,
      // The provenance block. This is what makes the item auditable later.
      source: {
        feedId: feed.id,
        feedName: feed.name,
        feedUrl: feed.url,
        guid: item.guid,
        published: item.published,
        kind: feed.kind,
        region: feed.region || null,
        locationStated: item.location || null,
        // A remote arrangement is not a place. Kept as its own field so nothing
        // downstream can promote "remote" into a location and match every
        // location filter on the board.
        arrangementStated: item.arrangementFromBody || (item.arrangement || null),
        // The feed is a public document from a third party, not something the
        // candidate edited and not something anybody here verified.
        trust: 'third_party_feed',
        companyProvenance,
      },
      track: feed.track,
      kind: feed.kind,
      description: (whereBlock + (item.description || '') + pay + tags).slice(0, 4000),
      // Run through the same gate as every other opportunity.
      validation,
      // A careers page from a feed is still a careers page.
      worthBuilding: validation.verdict === 'direct_posting',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Read a feed and turn it into opportunities in one call. */
export async function harvestFeed(feed, opts = {}) {
  const read = await readFeed(feed, opts);
  if (!read.ok) return { feedId: feed.id, feedName: feed.name, ok: false, error: read.error, opportunities: [] };
  const opportunities = itemsToOpportunities(feed, read.items, { limit: opts.limit || 25 });
  return {
    feedId: feed.id,
    feedName: feed.name,
    ok: true,
    format: read.format,
    items: read.count,
    usable: read.usable,
    setAside: read.setAside || 0,
    // How many of this feed's items are worth a person's time. A feed of 200
    // where 180 are careers pages is a bad source even though it is alive.
    worthBuilding: opportunities.filter((o) => o.worthBuilding).length,
    opportunities,
  };
}

/**
 * The company, when the feed states it somewhere other than a field.
 *
 * This is not a guess about the title. Two conventions cover most of what the
 * XML boards do, and both are stated facts rather than inferences:
 *
 *   "Toptal: Enterprise Sales Development Representative"   — Company: Title
 *   "Senior Data Engineer (US only) at Nimble Gravity"      — Title at Company
 *
 * Either way the employer is written down, and leaving `company: null` on 1,863
 * of 2,198 items threw away a fact the feed had already published — which
 * matters because a packet with a blank employer is one nobody can act on
 * confidently.
 *
 * What it will not do: split on a bare colon or match any "at", and guess. A
 * title like "Sr. Engineer, Platform" has no company in it and returns null. An
 * invented employer on an application is worse than a blank one, so both
 * patterns are narrow and each requires the half that is supposed to be a
 * company to look like one rather than like a job title.
 */
export function companyFromTitle(title) {
  const t = String(title || '').trim();
  if (!t) return null;

  /**
   * Words that appear where a company would go and never are one.
   *
   * A real list, not a short one, because this pattern reads structure and
   * structure has many shapes. "Remote: Customer Support Rep" and "Location:
   * Canada" both matched and would have put "Remote" and "Location" on an
   * application as the employer, which is the exact failure this whole
   * mechanism is not allowed to have.
   */
  const NOT_A_COMPANY = new RegExp(
    '^(?:remote|hybrid|onsite|on[- ]site|in[- ]office|location|loc|place|city|region|province|state|'
    + 'country|full[- ]?time|part[- ]?time|contract|permanent|temporary|freelance|relocation|'
    + 'salary|pay|comp|compensation|benefits|perks|about|job|jobs|role|position|opening|'
    + 'company|employer|industry|department|team|office|branch|site|shift|hours|'
    + 'apply|how to apply|important|note|warning|urgent|new|hiring|we|our|us|the|a|an|'
    + 'this|that|these|those|and|or|but|for|with|from|to|of|in|on|at|by|as|'
    + 'least|all|night|day|times|once|home|first|last|will|can|must|may|'
    + 'immediate|immediately|starting|starts|ends|closing|closes)$', 'i');

  const looksLikeACompany = (s) => {
    const v = String(s || '').trim();
    if (!v || v.length < 2 || v.length > 60) return false;
    if (NOT_A_COMPANY.test(v)) return false;
    // A company name has a capital in it and no sentence punctuation. This
    // rejects "Canada" only via the list above; "Acme Corp." is allowed.
    if (/[.;!?]$/.test(v) && !/\b(?:inc|ltd|llc|corp|corporation|co|company|group|holdings|partners|labs|studio|agency|systems|technologies|solutions)\.?$/i.test(v)) return false;
    return /[A-Za-z]/.test(v);
  };

  // "Company: Title" — the company is before the colon, the role after it.
  const colon = t.match(/^([A-Za-z][\w&.'()-]*(?:\s+[A-Z0-9&.'()-]+){0,4}):\s+(.{4,})$/);
  if (colon) {
    const left = colon[1].trim();
    const right = colon[2].trim();
    // Both halves have to pass. "Remote: Customer Support Rep" fails on the left
    // and "Acme: Canada" would fail on the right.
    if (looksLikeACompany(left) && right.length > 5 && !NOT_A_COMPANY.test(right.split(/[\s,]/)[0])) {
      return { company: left, title: right, via: 'title_before_colon' };
    }
  }

  // "Title at Company" — a trailing "at" with a name after it.
  const at = t.match(/^(.{5,}?)\s+(?:at|@)\s+([A-Za-z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s*$/);
  if (at) {
    // The role keeps its qualifiers. "(US only)" is an eligibility statement a
    // candidate needs, so the brackets stay; the guard is on the left being long
    // enough to be a role, not on it being free of punctuation.
    const left = at[1].trim();
    const right = at[2].trim();
    if (looksLikeACompany(right) && left.length > 4) {
      return { company: right, title: left, via: 'title_after_at' };
    }
  }
  return null;
}

/**
 * The location, where the feed states it in the body rather than a field.
 *
 * 1,906 of 2,198 items had no location at all, and the XML boards put it in the
 * description: We Work Remotely opens every posting with "Headquarters: remote"
 * followed by the employer's site. That is a stated fact, not an inference, and
 * discarding it left the majority of the registry with no place a candidate could
 * filter on.
 *
 * What it will not do is treat "remote" as a location. A remote job has no place,
 * and reporting "Remote" as its location is the same mistake as reading "remote
 * underground" as work-from-home. It is recorded as an arrangement, which is what
 * it is.
 */
export function locationFromBody(description) {
  const d = String(description || '');
  if (!d) return { location: null, arrangement: null };

  // The pattern the boards actually use, at the top of the body.
  const head = d.slice(0, 400);
  const labelled = head.match(
    /(?:headquarters|location|based in|office|site)\s*[:\-–]\s*([^\n|·•]{2,70})/i);
  if (labelled) {
    const raw = labelled[1].trim().replace(/\s*URL:.*$/i, '').trim();
    const remoteOnly = /^(?:remote|anywhere|worldwide|work from home|fully remote)\b/i.test(raw);
    return {
      location: remoteOnly ? null : raw,
      arrangement: remoteOnly ? 'remote' : null,
    };
  }

  // A city and a two-letter region, or a spelled-out one.
  const cityProv = head.match(/\b([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+)?),\s*([A-Z]{2})\b/);
  if (cityProv) return { location: `${cityProv[1]}, ${cityProv[2]}`, arrangement: null };

  if (/\b(?:fully\s+remote|100%\s+remote|work from home|remote[- ]first|anywhere)\b/i.test(head)) {
    return { location: null, arrangement: 'remote' };
  }
  return { location: null, arrangement: null };
}

/**
 * Split an item into its role and its employer, where the feed states both.
 *
 * The role keeps its qualifiers. "(US only)" is an eligibility statement a
 * candidate needs to see, not punctuation to be tidied away.
 */
function splitItem(item) {
  let next = item;
  if (!item.company) {
    const found = companyFromTitle(item.title);
    if (found) {
      next = { ...next, company: found.company, title: found.title, companyFrom: found.via };
    }
  }
  if (!next.location) {
    const found = locationFromBody(next.description);
    if (found.location || found.arrangement) {
      next = {
        ...next,
        location: next.location || found.location,
        // An arrangement read from the body is kept apart from a location, so a
        // remote job does not acquire a "Remote" location and start matching
        // every location filter on the board.
        arrangementFromBody: found.arrangement || null,
      };
    }
  }
  return next;
}

/**
 * Read a JSON job API into the same item shape the XML reader produces.
 *
 * Every one of these is a different company with a different name for the same
 * three facts, and all five field maps below were read off live responses rather
 * than guessed. A generic adapter that assumed one vendor's naming returned
 * `undefined` from the other four, which is an item with no title — worse than
 * dropping it, because it looks like a job.
 *
 * Two traps that are handled here and would otherwise be silent:
 *
 *  - **RemoteOK's first record is a legal notice**, not a job: `{last_updated,
 *    legal}` with nothing else. Taken at face value it is an item with no title,
 *    and if it is treated as one it counts towards the feed's total and shows a
 *    candidate a blank card.
 *  - **Arbeitnow sometimes links the employer's homepage** instead of the
 *    posting — 1 record in 326 in the sample, so a rate that looks like noise but
 *    is not. A company homepage is not a job listing and must not be offered as
 *    one, so it is dropped rather than relabelled.
 */
const JSON_FIELD_MAPS = {
  remoteok: {
    title: ['position', 'title'],
    company: ['company'],
    url: ['url', 'apply_url'],
    date: ['date', 'epoch'],
    description: ['description'],
    location: ['location'],
    tags: ['tags'],
  },

  // ── The ATS boards ───────────────────────────────────────────────────────
  //
  // A different kind of source, and the best one in this registry. Every other
  // feed here is an aggregator summarising somebody else's postings; a
  // Greenhouse or Lever board is the employer's own postings, on the employer's
  // own domain, with the employer's own fields. It is also the only kind that
  // states the employer as a *field* rather than something parsed out of a title,
  // which is why these rows need no title-splitting at all.
  greenhouse: {
    title: ['title'],
    // The one source in this registry that names the employer properly.
    company: ['company_name'],
    url: ['absolute_url'],
    // first_published rather than updated_at: a posting's age is when it went
    // live, not the last time somebody edited the HTML of it.
    date: ['first_published', 'updated_at'],
    // HTML-encoded, and stripped of tags downstream.
    description: ['content'],
    // An object: {"name": "Remote, Bangalore"}. `toText` flattens it.
    location: ['location'],
    tags: ['departments', 'offices'],
  },
  lever: {
    title: ['text'],
    // Lever has no company field — the board IS the company, and it is named in
    // the feed's own registration rather than per job.
    company: [],
    // hostedUrl is the posting. applyUrl is the application form, which is a
    // different page and a worse thing to hand a candidate.
    url: ['hostedUrl'],
    date: ['createdAt'],
    description: ['descriptionPlain', 'descriptionBodyPlain'],
    // Inside categories, alongside commitment and team.
    location: [],
    tags: ['categories'],
    salary: ['salaryRange'],
  },
  ashby: {
    title: ['title'],
    company: [],
    url: ['jobUrl', 'applyUrl'],
    date: ['publishedAt'],
    description: ['descriptionPlain'],
    // A plain string here, unlike Greenhouse's object.
    location: ['location'],
    tags: ['department', 'team', 'employmentType'],
    // A human-readable band: "€110K – €185K • Offers Equity".
    salary: ['compensation'],
  },
  remotive: {
    title: ['title'],
    company: ['company_name'],
    url: ['url'],
    date: ['publication_date'],
    description: ['description'],
    // Remotive puts the eligible territory in a field named for the candidate.
    location: ['candidate_required_location'],
    tags: ['tags', 'category'],
  },
  arbeitnow: {
    title: ['title'],
    company: ['company_name'],
    url: ['url'],
    // A Unix timestamp in seconds, not an ISO string. Recorded as seconds and
    // converted below; read as a string it is "1786516800", which is not a date
    // anything can order by.
    date: ['created_at'],
    dateIsEpoch: true,
    description: ['description'],
    location: ['location'],
    tags: ['tags', 'job_types'],
  },
  jobicy: {
    title: ['jobTitle'],
    company: ['companyName'],
    url: ['url'],
    date: ['pubDate'],
    description: ['jobDescription', 'jobExcerpt'],
    location: ['jobGeo'],
    tags: ['jobIndustry', 'jobType', 'jobLevel'],
  },
  himalayas: {
    title: ['title'],
    company: ['companyName'],
    // No `url` at all: the link lives in applicationLink, and guid duplicates it.
    // An adapter reading only `url` produces 20 items with no link, which is a
    // feed that reports full and yields nothing clickable.
    url: ['applicationLink', 'guid'],
    date: ['pubDate'],
    description: ['description', 'excerpt'],
    location: ['locationRestrictions'],
    tags: ['categories', 'employmentType', 'seniority'],
    // Himalayas publishes salary bands, which is worth carrying because it is
    // the one international source in this set that states a number.
    salary: ['minSalary', 'maxSalary', 'currency', 'salaryPeriod'],
  },
};

function firstOf(record, keys) {
  for (const k of keys) {
    const v = record?.[k];
    if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) return v;
  }
  return null;
}

/** Flatten whatever the location field is — a string, an object, or an array. */
function toText(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    const parts = v.map((x) => (typeof x === 'string' ? x : x?.name || x?.location || x?.title || '')).filter(Boolean);
    return parts.length ? parts.join(' / ') : null;
  }
  if (typeof v === 'object') return v.name || v.location || v.title || null;
  const s = String(v).trim();
  return s || null;
}

/**
 * Per-source fields the flat map cannot express.
 *
 * Lever keeps the location inside `categories` beside the commitment type and
 * the team, and its salary in a `{min,max,currency,interval}` object. Greenhouse
 * and Ashby both publish compensation too, in a form no adapter should try to
 * reduce to two numbers.
 *
 * So these are read explicitly, and the raw text is kept when the numbers are not
 * both present. A salary band reduced to nothing is a salary the board published
 * and this product threw away.
 */
function readSourceSpecific(record, feedId) {
  const out = {};

  if (feedId === 'lever') {
    const c = record?.categories;
    if (c && typeof c === 'object') {
      out.location = c.location || c.commitment || null;
      out.team = c.team || null;
      out.commitment = c.commitment || null;
    }
    const sr = record?.salaryRange;
    if (sr && typeof sr === 'object' && (sr.min != null || sr.max != null)) {
      out.salary = {
        min: sr.min ?? null,
        max: sr.max ?? null,
        currency: sr.currency || null,
        // "per-year-salary" is the board's word; kept verbatim rather than
        // mapped, because mapping it wrong turns a daily rate into an annual one.
        period: sr.interval || null,
        stated: true,
      };
    }
  }

  if (feedId === 'ashby') {
    const comp = record?.compensation;
    if (comp && typeof comp === 'object') {
      const summary = comp.compensationTierSummary || comp.summary || null;
      if (summary) {
        // The band as the employer wrote it, verbatim. Kept as text because the
        // structure varies per posting — a summary line, a tier table, a range —
        // and reducing it to min/max would drop the equity and bonus lines that
        // are the reason it is worth publishing.
        out.salary = { stated: true, min: null, max: null, currency: null, period: null, summary };
      }
    }
    if (record?.isRemote === true) out.arrangement = 'remote';
  }

  // Greenhouse is the one source that states the employer as a field, and it is
  // the reason the ATS boards are worth adding. The flag is what lets the board's
  // upsert prefer this row over an aggregator's copy of the same job, and it is
  // recorded on the row so a reader can see the employer was stated rather than
  // parsed.
  if (feedId === 'greenhouse' && record?.company_name) {
    out.companyFromField = true;
  }
  return out;
}

/**
 * Read a JSON job API.
 *
 * Returns the same `{ok, items, count, usable}` shape as `parseFeed` so
 * everything downstream — including `itemsToOpportunities` and
 * `validateOpportunity` — is shared rather than forked.
 */
export function parseJsonFeed(body, feed, { fetchedAt = null } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  let json;
  try {
    json = typeof body === 'string' ? JSON.parse(text) : body;
  } catch (e) {
    return { ok: false, state: 'unreadable', error: 'the response was not JSON: ' + String(e.message).slice(0, 60), items: [] };
  }

  // Where the array lives. `$` means the document is itself the array, which is
  // how RemoteOK and most single-purpose APIs are shaped.
  let arr = null;
  const path = feed?.jsonPath;
  if (path === '$' || path === null || path === undefined) {
    arr = Array.isArray(json) ? json : null;
  } else {
    const found = json?.[path];
    arr = Array.isArray(found) ? found : null;
  }
  // Fall back to the first array of objects anywhere at the top level, so a
  // board that renames its wrapper does not silently produce zero items.
  if (!arr && json && typeof json === 'object') {
    for (const v of Object.values(json)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') { arr = v; break; }
    }
  }
  if (!arr) {
    return {
      ok: false, state: 'no_items',
      error: 'no array of jobs in the response. top-level keys: '
        + (json && typeof json === 'object' ? Object.keys(json).slice(0, 8).join(', ') : typeof json),
      items: [],
    };
  }

  // The map is keyed on the *platform*, not on the feed's id.
  //
  // They were the same thing until the ATS boards arrived, and then they were
  // not: five different companies' boards all parse with one map each, so the ids
  // are `ats-greenhouse-gitlab`, `ats-greenhouse-stripe` and so on. Keying the
  // lookup on the id found no map for any of them, and every one of the 1,131
  // ATS postings parsed to a null title and a null link — counted as "seen" by
  // the poll, because 202 records came back, and written to the board as nothing.
  //
  // The failure was invisible in the feed health summary, which reports items
  // *fetched*. A board can be reachable, return two hundred records, and produce
  // zero usable jobs, and the count says 202 either way. `usable` is the number
  // that matters and it is now in the health report for exactly this reason.
  const sourceKey = feed?.source || feed?.id;
  const map = JSON_FIELD_MAPS[sourceKey] || null;
  if (!map && feed?.format === 'json') {
    return {
      ok: false, state: 'no_field_map',
      error: `no JSON field map for source "${sourceKey}". `
        + `known: ${Object.keys(JSON_FIELD_MAPS).join(', ')}`,
      items: [],
    };
  }

  const items = arr.map((record) => {
    // A record with neither a title nor a link is not a job. RemoteOK's legal
    // notice lands here and is dropped, rather than becoming a blank card.
    if (!record || typeof record !== 'object') return { usable: false, title: null, link: null };
    if (record.legal !== undefined && record.position === undefined && record.title === undefined) {
      return { usable: false, title: null, link: null, note: 'legal notice, not a job' };
    }

    const pick = (key) => (map ? firstOf(record, map[key] || []) : null);
    const specific = readSourceSpecific(record, sourceKey);

    const title = toText(pick('title'));
    let link = toText(pick('url'));
    // A board's company is the board, so a source with no company field — Lever
    // and Ashby publish none — takes the one its feed registration names.
    //
    // Flagged separately from a field because that is what it is. Lever did not
    // put "Dun & Bradstreet" in a `company` key; this product put it there, once,
    // by hand, in the registry. It is a stronger statement than a title parse and
    // a weaker one than a field the employer filled in, and recording all three
    // as `stated_as_field` would overstate the second of them — which is the one
    // claim on this board that has to be exactly true.
    const companyFromField = toText(pick('company'));
    const companyFromBoard = companyFromField ? null : (feed?.company || null);
    const company = companyFromField || companyFromBoard;
    const description = toText(pick('description')) || '';

    // A bare domain is a company homepage, not a posting. Arbeitnow does this
    // occasionally and so, presumably, do others. Dropped with a reason rather
    // than relabelled, because offering a candidate a company's front page as
    // "a job" wastes their time and teaches them the board is noisy.
    const isBareDomain = link && /^https?:\/\/[^/]+\/?$/.test(link.trim());
    if (isBareDomain) {
      return { usable: false, title, link, note: 'links to the employer homepage, not a posting' };
    }

    // Epoch seconds, or an ISO string, or nothing. parseFeedDate handles the
    // integer case and the unreadable case, so a bad value cannot become
    // "Invalid Date" on the way to the database.
    const published = parseFeedDate(toText(pick('date')), { fetchedAt });

    const tags = pick('tags');
    // Source-specific first: it read the field properly. The flat map is only
    // consulted when the specific reader found nothing.
    let salary = specific.salary || (map?.salary
      ? {
        min: firstOf(record, ['minSalary']),
        max: firstOf(record, ['maxSalary']),
        currency: firstOf(record, ['currency']),
        period: firstOf(record, ['salaryPeriod']),
      }
      : null);
    // A salary band with one end missing is not a salary. Nulled rather than
    // half-published, because "€110K – " reads as a figure and is not one.
    // `let`, not `const`: the first version declared this const and then assigned
    // to it, which is a SyntaxError at module load and took the whole Himalayas
    // feed down with a message about constants.
    if (salary && (salary.min === null || salary.max === null) && !salary.summary) salary = null;

    return {
      title,
      link,
      // These boards state the employer, so it is carried rather than left null
      // the way it is for RSS. Still never derived from the title.
      company,
      guid: link || (record.id !== undefined ? String(record.id) : null) || title,
      published,
      description: description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000),
      location: toText(pick('location')) || specific.location || null,
      tags: Array.isArray(tags) ? tags : (tags ? [String(tags)] : []),
      salary: salary && (salary.min !== null || salary.summary) ? salary : null,
      arrangementFromSource: specific.arrangement || null,
      companyFromBoard: companyFromBoard || null,
      usable: !!(title && link),
    };
  });

  return {
    ok: true,
    format: 'json',
    items,
    count: items.length,
    usable: items.filter((i) => i.usable).length,
    // Non-jobs that were seen and set aside, so a reader can tell "quiet feed"
    // apart from "feed full of records I could not read".
    setAside: items.filter((i) => !i.usable && i.note).length,
  };
}


export function feedSummary() {
  const live = FEEDS.filter((f) => !f.disabled);
  const byTrack = {};
  for (const f of live) byTrack[f.track] = (byTrack[f.track] || 0) + 1;
  return {
    // The headline number is the live one. `total` including 160 Craigslist
    // entries that all return 403 is a number that flatters the registry and
    // misleads anyone reading it.
    total: live.length,
    disabled: FEEDS.length - live.length,
    byTrack,
    json: live.filter((f) => f.format === 'json').length,
    regions: [...new Set(live.map((f) => f.region).filter(Boolean))],
    feeds: FEEDS.map((f) => ({
      id: f.id, name: f.name, url: f.url, track: f.track, kind: f.kind,
      format: f.format === 'json' ? 'json' : 'rss',
      region: f.region || null,
      disabled: f.disabled || null,
    })),
  };
}

export default {
  FEEDS, FEED_BY_ID, parseFeed, parseJsonFeed, readFeed,
  itemsToOpportunities, harvestFeed, feedSummary,
};
