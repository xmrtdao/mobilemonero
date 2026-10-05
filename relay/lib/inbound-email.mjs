/**
 * relay/lib/inbound-email.mjs — capturing inbound Resend mail into the database.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `server.js` is in .gitignore (line 34). Every fix for the "agents cannot read
 * inbound email" failure lived in that file and therefore existed only on one
 * machine's disk. This module is the substance, extracted so it can be versioned,
 * reviewed and tested. `server.js` keeps the wiring and calls in here.
 *
 * WHAT WAS ACTUALLY BROKEN
 * ------------------------
 * Four defects, in the order they bit:
 *
 *  1. The boot sync tested `Array.isArray()` on the response of
 *     GET /emails/receiving, which returns an ENVELOPE:
 *         { "object": "list", "has_more": true, "data": [ ... ] }
 *     Always false. The branch never ran, so the sync did nothing on every boot,
 *     for every domain, silently. app.inbox_emails stayed at 0 rows, and an empty
 *     table is indistinguishable from a quiet mailbox — which is why this survived
 *     long enough to be reported as "the last email was in September".
 *
 *  2. Nothing persisted. addToInbox() pushes onto an in-memory array that dies
 *     with the process. The table created expressly so mail would survive a
 *     restart had no writer.
 *
 *  3. Wrong API key. The sync fetched every row with one shared key. A Resend key
 *     is scoped to ONE domain and returns 404 for another domain's inbound id —
 *     and a 404 is indistinguishable from expiry. Twelve 31harbor messages were
 *     written off as "gone" on exactly that signal; re-tested with the matching
 *     key, all twelve returned 200.
 *
 *  4. One chance to run. The sync fired once at boot. Three of four webhooks
 *     point at infrastructure this relay does not control, so for those domains
 *     the boot pass was the only ingest path. Mail arriving afterwards waited for
 *     the next restart.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No database handle, no HTTP server, no process state. Everything arrives as an
 * argument, so this file can be tested without a relay running. `queryLocalPg`
 * and `EMAIL_DOMAINS` are injected by the caller.
 */

/**
 * How long to keep trying to fetch a body.
 *
 * Resend's documented figure, from
 * https://resend.com/docs/knowledge-base/resend-email-quota:
 *   "Resend retains email data for 30 days across all plans (Free, Pro, and
 *    Scale). This includes: email content and metadata, delivery status and
 *    events, logs and metrics."
 *
 * The same page answers the question this module exists for: "If you need access
 * to historical email data beyond the 30-day retention window, consider storing
 * webhook events in your own database."
 *
 * This was 3 days once, on the strength of twelve 404s. Those 404s were defect 3
 * above — a wrong key, not expiry — and the number was written down as if it were
 * a provider limit. 28 leaves a margin inside the documented 30 so a message that
 * arrives on the last day is still fetchable on the next pass.
 */
export const INBOUND_BODY_RETENTION_DAYS = 28;

/**
 * Maximum body fetches per domain per pass.
 *
 * A backlog of unreadable rows would otherwise turn one pass into hundreds of
 * requests against the provider this relay also sends transactional mail through.
 * 25 is roughly half a page of the listing, so steady state never approaches it.
 * This bounds the pathological case; it is not a throttle on normal operation.
 * Rows are retried on later passes until they succeed or fall outside the window.
 */
export const INBOUND_BODY_FETCH_CAP = 25;

/**
 * Fetch one inbound message's body by id.
 *
 * Endpoints, as measured against the live API:
 *   GET /emails/receiving        -> envelope, metadata only, NO body
 *   GET /emails/receiving/{id}   -> 200, full text + html
 *   GET /emails/{id}             -> 404, always
 *
 * So the per-id receiving path is the only route to a body. Per Resend: "Webhooks
 * do not include the email body, headers, or attachments, only their metadata."
 *
 * Returns `{fetched, text, html, ...}` and never throws. `fetched:false` with a
 * reason is a normal outcome and callers treat the reasons differently: one writes
 * a body, another records that it could not be had.
 *
 * A 404 is reported as 'wrong-key-or-expired' rather than 'expired' on purpose. A
 * key scoped to a different domain 404s identically to a message past retention,
 * and naming it "expired" is how defect 3 above became invisible for as long as
 * it did. The reason is recorded either way; the wording does not assert more
 * than the evidence supports.
 *
 * @param {string} emailId
 * @param {string} apiKey  the key scoped to THIS domain, never a shared one
 */
