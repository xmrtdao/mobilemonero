/**
 * relay/jobby/feed-board.mjs — poll the feeds into a shared board
 *
 * Reads every live feed, validates each link the same way a candidate's own
 * shortlist is validated, and writes the results to app.job_feed_items with the
 * provenance that lets any row be traced back to the document it came from.
 *
 * ── What this deliberately does not do ─────────────────────────────────────
 *
 * It does not create opportunities for candidates. Sourcing is a separate act
 * with a separate decision, and a candidate who wakes up to 2,000 auto-added
 * applications in their pipeline has been given work they did not choose. What
 * this does is make the board *available* — a candidate can ask for a feed, get
 * what is on it, and decide.
 *
 * It does not mark anything as verified. Every row is a third-party document.
 *
 * It does not delete. A job that leaves a feed leaves the board by ageing out of
 * the read window rather than by being destroyed, because a candidate may have an
 * application attached to it, and "the feed no longer lists it" is not the same
 * as "this job does not exist".
 */

import { urlKey } from './tools.mjs';
import { getPool } from './store.mjs';
import { FEEDS, harvestFeed, feedSummary } from './feeds.mjs';

/** How recent a row has to have been seen to be treated as still listed. */
const DEFAULT_MAX_AGE_HOURS = 72;

/**
 * One poll of every live feed.
 *
 * Bounded concurrency: 40 feeds at once is 40 simultaneous connections to other
 * people's servers, which gets the relay rate-limited and makes the results a
 * measurement of the harness rather than of the sources.
 */
export async function pollFeeds({
  limit = 100,
  concurrency = 4,
  timeout = 20000,
  only = null,
  includeDisabled = false,
  onProgress = null,
} = {}) {
  const pool = await getPool();
  const startedAt = new Date();

  const live = FEEDS.filter((f) => (includeDisabled || !f.disabled) && (!only || only.includes(f.id)));
  const disabledCount = FEEDS.length - live.length;

  // The run is recorded before any fetching, so a poll that dies halfway is
  // still visible as a poll that died halfway rather than never having happened.
  const { rows: runRows } = await pool.query(
    `INSERT INTO app.job_feed_runs (feeds_attempted) VALUES ($1) RETURNING id`,
    [live.length]);
  const runId = runRows[0].id;

  const results = [];
  let itemsSeen = 0;
  let itemsNew = 0;
  let duplicatesSeen = 0;

  for (let i = 0; i < live.length; i += concurrency) {
    const slice = live.slice(i, i + concurrency);
    const settled = await Promise.all(
      slice.map((f) => harvestFeed(f, { timeout, limit }).catch((e) => ({
        feedId: f.id, feedName: f.name, ok: false,
        error: String(e.message || e).slice(0, 120), opportunities: [],
      }))));

    for (const r of settled) {
      results.push({
        feedId: r.feedId, feedName: r.feedName, ok: !!r.ok,
        error: r.error || null, format: r.format || null,
        // Every count coerced. These are all sourced from another company's
        // document, and a non-numeric one poisons the totals that get written to
        // the run record.
        items: num(r.items), usable: num(r.usable),
        setAside: num(r.setAside), worthBuilding: num(r.worthBuilding),
        elapsedMs: num(r.elapsedMs),
      });
      if (!r.ok) continue;
      // Coerced, not trusted. `r.usable` comes from a fetch of somebody else's
      // document and `written.inserted` from a count of returned rows, and both
      // reach an integer column: a non-number arrives as "NaN" and aborts the
      // whole run UPDATE, losing the record of a poll that actually worked. A
      // count that cannot be read is zero, and zero is the honest reading.
      itemsSeen += Number.isFinite(Number(r.usable)) ? Number(r.usable) : 0;
      const written = await writeItems(pool, r, runId);
      itemsNew += Number.isFinite(Number(written.inserted)) ? Number(written.inserted) : 0;
      // Recorded rather than discarded: "this feed listed the same job twice" is
      // a fact about the source, and a rising count means a source is degrading.
      if (Number.isFinite(Number(written.duplicates))) duplicatesSeen += Number(written.duplicates);
    }
    if (onProgress) onProgress({ done: Math.min(i + concurrency, live.length), total: live.length });
  }

  const ok = results.filter((r) => r.ok).length;
  const finishedAt = new Date();

  await pool.query(
    `UPDATE app.job_feed_runs
        SET finished_at = $2, feeds_ok = $3, feeds_failed = $4,
            items_seen = $5, items_new = $6, results = $7, ok = true
      WHERE id = $1`,
    [runId, finishedAt, ok, results.length - ok, itemsSeen, itemsNew, JSON.stringify(results)]);

  return {
    runId,
    startedAt,
    finishedAt,
    elapsedMs: finishedAt - startedAt,
    feedsAttempted: live.length,
    feedsOk: ok,
    feedsFailed: results.length - ok,
    disabledSkipped: disabledCount,
    itemsSeen,
    itemsNew,
    // Same job listed twice by the same feed in one poll. A number, not a
    // failure, but a rising one means the source is getting worse.
    duplicatesSeen,
    results,
  };
}

