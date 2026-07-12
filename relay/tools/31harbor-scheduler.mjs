#!/usr/bin/env node
/**
 * 31harbor-scheduler.mjs — Daemon scheduler for the 31harbor campaign
 *
 * Schedule (Eastern Time, UTC-4 / UTC-5):
 *   8:00 PM ET   — Run national scraper (nightly refresh)
 *   7:00 AM ET   — Send 50 emails
 *   9:00 AM ET   — Send 50 emails
 *   11:00 AM ET  — Send 50 emails
 *
 * Usage:
 *   Daemon mode:  node relay/tools/31harbor-scheduler.mjs --daemon
 *   Dry run:      node relay/tools/31harbor-scheduler.mjs
 */

import { execSync, spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = __dirname;
const DATA_DIR = join(__dirname, '..', '..', 'relay-data');
const STATE_FILE = join(DATA_DIR, '31harbor-scheduler-state.json');
mkdirSync(DATA_DIR, { recursive: true });

// Get current UTC offset for US Eastern Time
function getEasternOffset() {
  const now = new Date();
  // Eastern: Mar-Nov = UTC-4 (EDT), Nov-Mar = UTC-5 (EST)
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  const isDST = Math.min(jan, jul) !== now.getTimezoneOffset();
  // If machine is already ET, use its offset; otherwise assume UTC-4 (EDT)
  const machineOffset = now.getTimezoneOffset();
  if (machineOffset === 240 || machineOffset === 300) {
    return machineOffset; // machine is already ET
  }
  return isDST ? 240 : 300; // EDT=240, EST=300
}

const ET_OFFSET = getEasternOffset(); // minutes ahead of UTC (240=EDT, 300=EST)

// Schedule in ET hour → convert to UTC hour
function etHourToUtc(etHour) {
  return (etHour + ET_OFFSET / 60) % 24;
}

const SCHEDULE = [
  { etHour: 7,  count: 50,  label: '7:00 AM ET send (50)' },
  { etHour: 9,  count: 50,  label: '9:00 AM ET send (50)' },
  { etHour: 11, count: 50,  label: '11:00 AM ET send (50)' },
  { etHour: 20, count: 0,   label: '8:00 PM ET scraper', scraper: true },
];

// Pre-compute UTC schedule
const UTC_SCHEDULE = SCHEDULE.map(s => ({
  utcHour: etHourToUtc(s.etHour),
  count: s.count,
  label: s.label,
  scraper: s.scraper || false,
}));

function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return { lastRunHour: {}, totalSent: 0, totalErrors: 0, lastScrapeDay: null };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const RUNNING_LOCK = join(DATA_DIR, '31harbor-scheduler-running.lock');

function acquireRunningLock() {
  try {
    if (existsSync(RUNNING_LOCK)) {
      const age = Date.now() - JSON.parse(readFileSync(RUNNING_LOCK, 'utf8')).started;
      if (age < 1800000) { // 30 min lock
        log(`Another scheduler instance already running (${Math.round(age/1000)}s ago) — skipping`);
        return false;
      }
      // Stale lock — overwrite
    }
    writeFileSync(RUNNING_LOCK, JSON.stringify({ started: Date.now(), pid: process.pid }));
    return true;
  } catch { return false; }
}

function releaseRunningLock() {
  try { if (existsSync(RUNNING_LOCK)) writeFileSync(RUNNING_LOCK, JSON.stringify({ started: Date.now(), pid: process.pid, done: true })); } catch {}
}

function runScraper() {
  const script = join(TOOLS_DIR, '31harbor-national-scraper.mjs');
  log(`Running nightly scraper...`);

  try {
    const result = execSync(`node "${script}" --target=3000`, {
      timeout: 1800000, // 30 min (scraper took ~18.5 min on June 22)
      encoding: 'utf8'
    });
    log(result.trim());
    log(`Scraper complete.`);
    return true;
  } catch (e) {
    const msg = e.message || e.stdout || e.stderr || 'unknown error';
    log(`Scraper error: ${msg.slice(0, 300)}`);
    return false;
  }
}

function runSender(count) {
  const script = join(TOOLS_DIR, '31harbor-daily-sender.mjs');
  log(`Running sender (${count} emails)...`);

  try {
    const result = execSync(`node "${script}" ${count}`, {
      timeout: 300000, // 5 min
      encoding: 'utf8'
    });
    log(result.trim());
    return true;
  } catch (e) {
    const msg = e.message || e.stdout || e.stderr || 'unknown error';
    log(`Sender error: ${msg.slice(0, 300)}`);
    return false;
  }
}

function log(msg) {
  const entry = `[${new Date().toISOString()}] [Scheduler] ${msg}`;
  console.log(entry);
  try {
    appendFileSync(join(DATA_DIR, '31harbor-campaign.log'), entry + '\n');
  } catch {}
}

function executeSlot(slot) {
  const now = new Date();
  const hour = now.getUTCHours();
  const dayStr = now.toISOString().slice(0, 10);

  const state = loadState();

  if (slot.scraper) {
    const key = 'scraper-' + dayStr;
    if (state.lastRunHour[key]) {
      log(`Scraper already ran today, skipping`);
      return;
    }
    const ok = runScraper();
    if (ok) {
      state.lastRunHour[key] = Date.now();
      state.lastScrapeDay = dayStr;
    }
    saveState(state);
  } else {
    const key = 'send-' + dayStr + '-' + slot.utcHour;
    if (state.lastRunHour[key]) {
      log(`Already ran sender for ${slot.label}, skipping`);
      return;
    }
    const ok = runSender(slot.count);
    if (ok) {
      state.lastRunHour[key] = Date.now();
      state.totalSent += slot.count;
    } else {
      state.totalErrors++;
    }
    saveState(state);
  }
}

function checkSchedule() {
  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const dayStr = now.toISOString().slice(0, 10);

  // Allow a 5-min window (minute 0-5) for each scheduled hour
  if (minute > 5) return;

  for (const slot of UTC_SCHEDULE) {
    if (slot.utcHour === hour) {
      const state = loadState();
      const key = slot.scraper
        ? 'scraper-' + dayStr
        : 'send-' + dayStr + '-' + slot.utcHour;

      if (!state.lastRunHour[key]) {
        log(`Firing: ${slot.label}`);
        executeSlot(slot);
      }
      return;
    }
  }
}

// Main
const isDaemon = process.argv.includes('--daemon');

if (isDaemon) {
  if (!acquireRunningLock()) {
    log(`Another scheduler daemon already running — exiting`);
    process.exit(0);
  }

  log(`31harbor Scheduler daemon starting (pid ${process.pid})`);
  log(`ET offset: UTC-${ET_OFFSET/60}h`);
  log(`Schedule:`);
  for (const s of SCHEDULE) {
    log(`  ${s.label}`);
  }
  log(`\nChecking every 60s...`);

  // Run once at startup if we're near a scheduled time
  checkSchedule();

  // Then check every minute
  setInterval(checkSchedule, 60000);
} else {
  // Single-run mode: just fire the next due slot (for testing)
  log(`Single-run mode. Checking schedule...`);
  checkSchedule();
}