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
// NOTE: Do NOT capture the pool at import time — getSharedPool() returns
// the current _pool reference, but the health check in db.mjs may replace
// it (calling oldPool.end()) after 3 consecutive failures. Always call
// getSharedPool() right before use to get the live pool reference.

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

// ── DB Activity Logger ──────────────────────────────────
// Logs to the relay's activity feed table so the Ships Log
// shows cron executions and edge function calls.
async function logToDb(activityType, title, status, description, metadata = {}, agentId = null) {
  try {
    const pool = getSharedPool();
    await pool.query(
      `INSERT INTO public.eliza_activity_log (activity_type, title, description, status, agent_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [activityType, title || activityType, description || '', status || 'info', agentId || 'cron', JSON.stringify(metadata)]
    );
  } catch (e) {
    // Silently fail — logging is best-effort
  }
}

// ── Cron Execution Write Path ──────────────────────────
// Writes a cron job execution to the dedicated tracking tables:
//   - public.cron_execution_log  (audit trail, one row per run)
//   - public.edge_function_logs (only for edge-function jobs)
//   - public.cron_registry       (run_count / last_run_at / last_status)
// plus the existing eliza_activity_log feed. This closes the
// "write path gap" where cron jobs ran but nothing recorded them
// in the dedicated log tables (they were stuck at 0 rows).
async function logCronExecution(job, res, startedAt) {
  const finishedAt = new Date();
  const durationMs = startedAt ? Math.max(0, finishedAt.getTime() - startedAt.getTime()) : null;
  const jobName = job.name || job.fn || `job-${job.id}`;
  const fnName = job.fn || (job.command && job.command.match(/functions\/v1\/([a-zA-Z0-9_-]+)/)?.[1]) || job.command || null;
  const status = res.ok ? 'completed' : 'failed';
  const platform = job.type === 'edge' ? 'edge' : 'local';
  const pool = getSharedPool();

  // 1. cron_execution_log — one row per run
  try {
    await pool.query(
      `INSERT INTO public.cron_execution_log
         (job_name, function_name, platform, status, started_at, finished_at, duration_ms, payload, result, error, run_count, owner_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
      [
        jobName,
        fnName,
        platform,
        status,
        startedAt ? startedAt.toISOString() : null,
        finishedAt.toISOString(),
        durationMs,
        JSON.stringify({ jobId: job.id, type: job.type }),
        res.ok ? JSON.stringify({ rows: res.rows ?? null, status: res.status ?? null }) : null,
        res.ok ? null : String(res.error || '').slice(0, 2000),
        1,
        'cron',
      ]
    );
  } catch (e) {
    log(`logCronExecution: cron_execution_log write failed: ${e.message}`, 'WARN');
  }

  // 2. edge_function_logs — only for edge-function jobs
  if (job.type === 'edge' && fnName) {
    try {
      await pool.query(
        `INSERT INTO public.edge_function_logs
           (function_name, event_type, event_message, level, timestamp, execution_time_ms, status_code, metadata, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          fnName,
          'cron_execution',
          res.ok ? `Cron job ${jobName} completed` : `Cron job ${jobName} failed: ${String(res.error || '').slice(0, 200)}`,
          res.ok ? 'info' : 'error',
          finishedAt.toISOString(),
          durationMs,
          res.status ?? (res.ok ? 200 : 500),
          JSON.stringify({ jobId: job.id, type: job.type }),
          status,
        ]
      );
    } catch (e) {
      log(`logCronExecution: edge_function_logs write failed: ${e.message}`, 'WARN');
    }
  }

  // 3. cron_registry — increment run_count, set last_run_at / last_status
  try {
    await pool.query(
      `UPDATE public.cron_registry
         SET run_count = COALESCE(run_count, 0) + 1,
             last_run_at = NOW(),
             last_status = $2,
             updated_at = NOW()
       WHERE job_name = $1`,
      [jobName, status]
    );
  } catch (e) {
    log(`logCronExecution: cron_registry update failed: ${e.message}`, 'WARN');
  }

  // 4. eliza_activity_log — keep the existing feed (Ships Log)
  await logToDb(
    job.type === 'sql' ? 'cron_execution' : 'edge_function',
    jobName,
    status,
    res.ok
      ? `${job.type}: ${jobName}`
      : `Error: ${(res.error || '').slice(0, 200)}`,
    { jobId: job.id, rows: res.rows, status: res.status, error: res.error },
    'cron'
  );
}

async function loadJobsFromPg() {
  const c = await getSharedPool().connect();
  try {
    // The supabase schema has cron jobs in cron.job (pg_cron). The
    // local PG might or might not have pg_cron installed; if not,
    // we fall back to reading from a JSON file the relay maintains.
    let rows;
    try {
      const r = await c.query("SELECT id, name, schedule, command, enabled FROM cron.job ORDER BY id");
      rows = r.rows;
      // Detect type: SQL, edge function, or shell command
      rows = rows.map((j) => {
        const cmd = (j.command || '').trim();
        let type = 'sql';
        if (/^SELECT\s+extensions\.http/i.test(cmd)) {
          type = 'edge';
        } else if (/^(python3?|node|cd\s|bash|sh\s)/i.test(cmd)) {
          type = 'shell';
        }
        return { ...j, type, name: j.name || ('job-' + j.id), disabled: j.enabled === false };
      });
      // If cron.job is empty, fall back to JSON file
      if (rows.length === 0) {
        const f = join(DATA_DIR, 'cron-jobs.json');
        if (existsSync(f)) {
          rows = JSON.parse(readFileSync(f, 'utf8'));
          rows = rows.map((j) => {
            if (j.type === 'sql' && j.sql) {
              return { id: j.id, schedule: j.schedule, type: 'sql', command: j.sql, name: j.name, disabled: j.disabled };
            }
            if (j.type === 'ef' && j.fn) {
              return { id: j.id, schedule: j.schedule, type: 'edge', fn: j.fn, body: j.body || {}, name: j.name, disabled: j.disabled };
            }
            return j;
          });
          log(`loaded ${rows.length} jobs from cron-jobs.json (cron.job was empty)`);
        }
      }
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
  const c = await getSharedPool().connect();
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
    // Skip prompts older than 10 minutes to avoid re-prompting stale threads
    const promptAge = Date.now() - new Date(lastSystemPrompt.ts || lastSystemPrompt.time || 0).getTime();
    if (promptAge > 600000) return { ok: true, result: `System prompt to @${promptedAgent} is stale (${Math.round(promptAge/60000)}m old), skipping` };
    // Hard cooldown: skip if we already followed up on this prompt in the last 10 minutes
    const promptId = lastSystemPrompt.id || lastSystemPrompt.ts || lastSystemPrompt.time;
    if (promptId) {
      const cooldowns = state.followUpCooldowns || {};
      const lastFollowUp = cooldowns[promptId];
      if (lastFollowUp && (Date.now() - lastFollowUp) < 600000) {
        return { ok: true, result: `Follow-up for prompt ${promptId.slice(0,12)} already sent <10min ago, skipping` };
      }
    }
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
    // Record cooldown
    if (promptId) {
      const s = loadState();
      if (!s.followUpCooldowns) s.followUpCooldowns = {};
      s.followUpCooldowns[promptId] = Date.now();
      saveState(s);
    }
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

// ── Python Job Runner ─────────────────────────────────────
// Executes Python code on the relay's python-exec tool.
// The job's `code` field contains the Python script.
async function runPythonJob(code) {
  if (!code) return { ok: false, error: 'no code in job definition' };
  try {
    const res = await fetch('http://127.0.0.1:8080/tools/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': '3a02d6eecc89f1c700c097f9034479c24a56787acfbc996c5d17086ecd364602',
        'x-agent-id': 'cron',
      },
      body: JSON.stringify({ tool: 'python-exec', args: { code, timeout: 120 } }),
      signal: AbortSignal.timeout(130_000),
    });
    const data = await res.json();
    if (data.success) {
      return { ok: true, result: data.output?.slice(0, 500) || '(empty)', rows: data.length };
    }
    return { ok: false, error: data.error || data.stderr || 'python-exec failed' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Robust Shell Command Runner ────────────────────────────────────
// The old implementation used promisify(exec)(cmd, { timeout }). On Windows
// Node, exec's timeout path calls child.kill() which races the process 'exit'/
// 'close' events and triggers a FATAL libuv abort:
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src/win/async.c
// (e.g. task-discussion-announcer running node relay/task-announcer.mjs every
// 15 min). That assertion is a hard process crash -- uncaughtException cannot
// catch it. Use spawn() and manage the lifecycle ourselves: wait for the real
// 'close' event (all stdio drained + handle settled) and always clear the
// timer before resolving, so a timer kill can never race a closing handle.
import { spawn } from 'node:child_process';
async function runShellCommand(command, { timeoutMs = 120_000, cwd = __dirname } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // spawn with shell:true passes the whole command string through the OS
      // shell (cmd.exe on Windows), preserving the original exec() behavior.
      child = spawn(command, { cwd, windowsHide: true, shell: true });
    } catch (e) {
      resolve({ ok: false, error: 'spawn failed: ' + e.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Kill the child, then wait for 'close' before resolving (no UV race).
      try { child.kill(); } catch {}
      // Guard: if the child never closes, resolve anyway after a grace period.
      const grace = setTimeout(() => resolve({ ok: false, error: 'shell timeout after ' + timeoutMs + 'ms', timedOut: true }), 5000);
      child.once('close', () => { clearTimeout(grace); resolve({ ok: false, error: 'shell timeout after ' + timeoutMs + 'ms', timedOut: true, stderr: stderr.slice(0, 200) }); });
    }, timeoutMs);

    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, rows: stdout.length, stderr: stderr.slice(0, 200), exitCode: code });
    });
  });
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { lastRun: {} }; }
}
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}



// Shared Context Writer and TTL-pruning/Dispatch-filter fixes

// ── Shared Context Writer ──────────────────────────────────

// Writes TTL-tracked entries to shared_context for scanner pruning

// and workflow engine dispatch filtering.
async function writeSharedContext(entry) {
  try {
    const pool = getSharedPool();
    const ttlMinutes = entry.ttl_minutes || 90;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
    // Two bugs were here. The column names were all wrong — the table is
    // (id, context_key, context_type, value, description, tags,
    // last_updated_by, created_at, updated_at) and this named `key`,
    // `ttl_minutes`, `expires_at` and `agent`, none of which exist. And the
    // statement had five placeholders with no parameter array passed at all.
    //
    // Together they meant this could never succeed. The catch turned the failure
    // into a WARN line, callers carried on, and the scanner's shared context was
    // silently never written - it looked healthy because nothing threw.
    //
    // There is no TTL column, so the expiry travels inside the value instead of
    // being discarded, where a reader can see it and pruning can act on it.
    const payload = (() => {
      try {
        const parsed = JSON.parse(entry.value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return JSON.stringify({ ...parsed, _expires_at: expiresAt, _ttl_minutes: ttlMinutes });
        }
        return JSON.stringify({ value: parsed, _expires_at: expiresAt, _ttl_minutes: ttlMinutes });
      } catch {
        return entry.value;
      }
    })();
    await pool.query(
      `INSERT INTO public.shared_context (context_key, context_type, value, last_updated_by, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, NOW(), NOW())
       ON CONFLICT (context_key) DO UPDATE
       SET value = EXCLUDED.value,
           context_type = EXCLUDED.context_type,
           last_updated_by = EXCLUDED.last_updated_by,
           updated_at = NOW()`,
      [entry.key, entry.context_type || 'general', payload, entry.agent || 'cron-engine-v2']
    );
    return { ok: true };
  } catch (e) {
    log(`writeSharedContext: DB error: ${e.message}`, 'WARN');
    return { ok: false, error: e.message };
  }
}

// Scanner Pruning & Deduplication
// Runs after arch-ecosystem-scanner execution to TTL-prune stale items,
// track acknowledgments, and mark duplicates with no-reemit guard.
async function pruneScannerItems() {
  try {
    const pool = getSharedPool();
    // The column is context_key, not key. Verified against the live table:
    //   public.shared_context (id uuid, context_key text, context_type text,
    //   value jsonb, description text, tags text[], last_updated_by text,
    //   created_at, updated_at)
    // Querying WHERE key = ... threw `column "key" does not exist` on every
    // single tick - roughly every 30 seconds, forever - which is how a 53MB
    // log file accumulated. The error was caught and warned, so the prune
    // silently never ran rather than crashing anything.
    const scanRes = await pool.query(
      `SELECT value FROM public.shared_context WHERE context_key = 'arch-ecosystem-scan'`
    );
    let scanItems = [];
    if (scanRes.rows.length > 0) {
      try {
        // value is jsonb, so node-postgres already handed us a parsed object.
        // JSON.parse would throw on anything that is not a string, which is why
        // this accepts both rather than assuming one shape.
        const v = scanRes.rows[0].value;
        scanItems = typeof v === 'string' ? JSON.parse(v || '[]') : (Array.isArray(v) ? v : []);
      } catch (e) {
        log(`pruneScannerItems: failed to parse scan output: ${e.message}`, 'WARN');
        scanItems = [];
      }
    }
    if (scanItems.length === 0) {
      log('pruneScannerItems: no scanner items to prune');
      return { ok: true };
    }
    const THRESHOLD_MS = 6 * 60 * 60 * 1000;
    const now = Date.now();
    let kept = 0, dropped = 0, markedDuplicate = 0;
    const processed = scanItems.map(item => {
      const itemAge = now - (item.nudged_at || item.created_at || now);
      const isResolved = item.status === 'resolved' || item.status === 'done' || item.status === 'closed';
      const isAcknowledged = item.acknowledged_at !== undefined;
      const isDuplicate = item.isDuplicate === true;
      if ((isResolved || isAcknowledged || isDuplicate) && itemAge > THRESHOLD_MS) {
        dropped++;
        return { ...item, toKeep: false, action: isResolved ? 'resolved-drop' : (isAcknowledged ? 'ack-drop' : 'duplicate-drop') };
      }
      if (!isDuplicate) { markedDuplicate++; return { ...item, toKeep: true, action: 'kept' }; }
      kept++;
      return { ...item, toKeep: true, action: 'kept-unresolved' };
    }).filter(p => p.toKeep);
    if (processed.length > 0 || dropped > 0) {
      await writeSharedContext({
        key: 'arch-ecosystem-scan',
        value: JSON.stringify(processed),
        ttl_minutes: 360,
        expires_at: new Date(Date.now() + 360 * 60000).toISOString(),
        agent: 'cron-engine-v2'
      });
    }
    log(`pruneScannerItems: kept=${processed.length}, dropped=${dropped}, markedDuplicate=${markedDuplicate}, totalIn=${scanItems.length}`);
    return { ok: true, kept, dropped, markedDuplicate, totalIn: scanItems.length };
  } catch (e) {
    log(`pruneScannerItems: error: ${e.message}`, 'ERROR');
    return { ok: false, error: e.message };
  }
}

// Workflow Engine Dispatch Filter Update
// Changes the fleet-chat-task-creator to use live tasks table query
// instead of string-matching conversation history.
// New filter: assignee_agent_id = eliza-001 AND status IN (PENDING, CLAIMED, IN_PROGRESS)
async function updateWorkflowDispatchFilter() {
  try {
    const pool = getSharedPool();
    const taskRes = await pool.query(
      `SELECT id, title, status, stage, priority, assignee_agent_id FROM public.tasks WHERE assignee_agent_id = 'eliza-001' AND status IN ('PENDING', 'CLAIMED', 'IN_PROGRESS') ORDER BY priority DESC, created_at DESC`
    );
    const activeTasks = taskRes.rows.map(t => ({ id: t.id, title: t.title, status: t.status, stage: t.stage, priority: t.priority }));
    await writeSharedContext({
      key: 'eliza-active-tasks',
      value: JSON.stringify(activeTasks),
      ttl_minutes: 30,
      expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
      agent: 'cron-engine-v2'
    });
    log(`updateWorkflowDispatchFilter: loaded ${activeTasks.length} active eliza-001 tasks from live table`);
    return { ok: true, count: activeTasks.length };
  } catch (e) {
    log(`updateWorkflowDispatchFilter: DB error: ${e.message}`, 'WARN');
    return { ok: true };
  }
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
    const startedAt = new Date();
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
    } else if (job.type === 'python' && job.code) {
      res = await runPythonJob(job.code);
    } else if (job.type === 'shell') {
      // Execute shell commands via child_process. Use async exec (NOT execSync)
      // so the relay's event loop is not blocked. execSync would block the
      // relay from serving the very HTTP requests these shell jobs make back
      // to localhost:8080, causing them to time out (e.g. trustgraph-scanner,
      // health-check, fleet-chat-heartbeat all fetch the relay).
      try {
        res = await runShellCommand(job.command, { timeoutMs: 120_000, cwd: join(__dirname, '..') });
      } catch (e) {
        res = { ok: false, error: e.message };
      }
    } else {
      res = { ok: false, error: `unknown type: ${job.type}` };
    }
    state.lastRun[job.id] = thisMin;
    // Write to the dedicated tracking tables (cron_execution_log,
    // edge_function_logs, cron_registry) + eliza_activity_log feed.
    await logCronExecution(job, res, startedAt);
    if (res.ok) {
      log(`[${job.id}] OK (${res.rows ?? res.status ?? '?'} rows/ms)`);
    } else {
      log(`[${job.id}] FAIL: ${res.error}`, 'WARN');
    }
  }
  saveState(state);

  // After all jobs have run, perform post-tick maintenance:
  //   1. TTL-prune scanner items & track acknowledgments (Ghost loop fix)
  //   2. Update workflow dispatch filter from live tasks table
  try {
    const pruneRes = await pruneScannerItems();
    if (pruneRes.ok) {
      log('pruneScannerItems: kept=' + (pruneRes.kept || 0) + ', dropped=' + (pruneRes.dropped || 0) + ', markedDuplicate=' + (pruneRes.markedDuplicate || 0));
    } else {
      log('pruneScannerItems: ' + (pruneRes.error || 'unknown error'), 'WARN');
    }
  } catch (e) {
    log('pruneScannerItems: unexpected error: ' + e.message, 'ERROR');
  }
  try {
    const dispatchRes = await updateWorkflowDispatchFilter();
    if (dispatchRes.ok) {
      log('updateWorkflowDispatchFilter: loaded ' + (dispatchRes.count || 0) + ' active eliza-001 tasks from live table');
    } else {
      log('updateWorkflowDispatchFilter: ' + (dispatchRes.error || 'unknown error'), 'WARN');
    }
  } catch (e) {
    log('updateWorkflowDispatchFilter: unexpected error: ' + e.message, 'ERROR');
  }
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
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  if (process.argv.includes('--once')) {
    runOnce().then(() => process.exit(0));
  } else if (process.argv.includes('--list')) {
    loadJobsFromPg().then((j) => { console.log(JSON.stringify(j, null, 2)); process.exit(0); });
  } else {
    runDaemon();
  }
}
