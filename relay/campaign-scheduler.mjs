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

if (isDaemon) {
  console.log('[CampaignScheduler] Daemon mode - checking schedule every minute');
  console.log(`[CampaignScheduler] Schedule: ${SCHEDULE_HOURS.map(h => (h + ':' + String(SCHEDULE_MINUTE).padStart(2,'0') + ' UTC')).join(', ')}`);
  checkSchedule();
  setInterval(checkSchedule, 60000);
} else {
  runCampaign();
}
