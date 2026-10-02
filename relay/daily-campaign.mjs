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
const LOG_FILE = path.join(__dirname, '..', 'relay-data', 'campaign.log');
const SENT_FILE = path.join(__dirname, '..', 'relay-data', 'campaign-sent.json');
const SUPPRESSION_FILE = path.join(__dirname, '..', 'relay-data', 'suppression-list.json');

function loadSuppression() {
  try {
    if (fs.existsSync(SUPPRESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SUPPRESSION_FILE, 'utf8'));
      return new Set(data.suppressed || []);
    }
  } catch {}
  return new Set();
}

// Load contacts, mark sent ones
let contacts = [];
try { contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); } catch { contacts = []; }

let sentHistory = [];
try { sentHistory = JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')); } catch { sentHistory = []; }

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

// Filter out already-sent emails (last 30 days) and suppressed
const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
const recentSent = new Set(sentHistory.filter(s => s.ts > cutoff).map(s => s.email));
const suppressed = loadSuppression();

let available = contacts.filter(c => !recentSent.has(c.email) && isRealEmail(c.email));

if (suppressed.size > 0) {
  const blocked = available.filter(c => suppressed.has(c.email));
  if (blocked.length > 0) {
    console.log(`[Campaign] Skipping ${blocked.length} suppressed contacts`);
    available = available.filter(c => !suppressed.has(c.email));
  }
}

// Pick 50, prioritizing untried ones
const day = new Date().getDate();
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

let sent = 0, errors = 0;
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

function appendSent(email) {
  sentHistory.push({ email, ts: Date.now() });
  fs.writeFileSync(SENT_FILE, JSON.stringify(sentHistory, null, 2));
}

function sendNext() {
  if (batch.length === 0 || sent + errors >= count) {
    const summary = `[${new Date().toISOString()}] Campaign: ${sent} sent, ${errors} errors`;
    console.log(summary);
    fs.appendFileSync(LOG_FILE, summary + '\n');
    releaseLock();
    return;
  }
  const entry = batch.shift();
  
  // Double-check this email hasn't been sent already (defense in depth)
  const recentSentCheck = new Set(sentHistory.filter(s => s.ts > Date.now() - 30*24*60*60*1000).map(s => s.email));
  if (recentSentCheck.has(entry.email)) {
    // Already sent in this session -�" skip
    sent++;
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

Military and non-profit rate -- $398. Just reply.

No commitment until deposit. Questions? Reply or call.

Warmly,

Joe Lee
Party Favor Photo
(202) 798-0610
partyfavorphoto.com`;

  // Template B: Limited time $100 off (A/B test)
  const COUPON_CODE = 'STUDIO100';
  const templateB = `Hello again from Party Favor Photo,

We are running a limited-time offer for our past clients and wanted you to be the first to know.

For the next 30 days, save $100 on any StudioStation package.

Here is what you already know about our setup -- professional DSLR camera with strobe lighting, not a tablet on a stick. The strobe flash creates clean, professional photos in any venue. Your guests see the difference immediately.

Packages at the discounted rate (limited time):

  2 hours -- $398 (regularly $498)
  ${stripeGeneral}

  3 hours -- $647 (regularly $747)
  ${stripe3hr}

  4 hours -- $896 (regularly $996)
  ${stripe4hr}

Offer ends in 30 days. No commitment until deposit. Questions? Reply or call.

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
  }, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode === 200 || res.statusCode === 201) {
        sent++;
        appendSent(entry.email);
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
        console.error(`  [ERR] ${entry.email}: HTTP ${res.statusCode} ${data.slice(0,200)}`);
      }
      setTimeout(sendNext, 250);
    });
  });
  req.on('error', (err) => {
    errors++;
    console.error(`  [ERR] ${entry.email}: ${err.message}`);
    setTimeout(sendNext, 250);
  });
  req.write(postData);
  req.end();
}

console.log(`Pool: ${contacts.length}, Available: ${available.length}, Target: ${count}, Sending: ${batch.length}`);
sendNext();
