#!/usr/bin/env node
/**
 * Daily Campaign Send -�" Party Favor Photo
 * Sends outreach emails from the seasonal-scraper contact pool. Usage: daily-campaign.mjs [count=50]
 * Called by Windows Task Scheduler at 8:00 AM daily.
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCampaignHtml } from './lib/email-template.mjs';
import {
  ensureCampaignSchema, recordSend, recordFailure, loadSuppression,
  recentlySent, campaignStats,
} from './lib/pfp-campaign-log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env
const envPath = path.join(__dirname, '.env');
const env = fs.readFileSync(envPath, 'utf8').split('\n').reduce((acc, line) => {
  const [k, ...v] = line.split('=');
  if (k) acc[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
  return acc;
}, {});

const RESEND_KEY = env.RESEND_API_KEY;
if (!RESEND_KEY) { console.error('No RESEND_API_KEY in .env'); process.exit(1); }

const RESEND_HOST = 'api.resend.com';
const FROM_ADDRESS = 'Party Favor Photo <bookings@partyfavorphoto.com>';
const REPLY_TO = 'joe@partyfavorphoto.com';
const CONTACTS_FILE = path.join(__dirname, '..', 'relay-data', 'campaign-contacts.json');
// LOG_FILE is now append-only and created if absent. The old `catch {}` around
// every write meant a failure here was invisible: the campaign reported success
// while recording nothing, which is how 50+ sends a day went out with no audit
// trail and a totalSent counter reading zero.
const LOG_FILE = path.join(__dirname, '..', 'relay-data', 'campaign.log');

/**
 * The pool, the Resend key, and the send log.
 *
 * Sends are recorded in public.pfp_campaign_sends, which is what the relay
 * dashboard's campaign tile reads. The JSON sent-log is gone on purpose: it was
 * never created, so nothing read it either, and a second source of truth that
 * only one writer touches is a source of disagreement.
 */
let DB_QUERY = null;
async function query(sql, params) {
  if (!DB_QUERY) {
    const { getPool } = await import('./jobby/store.mjs');
    const pool = await getPool();
    DB_QUERY = (s, p) => pool.query(s, p);
  }
  return DB_QUERY(sql, params);
}

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  try { appendFileSync(LOG_FILE, line + '\n'); }
  catch (e) { console.error(`campaign.log write failed: ${e.message}`); }
}

// Suppression lives in public.pfp_campaign_suppressions now. This previously
// read a suppression-list.json that has never existed, so an unsubscribe had
// nowhere to be recorded and the next drop emailed that person again.
let suppressed = new Set();

// The pool is the recipient list. It is still a 2.7 MB JSON blob and is loaded
// once per run, which is fine; what was missing was the WRITE side.
let contacts = [];
try { contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); }
catch (e) { console.error(`contact pool unreadable: ${e.message}`); contacts = []; }

// Image extensions that are NOT valid TLDs — reject emails whose domain TLD is an image extension
const IMAGE_EXTENSIONS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','tiff','tif','avif','heic','heif','raw','psd','eps','ico']);

function isRealEmail(email) {
  const e = email.toLowerCase().trim();
  if (!e.includes('@')) return false;
  const parts = e.split('@');
  if (parts.length !== 2) return false;
  const tld = parts[1].split('.').pop().toLowerCase().replace(/[^a-z]/g, '');
  if (IMAGE_EXTENSIONS.has(tld)) return false;
  return true;
}

// ── de-duplication, suppression, schema ─────────────────────────────────────
// Seed the suppression set from the table rather than a file that never existed.
suppressed = await loadSuppression(query);

// The 30-day check. `sentCount` on the pool record is only a hint the pool file
// carries; the table is the authority, because this is what every send writes.
const recentSent = new Set();
let recentCount = 0;
try {
  const { rows } = await query(
    `SELECT DISTINCT lower(email) AS email FROM public.pfp_campaign_sends
      WHERE status = 'sent' AND sent_at > NOW() - INTERVAL '30 days'`);
  for (const r of rows) recentSent.add(r.email);
  recentCount = recentSent.size;
} catch (e) {
  // Fail open on purpose: if the de-dup lookup fails we still send, because
  // dropping half the campaign on a bookkeeping error is the worse outcome.
  // The sentCount sort below still prefers untouched contacts.
  console.error(`[Campaign] de-dup lookup failed, falling back to sentCount sort: ${e.message}`);
}