/**
 * Write one feed's items.
 *
 * An upsert on (feed_id, guid), and a re-sighting bumps the counters rather than
 * inserting a second row. Without that, a feed that repeats an entry — or a poll
 * that runs twice — doubles the board, and a doubled board is a board nobody can
 * read.
 */
/**
 * A timestamp, or null.
 *
 * Feeds carry whatever their publisher's CMS emitted: RFC-822, ISO-8601, a Unix
 * integer as a string, and occasionally nothing usable at all. `new Date('...')`
 * on a malformed value returns an Invalid Date, and passing that to Postgres
 * produces "0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN" — which aborts the whole
 * batch, so one bad date in one feed out of thirty-nine stops the other
 * thirty-eight from being recorded.
 *
 * A date we cannot read is recorded as null. That is a gap in the record, and it
 * is the honest shape for it: a job with no readable date is a job whose age
 * nobody knows, not a job that is infinitely old.
 */
/** A count, or zero. Never NaN, never a string. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toTimestamp(value) {  if (value === null || value === undefined || value === '') return null;
  // A bare integer is epoch seconds or milliseconds.
  if (/^\d{9,14}$/.test(String(value).trim())) {
    const n = Number(String(value).trim());
    const d = n > 1e11 ? new Date(n) : new Date(n * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function writeItems(pool, harvest, runId) {
  const all = harvest.opportunities || [];
  if (!all.length) return 0;

  // Dedupe before the statement, not after — twice over.
  //
  // Within a feed: keyed on (feed_id, guid). Postgres refuses an ON CONFLICT DO
  // UPDATE that would touch the same conflicting row twice in one command, and
  // it refuses the whole batch. A feed listing the same item twice is not
  // hypothetical — RemoteFirstJobs re-lists entries across its category feeds.
  //
  // Across feeds: keyed on the posting's URL identity — see `urlKey` in tools.mjs,
  // which strips tracking parameters and nothing else. A syndicated job reaches
  // more than one board, and the unique index on `url_key` would otherwise reject
  // the batch outright rather than quietly keeping one, so the collision is
  // resolved here: the second sighting becomes a refresh of the first.
  const seenGuid = new Set();
  const seenUrl = new Set();
  const rows = [];
  let droppedInFeed = 0;
  let droppedAcrossFeeds = 0;

  for (const o of all) {
    const guid = o.source.guid || o.url || `${o.role}`;
    const gkey = `${o.source.feedId}::${guid}`;
    if (seenGuid.has(gkey)) { droppedInFeed++; continue; }
    seenGuid.add(gkey);

    const ukey = urlKey(o.url);
    if (ukey && seenUrl.has(ukey)) { droppedAcrossFeeds++; continue; }
    if (ukey) seenUrl.add(ukey);

    rows.push(o);
  }
  const dropped = droppedInFeed + droppedAcrossFeeds;

  let inserted = 0;
  // Batched, because 100 single-statement inserts is 100 round trips and the
  // whole point of the upsert is to make a poll cheap enough to run often.
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const params = [];
    // Built from the values rather than counted by hand. The first version
    // pushed sixteen values and generated twelve placeholders, which is a
    // statement Postgres rejects — and would have been a silent data loss had
    // the column order happened to line up. The column list and the value list
    // are now derived from one description, so they cannot drift.
    const value = (o) => [
      o.source.guid || o.url || `${o.role}`,
      o.source.feedId,
      o.source.feedName || null,
      o.role || null,
      o.company || null,
      o.url || null,
      (o.description || '').slice(0, 20000) || null,
      o.source.locationStated || null,
      o.source.arrangementStated || null,
      o.source.published ? toTimestamp(o.source.published) : null,
      o.source.companyProvenance || null,
      JSON.stringify(o.validation || {}),
      !!o.worthBuilding,
      o.source.trust || 'third_party_feed',
      o.source.guid || null,
      // The cross-source identity of the posting, computed by the one exported
      // function so the de-duplication above and the unique index below cannot
      // disagree about what "the same job" means.
      urlKey(o.url),
    ];
    // One list, used for both. The first version had fifteen column names, a
    // hard-coded ", updated_at" appended to the SQL, and fifteen values — so the
    // statement named sixteen targets and supplied fifteen, and Postgres
    // refused it. Deriving both from one array makes that class of mistake
    // impossible rather than merely unlikely.
    const COLUMNS = [
      'guid', 'feed_id', 'feed_name', 'role', 'company', 'url', 'description',
      'location_stated', 'arrangement_stated', 'published_at',
      'company_provenance', 'validation', 'worth_building', 'trust', 'raw_guid',
      'url_key', 'updated_at',
    ];
    const tuples = slice.map((o) => {
      const vals = [...value(o), 'now()'];
      const base = params.length;
      params.push(...value(o));
      return `(${vals.map((v, k) => (k === vals.length - 1 ? 'now()' : '$' + (base + k + 1))).join(', ')})`;
    });
    if (COLUMNS.length !== value(rows[0]).length + 1) {
      throw new Error(`writeItems: ${COLUMNS.length} columns but ${value(rows[0]).length + 1} values`);
    }

    // One conflict target: `url_key`.
    //
    // Postgres permits exactly one ON CONFLICT clause, so this cannot also name
    // (feed_id, guid) — a version that tried was rejected at parse time. It does
    // not need to. There is one job per URL by definition, and the URL index is
    // what collapses them, so a guid collision on a *different* URL is the only
    // remaining case and it is a data error worth having the database refuse. The
    // (feed_id, guid) index stays as that backstop.
    //
    // A stored column, not a SQL expression. The key used to be computed in two
    // places — here in JavaScript and again inside the index definition — and
    // nothing kept them equal, so they had already drifted: the JS version
    // dropped a trailing slash and the SQL version did not. One function, one
    // column, no second copy to keep in step.
    // How well-evidenced a sighting's employer is, as SQL, so the comparison
    // lives in the same statement that decides which row survives.
    //
    // Four levels, and a headline parse outranks nothing:
    //
    //   3  stated_as_field   the employer filled in a company field
    //   2  stated_by_board   the board *is* the company, named in the registry
    //   1  stated_in_title   read out of a headline, by a reader
    //   0  not_stated       no employer, and none guessed
    const rank = (side) => `CASE ${side}.company_provenance
        WHEN 'stated_as_field' THEN 3
        WHEN 'stated_by_board'  THEN 2
        WHEN 'not_stated'       THEN 0
        ELSE 1 END`;
    const better = `(${rank('EXCLUDED')} > ${rank('app.job_feed_items')})`;

    const res = await pool.query(
      `INSERT INTO app.job_feed_items (${COLUMNS.join(', ')})
       VALUES ${tuples.join(', ')}
       ON CONFLICT (url_key) WHERE url_key IS NOT NULL DO UPDATE SET
         last_seen_at = now(),
         seen_count = app.job_feed_items.seen_count + 1,
         -- The surviving row is the better-evidenced one. An employer's own board
         -- states the employer as a field; an aggregator's copy has it parsed out
         -- of a headline or not at all. When the new sighting is better evidenced
         -- it takes the row rather than being dropped, and the feed it came from
         -- travels with it, so the provenance still says where this was read from.
         --
         -- Ties keep the incumbent: two equally-evidenced rows have nothing to
         -- prefer between them, and swapping them would only move the seen_count.
         feed_id = CASE WHEN ${better} THEN EXCLUDED.feed_id ELSE app.job_feed_items.feed_id END,
         feed_name = CASE WHEN ${better} THEN EXCLUDED.feed_name ELSE app.job_feed_items.feed_name END,
         guid = CASE WHEN ${better} THEN EXCLUDED.guid ELSE app.job_feed_items.guid END,
         -- Never downgraded. A later sighting that parsed its employer out of a
         -- headline does not overwrite one the employer stated, and the rank above
         -- is what keeps these two clauses consistent with each other.
         company = CASE WHEN ${better} THEN EXCLUDED.company
                        ELSE COALESCE(EXCLUDED.company, app.job_feed_items.company) END,
         company_provenance = CASE WHEN ${better} THEN EXCLUDED.company_provenance
                                   ELSE app.job_feed_items.company_provenance END,
         role = EXCLUDED.role,
         description = EXCLUDED.description,
         location_stated = COALESCE(EXCLUDED.location_stated, app.job_feed_items.location_stated),
         arrangement_stated = COALESCE(EXCLUDED.arrangement_stated, app.job_feed_items.arrangement_stated),
         validation = EXCLUDED.validation,
         worth_building = EXCLUDED.worth_building,
         published_at = COALESCE(EXCLUDED.published_at, app.job_feed_items.published_at),
         updated_at = now()
       RETURNING (xmax = 0) AS was_insert`,
      params);
    inserted += res.rows.filter((r) => r.was_insert).length;
  }
  return { inserted, duplicates: dropped };
}

/**
 * The board, for a candidate to browse.
 *
 * `includeStale` is off by default, so what a candidate sees is what a feed is
 * currently listing. A job that dropped off a feed is not deleted, because an
 * application may be attached to it — it just stops being offered as new.
 */
