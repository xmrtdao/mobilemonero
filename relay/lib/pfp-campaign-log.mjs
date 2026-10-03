/**
 * relay/lib/pfp-campaign-log.mjs — who has been contacted, when, and how it went.
 *
 * WHY THIS IS A TABLE
 * -------------------
 * The campaign was tracking contact in `campaign-contacts.json`, a field called
 * `sentCount` on each record, and a `campaign-sent.json` that has never existed.
 * So the system could not answer "have we emailed this person?" or "what did we
 * send them last week?" — the two questions a campaign exists to answer. Emails
 * were going out and arriving, and the record of that was a counter on a JSON
 * blob last modified 2026-08-31.
 *
 * Three concrete failures this fixes:
 *
 *   1. De-duplication could not work across restarts. `sentCount` is written
 *      nowhere in the send path, so it stayed at its loaded value forever.
 *   2. `suppression-list.json` did not exist, so an unsubscribe or a "stop" had
 *      nowhere to live. On a cold-outreach list that is how a sending domain
 *      earns a spam reputation, which is the thing that actually threatens the
 *      business.
 *   3. `totalSent` read 0 while 50+ emails had gone out. A counter that reports
 *      zero events next to real events is worse than no counter, because it
 *      looks like a fact.
 *
 * WHY NOT KEEP USING THE JSON FILES
 * ---------------------------------
 * `daily-campaign.mjs` runs six times a day and appends on every success. That
 * is a read-modify-write of a multi-megabyte file per send, with no lock beyond
 * a file whose existence is checked but whose writes were failing. Rows in a
 * table are append-only and concurrent-safe.
 *
 * WHAT IS NOT CHANGED
 * -------------------
 * The send path, the schedule, the copy, the recipient selection and the contact
 * pool are all untouched. This records what already happens. Nothing here can
 * stop an email going out.
 */

import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'fs';

/** Schema, applied idempotently on first use. */
export async function ensureCampaignSchema(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS public.pfp_campaign_sends (
      id            bigserial PRIMARY KEY,
      email         text NOT NULL,
      contact_name  text,
      source_code   text,
      query_text    text,
      region        text,
      subject       text,
      resend_id     text,
      status        text NOT NULL DEFAULT 'sent',
      detail        text,
      campaign      text NOT NULL DEFAULT 'daily',
      sent_at       timestamptz NOT NULL DEFAULT NOW()
    )`);

  await query(`
    CREATE TABLE IF NOT EXISTS public.pfp_campaign_suppressions (
      id         bigserial PRIMARY KEY,
      email      text NOT NULL UNIQUE,
      reason     text NOT NULL,
      detail     text,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )`);

  // De-duplication reads this constantly; an index on email makes it a lookup
  // rather than a scan over a growing table.
  await query(
    `CREATE INDEX IF NOT EXISTS pfp_campaign_sends_email_idx
       ON public.pfp_campaign_sends (lower(email))`);
  await query(
    `CREATE INDEX IF NOT EXISTS pfp_campaign_sends_sent_at_idx
       ON public.pfp_campaign_sends (sent_at DESC)`);
}

/**
 * Record one send. Never throws.
 *
 * A bookkeeping failure must not stop the next email. Resend has already
 * accepted it by this point; losing the row is a smaller harm than aborting a
 * batch mid-flight, so a failure is reported and swallowed.
 */
export async function recordSend(query, log, entry) {
  try {
    await query(
      `INSERT INTO public.pfp_campaign_sends
         (email, contact_name, source_code, query_text, region, subject, resend_id, status, detail, campaign)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        String(entry.email || '').toLowerCase().trim(),
        entry.name ?? null,
        entry.source ?? null,
        entry.query ?? null,
        entry.region ?? null,
        entry.subject ?? null,
        entry.resend_id ?? null,
        entry.status || 'sent',
        entry.detail ?? null,
        entry.campaign || 'daily',
      ]
    );
  } catch (e) {
    log?.(`campaign-log: could not record send for ${entry.email}: ${e.message}`);
  }
}

/** Record a failure. Same never-throws contract, for the same reason. */
export async function recordFailure(query, log, entry) {
  return recordSend(query, log, { ...entry, status: 'error' });
}

/** Emails that must never be emailed again. */
export async function loadSuppression(query) {
  try {
    const { rows } = await query(
      `SELECT email FROM public.pfp_campaign_suppressions ORDER BY email`);
    return new Set(rows.map((r) => String(r.email).toLowerCase().trim()));
  } catch {
    return new Set();
  }
}

/** Add someone to the suppression list. Idempotent. */
export async function suppress(query, log, email, reason, detail) {
  try {
    await query(
      `INSERT INTO public.pfp_campaign_suppressions (email, reason, detail)
       VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING`,
      [String(email || '').toLowerCase().trim(), reason, detail ?? null]
    );
    return true;
  } catch (e) {
    log?.(`campaign-log: could not suppress ${email}: ${e.message}`);
    return false;
  }
}

