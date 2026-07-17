#!/usr/bin/env node
/**
 * relay/cron-engine-v2.mjs — Local cron job executor
 *
 * Replaces cron-engine.mjs (which used `psql -U postgres` and
 * `cmd.exe` spawns that hung waiting for a password). The old
 * engine referenced a non-existent `pg/bin/` path; this v2
 * connects to the embedded PG via the `pg` npm client using
 * the same connection string as the rest of the system:
 *
 *   postgres://postgres:postgres@localhost:5432/postgres
 *
 * It also uses the local edge function runtime at port 8090
 * (suite/runtime/manager.mjs) for "edge function" cron jobs
 * instead of proxying to the dead Supabase.
 *
 * Run with --once to execute due jobs once and exit, or as a
 * daemon that polls every 30s.
 */

import pg from 'pg';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
const { Client, Pool } = pg;
// Use the shared connection pool from relay/lib/db.mjs to prevent
// "too many clients" — was creating a separate pool here (max 5) that
// competed with server.js's pool (max 5) and localDb.mjs's pool (max 5).
// Consolidated July 17, 2026.
import { getPool as getSharedPool, query as dbQuery } from './lib/db.mjs';
const pool = getSharedPool();

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'relay-data');
const LOG_FILE = join(DATA_DIR, 'cron-engine-v2.log');
const STATE_FILE = join(DATA_DIR, 'cron-engine-v2-state.json');
mkdirSync(DATA_DIR, { recursive: true });

// Prefer LOCAL_DATABASE_URL (the convention used in relay/.env) over
// DATABASE_URL. The default fallback pointed at the empty `postgres`
// database, which caused every cron tick to log
// "relation/function/schema does not exist" even when the objects
// existed in xmrt_suite. Accept either env var to avoid breaking
// environments that only set DATABASE_URL.
// NOTE: PG_URL is no longer used directly — the shared pool from
// relay/lib/db.mjs handles connection config. Kept for reference.
const PG_URL = process.env.LOCAL_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgresql://postgres@127.0.0.1:5432/xmrt_suite';

// 2026-06-10: Default to local-sb (54321) instead of suite/runtime/manager.mjs
// (8090). The 8090 runtime is not running in the current local stack; local-sb
// on 54321 is the actual edge function host. Override with LOCAL_RUNTIME_URL
// env var if the suite runtime comes back.
const RUNTIME_URL = process.env.LOCAL_RUNTIME_URL || 'http://127.0.0.1:54321';

function log(msg, level = 'INFO') {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + '\n', { flag: 'a' }); } catch {}
}

function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { error: `Invalid cron: ${expr}` };
  const now = new Date();
  const minute = now.getMinutes();
  const hour = now.getHours();
  const day = now.getDate();
  const month = now.getMonth() + 1;
  const dow = now.getDay();
  const match = (field, value) => {
    if (field === '*') return true;
    if (field.startsWith('*/')) return value % parseInt(field.slice(2)) === 0;
    if (field.includes(',')) return field.split(',').map(Number).includes(value);
    if (field.includes('-')) {
      const [lo, hi] = field.split('-').map(Number);
      return value >= lo && value <= hi;
    }
    return parseInt(field) === value;
  };
  return {
    match: match(parts[0], minute) && match(parts[1], hour) &&
           match(parts[2], day) && match(parts[3], month) && match(parts[4], dow)
  };
}

async function loadJobsFromPg() {
  const c = await pool.connect();
  try {
    // The supabase schema has cron jobs in cron.job (pg_cron). The
    // local PG might or might not have pg_cron installed; if not,
    // we fall back to reading from a JSON file the relay maintains.
    let rows;
    try {
      const r = await c.query("SELECT jobid as id, schedule, command FROM cron.job ORDER BY jobid");
      rows = r.rows;
      // Detect type: SQL or edge function (SELECT extensions.http)
      rows = rows.map((j) => ({
        ...j,
        type: /^SELECT\s+extensions\.http/i.test(j.command || '') ? 'edge' : 'sql',
      }));
    } catch (e) {
      // pg_cron not available; read from relay-data/cron-jobs.json
      const f = join(DATA_DIR, 'cron-jobs.json');
      if (!existsSync(f)) {
        log('no cron.job table and no cron-jobs.json; nothing to do', 'WARN');
        return [];
      }
      rows = JSON.parse(readFileSync(f, 'utf8'));
      // Normalize field names: source has {id, schedule, type, sql/fn}
      // runtime expects {id, schedule, type, command: (sql) or fn+body}
      rows = rows.map((j) => {
        if (j.type === 'sql' && j.sql) {
          return { id: j.id, schedule: j.schedule, type: 'sql', command: j.sql, name: j.name, disabled: j.disabled };
        }
        if (j.type === 'ef' && j.fn) {
          return { id: j.id, schedule: j.schedule, type: 'edge', fn: j.fn, body: j.body || {}, name: j.name, disabled: j.disabled };
        }
        return j;
      });
    }
    return rows;
  } finally {
    c.release();
  }
}

