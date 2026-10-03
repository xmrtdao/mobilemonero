#!/usr/bin/env node
/**
 * PFP Re-introduction Campaign
 * Sends re-introduction + AI enhancement emails to past clients.
 * Daily limit: 100/day (Resend free tier)
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');
const SENT_LOG = join(__dirname, '..', '..', 'relay-data', 'pfp-reintro-sent.json');

function loadEnv() {
  const env = {};
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#')) {
        const eq = t.indexOf('=');
        if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
      }
    }
  }
  return env;
}

const env = loadEnv();
const RESEND_KEY = env.RESEND_API_KEY;

// Postgres runs directly on 127.0.0.1:5432 (db xmrt_suite). The PostgREST shim
// on 54321 talks to the same database and is used elsewhere in the relay, but
// this tool reads through the pool so it can filter on source_code.
if (env.LOCAL_DATABASE_URL) process.env.LOCAL_DATABASE_URL = env.LOCAL_DATABASE_URL;
const { getPool } = await import('../jobby/store.mjs');

if (!RESEND_KEY || !env.LOCAL_DATABASE_URL) {
  console.error('Missing RESEND_API_KEY or LOCAL_DATABASE_URL in .env');
  process.exit(1);
}

// Load sent log
let sentLog = [];
if (existsSync(SENT_LOG)) {
  try { sentLog = JSON.parse(readFileSync(SENT_LOG, 'utf-8')); } catch {}
}

const sentEmails = new Set(sentLog.map(e => e.email));

const REINTRO_SUBJECT = 'Party Favor Photo — We\'re Better Than Ever';
// ─────────────────────────────────────────────────────────────────────────────
// WHO THIS IS FOR
//
// VSCO was the previous CMS. `vsco_import` means these people booked us BEFORE,
// which is what makes "it's been a while" true and the offer fair.
//
// DO NOT point this at cold scraped contacts. A person who has never heard of us
// receiving "we'd love to reconnect with our past clients" and a preferred rate
// is worse than no email at all. Scraped leads are `scraped_ai` /
// `scraped_wedding` and are reached by the outbound campaign instead, which
// already sends six times a day to cold contacts and delivers cleanly.
//
// The emoji and em-dashes below are CORRECT and were not touched. Reading this
// file through PowerShell's Get-Content renders them as "?" and "-", which
// looks exactly like mojibake and is not. Editing them "to fix the encoding"
// would have damaged the file. This is the same PowerShell 5.1 UTF-8 mis-decode
// that has bitten this estate repeatedly: the reader was wrong, not the data.
//
// What DID change is the pricing line below. It promised "a preferred pricing
// rate", which contradicts the pricing rule - default price stands unless the
// owner directs a discount. The reply path still works; it just no longer
// advertises a discount nobody has authorised.
// ─────────────────────────────────────────────────────────────────────────────
const REINTRO_BODY = `Hi there,

It's been a while! We wanted to reach out and reconnect with our past clients.

Party Favor Photo is back and better than ever. We've added exciting new AI-powered features to our photo booth services while keeping everything you already loved:

✨ AI-generated custom backgrounds and filters in real-time
📸 StudioStation — our premium open-air photo booth with professional studio lighting
🎬 360 Video Platform for unforgettable event moments
🖼️ Instant AI art prints — watercolor portraits, keychain photos, and more

Whether you need a photo booth for a wedding, corporate event, school function, or private party — we'd love to help make it special.

Reply to this email and we'll send current pricing and availability for your date.

Let's create something fun together!

Best,
Joe
Party Favor Photo
(202) 798-0610
www.partyfavorphoto.com`;

/**
 * Past clients we have not re-introduced to yet.
 *
 * READ PATH ONLY. The Resend send below is untouched, because that tool has
 * real send history (50 delivered on 2026-05-22) and a mistake there reaches
 * clients. This query was migrated off the PostgREST shim to the same direct
 * pool the rest of the relay uses, for two reasons:
 *
 *   1. It can filter on `source_code`, which is how we distinguish backfilled
 *      VSCO clients from cold scraped contacts. PostgREST cannot express that
 *      cleanly and the old query fell back to `status IN ('lead','vsco_import')`,
 *      which mixes categories that must never share an email.
 *   2. It reads the same database the checkout and webhook code write to, so
 *      there is no second connection that can be looking at a different state.
 *
 * Only `vsco_import` is selected. A `scraped_*` row is someone who has never
 * heard of us, and telling them "it's been a while, we'd love to reconnect with
 * our past clients" is the wrong email to that person entirely.
 */
async function getUnsentContacts(limit) {
  const pool = await getPool();
  try {
    const { rows } = await pool.query(
      `SELECT contact_email, contact_name, status, notes
         FROM public.pfp_leads
        WHERE source_code = 'vsco_import'
          AND contact_email IS NOT NULL
          AND contact_email <> ''
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit * 2]
    );
    // Filter out already sent, in JS: sentLog is a file, not a table.
    return rows
      .filter((r) => !sentEmails.has(r.contact_email))
      .slice(0, limit);
  } finally {
    await pool.end();
  }
}

async function sendEmail(to, subject, text) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Party Favor Photo <bookings@partyfavorphoto.com>',
      to: [to],
      subject,
      text,
    }),
  });
  const data = await res.json();
  return { ok: res.ok, id: data.id, error: data.message };
}

async function main() {
  const batchSize = 50; // Start with 50 to test
  console.log(`=== PFP Re-introduction Campaign ===`);
  console.log(`Already sent: ${sentLog.length}`);
  
  const contacts = await getUnsentContacts(batchSize);
  console.log(`Contacts to send: ${contacts.length}`);
  
  if (contacts.length === 0) {
    console.log('No unsent contacts found.');
    return;
  }
  
  let sent = 0, errors = 0;
  
  for (const c of contacts) {
    const email = c.contact_email;
    // Personalize if we have a name
    const name = c.contact_name || email.split('@')[0];
    const body = `Hi ${name},\n\n${REINTRO_BODY.split('\n').slice(1).join('\n')}`;
    
    const result = await sendEmail(email, REINTRO_SUBJECT, body);
    if (result.ok) {
      sent++;
      sentLog.push({ email, name, ts: new Date().toISOString(), id: result.id });
      console.log(`  [${sent}] Sent to ${email}`);
    } else {
      errors++;
      console.error(`  [ERR] ${email}: ${result.error}`);
    }
    
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Save sent log
  writeFileSync(SENT_LOG, JSON.stringify(sentLog, null, 2));
  
  console.log(`\nSent: ${sent}, Errors: ${errors}`);
  console.log(`Total sent all time: ${sentLog.length}`);
  console.log('Done.');
}

main().catch(console.error);