export async function fetchInboundBody(emailId, apiKey) {
  if (!emailId) return { fetched: false, reason: 'no-id' };
  if (!apiKey) return { fetched: false, reason: 'no-api-key' };

  try {
    const res = await fetch(
      `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (res.status === 404) return { fetched: false, reason: 'wrong-key-or-expired' };
    if (res.status === 429) return { fetched: false, reason: 'rate-limited' };
    if (!res.ok) return { fetched: false, reason: `http-${res.status}` };

    const e = await res.json();
    const text = typeof e.text === 'string' && e.text.length ? e.text : null;
    const html = typeof e.html === 'string' && e.html.length ? e.html : null;

    // A 200 carrying neither field is a body we could not obtain. That is a
    // different fact from a 404 and must not be recorded as unavailable.
    if (!text && !html) return { fetched: false, reason: 'empty-body' };

    return {
      fetched: true,
      text,
      html,
      reason: null,
      subject: e.subject || null,
      createdAt: e.created_at || null,
      messageId: e.message_id || null,
      /**
       * SPF/DKIM/DMARC computed by the receiving mail server, so a sender cannot
       * forge it — the only sender-identity signal in the system that is not
       * self-asserted. Null for mail received before Resend added the field.
       */
      authentication: e.authentication || null,
      attachmentCount: Array.isArray(e.attachments) ? e.attachments.length : 0,
      /**
       * Signed URL to the original message including attachments. It expires about
       * an hour after issue, so it is deliberately NOT returned for storage — a
       * stored URL is a stored broken link that looks retrievable.
       */
      rawExpiresAt: e.raw?.expires_at || null,
    };
  } catch (err) {
    // Network blips and timeouts are retryable: the row keeps body_text NULL and
    // is attempted again on the next pass.
    return { fetched: false, reason: err.message || 'network-error' };
  }
}

/**
 * Persist one inbound email — body and all — keyed by its Resend email_id.
 *
 * One writer, used by both the webhook (immediately on delivery) and the periodic
 * sync (to backfill what the webhook missed), so "stored" has a single meaning.
 *
 * ON CONFLICT DO UPDATE, not DO NOTHING: the webhook is the more complete source
 * — it arrives with a verified signature and a known domain — so it should be able
 * to complete a row the sync only half-filled. COALESCE means the source that
 * actually has the body cannot be blanked by one that does not.
 *
 * `domain` is the REGISTRY KEY, never the bare domain. Every reader groups by the
 * key, and the two conventions once split one PFP mailbox across two labels, so
 * `GROUP BY domain` reported 52 rows for one inbox. The readable domain is kept
 * alongside in metadata.domain_name.
 */
export async function persistInboundEmail({ query, ...row }) {
  const {
    email_id, sender, recipient, subject,
    text, html, received_at, domain, metadata,
  } = row;

  if (!query) throw new Error('persistInboundEmail requires a query function');

  const res = await query(
    `INSERT INTO app.inbox_emails
       (email_id, sender, recipient, subject, body_text, body_html, received_at, read, domain, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (email_id) DO UPDATE SET
       body_text  = COALESCE(EXCLUDED.body_text, app.inbox_emails.body_text),
       body_html  = COALESCE(EXCLUDED.body_html, app.inbox_emails.body_html),
       subject    = COALESCE(NULLIF(EXCLUDED.subject,''),   app.inbox_emails.subject),
       sender     = COALESCE(NULLIF(EXCLUDED.sender,''),    app.inbox_emails.sender),
       recipient  = COALESCE(NULLIF(EXCLUDED.recipient,''), app.inbox_emails.recipient),
       domain     = COALESCE(app.inbox_emails.domain, EXCLUDED.domain),
       metadata   = COALESCE(app.inbox_emails.metadata,'{}'::jsonb)
                    || COALESCE(EXCLUDED.metadata,'{}'::jsonb)
     RETURNING id`,
    [
      email_id,
      sender || '',
      recipient || '',
      subject || '',
      // null, never '' — an empty string asserts "an email with no content",
      // which is a different and wrong fact from "no body captured yet".
      text || null,
      html || null,
      received_at || new Date().toISOString(),
      false,
      domain,
      JSON.stringify(metadata || {}),
    ]
  );
  return res.rows?.[0];
}

/**
 * Sync one domain's inbound mail: list it, fetch any missing bodies, persist,
 * and hand each row to the cache warmer.
 *
 * @param {object} args
 * @param {string} args.domain       registry key (pfp | mobilemonero | 31harbor | jobby)
 * @param {object} args.spec         EMAIL_DOMAINS[domain]
 * @param {string} args.apiKey       the key scoped to THIS domain
 * @param {Function} args.query      async (sql, params) => pg result
 * @param {Function} [args.keyFor]   (address) => registry key, for labelling rows
 * @param {Function} [args.addToInbox] (domain, entry) => void, warms the cache
 * @returns {Promise<{scanned:number,persisted:number,bodiesCaptured:number}>}
 */
export async function syncOneDomainInbox({ domain, spec, apiKey, query, keyFor, addToInbox }) {
  // `ok:false` on an empty summary is load-bearing. A domain that could not sync
  // returns scanned:0, which is indistinguishable from a mailbox that is simply
  // empty — and an empty-looking mailbox is the exact shape of the original bug.
  // The caller counts these, so one bad key shows up in the pass total.
  const summary = { ok: false, scanned: 0, persisted: 0, bodiesCaptured: 0, reason: null };
  const label = spec?.domain || domain;

  if (!apiKey) {
    summary.reason = 'no-api-key';
    console.warn(`[inbox-db] ${label}: no Resend key configured, cannot sync`);
    return summary;
  }

  let res;
  try {
    res = await fetch('https://api.resend.com/emails/receiving?limit=50', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    summary.reason = `listing-failed: ${e.message}`;
    console.warn(`[inbox-db] ${label}: listing failed (non-fatal): ${e.message}`);
    return summary;
  }
  if (!res.ok) {
    summary.reason = `listing-http-${res.status}`;
    console.warn(`[inbox-db] ${label}: listing returned HTTP ${res.status}`);
    return summary;
  }

  // Defect 1: the envelope. See the header comment.
  const payload = await res.json();
  // Both shapes accepted so a future flattening cannot break it the same way.
  const emails = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(emails)) {
    // Named out loud rather than skipped in silence.
    summary.reason = 'unreadable-shape';
    console.warn(`[inbox-db] Unexpected /emails/receiving shape from ${label}: `
      + `keys=${Object.keys(payload || {}).join(',')}`);
    return summary;
  }
  summary.ok = true;
  summary.scanned = emails.length;

  let bodyFetched = 0, bodyUnavailable = 0, bodySkipped = 0;

  for (const email of emails) {
    const regKey = (keyFor ? keyFor(email.to) : null) || domain;
    const toDomain = spec?.domain || label;

    // The listing carries no body. A cache entry built from it would read as
    // "an email with no content", so the cache is warmed only once the body is known.
    const listedText = email.text || null;

    // Persist the row first, always: even with no body it records that the mail
    // arrived and carries the id needed to fetch it later. A plain INSERT rather
    // than the upsert, because this re-reads the same rows every pass and an
    // upsert here would risk disturbing a body the webhook already stored.
    try {
      await query(
        `INSERT INTO app.inbox_emails
           (email_id, sender, recipient, subject, body_text, body_html, received_at, read, domain, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (email_id) DO NOTHING`,
        [
          email.id,
          email.from || '',
          Array.isArray(email.to) ? email.to.join(',') : (email.to || ''),
          email.subject || '',
          listedText,
          email.html || null,
          email.created_at || new Date().toISOString(),
          false,
          regKey,
          JSON.stringify({
            subject: email.subject || '', from: email.from || '',
            domain_name: toDomain, has_body: false,
          }),
        ]
      );
      summary.persisted++;
    } catch (dbErr) {
      // Never fatal. One unpersistable row must not stop the rest.
      console.warn(`[inbox-db] persist failed for ${email.id}: ${dbErr.message}`);
    }

    // Gated three ways: only rows with no body, only inside the retention window,
    // only up to the per-pass cap.
    const ageDays = (Date.now() - new Date(email.created_at || Date.now()).getTime()) / 86400000;
    if (!listedText && ageDays <= INBOUND_BODY_RETENTION_DAYS) {
      if (bodyFetched >= INBOUND_BODY_FETCH_CAP) { bodySkipped++; continue; }
      bodyFetched++;

      // apiKey is the DOMAIN'S OWN key, passed in by the caller. Defect 3 lives
      // here if a caller passes a shared one.
      const body = await fetchInboundBody(email.id, apiKey);

      if (body.fetched) {
        summary.bodiesCaptured++;
        try {
          await query(
            `UPDATE app.inbox_emails
                SET body_text = COALESCE(body_text, $2),
                    body_html = COALESCE(body_html, $3),
                    metadata  = COALESCE(metadata, '{}'::jsonb)
                               || jsonb_build_object('has_body', true,
                                                     'body_fetched_at', NOW(),
                                                     'authentication', $4::jsonb)
              WHERE email_id = $1`,
            [email.id, body.text, body.html, JSON.stringify(body.authentication || null)]
          );
        } catch (e) {
          console.warn(`[inbox-db] body write failed ${email.id}: ${e.message}`);
        }
      } else {
        // Not proof of expiry — a wrong key looks identical. Recorded with its
        // reason so a scope problem stays visible instead of being recorded as
        // "gone", and so the next pass does not rediscover it at the cost of a
        // request.
        bodyUnavailable++;
        try {
          await query(
            `UPDATE app.inbox_emails
                SET metadata = COALESCE(metadata, '{}'::jsonb)
                               || jsonb_build_object('body_unavailable', true,
                                                     'body_unavailable_reason', $2,
                                                     'body_checked_at', NOW())
              WHERE email_id = $1`,
            [email.id, body.reason]
          );
        } catch { /* not worth failing the pass over */ }
      }
      continue; // cache warmed on a later pass, now that the body is known
    }

    addToInbox?.(toDomain, {
      to: email.to,
      from: email.from,
      from_name: email.from_name,
      subject: email.subject,
      text: listedText || '',
      html: email.html || '',
      email_id: email.id,
      attachments: email.attachments,
    });
  }

  // `via key` is on this line because "which key answered" decides whether a body
  // can be fetched at all. A key scoped elsewhere answers 404, which reads like
  // expiry, and naming the key makes that visible in the log rather than inferred.
  console.log(
    `[inbox-db] ${label} via ${spec?.key || '?'} (scope: ${spec?.key_scope || 'unrecorded'}): `
    + `scanned ${summary.scanned}, persisted ${summary.persisted}, `
    + `bodies ${summary.bodiesCaptured}/${bodyFetched} captured, `
    + `${bodyUnavailable} unavailable, ${bodySkipped} over cap`
  );
  return summary;
}

/**
 * Run one pass across every registered domain.
 *
 * Overlap-guarded: if a pass is still running when the timer fires, skip rather
 * than start a second. Two concurrent passes would race on the same rows and
 * double the body-fetch requests, which is exactly the burst the per-domain cap
 * exists to prevent.
 *
 * Per-domain failures are isolated so one bad key cannot stop the other three.
 *
 * @param {object} args
 * @param {Array<{key:string, spec:object, apiKey:string}>} args.domains
 * @param {Function} args.query
 * @param {Function} [args.keyFor]
 * @param {Function} [args.addToInbox]
 * @param {boolean} [args.isRunning]  guard flag owned by the caller
 * @param {string} [args.trigger]     label for the log line
 */
export async function runInboundSyncPass({ domains, query, keyFor, addToInbox, isRunning, trigger = 'pass' }) {
  if (isRunning === true) {
    console.log(`[inbox-sync] ${trigger} skipped: previous pass still running`);
    return { skipped: true };
  }
  if (isRunning) isRunning.value = true;

  const started = Date.now();
  const totals = { scanned: 0, persisted: 0, bodiesCaptured: 0, failed: 0, failures: [] };

  try {
    for (const { key, spec, apiKey } of domains) {
      let r = null;
      try {
        r = await syncOneDomainInbox({
          domain: key, spec, apiKey, query, keyFor, addToInbox,
        });
        totals.scanned += r.scanned;
        totals.persisted += r.persisted;
        totals.bodiesCaptured += r.bodiesCaptured;
        // A domain that returned early (no key, bad listing, unreadable shape) did
        // not throw, so it would otherwise be counted as a healthy zero — which is
        // the shape of the original bug: an empty table that reads as a quiet
        // mailbox.
        if (r.ok === false) {
          totals.failed++;
          totals.failures.push(`${key}: ${r.reason}`);
        }
      } catch (e) {
        totals.failed++;
        totals.failures.push(`${key}: threw ${e.message}`);
        console.warn(`[inbox-sync] ${key} failed (non-fatal): ${e.message}`);
      }
    }
  } finally {
    if (isRunning) isRunning.value = false;
  }

  console.log(
    `[inbox-sync] ${trigger} complete in ${((Date.now() - started) / 1000).toFixed(1)}s`
    + ` — scanned ${totals.scanned}, persisted ${totals.persisted}, `
    + `bodies ${totals.bodiesCaptured}${totals.failed ? `, ${totals.failed} domain(s) FAILED` : ''}`
  );
  for (const f of totals.failures) console.warn(`[inbox-sync]   failure: ${f}`);
  return totals;
}