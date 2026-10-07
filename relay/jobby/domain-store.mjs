/**
 * Postgres access for the domain-opportunities scanner.
 *
 * Pool discipline, from `cron-engine-v2.mjs`: call `getSharedPool()` inside each
 * function. Do NOT capture it at module load. `lib/db.mjs` replaces its own
 * pool reference after three consecutive failed health checks, so a module that
 * grabbed the pool at import time keeps querying a dead one forever - and the
 * symptom is a hang, not an error.
 *
 * There is no client_id on any function here, and that is deliberate. See
 * `jobby_007_domain_ops.sql`: the domain pool is global. A domain's real state
 * does not depend on who is looking at it, and two candidates scanning the same
 * keyword should not each pay for the same HTTP request.
 */

import { getPool as getSharedPool } from '../lib/db.mjs';

async function db() {
  return getSharedPool();
}

/**
 * Create the tables if they are not there.
 *
 * The relay's house pattern is `CREATE TABLE IF NOT EXISTS` inside the module
 * that uses them (`lib/pfp-campaign-log.mjs`, `lib/pfp-lead-stages.mjs`), with
 * `migrations/` holding the commented reference copy. This mirrors that, so the
 * daemon can come up against a fresh database without a separate apply step -
 * the failure mode being prevented is a daemon that crash-loops on a missing
 * table while the supervisor restarts it four times an hour and nobody notices.
 */
export async function ensureDomainTables() {
  const p = await db();
  await p.query(`
    CREATE TABLE IF NOT EXISTS app.job_domain_candidates (
      id          bigserial PRIMARY KEY,
      domain      text NOT NULL,
      keyword     text,
      tld         text,
      dns_state   text NOT NULL DEFAULT 'unknown',
      http_state  text NOT NULL DEFAULT 'unknown',
      http_status integer,
      page_title  text,
      final_url   text,
      signature   text,
      contact_email text,
      contact_source text,
      contact_evidence jsonb,
      score       integer,
      score_reason text,
      verdict     text,
      scored_at   timestamptz,
      scored_by   text,
      evidence    jsonb,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT scored_has_reason CHECK (score IS NULL OR score_reason IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS job_domain_candidates_one_per_domain
      ON app.job_domain_candidates (domain);
    CREATE INDEX IF NOT EXISTS job_domain_candidates_scored
      ON app.job_domain_candidates (score DESC NULLS LAST, last_seen_at DESC)
      WHERE score IS NOT NULL;

    CREATE TABLE IF NOT EXISTS app.job_suppressions (
      id         bigserial PRIMARY KEY,
      email      text NOT NULL,
      reason     text NOT NULL,
      detail     text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS job_suppressions_one_per_email
      ON app.job_suppressions (lower(email));

    CREATE TABLE IF NOT EXISTS app.job_domain_runs (
      id          bigserial PRIMARY KEY,
      keywords    text[],
      requested   integer NOT NULL DEFAULT 0,
      checked     integer NOT NULL DEFAULT 0,
      found       integer NOT NULL DEFAULT 0,
      scored      integer NOT NULL DEFAULT 0,
      contacted   integer NOT NULL DEFAULT 0,
      stopped_reason text,
      duration_ms integer,
      started_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    );
  `);
  return true;
}

/**
 * Record what a scan found.
 *
 * Upsert on `domain`, which is the table's unique key, so rescanning a domain
 * refreshes its state instead of stacking duplicates. The score is NOT
 * overwritten here when the new row has none - a rescan that could not reach the
 * site must not erase a score earned by an earlier run that could. That is the
 * whole point of keeping `first_seen_at`.
 */
