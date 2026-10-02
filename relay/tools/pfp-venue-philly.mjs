#!/usr/bin/env node
/**
 * PFP Venue Finder — Philadelphia / PA-NJ
 * Exa-search-powered venue contact scraping for Peter's territory
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

const VENUE_QUERIES = [
  // Philadelphia
  'Philadelphia Pennsylvania wedding venues event spaces contact email directory',
  'Philadelphia hotel banquet rooms event coordinators email addresses',
  'Philadelphia museum art gallery private event rental contact email',
  'Philadelphia rooftop venue ballroom event coordinator email',
  'Philadelphia country club wedding venue contact information email',
  
  // Pennsylvania suburbs
  'Philadelphia suburbs Main Line wedding venues event contact email',
  'Bucks County Pennsylvania wedding venues event space rental email',
  'King of Prussia Pennsylvania event venue banquet manager email',
  'Valley Forge Pennsylvania wedding venue coordinator contact email',
  
  // New Jersey near Philly
  'Cherry Hill New Jersey wedding venues event spaces contact email',
  'Princeton New Jersey wedding venue event coordinator email',
  'New Brunswick New Jersey event venue banquet manager email',
  'Atlantic City New Jersey hotel event space wedding coordinator email',
  
  // South Jersey
  'Camden County New Jersey wedding venue event rental contact email',
  'Burlington County New Jersey banquet hall party venue email',
  
  // Central PA
  'Lancaster Pennsylvania wedding venue event space rental contact email',
  'Harrisburg Pennsylvania banquet hall event coordinator email',
  'Reading Pennsylvania wedding venue contact event manager email',
  
  // Photo booth specific — Philly area
  'Philadelphia wedding venues preferred vendor list photo booth email',
  'New Jersey wedding venues that allow outside vendors photo booth list',
];

async function main() {
  log('╔══════════════════════════════════════════════════╗');
  log('║  PFP Venue Finder — Philadelphia / PA-NJ        ║');
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
      if (results.length === 0) { log(`  No results`); continue; }
      
      let newCount = 0;
      for (const r of results) {
        const title = r.title || '';
        const resultText = [title, r.text || '', r.highlight || '', (r.highlights || []).join(' ')].join(' ');
        const emails = extractEmails(resultText);
        
        let region = 'PA/NJ';
        const fullText = (title + ' ' + (r.text || '')).toLowerCase();
        if (fullText.includes('philadelphia') || fullText.includes('philly')) region = 'Philadelphia';
        else if (fullText.includes('new jersey') || fullText.includes('nj') || fullText.includes('cherry hill') || fullText.includes('princeton') || fullText.includes('camden') || fullText.includes('atlantic city')) region = 'New Jersey';
        else if (fullText.includes('bucks') || fullText.includes('king of prussia') || fullText.includes('valley forge') || fullText.includes('lancaster') || fullText.includes('harrisburg') || fullText.includes('reading') || fullText.includes('main line')) region = 'PA Suburbs';
        
        for (const email of emails) {
          const clean = email.toLowerCase().trim();
          if (clean.includes('noreply') || clean.includes('example') || clean.includes('@domain')) continue;
          if (!existingEmails.has(clean)) {
            contacts.push({
              email: clean,
              name: title.replace(/\s*\|\s*.*$/, '').trim().substring(0, 60) || '',
              venue: title.replace(/\s*\|\s*.*$/, '').trim().substring(0, 60) || '',
              source: r.url || query,
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
      log(`  ${results.length} results → ${newCount} new`);
      if (newCount > 0) {
        const samples = contacts.slice(-Math.min(newCount, 3));
        samples.forEach(c => log(`  ✓ ${c.email} — ${c.name}`));
      }
      saveContacts(contacts);
      
    } catch (e) {
      log(`  ERROR: ${e.message}`);
    }
  }

  log(`\n========================================`);
  log(`DONE — ${VENUE_QUERIES.length} searches, ${totalNew} new contacts`);
  log(`Pool total: ${contacts.length}`);
  log(`========================================`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
