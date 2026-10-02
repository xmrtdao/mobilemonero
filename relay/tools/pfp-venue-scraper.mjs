#!/usr/bin/env node
/**
 * PFP Venue Directory Scraper — scrapes actual venue listing sites
 * Targets: Eventective, WeddingWire, Peerspace, venue-specific directories
 * Gets emails for event spaces in DC/MD/VA metro
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
const SB_URL = process.env.SUPABASE_URL || env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SB_PARSED = new URL(SB_URL);
const SB_HTTP = SB_PARSED.protocol === 'https:' ? https : http;

// Use explore-curiosity but with very specific directory-focused queries
async function exploreTopic(seedTopic) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ seed_topic: seedTopic });
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
        catch { resolve({ insights: [] }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Image extensions that are NOT valid TLDs — reject emails whose domain TLD is an image extension
const IMAGE_EXTENSIONS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','tiff','tif','avif','heic','heif','raw','psd','eps','ico']);

function extractEmails(text) {
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const found = text.match(regex) || [];
  return found.filter(e => {
    const parts = e.split('@');
    if (parts.length !== 2) return false;
    const tld = parts[1].split('.').pop().toLowerCase().replace(/[^a-z]/g, '');
    return !IMAGE_EXTENSIONS.has(tld);
  });
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function loadContacts() {
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); }
  catch { return []; }
}

function saveContacts(contacts) {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
}

// ── TARGET: Specific venue directory URLs to explore ─────
// Instead of generic search queries, we target actual directory pages
// that list venues with contact info
const VENUE_DIRECTORIES = [
  // Eventective — DC area venue listings
  'site:eventective.com "Washington DC" venue email',
  'site:eventective.com Virginia wedding venue contact',
  'site:eventective.com Maryland event venue rental',
  
  // WeddingWire vendor lists
  'site:weddingwire.com "Washington DC" venue coordinator email',
  'site:weddingwire.com Virginia wedding venue manager',
  'site:weddingwire.com Maryland event space contact',
  
  // The Knot venue directory
  'site:theknot.com "Washington DC" venue email contact',
  'site:theknot.com Virginia wedding venue director',
  
  // Peerspace / event rental directories
  'site:peerspace.com Washington DC event space host',
  'site:peerspace.com Arlington VA party venue',
  
  // Specific venue types — DC
  '"venue coordinator" "Washington DC" email',
  '"event manager" "Washington DC" hotel wedding',
  '"director of events" "Washington DC" email',
  
  // Specific venue types — Virginia
  '"event coordinator" Arlington VA hotel email',
  '"wedding coordinator" Alexandria VA venue email',
  '"banquet manager" Fairfax VA country club email',
  
  // Specific venue types — Maryland
  '"event manager" Bethesda MD hotel email',
  '"venue director" Silver Spring MD email',
  
  // Photo booth friendly venues (directories that list preferred vendors)
  '"preferred vendor" "photo booth" Washington DC list',
  '"vendor list" "photo booth" Arlington VA wedding',
  
  // Hotel event spaces — specific chains
  'Hilton Arlington VA event manager email',
  'Marriott Washington DC wedding coordinator email',
  'Hyatt Regency Reston event sales email',
  'Ritz-Carlton DC event planning contact email',
  'Four Seasons Washington DC event coordinator email',
  'JW Marriott Washington DC banquet manager email',
  
  // Historic venues
  'Torpedo Factory Alexandria VA event rental email',
  'DAR Constitution Hall Washington DC event contact',
  'Anderson House Washington DC wedding venue email',
  'Decatur House Washington DC private event email',
  
  // Unique spaces
  '"private event" "Washington DC" rooftop terrace email',
  'Washington DC art gallery event rental contact email',
];

async function main() {
  log('╔══════════════════════════════════════════════════╗');
  log('║  PFP Venue Directory Scraper                    ║');
  log('║  Target: DC/MD/VA venue contacts from directories║');
  log('╚══════════════════════════════════════════════════╝');
  
  let contacts = loadContacts();
  const existingEmails = new Set(contacts.map(c => c.email?.toLowerCase()).filter(Boolean));
  let totalNew = 0;
  let totalQueries = VENUE_DIRECTORIES.length;

  for (let i = 0; i < VENUE_DIRECTORIES.length; i++) {
    const query = VENUE_DIRECTORIES[i];
    log(`\n[${i+1}/${totalQueries}] ${query}`);
    
    try {
      const data = await exploreTopic(query);
      const sources = data?.insights || [];
      let newCount = 0;
      
      for (const s of sources) {
        const text = `${s.title || ''} ${(s.highlights || []).join(' ')} ${s.snippet || ''}`;
        const emails = extractEmails(text);
        
        // Get venue name from title
        let venueName = (s.title || '').replace(/\s*\|\s*.*$/, '').trim();
        if (venueName.length > 60) venueName = venueName.substring(0, 60);
        
        for (const email of emails) {
          const cleanEmail = email.toLowerCase().trim();
          // Skip generic/no-reply emails
          if (cleanEmail.includes('noreply') || cleanEmail.includes('no-reply') || 
              cleanEmail.includes('example.com') || cleanEmail.includes('@domain.com')) continue;
          if (cleanEmail && !existingEmails.has(cleanEmail)) {
            // Determine region from query
            let region = 'DC Metro';
            if (query.includes('Arlington') || query.includes('Alexandria') || query.includes('Fairfax') || 
                query.includes('Reston') || query.includes('Virginia')) region = 'Northern VA';
            else if (query.includes('Bethesda') || query.includes('Silver Spring') || query.includes('Maryland')) region = 'MD';
            else if (query.includes('Washington DC')) region = 'Washington DC';
            
            contacts.push({
              email: cleanEmail,
              name: venueName || '',
              venue: venueName || '',
              source: s.url || query,
              region: region,
              topics: 'venue, event space',
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
        log(`  +${newCount} new contacts`);
        const recent = contacts.slice(-Math.min(newCount, 3));
        recent.forEach(c => log(`  -> ${c.email} — ${c.name || c.venue || '?'}`));
      } else {
        log(`  ${sources.length} sources, 0 new`);
      }
      
      saveContacts(contacts);
      await new Promise(r => setTimeout(r, 1500));
      
    } catch (e) {
      log(`  ERROR: ${e.message}`);
    }
  }

  log(`\n========================================`);
  log(`DONE — ${totalQueries} queries, ${totalNew} new contacts`);
  log(`Pool total: ${contacts.length}`);
  log(`========================================`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
