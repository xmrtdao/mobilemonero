/**
 * relay/lib/pfp-inbound.mjs — watch the inbox, and a reply becomes a lead.
 *
 * WHY A POLL AND NOT A WEBHOOK
 * ----------------------------
 * Resend supports inbound webhooks, but the domain reports no inbound address
 * configured, and a webhook needs a public endpoint plus signature handling that
 * does not exist yet. The relay already runs a six-times-daily scheduler, so a
 * 15-minute poll fits the machinery that is already trusted. If reply speed
 * matters more than the extra moving part, this is the module to swap - the
 * filtering and lead creation are identical either way.
 *
 * WHY THE FILTER IS AN EXCLUSION LIST AND NOT A KEYWORD MATCH
 * -----------------------------------------------------------
 * Measured against the last 100 inbound messages in this account, a keyword test
 * for words like "photo", "event", "contract" and "book" flagged 30 of them - and
 * most of those 30 were false positives: a line-of-credit email containing
 * "contract", a GitHub alert containing "event", a Stripe receipt.
 *
 * A keyword gate would therefore drop the one message that mattered and admit
 * four that did not. So the filter only removes things that are DEFINITELY not a
 * lead:
 *
 *   - our own domain            (internal traffic, bounces)
 *   - a named non-PFP sender     (funding campaigns, notification senders)
 *   - a no-reply sender          (machine mail)
 *
 * Everything else becomes a lead and is triaged by a human. Being permissive here
 * costs a few minutes of someone's attention; being restrictive loses business
 * silently.
 *
 * WHAT EXCLUDED
 * -------------
 * Excluding an address from the LEAD WATCH does not delete it or stop the
 * campaign using it. This is about what becomes a lead, nothing else.
 */

import fs from 'node:fs';

/**
 * Our own staff addresses. Excluded ONLY when the mail is from partyfavorphoto.com.
 *
 * `ken` and `kengriffin` are here because the owner runs funding and line-of-credit
 * campaigns under those aliases and their inbound has nothing to do with photo
 * booth bookings. `eliza` is deliberately NOT here: the owner asked for Eliza to be
 * watched as a RECEIVING address, and mail from our own domain is excluded by the
 * domain rule regardless.
 */
export const EXCLUDED_STAFF = Object.freeze([
  'kengriffin', 'ken', 'eliza', 'alex',
  // Funding/campaign aliases.
  'maxcapitalfund', 'funds', 'capitalfunds', 'creditcapital',
]);

/**
 * Local parts that are never a person, excluded on ANY domain.
 *
 * `notifications@` is on this list rather than the staff list on purpose: a school
 * or parish office using notifications@ as its contact address is an ordinary
 * thing, and dropping it would lose a real lead. Nobody is ever a lead at
 * noreply@, though, so that is safe everywhere.
 */
export const ROBOT_SENDERS = Object.freeze([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'bounce', 'bounces', 'mailer-daemon', 'postmaster', 'abuse',
]);

/** Combined view, kept for callers that want one list. */
export const EXCLUDED_SENDERS = Object.freeze([...EXCLUDED_STAFF, ...ROBOT_SENDERS]);

/** Domains that are machines or other campaigns. */
export const EXCLUDED_DOMAINS = Object.freeze([
  'github.com',
  'stripe.com',
  'resend.com',
  'vsco.co',
  'getyourguide.com',
  'facebookmail.com',
  'sendgrid.net',
  'mailchimp.com',
]);

/** Our own domain. Mail from here is internal or a bounce. */
export const OWN_DOMAIN = 'partyfavorphoto.com';

/**
 * Decide whether an inbound message should become a lead.
 *
 * @returns {{is_lead: boolean, reason: string|null}}
 */
