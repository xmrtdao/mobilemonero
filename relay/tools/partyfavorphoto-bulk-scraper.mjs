#!/usr/bin/env node
/**
 * partyfavorphoto-bulk-scraper.mjs
 * Collects 5000+ event/PTSA contact emails for DC and Dallas areas.
 * Phase 2 uses direct Startpage.com HTML search (free, no captcha, no API key).
 */

import fs from 'fs';
import path from 'path';
import { fetchUrl, startpageSearch } from './search-provider.mjs';

const DATA_DIR = 'C:/Users/PureTrek/Desktop/xmrtdao/relay-data';
const CONTACTS_FILE = path.join(DATA_DIR, 'campaign-contacts.json');
const LOG_FILE = path.join(DATA_DIR, 'campaign.log');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TARGET = parseInt(process.argv.find(a => a.startsWith('--target='))?.split('=')[1]) || 5000;
const CONCURRENCY = 10;

let totalFound = 0, totalErrors = 0, lastSaveCount = 0;

const BLOCKED_DOMAINS = new Set([
  // Consumer email providers
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'protonmail.com', 'proton.me', 'zoho.com', 'yandex.com',
  'mail.com', 'inbox.com', 'fastmail.com', 'tutanota.com',
  // Social / share platforms
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'tiktok.com',
  'linkedin.com', 'youtube.com', 'snapchat.com', 'pinterest.com',
  'reddit.com', 'tumblr.com', 'whatsapp.com', 'telegram.org',
  'discord.com', 'discord.gg', 'twitch.tv', 'medium.com',
  // Non-real-person domains
  'example.com', 'example.org', 'example.net',
  'noreply', 'donotreply', 'no-reply', 'mailer-daemon',
  'unsubscribe', 'newsletter', 'mailchimp', 'sendgrid',
  'hubspot', 'constantcontact', 'mailgun', 'sendinblue', 'brevo',
  // Government / military (not our target for PFP)
  '.gov', '.mil',
]);

// Image extensions that are NOT valid TLDs — reject emails whose domain TLD is an image extension
const IMAGE_EXTENSIONS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','tiff','tif','avif','heic','heif','raw','psd','eps','ico']);

function isEmailAllowed(email) {
  const e = email.toLowerCase().trim();
  if (!e.includes('@')) return false;
  const [local, domain] = e.split('@');
  if (!domain || !domain.includes('.') || domain.length < 5) return false;
  // Reject emails whose domain TLD is an image extension (e.g. phone@1x.png)
  const tld = domain.split('.').pop().toLowerCase().replace(/[^a-z]/g, '');
  if (IMAGE_EXTENSIONS.has(tld)) return false;
  // Exact match
  if (BLOCKED_DOMAINS.has(domain)) return false;
  // Suffix match for .gov / .mil
  for (const blocked of BLOCKED_DOMAINS) {
    if (blocked.startsWith('.') && domain.endsWith(blocked)) return false;
  }
  // Substring match for known auto-email domains
  for (const blocked of BLOCKED_DOMAINS) {
    if (domain.includes(blocked)) return false;
  }
  // Block auto-generated local-parts
  if (/^(noreply|donotreply|no-?reply|mailer-?daemon|unsubscribe|newsletter|admin|support|info|contact|webmaster|postmaster|abuse|spam)/i.test(local)) return false;
  // Block suspicious multi-segment domains (likely spam traps)
  if ((domain.match(/\./g) || []).length >= 5) return false;
  return true;
}

function log(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(entry);
  try { fs.appendFileSync(LOG_FILE, entry); } catch {}
}

function extractEmails(text) {
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(regex) || [];
  return [...new Set(matches.filter(isEmailAllowed))];
}

// fetchUrl imported from search-provider.mjs

function loadExisting() {
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); } catch { return []; }
}

function saveContacts(contacts) {
  const unique = [];
  const seen = new Set();
  for (const c of contacts) {
    const key = c.email.toLowerCase().trim();
    if (!seen.has(key)) { seen.add(key); unique.push(c); }
  }
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(unique, null, 2));
  return unique;
}

function progressiveSave(newContacts) {
  const existing = loadExisting();
  const merged = [...existing, ...newContacts];
  const saved = saveContacts(merged);
  if (saved.length > lastSaveCount) {
    log(`  💾 Saved ${saved.length - lastSaveCount} new (pool: ${saved.length})`);
    lastSaveCount = saved.length;
  }
  return saved;
}