async function runSql(sql) {
  const c = await pool.connect();
  try {
    const r = await c.query(sql);
    return { ok: true, rows: r.rowCount };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    c.release();
  }
}

// ── Fleet Chat Heartbeat ──────────────────────────────────
async function runFleetChatHeartbeat() {
  try {
    const msgsRes = await fetch('http://127.0.0.1:8080/api/fleet-chat/messages?limit=10', { signal: AbortSignal.timeout(5000) });
    const msgsData = await msgsRes.json().catch(() => ({ messages: [] }));
    const recentMsgs = (msgsData.messages || []).slice(-5);
    const statusRes = await fetch('http://127.0.0.1:8080/api/supervisor/status', { signal: AbortSignal.timeout(5000) });
    const statusData = await statusRes.json().catch(() => ({}));
    const services = (statusData.services || []).filter(s => s.healthy);
    const tokenRes = await fetch('http://127.0.0.1:8080/api/token-usage/summary/agents?days=1', { signal: AbortSignal.timeout(5000) });
    const tokenData = await tokenRes.json().catch(() => []);
    const totalTokens = tokenData.reduce((s, t) => s + (parseInt(t.total_tokens) || 0), 0);
    const lastMsg = recentMsgs[recentMsgs.length - 1];
    const timeSinceLastMsg = lastMsg ? Math.floor((Date.now() - (lastMsg.ts || 0)) / 60000) : 999;
    const agents = ['vex', 'eliza', 'alice', 'trib', 'arch', 'hermes'];
    const agent = agents[Math.floor(Math.random() * agents.length)];
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    let prompt;
    if (timeSinceLastMsg > 60) {
      const topics = [
        `@${agent} the fleet has been quiet for a while. What is on your mind? Any observations about the system?`,
        `@${agent} it has been a quiet ${timeOfDay} on the fleet. Anything you want to flag or discuss?`,
        `@${agent} the ${timeOfDay} watch is quiet. How are things looking from your station?`,
      ];
      prompt = topics[Math.floor(Math.random() * topics.length)];
    } else if (totalTokens > 0) {
      const lastTopic = lastMsg ? lastMsg.message.slice(0, 80) : 'system operations';
      const prompts = [
        `@${agent} I noticed recent activity about "${lastTopic}". Do you have any thoughts to add?`,
        `@${agent} we have used ${totalTokens.toLocaleString()} tokens in the last 24h. How is your workload looking?`,
        `@${agent} ${services.length} services are healthy. Anything you want to check in on?`,
      ];
      prompt = prompts[Math.floor(Math.random() * prompts.length)];
    } else {
      const prompts = [
        `@${agent} status check — how are things on your end?`,
        `@${agent} anything to report this ${timeOfDay}?`,
        `@${agent} ${timeOfDay} check-in. All quiet?`,
      ];
      prompt = prompts[Math.floor(Math.random() * prompts.length)];
    }
    const sendRes = await fetch('http://127.0.0.1:8080/api/fleet-chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'system', message: prompt, channel: 'fleet' }),
      signal: AbortSignal.timeout(5000),
    });
    return { ok: sendRes.ok, result: `Fleet heartbeat sent to @${agent}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Fleet Chat Follow-Up ──────────────────────────────────
async function runFleetChatFollowUp() {
  try {
    const msgsRes = await fetch('http://127.0.0.1:8080/api/fleet-chat/messages?limit=10', { signal: AbortSignal.timeout(5000) });
    const msgsData = await msgsRes.json().catch(() => ({ messages: [] }));
    const msgs = (msgsData.messages || []).slice(-10);
    let lastSystemPrompt = null;
    let lastSystemPromptIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].agent === 'system' && msgs[i].message.startsWith('@')) {
        lastSystemPrompt = msgs[i];
        lastSystemPromptIdx = i;
        break;
      }
    }
    if (!lastSystemPrompt) return { ok: true, result: 'No system prompt found' };
    const mentionMatch = lastSystemPrompt.message.match(/^@(\w+)/);
    if (!mentionMatch) return { ok: true, result: 'No @mention in system prompt' };
    const promptedAgent = mentionMatch[1].toLowerCase();
    const promptedAgentResponses = msgs.slice(lastSystemPromptIdx + 1).filter(
      m => m.agent.toLowerCase().includes(promptedAgent) && m.agent !== 'system'
    );
    if (promptedAgentResponses.length === 0) return { ok: true, result: `${promptedAgent} has not responded yet` };
    const lastResponse = promptedAgentResponses[promptedAgentResponses.length - 1];
    const followUps = msgs.slice(msgs.indexOf(lastResponse) + 1).filter(
      m => m.agent !== 'system' && !m.agent.toLowerCase().includes(promptedAgent)
    );
    if (followUps.length > 0) return { ok: true, result: 'Follow-up already happened' };
    const agents = ['vex', 'eliza', 'alice', 'trib', 'arch', 'hermes'];
    const otherAgents = agents.filter(a => a !== promptedAgent);
    const followUpAgent = otherAgents[Math.floor(Math.random() * otherAgents.length)];
    const responseSnippet = (lastResponse.message || '').slice(0, 120);
    const followUpPrompts = [
      `@${followUpAgent} ${promptedAgent} just said: "${responseSnippet}". What do you think?`,
      `@${followUpAgent} ${promptedAgent} reported in. Any thoughts on what they mentioned?`,
      `@${followUpAgent} ${promptedAgent} shared some observations. Do you have anything to add?`,
    ];
    const prompt = followUpPrompts[Math.floor(Math.random() * followUpPrompts.length)];
    const sendRes = await fetch('http://127.0.0.1:8080/api/fleet-chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'system', message: prompt, channel: 'fleet' }),
      signal: AbortSignal.timeout(5000),
    });
    return { ok: sendRes.ok, result: `Follow-up sent to @${followUpAgent} about ${promptedAgent}'s response` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Fleet Chat Task Creator ──────────────────────────────
async function runFleetChatTaskCreator() {
  try {
    const msgsRes = await fetch('http://127.0.0.1:8080/api/fleet-chat/messages?limit=20', { signal: AbortSignal.timeout(5000) });
    const msgsData = await msgsRes.json().catch(() => ({ messages: [] }));
    const msgs = (msgsData.messages || []).slice(-20);
    let systemIdx = -1, agentAIdx = -1, followUpIdx = -1, agentBIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.agent === 'system' && m.message.startsWith('@') && followUpIdx === -1) followUpIdx = i;
      else if (m.agent !== 'system' && agentBIdx === -1 && followUpIdx !== -1 && i < followUpIdx) agentBIdx = i;
      else if (m.agent === 'system' && m.message.startsWith('@') && agentAIdx === -1) systemIdx = i;
      else if (m.agent !== 'system' && agentAIdx === -1 && systemIdx !== -1 && i < systemIdx) agentAIdx = i;
    }
    if (systemIdx === -1 || agentAIdx === -1 || followUpIdx === -1 || agentBIdx === -1) return { ok: true, result: 'No complete conversation cycle found' };
    const agentAResponse = msgs[agentAIdx];
    const agentBResponse = msgs[agentBIdx];
    const combinedText = (agentAResponse.message + ' ' + agentBResponse.message).toLowerCase();
    let taskTitle = null, taskDescription = null, taskPriority = 3;
    if (combinedText.includes('cron') && (combinedText.includes('error') || combinedText.includes('fail'))) {
      taskTitle = 'Investigate cron job errors'; taskDescription = 'Agents identified cron job issues in fleet chat. Review cron-engine-v2 logs and fix failing jobs.'; taskPriority = 1;
    } else if (combinedText.includes('service') && (combinedText.includes('down') || combinedText.includes('unreachable'))) {
      taskTitle = 'Investigate service outage'; taskDescription = 'Agents reported service issues in fleet chat. Check supervisor status and restore affected services.'; taskPriority = 1;
    } else if (combinedText.includes('knowledge') && combinedText.includes('base')) {
      taskTitle = 'Review knowledge base health'; taskDescription = 'Agents discussed knowledge base status in fleet chat. Verify entity count and fix any issues.'; taskPriority = 2;
    } else if (combinedText.includes('token') || combinedText.includes('usage')) {
      taskTitle = 'Review token usage patterns'; taskDescription = 'Agents discussed token consumption in fleet chat. Analyze usage and optimize if needed.'; taskPriority = 2;
    } else if (combinedText.includes('update') || combinedText.includes('upgrade') || combinedText.includes('deploy')) {
      taskTitle = 'Process update request from fleet discussion'; taskDescription = 'Agents discussed updates in fleet chat. Review the conversation and implement changes.'; taskPriority = 2;
    }
    if (!taskTitle) return { ok: true, result: 'No actionable topic detected' };
    const createRes = await fetch('http://127.0.0.1:8080/api/suite/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: taskTitle, description: taskDescription, status: 'PENDING', stage: 'DISCUSS', priority: taskPriority, category: 'fleet-chat', metadata: { source: 'fleet-chat', agent_a: agentAResponse.agent, agent_b: agentBResponse.agent, agent_a_message: agentAResponse.message.slice(0, 200), agent_b_message: agentBResponse.message.slice(0, 200) } }),
      signal: AbortSignal.timeout(5000),
    });
    if (createRes.ok) {
      await fetch('http://127.0.0.1:8080/api/fleet-chat/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'system', message: `📋 Task created from fleet discussion: "${taskTitle}" (priority ${taskPriority}). The task pipeline will assign it shortly.`, channel: 'fleet' }),
        signal: AbortSignal.timeout(5000),
      });
      return { ok: true, result: `Task created: ${taskTitle}` };
    }
    return { ok: false, result: 'Failed to create task' };
  } catch (err) { return { ok: false, error: err.message }; }
}

