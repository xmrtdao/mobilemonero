#!/usr/bin/env node
/**
 * inbound-email-parser.mjs — Alice's inbound email parsing pipeline
 *
 * Reads unread emails from both Resend inboxes (PFP + XMRT),
 * classifies them, extracts key client fields, persists the
 * parsed result to Supabase, and creates follow-up tasks for
 * actionable inquiries.
 *
 * Two sources are merged:
 *   1. Relay state (email.inbox) — populated via the relay's
 *      /api/fleet-chat/email-webhook forwarder and Resend's
 *      /webhook/resend-inbound handler.
 *   2. Supabase inbox_messages (type='email', is_read=false) —
 *      populated by the resend-webhook-proxy edge function.
 *
 * For each unparsed email, this module:
 *   - Detects/sets the account (partyfavorphoto / mobilemonero)
 *   - Classifies (inquiry / reply / vendor_pitch / automated / general)
 *   - Extracts phone, date, guest_count, address
 *   - Updates the inbox_messages row with parsed metadata
 *   - Marks the relay email as read
 *   - Logs a parse event to the email_parse_log table (if present)
 *   - For inquiries, creates a task in the tasks table
 *
 * Idempotency: a parsed email is marked with metadata.parsed_at
 * and metadata.parsed_by='alice'. Re-parsing is a no-op.
 *
 * Usage:
 *   import { parseInboundEmails } from './lib/inbound-email-parser.mjs'
 *   const result = await parseInboundEmails({ limit: 25 })
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import http from 'http';
import https from 'https';
import { findEscalationByToken, findEscalationBySubject, answerEscalation } from './task-escalation.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

// ── Env loader ─────────────────────────────────────────────
function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

// This estate runs locally. The old default pointed at the retired hosted
// project, so any environment that did not set SUPABASE_URL called a host that
// no longer holds the system of record. local-sb exposes the same REST layout
// on :54321.
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RELAY_PORT = process.env.RELAY_PORT || '8080';
const ALICE_ID = 'alice-sidecar';

// ── HTTP helpers ───────────────────────────────────────────
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = lib.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (options.timeout) req.setTimeout(options.timeout, () => req.destroy(new Error('timeout')));
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

// Native fetch wrapper with timeout + JSON convenience
async function fetchWithTimeout(url, options = {}) {
  const { timeout = 10000, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Classification ────────────────────────────────────────
// Returns { category, priority, is_automated, confidence }
//
//   category:    'inquiry' | 'reply' | 'vendor_pitch' | 'automated' | 'general' | 'support'
//   priority:    1-10 (Supabase tasks table convention; 10 = urgent)
//   is_automated: true if this is an auto-reply / bounce / system mail
//   confidence:  0-1, parser's self-assessed confidence
const VENDOR_PITCH_RE = /\b(seo|backlink|fix your (website|site|errors?)|marketing services|lead gen|web develop|outsourc|web design services|cryptocurrency (investment|trading)|investment opportunity|loan offer|affordable (seo|marketing)|buy followers|cheap (seo|backlinks))\b/i;
const INQUIRY_RE = /\b(quote|quote me|book|booking|hire|hire you|estimate|available|availability|wedding|birthday|party|corporate event|school (event|dance|prom)|graduation|anniversary|fundraiser|gala|reception|reservation|rent|rate|pricing|price list|how much|info|information|callback|call back|event|date|venue|guests?)\b/i;
const SUPPORT_RE = /\b(help|support|issue|problem|broken|not working|cancel|refund|complaint|question about)\b/i;
const AUTOMATED_SENDER_RE = /^(no-?reply|noreply|mailer-?daemon|postmaster|donotreply|notifications?)@/i;
const AUTOMATED_SUBJ_RE = /\b(automatic reply|out of office|auto-?reply|vacation|on leave|undeliverable|delivery (failed|status)|mail delivery failed|failure notice|returned mail|please activate|security alert|password reset|verify your|login attempt|receipt|order confirmation|invoice|booking confirmation|payment (received|confirmed)|subscription)\b/i;
// Contract-signing / e-sign platforms are system-generated notifications
const SIGN_PLATFORM_RE = /\b(zoho\s*sign|docusign|signnow|panda\s*doc|hellosign|adobe\s*sign|dropbox\s*sign)\b/i;
const OUT_OF_OFFICE_RE = /\b(out of office|away from|on vacation|on leave|limited access|back on (monday|tuesday|wednesday|thursday|friday|the|next))\b/i;

// Scale 0-5 (internal) -> 1-10 (Supabase tasks table)
function scalePriority(internal) {
  return Math.max(1, Math.min(10, Math.round(internal * 2)));
}

// Exported so the backlog can be measured against the real classifier rather
// than a guess at it: "how many of these would become tasks?" is a question
// about this function, not about an approximation of it.
export function classify(subject, text, from) {
  const subj = (subject || '').toLowerCase();
  const body = (text || '').toLowerCase();
  const fromLc = (from || '').toLowerCase();
  const haystack = `${subj} ${body.slice(0, 1500)}`;

  // Automated mail
  if (AUTOMATED_SENDER_RE.test(fromLc) || AUTOMATED_SUBJ_RE.test(subj)) {
    return { category: 'automated', priority: scalePriority(1), is_automated: true, confidence: 0.95 };
  }
  // Out-of-office
  if (OUT_OF_OFFICE_RE.test(subj) || OUT_OF_OFFICE_RE.test(body.slice(0, 500))) {
    return { category: 'automated', priority: scalePriority(1), is_automated: true, confidence: 0.85 };
  }
  // Contract-signing / e-sign platforms (Zoho Sign, DocuSign, etc.)
  if (SIGN_PLATFORM_RE.test(haystack) || SIGN_PLATFORM_RE.test(fromLc)) {
    return { category: 'automated', priority: scalePriority(2), is_automated: true, confidence: 0.85 };
  }
  // Vendor pitch / SEO spam
  if (VENDOR_PITCH_RE.test(haystack)) {
    return { category: 'vendor_pitch', priority: scalePriority(1), is_automated: false, confidence: 0.8 };
  }
  // Inquiry (RE: also counts as inquiry if it's about an event)
  if (INQUIRY_RE.test(haystack)) {
    return { category: 'inquiry', priority: scalePriority(4), is_automated: false, confidence: 0.8 };
  }
  // Existing conversation reply
  if (/^re:\s/i.test(subject || '')) {
    return { category: 'reply', priority: scalePriority(3), is_automated: false, confidence: 0.7 };
  }
  // Support request
  if (SUPPORT_RE.test(haystack)) {
    return { category: 'support', priority: scalePriority(3), is_automated: false, confidence: 0.6 };
  }
  return { category: 'general', priority: scalePriority(2), is_automated: false, confidence: 0.5 };
}

// ── Field extraction ──────────────────────────────────────
function extractFields(text) {
  const out = { phone: null, date_mentioned: null, guest_count: null, address: null, event_type: null, budget_mentioned: null };

  // Phone — US/international formats
  const phoneMatch = text.match(/(\+?\d{1,3}[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/)
    || text.match(/(\(\d{3}\)\s?\d{3}-\d{4})/);
  if (phoneMatch) out.phone = phoneMatch[1].trim();

  // Dates
  const namedDate = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i);
  if (namedDate) {
    out.date_mentioned = `${namedDate[1]} ${namedDate[2]}${namedDate[3] ? ', ' + namedDate[3] : ''}`;
  } else {
    const slashDate = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
    if (slashDate) out.date_mentioned = slashDate[0];
    else {
      const isoDate = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
      if (isoDate) out.date_mentioned = isoDate[0];
    }
  }

  // Guest count
  const guestMatch = text.match(/\b(\d{1,4})\s*(?:guests?|people|attendees|pax|persons?|adults?|kids?|children)\b/i);
  if (guestMatch) out.guest_count = parseInt(guestMatch[1], 10);

  // Address (street number + name + type)
  const addrMatch = text.match(/\b(\d{1,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway)\b\.?)/);
  if (addrMatch) out.address = addrMatch[1];

  // Event type
  const eventMatch = text.match(/\b(wedding|birthday|party|corporate event|school dance|prom|graduation|anniversary|fundraiser|gala|reception|quinceanera|sweet 16|bar mitzvah|baptism|christening|holiday party|company picnic|retirement|engagement|bridal shower|baby shower)\b/i);
  if (eventMatch) out.event_type = eventMatch[1].toLowerCase();

  // Budget
  const budgetMatch = text.match(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/);
  if (budgetMatch) out.budget_mentioned = '$' + budgetMatch[1];

  return out;
}

// ── Account detection (defense in depth) ───────────────────
function detectAccount(email, fallbackDomain) {
  const to = Array.isArray(email.to) ? email.to.join(',') : (email.to || '');
  const from = email.from || '';
  const allText = `${to} ${from} ${to.toLowerCase()}`;
  if (allText.includes('partyfavorphoto')) return 'partyfavorphoto';
  if (allText.includes('mobilemonero')) return 'mobilemonero';
  if (fallbackDomain === 'partyfavorphoto.com') return 'partyfavorphoto';
  if (fallbackDomain === 'mobilemonero.com') return 'mobilemonero';
  return 'unknown';
}

// ── Fetch unread from both relay inboxes ───────────────────
async function fetchRelayInbox(domain) {
  try {
    const path = domain === 'partyfavorphoto.com' ? '/resend/inbox' : '/resend/mobilemonero/inbox';
    const data = await fetchJSON(`http://localhost:${RELAY_PORT}${path}`, {
      headers: { 'X-Agent-Id': 'vex' },
      timeout: 8000,
    });
    return (data?.emails || []).filter(e => !e.read);
  } catch (e) {
    return [];
  }
}

// ── Fetch recent durable mail ──────────────────────────────
//
// app.inbox_emails is where the Resend webhook writes every inbound message,
// and it is the only place that survives a relay restart. The two sources
// above miss most of it: the relay's own inbox is in-memory state that the
// boot poller only partly refills, and inbox_messages is a different table
// the edge function wrote years ago.
//
// That gap is not academic. Six replies to the questions Alice asked arrived
// as mail, landed in this table, and were never seen by anything - because
// nothing read this table. The task asked "please confirm" and the answer sat
// in a table no one was watching.
//
// TWO THINGS BOUND IT, AND BOTH MATTER
//
// 1. THE READ FLAG IS NOT A WORK QUEUE.
//
//    `read` was never maintained for the rows the boot polyer wrote - 898
//    rows sat at read=false, and most of them are mail from weeks ago that
//    was handled at the time. Reading "everything unread" would replay a
//    week of history as if it had just arrived. So the marker used here is
//    metadata->>'parsed_by', which this parser sets itself, and the window
//    is recent mail only.
//
// 2. AN ANSWER IS NOT NEW WORK.
//
//    A reply to a question we asked is the answer to work already on the
//    board. Filing it as an inquiry would create a SECOND task for a task
//    that already exists - and the reply would sit there while the task it
//    answers stayed parked. Those rows are excluded here and handled by
//    relay/scripts/ingest-task-replies.mjs, which reads them, interprets
//    them and attaches them to the task they answer.
//
// The body is read, not just the subject: the reply IS the answer, and a
// subject line is not an answer.
async function fetchDurableInbox(domainKey, limit = 50, withinHours = 48) {
  try {
    const { query: localQuery } = await import('./localDb.mjs');
    const rows = await localQuery(
      `SELECT id, email_id, sender, recipient, subject, body_text, body_html,
              received_at, read, domain, metadata
         FROM app.inbox_emails m
        WHERE m.domain = $1
          AND m.body_text IS NOT NULL
          AND btrim(m.body_text) <> ''
          AND COALESCE(m.metadata->>'parsed_by', '') <> $2
          AND m.received_at > now() - ($3 || ' hours')::interval
          -- Not the answer to a question we asked. Those belong to the task
          -- they answer, and the reply ingester handles them.
          --
          -- EVERY escalation, open or answered: a second reply to a question
          -- we already answered is still an answer to that question, and
          -- still not new work. Only an escalation that is still open is
          -- matched here, because the ingester closes the escalation as it
          -- reads it - so an answered one would fall through to here and be
          -- filed as an inquiry.
          AND NOT EXISTS (
            SELECT 1 FROM app.task_escalations e
             WHERE (
                 (e.subject LIKE '%[esc_%'
                  AND m.subject LIKE '%' || substring(e.subject from '%\[esc_[a-f0-9]+\]%') || '%')
                 OR lower(m.subject) ILIKE '%' || lower(replace(e.subject, 'Needs you: ', '')) || '%'
               )
          )
        ORDER BY m.received_at DESC
        LIMIT $4`,
      [domainKey, ALICE_ID, String(withinHours), limit]
    ).catch(() => []);

    return rows.map(r => ({
      id: r.email_id || r.id,
      email_id: r.email_id,
      from: r.sender || '',
      to: r.recipient || '',
      subject: r.subject || '',
      text: r.body_text || '',
      html: r.body_html || '',
      received_at: r.received_at,
      read: r.read,
      metadata: r.metadata || {},
      // Which table this came from, so the reader knows how to mark it.
      _source: 'db',
      _domain_key: r.domain,
      _db_id: r.id,
    }));
  } catch (e) {
    console.warn(`[inbound-parser] could not read app.inbox_emails for ${domainKey}: ${e.message}`);
    return [];
  }
}

// ── Mark a durable row as read and parsed ───────────────────
//
// Without this the same row is re-read on every pass. The parsed_by marker
// is what the fetch filters on, so this is the idempotency record.
//
// `read` is set as well, but it is not what the fetch filters on: it was
// never maintained for the rows the boot poller wrote, so on its own it
// would either replay the whole history or hide the new mail. The marker
// this writes is the one that means "Alice has seen this".
async function markDurableParsed(dbId, classification, extracted) {
  if (!dbId) return false;
  try {
    const { query: localQuery } = await import('./localDb.mjs');
    await localQuery(
      `UPDATE app.inbox_emails
          SET read = true,
              metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1::int`,
      [dbId, JSON.stringify({
        parsed_by: ALICE_ID,
        parsed_at: new Date().toISOString(),
        category: classification?.category || null,
        priority: classification?.priority ?? null,
        extracted: extracted || {},
      })]
    );
    return true;
  } catch (e) {
    console.warn(`[inbound-parser] could not mark durable row ${dbId} parsed: ${e.message}`);
    return false;
  }
}

// ── Fetch unread from Supabase ────────────────────────────
async function fetchSupabaseInbox() {
  if (!SUPABASE_KEY) return [];
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/inbox_messages?type=eq.email&is_read=eq.false&select=*&order=created_at.desc&limit=50`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

// ── Resend API lookup (fallback when body is empty) ───────
// Some Supabase inbox rows are metadata-only (the legacy
// resend-webhook-proxy didn't fetch the full body). We can
// recover by calling Resend's receiving API directly.
function getResendKeyForAccount(account) {
  if (account === 'partyfavorphoto') return process.env.RESEND_API_KEY || '';
  if (account === 'mobilemonero') return process.env.RESEND_XMRT_API_KEY || '';
  return '';
}

async function fetchResendBody(emailId, account) {
  const key = getResendKeyForAccount(account);
  if (!key || !emailId) return null;
  try {
    const res = await fetchWithTimeout(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 8000,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch {
    return null;
  }
}

// ── Mark relay email as read ──────────────────────────────
async function markRelayRead(domain, id) {
  const path = domain === 'partyfavorphoto.com' ? '/resend/inbox/read' : '/resend/mobilemonero/inbox/read';
  try {
    await fetchJSON(`http://localhost:${RELAY_PORT}${path}`, {
      method: 'POST', timeout: 5000,
      body: { id, domain },
    });
  } catch { /* best-effort */ }
}