export async function readBoard({
  limit = 50, offset = 0, feedId = null, company = null, q = null,
  worthBuildingOnly = false, remoteOnly = false, includeStale = false,
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
} = {}) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT id, feed_id, feed_name, role, company, url, location_stated,
            arrangement_stated, published_at, worth_building, trust,
            company_provenance, validation, first_seen_at, last_seen_at, seen_count
       FROM app.job_feed_items i
      WHERE ($1::boolean = true OR last_seen_at > now() - ($7::int || ' hours')::interval)
        AND ($2::text IS NULL OR feed_id = $2)
        AND ($3::text IS NULL OR lower(company) LIKE '%' || lower($3) || '%')
        AND ($4::text IS NULL OR lower(role) LIKE '%' || lower($4) || '%'
             OR lower(coalesce(company,'')) LIKE '%' || lower($4) || '%')
        AND ($5::boolean = false OR worth_building)
        AND ($6::boolean = false OR arrangement_stated = 'remote')
      -- Fair across sources, which the old published_at ordering was not.
      --
      -- 1,295 of 1,315 rows carry no publication date at all, so ordering by
      -- published_at DESC NULLS LAST put every dated row above every undated one,
      -- and the public jobs list opened on twenty rows from a single source. It
      -- read as "every job here is from Himalayas" -- which is exactly how it
      -- looked, and was an artefact of the ordering rather than anything about the
      -- jobs. The locations on those rows were correct throughout.
      --
      -- last_seen_at is when this product last read the posting. It is populated
      -- for every row, it cannot be supplied by a source that stamps the current
      -- instant onto everything it serves, and it does not privilege whichever
      -- sources happen to publish dates. It is an ordering by recency on *our*
      -- record, which is what a reader of a board wants and is honest about being
      -- that rather than a posting date.
      --
      -- published_at still breaks ties, so among equally-recent rows a genuine
      -- posting date still decides.
      --
      -- (No backticks in this comment: it lives inside a template literal, where
      -- one would end the string. The same mistake made this file fail to parse
      -- with a bare "missing ) after argument list".)
      -- Fair by construction, because all four obvious orderings are not.
      --
      -- 1. published_at DESC NULLS LAST. 1,295 of 1,315 rows carry no date, so
      --    every dated row outranked every undated one and the public list opened
      --    on twenty rows from whichever source published timestamps. Himalayas
      --    stamps its pubDate with the instant of the fetch, so it owned the top
      --    of the board permanently. It read as "every job here is from Himalayas".
      --    The locations on those rows were correct throughout -- the fault was
      --    never the location field.
      --
      -- 2. last_seen_at DESC, the obvious repair. Feeds poll with a concurrency
      --    of 4, so same-family feeds finish inside one second and their rows share
      --    a timestamp. The first 24 became 12 WWR DevOps, 7 WWR Product and 5 We
      --    Work Remotely: one publisher owning the whole first page, just a
      --    different one. Polling order deciding what a reader sees.
      --
      -- 3. seen_count DESC, the next repair. Looks like corroboration and is not:
      --    it counts how many times *this product* read the row, and
      --    RemoteFirstJobs cross-lists every job across all eleven of its category
      --    feeds, so one job scored 7. The first 24 became five RemoteFirstJobs
      --    feeds -- five sources, one publisher with eleven aliases.
      --
      -- So: a stable per-row interleave. The key is derived from the row id, so it
      -- is the same on every request and does not reshuffle when a reader asks for
      -- more, and it is uncorrelated with feed, date and poll order, so no
      -- publisher can own the front page by owning the newest timestamp or by
      -- cross-listing itself.
      --
      -- Stable, not random: random() would satisfy the fairness point and break
      -- pagination, reordering rows under the reader on every page load. A hash of
      -- the id is random-looking and fixed for the life of the row.
      --
      -- (No backticks in this comment: it lives inside a template literal, where
      -- one ends the string. That mistake has broken this file twice, both times
      -- with a bare "missing ) after argument list" pointing at line 1.)
      ORDER BY mod(abs(hashtext(i.id::text)), 1000003), i.id
      LIMIT $8 OFFSET $9`,
    [includeStale, feedId, company, q, worthBuildingOnly, remoteOnly,
      maxAgeHours, Math.min(Number(limit) || 50, 200), Math.max(Number(offset) || 0, 0)]);
  return rows;
}

export async function boardCount(opts = {}) {
  const pool = await getPool();
  // The same WHERE clause as readBoard, filter for filter.
  //
  // It used to honour only the age filter, so a page filtered to one source was
  // told the board held all 1,315 jobs while showing that source's 24. "24 shown of
  // 1315" reads as "there are 1,300 more you are not seeing" and is worse than no
  // number at all.
  //
  // Two queries that must agree, written as two queries, is the hazard here. The
  // clause is repeated rather than shared because a shared builder over a
  // parameterised count is more machinery than the risk is worth — but the two must
  // be edited together, and that is said rather than left to be discovered.
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE worth_building)::int AS worth,
            count(DISTINCT feed_id)::int AS feeds,
            count(DISTINCT company)::int AS companies
       FROM app.job_feed_items
      WHERE ($1::boolean = true OR last_seen_at > now() - ($7::int || ' hours')::interval)
        AND ($2::text IS NULL OR feed_id = $2)
        AND ($3::text IS NULL OR lower(company) LIKE '%' || lower($3) || '%')
        AND ($4::text IS NULL OR lower(role) LIKE '%' || lower($4) || '%'
             OR lower(coalesce(company,'')) LIKE '%' || lower($4) || '%')
        AND ($5::boolean = false OR worth_building)
        AND ($6::boolean = false OR arrangement_stated = 'remote')`,
    [!!opts.includeStale, opts.feedId ?? null, opts.company ?? null, opts.q ?? null,
      !!opts.worthBuildingOnly, !!opts.remoteOnly, opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS]);
  return rows[0] || { n: 0, worth: 0, feeds: 0, companies: 0 };
}