let available = contacts.filter(
  (c) => c && c.email && !recentSent.has(String(c.email).toLowerCase().trim()) && isRealEmail(c.email));

if (suppressed.size > 0) {
  const blocked = available.filter((c) => suppressed.has(String(c.email).toLowerCase().trim()));
  if (blocked.length > 0) {
    console.log(`[Campaign] Skipping ${blocked.length} suppressed contacts`);
    available = available.filter((c) => !suppressed.has(String(c.email).toLowerCase().trim()));
  }
}

// Pick the batch, preferring the least-contacted. `sentCount` is seeded from the
// table after each run so this ordering stays truthful across restarts.
const sorted = [...available].sort((a, b) => (a.sentCount || 0) - (b.sentCount || 0));
const count = parseInt(process.argv[2]) || 100;

// Convert text body to HTML with images
function buildHtmlBody(textBody) {
  const paragraphs = textBody.split('\n\n');
  const html = paragraphs.map(p => {
    const trimmed = p.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('- ')) {
      return '<ul>' + trimmed.split('\n').map(l => '<li>' + l.replace(/^- /, '') + '</li>').join('') + '</ul>';
    }
    if (trimmed.startsWith('https://')) {
      // Check if it looks like an image (ends with image extension) or a URL
      const imgExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
      const isImage = imgExts.some(ext => trimmed.toLowerCase().includes(ext));
      if (isImage) {
        return '<p><img src="' + trimmed + '" style="max-width:100%;border-radius:8px;max-height:350px;"/></p>';
      }
      return '<p><a href="' + trimmed + '" style="display:inline-block;background:#ff6b35;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">Book Now</a></p>';
    }
    if (trimmed.startsWith('  ') || trimmed.includes('-- $')) {
      return '<p>' + trimmed.replace(/  /g, '&nbsp; ') + '</p>';
    }
    return '<p>' + trimmed + '</p>';
  }).filter(Boolean).join('\n');
  return '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">' + html + '</div>';
}
const batch = sorted.slice(0, count);

if (batch.length === 0) {
  console.log('No fresh contacts available. Run seasonal-scraper first.');
  process.exit(0);
}

let sent = 0, errors = 0, skipped = 0;
// Sends made in THIS run. Without it a duplicate inside a single batch would be
// invisible, because the table write lands after Resend has already accepted.
const sentEmailsThisRun = new Set();
const SUBJECT = 'The difference: DSLR + strobe vs tablet + ring light';

const logDir = path.join(__dirname, '..', 'relay-data');
const LOCK_FILE = path.join(logDir, 'campaign.lock');

// File-based lock to prevent concurrent campaign runs
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (lockAge < 3600000) {
        console.log('Campaign already running (age: ' + Math.round(lockAge/1000) + 's) -�" exiting');
        return false;
      }
      fs.unlinkSync(LOCK_FILE);
    }
    fs.writeFileSync(LOCK_FILE, String(Date.now()));
    return true;
  } catch { return false; }
}
function releaseLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {}
}

if (!acquireLock()) process.exit(0);
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(1); });
process.on('uncaughtException', () => { releaseLock(); process.exit(1); });

/**
 * Record one send.
 *
 * The JSON sent-log is replaced by public.pfp_campaign_sends. It was a
 * multi-megabyte read-modify-write per email that had never once been created, so
 * `recentSent` was permanently empty and the defence-in-depth check below was
 * permanently passing.
 */
async function recordDelivered(entry, resendId) {
  await recordSend(query, (m) => console.error(m), {
    email: entry.email,
    name: entry.name,
    source: entry.source,
    query: entry.query,
    region: entry.region,
    subject: SUBJECT,
    resend_id: resendId,
    status: 'sent',
  });
  sentEmailsThisRun.add(String(entry.email).toLowerCase().trim());
}