export async function recordCandidate(row) {
  const p = await db();
  const { rows } = await p.query(
    `INSERT INTO app.job_domain_candidates
       (domain, keyword, tld, dns_state, http_state, http_status, page_title,
        final_url, signature, contact_email, contact_source, contact_evidence,
        evidence, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (domain) DO UPDATE SET
       keyword            = COALESCE(EXCLUDED.keyword, job_domain_candidates.keyword),
       tld                = COALESCE(EXCLUDED.tld, job_domain_candidates.tld),
       dns_state          = EXCLUDED.dns_state,
       http_state         = EXCLUDED.http_state,
       http_status        = EXCLUDED.http_status,
       page_title         = EXCLUDED.page_title,
       final_url          = EXCLUDED.final_url,
       signature          = EXCLUDED.signature,
       -- Only replace a contact when we found one. A later run that failed to
       -- read the page has not proven the address is gone, and silently nulling
       -- a known contact would be reporting a gap that is not one.
       contact_email      = COALESCE(EXCLUDED.contact_email, job_domain_candidates.contact_email),
       contact_source     = COALESCE(EXCLUDED.contact_source, job_domain_candidates.contact_source),
       contact_evidence   = COALESCE(EXCLUDED.contact_evidence, job_domain_candidates.contact_evidence),
       evidence           = EXCLUDED.evidence,
       last_seen_at       = now()
     RETURNING id, domain, score, verdict`,
    [
      row.domain, row.keyword || null, row.tld || null,
      row.dns_state || 'unknown', row.http_state || 'unknown',
      row.http_status ?? null, row.page_title || null, row.final_url || null,
      row.signature || null, row.contact_email || null,
      row.contact_source || null,
      row.contact_evidence ? JSON.stringify(row.contact_evidence) : null,
      row.evidence ? JSON.stringify(row.evidence) : null,
    ]
  );
  return rows[0];
}

/** Attach a model score to a domain, with the reason and which model gave it. */
export async function recordScore(id, { score, reason, verdict, model }) {
  const p = await db();
  const { rows } = await p.query(
    `UPDATE app.job_domain_candidates
        SET score = $2, score_reason = $3, verdict = $4,
            scored_at = now(), scored_by = $5
      WHERE id = $1
      RETURNING id, domain, score, score_reason, verdict, scored_by`,
    [id, score, reason, verdict, model || null]
  );
  return rows[0] || null;
}

/**
 * The board query.
 *
 * Scored rows first, best first. `min_score` exists so the UI is not showing the
 * candidate a wall of near-zero rows on the first load - but the default board
 * deliberately does NOT hide unscored ones, because "we looked and did not
 * score this" is a state a reader should be able to see.
 */
export async function readBoard({ limit = 50, offset = 0, minScore = null, keyword = null } = {}) {
  const p = await db();
  const params = [Math.min(Number(limit) || 50, 200), Math.max(Number(offset) || 0, 0)];
  const where = [];
  if (minScore !== null && minScore !== undefined && minScore !== '') {
    params.push(Number(minScore));
    where.push(`score >= $${params.length}`);
  }
  if (keyword) {
    params.push(String(keyword).toLowerCase());
    where.push(`lower(keyword) = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await p.query(
    `SELECT id, domain, keyword, tld, dns_state, http_state, http_status,
            page_title, final_url, signature, contact_email, contact_source,
            score, score_reason, verdict, scored_at, scored_by,
            last_seen_at,
            -- Whether this address may ever be emailed. Checked on READ as well
            -- as on send, so a suppressed address is never rendered as an
            -- actionable opportunity in the first place.
            (contact_email IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM app.job_suppressions s
                WHERE lower(s.email) = lower(job_domain_candidates.contact_email)
            )) AS contactable
       FROM app.job_domain_candidates
       ${clause}
      ORDER BY score DESC NULLS LAST, last_seen_at DESC
      LIMIT $1 OFFSET $2`,
    params
  );
  return rows;
}

export async function boardCount({ minScore = null } = {}) {
  const p = await db();
  const params = [];
  let clause = '';
  if (minScore !== null && minScore !== undefined && minScore !== '') {
    params.push(Number(minScore));
    clause = `WHERE score >= $1`;
  }
  const { rows } = await p.query(
    `SELECT count(*)::int AS n FROM app.job_domain_candidates ${clause}`, params);
  return rows[0]?.n || 0;
}

/**
 * Count the outcomes.
 *
 * `contactable` is separated from `parked` deliberately. Parked domains are
 * cheap to check and numerous; almost none of them have an owner address in
 * them. A summary that reported "40 domains found" without saying "0 of them can
 * be contacted" would read as a working feature.
 */
export async function boardHealth() {
  const p = await db();
  const { rows } = await p.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE http_state = 'parked')::int AS parked,
           count(*) FILTER (WHERE http_state = 'live_weak')::int AS live_weak,
           count(*) FILTER (WHERE http_state = 'live_strong')::int AS live_strong,
           count(*) FILTER (WHERE http_state = 'blocked')::int AS blocked,
           count(*) FILTER (WHERE http_state = 'unreachable')::int AS unreachable,
           count(contact_email)::int AS with_contact,
           count(*) FILTER (WHERE score IS NOT NULL)::int AS scored,
           max(last_seen_at) AS last_scan
      FROM app.job_domain_candidates`);
  const row = rows[0] || {};
  const total = row.total || 0;
  return {
    ...row,
    // The honest headline number.
    contactable_pct: total ? Math.round(((row.with_contact || 0) / total) * 100) : 0,
  };
}