/**
 * Has this address been emailed inside `days`?
 *
 * The de-duplication check, backed by the table instead of a field nobody wrote.
 */
export async function recentlySent(query, log, email, days = 30) {
  try {
    const { rows } = await query(
      `SELECT 1 FROM public.pfp_campaign_sends
        WHERE lower(email) = $1 AND sent_at > NOW() - ($2 || ' days')::interval
        LIMIT 1`,
      [String(email || '').toLowerCase().trim(), String(days)]
    );
    return rows.length > 0;
  } catch (e) {
    log?.(`campaign-log: de-dup check failed for ${email}: ${e.message}`);
    // Fail OPEN. A failed lookup must not silently drop a contact from the
    // campaign, and the caller still has the legacy sentCount sort as a backstop.
    return false;
  }
}

/**
 * What the relay dashboard's campaign tile shows.
 *
 * Reads only. Every number here is computed from pfp_campaign_sends, so the tile
 * cannot disagree with the table the sends actually wrote to.
 */
export async function campaignStats(query, days = 7) {
  const totals = await query(`
    SELECT
      count(*)::int                                          AS total,
      count(*) FILTER (WHERE status = 'sent')::int           AS sent,
      count(*) FILTER (WHERE status = 'error')::int          AS errors,
      count(DISTINCT lower(email))::int                      AS unique_recipients,
      max(sent_at)                                           AS last_send_at
    FROM public.pfp_campaign_sends
    WHERE sent_at > NOW() - ($1 || ' days')::interval`, [String(days)]);

  const byDay = await query(`
    SELECT date_trunc('day', sent_at)::date AS day,
           count(*)::int                    AS sends,
           count(DISTINCT lower(email))::int AS unique_recipients
      FROM public.pfp_campaign_sends
     WHERE sent_at > NOW() - ($1 || ' days')::interval
     GROUP BY 1 ORDER BY 1`, [String(days)]);

  const topSources = await query(`
    SELECT source_code, count(*)::int AS sends, count(DISTINCT lower(email))::int AS recipients
      FROM public.pfp_campaign_sends
     WHERE sent_at > NOW() - ($1 || ' days')::interval AND source_code IS NOT NULL
     GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [String(days)]);

  const suppressed = await query(
    `SELECT count(*)::int AS n FROM public.pfp_campaign_suppressions`);

  // The number that matters most and had no home at all.
  const repeatRisk = await query(`
    SELECT count(*)::int AS n FROM (
      SELECT lower(email) FROM public.pfp_campaign_sends
       GROUP BY 1 HAVING count(*) > 1
    ) t`);

  const t = totals.rows[0] || {};
  return {
    window_days: Number(days),
    sends: t.total ?? 0,
    delivered_to_resend: t.sent ?? 0,
    errors: t.errors ?? 0,
    unique_recipients: t.unique_recipients ?? 0,
    suppressed_total: suppressed.rows[0]?.n ?? 0,
    addresses_sent_more_than_once: repeatRisk.rows[0]?.n ?? 0,
    last_send_at: t.last_send_at ?? null,
    by_day: byDay.rows.map((r) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
      sends: r.sends,
      unique_recipients: r.unique_recipients,
    })),
    top_sources: topSources.rows.map((r) => ({
      source_code: r.source_code,
      sends: r.sends,
      recipients: r.recipients,
    })),
  };
}

/**
 * Mirror the send count back onto the contact records, so the existing
 * `sort by sentCount` selection keeps working.
 *
 * This is the compatibility shim: daily-campaign.mjs picks its batch by
 * `(a.sentCount || 0)`, and that field has never been written. Rewriting the
 * 2.7 MB pool on every send would be worse than updating it once per batch,
 * which is what the caller does after it finishes.
 */
export function applySentCounts(contacts, query) {
  return (async () => {
    try {
      const { rows } = await query(
        `SELECT lower(email) AS email, count(*)::int AS n
           FROM public.pfp_campaign_sends
          WHERE status = 'sent' GROUP BY 1`);
      const counts = new Map(rows.map((r) => [r.email, r.n]));
      let touched = 0;
      for (const c of contacts) {
        if (!c || !c.email) continue;
        const n = counts.get(String(c.email).toLowerCase().trim());
        if (n !== undefined && c.sentCount !== n) { c.sentCount = n; touched++; }
      }
      return touched;
    } catch {
      return 0;
    }
  })();
}

export default {
  ensureCampaignSchema, recordSend, recordFailure, loadSuppression,
  suppress, recentlySent, campaignStats, applySentCounts,
};