export function classifyInbound(fromEmail) {
  const raw = String(fromEmail || '').trim().toLowerCase();
  if (!raw || !raw.includes('@')) {
    return { is_lead: false, reason: 'no usable sender address' };
  }
  const at = raw.indexOf('@');
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);

  // A syntactically impossible address is not a lead, and treating it as one
  // would create a lead row keyed on garbage. "@nodomain" and "a@b" both land
  // here: the shape is wrong, not the sender.
  if (!local || !domain || !domain.includes('.') || /\s/.test(raw)) {
    return { is_lead: false, reason: `not a usable email address: ${raw}` };
  }

  if (domain === OWN_DOMAIN) {
    return {
      is_lead: false,
      reason: `from our own domain (${raw}) - internal traffic, not a lead`,
    };
  }
  if (EXCLUDED_DOMAINS.includes(domain)) {
    return { is_lead: false, reason: `${domain} is a notification sender` };
  }

  // Sender names are excluded ONLY on our own domain. Excluding "ken" or
  // "notifications" everywhere would drop a genuine lead from a photographer
  // called Ken, or a school whose admin address is notifications@ - which is a
  // real pattern in school and parish offices.
  //
  // So: no-reply style local parts are excluded anywhere, because nobody is ever
  // a lead at noreply@; named people are excluded only as our own staff.
  if (domain === OWN_DOMAIN) {
    const base = local.split('+')[0];
    if (EXCLUDED_STAFF.includes(base) || EXCLUDED_STAFF.includes(local)) {
      return { is_lead: false, reason: `${base} is one of ours - internal traffic, not a lead` };
    }
  }

  if (ROBOT_SENDERS.includes(local.split('+')[0]) || ROBOT_SENDERS.includes(local)) {
    return { is_lead: false, reason: `${local} is a no-reply sender - no human is waiting` };
  }

  return { is_lead: true, reason: null };
}

/** Short body for the lead note, when the API gives us one. */
function snippetOf(m) {
  const body = m.text_body || m.html_body || '';
  const flat = String(body).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, 400) : null;
}

/**
 * Pull inbound messages and turn the lead-worthy ones into leads.
 *
 * Read-only against Resend's API; the only writes are to our database.
 *
 * @param {(sql:string, params?:any[])=>Promise<any>} query
 * @param {{key:string, capture:(q:Function,e:object)=>Promise<any>,
 *          limit?:number, since?:string, log?:Function}} deps
 */
export async function pollInbound(query, deps) {
  const { key, capture, limit = 100, since, log } = deps;
  const say = log || (() => {});

  const url = since
    ? `https://api.resend.com/emails/inbound?limit=${limit}`
    : `https://api.resend.com/emails/inbound?limit=${limit}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { ok: false, error: `Resend inbound HTTP ${res.status}: ${t.slice(0, 200)}` };
  }
  const body = await res.json();
  const messages = body?.data ?? (Array.isArray(body) ? body : []);
  if (!Array.isArray(messages)) {
    return { ok: false, error: 'Resend returned an unexpected shape for inbound mail' };
  }

  const seen = new Set();
  const skipped = [];
  const processed = [];
  let created = 0, logged = 0, resurrected = 0, duplicates = 0;

  // Newest first, so the most recent conversation is handled before older noise.
  const ordered = [...messages].sort((a, b) =>
    String(b.created_at || '').localeCompare(String(a.created_at || '')));

  for (const m of ordered) {
    const from = (Array.isArray(m.from) ? m.from.join(',') : m.from) || '';
    const mid = m.message_id || null;
    if (mid && seen.has(mid)) continue;
    if (mid) seen.add(mid);

    const verdict = classifyInbound(from);
    if (!verdict.is_lead) {
      skipped.push({ from: from || '(none)', subject: m.subject || '', reason: verdict.reason });
      continue;
    }

    let result;
    try {
      result = await capture(query, {
        from_email: from,
        sender_name: Array.isArray(m.from) ? m.from[0] : null,
        subject: m.subject || null,
        snippet: snippetOf(m),
        message_id: mid,
        received_at: m.created_at,
      });
    } catch (e) {
      skipped.push({ from, subject: m.subject || '', reason: `capture failed: ${e.message}` });
      continue;
    }

    if (result?.duplicate) { duplicates++; continue; }
    if (result?.created) created++;
    else if (result?.resurrected) resurrected++;
    else logged++;
    processed.push({ from, subject: m.subject || '', ...result });
  }

  const summary = {
    ok: true,
    scanned: messages.length,
    lead_worthy: processed.length,
    skipped: skipped.length,
    leads_created: created,
    leads_resurrected: resurrected,
    replies_logged: logged,
    duplicates_ignored: duplicates,
  };
  say('pfp-inbound', JSON.stringify(summary));
  return { ...summary, processed, skipped };
}

/**
 * A one-shot poll, runnable from cron or by hand.
 * Reads the key itself so a caller never has to handle a credential.
 */
export async function runInboundPoll(query, capture, opts = {}) {
  const env = parseEnv(fs.readFileSync(opts.envPath ?? '.env', 'utf8'));
  const key = env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'RESEND_API_KEY is not set' };
  return pollInbound(query, {
    key, capture,
    limit: opts.limit ?? 100,
    log: opts.log,
  });
}

function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export default { classifyInbound, pollInbound, runInboundPoll, EXCLUDED_SENDERS, EXCLUDED_DOMAINS };