// ── Startpage.com search (free, no captcha, no API key) ───
async function searchScrape(query, region) {
  try {
    const urls = await startpageSearch(query);
    if (urls.length === 0) return [];
    const limit = Math.min(urls.length, 5);
    const emails = new Set();
    for (let i = 0; i < limit; i++) {
      try {
        const html = await fetchUrl(urls[i], 1);
        extractEmails(html).forEach(e => emails.add(e));
      } catch { /* skip failed page */ }
    }
    return [...emails].map(email => ({
      email: email.toLowerCase().trim(),
      source: `startpage: ${query}`,
      added: new Date().toISOString(),
      region,
      topics: 'web-search',
      status: 'pending',
    }));
  } catch {
    return [];
  }
}

// ── High-yield directory pages ──────────────────────────
const SOURCES = [
  // FCPS
  { url: 'https://www.fcps.edu/sites/default/files/media/pdf/contacts_7.pdf', region: 'Northern Virginia Washington DC' },
  { url: 'https://www.fcps.edu/resources/student-safety-and-wellness/school-psychologists', region: 'Northern Virginia Washington DC' },
  { url: 'https://www.fcps.edu/contact-us', region: 'Northern Virginia Washington DC' },
  // Virginia PTA
  { url: 'https://vapta.org/vapta-councils/', region: 'Northern Virginia Washington DC' },
  { url: 'https://vapta.org/contact-us', region: 'Northern Virginia Washington DC' },
  // DC public schools
  { url: 'https://dcps.dc.gov/page/schools', region: 'Northern Virginia Washington DC' },
  // Montgomery County
  { url: 'https://www.montgomeryschoolsmd.org/schools/', region: 'Northern Virginia Washington DC' },
  // Prince George's County
  { url: 'https://www.pgcps.org/schools/', region: 'Northern Virginia Washington DC' },
  // PWCS
  { url: 'https://www.pwcs.edu/about/school_directory', region: 'Northern Virginia Washington DC' },
  // Arlington VA
  { url: 'https://www.apsva.us/schools/', region: 'Northern Virginia Washington DC' },
  // Dallas ISD
  { url: 'https://www.dallasisd.org/schools', region: 'Dallas Fort Worth Texas' },
  // Frisco ISD
  { url: 'https://www.friscoisd.org/schools', region: 'Dallas Fort Worth Texas' },
  // Plano ISD
  { url: 'https://www.pisd.edu/schools', region: 'Dallas Fort Worth Texas' },
  // Allen ISD
  { url: 'https://www.allenisd.org/schools', region: 'Dallas Fort Worth Texas' },
  // McKinney ISD
  { url: 'https://www.mckinneyisd.net/schools/', region: 'Dallas Fort Worth Texas' },
  // Texas PTA
  { url: 'https://www.txpta.org/state-office', region: 'Dallas Fort Worth Texas' },
  // Arlington ISD TX
  { url: 'https://www.aisd.net/schools/', region: 'Dallas Fort Worth Texas' },
  // Garland ISD
  { url: 'https://www.garlandisd.net/schools', region: 'Dallas Fort Worth Texas' },
];

async function scrapeSource(src) {
  try {
    const html = await fetchUrl(src.url);
    const emails = extractEmails(html);
    return emails.map(email => ({
      email: email.toLowerCase().trim(),
      source: src.url,
      added: new Date().toISOString(),
      region: src.region,
      topics: 'school-directory',
      status: 'pending',
    }));
  } catch {
    totalErrors++;
    return [];
  }
}

