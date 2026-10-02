#!/usr/bin/env node
/**
 * PFP Venue Contact Finder — Exa Search powered
 * Uses exa-search-function edge function for high-quality web search
 * Targets every event venue in DC/MD/VA metro, one city at a time
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

const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZhd291dWd0endtZWp4cWtlcXFqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Mjc2OTcxMiwiZXhwIjoyMDY4MzQ1NzEyfQ.QH0k26R2xbf4U5z6BmdYG1h_lkeNQ41zDjqL2zWxzxU';
const SB_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SB_PARSED = new URL(SB_URL);
const SB_HTTP = SB_PARSED.protocol === 'https:' ? https : http;

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

function extractEmails(text) {
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  return text.match(regex) || [];
}

// Call exa-search-function edge function
async function exaSearch(query) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query });
    const opts = {
      hostname: SB_PARSED.hostname,
      port: SB_PARSED.port || (SB_PARSED.protocol === 'https:' ? 443 : 80),
      path: '/functions/v1/exa-search-function',
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
        catch { resolve({ results: [] }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── VENUE QUERIES — one per city, exa finds the actual venues ──
const VENUE_QUERIES = [
  // Washington DC — comprehensive venue list
  'list of all wedding venues and event spaces in Washington DC with contact email addresses',
  'Washington DC hotel event spaces banquet rooms wedding coordinators email list',
  'Washington DC museum venue private event rental contact information',
  'Washington DC rooftop terrace venue private party contact email',
  'Washington DC art gallery event space rental coordinator email',
  
  // Arlington VA
  'Arlington Virginia wedding venues event spaces contact email directory',
  'Arlington VA hotel banquet rooms event coordinators email addresses',
  'Arlington VA community centers country clubs private event contacts',
  
  // Alexandria VA
  'Alexandria Virginia historic wedding venues event spaces contact email',
  'Alexandria VA waterfront venue banquet hall event coordinator email',
  'Alexandria VA hotel ballroom meeting space event manager email',
  
  // Fairfax County
  'Fairfax Virginia wedding venue event space rental contact email list',
  'Fairfax VA country clubs banquet halls event coordinator email',
  'Reston Herndon Vienna Virginia wedding venues event contacts',
  
  // Maryland suburbs
  'Bethesda Maryland wedding venues event spaces contact email directory',
  'Silver Spring Maryland event venue rental contact information',
  'Rockville Maryland banquet hall wedding venue coordinator email',
  
  // Photo booth specific
  'Washington DC wedding venues that allow outside vendors photo booth list',
  'Virginia wedding venues preferred vendor list photo booth email',
  'hotels in Washington DC with event space wedding coordinator direct email',
];

// ── RUN ────────────────────────────────────────────────────
async function main() {
  log('╔══════════════════════════════════════════════════╗');
  log('║  PFP Venue Finder — Exa Search                  ║');
  log('║  Finding venue contacts across DC/MD/VA metro   ║');
  log('╚══════════════════════════════════════════════════╝');
  
  let contacts = loadContacts();
  const existingEmails = new Set(contacts.map(c => c.email?.toLowerCase()).filter(Boolean));
  let totalNew = 0;
  
  log(`Starting pool: ${contacts.length} contacts`);

  for (let i = 0; i < VENUE_QUERIES.length; i++) {
    const query = VENUE_QUERIES[i];
    log(`\n[${i+1}/${VENUE_QUERIES.length}] ${query.substring(0, 100)}...`);
    
    try {
      const data = await exaSearch(query);
      const results = data?.results || [];
      
      if (results.length === 0) {
        log(`  No results`);
        continue;
      }
      
      // Extract venue names and emails from results
      let newCount = 0;
      for (const r of results) {
        const title = r.title || '';
        const url = r.url || '';
        
        // Exa returns text/highlights in results
        const resultText = [title, r.text || '', r.highlight || '', (r.highlights || []).join(' ')].join(' ');
        const emails = extractEmails(resultText);
        
        // Determine region from result
        let region = 'DC Metro';
        const fullText = (title + ' ' + url + ' ' + (r.text || '')).toLowerCase();
        if (fullText.includes('arlington') || fullText.includes('alexandria') || fullText.includes('fairfax') || fullText.includes('reston') || fullText.includes('herndon') || fullText.includes('vienna') || fullText.includes('virginia')) region = 'Northern VA';
        else if (fullText.includes('bethesda') || fullText.includes('silver spring') || fullText.includes('rockville') || fullText.includes('maryland')) region = 'MD Suburbs';
        else if (fullText.includes('washington dc') || fullText.includes('washington, dc') || fullText.includes('washington d.c.')) region = 'Washington DC';
        
        for (const email of emails) {
          const clean = email.toLowerCase().trim();
          if (clean.includes('noreply') || clean.includes('example') || clean.includes('@domain')) continue;
          if (!existingEmails.has(clean)) {
            contacts.push({
              email: clean,
              name: title.replace(/\s*\|\s*.*$/, '').trim().substring(0, 60) || '',
              venue: title.replace(/\s*\|\s*.*$/, '').trim().substring(0, 60) || '',
              source: url || query,
              region: region,
              topics: 'venue, event space',
              added: new Date().toISOString(),
              status: 'pending',
            });
            existingEmails.add(clean);
            newCount++;
          }
        }
      }
      
      totalNew += newCount;
      log(`  ${results.length} results → ${newCount} new emails`);
      
      // Show samples
      if (newCount > 0) {
        const samples = contacts.slice(-Math.min(newCount, 3));
        samples.forEach(c => log(`  ✓ ${c.email} — ${c.name || c.venue || c.region}`));
      }
      
      saveContacts(contacts);
      
    } catch (e) {
      log(`  ERROR: ${e.message}`);
    }
  }

  log(`\n========================================`);
  log(`DONE — ${VENUE_QUERIES.length} searches`);
  log(`New contacts: ${totalNew}`);
  log(`Pool total: ${contacts.length}`);
  log(`========================================`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
