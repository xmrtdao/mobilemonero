#!/usr/bin/env node
/**
 * PFP Venue Contact Finder — explore-curiosity driven
 * Scrapes every event venue, banquet hall, wedding space, and community center
 * in Arlington VA, Washington DC, Alexandria VA, and surrounding cities.
 * One city at a time, venue by venue.
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'relay-data');
const CONTACTS_FILE = path.join(DATA_DIR, 'campaign-contacts.json');
const LOG_FILE = path.join(DATA_DIR, 'campaign.log');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Load env
const envPath = path.join(__dirname, '..', '.env');
const env = fs.readFileSync(envPath, 'utf8').split('\n').reduce((acc, line) => {
  const [k, ...v] = line.split('=');
  if (k) acc[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
  return acc;
}, {});
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const SB_URL = process.env.SUPABASE_URL || env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SB_PARSED = new URL(SB_URL);
const SB_HTTP = SB_PARSED.protocol === 'https:' ? https : http;

// ── CITIES & VENUE TYPES ──────────────────────────────────
const CITIES = [
  { city: 'Arlington', state: 'VA', queries: [
    'Arlington VA wedding venue event space rental contact email',
    'Arlington VA banquet hall party venue coordinator email',
    'Arlington VA community center event rental manager email',
    'Arlington VA hotel event space wedding coordinator email',
    'Arlington VA country club private event contact email',
  ]},
  { city: 'Alexandria', state: 'VA', queries: [
    'Alexandria VA wedding venue event space rental contact email',
    'Alexandria VA banquet hall party venue coordinator email',
    'Alexandria VA historic venue event rental manager email',
    'Alexandria VA hotel ballroom event coordinator email',
    'Alexandria VA waterfront venue private event contact email',
  ]},
  { city: 'Washington', state: 'DC', queries: [
    'Washington DC wedding venue event space rental contact email',
    'Washington DC banquet hall gala venue coordinator email',
    'Washington DC hotel ballroom event manager email',
    'Washington DC museum event rental private party contact email',
    'Washington DC corporate event space venue director email',
  ]},
  { city: 'Fairfax', state: 'VA', queries: [
    'Fairfax VA wedding venue event space contact email',
    'Fairfax VA banquet hall community center rental email',
    'Fairfax VA country club event coordinator email',
  ]},
  { city: 'Bethesda', state: 'MD', queries: [
    'Bethesda MD wedding venue event space rental contact email',
    'Bethesda MD banquet hall hotel event coordinator email',
  ]},
  { city: 'Silver Spring', state: 'MD', queries: [
    'Silver Spring MD event venue wedding space rental contact email',
    'Silver Spring MD community center event manager email',
  ]},
  { city: 'Falls Church', state: 'VA', queries: [
    'Falls Church VA event venue wedding reception contact email',
    'Falls Church VA community center rental email',
  ]},
  { city: 'McLean', state: 'VA', queries: [
    'McLean VA wedding venue event space contact email',
    'McLean VA country club private event coordinator email',
  ]},
  { city: 'Reston', state: 'VA', queries: [
    'Reston VA event venue wedding space rental contact email',
    'Reston VA community center event manager email',
  ]},
  { city: 'Vienna', state: 'VA', queries: [
    'Vienna VA event venue wedding reception contact email',
    'Vienna VA community center party rental email',
  ]},
];

// ── HELPER: POST to Supabase explore-curiosity ────────────
function postJson(topic) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ seed_topic: topic });
    const opts = {
      hostname: SB_PARSED.hostname,
      port: SB_PARSED.port || (SB_PARSED.protocol === 'https:' ? 443 : 80),
      path: '/functions/v1/explore-curiosity',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = SB_HTTP.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'parse error', raw: data.slice(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Extract emails from text
function extractEmails(text) {
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  return text.match(regex) || [];
}

// Extract venue name from source
function extractVenue(text, url) {
  const lines = text.split('\n').filter(l => l.trim().length > 10);
  for (const line of lines.slice(0, 3)) {
    if (line.length < 100 && !line.includes('@') && !line.includes('http')) return line.trim();
  }
  if (url) {
    const match = url.match(/https?:\/\/(?:www\.)?([^.]+)/);
    if (match) return match[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }
  return '';
}

// ── LOGGING ────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ── LOAD / SAVE CONTACTS ──────────────────────────────────
function loadContacts() {
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); }
  catch { return []; }
}

function saveContacts(contacts) {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
}

// ── RUN ────────────────────────────────────────────────────
async function main() {
  log('╔══════════════════════════════════════════════════╗');
  log('║  PFP Venue Contact Finder — DC Metro Venues     ║');
  log('╚══════════════════════════════════════════════════╝');
  
  const startTime = Date.now();
  let contacts = loadContacts();
  const existingEmails = new Set(contacts.map(c => c.email?.toLowerCase()).filter(Boolean));
  let totalNew = 0;
  let totalQueries = 0;

  for (const city of CITIES) {
    log(`\n=== ${city.city}, ${city.state} — ${city.queries.length} venue queries ===`);
    
    for (const query of city.queries) {
      totalQueries++;
      log(`\n[${totalQueries}] "${query}"`);
      
      try {
        const data = await postJson(query);
        const sources = data?.insights || [];
        
        if (sources.length > 0) {
          let newCount = 0;
          for (const s of sources) {
            const text = `${s.title || ''} ${(s.highlights || []).join(' ')} ${s.snippet || ''}`;
            const emails = extractEmails(text);
            const venue = extractVenue(text, s.url);
            
            for (const email of emails) {
              const cleanEmail = email.toLowerCase().trim();
              if (cleanEmail && !existingEmails.has(cleanEmail)) {
                contacts.push({
                  email: cleanEmail,
                  name: venue || s.title || '',
                  venue: venue || '',
                  source: s.url || query,
                  region: `${city.city}, ${city.state}`,
                  topics: `venue, event space, ${city.city}`,
                  added: new Date().toISOString(),
                  status: 'pending',
                });
                existingEmails.add(cleanEmail);
                newCount++;
              }
            }
          }
          
          totalNew += newCount;
          if (newCount > 0) {
            log(`  +${newCount} new (from ${sources.length} sources)`);
            // Show up to 2 samples
            const recent = contacts.slice(-Math.min(newCount, 2));
            recent.forEach(c => log(`  -> ${c.email} — ${c.name}`));
          } else {
            log(`  ${sources.length} sources, 0 new (all duplicates)`);
          }
        } else {
          log(`  No results`);
        }
        
        // Save after every query
        saveContacts(contacts);
        
        // Brief pause
        await new Promise(r => setTimeout(r, 2000));
        
      } catch (e) {
        log(`  ERROR: ${e.message}`);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log(`\n========================================`);
  log(`DONE in ${elapsed} min`);
  log(`Cities: ${CITIES.length} | Queries: ${totalQueries}`);
  log(`New contacts: ${totalNew} | Pool total: ${contacts.length}`);
  log(`========================================`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