// ── Mark relay email as parsed (idempotency + audit) ──────
async function markRelayParsed(domain, id, classification, extracted) {
  try {
    await fetchJSON(`http://localhost:${RELAY_PORT}/resend/inbox/parsed`, {
      method: 'POST', timeout: 5000,
      body: { id, domain, classification, extracted },
    });
  } catch { /* best-effort */ }
}

// ── Update Supabase row with parsed metadata ──────────────
async function persistSupabaseParse(rowId, classification, extracted, account) {
  if (!SUPABASE_KEY) return false;
  const patch = {
    is_read: classification.priority <= 2, // low-priority = auto-read
    metadata: {
      parsed_at: new Date().toISOString(),
      parsed_by: ALICE_ID,
      parsed_version: '1.0.0',
      category: classification.category,
      priority: classification.priority,
      is_automated: classification.is_automated,
      confidence: classification.confidence,
      extracted,
      account,
    },
  };
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/inbox_messages?id=eq.${rowId}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return res.ok;
}

// ── Create a follow-up task for an inquiry ────────────────
async function createFollowupTask(email, classification, extracted) {
  if (!SUPABASE_KEY) return null;
  if (classification.category !== 'inquiry' && classification.category !== 'support') return null;
  // Don't double-create — check if a recent task references this email
  const subject = email.subject || '(no subject)';
  const check = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/tasks?title=ilike.*${encodeURIComponent(subject.slice(0, 30))}*&select=id&limit=1`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  const existing = await check.json();
  if (Array.isArray(existing) && existing.length > 0) return existing[0];

  const taskTitle = `Reply: ${subject}`;
  const taskBody = [
    `From: ${email.from || 'unknown'}`,
    `Account: ${extracted?.account || 'unknown'}`,
    extracted?.date_mentioned ? `Date: ${extracted.date_mentioned}` : null,
    extracted?.phone ? `Phone: ${extracted.phone}` : null,
    extracted?.guest_count ? `Guests: ${extracted.guest_count}` : null,
    extracted?.event_type ? `Event: ${extracted.event_type}` : null,
    `Category: ${classification.category} (priority ${classification.priority})`,
    '',
    '---',
    '',
    (email.text || email.content || '').slice(0, 2000),
  ].filter(Boolean).join('\n');

  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/tasks`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({
      // The id has to be supplied.
      //
      // app.tasks.id is NOT NULL with NO DEFAULT - the route that creates
      // tasks over SQL passes gen_random_uuid()::text itself, because a
      // column with no default and a NOT NULL constraint rejects any insert
      // that does not name it. PostgREST cannot add one, so every
      // email-originated task creation failed with "null value in column id
      // ... violates not-null constraint" - and the parse log still reported
      // "0 errors", because the failure was logged and not counted.
      //
      // That is why every task on the board came from the founder: the path
      // that would have created the others had never worked.
      id: randomUUID(),
      title: taskTitle,
      description: taskBody,
      status: 'BLOCKED',
      stage: 'PLAN',
      category: 'ops',
      priority: classification.priority,
      // Don't set assignee_agent_id — that field has FK validation
      // against the agents table and we don't have a JOE agent there.
      // The metadata below carries the from/to + extracted fields for
      // whoever picks it up.
      created_by_user_id: '1b865599-e9ae-45df-8e50-a2abec6811b4',
      metadata: {
        source: 'inbound-email',
        from: email.from,
        account: extracted?.account,
        email_id: email.id || email.email_id,
        inbox_id: email.inbox_id || null,
        category: classification.category,
        extracted,
        parsed_at: new Date().toISOString(),
        parsed_by: ALICE_ID,
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    // An open task with the same title already exists, so this email is
    // already being worked. That is the dedupe index doing its job, not a
    // failure - and the parse log counts errors, so calling it one would
    // report a healthy inbox as broken.
    if (/tasks_one_open_per_title|duplicate key value/.test(err)) {
      console.log('[inbound-parser] an open task with this title already exists - not filing it again');
      return null;
    }
    console.error(`[inbound-parser] task create failed: ${err}`);
    return null;
  }
  const created = await res.json();
  return Array.isArray(created) ? created[0] : created;
}

// ── Main: parse all unread ────────────────────────────────
export async function parseInboundEmails(opts = {}) {
  const limit = opts.limit || 25;
  const dryRun = opts.dryRun || false;
  const startTime = Date.now();

  const results = {
    started_at: new Date().toISOString(),
    parsed: [],
    skipped: [],
    errors: [],
    duration_ms: 0,
  };

  // Gather from every source
  const [pfpInbox, mmInbox, supaInbox, pfpDurable, mmDurable] = await Promise.all([
    fetchRelayInbox('partyfavorphoto.com'),
    fetchRelayInbox('mobilemonero.com'),
    fetchSupabaseInbox(),
    fetchDurableInbox('pfp'),
    fetchDurableInbox('mobilemonero'),
  ]);

  // Build a unified work list, deduping by email_id / message_id / from+subject
  const work = [];
  const seen = new Set();

  function addWork(entry, source) {
    const key = entry.id || entry.email_id || entry.message_id || `${entry.from}|${entry.subject}`;
    if (seen.has(key)) return;
    // Skip if already parsed (Supabase metadata check or relay parsed_by check)
    if (entry.metadata?.parsed_by === ALICE_ID) {
      results.skipped.push({ reason: 'already_parsed', source, id: key });
      return;
    }
    if (entry.parsed_by === ALICE_ID) {
      results.skipped.push({ reason: 'already_parsed', source, id: key });
      return;
    }
    seen.add(key);
    work.push({ ...entry, _source: source });
  }

  // The durable table goes FIRST.
  //
  // It is first because it is the only source that holds everything the
  // others miss, and because the order decides who gets processed. The relay's
  // own inbox holds 46 unread pfp messages and every one of them is older
  // than the durable table's newest; put the durable table last and those 46
  // fill the whole 25-slot budget every hour, and the mail that actually
  // arrived today is never read.
  //
  // addWork dedupes on the id, and both sources use Resend's message id, so
  // a message that is in both is still processed once - from the durable
  // table, which has the body and the durable marker.
  for (const e of pfpDurable) addWork(e, 'db-pfp');
  for (const e of mmDurable) addWork(e, 'db-mm');

  for (const e of pfpInbox) addWork({ ...e, _domain: 'partyfavorphoto.com' }, 'relay-pfp');
  for (const e of mmInbox) addWork({ ...e, _domain: 'mobilemonero.com' }, 'relay-mm');
  for (const e of supaInbox) addWork({ ...e, _domain: e.metadata?.account_label === 'mobilemonero' ? 'mobilemonero.com' : 'partyfavorphoto.com' }, 'supabase');

  // Process up to limit
  for (const email of work.slice(0, limit)) {
    try {
      const account = detectAccount(email, email._domain);
      const subject = email.subject || email.title || '(no subject)';
      let text = email.text || email.content || (email.html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const from = email.from || '';

      // Fallback: if body is empty but we have a Resend email_id, fetch it
      const emailId = email.email_id || email.id;
      if (!text && emailId) {
        const fetched = await fetchResendBody(emailId, account);
        if (fetched) {
          text = fetched.text || (fetched.html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }

      // An ANSWER to a question we asked.
      //
      // The question went out with a token in the subject, and a reply keeps
      // the subject, so the answer finds the task it belongs to. It is
      // recorded against the task, the escalation is closed, and NO task is
      // created for it: this is not new work, it is the answer to work that
      // is already on the board.
      const tokenMatch = subject.match(/\[(esc_[a-f0-9]+)\]/i);
      const esc = tokenMatch
        ? await findEscalationByToken(tokenMatch[1])
        // The questions that went out before the token existed are still
        // waiting for their answers, and a reply carries the subject it was
        // sent with.
        : await findEscalationBySubject(subject);

      if (esc) {
        const answered = await answerEscalation(esc.id, text, { from });
        if (email._source.startsWith('relay') && email.id) {
          await markRelayParsed(email._domain, email.id,
            { category: 'reply', event: 'escalation_answered' },
            { escalation_id: esc.id, task_id: esc.task_id });
        }
        if (email._source === 'supabase' && email.id) {
          await persistSupabaseParse(email.id,
            { category: 'reply', event: 'escalation_answered' },
            { escalation_id: esc.id, task_id: esc.task_id }, account);
        }
        if (email._source.startsWith('db') && email._db_id) {
          await markDurableParsed(email._db_id,
            { category: 'reply', event: 'escalation_answered', priority: 1 },
            { escalation_id: esc.id, task_id: esc.task_id });
        }
        results.parsed.push({
          source: email._source,
          id: email.id || email.email_id,
          subject, from, account,
          classification: { category: 'reply', event: 'escalation_answered' },
          answered_escalation: esc.id,
          answered_task: esc.task_id,
          answered: !!answered,
          task_created: null,
        });
        continue;
      }
      if (tokenMatch) {
        // A token we do not know: the question was sent, the record was not
        // kept, or it was answered twice. Say so rather than filing it as
        // new work.
        console.warn(`[inbound-parser] the reply carries the token ${tokenMatch[1]} and it matches nothing`);
      }

      const classification = classify(subject, text, from);
      const extracted = extractFields(text);
      extracted.account = account;

      if (dryRun) {
        results.parsed.push({
          source: email._source,
          id: email.id || email.email_id,
          subject, from, account,
          classification, extracted,
          text_preview: text.slice(0, 200),
        });
        continue;
      }

      // Persist to Supabase if this came from there
      let persisted = null;
      if (email._source === 'supabase' && email.id) {
        persisted = await persistSupabaseParse(email.id, classification, extracted, account);
      }

      // Mark relay email as read + parsed (idempotency marker)
      if (email._source.startsWith('relay') && email.id) {
        await markRelayParsed(email._domain, email.id, classification, extracted);
      }
      if (email._source.startsWith('db') && email._db_id) {
        await markDurableParsed(email._db_id, classification, extracted);
      }

      // Create follow-up task for inquiries
      let task = null;
      if (classification.category === 'inquiry' || classification.category === 'support') {
        task = await createFollowupTask({ ...email, subject, text }, classification, { ...extracted, account });
      }

      results.parsed.push({
        source: email._source,
        id: email.id || email.email_id,
        subject, from, account,
        classification, extracted,
        task_created: task?.id || null,
        supabase_persisted: persisted,
      });
    } catch (e) {
      results.errors.push({ id: email.id || email.email_id, error: e.message });
    }
  }

  results.duration_ms = Date.now() - startTime;
  return results;
}

// ── One-shot CLI entry ────────────────────────────────────
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const dryRun = process.argv.includes('--dry-run');
  parseInboundEmails({ dryRun, limit: 50 })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((e) => { console.error('Fatal:', e); process.exit(1); });
}