/** The last few polls, so "the board is empty" and "the poller is broken" differ. */
export async function recentRuns(limit = 5) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT id, started_at, finished_at, feeds_attempted, feeds_ok, feeds_failed,
            items_seen, items_new, ok
       FROM app.job_feed_runs ORDER BY id DESC LIMIT $1`,
    [Math.min(Number(limit) || 5, 20)]);
  return rows;
}

/**
 * What the last poll actually did, in one paragraph.
 *
 * Written because the number of rows on a board is not evidence that anything is
 * working, and a poller that has been failing for a week looks exactly like one
 * that has found nothing new.
 */
/**
 * What each feed actually contributed, and how much of it is evidenced.
 *
 * The board's flat list hides the thing a reader most needs: a source that names
 * the employer on every row and one that names it on none are not equally good,
 * and there is no way to see that from a list of links. These are the numbers
 * that decide whether to trust a row before clicking it.
 *
 * `employerStated` counts only rows where the employer arrived as a field or from
 * the board registration. Rows whose employer was read out of a posting title are
 * counted separately, because a company name produced by splitting a headline is a
 * reading of what somebody published rather than a fact anybody asserted — and the
 * page has to be able to say which is which per row.
 */
export async function boardBySource() {
  // `getPool`, because that is what this module imports. It has no `db` helper of
  // its own, and reaching for one is a ReferenceError at request time rather than
  // at load time — so it passed every syntax check and 500'd the endpoint.
  const pool = await getPool();
  const { rows } = await pool.query(`
    SELECT feed_id,
           feed_name,
           count(*)::int AS jobs,
           count(*) FILTER (WHERE company IS NOT NULL)::int AS with_company,
           count(*) FILTER (WHERE company_provenance IN ('stated_as_field', 'stated_by_board'))::int AS employer_stated,
           count(*) FILTER (WHERE company_provenance LIKE 'stated_in_title%')::int AS employer_from_title,
           count(*) FILTER (WHERE company IS NULL)::int AS employer_not_stated,
           count(*) FILTER (WHERE location_stated IS NOT NULL)::int AS location_stated,
           count(*) FILTER (WHERE worth_building)::int AS worth_building
      FROM app.job_feed_items
     GROUP BY feed_id, feed_name
     ORDER BY count(*) DESC, feed_name`);
  return rows;
}

export async function boardHealth() {
  const [count, runs, summary] = await Promise.all([boardCount(), recentRuns(3), Promise.resolve(feedSummary())]);
  const last = runs[0] || null;
  const problems = [];

  if (!last) problems.push('The board has never been polled.');
  else if (!last.ok) problems.push('The last poll did not finish.');
  else if (last.feeds_failed > 0) {
    problems.push(`${last.feeds_failed} of ${last.feeds_attempted} feeds failed on the last poll.`);
  }
  if (summary.disabled > 0) {
    problems.push(`${summary.disabled} feeds in the registry are disabled, including 160 Craigslist `
      + 'entries that return 403 to any client.');
  }
  if (count.n === 0 && last?.ok) problems.push('The last poll succeeded and found nothing, which is different from failing.');

  return {
    count,
    lastRun: last,
    registry: { total: summary.total, disabled: summary.disabled, json: summary.json, regions: summary.regions },
    problems,
    // Stated either way. "Healthy" on a board with four broken feeds is a word
    // that has stopped meaning anything.
    ok: problems.length === 0,
  };
}

export default {
  pollFeeds, readBoard, boardCount, recentRuns, boardHealth, boardBySource,
  DEFAULT_MAX_AGE_HOURS,
};