// ── Main ────────────────────────────────────────────────
async function main() {
  log(`╔══════════════════════════════════════════╗`);
  log(`║  📸 PFP Bulk Scraper — Target: ${TARGET}  ║`);
  log(`╚══════════════════════════════════════════╝`);

  const start = Date.now();
  const existing = loadExisting();
  log(`Pool starts at: ${existing.length} contacts\n`);
  let allNew = [];

  // Phase 1: Fetch known high-yield directory pages
  log(`📋 Phase 1: ${SOURCES.length} directory pages...\n`);
  for (let i = 0; i < SOURCES.length; i += CONCURRENCY) {
    const batch = SOURCES.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(scrapeSource));
    for (const contacts of results) {
      allNew.push(...contacts);
      totalFound = allNew.length;
    }
    const pct = Math.min(100, Math.round((totalFound / TARGET) * 100));
    const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
    process.stdout.write(`\r  [${bar}] ${totalFound}/${TARGET} (${pct}%)`);

    if (allNew.length - lastSaveCount > 50) {
      progressiveSave(allNew);
    }
  }

  // Phase 2: Targeted searches via Startpage.com
  log(`\n\n🔍 Phase 2: Startpage searches for corporate holiday party contacts...\n`);
  const searches = [
    // DC area — corporate event planners & admin
    { q: 'Washington DC corporate event planner directory email', r: 'Northern Virginia Washington DC' },
    { q: 'Northern Virginia corporate event coordinator email contact', r: 'Northern Virginia Washington DC' },
    { q: 'Washington DC office administrator email directory', r: 'Northern Virginia Washington DC' },
    { q: 'DMV marketing director email list company', r: 'Northern Virginia Washington DC' },
    { q: 'Washington DC administrative assistant email contact', r: 'Northern Virginia Washington DC' },
    { q: 'Northern Virginia company holiday party planner email', r: 'Northern Virginia Washington DC' },
    { q: 'DC metro area events manager email directory', r: 'Northern Virginia Washington DC' },
    { q: 'Washington DC communications director email list', r: 'Northern Virginia Washington DC' },
    { q: 'Tysons Corner corporate office manager email', r: 'Northern Virginia Washington DC' },
    { q: 'Arlington Virginia business association member directory email', r: 'Northern Virginia Washington DC' },
    { q: 'Washington DC human resources manager email contact', r: 'Northern Virginia Washington DC' },
    { q: 'DMV professional association chapter email directory', r: 'Northern Virginia Washington DC' },
    { q: 'Washington DC facility manager email corporate events', r: 'Northern Virginia Washington DC' },
    { q: 'Northern Virginia chamber of commerce member email list', r: 'Northern Virginia Washington DC' },
    { q: 'DC area employee engagement coordinator email', r: 'Northern Virginia Washington DC' },
    { q: 'Northern Virginia marketing coordinator email directory', r: 'Northern Virginia Washington DC' },
    { q: 'Washington DC event production company email contact', r: 'Northern Virginia Washington DC' },
    { q: 'DMV venue manager email corporate events', r: 'Northern Virginia Washington DC' },

    // Dallas area — corporate event planners & admin
    { q: 'Dallas Fort Worth corporate event planner email directory', r: 'Dallas Fort Worth Texas' },
    { q: 'Dallas Texas office manager email corporate events', r: 'Dallas Fort Worth Texas' },
    { q: 'Fort Worth administrative assistant email directory', r: 'Dallas Fort Worth Texas' },
    { q: 'Dallas marketing director email list company', r: 'Dallas Fort Worth Texas' },
    { q: 'Dallas Fort Worth event coordinator email contact', r: 'Dallas Fort Worth Texas' },
    { q: 'Dallas Texas human resources manager email directory', r: 'Dallas Fort Worth Texas' },
    { q: 'Dallas company holiday party committee email', r: 'Dallas Fort Worth Texas' },
    { q: 'Fort Worth chamber of commerce member email list', r: 'Dallas Fort Worth Texas' },
    { q: 'Dallas Fort Worth communications director email', r: 'Dallas Fort Worth Texas' },
    { q: 'Plano Texas corporate events manager email', r: 'Dallas Fort Worth Texas' },
    { q: 'Dallas professional association directory email', r: 'Dallas Fort Worth Texas' },
    { q: 'Fort Worth facility manager email corporate events', r: 'Dallas Fort Worth Texas' },
    { q: 'Dallas venue manager corporate events email', r: 'Dallas Fort Worth Texas' },
    { q: 'Dallas Fort Worth employee experience manager email', r: 'Dallas Fort Worth Texas' },
    { q: 'Irving Texas corporate office administrator email', r: 'Dallas Fort Worth Texas' },
    { q: 'Dallas Fort Worth catering manager email directory', r: 'Dallas Fort Worth Texas' },
    { q: 'North Texas event production company email contact', r: 'Dallas Fort Worth Texas' },
    { q: 'Dallas Fort Worth business association member email', r: 'Dallas Fort Worth Texas' },
  ];

  for (let i = 0; i < searches.length; i++) {
    const s = searches[i];
    const contacts = await searchScrape(s.q, s.r);
    allNew.push(...contacts);
    totalFound = allNew.length;
    if (contacts.length > 0) {
      log(`  ✓ "${s.q.slice(0, 55)}" → ${contacts.length} emails`);
    } else {
      log(`  · "${s.q.slice(0, 55)}" → 0`);
    }

    if (allNew.length - lastSaveCount > 100) {
      progressiveSave(allNew);
    }
  }

  // Final save
  log(`\n📦 Final merge...`);
  const merged = [...existing, ...allNew];
  const saved = saveContacts(merged);
  const elapsed = Math.round((Date.now() - start) / 1000);

  log(`\n╔══════════════════════════════════════════╗`);
  log(`║  ✅ DONE in ${elapsed}s                    ║`);
  log(`║  Found: ${allNew.length} new contacts      ║`);
  log(`║  Pool: ${saved.length} total               ║`);
  log(`║  Errors: ${totalErrors}                    ║`);
  log(`╚══════════════════════════════════════════╝\n`);
}

main().catch(e => {
  log(`\n❌ Fatal: ${e.message}`);
  process.exit(1);
});