function sendNext() {
  if (batch.length === 0 || sent + errors >= count) {
    // Written to the log AND to the table, so the scheduler's counters and the
    // dashboard tile both reflect what actually happened this run.
    logLine(`done  sent=${sent} errors=${errors} skipped=${skipped}`);
    (async () => {
      try {
        await recordSend(query, (m) => console.error(m), {
          email: `run-summary-${Date.now()}@campaign.local`,
          status: sent > 0 ? 'run' : 'run_empty',
          detail: JSON.stringify({ sent, errors, skipped }),
          campaign: 'daily-run',
        });
        await reconcilePool();
      } catch (e) {
        console.error(`run summary not recorded: ${e.message}`);
      }
      releaseLock();
    })();
    return;
  }
  const entry = batch.shift();
  const entryKey = String(entry.email || '').toLowerCase().trim();

  // Defence in depth, against BOTH sources: the table seeded at startup, and the
  // sends already made in this run. The old check only looked at an in-memory
  // array that was never populated, so it could not have caught anything.
  if (recentSent.has(entryKey) || sentEmailsThisRun.has(entryKey)) {
    skipped++;
    logLine(`skip ${entry.email} (already contacted in the last 30 days)`);
    setTimeout(sendNext, 10);
    return;
  }
  if (suppressed.has(entryKey)) {
    skipped++;
    setTimeout(sendNext, 10);
    return;
  }
  // Build dynamic email body with Stripe booking links
  const stripeGeneral = 'https://buy.stripe.com/cNicN5gP9g6haH0bKCbZe0d';
  const stripe3hr = 'https://buy.stripe.com/9B63cv9mH07j3eyeWObZe06';
  const stripe4hr = 'https://buy.stripe.com/eVqcN556r4nz16qeWObZe04';
  
  const templateA = `Hello again from Party Favor Photo,

You may have seen photo booths that use an iPad on a stand with a ring light -- that is the common setup these days. But that has never been how we do it.

Since day one, we have built our experience around a professional DSLR camera with strobe lighting -- the same gear photographers use for weddings and editorial shoots. There is a real difference:

- Strobe flash -- freezes motion, works in any lighting from dark ballrooms to outdoor day events, and creates that clean, professional look
- DSLR quality -- large sensor, sharp detail, prints that actually look good at 4x6 and larger
- Bounce-diffused lighting -- soft, flattering light on faces. No harsh shadows, no red-eye, no washed-out look
- Professional attendant -- someone sets the lighting, adjusts for each group, and keeps the energy up

The difference is obvious side by side. A tablet with a ring light works fine for selfies. Our setup produces photos people actually want to print and keep.

Packages:
  2 hours -- $498
  ${stripeGeneral}

  3 hours -- $747
  ${stripe3hr}

  4 hours -- $996
  ${stripe4hr}

School, military and non-profit rate -- 20% off any package. Reply and we will quote it.

No commitment until deposit. Questions? Reply or call.

Warmly,

Joe Lee
Party Favor Photo
(202) 798-0610
partyfavorphoto.com`;

  // Template B: the school/military rate, at the real percentage.
  //
  // This used to advertise "save $100" and quote $398 / $647 / $896, which is the
  // old FLAT-$100 discount. It is dead code - `const body = templateA` - so
  // nothing wrong has been sent, but it is one edit away from going live with
  // prices the business does not charge.
  //
  // The real rate is 20% off Standard, rounded to the dollar, which is what the
  // published price column says: $398 / $598 / $796. Authoritative values live in
  // relay/lib/pfp-pricing.mjs (DISCOUNTS, PUBLISHED_DISCOUNTED); these figures
  // must match it.
  const templateB = `Hello again from Party Favor Photo,

If your event is a school function, a military gathering, or a non-profit event, reply and we will quote the discounted rate.

Here is what you already know about our setup -- professional DSLR camera with strobe lighting, not a tablet on a stick. The strobe flash creates clean, professional photos in any venue. Your guests see the difference immediately.

Standard packages:

  2 hours -- $498
  ${stripeGeneral}

  3 hours -- $747
  ${stripe3hr}

  4 hours -- $996
  ${stripe4hr}

No commitment until deposit. Questions? Reply or call.

Warmly,

Joe Lee
Party Favor Photo
(202) 798-0610
partyfavorphoto.com`;

  // A/B split: alternate based on email hash
  const body = templateA;
  const subject = 'The difference: DSLR + strobe vs tablet + ring light';
  
  // Build proper multipart email with HTML + plain text fallback
  const htmlBody = buildCampaignHtml(body);
  // Resend native API: https://resend.com/docs/api-reference/emails/send-email
  // Verified domain: partyfavorphoto.com (RESEND_API_KEY). Sends appear as
  // "Party Favor Photo <bookings@partyfavorphoto.com>". Replies route to joe@.
  const postData = JSON.stringify({
    from: FROM_ADDRESS,
    to: entry.email,
    subject,
    html: htmlBody,
    text: body,
    reply_to: REPLY_TO,
  });
  const req = https.request({
    host: RESEND_HOST,
    path: '/emails',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
  }, async (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', async () => {
      if (res.statusCode === 200 || res.statusCode === 201) {
        sent++;
        // Record BEFORE advancing. Resend has accepted the mail at this point, so
        // losing this row means that address can be emailed again in 30 days.
        let resendId = null;
        try { resendId = JSON.parse(data || '{}').id ?? null; } catch {}
        await recordDelivered(entry, resendId);
        console.log(`  [${sent}] Sent to ${entry.email}`);
      } else if (res.statusCode === 429) {
        // Rate limited by Resend (5 req/s cap). Re-queue to front, back off 2s.
        // Don't count as error and don't log as a failure.
        batch.unshift(entry);
        console.warn(`  [RATE] ${entry.email}: HTTP 429, re-queued (batch now ${batch.length})`);
        setTimeout(sendNext, 2000);
        return;
      } else {
        errors++;
        // Failures are recorded too. The old state file showed totalErrors: 434
        // next to totalSent: 0, which is what a counter looks like when only one
        // of its two branches writes.
        await recordFailure(query, (m) => console.error(m), {
          email: entry.email, name: entry.name, source: entry.source,
          region: entry.region, subject, status: 'error',
          detail: `HTTP ${res.statusCode} ${String(data).slice(0, 200)}`,
        });
        console.error(`  [ERR] ${entry.email}: HTTP ${res.statusCode} ${data.slice(0,200)}`);
      }
      setTimeout(sendNext, 250);
    });
  });
  req.on('error', async (err) => {
    errors++;
    await recordFailure(query, (m) => console.error(m), {
      email: entry.email, name: entry.name, source: entry.source,
      region: entry.region, subject, status: 'error', detail: err.message,
    });
    console.error(`  [ERR] ${entry.email}: ${err.message}`);
    setTimeout(sendNext, 250);
  });
  req.write(postData);
  req.end();
}