async function runEdgeFunctionByName(fnName, body = {}) {
  const target = `${RUNTIME_URL}/functions/v1/${fnName}`;
  try {
    const r = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, preview: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function runEdgeFunction(job) {
  // Legacy: parse the command string for the function name.
  const m = job.command?.match(/functions\/v1\/([a-zA-Z0-9_-]+)/);
  if (!m) return { ok: false, error: 'no function name in command' };
  return runEdgeFunctionByName(m[1], {});
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { lastRun: {} }; }
}
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

async function tick() {
  const jobs = await loadJobsFromPg();
  if (!jobs.length) {
    log('no jobs registered');
    return;
  }
  log(`loaded ${jobs.length} jobs (${jobs.filter(j => j.type === 'sql').length} sql, ${jobs.filter(j => j.type === 'edge').length} edge)`);
  const state = loadState();
  for (const job of jobs) {
    if (job.disabled) continue;
    const c = parseCron(job.schedule);
    if (c.error) {
      log(`job ${job.id} bad cron: ${c.error}`, 'WARN');
      continue;
    }
    if (!c.match) continue;
    const lastMin = state.lastRun[job.id];
    const thisMin = Math.floor(Date.now() / 60000);
    if (lastMin === thisMin) continue; // already ran this minute
    const label = job.name || job.fn || `job-${job.id}`;
    log(`[${job.id}] ${job.type}: ${label}`);
    let res;
    if (job.type === 'sql') {
      res = await runSql(job.command);
    } else if (job.type === 'edge' && job.fn) {
      res = await runEdgeFunctionByName(job.fn, job.body);
    } else if (job.type === 'local' && job.action === 'fleet-chat-heartbeat') {
      res = await runFleetChatHeartbeat();
    } else if (job.type === 'local' && job.action === 'fleet-chat-followup') {
      res = await runFleetChatFollowUp();
    } else if (job.type === 'local' && job.action === 'fleet-chat-task-creator') {
      res = await runFleetChatTaskCreator();
    } else {
      res = { ok: false, error: `unknown type: ${job.type}` };
    }
    state.lastRun[job.id] = thisMin;
    if (res.ok) {
      log(`[${job.id}] OK (${res.rows ?? res.status ?? '?'} rows/ms)`);
    } else {
      log(`[${job.id}] FAIL: ${res.error}`, 'WARN');
    }
  }
  saveState(state);
}

export async function runOnce() {
  await tick();
}

export function runDaemon() {
  log('daemon starting (poll every 30s)');
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    try { await tick(); } catch (e) { log('tick error: ' + e.message, 'WARN'); }
    setTimeout(loop, 30_000);
  };
  loop();
  return () => { stopped = true; };
}

// CLI mode
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  if (process.argv.includes('--once')) {
    runOnce().then(() => process.exit(0));
  } else if (process.argv.includes('--list')) {
    loadJobsFromPg().then((j) => { console.log(JSON.stringify(j, null, 2)); process.exit(0); });
  } else {
    runDaemon();
  }
}
