#!/usr/bin/env node
/**
 * Campaign Scheduler — runs daily-campaign.mjs on a 6x/day schedule
 * Runs as daemon: node relay/campaign-scheduler.mjs --daemon
 * Or standalone: node relay/campaign-scheduler.mjs
 * Survives reboot when started via start-all.sh
 */

import { execSync, spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'relay-data');
const STATE_FILE = join(DATA_DIR, 'campaign-scheduler-state.json');

// ── Text Sanitization ──────────────────────────────────────────
function sanitizeText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\uFFFD/g, '-')
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u2022/g, '*')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '');
}

// 6 drops per day at these Costa Rica hours (UTC-6)
// 8:30am -> 10:30am -> 12:30pm -> 2:30pm -> 4:30pm -> 6:30pm CR time
const SCHEDULE_HOURS = [14, 16, 18, 20, 22, 0]; // UTC hours for :30 past
const SCHEDULE_MINUTE = 30;
const SEND_COUNT = 100;

// Inbound watch: a reply in the inbox is a lead, and the campaign's whole point
// is generating replies. Runs on its own 15-minute cadence, INDEPENDENT of the
// send schedule above, so a reply at 11:47am is not waiting until the 12:30 drop.
//
// Deliberately not a send trigger. Reading the inbox can never send an email, and
// keeping it separate means a broken poll cannot stall the campaign - the failure
// modes stay independent in both directions.
const INBOUND_INTERVAL_MS = 15 * 60 * 1000;
let lastInbound = 0;

function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return { lastRunHour: {}, totalSent: 0, totalErrors: 0 };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function runCampaign() {
  const now = new Date();
  const hour = now.getUTCHours();
  const dayStr = now.toISOString().slice(0, 10);
  
  const state = loadState();
  if (state.lastRunHour[dayStr + '-' + hour]) {
    console.log(`[CampaignScheduler] Already ran at ${hour}:00 today, skipping`);
    return;
  }
  
  const script = join(__dirname, 'daily-campaign.mjs');
  console.log(`[CampaignScheduler] Running campaign (${SEND_COUNT} sends) at ${hour}:00 UTC...`);
  
  try {
    const result = execSync(`node "${script}" ${SEND_COUNT}`, {
      timeout: 300000, // 5 min
      encoding: 'utf8'
    });
    console.log(result.trim());
    state.lastRunHour[dayStr + '-' + hour] = Date.now();
    state.totalSent += SEND_COUNT;
    saveState(state);
    console.log(`[CampaignScheduler] Campaign complete at ${hour}:00 UTC`);
  } catch (e) {
    const msg = e.message || e.stdout || e.stderr || 'unknown error';
    console.error(`[CampaignScheduler] Campaign error at ${hour}:00 UTC: ${msg.slice(0,200)}`);
    state.totalErrors++;
    saveState(state);
  }
}

function checkSchedule() {
  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  
  // Run at scheduled minute on each scheduled hour
  if (minute === SCHEDULE_MINUTE && SCHEDULE_HOURS.includes(hour)) {
    runCampaign();
  }
}

// Main loop
const isDaemon = process.argv.includes('--daemon');

/**
 * Poll the inbox for replies and turn them into leads.
 *
 * Runs on its own interval rather than on the send schedule. A reply is a lead
 * the moment it lands, and a school district waiting on a certificate of
 * insurance should not wait for the next campaign drop to be noticed.
 *
 * Every failure is swallowed and logged. This is the piece most likely to hit a
 * transient network or API error, and the daemon must keep running the send
 * schedule regardless - a dead poll must never take the campaign down with it.
 */
async function pollInbound() {
  const now = Date.now();
  if (now - lastInbound < INBOUND_INTERVAL_MS) return;
  lastInbound = now;
  try {
    const { getPool } = await import('./jobby/store.mjs');
    const { runInboundPoll } = await import('./lib/pfp-inbound.mjs');
    const { captureInboundEmail, sweepExpiredLeads } = await import('./lib/pfp-lead-stages.mjs');
    const pool = await getPool();
    const q = (sql, params) => pool.query(sql, params);

    // Ensure the stage machinery exists before the first capture, so a fresh
    // database cannot make the poller throw on a missing table.
    const { ensureLeadStageSchema, seedStages } = await import('./lib/pfp-lead-stages.mjs');
    await ensureLeadStageSchema(q);
    await seedStages(q);

    const r = await runInboundPoll(q, captureInboundEmail, {
      envPath: join(__dirname, '.env'),
      log: (ev, d) => console.log(`[${ev}] ${d}`),
    });
    if (!r.ok) {
      console.error(`[InboundPoll] ${r.error}`);
      return;
    }
    console.log(
      `[InboundPoll] scanned ${r.scanned}, ${r.lead_worthy} lead-worthy, ` +
      `${r.skipped} skipped, ${r.leads_created} new lead(s), ` +
      `${r.leads_resurrected} resurrected`
    );
    for (const p of r.processed ?? []) {
      if (p.created) console.log(`[InboundPoll]   NEW LEAD ${p.from} :: ${String(p.subject).slice(0, 60)}`);
      else if (p.resurrected) console.log(`[InboundPoll]   BACK ${p.from} :: ${p.was_stage} -> new`);
    }

    // Expire only what is genuinely overdue. Leads with an imminent event are
    // held back for a human; see EVENT_GUARD_DAYS in pfp-lead-stages.mjs.
    const sw = await sweepExpiredLeads(q, { actor: 'campaign-scheduler' });
    if (sw.expired || sw.held) {
      console.log(`[InboundPoll] stage sweep: expired ${sw.expired}, held ${sw.held} (event imminent)`);
    }
  } catch (e) {
    console.error(`[InboundPoll] failed: ${e.message}`);
  }
}

if (isDaemon) {
  console.log('[CampaignScheduler] Daemon mode - checking schedule every minute');
  console.log(`[CampaignScheduler] Schedule: ${SCHEDULE_HOURS.map(h => (h + ':' + String(SCHEDULE_MINUTE).padStart(2,'0') + ' UTC')).join(', ')}`);
  console.log(`[CampaignScheduler] Inbound lead watch: every ${INBOUND_INTERVAL_MS / 60000} minutes`);
  checkSchedule();
  setInterval(checkSchedule, 60000);
  // First poll shortly after start rather than instantly, so daemon startup does
  // not race the database and the send schedule.
  setTimeout(pollInbound, 20000);
  setInterval(pollInbound, 60000);
} else {
  // One-shot mode: the campaign runs, and the inbox is still watched once, so a
  // manual invocation does the useful thing rather than only the send.
  runCampaign();
  pollInbound();
}
