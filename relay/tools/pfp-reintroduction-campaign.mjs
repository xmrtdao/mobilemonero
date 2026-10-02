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
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = env.RESEND_API_KEY;
const SB = env.SUPABASE_URL || 'http://127.0.0.1:54321';

if (!SUPABASE_KEY || !RESEND_KEY) {
  console.error('Missing API keys');
  process.exit(1);
}

// Load sent log
let sentLog = [];
if (existsSync(SENT_LOG)) {
  try { sentLog = JSON.parse(readFileSync(SENT_LOG, 'utf-8')); } catch {}
}

const sentEmails = new Set(sentLog.map(e => e.email));

const REINTRO_SUBJECT = 'Party Favor Photo — We\'re Better Than Ever';
const REINTRO_BODY = `Hi there,

It's been a while! We wanted to reach out and reconnect with our past clients.

Party Favor Photo is back and better than ever. We've added exciting new AI-powered features to our photo booth services while keeping everything you already loved:

✨ AI-generated custom backgrounds and filters in real-time
📸 StudioStation — our premium open-air photo booth with professional studio lighting
🎬 360 Video Platform for unforgettable event moments
🖼️ Instant AI art prints — watercolor portraits, keychain photos, and more

Whether you need a photo booth for a wedding, corporate event, school function, or private party — we'd love to help make it special.

As a past client, we'd love to offer you a preferred pricing rate. Just reply to this email to learn more or book.

Let's create something fun together!

Best,
Joe
Party Favor Photo
(202) 798-0610
www.partyfavorphoto.com`;

async function getUnsentContacts(limit) {
  // Get leads that haven't been contacted yet - prioritize VSCO imports with past revenue
  const url = `${SB}/rest/v1/pfp_leads?select=contact_email,contact_name,status,notes&or=(status.eq.lead,status.eq.vsco_import)&order=created_at.asc&limit=${limit * 2}`;
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + SUPABASE_KEY, apikey: SUPABASE_KEY }
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  
  // Filter out already sent
  return data.filter(r => !sentEmails.has(r.contact_email) && r.contact_email).slice(0, limit);
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