/**
 * Seed `sentCount` back onto the pool file so the batch selection stays truthful
 * across restarts. Once per run, not once per send: the file is 2.7 MB and a
 * write per email would be 50 serialised rewrites for no benefit.
 */
async function reconcilePool() {
  try {
    const { rows } = await query(
      `SELECT lower(email) AS email, count(*)::int AS n
         FROM public.pfp_campaign_sends WHERE status = 'sent' GROUP BY 1`);
    const counts = new Map(rows.map((r) => [r.email, r.n]));
    let changed = 0;
    for (const c of contacts) {
      if (!c || !c.email) continue;
      const n = counts.get(String(c.email).toLowerCase().trim());
      if (n !== undefined && c.sentCount !== n) { c.sentCount = n; changed++; }
    }
    if (changed > 0) {
      fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts));
      logLine(`pool: updated sentCount on ${changed} record(s)`);
    }
  } catch (e) {
    console.error(`pool reconcile failed (non-fatal): ${e.message}`);
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
await ensureCampaignSchema(query).catch((e) =>
  console.error(`campaign schema unavailable, sends will proceed unlogged: ${e.message}`));

logLine(
  `start  pool=${contacts.length} available=${available.length} target=${count} ` +
  `batch=${batch.length} suppressed=${suppressed.size} dedup30d=${recentCount}`
);

sendNext();