export async function recentRuns(limit = 10) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, keywords, requested, checked, found, scored, contacted,
            stopped_reason, duration_ms, started_at, finished_at
       FROM app.job_domain_runs ORDER BY started_at DESC LIMIT $1`,
    [Math.min(Number(limit) || 10, 50)]
  );
  return rows;
}

export async function startRun(keywords) {
  const p = await db();
  const { rows } = await p.query(
    `INSERT INTO app.job_domain_runs (keywords, requested)
     VALUES ($1, $2) RETURNING id`,
    [keywords, keywords.length]
  );
  return rows[0].id;
}

export async function finishRun(id, { checked, found, scored, contacted, stoppedReason, durationMs }) {
  const p = await db();
  await p.query(
    `UPDATE app.job_domain_runs
        SET checked = $2, found = $3, scored = $4, contacted = $5,
            stopped_reason = $6, duration_ms = $7, finished_at = now()
      WHERE id = $1`,
    [id, checked || 0, found || 0, scored || 0, contacted || 0,
     stoppedReason || null, durationMs ?? null]
  );
}

/**
 * Is this address suppressed?
 *
 * Nothing sends in phase 1, so this is not on a send path yet. It is here
 * because a suppression check retrofitted at the moment it is first needed is a
 * suppression check nobody tested. `jobby_send` consults no suppression list
 * today; its only consent-shaped gate, `passesDisclosure`, is a bot-disclosure
 * rule rather than an opt-out.
 */
export async function isSuppressed(email) {
  if (!email) return false;
  const p = await db();
  const { rows } = await p.query(
    `SELECT 1 FROM app.job_suppressions WHERE lower(email) = lower($1) LIMIT 1`,
    [String(email)]
  );
  return rows.length > 0;
}

export async function addSuppression({ email, reason, detail }) {
  const p = await db();
  const { rows } = await p.query(
    `INSERT INTO app.job_suppressions (email, reason, detail)
     VALUES ($1, $2, $3)
     ON CONFLICT (lower(email)) DO UPDATE SET reason = EXCLUDED.reason
     RETURNING id, email, reason, created_at`,
    [String(email).toLowerCase(), reason || 'owner_request', detail || null]
  );
  return rows[0];
}

export async function listSuppressions(limit = 100) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, email, reason, detail, created_at
       FROM app.job_suppressions ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Number(limit) || 100, 500)]
  );
  return rows;
}

/** Domains whose last scan produced a contact, i.e. worth scoring first. */
export async function unscoredContactable(limit = 20) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, domain, keyword, http_state, signature, page_title,
            contact_email, contact_source, evidence
       FROM app.job_domain_candidates
      WHERE score IS NULL AND contact_email IS NOT NULL
      ORDER BY last_seen_at DESC
      LIMIT $1`,
    [Math.min(Number(limit) || 20, 100)]
  );
  return rows;
}
