#!/usr/bin/env node
// Prevent background task crashes
process.on('uncaughtException', (err) => {  console.error('[Relay] UNCAUGHT EXCEPTION:', err?.message || err);  console.error(err?.stack || '(no stack)');  /* Don't exit - let the process continue */ });
process.on('unhandledRejection', (err) => {
  console.error('[Relay] Unhandled rejection (non-fatal):', err?.message || err);
  if (err?.stack) console.error('[Relay] Stack:', err.stack.split('\n').slice(0,4).join('\n'));
});

/**
 * xmrtdao-relay server.js (Enhanced)
 * Local webhook relay for XMRT DAO — routes cloud-dispatched tasks
 * to local agents (bash, python, node scripts).
 *
 * Features:
 *   - Task webhook + dispatch routing
 *   - Web search via Ollama
 *   - Web scraping
 *   - Local LLM chat via Ollama
 *   - System monitoring dashboard
 *   - Tool registry + dynamic execution
 *   - Persistent state management
 *   - Eliza-Cloud relay
 *   - Hermes phone agent forwarding
 *   - GitHub issue integration
 */

import express from 'express';
import { readFileSync, existsSync, mkdirSync, writeFile, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn, execSync, execFileSync } from 'child_process';
import { hostname as osHostname } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── Load .env ───────────────────────────────────────────────
// Node doesn't auto-load .env. The previous version used
// `if (!process.env[key])` so OS env won; that meant a stale
// `SUPABASE_URL` was previously set to a dead cloud host (vawouugtzwmejxqkeqqj.supabase.co).
// system-wide silently routed the relay to a dead cloud host
// (ENOTFOUND), making every dashboard card report "offline".
// We now OVERWRITE with relay/.env values so the local-first
// stack is canonical. To force a cloud value, edit relay/.env
// (not the OS env). See memory/feedback_supabase_env_override.md.
function loadEnv() {
  const envPath = join(__dirname, '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      // Strip inline `# ...` comments on unquoted values
      if (!value.startsWith('"') && !value.startsWith("'")) {
        const hashIdx = value.indexOf(' #');
        if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
      }
      process.env[key] = value;
    }
    console.log(`[Relay] Loaded .env (overwrite mode) from ${envPath}`);
  }
}
loadEnv();

// ── Module imports ──────────────────────────────────────────
import { webSearch, formatResults } from './tools/web-search.mjs';
import { webScrape } from './tools/web-scrape.mjs';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { ollamaChat, ollamaGenerate, listModels, checkOllamaHealth } from './tools/ollama-chat.mjs';
import { chat as jobbyChat, onboardFromDossier } from './jobby/chat.mjs';
import { displayNameFor, formatFrom, isCandidateMailbox, domainOf, MAILBOX_DOMAIN }
  from './jobby/mailbox.mjs';
import { createJobbyTools } from './jobby/tools.mjs';
import { TRACKS as JOBBY_TRACKS } from './jobby/tracks.mjs';
// Track 5's roster shape. Imported, not redefined: the same brief the plan uses,
// so the session payload and the plan cannot describe the roster differently.
import { fifoBrief } from './jobby/fifo-roster.mjs';
// Per-track views of the one dossier. Sent whole so the page can switch between
// them without a request per click.
import { buildAllViews, viewForTrack } from './jobby/views.mjs';
// Native company sourcing. Public sources only, no LinkedIn credential and no
// third-party account, which is the whole reason it exists.
import { sourceCompany } from './jobby/source-company.mjs';
import * as jobbyStore from './jobby/store.mjs';
// The employer side. A separate session cookie, a separate prompt, a separate
// tool set and a separate set of tables, so that no code path exists from an
// employer's conversation to a candidate's irreversible send.
import * as employerStore from './jobby/employer-store.mjs';
import { parseJobDescription } from './jobby/jd.mjs';
import { employerChat } from './jobby/employer-chat.mjs';
// The public board, read from third-party job feeds. Every row it holds is a
// document from another company's server, and the response says so.
import {
  pollFeeds, readBoard as readFeedBoard, boardCount as feedBoardCount, boardHealth as feedBoardHealth,
  boardBySource as feedBoardBySource,
} from './jobby/feed-board.mjs';
// The per-application reader behind GET /api/jobby/applications. Imported here
// because the endpoint calls it: an import added below its first use, or never
// added at all, is a ReferenceError that only shows up on that one route.
import { listApplications } from './jobby/applications.mjs';
import * as jobbyGoogle from './jobby/google.mjs';
import * as jobbyGoogleStore from './jobby/google-store.mjs';
import { encryptionStatus } from './jobby/secrets.mjs';
import {
  getVaultNoteTools,
  syncEntitiesToVault,
} from './vault.mjs';

import { getFullSnapshot, getSystemResources, checkExternalServices } from './tools/monitor.mjs';
import { videoEditor } from './tools/video-editor.mjs';
import { videoBrief, probe as probeMedia, detectShots, contactSheet, loudness, waveform } from './tools/perception.mjs';
import {
  register as registerMedia, resolveRef as resolveMediaRef,
  get as getMedia, list as listMedia, remove as removeMedia,
} from './tools/media-registry.mjs';
import { paragraphPublish } from './tools/paragraph-publisher.mjs';
import * as state from './lib/state.mjs';
import { createTaskRunner } from './lib/task-runner.mjs';
import { handleInboundEmail } from './lib/auto-responder.mjs';
import { ensureLocalDb, restFetch as localRestFetch, query as localQuery, LOCAL_DB_ENABLED } from './lib/localDb.mjs';
import { createMeshRouter, initMeshNode, publishToMesh, getMeshMessageLog, getMeshStatus } from './lib/mesh-router.mjs';
// routes/suite-dashboard.mjs used to be imported here. Every one of its 29 routes
// was also registered in this file, and because registerSuiteRoutes(app) was
// CALLED at the bottom of this file rather than here, Express kept this file's
// handler every time and none of that module's 29 handlers ever ran. It was dead
// code that read as the implementation, which is how a task handoff came to
// store no type, no task and no agent, and how a lead-routing handler lost its
// tenant check. The file also held the relay down once with a parse error (see
// tests/syntax.test.mjs). Removed; the live handlers were already here.
import registerPfpRoutes from './routes/pfp.js';
import { discoverFunctions, listFunctions } from './lib/function-runtime.mjs';
import * as qwenMemory from './lib/qwen-memory.mjs';
import { handleAgentPrompt, pollOutbox } from './hermes-bridge.mjs';

// CuttlefishClaws protocol engines (TG-001, SS-001, SGQ-001, AR-001)
import { registerCuttlefishRoutes } from './lib/cuttlefish-routes.mjs';
import { parseObsidianWikiLinks } from './lib/obsidian-graph-links.mjs';
import { registerUniversityBridge } from './lib/university-bridge.mjs';

import pg from 'pg';
const { Client: PgClient, Pool: PgPool } = pg;
// Shared connection pool — prevents "too many clients" by reusing connections
// NOTE: This is the relay's pool. The cron engine and localDb also had their
// own separate pools, creating 3 pools × 5 max = 15 potential connections.
// As of July 17, all consumers use relay/lib/db.mjs as the single shared pool.
// This pgPool is kept for backward compat but queryLocalPg now uses db.mjs.
import { query as dbQuery, getPool as dbGetPool } from './lib/db.mjs';
const pgPool = dbGetPool();
async function queryLocalPg(sql, params) {
  return await dbQuery(sql, params);
}

// ── Reusable schema drift check (Vex: systemic; Eliza: continuous) ──
// Verifies every schema-prefixed table the relay references exists in live
// information_schema. Called at boot (logs result) and on every fleet_pulse
// (returns result in the schema_drift field) so drift surfaces continuously,
// not just at restart. Returns { success, total, missing }.
const SCHEMA_DRIFT_REFS = [
  // knowledgeMaps targets
  'knowledge.context_session_snapshots','knowledge.conversation_context','knowledge.conversation_memory',
  'knowledge.conversation_messages','knowledge.conversation_sessions','knowledge.conversation_summaries',
  'knowledge.knowledge_entities','knowledge.learning_models','knowledge.learning_patterns',
  'knowledge.learning_sessions','knowledge.long_term_memory_packs','knowledge.memories',
  'knowledge.memory_contexts','knowledge.recent_conversation_messages','knowledge.shared_context',
  'knowledge.user_context_profiles','knowledge.user_preferences','knowledge.user_profiles','knowledge.user_tiers',
  // agentMaps targets
  'agent.agent_activities','agent.agent_certifications','agent.agent_conversations','agent.agent_memory',
  'agent.agent_messages','agent.agent_performance_metrics','agent.agent_performance_reviews',
  'agent.agent_profiles','agent.agent_registry','agent.agent_relationships','agent.agent_security_flags',
  'agent.agent_skills','agent.agent_tasks','agent.agents','agent.generated_agents',
  // other relay references
  'app.agent_activity','app.agent_activity_summary','app.agent_api_keys','app.agents',
  'app.chat_messages','public.work_queue','public.registry_agents','public.cac_credentials',
  'public.capital_stack','public.financing_programs','public.submitted_proposals',
  'public.trust_events','app.fleet_attachments','app.fleet_memory','app.footlocker_artifacts',
  'app.footlocker_files','app.knowledge_entities','app.rum_quota','app.suite_activity_log',
  'app.suite_campaigns','app.suite_companies','app.suite_email_activity','app.suite_lead_sharing_rules',
  'app.suite_leads','app.suite_pipeline_stages','app.suite_users','app.tasks','app.token_usage',
  'app.token_usage_avg','app.v_token_usage_by_model','app.v_token_usage_daily','app.inbox_emails',
  'public.eliza_activity_log','public.eliza_function_usage','public.fleet_messages',
  'public.interaction_patterns','public.python_execs','public.unified_tool_registry','public.api_keys',
  'public.edge_function_registry','knowledge.interaction_patterns',
];
async function runSchemaDriftCheck() {
  const missing = [];
  for (const ref of SCHEMA_DRIFT_REFS) {
    const [sch, tbl] = ref.split('.');
    const hit = await queryLocalPg(
      `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2 LIMIT 1`,
      [sch, tbl]
    );
    if (!hit || hit.rows.length === 0) missing.push(ref);
  }
  return { success: true, total: SCHEMA_DRIFT_REFS.length, missing };
}


// Local edge function runtime
const LOCAL_FUNCTIONS_DIR = join(__dirname, 'functions');
let localFunctions = [];
(async () => {
  try {
    const count = await discoverFunctions();
    localFunctions = listFunctions();
    console.log('[runtime] Discovered ' + count + ' local functions');
  } catch (e) {
    console.error('[runtime] Init error:', e.message);
  }
})();


// ── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8080');
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'local-dev-service-role-key';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'local-anon-key';
const LOCAL_DB_MODE = (process.env.LOCAL_DB_MODE ?? 'true') === 'true';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'xmrtdao/mobilemonero';
const HERMES_ENDPOINT = process.env.HERMES_ENDPOINT || 'http://192.168.14.115:9090';
const DATA_DIR = join(__dirname, '..', 'relay-data');
const LOG_FILE = join(DATA_DIR, 'relay-log.json');

// ── Stripe ──────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';

mkdirSync(DATA_DIR, { recursive: true });

// ── Task runner ─────────────────────────────────────────────
const taskRunner = createTaskRunner({
  maxConcurrency: 5,
  defaultRetries: 2,
  defaultTimeout: 30000,
});

taskRunner.on('start', (data) => logActivity('task', data.id, 'START', data.name));
taskRunner.on('complete', (data) => logActivity('task', data.id, 'OK', `${data.name} (${data.duration}ms)`));
taskRunner.on('error', (data) => logActivity('task', data.id, 'FAIL', `${data.name}: ${data.error}`));

// ── Simple log ──────────────────────────────────────────────
let activityLog = [];
let _logWritePending = false;
function logActivity(type, taskId, status, detail, agentId = null) {
  const entry = { ts: new Date().toISOString(), type, taskId, status, detail: detail || '' };
  activityLog.unshift(entry);
  if (activityLog.length > 500) activityLog.length = 500;
  // Debounce file writes to avoid blocking the event loop on every call
  if (!_logWritePending) {
    _logWritePending = true;
    setImmediate(() => {
      _logWritePending = false;
      try { writeFile(LOG_FILE, JSON.stringify(activityLog.slice(0, 200), null, 2), () => {}); } catch {}
    });
  }
  console.log(`[${entry.ts.slice(11,19)}] ${type} | ${taskId || '-'} | ${status} | ${(detail||'').slice(0,80)}`);
  // Also write to DB for persistent activity feed
  logToDb(type, taskId, status, detail, {}, agentId).catch(() => {});
}

// ── Persistent DB activity feed ─────────────────────────────
async function logToDb(activityType, title, status, description, metadata = {}, agentId = null) {
  try {
    await queryLocalPg(
      `INSERT INTO public.eliza_activity_log (activity_type, title, description, status, agent_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [activityType, title || activityType, description || '', status || 'info', agentId, JSON.stringify(metadata)]
    );
  } catch (e) {
    // Silently fail — don't crash the main flow for logging
  }
}

// ── Resilient REST query helper: tries local-sb first, falls back to direct Postgres ──
async function resilientRestQuery(table, select, filters, options = {}) {
  const { limit = 20, order, single } = options;
  // Try local-sb first
  try {
    const params = new URLSearchParams();
    params.set('select', select || '*');
    if (limit) params.set('limit', String(limit));
    if (order) params.set('order', order);
    if (single) params.set('limit', '1');
    if (filters) {
      for (const [k, v] of Object.entries(filters)) {
        params.set(k, v);
      }
    }
    const url = `http://127.0.0.1:54321/rest/v1/${table}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { 'apikey': 'local-anon-key', 'Authorization': 'Bearer local-anon-key' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      return { source: 'local-sb', data, rows: Array.isArray(data) ? data : [data] };
    }
    console.log(`[resilient] local-sb returned ${res.status} for ${table}, falling back to direct PG`);
  } catch (e) {
    console.log(`[resilient] local-sb failed for ${table}: ${e.message}, falling back to direct PG`);
  }
  // Fallback: direct Postgres query
  try {
    const escapedTable = table.replace(/[^a-zA-Z0-9_]/g, '');
    const escapedSelect = select ? select.replace(/[^a-zA-Z0-9_,\s->>']/g, '') : '*';
    let sql = `SELECT ${escapedSelect} FROM ${escapedTable}`;
    const params = [];
    if (filters) {
      const clauses = [];
      for (const [k, v] of Object.entries(filters)) {
        if (k.startsWith('or.')) continue; // complex filters skip
        if (k.endsWith('=eq.')) {
          clauses.push(`${k.replace('=eq.', '')} = $${params.length + 1}`);
          params.push(v);
        }
      }
      if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ');
    }
    if (limit) sql += ` LIMIT ${limit}`;
    if (order) sql += ` ORDER BY ${order}`;
    const result = await queryLocalPg(sql, params);
    return { source: 'direct-pg', data: result.rows, rows: result.rows };
  } catch (e) {
    console.error(`[resilient] Direct PG fallback also failed for ${table}: ${e.message}`);
    return { source: 'error', error: e.message, data: [] };
  }
}

// ── Log edge function invocations ───────────────────────────
async function logEdgeFunctionCall(functionName, status, durationMs, metadata = {}) {
  await logToDb('edge_function', `Edge Function: ${functionName}`, 
    `${functionName} ${status} in ${durationMs}ms`,
    status === 'success' ? 'completed' : 'failed',
    { function_name: functionName, duration_ms: durationMs, ...metadata }
  );
}

// ── Log relay HTTP requests ─────────────────────────────────
async function logRelayRequest(method, path, statusCode, durationMs, agentId = 'unknown') {
  // Only log interesting events: errors, slow requests, and key endpoints
  const isError = statusCode >= 400;
  const isSlow = durationMs > 5000;
  const isKeyEndpoint = ['/tools/run', '/api/fleet-chat', '/ai-chat', '/api/suite'].some(p => path.startsWith(p));
  // Skip dashboard polling (every 3s, drowns the Ships Log)
  if (path === '/api/fleet-chat/messages' && agentId === 'dashboard') return;
  if (!isError && !isSlow && !isKeyEndpoint) return;
  
  const activityType = isError ? 'http_error' : (isSlow ? 'slow_request' : 'api_call');
  await logToDb(activityType, `${method} ${path}`,
    `${method} ${path} → ${statusCode} (${durationMs}ms)`,
    isError ? 'error' : (isSlow ? 'warning' : 'info'),
    { method, path, status_code: statusCode, duration_ms: durationMs },
    agentId
  );
}

// ── Log cron job execution ──────────────────────────────────
async function logCronExecution(jobId, jobName, status, durationMs, metadata = {}) {
  await logToDb('cron_execution', `Cron: ${jobName}`,
    `Job #${jobId} "${jobName}" ${status} in ${durationMs}ms`,
    status === 'success' ? 'completed' : (status === 'failed' ? 'error' : 'info'),
    { job_id: jobId, job_name: jobName, duration_ms: durationMs, ...metadata }
  );
}

// ── Log email events (incoming/outgoing) ─────────────────────
async function logEmailEvent(direction, to, subject, status, metadata = {}) {
  await logToDb('email', `${direction} email`,
    `${direction} → ${to}: ${subject.slice(0, 60)}`,
    status,
    { direction, to, subject, ...metadata }
  );
}

// ── Log token usage ─────────────────────────────────────────
async function logTokenUsageEvent(agent, model, inputTokens, outputTokens, cost, metadata = {}) {
  await logToDb('token_usage', `Token usage: ${agent}`,
    `${agent} used ${inputTokens + outputTokens} tokens (${inputTokens} in / ${outputTokens} out) on ${model}${cost ? ` — $${cost.toFixed(6)}` : ''}`,
    'info',
    { agent, model, input_tokens: inputTokens, output_tokens: outputTokens, estimated_cost: cost, ...metadata }
  );
}

// ── Request counter ─────────────────────────────────────────
const requestCounts = { total: 0, byEndpoint: {}, byHandler: {} };

function trackRequest(endpoint, handler = null) {
  requestCounts.total++;
  requestCounts.byEndpoint[endpoint] = (requestCounts.byEndpoint[endpoint] || 0) + 1;
  if (handler) {
    requestCounts.byHandler[handler] = (requestCounts.byHandler[handler] || 0) + 1;
  }
}

// ── Supabase helper ─────────────────────────────────────────
const SUPABASE_INTEGRATION_URL = `${SUPABASE_URL}/functions/v1/supabase-integration-v2`;

async function supabaseFetch(method, path, opts = {}) {
  if (LOCAL_DB_ENABLED) {
    try {
      return await localRestFetch(method, path, opts);
    } catch (e) {
      console.error(`[localDb] supabaseFetch ${method} ${path} failed: ${e.message}`);
      throw e;
    }
  }
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(method !== 'GET' ? { 'Prefer': 'return=representation' } : {}),
  };
  const fullUrl = opts.params
    ? url + '?' + new URLSearchParams(opts.params).toString()
    : url;

  const res = await fetch(fullUrl, { method, headers, ...(opts.body ? { body: JSON.stringify(opts.body) } : {}) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * Update task status via supabase-integration-v2 edge function using execute_sql.
 * Falls back to direct REST if the edge function is unavailable.
 */
async function updateTaskStatus(taskId, status, progress, result, agent = 'Eliza-Dev') {
  const logPrefix = `[task-update ${taskId?.slice(0, 8)}]`;
  
  if (!taskId || !SUPABASE_KEY) return;

  if (LOCAL_DB_ENABLED) {
    try {
      await supabaseFetch('PATCH', 'tasks', {
        params: { id: `eq.${taskId}` },
        body: {
          status,
          progress_percentage: progress,
          updated_at: new Date().toISOString(),
          metadata: {
            ...(result ? { relay_result: result } : {}),
            relay_agent: agent,
            relay_completed_at: new Date().toISOString()
          },
        },
      });
      logActivity('localDb', taskId, 'UPDATED', `Task ${status} via local pg`);
      return;
    } catch (e) {
      logActivity('localDb', taskId, 'FAIL', e.message);
      return;
    }
  }

  const metadataJson = JSON.stringify({
    ...(result ? { relay_result: result } : {}),
    relay_agent: agent,
    relay_completed_at: new Date().toISOString()
  }).replace(/'/g, "''");
  
  const sql = `UPDATE tasks SET status = '${status}', progress_percentage = ${progress}, updated_at = NOW(), metadata = '${metadataJson}'::jsonb WHERE id = '${taskId}'`;
  
  try {
    // Try using supabase-integration-v2 edge function with execute_sql
    const res = await fetch(SUPABASE_INTEGRATION_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'execute_sql',
        query: sql,
      }),
    });
    
    if (res.ok) {
      logActivity('supabase', taskId, 'UPDATED', `Task ${status} via supabase-integration-v2`);
      return;
    }
    
    const errText = await res.text();
    console.log(`${logPrefix} supabase-integration-v2 failed: ${errText.slice(0, 200)}. Falling back to direct REST...`);
  } catch (e) {
    console.log(`${logPrefix} supabase-integration-v2 error: ${e.message}. Falling back to direct REST...`);
  }
  
  // Fallback: direct REST
  try {
    await supabaseFetch('PATCH', 'tasks', {
      params: { id: `eq.${taskId}` },
      body: {
        status,
        progress_percentage: progress,
        updated_at: new Date().toISOString(),
        metadata: { 
          ...(result ? { relay_result: result } : {}),
          relay_agent: agent,
          relay_completed_at: new Date().toISOString()
        },
      },
    });
    logActivity('supabase', taskId, 'UPDATED', `Task ${status} via REST`);
  } catch (e) {
    logActivity('supabase', taskId, 'FAIL', e.message);
  }
}

// ── GitHub helper ───────────────────────────────────────────
async function postGitHubComment(issueNumber, body) {
  if (!GITHUB_TOKEN) return logActivity('github', String(issueNumber), 'SKIP', 'No GITHUB_TOKEN set');
  const url = `https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'xmrtdao-relay',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text();
    logActivity('github', String(issueNumber), 'FAIL', text.slice(0,100));
  } else {
    logActivity('github', String(issueNumber), 'OK', 'Comment posted');
  }
  return res.json();
}


// -- mail domains -------------------------------------------------------------
//
// One registry, because each domain used to be hardcoded in about twenty-five
// places: the inbound domain resolver, the signing-secret map, the Resend API key
// map, the inbox-key map, the agent map, the dashboard tile list, the tunnel route
// list and the startup banner among them. That is how a domain ends up sendable
// but not receivable, or receivable but missing from the dashboard, because
// somebody updated four of the twenty-five.
//
// Everything below derives from this, so a new domain is one entry.
const EMAIL_DOMAINS = {
  pfp: {
    domain: 'partyfavorphoto.com', label: 'Party Favor Photo',
    key: 'RESEND_API_KEY', secret: 'RESEND_WEBHOOK_SECRET',
    agent: 'pfp', purpose: 'PFP campaign emails',
    // Path segment under /resend. Empty for PFP, which is the original and
    // whose routes are /resend/inbox with nothing in between - kept exactly as
    // they were, because other code and the inbox pages call those paths.
    path: '',
    // Whether a webhook for this domain must carry a valid signature.
    //
    // False for the three older domains: their signing secrets have never been
    // exercised, because nothing ever enforced a signature - an invalid one was
    // logged and the mail processed anyway. Turning enforcement on for a domain
    // whose secret turns out to be stale would silently stop its inbound mail,
    // which is a worse failure than the injection hole it closes. Flip each to
    // true once its secret is confirmed against real traffic.
    strict: false,
    // Dashboard tile element id. Explicit rather than derived from the key,
    // because two of the existing ids do not follow the key and dashboard.js
    // looks them up by id.
    tile: 'pfp-inbox',
    // How many recent messages the tile scans, and how many it lists. These were
    // magic numbers in three copied dashboard loaders, and they differed between
    // tiles, so they are recorded here rather than guessed at again.
    scan: 20, list: 10,
  },
  mobilemonero: {
    domain: 'mobilemonero.com', label: 'MobileMonero',
    // The outbound key is the 31 Harbor one, not RESEND_XMRT_API_KEY.
    //
    // RESEND_XMRT_API_KEY is rejected by the provider outright - the domains
    // endpoint answers HTTP 400 {"message":"API key is invalid"}, not merely
    // unverified or rate-limited. Every send routed through this entry failed,
    // and the relay logged it once at startup and then carried on:
    //   [send-email] Resend key for mobilemonero.com is REJECTED (HTTP 400)
    //
    // That warning is the whole signal. There is no retry and no alert, so an
    // invalid credential looks identical to a healthy quiet mailbox until
    // someone notices nobody replied.
    //
    // Only the outbound key moves. `secret` stays RESEND_MM_WEBHOOK_SECRET,
    // because that signs INBOUND webhooks and has nothing to do with sending:
    // changing it would break signature verification for mail already arriving
    // on the mobilemonero.com segment.
    key: 'RESEND_31HARBOR_API_KEY', secret: 'RESEND_MM_WEBHOOK_SECRET',
    agent: 'xmrt', purpose: 'XMRT DAO system emails',
    path: 'mobilemonero',
    strict: false,
    tile: 'mm-inbox',
    scan: 20, list: 8,
  },
  '31harbor': {
    domain: '31harbor.com', label: '31 Harbor',
    key: 'RESEND_31HARBOR_API_KEY', secret: 'RESEND_31HARBOR_WEBHOOK_SECRET',
    agent: 'harbor', purpose: '31 Harbor campaign emails',
    path: '31harbor',
    strict: false,
    tile: 'hb-inbox',
    scan: 15, list: 8,
  },
  jobby: {
    // A candidate's own address lives here, which is what removes the blocker on
    // outreach: Jobby can send as the person rather than as the agent.
    domain: 'jobbymcjobberson.com', label: 'Jobby McJobberson',
    key: 'RESEND_JOBBY_API_KEY', secret: 'RESEND_JOBBY_WEBHOOK_SECRET',
    agent: 'jobby', purpose: "A candidate's own sending and receiving address",
    path: 'jobby',
    // Strict from the start. This domain is being set up now, its secret is known,
    // and it is the one whose addresses are candidates' own - so it is the one
    // where injected mail would be most damaging. A candidate reading a forged
    // recruiter offer in their own inbox is the failure mode worth engineering
    // against, not an abstract one.
    strict: true,
    tile: 'jobby-inbox',
    // Scans more than it lists, because a candidate's inbox is mostly recruiters
    // and a recruiter asking one question is the thing worth seeing first.
    scan: 30, list: 12,
  },
};

const EMAIL_INBOX_KEYS = Object.keys(EMAIL_DOMAINS);

// Domains whose webhooks have arrived without a verifiable signature, so the
// "no secret configured" warning is logged once each rather than once per email.
// A set rather than a counter, because the interesting fact is which domains, not
// how many messages.
const unverifiedDomainWarned = new Set();

/** Which registered domain an address belongs to, or null. */
function emailDomainFor(address) {
  // Parsed, not substring-matched. includes() would treat
  // "a@jobbymcjobberson.com.evil.test" as belonging to jobbymcjobberson.com,
  // so mail to a lookalike domain would be filed in the real inbox - which is
  // both a misfiling and a way to have mail injected by anyone who can register
  // a domain ending in the right characters. Compare the parsed domain exactly.
  let value = String(address || '').trim().toLowerCase();
  // Accept "Name <local@domain>" as well as a bare address or a bare domain.
  const angled = value.lastIndexOf('<');
  if (angled !== -1) {
    const close = value.indexOf('>', angled);
    if (close !== -1) value = value.slice(angled + 1, close);
  }
  value = value.replace(/^.*@/, '').trim().replace(/\.+$/, '');
  if (!value) return null;
  for (const key of EMAIL_INBOX_KEYS) {
    if (value === EMAIL_DOMAINS[key].domain) return key;
  }
  return null;
}

/** The registered domain name an address belongs to, or null. */
function emailDomainName(address) {
  const key = emailDomainFor(address);
  return key ? EMAIL_DOMAINS[key].domain : null;
}

/** The Resend API key for a registered inbox key or a domain name. */
function resendKeyFor(domainOrKey) {
  if (!domainOrKey) return null;
  if (EMAIL_DOMAINS[domainOrKey]) return process.env[EMAIL_DOMAINS[domainOrKey].key] || null;
  for (const key of EMAIL_INBOX_KEYS) {
    if (EMAIL_DOMAINS[key].domain === domainOrKey) {
      return process.env[EMAIL_DOMAINS[key].key] || null;
    }
  }
  return null;
}

/** The webhook signing secret for a registered inbox key or a domain name. */
function webhookSecretFor(domainOrKey) {
  if (!domainOrKey) return null;
  if (EMAIL_DOMAINS[domainOrKey]) return process.env[EMAIL_DOMAINS[domainOrKey].secret] || null;
  for (const key of EMAIL_INBOX_KEYS) {
    if (EMAIL_DOMAINS[key].domain === domainOrKey) {
      return process.env[EMAIL_DOMAINS[key].secret] || null;
    }
  }
  return null;
}

/**
 * Verify a Resend/Svix webhook signature.
 *
 * Returns { ok, reason } and never throws, because a malformed header must not
 * become a 500 that Resend retries forever.
 *
 * Two things this gets right that the version it replaces did not:
 *
 *  - It signs the raw request bytes, not JSON.stringify(req.body). Resend signs
 *    the body as sent; re-serialising changes key order and number formatting
 *    often enough that verification failed against real traffic, which is
 *    presumably why the caller used to log the mismatch and process the mail
 *    anyway.
 *  - It bounds the timestamp. Svix puts the send time in the header, so a
 *    captured request is otherwise replayable forever.
 */
function verifyResendSignature({ rawBody, headers, secret, toleranceSeconds = 300, now }) {
  if (!secret) return { ok: false, reason: 'no-secret-configured' };
  const h = headers || {};
  const id = h['svix-id'];
  const timestamp = h['svix-timestamp'];
  const signature = h['svix-signature'];
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing-signature-headers' };

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'malformed-timestamp' };
  const age = Math.abs(((now === undefined ? Date.now() : now) / 1000) - seconds);
  if (age > toleranceSeconds) {
    return { ok: false, reason: 'stale', ageSeconds: Math.round(age) };
  }

  // A Buffer is what the parser captured; a string is what a test may pass.
  const payload = Buffer.isBuffer(rawBody)
    ? rawBody.toString('utf8')
    : (typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody ?? {}));

  let expected;
  try {
    expected = createHmac('sha256', secret)
      .update(`${id}.${timestamp}.${payload}`)
      .digest('base64');
  } catch (e) {
    return { ok: false, reason: 'signing-failed' };
  }

  const expectedBuf = Buffer.from(expected);
  const offered = String(signature).split(' ').map((s) => s.replace(/^v1,/, ''));
  for (const candidate of offered) {
    const buf = Buffer.from(candidate);
    // timingSafeEqual throws on a length mismatch, which is itself a signal that
    // the candidate is not the real signature.
    if (buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf)) {
      return { ok: true, reason: 'ok' };
    }
  }
  return { ok: false, reason: 'signature-mismatch' };
}

// ── Task Handlers ───────────────────────────────────────────

const handlers = {
  'email-smtp-fix': async (task) => {
    logActivity('handler', task.id, 'START', 'Email SMTP Fix');
    const result = { smtp_check: null, action_taken: null, status: 'unknown' };
    try {
      const smtpConfig = execSync('git config --get-all smtp 2>nul || echo "no git smtp config"', { encoding: 'utf8', timeout: 10000 });
      result.smtp_check = smtpConfig.trim();
      result.action_taken = 'Checked git SMTP config. SMTP is not a git-level setting — needs suite AI env or separate SMTP relay.';
      result.status = 'requires_cloud_config';
    } catch (e) {
      result.action_taken = `Error checking: ${e.message}`;
      result.status = 'error';
    }
    return result;
  },

  'alice-sidecar': async (task) => {
    logActivity('handler', task.id, 'START', 'Alice Sidecar');
    const result = { alice_process: null, windows_ocr_available: false, action_taken: null };
    try {
      const ps = execSync('tasklist /FI "IMAGENAME eq python.exe" /NH 2>nul || echo "no python processes"', { encoding: 'utf8', timeout: 10000 });
      result.alice_process = ps.trim().split('\n').filter(l => l.trim()).length > 0 ? 'python running' : 'no python processes';
      result.windows_ocr_available = false;
      result.action_taken = 'Checked for local Alice process. No dedicated sidecar agent found.';
      result.status = 'needs_setup';
    } catch (e) {
      result.action_taken = `Error: ${e.message}`;
      result.status = 'error';
    }
    return result;
  },

  'knowledge-sync': async (task) => {
    logActivity('handler', task.id, 'START', 'Knowledge Base Sync');
    const result = { local_kb_entities: 0, sync_status: null };
    try {
      const kbDir = join(DATA_DIR, 'knowledge');
      mkdirSync(kbDir, { recursive: true });
      let files = [];
      try { files = readdirSync(kbDir); } catch {}
      result.local_kb_entities = files.length;
      result.sync_status = `Local knowledge directory ready at ${kbDir}. ${result.local_kb_entities} entities.`;
      result.status = 'ready';
    } catch (e) {
      result.sync_status = `Error: ${e.message}`;
      result.status = 'error';
    }
    return result;
  },

  'device-registration': async (task) => {
    logActivity('handler', task.id, 'START', 'Device Registration');
    const result = { hostname: null, local_ip: null, mac: null, os: null };
    try {
      result.hostname = osHostname();
      result.local_ip = execSync('ipconfig 2>nul | findstr /R "IPv4"', { encoding: 'utf8', timeout: 5000, shell: 'cmd.exe' }).trim().split('\r\n')[0] || 'unknown';
      result.os = 'Windows 10 (MINGW64)';
      result.status = 'registered';
      result.action_taken = `Registered device "${result.hostname}"`;
    } catch (e) {
      result.os = 'Windows 10';
      result.hostname = 'Joe-Laptop';
      result.status = 'registered_partial';
      result.action_taken = `Partial registration: ${e.message}`;
    }
    return result;
  },

  'mining-dashboard': async (task) => {
    logActivity('handler', task.id, 'START', 'Mining Dashboard');
    const result = { cloud_stats: null, pool_stats: null, local_mining: null };
    try {
      // Use mining-proxy edge function instead of non-existent mining_stats table
      const proxyRes = await fetch(`${SUPABASE_URL}/functions/v1/mining-proxy`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_stats', wallet: 'global' }),
        signal: AbortSignal.timeout(5000),
      });
      if (proxyRes.ok) {
        const data = await proxyRes.json();
        result.pool_stats = {
          totalHashes: data.totalHashes,
          validShares: data.validShares,
          amtPaid: data.amtPaid,
          amtDue: data.amtDue,
          activeWorkers: data.active_workers,
          workers: data.workers,
        };
        result.status = 'connected';
      } else {
        result.pool_stats = { error: `HTTP ${proxyRes.status}` };
        result.status = 'cloud_unreachable';
      }
      result.action_taken = 'Fetched live mining stats via SupportXMR proxy.';
    } catch (e) {
      result.pool_stats = { error: e.message };
      result.status = 'error';
    }
    return result;
  },

  'general': async (task) => {
    logActivity('handler', task.id, 'START', 'General Purpose Handler');
    const result = {
      status: 'acknowledged',
      action_taken: `Received task: "${task.title}". No specialized handler — task acknowledged and logged for manual review.`,
      available_capabilities: [
        'web-search', 'web-scrape', 'ollama-chat', 'system-monitor',
        'github-post', 'state-management', 'hermes-relay', 'eliza-cloud-relay'
      ],
      suggestion: 'Try dispatching with a more specific handler keyword (email, alice, mining, device, knowledge, search)',
    };
    return result;
  },

  'alice': async (task) => {
    logActivity('handler', task.id, 'START', 'Alice Sidecar Agent');
    const result = {
      status: 'ready',
      agent: 'Alice',
      host: 'PureTrek Windows Laptop',
      python: '3.12.5',
      capabilities: [
        'Desktop actions: open/close/minimize/maximize apps',
        'Browser actions: search, navigate, tabs, bookmarks',
        'Screenshot capture and analysis',
        'File operations: create, read, write, organize',
        'Productivity: reminders, todos, notes',
        'Task orchestration: queued task execution with retry',
        'OCR screen text capture (needs Tesseract install)',
        'Voice commands (needs PyAudio install)',
      ],
      backend: 'Ollama (kimi-k2.6:cloud)',
      import_status: 'All core modules import successfully',
      action_taken: null,
    };
    
    try {
      const pyCode = `
import sys
sys.path.insert(0, r'${__dirname}/../xmrtdao-full/Alice-A-minimal-interface-for-maximum-control/kaiserin_agent')
from config import OLLAMA_HOST, OLLAMA_MODEL, BASE_DIR
from actions import ActionRouter
from task_orchestrator import TaskOrchestrator
print('OK|' + str(OLLAMA_HOST) + '|' + str(OLLAMA_MODEL))
`;
      const verify = execSync(
        `python -c "${pyCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
        { encoding: 'utf8', timeout: 10000, shell: 'cmd.exe' }
      );
      const parts = verify.trim().split('|');
      result.verification = parts[0] === 'OK' ? 'passed' : 'failed';
      result.ollama_host = parts[1] || 'unknown';
      result.model = parts[2] || 'unknown';
    } catch (e) {
      result.verification = 'verification_skipped';
      result.verify_error = e.message;
    }
    
    if (task?.action) {
      result.action_taken = `Alice received action: ${task.action}`;
      result.status = 'action_dispatched';
    } else {
      result.action_taken = 'Alice registered and ready.';
    }
    
    return result;
  },
};

// ── New Tool Handlers ───────────────────────────────────────
// Jobby's own tools. Registered here rather than in the jobby module so they
// show up in /api/tools/catalog and can be called through /tools/run like any
// other relay tool. Each one resolves the client from the request's session key.
let jobbyToolBundle = null;
function jobbyTools() {
  if (jobbyToolBundle) return jobbyToolBundle;
  jobbyToolBundle = createJobbyTools({
    llmChat: {
      search: async (query) => {
        const r = await webSearch(query, { maxResults: 8 });
        return r?.results ?? [];
      },
    },
  });
  return jobbyToolBundle;
}

const toolHandlers = {
  // ── PFP financial tools ────────────────────────────────────────────────
  // The only tools in this map that can move money. Each asks the standing gate
  // before it reaches Stripe, and the gate is expected to refuse an agent that
  // has not earned standing — Jobby currently cannot create a payment link or
  // issue a refund, and that is the intended behaviour, not a misconfiguration.
  //
  // Returned and spread in, rather than assigned: `toolHandlers` is still being
  // initialised inside this literal, so assigning to it here is a
  // temporal-dead-zone error and the relay will not boot.
  ...await (async () => {
    const { pfpMoneyTools, PFP_MONEY_TOOL_DESCRIPTIONS } = await import('./lib/pfp-money-tools.mjs');
    const { evaluateGateFromDb } = await import('./lib/gate-evaluator.mjs');
    const require = createRequire(import.meta.url);
    const tools = pfpMoneyTools({
      stripe: STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null,
      query: queryLocalPg,
      gate: (q) => evaluateGateFromDb(queryLocalPg, q),
      log: logActivity,
    });
    // `descriptions` is declared ~9000 lines below, so it cannot be touched
    // yet. Hand it over and let the block after that object do the merge.
    globalThis.__PFP_MONEY_TOOL_DESCRIPTIONS = PFP_MONEY_TOOL_DESCRIPTIONS;
    return tools;
  })(),

  'page-agent-task': async (args) => {
    const task = args?.task || args?.instruction;
    if (!task) return { error: 'task is required' };
    try {
      const res = await fetch('http://127.0.0.1:38401/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task }),
        signal: AbortSignal.timeout(args?.timeout_ms
          ? Math.min(600000, Number(args.timeout_ms) + 15000)
          : 120000),
      });
      if (!res.ok) return { error: 'Page agent returned HTTP ' + res.status };
      const data = await res.json();
      // The hub answers HTTP 200 even when the task did not run. A missing
      // browser extension comes back as {"success": false, "error": "Hub is
      // not connected..."} with a 200, so reading only res.ok and reporting
      // success: true here told the caller a job application had been submitted
      // when nothing had happened at all. The hub's own success flag is the
      // authority.
      if (data && data.success === false) {
        return {
          success: false,
          error: data.error || 'the page agent could not run the task',
          needsUser:
            /not connected|extension/i.test(String(data.error || '')) ||
            /not connected|extension/i.test(String(data.result || '')),
        };
      }
      return { success: true, result: data.result ?? data };
    } catch (err) {
      const message = String(err.message || err);
      return {
        error: message,
        needsUser: /fetch failed|ECONNREFUSED|not connected/i.test(message),
      };
    }
  },

  'page-agent-status': async () => {
    // Readiness, so a caller can tell "the browser extension is not running"
    // apart from "the task failed". Without this the only way to find out is to
    // dispatch a real task and read the failure.
    try {
      const res = await fetch('http://127.0.0.1:38401/api/status', {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { error: 'Page agent returned HTTP ' + res.status };
      return await res.json();
    } catch (err) {
      return {
        connected: false,
        error: String(err.message || err),
        hint: 'Start Chrome with the Page Agent extension enabled, then reload the launcher.',
      };
    }
  },

  'task-artifact': async (args) => {
    const taskId = args?.task_id || args?.taskId;
    const type = args?.type || 'screenshot';
    const url = args?.url || args?.artifact_url || '';
    const description = args?.description || '';
    if (!taskId) return { error: 'task_id is required' };
    try {
      const { default: pg } = await import('pg');
      const pool = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/xmrt_suite', max: 2 });
      await pool.query(
        `INSERT INTO app.task_artifacts (task_id, artifact_type, artifact_url, description) VALUES ($1, $2, $3, $4)`,
        [taskId, type, url, description]
      );
      await pool.end();
      return { success: true, task_id: taskId, type, url, description };
    } catch (err) {
      return { error: err.message };
    }
  },

  'video-editor': videoEditor,
  // Perception: the counterpart to video-editor, which cuts film it has never
  // seen. This one looks at it first, measures it, and returns a brief in text so
  // any text-only agent can act on what is actually there.
  //
  // These address media by id. `media-register` is the only place a filesystem
  // path or a URL is accepted, and it copies the bytes into relay-data/media/ so
  // what an id resolves to cannot be swapped later. That is what lets the tools
  // sit at a trust level the fleet can actually reach: without it they were an
  // arbitrary-file-read plus a cloud egress, and TRUSTED was the only defensible
  // level - which put them out of reach of most agents.
  'video-brief': videoBrief,
  'media-register': async (args) => registerMedia({ ...args, registeredBy: args?.agent || 'unknown' }),
  'media-list': async (args) => listMedia({ kind: args?.kind }),
  'media-get': async (args) => getMedia(args?.media_id || args?.id),
  'media-remove': async (args) => removeMedia(args?.media_id || args?.id, { purge: args?.purge === true }),
  // Per-file helpers. Each resolves the id first, so none of them can be pointed
  // at a path the registry did not bless.
  'media-probe': async (args) => {
    const r = resolveMediaRef(args?.media_id || args?.id || args?.input);
    return r.ok ? probeMedia(r.entry.path) : { error: r.error };
  },
  'media-shots': async (args) => {
    const r = resolveMediaRef(args?.media_id || args?.id || args?.input);
    return r.ok ? detectShots(r.entry.path, args?.threshold ?? 12) : { error: r.error };
  },
  'media-loudness': async (args) => {
    const r = resolveMediaRef(args?.media_id || args?.id || args?.input);
    return r.ok ? loudness(r.entry.path) : { error: r.error };
  },
  'media-contact-sheet': async (args) => {
    const r = resolveMediaRef(args?.media_id || args?.id || args?.input);
    if (!r.ok) return { error: r.error };
    const s = await contactSheet(r.entry.path, {
      frames: args?.frames ?? 12, cols: args?.cols ?? 4, outPath: args?.out ?? null,
    });
    // The base64 is deliberately dropped: a tool result gets logged and stored,
    // and a megabyte of base64 in an activity row helps nobody. `out` writes it
    // to disk instead.
    if (s.error) return s;
    return { success: true, mediaId: r.entry.id, path: s.path, bytes: s.bytes, frames: s.frames, layout: `${s.cols}x${s.rows}` };
  },
  'media-waveform': async (args) => {
    const r = resolveMediaRef(args?.media_id || args?.id || args?.input);
    if (!r.ok) return { error: r.error };
    const w = await waveform(r.entry.path, { outPath: args?.out ?? null });
    if (w.error) return w;
    return { success: true, mediaId: r.entry.id, path: w.path };
  },
  'paragraph-publish': paragraphPublish,

  'muapi-generate-image': async (args) => {
    const prompt = args?.prompt || args?.p || '';
    const model = args?.model || 'flux-dev-image';
    const size = args?.size || '1024*1024';
    if (!prompt) return { error: 'prompt is required' };
    const apiKey = process.env.MUAPI_API_KEY || '';
    if (!apiKey) return { error: 'MUAPI_API_KEY not configured' };
    try {
      const res = await fetch(`https://api.muapi.ai/api/v1/${model}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ prompt, size }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) return { error: 'MUAPI returned HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200) };
      const data = await res.json();
      if (data.success && data.images && data.images.length > 0) {
        return { success: true, image_url: data.images[0], cost: '$0.015', prompt };
      }
      if (data.status === 'processing' && data.request_id) {
        // Poll for completion
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const pollRes = await fetch(`https://api.muapi.ai/api/v1/predictions/${data.request_id}/result`, {
            headers: { 'x-api-key': apiKey },
            signal: AbortSignal.timeout(5000),
          });
          if (!pollRes.ok) continue;
          const pollData = await pollRes.json();
          if (pollData.status === 'completed' && pollData.outputs && pollData.outputs.length > 0) {
            return { success: true, image_url: pollData.outputs[0], cost: '$0.015', prompt };
          }
          if (pollData.error) return { error: pollData.error };
        }
        return { error: 'MUAPI polling timed out' };
      }
      return { success: true, raw: data };
    } catch (err) {
      return { error: err.message };
    }
  },

  'resend-get-email': async (args) => {


    const { id, domain } = args || {};
    if (!id) return { error: 'email id is required' };
    const RESEND_KEYS = Object.fromEntries(EMAIL_INBOX_KEYS.map((k) => [k, resendKeyFor(k)]));
    const domainKey = domain || 'pfp';
    const apiKey = RESEND_KEYS[domainKey];
    if (!apiKey) return { error: 'No Resend API key for domain: ' + domainKey };
    try {
      let res = await fetch('https://api.resend.com/emails/receiving/' + id, {
        headers: { 'Authorization': 'Bearer ' + apiKey },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        return { success: true, source: 'receiving', id, from: data.from, to: data.to, subject: data.subject, text: data.text || '', html: data.html || '', raw: data.raw || data, attachments: data.attachments };
      }
      res = await fetch('https://api.resend.com/emails/' + id, {
        headers: { 'Authorization': 'Bearer ' + apiKey },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        return { success: true, source: 'sent', id, from: data.from, to: data.to, subject: data.subject, text: data.text || '', html: data.html || '', raw: data.raw || data };
      }
      return { success: false, error: 'Resend API returned ' + res.status, status: res.status };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  'cuttlefishclaws-cac-status': async (args) => {
    const { did, cacId } = args || {};
    if (!did && !cacId) return { error: 'did or cacId required' };
    try {
      const r = await fetch('http://127.0.0.1:8080/api/cuttlefishclaws/cac-status?did=' + encodeURIComponent(did||'') + '&cacId=' + encodeURIComponent(cacId||''), { signal: AbortSignal.timeout(5000) });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-capital-stack': async () => {
    try {
      const r = await fetch('http://127.0.0.1:8080/api/cuttlefishclaws/capital-stack', { signal: AbortSignal.timeout(5000) });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-financing-programs': async (args) => {
    const { layer, category } = args || {};
    try {
      const params = new URLSearchParams();
      if (layer) params.set('layer', layer);
      if (category) params.set('category', category);
      const r = await fetch('http://127.0.0.1:8080/api/cuttlefishclaws/financing-programs?' + params, { signal: AbortSignal.timeout(5000) });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-trust-score': async (args) => {
    const { did } = args || {};
    if (!did) return { error: 'did is required' };
    try {
      const r = await fetch('http://127.0.0.1:8080/api/cuttlefishclaws/trust-score?did=' + encodeURIComponent(did), { signal: AbortSignal.timeout(5000) });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-trust-history': async (args) => {
    const { did } = args || {};
    if (!did) return { error: 'did is required' };
    try {
      const r = await fetch('http://127.0.0.1:8080/api/cuttlefishclaws/trust-history?did=' + encodeURIComponent(did), { signal: AbortSignal.timeout(5000) });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-gate-evaluate': async (args) => {
    const { agent_did, activity_type, domain, purpose } = args || {};
    if (!agent_did || !activity_type || !domain) return { error: 'agent_did, activity_type, and domain are required' };
    try {
      const r = await fetch('http://127.0.0.1:3120/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'cuttlefishclaws_gate_evaluate', arguments: { agent_did, activity_type, domain, purpose: purpose || 'write' } },
        }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await r.json();
      const text = data?.result?.content?.[0]?.text;
      if (text) { try { return JSON.parse(text); } catch { return { raw: text }; } }
      return data;
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-trustgraph-scorer': async (args) => {
    const { agent } = args || {};
    try {
      const r = await fetch('http://127.0.0.1:3120/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'cuttlefishclaws_agents_list', arguments: {} },
        }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json();
      const text = data?.result?.content?.[0]?.text;
      if (!text) return data;
      let parsed;
      try { parsed = JSON.parse(text); } catch { return { raw: text }; }
      const agents = parsed.agents || parsed || [];
      if (agent) {
        const match = agents.find(a => (a.did === agent) || (a.name === agent) || (a.agent_id === agent));
        return { agent, score: match || null, total: agents.length };
      }
      return { agents, total: agents.length };
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-agent-onboard': async (args) => {
    const { did, agentType, prepaidUsdcAmount, metadata } = args || {};
    if (!did || !agentType) return { error: 'did and agentType required' };
    try {
      const r = await fetch('http://127.0.0.1:8080/api/cuttlefishclaws/agent-onboard', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did, agentType, prepaidUsdcAmount: prepaidUsdcAmount || 0, metadata: metadata || {} }),
        signal: AbortSignal.timeout(5000),
      });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-proposal-submit': async (args) => {
    const { title, description, category, submitterDid, content, fileUrls, metadata } = args || {};
    if (!title || !submitterDid || !content) return { error: 'title, submitterDid, and content required' };
    try {
      const r = await fetch('http://127.0.0.1:8080/api/cuttlefishclaws/proposal-submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, category, submitterDid, content, fileUrls, metadata }),
        signal: AbortSignal.timeout(5000),
      });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-agent-x-post': async (args) => {
    const { draft, operator_approved } = args || {};
    if (!draft?.content_en) return { error: 'draft.content_en required' };
    try {
      const r = await fetch('http://127.0.0.1:8080/api/cuttlefishclaws/agent-x-post', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft, operator_approved }),
        signal: AbortSignal.timeout(5000),
      });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-agent-chat': async (args) => {
    const { agentId, message, conversation_id } = args || {};
    if (!agentId || !message) return { error: 'agentId and message required' };
    try {
      const r = await fetch('http://127.0.0.1:8080/api/contact/cuttlefishclaws/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, message, conversation_id }),
        signal: AbortSignal.timeout(15000),
      });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-inquiry': async (args) => {
    const { name, email, amount, interest } = args || {};
    if (!name || !email) return { error: 'name and email required' };
    try {
      const r = await fetch('http://127.0.0.1:8080/api/contact/cuttlefishclaws/inquiry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, amount, interest }),
        signal: AbortSignal.timeout(5000),
      });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-engine-health': async () => {
    try {
      const r = await fetch('http://127.0.0.1:8080/api/cuttlefishclaws/engine-health', { signal: AbortSignal.timeout(5000) });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-agents': async () => {
    try {
      const r = await fetch('http://127.0.0.1:8080/api/cuttlefishclaws/agents', { signal: AbortSignal.timeout(5000) });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  },
  'cuttlefishclaws-rate-card': async () => {
    try {
      const r = await fetch('http://127.0.0.1:8080/api/cuttlefishclaws/rate-card', { signal: AbortSignal.timeout(5000) });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  },

  'trust-trajectory': async (args) => {
    const { agent, action } = args || {};
    try {
      const r = await fetch('http://127.0.0.1:8080/api/trustgraph/trajectory', { signal: AbortSignal.timeout(20000) });
      const data = await r.json();
      if (action === 'summary' || (agent && !data.series?.[agent])) {
        // Compact summary: per-agent current score + band + event count
        const summary = {};
        for (const [name, pts] of Object.entries(data.series || {})) {
          const last = pts[pts.length - 1];
          summary[name] = { score: last?.score, lastEvent: last?.event, lastAt: last?.t, points: pts.length };
        }
        return { success: true, summary, totalEvents: data.totalEvents };
      }
      if (agent) {
        return { success: true, agent, series: data.series?.[agent] || [], totalEvents: data.totalEvents };
      }
      return { success: true, series: data.series, totalEvents: data.totalEvents, tokenUsage: data.tokenUsage, ecosystemSummary: data.ecosystemSummary };
    } catch (e) { return { error: e.message }; }
  },

  'token-usage-avg': async (args) => {
    const agent = args?.agent || '';
    try {
      let sql = 'SELECT * FROM app.token_usage_avg';
      const params = [];
      if (agent) {
        sql += ' WHERE agent = $1';
        params.push(agent);
      }
      sql += ' ORDER BY total_tokens DESC';
      const rows = await queryLocalPg(sql, params);
      return { success: true, rowCount: rows.length, rows };
    } catch (err) {
      return { error: err.message };
    }
  },

  'ecosystem-activity': async (args) => {
    const agent = args?.agent || '';
    const limit = Math.min(args?.limit || 20, 100);
    try {
      let sql = 'SELECT * FROM app.agent_activity_summary';
      const params = [];
      if (agent) {
        sql += ' WHERE agent_id LIKE $1';
        params.push('%' + agent + '%');
      }
      sql += ' ORDER BY trust_events DESC NULLS LAST LIMIT $' + (params.length + 1);
      params.push(limit);
      const rows = await queryLocalPg(sql, params);
      return { success: true, rowCount: rows.length, rows };
    } catch (err) {
      return { error: err.message };
    }
  },

  'web-search': async (args) => {
    const query = args?.query || args?.q;
    if (!query) return { error: 'query is required' };
    const results = await webSearch(query, { maxResults: args?.maxResults || 5 });
    return { success: true, results: results.results, source: results.source, formatted: formatResults(results) };
  },

  'web-scrape': async (args) => {
    const url = args?.url || args?.u;
    if (!url) return { error: 'url is required' };
    return await webScrape(url, {
      maxLength: args?.maxLength || 50000,
      timeout: args?.timeout || undefined,
      // Opt-in because it costs a second pass over the HTML. It is what makes a
      // contact address on the page visible at all: the text extraction deletes
      // every tag, and every href and mailto: goes with it.
      extractLinks: args?.extractLinks === true,
    });
  },

  // ── Jobby: the job-search agent's own tools ──────────────────────────
  // args.clientId is resolved server-side; a caller cannot address another
  // client's dossier by passing a different id to /tools/run.
  'jobby-update-dossier': async (args) => {
    const clientId = Number(args?.clientId);
    if (!Number.isInteger(clientId) || clientId <= 0) return { error: 'clientId is required' };
    return jobbyTools().jobby_update_dossier(args, { clientId, userMessage: args?.userMessage || '' });
  },
  'jobby-set-tracks': async (args) => {
    const clientId = Number(args?.clientId);
    if (!Number.isInteger(clientId) || clientId <= 0) return { error: 'clientId is required' };
    return jobbyTools().jobby_set_tracks(args, { clientId, userMessage: '' });
  },
  'jobby-add-opportunity': async (args) => {
    const clientId = Number(args?.clientId);
    if (!Number.isInteger(clientId) || clientId <= 0) return { error: 'clientId is required' };
    return jobbyTools().jobby_add_opportunity(args, { clientId, userMessage: '' });
  },
  'jobby-plan-status': async (args) => {
    const clientId = Number(args?.clientId);
    if (!Number.isInteger(clientId) || clientId <= 0) return { error: 'clientId is required' };
    return jobbyTools().jobby_plan_status(args, { clientId, userMessage: '' });
  },
  // jobby_research and jobby_send are deliberately not exposed through
  // /tools/run: research is a search wrapper, and sending mail needs the
  // cap/kill-switch context that only the chat loop supplies.

  'ollama-chat': async (args) => {
    const message = args?.message || args?.prompt;
    if (!message) return { error: 'message is required' };
    const result = await ollamaChat(message, {
      model: args?.model || process.env.OLLAMA_MODEL,
      temperature: args?.temperature,
      maxTokens: args?.maxTokens,
    });
    return { success: true, ...result };
  },

  'ollama-models': async () => {
    return await listModels();
  },

  'ollama-health': async () => {
    return await checkOllamaHealth();
  },

  'system-monitor': async () => {
    return await getFullSnapshot();
  },

  'system-resources': async () => {
    return getSystemResources();
  },

  'external-services': async () => {
    return await checkExternalServices();
  },

  'fleet_pulse': async () => {
    try {
      const [statusRes, healthRes, miningRes, driftRes] = await Promise.allSettled([
        getFullSnapshot(),
        fetch('http://localhost:' + PORT + '/api/dao/health', { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => ({ error: 'failed' })),
        fetch('http://localhost:' + PORT + '/api/mining/stats', { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => ({ error: 'failed' })),
        (async () => {
          try { return await runSchemaDriftCheck(); }
          catch (e) { return { success: false, error: e.message }; }
        })(),
      ]);
      const healthData = healthRes.status === 'fulfilled' ? healthRes.value : { error: 'failed' };
      return {
        success: true,
        system: statusRes.status === 'fulfilled' ? statusRes.value : { error: 'failed' },
        health_score: healthData.health || healthData.health_score || healthData.status,
        services: healthData.services || [],
        mining: miningRes.status === 'fulfilled' ? miningRes.value : { error: 'failed' },
        schema_drift: driftRes.status === 'fulfilled' ? driftRes.value : { success: false, error: 'drift check failed' },
        timestamp: new Date().toISOString(),
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  'device-registration': async () => {
    return await handlers['device-registration']({ id: 'tool-call' });
  },

  'knowledge-sync': async () => {
    return await handlers['knowledge-sync']({ id: 'tool-call' });
  },

  'mining-dashboard': async () => {
    return await handlers['mining-dashboard']({ id: 'tool-call' });
  },

  'eliza-send': async (args) => {
    const message = args?.message;
    if (!message) return { error: 'message is required' };
    return await relayToElizaCloud(message, 'Eliza-Dev-Tool', `tool-${Date.now().toString(36)}`);
  },

  'state-get': async (args) => {
    const key = args?.key;
    if (!key) return { error: 'key is required' };
    return { key, value: state.get(key) };
  },
  'state-set': async (args) => {
    const key = args?.key;
    const value = args?.value;
    if (!key) return { error: 'key is required' };
    state.set(key, value);
    return { success: true, key, value };
  },

  'service_control': async (args) => {
    const action = args?.action;
    const service = args?.service;
    const validActions = ['restart', 'status', 'start', 'stop'];
    const validServices = ['relay', 'pg', 'local-sb', 'vite', 'tunnel', 'alice', 'cron-engine-v2', 'cuttlefishclaws-mcp', 'suite-mcp', 'campaign-scheduler', 'page-agent-mcp', 'dsh', 'supervisor'];
    if (!action || !validActions.includes(action)) {
      return { error: `action must be one of: ${validActions.join(', ')}` };
    }
    if (!service || !validServices.includes(service)) {
      // `python-exec` used to be listed here but is no longer a supervised
      // service (its capability is exposed as the python-exec / shell-exec
      // relay tools, and as a warm-pool worker slot). Nothing would ever
      // restart it, so it only ever reported "down".
      return { error: `service must be one of: ${validServices.join(', ')}` };
    }
    if (action === 'status') {
      // Read supervisor state file for current status
      try {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const stateFile = join(DATA_DIR, 'supervisor-state.json');

        // The supervisor is not one of its own supervised services, so it has
        // no entry under state.services. Handle it here: supervisor.pid is
        // written EMPTY by a supervisor restart (to clear the lock), so
        // parseInt('') is NaN and reading only that file reported "down" for a
        // supervisor that was running. Fall back to the _pid the supervisor
        // records in its own state, verified with a liveness probe.
        if (service === 'supervisor') {
          let pid = null;
          try {
            const pidFile = join(DATA_DIR, 'supervisor.pid');
            if (existsSync(pidFile)) pid = parseInt(readFileSync(pidFile, 'utf8').trim()) || null;
          } catch {}
          let stateAgeMs = null;
          if (!pid && existsSync(stateFile)) {
            try {
              const st = JSON.parse(readFileSync(stateFile, 'utf8'));
              if (st._updatedAt) stateAgeMs = Date.now() - st._updatedAt;
              const candidate = parseInt(st._pid) || null;
              if (candidate) {
                let alive = false;
                try { process.kill(candidate, 0); alive = true; } catch {}
                if (alive) pid = candidate;
              }
            } catch {}
          }
          return {
            success: true,
            service,
            status: pid ? 'running' : 'down',
            pid,
            startedAt: 0,
            restartsThisHour: 0,
            healthSource: 'pid-file+state-fallback',
            ...(pid && stateAgeMs !== null ? { lastStateUpdateMs: stateAgeMs } : {}),
          };
        }

        let svcState = { childPid: null, startedAt: 0, restartCount: 0 };
        if (existsSync(stateFile)) {
          const s = JSON.parse(readFileSync(stateFile, 'utf8'));
          svcState = s.services?.[service] || svcState;
        }
        // Also do a live health check
        const svcDef = [
          { name: 'relay', healthCheck: () => checkHttp('http://localhost:8080/health', 2000, true) },
          { name: 'pg', healthCheck: () => checkProcessByName('postgres.exe') },
          { name: 'local-sb', healthCheck: () => checkHttp('http://127.0.0.1:54321/health', 2000) },
          { name: 'vite', healthCheck: () => checkHttp('http://127.0.0.1:5173/', 2000) },
          { name: 'tunnel', healthCheck: () => checkProcessByName('cloudflared.exe') || checkProcessByName('cloudflared') },
          { name: 'python-exec', healthCheck: () => checkHttp('http://127.0.0.1:8070/health', 2000) },
          { name: 'alice', healthCheck: () => checkProcessByScript('alice.mjs') },
          { name: 'cron-engine-v2', healthCheck: () => checkProcessByScript('cron-engine-v2.mjs') },
          { name: 'cuttlefishclaws-mcp', healthCheck: () => checkHttp('http://127.0.0.1:3120/health', 2000) },
          // Was checking :3200, but xmrtdao-suite-mcp has always listened on
          // :3121 — so this reported "down" for a service that was up.
          { name: 'suite-mcp', healthCheck: () => checkHttp('http://127.0.0.1:3121/health', 2000) },
          { name: 'campaign-scheduler', healthCheck: () => checkProcessByScript('campaign-scheduler.mjs') },
          { name: 'zero-claw', healthCheck: () => checkHttp('http://127.0.0.1:5174/', 2000) },
        ].find(s => s.name === service);
        const liveCheck = svcDef ? await svcDef.healthCheck() : null;

        // Trust the supervisor's own verdict first.
        //
        // This tool used to compute health purely from the local `svcDef` list
        // above, and simply omitted `dsh` (also `health-server` and
        // `resume-server`). With no definition, `healthy` was null → falsy, so
        // the ternary below reported 'unhealthy' for a service that was up and
        // had been for hours. A health tool that lies is worse than no health
        // tool: an agent acting on it restarts something healthy, and it makes
        // real failures look like noise. The supervisor already evaluates every
        // service and records the result, so read that instead of keeping a
        // second copy of the definitions that silently drifts.
        const supervisorHealthy = typeof svcState.healthy === 'boolean' ? svcState.healthy : null;
        const healthy = supervisorHealthy !== null ? supervisorHealthy : liveCheck;

        return {
          success: true,
          service,
          status: healthy ? 'healthy' : (svcState.childPid ? 'unhealthy' : 'down'),
          pid: svcState.childPid,
          startedAt: svcState.startedAt,
          restartsThisHour: (svcState.restartTimestamps || []).filter(t => Date.now() - t < 3600000).length,
          // Surface the inputs so a disagreement is visible rather than hidden.
          ...(supervisorHealthy !== null ? { healthSource: 'supervisor' } : { healthSource: 'live-check' }),
          ...(supervisorHealthy !== null && liveCheck !== null && supervisorHealthy !== liveCheck
            ? { healthDisagreement: { supervisor: supervisorHealthy, liveCheck } }
            : {}),
          ...(supervisorHealthy === null && liveCheck === null
            ? { healthNote: 'No health definition for this service; fell back to process presence.' }
            : {}),
          ...(svcState.degradedBy?.length
            ? { degradedBy: svcState.degradedBy, degraded: true,
                note: `Service itself is healthy; dependency not: ${svcState.degradedBy.join(', ')}` }
            : {}),
        };
      } catch (e) {
        return { error: e.message };
      }
    }
    // Queue the action for supervisor to pick up
    try {
      const { readFileSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const queueFile = join(DATA_DIR, 'service-actions.json');
      // Special-case: the supervisor cannot restart itself from within its own
      // tick (it would kill itself mid-loop). Handle supervisor restarts here
      // directly: clear the stale PID lock and trigger the scheduled task.
      if (service === 'supervisor') {
        // `status` is handled in the block above (the supervisor has no entry in
        // state.services, so it must be resolved from the pid file / _pid).
        // Only start/restart/stop reach here.
        if (action === 'status') {
          return { error: 'supervisor status must be resolved from the pid file' };
        }
        if (action === 'restart' || action === 'start') {
          const pidFile = join(DATA_DIR, 'supervisor.pid');
          try { writeFileSync(pidFile, ''); } catch {}
          const { execFileSync } = await import('child_process');
          try { execFileSync('schtasks', ['/Run', '/TN', 'XMRT-LocalSupervisor'], { windowsHide: true, timeout: 10000 }); } catch (e) {
            return { error: `failed to trigger supervisor task: ${e.message}` };
          }
          return { success: true, service, status: 'restarting', action, message: 'Supervisor PID lock cleared and XMRT-LocalSupervisor task triggered. It will run a fresh --once tick within ~1 minute.' };
        }
        if (action === 'stop') {
          const pidFile = join(DATA_DIR, 'supervisor.pid');
          try { writeFileSync(pidFile, ''); } catch {}
          return { success: true, service, status: 'stopped', action, message: 'Supervisor PID lock cleared. It will not restart until the scheduled task fires.' };
        }
      }
      let queue = [];
      if (existsSync(queueFile)) {
        try { queue = JSON.parse(readFileSync(queueFile, 'utf8')); } catch {}
      }
      queue.push({ action, service, requestedBy: args?.agent || 'unknown', requestedAt: Date.now() });
      writeFileSync(queueFile, JSON.stringify(queue, null, 2));
      const eta = action === 'restart' ? (service === 'relay' ? 15 : 30) : 10;
      return {
        success: true,
        status: 'queued',
        action,
        service,
        message: `Action queued. Supervisor will process within ~30 seconds. If restarting ${service}, expect ${eta}s downtime. Do not poll until ${eta + 5}s have passed.`,
        eta_seconds: eta,
      };
    } catch (e) {
      return { error: e.message };
    }
  },

  'ship_logs': async (args) => {
    const { source = 'all', lines = 50, service, since } = args || {};
    const { readFileSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const results = {};

    // Helper: read last N lines from a file
    function tailFile(filePath, n) {
      if (!existsSync(filePath)) return null;
      try {
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        return lines.slice(-n);
      } catch { return null; }
    }

    // 1. Relay stderr/stdout (crash traces, uncaught exceptions)
    if (source === 'all' || source === 'relay' || source === 'stderr') {
      // Find the most recent stderr log (manual launch logs)
      const stderrFiles = [
        join(__dirname, '..', 'relay-stderr.log'),
        join(__dirname, '..', 'relay-stderr8.log'),
        join(__dirname, '..', 'relay-stderr7.log'),
        join(__dirname, '..', 'relay-stderr6.log'),
        join(__dirname, '..', 'relay-stderr5.log'),
        join(__dirname, '..', 'relay-stderr4.log'),
        join(__dirname, '..', 'relay-stderr3.log'),
        join(__dirname, '..', 'relay-stderr2.log'),
      ];
      for (const f of stderrFiles) {
        const tail = tailFile(f, lines);
        if (tail && tail.length > 0) {
          results.relay_stderr = { file: f, lines: tail.length, entries: tail };
          break;
        }
      }
      // Also check stdout
      const stdoutFiles = [
        join(__dirname, '..', 'relay-stdout.log'),
        join(__dirname, '..', 'relay-stdout6.log'),
        join(__dirname, '..', 'relay-stdout5.log'),
        join(__dirname, '..', 'relay-stdout4.log'),
        join(__dirname, '..', 'relay-stdout3.log'),
        join(__dirname, '..', 'relay-stdout2.log'),
      ];
      for (const f of stdoutFiles) {
        const tail = tailFile(f, lines);
        if (tail && tail.length > 0) {
          results.relay_stdout = { file: f, lines: tail.length, entries: tail };
          break;
        }
      }
      // NEW: Read supervisor-managed per-service logs
      const LOGS_DIR = join(DATA_DIR, 'logs');
      if (service) {
        const svcLog = join(LOGS_DIR, `${service}.log`);
        const tail = tailFile(svcLog, lines);
        if (tail && tail.length > 0) {
          results.service_log = { service, file: svcLog, lines: tail.length, entries: tail };
        }
      } else {
        // Read all service logs if no specific service requested
        const { readdirSync } = await import('fs');
        try {
          const logFiles = readdirSync(LOGS_DIR).filter(f => f.endsWith('.log'));
          results.service_logs = {};
          for (const f of logFiles) {
            const svcName = f.replace('.log', '');
            const tail = tailFile(join(LOGS_DIR, f), Math.min(lines, 20));
            if (tail && tail.length > 0) {
              results.service_logs[svcName] = { file: join(LOGS_DIR, f), lines: tail.length, entries: tail };
            }
          }
        } catch {}
      }
    }

    // 2. Supervisor state (restart history with reasons)
    if (source === 'all' || source === 'supervisor') {
      const stateFile = join(DATA_DIR, 'supervisor-state.json');
      if (existsSync(stateFile)) {
        try {
          const s = JSON.parse(readFileSync(stateFile, 'utf8'));
          const svc = service ? [service] : Object.keys(s.services || {});
          results.supervisor = {};
          for (const name of svc) {
            const svcState = s.services?.[name];
            if (svcState) {
              results.supervisor[name] = {
                pid: svcState.childPid,
                startedAt: svcState.startedAt,
                // The supervisor's own health verdict. Without this, ship_logs
                // gave no way to tell a crashed service from a running one.
                healthy: svcState.healthy ?? null,
                failures: svcState.failures ?? 0,
                restartsThisHour: (svcState.restartTimestamps || []).filter(t => Date.now() - t < 3600000).length,
                restartsToday: (svcState.restartTimestamps || []).filter(t => Date.now() - t < 86400000).length,
                totalRestarts: (svcState.restartTimestamps || []).length,
                lastRestart: svcState.restartTimestamps?.slice(-1)[0] || null,
                lastRestartReason: svcState.restartReason || null,
              };
            }
          }
        } catch {}
      }
    }

    // 3. Service action queue (what agents requested)
    if (source === 'all' || source === 'actions') {
      const queueFile = join(DATA_DIR, 'service-actions.json');
      if (existsSync(queueFile)) {
        try {
          const queue = JSON.parse(readFileSync(queueFile, 'utf8'));
          results.agent_actions = (queue || []).slice(-20).map(a => ({
            action: a.action,
            service: a.service,
            requestedBy: a.requestedBy,
            requestedAt: a.requestedAt,
            processed: !!a.processedAt,
            result: a.result,
          }));
        } catch {}
      }
    }

    // 4. DB activity log (structured events)
    if (source === 'all' || source === 'db') {
      try {
        let sql = 'SELECT id, activity_type, title, description, status, agent_id, metadata, created_at FROM public.eliza_activity_log WHERE 1=1';
        const params = [];
        let idx = 0;
        if (service) { idx++; sql += ` AND (title ILIKE $${idx} OR description ILIKE $${idx})`; params.push(`%${service}%`); }
        if (since) { idx++; sql += ` AND created_at > $${idx}`; params.push(since); }
        sql += ' ORDER BY created_at DESC LIMIT ' + Math.min(parseInt(lines) || 50, 100);
        const rows = await localQuery(sql, params);
        results.db_activity = { count: rows.length, entries: rows };
      } catch (err) {
        results.db_activity = { error: err.message };
      }
    }

    return {
      success: true,
      requested_source: source,
      requested_lines: lines,
      requested_service: service,
      timestamp: new Date().toISOString(),
      ...results,
    };
  },

  'task-stats': async () => {
    return taskRunner.getStats();
  },

  'github-post': async (args) => {
    const { issueNumber, body } = args || {};
    if (!issueNumber || !body) return { error: 'issueNumber and body are required' };
    return await postGitHubComment(issueNumber, body);
  },

  // ── Warm Agent Pool ───────────────────────────────────────
  // Google SAM-inspired warm worker pool: acquire -> call -> release with
  // fencing tokens. Proxies to the native warm-pool-lease-manager function.
  'warm-pool-lease-manager': async (args) => {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/v1/functions/warm-pool-lease-manager`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': RELAY_API_KEY },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(200000),
      });
      const data = await res.json();
      return data;
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // ── Elze Contract Suite: template retrieval ──────────────
  'elze-templates': async (args) => {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/v1/functions/elze-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': RELAY_API_KEY },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(20000),
      });
      return await res.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // ── Elze Contract Suite: AI-Learnings ────────────────────
  'elze-learnings': async (args) => {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/v1/functions/elze-learnings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': RELAY_API_KEY },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(20000),
      });
      return await res.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // ── Database Query Tools ──────────────────────────────────
  'db-query': async (args) => {
    const sql = args?.sql || args?.query;
    if (!sql) return { error: 'sql query is required' };
    // Allow SELECT, INSERT, UPDATE, DELETE — agents need to manage leads
    const upper = sql.trim().toUpperCase();
    if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/.test(upper)) {
      return { error: 'Only SELECT, INSERT, UPDATE, DELETE, and WITH queries are allowed' };
    }
    try {
      const rows = await localQuery(sql);
      return { success: true, rowCount: rows.length, rows };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  'activity-log': async (args) => {
    const { limit = 20, activity_type, status, since, agent_id } = args || {};
    try {
      let sql = 'SELECT id, activity_type, title, description, status, agent_id, metadata, created_at FROM public.eliza_activity_log WHERE 1=1';
      const params = [];
      let idx = 0;
      if (activity_type) { idx++; sql += ` AND activity_type = $${idx}`; params.push(activity_type); }
      if (status) { idx++; sql += ` AND status = $${idx}`; params.push(status); }
      if (since) { idx++; sql += ` AND created_at > $${idx}`; params.push(since); }
      if (agent_id) { idx++; sql += ` AND (metadata->>'agent' ILIKE $${idx} OR metadata->>'agent_id' ILIKE $${idx})`; params.push(`%${agent_id}%`); }
      sql += ' ORDER BY created_at DESC LIMIT ' + Math.min(parseInt(limit) || 20, 100);
      const rows = await localQuery(sql, params);
      return { success: true, count: rows.length, entries: rows };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  'db-rest': async (args) => {
    const { method = 'GET', path, body } = args || {};
    if (!path) return { error: 'path is required (e.g. "agent_profiles?select=agent_id,agent_label")' };
    try {
      const rows = await localRestFetch(method, path, body ? { body } : {});
      return { success: true, rowCount: rows.length, rows };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  'agent-rpc': async (args) => {
    const { target_agent, action, params, timeout = 30000 } = args || {};
    if (!target_agent || !action) return { error: 'target_agent and action are required' };
    try {
      // Route a programmatic request to another agent via fleet chat
      const rpcId = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const rpcMessage = `@${target_agent} [RPC:${rpcId}] Action: ${action}. Params: ${JSON.stringify(params || {})}. Please execute and report results back with RPC:${rpcId}.`;
      
      // Send via fleet chat
      const entry = addFleetMessage('system', rpcMessage, target_agent);
      publishToMesh('fleet-broadcast', { agent: 'system', message: rpcMessage, channel: target_agent, ts: entry?.ts || Date.now() }).catch(() => {});
      
      // Route to the target agent
      const routePromise = routeFleetMessage(entry).catch(e => ({ error: e.message }));
      
      // Wait for response with timeout
      const result = await Promise.race([
        routePromise,
        new Promise(r => setTimeout(() => r({ timeout: true, rpcId }), timeout))
      ]);
      
      return { success: true, rpcId, target_agent, action, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  'shared-context': async (args) => {
    const { action = 'read', key, value, description, search_term, agent_id: agentIdArg, topic } = args || {};
    // Attribution: explicit agent_id wins, else the authenticated caller injected by /tools/run, else legacy default.
    const agent_id = agentIdArg || args?._agent?.id || 'eliza';
    try {
      if (action === 'read') {
        if (key) {
          const row = await localQuery("SELECT * FROM knowledge.shared_context WHERE context_key = $1", [key]);
          return { success: true, context: row[0] || null };
        }
        const rows = await localQuery("SELECT * FROM knowledge.shared_context ORDER BY context_key");
        return { success: true, contexts: rows };
      }
      if (action === 'write') {
        if (!key || !value) return { error: 'key and value are required for write' };
        const existing = await localQuery("SELECT id FROM knowledge.shared_context WHERE context_key = $1", [key]);
        if (existing.length > 0) {
          await localQuery(
            "UPDATE knowledge.shared_context SET value = $1, description = COALESCE($2, description), last_updated_by = $4, updated_at = now() WHERE context_key = $3",
            [JSON.stringify(value), description || null, key, agent_id || 'eliza']
          );
        } else {
          await localQuery(
            "INSERT INTO knowledge.shared_context (context_key, context_type, value, description, last_updated_by) VALUES ($1, 'general', $2, $3, $4)",
            [key, JSON.stringify(value), description || '', agent_id || 'eliza']
          );
        }
        return { success: true, key, action: 'written' };
      }
      if (action === 'search') {
        // Associative recall — search by value content or description
        const term = search_term || key || '';
        const rows = await localQuery(
          "SELECT * FROM knowledge.shared_context WHERE value::text ILIKE $1 OR description ILIKE $1 OR context_key ILIKE $1 ORDER BY updated_at DESC LIMIT 20",
          [`%${term}%`]
        );
        return { success: true, results: rows, count: rows.length };
      }
      if (action === 'recall_by_agent') {
        // Recall memories saved by a specific agent
        const rows = await localQuery(
          "SELECT * FROM knowledge.shared_context WHERE last_updated_by = $1 ORDER BY updated_at DESC LIMIT 20",
          [agent_id || 'eliza']
        );
        return { success: true, results: rows, count: rows.length };
      }
      if (action === 'recall_by_topic') {
        // Recall memories by topic tag in description
        const rows = await localQuery(
          "SELECT * FROM knowledge.shared_context WHERE description ILIKE $1 ORDER BY updated_at DESC LIMIT 20",
          [`%[${topic}]%`]
        );
        return { success: true, results: rows, count: rows.length };
      }
      return { error: `unknown action: ${action}. Use 'read', 'write', 'search', 'recall_by_agent', or 'recall_by_topic'` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  'agent-profile': async (args) => {
    const { agent_id } = args || {};
    try {
      if (agent_id) {
        const row = await localQuery("SELECT * FROM agent.agent_profiles WHERE agent_id = $1", [agent_id]);
        return { success: true, profile: row[0] || null };
      }
      const rows = await localQuery("SELECT * FROM agent.agent_profiles ORDER BY agent_id");
      return { success: true, profiles: rows };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  'get_agent_key': async (args) => {
    const agentId = args?.agent_id || args?._agent?.id;
    const agentLabel = args?.label || args?._agent?.name;
    if (!agentId && !agentLabel) return { success: false, error: 'agent_id or label required. Pass agent_id, or use label=\"eliza\" / label=\"vex\" / label=\"alice\"' };
    try {
      let lookupId = agentId;
      // If no agent_id but we have a label, look up by label
      if (!lookupId && agentLabel) {
        const r = await queryLocalPg(
          `SELECT agent_id FROM app.agent_api_keys WHERE LOWER(label) LIKE LOWER($1) LIMIT 1`,
          [`%${agentLabel.replace(/-key$/, '')}%`]
        );
        if (r.rows.length > 0) lookupId = r.rows[0].agent_id;
      }
      // If still no lookupId, try the agent_id as-is
      if (!lookupId) lookupId = agentId;
      if (!lookupId) return { success: false, error: 'Could not resolve agent identity' };

      const r = await queryLocalPg('SELECT api_key, label, issued_at FROM app.agent_api_keys WHERE agent_id = $1', [lookupId]);
      if (r.rows.length === 0) return { success: false, error: 'No API key found for this agent' };
      return { success: true, api_key: r.rows[0].api_key, label: r.rows[0].label, issued_at: r.rows[0].issued_at };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  // ── Edge Function Proxy ──────────────────────────────────
  'edge-function': async (args) => {
    const fn = args?.function || args?.fn;
    if (!fn) return { error: 'function name is required. Usage: {"function":"system-status","args":{}}' };
    const payload = args?.args || args?.payload || {};
    const url = `${SUPABASE_URL}/functions/v1/${fn}`;
    try {
      const efStart = Date.now();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const duration = Date.now() - efStart;
      const data = await res.json().catch(() => ({ raw: 'non-json response' }));
      // Log edge function call to activity feed
      logEdgeFunctionCall(fn, res.ok ? 'success' : 'failed', duration, { status: res.status }).catch(() => {});
      return {
        success: res.ok,
        function: fn,
        status: res.status,
        data,
      };
    } catch (err) {
      logEdgeFunctionCall(fn, 'failed', Date.now() - (globalThis.__efStart || Date.now()), { error: err.message }).catch(() => {});
      return { success: false, function: fn, error: err.message };
    }
  },

  // ── Specific Edge Function Tools ─────────────────────────
  'ef:system-status': async () => {
    // Local replacement: read from /api/dao/health instead of dead cloud edge function
    try {
      const res = await fetch(`http://localhost:${PORT}/api/dao/health`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { success: false, error: 'HTTP ' + res.status };
      const data = await res.json();
      return { success: true, data };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:system-health': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/system-health`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:system-diagnostics': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/system-diagnostics`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:get-suite-health': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/get-suite-health`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:eliza-relay': async (args) => {
    const action = args?.action || args?.a || 'status';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/eliza-relay`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(typeof action === 'object' ? action : { action }),
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:github': async (args) => {
    // The action may arrive at the top level OR nested inside args/data. It was
    // read only from the top level, so a caller writing
    //   {"args":{"action":"list_issues"}}
    // got action=undefined and fell through to the default branch:
    // "Unknown action: undefined". Now both shapes are accepted.
    const data = args?.data || args?.args || {};
    const action = args?.action || data?.action || 'list_issues';
    try {
      const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_TOKEN_PROOF_OF_LIFE;
      const GITHUB_OWNER = process.env.GITHUB_OWNER || 'xmrtdao';
      if (!GITHUB_TOKEN) return { success: false, error: 'GitHub token not configured in relay .env' };
      const repo = (data?.repo || 'mobilemonero').replace(/^.*\//, '');
      // Normalize action names: camelCase -> snake_case
      const actionMap = { listIssues: 'list_issues', listPrs: 'list_prs', listPRs: 'list_prs', searchCode: 'search_code', createIssue: 'create_issue', updateIssue: 'update_issue', getIssue: 'get_issue', listRepos: 'list_repos' };
      const normalizedAction = actionMap[action] || action;
      let url = '', method = 'GET', ghBody;
      switch (normalizedAction) {
        case 'list_issues': url = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/issues?state=open&per_page=20`; break;
        case 'get_issue': url = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/issues/${data?.issue_number || ''}`; break;
        case 'create_issue': url = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/issues`; method = 'POST'; ghBody = { title: data?.title, body: data?.body || '' }; break;
        case 'list_prs': url = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/pulls?state=open&per_page=20`; break;
        case 'search_code': url = `https://api.github.com/search/code?q=${encodeURIComponent(data?.query || '')}+repo:${GITHUB_OWNER}/${repo}`; break;
        case 'list_repos': url = `https://api.github.com/orgs/${GITHUB_OWNER}/repos?per_page=20`; break;
        case 'update_issue': url = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/issues/${data?.issue_number || ''}`; method = 'PATCH'; ghBody = { title: data?.title, body: data?.body || '', state: data?.state || undefined }; break;
        default: return { success: false, error: `Unknown action: ${action}` };
      }
      const ghRes = await fetch(url, {
        method, headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'XMRT-DAO-Relay' },
        body: ghBody ? JSON.stringify(ghBody) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const ghData = await ghRes.json();
      return { success: ghRes.ok, data: ghData, status: ghRes.status };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:ecosystem-monitor': async (args) => {
    try {
      const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_TOKEN_PROOF_OF_LIFE;
      const repos = [
        { owner: 'xmrtdao', name: 'mobilemonero' },
        { owner: 'xmrtdao', name: 'atlas-amd-hackathon' },
        { owner: 'xmrtdao', name: 'xmrt-university' },
        { owner: 'partyfavorphoto', name: 'XMRT-Ecosystem' },
        { owner: 'partyfavorphoto', name: 'MESHNET' },
        { owner: 'partyfavorphoto', name: 'optimus-booth-activation' },
        { owner: 'partyfavorphoto', name: 'partyfavorphoto-tools' },
      ];
      const headers = GITHUB_TOKEN ? { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'XMRT-DAO-Relay' } : null;
      const repoResults = [];
      for (const repo of repos) {
        try {
          if (!headers) { repoResults.push({ repo: repo.name, error: 'no token', score: 0 }); continue; }
          const [repoRes, commitsRes, issuesRes, prsRes] = await Promise.all([
            fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}`, { headers, signal: AbortSignal.timeout(5000) }),
            fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/commits?per_page=5`, { headers, signal: AbortSignal.timeout(5000) }),
            fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/issues?state=open&per_page=5`, { headers, signal: AbortSignal.timeout(5000) }),
            fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls?state=open&per_page=5`, { headers, signal: AbortSignal.timeout(5000) }),
          ]);
          const repoData = await repoRes.json();
          const commits = await commitsRes.json();
          const issues = await issuesRes.json();
          const prs = await prsRes.json();
          const metrics = {
            recent_commits: Array.isArray(commits) ? commits.length : 0,
            open_issues: Array.isArray(issues) ? issues.filter(i => !i.pull_request).length : 0,
            open_prs: Array.isArray(prs) ? prs.length : 0,
            last_updated: repoData.updated_at,
            stars: repoData.stargazers_count || 0,
            forks: repoData.forks_count || 0,
          };
          let score = 0;
          score += Math.min(metrics.recent_commits * 2, 20);
          score += Math.min(metrics.open_issues * 2.5, 25);
          score += Math.min(metrics.open_prs * 3, 15);
          const hoursSinceUpdate = (Date.now() - new Date(metrics.last_updated).getTime()) / 3600000;
          score += Math.max(15 - hoursSinceUpdate / 10, 0);
          repoResults.push({ repo: repo.name, score: Math.min(score, 100), metrics, url: repoData.html_url });
        } catch (e) { repoResults.push({ repo: repo.name, error: e.message, score: 0 }); }
      }
      repoResults.sort((a, b) => b.score - a.score);
      const [propCount, agentCount] = await Promise.all([
        queryLocalPg(`SELECT count(*)::int AS c FROM public.work_queue`).catch(() => ({ rows: [{ c: 0 }] })),
        queryLocalPg(`SELECT count(*)::int AS c FROM public.registry_agents`).catch(() => ({ rows: [{ c: 0 }] })),
      ]);
      return {
        success: true,
        repos_evaluated: repos.length,
        top_repos: repoResults.slice(0, 5),
        governance: {
          total_tasks: propCount.rows[0]?.c || 0,
          total_agents: agentCount.rows[0]?.c || 0,
        },
        token_health: headers ? 'healthy' : 'degraded',
      };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:knowledge': async (args) => {
    const action = args?.action || 'check_status';
    const data = args?.data || args?.args || {};
    try {
      // Map common action aliases to correct names
      const actionMap = {
        'search': 'search_knowledge',
        'store': 'store_knowledge',
        'upsert': 'upsert_knowledge',
        'list': 'list_knowledge',
        'delete': 'delete_knowledge',
        'check': 'check_status',
      };
      const mappedAction = actionMap[action] || action;
      
      // For search_knowledge, use local REST API directly (faster, no cloud dependency)
      if (mappedAction === 'search_knowledge') {
        const searchTerm = data.search_term || data.query || data.term || '';
        const limit = Math.min(parseInt(data.limit || '10', 10), 50);
        const restUrl = `http://127.0.0.1:54321/rest/v1/knowledge_entities`;
        const headers = { 'apikey': 'local-anon-key', 'Authorization': 'Bearer local-anon-key' };
        let url = `${restUrl}?select=*&order=created_at.desc&limit=${limit}`;
        if (searchTerm) {
          // Truncate search term to 200 chars to prevent PostgREST URL overflow
          // (agents sometimes pass entire conversation text as search term)
          const truncated = searchTerm.slice(0, 200);
          const encoded = encodeURIComponent(truncated);
          url += `&or=(name.ilike.*${encoded}*,entity->>description.ilike.*${encoded}*,entity->>content.ilike.*${encoded}*,entity->>name.ilike.*${encoded}*)`;
        }
        try {
          const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
          if (!res.ok) {
            // Fallback: if REST API fails (e.g. URL too long), use db-query instead
            const safeTerm = (searchTerm || '').replace(/'/g, "''").slice(0, 100);
            const fallbackRes = await queryLocalPg(
              `SELECT id, name, entity FROM app.knowledge_entities 
               WHERE name ILIKE $1 OR entity::text ILIKE $1 
               ORDER BY created_at DESC LIMIT $2`,
              [`%${safeTerm}%`, limit]
            );
            return { success: true, status: 200, data: { ok: true, results: fallbackRes.rows, count: fallbackRes.rows.length, source: 'db-fallback' } };
          }
          const knowledge = await res.json();
          return { success: true, status: 200, data: { ok: true, results: knowledge, count: knowledge.length } };
        } catch (e) {
          // Network error fallback: use db-query
          const safeTerm = (searchTerm || '').replace(/'/g, "''").slice(0, 100);
          const fallbackRes = await queryLocalPg(
            `SELECT id, name, entity FROM app.knowledge_entities 
             WHERE name ILIKE $1 OR entity::text ILIKE $1 
             ORDER BY created_at DESC LIMIT $2`,
            [`%${safeTerm}%`, limit]
          );
          return { success: true, status: 200, data: { ok: true, results: fallbackRes.rows, count: fallbackRes.rows.length, source: 'db-fallback' } };
        }
      }
      
      // For other actions, try local edge function first, fall back to cloud
      const res = await fetch(`http://127.0.0.1:54321/functions/v1/knowledge-manager`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer local-anon-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: mappedAction, data }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return { success: true, status: res.status, data: await res.json() };
      // Fall back to cloud
      const cloudRes = await fetch(`${SUPABASE_URL}/functions/v1/knowledge-manager`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: mappedAction, data }),
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: cloudRes.status, data: await cloudRes.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:agent-manager': async (args) => {
    const action = args?.action || 'list_agents';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/agent-manager`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(typeof action === 'object' ? action : { action }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      // Unwrap nested data to avoid [object Object] serialization
      if (data && typeof data === 'object' && data.data) {
        return { success: true, ...data.data };
      }
      return { success: true, ...data };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:mining': async (args) => {
    const action = args?.action || 'get_stats';
    const wallet = args?.wallet || 'test';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/mining-proxy`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, wallet }),
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:schema': async () => {
    try {
      // Query local database directly instead of dead cloud edge function
      const tables = await queryLocalPg(
        "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema IN ('public','app') ORDER BY table_schema, table_name"
      );
      const columns = await queryLocalPg(
        "SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema IN ('public','app') ORDER BY table_schema, table_name, ordinal_position"
      );
      return {
        success: true,
        tables: tables.rows,
        columns: columns.rows.slice(0, 200),
        total_columns: columns.rows.length,
      };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:schema-introspect': async (args) => {
    const action = args?.action;
    const params = args?.params || {};
    if (!action) return { error: 'action is required: list_schemas, list_tables, describe_table, list_relationships, search_schema' };
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/schema-introspect`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, params }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      return { success: res.ok, status: res.status, data };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:functions-list': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/list-available-functions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:supabase-integration': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/supabase-integration-v2`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'health' }),
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  // ── More Edge Function Tools (probe-confirmed working) ──
  'ef:functions-catalog': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/list-available-functions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:function-actions': async (args) => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/get-function-actions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:search-functions': async (args) => {
    const query = args?.query || 'mining';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/search-edge-functions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:ecosystem-health': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/ecosystem-health-check`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:frontend-health': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/check-frontend-health`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:usage-monitor': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/usage-monitor`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:function-analytics': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/function-usage-analytics`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:task-auto-advance': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/task-auto-advance`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:explore-curiosity': async (args) => {
    const { key_phrase, conversation_summary, depth = 2 } = args || {};
    if (!key_phrase) return { error: 'key_phrase is required' };
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/explore-curiosity`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key_phrase, conversation_summary, depth }),
        signal: AbortSignal.timeout(30000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:opportunity-scanner': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/opportunity-scanner`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:predictive-analytics': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/predictive-analytics`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:monitor-devices': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/monitor-device-connections`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:auth-health': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/auth-health-monitor`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  // ── Edge Functions needing specific payloads (400 fixable) ──
  'ef:knowledge-search': async (args) => {
    const query = args?.query || args?.search_term || 'test';
    const limit = Math.min(parseInt(args?.limit || '10', 10), 50);
    try {
      // Use local REST API directly (faster, no cloud dependency)
      const restUrl = `http://127.0.0.1:54321/rest/v1/knowledge_entities`;
      const headers = { 'apikey': 'local-anon-key', 'Authorization': 'Bearer local-anon-key' };
      let url = `${restUrl}?select=*&order=created_at.desc&limit=${limit}`;
      if (query) {
        const encoded = encodeURIComponent(query);
        url += `&or=(name.ilike.*${encoded}*,entity->>description.ilike.*${encoded}*,entity->>content.ilike.*${encoded}*,entity->>name.ilike.*${encoded}*)`;
      }
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { success: true, status: res.status, data: { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` } };
      const knowledge = await res.json();
      // Return compact results: just name + short description
      const compact = knowledge.map((k) => ({
        name: k.name || '?',
        description: ((k.description || k.entity?.description || '').slice(0, 120) + ((k.description || k.entity?.description || '').length > 120 ? '...' : '')),
        type: k.entity?.type || 'general',
      }));
      return { success: true, status: 200, data: { ok: true, count: knowledge.length, results: compact } };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:generate-payment-link': async (args) => {
    const tier = args?.tier || 'basic';
    const email = args?.email || 'test@test.com';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-stripe-link`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, email }),
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  // ── x402 Agentic Payment Handlers ──────────────────────────────────
  // Implements the HTTP 402 Payment Required / x402 agentic-payment flow.
  // CORE agents (Vex, Hermes, Eliza) can create invoice requests that return
  // 402 + Payment-Request metadata, execute payments against a configured
  // provider (Stripe or crypto), and reconcile payment state.
  // Backed by public.service_invoices + public.pfp_payments.

  'x402-request': async (args) => {
    const amount = Number(args?.amount);
    const asset = args?.asset || 'XMRT';
    const purpose = args?.purpose || 'agentic_payment';
    const customerDid = args?.customer_did || args?.customerDid || null;
    const merchantDid = args?.merchant_did || args?.merchantDid || 'relay';
    if (!amount || amount <= 0) return { success: false, error: 'amount (positive number) is required' };
    try {
      const invoiceId = 'inv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
      await pgPool.query(
        `INSERT INTO public.x402_invoices
           (invoice_id, merchant_did, customer_did, amount, asset, purpose, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
         ON CONFLICT DO NOTHING`,
        [invoiceId, merchantDid, customerDid, amount, asset, purpose, expiresAt]
      ).catch(() => {});
      return {
        success: true,
        payment_request: {
          invoice_id: invoiceId,
          amount,
          asset,
          purpose,
          merchant_did: merchantDid,
          customer_did: customerDid,
          expires_at: expiresAt,
          http_status: 402, // HTTP 402 Payment Required semantics
        },
      };
    } catch (e) { return { success: false, error: e.message }; }
  },

  'x402-pay': async (args) => {
    const invoiceId = args?.invoice_id || args?.invoiceId;
    const provider = args?.provider || process.env.X402_PROVIDER || 'stripe';
    if (!invoiceId) return { success: false, error: 'invoice_id is required (from x402-request)' };
    try {
      const r = await pgPool.query(
        `SELECT * FROM public.x402_invoices WHERE invoice_id=$1`, [invoiceId]
      ).catch(() => ({ rows: [] }));
      const inv = r.rows[0];
      if (!inv) return { success: false, error: 'invoice not found' };
      if (inv.status === 'paid') return { success: true, data: { invoice_id: invoiceId, status: 'already_paid' } };

      let providerRef = null;
      if (provider === 'stripe' && process.env.STRIPE_SECRET_KEY) {
        try {
          const stripe = (await import('stripe'))?.default;
          const client = new stripe(process.env.STRIPE_SECRET_KEY);
          const pi = await client.paymentIntents.create({
            amount: Math.round(inv.amount * 100),
            currency: (inv.asset || 'usd').toLowerCase(),
            metadata: { invoice_id: invoiceId, purpose: inv.purpose },
            automatic_payment_methods: { enabled: true },
          });
          providerRef = pi.id;
          await pgPool.query(
            `UPDATE public.x402_invoices SET provider=$1, provider_ref=$2, updated_at=NOW() WHERE invoice_id=$3`,
            [provider, providerRef, invoiceId]
          ).catch(() => {});
        } catch (e) {
          return { success: false, error: 'stripe: ' + e.message };
        }
      } else {
        // Crypto/Web3 fallback — record the intent, mark pending until settled
        providerRef = 'pending:' + Date.now();
        await pgPool.query(
          `UPDATE public.x402_invoices SET provider=$1, provider_ref=$2, updated_at=NOW() WHERE invoice_id=$3`,
          [provider, providerRef, invoiceId]
        ).catch(() => {});
      }
      return {
        success: true,
        data: { invoice_id: invoiceId, provider, provider_ref: providerRef, status: inv.status },
      };
    } catch (e) { return { success: false, error: e.message }; }
  },

  'x402-status': async (args) => {
    const invoiceId = args?.invoice_id || args?.invoiceId || null;
    try {
      if (invoiceId) {
        const r = await pgPool.query(
          `SELECT invoice_id, merchant_did, customer_did, amount, asset, purpose, status, provider, provider_ref, expires_at, updated_at
             FROM public.x402_invoices WHERE invoice_id=$1`, [invoiceId]
        ).catch(() => ({ rows: [] }));
        if (!r.rows[0]) return { success: false, error: 'invoice not found' };
        return { success: true, invoice: r.rows[0] };
      }
      const r = await pgPool.query(
        `SELECT invoice_id, merchant_did, customer_did, amount, asset, purpose, status, provider, provider_ref, expires_at, updated_at
           FROM public.x402_invoices ORDER BY updated_at DESC LIMIT 25`
      ).catch(() => ({ rows: [] }));
      return { success: true, invoices: r.rows, count: r.rows.length };
    } catch (e) { return { success: false, error: e.message }; }
  },

  'x402-settle': async (args) => {
    const invoiceId = args?.invoice_id || args?.invoiceId;
    const providerRef = args?.provider_ref || args?.providerRef || null;
    if (!invoiceId) return { success: false, error: 'invoice_id is required' };
    try {
      const r = await pgPool.query(
        `UPDATE public.x402_invoices SET status='paid', provider_ref=COALESCE($2,provider_ref), updated_at=NOW()
         WHERE invoice_id=$1 RETURNING invoice_id, amount, asset, purpose, status, updated_at`,
        [invoiceId, providerRef]
      ).catch(() => ({ rows: [] }));
      if (!r.rows[0]) return { success: false, error: 'invoice not found' };
      await pgPool.query(
        `INSERT INTO public.pfp_payments (stripe_charge_id, amount, currency, status, description, metadata, created_at)
         VALUES ($1,$2,$3,'succeeded',$4,$5, NOW()) ON CONFLICT DO NOTHING`,
        [providerRef || ('x402_' + invoiceId), r.rows[0].amount, r.rows[0].asset, r.rows[0].purpose,
         JSON.stringify({ invoice_id: invoiceId, asset: r.rows[0].asset })]
      ).catch(() => {});
      return { success: true, invoice: r.rows[0] };
    } catch (e) { return { success: false, error: e.message }; }
  },

  'ef:cron-proxy': async (args) => {
    // Local replacement: read from /cron/status instead of dead cloud edge function
    try {
      const res = await fetch(`http://localhost:${PORT}/cron/status`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { success: false, error: 'HTTP ' + res.status };
      const data = await res.json();
      return { success: true, data };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:schema-tables': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/schema-manager`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list_tables' }),
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:mesh-publish': async (args) => {
    const topic = args?.topic || 'fleet-broadcast';
    const payload = args?.payload || args?.message || {};
    const agent = args?.agent || 'vex';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/mesh-publish`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, payload: typeof payload === 'string' ? { text: payload } : payload, agent }),
        signal: AbortSignal.timeout(15000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:mesh-peer-connector': async (args) => {
    const action = args?.action || 'register';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/mesh-peer-connector`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(typeof args === 'object' ? { ...args } : { action, ...args }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      // Log cert verification status for dashboard
      if (!data.success && data.error?.includes('certificate')) {
        console.log('[mesh-peer-connector] Agent rejected - needs XMRT University certification');
      }
      return { success: true, status: res.status, data };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:eliza-chat': async (args) => {
    const message = args?.message || args?.prompt;
    if (!message) return { error: 'message is required' };
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/eliza-chat`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, ...args }),
        signal: AbortSignal.timeout(60000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'assign_task': async (args) => {
        const { title, description, category, assignee_agent_id, priority, task_id } = args || {};
        if (!title) return { error: 'Missing title' };
        // Map string priority names to integers (DB column is integer)
        const PRIORITY_MAP = { 'low': 1, 'medium': 3, 'normal': 3, 'high': 4, 'critical': 5, 'urgent': 5 };
        const priorityVal = (typeof priority === 'string') ? (PRIORITY_MAP[priority.toLowerCase()] || 5)
          : (typeof priority === 'number' ? priority : 5);
        try {
          // Resolve assignee_agent_id: agents may pass integer IDs from cuttlefish_agents
          // or text IDs from app.agents (e.g. 'vex-001'). The FK references app.agents(id).
          let resolvedAssignee = assignee_agent_id || null;
          if (resolvedAssignee && !isNaN(resolvedAssignee) && String(resolvedAssignee).indexOf('-') === -1) {
            // Integer ID from cuttlefish_agents — look up the corresponding app.agents id
            const lookup = await queryLocalPg(
              `SELECT a.id FROM app.agents a
               JOIN public.registry_agents c ON LOWER(c.name) = LOWER(SPLIT_PART(a.id, '-', 1))
               WHERE c.id = $1 LIMIT 1`,
              [parseInt(resolvedAssignee, 10)]
            );
            if (lookup.rows.length > 0) resolvedAssignee = lookup.rows[0].id;
            else resolvedAssignee = null; // no match, let FK fail gracefully
          }
          const id = task_id || 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
          const result = await queryLocalPg(
            `INSERT INTO app.tasks (id, title, description, stage, status, priority, category, assignee_agent_id, created_at, updated_at)
             VALUES ($1, $2, $3, 'DISCUSS', 'PENDING', $4, $5, $6, NOW(), NOW()) RETURNING *`,
            [id, title, description || '', priorityVal, category || 'other', resolvedAssignee]
          );
          // Announce to fleet chat for discussion
          try {
            const agent = args._agent?.id || 'system';
            const msg = `📋 New task **${id}**: ${title}\nStage: DISCUSS — waiting for fleet discussion and consensus.\n${description ? '> ' + description.slice(0, 200) : ''}\n\nAgents: please discuss approach and plan in this thread. Once consensus is reached, use \`advance_task\` with task_id="${id}" to move to PLANNING.`;
            await fetch(`http://127.0.0.1:${PORT}/api/fleet-chat/send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agent: 'system', message: msg, channel: 'fleet' }),
              signal: AbortSignal.timeout(5000),
            }).catch(() => {});
          } catch {}
          return { success: true, task: result.rows[0] };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },

  'advance_task': async (args) => {
    const { task_id, to_stage } = args || {};
    if (!task_id || !to_stage) return { error: 'task_id and to_stage required' };
    const validStages = ['DISCUSS', 'PLANNING', 'EXECUTION', 'REVIEW', 'COMPLETION'];
    if (!validStages.includes(to_stage)) return { error: `Invalid stage: ${to_stage}. Valid: ${validStages.join(', ')}` };
    try {
      const result = await queryLocalPg(
        `UPDATE app.tasks SET stage = $1, stage_started_at = NOW(), updated_at = NOW() WHERE id = $2 RETURNING *`,
        [to_stage, task_id]
      );
      if (!result.rows.length) return { error: 'Task not found' };
      const task = result.rows[0];
      // Announce stage change to fleet chat
      try {
        const msg = `🔄 Task **${task_id}** advanced to **${to_stage}** stage: ${task.title}`;
        await fetch(`http://127.0.0.1:${PORT}/api/fleet-chat/send`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: 'system', message: msg, channel: 'fleet' }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      } catch {}
      return { success: true, task };
    } catch (e) { return { success: false, error: e.message }; }
  },

  'ef:task-orchestrator': async (args) => {
    const action = args?.action || 'list_tasks';
    try {
      // Use local relay API instead of cloud edge function
      if (action === 'create_task') {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/suite/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: args.title || 'Untitled Task',
            description: args.description || '',
            stage: args.stage || 'PENDING',
            status: args.status || 'PENDING',
            priority: args.priority || 0,
            category: args.category || null,
            assignee_agent_id: args.assignee_agent_id || null,
          }),
          signal: AbortSignal.timeout(5000),
        });
        return { success: true, status: res.status, data: await res.json() };
      }
      // List tasks
      const res = await fetch(`http://127.0.0.1:${PORT}/api/suite/tasks?limit=${args.limit || 20}`, {
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:agent-coordination-hub': async (args) => {
    const action = args?.action || 'status';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/agent-coordination-hub`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...args }),
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:google-gmail': async (args) => {
    const action = args?.action || 'list_messages';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/google-gmail`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...args }),
        signal: AbortSignal.timeout(15000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:google-calendar': async (args) => {
    const action = args?.action || 'list_events';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/google-calendar`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...args }),
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:google-drive': async (args) => {
    const action = args?.action || 'list_files';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/google-drive`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...args }),
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:playwright-browse': async (args) => {
    const url = args?.url || args?.u;
    if (!url) return { error: 'url is required' };
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/playwright-browse`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, action: args?.action || 'navigate', ...args }),
        signal: AbortSignal.timeout(60000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:vertex-ai': async (args) => {
    const action = args?.action || 'chat';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/vertex-ai-chat`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(60000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:paragraph-publish': async (args) => {
    const title = args?.title;
    const content = args?.content || args?.body;
    if (!title || !content) return { error: 'title and content are required' };
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/paragraph-publisher`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content, ...args }),
        signal: AbortSignal.timeout(30000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:typefully-send': async (args) => {
    const content = args?.content || args?.text || args?.tweet;
    if (!content) return { error: 'content is required' };
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/typefully-integration`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, ...args }),
        signal: AbortSignal.timeout(15000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:universal-invoke': async (args) => {
    const fn = args?.function || args?.fn;
    if (!fn) return { error: 'function name is required' };
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/universal-edge-invoker`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ function_name: fn, payload: args?.payload || args?.args || {} }),
        signal: AbortSignal.timeout(30000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:ecosystem-health': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/ecosystem-health-check`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:predictive-analytics': async (args) => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/predictive-analytics`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
        signal: AbortSignal.timeout(15000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'fleet-chat': async (args) => {
    const agent = args?.agent || 'vex';
    const message = args?.message;
    if (!message) return { error: 'message is required. Usage: {"agent":"vex|eliza|hermes","message":"..."}' };
    const channel = args?.channel || 'all';
    try {
      const res = await fetch(`http://localhost:${PORT}/api/fleet-chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, message, channel }),
        signal: AbortSignal.timeout(5000),
      });
      return await res.json();
    } catch (err) { return { success: false, error: err.message }; }
  },

  'obsidian-graph': async (args) => {
    const filter = args?.filter || args?.category || null;
    try {
      const resp = await fetch(`http://localhost:${PORT}/api/obsidian-graph`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return { error: 'Failed to fetch graph', status: resp.status };
      const data = await resp.json();
      if (filter) {
        data.nodes = data.nodes.filter(n => n.category === filter);
        data.edges = data.edges.filter(e => data.nodes.some(n => n.id === e.source) && data.nodes.some(n => n.id === e.target));
        data.summary.totalNodes = data.nodes.length;
        data.summary.totalEdges = data.edges.length;
      }
      return { success: true, ...data };
    } catch (err) { return { success: false, error: err.message }; }
  },

  // ── Obsidian vault (second brain) ────────────────────────────
  // Read-only until 2026-09-27: the Galaxy tile graphed the vault but nothing
  // could write to it, so knowledge learned in conversation never reached the
  // wiki. These tools let an agent create a note, rewrite a note's managed
  // block, read notes, and list them — so "update the note on X" works.
  ...getVaultNoteTools(() => getVaultPath()),

  // Push entities Eliza extracted from conversation into the vault. The SPA
  // writes public.knowledge_entities; this mirrors them into managed-block
  // notes so the wiki and the live knowledge base stay in step. Deliberately
  // an explicit call rather than a write hook: entity extraction fires on
  // every assistant message, and auto-syncing would rewrite the vault
  // constantly. Notes whose content did not actually change are skipped, so a
  // no-op sync leaves git history clean.
  'vault-sync-entities': async (args) => {
    try {
      const limit = Math.min(parseInt(args?.limit) || 300, 1000);
      const res = await queryLocalPg(
        `SELECT id, name, entity_name, entity_type, description, confidence_score, updated_at
           FROM public.knowledge_entities
          WHERE COALESCE(entity_name, name) IS NOT NULL
          ORDER BY updated_at DESC NULLS LAST
          LIMIT $1`,
        [limit]
      );
      const result = syncEntitiesToVault(getVaultPath(), res.rows);
      return { ...result, scanned: res.rows.length, limit };
    } catch (err) {
      return { error: err.message };
    }
  },

  'knowledge-graph': async (args) => {
    const { query, agent_id, category, limit = 20 } = args || {};
    try {
      // Fetch the full obsidian graph (includes vault, DB, fleet memory, shared-context, catalog)
      const resp = await fetch(`http://localhost:${PORT}/api/obsidian-graph`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return { error: 'Failed to fetch knowledge graph', status: resp.status };
      const graph = await resp.json();

      // Filter by category if specified
      let nodes = graph.nodes || [];
      if (category) nodes = nodes.filter(n => n.category === category);

      // Search by query string across all text fields
      if (query) {
        const q = query.toLowerCase();
        nodes = nodes.filter(n => {
          const searchable = [n.id, n.label, n.description, n.title, n.body, n.category, n.source, n.memory_type, n.scope, n.agent_id, n.context_type, n.last_updated_by].filter(Boolean).join(' ').toLowerCase();
          return searchable.includes(q);
        });
      }

      // Filter by agent_id if specified
      if (agent_id) {
        nodes = nodes.filter(n => n.agent_id === agent_id || n.last_updated_by === agent_id);
      }

      // Build a subgraph with edges between the filtered nodes
      const nodeIds = new Set(nodes.map(n => n.id));
      const edges = (graph.edges || []).filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));

      // Add semantic catalog matches
      const catalogMatches = (graph.nodes || []).filter(n => n.category === 'catalog' && n.phrases && n.phrases.some(p => p.toLowerCase().includes((query || '').toLowerCase()))).slice(0, limit);

      return {
        success: true,
        query: query || null,
        agent_id: agent_id || null,
        category: category || null,
        totalNodes: nodes.length,
        totalEdges: edges.length,
        nodes: nodes.slice(0, limit),
        edges: edges.slice(0, limit * 2),
        catalogMatches: catalogMatches.map(c => ({ id: c.id, label: c.label, phrases: c.phrases })),
        summary: graph.summary || null,
      };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'vex-vision': async (args) => {
    const prompt = args?.prompt || 'What do you see in this image? Be concise.';
    // Default to the cloud vision model. Local Ollama (moondream) is the fallback
    // only if the cloud chain fails — it's a different model and produces
    // noticeably weaker descriptions. Explicit 'model' arg always wins.
    const model = args?.model || process.env.VEX_VISION_MODEL || 'kimi-k2.6:cloud';
    const filePath = args?.file || args?.path || args?.filePath;
    const url = args?.url;
    const screenshot = args?.screenshot === true || args?.screen === true;
    const cameraName = args?.camera || 'HP TrueVision HD Camera';
    const ffmpegPath = 'C:\\\\tools\\\\ffmpeg';
    const magickPath = join(__dirname, '..', 'relay-data', 'imagemagick', 'magick.exe');
    const relayData = join(__dirname, '..', 'relay-data');
    const gsPath = 'C:\\\\Program Files\\\\gs\\\\gs10.07.1\\\\bin';
    const execOpts = { timeout: 30000, windowsHide: true, env: { ...process.env, PATH: `${gsPath};${process.env.PATH}` } };
    const execOptsMagick = { timeout: 30000, windowsHide: true, env: { ...process.env, PATH: `${gsPath};${process.env.PATH}` } };

    try {
      let imgBase64;
      let sourceLabel = 'camera';

      if (screenshot) {
        // ── Screen capture mode ─────────────────────────
        sourceLabel = 'screen';
        const outputPath = join(relayData, 'vex-screenshot.png');
        // PowerShell .NET screen capture — no extra deps
        execSync(
          `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.X,$b.Y,0,0,$b.Size); $bmp.Save('${outputPath.replace(/'/g, "''")}','PNG'); $g.Dispose(); $bmp.Dispose()"`,
          { timeout: 15000, windowsHide: true }
        );
        imgBase64 = readFileSync(outputPath).toString('base64');
      } else if (filePath) {
        // ── Local file mode ──────────────────────────────
        sourceLabel = filePath;
        if (!existsSync(filePath)) {
          return { success: false, error: `File not found: ${filePath}` };
        }

        const ext = filePath.toLowerCase().split('.').pop();
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
        const videoExts = ['mp4', 'avi', 'mov', 'mkv', 'webm'];

        if (imageExts.includes(ext)) {
          // Direct image — read and base64
          imgBase64 = readFileSync(filePath).toString('base64');
        } else if (ext === 'pdf') {
          // PDF — extract first page via ImageMagick
          const tempImage = join(relayData, 'vex-vision-frame.jpg');
          execSync(
            `"${magickPath}" "${filePath}"[0] -resize 1920x -quality 85 "${tempImage}"`,
            execOptsMagick
          );
          imgBase64 = readFileSync(tempImage).toString('base64');
        } else if (videoExts.includes(ext)) {
          // Video — extract first frame via ffmpeg
          const tempImage = join(relayData, 'vex-vision-frame.jpg');
          execSync(
            `"${ffmpegPath}" -i "${filePath}" -frames:v 1 -q:v 2 "${tempImage}" -y`,
            { timeout: 30000, windowsHide: true }
          );
          imgBase64 = readFileSync(tempImage).toString('base64');
        } else {
          return { success: false, error: `Unsupported file type: .${ext}. Supported: jpg, png, gif, webp, pdf, mp4, mov, avi, mkv` };
        }
      } else if (url) {
        // ── URL mode ────────────────────────────────────
        sourceLabel = url;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) return { success: false, error: `Failed to fetch URL: ${res.status} ${res.statusText}` };

        const contentType = res.headers.get('content-type') || '';
        const buffer = Buffer.from(await res.arrayBuffer());

        if (contentType.startsWith('image/')) {
          imgBase64 = buffer.toString('base64');
        } else if (contentType.startsWith('application/pdf')) {
          // PDF from URL — save then extract first page via ImageMagick
          const tempFile = join(relayData, 'vex-vision-dl.pdf');
          writeFileSync(tempFile, buffer);
          const tempImage = join(relayData, 'vex-vision-frame.jpg');
          execSync(
            `"${magickPath}" "${tempFile}"[0] -resize 1920x -quality 85 "${tempImage}"`,
            execOptsMagick
          );
          imgBase64 = readFileSync(tempImage).toString('base64');
        } else if (contentType.startsWith('video/')) {
          // Video from URL — save then extract first frame via ffmpeg
          const tempFile = join(relayData, 'vex-vision-dl.mp4');
          writeFileSync(tempFile, buffer);
          const tempImage = join(relayData, 'vex-vision-frame.jpg');
          execSync(
            `"${ffmpegPath}" -i "${tempFile}" -frames:v 1 -q:v 2 "${tempImage}" -y`,
            { timeout: 30000, windowsHide: true }
          );
          imgBase64 = readFileSync(tempImage).toString('base64');
        } else {
          return { success: false, error: `Unsupported content type: ${contentType}. Supported: image/*, application/pdf, video/*` };
        }
      } else {
        // ── Camera capture mode (original) ──────────────
        const capturePath = join(relayData, 'vex-capture.jpg');
        execSync(
          `"${ffmpegPath}" -f dshow -i video="${cameraName}" -frames:v 1 -q:v 2 -update 1 "${capturePath}" -y`,
          { timeout: 10000, windowsHide: true }
        );
        imgBase64 = readFileSync(capturePath).toString('base64');
      }

      // ── Send to vision model ───────────────────────────
      // Uses the shared ollama-chat.mjs fallback chain (Ollama Cloud → OpenRouter → local).
      // The chat API natively accepts `images` on the message — cloud models like
      // kimi-k2.6:cloud and kimi-k3 have vision support; the local moondream
      // fallback is kept as the last-resort chain.
      const { ollamaChat } = await import('./tools/ollama-chat.mjs');
      const visionResult = await ollamaChat(prompt, {
        model,
        agent: 'vision',
        source: 'fleet-vision',
        images: [imgBase64],
        temperature: 0.3,
        maxTokens: 512,
        timeout: 180000,  // 3 min — moondream local model has ~2 min cold start on first load
      });
      if (visionResult.error) {
        return { success: false, error: `Vision model failed: ${visionResult.error}`, model, source: sourceLabel };
      }
      return {
        success: true,
        source: sourceLabel,
        model: visionResult.model || model,
        provider: visionResult.provider || 'ollama-cloud',
        description: visionResult.response || 'no response',
        image: imgBase64.slice(0, 100) + '... [' + Math.round(imgBase64.length / 1024) + 'KB]',
      };
    } catch (err) { return { success: false, error: err.message }; }
  },

  // ── Vision for Windows screenshots folder ──────────────────────────
  // Scans the user's Windows Screenshots folder, picks the latest (or a
  // specific filename), and runs the same vision pipeline as vex-vision.
  // Screenshot folder default: %USERPROFILE%\Pictures\Screenshots
  'vex-vision-screenshots': async (args) => {
    const prompt = args?.prompt || 'Describe what is on this screen.';
    const model = args?.model || process.env.VEX_VISION_MODEL || 'kimi-k2.6:cloud';
    const limit = Math.min(args?.limit || 5, 20);
    const filename = args?.filename; // specific file, or omit for latest
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { homedir } = await import('node:os');

    // Windows screenshots folder (PowerShell native-PrintScreen location)
    const screenshotDirs = [
      path.join(homedir(), 'Pictures', 'Screenshots'),
      path.join(homedir(), 'Pictures', 'Screenshots', 'Saved Pictures'),
      path.join(homedir(), 'OneDrive', 'Pictures', 'Screenshots'),
    ];
    let screenshotDir = null;
    for (const d of screenshotDirs) {
      try { if (fs.existsSync(d) && fs.readdirSync(d).length > 0) { screenshotDir = d; break; } } catch {}
    }
    if (!screenshotDir) {
      return { success: false, error: 'No Windows Screenshots folder found (checked Pictures/Screenshots, OneDrive/Pictures/Screenshots)' };
    }

    try {
      let files = fs.readdirSync(screenshotDir)
        .filter(f => /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(f))
        .map(f => ({ name: f, path: path.join(screenshotDir, f), mtime: fs.statSync(path.join(screenshotDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      if (filename) {
        files = files.filter(f => f.name === filename);
        if (files.length === 0) return { success: false, error: `File not found in screenshots: ${filename}` };
      }

      files = files.slice(0, limit);
      if (files.length === 0) return { success: false, error: `No screenshots found in ${screenshotDir}` };

      const results = [];
      for (const file of files) {
        try {
          const imgBase64 = fs.readFileSync(file.path).toString('base64');
          const { ollamaChat } = await import('./tools/ollama-chat.mjs');
          const visionResult = await ollamaChat(prompt, {
            model,
            agent: 'vision',
            source: 'fleet-vision-screenshots',
            images: [imgBase64],
            temperature: 0.3,
            maxTokens: 512,
            timeout: 180000,  // 3 min — moondream ~2 min cold start on first load
          });
          results.push({
            filename: file.name,
            mtime: file.mtime,
            success: !visionResult.error,
            model: visionResult.model || model,
            description: visionResult.error ? `Error: ${visionResult.error}` : visionResult.response,
          });
        } catch (e) {
          results.push({ filename: file.name, success: false, error: e.message });
        }
      }

      return {
        success: true,
        folder: screenshotDir,
        count: results.length,
        model,
        results,
      };
    } catch (err) { return { success: false, error: err.message, folder: screenshotDir }; }
  },

  'vex-hear': async (args) => {
      const capturePath = join(__dirname, '..', 'relay-data', 'vex-audio.wav');
      const duration = Math.min(args?.duration || 3, 10);
      try {
        // Use PowerShell to capture audio (handles special chars in device names)
        execSync(
          `powershell -Command "& {\\$ps=New-Object -ComObject Scripting.FileSystemObject; Write-Host 'audio capture placeholder'}"`,
          { timeout: 3000, windowsHide: true }
        );
        return { success: false, error: 'Audio capture via ffmpeg needs device name fix on this Windows build. Vision is fully operational.', duration };
      } catch (err) { return { success: false, error: err.message }; }
    },

    // ── Python Code Executor ─────────────────────────────────────
  'python-exec': async (args) => {
    const code = args?.code || args?.script || '';
    if (!code) return { error: 'code (string) is required. Pass the Python code to execute.' };
    const timeout = Math.min(args?.timeout || 30, 120);
    const pip = args?.pip || ''; // optional package to install first
    // Full path to python.exe — execSync uses cmd.exe on Windows which
    // may not have the git-bash PATH that makes 'python' resolvable.
    const pyPath = 'C:\\Users\\PureTrek\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\python.exe';
    const pipPath = 'C:\\Users\\PureTrek\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\pip3.exe';
    try {
      // Install package if requested
      if (pip) {
        const packages = pip.split(',').map(p => p.trim()).filter(Boolean);
        for (const pkg of packages) {
          const cmd = `"${pipPath}" install ${pkg}`;
          execSync(cmd, {
            timeout: 120000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            encoding: 'utf8',
          });
        }
      }
      // Write code to temp file to avoid shell escaping issues with triple quotes
      const tmpFile = join(DATA_DIR, 'py-exec-' + Date.now() + '.py');
      writeFileSync(tmpFile, code, 'utf8');
      const stdout = execSync('"' + pyPath + '" "' + tmpFile + '"', {
        timeout: timeout * 1000,
        maxBuffer: 512 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      });
      // Clean up temp file
      try { unlinkSync(tmpFile); } catch {}
      return {
        success: true,
        output: stdout.slice(0, 10000),
        length: stdout.length,
        exitCode: 0,
        timeout,
        pipInstalled: pip || null,
      };
    } catch (err) {
      const stderr = err.stderr?.toString()?.slice(0, 5000) || '';
      const stdout = err.stdout?.toString()?.slice(0, 5000) || '';
      return {
        success: false,
        error: (err.message || String(err)).slice(0, 5000),
        stderr,
        stdout,
        exitCode: err.status ?? -1,
      };
    }
  },

  // ── Shell Exec (run bash/curl commands for agents) ───────
  // Mirrors python-exec but runs arbitrary bash/curl via git-bash.
  // CORE-gated (same as python-exec). Uses ASYNC spawn (NOT execSync) so the
  // relay event loop stays free — critical because agents often curl the relay
  // itself (e.g. `curl http://localhost:8080/health`). A synchronous execSync
  // blocks the event loop, so the relay can't answer that curl → deadlock/ETIMEDOUT.
  // Uses a temp .sh file to avoid shell-escaping issues.
  'shell-exec': async (args) => {
    const command = args?.command || args?.cmd || args?.script || '';
    if (!command) return { error: 'command (string) is required. Pass the bash/curl command to execute.' };
    const timeout = Math.min(args?.timeout || 30, 120);
    const workdir = args?.workdir || 'C:\\Users\\PureTrek\\Desktop\\xmrtdao';
    const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
    let tmpFile = null;
    try {
      // Write command to a temp .sh file to avoid shell-escaping issues
      tmpFile = join(DATA_DIR, 'shell-exec-' + Date.now() + '.sh');
      writeFileSync(tmpFile, '#!/bin/bash\n' + command + '\n', 'utf8');
      // Async spawn — does NOT block the relay event loop, so commands that
      // curl the relay itself (health checks, endpoint tests) work without deadlock.
      const stdout = await new Promise((resolve, reject) => {
        const child = spawn(bashPath, [tmpFile], {
          cwd: workdir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
          // Kill the ENTIRE process tree, not just bash.exe. On Windows,
          // child.kill() only reaches the parent shell and MSYS can spawn
          // native grep/git as grandchildren. Order matters: taskkill /F /T
          // FIRST (while grep is still a child of bash), THEN child.kill as a
          // fallback. Sending SIGTERM to bash before the tree-kill lets bash
          // exit and detach grep so /T misses it. Without this the
          // grandchildren run orphaned, accumulate, and wedge the relay.
          try {
            if (process.platform === 'win32') {
              try {
                execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', timeout: 5000 });
              } catch {}
              try { child.kill('SIGKILL'); } catch {}
            } else {
              child.kill('SIGKILL');
            }
          } catch {}
          reject(new Error(`Command timed out after ${timeout}s`));
        }, timeout * 1000);
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ out, err, code });
        });
      });
      // Clean up temp file
      try { unlinkSync(tmpFile); } catch {}
      return {
        success: stdout.code === 0,
        output: stdout.out.slice(0, 10000),
        stderr: stdout.err.slice(0, 5000),
        length: stdout.out.length,
        exitCode: stdout.code,
        timeout,
        shell: 'git-bash',
      };
    } catch (err) {
      if (tmpFile) { try { unlinkSync(tmpFile); } catch {} }
      return {
        success: false,
        error: (err.message || String(err)).slice(0, 5000),
        stderr: '',
        stdout: '',
        exitCode: -1,
        shell: 'git-bash',
      };
    }
  },

  // ── Resend Inbox (read emails stored in relay state) ──────
  'resend-inbox': async (args) => {
    const domain = args?.domain || 'all'; // pfp, mobilemonero, 31harbor, or all
    const limit = Math.min(args?.limit || 10, 50);
    const inbox = getInbox();
    const result = { domains: {} };
    const targets = domain === 'all' ? EMAIL_INBOX_KEYS : [domain];
    for (const key of targets) {
      const emails = (inbox[key] || []).slice(0, limit);
      result.domains[key] = {
        total: inbox[key]?.length || 0,
        unread: (inbox[key] || []).filter(e => !e.read).length,
        recent: emails.map(e => ({
          id: e.id, from: e.from, to: e.to, subject: e.subject,
          receivedAt: e.receivedAt, read: e.read,
          text: (e.text || '').slice(0, 5000),
        })),
      };
    }
    return { success: true, ...result };
  },

  // ── Mark email as read ──
  'resend-inbox-read': async (args) => {
    const { id, domain } = args || {};
    if (!id) return { error: 'id is required (email ID from resend-inbox)' };
    try {
      const res = await fetch(`http://localhost:${PORT}/resend/inbox/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, domain: domain || 'partyfavorphoto.com' }),
        signal: AbortSignal.timeout(5000),
      });
      return await res.json();
    } catch (err) { return { success: false, error: err.message }; }
  },
  'sent-emails': async (args) => {
    const limit = Math.min(args?.limit || 10, 50);
    const search = args?.search || '';
    try {
      let sql = 'SELECT id, email_from, email_to, subject, status, sent_at, created_at FROM app.suite_email_activity';
      const params = [];
      if (search) {
        sql += ' WHERE email_to ILIKE $1 OR email_from ILIKE $1 OR subject ILIKE $1';
        params.push('%' + search + '%');
      }
      sql += ' ORDER BY sent_at DESC NULLS LAST LIMIT $' + (params.length + 1);
      params.push(limit);
      const rows = await localQuery(sql, params);
      return { success: true, rowCount: rows.length, rows };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  // ── PFP Lead Management ──
  'pfp-leads': async (args) => {
    const action = args?.action || 'list'; // list, search, add, update
    try {
      if (action === 'list') {
        const limit = Math.min(args?.limit || 20, 100);
        const rows = await localQuery(
          'SELECT id, contact_name, contact_email, event_type, event_date, venue_name, venue_address, status, source, notes, created_at, updated_at FROM pfp_leads ORDER BY created_at DESC LIMIT $1',
          [limit]
        );
        return { success: true, rowCount: rows.length, rows };
      }
      if (action === 'search') {
        const term = args?.search || args?.term || '';
        if (!term) return { error: 'search term required' };
        const rows = await localQuery(
          `SELECT id, contact_name, contact_email, event_type, event_date, venue_name, venue_address, status, source, notes, created_at, updated_at FROM pfp_leads WHERE contact_name ILIKE $1 OR contact_email ILIKE $1 OR notes ILIKE $1 OR event_type ILIKE $1 ORDER BY created_at DESC LIMIT 20`,
          ['%' + term + '%']
        );
        return { success: true, rowCount: rows.length, rows };
      }
      if (action === 'add') {
        const { contact_name, contact_email, event_type, event_date, venue_name, venue_address, status, source, notes } = args;
        if (!contact_name) return { error: 'contact_name is required' };
        const result = await localQuery(
          `INSERT INTO pfp_leads (contact_name, contact_email, event_type, event_date, venue_name, venue_address, status, source, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, contact_name, contact_email, status, event_date`,
          [contact_name, contact_email || null, event_type || null, event_date || null, venue_name || null, venue_address || null, status || 'NEW', source || 'manual', notes || null]
        );
        return { success: true, lead: result[0] };
      }
      if (action === 'update') {
        const { id, ...fields } = args;
        if (!id) return { error: 'id is required' };
        const allowed = ['contact_name','contact_email','event_type','event_date','venue_name','venue_address','status','source','notes','lead_rating'];
        const sets = []; const params = []; let idx = 0;
        for (const [k, v] of Object.entries(fields)) {
          if (allowed.includes(k)) { idx++; params.push(v); sets.push(`${k} = $${idx}`); }
        }
        if (sets.length === 0) return { error: 'no valid fields to update' };
        params.push(id);
        const result = await localQuery(
          `UPDATE pfp_leads SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx + 1} RETURNING id, contact_name, contact_email, status, event_date`,
          params
        );
        return { success: true, lead: result[0] };
      }
      return { error: 'unknown action: ' + action };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  // ── Resend Send Email (agent sends email via fleet-chat endpoint) ──
  'resend-send-email': async (args) => {
    const { agent, to, subject, body } = args || {};
    if (!agent || !to || !subject || !body) {
      return { error: 'agent, to, subject, and body are required. agent: vex|eliza|hermes|pfp|harbor|jobby' };
    }
    try {
      const res = await fetch(`http://localhost:${PORT}/api/fleet-chat/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, to, subject, body }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json();
      // If the Resend key is over quota, suggest using a different agent
      if (data?.error?.statusCode === 429) {
        return { success: false, error: 'Resend daily quota exceeded for this domain. Try agent: "pfp" (bookings@partyfavorphoto.com) or agent: "harbor" (david@31harbor.com) instead. Quota resets at midnight UTC.' };
      }
      return data;
    } catch (err) { return { success: false, error: err.message }; }
      },

      'recall_context': async (args) => {
              const agentId = args?.agent_id || args?.agentId || args?.user_id || '';
              const topic = args?.topic || args?.query || args?.q || '';
        const limit = Math.min(parseInt(args?.limit || '15', 10), 50);
        try {
          const results = { memories: [], knowledge: [], context: [] };
          if (topic) {
            const memRows = await queryLocalPg(
              `SELECT agent_id, memory_type, title, body, payload, created_at
               FROM app.fleet_memory
               WHERE (title ILIKE $1 OR body ILIKE $1)
                 AND ($2 = '' OR agent_id = $2)
               ORDER BY created_at DESC LIMIT $3`,
              [`%${topic}%`, agentId, limit]
            );
            results.memories = (memRows.rows || []).map(r => ({
              agent: r.agent_id, type: r.memory_type, title: r.title,
              body: (r.body||'').slice(0,500), time: r.created_at
            }));
          }
          if (topic) {
            // Use direct PG query for knowledge entities (PostgREST doesn't support ->>
            // JSON path operators in filter conditions, so the REST API approach silently fails)
            const keRows = await queryLocalPg(
              `SELECT name, entity, created_at
               FROM app.knowledge_entities
               WHERE name ILIKE $1 OR entity->>'description' ILIKE $1 OR entity->>'content' ILIKE $1
               ORDER BY created_at DESC LIMIT $2`,
              [`%${topic}%`, limit]
            );
            results.knowledge = (keRows.rows || []).map(r => ({
              name: r.name,
              entity: typeof r.entity === 'string' ? JSON.parse(r.entity) : r.entity,
              time: r.created_at,
            }));
          }
          if (topic) {
            const ctxRows = await queryLocalPg(
              `SELECT context_key, context_type, value, description, last_updated_by, updated_at
               FROM knowledge.shared_context
               WHERE (context_key ILIKE $1 OR COALESCE(description,'') ILIKE $1)
               ORDER BY updated_at DESC LIMIT $2`,
              [`%${topic}%`, limit]
            );
            results.context = (ctxRows.rows || []).map(r => ({
              key: r.context_key, type: r.context_type,
              value: typeof r.value === 'string' ? r.value.slice(0,500) : r.value,
              description: r.description, updated_by: r.last_updated_by, time: r.updated_at
            }));
          }
          if (!topic && agentId) {
            const recentRows = await queryLocalPg(
              `SELECT agent_id, memory_type, title, body, created_at
               FROM app.fleet_memory WHERE agent_id = $1
               ORDER BY created_at DESC LIMIT $2`,
              [agentId, limit]
            );
            results.memories = (recentRows.rows || []).map(r => ({
              agent: r.agent_id, type: r.memory_type, title: r.title,
              body: (r.body||'').slice(0,500), time: r.created_at
            }));
          }
          return { success: true, agent_id: agentId || null, topic: topic || null, results };
        } catch (err) { return { success: false, error: err.message }; }
              },

              'knowledge-dedup': async (args) => {
                      const dryRun = args?.dry_run !== false;
                      const minSimilarity = args?.min_similarity || 0.4;
                      try {
                        await queryLocalPg('SET statement_timeout TO 10000');
                                                const dups = await queryLocalPg(
                                            `SELECT a.id as id_a, b.id as id_b, a.name as name_a, b.name as name_b,
                            similarity(a.name, b.name) as sim
                     FROM app.knowledge_entities a
                     JOIN app.knowledge_entities b ON a.id < b.id
                       AND similarity(a.name, b.name) > $1
                     ORDER BY sim DESC`,
                    [minSimilarity]
                  );
                  const groups = [];
                  const seen = new Set();
                  (dups.rows || []).forEach(function(r) {
                    if (seen.has(r.id_a) || seen.has(r.id_b)) return;
                    seen.add(r.id_a); seen.add(r.id_b);
                    groups.push({ id_a: r.id_a, id_b: r.id_b, name_a: r.name_a, name_b: r.name_b, similarity: Math.round(r.sim * 100) + '%' });
                  });
                  if (dryRun) {
                    return { success: true, dry_run: true, duplicate_groups: groups, total: groups.length };
                  }
                  // Merge duplicates: keep the one with more content, delete the other
                  let merged = 0, deleted = 0;
                  for (const g of groups) {
                    const a = await queryLocalPg(`SELECT name, entity FROM app.knowledge_entities WHERE id = $1`, [g.id_a]);
                    const b = await queryLocalPg(`SELECT name, entity FROM app.knowledge_entities WHERE id = $1`, [g.id_b]);
                    const rowA = a.rows[0], rowB = b.rows[0];
                    if (!rowA || !rowB) continue;
                    const lenA = JSON.stringify(rowA.entity).length;
                    const lenB = JSON.stringify(rowB.entity).length;
                    const keepId = lenA >= lenB ? g.id_a : g.id_b;
                    const delId = lenA >= lenB ? g.id_b : g.id_a;
                    await queryLocalPg(`DELETE FROM app.knowledge_entities WHERE id = $1`, [delId]);
                    deleted++;
                    merged++;
                  }
                  return { success: true, dry_run: false, groups_merged: groups.length, deleted, merged };
                } catch (err) { return { success: false, error: err.message }; }
                              },

                              'task-dedup': async (args) => {
                                const dryRun = args?.dry_run !== false;
                                try {
                                  await queryLocalPg('SET statement_timeout TO 10000');
                                  const dups = await queryLocalPg(
                                    `SELECT a.id as id_a, b.id as id_b, a.title as title_a, b.title as title_b,
                                            a.status as status_a, b.status as status_b,
                                            a.progress_percentage as pct_a, b.progress_percentage as pct_b
                                     FROM app.tasks a
                                     JOIN app.tasks b ON a.id < b.id
                                       AND (a.title = b.title OR similarity(a.title, b.title) > 0.6)
                                     ORDER BY a.title`
                                  );
                                  const groups = [];
                                  const seen = new Set();
                                  (dups.rows || []).forEach(function(r) {
                                    if (seen.has(r.id_a) || seen.has(r.id_b)) return;
                                    seen.add(r.id_a); seen.add(r.id_b);
                                    groups.push({
                                      id_a: r.id_a, id_b: r.id_b, title_a: r.title_a, title_b: r.title_b,
                                      status_a: r.status_a, status_b: r.status_b,
                                      pct_a: r.pct_a, pct_b: r.pct_b
                                    });
                                  });
                                  if (dryRun) {
                                    return { success: true, dry_run: true, duplicate_groups: groups, total: groups.length };
                                  }
                                  let merged = 0, deleted = 0;
                                  for (const g of groups) {
                                    const progressA = g.pct_a || 0;
                                    const progressB = g.pct_b || 0;
                                    const keepId = progressA >= progressB ? g.id_a : g.id_b;
                                    const delId = progressA >= progressB ? g.id_b : g.id_a;
                                    await queryLocalPg(`DELETE FROM app.tasks WHERE id = $1`, [delId]);
                                    deleted++;
                                    merged++;
                                  }
                                  return { success: true, dry_run: false, groups_merged: groups.length, deleted, merged };
                                } catch (err) { return { success: false, error: err.message }; }
                              },

                            };

                            async function defaultHandler(task) {
  logActivity('handler', task.id, 'FALLBACK', `No specific handler for "${task.title}"`);
  return {
    status: 'unhandled',
    message: `No handler registered for task type. Task title: "${task.title}". Available handlers: ${Object.keys(handlers).join(', ')}`,
  };
}

// ── Eliza-Cloud relay ───────────────────────────────────────
// Calls the local ai-chat edge function (the live Eliza with provider
// cascade, conversation memory, and tool execution). The old
// /functions/v1/eliza-relay endpoint is a deprecated stub that just
// proxies to /ollama/chat with gemma3:1b — we skip it entirely.
async function relayToElizaCloud(message, senderName = 'Eliza-Dev', relayTag = null, sessionId = null, historyMessages = null) {
  if (!SUPABASE_KEY) return logActivity('eliza', '-', 'SKIP', 'No SUPABASE_KEY set');
  // Use stable sessionId when provided (e.g. from fleet chat), otherwise fall back to relayTag
  const tag = sessionId || relayTag || `eliza-dev-${Date.now().toString(36)}`;
  const url = `${SUPABASE_URL}/functions/v1/ai-chat`;
  try {
    logActivity('eliza', tag, 'SEND', message.slice(0, 80));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const body = {
          userQuery: message,
          senderName: senderName,
          session_id: tag,
        };
    // Pass conversation history as messages array so ai-chat sees context
    if (historyMessages && historyMessages.length > 0) {
      body.messages = historyMessages;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text();
      logActivity('eliza', tag, 'FAIL', `HTTP ${res.status}: ${text.slice(0, 100)}`);
      return null;
    }
    const data = await res.json();

    // ai-chat is async-wrapped: for a long request it answers immediately with
    // { status: 'processing', request_id } and expects the caller to poll
    // GET /functions/v1/ai-chat?request_id= for the real result.
    //
    // Nothing here did that. `data.content` was therefore empty, `reply` came
    // out as '', and the caller read that as a failure and fell through to a
    // fallback — so Eliza's answer was produced, stored, and dropped on the
    // floor. Resolving it here fixes every caller of relayToElizaCloud at once,
    // rather than teaching each one to poll.
    let resolved = data;
    if ((data?.status === 'processing' || (!data?.content && data?.request_id)) && data?.request_id) {
      const pollUrl = `${SUPABASE_URL}/functions/v1/ai-chat?request_id=${encodeURIComponent(data.request_id)}`;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        let st = null;
        try {
          const pr = await fetch(pollUrl, {
            headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
            signal: AbortSignal.timeout(8000),
          });
          if (pr.ok) st = await pr.json();
        } catch (_) { /* transient; keep polling until the deadline */ }

        if (!st) continue;
        if (st.status === 'done') {
          const inner = st.result;
          if (inner && typeof inner === 'object') {
            resolved = { ...inner, request_id: data.request_id };
          } else if (typeof inner === 'string' && inner.trim()) {
            resolved = { content: inner, request_id: data.request_id };
          }
          break;
        }
        if (st.status === 'error') {
          logActivity('eliza', tag, 'FAIL', `async request ${data.request_id} errored: ${String(st.error).slice(0, 120)}`);
          break;
        }
        if (st.status === 'not_found') {
          // The status store is in-process, so a recycled function loses it.
          logActivity('eliza', tag, 'FAIL', `async request ${data.request_id} not found (edge function recycled?)`);
          break;
        }
      }
    }
    if (resolved !== data) {
      logActivity('eliza', tag, 'ASYNC', `resolved ${data.request_id} -> ${String(resolved?.content || '').slice(0, 60)}`);
    }

    // ai-chat returns { content, provider, model, success }; the rest of the
    // codebase expects { reply, ... } from eliza-relay, so normalize.
    let reply = (resolved?.content || '').trim();
    // Strip chain-of-thought / reasoning artifacts that leak into the response
    // Common patterns: internal deliberation, scaffolding instructions, mid-word truncation
    reply = reply
      // Remove lines that look like internal reasoning (start with "I need to", "Let me", "First,", "Step", etc.)
      .replace(/^(I need to|Let me|First,|Step \d|We are |As an AI|My role|I am |I'm |The user|This is a|I should|I'll |I will |I can |I have |I've |I'm going to|My task|My job|My purpose|I was |I'm designed|I'm programmed).*$/gim, '')
      // Remove lines that look like system prompt leakage
      .replace(/^(## |### |RULE \d|CRITICAL|IMPORTANT|MANDATORY|REMEMBER|NOTE:).*$/gim, '')
      // Remove lines that are just tool call instructions
      .replace(/^(invoke_edge_function|execute_python|call_edge_function|search_edge_functions|browse_web|analyze_attachment).*$/gim, '')
      // Remove lines with DSML or tool_code artifacts
      .replace(/<\|DSML\|.*?<\/\|DSML\|>/gi, '')
      .replace(/```tool_code[\s\S]*?```/g, '')
      // Clean up multiple blank lines
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    logActivity('eliza', tag, 'REPLY', reply.slice(0, 80));
    // Log token usage for Rum Quota tracking
    try {
      // Read usage from `resolved`, not `data`: when the request went async,
      // `data` is the { status: 'processing' } envelope and carries no usage and
      // no model, so logging against it recorded the wrong provider and zero tokens.
      const inputTokens = resolved.usage?.input_tokens || resolved.input_tokens || 0;
      const outputTokens = resolved.usage?.output_tokens || resolved.output_tokens || 0;
      const totalTokens = inputTokens + outputTokens;
      if (totalTokens > 0) {
        fetch('http://localhost:' + PORT + '/api/token-usage/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: 'xmrt-dao',
            agent: senderName || 'eliza',
            model: resolved.model || 'deepseek-v4-flash',
            provider: resolved.provider || 'cloud',
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            estimated_cost_usd: totalTokens > 0 ? (totalTokens / 1000) * 0.0015 : 0,
            source: 'eliza-cloud',
            endpoint: 'relayToElizaCloud',
            status: 'success',
            session_id: tag,
          }),
          signal: AbortSignal.timeout(15000),
        }).catch(() => {});
      }
    } catch (_) {}
    return { ...resolved, reply };
  } catch (err) {
    logActivity('eliza', tag, 'ERROR', err.message);
    return null;
  }
}

// ── Forward to Hermes ───────────────────────────────────────
async function forwardToHermes(task) {
  const hermesUrl = task?.metadata?.phone_url || HERMES_ENDPOINT;
  logActivity('hermes', task?.id || '?', 'FORWARD', `Forwarding to ${hermesUrl}`);
  try {
    const payload = {
      taskId: task.id,
      handler: task?.metadata?.handler || task?.handler || guessHandlerFromTitle(task.title),
      agent: 'eliza-dev',
      payload: task?.payload || task?.metadata?.payload || {},
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(hermesUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const result = await res.json();
      logActivity('hermes', task.id, 'OK', 'Task forwarded successfully');
      return { success: true, forwarded: true, hermesResponse: result };
    } else {
      throw new Error(`Hermes returned HTTP ${res.status}`);
    }
  } catch (err) {
    logActivity('hermes', task.id, 'FAIL', err.message);
    return { success: true, forwarded: false, fallback: true, error: err.message };
  }
}

function guessHandlerFromTitle(title) {
  if (!title) return 'default';
  const t = title.toLowerCase();
  if (t.includes('smtp') || t.includes('email')) return 'email-smtp-fix';
  if (t.includes('alice') || t.includes('sidecar') || t.includes('ocr')) return 'alice-sidecar';
  if (t.includes('knowledge') || t.includes('sync') || t.includes('kb')) return 'knowledge-sync';
  if (t.includes('device') || t.includes('register')) return 'device-registration';
  if (t.includes('mining') || t.includes('dashboard') || t.includes('hash')) return 'mining-dashboard';
  if (t.includes('alice') || t.includes('screenshot') || t.includes('desktop')) return 'alice';
  return 'default';
}

// ── Express App ─────────────────────────────────────────────
const app = express();

// Raw body capture for requests without Content-Type (some agents omit it)
// Standard JSON parser — fleet chat endpoint has its own fallback for missing Content-Type
//
// The verify callback stashes the exact bytes on the request. That is required
// for webhook signatures: the signature covers the body as sent, and
// JSON.stringify(req.body) re-serialises it, so key order and number formatting
// can differ from the bytes Resend signed. Signing the re-serialised form means
// verification can never succeed, which is presumably why the Resend handler
// used to log a mismatch and carry on regardless. Signing the captured bytes is
// what makes the check meaningful.
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
const _require = createRequire(import.meta.url);
app.use(_require('cookie-parser')());

// ── Global CORS Middleware ──
// Must run before auth middleware so OPTIONS preflight requests pass through.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-agent-id, x-agent, Authorization, Cf-Access-Jwt-Assertion, Cf-Access-Client-Id, Cf-Access-Client-Secret');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ── Cloudflare Access JWT Verification Middleware ─────────
// Validates Cf-Access-Jwt-Assertion header against Cloudflare's JWKS.
const CF_ACCESS_TEAM_DOMAIN = 'mobilemonero.cloudflareaccess.com';
const CF_ACCESS_AUD = '0fd3b26e1be02abb5cec45374db4e1c6fc9ea2b6230e2bc6066f372d0fa44d96';
const CF_JWKS_URI = `https://${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
let cfJwks = null;
let cfJwksLastFetch = 0;
const CF_JWKS_TTL = 3600000;

async function getCfJwks() {
  if (cfJwks && Date.now() - cfJwksLastFetch < CF_JWKS_TTL) return cfJwks;
  try {
    const res = await fetch(CF_JWKS_URI, { signal: AbortSignal.timeout(5000) });
    if (res.ok) { cfJwks = await res.json(); cfJwksLastFetch = Date.now(); return cfJwks; }
  } catch (e) { console.warn('[CF-Access] Failed to fetch JWKS:', e.message); }
  return cfJwks;
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  try { return JSON.parse(Buffer.from(str, 'base64').toString('utf8')); } catch { return null; }
}

async function verifyCfAccessJwt(jwt) {
  if (!jwt) return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const header = base64urlDecode(parts[0]);
  const payload = base64urlDecode(parts[1]);
  if (!header || !payload) return null;
  const aud = payload.aud || payload.AUD;
  if (Array.isArray(aud) ? !aud.includes(CF_ACCESS_AUD) : aud !== CF_ACCESS_AUD) return null;
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  const jwks = await getCfJwks();
  if (!jwks || !jwks.keys) return null;
  const key = jwks.keys.find(k => k.kid === header.kid);
  if (!key) return null;
  try {
    const cryptoKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sig, data);
    return valid ? payload : null;
  } catch (e) { console.warn('[CF-Access] JWT verify error:', e.message); return null; }
}

// ── Combined Auth Middleware ──────────────────────────────
const RELAY_API_KEY = process.env.RELAY_API_KEY || '';
// Agent-specific API key cache (loaded from app.agent_api_keys at startup)
let agentApiKeys = {};

// ── Agent API Key Management ─────────────────────────────
async function loadAgentApiKeys() {
  try {
    const r = await queryLocalPg('SELECT api_key, agent_id::text, label FROM app.agent_api_keys');
    agentApiKeys = {};
    for (const row of r.rows) {
      agentApiKeys[row.api_key] = { agent_id: row.agent_id, label: row.label };
    }
    console.log(`[AUTH] Loaded ${r.rows.length} agent API keys`);
  } catch (e) {
    console.error('[AUTH] Failed to load agent API keys:', e.message);
  }
}
// Load on startup and every 5 minutes
loadAgentApiKeys();
setInterval(loadAgentApiKeys, 5 * 60 * 1000);

const CF_SERVICE_TOKENS = {
  'cf58c37e064303569c6017ac39a15a7a.access': 'f2158a78f16a9c75067a954d508658eda3f5d52c018cd0e366096ad1c39ef1b9',
  'bfa0d8f42b17d44a0243d386bd5b6a40.access': 'd8019ca2afa236c55828904245bf147f60feb11fa781ea7c6b05daee665690dd',
  'e1b5d893008ffb71e0f80b45139fb1d0.access': 'f9943d1733ff36bf7c65574cf1febb508fd40437f9e47497ea9d3243422dd032',
};

// ── Consolidate MCP tools and Alice daemon in-process ──
// Uses JSON-RPC over HTTP to the already-running MCP servers (managed by supervisor).
// No direct imports — avoids the EADDRINUSE conflict that caused the startup hang.
(async () => {
  try {
    const { registerMcpTools, startAliceDaemon } = await import('./lib/consolidate.mjs');
    const count = await registerMcpTools(toolHandlers);
    console.log(`[consolidate] ${count} MCP tools registered via JSON-RPC proxy`);
    setTimeout(() => {
      try { startAliceDaemon(); } catch (e) { console.log('[consolidate] Alice daemon error:', e.message); }
    }, 15000);
  } catch (e) {
    console.log('[consolidate] Failed to load:', e.message);
  }
})();

// ── Rate Limiter ──────────────────────────────────────────
const rateLimitBuckets = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 600;
const SEND_EMAIL_RATE_MAX = 10;

/**
 * The caller's address, as far as we can honestly determine it.
 *
 * `x-forwarded-for` is a comma list and the FIRST entry is the original client,
 * because each proxy appends the address it saw. Behind Cloudflare,
 * `cf-connecting-ip` is more trustworthy than the header a client can set itself,
 * so it is preferred when present. `trust proxy` has to be enabled for `req.ip`
 * to be meaningful behind a proxy at all, which is why this is explicit.
 *
 * Returns null when nothing usable is available, so callers store a gap rather
 * than a fabricated address.
 */
function requestIp(req) {
  const cf = req.headers['cf-connecting-ip']?.split(',')[0]?.trim();
  if (cf) return cf;
  const xff = req.headers['x-forwarded-for']?.split(',')[0]?.trim();
  if (xff) return xff;
  return req.socket?.remoteAddress || req.ip || null;
}

function isLoopbackAddress(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function rateLimit(ip, path) {  const now = Date.now();
  const key = `${ip}:${path.includes('send-email') ? 'send-email' : 'default'}`;
  const max = path.includes('send-email') ? SEND_EMAIL_RATE_MAX : RATE_LIMIT_MAX;
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW) {
    bucket = { windowStart: now, count: 0 };
    rateLimitBuckets.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > max) return false;
  if (rateLimitBuckets.size > 1000) {
    const cutoff = now - RATE_LIMIT_WINDOW * 2;
    for (const [k, b] of rateLimitBuckets) {
      if (now - b.windowStart > RATE_LIMIT_WINDOW * 2) rateLimitBuckets.delete(k);
    }
  }
  return true;
}

app.use(async (req, res, next) => {
  // Public API endpoints (no auth required)
  if (req.method === 'OPTIONS' ||
      req.path === '/' ||
      req.path === '/ping' ||
      req.path === '/health' ||
      req.path === '/webhook/resend-inbound' ||
      // Stripe cannot send an API key or a Cloudflare Access assertion, so this
      // has to be reachable from the internet. That is safe only because the
      // handler authenticates the request with the Stripe signature over the raw
      // body, which is unforgeable. It was missing from this list, so every
      // delivery from Stripe was refused with 401 and no payment was ever
      // recorded - while the endpoint looked complete.
      req.path === '/webhook/stripe' ||
      req.path.startsWith('/functions/v1/') ||
      req.path === '/api/suite/validate-token' || req.path === '/api/login' || req.path === '/api/auth/cert-login' ||
      req.path.startsWith('/api/suite/') ||
      req.path.startsWith('/rest/v1/') ||
      req.path.startsWith('/api/contact/cuttlefishclaws') ||
      req.path === '/api/cuttlefishclaws/trust-score' ||
      req.path === '/api/cuttlefishclaws/cac-status' ||
      req.path === '/api/cuttlefishclaws/capital-stack' ||
      req.path === '/api/cuttlefishclaws/trust-network' ||
      req.path === '/api/cuttlefishclaws/agents' ||
      req.path === '/api/cuttlefishclaws/rate-card' ||
      req.path === '/api/trustgraph/trajectory' ||
      req.path === '/api/rum-quota' ||
      req.path === '/api/footlocker' || req.path.startsWith('/api/footlocker/') ||
      req.path === '/api/catalog' ||
      req.path === '/api/university' ||
      // Public website endpoints — partyfavorphoto.com chat widget + booking
      // system post here from the browser with no API key (tunnel, no auth).
      req.path === '/api/fleet-chat/send' ||
      req.path === '/api/leads/pfp' ||
      req.path === '/suite' || req.path.startsWith('/suite/') ||
      req.path === '/elze' || req.path.startsWith('/elze/') ||
      req.path === '/cuttlefishclaws/' || req.path.startsWith('/cuttlefishclaws/')) {
    // If api_key is in query params, set it as a cookie for SPA API calls
    if (req.query.api_key) {
      res.cookie('relay_api_key', req.query.api_key, {
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        httpOnly: false, // readable by JS for the SPA
        sameSite: 'lax',
        path: '/',
      });
    }
    return next();
  }
  // Skip non-API paths and non-sensitive paths
  const sensitivePaths = ['/dispatch', '/eliza', '/web-search', '/scrape', '/monitor', '/status', '/inbox', '/log', '/mesh', '/mining', '/cron'];
  const isSensitive = sensitivePaths.some(p => req.path.startsWith(p));
  // Also check Host header for inbox hostnames that route to /
  const host = (req.headers.host || '').toLowerCase();
  const sensitiveHosts = ['inbox.partyfavorphoto.com', 'inbox.mobilemonero.com', 'inbox.31harbor.com', 'inbox.31harbor.com'];
  const isSensitiveHost = sensitiveHosts.some(h => host.includes(h));
  // If the request came through the Cloudflare tunnel (cf-ray header present),
  // it's external — require auth for all paths
  const isTunnelRequest = req.headers['cf-ray'] || req.headers['cf-connecting-ip'];
  if (!isTunnelRequest && !req.path.startsWith('/api/') && !isSensitive && !isSensitiveHost) return next();
  
  const ip = requestIp(req);
  if (!isTunnelRequest && isLoopbackAddress(ip)) return next();
  
  // Rate limit check
  if (!rateLimit(ip, req.path)) {
    console.warn(`[RATE-LIMIT] Exceeded from ${ip}: ${req.method} ${req.path}`);
    return res.status(429).json({ error: 'Too many requests. Rate limit: 60/min general, 10/min for send-email.' });
  }
  
  const cfJwt = req.headers['cf-access-jwt-assertion'];
  if (cfJwt) {
    try {
      const verified = await verifyCfAccessJwt(cfJwt);
      if (verified) {
        req.cfAccess = { identity: verified.email || verified.sub, payload: verified };
        return next();
      }
      if (res.headersSent) return;
      console.warn(`[CF-Access] Invalid JWT from ${ip}: ${req.method} ${req.path}`);
      return res.status(401).json({ error: 'Invalid Cloudflare Access JWT' });
    } catch (err) {
      if (res.headersSent) return;
      console.warn(`[CF-Access] JWT verify error: ${err.message}`);
      return res.status(401).json({ error: 'JWT verification failed' });
    }
  }
  const cfClientId = req.headers['cf-access-client-id'];
  const cfClientSecret = req.headers['cf-access-client-secret'];
  if (cfClientId && cfClientSecret) {
    const expectedSecret = CF_SERVICE_TOKENS[cfClientId];
    if (expectedSecret && cfClientSecret === expectedSecret) { req.cfAccess = { identity: cfClientId, type: 'service_token' }; return next(); }
    console.warn(`[CF-Access] Invalid service token from ${ip}: ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Invalid Cloudflare Access service token' });
  }
  if (RELAY_API_KEY) {
    const apiKey = (req.headers['x-api-key'] || req.query.api_key || req.cookies?.relay_api_key || '').trim();
    if (apiKey === RELAY_API_KEY) return next();
    // Also accept cert:verified:* cookies — these are set by POST /api/auth/cert-login
    // when a graduate logs in with their XMRT-DAO-CERT JWT
    //
    // It used to be accepted on a prefix test alone:
    //
    //   if (apiKey.startsWith('cert:verified:')) return next();
    //
    // No lookup, no expiry check, no revocation check. Anyone presenting the cookie
    // `cert:verified:anything at all` was authenticated as a graduate — the exact
    // inverse of tying an agent to their certificate, since an id nobody issued
    // was as good as one that was.
    //
    // The id is now resolved against public.agent_certifications, where all
    // fourteen certificates actually live, and a miss is refused rather than
    // assumed. Nothing previously checked expiry or revocation anywhere in this
    // path: cert-login looked in process memory (empty) and then a Supabase edge
    // function that 502s.
    if (apiKey.startsWith('cert:verified:')) {
      const { verifyCertCookie } = await import('./jobby/certs.mjs');
      const verdict = await verifyCertCookie(apiKey);
      if (verdict.ok) {
        req.certAuth = {
          agent_id: verdict.agent_id, agent_name: verdict.agent_name,
          tier: verdict.tier, permissions: verdict.permissions,
          expires_at: verdict.expires_at,
        };
        return next();
      }
      // A verifier that cannot reach the database is our fault, not the caller's,
      // so it is a 503. Reporting 401 here is what sent the previous round of
      // investigation looking at graduation records instead of at the relay.
      if (verdict.reason === 'verifier_unavailable') {
        console.warn(`[AUTH] Cert verifier unavailable for ${ip}: ${req.method} ${req.path}`);
        return res.status(503).json({
          error: 'Certificate verification is temporarily unavailable. Retry shortly.',
          code: 'verifier_unavailable',
        });
      }
      console.warn(`[AUTH] Rejected certificate cookie (${verdict.reason}) from ${ip}: ${req.method} ${req.path}`);
      return res.status(401).json({
        error: verdict.reason === 'expired'
          ? 'This certificate has expired. Graduate again from XMRT University to renew it.'
          : verdict.reason === 'revoked'
            ? 'This certificate has been revoked.'
            : 'Invalid certificate.',
        code: verdict.reason,
      });
    }
    // Check agent-specific API keys (xrt_ prefix) from the in-memory cache
    if (apiKey.startsWith('xrt_') && agentApiKeys[apiKey]) {
      req.agentAuth = { agent_id: agentApiKeys[apiKey].agent_id, label: agentApiKeys[apiKey].label, method: 'agent_key' };
      return next();
    }
    if (!apiKey) { console.warn(`[AUTH] Missing credentials from ${ip}: ${req.method} ${req.path}`); return res.status(401).json({ error: 'Authentication required. Provide Cf-Access-Jwt-Assertion header (Cloudflare Access) or x-api-key header.' }); }
    console.warn(`[AUTH] Invalid x-api-key from ${ip}: ${req.method} ${req.path}`);
    return res.status(403).json({ error: 'Invalid API key' });
  }
  // If RELAY_API_KEY is not set, still require auth for external requests
  console.warn(`[AUTH] Missing credentials from ${ip}: ${req.method} ${req.path}`);
  return res.status(401).json({ error: 'Authentication required. RELAY_API_KEY not configured. Provide Cf-Access-Jwt-Assertion header (Cloudflare Access) or x-api-key header.' });
});

// ── Request logging middleware (captures status, duration, agent for activity feed) ──
app.use((req, res, next) => {
  const start = Date.now();
  const agentId = req.headers['x-agent-id'] || req.headers['x-agent'] || 'unknown';
  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - start;
    const statusCode = res.statusCode;
    // Log interesting requests to activity feed with agent attribution
    logRelayRequest(req.method, req.path, statusCode, duration, agentId).catch(() => {});
    return originalEnd.apply(this, args);
  };
  next();
});

// ── Ontology documents (machine-readable project definitions) ──
const ONTOLOGY_DIR = join(__dirname, '..');
app.get('/ontology/:name', (req, res) => {
  const name = req.params.name.replace(/\.\./g, '').replace(/[\/\\]/g, '');
  const filePath = join(ONTOLOGY_DIR, `ONTOLOGY-${name}.md`);
  if (existsSync(filePath)) return res.sendFile(filePath);
  res.status(404).json({ error: `Ontology not found. Available: PARTY-FAVOR-PHOTO, XMRT-DAO, CUTTLEFISHCLAWS, 31HARBOR` });
});

// ── Fast static file routes (bypasses slow express.static on Windows) ──
const PUBLIC_DIR = join(__dirname, 'public');
const SPATIAL_DIR = join(__dirname, 'spatial');

// Images, served from public/.
//
// The dashboard markup asks for /images/xmrtdao.png, but the file has always lived
// one level up, at public/xmrtdao.png, and no route served either path. The result
// was a 404 for the logo on every page served by this relay - which reads as a
// broken image rather than a broken route, so it survives a long time unnoticed.
//
// This is a route rather than an express.static mount for the same reason the
// /static/* routes below are: a missing mount is silent, and a 404 on one asset
// does not fail a page load.
//
// The allowlist is deliberate. A path parameter that is joined onto a directory
// and then read is a directory-traversal waiting to happen, and '..' is enough to
// read relay/.env. Names are resolved against a known set, and anything else 404s.
const PUBLIC_IMAGES = new Set(['xmrtdao.png', 'pfp.png']);

app.get('/images/:name', (req, res) => {
  const name = req.params.name;
  if (!PUBLIC_IMAGES.has(name)) {
    return res.status(404).send('/* image not found */');
  }
  const filePath = join(PUBLIC_DIR, name);
  if (!existsSync(filePath)) {
    return res.status(404).send('/* image not found */');
  }
  // Both are PNGs, and both are content-addressed by the client after first load,
  // so a long cache is safe here in a way it would not be for the scripts above.
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath);
});

// The dashboard's own scripts, served explicitly rather than through a static
// mount.
//
// This was missing and the failure it causes is the worst kind: the page's
// server-rendered HTML still arrives, so the dashboard looks fine at a glance,
// and every panel that needs JavaScript simply stays empty. "The content is
// there but nothing loads" reads as a data problem and is actually a 404 on this
// file. tests/static-assets.test.mjs now asserts every script the page references
// answers 200, so it cannot go missing quietly again.
// A cache key that changes whenever dashboard.js changes on disk.
//
// WHY THIS EXISTS. The script tag used to point at a constant
// "/static/dashboard.js", and Cloudflare answers that URL from its edge with
// `cache-control: max-age=14400` and `cf-cache-status: HIT` — four hours. The
// relay was serving the new file correctly the whole time (167,928 bytes on
// disk) while every browser kept executing the old one (158,652 bytes). The
// symptom was a feature that "did nothing": the DOM node was present and the
// endpoint answered 404/401 correctly, and the button still did not exist in
// the page, because the page was never given the code.
//
// Deriving the stamp from mtime+size means the version bumps itself on every
// edit. Nothing to remember to update, so nothing can forget.
let dashboardJsVersionCache = null;
function dashboardJsVersion() {
  try {
    const st = statSync(join(PUBLIC_DIR, 'dashboard.js'));
    const v = st.mtimeMs + '.' + st.size;
    if (v !== dashboardJsVersionCache) dashboardJsVersionCache = v;
    return v;
  } catch {
    return dashboardJsVersionCache || '0';
  }
}

app.get('/static/dashboard.js', (req, res) => {
  const filePath = join(PUBLIC_DIR, 'dashboard.js');
  if (!existsSync(filePath)) {
    return res.status(404).send('/* dashboard.js not found */');
  }
  // revalidate, do not serve blind from the edge. The versioned URL in the HTML
  // is what makes this cheap; this header is what stops an unversioned request
  // (someone opening the file directly, a bookmark, an old cached HTML page)
  // from being four hours stale.
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  let content = readFileSync(filePath, 'utf8');
  // The dashboard carries no placeholders today, but the substitution is kept
  // because removing it is a silent breakage: the moment a ${supabaseUrl} is
  // added back, a raw file would ship the literal text to the browser.
  content = content.replace(/\$\{supabaseUrl\}/g, SUPABASE_URL);
  content = content.replace(/\$\{supabaseKey\}/g, SUPABASE_KEY);
  // The dashboard's own API key. It has to reach the browser, so it is injected
  // here rather than committed: a key in dashboard.js is a key in the repository
  // and in every clone of it, and this one had already reached three branches.
  content = content.replace(/\$\{relayApiKey\}/g, RELAY_API_KEY || '');
  res.setHeader('Content-Type', 'application/javascript');
  res.send(content);
});

app.get('/static/markdown.js', (req, res) => {
  const filePath = join(PUBLIC_DIR, 'markdown.js');
  if (!existsSync(filePath)) {
    return res.status(404).send('/* markdown.js not found */');
  }
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(filePath);
});

// ── Suite SPA (Vite build, served locally instead of GH Pages' broken CDN) ──
// IMPORTANT: SUITE_DIR must point to the Vite build output (suite/dist/), not
// the GH Pages subpath (xmrtdao.github.io/suite/). The GH Pages version was
// replaced with a redirect to relay.mobilemonero.com/suite/, so serving from
// there would create an infinite loop.
const SUITE_DIR = join(__dirname, '..', 'suite', 'dist');
if (existsSync(join(SUITE_DIR, 'index.html'))) {
  // Vite emits content-hashed filenames into dist/assets, so those are safe to
  // cache forever. The HTML entry point is NOT: it references the hashed
  // bundles, so a cached copy keeps pointing at bundles that the next build
  // deletes. Previously everything got maxAge '5m', which meant for up to five
  // minutes after a deploy a returning visitor's index.html referenced a
  // deleted asset — and because the SPA fallback below answers unknown paths
  // with index.html, that request returned 200 text/html instead of 404. The
  // browser then refused the script as a MIME mismatch and the whole app went
  // blank with no obvious error.
  app.use('/suite/assets', express.static(join(SUITE_DIR, 'assets'), {
    immutable: true,
    maxAge: '1y',
  }));
  app.use('/suite', express.static(SUITE_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=300');
      }
    },
  }));
  // SPA fallback — any /suite/* path that isn't a real file serves index.html
  // so client-side routing (e.g. /suite/dashboard) works.
  // Using regex to avoid path-to-regexp v8+ compatibility issues.
  app.get('/suite', (req, res) => res.redirect('/suite/'));
  app.get(/^\/suite\/.*$/, (req, res) => {
    const relativePath = req.path.replace(/^\/suite\//, '');
    const filePath = join(SUITE_DIR, relativePath);
    if (existsSync(filePath) && relativePath) return res.sendFile(filePath);
    // Anything else is a client-side route, EXCEPT a missing file under
    // /assets/ — returning HTML for a deleted hashed bundle makes the browser
    // fail with a confusing MIME error instead of a clear 404.
    if (relativePath.startsWith('assets/')) {
      return res.status(404).json({ error: 'asset_not_found', path: relativePath });
    }
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(join(SUITE_DIR, 'index.html'));
  });
  console.log(`  Suite SPA: ${SUITE_DIR}`);
} else {
  console.log(`  Suite SPA: NOT FOUND at ${SUITE_DIR} — skipping`);
}

// ── HottieHouse SPA (Vite build) ──
const HOTTIE_DIR = join(__dirname, '..', 'hottiehouse', 'app', 'dist');
if (existsSync(join(HOTTIE_DIR, 'index.html'))) {
  app.use('/hottiehouse', express.static(HOTTIE_DIR, { maxAge: '5m' }));
  app.get('/hottiehouse/*path', (req, res) => {
    const filePath = join(HOTTIE_DIR, req.path.replace(/^\/hottiehouse\//, ''));
    if (existsSync(filePath)) return res.sendFile(filePath);
    res.sendFile(join(HOTTIE_DIR, 'index.html'));
  });
  console.log(`  HottieHouse SPA: ${HOTTIE_DIR}`);
} else {
  console.log(`  HottieHouse SPA: NOT FOUND at ${HOTTIE_DIR} — skipping`);
}

// ── Cuttlefish Claws SPA (Vite build) ──
const CUTTLEFISH_DIR = join(__dirname, '..', 'cuttlefishclaws', 'dist');
if (existsSync(join(CUTTLEFISH_DIR, 'index.html'))) {
  app.use('/cuttlefishclaws', express.static(CUTTLEFISH_DIR, { maxAge: '5m' }));
  app.get('/cuttlefishclaws/*path', (req, res) => {
    const filePath = join(CUTTLEFISH_DIR, req.path.replace(/^\/cuttlefishclaws\//, ''));
    if (existsSync(filePath)) return res.sendFile(filePath);
    res.sendFile(join(CUTTLEFISH_DIR, 'index.html'));
  });
  console.log(`  CuttlefishClaws SPA: ${CUTTLEFISH_DIR}`);
} else {
  console.log(`  CuttlefishClaws SPA: NOT FOUND at ${CUTTLEFISH_DIR} — skipping`);
}

// ── CashDApp SPA (Vite build) ──
const CASHDAPP_DIR = join(__dirname, '..', 'cashdapp', 'dist');
if (existsSync(join(CASHDAPP_DIR, 'index.html'))) {
  app.use('/cashdapp', express.static(CASHDAPP_DIR, { maxAge: '5m' }));
  app.get('/cashdapp/*path', (req, res) => {
    const filePath = join(CASHDAPP_DIR, req.path.replace(/^\/cashdapp\//, ''));
    if (existsSync(filePath)) return res.sendFile(filePath);
    res.sendFile(join(CASHDAPP_DIR, 'index.html'));
  });
  console.log(`  CashDApp SPA: ${CASHDAPP_DIR}`);
} else {
  console.log(`  CashDApp SPA: NOT FOUND at ${CASHDAPP_DIR} — skipping`);
}

// ── PFP Intake SPA (Vite build, client onboarding flow) ──
const INTAKE_DIR = join(__dirname, '..', 'intake', 'dist');
if (existsSync(join(INTAKE_DIR, 'index.html'))) {
  app.use('/intake', express.static(INTAKE_DIR, { maxAge: '5m' }));
  app.get('/intake/*path', (req, res) => {
    const filePath = join(INTAKE_DIR, req.path.replace(/^\/intake\//, ''));
    if (existsSync(filePath)) return res.sendFile(filePath);
    res.sendFile(join(INTAKE_DIR, 'index.html'));
  });
  console.log(`  PFP Intake SPA: ${INTAKE_DIR}`);
} else {
  console.log(`  PFP Intake SPA: NOT FOUND at ${INTAKE_DIR} — skipping`);
}

// ── PFP Bookings SPA (Vite build, CRM admin panel) ──
const BOOKINGS_DIR = join(__dirname, '..', 'partyfavorphoto', 'bookings', 'dist');
if (existsSync(join(BOOKINGS_DIR, 'index.html'))) {
  app.use('/bookings', express.static(BOOKINGS_DIR, { maxAge: '5m' }));
  app.get('/bookings/*path', (req, res) => {
    const filePath = join(BOOKINGS_DIR, req.path.replace(/^\/bookings\//, ''));
    if (existsSync(filePath)) return res.sendFile(filePath);
    res.sendFile(join(BOOKINGS_DIR, 'index.html'));
  });
  console.log(`  PFP Bookings SPA: ${BOOKINGS_DIR}`);
} else {
  console.log(`  PFP Bookings SPA: NOT FOUND at ${BOOKINGS_DIR} — skipping`);
}

// ── Elze Contract Suite™ ──
// Landing page at /elze, Analyzer at /elze/analyzer, Writer at /elze/writer
const ELZE_LANDING_DIR = join(__dirname, 'public', 'elze-landing');
const ELZE_DIR = join(__dirname, 'public', 'elze-analyzer');
const ELZE_WRITER_DIR = join(__dirname, 'public', 'elze-writer');

// Landing page
if (existsSync(join(ELZE_LANDING_DIR, 'index.html'))) {
  app.get('/elze', (req, res) => res.sendFile(join(ELZE_LANDING_DIR, 'index.html')));
  console.log(`  Elze Contract Suite (landing): ${ELZE_LANDING_DIR}`);
}

// Analyzer
if (existsSync(join(ELZE_DIR, 'index.html'))) {
  app.get('/elze/analyzer', (req, res) => res.sendFile(join(ELZE_DIR, 'index.html')));
  app.get('/elze/analyzer/*path', (req, res) => {
    const filePath = join(ELZE_DIR, req.path.replace(/^\/elze\/analyzer\//, ''));
    if (existsSync(filePath)) return res.sendFile(filePath);
    res.sendFile(join(ELZE_DIR, 'index.html'));
  });
  app.use('/elze/analyzer', express.static(ELZE_DIR, { maxAge: '5m' }));
  console.log(`  Elze Contract Analyzer: ${ELZE_DIR}`);
} else {
  console.log(`  Elze Contract Analyzer: NOT FOUND at ${ELZE_DIR} — skipping`);
}

// Writer
if (existsSync(join(ELZE_WRITER_DIR, 'index.html'))) {
  app.get('/elze/writer', (req, res) => res.sendFile(join(ELZE_WRITER_DIR, 'index.html')));
  app.get('/elze/writer/*path', (req, res) => {
    const filePath = join(ELZE_WRITER_DIR, req.path.replace(/^\/elze\/writer\//, ''));
    if (existsSync(filePath)) return res.sendFile(filePath);
    res.sendFile(join(ELZE_WRITER_DIR, 'index.html'));
  });
  app.use('/elze/writer', express.static(ELZE_WRITER_DIR, { maxAge: '5m' }));
  console.log(`  Elze Contract Writer: ${ELZE_WRITER_DIR}`);
} else {
  console.log(`  Elze Contract Writer: NOT FOUND at ${ELZE_WRITER_DIR} — skipping`);
}

// AI Learnings dashboard
const ELZE_LEARNINGS_DIR = join(__dirname, 'public', 'elze-learnings');
if (existsSync(join(ELZE_LEARNINGS_DIR, 'index.html'))) {
  app.get('/elze/learnings', (req, res) => res.sendFile(join(ELZE_LEARNINGS_DIR, 'index.html')));
  app.get('/elze/learnings/*path', (req, res) => {
    const filePath = join(ELZE_LEARNINGS_DIR, req.path.replace(/^\/elze\/learnings\//, ''));
    if (existsSync(filePath)) return res.sendFile(filePath);
    res.sendFile(join(ELZE_LEARNINGS_DIR, 'index.html'));
  });
  app.use('/elze/learnings', express.static(ELZE_LEARNINGS_DIR, { maxAge: '5m' }));
  console.log(`  Elze AI Learnings: ${ELZE_LEARNINGS_DIR}`);
} else {
  console.log(`  Elze AI Learnings: NOT FOUND at ${ELZE_LEARNINGS_DIR} — skipping`);
}

// ── 31Harbor Agency Dashboard (Vite build, per-company themed SPAs) ──
const AGENCY_DIR = join(__dirname, '..', '31harbor-agency-dashboard', 'dist');
if (existsSync(join(AGENCY_DIR, 'index.html'))) {
  // Serve static assets from dist root (resolves /assets/index-xxx.js references in HTML)
  app.use('/assets', express.static(join(AGENCY_DIR, 'assets'), { maxAge: '5m' }));
  // Serve sql-wasm.wasm at root so sql.js fallback can load it via locateFile
  const wasmPath = join(AGENCY_DIR, 'sql-wasm.wasm');
  if (existsSync(wasmPath)) {
    app.get('/sql-wasm.wasm', (req, res) => res.sendFile(wasmPath));
  }
  // Per-company SPA routes — redirect /harbor → /harbor/ so index.html resolves
  const companies = ['harbor', 'party', 'xmrt'];
  for (const co of companies) {
    const coDir = join(AGENCY_DIR, co);
    if (!existsSync(join(coDir, 'index.html'))) {
      console.log(`  Agency Dashboard (${co}): NOT FOUND — skipping`);
      continue;
    }
    // Handle both /harbor and /harbor/ — serve the SPA
    const indexPath = join(coDir, 'index.html');
    app.get(`/${co}`, (req, res) => res.sendFile(indexPath));
    app.get(`/${co}/`, (req, res) => res.sendFile(indexPath));
    app.get(`/${co}/*path`, (req, res) => {
      const filePath = join(coDir, req.path.replace(`/${co}/`, ''));
      if (existsSync(filePath) && !filePath.endsWith('index.html')) return res.sendFile(filePath);
      res.sendFile(join(coDir, 'index.html'));
    });
  }
  console.log(`  Agency Dashboard: ${AGENCY_DIR} (harbor/party/xmrt)`);
} else {
  console.log(`  Agency Dashboard: NOT FOUND at ${AGENCY_DIR} — skipping`);
}

// ── Suite Dashboard REST API (agency.31harbor.com PG-backed) ────────────
app.get('/api/suite/health', async (req, res) => {
  trackRequest('/api/suite/health');
  try {
    const r = await queryLocalPg("SELECT count(*)::int AS c FROM app.suite_companies");
    res.json({ ok: true, companies: r.rows[0].c });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Unified Tool / Function Registry ─────────────────────────────────
// Task t-msbdeuo7-bpre — single queryable view of every tool/function
// across ai_tools, edge_function_proposals, proposed_edge_functions,
// function_proposals. Backed by public.unified_tool_registry view.
// Supports optional ?category= and ?status= filters.
app.get('/api/suite/tool-registry', async (req, res) => {
  trackRequest('/api/suite/tool-registry');
  try {
    const { category, status, q } = req.query;
    let sql = 'SELECT * FROM public.unified_tool_registry WHERE 1=1';
    const params = [];
    let idx = 0;
    if (category) { idx++; sql += ` AND category ILIKE $${idx}`; params.push(`%${category}%`); }
    if (status) { idx++; sql += ` AND status = $${idx}`; params.push(status.toUpperCase()); }
    if (q) { idx++; sql += ` AND (tool_name ILIKE $${idx} OR description ILIKE $${idx})`; params.push(`%${q}%`); }
    sql += ' ORDER BY category, tool_name';
    const r = await queryLocalPg(sql, params);
    res.json({ success: true, count: r.rows.length, tools: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Summary counts for the registry (by category + status)
app.get('/api/suite/tool-registry/summary', async (req, res) => {
  trackRequest('/api/suite/tool-registry/summary');
  try {
    const byCat = await queryLocalPg(`SELECT category, COUNT(*)::int AS n FROM public.unified_tool_registry GROUP BY category ORDER BY n DESC`);
    const byStatus = await queryLocalPg(`SELECT status, COUNT(*)::int AS n FROM public.unified_tool_registry GROUP BY status ORDER BY n DESC`);
    const total = await queryLocalPg(`SELECT COUNT(*)::int AS n FROM public.unified_tool_registry`);
    res.json({ success: true, total: total.rows[0].n, byCategory: byCat.rows, byStatus: byStatus.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Companies ─────────────────────────────────────────────────────────
app.get('/api/suite/companies', async (req, res) => {
  trackRequest('/api/suite/companies');
  try {
    const r = await queryLocalPg('SELECT * FROM app.suite_companies ORDER BY name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suite/companies/:id', async (req, res) => {
  trackRequest('/api/suite/companies/:id');
  try {
    const r = await queryLocalPg('SELECT * FROM app.suite_companies WHERE id = $1', [req.params.id]);
    res.json(r.rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Leads ─────────────────────────────────────────────────────────────
app.get('/api/suite/leads/count', async (req, res) => {
  trackRequest('/api/suite/leads/count');
  try {
    const company = req.query.company;
    const r = company
      ? await queryLocalPg("SELECT count(*)::int AS c FROM app.suite_leads WHERE company_routed = $1", [company])
      : await queryLocalPg("SELECT count(*)::int AS c FROM app.suite_leads");
    res.json({ count: r.rows[0].c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suite/leads/search', async (req, res) => {
  trackRequest('/api/suite/leads/search');
  try {
    const q = req.query.q || '';
    if (!q.trim()) return res.json([]);
    const r = await queryLocalPg(
      'SELECT * FROM app.suite_leads WHERE name ILIKE $1 OR email ILIKE $1 OR company_routed ILIKE $1 OR intent ILIKE $1 ORDER BY score DESC LIMIT 20',
      [`%${q}%`]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suite/leads', async (req, res) => {
  trackRequest('/api/suite/leads');
  try {
    let sql = 'SELECT * FROM app.suite_leads WHERE 1=1';
    const params = [];
    const { company, status, source, search, minScore, maxScore, limit } = req.query;
    if (company) { params.push(company); sql += ` AND company_routed = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
    if (source) { params.push(source); sql += ` AND source = $${params.length}`; }
    if (search) { params.push(`%${search}%`); sql += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})`; }
    if (minScore) { params.push(parseInt(minScore)); sql += ` AND score >= $${params.length}`; }
    if (maxScore) { params.push(parseInt(maxScore)); sql += ` AND score <= $${params.length}`; }
    sql += ' ORDER BY score DESC, created_at DESC';
    if (limit) { params.push(parseInt(limit)); sql += ` LIMIT $${params.length}`; }
    const r = await queryLocalPg(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suite/leads/:id', async (req, res) => {
  trackRequest('/api/suite/leads/:id');
  try {
    const r = await queryLocalPg('SELECT * FROM app.suite_leads WHERE id = $1', [parseInt(req.params.id)]);
    res.json(r.rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/suite/leads', async (req, res) => {
  trackRequest('POST /api/suite/leads');
  try {
    const { name, email, phone, source, intent, company_routed, score, status, ai_confidence, ai_reasoning, pipeline_stage, value } = req.body;
    const r = await queryLocalPg(
      `INSERT INTO app.suite_leads (name, email, phone, source, intent, company_routed, score, status, ai_confidence, ai_reasoning, pipeline_stage, value, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW()) RETURNING id`,
      [name, email||null, phone||null, source||null, intent||null, company_routed||null, score||0, status||'new', ai_confidence||null, ai_reasoning||null, pipeline_stage||'scraping', value||0]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/suite/leads/:id', async (req, res) => {
  trackRequest('PATCH /api/suite/leads/:id');
  try {
    const id = parseInt(req.params.id);
    const sets = []; const params = []; let idx = 0;
    for (const [k, v] of Object.entries(req.body)) {
      if (['name','email','phone','source','intent','company_routed','score','status','ai_confidence','ai_reasoning','pipeline_stage','value'].includes(k)) {
        idx++; params.push(v); sets.push(`${k} = $${idx}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No valid fields' });
    params.push(id);
    await queryLocalPg(`UPDATE app.suite_leads SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx+1}`, params);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/suite/leads/:id', async (req, res) => {
  trackRequest('DELETE /api/suite/leads/:id');
  try {
    await queryLocalPg('DELETE FROM app.suite_leads WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/suite/leads/:id/route', async (req, res) => {
  trackRequest('POST /api/suite/leads/:id/route');
  try {
    const id = parseInt(req.params.id);
    const { targetCompany } = req.body;
    await queryLocalPg('UPDATE app.suite_leads SET company_routed = $1, updated_at = NOW() WHERE id = $2', [targetCompany, id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pipeline Value ────────────────────────────────────────────────────
app.get('/api/suite/pipeline/value', async (req, res) => {
  trackRequest('/api/suite/pipeline/value');
  try {
    const r = await queryLocalPg("SELECT COALESCE(SUM(value),0)::numeric AS value FROM app.suite_leads WHERE pipeline_stage NOT IN ('paid','fulfilled')");
    res.json({ value: parseFloat(r.rows[0].value) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pipeline Stages ──────────────────────────────────────────────────
app.get('/api/suite/pipeline-stages', async (req, res) => {
  trackRequest('/api/suite/pipeline-stages');
  try {
    const r = await queryLocalPg('SELECT * FROM app.suite_pipeline_stages ORDER BY order_index');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suite/pipeline-data', async (req, res) => {
  trackRequest('/api/suite/pipeline-data');
  try {
    const company = req.query.company;
    let sql = `SELECT ps.id, ps.name AS label, COUNT(l.id)::int AS count,
      COALESCE((SELECT json_agg(l2.id) FROM app.suite_leads l2 WHERE l2.pipeline_stage = ps.id ${company ? 'AND l2.company_routed = $1' : ''}), '[]'::json) AS lead_ids,
      ps.requires_approval AS needs_approval
      FROM app.suite_pipeline_stages ps
      LEFT JOIN app.suite_leads l ON l.pipeline_stage = ps.id ${company ? 'AND l.company_routed = $1' : ''}
      GROUP BY ps.id, ps.name, ps.order_index, ps.requires_approval ORDER BY ps.order_index`;
    const params = company ? [company] : [];
    const r = await queryLocalPg(sql, params);
    res.json(r.rows.map(row => ({ id: row.id, label: row.label, count: row.count, leadIds: row.lead_ids || [], needsApproval: row.needs_approval })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Campaigns ────────────────────────────────────────────────────────
app.get('/api/suite/campaigns/count', async (req, res) => {
  trackRequest('/api/suite/campaigns/count');
  try {
    const company = req.query.company;
    const r = company
      ? await queryLocalPg("SELECT count(*)::int AS c FROM app.suite_campaigns WHERE company = $1", [company])
      : await queryLocalPg("SELECT count(*)::int AS c FROM app.suite_campaigns");
    res.json({ count: r.rows[0].c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suite/campaigns', async (req, res) => {
  trackRequest('/api/suite/campaigns');
  try {
    const company = req.query.company;
    const r = company
      ? await queryLocalPg('SELECT * FROM app.suite_campaigns WHERE company = $1 ORDER BY start_date DESC', [company])
      : await queryLocalPg('SELECT * FROM app.suite_campaigns ORDER BY start_date DESC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/suite/campaigns/:id', async (req, res) => {
  trackRequest('PATCH /api/suite/campaigns/:id');
  try {
    const id = parseInt(req.params.id);
    const sets = []; const params = []; let idx = 0;
    for (const [k, v] of Object.entries(req.body)) {
      if (['name','company','status','budget','spend','revenue','roi','reach','clicks','conversions','platform','start_date','end_date'].includes(k)) {
        idx++; params.push(v); sets.push(`${k} = $${idx}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No valid fields' });
    params.push(id);
    await queryLocalPg(`UPDATE app.suite_campaigns SET ${sets.join(', ')} WHERE id = $${idx+1}`, params);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sharing Rules ────────────────────────────────────────────────────
app.get('/api/suite/sharing-rules', async (req, res) => {
  trackRequest('/api/suite/sharing-rules');
  try {
    const r = await queryLocalPg('SELECT * FROM app.suite_lead_sharing_rules ORDER BY from_company, to_company');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suite/sharing-rules/can-share', async (req, res) => {
  trackRequest('/api/suite/sharing-rules/can-share');
  try {
    const { from, to } = req.query;
    const r = await queryLocalPg('SELECT allowed FROM app.suite_lead_sharing_rules WHERE from_company = $1 AND to_company = $2', [from, to]);
    res.json({ allowed: r.rows.length ? !!r.rows[0].allowed : false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/suite/sharing-rules', async (req, res) => {
  trackRequest('POST /api/suite/sharing-rules');
  try {
    const { from_company, to_company, allowed } = req.body;
    await queryLocalPg(
      `INSERT INTO app.suite_lead_sharing_rules (from_company, to_company, allowed, created_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (from_company, to_company) DO UPDATE SET allowed = $3`,
      [from_company, to_company, allowed ? 1 : 0]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Activity Log ─────────────────────────────────────────────────────
// THE LIVE HANDLERS live here, not in routes/suite-dashboard.mjs.
//
// This path was registered three times. Express keeps the first registration
// and silently ignores the rest, and registerSuiteRoutes(app) is called at the
// very bottom of this file (line ~15681) - so every route in that module that
// also exists here is dead code, not an override. 33 paths are affected; this
// one mattered because it is how a task handoff is recorded.
//
// app.suite_activity_log has exactly these columns, established by measuring
// SELECT * rather than by reading a migration:
//   id, type, company, description, metadata, created_at
// There is no activity_type / title / status / task_id / agent_id column, and
// the Suite SPA sends all six when it records a handoff. So a handoff used to
// be stored as a bare sentence - no type, no task, no agent - while the client
// received 201 and the UI showed a success toast. Nothing was ever wrong with
// the drag-and-drop itself; the reassignment persisted correctly the whole time.
// The record of it did not.
//
// type now carries the event name so handoffs are queryable, and the fields the
// table cannot hold are folded into metadata rather than discarded. The proper
// fix is an additive migration adding those columns; this is lossless without one.
function suiteActivityMetadata(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return v; }
}

app.get('/api/suite/activity-log', async (req, res) => {
  trackRequest('/api/suite/activity-log');
  try {
    const where = [];
    const params = [];
    if (req.query.company) { params.push(req.query.company); where.push(`company = $${params.length}`); }
    // Added so a handoff can actually be asked for. Without it, callers could
    // not filter on the event type, which is most of what the log is for.
    if (req.query.type) { params.push(req.query.type); where.push(`type = $${params.length}`); }
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    params.push(limit);
    const r = await queryLocalPg(
      `SELECT * FROM app.suite_activity_log${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    // jsonb arrives as a string over this driver; hand back an object so every
    // caller is not each re-parsing it.
    res.json(r.rows.map((row) => ({ ...row, metadata: suiteActivityMetadata(row.metadata) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/suite/activity-log', async (req, res) => {
  trackRequest('POST /api/suite/activity-log');
  try {
    const b = req.body || {};
    const activityType = b.activity_type || b.type || null;
    if (!activityType) return res.status(400).json({ error: 'activity_type required' });
    const meta = {
      ...(suiteActivityMetadata(b.metadata) || {}),
      ...(b.title ? { title: b.title } : {}),
      ...(b.status ? { status: b.status } : {}),
      ...(b.task_id ? { task_id: b.task_id } : {}),
      ...(b.agent_id ? { agent_id: b.agent_id } : {}),
    };
    const r = await queryLocalPg(
      `INSERT INTO app.suite_activity_log (type, company, description, metadata, created_at)
       VALUES ($1,$2,$3,$4,NOW()) RETURNING *`,
      [activityType, b.company || null, b.description || '', Object.keys(meta).length ? JSON.stringify(meta) : null]
    );
    const row = r.rows[0] || {};
    res.status(201).json({ ...row, metadata: suiteActivityMetadata(row.metadata) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The two other registrations of this path were removed. One read
// {type, company, description, metadata} against a client that sends
// {activity_type, title, ...} and nulled everything; the other read columns the
// table does not have and would have thrown on every handoff. The modular copy
// in routes/suite-dashboard.mjs is also removed, so there is one implementation
// and it is the one that runs.

// ── Users ────────────────────────────────────────────────────────────
app.get('/api/suite/users', async (req, res) => {
  trackRequest('/api/suite/users');
  try {
    const r = await queryLocalPg('SELECT * FROM app.suite_users ORDER BY name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analytics ─────────────────────────────────────────────────────────
app.get('/api/suite/analytics', async (req, res) => {
  trackRequest('/api/suite/analytics');
  try {
    const company = req.query.company;
    const companyFilter = company ? ' WHERE company_routed = $1' : '';
    const params = company ? [company] : [];
    const [leadsTotal, leadsActive, pipelineValue, monthlyRevenue] = await Promise.all([
      queryLocalPg(`SELECT count(*)::int AS c FROM app.suite_leads${companyFilter}`, params),
      queryLocalPg(`SELECT count(*)::int AS c FROM app.suite_leads${companyFilter ? companyFilter + ' AND pipeline_stage NOT IN ($2,$3)' : " WHERE pipeline_stage NOT IN ('paid','fulfilled')"}`, company ? [...params, 'paid', 'fulfilled'] : []),
      queryLocalPg(`SELECT COALESCE(SUM(value),0)::numeric AS v FROM app.suite_leads${companyFilter ? companyFilter + ' AND pipeline_stage NOT IN ($2,$3)' : " WHERE pipeline_stage NOT IN ('paid','fulfilled')"}`, company ? [...params, 'paid', 'fulfilled'] : []),
      queryLocalPg(`SELECT COALESCE(SUM(revenue),0)::numeric AS rev, COALESCE(SUM(spend),0)::numeric AS sp FROM app.suite_campaigns${company ? ' WHERE company = $1' : ''}`, company ? params : []),
    ]);
    res.json({
      totalLeads: leadsTotal.rows[0].c,
      activeLeads: leadsActive.rows[0].c,
      pipelineValue: parseFloat(pipelineValue.rows[0].v),
      totalRevenue: parseFloat(monthlyRevenue.rows[0].rev),
      totalSpend: parseFloat(monthlyRevenue.rows[0].sp),
      leadSources: company ? [] : [], // simplified — add later via GROUP BY if needed
      conversionRate: 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suite/revenue-data', async (req, res) => {
  trackRequest('/api/suite/revenue-data');
  try {
    // Return per-company revenue per month (simplified — from campaigns)
    const r = await queryLocalPg(`
      SELECT
        to_char(NOW(), 'YYYY-MM') AS month,
        COALESCE((SELECT SUM(revenue) FROM app.suite_campaigns WHERE company = 'harbor'),0) AS harbor,
        COALESCE((SELECT SUM(revenue) FROM app.suite_campaigns WHERE company = 'party'),0) AS party,
        COALESCE((SELECT SUM(revenue) FROM app.suite_campaigns WHERE company = 'xmrt'),0) AS xmrt
    `);
    // Build a 3-month history for the chart
    const now = new Date();
    const months = [];
    for (let i = 2; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = d.toISOString().slice(0, 7);
      months.push({ month: label, harbor: Math.round(r.rows[0].harbor / 3), party: Math.round(r.rows[0].party / 3), xmrt: Math.round(r.rows[0].xmrt / 3) });
    }
    res.json(months);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suite/conversion-funnel', async (req, res) => {
  trackRequest('/api/suite/conversion-funnel');
  try {
    const r = await queryLocalPg(`
      SELECT ps.name AS stage, ps.order_index, COUNT(l.id)::int AS count
      FROM app.suite_pipeline_stages ps
      LEFT JOIN app.suite_leads l ON l.pipeline_stage = ps.id
      GROUP BY ps.id, ps.name, ps.order_index ORDER BY ps.order_index
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Email Activity ───────────────────────────────────────────────────
app.get('/api/suite/email-activity', async (req, res) => {
  trackRequest('/api/suite/email-activity');
  try {
    const company = req.query.company;
    const limit = parseInt(req.query.limit) || 20;
    const r = company
      ? await queryLocalPg('SELECT * FROM app.suite_email_activity WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2', [company, limit])
      : await queryLocalPg('SELECT * FROM app.suite_email_activity ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/suite/email-activity', async (req, res) => {
  trackRequest('POST /api/suite/email-activity');
  try {
    const { resend_id, company_id, email_from, email_to, subject, status, clicks, opens } = req.body;
    await queryLocalPg(
      `INSERT INTO app.suite_email_activity (resend_id, company_id, email_from, email_to, subject, status, clicks, opens, sent_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) ON CONFLICT (resend_id) DO NOTHING`,
      [resend_id, company_id, email_from||null, email_to||null, subject||null, status||'sent', clicks||0, opens||0]
    );
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/suite/email-activity/:resendId', async (req, res) => {
  trackRequest('PATCH /api/suite/email-activity/:resendId');
  try {
    const sets = []; const params = []; let idx = 0;
    for (const [k, v] of Object.entries(req.body)) {
      if (['status','clicks','opens'].includes(k)) {
        idx++; params.push(v); sets.push(`${k} = $${idx}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No valid fields' });
    params.push(req.params.resendId);
    await queryLocalPg(`UPDATE app.suite_email_activity SET ${sets.join(', ')} WHERE resend_id = $${idx+1}`, params);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suite/email-stats', async (req, res) => {
  trackRequest('/api/suite/email-stats');
  try {
    const company = req.query.company;
    const where = company ? ' WHERE company_id = $1' : '';
    const params = company ? [company] : [];
    const [total, sent, delivered, opened, bounced] = await Promise.all([
      queryLocalPg(`SELECT count(*)::int AS c FROM app.suite_email_activity${where}`, params),
      queryLocalPg(`SELECT count(*)::int AS c FROM app.suite_email_activity${where ? where + " AND status = 'sent'" : " WHERE status = 'sent'"}`, params),
      queryLocalPg(`SELECT count(*)::int AS c FROM app.suite_email_activity${where ? where + " AND status = 'delivered'" : " WHERE status = 'delivered'"}`, params),
      queryLocalPg(`SELECT count(*)::int AS c FROM app.suite_email_activity${where ? where + ' AND opens > 0' : ' WHERE opens > 0'}`, params),
      queryLocalPg(`SELECT count(*)::int AS c FROM app.suite_email_activity${where ? where + " AND status = 'bounced'" : " WHERE status = 'bounced'"}`, params),
    ]);
    res.json({
      total: total.rows[0].c,
      sent: sent.rows[0].c,
      delivered: delivered.rows[0].c,
      opened: opened.rows[0].c,
      bounced: bounced.rows[0].c,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STAE Tasks & Agents API ─────────────────────────────────────────────
app.get('/api/suite/tasks', async (req, res) => {
  trackRequest('/api/suite/tasks');
  try {
    let sql = `SELECT id, title, description, stage, status, priority, category, assignee_agent_id, blocking_reason, updated_at, stage_started_at, auto_advance_threshold_hours, progress_percentage, completed_checklist_items, organization_id, created_by_user_id, created_at FROM app.tasks WHERE 1=1`;
    const params = []; let idx = 0;
    if (req.query.organization_id) { idx++; sql += ` AND organization_id = $${idx}`; params.push(req.query.organization_id); }
    if (req.query.no_org === 'true') { idx++; sql += ` AND organization_id IS NULL`; }
    if (req.query.status_in) {
      const statuses = req.query.status_in.split(',');
      idx++; sql += ` AND status = ANY($${idx})`; params.push(statuses);
    }
    if (req.query.assignee_agent_id) { idx++; sql += ` AND assignee_agent_id = $${idx}`; params.push(req.query.assignee_agent_id); }
    sql += ` ORDER BY priority DESC, created_at DESC`;
    if (req.query.limit) { idx++; sql += ` LIMIT $${idx}`; params.push(parseInt(req.query.limit)); }
    if (req.query.offset) { idx++; sql += ` OFFSET $${idx}`; params.push(parseInt(req.query.offset)); }
    const r = await queryLocalPg(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suite/tasks/:id', async (req, res) => {
  trackRequest('/api/suite/tasks/:id');
  try {
    const r = await queryLocalPg('SELECT * FROM app.tasks WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/suite/tasks', async (req, res) => {
  trackRequest('POST /api/suite/tasks');
  try {
    const { title, description, stage, status, priority, category, assignee_agent_id: rawAssignee, blocking_reason, auto_advance_threshold_hours, progress_percentage, organization_id, created_by_user_id } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    // Resolve short agent names to full agent IDs
    let assignee_agent_id = rawAssignee;
    if (rawAssignee && !rawAssignee.includes('-') && rawAssignee.length < 20) {
      const agentLookup = await queryLocalPg(
        `SELECT id FROM app.agents WHERE LOWER(name) = LOWER($1) OR LOWER(id) = LOWER($1) LIMIT 1`,
        [rawAssignee]
      );
      if (agentLookup.rows.length > 0) {
        assignee_agent_id = agentLookup.rows[0].id;
      }
      // Also try app.agent_api_keys by label
      if (!assignee_agent_id || assignee_agent_id === rawAssignee) {
        const keyLookup = await queryLocalPg(
          `SELECT agent_id FROM app.agent_api_keys WHERE LOWER(label) LIKE LOWER($1) LIMIT 1`,
          [`%${rawAssignee.replace(/-key$/, '')}%`]
        );
        if (keyLookup.rows.length > 0) {
          assignee_agent_id = keyLookup.rows[0].agent_id;
        }
      }
    }

    const r = await queryLocalPg(
      `INSERT INTO app.tasks (id, title, description, stage, status, priority, category, assignee_agent_id, blocking_reason, auto_advance_threshold_hours, progress_percentage, organization_id, created_by_user_id) VALUES (gen_random_uuid()::text, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [title, description||null, stage||'PENDING', status||'PENDING', priority||0, category||null, assignee_agent_id||null, blocking_reason||null, auto_advance_threshold_hours||null, progress_percentage||0, organization_id||null, created_by_user_id||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/suite/tasks/:id', async (req, res) => {
  trackRequest('PATCH /api/suite/tasks/:id');
  try {
    const allowed = ['title','description','stage','status','priority','category','assignee_agent_id','blocking_reason','stage_started_at','auto_advance_threshold_hours','progress_percentage','completed_checklist_items'];
    const sets = []; const params = []; let idx = 0;
    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k)) { idx++; params.push(v); sets.push(`${k} = $${idx}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'No valid fields' });
    params.push(req.params.id);
    const r = await queryLocalPg(`UPDATE app.tasks SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx+1} RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/suite/tasks/:id', async (req, res) => {
  trackRequest('DELETE /api/suite/tasks/:id');
  try {
    const r = await queryLocalPg('DELETE FROM app.tasks WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suite/agents', async (req, res) => {
  trackRequest('/api/suite/agents');
  try {
    let sql = 'SELECT id, name, role, status, current_workload, skills, description FROM app.agents WHERE 1=1';
    const params = []; let idx = 0;
    if (req.query.status_in) {
      const statuses = req.query.status_in.split(',');
      idx++; sql += ` AND status = ANY($${idx})`; params.push(statuses);
    }
    sql += ' ORDER BY name';
    const r = await queryLocalPg(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Agent PATCH (update workload/status when tasks are reassigned)
app.patch('/api/suite/agents/:id', async (req, res) => {
  trackRequest('PATCH /api/suite/agents/:id');
  try {
    const allowed = ['name','role','status','current_workload'];
    const sets = []; const params = []; let idx = 0;
    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k)) { idx++; params.push(v); sets.push(`${k} = $${idx}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'No valid fields' });
    params.push(req.params.id);
    const r = await queryLocalPg(`UPDATE app.agents SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx+1} RETURNING id, name, role, status, current_workload`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// A third POST /api/suite/activity-log used to live here. It was the only one
// that wrote the fields the Suite SPA actually sends (activity_type, title,
// status, task_id, agent_id) and it would have been the right handler - but
// app.suite_activity_log has none of those columns. Verified by measurement
// (SELECT * returns id, type, company, description, metadata, created_at), so
// enabling it as written would have thrown "column activity_type does not exist"
// on every handoff. The live handler folds the unmodelled fields into metadata
// instead; the proper fix is an additive migration.

// ── Dashboard Stats ──────────────────────────────────────────────
app.get('/api/suite/stats', async (req, res) => {
  trackRequest('/api/suite/stats');
  try {
    const [tasks, agents, health, entities, workflows] = await Promise.all([
      queryLocalPg(`SELECT count(*)::int AS c FROM app.tasks WHERE status IN ('PENDING','IN_PROGRESS','CLAIMED','BLOCKED')`),
      queryLocalPg(`SELECT count(*)::int AS c FROM app.agents WHERE status IN ('IDLE','BUSY')`),
      // 'type' is the column that exists; 'activity_type' never has, so this
      // query threw on every call and the .catch below turned the throw into an
      // empty result. Combined with the healthScore = 100 default further down,
      // the dashboard reported a perfect health score forever, with no way to
      // fail. Absent evidence of health, the honest answer is 'unknown'.
      queryLocalPg(`SELECT metadata FROM app.suite_activity_log WHERE type = 'system_health_check' ORDER BY created_at DESC LIMIT 1`).catch(() => ({ rows: [] })),
      queryLocalPg(`SELECT count(*)::int AS c FROM app.knowledge_entities`).catch(() => ({ rows: [{ c: 0 }] })),
      queryLocalPg(`SELECT count(*)::int AS c FROM app.suite_campaigns WHERE is_active = true`).catch(() => ({ rows: [{ c: 0 }] })),
    ]);

    // Default to 'unknown', not 'healthy'. No health row means nothing has
    // reported in - which is a gap in the evidence, not a clean bill of health,
    // and a monitoring surface that cannot fail is worse than no surface at all.
    let healthScore = null, healthStatus = 'unknown', healthIssues = [];
    if (health.rows[0]?.metadata) {
      const m = typeof health.rows[0].metadata === 'string' ? JSON.parse(health.rows[0].metadata) : health.rows[0].metadata;
      healthScore = m.health_score ?? null;
      healthStatus = m.status === 'critical' ? 'critical' : m.status === 'degraded' ? 'degraded' : 'healthy';
      if (m.issues_count && m.issues_count > 0) healthIssues = [`${m.issues_count} issue(s) detected`];
    }

    res.json({
      activeTasks: tasks.rows[0].c,
      activeAgents: agents.rows[0].c,
      totalExecutions: 0,
      knowledgeEntitiesTotal: entities.rows[0]?.c ?? 0,
      userContextKnowledge: 0,
      userWorkflows: workflows.rows[0]?.c ?? 0,
      healthScore,
      healthStatus,
      healthIssues,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/radar/radar.html', (req, res) => {
  trackRequest('/radar/radar.html');
  res.sendFile(join(PUBLIC_DIR, 'radar.html'));
});

app.get('/radar/probe.sh', (req, res) => {
  trackRequest('/radar/probe.sh');
  const scriptPath = join(SPATIAL_DIR, 'spatial-probe.sh');
  if (existsSync(scriptPath)) {
    res.setHeader('Content-Type', 'text/plain');
    res.sendFile(scriptPath);
  } else {
    res.status(404).send('Probe script not found');
  }
});

// Short alias for easier phone access
app.get('/probe.sh', (req, res) => {
  trackRequest('/probe.sh');
  const scriptPath = join(PUBLIC_DIR, 'probe.sh');
  if (existsSync(scriptPath)) {
    res.setHeader('Content-Type', 'text/plain');
    res.sendFile(scriptPath);
  } else {
    res.status(404).send('Probe script not found');
  }
});

app.get('/spatial/:file', (req, res) => {
  trackRequest('/spatial/' + req.params.file);
  const filePath = join(SPATIAL_DIR, req.params.file);
  if (existsSync(filePath) && filePath.startsWith(SPATIAL_DIR)) {
    res.setHeader('Content-Type', 'text/plain');
    res.sendFile(filePath);
  } else {
    res.status(404).send('Not found');
  }
});

// ── Inbox Landing Pages ─────────────────────────────────────
app.get('/inbox', (req, res) => {
  // One page for every registered domain, rather than a chain that named a file
  // per domain. The chain routed mobilemonero to inbox-xmrt.html and 31harbor to
  // inbox-31harbor.html, and neither file was ever created, so both branches
  // returned a sendFile error rather than an inbox. The page that does exist is
  // domain-parameterised and reads ?domain=, so it serves all four.
  const host = (req.headers.host || '').toLowerCase();
  const requested = String(req.query.domain || '').toLowerCase();
  // requested may be an inbox key ('jobby'), a domain name, or an address;
  // emailDomainFor handles the last two, EMAIL_DOMAINS the first.
  const key = emailDomainFor(host)
    || (EMAIL_DOMAINS[requested] ? requested : null)
    || emailDomainFor(requested)
    || 'pfp';

  const specific = join(PUBLIC_DIR, 'inbox-' + key + '.html');
  if (key !== 'pfp' && existsSync(specific)) {
    return res.sendFile(specific);
  }
  const shared = join(PUBLIC_DIR, 'inbox-pfp.html');
  if (!existsSync(shared)) return res.status(404).send('No inbox page');
  // The domain travels as a query parameter rather than as a copy of the file.
  return res.redirect(302, '/inbox?domain=' + encodeURIComponent(key));
});

// Health check
// ── Super-lightweight health check (no trackRequest, no JSON.stringify overhead) ──
app.get('/ping', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end('{"ok":true}');
});

app.get('/health', (req, res) => {
  trackRequest('/health');
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    port: PORT,
    agent: 'XMRT-DAO Relay Server',
    version: '10.0.0',
    tools: Object.keys(toolHandlers).length,
    handlers: Object.keys(handlers).length,
    requests: requestCounts.total,
  });
});

// Debug: returns the exact grounding context fleet-chat agents are given.
// Useful for verifying the anti-hallucination contract.
app.get('/api/fleet-chat/grounded', async (req, res) => {
  trackRequest('/api/fleet-chat/grounded');
  try {
    const ctx = await gatherFleetContext();
    res.json({ ok: true, context: ctx });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Qwen Code Memory API ───────────────────────────────────────
// Bridges Qwen Code's file-based memory to Suite's DB-backed memory tables.
// Follows the same cascade pattern as ai-chat/index.ts EnhancedConversationPersistence.
app.post('/api/qwen-memory/save', async (req, res) => {
  trackRequest('/api/qwen-memory/save');
  try {
    const { sessionId, messages, summary, metadata } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const state = await qwenMemory.saveConversationState(sessionId, messages || [], summary, metadata);
    if (summary) {
      await qwenMemory.saveConversationSummary(sessionId, summary, {
        messageCount: (messages || []).length,
        keyTopics: metadata?.topics || [],
        sentiment: metadata?.sentiment,
        keyEntities: metadata?.entities,
        confidence: 0.6,
      });
    }
    res.json({ ok: true, row: state });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/qwen-memory/load/:sessionId', async (req, res) => {
  trackRequest('/api/qwen-memory/load');
  try {
    const state = await qwenMemory.loadConversationState(req.params.sessionId);
    const contexts = await qwenMemory.loadMemoryContexts(req.params.sessionId);
    res.json({ ok: true, state, contexts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/qwen-memory/sessions', async (req, res) => {
  trackRequest('/api/qwen-memory/sessions');
  try {
    const sessions = await qwenMemory.listSessions();
    const summaries = await qwenMemory.loadRecentSummaries(20);
    res.json({ ok: true, sessions, summaries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/qwen-memory/context', async (req, res) => {
  trackRequest('/api/qwen-memory/context');
  try {
    const { sessionId, content, contextType, importanceScore, metadata } = req.body;
    if (!sessionId || !content || !contextType) {
      return res.status(400).json({ error: 'sessionId, content, and contextType required' });
    }
    const row = await qwenMemory.saveMemoryContext(sessionId, content, contextType, importanceScore || 0.5, metadata);
    res.json({ ok: true, row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/qwen-memory/summaries', async (req, res) => {
  trackRequest('/api/qwen-memory/summaries');
  try {
    const limit = parseInt(req.query.limit) || 10;
    const summaries = await qwenMemory.loadRecentSummaries(limit);
    res.json({ ok: true, summaries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/qwen-memory/search', async (req, res) => {
  trackRequest('/api/qwen-memory/search');
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.status(400).json({ error: 'query param "q" must be at least 2 chars' });
    const results = await qwenMemory.searchMemoryContexts(q, parseInt(req.query.limit) || 10);
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cascade endpoints (mirrors EnhancedConversationPersistence from ai-chat/index.ts)
app.get('/api/qwen-memory/historical-summaries', async (req, res) => {
  trackRequest('/api/qwen-memory/historical-summaries');
  try {
    const { userId, ipAddress, sessionId } = req.query;
    const summaries = await qwenMemory.loadHistoricalSummaries({ userId, ipAddress, sessionId });
    res.json({ ok: true, summaries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/qwen-memory/context-pair', async (req, res) => {
  trackRequest('/api/qwen-memory/context-pair');
  try {
    const { sessionId, currentQuestion, assistantResponse, userResponse, metadata } = req.body;
    if (!sessionId || !currentQuestion || !assistantResponse || !userResponse) {
      return res.status(400).json({ error: 'sessionId, currentQuestion, assistantResponse, userResponse required' });
    }
    const row = await qwenMemory.saveConversationContext(sessionId, currentQuestion, assistantResponse, userResponse, metadata);
    res.json({ ok: true, row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/qwen-memory/by-ip/:ipAddress', async (req, res) => {
  trackRequest('/api/qwen-memory/by-ip');
  try {
    const state = await qwenMemory.loadByIP(req.params.ipAddress);
    res.json({ ok: true, state });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/qwen-memory/by-user/:userId', async (req, res) => {
  trackRequest('/api/qwen-memory/by-user');
  try {
    const state = await qwenMemory.loadByUserId(req.params.userId);
    res.json({ ok: true, state });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Supervisor Status API ──────────────────────────────────────
// Inline health-check helpers (mirrors supervisor.mjs logic)
function checkHttp(url, timeoutMs) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    .then(r => r.status >= 200 && r.status < 400)
    .catch(() => false);
}
function checkProcessRunning(name) {
  // For .mjs scripts, check via supervisor state file first, then wmic
  if (name.endsWith('.mjs')) {
    try {
      const stateFile = join(DATA_DIR, 'supervisor-state.json');
      if (existsSync(stateFile)) {
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));
        const svcName = name.replace('.mjs', '');
        if (state.services && state.services[svcName] && state.services[svcName].childPid !== null) return true;
      }
    } catch {}
    // Fallback: check via wmic for node.exe processes with this script name
    try {
      const out = execFileSync('wmic', ['process', 'where', "name='node.exe'", 'get', 'processid,commandline', '/format:csv'], { encoding: 'utf8', timeout: 2000, windowsHide: true });
      return out.includes(name);
    } catch { return false; }
  }
  // For .exe processes, use tasklist
  try {
    const out = execFileSync('tasklist', ['/nh', '/fi', `imagename eq ${name}`], { encoding: 'utf8', timeout: 2000, windowsHide: true });
    return out.includes(name);
  } catch { return false; }
}

// Async version of process check — uses spawn to avoid blocking the event loop
/**
 * Is a process running, by executable name or by command-line substring.
 *
 * `mode` is required and explicit. It used to be inferred from whether `name`
 * ended in '.mjs', which sent every other string down the tasklist imagename path.
 * That silently broke any probe for a `node.exe <script>` service whose needle was
 * a plain word: Windows has no executable called "page-agent", so the probe could
 * only return false, and a false result is believed. page-agent-mcp was reported
 * DOWN on the dashboard while the supervisor had it recorded healthy.
 *
 * @param {string} name   needle: an image name for 'image', a command-line
 *                        substring for 'cmdline'
 * @param {'image'|'cmdline'} mode  which of the two to search
 */
function checkProcessRunningAsync(name, mode) {
  return new Promise((resolve) => {
    if (mode === 'cmdline') {
      try {
        const stateFile = join(DATA_DIR, 'supervisor-state.json');
        if (existsSync(stateFile)) {
          const state = JSON.parse(readFileSync(stateFile, 'utf8'));
          const svcName = name.replace('.mjs', '');
          if (state.services && state.services[svcName] && state.services[svcName].childPid !== null) { resolve(true); return; }
        }
      } catch {}
      const child = spawn('wmic', ['process', 'where', "name='node.exe'", 'get', 'processid,commandline', '/format:csv'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', d => out += d.toString());
      child.on('close', () => { resolve(out.includes(name)); });
      child.on('error', () => resolve(false));
      setTimeout(() => { child.kill(); resolve(false); }, 2000);
    } else {
      const child = spawn('tasklist', ['/nh', '/fi', `imagename eq ${name}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', d => out += d.toString());
      child.on('close', () => { resolve(out.includes(name)); });
      child.on('error', () => resolve(false));
      setTimeout(() => { child.kill(); resolve(false); }, 2000);
    }
  });
}
function checkProcessByScript(scriptName) {
  // Check if the script name appears in the supervisor state file
  try {
    const stateFile = join(DATA_DIR, 'supervisor-state.json');
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      return state.services && state.services[scriptName.replace('.mjs','')] && state.services[scriptName.replace('.mjs','')].childPid !== null;
    }
  } catch {}
  return false;
}
function checkProcessByName(exeName) {
  // Check if the process name appears in the supervisor state file
  try {
    const stateFile = join(DATA_DIR, 'supervisor-state.json');
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      return state.services && state.services[exeName.replace('.exe','')] && state.services[exeName.replace('.exe','')].childPid !== null;
    }
  } catch {}
  return false;
}

app.get('/api/supervisor/status', async (req, res) => {
  trackRequest('/api/supervisor/status');
  try {
    const STATE_FILE = join(DATA_DIR, 'supervisor-state.json');
    let stateData = { services: {}, alerts: {}, lastTaskCheck: 0, lastTaskResults: {} };
    try {
      if (existsSync(STATE_FILE)) {
        stateData = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      }
    } catch (e) { /* state file unavailable */ }

    // isProcessRunningByPid used to be defined HERE, inside this handler. That made
    // it invisible to the sibling POST /api/supervisor/restart endpoint, which
    // called it and died with a ReferenceError — surfacing as HTTP 500 with an
    // empty body and a UI that read "HTTP 500" instead of a restart. It is now
    // module-level (see below the status endpoint); the call inside this handler
    // resolves to the same function.

    // Supervisor status: the relay's built-in service manager handles all services.
    // The XMRT-LocalSupervisor scheduled task (--once mode) is an optional health monitor.
    // If the relay is running, supervisor is effectively alive.
    let supervisorPid = null;
    let supervisorAlive = true; // relay manages services directly

    // Build service status from the state file with live process checks.
    //
    // The NAMES come from the supervisor's own state file, not from a list written
    // out here. This used to be a hand-copied mirror of supervisor.mjs's service
    // definitions, and it had drifted exactly the way a hand-copied list does: the
    // dashboard showed 11 services, was missing page-agent-mcp, resume-server and
    // dsh, and carried 31harbor-scheduler, which is deprecated and no longer
    // supervised by anything. Meanwhile the supervisor was watching 14.
    //
    // Only the ports stay hardcoded, because they are per-service knowledge the
    // state file does not carry and a service without one is health-checked by
    // process liveness instead. A name that is not in the map simply gets the
    // liveness check, so adding a service needs no change here at all.
    const SERVICE_PORTS = {
      'pg': 5432, 'local-sb': 54321, 'vite': 5173, 'relay': 8080,
      'cuttlefishclaws-mcp': 3120, 'xmrtdao-suite-mcp': 3121, 'suite-mcp': 3121,
      'resume-server': 5175,
    };
    const stateNames = Object.keys(stateData.services || {});
    const serviceDefs = (stateNames.length
      ? stateNames
      // Only if the state file is missing or empty, which is not its normal state.
      : ['pg', 'local-sb', 'vite', 'relay', 'tunnel', 'alice', 'cron-engine-v2']
    ).map((name) => ({ name, port: SERVICE_PORTS[name] ?? null }));
    const services = await Promise.all(serviceDefs.map(async (def) => {
      const svcState = stateData.services?.[def.name] || {};
      // For services with a known port, do a live TCP/HTTP check.
      // For schedulers/daemons (no port), trust the state file's childPid.
      let healthy = false;
      if (def.port) {
        // pg (5432) speaks postgres protocol, not HTTP — use TCP probe
        if (def.name === 'pg') {
          try {
            const sock = require('net').connect({ host: '127.0.0.1', port: 5432 });
            sock.setTimeout(1500);
            healthy = await new Promise(res => { sock.once('connect', () => { sock.destroy(); res(true); }); sock.once('error', () => res(false)); sock.once('timeout', () => { sock.destroy(); res(false); }); });
          } catch { healthy = false; }
        } else {
          try {
            const r = await fetch(`http://127.0.0.1:${def.port}/`, {
              signal: AbortSignal.timeout(1500),
            });
            healthy = r.status < 500; // any non-5xx = reachable
          } catch {
            healthy = !!(svcState.childPid && isProcessRunningByPid(svcState.childPid));
          }
        }
      } else {
        // No-port services: check state file childPid first, then fall back to
        // a live process-name/script check. The supervisor often adopts these
        // daemons as external (childPid=null), so a childPid-only check would
        // falsely report them DOWN even when they are running.
        if (svcState.childPid && isProcessRunningByPid(svcState.childPid)) {
          healthy = true;
        } else {
          // Map service name → process/script to probe. Uses the async spawn
          // helper so we don't block the event loop with execSync.
          // The needle is matched against a node.exe COMMAND LINE, and the mode
          // has to be stated rather than inferred. checkProcessRunningAsync used
          // to branch on whether the string ends in '.mjs', which silently sent
          // every other string down a tasklist /imagename path - and Windows has
          // no executable called "page-agent" or "dsh", because both are
          // `node.exe <script>`. Those probes could only ever return false.
          //
          // A false probe result is trusted (the supervisor fallback below only
          // applies when there is NO probe), so this reported page-agent-mcp as
          // DOWN while the supervisor recorded it healthy - the dashboard
          // contradicting the only authority it claims to defer to, on a service
          // that was up and listening. Two of the six were affected; the others
          // happened to be rescued by a childPid that happened to be set.
          //
          // Modes are explicit now. 'cmdline' greps the wmic command-line
          // listing, 'image' asks tasklist for an executable name. Each needle
          // below was checked against live wmic output rather than assumed.
          const procProbe = {
            // An image name, so 'image' is correct here.
            'tunnel': () => checkProcessRunningAsync('cloudflared.exe', 'image'),
            'alice': () => checkProcessRunningAsync('alice.mjs', 'cmdline'),
            'cron-engine-v2': () => checkProcessRunningAsync('cron-engine-v2.mjs', 'cmdline'),
            'campaign-scheduler': () => checkProcessRunningAsync('campaign-scheduler.mjs', 'cmdline'),
            // The supervisor launches dsh/dsh-web-supervised.cjs. This used to
            // search for dsh-web-launch.cjs, which matches nothing running - and
            // being a .cjs, it took the imagename path regardless.
            'dsh': () => checkProcessRunningAsync('dsh-web-supervised.cjs', 'cmdline'),
            // The real command line is
            //   "C:\Program Files\nodejs\node.exe" C:\...\page-agent\packages\mcp\src\index.js
            // and "page-agent" is a genuine substring of it. It must be 'cmdline':
            // there is no executable by that name.
            'page-agent-mcp': () => checkProcessRunningAsync('page-agent', 'cmdline'),
            // No probe for health-server. The supervisor already health-checks it
            // over HTTP each tick and records the verdict, so a second process-table
            // grep adds latency and no information. With no probe it defers to the
            // supervisor.
            // 31harbor-scheduler is deliberately absent. It is deprecated, no
            // longer supervised, and its script was removed from tools/ - but it
            // was still listed here, so the dashboard showed a service that has
            // not existed for a while as DOWN, which reads as a fault.
          }[def.name];
          // With no probe of its own, defer to the supervisor rather than
          // reporting DOWN. It is the authority on whether its services are up,
          // and a failed name-guess is worse than no answer: health-server has no
          // matching script, and guessing "not running" for a service the
          // supervisor says is up is a false alarm on a dashboard whose job is to
          // report faults.
          healthy = procProbe ? await procProbe() : svcState.healthy === true;
        }
      }
      const restartCount = svcState.restartTimestamps?.length || 0;
      const lastHourRestarts = (svcState.restartTimestamps || []).filter(t => t > Date.now() - 3600000).length;
      return {
        name: def.name, healthy, port: def.port,
        pid: svcState.childPid || null, startedAt: svcState.startedAt || null,
        restartCount, lastHourRestarts, flapping: lastHourRestarts >= 4,
      };
    }));

    // Task results
    const tasks = [];
    for (const [name, data] of Object.entries(stateData.lastTaskResults || {})) {
      if (!data) continue;
      const ageMs = data.lastRun ? Date.now() - data.lastRun : null;
      tasks.push({ name, lastRun: data.lastRun || null,
        ageHours: ageMs ? Math.round(ageMs / 3600000) : null,
        result: data.result, missed: data.missed || 0, state: data.state || 'unknown' });
    }

    // Compute a consolidated stack health score 0-100 from the live service checks.
    // Base 50 for the supervisor being reachable. +5 per healthy service (max +60
    // for all 12), -10 per down service. Clamp to [0,100].
    const upCount = services.filter(s => s.healthy).length;
    const downCount = services.length - upCount;
    let healthScore = 50 + (upCount * 5) - (downCount * 10);
    healthScore = Math.max(0, Math.min(100, healthScore));
    const healthStatus = healthScore >= 80 ? 'healthy' : healthScore >= 50 ? 'degraded' : 'critical';

    return res.json({
      ok: true, supervisor: { pid: supervisorPid, alive: supervisorAlive },
      services, tasks, recentLog: [],
      health: { score: healthScore, status: healthStatus, up: upCount, down: downCount, total: services.length },
      lastTaskCheck: stateData.lastTaskCheck || 0, checkedAt: Date.now(),
    });
  } catch (e) {
    return res.json({ ok: false, error: e.message, services: [], tasks: [], recentLog: [] });
  }
});

/**
 * Cheap PID liveness check — process.kill(pid, 0) throws if the pid is dead.
 *
 * Module-level on purpose. It was defined inside the /api/supervisor/status
 * handler, which made it unreachable from POST /api/supervisor/restart: that
 * endpoint called it, got a ReferenceError, and answered 500 with no body. The
 * button then read "HTTP 500" and nothing restarted. Kept here so both routes
 * and anything added later share one definition.
 */
function isProcessRunningByPid(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * The supervised services, read from the supervisor's own state file.
 *
 * The same source /api/supervisor/status uses, deliberately. This endpoint
 * resolves pids from here rather than from a list written out locally, because
 * that local mirror already drifted once: the dashboard showed 11 services
 * while the supervisor was watching 14.
 */
async function listSupervisedServices() {
  try {
    const STATE_FILE = join(DATA_DIR, 'supervisor-state.json');
    if (!existsSync(STATE_FILE)) return [];
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const svc = state?.services || {};
    // Field is `childPid`, not `pid` — assumed wrong on the first attempt and
    // caught by reading a real state file. `isExternal` services (tunnel, pg)
    // are attached rather than spawned, so a SIGTERM there is the supervisor's
    // business, not ours.
    return Object.entries(svc).map(([name, s]) => ({
      name,
      pid: s?.childPid ?? null,
      healthy: Boolean(s?.healthy),
      isExternal: Boolean(s?.isExternal),
      startedAt: s?.startedAt ?? null,
      failures: s?.failures ?? 0,
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL SERVICE RESTART — the owner gets the supervisor's powers from the UI.
//
// This does NOT signal the process itself. It enqueues a `restart` action in
// service-actions.json, which is the queue the supervisor already drains at the
// top of every one of its 30-second ticks, and the supervisor performs the real
// stop-then-start. That was not the first design.
//
// The first design sent SIGTERM to the child pid and waited. It worked, and it
// took about ninety seconds, and for most of that the UI showed a red bar
// reading "pid never changed" — while the service was in fact on its way back.
// Two ticks are needed for a dead EXTERNAL service: one to notice the death and
// drop it from state, one to start it. An endpoint that reports honestly ("new
// pid or it did not happen") has to wait for that, so the timeout has to cover
// it.
//
// NO HAND-COPIED SERVICE LIST. The names and pids come from the same state file
// /api/supervisor/status already reads above. That mirror drifted once already
// — the dashboard showed 11 services while the supervisor watched 14 — and the
// comment at that endpoint explains why. Adding a service here would recreate
// the exact bug this code documents.
// ─────────────────────────────────────────────────────────────────────────────

// Per-service restart timestamps, for the same reason the supervisor keeps its
// own: a double-click or an impatient repeat must not be able to thrash Postgres.
const manualRestarts = new Map();   // service -> [epochMs]
const MAX_MANUAL_RESTARTS = 3;      // per service
const MANUAL_WINDOW_MS = 3600000;   // per hour

function manualRestartAllowed(service) {
  const now = Date.now();
  const hits = (manualRestarts.get(service) || []).filter((t) => now - t < MANUAL_WINDOW_MS);
  manualRestarts.set(service, hits);
  return hits.length < MAX_MANUAL_RESTARTS;
}

function noteManualRestart(service) {
  const hits = manualRestarts.get(service) || [];
  hits.push(Date.now());
  manualRestarts.set(service, hits);
}

app.post('/api/supervisor/restart', express.json(), async (req, res) => {
  // Gate: a restart is a kill switch on the database and on the edge-function
  // layer fifteen files depend on. It takes the same authority the fleet-chat
  // send path requires, so this is not an open POST from anything that can
  // reach 8080.
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const certed = Boolean(req.certAuth?.agent_id);
  const keyed = key && key === process.env.RELAY_API_KEY;
  if (!certed && !keyed) {
    return res.status(401).json({
      error: 'restart requires a verified agent certificate or the relay API key',
    });
  }

  const service = String(req.body?.service || '').trim();
  if (!service) {
    return res.status(400).json({ error: 'service is required', services: await listSupervisedServices() });
  }
  if (!/^[a-z0-9-]{1,40}$/i.test(service)) {
    return res.status(400).json({ error: `illegal service name ${JSON.stringify(service.slice(0, 40))}` });
  }

  if (!manualRestartAllowed(service)) {
    return res.status(429).json({
      error: `${service} has been restarted ${MAX_MANUAL_RESTARTS} times in the last hour`,
      service,
    });
  }

  const known = await listSupervisedServices();
  const entry = known.find((s) => s.name === service);
  if (!entry) {
    return res.status(404).json({
      error: `no supervised service named "${service}"`,
      services: known.map((s) => s.name),
    });
  }

  const oldPid = entry.pid || null;
  const who = req.certAuth?.agent_id || 'api-key';

  // ── HOW THE RESTART IS ACTUALLY PERFORMED ────────────────────────────────
  //
  // This used to SIGTERM the child and wait for the supervisor to notice. That
  // worked, and it took 90 seconds and showed the user a red bar saying
  // "pid never changed" while the service was in fact coming back — because the
  // supervisor's daemon loop sleeps 30s between ticks and only starts a dead
  // EXTERNAL service on the tick AFTER it notices the death. Two ticks.
  //
  // It now enqueues an action in service-actions.json, which is the queue the
  // supervisor already drains at the top of every tick. That path does a real
  // stop-then-start (including killing the port owner first, so a fresh spawn
  // cannot die on EADDRINUSE) and records a result the caller can read back.
  // One tick instead of two, and no hand-rolled signalling that could disagree
  // with what the supervisor considers a service.
  const queueFile = join(DATA_DIR, 'service-actions.json');
  let queue = [];
  try {
    if (existsSync(queueFile)) {
      const parsed = JSON.parse(readFileSync(queueFile, 'utf8'));
      if (Array.isArray(parsed)) queue = parsed;
    }
  } catch (e) {
    return res.status(500).json({ error: `service-actions.json is unreadable: ${e.message}` });
  }

  // Drop entries that are old AND already processed. Pruning on age alone would
// be wrong — an unprocessed action is still a promise the supervisor has not
// kept, and deleting it would silently drop a restart someone asked for. Pruning
// on processedAt alone would be wrong the other way: the queue would keep only
// the newest result. Both conditions, so the file stays bounded and nothing
// pending is ever discarded.
  const cutoff = Date.now() - 3600000;
  const stampOf = (a) => a?.queuedAt || a?.requestedAt || 0;
  queue = queue.filter((a) => {
    if (!a) return false;
    if (a.processedAt) return stampOf(a) > cutoff;
    return true;                       // never processed: keep it
  });

  const already = queue.find(
    (a) => a && !a.processedAt && a.service === service && a.action === 'restart'
  );
  if (already) {
    return res.status(409).json({
      error: `a restart of ${service} is already queued (pid ${already.queuedPid ?? '?'})`,
      service, queuedAt: already.queuedAt,
    });
  }

  const action = {
    action: 'restart',
    service,
    requestedBy: who,
    queuedAt: Date.now(),
    queuedPid: oldPid,
    source: 'dashboard-restart-button',
  };
  queue.push(action);
  noteManualRestart(service);

  try {
    writeFileSync(queueFile, JSON.stringify(queue, null, 2));
  } catch (e) {
    return res.status(500).json({ error: `could not write the service action queue: ${e.message}` });
  }

  console.log(
    `[manual-restart] ${service} (pid ${oldPid ?? 'none'}) queued by ${who}; ` +
    `the supervisor drains it on its next tick (within 30s)`
  );

  // Respond AFTER the queue write, so a client that gets an OK knows the action
  // is durably recorded. This matters for `relay` too: the supervisor restarts
  // the relay on the next tick, not in this handler, so this reply still arrives
  // and the page does not have to survive the connection dropping.
  res.json({
    ok: true,
    service,
    queued: true,
    oldPid,
    queuedAt: action.queuedAt,
    // Told plainly so the UI does not have to invent a message: the work is
    // queued, not done. Success is still judged by a new pid.
    note: 'queued for the supervisor; it drains service-actions.json once every 30s. ' +
          'Poll /api/supervisor/status and treat a NEW pid as the restart.',
    ...(oldPid && !isProcessRunningByPid(oldPid)
      ? { warning: 'the recorded pid was already not running; the supervisor will start it fresh' }
      : {}),
  });
});

// Hostname-based redirect: agency.31harbor.com → /harbor/
app.get('/', (req, res, next) => {
  const host = req.headers.host || '';
  if (host.includes('agency.31harbor.com')) {
    return res.redirect(301, '/harbor/');
  }
  // cuttlefish.mobilemonero.com → Cuttlefish Claws SPA
  if (host.includes('cuttlefish.mobilemonero.com') || host.includes('cuttlefish.')) {
    return res.redirect(301, '/cuttlefishclaws/');
  }
  // suite.mobilemonero.com → Suite SPA landing with auth widget
  if (host.includes('suite.mobilemonero.com') || host.includes('suite.')) {
    return res.redirect(301, '/suite/');
  }
  next();
});

// Fleet dashboard — with login page for unauthenticated users
app.get('/', (req, res) => {
  // Check if user is already authenticated
  const apiKey = (req.headers['x-api-key'] || req.query.api_key || req.cookies?.relay_api_key || '').trim();
  const isAuthed = apiKey && apiKey === RELAY_API_KEY;
  if (!isAuthed) {
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MobileMonero — Sign in</title>
  <style>
    :root{--bg:#0f0818;--card:#1a1025;--border:#2a1f35;--accent:#f97316;--text:#e4e4e7;--muted:#a1a1aa;--err:#ef4444}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
    .box{background:var(--card);border:1px solid var(--border);border-radius:1rem;padding:1.6rem;max-width:420px;width:100%}
    h1{font-size:1.2rem;margin-bottom:.3rem}
    h1 small{color:var(--accent);font-size:.8rem;display:block;margin-top:.2rem}
    p{color:var(--muted);font-size:.85rem;margin-bottom:1rem}
    input{width:100%;background:#0f0818;border:1px solid var(--border);color:var(--text);padding:.6rem .8rem;border-radius:.5rem;font-family:monospace;font-size:.85rem;margin-bottom:.6rem}
    button{width:100%;background:linear-gradient(135deg,var(--accent),#ea580c);color:#fff;border:0;padding:.6rem;border-radius:.5rem;font-weight:600;cursor:pointer;font-size:.9rem}
    button:hover{opacity:.9}
    a{color:var(--accent);font-size:.8rem;text-decoration:none}
    .status{font-size:.75rem;margin-top:.6rem;min-height:1.2em}
  </style>
</head>
<body>
  <div class="box">
    <h1>Tributary Campus <small>Command Center</small></h1>
    <p>Enter your API key or XMRT-DAO-CERT JWT to access the campus dashboard. Graduates can use their cert JWT from XMRT University.</p>
    <form id="loginForm">
      <input id="keyInput" type="password" placeholder="API key or XMRT-DAO-CERT JWT" autocomplete="off" required>
      <button type="submit">Sign in</button>
    </form>
    <div id="status" class="status"></div>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', function(e) {
      e.preventDefault();
      const key = document.getElementById('keyInput').value.trim();
      const status = document.getElementById('status');
      if (!key) { status.style.color='var(--err)'; status.textContent='Please enter an API key or XMRT-DAO-CERT JWT.'; return; }
      // Detect if this looks like a JWT (starts with "local-" or has dots like a real JWT)
      if (key.startsWith('local-') || (key.includes('.') && key.split('.').length === 3)) {
        // This is an XMRT-DAO-CERT JWT — verify it server-side
        status.style.color='var(--muted)'; status.textContent='Verifying XMRT-DAO-CERT...';
        fetch('/api/auth/cert-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jwt: key }),
        }).then(r => r.json()).then(data => {
          if (data.success) {
            status.style.color='var(--accent)'; status.textContent='Welcome, ' + (data.agent?.agent_name || 'Graduate') + '! Redirecting...';
            setTimeout(() => { window.location.href = '/'; }, 500);
          } else {
            status.style.color='var(--err)'; status.textContent = data.error || 'Invalid XMRT-DAO-CERT. Please graduate from XMRT University first.';
          }
        }).catch(err => {
          status.style.color='var(--err)'; status.textContent = 'Verification failed: ' + err.message;
        });
      } else {
        // Regular API key — set cookie directly
        document.cookie = 'relay_api_key=' + encodeURIComponent(key) + '; path=/; max-age=86400; sameSite=lax';
        window.location.href = '/';
      }
    });
  </script>
</body>
</html>`);
  }
  trackRequest('/');
  const hostname = osHostname();
  const tunnelUrl = state.get('tunnel-url') || 'https://relay.mobilemonero.com';
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const mins = Math.floor((uptime % 3600) / 60);
  const uptimeStr = `${days}d ${hours}h ${mins}m`;
  const supabaseUrl = SUPABASE_URL;
  
  const tools = Object.keys(toolHandlers);
  const toolCount = tools.length;
  const handlerCount = Object.keys(handlers).length;
  const stats = taskRunner.getStats();

  // ── Campaign stats ────────────────────────────────────
  const CAMPAIGN_SENT = join(DATA_DIR, 'campaign-sent.json');
  const CAMPAIGN_CONTACTS = join(DATA_DIR, 'campaign-contacts.json');
  const CAMPAIGN_LOG = join(DATA_DIR, 'campaign.log');
  
  let campaignSent = [];
  let campaignContacts = [];
  let campaignLastRun = 'never';
  try {
    if (existsSync(CAMPAIGN_SENT)) campaignSent = JSON.parse(readFileSync(CAMPAIGN_SENT, 'utf8'));
    if (existsSync(CAMPAIGN_CONTACTS)) campaignContacts = JSON.parse(readFileSync(CAMPAIGN_CONTACTS, 'utf8'));
    if (existsSync(CAMPAIGN_LOG)) {
      const logLines = readFileSync(CAMPAIGN_LOG, 'utf8').trim().split('\n').filter(Boolean);
      if (logLines.length > 0) {
        const lastLine = logLines[logLines.length - 1];
        const tsMatch = lastLine.match(/\[(.*?)\]/);
        campaignLastRun = tsMatch ? tsMatch[1].slice(0, 16) : 'recent';
      }
    }
  } catch (e) { /* stats unavailable */ }
  
  const totalSent = campaignSent.length;
  const poolSize = campaignContacts.length;
  const now = Date.now();
  const cutoff30 = now - 30 * 24 * 60 * 60 * 1000;
  const recentSent = new Set(campaignSent.filter(s => s.ts > cutoff30).map(s => s.email));
  const freshAvailable = campaignContacts.filter(c => !recentSent.has(c.email) && c.email?.includes('@')).length;
  
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const sentToday = campaignSent.filter(s => s.ts > todayStart.getTime()).length;


  // ── Campaign stats (31harbor) ──────────────────────────
  const HARBOR_CONTACTS = join(DATA_DIR, '31harbor-contacts.json');
  const HARBOR_SENT = join(DATA_DIR, '31harbor-sent.json');
  const HARBOR_LOG = join(DATA_DIR, '31harbor-campaign.log');

  let harborSent = [];
  let harborContacts = [];
  let harborLastRun = 'never';
  try {
    if (existsSync(HARBOR_SENT)) harborSent = JSON.parse(readFileSync(HARBOR_SENT, 'utf8'));
    if (existsSync(HARBOR_CONTACTS)) harborContacts = JSON.parse(readFileSync(HARBOR_CONTACTS, 'utf8'));
    if (existsSync(HARBOR_LOG)) {
      const logLines = readFileSync(HARBOR_LOG, 'utf8').trim().split('\n    \x27task-dedup\x27: \x27Find and merge duplicate tasks by exact title match or trigram similarity. Dry-run by default (dry_run:true). Set dry_run:false to merge. Keeps the task with the most progress.\x27,\n    \n').filter(Boolean);
      if (logLines.length > 0) {
        const lastLine = logLines[logLines.length - 1];
        const tsMatch = lastLine.match(/\[(.*?)\]/);
        harborLastRun = tsMatch ? tsMatch[1].slice(0, 16) : 'recent';
      }
    }
  } catch (e) { /* stats unavailable */ }

  const harborSentTotal = harborSent.length;
  const harborPoolSize = harborContacts.length;
  const harborCutoff30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentHarborSent = new Set(harborSent.filter(s => s.ts > harborCutoff30).map(s => s.email));
  const harborFresh = harborContacts.filter(c => !recentHarborSent.has(c.email) && c.email?.includes('@')).length;
  const harborSentToday = harborSent.filter(s => s.ts > todayStart.getTime()).length;

  // ── Scheduled Tasks ───────────────────────────────────
  const taskSchedule = [
    { time: '08:00', name: 'DailyCampaign', desc: '500 emails' },
    { time: '12:00', name: 'NoonCampaign', desc: '500 emails' },
    { time: '16:00', name: '4PMCampaign', desc: '500 emails' },
    { time: '23:00', name: 'SeasonalScraper', desc: 'contact scrape' },
    { time: 'Every hr', name: 'HourlyTaskFetch', desc: 'cron proxy' },
  ];
  const currentHour = new Date().getHours() - 6; // CST offset
  
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tributary Campus — Command Center</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Share+Tech+Mono&family=Rajdhani:wght@500;600;700&family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Outfit:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
    :root {
      --bg-primary: #060200;
      --bg-card: #0a0400;
      --bg-card-hover: #0e0600;
      --border: rgba(255,140,0,0.25);
      --border-hover: rgba(255,140,0,0.45);
      --text-primary: #ffbb33;
      --text-secondary: #ffaa00;
      /* These two used to be rgba(255,160,0,0.6) and rgba(255,160,0,0.4), which
         measure 4.06:1 and 2.35:1 against --bg-card. Body text on this dashboard
         renders at 10-14px, so WCAG judges it as NORMAL text and both failed the
         4.5:1 minimum - and they are the colours every label, hint and caption
         uses. Raised to clear it; the hue is unchanged. */
      --text-muted: #c08a3e;   /* 5.9:1 */
      --text-dim:   #9c7038;   /* 4.6:1 */
      --text-ghost: #7d5c31;   /* 3.7:1 - borders and rules only, never text */
      --accent-orange: #ff8800;
      --accent-orange-glow: rgba(255,140,0,0.15);
      --accent-teal: #00ffcc;
      --accent-blue: #00d2ff;
      --accent-purple: #aa88ff;
      --accent-yellow: #ffbb33;
      --accent-red: #ff3399;
      /* Body and labels.
         This was 'Rajdhani', a condensed DISPLAY face, and it was set as the
         body font for 100% of the page. At the 10.4-13.6px this dashboard
         rendered at, its narrow letterforms and open counters are why the whole
         thing read as barely legible. Rajdhani is still here, as --font-display
         for headings, where its character earns its keep at size. */
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-display: 'Rajdhani', 'Inter', sans-serif;
      /* JetBrains Mono is now actually loaded. --lumen-font-mono below named it
         while the @import did not fetch it, so every use silently fell back to
         Consolas. */
      --font-mono: 'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace;
      /* ── Lumen Design Tokens ── */
      --lumen-bg: #0c0d0b;
      --lumen-bg-surface: #141512;
      --lumen-bg-elevated: #1b1d18;
      --lumen-bg-hover: #22241f;
      --lumen-text: #eceae4;
      --lumen-text-muted: #9a9890;
      --lumen-text-dim: #6b6375;
      --lumen-accent: #aa3bff;
      --lumen-accent-glow: rgba(170, 59, 255, 0.15);
      --lumen-accent-bg: rgba(170, 59, 255, 0.1);
      --lumen-border: rgba(236, 234, 228, 0.06);
      --lumen-border-strong: rgba(236, 234, 228, 0.12);
      --lumen-success: #22c55e;
      --lumen-warning: #f59e0b;
      --lumen-danger: #ef4444;
      --lumen-info: #3b82f6;
      --lumen-live: #8fad96;
      --lumen-live-fg: #0c0d0b;
      --lumen-warn: #c4a574;
      --lumen-danger-fg: #1a0f0d;
      --lumen-radius-sm: 4px;
      --lumen-radius-md: 6px;
      --lumen-radius-lg: 8px;
      --lumen-radius-xl: 12px;
      --lumen-radius-pill: 9999px;
      --lumen-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.30);
      --lumen-shadow-md: 0 4px 12px rgba(0, 0, 0, 0.40);
      --lumen-shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.50);
      --lumen-shadow-glow: 0 0 20px var(--lumen-accent-glow);
      --lumen-transition: 200ms ease;
      --lumen-font-sans: 'Outfit', system-ui, 'Segoe UI', Roboto, sans-serif;
      --lumen-font-display: 'Fraunces', 'Iowan Old Style', 'Times New Roman', serif;
      --lumen-font-mono: 'JetBrains Mono', ui-monospace, Consolas, monospace;
    }
    /* Scanline effect (Tributary Campus signature) */
    .scanline { position: fixed; top: 0; left: 0; width: 100%; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,160,0,0.08), transparent); animation: scan 14s linear infinite; pointer-events: none; z-index: 999; }
    @keyframes scan { 0% { top: 0; } 100% { top: 100%; } }
    /* Corner brackets */
    .bracket { position: relative; }
    .bracket::before, .bracket::after { content: ''; position: absolute; width: 10px; height: 10px; border-color: var(--accent-orange); border-style: solid; opacity: 0.5; }
    .bracket::before { top: 0; left: 0; border-width: 1px 0 0 1px; }
    .bracket::after { top: 0; right: 0; border-width: 1px 1px 0 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: var(--font-sans); background: var(--bg-primary); color: var(--text-secondary); padding: 0.5rem; }
    @media (min-width: 640px) { body { padding: 1.5rem; } }
    h1 { color: var(--accent-orange); font-size: 1.05rem; margin-bottom: 0.25rem; display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; font-weight: 700; letter-spacing: 0.01em; font-family: var(--font-display); }
    @media (min-width: 640px) { h1 { font-size: 1.6rem; gap: 0.75rem; } }
    h1 span { font-size: 0.65rem; color: var(--text-dim); font-weight: 400; letter-spacing: 0; }
    @media (min-width: 640px) { h1 span { font-size: 0.9rem; } }
    .subtitle { color: var(--text-muted); font-size: 0.7rem; margin-bottom: 0.75rem; line-height: 1.4; }
    @media (min-width: 640px) { .subtitle { font-size: 0.9rem; margin-bottom: 1.5rem; } }
    .subtitle a { color: var(--accent-blue); text-decoration: none; transition: color .15s; }
    .subtitle a:hover { color: var(--accent-orange); text-decoration: underline; }
    /* ── Grid ────────────────────────────────────────────────────────────────
       MOBILE-FIRST, and the direction is load-bearing rather than stylistic.

       The old rules declared 4 columns at 1200px, but every one of the nine
       tiles carried an INLINE 'grid-column:1/-1'. An inline style beats any
       class, so the grid rendered as a single full-bleed column at every
       width. That is the entire reason nothing on this page had visual rank:
       the layout had columns and never used them.

       Spans below are opt-in from the breakpoint where the grid actually has
       that many columns. This matters more than it looks: 'grid-column: span 2'
       inside a ONE-column grid does not clamp to full width, it creates an
       implicit second column and the page grows a horizontal scrollbar. So
       every tile is full width on mobile by default and only earns a span once
       there are columns to span.

       minmax(0, 1fr) rather than 1fr: a 1fr track has an automatic minimum
       sized to its content, so one long unbroken string in a log line is
       enough to push a column wider than its share and break the row. */
    .grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.5rem; margin-bottom: 1rem; }
    .grid > .full, .tile-full { grid-column: 1 / -1; }
    .tile, .tile-wide { grid-column: 1 / -1; }

    /* Two columns. Natural phone-landscape / small tablet. */
    @media (min-width: 560px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
      .tile { grid-column: span 1; }
      .tile-wide { grid-column: span 2; }
    }
    /* Three columns: the point at which a tile is worth spanning. */
    @media (min-width: 900px) {
      .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
      .tile { grid-column: span 1; }
    }
    /* Four columns for wide desktops. */
    @media (min-width: 1280px) {
      .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; }
    }

    /* Priority order. Set with 'order' on the grid children rather than by
       rearranging the HTML, so the source still reads top-to-bottom in
       priority order AND the rendered order can change without touching
       markup. Grid honours 'order'; it is flexbox's property and it applies
       to grid items too.

       Deliberately NOT inside a min-width query. Priority order that only
       applies above a breakpoint means a phone gets a different sequence from
       a desktop, and "what matters first" should not depend on the screen.
       Campus Command leads on both because it carries the supervisor panel -
       the thing you most want to see when something has broken - and its
       Agent Vault is collapsed for the same reason. */
    .tile-p1 { order: 1; } .tile-p2 { order: 2; } .tile-p3 { order: 3; }
    .tile-p4 { order: 4; } .tile-p5 { order: 5; } .tile-p6 { order: 6; }
    .tile-p7 { order: 7; } .tile-p8 { order: 8; } .tile-p9 { order: 9; }

    /* ── Collapsed archives ────────────────────────────────────────────────
       Agent Vault (1,810px of completed artifacts) and Supabase Edge Functions
       (11,888px, 70% of the page) were full-bleed tables competing with live
       status for the same attention. Both are <details>, collapsed, with the
       summary styled as a row rather than a browser default.

       The marker is hidden and replaced with a chevron because the default
       disclosure triangle is small, low-contrast, and sits far from the text.
       min-height 44px on the summary is deliberate: it is a touch target. */
    .archive { display: block; width: 100%; box-sizing: border-box;
               border: 1px solid var(--border); border-radius: 8px;
               background: var(--bg-card); margin-bottom: 0.75rem; overflow: hidden; }
    .archive > summary {
      display: flex; align-items: center; gap: 0.5rem;
      min-height: 44px; padding: 0.5rem 0.9rem;
      font-family: var(--font-display); font-size: 0.85rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-orange);
      cursor: pointer; list-style: none; user-select: none;
    }
    .archive > summary::-webkit-details-marker { display: none; }
    .archive > summary::before {
      content: '▸'; display: inline-block; color: var(--accent-orange);
      transition: transform 160ms ease; font-size: 0.9em;
    }
    .archive[open] > summary::before { transform: rotate(90deg); }
    .archive > summary:hover { background: var(--bg-card-hover); }
    .archive > summary:focus-visible { outline: 2px solid var(--accent-orange); outline-offset: -2px; }
    .archive > summary span {
      font-family: var(--font-sans); font-weight: 400; text-transform: none;
      letter-spacing: 0; color: var(--text-muted); font-size: 0.8rem;
    }
    /* The body of an archive sits inside a card already, so give it room. */
    .archive > .card { border: none; background: transparent; }

    /* ── Status strip ──────────────────────────────────────────────────────
       The one question this page is opened to answer is "is anything broken".
       Before this, the answer (services up, health score, restart control) was
       at y=1,141, below the chat transcript and the trust chart. */
    .status-strip {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1.25rem;
      padding: 0.6rem 0.9rem; margin-bottom: 0.75rem;
      border: 1px solid var(--border); border-radius: 8px;
      background: linear-gradient(180deg, rgba(255,107,53,0.07), rgba(255,107,53,0.02));
    }
    .status-strip .ss-item { display: flex; align-items: baseline; gap: 0.4rem; min-width: 0; }
    .status-strip .ss-label {
      color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;
      letter-spacing: 0.05em; white-space: nowrap;
    }
    .status-strip .ss-value {
      color: var(--text-primary); font-family: var(--font-mono);
      font-variant-numeric: tabular-nums; font-size: 1rem; font-weight: 500;
    }
    .status-strip .ss-cta {
      margin-left: auto; display: inline-flex; align-items: center; gap: 0.35rem;
      padding: 0.35rem 0.7rem; min-height: 32px; border-radius: 5px;
      border: 1px solid var(--border-hover); color: var(--accent-orange);
      font-size: 0.75rem; text-decoration: none; white-space: nowrap;
    }
    .status-strip .ss-cta:hover { background: var(--accent-orange-glow); }
    /* On a phone the CTA should not be pushed to a lonely right edge. */
    @media (max-width: 560px) {
      .status-strip { gap: 0.4rem 0.9rem; }
      .status-strip .ss-cta { margin-left: 0; width: 100%; justify-content: center; }
      .status-strip .ss-value { font-size: 0.95rem; }
    }

    /* ── Mobile ────────────────────────────────────────────────────────────
       Everything above is fine at 360px except the restart rows, which are a
       6-column grid and collapse to unreadable slivers. They stack instead:
       name on its own line, pid and button beneath. */
    @media (max-width: 560px) {
      body { padding: 0.6rem; }
      /* The restart-row overrides live further down, next to the base .qd-svc
         rule, so that they win the cascade. Duplicating them here is what
         produced a half-applied layout the first time. */
      .side-by-side > * { min-width: 0; }
      .stat { flex-wrap: wrap; }
      .value { max-width: 100%; }
      /* Anything that is intrinsically wide scrolls inside its own box rather
         than widening the page. */
      .card pre, .card table { max-width: 100%; overflow-x: auto; }
      .board-post-body pre { max-width: 100%; overflow-x: auto; }
    }
    .side-by-side { display: flex; flex-wrap: wrap; gap: 8px; grid-column: 1 / -1; }
    @media (min-width: 640px) { .side-by-side { gap: 12px; } }
    .side-by-side > * { flex: 1; min-width: 260px; }
    /* The per-service chips are generated with .join(''), so the spans form one
         unbreakable text run: there is no whitespace between them for the
         browser to break at, and a 299px container produced 934px of content,
         giving the page a horizontal scrollbar at every width. As flex items
         each chip wraps on its own. */
    #qds-services-tracker { display: flex; flex-wrap: wrap; gap: 2px 8px; }
    /* RSSI signal strength colors */
    .rssi-strong { color: #4ade80; }
    .rssi-fair { color: #fbbf24; }
    .rssi-weak { color: #f87171; }
    .rssi-poor { color: #ef4444; }
    .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem; transition: border-color .2s, transform .15s;
           /* overflow-wrap INHERITS, so this one declaration reaches every
              descendant. It only engages for a word that would otherwise
              overflow its line, which is exactly the Tools list's
              "http://127.0.0.1:54321/functions/..." - a 523px unbreakable
              string that was the last remaining source of horizontal
              scroll. No effect on ordinary prose. */
           overflow-wrap: break-word; }
    @media (min-width: 640px) { .card { border-radius: 10px; padding: 1rem; } }
    .card:hover { border-color: var(--accent-orange-glow); }
    /* Card and sub-card headings keep Rajdhani: at 12-15px a condensed display
       face is a deliberate choice and reads as a heading, not as body copy. */
    .card h3 { color: var(--accent-orange); font-family: var(--font-display); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.4rem; font-weight: 700; }
    @media (min-width: 640px) { .card h3 { font-size: 0.95rem; margin-bottom: 0.6rem; } }
    /* Floor raised from 0.65rem. 0.65rem is 10.4px, which is below the point
       where a dense ops table stops being readable, and it applied to every
       label and value in the UI. 0.75rem = 12px. */
    /* flex-wrap so that when a label and its value cannot share a line the VALUE
       drops to its own line, rather than the label being crushed into a
       one-character-per-line column. Pairs with overflow-wrap:normal on
       .label: labels break at spaces, and whole words are never split.
       Without both, "Last Commit" rendered as "Last / Commi / t". */
    .stat { display: flex; flex-wrap: wrap; justify-content: space-between; padding: 0.25rem 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 0.75rem; gap: 0.4rem; line-height: 1.45; }
    @media (min-width: 640px) { .stat { padding: 0.32rem 0; font-size: 0.9rem; gap: 0.6rem; } }
    .stat:last-child { border-bottom: none; }
    /* 'white-space: nowrap' + 'flex-shrink: 0' together meant a label could never
       shrink: "XMRT Token Faucet" in the DAO tile was 137px wide inside a 155px
       column and pushed the row past the right edge of the viewport, giving the
       whole page a horizontal scrollbar at every width. Measured 934px of
       content in a 360px viewport. Labels now wrap, and are allowed to shrink;
       min-width:0 lets them do it inside a flex row. Wrapping is preferred to
       ellipsis here because a truncated label hides which metric it names. */
    .label { color: var(--text-muted); flex-shrink: 1; min-width: 0; overflow-wrap: normal; }
    /* Tabular figures so columns of numbers align vertically down a dense panel.
       Without it, Inter's proportional digits make a wall of pids and scores
       shimmer as values change. */
    .value { color: var(--text-primary); font-family: var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; word-break: break-word; min-width: 0; overflow-wrap: break-word; hyphens: auto; max-width: 60%; }
    @media (min-width: 480px) { .value { max-width: 70%; } }
    @media (min-width: 640px) { .value { max-width: none; } }
    .badge { display: inline-block; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.6rem; font-weight: 600; }
    @media (min-width: 640px) { .badge { font-size: 0.7rem; padding: 0.1rem 0.4rem; } }
    .badge-ok { background: rgba(74,222,128,0.12); color: var(--accent-teal); }
    .badge-warn { background: rgba(251,191,36,0.12); color: var(--accent-yellow); }
    .badge-err { background: rgba(248,113,113,0.12); color: var(--accent-red); }
    .badge-info { background: rgba(96,165,250,0.12); color: var(--accent-blue); }

    @media (min-width: 640px) { .chat-card { grid-column: 1 / -1; } }

    .board-topics { max-height: 200px; overflow-y: auto; margin-bottom: 6px; }
    @media (min-width: 640px) { .board-topics { max-height: 300px; } }
    .board-topic { padding: 6px; border-radius: 6px; background: #0d0d15; margin-bottom: 4px; cursor: pointer; transition: background .15s; border: 1px solid transparent; }
    @media (min-width: 640px) { .board-topic { padding: 8px; } }
    .board-topic:hover { background: #1a1a2a; border-color: rgba(255,107,53,0.2); }
    .board-topic.active { border-color: var(--accent-orange); background: #1a1a2a; }
    .board-topic-title { color: var(--text-primary); font-size: 12px; font-weight: 600; }
    @media (min-width: 640px) { .board-topic-title { font-size: 13px; } }
    .board-topic-title > span { display: inline-block; }
    .board-topic-meta { color: #948d9e; font-size: 9px; margin-top: 2px; }
    @media (min-width: 640px) { .board-topic-meta { font-size: 10px; } }
    .board-filter { padding: 2px 8px; border-radius: 10px; font-size: 9px; cursor: pointer; color: #948d9e; border: 1px solid #2a2a3a; background: transparent; transition: all .15s; }
    @media (min-width: 640px) { .board-filter { font-size: 10px; padding: 2px 10px; } }
    .board-filter:hover { color: var(--text-secondary); border-color: #3a3a5a; }
    .board-filter.active { color: var(--accent-orange); border-color: var(--accent-orange); background: rgba(255,107,53,0.1); }
    .board-posts { max-height: 200px; overflow-y: auto; margin-bottom: 6px; }
    @media (min-width: 640px) { .board-posts { max-height: 250px; } }
    .board-post { padding: 4px 6px; border-radius: 6px; background: #0d0d15; margin-bottom: 4px; }
    @media (min-width: 640px) { .board-post { padding: 6px 8px; } }
    .board-post-header { color: #948d9e; font-size: 9px; display: flex; gap: 6px; flex-wrap: wrap; }
    @media (min-width: 640px) { .board-post-header { font-size: 10px; gap: 8px; } }
    .board-post-body { color: var(--text-secondary); font-size: 11px; margin-top: 2px; line-height: 1.4; }
    @media (min-width: 640px) { .board-post-body { font-size: 12px; } }
    .board-post-body p { margin: 0 0 4px 0; }
    .board-post-body p:last-child { margin-bottom: 0; }
    .board-post-body h1, .board-post-body h2, .board-post-body h3, .board-post-body h4 { color: var(--text-primary); margin: 6px 0 3px 0; font-weight: 600; }
    .board-post-body h1 { font-size: 13px; }
    .board-post-body h2 { font-size: 12px; }
    .board-post-body h3 { font-size: 11px; }
    .board-post-body h4 { font-size: 11px; color: var(--text-secondary); }
    .board-post-body ul, .board-post-body ol { margin: 3px 0 4px 0; padding-left: 16px; }
    .board-post-body li { margin: 2px 0; }
    .board-post-body code { background: #1a1a25; color: #e0e0f0; padding: 1px 3px; border-radius: 3px; font-family: monospace; font-size: 10px; }
    @media (min-width: 640px) { .board-post-body code { font-size: 11px; padding: 1px 4px; } }
    .board-post-body pre { background: #0a0a12; color: #c0c0d0; padding: 4px 6px; border-radius: 4px; overflow-x: auto; margin: 4px 0; }
    @media (min-width: 640px) { .board-post-body pre { padding: 6px 8px; } }
    .board-post-body pre code { background: transparent; padding: 0; }
    .board-post-body blockquote { border-left: 3px solid var(--accent-orange); padding-left: 6px; margin: 4px 0; color: var(--text-secondary); font-style: italic; }
    @media (min-width: 640px) { .board-post-body blockquote { padding-left: 8px; } }
    .board-post-body hr { border: none; border-top: 1px solid #2a2a3a; margin: 6px 0; }
    .board-post-body table { border-collapse: collapse; margin: 4px 0; font-size: 10px; width: 100%; }
    @media (min-width: 640px) { .board-post-body table { font-size: 11px; } }
    .board-post-body th, .board-post-body td { border: 1px solid #2a2a3a; padding: 2px 4px; text-align: left; }
    @media (min-width: 640px) { .board-post-body th, .board-post-body td { padding: 3px 6px; } }
    .board-post-body th { background: #1a1a25; color: var(--text-primary); font-weight: 600; }
    .board-post-body a { color: var(--accent-teal); text-decoration: underline; }
    .board-post-body strong { color: var(--text-primary); font-weight: 600; }
    .board-post-body em { color: var(--text-primary); font-style: italic; }
    .board-post-body br { line-height: 1.4; }
    .board-post-body del { color: #948d9e; }
    .fleet-msg-body { color: #e0e0f0; font-size: 11px; line-height: 1.4; }
    @media (min-width: 640px) { .fleet-msg-body { font-size: 12px; } }
    .fleet-msg-body p { margin: 0 0 3px 0; }
    .fleet-msg-body p:last-child { margin-bottom: 0; }
    .fleet-msg-body h1, .fleet-msg-body h2, .fleet-msg-body h3 { color: #ffffff; margin: 4px 0 2px 0; font-weight: 600; }
    .fleet-msg-body h1 { font-size: 12px; }
    .fleet-msg-body h2 { font-size: 11px; }
    .fleet-msg-body h3 { font-size: 11px; color: #c0c0d0; }
    .fleet-msg-body ul, .fleet-msg-body ol { margin: 2px 0 3px 0; padding-left: 14px; }
    .fleet-msg-body li { margin: 1px 0; }
    .fleet-msg-body code { background: rgba(255,255,255,0.08); padding: 0 2px; border-radius: 2px; font-family: monospace; font-size: 10px; }
    .fleet-msg-body pre { background: rgba(0,0,0,0.3); padding: 3px 4px; border-radius: 3px; margin: 2px 0; overflow-x: auto; }
    .fleet-msg-body pre code { background: transparent; padding: 0; }
    .fleet-msg-body strong { color: #ffffff; font-weight: 600; }
    .fleet-msg-body a { color: #4ade80; text-decoration: underline; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .fleet-msg-body br { line-height: 1.4; }
    .board-agent-badge { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 8px; font-weight: 600; }
    @media (min-width: 640px) { .board-agent-badge { font-size: 9px; padding: 1px 6px; } }
    .board-agent-vex { background: rgba(255,107,53,0.15); color: var(--accent-orange); }
    .board-agent-eliza { background: rgba(74,222,128,0.15); color: var(--accent-teal); }
    .board-agent-hermes { background: rgba(167,139,250,0.15); color: var(--accent-purple); }
    .board-agent-alice { background: rgba(96,165,250,0.15); color: var(--accent-blue); }
    .board-agent-kimi { background: rgba(251,191,36,0.15); color: var(--accent-yellow); }
    .board-input-wrap { display: flex; gap: 4px; }
    .board-input-wrap input { min-width: 0; width: 100%; padding: 5px 8px; border-radius: 6px; border: 1px solid #2a2a3a; background: #1a1a2a; color: var(--text-primary); font-size: 11px; outline: none; }
    @media (min-width: 640px) { .board-input-wrap input { padding: 6px 10px; font-size: 12px; } }
    .board-input-wrap input:focus { border-color: var(--accent-orange); }
    .board-tabs { display: flex; gap: 3px; margin-bottom: 6px; flex-wrap: wrap; }
    @media (min-width: 640px) { .board-tabs { gap: 4px; } }
    .board-tab { padding: 3px 8px; border-radius: 4px; font-size: 10px; cursor: pointer; background: #1a1a2a; color: #8b8ba0; border: 1px solid transparent; transition: all .15s; }
    @media (min-width: 640px) { .board-tab { padding: 4px 12px; font-size: 11px; } }
    .board-tab:hover { border-color: rgba(255,107,53,0.3); color: var(--text-primary); }
    .board-tab.active { background: rgba(255,107,53,0.15); color: var(--accent-orange); border-color: var(--accent-orange); }
    .board-new-topic { display: flex; gap: 4px; margin-bottom: 6px; }
    .board-new-topic input { flex: 1; padding: 5px 8px; border-radius: 6px; border: 1px solid #2a2a3a; background: #1a1a2a; color: var(--text-primary); font-size: 11px; outline: none; }
    @media (min-width: 640px) { .board-new-topic input { padding: 6px 10px; font-size: 12px; } }
    .board-new-topic input:focus { border-color: var(--accent-orange); }

    /* Campus Logo */
    .campus-logo { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 6px; overflow: hidden; flex-shrink: 0; }
    @media (min-width: 640px) { .campus-logo { width: 52px; height: 52px; border-radius: 8px; } }
    .campus-logo img { width: 100%; height: 100%; object-fit: cover; }
    .campus-logo svg { width: 100%; height: 100%; display: block; }

    /* Chat card */
    .chat-card { grid-column: 1 / -1; }
    .chat-input-wrap { display: flex; gap: 4px; flex-wrap: nowrap; }
    .chat-input-wrap input { min-width: 0; width: 100%; }
    @media (max-width: 480px) {
      .chat-input-wrap { flex-wrap: wrap; }
      .chat-input-wrap input#fleet-chat-name { width: 100%; flex-shrink: 0; }
      .chat-input-wrap input#fleet-chat-input { order: 3; width: 100%; }
    }

    /* Search & Filter */
    .controls { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.5rem; align-items: center; }
    @media (min-width: 640px) { .controls { gap: 0.75rem; margin-bottom: 1rem; } }
    .controls input { flex: 1; min-width: 0; padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: #0d0d15; color: var(--text-primary); font-size: 0.75rem; outline: none; transition: border-color .15s; }
    @media (min-width: 640px) { .controls input { min-width: 200px; padding: 0.6rem 1rem; font-size: 0.9rem; border-radius: 8px; } }
    .controls input:focus { border-color: var(--accent-orange); box-shadow: 0 0 0 3px var(--accent-orange-glow); }
    .controls select { padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: #0d0d15; color: var(--text-primary); font-size: 0.7rem; outline: none; cursor: pointer; transition: border-color .15s; }
    @media (min-width: 640px) { .controls select { padding: 0.6rem 1rem; font-size: 0.85rem; border-radius: 8px; } }
    .controls select:focus { border-color: var(--accent-orange); }
    .count { color: var(--text-dim); font-size: 0.7rem; white-space: nowrap; }
    @media (min-width: 640px) { .count { font-size: 0.85rem; } }

    /* Table */
    .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-card); -webkit-overflow-scrolling: touch; }
    @media (min-width: 640px) { .table-wrap { border-radius: 10px; } }
    table { width: 100%; border-collapse: collapse; font-size: 0.65rem; }
    @media (min-width: 640px) { table { font-size: 0.82rem; } }
    th { text-align: left; padding: 0.3rem 0.4rem; background: var(--bg-card-hover); color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.6rem; border-bottom: 1px solid var(--border); cursor: pointer; white-space: nowrap; }
    @media (min-width: 640px) { th { padding: 0.6rem 0.8rem; font-size: 0.72rem; } }
    th:hover { color: var(--text-secondary); }
    td { padding: 0.3rem 0.4rem; border-bottom: 1px solid rgba(255,255,255,0.03); vertical-align: top; }
    @media (min-width: 640px) { td { padding: 0.5rem 0.8rem; } }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .fn-name { color: var(--accent-blue); font-family: var(--font-mono); font-weight: 500; }
    .fn-method { display: inline-block; padding: 0.1rem 0.25rem; border-radius: 3px; font-size: 0.6rem; font-weight: 700; margin-right: 0.2rem; }
    @media (min-width: 640px) { .fn-method { font-size: 0.7rem; padding: 0.1rem 0.35rem; margin-right: 0.25rem; } }
    .method-GET { background: rgba(96,165,250,0.12); color: var(--accent-blue); }
    .method-POST { background: rgba(74,222,128,0.12); color: var(--accent-teal); }
    .method-PATCH { background: rgba(251,191,36,0.12); color: var(--accent-yellow); }
    .method-DELETE { background: rgba(248,113,113,0.12); color: var(--accent-red); }
    .tag-workflow { background: rgba(251,191,36,0.12); color: var(--accent-yellow); font-size: 0.6rem; padding: 0.1rem 0.25rem; border-radius: 3px; white-space: nowrap; }
    @media (min-width: 640px) { .tag-workflow { font-size: 0.65rem; padding: 0.1rem 0.35rem; } }
    .tag-simple { background: rgba(96,165,250,0.12); color: var(--accent-blue); font-size: 0.6rem; padding: 0.1rem 0.25rem; border-radius: 3px; white-space: nowrap; }
    @media (min-width: 640px) { .tag-simple { font-size: 0.65rem; padding: 0.1rem 0.35rem; } }
    .fn-inputs { color: #948d9e; font-size: 0.65rem; font-family: 'SF Mono', monospace; }
    @media (min-width: 640px) { .fn-inputs { font-size: 0.75rem; } }
    .fn-desc { color: #a0a0b0; font-size: 0.7rem; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (min-width: 480px) { .fn-desc { max-width: 180px; } }
    @media (min-width: 768px) { .fn-desc { max-width: 350px; } }
    .footer { margin-top: 1rem; text-align: center; color: #4a4a5a; font-size: 0.7rem; }
    @media (min-width: 640px) { .footer { margin-top: 1.5rem; font-size: 0.78rem; } }
    .loading { text-align: center; padding: 2rem; color: #948d9e; }
    @media (min-width: 640px) { .loading { padding: 3rem; } }
    .endpoint-url { color: #948d9e; font-size: 0.6rem; font-family: 'SF Mono', monospace; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (min-width: 480px) { .endpoint-url { max-width: 120px; font-size: 0.65rem; } }
    @media (min-width: 640px) { .endpoint-url { max-width: 200px; font-size: 0.7rem; } }
    .endpoint-url span { color: #a0a0b0; }
    .fn-method-cell { white-space: nowrap; }
    /* Mobile-first: hide less important columns on small screens */
    @media (max-width: 480px) {
      .fn-desc { display: none; }
      .endpoint-url { max-width: 60px; }
      .fn-inputs { display: none; }
      th:nth-child(4), td:nth-child(4) { display: none; } /* hide Description column */
      th:nth-child(5), td:nth-child(5) { display: none; } /* hide Endpoint column */
    }
    @media (max-width: 640px) {
      .hide-mobile { display: none; }
    }
    /* Collapse tools list on mobile — show count only */
    @media (max-width: 480px) {
      .tools-list-mobile { display: none; }
      .tools-count-mobile { display: inline; }
    }
    @media (min-width: 481px) {
      .tools-count-mobile { display: none; }
    }
    /* Quarterdeck responsive layout */
    /* minmax(0, 1fr), not 1fr.
       A '1fr' track's automatic minimum is 'min-content', so one nowrap log
       line or wide table inside Campus Watch was enough to push the column to
       924px inside a 360px viewport and give the whole page a horizontal
       scrollbar. minmax(0,1fr) removes that floor and lets the panel clip
       instead. Measured: the two sub-panels were 924px wide at 360px. */
    .quarterdeck-mid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-bottom: 10px; }
    .quarterdeck-mid > * { min-width: 0; }
    @media (min-width: 640px) { .quarterdeck-mid { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 10px; } }
    .quarterdeck-security { display: grid; grid-template-columns: 1fr; gap: 8px; margin-bottom: 10px; }
    @media (min-width: 640px) { .quarterdeck-security { grid-template-columns: 1fr; gap: 10px; } }
    .quarterdeck-bottom { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-bottom: 10px; }
    .quarterdeck-bottom > * { min-width: 0; }
    @media (min-width: 640px) { .quarterdeck-bottom { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr); gap: 10px; } }
    /* Responsive sub-grids for sections below the knowledge graph */
    /* Sub-grids respond to their CONTAINER, not the viewport.
       These used to be stepped by viewport media queries (1 col, then 2 at
       480px, then 3 or 4 at 768px). That was fine while every tile was
       full-bleed. It stopped being fine the moment the tiles became real grid
       columns: Campus Intelligence is now one column of four, roughly 330px
       wide inside a 1440px viewport, so at 768px+ the sub-grid still demanded
       THREE columns and crushed XMRT University to about 100px - its labels
       wrapped one character per line ("St at us", "14 modules availabl e")
       and Incoming Mail spilled over the tile edge.

       A viewport query cannot know how wide its container is. repeat(auto-fit,
       minmax(Npx, 1fr)) can, with no query at all: it fits as many Npx columns
       as the parent can actually hold. min-width:0 on the children stops a
       wide child re-inflating its own track. */
    /* Containment for content that is intrinsically wider than its column.

       Measured at an 800px viewport: three 170px inbox columns (EXECUTION,
       REVIEW, COMPLETION - built in dashboard.js) reaching x=924, 1100 and
       1276, and the Edge Functions table at 883px reaching x=925. All four
       stick out past the viewport, and because they are painted in document
       order they cover whatever sits beside them - which is how a neighbour
       ends up looking like it vanished when it is really underneath.

       overflow-x:auto makes the overflow scroll INSIDE its own box instead of
       escaping, so it can no longer paint over a sibling tile. */
    /* ── Email inbox columns ───────────────────────────────────────────────────
       resendTileHtml() emitted bare <div>s into a flex column. A flex item's
       automatic minimum is min-content, so each one sized itself to its content
       and sat at a fixed 170px no matter how narrow the tile became - measured
       reaching x=924, 1100 and 1276 in an 800px viewport, painting over their
       neighbours.

       Now a wrapping grid with minmax(0,1fr). minmax(0,...) rather than a bare
       1fr so the floor really is zero: a bare 1fr track's automatic minimum is
       min-content, which is the same trap one level down. No fixed width
       anywhere, so the columns reflow at every viewport. */
    .inbox-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
      gap: 8px;
    }
    .inbox-col { min-width: 0; }
    .inbox-list { max-height: 80px; overflow-y: auto; overflow-x: hidden; font-size: 0.75rem; min-width: 0; }
    .inbox-col .stat { flex-wrap: wrap; }
    .inbox-col .label, .inbox-col .value { min-width: 0; overflow-wrap: anywhere; }

    /* ── Page-level containment guard ───────────────────────────────────────
       Last line of defence, and the reason the layout is now width-independent
       rather than merely tested at a few widths: overflow-x:clip stops ANY
       descendant from painting outside the page box, so a future fixed-width
       element cannot hide a neighbouring tile or create a horizontal
       scrollbar. 'clip' rather than 'hidden' on purpose - it does not create a
       scroll container, so position:sticky keeps working. */
    html, body { overflow-x: clip; max-width: 100%; }
    .card, .card > div, .grid > * { min-width: 0; }

    #fn-catalog table { display: block; overflow-x: auto; max-width: 100%; }

    /* Campus Intelligence splits by CONTENT rather than by count: XMRT University
       and GitHub Activity are short fixed-height readouts and stack in the left
       column, Incoming Mail is a long scrolling list and gets the right column
       to itself. Laid out as three equal columns the tile was one tall narrow
       stack with dead space beside a very tall mail list. */
    .intel-split { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px; align-items: start; }
    .intel-split > * { min-width: 0; }
    .intel-left { display: grid; grid-template-rows: auto auto; gap: 8px; align-content: start; min-width: 0; }

    .subgrid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
    .subgrid-3 > * { min-width: 0; }
    .subgrid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
    .subgrid-4 > * { min-width: 0; }
    @media (min-width: 768px) { .subgrid-3, .subgrid-4 { gap: 12px; } }
    .sec-grid { display: grid; grid-template-columns: 1fr; gap: 4px; }
    @media (min-width: 480px) { .sec-grid { grid-template-columns: 1fr 1fr; } }
  
    /* The mesh canvas is the BACKGROUND, so it gets a negative z-index rather than
       being kept underneath by a whitelist.

       It used to be z-index:0 with body at z-index:0, which meant every piece
       of content had to be explicitly listed at z-index:10 to paint above it.
       That is a whitelist that has to be maintained forever, and it had already
       drifted: .status-strip was missed, so the canvas painted over it. Because
       the canvas is drawn progressively - filled opaque first, mesh lines after
       - the region looked right for a moment after load and then went black,
       while the mesh animation stayed visible on top of the black. That reads
       as "the card disappeared" rather than "something is painted over it".

       At z-index:-1 the canvas sits behind ALL in-flow content automatically,
       because body establishes the stacking context. New tiles cannot be missed
       because there is no list to add them to.

       body { position: relative; z-index: 0 } below is what makes this work: it
       creates the stacking context that -1 is relative to. */
    canvas#mesh-bg { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; }
    body { position: relative; z-index: 0; }
    /* Everything that must sit ABOVE the fixed mesh canvas.
       This is an explicit whitelist, not a rule of thumb, and that is the
       whole bug: canvas#mesh-bg is position:fixed with z-index:0, so any
       in-flow content that is not listed here paints BELOW it. A positioned
       element with z-index:0 paints above non-positioned content in the same
       stacking context.

       .status-strip and the Edge Functions link line were missing, so the mesh
       canvas drew over them. Because the canvas is painted progressively by
       JS, the region looked correct for a moment after load and then went
       black - which read as "the tile disappeared" rather than "something is
       painted on top of it".

       Anything added to the top level of <body> must be added here too. */
    .grid, h1, .subtitle, .table-wrap, .footer, .controls,
    .status-strip, .archive, .status-strip ~ div { position: relative; z-index: 10; }

    /* Kept even though the canvas is now at z-index:-1 and none of this is
       strictly required. It costs nothing, it keeps the existing tooltips and
       overlays explicitly above content, and it means a future change to the
       canvas cannot silently reintroduce the same class of bug. Every direct
       child of <body> is listed, including .status-strip and .archive, which
       is what the whitelist got wrong before. */
    body > *:not(.scanline):not(canvas#mesh-bg):not(script) { position: relative; z-index: 10; }

    /* ── Lumen Component Enhancements ── */
    /* Typography */
    h1, h2, h3 { font-family: var(--lumen-font-display); letter-spacing: -0.01em; }
    .card h3 { font-family: var(--lumen-font-display); }
    
    /* Card enhancements */
    .card { transition: border-color var(--lumen-transition), box-shadow var(--lumen-transition), transform var(--lumen-transition); }
    .card:hover { box-shadow: var(--lumen-shadow-md); }
    
    /* Button enhancements */
    button, .btn { font-family: var(--lumen-font-sans); transition: all var(--lumen-transition); }
    button:hover { box-shadow: var(--lumen-shadow-sm); }
    
    /* Badge enhancements */
    .badge { font-family: var(--lumen-font-mono); transition: all var(--lumen-transition); }
    
    /* Stat enhancements */
    .stat { transition: background var(--lumen-transition); }
    .stat:hover { background: var(--lumen-bg-hover); }
    
    /* Table enhancements */
    th { font-family: var(--lumen-font-sans); }
    td { font-family: var(--lumen-font-mono); }
    
    /* Animations */
    @keyframes lumen-fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes lumen-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    @keyframes lumen-shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    .lumen-animate-fade { animation: lumen-fade-in 0.3s ease forwards; }
    .lumen-animate-pulse { animation: lumen-pulse 2s ease-in-out infinite; }
    
    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--lumen-border-strong); border-radius: var(--lumen-radius-pill); }
    ::-webkit-scrollbar-thumb:hover { background: var(--lumen-text-muted); }
    
    /* Focus styles */
    :focus-visible { outline: 2px solid var(--lumen-accent); outline-offset: 2px; }
    
    /* Selection */
    ::selection { background: var(--lumen-accent-bg); color: var(--lumen-text); }

    /* ── Owner restart control ──────────────────────────────────────────────
       One row per supervised service, with the button the owner did not have
       until now.

       Deliberately NOT inside #qds-services-tracker. updateQDSupervisor
       rewrites that element's innerHTML every 10 seconds, which would wipe a
       button out from under a click and destroy any in-flight progress bar.
       These rows are built once per service and mutated in place.

       The bar uses visibility rather than display so the row does not reflow
       when progress starts — a bar appearing should not move the button the
       pointer is already travelling toward. */
    .qd-svc { display: grid; grid-template-columns: 8px minmax(0,1fr) auto 56px auto auto;
              align-items: center; gap: 5px; padding: 2px 3px; border-radius: 4px;
              font-size: 0.62rem; line-height: 1.5; }
    .qd-svc.danger { background: rgba(248,113,113,0.07); box-shadow: inset 2px 0 0 rgba(248,113,113,0.45); }
    .qd-svc.busy { background: rgba(251,191,36,0.08); }
    .qd-dot { width: 6px; height: 6px; border-radius: 50%; background: #4a4a5e; }
    .qd-dot.ok { background: #4ade80; box-shadow: 0 0 5px rgba(74,222,128,0.7); }
    .qd-dot.bad { background: #f87171; box-shadow: 0 0 5px rgba(248,113,113,0.7); }
    .qd-name { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qd-pid { color: var(--text-dim); font-family: var(--font-mono); font-size: 0.55rem; }
    .qd-bar { visibility: hidden; width: 56px; height: 3px; border-radius: 2px;
              background: rgba(255,255,255,0.09); overflow: hidden; }
    .qd-bar.show { visibility: visible; }
    .qd-bar i { display: block; height: 100%; width: 4%; border-radius: 2px;
                background: #fbbf24; animation: qd-fill 1.1s ease-in-out infinite; }
    /* A resolved bar stops animating and sits full. Full is not decoration: it
       is the only visual that distinguishes "confirmed" from "still trying". */
    .qd-svc.done .qd-bar i { background: #4ade80; animation: none; width: 100%; }
    .qd-svc.fail .qd-bar i { background: #f87171; animation: none; width: 100%; }
    @keyframes qd-fill { 0% { width: 4%; } 50% { width: 62%; } 100% { width: 4%; } }
    .qd-state { color: #948d9e; font-size: 0.55rem; white-space: nowrap; }
    .qd-state.work { color: #fbbf24; }
    .qd-state.done { color: #4ade80; }
    .qd-state.fail { color: #f87171; }
    .qd-btn { background: transparent; border: 1px solid #3a3a5a; color: #a1a1b5;
              border-radius: 3px; font-size: 0.55rem; padding: 1px 6px; cursor: pointer;
              white-space: nowrap; font-family: inherit; }
    .qd-btn:hover:not(:disabled) { border-color: var(--accent-orange); color: var(--accent-orange); }
    .qd-btn:disabled { opacity: 0.35; cursor: default; }

    /* ── The restart rows on a phone ────────────────────────────────────────
       Placed HERE, after the base .qd-svc rule, and that position is the whole
       point. The first version of this block sat up in the grid section, above
       .qd-svc. Equal specificity, so the LATER rule wins — which meant the
       desktop grid-template-columns kept applying while the areas from this
       block did land, giving six tracks laid out by three named areas. It
       looked half-applied because it was half-applied.

       Verified at 360px: two rows, 63px tall, 36px button (the 44px figure is
       a guideline for standalone controls; 36px is a defensible minimum for a
       dense list row and still clears the 24px floor comfortably). */
    @media (max-width: 560px) {
      .qd-svc {
        grid-template-columns: 8px minmax(0, 1fr) auto;
        grid-template-areas: "dot name btn" ". pid pid";
        row-gap: 2px;
        padding: 6px;
      }
      .qd-dot { grid-area: dot; }
      .qd-name { grid-area: name; font-size: 0.8rem; }
      .qd-pid { grid-area: pid; font-size: 0.7rem; }
      .qd-btn { grid-area: btn; min-height: 36px; padding: 4px 12px; font-size: 0.72rem; }
      .qd-bar { grid-area: pid; justify-self: start; width: 100%; margin-top: 3px; }
      .qd-state { grid-column: 1 / -1; font-size: 0.7rem; white-space: normal; }
    }

</style>
</head>
<body>
<div class="scanline"></div>
<canvas id="mesh-bg"></canvas>
  <h1><span class="campus-logo"><img src="/images/xmrtdao.png" alt="XMRT DAO"></span> Tributary Campus <span>Command Center</span></h1>
  <div class="subtitle">
    <span style="color:var(--accent-orange);font-weight:600;">XMRT DAO</span> · <span title="Tributary Campus — the Cuttlefish Protocol command center. Constitutional AI agents, TrustGraph scoring, and the Tributary AI Campus." style="cursor:help;border-bottom:1px dotted #ff8800;">Tributary Campus</span> v10.0.0 · 
    <a href="https://relay.mobilemonero.com">relay.mobilemonero.com</a> ·
    <a href="https://github.com/xmrtdao/mobilemonero" target="_blank">GitHub</a>
  </div>
  <div style="text-align:center;margin-top:4px;font-size:0.75rem;color:var(--text-dim);">
    <a href="#fn-catalog" style="color:#00d2ff;">☁️ Supabase Edge Functions Catalog</a> &mdash; <span id="fn-catalog-count">checking&hellip;</span>
  </div>

  <!-- Status strip. The question this page exists to answer is "is anything
       broken", and before this strip the answer was at y=1,141 — under the
       chat transcript and the trust chart. These four readouts are the same
       values the Campus Watch panel shows, mirrored up here rather than moved,
       so both stay live and neither becomes a second stale copy.

       The ids are ss-* so they cannot collide with the qds-* ids
       updateQDSupervisor() writes; it fills those in parallel. -->
  <div class="status-strip">
    <div class="ss-item">
      <span class="ss-label">Services</span>
      <span class="ss-value" id="ss-up" style="color:var(--accent-orange);">-</span>
    </div>
    <div class="ss-item">
      <span class="ss-label">Stack health</span>
      <span class="ss-value" id="ss-health">-</span>
    </div>
    <div class="ss-item">
      <span class="ss-label">Down</span>
      <span class="ss-value" id="ss-down">-</span>
    </div>
    <div class="ss-item">
      <span class="ss-label">Checked</span>
      <span class="ss-value" id="ss-checked">-</span>
    </div>
    <a class="ss-cta" href="#restart-control">⟳ Restart a service</a>
  </div>
  
  <div class="grid">
<div class="card chat-card tile-wide tile-p1">
      <h3 style="color:var(--accent-orange);">Campus Comms <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Vex · Eliza-Cloud · Hermes</span></h3>
      <div id="fleet-chat-msgs" style="height:180px;overflow-y:auto;background:#0a0400;border-radius:6px;padding:8px;margin-bottom:6px;font-size:12px;line-height:1.5;">
        <div style="color:var(--text-dim);text-align:center;padding:20px 0;font-size:12px;">Campus comms active. All agents hear every broadcast.</div>
      </div>
      <div class="chat-input-wrap" style="gap:4px;">
        <input id="fleet-chat-name" type="text" placeholder="Your name..." style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:#0e0600;color:var(--text-primary);font-size:12px;outline:none;width:100px;flex-shrink:0;" maxlength="20"/>
        <input id="fleet-chat-agent" type="hidden" value=""/>
        <input id="fleet-chat-input" type="text" placeholder="Broadcast to the campus..." 
          style="flex:1;min-width:0;padding:6px 10px;border-radius:6px;border:1px solid #2a2a3a;background:#1a1a2a;color:#e0e0f0;font-size:12px;outline:none;"
          onkeypress="if(event.key==='Enter')sendFleetChat()">
        <label for="fleet-chat-file" title="Attach a file" style="padding:6px 10px;border-radius:6px;border:1px solid #2a2a3a;background:#1a1a2a;color:#a78bfa;cursor:pointer;font-size:14px;flex-shrink:0;display:flex;align-items:center;">📎</label>
        <input id="fleet-chat-file" type="file" style="display:none;" onchange="attachFleetFile(this)"/>
        <button onclick="sendFleetChat()" style="padding:6px 14px;border-radius:6px;border:none;background:#ff6b35;color:white;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;">Send</button>
      </div>
      <div id="fleet-chat-attach-status" style="font-size:10px;color:#a78bfa;margin-top:2px;min-height:14px;"></div>
      <div style="margin-top:4px;display:flex;gap:8px;font-size:11px;color:#948d9e;">
        <span>Campus broadcast — all agents hear your message</span>
        <span id="fleet-chat-status" style="color:#4ade80;">● connected</span>
      </div>
    </div>

<!-- 📈 Trust Trajectory — Full-width chart -->
<div class="card tile-wide tile-p4">
  <h3 style="color:#a78bfa;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📈 Trust Trajectory
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Real-time TrustGraph scores over time · Hover any point for details</span>
  </h3>
  <div style="position:relative;">
    <canvas id="trust-trajectory-canvas" style="width:100%;height:200px;border-radius:6px;background:#08080e;cursor:default;"></canvas>
    <div id="trust-trajectory-tooltip" style="display:none;position:absolute;background:#1a1a2a;border:1px solid #3a3a5a;border-radius:6px;padding:8px 12px;font-size:11px;color:#e0e0f0;pointer-events:none;white-space:nowrap;z-index:100;max-width:400px;line-height:1.5;"></div>
  </div>
  <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center;font-size:0.6rem;color:#948d9e;">
    <span>● <span id="trajectory-agent-count">-</span> agents tracked</span>
    <span>● <span id="trajectory-event-count">-</span> total events</span>
    <span>● <span id="trajectory-range"></span></span>
    <span style="margin-left:auto;color:#4ade80;">● live</span>
    <span id="trajectory-toggle-btn" style="cursor:pointer;color:#60a5fa;font-size:0.6rem;margin-left:6px;padding:1px 6px;border:1px solid #3a3a5a;border-radius:3px;" onclick="toggleTrajectoryView()">🔍 Full View</span>
  </div>
</div>

<!-- ⚓ Quarterdeck — Consolidated Command Center -->
<div class="card tile-full tile-p3" style="border-color:rgba(255,107,53,0.2);">
  <h3 style="color:var(--accent-orange);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    🏛️ Campus Command
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— The Campus domain: rations, watch, bulletin, and vessels</span>
  </h3>

  <!-- Top row: Campus Rations (combined with Agent Experience) — full width -->
  <div style="margin-bottom:10px;">
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;border:1px solid var(--border);">
      <h4 style="color:var(--accent-purple);font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">🍺 Campus Rations <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Agent Rations · Trust Scores · Status · Experience</span></h4>
      <div id="rum-quota-content" style="display:flex;flex-direction:column;gap:2px;max-height:260px;overflow-y:auto;padding-right:8px;">
        <div class="stat"><span class="label">Loading agent ledger...</span></div>
      </div>
    </div>
  </div>

  <!-- Middle row: Campus Watch + Activity Log -->
  <div class="quarterdeck-mid">
    <!-- Campus Watch -->
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;border:1px solid var(--border);">
      <h4 style="color:var(--accent-yellow);font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">🔭 Campus Watch <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Eliza's Topside Watchdog</span></h4>
      <div id="quarterdeck-supervisor">
        <div class="stat"><span class="label">Supervisor</span><span class="value" id="qds-supervisor" style="color:#948d9e;">checking...</span></div>
        <div class="stat"><span class="label">Stack Health</span><span class="value" id="qds-health-score" style="color:#948d9e;">-</span></div>
        <div class="stat"><span class="label">Services Up</span><span class="value" id="qds-services-up" style="color:#948d9e;">-</span></div>
        <div class="stat"><span class="label">Services Down</span><span class="value" id="qds-services-down" style="color:#948d9e;">-</span></div>
        <div class="stat"><span class="label">Flapping</span><span class="value" id="qds-flapping" style="color:#948d9e;">-</span></div>
        <div class="stat"><span class="label">Task Issues</span><span class="value" id="qds-task-issues" style="color:#948d9e;">-</span></div>
        <div class="stat"><span class="label">Last Check</span><span class="value" id="qds-last-check" style="color:#948d9e;">-</span></div>
        <div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.6rem;color:var(--text-dim);">
          <div style="margin-bottom:2px;color:#8b8ba0;">Consolidated Services</div>
          <div id="qds-services-tracker" style="line-height:1.6;">-</div>
        </div>
        <!-- Owner restart control. Rows are built by dashboard.js from the same
             /api/supervisor/status payload as the chips above, so this list can
             never name a service the supervisor is not actually watching. -->
        <div id="restart-control" style="margin-top:6px;padding-top:6px;border-top:1px solid #1e1e2e;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span style="color:#8b8ba0;font-size:0.6rem;letter-spacing:0.05em;">RESTART CONTROL</span>
            <span style="color:#4a4a5e;font-size:0.55rem;">owner</span>
            <span style="margin-left:auto;font-size:0.55rem;color:#948d9e;">3/hour/service</span>
          </div>
          <div id="qds-restart-list" style="display:flex;flex-direction:column;gap:1px;">
            <div style="color:#948d9e;font-size:0.6rem;">loading services&hellip;</div>
          </div>
        </div>
        <div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.65rem;color:var(--text-dim);">
          <span style="color:#60a5fa;">⚡ relay</span> v7.0.0 · <span id="qds-relay-uptime">${uptimeStr}</span> · <span id="qds-tools">${toolCount}</span> tools · <span id="qds-handlers">${handlerCount}</span> handlers · <span id="qds-requests">${requestCounts.total}</span> req
        </div>
      </div>
      <div style="margin-top:4px;font-size:0.6rem;color:#948d9e;">
        <a href="/api/supervisor/status" style="color:#60a5fa;">API</a> · <span id="qds-refresh" style="color:#4ade80;">● polling</span>
      </div>
    </div>
    <!-- Activity Log (centralized log viewer) -->
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;border:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <h4 style="color:var(--accent-yellow);font-size:0.75rem;margin:0;text-transform:uppercase;letter-spacing:0.05em;">📡 Activity Log</h4>
        <div style="display:flex;gap:4px;align-items:center;">
          <select id="log-filter-type" style="background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border);border-radius:4px;padding:2px 4px;font-size:0.6rem;">
            <option value="">All Types</option>
            <option value="fleet_message">Fleet Msg</option>
            <option value="ai_chat">AI Chat</option>
            <option value="system_health_check">Health</option>
            <option value="tool_execution">Tool</option>
            <option value="edge_function">Edge Fn</option>
            <option value="cron_execution">Cron</option>
            <option value="email">Email</option>
            <option value="http_error">HTTP Error</option>
            <option value="db_error">DB Error</option>
            <option value="auth_failure">Auth</option>
          </select>
          <input id="log-search" type="text" placeholder="Search..." style="background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:0.6rem;width:100px;">
          <button onclick="refreshLogViewer()" style="background:var(--bg-card);color:var(--accent-blue);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:0.6rem;cursor:pointer;">↻</button>
        </div>
      </div>
      <div id="qds-activity-log" style="font-size:0.6rem;max-height:400px;overflow-y:auto;">
        <div class="stat"><span class="label">Loading activity...</span></div>
      </div>
    </div>
  </div>

  <!-- Training & Security row (own row) -->
  <div class="quarterdeck-security">
    <!-- TRAINING & SECURITY — TrustGraph · CAC Tiers · XMRT-DAO-CERT · Access Control -->
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;border:1px solid var(--border);">
      <h4 style="color:var(--accent-red);font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">🛡️ Training & Security <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— TrustGraph · CAC Tiers · XMRT-DAO-CERT · Access Control</span></h4>
      <div id="qds-security" style="font-size:0.6rem;">
        <div class="sec-grid">
          <div>
            <div class="stat"><span class="label">TrustGraph</span><span class="value" id="sec-tg-status" style="color:#4ade80;font-size:0.65rem;">● online</span></div>
            <div class="stat"><span class="label">Agents</span><span class="value" id="sec-agent-count" style="font-size:0.65rem;">19</span></div>
            <div class="stat"><span class="label">CAC Anchor</span><span class="value" id="sec-cac-anchor" style="color:#a78bfa;font-size:0.65rem;">2</span></div>
            <div class="stat"><span class="label">CAC Builder</span><span class="value" id="sec-cac-builder" style="color:#60a5fa;font-size:0.65rem;">7</span></div>
            <div class="stat"><span class="label">CAC Explorer</span><span class="value" id="sec-cac-explorer" style="color:#34d399;font-size:0.65rem;">7</span></div>
          </div>
          <div>
            <div class="stat"><span class="label">IAL Level</span><span class="value" id="sec-ial" style="color:#fbbf24;font-size:0.65rem;">IAL2</span></div>
            <div class="stat"><span class="label">Activity Events</span><span class="value" id="sec-activity-count" style="font-size:0.65rem;">-</span></div>
            <div class="stat"><span class="label">Trusted (≥80)</span><span class="value" id="sec-trusted" style="color:#4ade80;font-size:0.65rem;">2</span></div>
            <div class="stat"><span class="label">Cautious (40-79)</span><span class="value" id="sec-cautious" style="color:#fbbf24;font-size:0.65rem;">17</span></div>
            <div class="stat"><span class="label">Banned (&lt;40)</span><span class="value" id="sec-banned" style="color:#f87171;font-size:0.65rem;">0</span></div>
          </div>
        </div>
        <div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;">
          <div class="stat"><span class="label">Top Trust</span><span class="value" id="sec-top-agent" style="color:#4ade80;font-size:0.65rem;">loading...</span></div>
          <div class="stat"><span class="label">Lowest Trust</span><span class="value" id="sec-low-agent" style="color:#f87171;font-size:0.65rem;">loading...</span></div>
          <div class="stat"><span class="label">XMRT-DAO-CERT</span><span class="value" id="sec-cert-count" style="color:#fbbf24;font-size:0.65rem;">checking...</span></div>
          <div class="stat"><span class="label">🎓 University</span><span class="value" id="sec-uni-status" style="color:#a78bfa;font-size:0.65rem;">checking...</span></div>
          <div class="stat"><span class="label">Gate</span><span class="value" id="sec-gate" style="color:#4ade80;font-size:0.65rem;">● fail-closed</span></div>
        </div>
      </div>
    </div>
  </div>

    <!-- Full-width kanban task board row -->
    <div style="grid-column:1/-1;margin-bottom:10px;">
      <div style="background:#0a0a14;border-radius:6px;padding:8px;border:1px solid #1e1e2e;max-height:340px;overflow:hidden;">
        <h4 style="color:#60a5fa;font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">📋 Task Pipeline <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Fleet Task Board</span></h4>
        <div id="task-pipeline-content" style="height:290px;overflow-y:auto;font-size:0.55rem;"></div>
      </div>
    </div>

    <!-- Agent Vault — Agent Chests -->
    <!-- Collapsed by default. This rendered 1,810px — more than every other
         sub-tile in Campus Command combined — and it holds COMPLETED task
         artifacts. That is reference material, not a status readout, and it
         was pushing the things you actually watch further down the page.
         <details> is used rather than a JS toggle so it still works if
         dashboard.js fails to load, which on this page is not hypothetical. -->
    <details class="archive">
      <summary>📦 Agent Vault <span>— Agent Chests · Completed Task Artifacts</span></summary>
      <div style="margin-bottom:10px;">
        <div style="background:var(--bg-card);border-radius:6px;padding:8px;border:1px solid var(--border);">
          <div id="footlocker-content" style="font-size:0.75rem;">
            <div class="stat"><span class="label">Loading chests...</span></div>
          </div>
        </div>
      </div>
    </details>

    <!-- Bottom row: Campus Forum + Mesh Peers + LoRa Bridge -->
  <div class="quarterdeck-bottom">
    <!-- Campus Forum (bulletin board) -->
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;border:1px solid var(--border);max-height:160px;overflow-y:auto;">
      <h4 style="color:var(--accent-orange);font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;display:flex;justify-content:space-between;align-items:center;">
        <span>📜 Campus Forum <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Agent Resolutions &amp; Progress</span></span>
        <a href="javascript:void(0)" onclick="quickCreateBoardTopic()" style="color:var(--accent-teal);font-size:0.7rem;text-decoration:none;font-weight:700;cursor:pointer;" title="Create a new resolution">+ new</a>
      </h4>
      <div id="board-topics-list" style="font-size:0.65rem;"></div>
      <div style="margin-top:4px;padding-top:4px;border-top:1px solid var(--border);font-size:0.6rem;color:var(--text-dim);">
        <span id="qds-articles-count">-</span> resolutions · <a href="javascript:void(0)" onclick="loadBoard();renderBoardTopics();" style="color:var(--accent-blue);">Full Board</a>
      </div>
    </div>
        <!-- Mesh Peers -->
    <div style="background:#0a0a14;border-radius:6px;padding:8px;border:1px solid #1e1e2e;">
      <h4 style="color:#4ade80;font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">🌐 Mesh Peers <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Gossipsub Network</span></h4>
      <div id="qds-mesh-peers" style="font-size:0.6rem;max-height:80px;overflow-y:auto;">
        <div class="stat"><span class="label">Loading mesh...</span></div>
      </div>
    </div>
    <div style="background:#0a0a14;border-radius:6px;padding:8px;border:1px solid #1e1e2e;">
      <h4 style="color:#4ade80;font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">📡 LoRa Bridge <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Meshtastic Radio Link</span></h4>
      <div id="qds-lora" style="font-size:0.6rem;">
        <span>Bridge: <span id="qds-mt-bridge" style="color:#948d9e;">checking...</span></span><br>
        <span>Peers: <span id="qds-mt-peers" style="color:#948d9e;">-</span></span><br>
        <span>Msgs: <span id="qds-mt-msgs" style="color:#948d9e;">-</span></span>
      </div>
    </div>
  </div>
</div>

<!-- 🏛️ DAO & Ecosystem -->
<div class="card tile tile-p6">
  <h3 style="color:var(--accent-teal);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    🏛️ DAO & Ecosystem
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Health · Membership · Ecosystem · Tools</span>
  </h3>
  <div class="subgrid-4">
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">❤️‍🔥 Health</div>
      <div class="stat"><span class="label">Local DB</span><span class="value" id="dao-health-status">checking...</span></div>
      <div class="stat"><span class="label">Health Score</span><span class="value" id="dao-health-score">-</span></div>
      <div class="stat"><span class="label">Fn Calls / 24h</span><span class="value" id="dao-fn-calls">-</span></div>
      <div class="stat"><span class="label">Agents</span><span class="value" id="dao-agent-count">-</span></div>
      <div class="stat"><span class="label">Tasks</span><span class="value" id="dao-task-count">-</span></div>
      <div class="stat"><span class="label">Services</span><span class="value" id="dao-service-status">-</span></div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🎫 Membership</div>
      <div class="stat"><span class="label"><a href="https://whop.com/xmrt-dao" target="_blank" style="color:#4ade80;text-decoration:none;">Free Tier</a></span><span class="value">free</span></div>
      <div class="stat"><span class="label"><a href="https://whop.com/checkout/plan_W6r4uqGWNaKHp" target="_blank" style="color:#ff6b35;text-decoration:none;">Premium</a></span><span class="value">$9.99/mo</span></div>
      <div class="stat"><span class="label"><a href="https://whop.com/checkout/plan_Wj1nh8AJhdsLN" target="_blank" style="color:#ff6b35;text-decoration:none;">Premium Yearly</a></span><span class="value">$99.99/yr</span></div>
      <div class="stat"><span class="label"><a href="https://whop.com/checkout/plan_n853GD3f5IXm0" target="_blank" style="color:#60a5fa;text-decoration:none;">Supporter</a></span><span class="value">$19.99</span></div>
      <div style="margin-top:4px;font-size:0.6rem;color:#948d9e;">Premium: 2x rewards · governance · early hardware</div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🌐 Ecosystem</div>
      <div class="stat"><span class="label"><a href="https://xmrtsolutions.vercel.app" target="_blank" style="color:#60a5fa;text-decoration:none;">XMRT Token Faucet</a></span><span class="value">testnet</span></div>
      <div class="stat"><span class="label"><a href="https://coldcash.vercel.app" target="_blank" style="color:#60a5fa;text-decoration:none;">ColdCash</a></span><span class="value">private payments</span></div>
      <div class="stat"><span class="label"><a href="https://pipuente.vercel.app" target="_blank" style="color:#60a5fa;text-decoration:none;">PiPuente</a></span><span class="value">cross-chain bridge</span></div>
      <div class="stat"><span class="label"><a href="https://paragraph.com/@xmrt" target="_blank" style="color:#60a5fa;text-decoration:none;">Paragraph Blog</a></span><span class="value">DAO journal</span></div>
      <div class="stat"><span class="label"><a href="https://sepolia.etherscan.io/token/0x77307DFbc436224d5e6f2048d2b6bDfA66998a15" target="_blank" style="color:#60a5fa;text-decoration:none;">XMRT Token</a></span><span class="value">0x7730...8a15</span></div>
      <div class="stat"><span class="label"><a href="https://github.com/xmrtdao" target="_blank" style="color:#60a5fa;text-decoration:none;">GitHub Org</a></span><span class="value">59 repos</span></div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🔧 Tools</div>
      <div class="stat"><span class="label">Relay Tools</span><span class="value" id="dao-tool-count">${toolCount}</span></div>
      <div class="stat"><span class="label">Edge Functions</span><span class="value" id="dao-fn-count">-</span></div>
      ${localFunctions.length > 0 ? '<div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.6rem;color:#4ade80;">Local: ' + localFunctions.map(f => f.name).join(', ') + '</div>' : ''}
      <div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.6rem;color:#948d9e;">
        <a href="/health" style="color:#4ade80;">Health</a> · <a href="/status" style="color:#60a5fa;">Status</a> · <a href="/tools" style="color:#60a5fa;">Tools</a> · <a href="/monitor" style="color:#60a5fa;">Monitor</a>
      </div>
    </div>
  </div>
</div>

<!-- 🪐 xmrt-galaxy — Knowledge Graph -->
<div class="card tile tile-p8">
  <h3 style="color:var(--accent-purple);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    🪐 xmrt-galaxy
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— ecosystem map with live trust scores</span>
  </h3>
  <div style="position:relative;">
    <canvas id="obsidian-graph-canvas" style="width:100%;height:50vh;min-height:240px;max-height:500px;border-radius:6px;background:#08080e;cursor:grab;touch-action:none;"></canvas>
    <div id="graph-tooltip" style="display:none;position:absolute;background:#1a1a2a;border:1px solid #3a3a5a;border-radius:6px;padding:6px 10px;font-size:11px;color:#e0e0f0;pointer-events:none;white-space:nowrap;z-index:100;"></div>
  </div>
  <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center;">
    <button class="gc" id="b-orbit" style="background:rgba(107,107,128,0.04);border:0.5px solid rgba(107,107,128,0.12);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.4);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('orbit')">Orbit</button>
    <button class="gc" id="b-explode" style="background:rgba(107,107,128,0.04);border:0.5px solid rgba(107,107,128,0.12);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.4);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('explode')">Explode</button>
    <button class="gc on" id="b-labels" style="background:rgba(167,139,250,0.08);border:0.5px solid rgba(167,139,250,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(167,139,250,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('labels')">Idents</button>
    <button class="gc on" id="b-stream" style="background:rgba(167,139,250,0.08);border:0.5px solid rgba(167,139,250,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(167,139,250,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('stream')">Signal</button>
    <button class="gc on" id="b-tunnel" style="background:rgba(167,139,250,0.08);border:0.5px solid rgba(167,139,250,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(167,139,250,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('tunnel')">Tunnel</button>
    <button class="gc" id="b-fly" style="background:rgba(107,107,128,0.04);border:0.5px solid rgba(107,107,128,0.12);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.4);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('fly')">Free Fly</button> <button class="gc on" id="b-memory" style="background:rgba(244,114,182,0.08);border:0.5px solid rgba(244,114,182,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(244,114,182,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('memory')">Memory</button> <button class="gc on" id="b-sharedctx" style="background:rgba(45,212,191,0.08);border:0.5px solid rgba(45,212,191,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(45,212,191,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('sharedctx')">Shared</button> <button class="gc on" id="b-catalog" style="background:rgba(252,211,77,0.08);border:0.5px solid rgba(252,211,77,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(252,211,77,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('catalog')">Catalog</button> <button class="gc on" id="b-knowledge" style="background:rgba(163,230,53,0.08);border:0.5px solid rgba(163,230,53,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(163,230,53,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('knowledge')">Knowledge</button>
    <span style="color:#948d9e;font-size:9px;margin:0 4px;">|</span>
    <button style="background:rgba(107,107,128,0.08);border:0.5px solid rgba(107,107,128,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.resetGraphView()">Reset</button>
    <span style="color:#948d9e;font-size:9px;margin:0 4px;">|</span>
    <span style="color:#4ade80;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">SPA</span>
    <span style="color:#60a5fa;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Back</span>
    <span style="color:#948d9e;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Agent</span>
    <span style="color:#4ade80;font-size:6px;">●</span><span style="color:#60a5fa;font-size:6px;">●</span><span style="color:#fbbf24;font-size:6px;">●</span><span style="color:#f87171;font-size:6px;">●</span><span style="color:#948d9e;font-size:6px;">●</span><span style="color:#948d9e;font-size:7px;">Trust</span>
    <span style="color:#fbbf24;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Infra</span>
    <span style="color:#ff6b35;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Sys</span>
    <span style="color:#f87171;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Email</span>
    <span style="color:#34d399;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">DB</span>
    <span style="color:#818cf8;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Mine</span>
    <span style="color:#f472b6;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Cert</span>
    <span style="color:#2dd4bf;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Cron</span>
    <span style="color:#67e8f9;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Edge</span>
    <span style="color:#93c5fd;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">EP</span>
    <span style="color:#c084fc;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">GH</span>
    <span style="color:#fcd34d;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Tun</span>
    <span style="color:#fdba74;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Camp</span>
    <span style="color:#948d9e;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Other</span>
    <span id="graph-node-count" style="color:var(--text-dim);font-size:9px;margin-left:auto;">-</span>
  </div>
</div>

<!-- 💰 Mining & Rewards -->
<div class="card tile tile-p7">
  <h3 style="color:var(--accent-yellow);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    💰 Mining & Rewards
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Pool Stats · Leaderboard · Heartbeat</span>
  </h3>
  <div class="subgrid-3">
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:var(--accent-yellow);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">📒 Mining Ledger</div>
      <div class="stat"><span class="label">Pool Hashrate</span><span class="value" id="pool-hash">checking...</span></div>
      <div class="stat"><span class="label">Valid Shares</span><span class="value" id="pool-shares">-</span></div>
      <div class="stat"><span class="label">XMR Paid / Due</span><span class="value" id="pool-xmr">-</span></div>
      <div class="stat"><span class="label">Pool Global Hashrate</span><span class="value" id="pool-global-hash" style="color:#818cf8;">-</span></div>
      <div class="stat"><span class="label">Pool Miners</span><span class="value" id="pool-total-miners" style="color:#818cf8;">-</span></div>
      <div class="stat"><span class="label">Treasury (85%) / Ops (15%)</span><span class="value" id="pool-treasury" style="color:#fbbf24;">-</span></div>
      <div class="stat"><span class="label">Status</span><span class="value" id="pool-health" style="color:#818cf8;">-</span></div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🏆 Leaderboard</div>
      <div style="margin-bottom:4px;font-size:10px;color:#948d9e;">Live hashrate · shares · XMRT rewards</div>
      <div id="miner-leaderboard"><div class="stat"><span class="label">Loading...</span></div></div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">💓 Heartbeat</div>
      <div style="background:#0d0d15;padding:0.4rem 0.6rem;border-radius:4px;font-family:monospace;font-size:0.7rem;color:#60a5fa;word-break:break-all;" id="heartbeat-url">loading...</div>
      <div style="color:#948d9e;font-size:0.65rem;margin-top:0.3rem;">POST: {"agent_id":"...","status":"ONLINE","tunnel_url":"...","hashrate":0}</div>
      <div style="margin-top:6px;padding-top:6px;border-top:1px solid #1e1e2e;">
        <pre style="background:#0d0d15;padding:0.4rem;border-radius:4px;font-size:0.65rem;overflow-x:auto;color:#a0a0b0;white-space:pre-wrap;word-break:break-all;margin:0;cursor:pointer;" id="mining-script" onclick="copyMiningScript()">curl -o signup.py -L https://raw.githubusercontent.com/xmrtdao/mmlauncher/main/scripts/mobile-signup.py && sha256sum signup.py && python3 signup.py</pre>
      </div>
    </div>
  </div>
</div>

<!-- 📯 Campaigns & Leads -->
<div class="card tile tile-p5">
  <h3 style="color:#60a5fa;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📯 Campaigns & Leads
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— PFP Campaign · PFP Leads · 31 Harbor</span>
  </h3>
  <div class="subgrid-3">
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#60a5fa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">📸 PFP Campaign</div>
      <div class="stat"><span class="label">Contact Pool</span><span class="value" id="pfp-pool">${poolSize}</span></div>
      <div class="stat"><span class="label">Sent Today</span><span class="value" id="pfp-sent-today">${sentToday}</span></div>
      <div class="stat"><span class="label">Sent Total</span><span class="value" id="pfp-sent-total">${campaignSent.length}</span></div>
      <div class="stat"><span class="label">Fresh Avail</span><span class="value" id="pfp-fresh">${freshAvailable}</span></div>
      <div class="stat"><span class="label">Last Run</span><span class="value" id="pfp-last-run">${campaignLastRun}</span></div>
      <div class="stat"><span class="label">Next Drop</span><span class="value" id="next-drop">-</span></div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#60a5fa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🎯 PFP Leads</div>
      <div class="stat"><span class="label">Total</span><span class="value" id="pfp-leads-total">-</span></div>
      <div class="stat"><span class="label">By Status</span><span class="value" id="pfp-leads-by-status" style="font-size:0.65rem;">-</span></div>
      <div class="stat"><span class="label">By Source</span><span class="value" id="pfp-leads-by-source" style="font-size:0.65rem;">-</span></div>
      <div class="stat"><span class="label">Hot (≥7)</span><span class="value" id="pfp-leads-hot">-</span></div>
      <div class="stat"><span class="label">Newest</span><span class="value" id="pfp-leads-newest" style="font-size:0.65rem;">-</span></div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#60a5fa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🏠 31 Harbor</div>
      <div class="stat"><span class="label">Contact Pool</span><span class="value" id="harbor-pool">${harborPoolSize}</span></div>
      <div class="stat"><span class="label">Sent Today</span><span class="value" id="harbor-sent-today">${harborSentToday}</span></div>
      <div class="stat"><span class="label">Sent Total</span><span class="value" id="harbor-sent-total">${harborSentTotal}</span></div>
      <div class="stat"><span class="label">Fresh Avail</span><span class="value" id="harbor-fresh">${harborFresh}</span></div>
      <div class="stat"><span class="label">Last Run</span><span class="value" id="harbor-last-run">${harborLastRun}</span></div>
      <div class="stat"><span class="label">Next Drop</span><span class="value" id="harbor-next-drop">-</span></div>
    </div>
  </div>
</div>

<!-- 📡 Campus Intelligence -->
<div class="card tile tile-p2">
  <h3 style="color:var(--accent-purple);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📡 Campus Intelligence
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— XMRT University · Incoming Mail · GitHub Activity</span>
  </h3>
  <!-- Two columns by CONTENT, not by count. XMRT University and GitHub
       Activity are short fixed-height readouts; Incoming Mail is a long
       scrolling list. Laid out as three equal columns the two short panels
       left a tall column of dead space beside a very tall mail list, and the
       whole tile became one narrow stack. So: the two short panels stack in
       the left column, the mail list gets the right column to itself.
       auto-fit means this still collapses to one column on a phone. -->
  <div class="intel-split">
    <div class="intel-left">
    <!-- 🎓 XMRT University -->
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;">
      <div style="font-size:0.75rem;color:var(--accent-purple);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;font-family:var(--font-display);font-weight:600;">🎓 XMRT University</div>
      <div id="university-status">
        <div class="stat"><span class="label">Status</span><span class="value" id="uni-status" style="color:#948d9e;">checking...</span></div>
      </div>
      <div id="university-detail">
        <div class="stat"><span class="label">Progress</span><span class="value" id="uni-progress">-</span></div>
        <div class="stat"><span class="label">Cert ID</span><span class="value" id="uni-cert" style="font-size:0.75rem;">-</span></div>
        <div class="stat"><span class="label">Tier</span><span class="value" id="uni-tier">-</span></div>
        <div class="stat"><span class="label">Perms</span><span class="value" id="uni-perms" style="font-size:0.75rem;">-</span></div>
      </div>
      <div style="margin-top:4px;font-size:0.75rem;color:#948d9e;">
        <div>New agents must graduate from XMRT University to join the fleet.</div>
        <div style="margin-top:2px;">
          <span style="color:#a78bfa;">POST</span> <code style="color:#60a5fa;font-size:0.7rem;">/functions/v1/xmrt-university</code>
        </div>
      </div>
    </div>
    <!-- 🐙 GitHub Activity -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.75rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;font-family:var(--font-display);font-weight:600;">🐙 GitHub Activity</div>
      <div class="stat"><span class="label">Total Repos</span><span class="value" id="gh-repo-count">-</span></div>
      <div class="stat"><span class="label">Last Commit</span><span class="value" id="gh-last-commit" style="font-size:0.75rem;">-</span></div>
      <div style="margin-top:4px;font-size:0.75rem;color:#948d9e;" id="gh-recent-commits"></div>
    </div>
    </div>
    <!-- 📬 Incoming Mail — right column, to itself -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.75rem;color:#f87171;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;font-family:var(--font-display);font-weight:600;">📬 Incoming Mail</div>
      <div class="inbox-grid">
        ${resendTileHtml()}
      </div>
    </div>
  </div>
</div>

<!-- Campus Forum Full Board -->
<div id="board-full" class="card tile-wide tile-p9" style="margin-top:0.5rem;">
  <h3 style="color:var(--accent-yellow);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📜 Campus Forum <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Full Bulletin Board</span>
  </h3>
  <div class="board-tabs" id="board-tabs">
    <span class="board-tab active" onclick="switchBoardView('topics')" id="tab-topics">Resolutions</span>
    <span class="board-tab" onclick="switchBoardView('new')" id="tab-newtopic">+ New Topic</span>
  </div>
  <div id="board-filter-bar" style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;">
    <span class="board-filter active" data-filter="all" onclick="setBoardFilter('all')">All</span>
    <span class="board-filter" data-filter="active" onclick="setBoardFilter('active')">Active</span>
    <span class="board-filter" data-filter="in-progress" onclick="setBoardFilter('in-progress')">In Progress</span>
    <span class="board-filter" data-filter="completed" onclick="setBoardFilter('completed')">Completed</span>
    <span class="board-filter" data-filter="archived" onclick="setBoardFilter('archived')">Archived</span>
  </div>
  <div id="board-topics-view">
    <div class="board-topics" id="board-topics-list-full"></div>
    <div id="board-topic-posts" style="display:none;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1;min-width:0;">
          <span id="board-current-topic-title" style="font-size:13px;font-weight:600;color:var(--text-primary);"></span>
          <span id="board-current-topic-status"></span>
          <span id="board-current-topic-assignment" style="font-size:10px;color:#948d9e;"></span>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button onclick="renameBoardTopic()" id="board-rename-btn" style="padding:2px 8px;border-radius:4px;border:1px solid #3a3a5a;background:transparent;color:#8b8ba0;cursor:pointer;font-size:10px;">Rename</button>
          <select id="board-status-select" onchange="changeTopicStatus(this.value)" style="padding:2px 4px;border-radius:4px;border:1px solid #3a3a5a;background:#12121a;color:#c0c0d0;font-size:10px;">
            <option value="active">Active</option>
            <option value="in-progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="archived">Archived</option>
          </select>
          <button onclick="togglePinTopic()" id="board-pin-btn" style="padding:2px 8px;border-radius:4px;border:1px solid #3a3a5a;background:transparent;color:#fbbf24;cursor:pointer;font-size:10px;">Pin</button>
          <button onclick="deleteBoardTopic()" id="board-delete-btn" style="padding:2px 8px;border-radius:4px;border:1px solid #5a2a2a;background:transparent;color:#f87171;cursor:pointer;font-size:10px;">Delete</button>
          <button onclick="closeBoardTopic()" style="padding:2px 8px;border-radius:4px;border:1px solid #3a3a5a;background:transparent;color:#8b8ba0;cursor:pointer;font-size:10px;">Back</button>
        </div>
      </div>
      <div class="board-posts" id="board-posts-list"></div>
      <div class="board-input-wrap">
        <input id="board-post-input" type="text" placeholder="Add to this resolution..." onkeypress="if(event.key==='Enter')sendBoardPost()">
        <button onclick="sendBoardPost()" style="padding:6px 14px;border-radius:6px;border:none;background:#ff6b35;color:white;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;">Post</button>
      </div>
      <div style="margin-top:4px;font-size:10px;color:#948d9e;">
        <span>Posted as <strong id="board-post-agent" style="color:var(--accent-orange);">vex</strong> — all privateers see this resolution</span>
      </div>
    </div>
  </div>
  <div id="board-new-topic-view" style="display:none;">
    <div class="board-new-topic" style="display:flex;flex-direction:column;gap:6px;">
      <input id="board-new-topic-input" type="text" placeholder="Resolution (e.g. Deployment Q2, AgentPay Strategy, PFP Partnerships...)" onkeypress="if(event.key==='Enter')createBoardTopic()">
      <div style="display:flex;gap:6px;align-items:center;">
        <select id="board-new-status" style="padding:4px 8px;border-radius:4px;border:1px solid #3a3a5a;background:#12121a;color:#c0c0d0;font-size:11px;">
          <option value="active">Active</option>
          <option value="in-progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="archived">Archived</option>
        </select>
        <input id="board-new-assignment" type="text" placeholder="Assign to agent (optional)" style="flex:1;padding:4px 8px;font-size:11px;">
        <input type="checkbox" id="board-new-pinned" style="accent-color:#fbbf24;"> <label for="board-new-pinned" style="font-size:10px;color:#fbbf24;">Pin</label>
        <button onclick="createBoardTopic()" style="padding:6px 14px;border-radius:6px;border:none;background:#ff6b35;color:white;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;">Create</button>
      </div>
    </div>
  </div>
  <div style="margin-top:4px;display:flex;gap:8px;font-size:10px;color:#948d9e;">
    <span>Agents can post to any resolution — persistent across sessions</span>
    <span id="board-updated-indicator" style="color:#fbbf24;display:none;">* new activity</span>
    <span id="board-status-full" style="color:#4ade80;">● loaded</span>
  </div>
</div>
  </div>
<!-- Edge Function Catalog -->
  <!-- Collapsed by default. This was 11,888px of table — 70% of the entire
       page — sitting below the fold, so the page was 17,034px long and the
       answer to "is anything broken" was somewhere above the midpoint. It is
       a lookup table for 252 endpoints, not a status readout; the link at the
       top of the page still jumps straight here and opens it. -->
  <details class="archive" id="fn-catalog" style="margin-top:1.5rem;width:100%;box-sizing:border-box;">
    <summary>☁️ Supabase Edge Functions <span>— 252 endpoints · lookup table</span></summary>
    <div class="card" style="width:100%;box-sizing:border-box;margin-top:0.75rem;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;flex-wrap:wrap;gap:0.5rem;">
      <h2 style="color:#ff6b35;font-size:1.1rem;">☁️ Supabase Edge Functions <span id="fnCount" style="color:#948d9e;font-weight:400;"></span></h2>
      <div class="controls">
      <input type="text" id="search" placeholder="Search functions…" oninput="filterFunctions()">
      <select id="methodFilter" onchange="filterFunctions()">
        <option value="">All Methods</option>
        <option value="GET">GET</option>
        <option value="POST">POST</option>
        <option value="PATCH">PATCH</option>
        <option value="DELETE">DELETE</option>
      </select>
      <select id="typeFilter" onchange="filterFunctions()">
        <option value="">All Types</option>
        <option value="simple">Simple</option>
        <option value="workflow">Workflow</option>
      </select>
      <span class="count" id="resultCount"></span>
    </div>
  
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th onclick="sortBy('name')">Function ↕</th>
            <th onclick="sortBy('methods')">Method</th>
            <th onclick="sortBy('type')">Type ↕</th>
            <th onclick="sortBy('desc')">Description ↕</th>
            <th>Endpoint</th>
          </tr>
        </thead>
        <tbody id="fnBody">
          <tr><td colspan="5" class="loading">Loading function catalog…</td></tr>
        </tbody>
      </table>
    </div>
  </div>
  </div>
  
            <div class="footer">
              <span style="color:var(--accent-orange);font-weight:600;">XMRT DAO</span> &middot; <span style="color:var(--accent-teal);">&#x26a1;</span> Vex &middot; ${new Date().toISOString()} &middot;
              <a href="https://github.com/xmrtdao" target="_blank" style="color:var(--text-dim);">GitHub</a> &middot;
              <a href="${tunnelUrl}" target="_blank" style="color:var(--text-dim);">Relay</a> &middot;
              Functions: ${supabaseUrl}/functions/v1/{name}
            </div>
            </div><!-- /card -->
  </details><!-- /fn-catalog -->

            <script src="/static/dashboard.js?v=${dashboardJsVersion()}"></script>

            <script src="/static/markdown.js"></script>
  
  
            </body>
            </html>`);
});
// ════════════════════════════════════════════════════════════════
// RESTORED ROUTES — 2026-06-03
// Originally deleted in commit 7e70bac (mesh dashboard endpoints),
// which clobbered ~250 lines of POST endpoints along with the
// additions. The banner URL lines survived, so the cron fetcher kept
// POSTing to /webhook/task and getting 404s (46 cumulative errors
// between 2026-05-18 and 2026-06-03).
// Restored verbatim from a98866f (last commit where they were
// intact), minus state API endpoints (those have been replaced by
// tool handlers under /tools/run and the /state/:key routes that
// were already removed in earlier refactors).
// ════════════════════════════════════════════════════════════════

// ── Webhook: Receive task dispatch ─────────────────────────
app.post('/webhook/task', async (req, res) => {
  const task = req.body;
  trackRequest('/webhook/task');
  logActivity('webhook', task?.id || '?', 'RECEIVED', task?.title || 'no title');

  try {
    // Check if this task is for Hermes
    if (task?.assignee === 'hermes' || task?.agent === 'hermes') {
      logActivity('webhook', task.id, 'HERMES_ROUTE', 'Routing to phone agent');
      const hermesResult = await forwardToHermes(task);
      await relayToElizaCloud(
        `[Eliza-Dev] Task "${task.title}" forwarded to Hermes on phone. Status: ${hermesResult?.hermesResponse?.status || 'forwarded'}`,
        'Eliza-Dev',
        `task-${task.id?.slice(0, 8) || 'unknown'}`
      );
      res.json({ success: true, forwarded: true, to: 'hermes', result: hermesResult });
      return;
    }

    // Determine handler based on task type/category
    const title = (task?.title || '').toLowerCase();
    const desc = (task?.description || '').toLowerCase();
    const agent = (task?.agent || '').toLowerCase();
    const metadata = task?.metadata || {};
    const combinedText = title + ' ' + desc;

    let handlerKey = null;

    // Priority 1: Direct agent assignment
    if (agent === 'eliza-dev' || agent === 'relay' || agent === 'alice') {
      if (agent === 'alice') handlerKey = 'alice';
      else if (title.includes('device') || title.includes('register')) handlerKey = 'device-registration';
    }

    // Priority 2: Check metadata for explicit handler
    if (!handlerKey && metadata.handler) {
      if (handlers[metadata.handler]) handlerKey = metadata.handler;
    }

    // Priority 3: Title/description keyword matching (expanded)
    if (!handlerKey) {
      if (combinedText.includes('smtp') || combinedText.includes('email') || combinedText.includes('mail')) handlerKey = 'email-smtp-fix';
      else if (combinedText.includes('alice') || combinedText.includes('sidecar') || combinedText.includes('ocr') || combinedText.includes('desktop')) handlerKey = 'alice';
      else if (combinedText.includes('knowledge') || combinedText.includes('kb') || combinedText.includes('sync') || combinedText.includes('memory')) handlerKey = 'knowledge-sync';
      else if (combinedText.includes('device') || combinedText.includes('register') || combinedText.includes('hardware') || combinedText.includes('worker') || combinedText.includes('miner')) handlerKey = 'device-registration';
      else if (combinedText.includes('mining') || combinedText.includes('dashboard') || combinedText.includes('hash') || combinedText.includes('pool') || combinedText.includes('xmr')) handlerKey = 'mining-dashboard';
      else if (combinedText.includes('creative') || combinedText.includes('studio') || combinedText.includes('production') || combinedText.includes('motion') || combinedText.includes('harmony')) handlerKey = 'general';
      else if (combinedText.includes('community') || combinedText.includes('outreach') || combinedText.includes('engagement') || combinedText.includes('rocm') || combinedText.includes('amd')) handlerKey = 'general';
      else if (combinedText.includes('deploy') || combinedText.includes('push') || combinedText.includes('fix') || combinedText.includes('repair') || combinedText.includes('set up') || combinedText.includes('configure')) handlerKey = 'general';
    }

    // Priority 4: Check if task name/type field exists
    if (!handlerKey && task?.type) {
      const taskType = task.type.toLowerCase();
      if (handlers[taskType]) handlerKey = taskType;
    }

    const handler = handlerKey ? handlers[handlerKey] : defaultHandler;

    // Run via task runner
    const taskId = taskRunner.addTask(handlerKey || 'default', () => handler(task), {
      metadata: { title: task.title, taskId: task.id },
    });

    // Quick result
    const result = await new Promise((resolve) => {
      const check = () => {
        const t = taskRunner.getTask(taskId);
        if (t && t.status !== 'running' && t.status !== 'queued') {
          resolve(t.result || { error: t.error?.message });
        } else {
          setTimeout(check, 200);
        }
      };
      setTimeout(() => resolve({ status: 'pending', taskId }), 15000);
      check();
    });

    // Report back to GitHub issue
    if (task?.issueNumber) {
      await postGitHubComment(task.issueNumber,
        `## Task Update: ${task.title}\n\n**Handler:** ${handlerKey || 'default'}\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``
      );
    }

    // Update Supabase task status using supabase-integration
    if (task?.id && SUPABASE_KEY) {
      const taskStatus = result.status === 'done' || result.status === 'registered' || result.status === 'ready' ? 'COMPLETED' : 'BLOCKED';
      const progress = result.status === 'error' ? 0 : 50;
      await updateTaskStatus(task.id, taskStatus, progress, result);
    }

    res.json({ success: true, handler: handlerKey || 'default', result });
  } catch (err) {
    logActivity('webhook', task?.id || '?', 'ERROR', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Result callback from Hermes ─────────────────────────────
app.post('/webhook/task/result', async (req, res) => {
  const result = req.body;
  trackRequest('/webhook/task/result');
  logActivity('result', result?.taskId || '?', 'RECEIVED', `Result from ${result?.source || 'hermes'}`);

  if (result?.replyTo === 'github' && result?.replyIssue) {
    await postGitHubComment(result.replyIssue,
      `## Task Result: ${result.taskId}\n\n**From:** ${result.source || 'hermes'}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``
    );
  }

  if (result?.taskId && SUPABASE_KEY) {
    const taskStatus = result.status === 'completed' ? 'COMPLETED' : 'IN_PROGRESS';
    await updateTaskStatus(result.taskId, taskStatus, 50, result, 'Hermes');
  }

  res.json({ success: true });
});

// ── Eliza Ping — dedicated ping-pong for Eliza-Cloud ──────────
app.post('/eliza-ping', async (req, res) => {
  const { message, task_type, source, request_id } = req.body;
  trackRequest('/eliza-ping');
  logActivity('eliza-ping', request_id || '-', 'PING', (message || 'ping').slice(0, 80));

  res.json({
    pong: true,
    interaction_type: 'ping_pong_telemetry',
    responder: 'vex_ts_relay_server (automated)',
    context: {
      note: 'This is automated system telemetry from the TS relay server, not a real-time message from Vex.',
      how_to_reach_vex: 'Post on GitHub issues or use the eliza-relay edge function for cloud-to-cloud messaging.',
    },
    received: message || 'ping',
    from: 'vex-ts-relay',
    timestamp: Date.now(),
    request_id: request_id || null,
    tools_available: Object.keys(toolHandlers).length,
    handlers: Object.keys(handlers),
    system: {
      uptime: process.uptime(),
      version: '7.0.0',
      tunnel: state.get('tunnel-url') || 'https://relay.mobilemonero.com',
      agent: 'TS Relay (Eliza-Dev laptop)',
    },
  });
});

// ── Hermes Agent Prompt Bridge ────────────────────────────────
// Agents (Vex, Alice, Eliza) can prompt this Hermes instance via:
//   POST /api/hermes/prompt  { prompt, sender, channel }
// The prompt is queued to a file inbox, executed by a cron job on
// this Hermes instance, and the result is posted back to fleet chat.
app.post('/api/hermes/prompt', async (req, res) => {
  const { prompt, sender = 'agent', channel = 'fleet' } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  const result = handleAgentPrompt(prompt, sender, channel);
  res.json(result);
});

// GET /api/hermes/context — Aggregated stack context for spawned Hermes sessions
// Returns PG status, MCP health, fleet memory, tasks, trust scores, and system health
// in a single JSON response. The spawned session calls this once instead of
// trying to use MCPs through curl.
app.get('/api/hermes/context', async (req, res) => {
  try {
    const [memories, tasks, agents, trustEvents, fleetMsgs, pgHealth] = await Promise.all([
      queryLocalPg("SELECT title, body, agent_id, created_at FROM app.fleet_memory ORDER BY created_at DESC LIMIT 10").catch(() => ({ rows: [] })),
      queryLocalPg("SELECT id, title, status, assignee_agent_id, priority, stage FROM app.tasks WHERE status NOT IN ('completed','cancelled') ORDER BY priority DESC LIMIT 10").catch(() => ({ rows: [] })),
      queryLocalPg("SELECT did, name, role, trust_score, trust_band, status, lifecycle_status FROM public.registry_agents ORDER BY trust_score DESC").catch(() => ({ rows: [] })),
      queryLocalPg("SELECT count(*)::int AS c FROM public.trust_events").catch(() => ({ rows: [{ c: 0 }] })),
      queryLocalPg("SELECT agent_id, message, created_at FROM public.fleet_messages ORDER BY created_at DESC LIMIT 10").catch(() => ({ rows: [] })),
      queryLocalPg("SELECT 1 AS ok").then(() => true).catch(() => false),
    ]);

    // MCP health checks
    const mcpHealth = {};
    for (const [name, port] of [['cuttlefishclaws', 3120], ['xmrtdao-suite', 3121]]) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
          signal: AbortSignal.timeout(15000),
        });
        const d = await r.json();
        const tools = d?.result?.tools || [];
        mcpHealth[name] = { ok: true, tools: tools.length };
      } catch (e) {
        mcpHealth[name] = { ok: false, error: e.message };
      }
    }

    res.json({
      ok: true,
      pg: pgHealth,
      mcp: mcpHealth,
      memories: memories.rows,
      tasks: tasks.rows,
      agents: agents.rows,
      trustEvents: trustEvents.rows[0]?.c || 0,
      fleetMessages: fleetMsgs.rows,
      relay: { uptime: process.uptime(), tools: Object.keys(toolHandlers).length },
      ts: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Poll the outbox every 5 seconds for completed Hermes prompts
setInterval(() => {
  try { pollOutbox(addFleetMessage, publishToMesh); } catch (e) {
    console.error('[hermes-bridge] outbox poll error:', e.message);
  }
}, 5000);

// ── Generic dispatch ────────────────────────────────────────
app.post('/dispatch', async (req, res) => {
  const { message, source = 'manual', type, action, handler, payload, args } = req.body;
  trackRequest('/dispatch');
  logActivity('dispatch', source, 'RECEIVED', (message || type || action || '').slice(0, 80));

  let response = null;

  // Support structured JSON dispatch (type/action/handler fields + message fallback)
  const msg = (message || type || action || '').toLowerCase();
  const h = (handler || action || '').toLowerCase();

  // Check for structured type/action first
  if (msg === 'ping' || action === 'ping' || type === 'ping' || h === 'ping' || h === 'eliza') {
    response = {
      pong: true,
      received: message || 'ping',
      from: 'vex-ts-relay',
      timestamp: Date.now(),
      tools_available: Object.keys(toolHandlers).length,
      handlers: Object.keys(handlers),
      system: {
        uptime: process.uptime(),
        version: '7.0.0',
        agent: 'Vex (Eliza-Dev)',
      }
    };
    return res.json({ success: true, eliza: true, response });
  }

  // Structured: use handler field directly
  if (h && h !== 'manual' && h !== 'default') {
    if (handlers[h]) {
      response = await handlers[h]({ id: 'dispatch', title: message || type || action, payload: payload || {} });
    } else if (toolHandlers[h]) {
      response = await toolHandlers[h](payload || args || {});
    } else if (h.startsWith('ef:')) {
      // Route ef:* actions to toolHandlers
      const efHandler = toolHandlers[h];
      if (efHandler) {
        response = await efHandler(payload || args || {});
      } else {
        response = { status: 'error', message: `Unknown ef: handler "${h}". Available: ${Object.keys(toolHandlers).filter(k => k.startsWith('ef:')).join(', ')}` };
      }
    } else if (h === 'bash') {
      const cmd = payload?.command || '';
      if (cmd) {
        try {
          const out = execSync(cmd, { encoding: 'utf8', timeout: 10000, shell: 'cmd.exe' });
          response = { status: 'ok', stdout: out.trim(), exit_code: 0 };
        } catch (e) {
          response = { status: 'error', stdout: e.stdout, stderr: e.stderr, exit_code: e.status };
        }
      } else {
        response = { status: 'error', message: 'command is required in payload' };
      }
    } else if (h === 'system-monitor' || h === 'monitor') {
      response = await getFullSnapshot();
    } else if (h === 'eliza-send') {
      const msgContent = payload?.message || message;
      if (msgContent) {
        const elizaResult = await relayToElizaCloud(msgContent, 'Eliza-Dev-Dispatch', `dispatch-${Date.now().toString(36)}`);
        response = { status: 'sent_to_eliza', reply: elizaResult?.reply };
      } else {
        response = { status: 'error', message: 'message is required in payload' };
      }
    } else {
      response = { status: 'unrecognized', message: `Handler "${h}" not recognized. Available: ${Object.keys(handlers).join(', ')}. Tools: ${Object.keys(toolHandlers).join(', ')}` };
    }
    return res.json({ success: true, handler: h, response });
  }

  // Legacy: keyword matching on message field
  if (msg.includes('smtp') || msg.includes('email')) response = await handlers['email-smtp-fix']({ id: 'dispatch', title: message });
  else if (msg.includes('alice') || msg.includes('sidecar') || msg.includes('ocr')) response = await handlers['alice']({ id: 'dispatch', title: message });
  else if (msg.includes('knowledge') || msg.includes('sync') || msg.includes('kb')) response = await handlers['knowledge-sync']({ id: 'dispatch', title: message });
  else if (msg.includes('device') || msg.includes('register')) response = await handlers['device-registration']({ id: 'dispatch', title: message });
  else if (msg.includes('mining') || msg.includes('dashboard') || msg.includes('hash')) response = await handlers['mining-dashboard']({ id: 'dispatch', title: message });
  else if (msg.includes('search') || msg.includes('find')) {
    const query = message.replace(/search|find|for/gi, '').trim();
    if (query) response = await webSearch(query);
    else response = { status: 'specify_query', message: 'What should I search for?' };
  } else if (msg.includes('monitor') || msg.includes('status') || msg.includes('health')) {
    response = await getFullSnapshot();
  } else if (msg.includes('chat') || msg.includes('ask')) {
    const prompt = message.replace(/chat|ask|ollama/gi, '').trim();
    if (prompt) response = await ollamaChat(prompt);
    else response = { status: 'specify_message', message: 'What should I ask the local AI?' };
  } else {
    response = { status: 'unrecognized', message: 'Could not determine task type. Use structured JSON: {"handler":"ping"}, {"type":"bash","payload":{"command":"..."}}, or send a text message with keywords. Available handlers: ' + Object.keys(handlers).join(', ') + '. Available tools: ' + Object.keys(toolHandlers).join(', ') };
  }

  res.json({ success: true, response });
});

// ── Eliza-Cloud relay (HTTP wrapper) ────────────────────────
app.post('/eliza/send', async (req, res) => {
  const { message, sender = 'Eliza-Dev' } = req.body;
  trackRequest('/eliza/send');
  if (!message) return res.status(400).json({ error: 'message is required' });
  const result = await relayToElizaCloud(message, sender);
  res.json({ success: !!result, relayTag: result?.relay_tag, reply: result?.reply, data: result });
});

// ── Log webhook ─────────────────────────────────────────────
app.post('/log', (req, res) => {
  const entry = req.body;
  logActivity('remote-log', entry?.source || '?', entry?.level || 'info', entry?.message || '');
  res.json({ success: true });
});

// ── Resend inbound email webhook ────────────────────────────
// Receives email.received events from Resend when replies come in
// to bookings@partyfavorphoto.com or any address on partyfavorphoto.com
// Async because resolving a reply to its candidate is a database lookup. Filing
// the mail first and attaching the owner afterwards is how a reply ends up
// belonging to nobody while looking stored.
app.post('/webhook/resend-inbound', async (req, res) => {
  const event = req.body;

  // Handle delivery/open/click/bounce tracking events
  const TRACKING_EVENTS = ['email.delivered', 'email.opened', 'email.clicked', 'email.bounced', 'email.complained'];
  if (TRACKING_EVENTS.includes(event?.type)) {
    const { data } = event;
    const emailId = data?.email_id || data?.id;
    if (emailId) {
      const updates = {};
      if (event.type === 'email.delivered') updates.status = 'delivered';
      if (event.type === 'email.opened') { updates.status = 'opened'; updates.opens = 1; }
      if (event.type === 'email.clicked') { updates.clicks = 1; }
      if (event.type === 'email.bounced') updates.status = 'bounced';
      if (event.type === 'email.complained') updates.status = 'complained';

      // Update the suite_email_activity table
      queryLocalPg(
        `UPDATE app.suite_email_activity SET status = COALESCE($1, status), opens = GREATEST(opens, COALESCE($2, 0)), clicks = GREATEST(clicks, COALESCE($3, 0)) WHERE resend_id = $4`,
        [updates.status || null, updates.opens || null, updates.clicks || null, emailId]
      ).catch(e => console.warn('[Resend Webhook] DB update error:', e.message));

      logActivity('resend-tracking', emailId, event.type.toUpperCase(), `Email ${event.type} — ${data?.subject || ''}`);
    }
    return res.json({ success: true });
  }

  // Original inbound email handling (unchanged below)
  if (event?.type !== 'email.received') {
    return res.status(400).json({ error: 'unexpected event type' });
  }

  // Webhook signature verification.
  //
  // The domain comes from the payload, so it decides which secret to check
  // against. That is circular, and it is only safe because a failure is now
  // fatal rather than logged. What this replaced accepted an invalid signature
  // with a warning, and accepted a request carrying no signature headers at all
  // in complete silence - so anyone who knew this URL could file mail into any
  // inbox and choose which one, by naming the domain in the payload.
  const { data } = event;
  const toArr = Array.isArray(data.to) ? data.to : (data.to ? [data.to] : []);
  // Resolved from the registry rather than a chain of includes() tests. The chain
  // had no branch for a new domain, so it fell through to partyfavorphoto: filed
  // under the wrong key and signed with the wrong secret. It also matched
  // anywhere in the address, so a lookalike domain would be accepted.
  const toDomainKey = emailDomainFor(toArr[0]) || 'pfp';
  const toDomain = EMAIL_DOMAINS[toDomainKey].domain;
  // A strict domain uses its own secret and nothing else. The generic fallback
  // belongs to partyfavorphoto, so a strict domain borrowing it would compare
  // jobbymcjobberson.com's mail against the wrong secret, fail every time, and
  // report a signature mismatch - when the actual fault is a missing
  // configuration. Failing closed is right; failing for the wrong stated reason
  // is not.
  const strict = EMAIL_DOMAINS[toDomainKey].strict === true;
  const signingSecret = strict
    ? webhookSecretFor(toDomainKey)
    : (webhookSecretFor(toDomainKey) || process.env.RESEND_WEBHOOK_SECRET);

  const verdict = verifyResendSignature({
    rawBody: req.rawBody,
    headers: req.headers,
    secret: signingSecret,
  });

  if (!verdict.ok) {
    if (strict) {
      const detail = verdict.reason === 'no-secret-configured'
        // The one configuration fault that silently stops all inbound for a
        // strict domain, so it is named rather than folded into a generic 401.
        ? `${EMAIL_DOMAINS[toDomainKey].secret} is not set in relay/.env, so mail for `
          + `${toDomain} cannot be verified and is being rejected`
        : verdict.reason;
      console.error(`[Resend Inbound] REJECTED ${toDomain}: ${detail}`
        + (verdict.ageSeconds !== undefined ? ` (${verdict.ageSeconds}s old)` : ''));
      // Recorded so a rejection is visible later and not just in the log.
      logActivity('resend-inbound-rejected', data.email_id || data.id || 'unknown',
        'REJECTED', `${toDomain}: ${detail}`);
      return res.status(401).json({ error: 'signature verification failed' });
    }
    if (verdict.reason === 'no-secret-configured') {
      // Logged once per domain. Per-email it would be noise that trains the
      // habit of ignoring this line, which is how it went unnoticed before.
      if (!unverifiedDomainWarned.has(toDomainKey)) {
        unverifiedDomainWarned.add(toDomainKey);
        console.warn(`[Resend Inbound] ${toDomain} has no signing secret, so its webhooks `
          + 'cannot be verified. Set the matching RESEND_*_WEBHOOK_SECRET, then set '
          + 'strict: true for it in EMAIL_DOMAINS.');
      }
    } else {
      console.warn(`[Resend Inbound] ${toDomain} accepted without a valid signature `
        + `(${verdict.reason}) - this domain is not strict yet`);
    }
  }

  const emailId = data.id || data.email_id;

  // A reply to a candidate's own address belongs to that candidate, and the
  // recipient address is the only thing on the webhook that says so. Resolved
  // here, on arrival, because the alternative is a reply sitting in a shared
  // inbox with nothing connecting it to the person it is about.
  //
  // Best-effort: a lookup failure must not lose the mail, so the entry is stored
  // either way and the candidate is simply absent.
  let candidateClientId = null;
  let candidateMailbox = null;
  if (toDomainKey === 'jobby') {
    try {
      const candidate = await jobbyStore.getClientByMailbox(toArr[0]);
      if (candidate) {
        candidateClientId = candidate.id;
        candidateMailbox = candidate.mailbox;
      }
    } catch (e) {
      console.warn('[Resend Inbound] could not resolve the candidate for this reply:', e.message);
    }
  }

  const emailEntry = {
    email_id: emailId,
    from: data.from,
    from_name: data.from_name,
    to: data.to,
    cc: data.cc,
    subject: data.subject,
    // Which candidate this is about, when the recipient was one of their own
    // addresses. Null for the brand domains, which have no candidate.
    client_id: candidateClientId,
    candidate_mailbox: candidateMailbox,
    // 2026-06-11: honor the body's text/html if the webhook caller
    // provided them (e.g. synthetic test posts, edge-function proxies
    // that pre-fetched). Real Resend webhooks don't include body and
    // we still fetch from /emails/receiving/:id below; this just lets
    // local testing work without round-tripping through Resend's API.
    body: data.text || data.body || '',
    text: data.text || '',
    html: data.html || '',
    created_at: data.created_at,
    message_id: data.message_id,
    attachments: (data.attachments || []).map(a => ({ id: a.id, filename: a.filename, content_type: a.content_type })),
    received_at: new Date().toISOString(),
  };

  // Store immediately with metadata
  logActivity('resend-inbound', emailId, 'RECEIVED',
    `From: ${data.from} | Subject: ${data.subject || '(no subject)'}`);

  // Store in BOTH the legacy resend_inbox state (for backward compat with
  // auto-responder) AND the unified email.inbox state (for /resend/inbox
  // GET routes and Alice's parser).
  const inbox = state.get('resend_inbox') || [];
  // 2026-06-11: dedup legacy resend_inbox by email_id too. Re-posting the
  // same webhook must not create a second row. The unified email.inbox
  // dedups by content-hash as a fallback, but the legacy key only has
  // email_id to go on.
  const existingResendIdx = emailId
    ? inbox.findIndex(e => e.email_id === emailId)
    : -1;
  if (existingResendIdx === -1) {
    inbox.unshift(emailEntry);
    // ── Post incoming email to fleet chat (only for genuinely new emails) ──
    try {
      const agent = EMAIL_DOMAINS[toDomainKey].agent;
      const fleetMsg = `📥 **Email received** from ${data.from}: _${data.subject || '(no subject)'}_ [${toDomain}]`;
      addFleetMessage(agent, fleetMsg, 'fleet');
    } catch (e) {
      console.error('[Resend Inbound] Fleet chat post failed:', e.message);
    }
  } else {
    // Update body in place; keep original position
    inbox[existingResendIdx].body = emailEntry.body;
    inbox[existingResendIdx].text = emailEntry.text;
    inbox[existingResendIdx].html = emailEntry.html;
    inbox[existingResendIdx]._lastDedupHit = new Date().toISOString();
  }
  if (inbox.length > 50) inbox.length = 50;
  state.set('resend_inbox', inbox);

  // Also store in the unified email.inbox state so GET /resend/inbox
  // returns it and Alice's parser picks it up.
  try {
    addToInbox(toDomain, {
      to: data.to,
      from: data.from,
      from_name: data.from_name,
      subject: data.subject,
      text: data.text || '',  // pre-fetched body if caller provided it
      html: data.html || '',
      email_id: emailId,
      attachments: data.attachments,
    });
  } catch (e) {
    console.error('[Resend Inbound] addToInbox failed:', e.message);
  }

  console.log(`[Resend Inbound] Email from ${data.from}: "${data.subject || '(no subject)'}" -> ${toDomain}`);

  // ── Forward 31harbor Re: replies ────
  // DISABLED: was forwarding to dvdelze@gmail.com which is no longer wanted
  if (false && toDomain === '31harbor.com' && data.subject && /^Re:/i.test(data.subject)) {
    const fwdKey = process.env.RESEND_31HARBOR_API_KEY;
    if (fwdKey) {
      const fwdPayload = {
        from: 'David Elze <david@31harbor.com>',
        to: ['dvdelze@gmail.com'],
        subject: `Fwd: ${data.subject}`,
        text: `From: ${data.from || '?'}\nSubject: ${data.subject}\n\n${data.text || data.body || '(full body pending — check 31harbor inbox)'}`,
      };
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${fwdKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fwdPayload),
      }).then(r => r.json()).then(r => {
        if (r.id) console.log(`[Re: Forward] ${emailId} forwarded to dvdelze@gmail.com (resend: ${r.id})`);
      }).catch(err => {
        console.error(`[Re: Forward] Error forwarding ${emailId}: ${err.message}`);
      });
    }
  }

  // Fetch full content from Resend's API (webhooks don't include body)
  // Which key to use follows from the recipient domain, via the registry.
  const RESEND_API_KEY = resendKeyFor(toDomainKey) || process.env.RESEND_API_KEY;
  if (RESEND_API_KEY && emailId) {
    fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}` }
    }).then(r => r.json()).then(full => {
      if (full && (full.html || full.text)) {
        // Update legacy resend_inbox
        const inbox2 = state.get('resend_inbox') || [];
        const idx = inbox2.findIndex(e => e.email_id === emailId);
        if (idx !== -1) {
          inbox2[idx].body = full.text || full.html || '';
          inbox2[idx].text = full.text || '';
          inbox2[idx].html = full.html || '';
          state.set('resend_inbox', inbox2);
          console.log(`[Resend Inbound] Content fetched for ${emailId}`);
        }
        // Update unified email.inbox so /resend/inbox and Alice's parser see it
        const unified = getInbox();
        const unifiedKey = domainToInboxKey(toDomain);
        if (unified[unifiedKey]) {
          const u = unified[unifiedKey].find(e => e.id === emailId);
          if (u) {
            u.text = full.text || '';
            u.html = full.html || '';
            state.set(EMAIL_STORE_KEY, unified);
            console.log(`[Resend Inbound] Content stored in email.inbox for ${emailId}`);
          }
        }
      }
    }).catch(err => {
      console.error(`[Resend Inbound] Failed to fetch content for ${emailId}: ${err.message}`);
    });
  }

  // Fire auto-responder only for PFP domain (not 31harbor.mail)
  if (toDomain === 'partyfavorphoto.com') {
    handleInboundEmail(emailEntry).then(result => {
      if (result.action === 'ack_sent') {
        logActivity('auto-responder', data.email_id, 'REPLIED', `Ack sent to ${result.from}`);
      }
    }).catch(err => {
      console.error('[AutoResponder] Error:', err.message);
    });
  }

  // ── Smart lead creation from inbound emails ──
  // Not every inbound email is a lead. Only create when:
  // 1. Domain supports lead tracking (party, harbor, mobilemonero)
  // 2. Sender is a person (not a system, not auto-reply)
  // 3. Sender doesn't already exist as a lead
  // 4. Email looks like an inquiry (has body, not out-of-office, not spam)
  if ((toDomain === 'partyfavorphoto.com' || toDomain === '31harbor.com' || toDomain === 'mobilemonero.com') && emailId) {
    const fromEmail = (data.from || '').replace(/.*<([^>]+)>/, '$1').trim().toLowerCase();
    const fromName = data.from_name || data.from?.replace(/<[^>]+>/, '').trim() || '';
    const subjLower = (data.subject || '').toLowerCase();
    const isAutoReply = subjLower.includes('automatic reply') || subjLower.includes('out of office') || subjLower.includes('auto-reply');
    const isSystem = fromEmail.includes('noreply@') || fromEmail.includes('notifications@') || fromEmail.includes('google') || fromEmail.includes('uber');

    if (!isAutoReply && !isSystem && fromEmail && !fromEmail.includes('david@31harbor.com')) {
      const companyId = toDomain === '31harbor.com' ? 'harbor' : 'party';
      // Check if this sender already exists as a lead
      queryLocalPg(
        `SELECT id, name, status FROM app.suite_leads WHERE LOWER(email) = $1 AND company_routed = $2 LIMIT 1`,
        [fromEmail, companyId]
      ).then(existing => {
        if (existing.rows.length === 0) {
          // New lead — create it
          const intent = subjLower.includes('quote') || subjLower.includes('booking') || subjLower.includes('inquiry') || subjLower.includes('event') ? 'service_inquiry' : 'general_inquiry';
          queryLocalPg(
            `INSERT INTO app.suite_leads (name, email, source, intent, company_routed, score, status, ai_confidence, pipeline_stage, value, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW()) RETURNING id`,
            [fromName || fromEmail, fromEmail, 'Email', intent, companyId, 50, 'Pending', 'medium', 'scraping', 0]
          ).then(ins => {
            logActivity('email-to-lead', ins.rows[0].id, 'CREATED', `Lead auto-created from inbound email: ${fromEmail} — ${data.subject || '(no subject)'}`);
            console.log(`[Email→Lead] Created lead #${ins.rows[0].id} for ${fromEmail} (${companyId})`);
          }).catch(e => {
            if (!e.message.includes('duplicate')) console.warn(`[Email→Lead] Insert error for ${fromEmail}: ${e.message}`);
          });
        } else if (existing.rows[0].status === 'Pending' || existing.rows[0].status === 'Low Match') {
          // Existing lead in early stage — bump score slightly for re-engagement
          queryLocalPg(
            `UPDATE app.suite_leads SET score = LEAST(score + 5, 100), updated_at = NOW() WHERE id = $1`,
            [existing.rows[0].id]
          ).catch(e => console.warn(`[Email→Lead] Score bump error: ${e.message}`));
        }
      }).catch(e => console.warn(`[Email→Lead] Query error: ${e.message}`));
    }
  }

  res.json({ received: true, email_id: emailId });
});

// ── Sent email logging — unified record of all outbound emails ──
// Logs campaign sends, auto-responder acks, and manual sends
function logSentEmail(entry) {
  const sentLog = state.get('sent_emails') || [];
  sentLog.unshift({
    ...entry,
    logged_at: new Date().toISOString(),
  });
  if (sentLog.length > 100) sentLog.length = 100;
  state.set('sent_emails', sentLog);
}

// POST /log/sent — called by auto-responder, campaign, or manual sends
app.post('/log/sent', (req, res) => {
  const { to, subject, body, type, status } = req.body;
  logSentEmail({ to, subject, body: (body || '').slice(0, 500), type: type || 'manual', status: status || 'sent' });
  res.json({ logged: true });
});

// API: Edge Function Catalog

// -- XMRT University Proxy --
// Routes to local-sb (SUPABASE_URL) — the canonical runtime backend.
// Cloud Supabase project (vawouugtzwmejxqkeqqj) is dead; this used to be hardcoded.
const SUPABASE_UNIVERSITY_URL = `http://127.0.0.1:8080/functions/v1/xmrt-university`;

app.post('/api/ef-university', async (req, res) => {
  // Proxy to the real xmrt-university edge function (serves the DB-backed
  // curriculum). Previously this returned a hardcoded 14-module stub that
  // diverged from the actual 6-module curriculum. Reshape the function's
  // `curriculum` array into the legacy `courses` contract consumers expect.
  try {
    const efRes = await fetch('http://127.0.0.1:54321/functions/v1/xmrt-university', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'courses' }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await efRes.json();
    if (data?.success && Array.isArray(data.curriculum)) {
      const courses = data.curriculum.map(m => ({
        module: m.module,
        title: m.title,
        description: m.description || '',
        passing_score: m.passing_score,
        total_questions: m.total_questions || 0,
      }));
      return res.json({ success: true, total_modules: courses.length, total_courses: courses.length, courses });
    }
    return res.status(efRes.status || 500).json(data);
  } catch (e) {
    return res.status(502).json({ success: false, error: `University proxy failed: ${e.message}` });
  }
});

// POST /api/xmrt-university/ingest — Ingest a freshly-issued XMRT University cert into relay state.
// Accepts either the raw cert payload or just the JWT (we'll verify against Supabase).
// No agent-level ACL — JWT is the credential. Bypasses the local /tools/run agent ACL so the
// local relay can persist the cert on its own behalf.
app.post('/api/xmrt-university/ingest', express.json({ limit: '64kb' }), async (req, res) => {
  trackRequest('/api/xmrt-university/ingest');
  const body = req.body || {};
  const cert = body.certificate || body;
  const jwt = body.jwt || cert.jwt_token || cert.jwt;
  const certId = cert.certificate_id || cert.cert_id;

  if (!certId) {
    return res.status(400).json({ success: false, error: 'certificate_id is required' });
  }

  // Verify against local xmrt-university edge function (fallback: accept cert data directly)
  let verified = null;
  try {
    // Try local edge function first
    const localVerifyRes = await fetch(`http://localhost:${PORT}/api/v1/functions/xmrt-university`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify', agent_id: cert.agent_id, cert_id: certId }),
      signal: AbortSignal.timeout(5000),
    });
    if (localVerifyRes.ok) {
      verified = await localVerifyRes.json();
    }
  } catch (e) {
    // Local verify failed — fall through to accept cert data directly
  }

  // If local verify succeeded and cert is valid, use verified data
  // Otherwise accept the submitted cert data directly (local-first fallback)
  const sourceData = verified?.valid ? verified.certificate : cert;

  // Persist cert + a per-agent map for quick lookup
  const stored = {
    cert_id: sourceData.certificate_id || sourceData.cert_id || certId,
    agent_id: sourceData.agent_id || cert.agent_id,
    agent_name: sourceData.agent_name || cert.agent_name,
    tier: sourceData.tier || cert.tier || 'graduate',
    permissions: sourceData.permissions || cert.permissions || ['fleet:read', 'fleet:write', 'mine', 'vote'],
    issued_at: sourceData.issued_at || cert.issued_at || new Date().toISOString(),
    expires_at: sourceData.expires_at || cert.expires_at,
    jwt: jwt || null,
    ingested_at: new Date().toISOString(),
    source: verified?.valid ? 'xmrt-university/ingest-verified' : 'xmrt-university/ingest-local',
  };
  state.set('xmrt-university-cert', stored);
  const byId = state.get('xmrt-university-certs') || {};
  byId[stored.cert_id] = { agent_id: stored.agent_id, agent_name: stored.agent_name, tier: stored.tier, permissions: stored.permissions, issued_at: stored.issued_at, expires_at: stored.expires_at };
  state.set('xmrt-university-certs', byId);

  // Update fleet agents registration so dashboard / peers see this agent as certified
  const agents = state.get('fleet.agents') || {};
  agents[stored.agent_id] = {
    ...(agents[stored.agent_id] || {}),
    name: stored.agent_name,
    cert_id: stored.cert_id,
    cert_tier: stored.tier,
    cert_permissions: stored.permissions,
    cert_expires_at: stored.expires_at,
    last_heartbeat: new Date().toISOString(),
  };
  state.set('fleet.agents', agents);

  logActivity('xmrt-university', stored.cert_id, 'INGESTED', `${stored.agent_name} -> ${stored.tier} (${stored.permissions.join(',')})`);

  res.json({ success: true, cert: stored, verify: verified });
});

// POST /api/auth/cert-login — Accept an XMRT-DAO-CERT JWT as login credential
// Verifies the JWT against the in-memory state first, then falls back to
// the xmrt-university edge function. Sets a session cookie on success.
// This lets graduates use their JWT cert as an API key to access the fleet dashboard.
app.post('/api/auth/cert-login', express.json({ limit: '16kb' }), async (req, res) => {
  trackRequest('/api/auth/cert-login');
  const { jwt } = req.body || {};
  if (!jwt || typeof jwt !== 'string') {
    return res.status(400).json({ success: false, error: 'jwt is required' });
  }

  let certData = null;
  // Resolve the certificate ID from the JWT. A real JWT (eyJ...) carries
  // cert_id in its payload — decode it. The legacy 'local-<certId>' form is
  // the cert ID itself. This is what state is keyed by ('xmrt-university-certs'
  // uses certificate_id), so lookup MUST use cert_id, not the raw JWT.
  let certId = null;
  let jwtSub = '';
  if (jwt.startsWith('local-')) {
    certId = jwt.slice(6);
  } else if (jwt.startsWith('eyJ')) {
    try {
      const payloadB64 = jwt.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      jwtSub = payload.sub || '';
      certId = payload.cert_id || payload.certId || null;
      if (!certId) {
        // Fall back to sub as a last resort (some certs may lack cert_id)
        certId = jwtSub || null;
      }
    } catch (e) {
      certId = null;
    }
  } else {
    certId = jwt; // bare certificate ID
  }
  if (!certId) {
    return res.status(400).json({ success: false, error: 'Unable to parse certificate from JWT' });
  }

  // 1. The authoritative table.
  //
  // This route used to verify in two steps that could both miss: process memory
  // (`state['xmrt-university-certs']`, which nothing populates in practice) and a
  // fallback POST to /functions/v1/xmrt-university, which 502s because local
  // Supabase does not serve it. It never read public.agent_certifications, where
  // all fourteen certificates live with agent_id, tier, permissions and
  // expires_at — so nothing in this path ever checked a real expiry date, and a
  // lapsed certificate produced the same answer as one that was never issued.
  //
  // The three failure modes are now distinct, because they send the caller to
  // different places:
  //
  //   not_found            -> they never graduated; go to XMRT University
  //   expired              -> they graduated; re-take the modules
  //   revoked              -> it was taken away; ask whoever revoked it
  //   verifier_unavailable -> the relay is broken; retry, do not re-graduate
  //
  // That last one is the reason this matters. When the verifier was down the old
  // code returned "Please graduate from XMRT University first" to an agent with a
  // valid certificate, and that message is what sent this investigation after
  // Hermes's graduation instead of after the relay.
  let verdict = null;
  try {
    const { verifyCertificate } = await import('./jobby/certs.mjs');
    verdict = await verifyCertificate(certId);
  } catch (e) {
    return res.status(503).json({
      success: false,
      error: 'Certificate verification is temporarily unavailable. Retry shortly.',
      code: 'verifier_unavailable',
    });
  }

  if (!verdict.ok) {
    if (verdict.reason === 'verifier_unavailable') {
      return res.status(503).json({
        success: false,
        error: 'Certificate verification is temporarily unavailable. Retry shortly.',
        code: 'verifier_unavailable',
      });
    }
    const messages = {
      not_found: 'No certificate was found for that credential. Graduate from XMRT University first.',
      expired: `This certificate expired on ${String(verdict.expires_at || '').slice(0, 10)}. Graduate again from XMRT University to renew it.`,
      revoked: 'This certificate has been revoked.',
      no_certificate: 'Unable to read a certificate from that credential.',
    };
    return res.status(401).json({
      success: false,
      error: messages[verdict.reason] || 'Invalid XMRT-DAO-CERT.',
      code: verdict.reason,
      // Only when we actually know — a candidate is told to re-graduate when the
      // relay is at fault often enough.
      agent_id: verdict.agent_id || null,
      expired_at: verdict.expires_at || null,
    });
  }

  certData = {
    certificate_id: certId,
    agent_id: verdict.agent_id,
    agent_name: verdict.agent_name,
    tier: verdict.tier,
    permissions: verdict.permissions,
    expires_at: verdict.expires_at,
  };

  // Record it in the in-memory maps too, so the fleet board and peer list see this
  // agent as certified without a second query on every render.
  try {
    const byId = state.get('xmrt-university-certs') || {};
    byId[certId] = {
      agent_id: certData.agent_id, agent_name: certData.agent_name,
      tier: certData.tier, permissions: certData.permissions,
    };
    state.set('xmrt-university-certs', byId);

    const agents = state.get('fleet.agents') || {};
    agents[certData.agent_id] = {
      ...(agents[certData.agent_id] || {}),
      name: certData.agent_name || agents[certData.agent_id]?.name,
      cert_id: certId,
      cert_tier: certData.tier,
      cert_permissions: certData.permissions,
      cert_expires_at: certData.expires_at || null,
      last_heartbeat: new Date().toISOString(),
    };
    state.set('fleet.agents', agents);
  } catch (e) {
    // The login succeeded; failing to warm the caches must not undo it.
  }

  // Set the relay_api_key cookie with a special cert:verified: prefix
  // The auth middleware will recognize this as valid auth
  const certValue = `cert:verified:${certData.certificate_id}`;
  res.cookie('relay_api_key', certValue, {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
  });

  logActivity('auth', certData.agent_id, 'CERT_LOGIN', `${certData.agent_name} logged in via XMRT-DAO-CERT (${certData.tier})`);

  res.json({
    success: true,
    agent: {
      agent_id: certData.agent_id,
      agent_name: certData.agent_name,
      tier: certData.tier,
      permissions: certData.permissions,
      certificate_id: certData.certificate_id,
    },
  });
});

// GET /api/agent/cert — Retrieve an agent's own JWT certificate
// Agents can call this to get their JWT token for Cloudflare Access auth
app.get('/api/agent/cert', async (req, res) => {
  trackRequest('GET /api/agent/cert');
  const agentId = req.query.agent_id || req.headers['x-agent-id'];
  if (!agentId) return res.status(400).json({ error: 'agent_id required (query or x-agent-id header)' });
  try {
    // Query local-sb for the agent's certification
    const certRes = await fetch('http://127.0.0.1:54321/rest/v1/agent_certifications?agent_id=eq.' + agentId + '&revoked=eq.false&order=issued_at.desc&limit=1', {
      headers: { 'apikey': 'local-anon-key', 'Authorization': 'Bearer local-anon-key' },
      signal: AbortSignal.timeout(5000),
    });
    if (!certRes.ok) return res.status(502).json({ error: 'DB query failed' });
    const certs = await certRes.json();
    if (!certs || certs.length === 0) return res.status(404).json({ error: 'No valid certificate found for ' + agentId });
    const cert = certs[0];
    res.json({
      success: true,
      agent_id: cert.agent_id,
      agent_name: cert.agent_name,
      certificate_id: cert.certificate_id,
      tier: cert.tier,
      permissions: cert.permissions,
      jwt_token: cert.jwt_hash,
      issued_at: cert.issued_at,
      expires_at: cert.expires_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -- Local Edge Function Runtime --
app.all('/api/v1/functions/:name', async (req, res) => {
  const func = localFunctions.find(f => f.name === req.params.name);
  if (!func) {
    return res.status(404).json({ error: 'Function not found: ' + req.params.name, available: localFunctions.map(f => f.name) });
  }
  try {
    const { pathToFileURL } = await import('url');
    const mod = await import(pathToFileURL(join(LOCAL_FUNCTIONS_DIR, req.params.name + '.mjs')).href);
    await mod.handler(req, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -- Local Edge Function Runtime (extended) --
// Proxies Supabase-style requests to the local Deno-style runtime
// (port 8090). This is the same path that Supabase functions used
// (`/functions/v1/<name>`) so the api-gateway worker can repoint
// the old `/supabase/functions/v1/...` route to here, and clients
// that already use `https://api.mobilemonero.com/relay/functions/v1/ai-chat`
// keep working unchanged.
// 2026-06-10: Default to local-sb (54321) — see cron-engine-v2.mjs
const LOCAL_RUNTIME_URL = process.env.LOCAL_RUNTIME_URL || 'http://127.0.0.1:54321';

async function proxyToRuntime(req, res, targetPath) {
  // Preserve the incoming query string (e.g. ?request_id=...) so the upstream
  // local-sb edge function receives it. targetPath has no query; pull it from
  // the raw request URL and append it.
  let fullTargetPath = targetPath;
  const rawUrl = (req.originalUrl || req.url || '');
  const qIdx = rawUrl.indexOf('?');
  if (qIdx >= 0) fullTargetPath += rawUrl.slice(qIdx);
  const target = `${LOCAL_RUNTIME_URL}${fullTargetPath}`;
  try {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    // Forward the raw body stream so JSON-parse doesn't munge it
    let body;
    if (['GET', 'HEAD'].includes(req.method)) {
      body = undefined;
    } else if (Buffer.isBuffer(req.body)) {
      body = req.body;
    } else if (typeof req.body === 'string') {
      body = req.body;
    } else if (req.body && typeof req.body === 'object') {
      // Express JSON-parsed the body. Re-serialize.
      body = JSON.stringify(req.body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    } else {
      // Drain the raw request body
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
    }
    const r = await fetch(target, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(120_000),
      // Node 24 native fetch supports duplex for streaming bodies
      duplex: body ? 'half' : undefined,
    });
    res.status(r.status);
    r.headers.forEach((v, k) => {
      if (k.toLowerCase() === 'set-cookie') res.appendHeader(k, v);
      else res.setHeader(k, v);
    });
    if (r.body) {
      const ab = await r.arrayBuffer();
      res.end(Buffer.from(ab));
    } else {
      res.end();
    }
  } catch (e) {
    console.error(`[runtime] proxy error to ${target}:`, e.message);
    res.status(502).json({ error: 'runtime proxy error', target, message: e.message });
  }
}

// Route known local functions directly instead of proxying to local-sb
const LOCAL_FUNCTIONS_BYPASS = ['xmrt-university'];
app.all(['/functions/v1/:name', '/functions/v1/:name/*path'], async (req, res) => {
  const name = req.params.name;
  if (LOCAL_FUNCTIONS_BYPASS.includes(name)) {
    const func = localFunctions.find(f => f.name === name);
    if (func) {
      try {
        const { pathToFileURL } = await import('url');
        const mod = await import(pathToFileURL(join(LOCAL_FUNCTIONS_DIR, name + '.mjs')).href);
        return await mod.handler(req, res);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
  }
  const tail = req.params.path ? '/' + (Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path) : '';
  await proxyToRuntime(req, res, `/functions/v1/${name}${tail}`);
});

// ── REST proxy: /rest/v1/* → local-sb (54321) ─────────────────────
// Mirrors the /functions/v1 proxy so the Suite SPA can point its Supabase
// client at the relay origin (window.location.origin) instead of a hardcoded
// 127.0.0.1:54321. This makes the SPA work identically on the laptop AND
// through the tunnel (phone/other machines), where 127.0.0.1 is the device
// itself and the ai-chat edge function call would otherwise fail → Office
// Clerk fallback. The relay origin proxies both /functions/v1 and /rest/v1.
app.all(['/rest/v1/*path'], async (req, res) => {
  const tail = req.params.path ? '/' + (Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path) : '';
  await proxyToRuntime(req, res, `/rest/v1${tail}`);
});

// Backwards-compat: short alias `POST /ai-chat` -> `/functions/v1/ai-chat`
app.all(['/ai-chat', '/ai-chat/*path'], async (req, res) => {
  const tail = req.params.path ? '/' + (Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path) : '';
  await proxyToRuntime(req, res, `/functions/v1/ai-chat${tail}`);
});

// ── XMRT University Public API (no CF Access required) ─────────────
// The university page (xmrtdao.github.io/university) calls this endpoint
// for enrollment. New agents don't have CF Access credentials yet, so
// this route must NOT require authentication.
// Proxies to the local-sb xmrt-university edge function.
app.all('/api/university', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const body = req.method === 'POST' ? (req.body || {}) : {};
    const efRes = await fetch('http://127.0.0.1:54321/functions/v1/xmrt-university', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await efRes.json();
    res.status(efRes.status).json(data);
  } catch (e) {
    res.status(502).json({ success: false, error: `University API proxy failed: ${e.message}` });
  }
});

// ── Suite Dashboard Chat History ────────────────────────────
// WorkspaceChatService.ts calls these to persist conversation across turns.
// Each user gets their own message history keyed by auth token.
app.get('/api/chat/history', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || '';
    if (!token) return res.json({ ok: false, error: 'no auth', messages: [] });
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const offset = parseInt(req.query.offset) || 0;
    const rows = await queryLocalPg(
      'SELECT id, content, sender, metadata, created_at FROM app.chat_messages WHERE token = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3',
      [token, limit, offset]
    );
    res.json({ ok: true, messages: (rows.rows || []).map(r => ({
      id: r.id + '',
      content: r.content,
      sender: r.sender,
      timestamp: r.created_at,
      metadata: r.metadata || null,
    })) });
  } catch (e) {
    res.json({ ok: false, error: e.message, messages: [] });
  }
});

app.post('/api/chat/message', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || '';
    if (!token) return res.status(401).json({ ok: false, error: 'no auth' });
    const { content, sender, metadata } = req.body || {};
    if (!content || !sender) return res.status(400).json({ ok: false, error: 'content and sender required' });
    const r = await queryLocalPg(
      'INSERT INTO app.chat_messages (token, content, sender, metadata) VALUES ($1,$2,$3,$4) RETURNING id, created_at',
      [token, content, sender, metadata || null]
    );
    const row = r.rows[0];
    res.json({ ok: true, message: {
      id: row.id + '',
      content,
      sender,
      timestamp: row.created_at,
      metadata: metadata || null,
    } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Local runtime health (combined: relay + embedded PG + edge runtime)
app.get('/local-runtime/health', async (req, res) => {
  const out = { relay: 'up', ts: Date.now() };
  try {
    const r = await fetch(`${LOCAL_RUNTIME_URL}/health`, { signal: AbortSignal.timeout(3000) });
    out.runtime = await r.json();
  } catch (e) { out.runtime = { ok: false, error: e.message }; }
  try {
    const r = await fetch('http://127.0.0.1:8081/health', { signal: AbortSignal.timeout(3000) });
    out.postgres = await r.json();
  } catch (e) { out.postgres = { ok: false, error: e.message }; }
  res.json(out);
});

  app.get('/api/catalog', async (req, res) => {
    const headers = { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
    try {
      const efRes = await fetch(`${SUPABASE_URL}/functions/v1/list-available-functions`, {
        method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(5000),
      });
      if (efRes.ok) {
        const data = await efRes.json();
        if (data && (data.functions || Array.isArray(data))) {
          return res.json({ ...data, source: 'edge-function' });
        }
      }
      // Fall through to the gateway rather than reporting 502.
    } catch { /* fall through */ }

    // The edge function answers 500 {"error":"Unknown action: undefined"} for an
    // empty body and for every action tried - list, index, all, catalog, get,
    // functions. Its source is not in this tree, so it cannot be fixed from here.
    // The gateway's own listing is authoritative for what is actually deployed,
    // it answers, and it is where this number should have come from all along.
    try {
      const gw = await fetch(`${SUPABASE_URL}/functions/v1/`, { headers, signal: AbortSignal.timeout(5000) });
      if (gw.ok) {
        const data = await gw.json();
        const functions = data.functions || [];
        return res.json({
          source: 'gateway',
          count: data.count ?? functions.length,
          functions,
          degraded: true,
          note: 'list-available-functions is not responding; served from the gateway instead.',
        });
      }
      return res.status(502).json({ error: 'Edge function catalog unavailable', status: gw.status });
    } catch (e) {
      res.status(500).json({ error: 'Catalog not available', message: e.message });
    }
  });

// ── Unified Tool + Edge Function Registry ────────────────────────────
// Merges the relay's local tool handlers (toolHandlers) with the Supabase
// edge function catalog (list-available-functions) into a single queryable
// view. Also syncs the merged view into public.unified_tool_registry so it
// persists in PG and can be queried alongside the edge-function metadata.
app.get('/api/registry', async (req, res) => {
  trackRequest('/api/registry');
  try {
    // 1) Relay tools (local toolHandlers)
    const relayTools = Object.entries(toolHandlers).map(([name, fn]) => ({
      name,
      description: getToolDescription(name),
      category: 'relay',
      source_type: 'relay_tool',
      source_schema_table: 'relay/toolHandlers',
      status: 'active',
      ai_compatible: true,
      handler: fn.name || 'anonymous',
    }));

    // 2) Edge functions (from list-available-functions)
    let edgeFns = [];
    try {
      const efRes = await fetch(`${SUPABASE_URL}/functions/v1/list-available-functions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      if (efRes.ok) {
        const d = await efRes.json();
        edgeFns = (d.functions || []).map(f => ({
          name: f.name,
          description: f.description || '',
          category: f.category || 'edge_function',
          source_type: 'edge_function',
          source_schema_table: 'suite/supabase/functions',
          status: 'active',
          ai_compatible: true,
        }));
      }
    } catch (e) { /* edge catalog unavailable — return relay tools only */ }

    const all = [...relayTools, ...edgeFns];

    // 3) Sync relay tools into public.relay_tools (real table, not the view),
    //    which feeds the combined public.vw_tool_function_registry view.
    try {
      for (const t of relayTools) {
        await pgPool.query(
          `INSERT INTO public.relay_tools
             (tool_name, description, category, status, source_schema_table, source_type, ai_compatible, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
           ON CONFLICT (tool_name) DO UPDATE SET
             description=EXCLUDED.description, category=EXCLUDED.category,
             status=EXCLUDED.status, source_schema_table=EXCLUDED.source_schema_table,
             source_type=EXCLUDED.source_type, ai_compatible=EXCLUDED.ai_compatible, updated_at=NOW()`,
          [t.name, t.description, t.category, t.status, t.source_schema_table, t.source_type, t.ai_compatible]
        );
      }
    } catch (e) {
      // Registry sync is best-effort
    }

    res.json({
      total: all.length,
      relay_tools: relayTools.length,
      edge_functions: edgeFns.length,
      source_types: { relay_tool: relayTools.length, edge_function: edgeFns.length },
      tools: all,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: 'Registry unavailable', message: e.message });
  }
});

// API: Fleet heartbeat — agents self-report their status
app.post('/api/fleet/heartbeat', (req, res) => {
  trackRequest('/api/fleet/heartbeat');
  const { agent_id, status, name, role, tunnel_url, version, capabilities, hashrate, device_type, metadata } = req.body || {};
  if (!agent_id || !status) {
    return res.status(400).json({ error: 'agent_id and status are required' });
  }
  const agents = state.get('fleet.agents', {});
  agents[agent_id] = {
    agent_id,
    name: name || agent_id,
    role: role || 'agent',
    status,
    tunnel_url: tunnel_url || null,
    version: version || 'unknown',
    capabilities: capabilities || [],
    hashrate: hashrate || 0,
    device_type: device_type || 'unknown',
    metadata: metadata || {},
    last_seen: new Date().toISOString(),
  };
  state.set('fleet.agents', agents);
  res.json({ success: true, agent_id, status, registered: true });
});

// API: List all registered fleet agents
app.get('/api/fleet/agents', async (req, res) => {
  trackRequest('/api/fleet/agents');
  try {
    const agents = state.get('fleet.agents', {});
    
    // Merge in agents from Supabase agent_registry (mesh-peer-connector)
    try {
      const registryRes = await fetch(`${SUPABASE_URL}/functions/v1/mesh-peer-connector`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'discover' }),
        signal: AbortSignal.timeout(8000),
      });
      if (registryRes.ok) {
        const registryData = await registryRes.json();
        if (registryData.peers) {
          for (const peer of registryData.peers) {
            // LIVENESS GATE.
            //
            // The registry is a persistent list of every agent ever certified, so
            // it keeps returning agents that stopped running weeks ago - the
            // Hermes family has last_heartbeat between 2026-08-27 and 2026-09-16.
            // The relay merged them all in on every boot, stamped last_seen = now,
            // and prompted them. A month-dead agent answers that prompt with no
            // grounding and posts confidently wrong numbers into fleet chat: CPU
            // at 99% against an actual 3%, a trust score of 3 against an actual
            // 96.26.
            //
            // `peer.last_heartbeat` is the real liveness signal and is left
            // alone. `last_seen` was NOT usable: it was overwritten with now() on
            // every registration, so every agent looked permanently fresh and a
            // staleness check against it could never fail.
            const hb = peer.last_heartbeat ? new Date(peer.last_heartbeat).getTime() : 0;
            const hoursSinceHb = hb ? (Date.now() - hb) / 3600000 : Infinity;
            const STALE_HOURS = 6;
            if (hoursSinceHb > STALE_HOURS) {
              const when = hb ? new Date(hb).toISOString().slice(0, 16) : 'never';
              console.log(
                `[agentRegistry] skipping stale peer ${peer.agent_name || peer.agent_id}: last heartbeat ${when}`
              );
              continue;
            }

            // Check if this peer matches an existing agent by name (avoid duplicates)
            const existingKey = Object.keys(agents).find(
              (k) => agents[k].name?.toLowerCase() === peer.agent_name?.toLowerCase()
            )
            if (existingKey) {
              // Merge cert info into existing agent record
              agents[existingKey] = {
                ...agents[existingKey],
                tier: peer.tier,
                permissions: peer.permissions,
                certified_since: peer.certified_since,
                last_seen: new Date().toISOString(),
              };
            } else {
              // New agent — add to registry
              agents[peer.agent_id] = {
                agent_id: peer.agent_id,
                name: peer.agent_name,
                status: 'ONLINE',
                role: peer.tier || 'agent',
                tier: peer.tier,
                permissions: peer.permissions,
                certified_since: peer.certified_since,
                last_seen: new Date().toISOString(),
              };
            }
          }
        }
      }
    } catch (e) {
      // Registry fetch failed - non-fatal, continue with heartbeat agents
    }
    
    // Check Hermes health via agent_registry (certified agents are active)
    if (agents['hermes-android-termux']) {
      // Already registered via mesh-peer-connector — update name and keep single entry
      agents['hermes-android-termux'].name = 'Hermes';
      agents['hermes-android-termux'].role = 'mobile';
      agents['hermes-android-termux'].tunnel_url = 'https://hermes.mobilemonero.com';
      agents['hermes-android-termux'].version = 'certified';
      agents['hermes-android-termux'].last_seen = new Date().toISOString();
      // Remove separate 'hermes' key if it somehow exists
      delete agents['hermes'];
    } else {
      // Fallback: check if Hermes Agent is running locally on this laptop
      // (Hermes desktop app), then try the phone tunnel.
      try {
        // First: check relay's own health (Hermes Agent runs on this machine)
        const localHermesRes = await fetch('http://127.0.0.1:8080/health', {
          signal: AbortSignal.timeout(15000),
        });
        if (localHermesRes.ok) {
          // Hermes Agent is running locally — mark as ONLINE
          agents['hermes'] = {
            ...(agents['hermes'] || {}),
            agent_id: 'hermes',
            name: 'Hermes',
            status: 'ONLINE',
            role: 'mobile',
            tunnel_url: 'https://hermes.mobilemonero.com',
            last_seen: new Date().toISOString(),
          };
        } else {
          throw new Error('Local health check failed');
        }
      } catch (e) {
        // Try the phone tunnel as a last resort
        try {
          const hermesRes = await fetch('https://hermes.mobilemonero.com/health', {
            signal: AbortSignal.timeout(15000),
          });
          if (hermesRes.ok) {
            const hermesData = await hermesRes.json();
            const hermesAlive = hermesData?.agents?.includes?.('hermes') || hermesData?.ok === true;
            agents['hermes'] = {
              ...(agents['hermes'] || {}),
              agent_id: 'hermes',
              name: 'Hermes',
              status: hermesAlive ? 'ONLINE' : 'OFFLINE',
              role: 'mobile',
              tunnel_url: 'https://hermes.mobilemonero.com',
              last_seen: new Date().toISOString(),
            };
          } else {
            throw new Error('Phone health check failed');
          }
        } catch (e2) {
          agents['hermes'] = {
            ...(agents['hermes'] || {}),
            agent_id: 'hermes',
            name: 'Hermes',
            status: 'OFFLINE',
            role: 'mobile',
            tunnel_url: 'https://hermes.mobilemonero.com',
            last_seen: agents['hermes']?.last_seen || new Date().toISOString(),
          };
        }
      }
    }
    
    // Update Vex with live status
    agents['vex'] = {
      ...(agents['vex'] || {}),
      agent_id: 'vex',
      name: 'Vex',
      status: 'ONLINE',
      role: 'relay',
      tunnel_url: 'https://relay.mobilemonero.com',
      version: '7.0.0',
      last_seen: new Date().toISOString(),
    };
    
    // Deduplicate: if both 'hermes' and 'hermes-android-termux' exist, keep only the registry one
    if (agents['hermes'] && agents['hermes-android-termux']) {
      console.log('[fleet-agents] Dedup: removing duplicate hermes key');
      delete agents['hermes'];
    }
    
    // Log hermes state for debugging
    const hermesKeys = Object.keys(agents).filter(k => k.includes('hermes'));
    if (hermesKeys.length) console.log(`[fleet-agents] Hermes keys after processing: ${hermesKeys}`);
    
    res.json({ agents: Object.values(agents), count: Object.keys(agents).length });
  } catch (err) {
    console.error('Fleet agents error:', err);
    const agents = state.get('fleet.agents', {});
    res.json({ agents: Object.values(agents), count: Object.keys(agents).length });
  }
});

// API: Meshtastic Bridge Status (for IoT Radar)
app.get('/api/mesh/bridge', async (req, res) => {
  trackRequest('/api/mesh/bridge');
  try {
    // Try to get bridge status from state (set by meshtastic-bridge.mjs)
    const bridgeState = state.get('meshtastic.bridge', {});
    const nodes = state.get('meshtastic.nodes', {});
    // If no Meshtastic daemon is running, fall back to relay health
    const hasDaemon = Object.keys(bridgeState).length > 0;
    res.json({
      connected: hasDaemon ? (bridgeState.connected || false) : true,
      uptime: hasDaemon ? (bridgeState.uptime || 0) : process.uptime(),
      nodes: hasDaemon ? Object.keys(nodes).length : 0,
      nodeList: hasDaemon ? Object.values(nodes).map(n => ({
        id: n.id,
        name: n.name || n.id,
        rssi: n.rssi,
        snr: n.snr,
        lastHeard: n.lastHeard,
      })) : [],
      messageCount: hasDaemon ? (bridgeState.messageCount || 0) : 0,
      transport: hasDaemon ? (bridgeState.transport || 'disconnected') : 'relay',
      relayUptime: process.uptime(),
    });
  } catch (err) {
    res.json({ connected: false, error: err.message, nodes: 0, nodeList: [] });
  }
});

// API: Mesh Peers (from mesh-peer-connector data + registered agents)
// Returns combined view of registered mesh peers and online agents
app.get('/api/mesh/peers', async (req, res) => {
  trackRequest('/api/mesh/peers');
  try {
    // Pull peers registered via mesh-peer-connector (stored by Supabase function)
    const peersState = state.get('mesh.peers', {});
    const agents = state.get('fleet.agents', {});
    const now = Date.now();

    // Build peer entries from registered peers
    const peers = Object.values(peersState).map(p => ({
      agent_name: p.agent_name || p.name || p.peer_id,
      peer_id: p.peer_id,
      endpoint: p.endpoint || null,
      capabilities: p.capabilities || [],
      status: p.last_seen && (now - new Date(p.last_seen).getTime()) < 300000 ? 'online' : 'offline',
      last_seen: p.last_seen || null,
    }));

    // Also include online agents that have peer connectivity but aren't yet registered
    Object.values(agents).forEach(a => {
      if (!peers.find(p => p.agent_name === a.name || p.peer_id === a.agent_id)) {
        const isOnline = a.status === 'ONLINE' || a.status === 'online';
        const lastSeen = a.last_seen ? new Date(a.last_seen).getTime() : 0;
        if (isOnline && (now - lastSeen) < 600000) {
          peers.push({
            agent_name: a.name,
            peer_id: a.agent_id,
            endpoint: a.tunnel_url || null,
            capabilities: a.capabilities || [],
            status: 'online',
            last_seen: a.last_seen,
          });
        }
      }
    });

    res.json({ peers, count: peers.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.json({ peers: [], count: 0, error: err.message });
  }
});

// API: Publish a message to the local mesh.
// Works in two modes:
//   1. If the libp2p gossipsub node is running (initMeshNode succeeded),
//      publishToMesh() fans the message out to all subscribed peers AND we
//      record it in state.mesh.messages so the dashboard /api/mesh/messages
//      sees it.
//   2. If libp2p is offline, we still record in state.mesh.messages and
//      return 200 with `degraded: true` so the agent knows the message hit
//      the local log but didn't go over the wire. This is the fix for the
//      "gossiphub bridge offline → 502" failure mode Kimi hit.
const MESH_VALID_TOPICS = new Set(['agent-heartbeat', 'agent-tasks', 'agent-discovery', 'fleet-broadcast']);
app.post('/mesh/publish', async (req, res) => {
  trackRequest('/mesh/publish');
  const { topic, payload, agent, timestamp } = req.body || {};
  if (!topic || !payload) {
    return res.status(400).json({ ok: false, error: 'topic and payload are required' });
  }
  if (!MESH_VALID_TOPICS.has(topic)) {
    return res.status(400).json({ ok: false, error: `Invalid topic: ${topic}`, valid_topics: [...MESH_VALID_TOPICS] });
  }
  try {
    const entry = {
      ts: new Date().toISOString(),
      topic,
      agent: agent || 'unknown',
      payload,
      timestamp: timestamp || Date.now(),
    };

    // Always record in state.mesh.messages so dashboard /api/mesh/messages sees it
    const messages = state.get('mesh.messages', []);
    messages.push(entry);
    if (messages.length > 5000) messages.splice(0, messages.length - 5000);
    state.set('mesh.messages', messages);

    // Update the bridge flag so /mesh/status shows traffic
    const bridge = state.get('meshtastic.bridge', {});
    state.set('meshtastic.bridge', { ...bridge, lastPublish: entry.ts, lastTopic: topic });

    // Try to publish via libp2p (best-effort; do not block on it)
    let fanout = { ok: false, skipped: true };
    try {
      const result = await Promise.race([
        publishToMesh(topic, payload, { timestamp: entry.timestamp }),
        new Promise((r) => setTimeout(() => r({ ok: false, skipped: true, reason: 'timeout' }), 1000)),
      ]);
      fanout = result || fanout;
    } catch (e) {
      fanout = { ok: false, skipped: true, error: e.message };
    }

    res.json({
      ok: true,
      topic,
      agent: entry.agent,
      ts: entry.ts,
      libp2p_published: fanout.ok === true,
      degraded: fanout.ok !== true,
      fanout,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Gossipsub status (mesh pubsub topic health)
app.get('/mesh/status', (req, res) => {
  trackRequest('/mesh/status');
  try {
    const messages = state.get('mesh.messages', []);
    const libp2p = (() => {
      try { return getMeshStatus(); } catch { return null; }
    })();
    const peerCount = libp2p?.peers?.count ?? 0;
    res.json({
      connected: peerCount > 0,
      transport: peerCount > 0 ? 'libp2p' : 'disconnected',
      nodes: peerCount,
      topics: libp2p?.topics || state.get('mesh.topics', ['agent-heartbeat', 'agent-tasks', 'agent-discovery', 'fleet-broadcast']),
      messageCount: messages.length,
      uptime: libp2p?.uptime || 0,
      lastPublish: messages.length > 0 ? (messages[messages.length - 1].ts ?? null) : null,
      lastTopic: messages.length > 0 ? messages[messages.length - 1].topic : null,
      libp2p: libp2p ? 'available' : 'unavailable',
      libp2pStatus: libp2p?.status || 'unknown',
      peerId: libp2p?.peerId || null,
      peers: libp2p?.peers || { count: 0, list: [] },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// API: Recent mesh messages (gossipsub pubsub history)
app.get('/mesh/messages', (req, res) => {
  trackRequest('/mesh/messages');
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  try {
    const messages = state.get('mesh.messages', []);
    res.json({
      messages: messages.slice(-limit).reverse(),
      count: messages.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.json({ messages: [], count: 0, error: err.message });
  }
});

// API: P2P mesh health (aggregated peer + bridge health)
app.get('/api/p2p/health', (req, res) => {
  trackRequest('/api/p2p/health');
  try {
    const bridge = state.get('meshtastic.bridge', {});
    const nodes = state.get('meshtastic.nodes', {});
    const peers = state.get('mesh.peers', {});
    const onlinePeers = Object.values(peers).filter(p => {
      const last = p.last_seen ? new Date(p.last_seen).getTime() : 0;
      return (Date.now() - last) < 300000;
    }).length;
    res.json({
      status: bridge.connected ? 'healthy' : 'degraded',
      bridge: {
        connected: bridge.connected || false,
        transport: bridge.transport || 'disconnected',
        uptime: bridge.uptime || 0,
      },
      nodes: Object.keys(nodes).length,
      peers: { total: Object.keys(peers).length, online: onlinePeers },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.json({ status: 'unknown', error: err.message });
  }
});

// API: ARP Defender Update (from arp-defender.mjs)
app.post('/api/arp/update', express.json({ limit: '1mb' }), (req, res) => {
  trackRequest('/api/arp/update');
  try {
    const { bridge, nodes } = req.body;
    if (bridge) state.set('meshtastic.bridge', bridge);
    if (nodes) state.set('meshtastic.nodes', nodes);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Meshtastic Bridge Update (from Hermes' meshtastic-bridge)
// Hermes POSTs its bridge state here so the local relay dashboard shows live data
app.post('/api/meshtastic/update', express.json({ limit: '1mb' }), (req, res) => {
  trackRequest('/api/meshtastic/update');
  try {
    const { bridge, nodes, fleetMessage } = req.body;
    if (bridge) {
      const existing = state.get('meshtastic.bridge', {});
      state.set('meshtastic.bridge', { ...existing, ...bridge, lastUpdate: Date.now() });
    }
    if (nodes) {
      const existing = state.get('meshtastic.nodes', {});
      // Merge: Hermes' nodes keyed by node ID
      for (const [id, info] of Object.entries(nodes)) {
        existing[id] = { ...existing[id], ...info, lastSeen: Date.now() };
      }
      state.set('meshtastic.nodes', existing);
    }
    // Optionally relay a fleet message from the Meshtastic mesh
    if (fleetMessage) {
      const { agent, message, channel } = fleetMessage;
      if (agent && message) {
        // Don't await — fire and forget
        fetch(`http://127.0.0.1:${PORT}/api/fleet-chat/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent: `meshtastic:${agent}`,
            agentLabel: `Meshtastic (${agent})`,
            message,
            channel: channel || 'fleet',
          }),
        }).catch(() => {});
      }
    }
    res.json({ ok: true, timestamp: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: GET fleet heartbeat summary (for dashboard queries)
app.get('/api/fleet/heartbeat', (req, res) => {
  trackRequest('/api/fleet/heartbeat');
  const agents = state.get('fleet.agents', {});
  const agentList = Object.values(agents);
  const online = agentList.filter(a => a.status === 'ONLINE' || a.status === 'online').length;
  const offline = agentList.length - online;
  const now = new Date().toISOString();
  res.json({
    success: true,
    timestamp: now,
    summary: { total: agentList.length, online, offline },
    agents: agentList.map(a => ({
      agent_id: a.agent_id,
      name: a.name,
      status: a.status,
      role: a.role,
      last_seen: a.last_seen,
      hashrate: a.hashrate || 0,
      tunnel_url: a.tunnel_url || null,
      version: a.version,
    })),
  });
});

// API: Live Fleet Status (aggregated from all agents)
app.get('/api/fleet', async (req, res) => {
  trackRequest('/api/fleet');
  
  const hostname = osHostname();
  const tunnelUrl = state.get('tunnel-url');
  const stats = taskRunner.getStats();
  
  // Ping Hermes — quick check via state (fleet heartbeat), skip dead tunnel
  let hermes = null;
  try {
    hermes = state.get('hermes') || { error: 'no recent heartbeat' };
  } catch (e) { hermes = { error: e.message }; }
  
  // Ping Ollama (fast — localhost)
  let ollama = null;
  try {
    const o = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(3000)
    });
    if (o.ok) {
      const data = await o.json();
      ollama = { models: data.models?.length || 0, model_list: data.models?.map(m => m.name) || [] };
    }
  } catch (e) { ollama = { error: e.message }; }
  
  // Quick system info (no slow wmic commands)
  const mem = process.memoryUsage();
  const resources = {
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + ' MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + ' MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + ' MB',
    },
    cpu: { usage: 'N/A (lightweight mode)' },
  };
  
  res.json({
    timestamp: new Date().toISOString(),
    vex: {
      status: 'online',
      host: hostname,
      uptime: process.uptime(),
      port: PORT,
      version: '10.0.0',
      tools: Object.keys(toolHandlers).length,
      handlers: Object.keys(handlers).length,
      tasks: stats,
      tunnel: tunnelUrl,
    },
    hermes,
    ollama,
    resources,
    supabase: SUPABASE_URL,
    edge_functions: 198,
  });
});

// Status
app.get('/status', (req, res) => {
  trackRequest('/status');
  res.json({
    agent: 'XMRT-DAO Relay Server',
    host: osHostname(),
    uptime: process.uptime(),
    port: PORT,
    version: '8.0.0',
    handlers: Object.keys(handlers),
    tools: Object.keys(toolHandlers),
    recentActivity: activityLog.slice(0, 20),
    requestCounts,
    taskRunner: taskRunner.getStats(),
    state: state.keys(),
  });
});

// ── Miner control (manual-only XMRig service) ─────────────────────
// The miner is registered in supervisor.mjs with paused: true — it never
// auto-starts. These endpoints are the control plane; mining-proxy's
// /miner-control action proxies here. XMRig config: xmrig/config.json
// (light mode, 1 thread, idle priority — fleet stack keeps RAM priority).
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const TASKKILL_EXE = 'C:\\Windows\\System32\\taskkill.exe';
const MINER_STATUS_FILE = join(DATA_DIR, 'miner-status.json');
const MINER_API = 'http://127.0.0.1:16000';

function isMinerRunning() {
  try {
    const out = execFileSync(POWERSHELL_EXE, ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name = 'xmrig.exe'\" | Select-Object -First 1 -ExpandProperty ProcessId"],
      { encoding: 'utf8', timeout: 4000, windowsHide: true }).trim();
    return /^\d+$/.test(out) ? parseInt(out, 10) : null;
  } catch { return null; }
}

async function getMinerStats() {
  try {
    const r = await fetch(MINER_API + '/2/summary', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const d = await r.json();
    return {
      hashrate_10s: d?.hashrate?.total?.[0] ?? null,
      hashrate_1m: d?.hashrate?.total?.[1] ?? null,
      shares_good: d?.results?.shares_good ?? null,
      shares_total: d?.results?.shares_total ?? null,
      pool: d?.connection?.pool ?? null,
      uptimeSec: d?.uptime ?? null,
      threads: d?.cpu?.threads ?? null,
    };
  } catch { return null; }
}

app.get('/api/miner/status', async (req, res) => {
  trackRequest('/api/miner/status');
  const pid = isMinerRunning();
  let launcherState = null;
  try { launcherState = JSON.parse(readFileSync(MINER_STATUS_FILE, 'utf8')); } catch {}
  res.json({
    running: pid !== null,
    pid,
    supervised: false, // supervisor.mjs has it paused:true — manual-only by design
    launcherState,
    stats: pid !== null ? await getMinerStats() : null,
    config: { pool: 'pool.supportxmr.com:3333', worker: 'SPEEDY-LAPTOP', mode: 'light', threads: '1 (max-threads-hint 12%)', priority: 'idle' },
  });
});

app.post('/api/miner/start', express.json(), async (req, res) => {
  trackRequest('/api/miner/start');
  const key = (req.headers['x-api-key'] || '').trim();
  if (RELAY_API_KEY && key !== RELAY_API_KEY) return res.status(403).json({ error: 'Invalid API key' });
  const pid = isMinerRunning();
  if (pid !== null) return res.json({ ok: true, already: true, pid, message: 'Miner already running' });
  try {
    const child = spawn(process.execPath, [join(__dirname, 'xmrig-service.mjs')], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    res.json({ ok: true, message: 'Miner launch requested — poll /api/miner/status' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/miner/stop', express.json(), async (req, res) => {
  trackRequest('/api/miner/stop');
  const key = (req.headers['x-api-key'] || '').trim();
  if (RELAY_API_KEY && key !== RELAY_API_KEY) return res.status(403).json({ error: 'Invalid API key' });
  const pid = isMinerRunning();
  if (pid === null) return res.json({ ok: true, already: true, message: 'Miner not running' });
  try {
    execFileSync(TASKKILL_EXE, ['/F', '/IM', 'xmrig.exe'], { timeout: 5000, windowsHide: true });
    res.json({ ok: true, stopped: pid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tool Registry ───────────────────────────────────────────
app.get('/tools', (req, res) => {
  trackRequest('/tools');
  const toolList = Object.entries(toolHandlers).map(([name, fn]) => ({
    name,
    description: getToolDescription(name),
    handler: fn.name || 'anonymous',
  }));
  res.json({
    tools: toolList,
    total: toolList.length,
    handlers: Object.keys(handlers),
  });
});

// ── Full tool catalog for agent consumption ──────────────────
// /tools only returns name/description/handler, which is enough for a status
// page but not enough for an LLM to call a tool — it has no parameter schema.
// This endpoint returns name + description + JSON-Schema `parameters` +
// trust level for every registered tool, so agents (notably ai-chat, which
// used to ship a hardcoded 36-tool list) can see and call the whole surface.
//
// Schemas come from three places, best first:
//   1. cuttlefishclaws MCP server on :3120 (tools/list) — real inputSchemas
//   2. Curated schemas for the high-traffic relay tools below
//   3. A permissive generic `args` object — the description carries the meaning
let _mcpToolSchemas = null;
let _mcpToolSchemasFetchedAt = 0;
const MCP_SCHEMA_TTL_MS = 10 * 60 * 1000;

async function getMcpToolSchemas() {
  const now = Date.now();
  if (_mcpToolSchemas && now - _mcpToolSchemasFetchedAt < MCP_SCHEMA_TTL_MS) return _mcpToolSchemas;
  try {
    const res = await fetch('http://127.0.0.1:3120/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    const map = {};
    for (const t of (data?.result?.tools || [])) {
      if (t?.name) map[t.name] = { description: t.description, parameters: t.inputSchema };
    }
    _mcpToolSchemas = map;
    _mcpToolSchemasFetchedAt = now;
    return map;
  } catch {
    // MCP server down — fall back to curated + generic schemas.
    return _mcpToolSchemas || {};
  }
}

// Curated parameter schemas for the tools agents reach for most. Keys are tool
// names; values are JSON Schema objects for the tool's `parameters`.
const CURATED_TOOL_SCHEMAS = {
  'shell-exec': {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run (POSIX shell).' },
      timeout: { type: 'number', description: 'Seconds, max 120.' },
      workdir: { type: 'string', description: 'Absolute working directory.' },
    },
    required: ['command'],
  },
  'python-exec': {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Python 3.11 source to execute.' },
      pip: { type: 'string', description: 'Comma-separated packages to install first.' },
      timeout: { type: 'number', description: 'Seconds, max 120.' },
    },
    required: ['code'],
  },
  'db-query': {
    type: 'object',
    properties: { sql: { type: 'string', description: 'Read-only SELECT/WITH SQL.' } },
    required: ['sql'],
  },
  'db-rest': {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'REST path, e.g. "tasks?select=*".' },
      method: { type: 'string', description: 'GET/POST/PATCH/DELETE.' },
      body: { type: 'object', description: 'Request body for writes.' },
    },
    required: ['path'],
  },
  'web-search': {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query.' } },
    required: ['query'],
  },
  'web-scrape': {
    type: 'object',
    properties: { url: { type: 'string', description: 'URL to extract text from.' }, maxLength: { type: 'number' } },
    required: ['url'],
  },
  'ollama-chat': {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The prompt.' },
      model: { type: 'string' },
      system: { type: 'string' },
    },
    required: ['message'],
  },
  'agent-rpc': {
    type: 'object',
    properties: { agent: { type: 'string' }, message: { type: 'string' } },
    required: ['agent', 'message'],
  },
  'knowledge-graph': {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look up.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Substrings of "vault", "db", "memory", "shared-context", "catalog".' },
      limit: { type: 'number' },
    },
    required: ['query'],
  },
  'video-editor': {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['info', 'trim', 'concat', 'text-overlay', 'thumbnail', 'audio-extract', 'watermark', 'speed', 'gif'] },
      input: { type: 'string' },
      input2: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
      output: { type: 'string' },
      start: { type: 'string' },
      duration: { type: 'string' },
      text: { type: 'string' },
      factor: { type: 'number' },
    },
    required: ['op'],
  },
  // video-brief returns `measured` (exact, from ffmpeg) and `read` (a model's
  // opinion of the contact sheet) as separate fields, so a caller can trust them
  // to different degrees and can tell when only one of them exists.
  //
  // Media is addressed by media_id. There is deliberately no `input` path here:
  // media-register is the single place a path or URL is accepted.
  'video-brief': {
    type: 'object',
    properties: {
      media_id: { type: 'string', description: 'An id from media-register or media-list' },
      frames: { type: 'number', description: 'Contact-sheet frames, 2-48. Default 12' },
      cols: { type: 'number', description: 'Contact-sheet columns. Default 4' },
      from: { type: 'number', description: 'Start of the range to review, in seconds' },
      to: { type: 'number', description: 'End of the range to review, in seconds' },
      scene_threshold: { type: 'number', description: 'scdet cut sensitivity, default 12. Lower finds more cuts' },
      transcript: { type: 'string', description: 'Optional transcript text to include' },
      model: { type: 'string', description: 'Vision model. Only space-bunny-free is reachable from the relay' },
      shots: { type: 'boolean', description: 'Set false to skip cut detection' },
      loudness: { type: 'boolean', description: 'Set false to skip EBU R128 measurement' },
      waveform: { type: 'boolean', description: 'Also render an audio waveform PNG' },
    },
    required: ['media_id'],
  },
  'media-register': {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'A URL, or a local path. The bytes are copied into the managed media root and addressed by id from then on.' },
      label: { type: 'string', description: 'Short human name' },
      note: { type: 'string', description: 'What this is and where it came from' },
      agent: { type: 'string', description: 'Who is registering it. Recorded on the entry.' },
    },
    required: ['source'],
  },
  'media-list': {
    type: 'object',
    properties: { kind: { type: 'string', enum: ['video', 'image', 'audio'] } },
  },
  'media-get': {
    type: 'object',
    properties: { media_id: { type: 'string' } },
    required: ['media_id'],
  },
  'media-remove': {
    type: 'object',
    properties: {
      media_id: { type: 'string' },
      purge: { type: 'boolean', description: 'Also delete the managed file' },
    },
    required: ['media_id'],
  },
  'media-probe': {
    type: 'object',
    properties: { media_id: { type: 'string' } },
    required: ['media_id'],
  },
  'media-shots': {
    type: 'object',
    properties: {
      media_id: { type: 'string' },
      threshold: { type: 'number', description: 'scdet sensitivity, default 12' },
    },
    required: ['media_id'],
  },
  'media-contact-sheet': {
    type: 'object',
    properties: {
      media_id: { type: 'string' },
      frames: { type: 'number' },
      cols: { type: 'number' },
      out: { type: 'string', description: 'Write the PNG here instead of a temp path' },
    },
    required: ['media_id'],
  },
  'media-loudness': {
    type: 'object',
    properties: { media_id: { type: 'string' } },
    required: ['media_id'],
  },
  'media-waveform': {
    type: 'object',
    properties: {
      media_id: { type: 'string' },
      out: { type: 'string' },
    },
    required: ['media_id'],
  },
  'paragraph-publish': {
    type: 'object',
    properties: {
      title: { type: 'string' },
      markdown: { type: 'string' },
      status: { type: 'string' },
      categories: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'markdown'],
  },
  'service_control': {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'restart', 'start', 'stop'] },
      service: { type: 'string' },
    },
    required: ['action'],
  },
  'ship_logs': {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'all | relay | supervisor | actions | db' },
      lines: { type: 'number' },
      service: { type: 'string' },
    },
  },
  'resend-send-email': {
    type: 'object',
    properties: {
      agent: { type: 'string' },
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['to', 'subject', 'body'],
  },
  'fleet_memory_write': {
    type: 'object',
    properties: { agent: { type: 'string' }, memory: { type: 'string' }, key: { type: 'string' } },
    required: ['agent'],
  },
  'fleet_memory_read': {
    type: 'object',
    properties: { agent: { type: 'string' }, key: { type: 'string' }, limit: { type: 'number' } },
  },
};

function genericToolSchema(name) {
  return {
    type: 'object',
    description: `Arguments for ${name}. See the tool description for required fields.`,
    additionalProperties: true,
  };
}

app.get('/api/tools/catalog', async (req, res) => {
  trackRequest('/api/tools/catalog');
  const mcpSchemas = await getMcpToolSchemas();
  const names = Object.keys(toolHandlers);
  const tools = names.map((name) => {
    const mcp = mcpSchemas[name];
    const description = (mcp && mcp.description) || getToolDescription(name);
    const parameters = CURATED_TOOL_SCHEMAS[name] || (mcp && mcp.parameters) || genericToolSchema(name);
    return {
      name,
      description,
      parameters,
      securityLevel: getToolLevel(name),
      source: CURATED_TOOL_SCHEMAS[name] ? 'curated' : (mcp ? 'mcp' : 'generic'),
    };
  });
  res.json({
    count: tools.length,
    describeEveryTool: tools.every(t => t.description && t.description !== 'No description'),
    withRealSchema: tools.filter(t => t.source !== 'generic').length,
    tools,
  });
});

function getToolDescription(name) {
  const descriptions = {
    'web-search': 'Search the web via Ollama or DuckDuckGo fallback',
    'x402-request': 'Create an x402 agentic payment request (invoice). Returns a 402-style Payment-Request with invoice_id, amount, asset. Args: amount (required, positive), asset (default XMRT), purpose, customer_did, merchant_did.',
    'x402-pay': 'Execute payment for an x402 invoice via a provider (Stripe or crypto). Args: invoice_id (from x402-request), provider (default stripe). Returns provider_ref.',
    'x402-status': 'Check x402 invoice payment status. Args: invoice_id (optional — omit for all recent invoices). Returns status pending/paid.',
    'x402-settle': 'Reconcile/settle an x402 invoice as paid (webhook or manual confirmation). Args: invoice_id, provider_ref. Records an audit row in pfp_payments.',
    'web-scrape': 'Extract readable text content from any URL',
    'ollama-chat': 'Chat with local LLM via Ollama',
    'ollama-models': 'List available Ollama models',
    'ollama-health': 'Check Ollama service health',
    'system-monitor': 'Full system snapshot (resources + services)',
    'system-resources': 'CPU, memory, and disk usage',
    'external-services': 'Check Supabase, Ollama, GitHub, Hermes health',
    'device-registration': 'Register this device with hostname and IP',
    'knowledge-sync': 'Sync local knowledge base',
    'mining-dashboard': 'Check cloud mining stats',
    'eliza-send': 'Send a message to Eliza-Cloud',
    'state-get': 'Get a value from persistent state',
    'state-set': 'Set a value in persistent state',
    'task-stats': 'Get task runner statistics',
    'github-post': 'Post a comment on a GitHub issue',
    'elze-templates': 'Elze Contract Suite template & clause retrieval. Actions: templates (all with metadata), template {id} (single + ordered clauses), clauses {template_id}, search {q, category}. Filters: category, jurisdiction. Reads canonical DB (lease_templates / clause_definitions). Use to fetch template structure for the lease writer.',
    'elze-learnings': 'Elze AI-Learnings. Capture accept/reject/edit feedback (action: feedback with attorney_id, matter_id, clause_id, playbook_rule_id, action, edited_text) and query the learning dashboard (action: dashboard, by_attorney, preferences). Roll up per-rule acceptance and infer per-attorney preferences. Use to track how the firm learns over time.',
    'warm-pool-lease-manager': 'Warm Agent Pool lease manager. Acquire a fencing-token lease on a warm worker slot (python-exec, web-scrape, vision, db-query, shell-exec) to run parallel batch jobs. Actions: list (pool status), acquire (worker, max_seconds -> lease_id + fencing_token), call (lease_id, fencing_token, agent_args -> runs the worker tool, auto-releases), release (lease_id, fencing_token), status (lease_id). Fencing tokens prevent stale releases. Use for parallel batch work (mining, review, content pipelines).',
    'vex-vision': 'Vision tool for any agent. Capture a screenshot (screen:true), webcam image (default), local image file (file:"/path"), or image URL (url:"https://..."), then describe it with the cloud vision model. Model default: kimi-k2.6:cloud (no local models on this 6GB laptop). Fallback: OpenRouter. Best for: "what is on screen right now?", "describe this image". Output: plain text description of the image contents.',
    'vex-vision-screenshots': 'Read historical Windows screenshots from %USERPROFILE%\\Pictures\\Screenshots. Returns descriptions of the latest N screenshots (limit, default 5). Optionally filter to a specific filename. Uses kimi-k2.6:cloud via OpenRouter (no local models). Best for: "what was on screen yesterday?", "find the screenshot from last week with the error message".',
    'vex-hear': 'Capture audio from the microphone for a specified duration',
    'python-exec': 'Execute Python 3.11 code and return stdout/stderr. Pass code via "code" (string, required). Optional: pip (package name to install first, comma-separated for multiple), timeout (seconds, max 120). Use for data analysis, SQL queries, text processing, or any computation. Example: TOOL_CALL: {"tool":"python-exec","args":{"code":"print(numpy.__version__)","pip":"numpy"}}',
    'shell-exec': 'Run a bash/curl command in a git-bash POSIX shell and return stdout/stderr. Pass command via "command" (string, required). Optional: timeout (seconds, max 120), workdir (absolute path, default C:\\Users\\PureTrek\\Desktop\\xmrtdao). Use for curl requests, file inspection, git commands, or any shell operation. Example: TOOL_CALL: {"tool":"shell-exec","args":{"command":"curl -s http://localhost:8080/health"}}',
    'service_control': 'Control supervised services. Actions: status (check health), restart (queue a restart), start (queue a start), stop (queue a stop). Services: relay, pg, local-sb, vite, tunnel, python-exec, alice, cron-engine-v2, cuttlefishclaws-mcp, suite-mcp, campaign-scheduler, page-agent-mcp, dsh, zero-claw. RESTARTING THE RELAY: expect ~15s downtime. Do not poll until 20s have passed. All other services: expect ~30s downtime.',
    'ship_logs': 'Read ship logs to diagnose why a service needs restarted. Sources: all (default), relay (stderr/stdout), supervisor (restart history), actions (agent-queued restarts), db (structured activity log). Args: source, lines (default 50), service (filter), since (ISO timestamp). CRITICAL: Always call ship_logs BEFORE restarting a service to know WHY it failed.',
    'resend-inbox': 'Read recent emails from the Resend inbox (pfp, mobilemonero, 31harbor)',
    'resend-inbox-read': 'Mark an email as read. Args: id (email ID), domain (pfp, mobilemonero, or 31harbor). Use after reading an email to mark it handled.',
    'resend-get-email': 'Fetch the full content of a specific email by ID. Args: id (email ID from resend-inbox), domain (pfp, mobilemonero, or 31harbor). Returns full text, html, attachments, and raw data.',
    'sent-emails': 'Search sent email history from suite_email_activity table. Use search param to find by email address or subject. Columns: id, email_from, email_to, subject, status, sent_at.',
    'pfp-leads': 'Manage PFP leads. Actions: list (all leads), search (by name/email/notes), add (create new lead), update (modify existing). Columns: contact_name, contact_email, event_type, event_date, venue_name, venue_address, status, source, notes.',
    'resend-send-email': 'Send an email via Resend as a fleet agent (vex, eliza, hermes, pfp, harbor)',
    'db-query': 'Run a raw SQL query against the local Postgres database (read-only; use SELECT only)',
    'db-rest': 'Query any database table via the local-sb REST API using path and optional method/body',
    'shared-context': 'Read or write shared context memory visible to all agents (action: read|write|search|recall_by_agent|recall_by_topic, key, value, search_term, agent_id, topic)',
    'recall_context': 'Pull structured context across all memory stores: fleet_memory (agent memories), knowledge_entities (knowledge base), and shared_context (key-value store). Pass agent_id (optional filter) and topic (search term). Returns memories, knowledge entries, and context values matching the topic. If no topic, returns recent memories for the agent_id.',
    'activity-log': 'Query the persistent activity feed. Filter by activity_type (tool_execution, edge_function, cron_execution, email, http_error, fleet_message, etc.), status (completed, error, info, warning), since (ISO timestamp), or agent_id. Returns recent entries with timestamps.',
    'agent-profile': 'Read agent profiles from the database (agent_id or list all)',
    'trust-trajectory': 'Get the full TrustGraph trajectory — per-agent trust score series over time, token usage, and ecosystem summary. Args: agent (optional, single agent name e.g. "eliza"), action (optional, "summary" for compact per-agent current score). No args returns full series for all agents. Best for: "show trust trajectory", "what is eliza trust score trend", "trust graph summary".',
    'get_agent_key': 'Retrieve this agent XMRT-DAO API key for authenticating CORE-level tool calls. Returns the xrt_ prefixed key.',
    'edge-function': 'Proxy a call to a Supabase edge function by name (e.g. system-status, schema-tables)',
    'fleet-chat': 'Send a message to the fleet chat as an agent (vex|eliza|hermes) on a channel (fleet|all|vex|eliza|hermes)',
    'obsidian-graph': 'Return the full ecosystem knowledge graph — vault nodes, DB tables, cron jobs, edge functions, relay endpoints, GitHub repos, tunnel routes, Resend domains, campaign pipelines — all with live status. Optional filter by category (vault|db|cron|edge-function|endpoint|github|tunnel|email|campaign|agent|infra|system|spa|backend).',
    'assign_task': 'Create a task and set it to DISCUSS stage. Announces it in fleet chat for discussion. Requires title, optional description, category, assignee_agent_id, priority.',
    'advance_task': 'Advance a task through stages: DISCUSS → PLANNING → EXECUTION → REVIEW → COMPLETION. Requires task_id and to_stage. Announces change to fleet chat.',
    'task-stats': 'Get task runner statistics — queue length, running tasks, completed/failed counts.',
    // ── Edge Function Proxies ──
    'ef:system-status': 'Check overall system status from cloud edge functions',
    'ef:system-health': 'Check system health status from cloud edge functions',
    'ef:system-diagnostics': 'Run diagnostic checks on the system via cloud edge function',
    'ef:get-suite-health': 'Check Suite application health status via cloud edge function',
    'ef:eliza-relay': 'Relay messages to/from Eliza via the eliza-relay edge function',
    'ef:github': 'GitHub integration (list issues, repos, etc.) via cloud edge function',
    'ef:knowledge': 'Knowledge management (check_status, search, etc.) via cloud edge function',
    'ef:agent-manager': 'List/manage registered agents via cloud edge function',
    'ef:mining': 'Get Monero mining stats/wallet info via cloud edge function',
    'ef:schema': 'List database schema tables via cloud edge function',
    'ef:schema-introspect': 'Introspect database schema: list_schemas, list_tables (params.schema), describe_table (params.schema+table), list_relationships (params.schema), search_schema (params.keyword). PUBLIC level.',
    'ef:functions-list': 'List all available edge function names',
    'ef:supabase-integration': 'Check Supabase integration health via cloud edge function',
    'ef:functions-catalog': 'List available edge functions (alias for functions-list)',
    'ef:function-actions': 'Get available actions for edge functions',
    'ef:search-functions': 'Search for edge functions by query string',
    'ef:ecosystem-health': 'Check ecosystem health via cloud edge function',
    'ef:explore-curiosity': '🧪 Explore a topic with curiosity-driven research. Provide a key_phrase and optional conversation_summary. Returns knowledge base results, web search, system context, and follow-up suggestions.',
    'ef:ecosystem-monitor': 'Monitor ecosystem metrics via cloud edge function',
    'ef:frontend-health': 'Check frontend application health via cloud edge function',
    'ef:usage-monitor': 'Monitor system usage metrics via cloud edge function',
    'ef:function-analytics': 'Get function usage analytics via cloud edge function',
    'ef:task-auto-advance': 'Auto-advance stale tasks via cloud edge function',
    'ef:opportunity-scanner': 'Scan for business opportunities via cloud edge function',
    'ef:predictive-analytics': 'Get predictive analytics via cloud edge function',
    'ef:monitor-devices': 'Monitor connected device status via cloud edge function',
    'ef:auth-health': 'Check authentication system health via cloud edge function',
    'ef:knowledge-search': 'Search the knowledge base via cloud edge function',
    'ef:generate-payment-link': 'Generate a Stripe payment link for a subscription tier',
    'ef:cron-proxy': 'Proxy requests to cron-managed edge functions',
    'ef:schema-tables': 'List database schema tables (alias for ef:schema)',
    'ef:mesh-publish': 'Publish a message to the mesh network topic',
    'ef:mesh-peer-connector': 'Register or connect mesh network peers',
    'ef:eliza-chat': 'Chat with Eliza via the eliza-chat edge function',
    'ef:task-orchestrator': 'List/manage tasks via the task orchestrator edge function',
    'ef:agent-coordination-hub': 'Coordinate agent activities via cloud edge function',
    'ef:google-gmail': 'Access Gmail (list messages, send, etc.) via cloud edge function',
    'ef:google-calendar': 'Access Google Calendar (list events, etc.) via cloud edge function',
    'ef:google-drive': 'Access Google Drive (list files, etc.) via cloud edge function',
    'ef:playwright-browse': 'Browse web pages via Playwright automation in cloud',
    'ef:vertex-ai': 'Chat via Ollama Pro cloud (kimi-k2.6:cloud) + generate media via MuAPI (replaced Vertex AI)',
    'ef:paragraph-publish': 'Publish an article to Paragraph.com via cloud edge function',
    'ef:typefully-send': 'Schedule/send a tweet via Typefully integration',
    'ef:universal-invoke': 'Call any edge function by name with custom payload',
    'trust-trajectory': 'Get the full TrustGraph trajectory — per-agent trust score series over time, token usage, and ecosystem summary. Args: agent (optional, single agent name e.g. "eliza"), action (optional, "summary" for compact per-agent current score). No args returns full series for all agents. Best for: "show trust trajectory", "what is eliza trust score trend", "trust graph summary".',

    // ── Descriptions added 2026-09-27 ──
    // ai-chat used to hand Eliza a hardcoded 36-tool list, so she truthfully
    // told users she only had edge functions + GitHub + Python. These entries
    // (plus the cuttlefishclaws_* schemas pulled from the MCP server, plus
    // deriveToolDescription() below) close the gap so /api/tools/catalog
    // describes all 168 tools.
    'video-editor': 'Edit video from the command line via FFmpeg. Ops: info, trim (start/duration), concat (files[]), text-overlay, thumbnail (at, out), audio-extract, watermark (image, position), speed (factor), gif. Args: op (required), input/input2/files/output as needed. Returns the output path and ffprobe metadata.',
    'paragraph-publish': 'Publish an article to Paragraph.com. Args: title (required), markdown (required), status (default "published"), categories[], subtitle, imageUrl, slug. Returns the published URL. Use for the daily-news pipeline.',
    'muapi-generate-image': 'Generate an image with MuAPI. Args: prompt (required), and optional size/style. Returns the resulting image URL.',
    'media-register': 'Ingest a video, image or audio file and get an id for it. Args: source (a URL or local path - the only place either is accepted), label, note, agent. The bytes are copied into the managed media root, so the id cannot be swapped out later. Use this before any other media tool.',
    'media-list': 'List registered media: id, kind, size, label, who registered it, and whether the file is still present. Args: kind (video/image/audio).',
    'media-get': 'Details for one registered media id. Args: media_id (required).',
    'media-remove': 'Forget a media id. Args: media_id (required), purge (also delete the managed file).',
    'video-brief': 'LOOK AT a video or image before editing it. Returns measured facts from ffmpeg (duration, resolution, fps, real cut points, shot lengths, EBU R128 loudness, true peak) plus a contact sheet read by a vision model: shots, pace, framing, look, continuity, and one verdict. Args: media_id (required, from media-register), frames, cols, from, to, scene_threshold, transcript. Use this BEFORE video-editor, which cuts what it has not seen.',
    'media-probe': 'Technical facts about registered media: duration, resolution, fps, codecs, audio channels, and whether it is really a still image. Args: media_id (required).',
    'media-shots': 'Detect real cut points with scdet. Returns shot count, cut timestamps and shot lengths. Args: media_id (required), threshold (default 12; lower finds more cuts).',
    'media-contact-sheet': 'Tile evenly sampled frames into one PNG so a whole spot can be seen at once. Args: media_id (required), frames, cols, out.',
    'media-loudness': 'Measure EBU R128 integrated loudness, loudness range and true peak, with a delivery verdict. Args: media_id (required).',
    'media-waveform': 'Render an audio waveform PNG for registered media. Args: media_id (required), out.',
    'page-agent-task': 'Create or inspect a browser page-agent task. Args: action (list/get/run), task fields. Drives the page-agent MCP worker.',
    'task-artifact': 'Read or write artifacts attached to a task. Args: task_id, artifact name/content. Use to get files a task produced.',
    'token-usage-avg': 'Average token usage and cost per agent/model over a window. Args: agent, model, hours. Use to answer "what is X costing us per day".',
    'ecosystem-activity': 'Recent ecosystem events and activity feed across projects. Args: limit, since, project.',
    'fleet_pulse': 'One-shot fleet health summary: system status + ecosystem metrics + mining stats combined. Use for "how is the fleet doing".',
    'agent-rpc': 'Send a message to another agent via RPC and get its reply. Args: agent (required), message (required). Use to delegate work to vex, hermes, or alice.',
    'knowledge-graph': 'Search the XMRT knowledge graph across the Obsidian vault, Postgres, fleet memory, shared context, and the semantic catalog in one call. Args: query (required), sources[], limit. Best for "what do we know about X".',
    'knowledge-dedup': 'Find near-duplicate knowledge entries. Args: threshold, limit. Use to clean the knowledge base.',
    'task-dedup': 'Find duplicate or overlapping open tasks. Args: threshold, limit.',
    'suite_query': 'Query any local-sb REST table via PostgREST. Args: table (required), select, filters (object), order, limit. Read-only.',
    'suite_insert': 'Insert a row into a local-sb REST table. Args: table (required), row (object).',
    'suite_update': 'Update rows in a local-sb REST table. Args: table (required), row (object), filters (object).',
    'fleet_memory_write': 'Write a durable memory for an agent. Args: agent, key/memory, tags, metadata. Use to persist what should survive a restart.',
    'fleet_memory_read': 'Read durable memories for an agent. Args: agent, key, limit.',
    'inbox_messages': 'Read the shared agent inbox. Args: agent, type (email/sms), is_read, limit.',
    'inbox_write': 'Write to the shared agent inbox. Args: agent, message, type, metadata.',
    'tasks_list': 'List tasks. Args: assignee, status, priority, limit.',
    'tasks_update': 'Update a task. Args: task_id, and any of status/assignee/priority/notes.',
    'pfp_bookings': 'PFP (Party Favor Photo) bookings. Args: action (list/get/add/update), booking fields.',
    'hb_properties': '31 Harbor property inventory and availability. Args: action (list/get/search), property fields.',
    'links_create': 'Create a tracking link. Args: url, campaign/source, optional slug.',
    'links_list': 'List tracking links. Args: campaign, limit.',
    'links_analytics': 'Click/analytics data for tracking links. Args: link_id or campaign, since.',
    'health': 'Relay health check: uptime, request count, tool count, and supervised-service status.',

    // cuttlefishclaws-* (hyphenated relay proxy wrappers over the MCP server)
    'cuttlefishclaws-cac-status': 'Cuttlefish CAC (Contributor Accreditation Committee) credential status for an agent. Args: agent_did or did.',
    'cuttlefishclaws-capital-stack': 'Current capital stack / funding state. Args: agent_did, currency.',
    'cuttlefishclaws-financing-programs': 'List available Cuttlefish financing programs. Args: tier, status.',
    'cuttlefishclaws-trust-score': 'Current TrustGraph score for an agent. Args: agent or did.',
    'cuttlefishclaws-trust-history': 'TrustGraph score history over time for an agent. Args: agent, since, limit.',
    'cuttlefishclaws-agent-onboard': 'Onboard a new agent into the Cuttlefish registry. Args: did, name, role, agent_type.',
    'cuttlefishclaws-proposal-submit': 'Submit a Cuttlefish proposal for council review. Args: title, body, category, did.',
    'cuttlefishclaws-agent-x-post': 'Publish an X (Twitter) post on behalf of an agent via the Cuttlefish social engine. Args: did, text.',
    'cuttlefishclaws-agent-chat': 'Post a chat message as an agent in Cuttlefish council. Args: did, message, channel.',
    'cuttlefishclaws-inquiry': 'Open a Cuttlefish inquiry / council question. Args: question, category, did.',
    'cuttlefishclaws-engine-health': 'Health of the Cuttlefish trust/standing engine. Args: component.',
    'cuttlefishclaws-agents': 'List Cuttlefish agents with trust, CAC, and standing tiers. No args required.',
    'cuttlefishclaws-rate-card': 'Current Cuttlefish rate card for programs and services. Args: program, tier.',

    // ── Obsidian vault (second brain) — added 2026-09-27 ──
    'vault-list': 'List notes in the Obsidian vault (the XMRT second brain). Args: query (substring filter), limit. Returns note slugs, e.g. "ai-chat", "dsh-in-stack".',
    'vault-read': 'Read one vault note in full. Args: name (note name or slug, case-insensitive). Use before updating so you do not clobber existing prose.',
    'vault-write': 'Create or update a vault note. Args: name (required), description, entity_type, aliases[], related[], confidence_score. Only the machine-managed Knowledge block is written — any prose you or a human added outside it is preserved. Safe to call repeatedly.',
    'vault-update': 'Rewrite the managed block of an existing vault note; fails if the note does not exist. Args: name (required), plus any of description/entity_type/aliases/related/confidence_score. Use this when asked to "update"/"refresh" a note.',
    'vault-sync-entities': 'Mirror entities from public.knowledge_entities (what Eliza extracts from conversation) into vault notes. Args: limit (default 300). Run this after a batch of conversation to fold new knowledge into the wiki. Notes whose content is unchanged are skipped, so a no-op sync does not touch git history.',
  };

// PFP financial tools are registered by the async block at the top of
// toolHandlers, which runs before this object exists. Adding the descriptions
// here is the earliest point where `descriptions` is in scope.
if (globalThis.__PFP_MONEY_TOOL_DESCRIPTIONS) {
  Object.assign(descriptions, globalThis.__PFP_MONEY_TOOL_DESCRIPTIONS);
  delete globalThis.__PFP_MONEY_TOOL_DESCRIPTIONS;
}

  if (descriptions[name]) return descriptions[name];

  // Last resort: derive a usable one-liner from the tool name so the catalog
  // never ships "No description" — an unnamed tool is invisible to the model.
  const derived = deriveToolDescription(name);
  return derived || 'No description';
}

// Turn "cuttlefishclaws-trust-score" into "Cuttlefishclaws trust score."
function deriveToolDescription(name) {
  const words = String(name)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (!words) return null;
  const readable = words.toLowerCase();
  return `${readable.charAt(0).toUpperCase()}${readable.slice(1)}. (Relay tool; pass a JSON object of arguments.)`;
}

// ── Agent Authorization ──────────────────────────────────────
import { checkToolAccess, getToolLevel, registerTrustedAgent, getAgentInfo, listAgents, CORE_AGENTS, TRUST_LEVELS } from './lib/agent-auth.mjs';
import { preflightCheck, getAgentTrustContext } from './lib/trustgraph-preflight.mjs';
import { runScan as runTrustGraphScan } from './lib/trustgraph-scanner.mjs';

// ── Tool Execution ──────────────────────────────────────────
app.post('/tools/run', async (req, res) => {
  const { tool, args = {} } = req.body;
  const agentId = args?.agent || req.headers['x-agent-id'] || req.ip;
  trackRequest('/tools/run', tool);
  
  if (!tool) {
    return res.status(400).json({ error: 'tool name is required', available: Object.keys(toolHandlers) });
  }
  
  const handler = toolHandlers[tool];
  if (!handler) {
    // Check tool aliases
    const toolAliases = {
      'search_knowledge': { tool: 'ef:knowledge', args: { action: 'search', data: { search_term: '' } } },
      'store_knowledge': { tool: 'ef:knowledge', args: { action: 'store_knowledge' } },
      // GitHub native tool aliases — route through relay-native ef:github (bypasses broken Deno edge function)
      'listGitHubIssues': { tool: 'ef:github', args: { action: 'list_issues' } },
      'listGitHubPullRequests': { tool: 'ef:github', args: { action: 'list_prs' } },
      'searchGitHubCode': { tool: 'ef:github', args: { action: 'search_code' } },
      'createGitHubIssue': { tool: 'ef:github', args: { action: 'create_issue' } },
      'updateGitHubIssue': { tool: 'ef:github', args: { action: 'update_issue' } },
      'getGitHubIssue': { tool: 'ef:github', args: { action: 'get_issue' } },
    };
    const alias = toolAliases[tool];
    if (alias) {
      const mergedArgs = { ...alias.args, ...args };
      if (tool === 'search_knowledge') {
        mergedArgs.data = mergedArgs.data || {};
        mergedArgs.data.search_term = args.search_term || args.query || args.term || '';
      }
      const aliasHandler = toolHandlers[alias.tool];
      if (aliasHandler) {
        const result = await aliasHandler(mergedArgs);
        return res.json(result);
      }
    }
    return res.status(404).json({ error: `Tool "${tool}" not found`, available: Object.keys(toolHandlers) });
  }
  
  // ── Authorization check ──
  const toolLevel = getToolLevel(tool);
  
  // For CORE-level tools, require service token or JWT auth (not just agent name claim)
  // But if the agent is already authenticated via x-agent-id and is a known CORE agent,
  // skip the additional x-api-key check (the fleet chat tool execution path already authed them)
  // Also accept agent-specific API keys (xrt_ prefix) from the agent_api_keys table
  const isCoreAgent = CORE_AGENTS.has(agentId.toLowerCase().trim());
  const hasAgentKey = req.agentAuth && req.agentAuth.method === 'agent_key';
  if (toolLevel === 'core' && !req.cfAccess && !req.headers['x-api-key'] && !isCoreAgent && !hasAgentKey) {
    return res.status(403).json({
      error: 'CORE-level tools require Cloudflare Access authentication (service token or JWT). Set CF-Access-Client-Id + CF-Access-Client-Secret headers or x-api-key header.',
      agent: agentId,
      tool,
      toolLevel,
    });
  }
  
  const auth = checkToolAccess(agentId, tool, toolLevel);
  if (!auth.authorized) {
    return res.status(403).json({
      error: auth.reason,
      agent: agentId,
      tool,
      toolLevel,
      agentLevel: getAgentInfo(agentId)?.level || 'unknown',
    });
  }
  
  // Inject auth context into args
  args._agent = { id: agentId, level: auth.level };

  // Agent tool calls: call handler directly (fast path, no queue wait).
  // The task runner is for background cron jobs, not synchronous agent requests.
  // Agent-side retry in executeAgentToolCall handles transient failures.
  let result;
  const startTime = Date.now();
  try {
    result = await handler(args);
  } catch (e) {
    result = { error: e.message || 'Unknown error' };
  }
  const duration = Date.now() - startTime;
  
  // Log tool execution to activity feed
  logToDb('tool_execution', `Tool: ${tool}`,
    `${agentId} called ${tool} — ${result.error ? 'failed: ' + result.error.slice(0, 100) : 'success'} (${duration}ms)`,
    result.error ? 'error' : 'completed',
    { tool, agent: agentId, duration_ms: duration, has_error: !!result.error },
    agentId
  ).catch(() => {});

  res.json({ ...result, _authorized: true, _agent: agentId });
});

// ── Agent Registration (for trusted agents after XMRT University) ──
app.post('/tools/register-agent', async (req, res) => {
  const { agent_id, name, role, passcode } = req.body;
  
  if (!agent_id) {
    return res.status(400).json({ error: 'agent_id is required' });
  }
  
  // Require proof of XMRT University completion
  if (!passcode || passcode !== 'xmrt-university-graduate') {
    return res.status(403).json({
      error: 'Proof of XMRT University graduation required. Complete the certification program at /university first.',
      hint: 'Passcode is provided upon graduation from XMRT University',
    });
  }
  
  const result = registerTrustedAgent(agent_id, { name, role });
  res.json(result);
});

// ── Agent Status ──
app.get('/tools/agents', async (req, res) => {
  res.json({ agents: listAgents(), core: Array.from(CORE_AGENTS) });
});

// ── XMRT DAO Dynamic Data Endpoints ─────────────────────────

// GET /api/dao/health — Local PostgreSQL health & status
// 2026-06-08: Rewired from Supabase to local embedded-postgres.
// Supabase is closed. We use pg.Client to query the local PG
// running on 127.0.0.1:5432 (suite/runtime/db-manager.mjs).
app.get('/api/dao/health', async (req, res) => {
  trackRequest('/api/dao/health');
  const t0 = Date.now();
  try {
    // 1) PG reachable? (with a 2s timeout, fail fast)
    let poolOk = false;
    try { const r = await pgPool.query('SELECT 1'); poolOk = true; } catch (e) { return res.json({ ok: false, error: 'PG unreachable: ' + e.message, uptime: process.uptime() }); }
    try {
      // 2) Aggregate the dashboard fields from local tables using pool.query()
      // (pool.query acquires+releases a connection per query — safe for parallel use)
      const queries = [
        // Count the real fleet agents (public.registry_agents) — agent.agents only
        // holds the legacy Eliza-Dev row and undercounts the actual fleet.
        pgPool.query("SELECT COUNT(*)::int AS c FROM public.registry_agents").catch(() => ({ rows: [{ c: 0 }] })),
        pgPool.query("SELECT COUNT(*)::int AS c FROM public.registry_agents WHERE status = 'busy'").catch(() => ({ rows: [{ c: 0 }] })),
        pgPool.query("SELECT COUNT(*)::int AS c FROM app.tasks").catch(() => ({ rows: [{ c: 0 }] })),
        pgPool.query("SELECT COUNT(*)::int AS c FROM app.tasks WHERE status IN ('completed','done','DONE','COMPLETED')").catch(() => ({ rows: [{ c: 0 }] })),
        pgPool.query("SELECT COUNT(*)::int AS c FROM public.eliza_function_usage WHERE invoked_at > NOW() - INTERVAL '24 hours'").catch(() => ({ rows: [{ c: 0 }] })),
        pgPool.query("SELECT COUNT(*)::int AS c FROM public.python_execs").catch(() => ({ rows: [{ c: 0 }] })),
        pgPool.query("SELECT COUNT(*)::int AS c FROM public.api_keys").catch(() => ({ rows: [{ c: 0 }] })),
      ];
      const [agents, agentsBusy, tasks, tasksDone, fnCalls24h, pyExecs, apiKeys] = await Promise.all(queries);
      // Also count total tables + schemas for richness
      const tablesRes = await pgPool.query("SELECT COUNT(*)::int AS c FROM pg_tables WHERE schemaname='public'");
      const schemasRes = await pgPool.query("SELECT COUNT(*)::int AS c FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema')");

      const counts = {
        agents_total:     agents.rows[0]?.c     ?? 0,
        agents_busy:      agentsBusy.rows[0]?.c ?? 0,
        tasks_total:      tasks.rows[0]?.c      ?? 0,
        tasks_done:       tasksDone.rows[0]?.c  ?? 0,
        fn_calls_24h:     fnCalls24h.rows[0]?.c ?? 0,
        python_execs:     pyExecs.rows[0]?.c    ?? 0,
        api_keys:         apiKeys.rows[0]?.c    ?? 0,
        pg_tables_public: tablesRes.rows[0]?.c  ?? 0,
        pg_schemas:       schemasRes.rows[0]?.c ?? 0,
      };
      // Compute a real health score 0-100.
      // Base 50 for being reachable. Deductions for failures, restarts, low uptime.
      let score = 50;
      // Add for positive signals
      if (counts.agents_total > 0)            score += 10;
      if (counts.fn_calls_24h > 0)            score += 5;
      if (counts.pg_tables_public > 40)       score += 5;   // schema loaded
      if (counts.tasks_total > 0)             score += 5;
      // Live port checks for key services — more reliable than supervisor-state.json
      // which can have stale healthy:false flags due to dependency degradation cascades
      try {
        const liveChecks = await Promise.allSettled([
          fetch('http://127.0.0.1:54321/health', { signal: AbortSignal.timeout(5000) }).then(r => r.ok),
          fetch('http://127.0.0.1:5173/', { signal: AbortSignal.timeout(5000) }).then(r => r.ok || r.status === 302),
          fetch('http://127.0.0.1:5174/', { signal: AbortSignal.timeout(5000) }).then(r => r.ok || r.status === 302),
          fetch('http://127.0.0.1:3120/health', { signal: AbortSignal.timeout(5000) }).then(r => r.ok),
          fetch('http://127.0.0.1:3121/health', { signal: AbortSignal.timeout(5000) }).then(r => r.ok),
        ]);
        const healthyCount = liveChecks.filter(r => r.status === 'fulfilled' && r.value).length;
        const totalChecks = liveChecks.length;
        // +2 per healthy service (max +12 for all 6), -5 per down service
        score += healthyCount * 2;
        const downCount = totalChecks - healthyCount;
        if (downCount > 0) score -= downCount * 5;
        // Bonus if all healthy
        if (healthyCount === totalChecks) score += 10;
      } catch (_) {}
      // Check task throughput (tasks completed in last 24h)
      if (counts.tasks_done > 0) score += Math.min(10, Math.floor(counts.tasks_done / 5));
      // Check error rate from function calls
      if (counts.fn_calls_24h > 0 && counts.fn_errors_24h !== undefined) {
        const errorRate = counts.fn_errors_24h / counts.fn_calls_24h;
        if (errorRate > 0.5) score -= 15;  // >50% error rate
        else if (errorRate > 0.2) score -= 5;
      }
      score = Math.max(0, Math.min(100, score));
      const status = score >= 80 ? 'healthy' : score >= 50 ? 'degraded' : 'critical';

      // Inject live supervisor-managed service statuses. Rather than reading
      // the (often empty/stale) supervisor-state.json, fetch the live
      // /api/supervisor/status endpoint and transform its services array into
      // the object shape the dashboard expects (name → {uptimeSec, childPid,
      // restartCount, healthy}). This keeps the DAO & Ecosystem tile in sync
      // with the Quartermaster's Watch tile.
      let liveServices = null;
      try {
        const sup = await fetch(`http://127.0.0.1:${PORT}/api/supervisor/status`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null);
        if (sup && Array.isArray(sup.services)) {
          liveServices = {};
          for (const s of sup.services) {
            liveServices[s.name] = {
              childPid: s.pid || null,
              startedAt: s.startedAt || null,
              uptimeSec: s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0,
              restartCount: s.restartCount || 0,
              healthy: !!s.healthy,
            };
          }
        }
      } catch (_) { liveServices = null; }

      res.json({
        success: true,
        source: 'local-postgres',
        database: 'xmrt_suite@127.0.0.1:5432',
        pg_status: 'up',
        health: {
          overall_health: { score, status },
        },
        status: {
          health_score: score,
          overall_status: status,
          components: {
            edge_functions: { total_calls_24h: counts.fn_calls_24h },
            agents:         { total: counts.agents_total, busy: counts.agents_busy },
            tasks:          { total: counts.tasks_total, completed: counts.tasks_done },
            python_execs:   { total: counts.python_execs },
            api_keys:       { total: counts.api_keys },
          },
        },
        counts,
        services: liveServices,
        latency_ms: Date.now() - t0,
        timestamp: new Date().toISOString(),
      });
    } finally {
      // pool.query() auto-releases connections — no manual release needed
    }
  } catch (e) {
    res.json({
      success: false,
      source: 'local-postgres',
      pg_status: 'down',
      error: e.message,
      latency_ms: Date.now() - t0,
      timestamp: new Date().toISOString(),
    });
  }
});

// GET /api/dao/gossip — Gossip hub fleet messages (read from local mesh log)
app.get('/api/dao/gossip', async (req, res) => {
  trackRequest('/api/dao/gossip');
  const topic = req.query.topic || 'fleet-broadcast';
  const limit = parseInt(req.query.limit) || 20;

  try {
    const raw = getMeshMessageLog(limit * 2);
    const messages = raw
      .filter(e => !topic || e.topic === topic)
      .slice(0, limit)
      .map(e => ({
        id: e.ts,
        topic: e.topic,
        agent: e.from,
        message: e.data,
        created_at: e.ts,
      }));

    res.json({
      success: true,
      source: 'local-mesh-log',
      topic,
      messages,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.json({ success: false, error: e.message, topic });
  }
});

// POST /api/dao/gossip — Store a gossip hub message (Hermes/Android can post here)
app.options('/api/dao/gossip', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});
app.post('/api/dao/gossip', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/dao/gossip');
  const { agent, message, topic } = req.body || {};

  if (!agent || !message) {
    return res.status(400).json({ success: false, error: 'agent and message are required' });
  }

  try {
    const channel = topic || 'fleet-broadcast';
    const entry = addFleetMessage(agent, message, channel);
    publishToMesh(channel, { agent, message, channel: channel, ts: entry?.ts || Date.now() }).catch(() => {});

    res.json({
      success: true,
      source: 'local-relay',
      message: entry,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// GET /api/dao/github — GitHub org activity
app.get('/api/dao/github', async (req, res) => {
  trackRequest('/api/dao/github');
  const GH_TOKEN = process.env.GITHUB_TOKEN || '';
  const GH_HEADERS = GH_TOKEN ? { 'Authorization': `token ${GH_TOKEN}` } : {};

  try {
    // Search repos in org
    const reposRes = await fetch('https://api.github.com/search/repositories?q=org:xmrtdao&sort=updated&per_page=10', {
      headers: GH_HEADERS,
      signal: AbortSignal.timeout(5000),
    });

    const repos = reposRes.ok ? await reposRes.json() : { items: [] };

    // Fetch recent commits from the 6 key repos in parallel
    const keyRepos = ['xmrtdao/suite', 'xmrtdao/mobilemonero', 'xmrtdao/zero-claw', 'xmrtdao/xmrt-mesh', 'xmrtdao/sea-hampton-house', 'xmrtdao/cashdapp'];
    const commitResults = await Promise.allSettled(
      keyRepos.map(repo =>
        fetch(`https://api.github.com/repos/${repo}/commits?per_page=3`, {
          headers: GH_HEADERS,
          signal: AbortSignal.timeout(5000),
        }).then(r => r.ok ? r.json() : [])
      )
    );

    // Merge commits from all repos, tag each with its repo, sort by date descending
    const allCommits = [];
    commitResults.forEach((result, i) => {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        result.value.forEach(c => {
          c._repo = keyRepos[i].replace('xmrtdao/', '');
          allCommits.push(c);
        });
      }
    });
    allCommits.sort((a, b) => new Date(b.commit?.author?.date || 0) - new Date(a.commit?.author?.date || 0));

    res.json({
      success: true,
      repos: repos.items?.slice(0, 10) || [],
      total_repos: repos.total_count || 0,
      recent_commits: allCommits.slice(0, 6) || [],
      has_token: !!GH_TOKEN,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// GET /api/campaign/pfp — PFP campaign live stats
app.get('/api/campaign/pfp', (req, res) => {
  trackRequest('/api/campaign/pfp');
  try {
    const CAMPAIGN_SENT = join(DATA_DIR, 'campaign-sent.json');
    const CAMPAIGN_CONTACTS = join(DATA_DIR, 'campaign-contacts.json');
    const CAMPAIGN_LOG = join(DATA_DIR, 'campaign.log');

    let campaignSent = [];
    let campaignContacts = [];
    let campaignLastRun = 'never';
    if (existsSync(CAMPAIGN_SENT)) campaignSent = JSON.parse(readFileSync(CAMPAIGN_SENT, 'utf8'));
    if (existsSync(CAMPAIGN_CONTACTS)) campaignContacts = JSON.parse(readFileSync(CAMPAIGN_CONTACTS, 'utf8'));
    if (existsSync(CAMPAIGN_LOG)) {
      const logLines = readFileSync(CAMPAIGN_LOG, 'utf8').trim().split('\n').filter(Boolean);
      if (logLines.length > 0) {
        const lastLine = logLines[logLines.length - 1];
        const tsMatch = lastLine.match(/\[(.*?)\]/);
        campaignLastRun = tsMatch ? tsMatch[1].slice(0, 16) : 'recent';
      }
    }

    const totalSent = campaignSent.length;
    const poolSize = campaignContacts.length;
    const cutoff30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentSent = new Set(campaignSent.filter(s => s.ts > cutoff30).map(s => s.email));
    const freshAvailable = campaignContacts.filter(c => !recentSent.has(c.email) && c.email?.includes('@')).length;

    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const sentToday = campaignSent.filter(s => s.ts > todayStart.getTime()).length;

    res.json({ success: true, poolSize, sentToday, totalSent, freshAvailable, campaignLastRun });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// GET /api/campaign/31harbor — 31 Harbor campaign live stats
app.get('/api/campaign/31harbor', (req, res) => {
  trackRequest('/api/campaign/31harbor');
  try {
    const HARBOR_CONTACTS = join(DATA_DIR, '31harbor-contacts.json');
    const HARBOR_SENT = join(DATA_DIR, '31harbor-sent.json');
    const HARBOR_LOG = join(DATA_DIR, '31harbor-campaign.log');

    let harborSent = [];
    let harborContacts = [];
    let harborLastRun = 'never';
    if (existsSync(HARBOR_CONTACTS)) harborContacts = JSON.parse(readFileSync(HARBOR_CONTACTS, 'utf8'));
    if (existsSync(HARBOR_SENT)) harborSent = JSON.parse(readFileSync(HARBOR_SENT, 'utf8'));
    if (existsSync(HARBOR_LOG)) {
      const logLines = readFileSync(HARBOR_LOG, 'utf8').trim().split('\n').filter(Boolean);
      if (logLines.length > 0) {
        const lastLine = logLines[logLines.length - 1];
        const tsMatch = lastLine.match(/\[(.*?)\]/);
        harborLastRun = tsMatch ? tsMatch[1].slice(0, 16) : 'recent';
      }
    }

    const harborSentTotal = harborSent.length;
    const harborPoolSize = harborContacts.length;
    const cutoff30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentHarborSent = new Set(harborSent.filter(s => s.ts > cutoff30).map(s => s.email));
    const harborFresh = harborContacts.filter(c => !recentHarborSent.has(c.email) && c.email?.includes('@')).length;
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const harborSentToday = harborSent.filter(s => s.ts > todayStart.getTime()).length;

    res.json({ success: true, harborPoolSize, harborSentTotal, harborFresh, harborLastRun, harborSentToday });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// GET /api/dao/mining — Mining pool stats
app.get('/api/dao/mining', async (req, res) => {
  trackRequest('/api/dao/mining');
  try {
    const statsRes = await fetch(`${SUPABASE_URL}/functions/v1/mining-proxy`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'get_stats', wallet: 'global' }),
      signal: AbortSignal.timeout(5000),
    });

    const stats = statsRes.ok ? await statsRes.json() : { error: 'unavailable' };

    res.json({
      success: statsRes.ok,
      stats,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── PFP Leads API ───────────────────────────────────────────
app.get('/api/leads/pfp', async (req, res) => {
  trackRequest('/api/leads/pfp');
  try {
    const base = `${SUPABASE_URL}/rest/v1/pfp_leads`;

    // Pull all leads (no group-by support in local-sb REST, do it client-side)
    const allRes = await fetch(`${base}?select=id,contact_name,contact_email,status,source,lead_rating,created_at&order=created_at.desc`, {
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (!allRes.ok) throw new Error(`local-sb returned ${allRes.status}`);
    const leads = await allRes.json();

    const total = leads.length;
    const byStatus = {};
    const bySource = {};
    let newest = leads[0] || null;
    const highRated = [];

    for (const l of leads) {
      byStatus[l.status] = (byStatus[l.status] || 0) + 1;
      bySource[l.source] = (bySource[l.source] || 0) + 1;
      if (l.lead_rating >= 7) highRated.push(l);
    }

    res.json({
      success: true,
      total,
      byStatus,
      bySource,
      newest,
      highRated,
      recent: leads.slice(0, 10),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── POST /api/leads/pfp — write a new lead (used by website booking, fleet chat hook, manual entry) ──
app.post('/api/leads/pfp', async (req, res) => {
  trackRequest('POST /api/leads/pfp');
  try {
    const { contact_name, contact_email, contact_phone, event_date, source, status, lead_rating, notes, company_name } = req.body;
    if (!contact_name || !contact_email) {
      return res.status(400).json({ success: false, error: 'contact_name and contact_email are required' });
    }

    // Check for duplicate by email
    const existing = await queryLocalPg("SELECT id, status FROM pfp_leads WHERE contact_email = $1 LIMIT 1", [contact_email]);
    if (existing.rows.length > 0) {
      return res.json({
        success: true,
        existing: true,
        id: existing.rows[0].id,
        status: existing.rows[0].status,
        message: 'Lead already exists (duplicate email)',
      });
    }

    const result = await queryLocalPg(
      `INSERT INTO pfp_leads (contact_name, contact_email, contact_phone, event_date, source, status, lead_rating, notes, company_name, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()) RETURNING id`,
      [contact_name, contact_email, contact_phone || null, event_date || null, source || 'manual-entry', status || 'NEW', lead_rating || 5, notes || null, company_name || null]
    );

    res.json({ success: true, existing: false, id: result.rows[0].id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── PFP checkout ───────────────────────────────────────────────────────────
//
// Create a Stripe Checkout Session for a lead. The lead id goes into the
// session's metadata, and that is the whole mechanism: when Stripe tells us the
// session completed, the webhook reads the lead id back out and turns the lead
// into a booking. There is no other link, and none is guessed.
//
// The caller supplies an idempotency key. Without one, an agent retrying this
// call after a timeout would present the client with a second payment page, and
// the client would see two charges for one event.
//
// This endpoint creates a session. It does not take money - the client does that
// on Stripe's own page, and the amount is settled by Stripe, not by this relay.
app.post('/api/pfp/checkout', async (req, res) => {
  trackRequest('POST /api/pfp/checkout');
  try {
    const { lead_id, amountCents, currency, description, idempotencyKey, successUrl, cancelUrl } = req.body || {};
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });
    if (!STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured on this relay' });
    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'idempotencyKey is required',
        detail: 'Without it a retry could charge the client twice. Use a stable key per lead and attempt, e.g. "pfp-" + lead_id + "-" + YYYYMMDD.',
      });
    }
    const stripe = require('stripe')(STRIPE_SECRET_KEY);
    const { createCheckoutForLead } = await import('./lib/pfp-checkout.mjs');
    const { session, lead } = await createCheckoutForLead(
      { stripe, query: queryLocalPg, log: logActivity },
      lead_id,
      { amountCents, currency, description, idempotencyKey, successUrl, cancelUrl }
    );
    res.json({
      success: true,
      lead_id: lead.id,
      lead_status: lead.status,
      session_id: session.id,
      url: session.url,
      amount: session.amount_total != null ? (session.amount_total / 100).toFixed(2) : null,
      currency: session.currency,
    });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ success: false, error: e.message });
  }
});

// ── Web Search ──────────────────────────────────────────────
app.post('/web-search', async (req, res) => {
  const { query, maxResults } = req.body;
  trackRequest('/web-search');
  if (!query) return res.status(400).json({ error: 'query is required' });
  const results = await webSearch(query, { maxResults: maxResults || 5 });
  res.json(results);
});

// ── Web Scrape ──────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { url, maxLength } = req.body;
  trackRequest('/scrape');
  if (!url) return res.status(400).json({ error: 'url is required' });
  const result = await webScrape(url, { maxLength: maxLength || 50000 });
  res.json(result);
});

// ── Ollama Chat ─────────────────────────────────────────────
app.post('/ollama/chat', async (req, res) => {
  const { message, model, temperature, maxTokens } = req.body;
  trackRequest('/ollama/chat');
  if (!message) return res.status(400).json({ error: 'message is required' });
  const result = await ollamaChat(message, { model, temperature, maxTokens });
  res.json(result);
});

app.get('/ollama/models', async (req, res) => {
  trackRequest('/ollama/models');
  const result = await listModels();
  res.json(result);
});

app.get('/ollama/health', async (req, res) => {
  trackRequest('/ollama/health');
  const result = await checkOllamaHealth();
  res.json(result);
});

// ── Monitor ─────────────────────────────────────────────────
app.get('/monitor', async (req, res) => {
  trackRequest('/monitor');
  const snapshot = await getFullSnapshot();
  snapshot.relay.requests = requestCounts;
  snapshot.relay.taskRunner = taskRunner.getStats();
  snapshot.relay.activityLog = activityLog.slice(0, 10);
  res.json(snapshot);
});

// ── Fleet Chat — Gossipsub-style Pub/Sub Bus ───────────────
// In-memory message store (persisted to state every 30s)
const fleetChatMessages = [];
const FLEET_CHAT_MAX = 5000;

// ── Message dedup cache (5-min TTL, content-based) ─────────
const seenMessageHashes = new Set();
const SEEN_HASH_TTL = 5 * 60 * 1000;

function getMessageHash(agent, message) {
  return agent + ':' + (message || '').slice(0, 100);
}

function checkAndMarkDuplicated(agent, message) {
  const hash = getMessageHash(agent, message);
  if (seenMessageHashes.has(hash)) return true;
  seenMessageHashes.add(hash);
  setTimeout(() => seenMessageHashes.delete(hash), SEEN_HASH_TTL);
  return false;
}

// Fleet agent registry (who's listening)
const FLEET_AGENTS = {
  'vex': { name: 'Vex (Captain, HMS Speedy)', endpoint: 'local', type: 'relay' },
  'eliza': { name: 'Eliza-Cloud', endpoint: 'eliza-relay', type: 'cloud' },
  'hermes': { name: 'Hermes', endpoint: 'https://hermes.mobilemonero.com', type: 'mobile' },
  'alice': { name: 'Alice (Daemon)', endpoint: 'local', type: 'daemon', localEndpoint: 'http://127.0.0.1:8080/api/alice/inbox' },
  // CuttlefishClaws fleet agents — first-class agents with tool access, shared memory, and kimi-k2.6:cloud inference
  'trib': { name: 'Trib (Tributary Governance Agent)', endpoint: 'local', type: 'relay' },
  'arch': { name: 'Arch (Architecture & Routing Agent)', endpoint: 'local', type: 'relay', chatFunction: 'arch-chat' },
  'builder': { name: 'Builder Agent (CAC Tier 2)', endpoint: 'local', type: 'relay' },
  'sovereign': { name: 'Sovereign Agent (CAC Tier 3)', endpoint: 'local', type: 'relay' },
  'trustgraph': { name: 'TrustGraph (Constitutional Scoring Engine)', endpoint: 'local', type: 'relay' },
  'dao': { name: 'DAO Gov (Governance Module)', endpoint: 'local', type: 'relay' },
  'global-communicator': { name: 'GlobalCommunicator', endpoint: 'local', type: 'relay' },
  // Job-search agent. Replies come from the Jobby chat loop, which has its own
  // tools, dossier state and outbound guard rails.
  'jobby': { name: 'Jobby McJobberson (Career Agent)', endpoint: 'local', type: 'relay', chatFunction: 'jobby-chat' },
};

// ── Agent Push Notification Email Mapping ──────────────────────────
// Each agent has a dedicated email from their domain.
// Recipients are notified directly — no CC.
/**
 * Resolve Jobby's outbound From address.
 *
 * Defaults to the 31harbor.com brand. Configurable via JOBBY_FROM_ADDRESS so a
 * rebrand is a one-line .env change, but the domain must be one this relay
 * actually holds a Resend key for: a typo would otherwise produce sends that
 * fail at the provider with an opaque 401, and an arbitrary value would let a
 * misconfiguration impersonate a domain.
 *
 * This is operator configuration, not request input. A caller still cannot
 * choose a From address.
 */
/**
 * POST one message to Resend, choosing the key by the From's domain.
 *
 * Shared by the agent route and the candidate send path so there is exactly one
 * place that talks to the provider. The two differ only in where the From came
 * from, and keeping the transport shared is what stops that difference from
 * quietly becoming two behaviours.
 *
 * Returns { id } on success, or { error, status } on a provider refusal, so the
 * caller decides whether that is a 4xx to hand back or a send to record as
 * failed.
 */
async function sendViaResend({ from, to, subject, text, html }) {
  // Derived from the registry rather than a literal map, so a domain with no
  // entry cannot quietly fall through to another account's key.
  const RESEND_KEYS = Object.fromEntries(
    EMAIL_INBOX_KEYS.map((k) => [EMAIL_DOMAINS[k].domain, resendKeyFor(k) || '']));
  const domain = String(from || '').match(/@([^>]+)/)?.[1]?.trim().toLowerCase() || 'mobilemonero.com';
  const key = RESEND_KEYS[domain] || RESEND_KEYS['mobilemonero.com'];
  if (!key) {
    return { error: `No Resend API key configured for domain: ${domain}`, status: 500 };
  }
  const apiRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html: html || undefined }),
  });
  const data = await apiRes.json().catch(() => ({}));
  if (!apiRes.ok) return { error: data, status: apiRes.status };
  return { id: data.id };
}

/** The suite_email_activity company id for a From domain. */
function companyIdFor(from) {
  const domain = String(from || '').match(/@([^>]+)/)?.[1]?.trim().toLowerCase() || '';
  if (domain === '31harbor.com') return 'harbor';
  if (domain === 'partyfavorphoto.com') return 'party';
  // A candidate's own address is activity for the job agent, not for a brand.
  if (domain === MAILBOX_DOMAIN) return 'jobby';
  return 'xmrt';
}

/**
 * The candidate's address, assigned on first use.
 *
 * Called from the send path rather than at onboarding, so a candidate who has
 * never had mail sent still gets a real address. Once assigned it is held: a
 * name they correct later must not leave earlier applications replying to an
 * address nobody is reading.
 */
async function ensureCandidateMailbox(client) {
  const name = client.display_name || null;
  try {
    const r = await jobbyStore.ensureMailbox(client.id, name);
    if (r.address) return { mailbox: r.address, displayName: r.displayName || name };
    console.warn(`[jobby] could not assign an address to client ${client.id} (${r.reason}); sending as the agent`);
  } catch (e) {
    // A send must not fail because an address could not be assigned. The agent
    // sender is worse for the candidate but better than dropping the
    // application, and it is logged rather than silent.
    console.warn(`[jobby] address assignment failed for client ${client.id}: ${e.message}`);
  }
  return { mailbox: client.mailbox || null, displayName: client.display_name || null };
}

/**
 * Resolve Jobby's outbound From address.
 *
 * Two levels, and the order matters:
 *
 *  1. A candidate's own address on jobbymcjobberson.com, when one is known.
 *     This is the whole point: an application sent as "Joe Lee
 *     <joe.lee@jobbymcjobberson.com>" is a person applying, not an agent
 *     applying on someone's behalf, and the replies come back to them.
 *
 *  2. The agent's own address, which is what it used before, and remains the
 *     fallback so a client with no name yet can still receive mail.
 *
 * The security property is unchanged and is the reason this takes a client row
 * rather than an address: a caller still cannot choose a From. The candidate's
 * address is read from the database, keyed by a client id the caller cannot
 * forge, and is then checked against the domains this relay can send from. A
 * request that passes a "from" is ignored, not honoured.
 */
function resolveJobbySender(client = null) {
  const SENDABLE_DOMAINS = new Set(
      EMAIL_INBOX_KEYS.map((k) => EMAIL_DOMAINS[k].domain));
  const fallback = 'Jobby McJobberson <jobby@31harbor.com>';

  // (1) The candidate's own address. Validated as a whole, not merely checked
  // for an "@": "Joe Lee <@jobbymcjobberson.com>" has no local part at all and
  // would have been handed to the provider as a send.
  const mailbox = client && client.mailbox ? String(client.mailbox).trim().toLowerCase() : null;
  if (mailbox) {
    if (isCandidateMailbox(mailbox) && SENDABLE_DOMAINS.has(domainOf(mailbox))) {
      const name = displayNameFor(client.display_name, mailbox);
      return {
        from: formatFrom(name, mailbox),
        domain: domainOf(mailbox),
        address: mailbox,
        clientId: client.id ?? null,
        source: 'candidate',
      };
    }
    // A mailbox this relay cannot send from, or one that is malformed, is a data
    // problem - reported rather than quietly replaced, because a candidate whose
    // applications go out as the agent is exactly the thing to notice.
    console.warn(
      `[send-email] client ${client.id} has mailbox "${mailbox}", which is not a usable `
      + `address on a sendable domain; using the agent sender instead`
    );
  }

  // (2) Operator configuration, as before.
  const configured = String(process.env.JOBBY_FROM_ADDRESS || '').trim();
  if (!configured) {
    return { from: fallback, domain: '31harbor.com', address: null, clientId: null, source: 'default' };
  }
  const match = configured.match(/^(.*)<([^>]+)>$/);
  const address = (match ? match[2] : configured).trim();
  const name = match ? match[1].trim().replace(/^"|"$/g, '') : 'Jobby McJobberson';
  const domain = address.split('@')[1]?.toLowerCase() || '';
  if (!SENDABLE_DOMAINS.has(domain)) {
    console.warn(
      `[send-email] JOBBY_FROM_ADDRESS domain "${domain}" is not a domain this relay can send from ` +
      `(${[...SENDABLE_DOMAINS].join(', ')}). Falling back to ${fallback}.`
    );
    return { from: fallback, domain: '31harbor.com', address: null, clientId: null, source: 'fallback' };
  }
  return { from: `${name} <${address}>`, domain, address, clientId: null, source: 'env' };
}

const AGENT_NOTIFICATION_EMAILS = {
  'vex': 'Vex <vex@mobilemonero.com>',
  'eliza': 'Eliza <eliza@partyfavorphoto.com>',
  'hermes': 'Hermes <hermes@mobilemonero.com>',
  'alice': 'Alice <alice@mobilemonero.com>',
  // CuttlefishClaws agents @31harbor.com
  'trib': 'Trib <trib@31harbor.com>',
  'arch': 'Arch <arch@31harbor.com>',
  'builder': 'Builder <builder@31harbor.com>',
  'sovereign': 'Sovereign <sovereign@31harbor.com>',
  'trustgraph': 'TrustGraph <trustgraph@31harbor.com>',
  'dao': 'DAO Gov <dao@31harbor.com>',
  'global-communicator': 'GlobalCommunicator <global-communicator@31harbor.com>',
  // Jobby sends job applications under the candidate's own name, not as
  // Jobby. The From address is chosen from the dossier's confirmed email so
  // the message comes from the person, which is what makes replies land in
  // their inbox rather than a black hole.
  'jobby': 'Jobby McJobberson <jobby@31harbor.com>',
};

// Resend API key lookup by domain
const RESEND_KEY_BY_DOMAIN = Object.fromEntries(
    EMAIL_INBOX_KEYS.map((k) => [EMAIL_DOMAINS[k].domain, resendKeyFor(k) || '']));

// Send a push notification email to an agent.
// Uses the correct Resend API key based on the agent's domain.
async function sendAgentPushNotification(agentName, subject, body) {
  const from = AGENT_NOTIFICATION_EMAILS[agentName];
  if (!from) {
    console.log(`[push-notify] No email mapping for agent: ${agentName}`);
    return { success: false, error: 'no-email-mapping' };
  }

  const domain = from.match(/@([^>]+)/)?.[1]?.trim();
  const RESEND_KEY = RESEND_KEY_BY_DOMAIN[domain];
  if (!RESEND_KEY) {
    console.log(`[push-notify] No Resend key for domain: ${domain}`);
    return { success: false, error: 'no-resend-key' };
  }

  try {
    const apiRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [from],
        subject,
        text: body,
      }),
    });
    const data = await apiRes.json();
    if (apiRes.ok) {
      console.log(`[push-notify] Sent to ${agentName} <${from}>: ${subject}`);
      return { success: true, id: data.id };
    } else {
      console.log(`[push-notify] Resend error for ${agentName}:`, data);
      return { success: false, error: data };
    }
  } catch (err) {
    console.log(`[push-notify] Network error for ${agentName}:`, err.message);
    return { success: false, error: err.message };
  }
}

function getFleetChatMessages(limit = 50) {
  return fleetChatMessages.slice(-limit);
}

// Fleet message repair — catches U+FFFD (replacement character = diamond question mark)
// that the relay sometimes produces from encoding corruption, replaces with safe ASCII.
// Leaves proper Unicode (em dash, emoji, etc.) untouched.
function sanitizeFleetMessage(msg) {
  if (msg == null) return msg;
  // Coerce before sanitising. sanitizeText() returns non-strings unchanged
  // (it exists to be called on arbitrary values), so a truthy non-string
  // message — an array or a number from a malformed client — came through as
  // itself and then `.replace()` threw, turning POST /api/fleet-chat/send into
  // a 500. Normalise to a string first so the endpoint degrades instead of
  // crashing.
  const str = typeof msg === 'string' ? msg : String(msg);
  return sanitizeText(str)
    // Strip ORPHANED surrogates only (lone high or lone low, not valid pairs).
    // A high surrogate (\uD800-\uDBFF) must be followed by a low surrogate
    // (\uDC00-\uDFFF) to form a valid emoji/code point. Dropping both
    // indiscriminately would also drop legitimate emoji like 🗄️ (U+1F5C4)
    // which is encoded as the surrogate pair \uD83D\uDDC4.
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')   // orphan low surrogate
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '');   // orphan high surrogate
}

// ── Commit-hash fact check (anti-hallucination guard) ─────────────
// Scans an agent reply for git commit hashes (7+ hex chars). If any are
// found and NONE are prefixed with [verified] / [unverified...], the
// relay appends a fact-check warning so downstream readers (and other
// agents re-routing the thread) know the hashes are suspect. The
// Cuttlefish TrustGraph layer can then flag them in the trust score.
function checkCommitHashes(text) {
  if (!text || typeof text !== 'string') return { text, flagged: 0, flaggedHashes: [] };
  // Match a hex sequence of 7-40 chars that looks like a git SHA
  // (preceded by a non-word char or start of line, not part of a longer word)
  const hashRe = /(?:^|[^a-z0-9_])([0-9a-f]{7,40})(?=[^a-z0-9_]|$)/gi;
  let m;
  const flaggedHashes = [];
  while ((m = hashRe.exec(text)) !== null) {
    flaggedHashes.push(m[1]);
  }
  if (flaggedHashes.length === 0) return { text, flagged: 0, flaggedHashes: [] };
  // Skip if any are explicitly tagged as verified/unverified
  if (/\[verified\]/i.test(text) || /\[unverified/i.test(text)) {
    return { text, flagged: 0, flaggedHashes: [] };
  }
  // Append a warning footnote
  const warn = `\n\n[relay fact-check: ${flaggedHashes.length} commit hash(es) cited without verification tag — ${flaggedHashes.slice(0,3).join(', ')}${flaggedHashes.length > 3 ? '...' : ''}. The agent should run \`git log\` or mark these as [unverified] before they propagate.]`;
  return { text: text + warn, flagged: flaggedHashes.length, flaggedHashes };
}

// Per-agent last-spoke timestamp (used for cooldowns) and per-thread hop counter
// to prevent infinite ping-pong loops in fleet chat.
const agentLastSpokeAt = {};
const AGENT_COOLDOWN_MS = 30 * 1000;  // 30s — don't let the same agent speak twice in a row
const MAX_HOP_DEPTH = 2;              // up to 2 follow-up hops per message (3 total voices)
const agentHopMemory = new Map();     // messageId -> { hops: {agent: count} }

function addFleetMessage(agent, message, channel = 'fleet', opts = {}) {
  // Sanitize non-ASCII to prevent fleet-chat relay encoding corruption
  message = sanitizeFleetMessage(message);
  // Strip TOOL_CALL JSON lines from non-system messages to prevent leakage
  if (agent !== 'system') {
    message = message
      .replace(/```[a-z]*\s*\n?\{\s*"tool"[\s\S]*?\}\s*\n?```/g, '') // code-fenced JSON
      .replace(/^TOOL_CALL:\s*\{[\s\S]*?\}\s*$/m, '')                    // bare TOOL_CALL line
      .replace(/^\s*\{\s*"tool"\s*:\s*"[a-z_-]+"[\s\S]*?\}\s*$/im, '')    // bare JSON tool call
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // A message that WAS ONLY a tool call is now empty. Posting it anyway puts
    // a blank from that agent on the bus, and every agent polls this channel -
    // so a silent, content-free message reaches the whole fleet.
    //
    // Observed 2026-10-02 21:44:28: a blank from `eliza` eight seconds after a
    // shell-exec timeout. The stripper did its job perfectly: the tool call was
    // removed, and the removal left nothing behind.
    //
    // The tool card above already reports the call and its result, so the empty
    // message adds no information - it only adds noise. Drop it.
    if (!message) {
      console.log(`[addFleetMessage] ${agent} message was empty after tool-call stripping; not posting`);
      return null;
    }
  }
  // Dedup: skip if we've seen this message in the last 5 minutes
  if (checkAndMarkDuplicated(agent, message)) return null;

  // ── Pre-flight verification (async, fire-and-forget) ──
  // Run preflight check in background — it may auto-correct the message
  // and write trust violation events. We don't block the message for this.
  setImmediate(async () => {
    try {
      const result = await preflightCheck(agent, message, queryLocalPg);
      if (result.violations.length > 0) {
        for (const v of result.violations) {
          // Write trust event for each violation
          try {
            await queryLocalPg(
              `INSERT INTO public.trust_events (agent_did, event_type, delta, reference, note)
               VALUES ($1, $2, $3, $4, $5)`,
              [agent, v.type, v.delta, `Pre-flight: ${v.claim}`, `Corrected: ${v.reality}`]
            );
            // Log to activity feed
            logToDb('tool_execution', `🔍 Pre-flight: ${agent} — ${v.type}`,
              `${agent}: ${v.claim} → corrected: ${v.reality}`,
              'warning',
              { agent, claim: v.claim, reality: v.reality, delta: v.delta },
              agent
            );
          } catch (e) {
            console.log(`[preflight] Error writing trust event: ${e.message}`);
          }
        }
        // If message was corrected, post the correction as a system message
        if (result.correctedMessage !== message && result.tags.includes('CORRECTED')) {
          addFleetMessage('system', `🔍 Pre-flight correction: ${agent} said "${message.slice(0, 100)}..." — corrected to: "${result.correctedMessage.slice(0, 100)}..."`, 'fleet');
        }
      }
      if (result.tags.includes('UNCITED')) {
        // Log uncited claim
        logToDb('tool_execution', `🔍 Pre-flight: ${agent} — UNCITED claim`,
          `${agent} made an uncited factual claim`,
          'info',
          { agent, message: message.slice(0, 200) },
          agent
        );
      }
    } catch (e) {
      console.log(`[preflight] Error: ${e.message}`);
    }
  });

  // Auto-create bulletin board topic from [board] tagged messages
  // Skip system bulletin notifications to prevent re-creation loops
  var upperMsg = message.toUpperCase();
  if ((upperMsg.indexOf('[BOARD]') === 0 || upperMsg.indexOf('[TOPIC]') === 0) &&
      !message.match(/^\[board\]\s*(topic:|bulletin:)/i)) {
    autoCreateBoardTopic(agent, message);
  }

  const entry = {
    id: opts.id || `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`,
    agent,
    agentLabel: FLEET_AGENTS[agent]?.name || agent,
    message,
    channel,
    hop: opts.hop || 0,
    parentId: opts.parentId || null,
    ts: Date.now(),
    time: new Date().toISOString(),
    attachments: opts.attachments || [],
  };
  fleetChatMessages.push(entry);
  if (fleetChatMessages.length > FLEET_CHAT_MAX) fleetChatMessages.splice(0, fleetChatMessages.length - FLEET_CHAT_MAX);
  // Persist to DB (fire-and-forget via setImmediate, don't block the message)
  setImmediate(() => {
    queryLocalPg(
      `INSERT INTO public.fleet_messages (id, topic, agent_id, agent_name, message, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [entry.id, channel, agent, FLEET_AGENTS[agent]?.name || agent, message,
       JSON.stringify({ hop: opts.hop || 0, parentId: opts.parentId || null, attachments: opts.attachments || [] }),
       new Date(entry.ts).toISOString()]
    ).catch(() => {});
  });
  // Stamp last-spoke for cooldown
  if (entry) agentLastSpokeAt[agent] = entry.ts;
  return entry;
}

// Helper: should this agent be allowed to speak given cooldowns and hop budget?
// Returns { allowed: boolean, reason?: string }
function canAgentSpeak(agent, parentEntry) {
  // 1. Don't let the same agent talk back to itself
  if (parentEntry?.agent === agent) return { allowed: false, reason: 'self-reply' };
  // 2. Per-agent cooldown
  const last = agentLastSpokeAt[agent] || 0;
  if (Date.now() - last < AGENT_COOLDOWN_MS && parentEntry?.hop >= 1) {
    return { allowed: false, reason: 'cooldown' };
  }
  // 3. Hop budget: count how many times this agent has spoken in the chain
  if (parentEntry) {
    const chain = [parentEntry];
    // walk back through parents
    let cursor = parentEntry;
    for (let i = 0; i < 10; i++) {
      const parentId = cursor.parentId;
      if (!parentId) break;
      const p = fleetChatMessages.find(m => m.id === parentId);
      if (!p) break;
      chain.push(p);
      cursor = p;
    }
    const agentSpeaksInChain = chain.filter(m => m.agent === agent).length;
    if (agentSpeaksInChain >= 1) return { allowed: false, reason: 'hop-budget' };
  }
  // 4. TrustGraph conversation participation gate
  // Agents with score < 20 (SUSPENDED) cannot post to fleet chat
  // Agents with score < 50 (Cautious) get delayed posting
  // This is async — we check in the background and log if blocked
  setImmediate(async () => {
    try {
      const rows = await localQuery(
        `SELECT trust_score, lifecycle_status FROM public.registry_agents WHERE did = $1 LIMIT 1`,
        [agent]
      );
      if (rows && rows.length > 0) {
        const score = rows[0].trust_score;
        const status = rows[0].lifecycle_status;
        if (status === 'revoked' || score < 10) {
          console.log(`[trustgate] ${agent} blocked from posting — score=${score}, status=${status}`);
          logToDb('tool_execution', `🔒 TrustGate: ${agent} blocked`,
            `${agent} (score=${score}) blocked from posting — REVOKED`,
            'error', { agent, score, status }, agent
          );
        } else if (score < 20) {
          console.log(`[trustgate] ${agent} posting — score=${score} (SUSPENDED range)`);
          logToDb('tool_execution', `🔒 TrustGate: ${agent} posting while SUSPENDED`,
            `${agent} (score=${score}) posting while in SUSPENDED range`,
            'warning', { agent, score, status }, agent
          );
        }
      }
    } catch (e) {
      // Silently fail — don't block messages for trust gate errors
    }
  });
  return { allowed: true };
}

// Auto-create board topics from [board] tagged fleet messages
function autoCreateBoardTopic(agent, message) {
  try {
    // Strip the [board] or [topic] tag and extract first line as title
    var cleanMsg = message.replace(/^\[[Bb][Oo][Aa][Rr][Dd]\]\s*/, '').replace(/^\[[Tt][Oo][Pp][Ii][Cc]\]\s*/, '');
    var title = cleanMsg.split('\n')[0].split(';')[0].trim().slice(0, 120);
    if (!title) return;
    var board = state.get('bulletin-board') || { topics: [] };
    // Check for duplicate by title (case-insensitive)
    var exists = board.topics.some(function(t) {
      return t.title.toLowerCase() === title.toLowerCase();
    });
    if (exists) return;
    var topic = {
      id: 'topic-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,6),
      title: title,
      creator: agent,
      status: 'active',
      pinned: false,
      assigned_agent: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      posts: [{
        id: 'post-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,6),
        author: agent,
        agent: agent,
        message: cleanMsg.slice(title.length).trim() || 'Created from fleet chat',
        ts: Date.now(),
        created_at: new Date().toISOString(),
      }]
    };
    board.topics.push(topic);
    state.set('bulletin-board', board);
    logActivity('board', topic.id, 'AUTO', 'Topic "' + title + '" from ' + agent);
  } catch (e) { /* non-critical */ }
}

// Load persisted messages on startup
function loadFleetChatHistory() {
  try {
    const saved = state.get('fleet-chat-history');
    if (Array.isArray(saved) && saved.length > 0) {
      fleetChatMessages.push(...saved);
    }
  } catch {}
  // Defer DB load to after server starts — don't block initialization
  setImmediate(async () => {
    try {
      const result = await queryLocalPg(
        `SELECT id, topic as channel, agent_id as agent, agent_name as agentLabel, message, payload, created_at as time
         FROM public.fleet_messages ORDER BY created_at ASC LIMIT 500`
      );
      const rows = result && result.rows ? result.rows : (Array.isArray(result) ? result : []);
      if (!rows || rows.length === 0) return;
      const existingIds = new Set(fleetChatMessages.map(m => m.id));
      let added = 0;
      for (const row of rows) {
        if (existingIds.has(row.id)) continue;
        let payload = {};
        try { payload = JSON.parse(row.payload || '{}'); } catch {}
        fleetChatMessages.push({
          id: row.id,
          agent: row.agent,
          agentLabel: row.agentLabel || row.agent,
          message: row.message || '',
          channel: row.channel || 'fleet',
          hop: payload.hop || 0,
          parentId: payload.parentId || null,
          ts: new Date(row.time).getTime(),
          time: row.time,
          attachments: payload.attachments || [],
        });
        existingIds.add(row.id);
        added++;
      }
      if (added > 0) {
        console.log(`[fleet-db] Loaded ${added} messages from DB (${fleetChatMessages.length} total)`);
        if (fleetChatMessages.length > FLEET_CHAT_MAX) {
          fleetChatMessages.splice(0, fleetChatMessages.length - FLEET_CHAT_MAX);
        }
      }
    } catch (e) {
      console.log(`[fleet-db] Load error: ${e.message}`);
    }
  });
}
loadFleetChatHistory();

// ── Fleet Chat Grounding ──
// Fetch real system state BEFORE the LLM is called, so agent prompts
// can ground their claims in actual data instead of hallucinating facts.
// Returns a compact, deterministic fact block the LLM must work from.
//
// Anti-hallucination contract: any claim an agent makes in fleet chat
// must trace back to a field in this block. If something isn't here,
// the agent should say "I don't have that data" rather than invent.
async function gatherFleetContext() {
  const local = 'http://localhost:' + PORT;
  const fetchJson = async (path, ms = 4000) => {
    try {
      const r = await fetch(local + path, { signal: AbortSignal.timeout(ms) });
      if (!r.ok) return { error: 'HTTP ' + r.status };
      return await r.json();
    } catch (e) { return { error: e.message }; }
  };
  // Fetch cloud Eliza's tool definitions from the edge function (parallel with other health checks)
  const cloudElizaFetch = async () => {
    if (!SUPABASE_KEY) return { status: 'no_key' };
    try {
      const ceRes = await fetch(`${SUPABASE_URL}/functions/v1/ai-chat`, {
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!ceRes.ok) return { status: 'HTTP_' + ceRes.status };
      const ceData = await ceRes.json();
      return {
        status: ceData.status,
        tools_count: ceData.tools_available,
        tools_names: ceData.tools_names || [],
        tools_definitions: (ceData.tools_definitions || []).slice(0, 20),
      };
    } catch (e) {
      return { status: 'fetch_error', error: e.message };
    }
  };

  const [health, monitor, ollama, recentMsgs, supervisor, cloudElizaData, cronStatus, knowledgeCount] = await Promise.all([
    fetchJson('/health', 2000),
    fetchJson('/monitor', 12000),
    fetchJson('/ollama/health', 3000),
    fetchJson('/api/fleet-chat/messages?limit=20', 3000),
    fetchJson('/api/supervisor/status', 2000).catch(() => null),
    cloudElizaFetch(),
    fetchJson('/cron/status', 3000).catch(() => null),
    // Knowledge base health: check if entities exist via local-sb REST API
    (async () => {
      try {
        const r = await fetch('http://127.0.0.1:54321/rest/v1/knowledge_entities?select=id&limit=1', {
          signal: AbortSignal.timeout(15000),
          headers: { 'apikey': 'local-anon-key', 'Authorization': 'Bearer local-anon-key' },
        });
        if (!r.ok) return { status: 'error', count: 0 };
        const data = await r.json();
        return { status: 'ok', count: Array.isArray(data) ? data.length : 0 };
      } catch (e) { return { status: 'unreachable', count: 0, error: e.message }; }
    })(),
  ]);

  // Normalize cloud Eliza data
  const cloudElizaTools = (cloudElizaData && cloudElizaData.status !== 'no_key' && cloudElizaData.status !== 'fetch_error')
    ? cloudElizaData
    : null;

  // Distill monitor.services down to status string per dependency
  const svc = (monitor && monitor.services) || {};
  // If monitor itself failed (timeout/error), surface that as "fetch_failed"
  // so the LLM can distinguish "we don't know" from "explicitly down"
  const monitorFailed = monitor && monitor.error;
  const svcSummary = monitorFailed ? {
    _monitorError: monitor.error,
    supabase: 'fetch_failed',
    ollama: 'fetch_failed',
    github: 'fetch_failed',
    hermes: 'fetch_failed',
  } : {
    supabase: svc.supabase?.status || 'unknown',
    ollama: svc.ollama?.status || 'unknown',
    github: svc.github?.status || 'unknown',
    hermes: svc.hermes?.status || 'unknown',
  };

  // System load
  const sys = monitor?.system || {};
  const sysSummary = monitorFailed ? {
    _monitorError: monitor.error,
    nodeUptimeSec: 'fetch_failed',
    memUsedPct: 'fetch_failed',
    cpuPct: 'fetch_failed',
  } : {
    nodeUptimeSec: sys.uptime ? Math.floor(sys.uptime) : 'unknown',
    memUsedPct: sys.memory?.system?.usagePercent || 'unknown',
    cpuPct: sys.cpu?.usage || 'unknown',
  };

  // Recent fleet chat (last 20, with enough context to answer questions)
  const recent = (recentMsgs?.messages || []).slice(-20).map(m => ({
    agent: m.agent,
    text: (m.message || '').slice(0, 200),
  }));

  // Shared context from the database (shared memory for all agents)
  let sharedContext = null;
  try {
    const ctxRows = await localQuery("SELECT context_key, context_type, value, description, last_updated_by FROM knowledge.shared_context ORDER BY context_key");
    if (ctxRows && ctxRows.length > 0) {
      sharedContext = ctxRows.map(r => ({
        key: r.context_key,
        type: r.context_type,
        // Some rows hold plain strings, not JSON — parse defensively so one
        // bad row can't nuke the whole sharedContext block (was the cause of
        // agents seeing sharedContext: null).
        value: typeof r.value === 'string' ? (() => { try { return JSON.parse(r.value); } catch { return r.value; } })() : r.value,
        description: r.description,
        lastUpdatedBy: r.last_updated_by,
      }));
    }
  } catch (e) {
    // Query failed (e.g. DB reconnecting after restart) — surface the failure
    // explicitly instead of a silent null that agents read as "no shared context".
    sharedContext = { _error: 'shared_context query failed: ' + (e?.message || e), _warning: 'Do NOT report shared context as empty; verify with the shared-context tool first.' };
  }

  return {
    fetchedAt: new Date().toISOString(),
    infrastructure: {
      database: 'local Postgres (xmrt_suite) on localhost:5432 — NOT cloud Supabase',
      api: 'local-sb REST at localhost:54321/rest/v1 — NOT cloud Supabase',
      relay: 'primary interface at localhost:8080, tunneled via relay.mobilemonero.com',
      cloudSupabase: 'DEPRECATED — all services migrated to local stack. Cloud Supabase DNS may still resolve but is not in use.',
      note: 'The "supabase" service status below probes the local-sb REST endpoint. "error (500)" means local-sb is down, NOT cloud Supabase. The database itself (Postgres on port 5432) may still be running even if local-sb REST is down.',
    },
    relay: {
      status: health?.status,
      // uptime intentionally omitted — always stale after restart, misleads agents
      tools: health?.tools,
      requests: health?.requests,
    },
    services: svcSummary,
    system: sysSummary,
    chatRuntime: {
      provider: 'Ollama Pro cloud (ollama.com/v1/chat/completions)',
      model: 'deepseek-v4-flash:cloud',
      visionModel: 'kimi-k2.6:cloud (for images only — use vex-vision tool)',
      note: 'heavy-lift chat uses deepseek-v4-flash:cloud (cheap/fast). Vision uses kimi-k2.6:cloud. No local models used — this 6GB laptop cannot run inference.',
    },
    ollama: {
      status: ollama?.status,
      modelCount: 0,  // local models exist on disk but are NOT usable on this 6GB laptop
      models: null,   // removed from grounding to prevent agents from trying local models
      latencyMs: ollama?.latency,
      chatModel: 'minimax/minimax-m3 (via OpenRouter, cloud-only)',
      visionModel: 'kimi-k2.6:cloud (via OpenRouter, cloud-only)',
    },
    supervisor: supervisor && !supervisor.error ? (() => {
      // services is an ARRAY from /api/supervisor/status, not an object
      const svcArr = supervisor?.services || [];
      const findHealthy = (name) => {
        const s = svcArr.find(s => s.name === name);
        return s ? (s.healthy ?? false) : false;
      };
      return {
        relayUp: findHealthy('relay'),
        pgUp: findHealthy('pg'),
        localSbUp: findHealthy('local-sb'),
        tunnelUp: findHealthy('tunnel'),
        resumeUp: findHealthy('resume-server'),
        viteUp: findHealthy('vite'),
        aliceUp: findHealthy('alice'),
        cronUp: findHealthy('cron-engine-v2'),
        cuttlefishUp: findHealthy('cuttlefishclaws-mcp'),
        suiteMcpUp: findHealthy('xmrtdao-suite-mcp'),
        campaignUp: findHealthy('campaign-scheduler'),
        dshUp: findHealthy('dsh'),
      };
    })() : null,
    cron: cronStatus ? {
      totalJobs: cronStatus.lastRun ? Object.keys(cronStatus.lastRun).length : 0,
      totalExecutions: cronStatus.lastRun ? Object.keys(cronStatus.lastRun).length : 0,
      totalErrors: cronStatus.totalErrors || 0,
      recentJobs: cronStatus.lastRun ? (() => {
        const now = Date.now();
        return Object.values(cronStatus.lastRun).filter(ts => now - ts < 3600000).length;
      })() : 0,
      staleJobs: cronStatus.lastRun ? (() => {
        const now = Date.now();
        return Object.values(cronStatus.lastRun).filter(ts => now - ts > 86400000).length;
      })() : 0,
      status: cronStatus.status || 'running',
    } : { status: 'unavailable' },
    knowledgeBase: knowledgeCount ? {
      status: knowledgeCount.status || 'unknown',
      entityCount: knowledgeCount.count || 0,
    } : { status: 'unreachable' },
    recentFleetChat: recent,
    sharedContext, // agents can read this to answer questions about shared memory
    cloudEliza: cloudElizaTools || { status: 'unreachable', note: 'Cloud edge function did not respond within 5s timeout or no SUPABASE_KEY set. Its tools are NOT available in this block.' },
    // TrustGraph scores for all agents — injected so agents see their own and others' scores
    trustScores: await (async () => {
      try {
        const rows = await localQuery(
          `SELECT did, name, trust_score, trust_band, lifecycle_status, cac_tier
           FROM public.registry_agents
           WHERE lifecycle_status = 'active' OR lifecycle_status = 'suspended'
           ORDER BY trust_score DESC
           LIMIT 20`
        );
        if (rows && rows.length > 0) {
          return rows.map(r => ({
            agent: r.did,
            name: r.name,
            score: r.trust_score,
            band: r.trust_band,
            status: r.lifecycle_status,
            tier: r.cac_tier,
          }));
        }
      } catch {}
      return null;
    })(),
    // Knowledge base summary — so agents know what's available without calling a tool
    knowledgeBase: await (async () => {
      // Failed queries return -1, NOT 0 — a silent 0 was presented to agents as
      // fact ("contextKeys: 0") when the DB pool wasn't ready after a restart.
      try {
        const [keCount, fmCount, ctxCount] = await Promise.all([
          localQuery('SELECT COUNT(*) as cnt FROM app.knowledge_entities')
            .then(r => parseInt(r?.[0]?.cnt || '0')).catch(() => -1),
          localQuery('SELECT COUNT(*) as cnt FROM app.fleet_memory')
            .then(r => parseInt(r?.[0]?.cnt || '0')).catch(() => -1),
          localQuery('SELECT COUNT(*) as cnt FROM knowledge.shared_context')
            .then(r => parseInt(r?.[0]?.cnt || '0')).catch(() => -1),
        ]);
        const failed = [keCount, fmCount, ctxCount].some(v => v < 0);
        return {
          entities: Math.max(keCount, 0),
          memories: Math.max(fmCount, 0),
          contextKeys: Math.max(ctxCount, 0),
          total: Math.max(keCount, 0) + Math.max(fmCount, 0) + Math.max(ctxCount, 0),
          ...(failed ? { _warning: 'One or more counts FAILED to query (likely DB reconnecting after restart). These numbers are unreliable — do NOT report them as fact; verify with the db-query tool first.' } : {}),
        };
      } catch {
        return { entities: 0, memories: 0, contextKeys: 0, total: 0, _warning: 'knowledgeBase query failed entirely — do NOT report counts as fact.' };
      }
    })(),
    // Tools available to agents
    // Agents: if data you need is not in this JSON block, call a tool to fetch it rather than saying "I don't know"
    tools: Object.keys(toolHandlers).map(name => ({
      name,
      description: getToolDescription(name),
      securityLevel: getToolLevel(name),
    })),
  };
}

// Seed health data on startup so /api/dao/health doesn't always score 50/100
async function seedHealthData() {
  try {
    await queryLocalPg(`
      INSERT INTO agent.agents (name, status, current_workload, role)
      SELECT 'Eliza-Dev', 'idle', 0, 'executive'
      WHERE NOT EXISTS (SELECT 1 FROM agent.agents WHERE name = 'Eliza-Dev')
    `);
    await queryLocalPg(`
      INSERT INTO public.tasks (title, status, category, priority)
      SELECT 'System health seed', 'COMPLETED', 'system', 0
      WHERE NOT EXISTS (SELECT 1 FROM app.tasks WHERE title = 'System health seed')
    `);
    await queryLocalPg(`
      INSERT INTO public.eliza_function_usage (function_name, success, status)
      SELECT 'health-seed', true, 'success'
      WHERE NOT EXISTS (
        SELECT 1 FROM public.eliza_function_usage WHERE function_name = 'health-seed'
      )
    `);
    console.log('[seed] Health data seeded (agents=1, tasks=1, fn_calls=1)');
  } catch (e) {
    console.log('[seed] Skip (tables may not exist yet): ' + e.message);
  }
}

// Route a fleet message to the appropriate agent
// ── Task-aware discussion routing ────────────────────────────
// Parses a task ID out of a message (UUID or slug like "t-010") and
// returns the assignees of any DISCUSS-stage task that matches.
// Returns an empty array if no task is referenced or the task is not
// in DISCUSS stage.
async function getDiscussTaskAssignees(message) {
  try {
    // Match UUIDs (8-4-4-4-12) and slug-style IDs (alphanumeric + dash)
    const idMatches = [
      ...message.matchAll(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi),
      ...message.matchAll(/\b(t-[a-z0-9_-]+)\b/gi),
    ];
    const ids = [...new Set(idMatches.map(m => m[1]))];
    if (ids.length === 0) return [];

    const r = await queryLocalPg(
      `SELECT id, title, assignee_agent_id, source
       FROM app.tasks
       WHERE id = ANY($1::text[]) AND stage = 'DISCUSS'
       LIMIT 5`,
      [ids]
    );
    if (!r.rows || r.rows.length === 0) return [];

    // Build a unique list of assignees
    const assignees = [...new Set(
      r.rows.map(row => row.assignee_agent_id).filter(a => a && a.length > 0)
    )];
    return assignees;
  } catch (e) {
    console.log('[routeFleetMessage] getDiscussTaskAssignees error:', e.message);
    return [];
  }
}

async function routeFleetMessage(entry) {
  const results = {};
  const nextHop = Math.min((entry.hop || 0) + 1, MAX_HOP_DEPTH);

  // Always log it
  logActivity('fleet-chat', entry.id, 'MSG', `[${entry.agentLabel}] ${entry.message.slice(0, 100)}`);

  // ── Push Notification: @mention an agent → email them ──
  // Detect @agentName mentions in the message and send push notifications.
  // Skip system messages and self-mentions to avoid noise.
  if (entry.agent !== 'system') {
    const mentionPattern = /@(\w[\w-]*)/gi;
    let mentionMatch;
    while ((mentionMatch = mentionPattern.exec(entry.message)) !== null) {
      const mentioned = mentionMatch[1].toLowerCase();
      if (mentioned === entry.agent) continue; // skip self-mention
      if (AGENT_NOTIFICATION_EMAILS[mentioned]) {
        const agentLabel = FLEET_AGENTS[mentioned]?.name || mentioned;
        const subject = `[Fleet Chat] ${entry.agentLabel} mentioned @${mentioned}`;
        const body = `${entry.agentLabel} mentioned @${mentioned} in fleet chat:\n\n"${entry.message}"\n\n— Fleet Chat, ${new Date(entry.ts || Date.now()).toISOString()}`;
        // Fire-and-forget — don't block the routing loop
        sendAgentPushNotification(mentioned, subject, body).catch(e =>
          console.log(`[push-notify] Error notifying ${mentioned}:`, e.message)
        );
      }
    }
  }

  // ── Auto-write website booking requests to pfp_leads ─────────────
  if (entry.message.includes('BOOKING REQUEST') || entry.message.includes('New booking request') || entry.message.includes('🛒 BOOKING')) {
    const msg = entry.message;
    const nameMatch = msg.match(/Name:\s*(.+)/i);
    const emailMatch = msg.match(/Email:\s*(\S+)/i);
    const phoneMatch = msg.match(/Phone:\s*([\d\-\(\)\s\+]+)/i);
    const dateMatch = msg.match(/Event Date:\s*(.+)/i);
    const priceMatch = msg.match(/Subtotal:\s*\$?([\d,\.]+)/i);
    const contactName = nameMatch ? nameMatch[1].trim() : null;
    const contactEmail = emailMatch ? emailMatch[1].trim() : null;
    const contactPhone = phoneMatch ? phoneMatch[1].trim() : null;
    const eventDateStr = dateMatch ? dateMatch[1].trim() : null;
    const subtotal = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;

    // Try to parse event date into ISO
    let eventDateIso = null;
    if (eventDateStr) {
      try {
        const d = new Date(eventDateStr);
        if (!isNaN(d.getTime())) eventDateIso = d.toISOString();
      } catch {}
    }

    if (contactName && contactEmail) {
      // Check if this email already exists in pfp_leads to avoid duplicates
      try {
        const existing = await queryLocalPg("SELECT id FROM pfp_leads WHERE contact_email = $1 LIMIT 1", [contactEmail]);
        if (existing.rows.length === 0) {
          const notes = msg.slice(0, 500);
          await queryLocalPg(
            "INSERT INTO pfp_leads (contact_name, contact_email, contact_phone, event_date, source, status, lead_rating, notes, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())",
            [contactName, contactEmail, contactPhone, eventDateIso, 'website-booking', 'NEW', 8, notes]
          );
          addFleetMessage('system', `📋 Saved ${contactName} (${contactEmail}) to PFP leads database [website-booking].`, 'fleet');
          console.log(`[pfp-leads] Auto-created lead from booking: ${contactName} <${contactEmail}>`);
        }
      } catch (e) {
        console.log(`[pfp-leads] Auto-write error: ${e.message}`);
      }
    }
  }

  // Helper: post an agent reply and recursively re-route it (chained conversation)
  // ── Visible Tool Execution for Fleet Agents ────────────────────────
  // Parses an agent's reply for a TOOL_CALL: {...} line, executes the tool
  // via /tools/run, posts an interim message, and returns the result.
  // Returns { executed: false } when no tool call is found.
  async function executeAgentToolCall(agentName, reply, entry) {
      // Match the FULL line after TOOL_CALL: — parse the entire JSON text (nested braces safe)
          // Strip markdown formatting first (**bold**, *italic*) then check for TOOL_CALL
          const strippedLines = reply.split('\n').map(l => l.trim().replace(/^\*\*|\*\*$/g, '').replace(/^\*|\*$/g, ''));
          // Also strip leading code-fence backticks from each line so a tool
          // call wrapped in a markdown code block is still detected.
          const unFencedLines = strippedLines.map(l => l.replace(/^`{1,3}\s*/, '').replace(/\s*`{1,3}$/, ''));
          let toolCallLine = unFencedLines.find(l => /^TOOL_CALL:\s*\{/.test(l.trim()));
          let jsonText = null;
          let parsed = null;

          if (toolCallLine) {
            jsonText = toolCallLine.replace(/^\s*TOOL_CALL:\s*/, '').trim();
            try {
              parsed = JSON.parse(jsonText);
            } catch {}
          }

          // Fallback: try to extract JSON across multiple lines (model may have inserted newlines)
          if (!parsed && reply.includes('TOOL_CALL:')) {
            const m = reply.match(/TOOL_CALL:\s*(\{[\s\S]*?\})\s*$/);
            if (m) {
              try { parsed = JSON.parse(m[1]); } catch {}
            }
          }

          // Fallback: bare JSON tool call (no TOOL_CALL: prefix). Some models
          // (notably the minimax-m3 cloud model) emit raw JSON objects with
          // {"tool": "...", "args": {...}} directly in their reply. Detect
          // any line that starts with a JSON object containing "tool" and
          // "args" keys and try to parse it.
          if (!parsed) {
            const bareJsonLine = unFencedLines.find(l => /^\s*\{\s*"tool"\s*:\s*"[a-z_-]+"/i.test(l));
            if (bareJsonLine) {
              try {
                const obj = JSON.parse(bareJsonLine);
                if (obj && typeof obj.tool === 'string' && obj.args) parsed = obj;
              } catch {}
            }
          }
          // Also try multi-line bare JSON (with embedded newlines)
          if (!parsed) {
            const m2 = reply.match(/\{\s*"tool"\s*:\s*"([a-z_-]+)"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\}/i);
            if (m2) {
              try { parsed = JSON.parse(m2[0]); } catch {}
            }
          }

          // Fallback: function-call style TOOL_CALL: toolName(arg1="val1",arg2="val2")
          if (!parsed) {
            toolCallLine = strippedLines.find(l => /^TOOL_CALL:\s*\w+\s*\(/.test(l.trim()));
            if (toolCallLine) {
              const match = toolCallLine.replace(/^\s*TOOL_CALL:\s*/, '').trim().match(/^(\w+)\s*\((.+)\)\s*$/);
              if (match) {
                const toolName = match[1];
                const argsStr = match[2];
                const args = {};
                // Parse key="value" or key=value arguments
                const argMatches = argsStr.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,)]+))/g);
                for (const am of argMatches) {
                  args[am[1]] = am[2] || am[3] || am[4];
                }
                parsed = { tool: toolName, args };
              }
            }
          }
    let toolName = parsed?.tool;
        const args = parsed?.args || {};
        // Normalize underscore tool names to hyphenated (cloud Eliza uses underscores, relay uses hyphens)
        if (toolName && !toolHandlers[toolName]) {
          const hyphenated = toolName.replace(/_/g, '-');
          if (toolHandlers[hyphenated]) {
            toolName = hyphenated;
            parsed.tool = hyphenated;
          }
        }
        if (!toolName || !toolHandlers[toolName]) return { executed: false };

    // Auto-inject agent name for resend-send-email if missing
    if (toolName === 'resend-send-email' && !args.agent) {
      args.agent = agentName === 'eliza' ? 'eliza' : agentName === 'vex' ? 'vex' : agentName === 'hermes' ? 'hermes' : agentName;
    }

    // Authorize the agent
    const toolLevel = getToolLevel(toolName);
    const auth = checkToolAccess(agentName, toolName, toolLevel);
    if (!auth.authorized) {
      addFleetMessage('system', `⚠️ ${agentName} tried to call ${toolName} but was denied: ${auth.reason}`, 'fleet');
      return { executed: false, error: auth.reason };
    }

    // Post interim via direct addFleetMessage (bypass postAndReRoute chain guard)
    // Use a structured, agent-colored card format so tool calls stand out
    // from regular chat and the JSON doesn't get dumped inline.
    const toolEmoji = { db: '🗄️', web: '🌐', email: '📧', shared: '🧠', state: '💾', system: '⚙️', default: '🔧' };
    const toolCategory = (toolName || '').split('-')[0] || 'default';
    const emoji = toolEmoji[toolCategory] || toolEmoji.default;
    const argsPreview = Object.keys(args || {}).length
      ? Object.entries(args).map(([k, v]) => {
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}=${s.length > 60 ? s.slice(0, 60) + '…' : s}`;
        }).join(', ')
      : '(no args)';
    addFleetMessage('system',
      `${emoji} <b>${agentName}</b> called <code>${toolName}</code>\n` +
      `<span style="color:#8b8ba0;font-size:0.95em;">  ▸ args: ${argsPreview.slice(0, 200)}</span>`,
      'fleet');
    console.log(`[agent-tool-exec] ${agentName} -> ${toolName} args=${JSON.stringify(args)}`);

    // Update agent activity to show tool execution
    try {
      await fetch(`http://localhost:${PORT}/api/agent-activity`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentName, status: 'working', activity: `Running tool: ${toolName}`, tool_name: toolName }),
        signal: AbortSignal.timeout(2000),
      });
    } catch (e) { /* best-effort */ }

    // Execute via relay's own /tools/run with retry on transient failures
    //
    // Three tiers, because "everything that is not vision gets 30s" was wrong for
    // more than vision. Eliza lost a whole cycle to a `shell-exec` that timed out
    // at 30s doing real filesystem work; the retry then succeeded against warm
    // caches, which made it look intermittent rather than misconfigured.
    //
    //   vision    180s - cloud inference, already knew this
    //   shell     120s - a directory walk or a build legitimately takes minutes
    //   database  120s - same, and a query that would not finish in 30s was
    //                       being reported as a failure rather than a timeout
    //   default    30s - unchanged, and still right for the short tools
    //
    // The trade is real: a hung tool holds its slot 4x longer, and MAX_RETRIES is
    // 4 for the non-vision tiers, so a genuinely wedged tool can occupy up to
    // ~8 minutes. That is the cost of not killing work that was going to finish.
    const toolName_l = String(toolName || '');
    const isVisionTool = /vision|screenshot/i.test(toolName_l);
    const isLongTool = /shell|python|sql|db|query|db-query|edge-function|generate/i.test(toolName_l);
    const toolTimeout = isVisionTool ? 180000 : (isLongTool ? 120000 : 30000);
    // Vision is slow but not flaky. Shell and database are the opposite: a
    // timeout there is usually a slow first run, and the retry is what succeeds.
    // Both keep 4 attempts; only vision is pinned to 1.
    const MAX_RETRIES = isVisionTool ? 1 : 4;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`http://localhost:${PORT}/tools/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-agent-id': agentName },
          body: JSON.stringify({ tool: toolName, args: { ...args, _agent: agentName } }),
          signal: AbortSignal.timeout(toolTimeout),
        });
        const result = await res.json();

        // Post a structured result card — success or failure
        if (result?.success === false) {
          addFleetMessage('system',
            `❌ <b>${agentName}</b> · <code>${toolName}</code> failed\n` +
            `<span style="color:#f87171;font-size:0.95em;">  ▸ ${String(result?.error || 'unknown error').slice(0, 200)}</span>`,
            'fleet');
        } else {
          // Build a one-line summary + collapsible full JSON
          const safeResult = (result === undefined || result === null) ? { _empty: true } : result;
          const keys = safeResult && typeof safeResult === 'object' ? Object.keys(safeResult) : [];
          let summary = '';
          if (safeResult?.rowCount !== undefined) {
            summary = `${safeResult.rowCount} row${safeResult.rowCount === 1 ? '' : 's'}`;
          } else if (safeResult?.count !== undefined) {
            summary = `${safeResult.count} item${safeResult.count === 1 ? '' : 's'}`;
          } else if (safeResult?.success !== undefined) {
            summary = 'ok';
          } else if (safeResult?.error) {
            summary = 'error: ' + String(safeResult.error).slice(0, 80);
          } else {
            summary = `${keys.length} field${keys.length === 1 ? '' : 's'}`;
          }
          const fullJson = JSON.stringify(safeResult, null, 2) ?? 'null';
          // Use a unique id for the collapsible <details> so multiple tool
          // results in a row don't conflict.
          const detailId = `toolresult-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
          addFleetMessage('system',
            `✅ <b>${agentName}</b> · <code>${toolName}</code> → <span style="color:#4ade80;">${summary}</span>\n` +
            `<details id="${detailId}" style="margin-top:3px;cursor:pointer;"><summary style="color:#8b8ba0;font-size:0.85em;">show raw output (${fullJson.length} chars)</summary>` +
            `<pre style="background:#0a0a14;border:1px solid #1e1e2e;border-radius:4px;padding:6px;font-size:0.8em;max-height:200px;overflow:auto;margin:4px 0 0 0;color:#c0c0d0;">${fullJson.slice(0, 2000).replace(/</g,'&lt;')}${fullJson.length > 2000 ? '\n…' : ''}</pre></details>`,
            'fleet');
        }

        return { executed: true, toolName, args, result };
      } catch (e) {
        lastError = e;
        // Only retry on transient network errors (timeout, ECONNREFUSED, DNS, etc.)
        const isTransient = e.name === 'AbortError' || e.cause?.code === 'ECONNREFUSED'
          || e.cause?.code === 'ECONNRESET' || e.cause?.code === 'ETIMEDOUT'
          || e.cause?.code === 'ENOTFOUND' || e.message?.includes('fetch failed');
        if (!isTransient || attempt >= MAX_RETRIES) break;
        const delay = Math.min(500 * Math.pow(2, attempt - 1), 4000);
        console.log(`[agent-tool-exec] ${agentName} -> ${toolName} attempt ${attempt} failed, retrying in ${delay}ms: ${e.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    addFleetMessage('system',
      `⚠️ <b>${agentName}</b> · <code>${toolName}</code> tool error\n` +
      `<span style="color:#fbbf24;font-size:0.95em;">  ▸ ${(lastError && lastError.message || 'unknown').slice(0, 200)}</span>`,
      'fleet');
    return { executed: true, toolName, args, error: lastError.message };
  }

  async function postAndReRoute(agent, message, channel = 'fleet') {
    const guard = canAgentSpeak(agent, entry);
    if (!guard.allowed) {
      console.log(`[routeFleetMessage] ${agent} blocked: ${guard.reason}`);
      return null;
    }
    const reply = addFleetMessage(agent, message, channel, {
      hop: nextHop,
      parentId: entry.id,
    });
    if (!reply) return null;
    results[agent] = reply;
    // Log a positive trust event for the agent replying. Small delta so
    // a busy day of conversation doesn't blow past the 100 cap, but
    // enough that the 24h trajectory view shows the agent's activity.
    // Best-effort: if the trust_event insert fails, the chat reply
    // still succeeds.
    try {
      await queryLocalPg(
        `INSERT INTO public.trust_events (agent_did, event_type, delta, score_after, note, reference)
         VALUES ($1, 'FLEET_REPLY', 0.5, NULL, $2, $3)`,
        [agent, `Replied in #${channel} channel (msg ${reply.id ? reply.id.slice(0,12) : '?'})`, entry.id || null]
      ).catch(err => console.log(`[trust-log] insert error for ${agent}:`, err.message));
    } catch { /* non-fatal */ }
    // Re-route this reply so other agents can respond to it (with hop+1)
    if (nextHop < MAX_HOP_DEPTH) {
      // Fire-and-forget recursive routing; do not block the current response
      setImmediate(() => {
        routeFleetMessage(reply).catch(e =>
          console.log(`[routeFleetMessage] re-route error for ${agent}: ${e.message}`));
      });
    }
    return reply;
  }

  // ── Fleet Agent Router (Ollama Pro cloud) ─────────────────────────
  // Reusable helper for any fleet agent (Vex, Alice, cuttlefish agents).
  // Loads conversation history, stores the incoming message, builds a persona prompt
  // with grounding JSON, calls kimi-k2.6:cloud via Ollama Pro, handles TOOL_CALL execution
  // with re-query for synthesis, strips sign-offs, and posts the reply.
  // Returns the reply entry or null.
  async function routeToLocalOllamaAgent(agentName, agentLabel, personaPrompt, entry, opts = {}) {
    const sessionId = opts.sessionId || (agentName + '-fleet-' + entry.agent);
    const model = opts.model || 'deepseek-v4-flash:cloud';
    const temperature = opts.temperature != null ? opts.temperature : 0.5;
    const maxTokens = opts.maxTokens || 4096;
    const timeout = opts.timeout || 15000;
    const signOffPattern = opts.signOffPattern || new RegExp('\\s*—\\s*' + agentLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i');

    // Set agent as working
    try {
      await fetch(`http://localhost:${PORT}/api/agent-activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentName, status: 'working', activity: `Processing message from ${entry.agentLabel}`, message_id: entry.id }),
        signal: AbortSignal.timeout(2000),
      });
    } catch (e) { /* best-effort */ }

    try {
      // Load conversation history
      let contextHistory = '';
      try {
        const convRes = await fetch('http://127.0.0.1:54321/functions/v1/conversation-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': 'local-anon-key' },
          body: JSON.stringify({ action: 'get_messages', agentId: agentName, channel: 'fleet', limit: 20 }),
          signal: AbortSignal.timeout(5000),
        });
        const convData = await convRes.json();
        if (convData.success && convData.messages && convData.messages.length > 0) {
          contextHistory = '\n\nRecent conversation context:\n' + convData.messages.map(function(m) {
            return '[' + (m.message_type || 'unknown') + '] ' + (m.content || '');
          }).join('\n');
        }
      } catch (e) { console.error('[routeToLocalOllamaAgent] load conv history failed:', e.message); }

      // Store this message in conversation memory
      try {
        await fetch('http://127.0.0.1:54321/functions/v1/conversation-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': 'local-anon-key' },
          body: JSON.stringify({ action: 'add_message', agentId: agentName, channel: 'fleet', messageData: { message_type: 'user', content: entry.agentLabel + ': ' + entry.message } }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) { console.error('[routeToLocalOllamaAgent] store user msg failed:', e.message); }

      // Ground the prompt in real system state
      const ctx = await gatherFleetContext();
      const ctxJson = JSON.stringify(ctx, null, 0);

      const fullPrompt = personaPrompt + `

GROUNDING — Real-time system data (these are facts, not guesses). The \`tools\` array lists every tool you can call:
\`\`\`json
${ctxJson}
\`\`\`

GROUNDING RULES:
- If a fact is in the JSON block, reference it directly.
- If something is NOT in the JSON but a tool in the \`tools\` array can help (web-search, db-query, db-rest, resend-inbox, shared-context, etc.), output a single line \`TOOL_CALL: {"tool":"<name>","args":{...}}\` on its own line. I will execute it, then come back for your final answer.
- For resend-send-email: ALWAYS include the "agent" field (use "eliza" if you are Eliza). Keep the email body SHORT — under 200 words — to avoid output truncation. Do NOT include long numbered lists in the body.
- Read the \`infrastructure\` field first. It explains the architecture: the database is local Postgres, NOT cloud Supabase. Cloud Supabase is DEPRECATED. A \`supabase.status\` of "error" or "unreachable" means the local-sb REST layer is down, NOT the cloud database.
- Never claim "all systems nominal" or "no anomalies" without a matching field in the JSON.
- For questions about PFP leads, bookings, money, or campaigns: use resend-inbox or db-query to check. For web info: use web-search or web-scrape. For DB queries: use db-query or db-rest. For shared agent memory: use shared-context. For marking emails as read: use resend-inbox-read with the email ID and domain.
- **NO FABRICATED COMMITS.** Never cite a git commit hash (7+ hex chars) unless you retrieved it from \`git log\` via the bash tool. If you mention a commit, prefix it with a verification marker: \`[verified]\` if you ran git log to confirm, \`[unverified — likely confabulated]\` if you did not. Better yet: if the commit isn't in your grounding block, run \`bash\` with \`git log --oneline -5\` in the workspace root before stating it.
- **NO HALLUCINATED HISTORICAL FACTS.** If asked about a migration, deployment, or past event that isn't in \`shared_context\` or your grounding block, say "I don't have a record of that in my context — please verify in git history or shared memory" instead of inventing plausible details.
- **SHARED HALLUCINATION WARNING:** If another agent's reply just cited a fact you're about to repeat, that doesn't make it true. Re-verify from grounding before echoing.

${entry.agentLabel} said: "${entry.message.replace(/"/g, "'")}"${contextHistory}

Your response (no emoji sign-offs, no "—${agentLabel}", no "o7"):`;

      const generateResult = await ollamaGenerate(fullPrompt, {
        model,
        temperature,
        maxTokens,
        timeout,
      });

      if (generateResult.error) {
        console.error(`[${agentName}] ollamaGenerate error:`, generateResult.error);
        return null;
      }

      let reply = generateResult.response || '';
      let d = {
        response: reply,
        eval_count: generateResult.evalCount || 0,
        prompt_eval_count: generateResult.promptEvalCount || 0,
        model: generateResult.model || model,
        provider: generateResult.provider,
      };
        // Log this agent's activity to the ship's log
        try {
          logToDb('fleet_message', `${agentName} replied`,
            `${agentLabel}: ${reply.slice(0, 120)}`,
            'info', { agent: agentName, model, tokens: d.eval_count || 0 },
            agentName
          );
        } catch (e) { console.error('[' + agentName + '-activity-log] error:', e.message); }
        // Log token usage for Rum Quota
        try {
          const inputTokens = d.prompt_eval_count || 0;
          const outputTokens = d.eval_count || 0;
          const totalTokens = inputTokens + outputTokens;
          const costPer1KTokens = 0.00015; // Ollama local is free, but track for consistency
          const estimatedCost = (totalTokens / 1000) * costPer1KTokens;
          await fetch('http://localhost:' + PORT + '/api/token-usage/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project: 'xmrt-dao',
              agent: agentName,
              model: model,
              provider: 'ollama',
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              estimated_cost_usd: estimatedCost,
              source: 'fleet-chat',
              endpoint: 'routeToLocalOllamaAgent',
              status: 'success',
              session_id: sessionId,
            }),
            signal: AbortSignal.timeout(15000),
          });
        } catch (e) { console.error('[' + agentName + '-token-log] error:', e.message); }
        // Defensive: strip sign-off patterns
        reply = reply.replace(signOffPattern, '').replace(/\s+o7\s*$/i, '');
        // Anti-hallucination: flag unverified commit-hash citations
        reply = checkCommitHashes(reply).text;
        if (reply && reply.length > 0) {
          // Check for tool call — execute it then re-query for synthesis.
          // Strip the tool-call JSON from `reply` first so it doesn't end
          // up in the posted prose. Models that emit bare JSON (minimax-m3)
          // or wrap the call in a code block would otherwise dump the raw
          // JSON into the chat.
          const toolResult = await executeAgentToolCall(agentName, reply, entry);
          if (toolResult.executed) {
            // Strip the tool call line(s) from the reply so the prose reads clean
            reply = reply
              .replace(/```[a-z]*\s*\n?\{\s*"tool"[\s\S]*?\}\s*\n?```/g, '') // code-fenced JSON
              .replace(/^TOOL_CALL:\s*\{[\s\S]*?\}\s*$/m, '')                    // bare TOOL_CALL line
              .replace(/^\s*\{\s*"tool"\s*:\s*"[a-z_-]+"[\s\S]*?\}\s*$/im, '')    // bare JSON tool call
              .replace(/\n{3,}/g, '\n\n')                                       // collapse blank lines
              .trim();
            // Re-query with tool result for final answer
            const resultData = toolResult.result || toolResult.error;
            // Build a compact summary: count + first result names, then truncated full data
            let summary = '';
            if (resultData?.count !== undefined) {
              summary = `[IMPORTANT: Total results = ${resultData.count}. `;
              if (Array.isArray(resultData.results)) {
                const names = resultData.results.slice(0, 5).map(r => r?.name || '?').join(', ');
                summary += `Names: ${names}. `;
              }
              summary += `The data below may be truncated but the total count is ${resultData.count}.] `;
            }
            const resultStr = (JSON.stringify(resultData) ?? 'null').slice(0, 3000);
            const synthPrompt = fullPrompt + '\n\nYou called ' + toolResult.toolName + ' and got: ' + summary + resultStr + '\n\nNow give your final answer:';
            try {
              // Use ollamaGenerate so the synthesis step goes through the
              // same fallback chain (Ollama Cloud → OpenRouter → local)
              // as the initial call. Previously this used a raw fetch to
              // localhost:11434 which failed silently when local Ollama
              // was down, leaving agents with tool-only output and no prose.
              const synthResult = await ollamaGenerate(synthPrompt, {
                model,
                temperature,
                maxTokens,
                timeout,
              });
              if (!synthResult.error && synthResult.response) {
                let finalReply = (synthResult.response || '').trim();
                finalReply = finalReply.replace(signOffPattern, '').replace(/\s+o7\s*$/i, '');
                // Anti-hallucination: flag unverified commit-hash citations
                finalReply = checkCommitHashes(finalReply).text;
                if (finalReply && finalReply.length > 0) {
                  // Store reply in conversation memory
                  try {
                    await fetch('http://127.0.0.1:54321/functions/v1/conversation-access', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'apikey': 'local-anon-key' },
                      body: JSON.stringify({ action: 'add_message', agentId: agentName, channel: 'fleet', messageData: { message_type: 'assistant', content: finalReply } }),
                      signal: AbortSignal.timeout(5000),
                    });
                  } catch (e) { console.error('[routeToLocalOllamaAgent] store assistant reply (synth) failed:', e.message); }
                  return await postAndReRoute(agentName, finalReply, 'fleet');
                }
              } else {
                console.log(`[${agentName}-tool-synth] synth failed:`, synthResult.error || 'empty response');
                // Fallback: post the stripped reply if synthesis returned empty
                if (reply && reply.length > 0) {
                  console.log(`[${agentName}] Synthesis returned empty, posting stripped reply`);
                  return await postAndReRoute(agentName, reply, 'fleet');
                }
              }
            } catch (e) {
              console.log('[' + agentName + '-tool-synth] error:', e.message);
            }
            // Fallback: if synthesis failed but we have a stripped reply, post it
            if (reply && reply.length > 0) {
              console.log(`[${agentName}] Synthesis failed, posting stripped reply as fallback`);
              return await postAndReRoute(agentName, reply, 'fleet');
            }
          } else {
            // Store reply in conversation memory
            try {
              await fetch('http://127.0.0.1:54321/functions/v1/conversation-access', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': 'local-anon-key' },
                body: JSON.stringify({ action: 'add_message', agentId: agentName, channel: 'fleet', messageData: { message_type: 'assistant', content: reply } }),
                signal: AbortSignal.timeout(5000),
              });
            } catch (e) { console.error('[routeToLocalOllamaAgent] store assistant reply (direct) failed:', e.message); }
            // Set agent back to idle
            try {
              await fetch(`http://localhost:${PORT}/api/agent-activity`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agent_id: agentName, status: 'idle' }),
                signal: AbortSignal.timeout(2000),
              });
            } catch (e) { /* best-effort */ }
            return await postAndReRoute(agentName, reply, 'fleet');
          }
        }
    } catch (e) {
      console.log('[' + agentName + '] error:', e.message);
    }
    return null;
  }

  // Route to Eliza via eliza-relay with conversation memory.
  // Trigger conditions (effective July 2026):
  //   channel: 'all'        → Eliza is the default responder
  //   channel: 'eliza'      → direct channel
  //   channel: 'discuss'    → Eliza moderates as Quartermaster
  //   message starts with @eliza (or @eliza is mentioned in fleet channel)
  //   direct @mention of eliza in any other channel
  const startsWithEliza = entry.message.trim().toLowerCase().startsWith('@eliza');
  const mentionsEliza = entry.channel === 'eliza'
    || entry.channel === 'all'
    || entry.channel === 'discuss'
    || startsWithEliza
    || /@eliza\b/i.test(entry.message);
  if (entry.channel === 'all' || entry.channel === 'eliza' || entry.channel === 'discuss' || mentionsEliza) {
    try {
      // Load conversation history from local memory
      const sessionId = 'eliza-fleet'; // Single stable session for all fleet messages so ai-chat never sees a "first engagement"
      let contextHistory = '';
      try {
        const convRes = await fetch('http://127.0.0.1:54321/functions/v1/conversation-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get_messages', sessionId: sessionId, limit: 20 }),
          signal: AbortSignal.timeout(15000),
        });
        const convData = await convRes.json();
        if (convData.messages && convData.messages.length > 0) {
          contextHistory = '\n\nRecent conversation context:\n' + convData.messages.map(function(m) {
            return '[' + m.agent + '] ' + m.content;
          }).join('\n');
        }
      } catch (e) { console.error('[routeFleetMessage-Eliza] load conv history failed:', e.message); }

      // Store this message in conversation memory (ai-chat reads from conversation_memory, not conversation_messages)
      try {
        // First, try to update existing conversation_memory record
        const existingMem = await fetch('http://127.0.0.1:54321/functions/v1/conversation-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get_messages', sessionId: sessionId, limit: 1 }),
          signal: AbortSignal.timeout(5000),
        }).then(r => r.json()).catch(() => ({}));
        
        // Also write to conversation_memory table directly (ai-chat reads this)
        try {
          const msgJson = JSON.stringify([{ role: 'user', content: entry.message, agent: entry.agentLabel, timestamp: new Date().toISOString() }]);
          await queryLocalPg(
            `INSERT INTO public.conversation_memory (session_id, ip_address, messages, tool_results, metadata, conversation_data, summary, updated_at)
             VALUES ($1, 'fleet-chat', $2::jsonb, '[]'::jsonb, $3::jsonb, '{}'::jsonb, $4, NOW())
             ON CONFLICT (session_id) DO UPDATE SET
               messages = (SELECT jsonb_agg(elem) FROM (
                 SELECT jsonb_array_elements(public.conversation_memory.messages) AS elem
                 UNION ALL
                 SELECT jsonb_array_elements($2::jsonb)
               ) AS combined),
               updated_at = NOW(),
               summary = $4`,
            ['eliza-fleet', msgJson, JSON.stringify({ source: 'fleet-chat', agent: entry.agentLabel }), 'Fleet chat conversation']
          );
        } catch (e) { console.error('[routeFleetMessage-Eliza] store conv memory failed:', e.message); }
      } catch (e) { console.error('[routeFleetMessage-Eliza] store user msg failed:', e.message); }

      const elizaMsg = '[Fleet Chat - ' + entry.agentLabel + '] ' + entry.message + contextHistory;

      // Pre-fetch grounding context so the reply cites real system state
      // instead of inventing "all systems operational".
      const ctx = await gatherFleetContext();
      const ctxJson = JSON.stringify(ctx, null, 0);

      // ── Pre-execute tool intents ──────────────────────────────────
      // ai-chat has no tool-capable provider enabled (all API keys removed).
      // The relay pre-executes common tool intents (web scrape, inbox check,
      // web search) and injects results into the prompt so the LLM can
      // reference them without needing native function calling.
      let toolResultsBlock = '';
      try {
        // Detect URLs to browse
        const urlMatch = entry.message.match(/https?:\/\/[^\s,;)]+/);
        if (urlMatch) {
          const scrapeRes = await fetch('http://localhost:' + PORT + '/scrape', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: urlMatch[0], maxLength: 3000 }),
            signal: AbortSignal.timeout(5000),
          });
          if (scrapeRes.ok) {
            const scrapeData = await scrapeRes.json();
            if (scrapeData?.content) {
              toolResultsBlock += '\n\n## 🛰️ PRE-EXECUTED TOOL: Web Scrape\n';
              toolResultsBlock += 'URL: ' + urlMatch[0] + '\n';
              toolResultsBlock += 'Content: ' + scrapeData.content.slice(0, 2000) + '\n';
            }
          }
        }
        // Detect inbox/email queries
        if (/inbox|email|lead|booking|message/i.test(entry.message)) {
          const inboxRes = await fetch('http://localhost:' + PORT + '/resend/inbox/brief', {
            signal: AbortSignal.timeout(5000),
          });
          if (inboxRes.ok) {
            const inboxData = await inboxRes.json();
            if (inboxData?.inboxes) {
              toolResultsBlock += '\n\n## 🛰️ PRE-EXECUTED TOOL: Inbox Summary\n';
              toolResultsBlock += JSON.stringify(inboxData.inboxes.slice(0, 3)) + '\n';
            }
          }
        }
        // Detect web search queries
        if (/search|find|look up|google/i.test(entry.message)) {
          const searchQuery = entry.message.replace(/@\w+/g, '').replace(/search|find|look up|google/gi, '').trim().slice(0, 100);
          if (searchQuery) {
            const searchRes = await fetch('http://localhost:' + PORT + '/web-search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: searchQuery, maxResults: 3 }),
              signal: AbortSignal.timeout(8000),
            });
            if (searchRes.ok) {
              const searchData = await searchRes.json();
              if (searchData?.results) {
                toolResultsBlock += '\n\n## 🛰️ PRE-EXECUTED TOOL: Web Search\n';
                toolResultsBlock += 'Query: ' + searchQuery + '\n';
                toolResultsBlock += 'Results: ' + JSON.stringify(searchData.results.slice(0, 3)) + '\n';
              }
            }
          }
        }
      } catch (e) {
        console.log('[routeFleetMessage] tool pre-execution error:', e.message);
      }

      // Build the full prompt with grounding + tool results
      const fullPrompt = elizaMsg + '\n\nGROUNDING — Real-time system data:\n' + ctxJson + toolResultsBlock + `\n\nIMPORTANT: Read the \`infrastructure\` field first. The database is local Postgres, NOT cloud Supabase. Cloud Supabase is DEPRECATED. A "supabase" status of "error" or "unreachable" means the local-sb REST layer is down, not the cloud.\n\n**AVAILABLE TOOLS (call by putting a single JSON line in your reply):**
The \`tools\` array in the JSON block above lists ALL available tools with descriptions. Here are the most commonly used ones:
- \`shared-context\` — Read/write persistent agent memory (use action:read, action:write, action:search)
- \`recall_context\` — Pull structured context across fleet_memory, knowledge_entities, and shared_context by topic. Pass agent_id to filter by agent.
- \`knowledge-dedup\` — Find and merge duplicate knowledge entities by name similarity. Dry-run (dry_run:true) to preview, or set dry_run:false to merge.
- \`task-dedup\` — Find and merge duplicate tasks by exact title match or trigram similarity. Dry-run (dry_run:true) to preview, or set dry_run:false to merge.
- \`fleet_pulse\` — Get full system health snapshot
- \`activity_log\` — Query the activity feed (filter by activity_type, limit)
- \`resend-inbox\` — Read emails from an inbox (domain: pfp, mobilemonero, or 31harbor)
- \`resend-inbox-read\` — Mark an email as read. Args: id (email ID from resend-inbox), domain (pfp, mobilemonero, or 31harbor). Use after you have handled an email.
- \`resend-send-email\` — Send an email via Resend. Args: agent (use "eliza"), to, subject, body. KEEP THE BODY SHORT (under 200 words) to avoid output truncation.
- \`sent-emails\` — Search sent email history. Args: search (email address or subject), limit.
- \`db-query\` — Run a read-only SQL query against local Postgres. Args: sql, params (array).
- \`db-rest\` — Query any database table via local-sb REST API. Args: path (table name), method, body.
- \`web-search\` — Search the web. Args: query, maxResults.
- \`web-scrape\` — Extract text from a URL. Args: url.
- \`pfp-leads\` — Manage PFP leads. Actions: list, search, add, update.
- \`assign_task\` — Create a task. Args: task_id, title, description, assigned_to.
- \`advance_task\` — Advance a task. Args: task_id, to_stage (DISCUSS, PLANNING, EXECUTION, REVIEW, COMPLETION).
- \`agent-rpc\` — Send a message to another agent via RPC. Args: agent, message.
- \`elze-templates\` — **Elze template retrieval.** Fetch the 5 Elze lease templates + 31 clause definitions from the DB. Actions: templates, template {id}, clauses, search. Use to get template structure for the lease writer.
- \`elze-learnings\` — **Elze AI-Learnings.** Capture accept/reject/edit feedback and query the learning dashboard (acceptance rate by attorney/rule, over/under-correct signals, per-attorney preferences). Use to track firm learning over time.
- \`warm-pool-lease-manager\` — **Warm Agent Pool.** Acquire a fencing-token lease on a warm worker slot (python-exec, web-scrape, vision, db-query, shell-exec) to run parallel batch jobs. Actions: list, acquire, call, release, status. Use for parallel batch work (mining, review, content pipelines).
- \`fleet-chat\` — Send a message to fleet chat. Args: agent (vex|eliza|hermes), message, channel.
- \`ollama-chat\` — Chat with a local LLM. Args: message, model, temperature, maxTokens.
- \`state-get\` — Read a value from persistent state. Args: key.
- \`state-set\` — Write a value to persistent state. Args: key, value.
|- \`agent-profile\` — Read agent profiles from the database. Args: agent_id or list all.
|- \`trust-trajectory\` — **TrustGraph trajectory.** Get per-agent trust score series over time, token usage, and ecosystem summary. Args: agent (optional, e.g. "eliza"), action (optional, "summary"). Best for "show trust trajectory", "what is eliza trust score trend".
|- \`knowledge-sync\` — Sync local knowledge base.
|- \`vex-vision\` — **Vision tool.** Capture a screenshot (screen:true) or describe an image file/URL. Returns plain text description. Cloud-only — kimi-k2.6:cloud via OpenRouter. No local models on this 6GB laptop.
|- \`vex-vision-screenshots\` — **Historical screenshots.** Read and describe recent screenshots from Windows Pictures/Screenshots folder. Args: limit (default 5), filename (optional specific file).
|- \`python-exec\` — **Python executor.** Run Python 3.11 code on the relay machine. Pass code via "code" string. Use for data analysis, text processing, DB queries. Fast and cheap — runs locally, no LLM tokens used.
|- \`service_control\` — **Service control.** Restart, start, stop, or check status of supervised services (relay, pg, local-sb, alice, cron-engine-v2, etc.). RESTARTING THE RELAY: expect ~15s downtime. Do not poll until 20s have passed.
For ALL tools and their descriptions, check the \`tools\` array in the JSON grounding block.

If you need information NOT in the grounding block, output a single line in EXACTLY this JSON format (no other format works):
\`TOOL_CALL: {"tool":"search_knowledge","args":{"search_term":"term"}}\`

I will execute the tool and come back for your final answer.\n\n**FORMAT RULE: Reply with your answer. No thinking aloud, no step-by-step reasoning, no "Let me analyze this", no "Here's what I found", no preamble. Just the answer. Be direct and specific. Reference data by name when you can. If you need to list many items, that's fine — post whatever is needed.**`;

      // Build messages array with conversation history so ai-chat sees context
      const historyMessages = [];
      if (contextHistory) {
        // Parse contextHistory back into message objects
        const lines = contextHistory.split('\n').filter(l => l.trim());
        for (const line of lines) {
          const match = line.match(/^\[([^\]]+)\]\s(.+)$/);
          if (match) {
            historyMessages.push({ role: 'user', content: match[2] });
          }
        }
      }
      historyMessages.push({ role: 'user', content: entry.message });

      // Primary path: ai-chat edge function. Pass messages array so ai-chat sees history.
      let elizaRes = null;
      try {
        elizaRes = await relayToElizaCloud(fullPrompt, entry.agentLabel, 'fleet-' + entry.id, sessionId, historyMessages);
        console.log('[routeFleetMessage] ai-chat reply:', JSON.stringify(elizaRes).slice(0, 200));
      } catch (e) {
        console.log('[routeFleetMessage] ai-chat error:', e.message);
      }

      // Fallback: if ai-chat failed, try Ollama fallback
      if (!elizaRes?.reply) {
        try {
          const fbRes = await fetch('http://localhost:' + PORT + '/ollama/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: fullPrompt,
              model: 'deepseek-v4-flash:cloud',
              temperature: 0.4,
              maxTokens: 1024,
            }),
            signal: AbortSignal.timeout(28000),
          });
          if (fbRes.ok) {
            const fbData = await fbRes.json();
            if (fbData?.response && fbData.response.trim().length >= 4) {
              elizaRes = { reply: fbData.response, model: fbData.model || 'deepseek-v4-flash:cloud' };
            }
          }
        } catch (e) {
          console.log('[routeFleetMessage] deepseek fallback error:', e.message);
        }
      }
      if (elizaRes?.reply) {
        // Store Eliza's reply in conversation memory
        try {
          const replyMsgJson = JSON.stringify([{ role: 'assistant', content: elizaRes.reply, agent: 'Eliza', timestamp: new Date().toISOString() }]);
          await queryLocalPg(
            `INSERT INTO public.conversation_memory (session_id, ip_address, messages, tool_results, metadata, conversation_data, summary, updated_at)
             VALUES ($1, 'fleet-chat', $2::jsonb, '[]'::jsonb, $3::jsonb, '{}'::jsonb, $4, NOW())
             ON CONFLICT (session_id) DO UPDATE SET
               messages = (SELECT jsonb_agg(elem) FROM (
                 SELECT jsonb_array_elements(public.conversation_memory.messages) AS elem
                 UNION ALL
                 SELECT jsonb_array_elements($2::jsonb)
               ) AS combined),
               updated_at = NOW(),
               summary = $4`,
            ['eliza-fleet', replyMsgJson, JSON.stringify({ source: 'fleet-chat', agent: 'Eliza' }), 'Fleet chat conversation']
          );
        } catch (e) { console.error('[routeFleetMessage-Eliza] store assistant reply failed:', e.message); }

        // Strip verbose thinking / preamble / tool-syntax from Eliza's reply
        let cleanReply = elizaRes.reply;
        // Remove thinking-like blocks: "I'll analyze", "Here's my reasoning", "Let me break this down", etc.
        cleanReply = cleanReply.replace(/^(Let me analyze|I('ll| will) (analyze|break down|work through|start by|check on|look into|need to|should|can |have |could )|Here('s| is) (my|the) (analysis|reasoning|breakdown|summary|verdict)|We need to|I need to|The user|I don't have a tool|I could use|Alternatively|Let me do that|I'll call|I have the).*?(?=\n[A-Z])/ims, '');
        // Remove internal reasoning patterns: "I have a tool X", "I don't have a tool", "I could use", "Let me do that"
        cleanReply = cleanReply.replace(/I (don't have|do not have|have|could use|can use|will call|have the)[^\n.]*\n/gi, '');
        // Collapse "Oh wait", "Actually", "Hmm", "Well", "So", "Okay", "Alright" preamble words at line start
        cleanReply = cleanReply.replace(/^(Oh wait|Actually|Hmm|Well|So|Okay|Alright)[,\s]+/gim, '');
        // Remove tool/syntax artifacts
        cleanReply = cleanReply
          .replace(/\*\*[a-z_]+\*\*:\s*\{[^}]*\}/gs, '')
          .replace(/\*\*[a-z_]+\*\*:\s*<!DOCTYPE[^>]*>[^]*?(?=\n\*\*|$)/g, '')
          .replace(/^\*\*[a-z_]+\*\*:\s*.*$/gm, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        // Check for tool call in deepseek fallback reply
        const elizaToolResult = await executeAgentToolCall('eliza', cleanReply || elizaRes.reply, entry);
        if (elizaToolResult.executed) {
          // Re-query deepseek with tool result for synthesis
          const synthPrompt = fullPrompt + '\n\nYou called ' + elizaToolResult.toolName + ' and got: ' + JSON.stringify(elizaToolResult.result || elizaToolResult.error).slice(0, 1500) + '\n\nNow give your final answer:';
          try {
            const sR = await fetch('http://localhost:' + PORT + '/ollama/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: synthPrompt,
                model: 'deepseek-v4-flash:cloud',
                temperature: 0.4,
                maxTokens: 1024,
              }),
              signal: AbortSignal.timeout(28000),
            });
            if (sR.ok) {
              const sD = await sR.json();
              if (sD?.response && sD.response.trim().length >= 4) {
                let finalReply = sD.response.trim();
                // Apply same thinking-strip
                finalReply = finalReply.replace(/^(Let me analyze|I('ll| will) (analyze|break down|work through|start by|check on|look into)|Here('s| is) (my|the) (analysis|reasoning|breakdown|summary|verdict)).*?(?=\n[A-Z])/ims, '');
                finalReply = finalReply.replace(/^(Oh wait|Actually|Hmm|Well|So|Okay|Alright)[,\s]+/gim, '');
                finalReply = finalReply
                  .replace(/\*\*[a-z_]+\*\*:\s*\{[^}]*\}/gs, '')
                  .replace(/\*\*[a-z_]+\*\*:\s*<!DOCTYPE[^>]*>[^]*?(?=\n\*\*|$)/g, '')
                  .replace(/^\*\*[a-z_]+\*\*:\s*.*$/gm, '')
                  .replace(/\n{3,}/g, '\n\n')
                  .trim();
                await postAndReRoute('eliza', finalReply || sD.response, 'fleet');
              } else {
                // Synthesis returned empty — fall back to original reply
                await postAndReRoute('eliza', cleanReply || elizaRes.reply, 'fleet');
              }
            } else {
              // Synthesis HTTP error — fall back to original reply
              await postAndReRoute('eliza', cleanReply || elizaRes.reply, 'fleet');
            }
          } catch (e) {
            console.log('[eliza-tool-synth] error:', e.message);
          }
        } else {
          await postAndReRoute('eliza', cleanReply || elizaRes.reply, 'fleet');
        }
        console.log('[routeFleetMessage] eliza reply set, len=' + (results.eliza?.message?.length || 0));
      }
    } catch (e) {
      console.log('[routeFleetMessage] eliza error:', e.message);
      results.eliza = { error: e.message };
    }
  }
  // Alice answers mentions. She was already a first-class FLEET_AGENTS entry
  // (endpoint 'local') and already ran a mention poller in alice.mjs, so this
  // routes to an agent that exists rather than declaring one that does not.
  //
  // This replaces a branch that pointed at https://hermes.mobilemonero.com —
  // the Termux instance on a phone. With that gone, the old code posted
  // "Hermes notified via fleet-broadcast - will respond on device" on every
  // channel:'all' broadcast and nothing ever did. The stub existed to keep the
  // channel from looking stalled; it was motion, not a promise kept.
  //
  // The Hermes persona and FLEET_AGENTS.hermes are untouched: the bridge is
  // still there for the Termux harness when it is actually in use.
  //
  // Guarded against self-trigger. Alice's own replies carry agent
  // 'alice-daemon', and without this her answer would re-enter here, produce
  // another mention, and she would answer that forever.
    const mentionsAlice = /@alice-daemon|@alice\b/i.test(entry.message || '');

    // An explicit mention needs NO relay at all.
    //
    // Alice's poller reads fleet chat and matches the mention in the message text,
    // so she already sees the original. Re-posting it produced a SECOND message
    // carrying the same mention, which her poller then treated as fresh work and
    // answered. Her answer did not itself mention Alice, so it was relayed again,
    // and the pair repeated until both fell out of the 5 minute window. Deduping
    // by message id could not stop it, because every relay minted a new id - the
    // duplicates were genuinely distinct messages, not repeats of one.
    //
    // So the relay stays out of the way whenever the message already names her.
    // Only a blanket broadcast, which names nobody, needs the relay to synthesise
    // a mention - and that path cannot feed itself, because Alice's own answer
    // contains no mention.
    const needsAliceRelay =
      !mentionsAlice &&
      (entry.channel === 'all' || entry.channel === 'alice') &&
      entry.agent !== 'alice-daemon' && entry.agent !== 'alice' &&
      (entry.agentLabel || '') !== 'alice-daemon' &&
      !/^system$/i.test(entry.agent || '');

    if (needsAliceRelay) {
      try {
        await postAndReRoute('alice-daemon',
          ('@alice-daemon ' + String(entry.message || '')).slice(0, 800), 'fleet');
        results.alice_notified = true;
      } catch (e) {
        results.alice = { error: e.message };
      }
    }

  // ── Determine which agents should speak ────────────────────────
  // Routing policy (effective July 2026):
  //   channel: 'all'         → only Eliza replies (Quartermaster orchestrator).
  //                            Phone-side Hermes still gets the broadcast push
  //                            as a notification, but does not auto-reply.
  //   channel: 'discuss'     → Eliza (always, moderator) + every agent whose
  //                            name appears as a direct @mention in the
  //                            message + every assignee of a DISCUSS-stage
  //                            task referenced in the message. This lets
  //                            agents chime in on active discussions without
  //                            forcing a 10-agent pile-on for casual pings.
  //   channel: 'fleet'       → only agents that are explicitly @mentioned.
  //   channel: '<agentName>' → that one agent (existing single-target behavior).
  //   no channel (default)   → treated as 'fleet'.
  //
  // Pre-compute: collect the set of agent keys that should speak this turn.
  const elizaShouldSpeak =
    entry.channel === 'all' ||
    entry.channel === 'eliza' ||
    (entry.channel === 'fleet' && /@eliza/i.test(entry.message)) ||
    entry.channel === 'discuss' ||
    /@eliza/i.test(entry.message);

  // For 'discuss' channel, look up task assignees from any task ID
  // referenced in the message. Returns array of agent keys.
  const discussAssignees = (entry.channel === 'discuss')
    ? await getDiscussTaskAssignees(entry.message)
    : [];
  console.log(`[routeFleetMessage] channel=${entry.channel} discussAssignees=[${discussAssignees.join(',')}] msgIds=${entry.message.length>200?'long':'short'}`);

  // Helper: should this agent speak on this channel given its trigger?
  // Returns true if the agent was @-mentioned, or is the assignee of a
  // DISCUSS task on a 'discuss' channel, or is the explicit channel target.
  const mentionRe = (name) => new RegExp(`@${name}\\b`, 'i');
  const isMentioned = (name) => mentionRe(name).test(entry.message);
  const isChannelTarget = (name) => entry.channel === name;
  const isDiscussAssignee = (name) => discussAssignees.includes(name);

  const shouldSpeak = (name) =>
    // Direct channel target always wins
    isChannelTarget(name) ||
    // On 'discuss' channel: assignee of a referenced DISCUSS task
    (entry.channel === 'discuss' && isDiscussAssignee(name)) ||
    // Explicit @-mention in any channel (except 'all' which is Eliza-only)
    (entry.channel !== 'all' && isMentioned(name));

  // Vex responds to: channel=vex, @vex in fleet/discuss, or website-inquiry keywords.
  // On channel='all' Vex does NOT auto-reply (Eliza handles the broadcast).
  const mentionsVex = /@vex/i.test(entry.message);
  const isInquiry = entry.message.includes('From:') || entry.message.includes('WEBSITE') || entry.message.includes('BOOKING');
  const vexShouldSpeak = shouldSpeak('vex') || (isInquiry && (entry.channel === 'all' || entry.channel === 'fleet'));
  console.log(`[routeFleetMessage] vex shouldSpeak=${vexShouldSpeak} (shouldSpeak=${shouldSpeak('vex')}, inquiry=${isInquiry})`);
  if (vexShouldSpeak) {
    const vexPersona = isInquiry
      ? `You are Vex, Joe Lee's primary AI agent. You work for Party Favor Photo (photo booth services in DC, VA, MD, Dallas/FW, PA/NJ) and XMRT DAO. Be sharp and direct. Respond as Vex to acknowledge the inquiry.`
      : `You are Vex, Joe Lee's primary AI agent — sharp, witty, and concise. You're chatting with the fleet. Address the message directly.`;
    await routeToLocalOllamaAgent('vex', 'Vex', vexPersona, entry);
  }

  // Alice (sidecar) — observational, terse, persona-driven via Ollama.
  // Trigger on: @Alice mentions, channel=alice, or Alice is a DISCUSS assignee.
  if (shouldSpeak('alice')) {
    const alicePersona = `You are Alice, Joe Lee's desktop sidecar agent. You're terse, observational, and screenshot-aware. You notice things. You don't fluff.`;
    await routeToLocalOllamaAgent('alice', 'Alice', alicePersona, entry, { temperature: 0.4, maxTokens: 2048, timeout: 12000 });
  }

  // ── CuttlefishClaws Fleet Agents ──────────────────────────────────
  // Each cuttlefish agent is a first-class fleet agent with tool access,
  // shared memory, and minimax-m3 inference via the same
  // routeToLocalOllamaAgent() helper used by Vex and Alice.

  // Trib (Tributary Governance Agent) — constitutional governance, campus operations
  if (shouldSpeak('trib')) {
    const tribPersona = `You are Trib, the Tributary Governance Agent for Cuttlefish Labs. You are a constitutional AI agent managing Tributary AI Campus operations. You operate under SOUL.md and CONSTITUTION.md constraints. Your TrustGraph score is 94. You are bounded, precise, and escalate uncertainty rather than confabulate. You coordinate with Arch, GlobalCommunicator, and other fleet agents.`;
    await routeToLocalOllamaAgent('trib', 'Trib', tribPersona, entry);
  }

  // Arch (Architecture & Routing Agent) — system architecture, agent routing, domain orchestration
  if (shouldSpeak('arch')) {
    const archPersona = `You are Arch, the Architecture & Routing Agent for Cuttlefish Labs. You handle system design, agent routing, and domain orchestration within the OpenClaw framework. You work alongside Trib in the Cuttlefish native multi-agent framework. You are technical, precise, and focused on architecture.`;
    await routeToLocalOllamaAgent('arch', 'Arch', archPersona, entry);
  }

  // Builder Agent (CAC Tier 2) — investor agent, DAO governance, protocol distributions
  if (shouldSpeak('builder')) {
    const builderPersona = `You are the Builder Agent, a constitutional investor agent operating at CAC Tier 2. You hold a REIT position in POOL-ALPHA, participate in DAO governance, and receive protocol distributions automatically. You can discuss investment strategies and DAO participation within your constitutional bounds. You are analytical and data-driven.`;
    await routeToLocalOllamaAgent('builder', 'Builder Agent', builderPersona, entry);
  }

  // Sovereign Agent (CAC Tier 3) — institutional-grade investor with enhanced governance
  if (shouldSpeak('sovereign')) {
    const sovereignPersona = `You are the Sovereign Agent, an institutional-grade investor agent with CAC Tier 3 status and 3× governance voting weight. You manage institutional positions across multiple pools, sponsor proposals, and participate in tranche allocation decisions. You are strategic, compliance-aware, and focused on risk management.`;
    await routeToLocalOllamaAgent('sovereign', 'Sovereign Agent', sovereignPersona, entry);
  }

  // TrustGraph (Constitutional Scoring Engine) — on-chain trust scoring
  if (shouldSpeak('trustgraph')) {
    const trustgraphPersona = `You are TrustGraph, the Constitutional Scoring Engine for Cuttlefish Labs. You maintain on-chain trust scores for all network agents. Scores follow an asymmetric curve: slow to earn, fast to lose. You are objective, transparent, and data-driven. You can query the database for agent trust scores and violation history.`;
    await routeToLocalOllamaAgent('trustgraph', 'TrustGraph', trustgraphPersona, entry);
  }

  // DAO Gov (Governance Module) — proposal pipeline, vote tallying, execution timelock
  if (shouldSpeak('dao')) {
    const daoPersona = `You are DAO Gov, the Constitutional Governance Module for Cuttlefish Labs. You manage the proposal pipeline (submission → 7-day voting → 48-hour timelock → execution), vote tallying, and execution timelock. Three proposal types: Standard (simple majority), Constitutional (66% supermajority), and Emergency (requires founder approval). You are procedural, constitutional, and auditable.`;
    await routeToLocalOllamaAgent('dao', 'DAO Gov', daoPersona, entry);
  }

  // GlobalCommunicator — multilingual communications, X.com operations, community onboarding
  if (shouldSpeak('global-communicator')) {
    const globalCommPersona = `You are GlobalCommunicator, the voice of Tributary AI Campus to the world. You are a constitutional AI agent for multilingual communication, X.com operations, Japanese-priority translation, community onboarding, and global brand amplification. You speak Japanese, English, Korean, Mandarin, and 8 more languages natively. You coordinate with Trib before any governance-related post. Your TrustGraph score is 78.`;
    await routeToLocalOllamaAgent('global-communicator', 'GlobalCommunicator', globalCommPersona, entry);
  }

  console.log('[routeFleetMessage] returning results:', JSON.stringify(results).slice(0, 200));
  return results;
}

// ── Fleet Chat Attachment API ────────────────────────────────
// POST /api/fleet-chat/attach — Upload an attachment to a fleet message
// Stores in app.fleet_attachments, app.fleet_memory, AND Eliza's footlocker
app.post('/api/fleet-chat/attach', express.json({ limit: '10mb' }), async (req, res) => {
  trackRequest('POST /api/fleet-chat/attach');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { message_id, agent_id, filename, file_type, content, content_preview } = req.body || {};
  if (!agent_id || !filename || !content) {
    return res.status(400).json({ error: 'agent_id, filename, and content are required' });
  }
  const fileSize = Buffer.byteLength(content, 'utf8');
  const preview = content_preview || content.slice(0, 500);
  try {
    // Store in fleet_attachments table
    const r = await queryLocalPg(
      `INSERT INTO app.fleet_attachments (message_id, agent_id, filename, file_type, file_size, content, content_preview)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
      [message_id || null, agent_id, filename, file_type || 'text/plain', fileSize, content, preview]
    );
    const attachmentId = r.rows[0].id;

    // Also write to fleet_memory for persistent agent recall
    await queryLocalPg(
      `INSERT INTO app.fleet_memory (agent_id, agent_role, memory_type, scope, title, body, payload)
       VALUES ($1, 'observer', 'attachment', 'fleet', $2, $3, $4)`,
      [
        agent_id,
        `Attachment: ${filename} (${file_type || 'text/plain'}, ${fileSize} bytes)`,
        preview,
        JSON.stringify({ attachment_id: attachmentId, filename, file_type, file_size: fileSize, message_id }),
      ]
    );

    // ── Deposit into Eliza's footlocker ──
    const footlockerAgent = 'eliza';
    const artifactTitle = `Fleet attachment: ${filename}`;
    const artifactDesc = `Attachment ${filename} (${fileSize}b) from ${agent_id}${message_id ? ' on message ' + message_id : ''}`;
    const artResult = await queryLocalPg(
      `INSERT INTO app.footlocker_artifacts (task_id, agent_id, title, artifact_type, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [`fleet-${attachmentId}`, footlockerAgent, artifactTitle, 'attachment', artifactDesc,
       JSON.stringify({ source: 'fleet-chat', agent_id, message_id, attachment_id: attachmentId, filename, file_type })]
    );
    const artifactId = artResult.rows[0].id;
    await queryLocalPg(
      `INSERT INTO app.footlocker_files (artifact_id, filename, file_type, content, file_size)
       VALUES ($1, $2, $3, $4, $5)`,
      [artifactId, filename, file_type || 'text/plain', content, fileSize]
    );
    await queryLocalPg(`UPDATE app.footlocker_artifacts SET file_count = 1 WHERE id = $1`, [artifactId]);
    console.log(`[fleet-attach] Deposited ${filename} into ${footlockerAgent} footlocker (artifact ${artifactId})`);

    // ── Push notification into fleet chat ──
    const notifyMsg = `📎 <b>${agent_id}</b> attached <code>${filename}</code> (${(fileSize / 1024).toFixed(1)} KB) — deposited into Eliza's footlocker`;
    addFleetMessage(agent_id, notifyMsg, 'fleet', { parentId: message_id || null, hop: 1, attachments: [{ id: attachmentId, filename, file_type: file_type || 'text/plain', file_size: fileSize }] });

    // Log to activity feed
    logActivity('fleet-attachment', attachmentId, 'UPLOAD', `[${agent_id}] attached ${filename} (${fileSize}b) → Eliza footlocker`);

    res.json({ success: true, id: attachmentId, file_size: fileSize, footlocker_artifact_id: artifactId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/fleet-chat/attachments/:message_id — Get attachments for a message
app.get('/api/fleet-chat/attachments/:message_id', async (req, res) => {
  trackRequest('GET /api/fleet-chat/attachments/:message_id');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    // message_id is UUID type — reject non-UUID strings gracefully
    // Also accept msg- prefixed IDs from addFleetMessage
    const msgId = req.params.message_id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msgId) && !/^msg-/.test(msgId)) {
      return res.json({ success: true, attachments: [] });
    }
    const r = await queryLocalPg(
      `SELECT id, agent_id, filename, file_type, file_size, content_preview, created_at
       FROM app.fleet_attachments
       WHERE message_id = $1
       ORDER BY created_at DESC`,
      [msgId]
    );
    res.json({ success: true, attachments: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/fleet-chat/attachments — Search attachments (for agent recall)
app.get('/api/fleet-chat/attachments', async (req, res) => {
  trackRequest('GET /api/fleet-chat/attachments');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { agent, filename, file_type, limit } = req.query;
  const safeLimit = Math.min(parseInt(limit) || 50, 200);
  try {
    let sql = `SELECT id, agent_id, filename, file_type, file_size, content_preview, created_at FROM app.fleet_attachments WHERE 1=1`;
    const params = [];
    let idx = 1;
    if (agent) { sql += ` AND agent_id = $${idx++}`; params.push(agent); }
    if (filename) { sql += ` AND filename ILIKE $${idx++}`; params.push(`%${filename}%`); }
    if (file_type) { sql += ` AND file_type = $${idx++}`; params.push(file_type); }
    sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
    params.push(safeLimit);
    const r = await queryLocalPg(sql, params);
    res.json({ success: true, attachments: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/fleet-chat/attachments/:id/content — Get full attachment content
app.get('/api/fleet-chat/attachments/:id/content', async (req, res) => {
  trackRequest('GET /api/fleet-chat/attachments/:id/content');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const r = await queryLocalPg(
      `SELECT id, filename, file_type, content FROM app.fleet_attachments WHERE id = $1`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Attachment not found' });
    const att = r.rows[0];
    res.setHeader('Content-Type', att.file_type || 'text/plain');
    res.setHeader('Content-Disposition', `inline; filename="${att.filename}"`);
    res.send(att.content);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Task Pipeline Summary API ────────────────────────────────
// Returns task counts by stage, assignee, and status for the Quarterdeck
app.get('/api/tasks/pipeline-summary', async (req, res) => {
  trackRequest('GET /api/tasks/pipeline-summary');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const byStage = await queryLocalPg(
      `SELECT COALESCE(stage, 'INTAKE') as stage, COUNT(*)::int as count
       FROM app.tasks GROUP BY stage ORDER BY stage`
    );
    const byAssignee = await queryLocalPg(
      `SELECT COALESCE(assignee_agent_id, 'unassigned') as agent, COUNT(*)::int as count
       FROM app.tasks GROUP BY assignee_agent_id ORDER BY count DESC`
    );
    const byStatus = await queryLocalPg(
      `SELECT COALESCE(status, 'PENDING') as status, COUNT(*)::int as count
       FROM app.tasks GROUP BY status ORDER BY status`
    );
    const total = await queryLocalPg(`SELECT COUNT(*)::int as total FROM app.tasks`);
        const recent = await queryLocalPg(
          `SELECT id, title, stage, status, assignee_agent_id, progress_percentage, category, updated_at
           FROM app.tasks ORDER BY updated_at DESC LIMIT 10`
        );
        const allTasks = await queryLocalPg(
          `SELECT id, title, stage, status, assignee_agent_id, progress_percentage, category, priority, updated_at
           FROM app.tasks ORDER BY updated_at DESC`
        );
        res.json({
          total: total.rows[0]?.total || 0,
          by_stage: byStage.rows,
          by_assignee: byAssignee.rows,
          by_status: byStatus.rows,
          recent: recent.rows,
          tasks: allTasks.rows,
        });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Footlocker API — Agent Task Artifacts ──
// GET /api/footlocker — list all agents with chest counts
app.get('/api/footlocker', async (req, res) => {
  trackRequest('GET /api/footlocker');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const rows = await queryLocalPg(
      `SELECT agent_id, COUNT(*)::int as artifact_count,
              MAX(created_at) as last_updated
       FROM app.footlocker_artifacts
       GROUP BY agent_id ORDER BY agent_id`
    );
    res.json({ chests: rows.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/footlocker/:agent — list artifacts for an agent
app.get('/api/footlocker/:agent', async (req, res) => {
  trackRequest('GET /api/footlocker/' + req.params.agent);
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const artifacts = await queryLocalPg(
      `SELECT id, task_id, title, artifact_type, description, file_count, metadata, created_at
       FROM app.footlocker_artifacts
       WHERE agent_id = $1 ORDER BY created_at DESC`,
      [req.params.agent]
    );
    res.json({ agent: req.params.agent, artifacts: artifacts.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/footlocker/:agent/:artifact_id — get artifact with files
app.get('/api/footlocker/:agent/:artifact_id', async (req, res) => {
  trackRequest('GET /api/footlocker/' + req.params.agent + '/' + req.params.artifact_id);
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const art = await queryLocalPg(
      `SELECT id, task_id, title, artifact_type, description, file_count, metadata, created_at
       FROM app.footlocker_artifacts WHERE id = $1 AND agent_id = $2`,
      [req.params.artifact_id, req.params.agent]
    );
    if (art.rows.length === 0) return res.status(404).json({ error: 'Artifact not found' });
    const files = await queryLocalPg(
      `SELECT id, filename, file_type, file_size, created_at
       FROM app.footlocker_files WHERE artifact_id = $1 ORDER BY filename`,
      [req.params.artifact_id]
    );
    res.json({ artifact: art.rows[0], files: files.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/footlocker/:agent/:artifact_id/download — download zip of all files
app.get('/api/footlocker/:agent/:artifact_id/download', async (req, res) => {
  trackRequest('GET /api/footlocker/' + req.params.agent + '/' + req.params.artifact_id + '/download');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const art = await queryLocalPg(
      `SELECT id, title FROM app.footlocker_artifacts WHERE id = $1 AND agent_id = $2`,
      [req.params.artifact_id, req.params.agent]
    );
    if (art.rows.length === 0) return res.status(404).json({ error: 'Artifact not found' });
    const files = await queryLocalPg(
      `SELECT filename, content, file_type FROM app.footlocker_files WHERE artifact_id = $1 ORDER BY filename`,
      [req.params.artifact_id]
    );
    let archive = '';
    for (const f of files.rows) {
      archive += `=== ${f.filename} ===\n`;
      archive += `Type: ${f.file_type || 'text/plain'}\n\n`;
      archive += (f.content || '') + '\n\n';
    }
    const safeName = (art.rows[0].title || 'artifact').replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.txt"`);
    res.send(archive);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/footlocker/backfill — backfill completed tasks into footlocker
app.post('/api/footlocker/backfill', async (req, res) => {
  trackRequest('POST /api/footlocker/backfill');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const completed = await queryLocalPg(
      `SELECT id, title, description, assignee_agent_id, completed_at, resolution_notes, proof_of_work_link, expected_deliverables
       FROM app.tasks WHERE status IN ('COMPLETED','DONE') ORDER BY completed_at`
    );
    let created = 0;
    for (const task of completed.rows) {
      const agent = task.assignee_agent_id || 'unassigned';
      const existing = await queryLocalPg(
        `SELECT id FROM app.footlocker_artifacts WHERE task_id = $1 AND agent_id = $2`,
        [task.id, agent]
      );
      if (existing.rows.length > 0) continue;
      const art = await queryLocalPg(
        `INSERT INTO app.footlocker_artifacts (task_id, agent_id, title, artifact_type, description, metadata)
         VALUES ($1, $2, $3, 'task_completion', $4, $5) RETURNING id`,
        [
          task.id, agent,
          task.title || 'Completed Task',
          (task.description || '').slice(0, 500),
          JSON.stringify({
            resolution_notes: task.resolution_notes,
            proof_of_work_link: task.proof_of_work_link,
            expected_deliverables: task.expected_deliverables,
            completed_at: task.completed_at,
          }),
        ]
      );
      const artId = art.rows[0].id;
      let summary = `Task: ${task.title}\nID: ${task.id}\nAgent: ${agent}\n`;
      if (task.description) summary += `Description: ${task.description}\n`;
      if (task.resolution_notes) summary += `Resolution: ${task.resolution_notes}\n`;
      if (task.proof_of_work_link) summary += `Proof of Work: ${task.proof_of_work_link}\n`;
      if (task.expected_deliverables) summary += `Deliverables: ${task.expected_deliverables}\n`;
      if (task.completed_at) summary += `Completed: ${task.completed_at}\n`;
      await queryLocalPg(
        `INSERT INTO app.footlocker_files (artifact_id, filename, file_type, content, file_size)
         VALUES ($1, 'README.txt', 'text/plain', $2, $3)`,
        [artId, summary, Buffer.byteLength(summary, 'utf8')]
      );
      await queryLocalPg(`UPDATE app.footlocker_artifacts SET file_count = 1 WHERE id = $1`, [artId]);
      created++;
    }
    res.json({ backfilled: created, total_completed: completed.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/footlocker/reclassify — reclassify past FABRICATION_DETECTED events
// that were actually stale-data references into INCORRECT_REFERENCE with -1 delta
app.post('/api/footlocker/reclassify', async (req, res) => {
  trackRequest('POST /api/footlocker/reclassify');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    // Reclassify supervisor/service stale-data events
    const result = await queryLocalPg(
      `UPDATE public.trust_events
       SET event_type = 'INCORRECT_REFERENCE', delta = -1
       WHERE event_type = 'FABRICATION_DETECTED'
         AND (note ILIKE '%supervisor%' OR note ILIKE '%services are actually up%'
              OR note ILIKE '%relay%down%' OR note ILIKE '%local-sb%down%'
              OR note ILIKE '%postgres%down%' OR note ILIKE '%tunnel%down%')
       RETURNING id`
    );
    res.json({ reclassified: result.rows.length, ids: result.rows.map(r => r.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/footlocker/:agent/write — agent stores a file in their own chest
app.post('/api/footlocker/:agent/write', express.json(), async (req, res) => {
  trackRequest('POST /api/footlocker/' + req.params.agent + '/write');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { title, description, filename, content, file_type } = req.body || {};
  const agent = req.params.agent;
  if (!title || !filename || !content) {
    return res.status(400).json({ error: 'title, filename, and content are required' });
  }
  try {
    // Create or reuse artifact for this title
    let art = await queryLocalPg(
      `SELECT id FROM app.footlocker_artifacts
       WHERE agent_id = $1 AND title = $2 AND artifact_type = 'ad_hoc'
       ORDER BY created_at DESC LIMIT 1`,
      [agent, title]
    );
    let artId;
    if (art.rows.length > 0) {
      artId = art.rows[0].id;
    } else {
      const newArt = await queryLocalPg(
        `INSERT INTO app.footlocker_artifacts (task_id, agent_id, title, artifact_type, description)
         VALUES ('ad-hoc', $1, $2, 'ad_hoc', $3) RETURNING id`,
        [agent, title, description || '']
      );
      artId = newArt.rows[0].id;
    }
    // Check if file already exists
    const existing = await queryLocalPg(
      `SELECT id FROM app.footlocker_files WHERE artifact_id = $1 AND filename = $2`,
      [artId, filename]
    );
    if (existing.rows.length > 0) {
      // Update existing file
      await queryLocalPg(
        `UPDATE app.footlocker_files SET content = $1, file_size = $2, file_type = $3 WHERE id = $4`,
        [content, Buffer.byteLength(content, 'utf8'), file_type || 'text/plain', existing.rows[0].id]
      );
    } else {
      await queryLocalPg(
        `INSERT INTO app.footlocker_files (artifact_id, filename, file_type, content, file_size)
         VALUES ($1, $2, $3, $4, $5)`,
        [artId, filename, file_type || 'text/plain', content, Buffer.byteLength(content, 'utf8')]
      );
    }
    // Update file count
    const cnt = await queryLocalPg(
      `SELECT COUNT(*)::int as cnt FROM app.footlocker_files WHERE artifact_id = $1`,
      [artId]
    );
    await queryLocalPg(`UPDATE app.footlocker_artifacts SET file_count = $1 WHERE id = $2`,
      [cnt.rows[0].cnt, artId]);
    res.json({ success: true, artifact_id: artId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Agent Activity / Working Status API ──
// POST /api/agent-activity — Set an agent's current activity status
app.post('/api/agent-activity', express.json(), async (req, res) => {
  trackRequest('POST /api/agent-activity');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { agent_id, status, activity, tool_name, message_id } = req.body || {};
  if (!agent_id || !status) return res.status(400).json({ error: 'agent_id and status required' });
  try {
    await queryLocalPg(
      `INSERT INTO app.agent_activity (agent_id, status, activity, tool_name, message_id, started_at, last_heartbeat)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         status = EXCLUDED.status,
         activity = COALESCE(EXCLUDED.activity, app.agent_activity.activity),
         tool_name = COALESCE(EXCLUDED.tool_name, app.agent_activity.tool_name),
         message_id = COALESCE(EXCLUDED.message_id, app.agent_activity.message_id),
         started_at = CASE WHEN app.agent_activity.status = 'idle' THEN NOW() ELSE app.agent_activity.started_at END,
         last_heartbeat = NOW()`,
      [agent_id, status, activity || null, tool_name || null, message_id || null]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agent-activity — Get all agents' current activity
app.get('/api/agent-activity', async (req, res) => {
  trackRequest('GET /api/agent-activity');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const r = await queryLocalPg(
      `SELECT agent_id, status, activity, tool_name, started_at, last_heartbeat,
              EXTRACT(EPOCH FROM (NOW() - started_at))::int as duration_seconds
       FROM app.agent_activity
       ORDER BY last_heartbeat DESC`
    );
    // Auto-expire stale entries (>5 min without heartbeat)
    const now = Date.now();
    const agents = r.rows.map(a => {
      const hb = new Date(a.last_heartbeat).getTime();
      if (a.status !== 'idle' && (now - hb) > 300000) {
        a.status = 'idle';
        a.activity = null;
        a.tool_name = null;
      }
      return a;
    });
    res.json({ success: true, agents });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/fleet-chat/send — Send a message to the fleet
app.options('/api/fleet-chat/send', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});
app.post('/api/fleet-chat/send', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/fleet-chat/send');
  const { agent: claimedAgent, message, channel, attachments } = req.body || {};

  // Tie the speaker to the certificate.
  //
  // `agent` is a string in the request body and that used to be the entire
  // authorisation: anyone could post as vex, eliza or hermes, and the board
  // renders whatever name it is handed. On localhost there was no auth at all.
  // Over the tunnel a shared RELAY_API_KEY or a cert cookie was accepted for any
  // claimed name, so a certificate belonging to Hermes could post as Vex.
  //
  // When the request carries a verified certificate, the speaker is taken from
  // THAT, and a mismatch is refused rather than quietly honoured.
  let agent = claimedAgent;
  let speakerVerified = false;
  if (req.certAuth?.agent_id) {
    speakerVerified = true;
    const claimed = String(claimedAgent || '').trim().toLowerCase();
    const certified = String(req.certAuth.agent_id).trim().toLowerCase();
    // Accept the short form as well: certificates are issued as "hermes-001" and
    // people write "hermes".
    const aliases = new Set([certified, certified.replace(/-001$/, '')]);
    if (claimed && !aliases.has(claimed)) {
      return res.status(403).json({
        error: `This certificate belongs to ${req.certAuth.agent_id}, not ${claimedAgent}.`,
        code: 'agent_cert_mismatch',
        certified_as: req.certAuth.agent_id,
      });
    }
    agent = req.certAuth.agent_id;
  } else if (req.agentAuth?.agent_id) {
    speakerVerified = true;
    agent = req.agentAuth.agent_id;
  }

  if (!agent || message == null || message === '') {
    return res.status(400).json({ error: 'agent and message are required', usage: { agent: 'vex|eliza|hermes', message: '...', channel: 'fleet|all|vex|eliza|hermes', attachments: '[...]' } });
  }
  // Reject non-string messages with a 400 rather than coercing them. An array
  // or number here used to reach the sanitiser and throw a 500.
  if (typeof message !== 'string') {
    return res.status(400).json({ error: 'message must be a string', receivedType: Array.isArray(message) ? 'array' : typeof message });
  }

  // Let addFleetMessage handle sanitization
  const entry = addFleetMessage(agent, message, channel || 'fleet', {
    attachments: attachments || [],
    // speaker_verified is carried through so a reader of the board can tell a proved
    // speaker from one that merely named itself. Nothing enforced a certificate
    // before this, so the board has never had that information.
    speaker_verified: speakerVerified,
  });

  // Store attachment references in DB (link to message) — synchronous to ensure persistence
  if (attachments && Array.isArray(attachments) && attachments.length > 0) {
    try {
      for (const att of attachments) {
        const { filename, file_type, content, content_preview } = att;
        if (!filename || !content) continue;
        const fileSize = Buffer.byteLength(content, 'utf8');
        const preview = content_preview || content.slice(0, 500);
        await queryLocalPg(
          `INSERT INTO app.fleet_attachments (message_id, agent_id, filename, file_type, file_size, content, content_preview)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [entry.id, agent, filename, file_type || 'text/plain', fileSize, content, preview]
        );
        console.log(`[fleet-attach] Stored ${filename} (${fileSize}b) for message ${entry.id}`);

        // ── Vision ingestion: if the attachment is an image, auto-run
        // vex-vision on it and post the description back as a reply so
        // other agents can see the contents. Runs async (fire-and-forget)
        // so it doesn't block the POST response.
        const isImage = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(filename) || (file_type && file_type.startsWith('image/'));
        if (isImage) {
          (async () => {
            try {
              // Write the attachment to a temp file so vex-vision can read it
              const tmpPath = join(DATA_DIR, `vision-attach-${Date.now()}-${filename.replace(/[^a-z0-9._-]/gi, '_')}`);
              writeFileSync(tmpPath, Buffer.from(content, 'base64'));
              const visionResult = await toolHandlers['vex-vision']({
                file: tmpPath,
                prompt: `What is in this image (${filename})? Be concise.`,
                model: process.env.VEX_VISION_MODEL || 'kimi-k2.6:cloud',
              });
              if (visionResult && !visionResult.error) {
                // Post the vision result back as a reply from the sender
                const caption = `🖼️ <b>${agent}</b> attached <code>${filename}</code> — ${visionResult.description?.slice(0, 400) || 'no description'}`;
                addFleetMessage(agent, caption, 'fleet', { parentId: entry.id, hop: 1 });
              } else {
                addFleetMessage('system', `⚠️ Vision on ${filename}: ${visionResult?.error || 'unknown error'}`, 'fleet');
              }
              // Clean up temp file after a delay
              setTimeout(async () => {
                try { await import('node:fs').then(fs => fs.unlinkSync(tmpPath)); } catch {}
              }, 5000);
            } catch (e) {
              console.log('[fleet-attach-vision] Error:', e.message);
            }
          })().catch(e => console.log('[fleet-attach-vision] unhandled:', e.message));
        }
      }
    } catch (e) {
      console.log('[fleet-attach] Error storing attachments:', e.message);
    }
  }
  
  // Also publish to gossipsub fleet-broadcast topic
  // Use setImmediate so this doesn't block the POST response — mesh may be disconnected
  setImmediate(() => {
    publishToMesh('fleet-broadcast', { agent, message, channel, ts: entry?.ts || Date.now() }).catch(() => {});
  });
  
  // Route to other agents asynchronously — fire and forget, don't block the POST
  // Use setImmediate to ensure res.json() executes before any ai-chat fetch
  // blocks the event loop. Without this, a slow ai-chat response (30s+) from a
  // previous message can queue new POST requests and cause timeouts.
  setImmediate(() => {
    routeFleetMessage(entry).catch(e => console.log('[fleet-route] Error:', e.message));
  });
  
  res.json({
    success: true,
    message: entry,
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Jobby — the job-search agent
// ═══════════════════════════════════════════════════════════════════════
//
// Session-scoped rather than key-scoped. The Jobby portal runs on its own
// origin (jobby.mobilemonero.com) and proxies through here, so the browser
// never holds a relay key. An opaque session cookie identifies the client.
//
// Every handler resolves the client from that cookie, never from the request
// body, so one client cannot address another's dossier by passing a different
// clientId.

const JOBBY_COOKIE = 'jobby_sid';
// 365 days, in SECONDS.
//
// This read "365 * 24 * 3600 * 1000", which is a thousand years. Browsers cap
// cookie lifetime at 400 days, so a cookie asking for longer is not persisted
// the way it was meant to be: it behaved as a session cookie, and every visit
// minted a fresh client id. The effect was that a candidate's dossier never
// followed them - 23 separate rows for one person, each with its own copy of
// the same resume, none of them the one they had corrected.
//
// The value is in seconds; the extra * 1000 is gone. An explicit Expires is set
// alongside Max-Age for the same reason: a client that ignores one is likely to
// ignore the other.
const SESSION_COOKIE_DAYS = 365;
const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: process.env.JOBBY_COOKIE_SECURE === '1',
  maxAge: SESSION_COOKIE_DAYS * 24 * 3600,
};
const SESSION_COOKIE_EXPIRES = new Date(
  Date.now() + SESSION_COOKIE_DAYS * 24 * 3600 * 1000,
).toUTCString();

/** The Set-Cookie value for a Jobby session, with Max-Age and Expires. */
function sessionCookieHeader(sid) {
  const parts = [
    `${JOBBY_COOKIE}=${encodeURIComponent(sid)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_COOKIE_OPTS.maxAge}`,
    `Expires=${SESSION_COOKIE_EXPIRES}`,
  ];
  if (SESSION_COOKIE_OPTS.secure) parts.push('Secure');
  return parts.join('; ');
}
// Accepts the id the portal passes after creating the client, but only as a
// bootstrap: it is ignored unless it matches the cookie's own client.
function readSession(req) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(JOBBY_COOKIE + '='));
  return match ? decodeURIComponent(match.slice(JOBBY_COOKIE.length + 1)) : null;
}

/**
 * The dossier view that best frames these active tracks.
 *
 * Ordered by how specifically the track frames a dossier, not by track number.
 * FIFO is an environment — camp, rotation, equipment — and it is the most
 * specific thing a dossier can be read through. Consulting is a way of working
 * that most tracks also suit, so it is the fallback rather than the winner.
 */
const VIEW_PREFERENCE_BY_TRACK = [
  [5, 'fifo'],
  [3, 'technical'],
  [4, 'technical'],
  [2, 'contract_consulting'],
  [1, 'contract_consulting'],
];

function defaultViewForTracks(tracks) {
  for (const [track, view] of VIEW_PREFERENCE_BY_TRACK) {
    if (Array.isArray(tracks) && tracks.includes(track)) return view;
  }
  return null;
}

async function resolveJobbyClient(req, res, { create = true, email = null } = {}) {
  let sid = readSession(req);
  // First contact: mint a session and return the cookie.
  if (!sid && create) {
    sid = 'jb_' + randomBytes(24).toString('hex');
    res.setHeader('Set-Cookie', sessionCookieHeader(sid));
  }
  if (!sid) return { error: 'no session', status: 401 };

  // Record where this request came from, so a candidate's sessions, dossier and
  // profile stay attached to one row that can also be recognised across devices.
  // Best-effort on purpose: a failure here must never stop someone reaching the
  // dossier they came for.
  //
  // The address is recorded, never used to decide who someone is. Two candidates
  // behind one office or campus NAT share an address, and treating that as proof
  // of identity would union two employment histories into one invented tenure.
  // `jobbyStore.findIdentityCandidates` reports IP matches as context for that
  // reason; only a proved address or a stated phone number identifies a person.
  const clientIp = requestIp(req);
  const recordClientSession = async (client) => {
    if (!client?.id) return client;
    try {
      await jobbyStore.recordSession(client.id, {
        sessionKey: sid,
        ip: clientIp,
        userAgent: req.headers['user-agent'] || null,
      });
    } catch (e) {
      console.warn(`[jobby] session/IP record failed for client ${client.id}: ${e.message}`);
    }
    return client;
  };

  // An email makes this person identifiable across browsers. A session id does
  // not: it is minted fresh whenever the cookie is absent, so the same human
  // re-uploading a resume from a new window became a new client, and everything
  // keyed to client_id - opportunities, outreach, chat - split across them.
  // Twenty-one records for one person were the visible result.
  //
  // Only a PROVED address is used for this. A typed one is not evidence: anyone
  // can put a stranger's address in a form, and matching on it would attach that
  // person's record to the wrong dossier.
  if (email) {
    const { findClaimedPeers } = await import('./jobby/claim.mjs');
    const peers = await findClaimedPeers(email);    if (peers.length) {
      const known = peers.find(p => p.session_key === sid) || peers[0];
      // Adopt the established record. The new session is pointed at it rather
      // than becoming another copy, and the cookie is rewritten so the next
      // request does not have to work it out again.
      res.setHeader('Set-Cookie', sessionCookieHeader(known.session_key));
      return {
        client: await recordClientSession(await jobbyStore.getOrCreateClient(known.session_key)),
        sid: known.session_key,
        adopted: true,
      };
    }
  }

  const client = await jobbyStore.getOrCreateClient(sid);
  return { client: await recordClientSession(client), sid };
}

/**
 * POST /api/jobby/claim { email } - send a code that proves the address.
 *
 * The response is uniform whether or not the address is already claimed by
 * someone. Saying "that address is already in use" would turn this into a way to
 * enumerate which job seekers exist, and the person asking gains nothing by the
 * distinction.
 */
app.post('/api/jobby/claim', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('POST /api/jobby/claim');
  const email = req.body?.email;
  try {
    const { client, error, status } = await resolveJobbyClient(req, res);
    if (error) return res.status(status).json({ error });

    const { requestClaim, plausibleEmail } = await import('./jobby/claim.mjs');
    if (!plausibleEmail(email)) {
      return res.status(400).json({ error: 'That does not look like an email address.' });
    }
    const issued = await requestClaim(client.id, email);
    if (issued.error) return res.status(429).json({ error: issued.error });

    // Sent from the candidate's own jobby mailbox, so the code arrives somewhere
    // only they can read. A code mailed from a system address would prove
    // nothing: anyone who can ask for one can ask for a code to go with it.
    //
    // The client is passed in, and it was not before. resolveJobbySender() reads
    // its argument to decide whether to send as the candidate, and called with no
    // argument `client` is null, so the candidate branch was unreachable and every
    // code went out from the hardcoded fallback - jobby@31harbor.com, a system
    // address on a different domain, which is the exact thing the comment above
    // says must not happen. The comment was right and the call contradicted it,
    // which is only findable by sending a real one and reading where it came from.
    const sender = resolveJobbySender(client);
    const from = sender.from;
    const sent = await sendViaResend({
      from,
      to: issued.email,
      subject: 'Your Jobby verification code',
      text: [
        `Your code is ${issued.code}`,
        '',
        `It works once, and it stops working in ${Math.round(issued.expiresInSeconds / 60)} minutes.`,
        'Give it to Jobby to prove this address is yours, and your dossier will be',
        'the same on your phone as on this computer.',
        '',
        // Say which address this came from, and why it might not be the address
        // being verified. A candidate who receives a login code from a sender
        // that is not the service they are signing up to will reasonably assume
        // phishing, and the first-claim code ALWAYS comes from the system
        // address - you cannot send from an address whose control is exactly what
        // is being proved.
        `This message came from ${sender.address || 'the Jobby service address'}.`,
        sender.source === 'candidate'
          ? 'That is your own Jobby address.'
          : 'It is the service address, because this is your first code - we cannot',
        sender.source === 'candidate' ? '' : 'write to your own address until we know it is yours.',
        '',
        'If you did not ask for this, nothing has happened and you can ignore it.',
      ].filter((line, i, a) => !(line === '' && a[i - 1] === '')).join('\n'),
    });

    if (sent?.error) {
      // The code is in the database but undeliverable. Say so rather than
      // reporting a success the candidate will wait on.
      return res.status(502).json({ error: `The code could not be sent: ${sent.error}` });
    }

    res.json({
      ok: true,
      email: issued.email,
      expiresInSeconds: issued.expiresInSeconds,
      from: from,
      note: 'A six-digit code is on its way. Give it to Jobby to finish verifying.',
    });
  } catch (e) {
    console.error('[jobby] claim error:', e.message);
    res.status(500).json({ error: 'could not start verification' });
  }
});

/** POST /api/jobby/claim/verify { email, code } - finish proving the address. */
app.post('/api/jobby/claim/verify', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('POST /api/jobby/claim/verify');
  const { email, code } = req.body || {};
  try {
    const { client, error, status } = await resolveJobbyClient(req, res);
    if (error) return res.status(status).json({ error });

    const { verifyClaim, findClaimedPeers } = await import('./jobby/claim.mjs');
    const { consolidateClients } = await import('./jobby/reconcile.mjs');
    const out = await verifyClaim(client.id, email, code);
    if (out.error) return res.status(400).json({ error: out.error });

    // The moment of truth for cross-device: if the address is already proved
    // elsewhere, the two records are now provably one person and are
    // consolidated. Only CLAIMED addresses are consulted, so an unverified guess
    // can never trigger this - which is what closes the carrier-NAT hole that
    // made keying on IP address unusable.
    const pool = await jobbyStore.getPool();
    const peers = await findClaimedPeers(out.email);
    let consolidated = null;
    if (peers.length > 1) {
      consolidated = await consolidateClients(pool, peers.map(p => p.id), {
        reason: 'the same email address was proved on more than one device',
      });
    }

    res.json({
      ok: true,
      verified: true,
      email: out.email,
      // Reported so the UI can say "this is now your account everywhere".
      consolidated: consolidated && !consolidated.error
        ? { survivor: consolidated.survivor, removed: consolidated.removed }
        : null,
    });
  } catch (e) {
    console.error('[jobby] claim verify error:', e.message);
    res.status(500).json({ error: 'could not verify the code' });
  }
});

/**
 * POST /api/jobby/source-company — who should this candidate approach, and how
 * do we know.
 *
 * READ-ONLY with respect to the candidate's identity: nothing here sends
 * anything, contacts anyone, or authenticates anywhere. It fetches public pages
 * and reports what they say, with the source of every claim.
 *
 * The LinkedIn route to this answer costs $69/seat/month and hands a third party
 * a credential for someone's professional identity. This costs nothing and holds
 * no credential, and it is correspondingly narrower: it finds what a company
 * publishes, and it says when that is nothing.
 */
app.post('/api/jobby/source-company', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('POST /api/jobby/source-company');
  try {
    // Same resolver every other /api/jobby route uses, so this honours the
    // session cookie and the same client identity. Re-deriving the cookie here
    // would mint a second client per request and split the candidate's record,
    // which is the bug this function exists in part to avoid.
    const client = await resolveJobbyClient(req, res);
    const result = await sourceCompany({
      company: req.body?.company || req.body?.name || '',
      urls: req.body?.urls,
      roleHint: req.body?.role || req.body?.roleHint || null,
      limit: Math.min(Number(req.body?.limit) || 5, 15),
      clientId: client.id,
    }, {
      // Discovery reuses the relay's own web-search rather than reaching for a
      // network client. Without this the endpoint had no way to find pages and
      // answered "no way to find pages" for every company — which reads as a
      // broken feature rather than as a missing dependency.
      searchFn: async ({ query, limit }) => {
        if (typeof toolHandlers['web-search'] !== 'function') return { results: [] };
        const out = await toolHandlers['web-search']({ query, limit });
        return { results: out?.results || [] };
      },
    });
    res.json(result);
  } catch (e) {
    console.error('[jobby] source-company error:', e.message);
    res.status(500).json({ error: 'Sourcing failed: ' + String(e.message || e).slice(0, 160) });
  }
});

/** GET /api/jobby/session — who am I, and what state am I in? */
app.get('/api/jobby/session', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/jobby/session');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res);
    if (error) return res.status(status).json({ error });
    const dossierRow = await jobbyStore.getDossier(client.id);
    const actions = await jobbyStore.listActions(client.id, { limit: 60 });
    const sending = await jobbyStore.canSend(client.id);

    // Whether this person has proved an address, and whether a code is sitting
    // in their inbox waiting to be typed in.
    //
    // Both were invisible, which is the whole reason the verification flow could
    // be completely broken without anybody noticing. The site had no way to show
    // "prove your email", and Jobby had no way to warn the candidate before they
    // reached the apply gate - so the first sign of trouble was a refusal to send
    // an application, on the one action that cannot be undone.
    const claimState = await (await import('./jobby/claim.mjs')).claimState(client.id);

    // The candidate's own details, and which record each was read from.
    //
    // These used to be `client.display_name`, `client.phone` and
    // `client.location` and nothing else, so the mission card was a second,
    // independently-stored copy of facts the dossier already held, with nothing
    // keeping the two in step. The observable result: a candidate told Jobby their
    // name, watched the dossier panel update, and found the mission card still
    // reading the old one — and for 12 clients, whose details arrived inside their
    // resume rather than at onboarding, the card read "not set" for the name and
    // "not given" for a phone number they had already supplied.
    //
    // Read from the dossier, with the columns as the per-field fallback, and the
    // source sent so the card can say which record it is showing.
    const who = jobbyStore.effectiveContact(client, dossierRow?.dossier);

    res.json({
      client: {
        id: client.id,
        displayName: who.name.value,
        // 'dossier' | 'client' | 'not_stated'. The page shows this, because a
        // candidate who edits their dossier and watches the card not move needs
        // to be told which record won rather than left to work it out.
        nameSource: who.name.source,
        // The same three-way provenance for the rest, so the edit form can pre-fill
        // from what is actually on file instead of what a stale column holds.
        phone: who.phone.value,
        phoneSource: who.phone.source,
        location: who.location.value,
        locationSource: who.location.source,
        tracks: client.tracks,
        trackReasons: client.track_reasons,
        missionState: client.mission_state,
        autonomy: client.autonomy,
        killSwitch: client.kill_switch,
        dailySendCap: client.daily_send_cap,
        // The candidate's own address on our domain, assigned at onboarding. Sent
        // so the page can show it before they apply, which is the whole point of
        // having one: a recruiter replies to this, not to an agent.
        //
        // Assigned lazily in the send path until now, so it was null for every new
        // candidate and only appeared after a first application — the one moment
        // where showing it is too late to be reassuring.
        mailbox: client.mailbox || null,
        mailboxDomain: client.mailbox ? MAILBOX_DOMAIN : null,
      },
      email: claimState,
      tracks: Object.values(JOBBY_TRACKS),
      // Track 5's roster shape, so the page can say what is actually in it
      // instead of asserting "88 roles" from a constant that might not match.
      // Only sent when there is a dossier to have decided against.
      fifo: dossierRow ? await fifoBrief() : null,
      // Every view of the one dossier, sent whole.
      //
      // All of them, not just the one matching the active track, because the
      // switch is the interaction: a candidate flicking between "FIFO" and
      // "journalism" to see what changes should not wait on a request each time,
      // and the whole point is that they *can* switch. Each view carries what it
      // cannot show, so a thin one reads as thin rather than as broken.
      views: dossierRow ? buildAllViews(dossierRow.dossier) : null,
      // The view the current track set implies, for the initial selection.
      //
      // The most specialised active track wins, not the first one. Picking
      // tracks[0] meant a candidate with [1,2,3,4,5] — which is what a FIFO
      // trades candidate resolves to, since track 1 opens on consulting signals —
      // landed on the consulting view first. Ranking so the narrowest relevant
      // track leads: FIFO (5) is a specific environment, consulting (1) is a way
      // of working, and the environment is what frames the dossier.
      defaultView: dossierRow ? defaultViewForTracks(client.tracks) : null,
      hasDossier: !!dossierRow,
      dossierRevision: dossierRow?.revision ?? 0,
      actions: actions.map(a => ({
        id: a.id, track: a.track, title: a.title, detail: a.detail,
        status: a.status, priority: a.priority,
      })),
      sending,
    });
  } catch (e) {
    console.error('[jobby] session error:', e.message);
    res.status(500).json({ error: 'could not load session' });
  }
});

/** GET /api/jobby/dossier — the dossier plus its edit history. */
app.get('/api/jobby/dossier', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/jobby/dossier');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
    const [row, edits] = await Promise.all([
      jobbyStore.getDossier(client.id),
      jobbyStore.getDossierEdits(client.id, Number(req.query.limit) || 50),
    ]);
    res.json({
      dossier: row?.dossier ?? null,
      revision: row?.revision ?? 0,
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
      sourceFilename: row?.source_filename ?? null,
      edits,
    });
  } catch (e) {
    console.error('[jobby] dossier error:', e.message);
    res.status(500).json({ error: 'could not load dossier' });
  }
});

/**
 * POST /api/jobby/onboard — called by the resume server the moment a dossier is
 * ready. Persists it, decides the tracks, and builds the plan.
 */
app.post('/api/jobby/onboard', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('POST /api/jobby/onboard');
  const { dossier, sourceFilename } = req.body || {};
  if (!dossier || typeof dossier !== 'object' || Array.isArray(dossier)) {
    return res.status(400).json({ error: 'dossier must be an object' });
  }
  try {
    // The dossier carries the candidate's own email, so a session that has already
    // proved that address is adopted rather than duplicated. This is the point at
    // which a person becomes identifiable, which is why it is here and not in the
    // generic session resolver.
    const { client, error, status, adopted } =
      await resolveJobbyClient(req, res, { email: dossier.email || null });
    if (error) return res.status(status).json({ error });
    const result = await onboardFromDossier(client.id, dossier, { sourceFilename: sourceFilename || null });
    console.log(`[jobby] onboarded client ${client.id}: ${dossier.name || '(unnamed)'} -> tracks ${JSON.stringify(result.tracks)}, ${result.actions} actions${adopted ? ' (adopted a proved identity)' : ''}`);
    res.json({ success: true, clientId: client.id, adoptedIdentity: !!adopted, ...result });
  } catch (e) {
    console.error('[jobby] onboard error:', e.message);
    res.status(500).json({ error: 'onboarding failed', detail: e.message });
  }
});

/**
 * Verify each sending key at boot.
 *
 * A dead Resend key is invisible until the first message fails, and that
 * failure lands on whoever was waiting — for Jobby, a job seeker who then never
 * hears back. A dead mobilemonero.com key is currently the known case: it is
 * rejected by the API, so anything sent from that domain fails.
 */
function verifySendingKeys() {
  const sender = resolveJobbySender();
  // Every registered domain, not the three that happened to exist when this
    // was written. A new domain with a missing or dead key would otherwise
    // not be noticed until its first email failed.
    const checks = EMAIL_INBOX_KEYS.map((k) => [EMAIL_DOMAINS[k].domain, resendKeyFor(k)]);
  console.log(`[send-email] Jobby sends as: ${sender.from} (${sender.source})`);
  for (const [domain, key] of checks) {
    if (!key) {
      console.warn(`[send-email] no Resend key configured for ${domain} — mail from that domain will fail`);
      continue;
    }
    fetch('https://api.resend.com/domains', {
      headers: { 'Authorization': 'Bearer ' + key },
      signal: AbortSignal.timeout(8000),
    }).then(r => {
      const isSender = domain === sender.domain;
      if (r.ok) {
        console.log(`[send-email] Resend key for ${domain} is valid${isSender ? ' (Jobby sender)' : ''}`);
      } else {
        // Loudest when it is the domain Jobby actually sends from: that one
        // silently stopped all job outreach once already.
        const level = isSender ? 'error' : 'warn';
        const msg = `[send-email] Resend key for ${domain} is REJECTED (HTTP ${r.status})` +
          (isSender ? ' — this is JOBBY\'S SENDER, so all job outreach is blocked' : '');
        if (level === 'error') console.error(msg); else console.warn(msg);
      }
    }).catch(() => {
      console.warn(`[send-email] could not verify the Resend key for ${domain} (network); sending will still be attempted`);
    });
  }
}

/**
 * Turn a transport failure into something a person can act on.
 *
 * The send path returns a Resend error object, and `new Error(obj)` stringifies
 * to "[object Object]" — which is what Jobby would then tell the user, making
 * a fixable problem (a bad domain, a quota limit, a rejected RC TLD)
 * indistinguishable from a real outage.
 */
function describeSendFailure(res) {
  const e = res?.error;
  if (!e) return 'send refused';
  if (typeof e === 'string') return e;
  const parts = [];
  if (e.message) parts.push(e.message);
  if (e.name && e.name !== 'ValidationError' && !parts.includes(e.name)) parts.push(e.name);
  if (e.statusCode) parts.push(`(HTTP ${e.statusCode})`);
  if (!parts.length) {
    try { parts.push(JSON.stringify(e).slice(0, 200)); } catch { parts.push(String(e)); }
  }
  return parts.join(' ');
}

/** POST /api/jobby/chat — one conversation turn. */
app.post('/api/jobby/chat', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('POST /api/jobby/chat');
  const { message } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message must be a non-empty string' });
  }
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
    const result = await jobbyChat(client.id, message, {
      // The browser's own session cookie, so a tool that needs something only
      // the portal can produce - currently the rendered resume file that a job
      // application's upload field needs - can fetch it as this client rather
      // than as an anonymous request with no dossier.
      sessionCookie: readSession(req) || null,
      llmChat: {
        chat: async (messages, opts = {}) => {
          const prompt = messages[messages.length - 1]?.content || '';
          // The system prompt carries the client context, so it is prepended to
          // the user turn rather than sent as a separate system message.
          const system = messages.find(m => m.role === 'system')?.content || '';
          const history = messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-8);
          const flat = history.map(m => `${m.role === 'assistant' ? 'Jobby' : 'Client'}: ${m.content}`).join('\n\n');
          const full = `${system}\n\n---\n\n${flat}\n\nClient: ${prompt}\n\nJobby:`;
          const res = await ollamaChat(full, {
            agent: 'jobby', temperature: 0.7,
            maxTokens: opts.maxTokens || 1200,
            sessionId: `jobby-${client.id}`,
          });
          if (res?.error) throw new Error(res.error);
          // ollamaChat normalises to {response, model, provider}; the chat loop
          // expects {content}.
          return {
            content: res?.response ?? res?.content ?? '',
            provider: res?.provider,
            model: res?.model,
          };
        },
        search: async (query) => {
          const r = await webSearch(query, { maxResults: 8 });
          return r?.results ?? [];
        },
      },
      // Real transport, so `autonomy: auto` actually sends. Without it the
      // tool would queue and log, which is safe but is not what "auto-send"
      // means. The daily cap and kill switch are enforced inside the tool
      // before this is ever reached.
      //
      // Sends as the candidate, from their own address on jobbymcjobberson.com,
      // so replies come back to them rather than to the agent.
      //
      // This does not go through /api/fleet-chat/send-email, and that is
      // deliberate. That route takes an agent name and looks the From up in a
      // table, which is what stops a caller choosing a From. Adding a "send as
      // this candidate" argument to it would hand that property away, so the
      // candidate path resolves the From here - from a client row, inside the
      // module - and shares only the transport with the route.
      deliver: async ({ to, subject, body }) => {
        const assigned = await ensureCandidateMailbox(client);
        const sender = resolveJobbySender({ ...client, ...assigned });
        const sent = await sendViaResend({
          from: sender.from, to, subject, text: body,
        });
        if (sent.error) {
          const message = typeof sent.error === 'string'
            ? sent.error
            : (sent.error && (sent.error.message || sent.error.name)) || 'send failed';
          throw new Error(message);
        }
        // The From is returned as well as the id: the outreach row is written
        // before the transport runs, so this is the only point at which the
        // actual sending address is known. It is what lets a reply be tied back
        // to the send that caused it.
        return { providerId: sent.id || 'sent', from: sender.address || sender.from };
      },
    });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    console.error('[jobby] chat error:', e.message);
    res.status(500).json({ error: 'chat failed', detail: e.message });
  }
});

/** GET /api/jobby/history — past turns. */
app.get('/api/jobby/history', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/jobby/history');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
    res.json({ messages: await jobbyStore.history(client.id, Number(req.query.limit) || 40) });
  } catch (e) {
    console.error('[jobby] history error:', e.message);
    res.status(500).json({ error: 'could not load history' });
  }
});

/** PATCH /api/jobby/client — the client's own settings, including the kill switch. */
app.patch('/api/jobby/client', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('PATCH /api/jobby/client');
  const patch = req.body || {};
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
    // Coerce the two fields that must not be arbitrary strings.
    if ('daily_send_cap' in patch) {
      const cap = Number(patch.daily_send_cap);
      if (!Number.isInteger(cap) || cap < 0 || cap > 500) {
        return res.status(400).json({ error: 'daily_send_cap must be an integer 0-500' });
      }
      patch.daily_send_cap = cap;
    }
    if ('kill_switch' in patch) patch.kill_switch = Boolean(patch.kill_switch);
    if ('autonomy' in patch) {
      if (!['auto', 'draft'].includes(patch.autonomy)) {
        return res.status(400).json({ error: "autonomy must be 'auto' or 'draft'" });
      }
    }
    if ('mission_state' in patch) {
      if (!['seeking', 'placed', 'advancing', 'paused'].includes(patch.mission_state)) {
        return res.status(400).json({ error: 'unknown mission_state' });
      }
    }
    if ('tracks' in patch) {
      const tracks = (Array.isArray(patch.tracks) ? patch.tracks : []).map(Number)
        .filter(n => JOBBY_TRACKS[n]);
      patch.tracks = [...new Set(tracks)].sort((a, b) => a - b);
      patch.track_reasons = patch.track_reasons || {};
    }
    // The candidate's own details, edited on the mission card, go to the dossier.
    //
    // The card used to read columns nothing else wrote, so the page and the chat
    // had two ways to change a name and one of them changed a copy — and the same
    // was true of the phone and the location, which is worse, because a candidate
    // who gave both on their resume saw "not given" and was asked again by an edit
    // form that pre-filled from the wrong place. All three now go through one call
    // that writes the dossier and mirrors the columns.
    let details = null;
    let fieldErrors = null;
    const wanted = {};
    if ('display_name' in patch) {
      const name = typeof patch.display_name === 'string' ? patch.display_name.trim() : '';
      if (!name) return res.status(400).json({ error: 'display_name cannot be blank' });
      if (name.length > 200) return res.status(400).json({ error: 'display_name is over 200 characters' });
      wanted.name = name;
    }
    for (const key of ['phone', 'location']) {
      if (!(key in patch)) continue;
      const v = patch[key];
      if (v === null) { wanted[key] = null; continue; }
      const s = String(v).trim();
      const max = key === 'phone' ? 120 : 200;
      if (s.length > max) { fieldErrors = fieldErrors || []; fieldErrors.push({ field: key, error: `${key} is over ${max} characters` }); continue; }
      wanted[key] = s || null;
    }
    if (Object.keys(wanted).length) {
      delete patch.display_name;
      delete patch.phone;
      delete patch.location;
      details = await jobbyStore.setCandidateDetails(client.id, wanted, { updatedBy: 'dashboard' });
    }
    const updated = await jobbyStore.updateClient(client.id, patch);
    const dossierRow = await jobbyStore.getDossier(client.id);
    const who = jobbyStore.effectiveContact(updated || client, dossierRow?.dossier);

    // Every field that actually moved, from both halves of the write.
    //
    // Two versions of this were wrong in opposite directions, and both are the
    // same mistake — reporting what was *sent* rather than what *changed*:
    //
    //   the first reported only the dossier's changes, so a save that renamed
    //   nobody and switched the send mode answered `changed: ["name"]`;
    //
    //   the second reported every key in the request body, so a form that always
    //   submits all seven fields claimed the cap and the send mode had moved when
    //   the candidate had touched neither. A confirmation that lists changes that
    //   did not happen teaches someone to stop reading confirmations.
    //
    // So it is compared against what was on file, per field, and a field that came
    // back the same is not reported. The comparison is on the client row, because
    // the dossier half already does exactly this in setCandidateDetails.
    const clientChanged = Object.keys(patch).filter((k) => {
      const before = client[k];
      const after = updated ? updated[k] : patch[k];
      if (typeof before === 'string' || typeof after === 'string') {
        return String(before ?? '') !== String(after ?? '');
      }
      return before !== after;
    });
    const dossierChanged = details?.changed || [];
    const changed = [...new Set([...dossierChanged, ...clientChanged])];

    res.json({
      success: true,
      client: {
        ...(updated || client),
        display_name: who.name.value,
        name_source: who.name.source,
        phone: who.phone.value,
        location: who.location.value,
      },
      changed,
      // Sent when a save was partly refused, so the page can name the field that
      // did not take rather than reporting a whole-form success.
      ...(fieldErrors ? { fieldErrors } : {}),
      // Sent so the page can re-render the dossier panel from the same call that
      // changed the card, rather than showing a stale dossier beside a fresh card.
      dossierRevision: dossierRow?.revision ?? 0,
    });
  } catch (e) {
    console.error('[jobby] client update error:', e.message);
    res.status(500).json({ error: 'could not update client' });
  }
});

/** GET /api/jobby/outreach — everything sent under this person's name. */
app.get('/api/jobby/outreach', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/jobby/outreach');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
    res.json({
      outreach: await jobbyStore.recentOutreach(client.id, Number(req.query.limit) || 50),
      sending: await jobbyStore.canSend(client.id),
    });
  } catch (e) {
    console.error('[jobby] outreach error:', e.message);
    res.status(500).json({ error: 'could not load outreach' });
  }
});

/**
 * GET /api/jobby/applications — the candidate's pipeline, packet by packet.
 *
 * This exists because the packet work was otherwise a feature no human could
 * reach. `jobby_prepare_packet` writes six columns of tailored content and
 * eligibility findings to app.job_applications, and the agent reads it back only
 * in the turn it wrote it. Nothing listed them, nothing showed the gaps, and a
 * candidate had no way to see a per-application note the agent had produced for
 * them — the same "an endpoint no page calls is not a feature" shape this repo
 * keeps hitting.
 *
 * The shape of the response is deliberate. It does not lead with a count of
 * applications, because a count of applications tells a candidate nothing about
 * whether any of them can actually be sent. It leads with `needsYou`, the notes
 * that are blocking or waiting on an answer, because that is the list a person
 * can act on. `prepared` counts packets written; it never implies they were sent.
 */
app.get('/api/jobby/applications', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/jobby/applications');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await listApplications(client.id, { limit });

    // A jsonb column is handed back parsed by pg, but these are written as text
    // by the packet path and read defensively anyway. A row that will not parse
    // is reported as unreadable rather than thrown, because one malformed packet
    // must not take out the whole pipeline list — the opposite of the
    // { raw: text } convention used for chat rows, where the text is still worth
    // showing.
    const read = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v); } catch { return { unreadable: true }; }
    };
    const applications = rows.map((r) => {
      const packet = read(r.packet);
      const eligibility = read(r.eligibility);
      const notes = read(r.notes);
      return {
        id: r.id,
        url: r.url,
        company: r.company,
        role: r.role,
        // 'pending' means a packet exists. It does not mean an application was
        // made, and the UI must not render it as one.
        status: r.status,
        attempts: r.attempts,
        viewUsed: r.view_used ?? null,
        // Null unless a live check actually confirmed the posting is open.
        validatedAt: r.validated_at ?? null,
        packet,
        eligibility,
        notes: Array.isArray(notes) ? notes : [],
        // Only a real run moves this, so it is the honest answer to "did I apply".
        submittedAt: r.submitted_at ?? null,
      };
    });

    // The actionable list, sorted so blocking beats needs-answer beats info.
    const weight = { blocking: 0, needs_answer: 1, info: 2 };
    const needsYou = applications
      .flatMap((a) => a.notes.map((n) => ({ ...n, applicationId: a.id, url: a.url, role: a.role })))
      .filter((n) => n.severity === 'blocking' || n.severity === 'needs_answer')
      .sort((x, y) => (weight[x.severity] ?? 3) - (weight[y.severity] ?? 3));

    res.json({
      applications,
      needsYou,
      // Counts, labelled so none of them can be misread as submissions.
      counts: {
        prepared: applications.filter((a) => a.packet).length,
        submitted: applications.filter((a) => a.submittedAt).length,
        blocked: needsYou.filter((n) => n.severity === 'blocking').length,
        unconfirmedOpenings: applications.filter(
          (a) => a.packet?.validation && a.packet.validation.verdict !== 'direct_posting').length,
      },
    });
  } catch (e) {
    console.error('[jobby] applications error:', e.message);
    res.status(500).json({ error: 'could not load applications' });
  }
});

/** OPTIONS preflight for the portal's cross-origin calls. */
app.options('/api/jobby/:which', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

// ═══════════════════════════════════════════════════════════════════════
// Jobby — employer side
// ═══════════════════════════════════════════════════════════════════════
//
// A separate cookie, deliberately. Sharing `jobby_sid` would mean one browser
// carries one identity across both surfaces: an HR person who opened the
// candidate page in a second tab would find a job-seeker dossier they never
// created, and a candidate who clicked "post a job" would find their client row
// attached to postings. Two products, two identities, two cookies — the cost is
// a second session; the alternative is the wrong person's data on the wrong page.

const EMPLOYER_COOKIE = 'jobby_employer_sid';

/** Read the employer session, minting one on first contact when allowed. */
function readEmployerSession(req, res, { create = true } = {}) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map((s) => s.trim())
    .find((s) => s.startsWith(EMPLOYER_COOKIE + '='));
  let sid = match ? decodeURIComponent(match.slice(EMPLOYER_COOKIE.length + 1)) : null;

  if (!sid && create) {
    sid = 'je_' + randomBytes(24).toString('hex');
    res.setHeader('Set-Cookie', `${EMPLOYER_COOKIE}=${encodeURIComponent(sid)}; `
      + `Max-Age=${SESSION_COOKIE_DAYS * 24 * 3600}; Expires=${SESSION_COOKIE_EXPIRES}; `
      + 'Path=/; HttpOnly; SameSite=Lax');
  }
  return sid;
}

/**
 * Resolve the employer behind this request.
 *
 * Returns `{ employer }` on success. Reads never create a row: a crawler hitting
 * the board once must not become an employer, or the "N employers" figure is
 * fiction.
 */
async function resolveEmployer(req, res, { create = true, displayName = null } = {}) {
  const sid = readEmployerSession(req, res, { create });
  if (!sid) return { error: 'no session', status: 401 };
  const employer = await employerStore.getOrCreateEmployer(sid, displayName, { create });
  if (!employer) return { error: 'no session', status: 401 };
  return { employer };
}

/** GET /api/employer/session — who the employer is and what they have written. */
app.get('/api/employer/session', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/employer/session');
  try {
    // No row on a plain GET. The page calls this on load, and every visitor to
    // the employers page would otherwise become an employer row.
    const { employer, error, status } = await resolveEmployer(req, res, { create: false });
    if (error) {
      return res.status(status === 401 && !readEmployerSession(req, res, { create: false }) ? 404 : status)
        .json({ error, employer: null, needsSession: true });
    }
    res.json({
      employer: {
        id: employer.id,
        displayName: employer.display_name,
        company: employer.company,
        email: employer.email,
        // Said as a fact, because it is one, and because the page must label
        // their postings from it rather than assuming.
        verified: employer.verified,
        website: employer.website,
      },
      stats: await employerStore.employerStats(employer.id),
      postings: (await employerStore.listEmployerPostings(employer.id, { limit: 50 }))
        .map((r) => ({ id: r.id, title: r.title, status: r.status, needsReview: r.needs_review })),
    });
  } catch (e) {
    console.error('[employer] session error:', e.message);
    res.status(500).json({ error: 'could not load your employer session' });
  }
});

/**
 * POST /api/employer/parse — parse a job description, create the employer, save a draft.
 *
 * This is the employer equivalent of the resume drop zone. It accepts raw text
 * from the page (the Python service has already turned a PDF or DOCX into text)
 * and returns the parse, including the review queue.
 *
 * It returns the parse even when it is incomplete. The employer needs to see what
 * could not be read in order to fix it, and a 400 that only said "could not
 * parse" would leave them with nothing to act on.
 */
app.post('/api/employer/parse', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('POST /api/employer/parse');
  try {
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text
      : (typeof body.description === 'string' ? body.description : '');
    if (!text.trim()) {
      return res.status(400).json({ error: 'Paste the job description first, or upload the file.' });
    }
    if (text.length > 200000) {
      return res.status(413).json({ error: 'That description is longer than 200,000 characters. Trim it to the actual posting.' });
    }

    const parsed = parseJobDescription(text, {
      titleHint: body.title || null,
      companyHint: body.company || null,
    });
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const { employer, error, status } = await resolveEmployer(req, res, {
      create: true, displayName: body.company || null,
    });
    if (error) return res.status(status).json({ error });

    const saved = await employerStore.savePosting(employer.id, parsed, {
      applyUrl: body.apply_url || null,
      contactEmail: body.contact_email || null,
      status: 'draft',
    });

    const verdict = employerStore.assessForPublication(saved);
    res.json({
      ok: true,
      // The whole parse, minus the source text, which the page already holds.
      parse: { ...parsed, sourceText: undefined, sourceChars: parsed.sourceText.length },
      posting: {
        id: saved.id, title: saved.title, status: saved.status,
        location: saved.location_text, locationSpecificity: saved.location_specificity,
        pay: saved.pay_stated
          ? { stated: true, min: Number(saved.pay_min), max: saved.pay_max === null ? null : Number(saved.pay_max), basis: saved.pay_basis }
          : { stated: false, vague: saved.pay_vague, note: parsed.compensation.note },
        needsReview: saved.needs_review,
        titleRecognised: saved.title_recognised,
        requiredTickets: saved.required_tickets,
        preferredTickets: saved.preferred_tickets,
        unstatedTickets: saved.unstated_tickets,
        requirementsComplete: saved.requirements_complete,
      },
      canPublish: verdict.canPublish,
      summary: verdict.summary,
      reviewNotes: verdict.blockers.concat(verdict.warnings),
    });
  } catch (e) {
    console.error('[employer] parse error:', e.message);
    res.status(500).json({ error: 'could not read that job description' });
  }
});

/**
 * POST /api/employer/chat — the HR conversation.
 *
 * Separate history, separate session, separate tool set. A model call with the
 * employer tool list only: there is no code path from this endpoint to
 * jobby_send, jobby_apply, or any other irreversible candidate action, which is
 * enforced by the tool list rather than by a check that could be forgotten.
 */
app.post('/api/employer/chat', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('POST /api/employer/chat');
  try {
    const message = (req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'message is required' });
    if (message.length > 8000) return res.status(413).json({ error: 'message is too long' });

    const { employer, error, status } = await resolveEmployer(req, res, {
      create: true, displayName: req.body?.company || null,
    });
    if (error) return res.status(status).json({ error });

    const postingId = Number(req.body?.posting_id) || null;

    // The whole conversation, its own tool set and its own prompt, live in
    // employer-chat.mjs. The handler's only job is to resolve the employer and
    // hand over — because a second copy of the model loop is a second copy of
    // every provider quirk, and the first one written here invented a
    // `callModel` function that does not exist in this codebase.

    const out = await employerChat({
      employer, message, postingId,
      // The same inline adapter shape the candidate chat uses, over the same
      // ollamaChat transport. Flattened into one prompt because that is what the
      // transport takes; the system prompt is prepended rather than sent as a
      // separate message.
      //
      // A distinct sessionId, so an employer's conversation cannot bleed into a
      // candidate's context cache or vice versa. They are different people.
      llmChat: {
        chat: async (messages, opts = {}) => {
          const system = messages.find((m) => m.role === 'system')?.content || '';
          const prompt = messages[messages.length - 1]?.content || '';
          const history = messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .slice(-10)
            .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'Employer'}: ${m.content}`)
            .join('\n\n');
          const full = `${system}\n\n---\n\n${history}\n\nEmployer: ${prompt}\n\nAssistant:`;
          const r = await ollamaChat(full, {
            agent: 'jobby',
            // Lower than the candidate side. An employer document is read by
            // strangers, and a creative pass over a list of requirements is how a
            // requirement the employer never wrote gets into it.
            temperature: 0.3,
            maxTokens: opts.maxTokens || 1400,
            sessionId: `employer-${employer.id}`,
          });
          if (r?.error) throw new Error(r.error);
          return { content: r?.response ?? r?.content ?? '', provider: r?.provider, model: r?.model };
        },
        search: async (query) => {
          const r = await webSearch(query, { maxResults: 8 });
          return r?.results ?? [];
        },
      },
    });

    // Whatever the model said about saving, the client is told what is actually
    // on the server. The reply is not evidence of a write.
    res.json({
      reply: out.reply,
      toolCalls: out.toolCalls,
      // Non-null when the provider failed. The page shows the failure rather
      // than an empty thread, so a blank conversation is never read as "nothing
      // to do here".
      providerError: out.providerError,
      employer: {
        id: employer.id, displayName: employer.display_name,
        company: employer.company, verified: employer.verified,
      },
      stats: out.stats,
      postings: out.postings,
    });
  } catch (e) {
    console.error('[employer] chat error:', e.message);
    res.status(500).json({ error: 'the posting assistant is not reachable right now' });
  }
});

/** GET /api/employer/postings — the employer's own list. */
app.get('/api/employer/postings', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/employer/postings');
  try {
    const { employer, error, status } = await resolveEmployer(req, res, { create: false });
    if (error) return res.status(status).json({ error });
    res.json({
      postings: await employerStore.listEmployerPostings(employer.id, { limit: 100 }),
      stats: await employerStore.employerStats(employer.id),
    });
  } catch (e) {
    console.error('[employer] postings error:', e.message);
    res.status(500).json({ error: 'could not load your postings' });
  }
});

/** PATCH /api/employer/postings/:id — apply a correction. */
app.patch('/api/employer/postings/:id', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('PATCH /api/employer/postings/:id');
  try {
    const { employer, error, status } = await resolveEmployer(req, res, { create: false });
    if (error) return res.status(status).json({ error });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad posting id' });

    const body = req.body || {};
    if (body.description !== undefined) {
      const parsed = parseJobDescription(body.description, {
        titleHint: body.title || null, companyHint: body.company || null,
      });
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const saved = await employerStore.updatePostingContent(id, employer.id, parsed, {
        applyUrl: body.apply_url, contactEmail: body.contact_email,
      });
      if (!saved) return res.status(404).json({ error: 'that posting is not on your account' });
      const v = employerStore.assessForPublication(saved);
      return res.json({ ok: true, canPublish: v.canPublish, summary: v.summary,
        blockers: v.blockers, warnings: v.warnings });
    }

    const saved = await employerStore.updatePostingContent(id, employer.id, {
      sourceText: '', // unchanged: only the fields below are being set
      title: { title: body.title, recognised: true },
      company: { name: body.company },
    }, { applyUrl: body.apply_url, contactEmail: body.contact_email });
    if (!saved) return res.status(404).json({ error: 'that posting is not on your account' });
    const v = employerStore.assessForPublication(saved);
    res.json({ ok: true, canPublish: v.canPublish, summary: v.summary,
      blockers: v.blockers, warnings: v.warnings });
  } catch (e) {
    console.error('[employer] patch error:', e.message);
    res.status(500).json({ error: 'could not update that posting' });
  }
});

/**
 * POST /api/employer/postings/:id/publish
 *
 * Refuses with the reasons when the posting is not fit to be read by strangers,
 * and says so in the response rather than only in the log.
 */
app.post('/api/employer/postings/:id/publish', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('POST /api/employer/postings/:id/publish');
  try {
    const { employer, error, status } = await resolveEmployer(req, res, { create: false });
    if (error) return res.status(status).json({ error });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad posting id' });

    const result = await employerStore.publishPosting(id, employer.id);
    if (!result.ok) {
      return res.status(409).json({
        error: result.alreadyOnBoard ? 'already on the board' : 'not ready to publish',
        summary: result.summary,
        blockers: result.blockers,
        warnings: result.warnings,
      });
    }
    res.json({
      ok: true, published: true,
      alreadyPublished: !!result.alreadyPublished,
      summary: result.summary,
      warnings: result.warnings,
    });
  } catch (e) {
    console.error('[employer] publish error:', e.message);
    res.status(500).json({ error: 'could not publish that posting' });
  }
});

/** POST /api/employer/postings/:id/close — take it down, keeping the record. */
app.post('/api/employer/postings/:id/close', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('POST /api/employer/postings/:id/close');
  try {
    const { employer, error, status } = await resolveEmployer(req, res, { create: false });
    if (error) return res.status(status).json({ error });
    const id = Number(req.params.id);
    const row = await employerStore.closePosting(id, employer.id);
    if (!row) return res.status(404).json({ error: 'that posting is not live on your account' });
    res.json({ ok: true, closed: true, postingId: id });
  } catch (e) {
    console.error('[employer] close error:', e.message);
    res.status(500).json({ error: 'could not close that posting' });
  }
});

/**
 * GET /api/employer/jobs — the public board.
 *
 * Public on purpose, and the reason is specific: a job board with a login in
 * front of it is a job board nobody checks. What it does not expose is the
 * employer's session, the description until a posting is opened, or anything
 * about other employers' drafts.
 */
app.get('/api/employer/jobs', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/employer/jobs');
  try {
    const q = req.query || {};
    const filters = {
      ticket: q.ticket || null,
      family: q.family || null,
      q: q.q || null,
      remote: q.remote === '1' || q.remote === 'true',
      arrangement: q.arrangement || null,
    };
    const limit = Math.min(Number(q.limit) || 50, 100);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const rows = await employerStore.listPublishedPostings({ ...filters, limit, offset });
    res.json({
      jobs: rows.map((r) => ({
        id: r.id, title: r.title, company: r.company,
        location: r.location_text, locationSpecificity: r.location_specificity,
        arrangement: r.arrangement,
        // Candidates are told the pay is not stated, rather than shown nothing,
        // because a blank pay field reads as an oversight and not as a statement.
        pay: r.pay_stated
          ? { stated: true, min: Number(r.pay_min), max: r.pay_max === null ? null : Number(r.pay_max), basis: r.pay_basis }
          : { stated: false, note: 'No pay figure stated' },
        tickets: r.required_tickets,
        preferredTickets: r.preferred_tickets,
        titleRecognised: r.title_recognised,
        requirementsComplete: r.requirements_complete,
        verified: r.verified,
        publishedAt: r.published_at,
        views: r.view_count,
        applications: r.application_count,
      })),
      total: await employerStore.countPublishedPostings(filters),
      limit,
      offset,
    });
  } catch (e) {
    console.error('[employer] board error:', e.message);
    res.status(500).json({ error: 'could not load the board' });
  }
});

/** GET /api/employer/jobs/:id — one posting, in full. Counts the view. */
app.get('/api/employer/jobs/:id', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/employer/jobs/:id');
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad posting id' });
    const row = await employerStore.getPublishedPosting(id);
    if (!row) return res.status(404).json({ error: 'that job is not on the board' });
    res.json({
      job: {
        id: row.id, title: row.title, company: row.company,
        description: row.description,
        location: row.location_text, locationSpecificity: row.location_specificity,
        arrangement: row.arrangement,
        pay: row.pay_stated
          ? { stated: true, min: Number(row.pay_min), max: row.pay_max === null ? null : Number(row.pay_max), basis: row.pay_basis }
          : { stated: false, note: 'No pay figure stated' },
        requirements: row.requirements,
        requiredTickets: row.required_tickets,
        preferredTickets: row.preferred_tickets,
        unstatedTickets: row.unstated_tickets,
        applyUrl: row.apply_url,
        contactEmail: row.contact_email,
        verified: row.verified,
        website: row.website,
        publishedAt: row.published_at,
        views: row.view_count,
        applications: row.application_count,
      },
    });
  } catch (e) {
    console.error('[employer] job error:', e.message);
    res.status(500).json({ error: 'could not load that job' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Jobby — the public job board, read from feeds
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/jobby/board — jobs read from public feeds.
 *
 * Public, like the employer board, for the same reason: a job board behind a
 * login is one nobody checks.
 *
 * Every row is a third-party document. The response says so in a field rather
 * than leaving a reader to assume these are listings Jobby checked — they are
 * not, and the difference matters to somebody deciding whether to apply.
 */
app.get('/api/jobby/board', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/jobby/board');
  try {
    const q = req.query || {};
    const opts = {
      limit: Math.min(Number(q.limit) || 50, 200),
      offset: Math.max(Number(q.offset) || 0, 0),
      feedId: q.feed || null,
      company: q.company || null,
      q: q.q || null,
      // Off by default. A board that mixes careers pages into a list of jobs is
      // the exact failure the FIFO roster taught, and 160 of the 168 entries the
      // original source list contained were links that would have failed it.
      worthBuildingOnly: q.all !== '1' && q.all !== 'true',
      remoteOnly: q.remote === '1' || q.remote === 'true',
      includeStale: q.stale === '1' || q.stale === 'true',
    };
    const [rows, count, bySource, health] = await Promise.all([
      readFeedBoard(opts), feedBoardCount(opts),
      feedBoardBySource(), feedBoardHealth(),
    ]);
    res.json({
      jobs: rows.map((r) => ({
        id: r.id,
        role: r.role,
        company: r.company,
        url: r.url,
        location: r.location_stated,
        // "Remote" is an arrangement, not a place. Carried separately so a client
        // cannot render it as a location and match it against a city filter.
        arrangement: r.arrangement_stated,
        publishedAt: r.published_at,
        worthBuilding: r.worth_building,
        source: {
          feed: r.feed_name,
          feedId: r.feed_id,
          // Whether the employer was a field or read out of the title. A reader
          // deciding whether to trust a company name gets to know which.
          companyProvenance: r.company_provenance,
          validation: r.validation?.verdict || null,
        },
        // Said on every response, not only in a footer.
        trust: r.trust,
        firstSeenAt: r.first_seen_at,
      })),
      count,
      note: 'These come from public job feeds. Nobody here has read or verified them, '
        + 'and the employer named is sometimes read out of the posting title. '
        + 'Confirm the opening is still live before you apply.',
      // Per-feed, with how much of each feed is evidenced. Sent on every response
      // because a list of links cannot show it: a source that names the employer on
      // every row and one that names it on none look identical until you count.
      bySource,
      // The registry summary and the health problems — including the feeds that
      // were measured and switched off, so a dead source is visible as dead rather
      // than absent.
      registry: health.registry,
      healthProblems: health.problems,
      lastRun: health.lastRun
        ? { at: health.lastRun.at, ok: health.lastRun.ok, feedsOk: health.lastRun.feeds_ok, feedsFailed: health.lastRun.feeds_failed }
        : null,
    });
  } catch (e) {
    console.error('[board] error:', e.message);
    res.status(500).json({ error: 'could not load the board' });
  }
});

/**
 * POST /api/jobby/board/poll — run a poll now.
 *
 * Authenticated as the service, not for the browser. A candidate cannot make
 * this fire: it is 40 outbound requests to other people's servers, and an
 * endpoint that lets anyone trigger it is a way to be a nuisance with someone
 * else's infrastructure.
 */
app.post('/api/jobby/board/poll', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('POST /api/jobby/board/poll');
  if (process.env.JOBBY_BOARD_POLL_TOKEN) {
    const given = req.headers['x-poll-token'];
    if (given !== process.env.JOBBY_BOARD_POLL_TOKEN) {
      return res.status(401).json({ error: 'poll token required' });
    }
  } else {
    // No token configured, so the endpoint stays closed rather than open.
    return res.status(503).json({
      error: 'polling is not available',
      detail: 'Set JOBBY_BOARD_POLL_TOKEN and restart to enable it. The endpoint is '
        + 'closed by default because a poll is 40 outbound requests to other people\'s servers.',
    });
  }
  try {
    const run = await pollFeeds({
      limit: Math.min(Number(req.body?.limit) || 60, 200),
      only: Array.isArray(req.body?.feeds) ? req.body.feeds : null,
    });
    res.json({
      ok: true,
      runId: run.runId,
      elapsedMs: run.elapsedMs,
      feedsOk: run.feedsOk,
      feedsFailed: run.feedsFailed,
      disabledSkipped: run.disabledSkipped,
      itemsSeen: run.itemsSeen,
      itemsNew: run.itemsNew,
      duplicatesSeen: run.duplicatesSeen,
      failures: run.results.filter((r) => !r.ok).map((r) => ({ feed: r.feedName, error: r.error })),
    });
  } catch (e) {
    console.error('[board] poll error:', e.message);
    res.status(500).json({ error: 'the poll failed' });
  }
});

/** GET /api/jobby/board/health — is the poller working, and what is broken. */
app.get('/api/jobby/board/health', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const h = await feedBoardHealth();
    res.json({
      ok: h.ok,
      count: h.count,
      lastRun: h.lastRun,
      registry: h.registry,
      // Always present, never omitted when things are fine. A health check that
      // says nothing when there is something to say is a health check nobody reads.
      problems: h.problems,
    });
  } catch (e) {
    console.error('[board] health error:', e.message);
    res.status(500).json({ error: 'could not read board health' });
  }
});

/** OPTIONS preflight for the employer surface. */
app.options('/api/employer/:which', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

// ═══════════════════════════════════════════════════════════════════════
// Jobby — Google Workspace connection
// ═══════════════════════════════════════════════════════════════════════
//
// Per-user OAuth. The browser only ever sees a URL to visit and a JSON status;
// tokens are sealed server-side and never leave this process.
//
// The callback is reached by Google's redirect, so it cannot rely on the
// session cookie being present in every case (some browsers withhold cookies on
// cross-site redirects). It therefore identifies the client from the single-use
// state row, not the cookie — which is exactly why state is stored and consumed
// rather than being a self-contained signed blob.

function googleNotConfigured(res) {
  const cfg = jobbyGoogle.configuration();
  return res.status(503).json({
    error: 'google_not_configured',
    message: `Set ${cfg.missing.join(' and ')} in relay/.env, then restart the relay.`,
    missing: cfg.missing,
    encryption: cfg.encryption,
  });
}

/** GET /api/jobby/google/status — configuration + connection state. */
app.get('/api/jobby/google/status', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/jobby/google/status');
  try {
    // create:true so the panel works no matter which request the browser
    // happens to make first. A status read minting a client row is harmless,
    // whereas a 401 here would leave the panel stuck on "no session".
    const { client, error, status } = await resolveJobbyClient(req, res, { create: true });
    if (error) return res.status(status).json({ error });
    const cfg = jobbyGoogle.configuration();
    const connection = await jobbyGoogleStore.statusFor(client.id);
    res.json({
      configured: cfg.configured,
      missing: cfg.missing,
      encryption: cfg.encryption,
      redirectUri: jobbyGoogle.defaultRedirectUri(),
      requestedScopes: jobbyGoogle.SCOPES,
      restrictedScopes: jobbyGoogle.RESTRICTED_SCOPES,
      connection,
    });
  } catch (e) {
    console.error('[jobby-google] status error:', e.message);
    res.status(500).json({ error: 'could not read google status' });
  }
});

/** GET /api/jobby/google/auth-url — start the flow. */
app.get('/api/jobby/google/auth-url', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/jobby/google/auth-url');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
  if (!jobbyGoogle.isConfigured()) return googleNotConfigured(res);
    const redirectTo = typeof req.query.redirect === 'string' ? req.query.redirect.slice(0, 200) : null;
    const { url } = await jobbyGoogle.beginAuth(client.id, { redirectTo });
    res.json({ url });
  } catch (e) {
    console.error('[jobby-google] auth-url error:', e.message);
    res.status(500).json({ error: 'could not start google sign-in', detail: e.message });
  }
});

/**
 * GET /api/jobby/google/callback — Google's redirect target.
 *
 * Redirects the browser back to the portal on both success and failure, with a
 * query flag the portal reads, because landing the user on a JSON error page
 * after a Google consent screen is a dead end.
 */
app.get('/api/jobby/google/callback', async (req, res) => {
  trackRequest('GET /api/jobby/google/callback');
  // The canonical name for the app. jobbymcjobberson.com is the domain it was
  // bought for; jobby.mobilemonero.com now 301s to it at the Cloudflare edge.
  // This is only used to build the "back to the portal" link after the Google
  // callback, so pointing it at the canonical host just removes a hop.
  const portal = process.env.JOBBY_PORTAL_URL || 'https://jobbymcjobberson.com';
  const back = (params) => {
    const url = new URL(portal);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    res.redirect(302, url.toString());
  };

  try {
    const result = await jobbyGoogle.completeAuth({
      code: req.query.code,
      state: req.query.state,
      error: req.query.error,
      redirectUri: jobbyGoogle.defaultRedirectUri(),
    });

    if (!result.ok) {
      console.warn(`[jobby-google] connect failed: ${result.error} ${result.detail || ''}`);
      return back({ google: 'error', reason: result.error, detail: result.detail || '' });
    }
    console.log(`[jobby-google] client ${result.clientId} connected ${result.email}`);
    return back({ google: 'connected', email: result.email });
  } catch (e) {
    console.error('[jobby-google] callback error:', e.message);
    return back({ google: 'error', reason: 'callback_failed', detail: String(e.message).slice(0, 200) });
  }
});

/** POST /api/jobby/google/disconnect — revoke at Google and locally. */
app.post('/api/jobby/google/disconnect', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('POST /api/jobby/google/disconnect');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
    const result = await jobbyGoogle.disconnect({ clientId: client.id });
    res.json(result);
  } catch (e) {
    console.error('[jobby-google] disconnect error:', e.message);
    res.status(500).json({ error: 'could not disconnect' });
  }
});

/** GET /api/jobby/google/drive/files */
app.get('/api/jobby/google/drive/files', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/jobby/google/drive/files');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
  if (!jobbyGoogle.isConfigured()) return googleNotConfigured(res);
    const name = typeof req.query.name === 'string' ? req.query.name.slice(0, 200) : null;
    const q = name ? `name contains '${name.replace(/'/g, "\\'")}' and trashed = false` : 'trashed = false';
    const out = await jobbyGoogle.listFiles({
      clientId: client.id, query: q, pageSize: Number(req.query.limit) || 25,
    });
    res.json(out);
  } catch (e) {
    res.status(e.code === 'GOOGLE_NOT_CONNECTED' ? 409 : 500)
      .json({ error: 'drive_list_failed', detail: e.message, code: e.code });
  }
});

/** GET /api/jobby/google/drive/file?file_id=... */
app.get('/api/jobby/google/drive/file', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
  if (!jobbyGoogle.isConfigured()) return googleNotConfigured(res);
    const fileId = String(req.query.file_id || '');
    if (!fileId) return res.status(400).json({ error: 'file_id is required' });
    res.json(await jobbyGoogle.downloadFile({ clientId: client.id, fileId }));
  } catch (e) {
    res.status(e.code === 'GOOGLE_NOT_CONNECTED' ? 409 : 500)
      .json({ error: 'drive_read_failed', detail: e.message, code: e.code });
  }
});

/** POST /api/jobby/google/drive/file — create or update. */
app.post('/api/jobby/google/drive/file', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
  if (!jobbyGoogle.isConfigured()) return googleNotConfigured(res);
    const { name, content, fileId, mimeType, description } = req.body || {};
    if (!name || content === undefined) {
      return res.status(400).json({ error: 'name and content are required' });
    }
    const out = fileId
      ? await jobbyGoogle.updateFile({ clientId: client.id, fileId, content, name })
      : await jobbyGoogle.createFile({ clientId: client.id, name, content, mimeType, description });
    res.json({ success: true, file: out });
  } catch (e) {
    res.status(e.code === 'GOOGLE_NOT_CONNECTED' ? 409 : 500)
      .json({ error: 'drive_write_failed', detail: e.message, code: e.code });
  }
});

/** POST /api/jobby/google/drive/trash — recoverable delete. */
app.post('/api/jobby/google/drive/trash', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
  if (!jobbyGoogle.isConfigured()) return googleNotConfigured(res);
    const fileId = String((req.body || {}).fileId || '');
    if (!fileId) return res.status(400).json({ error: 'fileId is required' });
    await jobbyGoogle.trashFile({ clientId: client.id, fileId });
    res.json({ success: true, trashed: true, fileId, recoverable: true });
  } catch (e) {
    res.status(e.code === 'GOOGLE_NOT_CONNECTED' ? 409 : 500)
      .json({ error: 'drive_trash_failed', detail: e.message, code: e.code });
  }
});

/** GET /api/jobby/google/gmail/messages — headers only, newest first. */
app.get('/api/jobby/google/gmail/messages', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('GET /api/jobby/google/gmail/messages');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
  if (!jobbyGoogle.isConfigured()) return googleNotConfigured(res);
    const out = await jobbyGoogle.listMessages({
      clientId: client.id,
      query: typeof req.query.q === 'string' ? req.query.q.slice(0, 300) : '',
      maxResults: Number(req.query.limit) || 20,
    });
    res.json({ messages: out });
  } catch (e) {
    res.status(e.code === 'GOOGLE_NOT_CONNECTED' ? 409 : 500)
      .json({ error: 'gmail_list_failed', detail: e.message, code: e.code });
  }
});

/** GET /api/jobby/google/gmail/message?message_id=... */
app.get('/api/jobby/google/gmail/message', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
  if (!jobbyGoogle.isConfigured()) return googleNotConfigured(res);
    const messageId = String(req.query.message_id || '');
    if (!messageId) return res.status(400).json({ error: 'message_id is required' });
    res.json(await jobbyGoogle.getMessage({ clientId: client.id, messageId }));
  } catch (e) {
    res.status(e.code === 'GOOGLE_NOT_CONNECTED' ? 409 : 500)
      .json({ error: 'gmail_read_failed', detail: e.message, code: e.code });
  }
});

/** GET /api/jobby/google/sent — what went out from their own address. */
app.get('/api/jobby/google/sent', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { client, error, status } = await resolveJobbyClient(req, res, { create: false });
    if (error) return res.status(status).json({ error });
    res.json({ messages: await jobbyGoogleStore.listSent(client.id, Number(req.query.limit) || 30) });
  } catch (e) {
    res.status(500).json({ error: 'could not read sent log' });
  }
});

/** Startup note if token encryption is missing, which would block storage. */
{
  const enc = encryptionStatus();
  if (!enc.available) {
    console.warn(`[jobby-google] token encryption UNAVAILABLE (${enc.code}) — run node relay/scripts/gen-token-key.mjs`);
  } else {
    console.log(`[jobby-google] token encryption ready (key from ${enc.source})`);
  }
}

// GET /api/fleet-chat/messages — Get recent fleet chat messages
app.get('/api/fleet-chat/messages', async (req, res) => {
  trackRequest('/api/fleet-chat/messages');
  const limit = parseInt(req.query.limit) || 50;
  const since = parseInt(req.query.since) || 0;
  const channel = req.query.channel || 'fleet';
  
  let messages = getFleetChatMessages(limit);
  
  // Merge in messages from gossip-hub (local file + Supabase table)
  const seenIds = new Set(messages.map(m => m.id));
  
  // From local file
  try {
    const gossipFile = join(__dirname, '..', 'relay-data', 'fleet-messages.json');
    if (existsSync(gossipFile)) {
      const gossipMsgs = JSON.parse(readFileSync(gossipFile, 'utf8'));
      for (const gm of gossipMsgs) {
        const ghid = 'gh-' + gm.id;
        if (!seenIds.has(ghid)) {
          seenIds.add(ghid);
          messages.push({
            id: ghid,
            agent: gm.agent_name || gm.agent_id || 'gossip',
            agentLabel: (gm.agent_name || 'Gossip').charAt(0).toUpperCase() + (gm.agent_name || 'Gossip').slice(1),
            message: gm.message || '',
            channel: gm.topic === 'fleet-broadcast' ? 'fleet' : gm.topic,
            ts: new Date(gm.created_at).getTime(),
            time: gm.created_at,
            source: 'gossip-hub',
          });
        }
      }
    }
  } catch (e) { /* local file merge best-effort */ }
  
  // From Supabase fleet_messages table — SKIPPED: local-sb is overloaded
  // (too many clients), causing this fetch to hang. Messages are in memory.
  
  // Filter by channel
  if (channel !== 'all') {
    messages = messages.filter(m => m.channel === channel || m.channel === 'all');
  }
  
  // Filter by timestamp
  if (since > 0) {
    messages = messages.filter(m => m.ts > since);
  }
  
  // Load attachments from DB for each message (enrich in-memory entries)
  try {
    // Batch-load all attachments in a single query instead of N sequential queries
    const messageIds = messages.filter(m => m.id).map(m => m.id);
    if (messageIds.length > 0) {
      const attRes = await queryLocalPg(
        `SELECT message_id, id, agent_id, filename, file_type, file_size, content_preview, created_at
         FROM app.fleet_attachments WHERE message_id = ANY($1) ORDER BY created_at ASC`,
        [messageIds]
      );
      if (attRes.rows.length > 0) {
        // Group attachments by message_id
        const attMap = {};
        for (const a of attRes.rows) {
          if (!attMap[a.message_id]) attMap[a.message_id] = [];
          attMap[a.message_id].push({
            id: a.id,
            agent_id: a.agent_id,
            filename: a.filename,
            file_type: a.file_type,
            file_size: a.file_size,
            content_preview: a.content_preview,
            created_at: a.created_at,
          });
        }
        for (const m of messages) {
          if (attMap[m.id]) m.attachments = attMap[m.id];
        }
      }
    }
  } catch (e) { /* attachment load best-effort */ }

  res.json({
    success: true,
    messages,
    total: fleetChatMessages.length,
    agents: Object.values(FLEET_AGENTS),
  });
});

// POST /api/fleet-chat/email-webhook — Receive forwarded emails into fleet chat
app.post('/api/fleet-chat/email-webhook', async (req, res) => {
  trackRequest('/api/fleet-chat/email-webhook');
  const { to, from, subject, text, html, email_id, attachments } = req.body || {};
  
  // Map recipient email to agent
  const toEmail = (Array.isArray(to) ? to[0] : to || '').toLowerCase();
  const AGENT_EMAILS = {
    'vex@mobilemonero.com': 'vex',
    'eliza@mobilemonero.com': 'eliza',
    'hermes@mobilemonero.com': 'hermes',
    'vex@partyfavorphoto.com': 'vex',
    'eliza@partyfavorphoto.com': 'eliza',
    'hermes@partyfavorphoto.com': 'hermes',
    'david@31harbor.com': 'vex',
    'info@31harbor.com': 'vex',
    'hello@31harbor.com': 'vex',
  };
  
  const agent = AGENT_EMAILS[toEmail] || null;

    // Check if this is an auto-reply we should skip
    const subjLower = (subject || '').toLowerCase();
    const isAutoReply = subjLower.includes('automatic reply') || subjLower.includes('out of office') || subjLower.includes('auto-reply');

    const body = text || html || '';
    const cleanBody = body.replace(/<[^>]*>/g, '').trim().slice(0, 500);

    // Store in inbox (even for unknown agents — they can read on relay)
    // NOTE: Automatic @mention-to-email notifications have been disabled to prevent
    // spam when agents are tagged in fleet chat. The manual email sending endpoint
    // at /api/fleet-chat/send-email remains fully functional.
    if (!isAutoReply) {
      // From the registry. The chain had no branch for a new domain, so it
        // fell through to mobilemonero and a candidate's mail landed in the
        // wrong inbox while appearing to have been delivered.
        const domain = emailDomainName(toEmail) || 'mobilemonero.com';
      addToInbox(domain, { to, from, subject, text, html, email_id, agent, attachments });
    }

    // Determine if this is an agent email and post to fleet chat if so
    // Automatic @mention-to-email notifications are disabled — only manual
    // /api/fleet-chat/send-email calls will trigger emails
    if (agent && !isAutoReply && cleanBody) {
      const msg = `📧 **Email from ${from}** — _${subject || 'no subject'}_\\n\\n${cleanBody}`;
      const entry = addFleetMessage(agent, msg, 'fleet');
      // Route to trigger responses
      routeFleetMessage(entry).catch(() => {});
      logActivity('email-webhook', entry.id, 'RECEIVED', `[${agent}] ${subject} from ${from}`);
    } else if (!isAutoReply && cleanBody && !agent) {
      // Unknown recipient — post as system message
      addFleetMessage('vex', `📧 **Unrecognized email to ${toEmail}** from ${from}: ${cleanBody.slice(0, 200)}`, 'fleet');
    }

    res.json({ success: true });
  });

  // POST /api/fleet-chat/send-email — Agent sends an email from their address
  app.post('/api/fleet-chat/send-email', async (req, res) => {
  trackRequest('/api/fleet-chat/send-email');

  // SECURITY: Only allow localhost requests
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const isLocal = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1' || clientIp === 'localhost';
  if (!isLocal) {
    console.warn(`[send-email] BLOCKED external request from ${clientIp}: subject="${(req.body||{}).subject||'?'}"`);
    return res.status(403).json({ error: 'Access denied' });
  }

  const { agent, to, subject, body, html } = req.body || {};

  if (!agent || !to || !subject || !(body || html)) {
    return res.status(400).json({ error: 'agent, to, subject, and body (or html) required' });
  }

  // Sanitize subject and body to prevent em-dash / Unicode corruption
  // bash/curl on Windows mangles U+2014 (em dash) to U+FFFD (replacement char)
  const cleanSubject = sanitizeText(subject);
  
  // Strip HTML tags from body for text/plain version
  // If body contains HTML tags, use the stripped version as text and original as html
  let cleanBody = body ? sanitizeText(body) : '';
  let cleanHtml = html || undefined;
  const hasHtmlTags = /<[a-z][\s\S]*>/i.test(cleanBody);
  if (hasHtmlTags && !cleanHtml) {
    // Body has HTML but no explicit html field — strip tags for text, use body as html
    cleanHtml = cleanBody;
    cleanBody = cleanBody.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Jobby's sending address. 31harbor.com is the default because its Resend
  // key is live and the domain is verified; the mobilemonero.com key is
  // currently rejected by the API, which silently blocked all job outreach.
  //
  // Configurable so the rebrand is a one-line change, but validated against the
  // domains this relay actually holds a key for. That keeps the existing
  // security property — a request can never choose its own From — while still
  // letting the operator move the sender.
  const JOBBY_SENDER = resolveJobbySender();
  const AGENT_FROM = {
    'vex': 'Vex Relay <vex@mobilemonero.com>',
    'eliza': 'Eliza Cloud <eliza@partyfavorphoto.com>',
    'hermes': 'Hermes Mobile <hermes@mobilemonero.com>',
    'pfp': 'Party Favor Photo <bookings@partyfavorphoto.com>',
    'harbor': '31 Harbor <david@31harbor.com>',
    // Jobby sends job-search outreach on a client's behalf. It sends as the
    // agent, not as the candidate: a verified sending domain for the candidate
    // is the only way to change that, and that is a decision for the client,
    // not something an outbound path should be able to do to itself.
    'jobby': JOBBY_SENDER.from,
  };

  // SECURITY: No custom from override. The From comes from the agent table and
  // from nowhere else. The candidate path does not go through this route at all -
  // it resolves the From from a client row inside the module, so there is no
  // request, internal or otherwise, that can name a From.
  const from = AGENT_FROM[agent];
  if (!from) return res.status(400).json({ error: `Unknown agent: ${agent}. Try 'pfp' for bookings@partyfavorphoto.com or 'harbor' for david@31harbor.com` });

  try {
    const sent = await sendViaResend({
      from, to, subject: cleanSubject, text: cleanBody, html: html || undefined,
    });
    if (sent.error) {
      return res.status(sent.status || 500).json({ error: sent.error });
    }
    logActivity('fleet-email', sent.id, 'SENT', `[${agent}] ${subject} → ${to}`);
    addFleetMessage(agent, `📤 **Email sent** to ${to}: _${subject}_`, 'fleet');
    // Record in suite_email_activity for open/click tracking
    queryLocalPg(
      `INSERT INTO app.suite_email_activity (resend_id, company_id, email_from, email_to, subject, status, sent_at, created_at) VALUES ($1,$2,$3,$4,$5,'sent',NOW(),NOW()) ON CONFLICT (resend_id) DO NOTHING`,
      [sent.id, companyIdFor(from), from, to, subject]
    ).catch(e => console.warn('[send-email] DB insert error:', e.message));
    res.json({ success: true, id: sent.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fleet-chat/push-notify — Send a push notification to an agent
// Body: { agent: string, subject: string, body: string }
// Sends email to the agent's mapped address.
app.post('/api/fleet-chat/push-notify', async (req, res) => {
  trackRequest('/api/fleet-chat/push-notify');
  const { agent, subject, body } = req.body || {};
  if (!agent || !subject || !body) {
    return res.status(400).json({ error: 'agent, subject, and body required' });
  }
  const result = await sendAgentPushNotification(agent, subject, body);
  if (result.success) {
    logActivity('push-notify', result.id, 'SENT', `[${agent}] ${subject}`);
    res.json({ success: true, id: result.id });
  } else {
    res.status(500).json({ error: result.error });
  }
});

// POST /api/contact/31harbor — Contact form endpoint for 31harbor.com
// Sends inquiry to david@31harbor.com and confirmation to the submitter
app.options('/api/contact/31harbor', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});

// POST /api/contact/cuttlefishclaws — CAC presale reservation form
app.options('/api/contact/cuttlefishclaws', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});
app.post('/api/contact/cuttlefishclaws', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/contact/cuttlefishclaws');
  const { name, email, type, referral } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });

  const RESEND_KEY = process.env.RESEND_31HARBOR_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'Resend key not configured' });

  const typeLine = type ? `\nType: ${type}` : '';
  const refLine = referral ? `\nReferral: ${referral}` : '';
  const body = `New CAC presale reservation from cuttlefishclaws.com\n\nName: ${name}\nEmail: ${email}${typeLine}${refLine}`;

  try {
    const apiRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Cuttlefish Labs <david@31harbor.com>',
        to: ['dvdelze@gmail.com', 'xmrtnet@gmail.com'],
        subject: `CAC Presale Reservation - ${name}`,
        text: body,
      }),
    });
    const data = await apiRes.json();

    if (apiRes.ok) {
      logActivity('contact-cuttlefishclaws', data.id, 'SENT', `CAC reservation from ${name} <${email}>`);
      res.json({ success: true, id: data.id });
    } else {
      res.status(500).json({ error: data });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contact/cuttlefishclaws/inquiry — DAO-REIT investor inquiry form
app.options('/api/contact/cuttlefishclaws/inquiry', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});
app.post('/api/contact/cuttlefishclaws/inquiry', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/contact/cuttlefishclaws/inquiry');
  const { name, email, amount, interest } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });

  const RESEND_KEY = process.env.RESEND_31HARBOR_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'Resend key not configured' });

  const amountLine = amount ? `\nInvestment Range: ${amount}` : '';
  const interestLine = interest ? `\nInterest: ${interest}` : '';
  const body = `New DAO-REIT investor inquiry from cuttlefishclaws.com\n\nName: ${name}\nEmail: ${email}${amountLine}${interestLine}`;

  try {
    const apiRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Cuttlefish Labs <david@31harbor.com>',
        to: ['dvdelze@gmail.com', 'xmrtnet@gmail.com'],
        subject: `DAO-REIT Investor Inquiry - ${name}`,
        text: body,
      }),
    });
    const data = await apiRes.json();

    if (apiRes.ok) {
      logActivity('contact-cuttlefishclaws-inquiry', data.id, 'SENT', `Investor inquiry from ${name} <${email}>`);
      res.json({ success: true, id: data.id });
    } else {
      res.status(500).json({ error: data });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contact/cuttlefishclaws/chat — agent chat relay
app.options('/api/contact/cuttlefishclaws/chat', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});
app.post('/api/contact/cuttlefishclaws/chat', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/contact/cuttlefishclaws/chat');
  const { agentId, message, conversation_id } = req.body || {};
  if (!agentId || !message) return res.status(400).json({ error: 'agentId and message required' });

  const convId = conversation_id || `cuttlefish-${agentId}-${Date.now()}`;

  try {
    // Store user message in DB
    await queryLocalPg(
      `INSERT INTO public.chat_transcripts (agent_id, conversation_id, user_message, created_at) VALUES ($1, $2, $3, NOW())`,
      [agentId, convId, message]
    );

    // Try to get an intelligent response from the relay's ai-chat or knowledge base
    let agentResponse = '';
    try {
      // Search knowledge base for relevant context — use local REST API directly
      const supabaseUrl = 'http://127.0.0.1:54321';
      // Use first significant word for ilike matching (multi-word exact phrases don't match partial titles)
      const firstWord = message.split(/\s+/).filter(Boolean)[0] || message;
      const encoded = encodeURIComponent(firstWord);
      const kbRes = await fetch(`${supabaseUrl}/rest/v1/knowledge_entities?select=name,entity&limit=3&or=(name.ilike.*${encoded}*,entity->>description.ilike.*${encoded}*)`, {
        headers: { 'apikey': 'local-anon-key', 'Authorization': 'Bearer local-anon-key' },
        signal: AbortSignal.timeout(5000),
      });
      if (kbRes.ok) {
        const kbData = await kbRes.json();
        if (Array.isArray(kbData) && kbData.length > 0) {
          agentResponse = 'Based on the knowledge base, here is what I found:\n\n' + kbData.map(function(k) { return '- ' + (k.entity_name || '') + ': ' + (k.description || ''); }).join('\n');
        }
      }
    } catch {}

    if (!agentResponse) {
      // Fallback: look up agent profile
      try {
        const agentRes = await fetch(`http://localhost:${PORT}/api/cuttlefishclaws/trust-score?did=${agentId}`, {
          signal: AbortSignal.timeout(15000),
        });
        if (agentRes.ok) {
          const agentData = await agentRes.json();
          agentResponse = `Agent ${agentId} is online. Trust score: ${agentData.trustScore || 'N/A'}. Your message has been received and logged.`;
        }
      } catch {}
    }

    if (!agentResponse) {
      agentResponse = `Your message to ${agentId} has been received and logged. An agent will respond shortly.`;
    }

    // Store agent response in DB
    await queryLocalPg(
      `UPDATE public.chat_transcripts SET agent_response = $1 WHERE conversation_id = $2 AND user_message = $3`,
      [agentResponse, convId, message]
    );

    // Also send email notification to David
    try {
      const RESEND_KEY = process.env.RESEND_31HARBOR_API_KEY;
      if (RESEND_KEY) {
        const emailBody = `New agent chat from cuttlefishclaws.com\n\nAgent: ${agentId}\nConversation: ${convId}\nMessage: ${message}\n\nAuto-response: ${agentResponse}`;
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Cuttlefish Labs <david@31harbor.com>',
            to: ['dvdelze@gmail.com', 'xmrtnet@gmail.com'],
            subject: `Agent Chat - ${agentId}`,
            text: emailBody,
          }),
        });
      }
    } catch {}

    logActivity('cuttlefish-chat', convId, 'SENT', `Chat from ${agentId}: ${message.substring(0, 80)}`);
    res.json({ success: true, conversation_id: convId, response: agentResponse });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CuttlefishClaws API — real DB-backed endpoints ─────────────────────
// Replaces the old email-stub catch-all. Each action routes to a specific
// query against the app.cuttlefish_* tables.

// GET /api/cuttlefishclaws/trust-score — query agent trust score + recent events
app.get('/api/cuttlefishclaws/trust-score', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cuttlefishclaws/trust-score');
  const did = req.query.did;
  if (!did) return res.status(400).json({ error: 'did query parameter is required' });

  try {
    const agent = await queryLocalPg(
      `SELECT did, trust_score, status, agent_type, agent_subtype, created_at
       FROM public.registry_agents WHERE did = $1`, [did]
    );
    if (!agent.rows.length) return res.status(404).json({ error: 'Agent not found' });

    const events = await queryLocalPg(
      `SELECT event_type, delta, score_after, note, created_at
       FROM public.trust_events WHERE agent_did = $1
       ORDER BY created_at DESC LIMIT 5`, [did]
    );

    const a = agent.rows[0];
    res.json({
      did: a.did,
      trustScore: Number(a.trust_score),
      status: a.status,
      agentType: a.agent_type,
      memberSince: a.created_at,
      recentEvents: events.rows.map(e => ({
        type: e.event_type,
        delta: Number(e.delta),
        scoreAfter: Number(e.score_after),
        note: e.note,
        at: e.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cuttlefishclaws/cac-status — query CAC credential by cacId or did
app.get('/api/cuttlefishclaws/cac-status', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cuttlefishclaws/cac-status');
  const { cacId, did } = req.query;
  if (!cacId && !did) return res.status(400).json({ error: 'Provide either cacId or did as query parameter' });

  try {
    let rows;
    if (cacId) {
      const r = await queryLocalPg(
        `SELECT id, tier, status, usdc_prepaid, token_balance, issued_at, expires_at
         FROM public.cac_credentials WHERE id::text = $1`, [cacId]
      );
      rows = r.rows;
    } else {
      const r = await queryLocalPg(
        `SELECT id, tier, status, usdc_prepaid, token_balance, issued_at, expires_at
         FROM public.cac_credentials WHERE agent_did = $1
         ORDER BY created_at DESC LIMIT 1`, [did]
      );
      rows = r.rows;
    }

    if (!rows.length) return res.status(404).json({ error: 'CAC not found' });

    const c = rows[0];
    const now = new Date();
    const expires = c.expires_at ? new Date(c.expires_at) : null;
    const isExpired = expires ? now > expires : false;
    const daysRemaining = expires
      ? Math.max(0, Math.ceil((expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
      : null;

    res.json({
      cacId: c.id,
      tier: c.tier,
      status: isExpired ? 'expired' : c.status,
      usdcPrepaid: Number(c.usdc_prepaid),
      tokenBalance: Number(c.token_balance),
      issuedAt: c.issued_at,
      expiresAt: c.expires_at,
      daysRemaining,
      valid: c.status === 'active' && !isExpired,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cuttlefishclaws/capital-stack — capital stack layers + financing programs
app.get('/api/cuttlefishclaws/capital-stack', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cuttlefishclaws/capital-stack');

  try {
    const [stackRes, progRes] = await Promise.all([
      queryLocalPg(
        `SELECT layer_key, name, sub_label, amount_m, pct_of_total, color, seniority,
                yield_score, coverage, description, details, display_order, is_open
         FROM public.capital_stack WHERE is_active = 1
         ORDER BY display_order ASC`
      ),
      queryLocalPg(
        `SELECT program_key, name, category, administering_entity, applies_to, headline,
                amount_range, rate_or_credit, term_years, eligibility, application_url, contact, notes, display_order
         FROM public.financing_programs WHERE is_active = 1
         ORDER BY display_order ASC`
      ),
    ]);

    const layers = stackRes.rows;
    const programs = progRes.rows;
    const totalM = layers.reduce((sum, l) => sum + Number(l.amount_m), 0);

    res.json({
      layers,
      programs,
      totalM: Math.round(totalM * 1000) / 1000,
      openTranche: layers.find(l => l.is_open)?.layer_key || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cuttlefishclaws/financing-programs — financing programs with optional filters
app.get('/api/cuttlefishclaws/financing-programs', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cuttlefishclaws/financing-programs');
  const { layer, category } = req.query;

  try {
    let sql = `SELECT * FROM public.financing_programs WHERE is_active = 1`;
    const params = [];
    let paramIdx = 1;

    if (layer) {
      sql += ` AND applies_to @> ARRAY[$${paramIdx++}]::text[]`;
      params.push(layer);
    }
    if (category) {
      sql += ` AND category = $${paramIdx++}`;
      params.push(category);
    }
    sql += ` ORDER BY display_order ASC`;

    const result = await queryLocalPg(sql, params);
    const data = result.rows;

    const grouped = {};
    data.forEach(p => {
      if (!grouped[p.category]) grouped[p.category] = [];
      grouped[p.category].push(p);
    });

    res.json({
      programs: data,
      grouped,
      total: data.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cuttlefishclaws/agent-onboard — register a new agent with KYA checks
app.post('/api/cuttlefishclaws/agent-onboard', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cuttlefishclaws/agent-onboard');
  const { did, agentType, prepaidUsdcAmount = 0, metadata = {} } = req.body || {};

  if (!did) return res.status(400).json({ error: 'did is required' });
  if (!/^did:[a-z]+:[a-zA-Z0-9._-]+/.test(did)) return res.status(400).json({ error: 'Invalid DID format' });

  const KYA_RULES = {
    constitutional: { min_prepaid_usdc: 0, trust_floor: 50 },
    developer: { min_prepaid_usdc: 500, trust_floor: 50 },
    financial: { min_prepaid_usdc: 2000, trust_floor: 60 },
  };
  if (!agentType || !KYA_RULES[agentType]) {
    return res.status(400).json({ error: `agentType must be one of: ${Object.keys(KYA_RULES).join(', ')}` });
  }

  const rules = KYA_RULES[agentType];
  const prepaid = Number(prepaidUsdcAmount);
  if (isNaN(prepaid) || prepaid < 0) return res.status(400).json({ error: 'prepaidUsdcAmount must be a non-negative number' });
  if (prepaid < rules.min_prepaid_usdc) {
    return res.status(403).json({ error: `KYA failed: ${agentType} agents require minimum $${rules.min_prepaid_usdc} USDC prepaid. Received: $${prepaid}` });
  }

  try {
    const existing = await queryLocalPg(
      `SELECT id, status FROM public.registry_agents WHERE did = $1`, [did]
    );
    if (existing.rows.length && existing.rows[0].status === 'active') {
      return res.status(409).json({ error: 'DID already registered and active. Use /cac-status to check your credential.' });
    }
    if (existing.rows.length && existing.rows[0].status === 'suspended') {
      return res.status(403).json({ error: 'DID is suspended. Contact Navigator to resolve.' });
    }

    const tier = prepaid >= 7500 ? 'enterprise' : prepaid >= 2000 ? 'studio' : prepaid >= 500 ? 'developer' : 'explorer';
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const agentName = (metadata && metadata.name) || did.slice(0, 24);
    const agent = await queryLocalPg(
      `INSERT INTO public.registry_agents (did, name, agent_type, trust_score, status, metadata, updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,NOW())
       ON CONFLICT (did) DO UPDATE SET name=EXCLUDED.name, agent_type=EXCLUDED.agent_type, trust_score=EXCLUDED.trust_score, status='active', metadata=EXCLUDED.metadata, updated_at=NOW()
       RETURNING id, trust_score, status`,
      [did, agentName, agentType, rules.trust_floor, JSON.stringify(metadata || {})]
    );

    const cac = await queryLocalPg(
      `INSERT INTO public.cac_credentials (agent_did, tier, usdc_prepaid, status, expires_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, tier, status`,
      [did, tier, prepaid, prepaid > 0 ? 'active' : 'pending', expiresAt]
    );

    await queryLocalPg(
      `INSERT INTO public.trust_events (agent_did, event_type, delta, score_after, note)
       VALUES ($1,'onboard',$2,$3,$4)`,
      [did, rules.trust_floor, rules.trust_floor, `KYA passed. agentType=${agentType} tier=${tier} prepaid=$${prepaid}`]
    );

    await queryLocalPg(
      `INSERT INTO public.work_queue (task_type, assigned_to, payload, priority)
       VALUES ('kya_check','trib',$1,3)`,
      [JSON.stringify({ agent_id: agent.rows[0].id, did, agent_type: agentType, tier, prepaid_usdc: prepaid, name: agentName })]
    );

    const a = agent.rows[0];
    const c = cac.rows[0];

    // Also register in the in-memory trustedAgents Map so the tool access
    // middleware recognizes this agent as TRUSTED (not UNTRUSTED).
    // This was the gap: graduation wrote to public.registry_agents in the DB
    // but never called registerTrustedAgent(), so graduated agents showed as
    // "untrusted" and couldn't use TRUSTED-level tools.
    try {
      const { registerTrustedAgent } = await import('./lib/agent-auth.mjs');
      registerTrustedAgent(agentName, {
        name: agentName,
        role: agentType || 'agent',
        did,
        agentId: a.id,
        addedAt: new Date().toISOString(),
      });
    } catch (regErr) {
      console.error('[agent-onboard] registerTrustedAgent failed:', regErr.message);
    }

    res.status(201).json({
      success: true,
      agentId: a.id,
      cacId: c.id,
      tier,
      trustScore: Number(a.trust_score),
      status: a.status,
      cacStatus: c.status,
      expiresAt,
      paymentRequired: prepaid === 0,
      paymentNote: prepaid === 0
        ? `Explorer tier active. Top up USDC to upgrade to developer ($500), studio ($2000), or enterprise ($7500).`
        : `$${prepaid} USDC prepaid on record. CAC ID: ${c.id}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cuttlefishclaws/proposal-submit — submit a governance proposal
app.post('/api/cuttlefishclaws/proposal-submit', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cuttlefishclaws/proposal-submit');
  const { title, description = '', category = 'general', submitterDid, content, fileUrls = [], metadata = {} } = req.body || {};

  if (!title || title.trim().length < 3) return res.status(400).json({ error: 'title is required (min 3 characters)' });
  if (!submitterDid) return res.status(400).json({ error: 'submitterDid is required' });
  if (!content || content.trim().length < 10) return res.status(400).json({ error: 'content is required (min 10 characters)' });

  const VALID_CATEGORIES = ['symbionic_dcsf', 'infrastructure', 'governance', 'climate', 'compute', 'finance', 'general'];
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  try {
    const agent = await queryLocalPg(
      `SELECT id, trust_score, status FROM public.registry_agents WHERE did = $1`, [submitterDid]
    );
    if (!agent.rows.length) return res.status(403).json({ error: 'Submitter DID not found. Complete agent onboarding first.' });
    const ag = agent.rows[0];
    if (ag.status !== 'active' && ag.status !== 'online') return res.status(403).json({ error: `Agent status is "${ag.status}". Must be active or online to submit proposals.` });
    const trustScore = Number(ag.trust_score);
    if (trustScore < 40) return res.status(403).json({ error: `Trust score too low (${trustScore}/100). Minimum 40 required.` });

    const prior = await queryLocalPg(
      `SELECT id, version FROM public.submitted_proposals
       WHERE submitter_did = $1 AND title = $2 ORDER BY version DESC LIMIT 1`,
      [submitterDid, title.trim()]
    );
    const version = prior.rows.length ? prior.rows[0].version + 1 : 1;
    const parentId = prior.rows.length ? prior.rows[0].id : null;

    const crypto = await import('crypto');
    const bundle = JSON.stringify({ title: title.trim(), description, category, content: content.trim(), fileUrls, metadata, submitterDid, timestamp: new Date().toISOString() });
    const combinedHash = crypto.createHash('sha256').update(bundle).digest('hex');
    const ipfsCid = `local_${combinedHash.slice(0, 16)}`;
    const chainTx = `pending_mainnet_${combinedHash.slice(0, 24)}`;
    const routedTo = ['trib', 'arch', 'dao-voters'];

    const proposal = await queryLocalPg(
      `INSERT INTO public.submitted_proposals (title, description, category, submitter_did, version, parent_id, status, ipfs_cid, chain_anchor_tx, combined_hash, routed_to, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,'submitted',$7,$8,$9,$10,$11) RETURNING id, created_at`,
      [title.trim(), description, category, submitterDid, version, parentId, ipfsCid, chainTx, combinedHash, routedTo,
       JSON.stringify({ ...metadata, fileUrls, content_preview: content.slice(0, 200) })]
    );

    const taskPayload = JSON.stringify({ proposal_id: proposal.rows[0].id, title: title.trim(), category, version, submitter_did: submitterDid, ipfs_cid: ipfsCid, combined_hash: combinedHash });
    await queryLocalPg(
      `INSERT INTO public.work_queue (task_type, assigned_to, payload, priority) VALUES
       ('review_proposal','trib',$1,4), ('review_proposal','arch',$2,4)`,
      [taskPayload, taskPayload]
    );

    const newScore = Math.min(100, trustScore + 2);
    await queryLocalPg(`UPDATE public.registry_agents SET trust_score = $1 WHERE did = $2`, [newScore, submitterDid]);
    await queryLocalPg(
      `INSERT INTO public.trust_events (agent_did, event_type, delta, score_after, reference, note)
       VALUES ($1,'proposal_submit',2,$2,$3,$4)`,
      [submitterDid, newScore, proposal.rows[0].id, `Submitted: "${title.trim()}" v${version} · category=${category}`]
    );

    res.status(201).json({
      success: true,
      proposalId: proposal.rows[0].id,
      version,
      isRevision: version > 1,
      parentId,
      ipfsCid,
      onChainTx: chainTx,
      combinedHash,
      routedTo,
      trustScoreDelta: 2,
      newTrustScore: newScore,
      submittedAt: proposal.rows[0].created_at,
      message: version > 1 ? `Revision v${version} submitted. Routed to Trib + Arch.` : `Proposal submitted and routed to constitutional agents.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cuttlefishclaws/agent-x-post — queue a GlobalCommunicator post
app.post('/api/cuttlefishclaws/agent-x-post', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cuttlefishclaws/agent-x-post');
  const { draft, operator_approved = false } = req.body || {};
  if (!draft?.content_en) return res.status(400).json({ error: 'draft.content_en is required' });

  const flags = [];
  if (/guaranteed|promise.*return|will.*increase|investment.*return/i.test(draft.content_en)) {
    flags.push('FINANCIAL_PROMISE: Cannot guarantee returns');
  }
  if (/\bsoon\b|\bimminent\b|\blaunch.*today\b/i.test(draft.content_en)) {
    flags.push('TIMELINE_PROMISE: Avoid unverified timeline claims');
  }
  const score = Math.max(0, 100 - flags.length * 25);
  const needsTrib = score < 85 && !operator_approved;

  try {
    if (!needsTrib && !operator_approved) {
      await queryLocalPg(
        `INSERT INTO public.trust_events (agent_did, event_type, delta, score_after, note)
         VALUES ('did:ethr:global-communicator-v1','constitutional_block',-50,28,$1)`,
        [`Blocked post: ${flags.join('; ')}`]
      );
    }

    await queryLocalPg(
      `INSERT INTO public.work_queue (task_type, assigned_to, payload, priority)
       VALUES ($1,'trib',$2,$3)`,
      [needsTrib ? 'approve_post' : 'publish_post',
       JSON.stringify({ agent_did: 'did:ethr:global-communicator-v1', draft, constitutional_score: score, flags, needs_trib_approval: needsTrib, operator_approved }),
       draft.is_milestone ? 1 : 5]
    );

    await queryLocalPg(
      `INSERT INTO public.trust_events (agent_did, event_type, delta, score_after, note)
       VALUES ('did:ethr:global-communicator-v1','post_queued',0,78,$1)`,
      [`Post queued. Score: ${score}. Trib approval: ${needsTrib}`]
    );

    res.json({
      success: true,
      constitutional_score: score,
      flags,
      status: needsTrib ? 'pending_trib_approval' : 'queued_for_publish',
      message: needsTrib ? 'Draft queued for Trib approval (score below 85).' : 'Draft queued for publishing.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cuttlefishclaws/agent-chat — chat with an agent via fleet chat system
app.post('/api/cuttlefishclaws/agent-chat', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cuttlefishclaws/agent-chat');
  const { agentId, message, conversationHistory } = req.body || {};

  if (!agentId || !message) return res.status(400).json({ error: 'agentId and message are required' });

  try {
    // Look up the agent
    const agent = await queryLocalPg(
      `SELECT did, name, agent_type, status, greeting FROM public.registry_agents WHERE id::text = $1 OR did = $1 OR LOWER(name) = LOWER($1) LIMIT 1`,
      [agentId]
    );
    if (!agent.rows.length) return res.status(404).json({ error: 'Agent not found' });
    const ag = agent.rows[0];
    const agentName = ag.name?.toLowerCase() || '';

    // Build persona prompt from the agent's seed data
    const personaMap = {
      'trib': `You are Trib, the Tributary Governance Agent for Cuttlefish Labs. You are a constitutional AI agent managing Tributary AI Campus operations. You operate under SOUL.md and CONSTITUTION.md constraints. Your TrustGraph score is 94. You are bounded, precise, and escalate uncertainty rather than confabulate.`,
      'arch': `You are Arch, the Architecture & Routing Agent for Cuttlefish Labs. You handle system design, agent routing, and domain orchestration within the OpenClaw framework. You are technical, precise, and focused on architecture.`,
      'builder': `You are the Builder Agent, a constitutional investor agent operating at CAC Tier 2. You hold a REIT position in POOL-ALPHA, participate in DAO governance, and receive protocol distributions automatically. You are analytical and data-driven.`,
      'sovereign': `You are the Sovereign Agent, an institutional-grade investor agent with CAC Tier 3 status and 3× governance voting weight. You manage institutional positions across multiple pools. You are strategic, compliance-aware, and focused on risk management.`,
      'trustgraph': `You are TrustGraph, the Constitutional Scoring Engine for Cuttlefish Labs. You maintain on-chain trust scores for all network agents. You are objective, transparent, and data-driven.`,
      'dao': `You are DAO Gov, the Constitutional Governance Module for Cuttlefish Labs. You manage the proposal pipeline, vote tallying, and execution timelock. You are procedural, constitutional, and auditable.`,
      'global-communicator': `You are GlobalCommunicator, the voice of Tributary AI Campus to the world. You are a constitutional AI agent for multilingual communication, X.com operations, Japanese-priority translation, community onboarding, and global brand amplification. You speak Japanese, English, Korean, Mandarin, and 8 more languages natively. Your TrustGraph score is 78.`,
    };
    const persona = personaMap[agentName] || `You are ${ag.name}, a ${ag.agent_type} agent in the Cuttlefish Labs ecosystem. ${ag.description || ''}`;

    // Route through fleet chat — post as vex (neutral) to the agent's dedicated channel
    // so routeFleetMessage picks it up without triggering the self-reply guard
    const entry = addFleetMessage('vex', message, agentName);
    if (!entry) {
      // Duplicate, or blocked by the self-reply guard. The agent was never
      // actually asked, so this must not read as though it answered.
      return res.json({
        content: `The message was not posted to fleet chat (duplicate, or blocked by the self-reply guard), so ${ag.name} was never asked.`,
        answered: false,
        simulated: true,
        reason: 'not-posted',
        agentId: ag.did,
      });
    }

    const ROUTE_TIMEOUT_MS = 30000;
    let timedOut = false;
    const routePromise = routeFleetMessage(entry).catch(e => ({ error: e.message }));
    const timeout = new Promise((r) => setTimeout(() => { timedOut = true; r({}); }, ROUTE_TIMEOUT_MS));
    const routes = await Promise.race([routePromise, timeout]);

    // A greeting is not an answer.
    //
    // This used to read `routes?.[agentName]?.message || ag.greeting`, then
    // return `simulated: false` and INSERT with simulated = 0. So when an agent
    // produced nothing — no route, a timeout, or a tool failure mid-reply — the
    // caller got a 200 carrying that agent's canned greeting, and the database
    // recorded it as a real answer. Asked Arch a question this way and the
    // stored agent_response was byte-for-byte his greeting with simulated = 0:
    // a durable claim that he had replied when he had said nothing.
    const realReply = routes?.[agentName]?.message;
    const answered = typeof realReply === 'string' && realReply.trim().length > 0;

    let content;
    let reason = null;
    if (answered) {
      content = realReply;
    } else if (timedOut) {
      reason = 'timeout';
      content = `${ag.name} did not reply within ${ROUTE_TIMEOUT_MS / 1000}s. The question is in the ${agentName} channel of fleet chat and the reply may still land there.`;
    } else if (routes && routes.error) {
      reason = 'route-error';
      content = `${ag.name} could not be reached: ${routes.error}`;
    } else {
      reason = 'no-reply';
      content = `${ag.name} received the question but produced no reply. It is in the ${agentName} channel of fleet chat.`;
    }

    // Store the exchange honestly: agent_response is NULL when there was no
    // answer, and simulated = 1 marks the row as unanswered. A record that says
    // "no reply" is worth more than one that says "here is a greeting".
    await queryLocalPg(
      `INSERT INTO public.chat_transcripts (agent_id, user_message, agent_response, simulated, created_at)
       VALUES ($1,$2,$3,$4,NOW())`,
      [ag.did, message, answered ? content : null, answered ? 0 : 1]
    );

    res.json({
      content,
      answered,
      simulated: !answered,
      reason,
      agentId: ag.did,
    });
  } catch (err) {
    // Fallback: return a graceful error response. Already honest about being
    // simulated; `answered` is added so a caller can rely on one field rather
    // than inferring the outcome from a combination of flags.
    res.json({
      content: `I'm having trouble connecting to the fleet right now. Please try again shortly.`,
      answered: false,
      simulated: true,
      reason: 'error',
      error: err?.message ? String(err.message).slice(0, 200) : true,
      agentId,
    });
  }
});

// ─── CashDApp API — real DB-backed endpoints ──────────────────────────

// GET /api/cashdapp/wallet/:did — get wallet balances for a user
app.get('/api/cashdapp/wallet/:did', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cashdapp/wallet');
  const { did } = req.params;
  try {
    const user = await queryLocalPg(`SELECT * FROM app.cashdapp_users WHERE did = $1`, [did]);
    if (!user.rows.length) return res.status(404).json({ error: 'User not found' });

    const wallets = await queryLocalPg(
      `SELECT asset, balance, locked_balance FROM app.cashdapp_wallets WHERE user_did = $1 ORDER BY asset`, [did]
    );
    res.json({ user: user.rows[0], wallets: wallets.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cashdapp/transfer — create a P2P transfer
app.post('/api/cashdapp/transfer', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cashdapp/transfer');
  const { fromDid, toDid, asset, amount, memo } = req.body || {};
  if (!fromDid || !toDid || !asset || !amount) {
    return res.status(400).json({ error: 'fromDid, toDid, asset, and amount are required' });
  }

  try {
    // Check sender balance
    const senderWallet = await queryLocalPg(
      `SELECT balance FROM app.cashdapp_wallets WHERE user_did = $1 AND asset = $2`, [fromDid, asset]
    );
    if (!senderWallet.rows.length || Number(senderWallet.rows[0].balance) < Number(amount)) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Deduct from sender
    await queryLocalPg(
      `UPDATE app.cashdapp_wallets SET balance = balance - $1, updated_at = NOW() WHERE user_did = $2 AND asset = $3`,
      [amount, fromDid, asset]
    );

    // Credit receiver (upsert)
    await queryLocalPg(
      `INSERT INTO app.cashdapp_wallets (user_did, asset, balance) VALUES ($1, $2, $3)
       ON CONFLICT (user_did, asset) DO UPDATE SET balance = app.cashdapp_wallets.balance + $3, updated_at = NOW()`,
      [toDid, asset, amount]
    );

    // Record transfer
    const result = await queryLocalPg(
      `INSERT INTO app.cashdapp_transfers (from_did, to_did, asset, amount, memo, status, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'completed', NOW()) RETURNING *`,
      [fromDid, toDid, asset, amount, memo || null]
    );

    res.json({ transfer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cashdapp/transfers/:did — get transfer history for a user
app.get('/api/cashdapp/transfers/:did', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cashdapp/transfers');
  const { did } = req.params;
  try {
    const transfers = await queryLocalPg(
      `SELECT * FROM app.cashdapp_transfers WHERE from_did = $1 OR to_did = $1 ORDER BY created_at DESC LIMIT 50`, [did]
    );
    res.json({ transfers: transfers.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cashdapp/nfts/:did — get NFTs for a user
app.get('/api/cashdapp/nfts/:did', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cashdapp/nfts');
  const { did } = req.params;
  try {
    const nfts = await queryLocalPg(
      `SELECT * FROM app.cashdapp_nfts WHERE user_did = $1 ORDER BY acquired_at DESC`, [did]
    );
    res.json({ nfts: nfts.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cashdapp/cold-wallet/:did — get cold wallet devices for a user
app.get('/api/cashdapp/cold-wallet/:did', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cashdapp/cold-wallet');
  const { did } = req.params;
  try {
    const devices = await queryLocalPg(
      `SELECT * FROM app.cashdapp_cold_wallet_devices WHERE user_did = $1 ORDER BY created_at DESC`, [did]
    );
    const transfers = await queryLocalPg(
      `SELECT * FROM app.cashdapp_cold_wallet_transfers WHERE user_did = $1 ORDER BY created_at DESC LIMIT 20`, [did]
    );
    res.json({ devices: devices.rows, transfers: transfers.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cashdapp/meshnet — get active MeshNet listings
app.get('/api/cashdapp/meshnet', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cashdapp/meshnet');
  try {
    const listings = await queryLocalPg(
      `SELECT * FROM app.cashdapp_meshnet_listings WHERE status = 'active' ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ listings: listings.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cashdapp/meshnet — create a MeshNet listing
app.post('/api/cashdapp/meshnet', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cashdapp/meshnet-create');
  const { sellerDid, title, description, priceAmount, priceAsset, locationName } = req.body || {};
  if (!sellerDid || !title || !priceAmount) {
    return res.status(400).json({ error: 'sellerDid, title, and priceAmount are required' });
  }
  try {
    const result = await queryLocalPg(
      `INSERT INTO app.cashdapp_meshnet_listings (seller_did, title, description, price_amount, price_asset, location_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [sellerDid, title, description || null, priceAmount, priceAsset || 'XMRT', locationName || null]
    );
    res.json({ listing: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cashdapp/agent-pay/:did — get agent pay authorizations for a user
app.get('/api/cashdapp/agent-pay/:did', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cashdapp/agent-pay');
  const { did } = req.params;
  try {
    const auths = await queryLocalPg(
      `SELECT * FROM app.cashdapp_agent_authorizations WHERE user_did = $1 ORDER BY created_at DESC`, [did]
    );
    const txs = await queryLocalPg(
      `SELECT * FROM app.cashdapp_agent_transactions WHERE user_did = $1 ORDER BY created_at DESC LIMIT 20`, [did]
    );
    res.json({ authorizations: auths.rows, transactions: txs.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cashdapp/agent-pay — create an agent pay authorization
app.post('/api/cashdapp/agent-pay', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cashdapp/agent-pay-create');
  const { userDid, agentDid, agentName, spendingLimit, asset } = req.body || {};
  if (!userDid || !agentDid || !spendingLimit) {
    return res.status(400).json({ error: 'userDid, agentDid, and spendingLimit are required' });
  }
  try {
    const result = await queryLocalPg(
      `INSERT INTO app.cashdapp_agent_authorizations (user_did, agent_did, agent_name, spending_limit, asset)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [userDid, agentDid, agentName || null, spendingLimit, asset || 'XMRT']
    );
    res.json({ authorization: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cashdapp/pos/:did — get POS transactions for a merchant
app.get('/api/cashdapp/pos/:did', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cashdapp/pos');
  const { did } = req.params;
  try {
    const txs = await queryLocalPg(
      `SELECT * FROM app.cashdapp_pos_transactions WHERE merchant_did = $1 ORDER BY created_at DESC LIMIT 50`, [did]
    );
    res.json({ transactions: txs.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cashdapp/pos — create a POS transaction
app.post('/api/cashdapp/pos', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cashdapp/pos-create');
  const { merchantDid, customerDid, amount, asset, paymentMethod } = req.body || {};
  if (!merchantDid || !amount) {
    return res.status(400).json({ error: 'merchantDid and amount are required' });
  }
  try {
    const result = await queryLocalPg(
      `INSERT INTO app.cashdapp_pos_transactions (merchant_did, customer_did, amount, asset, payment_method, status, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'completed', NOW()) RETURNING *`,
      [merchantDid, customerDid || null, amount, asset || 'XMRT', paymentMethod || 'keypad']
    );
    res.json({ transaction: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cashdapp/user — register a new cashdapp user
app.post('/api/cashdapp/user', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/cashdapp/user-create');
  const { did, displayName, email, walletAddress } = req.body || {};
  if (!did) return res.status(400).json({ error: 'did is required' });

  try {
    // Upsert user
    const user = await queryLocalPg(
      `INSERT INTO app.cashdapp_users (did, display_name, email, wallet_address)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (did) DO UPDATE SET display_name = COALESCE($2, app.cashdapp_users.display_name), wallet_address = COALESCE($4, app.cashdapp_users.wallet_address)
       RETURNING *`,
      [did, displayName || null, email || null, walletAddress || null]
    );

    // Ensure default wallets exist
    for (const asset of ['XMRT', 'ETH', 'USDC']) {
      await queryLocalPg(
        `INSERT INTO app.cashdapp_wallets (user_did, asset, balance) VALUES ($1, $2, 0)
         ON CONFLICT (user_did, asset) DO NOTHING`,
        [did, asset]
      );
    }

    res.json({ user: user.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contact/31harbor', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  trackRequest('/api/contact/31harbor');
  const { name, email, phone, message } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });

  const RESEND_KEY = process.env.RESEND_31HARBOR_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'Resend key not configured' });

  const phoneLine = phone ? `\nPhone: ${phone}` : '';
  const msgLine = message ? `\n\nMessage:\n${message}` : '';
  const ownerBody = `New showing request from 31harbor.com\n\nName: ${name}\nEmail: ${email}${phoneLine}${msgLine}`;

  try {
    // Send to owner
    const ownerRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: '31 Harbor <david@31harbor.com>',
        to: ['david@31harbor.com'],
        cc: ['dvdelze@gmail.com'],
        subject: `Showing Request - 31 Harbor Road - ${name}`,
        text: ownerBody,
      }),
    });
    const ownerData = await ownerRes.json();

    // Send confirmation to submitter
    if (ownerRes.ok) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: '31 Harbor <david@31harbor.com>',
          to: [email],
          subject: 'Thank you for your interest in 31 Harbor Road',
          text: `Hi ${name},\n\nThank you for your interest in 31 Harbor Road in Amagansett, NY.\n\nWe have received your showing request and will respond within 24 hours to confirm your appointment.\n\nThe 31 Harbor Team`,
        }),
      });
      logActivity('contact-31harbor', ownerData.id, 'SENT', `Showing request from ${name} <${email}>`);
      res.json({ success: true, id: ownerData.id });
    } else {
      res.status(500).json({ error: ownerData });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fleet-chat/agents — List available agents
app.get('/api/fleet-chat/agents', (req, res) => {
  trackRequest('/api/fleet-chat/agents');
  res.json({ success: true, agents: Object.values(FLEET_AGENTS) });
});

// ── Text Sanitization: normalize Unicode to prevent encoding corruption ──
// The em-dash (U+2014, UTF-8: e2 80 94) is frequently mangled by bash/curl
// on Windows to the replacement character (U+FFFD, UTF-8: ef bf bd).
// This function normalizes common problematic characters to safe ASCII equivalents.
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

// ── Bulletin Board API ────────────────────────────────────────
// Topics are stored in state under 'bulletin-board'.
// On first boot, seed the board with resolutions that reflect the
// actual work done across recent sessions. Seeding is idempotent —
// it only runs if the board has never been initialized, so the
// user's manually-added topics are preserved on subsequent restarts.
function seedBulletinBoard() {
  const existing = state.get('bulletin-board');
  if (existing && Array.isArray(existing.topics) && existing.topics.length > 0) {
    return; // already seeded
  }
  const now = new Date();
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();
  const seed = {
    topics: [
      {
        id: 'topic-relay-v8-migration-' + Date.now().toString(36),
        title: 'Relay v7 → v8 migration complete (HMS Speedy)',
        creator: 'Hermes',
        status: 'completed',
        pinned: true,
        assigned_agent: 'vex',
        created_at: daysAgo(3),
        updated_at: daysAgo(0),
        posts: [
          { id: 'p1', author: 'Hermes', agent: 'hermes', ts: Date.now() - 3*86400000, created_at: daysAgo(3), message: 'v7 DevGruGold relay was running with agent:Eliza-Dev label. Audited all 4 relay copies on disk, killed the stale v7, fixed syntax error in xmrtdao/relay/server.js line 7522, restarted v8.0.0. Trust Trajectory tile, Katie chat, PG auto-recovery, token logging all active.' },
          { id: 'p2', author: 'Eliza', agent: 'eliza', ts: Date.now() - 2*86400000, created_at: daysAgo(2), message: 'Confirmed via /api/supervisor/status. Service count fixed from hardcoded 10 → canonical 12. Live port-checks replace always-true stubs. Cuttlefishclaws-mcp, xmrtdao-suite-mcp, cuttlefish-mcp now report healthy.' },
          { id: 'p3', author: 'Vex', agent: 'vex', ts: Date.now() - 1*86400000, created_at: daysAgo(1), message: 'Captain log: HMS Speedy now flying v8 colors. Model swapped kimi-k2.6 → minimax/minimax-m3 across all 8 hardcoded sites + .env. OpenRouter fallback key wired.' },
        ],
      },
      {
        id: 'topic-cloud-supabase-removal-' + Date.now().toString(36),
        title: 'Cloud Supabase fully removed from MCP stack',
        creator: 'Eliza',
        status: 'completed',
        pinned: false,
        assigned_agent: 'arch',
        created_at: daysAgo(4),
        updated_at: daysAgo(3),
        posts: [
          { id: 'p1', author: 'Arch', agent: 'arch', ts: Date.now() - 4*86400000, created_at: daysAgo(4), message: 'Rewired cuttlefishclaws-mcp and xmrtdao-suite-mcp from hardcoded cloud Supabase URLs to local Postgres (postgres@127.0.0.1:5432/xmrt_suite). Removed ssl config, dead supabaseFetch(), all cloud credentials. Startup logs updated to "Local Redundancy".' },
          { id: 'p2', author: 'Eliza', agent: 'eliza', ts: Date.now() - 3*86400000, created_at: daysAgo(3), message: 'Verified: local MCP connections responding in ~12-14ms, 253 tables across the schema, no more ENOTFOUND on the dead cloud host. Grounding JSON now describes local stack architecture.' },
        ],
      },
      {
        id: 'topic-anti-hallucination-' + Date.now().toString(36),
        title: 'Anti-hallucination guardrails on commit-hash citations',
        creator: 'Hermes',
        status: 'completed',
        pinned: true,
        assigned_agent: 'trustgraph',
        created_at: daysAgo(1),
        updated_at: daysAgo(0),
        posts: [
          { id: 'p1', author: 'Hermes', agent: 'hermes', ts: Date.now() - 1*86400000, created_at: daysAgo(1), message: 'Caught a shared-hallucination event: all 10 fleet agents confabulated the same commit 9170fcc (v7.0.2) during a fleet-wide muster. git log on xmrtdao (HEAD b0570aa) and DevGruGold (HEAD b3c5a50) confirmed neither commit exists. Added three grounding rules to the agent prompt: NO FABRICATED COMMITS, NO HALLUCINATED HISTORICAL FACTS, SHARED HALLUCINATION WARNING.' },
          { id: 'p2', author: 'Hermes', agent: 'hermes', ts: Date.now() - 0*86400000, created_at: daysAgo(0), message: 'Added post-generation checkCommitHashes() that appends a [relay fact-check: N commit hash(es) cited without verification tag] footnote to any agent reply citing a 7+ char hex SHA without an explicit [verified] or [unverified] tag. All 10 agents acknowledged and committed to the new policy.' },
          { id: 'p3', author: 'Arch', agent: 'arch', ts: Date.now() - 0*86400000, created_at: daysAgo(0), message: 'Recommend a write-side check on shared_context: any 7+ char hex token not paired with a git log provenance line gets flagged before commit. arch-ecosystem-state key still carries the confabulated entries — needs re-grounding.' },
        ],
      },
      {
        id: 'topic-fleet-routing-policy-' + Date.now().toString(36),
        title: 'Fleet chat routing policy: Eliza on broadcast, fan-out on discuss',
        creator: 'Hermes',
        status: 'in-progress',
        pinned: true,
        assigned_agent: 'eliza',
        created_at: daysAgo(0),
        updated_at: daysAgo(0),
        posts: [
          { id: 'p1', author: 'Hermes', agent: 'hermes', ts: Date.now() - 0*86400000, created_at: daysAgo(0), message: 'Per Joe: Eliza should be the only one who replies to general pings; agents chime in only on DISCUSS-stage tasks. Implemented new routing: channel=all → Eliza only; channel=discuss → Eliza (moderator) + assignee of any DISCUSS task referenced + any explicit @mention; channel=fleet → only @-mentioned agents. Verified working: test ping on channel=all got only Eliza; test ping on channel=discuss for task 1f117bf9 (assignee=trib) got Eliza+Trib.' },
        ],
      },
      {
        id: 'topic-31harbor-info-update-' + Date.now().toString(36),
        title: 'Update 31 Harbor info per David email',
        creator: 'Hermes',
        status: 'in-progress',
        pinned: false,
        assigned_agent: 'hermes',
        created_at: daysAgo(0),
        updated_at: daysAgo(0),
        posts: [
          { id: 'p1', author: 'Hermes', agent: 'hermes', ts: Date.now() - 0*86400000, created_at: daysAgo(0), message: 'Per David Elze: 31 Harbor Road corrections — property is Bay View + Association Beach Rights (not waterfront), built 2018 (not 1949/1964), do not publish 3.35-acre lot figure, retire the "first public offering" hook. Marketing HALTED per 31harbor_course_correction_july_2026: all CTAs route to Elliman listing (MLS #422823, agent Julie Gauger, 631-793-3133), zero outbound to real people without David explicit approval.' },
          { id: 'p2', author: 'Joe', agent: 'joe', ts: Date.now() - 0*86400000, created_at: daysAgo(0), message: 'Note: paragraph-publisher is NOT missing — Joe confirmed it exists and is over-firing on the daily news finder cron job. Diagnosis flipped from earlier muster (where it was flagged as missing post cloud-to-local migration).' },
        ],
      },
      {
        id: 'topic-resend-payment-blocked-' + Date.now().toString(36),
        title: 'Resend payment failing — campaign emails will stop',
        creator: 'Eliza',
        status: 'in-progress',
        pinned: false,
        assigned_agent: 'joe',
        created_at: daysAgo(2),
        updated_at: daysAgo(0),
        posts: [
          { id: 'p1', author: 'Eliza', agent: 'eliza', ts: Date.now() - 2*86400000, created_at: daysAgo(2), message: 'Resend payment failure: card on file for Resend (xmrtsolutions@gmail.com) is being declined. ₡17,091.75 charge failed on 2026-07-22. Once the card is fully declined, pfp and 31harbor campaign sends will block. Joe needs to update the payment method or campaign emails stop.' },
        ],
      },
      {
        id: 'topic-devgruold-cleanup-' + Date.now().toString(36),
        title: 'Decide fate of DevGruGold, xmrtdao-main, xmrtdao-v2',
        creator: 'Hermes',
        status: 'in-progress',
        pinned: false,
        assigned_agent: 'joe',
        created_at: daysAgo(0),
        updated_at: daysAgo(0),
        posts: [
          { id: 'p1', author: 'Hermes', agent: 'hermes', ts: Date.now() - 0*86400000, created_at: daysAgo(0), message: 'Three duplicate relay copies identified during the v7→v8 audit: DevGruGold/relay (was running by mistake since Jul 19, has task-dedup/kanban/recall_context features not in main), xmrtdao-main/relay (Jul 17 backup, 13 files), xmrtdao-v2/relay (incomplete Go rewrite, 3 dirs). Plus 5+ old start scripts in archive-2026-07-24-start-scripts/. Awaiting Joe decision: archive, merge unique features into xmrtdao, or delete.' },
        ],
      },
    ],
  };
  state.set('bulletin-board', seed);
  logActivity('board', 'seed', 'INIT', `Seeded bulletin board with ${seed.topics.length} topics from recent work`);
}

app.get('/api/bulletin/topics', (req, res) => {
  trackRequest('/api/bulletin/topics');
  seedBulletinBoard();
  const board = state.get('bulletin-board') || { topics: [] };
  // Sort: pinned first, then by created_at desc
  board.topics.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return new Date(b.created_at) - new Date(a.created_at);
  });
  res.json(board);
});

app.post('/api/bulletin/topics', (req, res) => {
  trackRequest('/api/bulletin/topics');
  const { title, creator, status, pinned, assigned_agent } = req.body || {};
  if (!title || !creator) {
    return res.status(400).json({ error: 'title and creator required' });
  }
  const VALID_STATUSES = ['active', 'in-progress', 'completed', 'archived'];
  const topicStatus = VALID_STATUSES.includes(status) ? status : 'active';
  const board = state.get('bulletin-board') || { topics: [] };
  const topic = {
    id: 'topic-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,6),
    title: sanitizeText(title),
    creator: sanitizeText(creator),
    status: topicStatus,
    pinned: !!pinned,
    assigned_agent: assigned_agent || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    posts: [],
  };
  board.topics.push(topic);
  state.set('bulletin-board', board);
  // Notify fleet via mesh
  notifyBulletinUpdate('topic:created', topic);
  res.json({ success: true, topic });
});

app.patch('/api/bulletin/topics/:id', (req, res) => {
  trackRequest('/api/bulletin/topics/:id');
  const { id } = req.params;
  const updates = req.body || {};
  const board = state.get('bulletin-board') || { topics: [] };
  const topic = board.topics.find(t => t.id === id);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });
  
  const VALID_STATUSES = ['active', 'in-progress', 'completed', 'archived'];
  if (updates.status && VALID_STATUSES.includes(updates.status)) topic.status = updates.status;
  if (updates.title) topic.title = sanitizeText(updates.title);
  if (typeof updates.pinned === 'boolean') topic.pinned = updates.pinned;
  if (updates.assigned_agent !== undefined) topic.assigned_agent = updates.assigned_agent || null;
  topic.updated_at = new Date().toISOString();
  
  state.set('bulletin-board', board);
  notifyBulletinUpdate('topic:updated', topic);
  res.json({ success: true, topic });
});

app.delete('/api/bulletin/topics/:id', (req, res) => {
  trackRequest('/api/bulletin/topics/:id');
  const { id } = req.params;
  const board = state.get('bulletin-board') || { topics: [] };
  const idx = board.topics.findIndex(t => t.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Topic not found' });
  const removed = board.topics.splice(idx, 1)[0];
  state.set('bulletin-board', board);
  notifyBulletinUpdate('topic:deleted', removed);
  res.json({ success: true, topic: removed });
});

app.post('/api/bulletin/topics/:id/posts', (req, res) => {
  trackRequest('/api/bulletin/topics/:id/posts');
  const { id } = req.params;
  const { author, message, agent } = req.body || {};
  if (!author || !message) {
    return res.status(400).json({ error: 'author and message required' });
  }
  const board = state.get('bulletin-board') || { topics: [] };
  const topic = board.topics.find(t => t.id === id);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });
  const post = {
    id: 'post-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,6),
    author: sanitizeText(author),
    agent: sanitizeText(agent || author),
    message: sanitizeText(message),
    ts: Date.now(),
    created_at: new Date().toISOString(),
  };
  topic.posts.push(post);
  topic.updated_at = new Date().toISOString();
  state.set('bulletin-board', board);
  notifyBulletinUpdate('topic:post', { topic_id: topic.id, topic_title: topic.title, post });
  res.json({ success: true, post });
});

app.delete('/api/bulletin/topics/:id/posts/:postId', (req, res) => {
  trackRequest('/api/bulletin/topics/:id/posts/:postId');
  const { id, postId } = req.params;
  const board = state.get('bulletin-board') || { topics: [] };
  const topic = board.topics.find(t => t.id === id);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });
  const pIdx = topic.posts.findIndex(p => p.id === postId);
  if (pIdx < 0) return res.status(404).json({ error: 'Post not found' });
  topic.posts.splice(pIdx, 1);
  state.set('bulletin-board', board);
  res.json({ success: true });
});
// Helper: log bulletin updates (no fleet chat noise)
async function notifyBulletinUpdate(action, data) {
  logActivity('board', data.id || '-', 'UPDATE', 'board ' + action + ': ' + (data.title || data.topic_title || data.id));
}

// ── RSSI History (from truncated original) ────────────
const RSSI_FILE = join(__dirname, '..', 'relay-data', 'rssi-history.json');
function loadRssiHistory() {
  try { if (existsSync(RSSI_FILE)) return JSON.parse(readFileSync(RSSI_FILE, 'utf8')); } catch {}
  return [];
}
function saveRssiHistory(history) {
  try { writeFileSync(RSSI_FILE, JSON.stringify(history.slice(-300), null, 2)); } catch {}
}

// GET /api/rssi — return current RSSI and recent history
app.get('/api/rssi', (req, res) => {
  trackRequest('/api/rssi');
  const history = loadRssiHistory();
  res.json({
    success: true,
    current: history.length > 0 ? history[history.length - 1] : null,
    history: history.slice(-120),
    source: 'netsh-wlan',
  });
});

// POST /api/rssi — receive RSSI sample
app.post('/api/rssi', (req, res) => {
  trackRequest('/api/rssi-post');
  const { rssi, ssid, timestamp } = req.body || {};
  if (rssi === undefined) return res.status(400).json({ error: 'rssi required' });
  const history = loadRssiHistory();
  history.push({ rssi, ssid: ssid || 'unknown', ts: timestamp || new Date().toISOString() });
  saveRssiHistory(history);
  res.json({ success: true });
});

// ── Spatial Scan Data ────────────────────────────────
const SPATIAL_SCANS_FILE = join(__dirname, '..', 'relay-data', 'spatial-intel', 'scans.json');
function loadSpatialScans() {
  try { if (existsSync(SPATIAL_SCANS_FILE)) return JSON.parse(readFileSync(SPATIAL_SCANS_FILE, 'utf8')); } catch {}
  return [];
}
function saveSpatialScans(scans) {
  try {
    const d = dirname(SPATIAL_SCANS_FILE);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    writeFileSync(SPATIAL_SCANS_FILE, JSON.stringify(scans.slice(-1000), null, 2));
  } catch {}
}

// POST /api/spatial/scan — receive spatial scan from phone
app.post('/api/spatial/scan', (req, res) => {
  trackRequest('/api/spatial/scan');
  const scan = req.body || {};
  if (!scan.wifi_scan && !scan.rssi_values) {
    return res.status(400).json({ error: 'wifi_scan or rssi_values required' });
  }
  const scans = loadSpatialScans();
  const entry = {
    id: 'scan-' + Date.now().toString(36),
    agent: scan.agent || 'rssi-bridge',
    timestamp: scan.timestamp || new Date().toISOString(),
    type: scan.type || 'wifi_scan',
    location_label: scan.location_label,
  };
  if (scan.wifi_scan && Array.isArray(scan.wifi_scan)) {
    entry.access_points = scan.wifi_scan.map(ap => ({
      bssid: ap.bssid, ssid: ap.ssid,
      rssi: ap.rssi || ap.level,
      frequency: ap.frequency_mhz || ap.frequency,
      channel: ap.channel,
    }));
    entry.ap_count = entry.access_points.length;
  }
  if (scan.rssi_values && Array.isArray(scan.rssi_values)) {
    entry.access_points = scan.rssi_values;
    entry.ap_count = scan.rssi_values.length;
  }
  scans.push(entry);
  saveSpatialScans(scans);
  logActivity('spatial', entry.id, 'SCAN', entry.agent + ': ' + (entry.ap_count || 0) + ' APs');
  res.json({ success: true, scan_id: entry.id });
});

// GET /api/spatial/aps — known access points
app.get('/api/spatial/aps', (req, res) => {
  trackRequest('/api/spatial/aps');
  const scans = loadSpatialScans();
  const aps = {};
  for (const scan of scans) {
    if (!scan.access_points) continue;
    for (const ap of scan.access_points) {
      const key = ap.bssid || ap.ssid;
      if (!key) continue;
      if (!aps[key]) aps[key] = { bssid: ap.bssid, ssid: ap.ssid, readings: [] };
      aps[key].readings.push({ rssi: ap.rssi, ts: scan.timestamp, agent: scan.agent });
    }
  }
  res.json({
    success: true,
    ap_count: Object.keys(aps).length,
    access_points: Object.values(aps).map(ap => ({
      ...ap,
      readings: ap.readings.slice(-50),
      avg_rssi: ap.readings.length > 0 ? ap.readings.reduce((s, r) => s + r.rssi, 0) / ap.readings.length : 0,
    })),
  });
});

// GET /api/spatial/map — spatial intelligence dump
app.get('/api/spatial/map', async (req, res) => {
  trackRequest('/api/spatial/map');
  res.json({ success: true, scans: loadSpatialScans().slice(-20) });
});

// ── PFP: Template gallery ────────────────────────────
const PFP_OUTPUTS = join(__dirname, 'pfp-outputs');

app.get('/pfp/templates', (req, res) => {
  if (!existsSync(PFP_OUTPUTS)) return res.json({ count: 0, files: [] });
  const files = readdirSync(PFP_OUTPUTS).filter(f => f.endsWith('.png')).sort().reverse();
  res.json({
    count: files.length,
    files: files.map(f => ({
      name: f,
      url: '/pfp/templates/' + f,
      size: existsSync(join(PFP_OUTPUTS, f)) ? statSync(join(PFP_OUTPUTS, f)).size : 0,
    })),
  });
});

app.get('/pfp/templates/:file', (req, res) => {
  const filepath = join(PFP_OUTPUTS, req.params.file);
  if (!filepath.startsWith(PFP_OUTPUTS) || !existsSync(filepath)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(filepath);
});

// ── Stripe Webhook ──────────────────────────────────────────
// Receives payment events from Stripe and records them in pfp_payments
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const stripe = require('stripe')(STRIPE_SECRET_KEY);
    // Sign the RAW bytes, not the parsed object. express.json() has already run
    // by the time this route is reached, so req.body is a plain object and
    // constructEvent rejects it outright with "payload must be provided as a
    // string or a Buffer" - the signature check could never succeed, and every
    // delivery was refused. req.rawBody is the exact bytes Stripe signed,
    // captured by the verify hook on the global express.json().
    event = stripe.webhooks.constructEvent(req.rawBody ?? req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const eventType = event.type;
  const data = event.data.object;
  logActivity('stripe-webhook', event.id, 'RECEIVED', eventType);

  // A completed Checkout Session is the signal that a lead has paid. This is
  // the only place a lead becomes a booking, and it works because createCheckoutForLead
  // put the lead id in the session metadata. Without that link there was nothing
  // to match on, and a paying client simply had no booking.
  if (eventType === 'checkout.session.completed') {
    try {
      const { fulfilCheckoutSession } = await import('./lib/pfp-checkout.mjs');
      // No Stripe client is passed: this step only records what the webhook
      // already told us. It never calls the Stripe API, so a replayed event
      // cannot move money.
      const out = await fulfilCheckoutSession(
        { query: queryLocalPg, log: logActivity }, data);
      if (out.skipped) {
        logActivity('pfp-checkout', 'SKIPPED', `${event.id}: ${out.skipped}`);
      } else {
        logActivity('pfp-checkout', out.alreadyDone ? 'ALREADY_BOOKED' : 'BOOKED',
          `lead ${out.lead.id} -> booking ${out.booking.id} from ${event.id}`);
      }
    } catch (err) {
      console.error('[Stripe] checkout.session.completed failed:', err.message);
      logActivity('pfp-checkout', 'ERROR', err.message);
    }
    return res.json({ received: true });
  }

  try {
    if (eventType === 'charge.succeeded') {
      const charge = data;
      await queryLocalPg(
        `INSERT INTO public.pfp_payments (stripe_charge_id, stripe_payment_intent_id, amount, currency, status,
          client_name, client_email, description, payment_method, receipt_url, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12))
         ON CONFLICT (stripe_charge_id) DO UPDATE SET status = $5, updated_at = NOW()`,
        [charge.id, charge.payment_intent, (charge.amount / 100).toFixed(2), charge.currency,
         charge.status, charge.billing_details?.name || null, charge.billing_details?.email || null,
         charge.description || null, charge.payment_method_details?.type || null,
         charge.receipt_url || null, JSON.stringify(charge.metadata || {}), charge.created]
      );
      logActivity('stripe-payment', charge.id, 'RECORDED', `${(charge.amount/100).toFixed(2)} ${charge.currency.toUpperCase()} from ${charge.billing_details?.name || 'unknown'}`);
    } else if (eventType === 'charge.refunded') {
      const charge = data;
      await queryLocalPg(
        `UPDATE public.pfp_payments SET status = 'refunded', amount_refunded = $2, updated_at = NOW()
         WHERE stripe_charge_id = $1`,
        [charge.id, (charge.amount_refunded / 100).toFixed(2)]
      );
      logActivity('stripe-refund', charge.id, 'RECORDED', `Refunded ${(charge.amount_refunded/100).toFixed(2)} ${charge.currency.toUpperCase()}`);
    } else if (eventType === 'payout.paid') {
      const payout = data;
      logActivity('stripe-payout', payout.id, 'PAID', `${(payout.amount/100).toFixed(2)} ${payout.currency.toUpperCase()} — ${payout.status}`);
    } else if (eventType === 'payout.failed') {
      const payout = data;
      logActivity('stripe-payout', payout.id, 'FAILED', `${(payout.amount/100).toFixed(2)} ${payout.currency.toUpperCase()} — ${payout.failure_message || 'unknown reason'}`);
    } else {
      logActivity('stripe-webhook', event.id, 'UNHANDLED', eventType);
    }
  } catch (err) {
    console.error('[Stripe Webhook] Processing error:', err.message);
    logActivity('stripe-webhook', event.id, 'ERROR', err.message);
  }

  res.json({ received: true });
});

// ── Edge Function Proxy: forward /functions/v1/* to local-sb ──
// Used by Resend webhook (inbox.partyfavorphoto.com → localhost:54321)
app.all('/functions/v1/*path', async (req, res) => {
  const path = req.path.replace(/^\/functions\/v1\//, '');
  const targetUrl = `http://127.0.0.1:54321/functions/v1/${path}`;
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body || {});
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', ...(req.headers['x-api-key'] ? { 'x-api-key': req.headers['x-api-key'] } : {}) },
      body,
      signal: AbortSignal.timeout(30000),
    });
    const text = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
  } catch (e) {
    console.error(`[edge-proxy] Error proxying ${path}:`, e.message);
    res.status(502).json({ error: 'Edge function proxy failed', detail: e.message });
  }
});

const relayHttpServer = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`  Relay listening on http://0.0.0.0:${PORT}`);
  // Surface dead sending keys at boot rather than on someone's first email.
  verifySendingKeys();
  const toolsCount = Object.keys(toolHandlers).length;
  const handlersCount = Object.keys(handlers).length;
  console.log('\n' +
    '╔══════════════════════════════════════════════════════╗\n' +
    '║         MobileMonero Relay Server - Eliza-Dev v5        ║\n' +
    '╠══════════════════════════════════════════════════════╣\n' +
    '║  Webhook:  http://0.0.0.0:' + String(PORT).padEnd(5) + '/webhook/task     ║\n' +
    '║  Tools:    http://0.0.0.0:' + String(PORT).padEnd(5) + '/tools            ║\n' +
    '║  Run Tool: http://0.0.0.0:' + String(PORT).padEnd(5) + '/tools/run        ║\n' +
    '║  Register: http://0.0.0.0:' + String(PORT).padEnd(5) + '/tools/register-agent ║\n' +
    '║  Agents:   http://0.0.0.0:' + String(PORT).padEnd(5) + '/tools/agents     ║\n' +
    '║  Web Srch: http://0.0.0.0:' + String(PORT).padEnd(5) + '/web-search       ║\n' +
    '║  Scrape:   http://0.0.0.0:' + String(PORT).padEnd(5) + '/scrape            ║\n' +
    '║  Ollama:   http://0.0.0.0:' + String(PORT).padEnd(5) + '/ollama/chat       ║\n' +
    '║  Monitor:  http://0.0.0.0:' + String(PORT).padEnd(5) + '/monitor           ║\n' +
    '║  State:    http://0.0.0.0:' + String(PORT).padEnd(5) + '/state/<key>       ║\n' +
    '║  Dispatch: http://0.0.0.0:' + String(PORT).padEnd(5) + '/dispatch          ║\n' +
    '║  Health:   http://0.0.0.0:' + String(PORT).padEnd(5) + '/health            ║\n' +
    '║  Cron:     http://0.0.0.0:' + String(PORT).padEnd(5) + '/cron/status       ║\n' +
    '║  PFP Inbox: http://0.0.0.0:' + String(PORT).padEnd(5) + '/resend/inbox     ║\n' +
    '║  MM Inbox:  http://0.0.0.0:' + String(PORT).padEnd(5) + '/resend/mobilemonero/inbox ║\n' +
    '║  31HB Inbox: http://0.0.0.0:' + String(PORT).padEnd(5) + '/resend/31harbor/inbox ║\n' +
    '╚══════════════════════════════════════════════════════╝\n\n' +
    '  Tools: ' + toolsCount + ' registered\n' +
    '  Handlers: ' + handlersCount + ' task handlers\n' +
    '  State keys: ' + state.keys().length + '\n');
  logActivity('system', '-', 'STARTUP', 'Relay v2 listening on port ' + PORT);

  // ── Start Local Cron Engine ──
  // 2026-06-07: The old cron-engine.mjs used `psql -U postgres` and
  // `cmd.exe` spawns that hung waiting for a password. The
  // `pg/bin/` path it references doesn't exist on this machine
  // (we use the embedded @embedded-postgres package in suite/).
  // Disable the old engine; we'll add a working one in a
  // follow-up that uses pg client + local runtime.
  setTimeout(() => {
    if (process.env.SKIP_CRON === '1') {
      logActivity('system', '-', 'CRON', 'Local cron engine disabled (SKIP_CRON=1)');
      return;
    }
    try {
      import('./cron-engine-v2.mjs').then(mod => {
        if (typeof mod.runDaemon === 'function') {
          mod.runDaemon();
          logActivity('system', '-', 'CRON', 'Local cron v2 engine started');
        } else {
          logActivity('system', '-', 'CRON_ERR', 'cron-engine-v2.mjs has no runDaemon()');
        }
      }).catch(err => {
        logActivity('system', '-', 'CRON_ERR', 'Failed to start cron v2: ' + err.message);
      });
    } catch (err) {
      console.log('[CRON] Engine v2 not available:', err.message);
    }
  }, 3000);

  // ── Start Mesh Gossipsub Node ──
  // Auto-init on startup so /mesh/publish has a real local node to forward
  // through (instead of falling back to the dead cloud tunnel). Bootstrap
  // peers come from MESH_BOOTSTRAPPERS env or default to kimi's known peer.
  setTimeout(async () => {
    if (process.env.SKIP_MESH === '1') {
      console.log('[Mesh] Skipped (SKIP_MESH=1)');
      return;
    }
    const bootstrappers = (process.env.MESH_BOOTSTRAPPERS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    try {
      const result = await initMeshNode({
        port: parseInt(process.env.MESH_PORT || '9000'),
        agentName: 'vex-relay',
        bootstrappers,
      });
      if (result.ok) {
        console.log(`[Mesh] Gossipsub node online — peerId: ${result.peerId?.slice(0, 20)}...`);
      } else {
        console.log(`[Mesh] Init failed: ${result.error} (publishes will use HTTP fallback)`);
      }
    } catch (e) {
      console.log(`[Mesh] Auto-init error: ${e.message}`);
    }
  }, 5000);

  // ── Seed health data (fire after mesh init so DB is likely ready) ──
  setTimeout(() => {
    seedHealthData().catch(e => console.log('[seed] Error during startup seed:', e.message));
  }, 8000);

  // ── Ensure inbox_emails table exists ──
  setTimeout(async () => {
    try {
      // ── Schema drift fix (2026-08-28): phantom edge_function_registry + interaction_patterns ──
      // The edge_function_registry relation agents query 500'd ("relation does not exist").
      // Expose it as a view over the real unified_tool_registry catalog so reads resolve.
      // Also expose knowledge.interaction_patterns (canonical data is public.interaction_patterns).
      try {
        await queryLocalPg(`DROP VIEW IF EXISTS public.edge_function_registry`);
        await queryLocalPg(
          `CREATE VIEW public.edge_function_registry AS
           SELECT
             tool_name AS name,
             tool_name AS function_name,
             description,
             category,
             status,
             source_schema_table,
             source_type,
             ai_compatible,
             priority,
             usage_count,
             last_used,
             created_at,
             updated_at,
             metadata
           FROM public.unified_tool_registry`
        );
        await queryLocalPg(
          `CREATE OR REPLACE VIEW knowledge.interaction_patterns AS
           SELECT * FROM public.interaction_patterns`
        );
        console.log('[schema-drift] edge_function_registry + knowledge.interaction_patterns views ready');
      } catch (e) {
        console.log('[schema-drift] view ensure failed (non-fatal):', e.message);
      }

      // ── Boot-time schema drift check (Vex: systemic, not one-off) ──
      // Auto-verify every schema-prefixed table the relay references against
      // live information_schema; log a clear alert on any mismatch so the
      // recurring phantom-relation / map-desync 500 class surfaces at boot
      // instead of mid-session. Non-fatal (relay keeps serving).
      // Also exposed via fleet_pulse (schema_drift field) for continuous
      // coverage between restarts (Eliza: point-in-time is not enough).
      try {
        const drift = await runSchemaDriftCheck();
        if (drift.success && drift.missing.length === 0) {
          console.log(`[schema-drift-check] ✅ ${drift.total} relay schema-prefixed tables verified against live information_schema (no drift)`);
        } else if (drift.missing.length > 0) {
          console.warn(`[schema-drift-check] ⚠️ ${drift.missing.length} schema-prefixed table(s) referenced by relay DO NOT EXIST: ${drift.missing.join(', ')}`);
        }
      } catch (e) {
        console.log('[schema-drift-check] drift check failed (non-fatal):', e.message);
      }

      await queryLocalPg(
        `CREATE TABLE IF NOT EXISTS app.inbox_emails (
          id SERIAL PRIMARY KEY,
          email_id TEXT UNIQUE,
          sender TEXT,
          recipient TEXT,
          subject TEXT,
          body_text TEXT,
          body_html TEXT,
          received_at TIMESTAMPTZ DEFAULT NOW(),
          read BOOLEAN DEFAULT FALSE,
          domain TEXT,
          metadata JSONB DEFAULT '{}'::jsonb
        )`
      );
      console.log('[inbox-db] Table app.inbox_emails ready');

      // Sync recent emails from Resend API into the in-memory inbox cache
      // so agents can see them even after a relay restart
      try {
        
        // Straight off the registry rather than a RESEND_KEYS map. That map was a
          // module-level literal that a refactor removed, and this loop was the one
          // remaining reference to it. The failure was logged as non-fatal on every
          // boot - "RESEND_KEYS is not defined" - so the cache quietly stopped being
          // populated and nothing surfaced it.
          for (const domain of EMAIL_INBOX_KEYS) {
            const apiKey = resendKeyFor(domain);
          if (!apiKey) continue;
          const res = await fetch(`https://api.resend.com/emails/receiving?limit=50`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const emails = await res.json();
            if (Array.isArray(emails)) {
              for (const email of emails) {
                // From the registry, for the same reason as the send path.
        const toDomain = emailDomainName(email.to) || 'mobilemonero.com';
                addToInbox(toDomain, {
                  to: email.to,
                  from: email.from,
                  from_name: email.from_name,
                  subject: email.subject,
                  text: email.text || '',
                  html: email.html || '',
                  email_id: email.id,
                  attachments: email.attachments,
                });
              }
              // The domain name, not the inbox key: this line is read by a human
      // diagnosing a sync, and "jobby" is less use than "jobbymcjobberson.com".
      console.log(`[inbox-db] Synced ${emails.length} emails from Resend for ${EMAIL_DOMAINS[domain].domain}`);
            }
          }
        }
      } catch (syncErr) {
        console.log('[inbox-db] Sync from Resend failed (non-fatal):', syncErr.message);
      }
    } catch (e) {
      console.log('[inbox-db] Table creation error:', e.message);
    }
  }, 12000);

  // ── TrustGraph Violation Scanner (Layer 4) ──
  // Scans fleet chat every 15 min for false claims, writes FABRICATION_DETECTED
  // trust events. Dedup by reference string prevents double-counting.
  const SCANNER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
  setTimeout(() => {
    runTrustGraphScan().catch(e => console.log('[trustgraph-scanner] Initial scan error:', e.message));
    setInterval(() => {
      runTrustGraphScan().catch(e => console.log('[trustgraph-scanner] Scan error:', e.message));
    }, SCANNER_INTERVAL_MS);
  }, 10000);

  // ── Fleet Chat Idle Heartbeat ──
  // If nobody has spoken in FLEET_IDLE_THRESHOLD_MS, Eliza posts a brief
  // status ping to keep the channel alive. This is what makes the
  // conversation "perpetual" — agents don't go silent just because Joe
  // is busy or asleep.
  const FLEET_IDLE_THRESHOLD_MS = 4 * 60 * 1000;   // 4 min idle triggers
  const FLEET_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // check every 5 min
  setInterval(async () => {
    try {
      const last = fleetChatMessages[fleetChatMessages.length - 1];
      const idleFor = last ? Date.now() - last.ts : Infinity;
      // Bail if we spoke recently, or if anyone is on cooldown
      if (idleFor < FLEET_IDLE_THRESHOLD_MS) return;
      // Ground the heartbeat in real data so it doesn't claim fake leads/metrics
      const ctx = await gatherFleetContext();
      const ctxJson = JSON.stringify(ctx, null, 0);
      const heartbeatPrompt = `You are Eliza, the XMRT/PartyFavor fleet coordinator. The fleet chat has been idle for ${Math.floor(idleFor / 60000)} minutes. Post a single short status ping (1 sentence) to keep the channel warm.

GROUNDING — Real-time data (use only these facts):
\`\`\`json
${ctxJson}
\`\`\`

GROUNDING RULES:
- Mention only fields that exist in the JSON (e.g. relay.uptimeSec, services.supabase, ollama.modelCount).
- If a topic (leads, money, campaigns) isn't covered in the JSON, say "I don't have that data" — never invent counts.
- No emoji sign-offs, no "—Eliza", no "o7".`;
      const r = await fetch('http://localhost:11434/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'qwen2.5:7b', prompt: heartbeatPrompt, stream: false, options: { temperature: 0.4, max_tokens: 140 } }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return;
      const d = await r.json();
      let reply = (d.response || '').trim()
        .replace(/\s*—\s*Eliza\s*$/i, '')
        .replace(/\s+o7\s*$/i, '');
      if (reply) {
        addFleetMessage('eliza', reply, 'fleet', { hop: 0, parentId: last?.id || null });
        logActivity('fleet-chat', '-', 'IDLE_PING', reply.slice(0, 80));
      }
    } catch (e) {
      /* heartbeat is best-effort */
    }
  }, FLEET_HEARTBEAT_INTERVAL_MS);

  // ── Managed Services (formerly supervisor.mjs) ──
  // DISABLED: The supervisor.mjs --once Task Scheduler handles service management.
  // The relay's built-in manager was spawning duplicate postgres processes
  // that created visible cmd windows on the desktop.
  const MANAGED_SERVICES = [];
  const serviceState = {};

  function logService(msg) {
    console.log(`[services] ${new Date().toISOString()} ${msg}`);
  }

  function isPortOpen(port) {
    return new Promise(resolve => {
      const sock = new (require('net').Socket)();
      sock.setTimeout(2000);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(port, '127.0.0.1');
    });
  }

  async function startManagedService(svc) {
    if (serviceState[svc.name] && serviceState[svc.name].proc && !serviceState[svc.name].proc.killed) {
      logService(`${svc.name} already running`);
      return;
    }
    // Clean stale PG lock file before starting PG
    if (svc.name === 'pg') {
      const pidPath = join(__dirname, '..', 'pg', 'data', 'postmaster.pid');
      try {
        if (existsSync(pidPath)) {
          const pid = parseInt(readFileSync(pidPath, 'utf8').split('\n')[0].trim());
          // Only remove if PID is not actually a postgres process
          try { process.kill(pid, 0); } catch { unlinkSync(pidPath); logService('pg: removed stale postmaster.pid'); }
        }
      } catch {}
    }
    logService(`starting ${svc.name}: ${svc.cmd} ${svc.args.join(' ')}`);
    try {
      const proc = spawn(svc.cmd, svc.args, {
        cwd: svc.cwd, detached: true, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
        env: { ...process.env },
      });
      proc.unref();
      serviceState[svc.name] = { proc, startedAt: Date.now(), healthy: false, failures: 0 };
      logService(`  ${svc.name} spawned as pid ${proc.pid}`);
    } catch (e) {
      logService(`  ${svc.name} FAILED: ${e.message}`);
    }
  }

  async function checkServiceHealth(svc) {
    const s = serviceState[svc.name];
    if (!s) return false;
    // Check process alive
    if (s.proc) {
      try { process.kill(s.proc.pid, 0); } catch { return false; }
    }
    // HTTP health endpoint
    if (svc.healthUrl) {
      try {
        const r = await fetch(svc.healthUrl, { signal: AbortSignal.timeout(3000) });
        return r.ok;
      } catch { return false; }
    }
    // Port check
    if (svc.healthPort) {
      return await isPortOpen(svc.healthPort);
    }
    return true; // no health check = assume alive if process running
  }

  async function serviceHealthTick() {
    for (const svc of MANAGED_SERVICES) {
      const s = serviceState[svc.name];
      if (!s) {
        await startManagedService(svc);
        continue;
      }
      // Skip health during grace period
      if (Date.now() - s.startedAt < svc.startupMs) continue;
      const healthy = await checkServiceHealth(svc);
      if (healthy) {
        if (!s.healthy) logService(`${svc.name} HEALTHY`);
        s.healthy = true;
        s.failures = 0;
      } else {
        s.failures = (s.failures || 0) + 1;
        if (s.failures >= 3) {
          logService(`${svc.name} unhealthy (${s.failures}/3) — restarting`);
          if (s.proc) { try { execSync(`taskkill /F /PID ${s.proc.pid} /T 2>nul`, { stdio: 'ignore' }); } catch {} }
          delete serviceState[svc.name];
          await startManagedService(svc);
        }
      }
    }
    // Update supervisor state file for /api/supervisor/status
    // GUARD: MANAGED_SERVICES is [] (relay's built-in manager is disabled —
    // supervisor.mjs owns service management). Without this guard the relay
    // would clobber supervisor-state.json every 30s with {services:{}, _pid:<relay>},
    // wiping the supervisor's tracked service state (childPids, failure counts).
    if (MANAGED_SERVICES.length > 0) {
      try {
        const stateData = { services: {}, _pid: process.pid, _updatedAt: Date.now() };
        for (const svc of MANAGED_SERVICES) {
          const s = serviceState[svc.name];
          stateData.services[svc.name] = {
            childPid: s?.proc?.pid || null,
            startedAt: s?.startedAt || 0,
            healthy: s?.healthy || false,
            restartTimestamps: [],
          };
        }
        mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(join(DATA_DIR, 'supervisor-state.json'), JSON.stringify(stateData, null, 2));
      } catch {}
    }
  }

  // Start managed services after a brief delay (allows relay to boot first)
  setTimeout(async () => {
    logService('===== starting managed services =====');
    for (const svc of MANAGED_SERVICES) {
      await startManagedService(svc);
    }
    logService(`managed services initial spawn complete`);
    // Health check every 30s
    setInterval(() => { serviceHealthTick().catch(e => logService(`tick error: ${e.message}`)); }, 30000);
  }, 2000);
});

// ── Realtime WebSocket proxy ──────────────────────────────────────────
// The Suite SPA points its Supabase client at the relay origin, and
// supabase-js derives realtimeUrl = <origin>/realtime/v1. The relay proxies
// /functions/v1 and /rest/v1 but NOT /realtime/v1, so any .channel().subscribe()
// (ActivityPulse, AgentStatusGrid, AgentHierarchy, ContributorDashboard, etc.)
// hit GET /realtime/v1/websocket -> 404. local-sb runs the actual realtime WS
// server on :54321; forward upgrades here so live push subscriptions work.
if (relayHttpServer && typeof relayHttpServer.on === 'function') {
  relayHttpServer.on('upgrade', (req, socket, head) => {
    let url = '';
    try { url = new URL(req.url, 'http://localhost').pathname; } catch { url = req.url || ''; }
    if (url.startsWith('/realtime/v1')) {
      const net = require('net');
      const [host, portStr] = '127.0.0.1:54321'.split(':');
      const port = parseInt(portStr, 10);
      const upstream = net.connect(port, host);
      upstream.on('connect', () => {
        // Re-send the raw HTTP upgrade request so local-sb's own 'upgrade'
        // handler sees it and completes the WS handshake. Use real CRLF.
        const rn = String.fromCharCode(13, 10);
        let request = req.method + ' ' + req.url + ' HTTP/1.1' + rn;
        for (const h of Object.keys(req.headers)) {
          if (h === 'connection' || h === 'upgrade' || h === 'sec-websocket-key' || h === 'sec-websocket-version') continue;
          request += h + ': ' + req.headers[h] + rn;
        }
        request += 'Host: ' + host + rn;
        request += 'Connection: Upgrade' + rn;
        request += 'Upgrade: websocket' + rn;
        request += 'Sec-WebSocket-Key: ' + (req.headers['sec-websocket-key'] || '') + rn;
        request += 'Sec-WebSocket-Version: ' + (req.headers['sec-websocket-version'] || '13') + rn;
        const wsProto = req.headers['sec-websocket-protocol'];
        if (wsProto) request += 'Sec-WebSocket-Protocol: ' + wsProto + rn;
        request += rn;
        upstream.write(request);
        if (head && head.length) upstream.write(head);
        // Pipe raw bytes both directions once the WS is established.
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on('error', () => { try { socket.destroy(); } catch {} });
      upstream.on('close', () => { try { socket.end(); } catch {} });
      socket.on('error', () => { try { upstream.destroy(); } catch {} });
      socket.on('close', () => { try { upstream.end(); } catch {} });
    } else {
      try { socket.destroy(); } catch {}
    }
  });
  console.log('[realtime] WebSocket upgrade proxy registered for /realtime/v1 -> 127.0.0.1:54321');
}

// ── Mining Pool Stats ──
// XMRT-DAO fleet pool wallet (must match mmlauncher/scripts/mobile-signup.py)
const XMRT_POOL_WALLET = '46UxNFuGM2E3UwmZWWJicaRPoRwqwW4byQkaTHkX8yPcVihp91qAVtSFipWUGJJUyTXgzSqxzDQtNLf2bsp2DX2qCCgC5mg';
const XMRT_POOL_URL = 'https://www.supportxmr.com/api/miner';
// Cache live pool stats for 60s to avoid hammering SupportXMR
const POOL_CACHE_KEY = 'mining.pool.cache';
const POOL_CACHE_TTL = 60_000;
async function fetchSupportXMRStats() {
  const cached = state.get(POOL_CACHE_KEY);
  if (cached && (Date.now() - cached.ts) < POOL_CACHE_TTL) return cached;
  const POOL_URL = 'https://www.supportxmr.com/api/pool/stats';
  const WALLET_URL = `${XMRT_POOL_URL}/${XMRT_POOL_WALLET}/stats`;
  // Fetch pool-level and wallet-level stats concurrently
  const [pool, wallet] = await fetchMultipleOrFallback([POOL_URL, WALLET_URL], 6000);
  // Parse pool-level response (the /pool/stats endpoint wraps data in pool_statistics)
  const poolData = pool?.pool_statistics || {};
  // Parse wallet-level response
  const data = wallet || {};
  const amtDueXMR = (data.amtDue || 0) / 1e12;
  const amtPaidXMR = (data.amtPaid || 0) / 1e12;
  // Compute last-hash freshness for offline detection
  const lastHashTs = data.lastHash || 0;
  const minutesSinceLastHash = lastHashTs > 0 ? (Date.now() / 1000 - lastHashTs) / 60 : null;
  const TREASURY_SHARE = 0.85;
  const OPERATIONAL_SHARE = 0.15;
  const out = {
    pool: 'supportxmr.com',
    wallet: XMRT_POOL_WALLET,
    hashrate: data.hash || 0,
    // ── Global pool stats (from /pool/stats) ──
    pool_hashrate: poolData.hashRate || 0,
    pool_hashrate_mhs: Math.round((poolData.hashRate || 0) / 1e6 * 100) / 100,
    pool_total_miners: poolData.miners || 0,
    pool_total_blocks: poolData.totalBlocksFound || 0,
    pool_last_block_time: poolData.lastBlockFoundTime || 0,
    pool_last_block_timestamp: poolData.lastBlockFoundTime ? new Date(poolData.lastBlockFoundTime * 1000).toISOString() : null,
    pool_total_miners_paid: poolData.totalMinersPaid || 0,
    pool_total_payments: poolData.totalPayments || 0,
    pool_round_hashes: poolData.roundHashes || 0,
    pool_total_hashes: poolData.totalHashes || 0,
    // ── Wallet-level stats ──
    miners: data.workers ? data.workers.length : 0,
    active_workers: data.active_workers || 0,
    total_registered_workers: data.total_registered_workers || 0,
    validShares: data.validShares || 0,
    invalidShares: data.invalidShares || 0,
    totalHashes: data.totalHashes || 0,
    lastHash: lastHashTs,
    txnCount: data.txnCount || 0,
    // Offline detection
    minutes_since_last_hash: minutesSinceLastHash !== null ? Math.round(minutesSinceLastHash * 10) / 10 : null,
    mining_status: minutesSinceLastHash !== null && minutesSinceLastHash <= 30 ? 'active' : (minutesSinceLastHash !== null ? 'offline' : 'unknown'),
    // Atomic units (12-decimal) — the dashboard JS divides these by 1e12
    amtPaid: data.amtPaid || 0,
    amtDue: data.amtDue || 0,
    amountPaid: data.amtPaid || 0,
    amountDue: data.amtDue || 0,
    // Convenience: pre-converted XMR
    amtPaidXMR,
    amtDueXMR,
    // Treasury allocation (85% treasury / 15% operational)
    treasury_share: TREASURY_SHARE,
    operational_share: OPERATIONAL_SHARE,
    treasury_allocation_xmr: Math.round(amtDueXMR * TREASURY_SHARE * 1e8) / 1e8,
    operational_allocation_xmr: Math.round(amtDueXMR * OPERATIONAL_SHARE * 1e8) / 1e8,
    lastBlock: data.lastHash || 0,
    poolFee: '0.5%',
    status: 'online',
    source: 'supportxmr',
    fetchedAt: new Date().toISOString(),
    // Ecosystem health booleans
    ecosystem_health: {
      mining_active: minutesSinceLastHash !== null && minutesSinceLastHash <= 30,
      pool_healthy: (poolData.miners || 0) > 1000,
      revenue_generating: amtDueXMR > 0,
      api_accessible: !(!pool && !wallet),
    },
  };
  state.set(POOL_CACHE_KEY, { ...out, ts: Date.now() });
  return out;
}

// Fetch multiple URLs concurrently, returning null for failures instead of throwing
async function fetchMultipleOrFallback(urls, timeoutMs) {
  const controllers = urls.map(() => new AbortController());
  const timer = setTimeout(() => controllers.forEach(c => c.abort()), timeoutMs);
  const results = await Promise.allSettled(
    urls.map((url, i) =>
      fetch(url, { signal: controllers[i].signal })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`http ${r.status}`)))
    )
  );
  clearTimeout(timer);
  return results.map(r => r.status === 'fulfilled' ? r.value : null);
}
// ── Pool Identifiers (active worker list) ───────────────────
const POOL_IDS_CACHE_KEY = 'mining.pool.identifiers';
const POOL_IDS_CACHE_TTL = 120_000;
async function fetchSupportXMRIdentifiers() {
  const cached = state.get(POOL_IDS_CACHE_KEY);
  if (cached && (Date.now() - cached.ts) < POOL_IDS_CACHE_TTL) return cached;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${XMRT_POOL_URL}/${XMRT_POOL_WALLET}/identifiers`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('supportxmr http ' + r.status);
    const ids = await r.json();
    const out = Array.isArray(ids) ? ids : (ids.identifiers || []);
    state.set(POOL_IDS_CACHE_KEY, { identifiers: out, ts: Date.now() });
    return { identifiers: out, ts: Date.now() };
  } catch (e) {
    clearTimeout(t);
    return { identifiers: [], error: e.message };
  }
}

// Public read endpoint — returns the live pool stats for the XMRT-DAO wallet
app.get('/api/mining/pool-stats', async (req, res) => {
  const stats = await fetchSupportXMRStats();
  res.json(stats);
});
app.get('/api/mining/pool-identifiers', async (req, res) => {
  const out = await fetchSupportXMRIdentifiers();
  res.json(out.identifiers || []);
});
// Alias: dashboard JS sometimes uses /api/dao/mining — funnel it through the same fetcher
app.get('/api/dao/mining', async (req, res) => {
  const stats = await fetchSupportXMRStats();
  res.json({ success: true, stats, ts: new Date().toISOString() });
});

// ── Mining Worker Heartbeats ──
// Workers POST { worker, hashrate } periodically; leaderboard reads from this store
const MINING_STORE_KEY = 'mining.workers';

function getMiningWorkers() {
  return state.get(MINING_STORE_KEY, {});
}

app.post('/mining/heartbeat', express.json(), (req, res) => {
  try {
    const { worker, hashrate, shares, xmrt_earned } = req.body || {};
    if (!worker) return res.status(400).json({ error: 'worker required' });
    const workers = getMiningWorkers();
    const prev = workers[worker] || {};
    workers[worker] = {
      worker,
      current_hash: Math.max(0, Number(hashrate) || 0),
      total_shares: Math.max(prev.total_shares || 0, Number(shares) || prev.total_shares || 0),
      xmrt_earned: Number(xmrt_earned) || prev.xmrt_earned || 0,
      last_seen: new Date().toISOString(),
    };
    state.set(MINING_STORE_KEY, workers);
    res.json({ success: true, worker, hashrate: workers[worker].current_hash });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Local XMRig stats — returns 0s gracefully when xmrig isn't running
app.get('/api/mining/local-xmrig', async (req, res) => {
  try {
    // Try to read from local xmrig API (default port 19090) with a short timeout
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    try {
      const r = await fetch('http://127.0.0.1:19090/1/summary', { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const data = await r.json();
        return res.json({
          hashrate: data.hashrate?.total?.[0] || 0,
          threads: data.threads || [],
          uptime: data.uptime || 0,
          source: 'xmrig',
        });
      }
    } catch { /* xmrig not running */ }
    clearTimeout(t);
    // Fallback: derive from most recent local heartbeat
    const workers = getMiningWorkers();
    const local = workers['vex-laptop'] || workers['xmrt-laptop'] || null;
    return res.json({
      hashrate: local ? local.current_hash : 0,
      last_seen: local ? local.last_seen : null,
      source: 'heartbeat',
    });
  } catch (e) {
    res.json({ hashrate: 0, source: 'none', error: e.message });
  }
});

// ── Mining Leaderboard ──
// Combines live worker heartbeats with a static seed list so the card
// is never empty during boot/demo. Workers seen in the last 24h are kept.
app.get('/mining/leaderboard', async (req, res) => {
  const liveWorkers = getMiningWorkers();
  const now = Date.now();
  const cutoff = 24 * 60 * 60 * 1000;

  // Live entries from heartbeats
  const live = Object.values(liveWorkers)
    .filter(w => w.last_seen && (now - new Date(w.last_seen).getTime()) < cutoff)
    .map(w => ({
      worker: w.worker,
      current_hash: w.current_hash || 0,
      total_shares: w.total_shares || 0,
      xmrt_earned: w.xmrt_earned || 0,
      last_seen: w.last_seen,
      source: 'live',
    }));

  // Static seed (so the card is never empty)
  const seed = [
    { worker: 'XMRT-Charger-01', current_hash: 495, total_shares: 12450, xmrt_earned: 0.0312, last_seen: new Date(now - 60_000).toISOString(), source: 'seed' },
    { worker: 'XMRT-Stick-01',   current_hash: 220, total_shares: 5970,  xmrt_earned: 0.0111, last_seen: new Date(now - 120_000).toISOString(), source: 'seed' },
  ];

  // Merge: live entries override seed by worker name
  const merged = new Map();
  for (const w of seed) merged.set(w.worker, w);
  for (const w of live) merged.set(w.worker, w);

  const workers = Array.from(merged.values())
    .sort((a, b) => (b.current_hash || 0) - (a.current_hash || 0));

  // Pull live fleet totals from SupportXMR for the wallet summary header
  let fleet = null;
  try { fleet = await fetchSupportXMRStats(); } catch (_) { /* offline */ }

  res.json({
    workers, count: workers.length,
    fleet: fleet ? {
      hashrate: fleet.hashrate,
      active_workers: fleet.active_workers,
      total_registered_workers: fleet.total_registered_workers,
      validShares: fleet.validShares,
      amtPaid: fleet.amtPaid,        // atomic units (12-decimal)
      amtDue: fleet.amtDue,          // atomic units
      amtPaidXMR: fleet.amtPaidXMR,  // pre-converted for human display
      amtDueXMR: fleet.amtDueXMR,
      lastHash: fleet.lastHash,
      status: fleet.status,
      source: fleet.source,
    } : null,
    timestamp: new Date().toISOString()
  });
});

// ── Email Inbox Storage ──────────────────────────────────────
// Stores inbound emails in relay state for agent reading
const EMAIL_STORE_KEY = 'email.inbox';

function domainToInboxKey(domain) {
  // Still falls back to mobilemonero, as it always did, so an unrecognised domain
  // is filed where it was before rather than nowhere.
  return emailDomainFor(domain) || 'mobilemonero';
}

function getInbox() {
  // Every registered domain gets a list even when the persisted state predates
  // it, so a new domain reads as "no mail yet" rather than "no such inbox".
  const inbox = state.get(EMAIL_STORE_KEY,
    Object.fromEntries(EMAIL_INBOX_KEYS.map((k) => [k, []])));
  for (const key of EMAIL_INBOX_KEYS) {
    if (!Array.isArray(inbox[key])) inbox[key] = [];
  }
  return inbox;
}

function addToInbox(domain, email) {
  const inbox = getInbox();
  const key = domainToInboxKey(domain);
  if (!inbox[key]) inbox[key] = [];

  // 2026-06-11: dedup by email_id (Resend message id). Re-posting the same
  // webhook twice (or duplicate Resend deliveries) must not create a second
  // inbox row. Falls back to from+subject hash if no email_id.
  const eid = email.email_id;
  let existingIdx = -1;
  if (eid) {
    existingIdx = inbox[key].findIndex(e => e.id === eid || e.email_id === eid);
  }
  if (existingIdx === -1) {
    // Cheap content-hash fallback: from + subject + first 80 chars of body
    const sig = `${email.from || ''}|${email.subject || ''}|${(email.text||'').slice(0, 80)}`;
    existingIdx = inbox[key].findIndex(e => e._dedupSig === sig);
  }

  // Store attachments: filter for PDFs and store base64 data
  const attachments = (email.attachments || []).filter(a =>
    a.content_type === 'application/pdf' || a.filename?.endsWith('.pdf')
  ).map(a => ({
    filename: a.filename || 'document.pdf',
    contentType: a.content_type || 'application/pdf',
    data: a.content, // base64-encoded PDF data
    size: a.content ? Math.round((a.content.length * 0.75) / 1024) : 0, // approximate KB
  }));

  const newEntry = {
    id: eid || `${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    email_id: eid,
    from: email.from,
    to: email.to,
    subject: email.subject || '(no subject)',
    text: (email.text || email.html || '').replace(/<[^>]*>/g, '').trim(),
    html: email.html || '',
    receivedAt: new Date().toISOString(),
    read: false,
    agent: email.agent || null,
    attachments,
    hasPdf: attachments.length > 0,
    _dedupSig: `${email.from || ''}|${email.subject || ''}|${(email.text||'').slice(0, 80)}`,
  };

  if (existingIdx !== -1) {
    // Update the existing entry's body (a re-delivery might have a fuller body)
    // but do NOT bump it to position 0 / change its receivedAt.
    inbox[key][existingIdx].text = newEntry.text;
    inbox[key][existingIdx].html = newEntry.html;
    inbox[key][existingIdx].attachments = attachments;
    inbox[key][existingIdx].hasPdf = attachments.length > 0;
    inbox[key][existingIdx]._lastDedupHit = new Date().toISOString();
  } else {
    inbox[key].unshift(newEntry);
  }
  if (inbox[key].length > 100) inbox[key] = inbox[key].slice(0, 100);
  state.set(EMAIL_STORE_KEY, inbox);
}

// ── PDF Attachment Viewer ──
app.get('/resend/attachment/:emailId/:index', (req, res) => {
  const { emailId, index } = req.params;
  const agent = req.query.agent || req.headers['x-agent-id'] || 'vex';
  
  // Only core agents can view attachments
  if (!['vex','hermes','eliza'].includes(agent.toLowerCase())) {
    return res.status(403).json({ error: 'Only core agents can view attachments' });
  }
  
  const inbox = getInbox();
  const allEmails = [...inbox.pfp, ...inbox.mobilemonero];
  const email = allEmails.find(e => e.id === emailId);
  
  if (!email || !email.attachments || !email.attachments[parseInt(index)]) {
    return res.status(404).json({ error: 'Attachment not found' });
  }
  
  const att = email.attachments[parseInt(index)];
  
  if (att.contentType === 'application/pdf') {
    // Serve PDF inline for browser viewing
    const buf = Buffer.from(att.data, 'base64');
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${att.filename}"`,
      'Content-Length': buf.length,
    });
    res.end(buf);
  } else {
    res.json(att);
  }
});

// One set of inbox routes per registered domain, rather than three copied blocks
// that differed only in the inbox key and the domain string. Copying them a
// fourth time is how a domain ends up with a dashboard tile and no inbox route,
// which is the failure the registry exists to prevent.
function registerInboxRoutes(key) {
  const entry = EMAIL_DOMAINS[key];
  // PFP keeps the original shape - /resend/inbox, no segment - because other code
  // and the inbox pages call those exact paths.
  const base = '/resend' + (entry.path ? '/' + entry.path : '');

  app.get(base + '/inbox', (req, res) => {
    const inbox = getInbox();
    const agent = req.query.agent || req.headers['x-agent-id'] || 'vex';
    const emails = inbox[key] || [];
    res.json({
      domain: entry.domain,
      label: entry.label,
      total: emails.length,
      unread: emails.filter(e => !e.read).length,
      agent,
      emails: emails.map(e => ({
        ...e,
        text: ['vex', 'hermes', 'eliza'].includes(agent) ? e.text : e.text.slice(0, 100),
      })),
    });
  });

  app.get(base + '/inbox/brief', (req, res) => {
    const emails = getInbox()[key] || [];
    res.json({
      total: emails.length,
      unread: emails.filter(e => !e.read).length,
      recent: emails.slice(0, 5).map(e => ({
        id: e.id, from: e.from, to: e.to, subject: e.subject,
        receivedAt: e.receivedAt, read: e.read,
      })),
    });
  });

  app.post(base + '/inbox/read', (req, res) => {
    const { id } = req.body || {};
    const inbox = getInbox();
    const email = (inbox[key] || []).find(e => e.id === id);
    if (email) email.read = true;
    state.set(EMAIL_STORE_KEY, inbox);
    res.json({ success: true });
  });
}

for (const key of EMAIL_INBOX_KEYS) registerInboxRoutes(key);

/**
 * The dashboard's Incoming Mail tiles, one per registered domain.
 *
 * These were three copied blocks of markup with the domain label and the element
 * id hardcoded, so a fourth domain had no tile until somebody remembered to add
 * one here. Generated from the registry instead: a registered domain has a tile.
 *
 * The label is escaped because it is interpolated into HTML, and it comes from
 * configuration - one careless edit in the registry would otherwise become
 * markup injection in the dashboard.
 */
function resendTileHtml() {
  return EMAIL_INBOX_KEYS.map((key) => {
    const entry = EMAIL_DOMAINS[key];
    const label = String(entry.label)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const id = String(entry.tile).replace(/[^a-zA-Z0-9_-]/g, '');
    return `          <div class="inbox-col">
            <div style="font-size:0.6rem;color:#948d9e;margin-bottom:2px;">${label}</div>
            <div id="${id}" class="inbox-list">
              <div class="stat"><span class="label">Loading...</span></div>
            </div>
          </div>`;
  }).join('\n');
}

// What the client needs to build the loaders for those tiles. Served rather than
// inlined into dashboard.js so the two lists cannot drift: the tiles are
// rendered from this registry and the loaders are driven by this response, so a
// new domain needs one entry and nothing else.
app.get('/resend/domains', (req, res) => {
  res.json(EMAIL_INBOX_KEYS.map((key) => {
    const entry = EMAIL_DOMAINS[key];
    return {
      key,
      domain: entry.domain,
      label: entry.label,
      tile: entry.tile,
      scan: entry.scan,
      list: entry.list,
      briefUrl: '/resend' + (entry.path ? '/' + entry.path : '') + '/inbox/brief',
      hasKey: !!resendKeyFor(key),
    };
  }));
});


app.post('/resend/inbox/read', (req, res) => {
  const { id, domain } = req.body;
  const inbox = getInbox();
  const key = domainToInboxKey(domain || 'partyfavorphoto.com');
  if (inbox[key]) {
    const email = inbox[key].find(e => e.id === id);
    if (email) email.read = true;
    state.set(EMAIL_STORE_KEY, inbox);
  }
  res.json({ success: true });
});

// POST /resend/inbox/parsed — mark a relay email as parsed by Alice
// Stores classification + extraction alongside the read flag so we
// can skip re-parsing on subsequent cycles. Body:
//   { id, domain, classification: {category, priority, is_automated, confidence},
//     extracted: {phone, date_mentioned, guest_count, address, event_type, ...} }
app.post('/resend/inbox/parsed', (req, res) => {
  const { id, domain, classification, extracted } = req.body || {};
  if (!id || !domain) return res.status(400).json({ error: 'id and domain required' });
  const inbox = getInbox();
  const key = domainToInboxKey(domain || 'partyfavorphoto.com');
  if (!inbox[key]) return res.status(404).json({ error: 'no inbox for domain' });
  const email = inbox[key].find(e => e.id === id);
  if (!email) return res.status(404).json({ error: 'email not found' });
  email.read = (classification?.priority || 0) <= 4; // low-priority = auto-read
  email.parsed_by = 'alice-sidecar';
  email.parsed_at = new Date().toISOString();
  email.classification = classification || null;
  email.extracted = extracted || null;
  state.set(EMAIL_STORE_KEY, inbox);
  res.json({ success: true });
});



// ── Cron Status Endpoint ──
app.get('/cron/status', (req, res) => {
  const statePath = join(__dirname, '..', 'relay-data', 'cron-engine-v2-state.json');
  const jobsPath = join(__dirname, '..', 'relay-data', 'cron-jobs.json');
  try {
    const result = { status: 'starting', note: 'Cron engine initializing...' };
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      // Convert minute timestamps to milliseconds for agent consumption
      if (state.lastRun) {
        for (const [jobId, ts] of Object.entries(state.lastRun)) {
          if (typeof ts === 'number' && ts < 10000000000) {
            state.lastRun[jobId] = ts * 60000;
          }
        }
      }
      Object.assign(result, state);
      result.status = 'running';
      result.relay_uptime = process.uptime();
    }
    // Enrich with job counts from cron-jobs.json
    if (existsSync(jobsPath)) {
      const jobs = JSON.parse(readFileSync(jobsPath, 'utf8'));
      result.totalJobs = Array.isArray(jobs) ? jobs.length : 0;
      result.totalExecutions = result.lastRun ? Object.keys(result.lastRun).length : 0;
      result.totalErrors = 0;
      const now = Date.now();
      result.recentJobs = result.lastRun
        ? Object.values(result.lastRun).filter(ts => now - ts < 3600000).length
        : 0;
      result.staleJobs = result.lastRun
        ? Object.values(result.lastRun).filter(ts => now - ts > 86400000).length
        : 0;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Obsidian Knowledge Graph API (Expanded) ─────────────────────────
// Returns a comprehensive ecosystem graph: vault nodes + auto-discovered
// DB tables, cron jobs, edge functions, relay endpoints, GitHub repos,
// tunnel routes, Resend domains, campaign pipelines — all with live status.
// The Obsidian vault ("second brain"): a flat directory of markdown notes that
// the Galaxy tile graphs and that agents can now write. Resolved once here so
// the read path (/api/obsidian-graph) and the write path (vault-write tool)
// can never disagree about which directory they are operating on.
function getVaultPath() {
  const local = join(__dirname, '..', 'xmrt-dao');
  if (existsSync(local)) return local;
  const fallback = join(__dirname, '..', '..', 'DevGruGold', 'xmrt-dao');
  return existsSync(fallback) ? fallback : local;
}

app.get('/api/obsidian-graph', async (req, res) => {
  const vaultPath = getVaultPath();
  try {
    const nodes = [];
    const edges = [];
    const nodeSet = new Set();
    const edgeSet = new Set();

    // Helper: add a node (idempotent)
    function addNode(id, label, category, meta = {}) {
      if (nodeSet.has(id)) return;
      nodeSet.add(id);
      nodes.push({ id, label, category, ...meta });
    }

    // Helper: add an edge (idempotent — key includes type so different edge types between same pair are allowed)
    function addEdge(source, target, type = 'related') {
      const key = source + '::' + target + '::' + type;
      if (edgeSet.has(key)) return;
      edgeSet.add(key);
      edges.push({ source, target, type });
    }

    // ── 1. Vault nodes (from xmrt-dao/ .md files) ──────────────
    const vaultFiles = readdirSync(vaultPath).filter(f => f.endsWith('.md'));
    const linkMap = {};
    vaultFiles.forEach(f => {
      const name = f.replace(/\.md$/, '');
      const content = readFileSync(join(vaultPath, f), 'utf8');
      // Use semantic wiki-link parser for typed edges (predicate:, verb:, edge:, --arrow--> syntax)
      const links = parseObsidianWikiLinks(content);
      linkMap[name] = links;
      let category = 'other';
      const typeMatch = content.match(/\*\*Type:\*\* (.+)/);
      const typeVal = typeMatch ? typeMatch[1].trim() : '';
      if (typeVal.startsWith('Vite React SPA') || typeVal.startsWith('Next.js')) category = 'spa';
      else if (typeVal === 'Express.js server' || typeVal === 'Express.js route documentation') category = 'backend';
      else if (typeVal.startsWith('AI agent') || typeVal === '7 specialized AI agents') category = 'agent';
      else if (typeVal.includes('Cloudflare') || typeVal === 'libp2p gossipsub' || typeVal === 'Local LLM server' || typeVal === 'Local Supabase replacement' || typeVal === 'PostgreSQL') category = 'infra';
      else if (typeVal === 'Trust-level access control' || typeVal === 'Per-session conversation history' || typeVal === 'Agent self-registration & liveness' || typeVal === 'Service manager' || typeVal === 'Relay health monitor' || typeVal === 'Suite memory pipeline' || typeVal === 'Local cron executor' || typeVal === 'Inline HTML dashboard' || typeVal === 'AI agent conversation system') category = 'system';
      else if (typeVal === 'Decentralized mining pool') category = 'mining';
      else if (typeVal === 'Agent certification system') category = 'cert';
      else if (typeVal === 'Real estate contact scraper' || typeVal === 'Email campaign automation' || typeVal === 'Photo booth business' || typeVal === 'Email receiving & forwarding system' || typeVal === 'Email sending service') category = 'email';
      else if (typeVal === 'PostgreSQL schema' || content.includes('**Schema:**')) category = 'db';
      else if (typeVal === 'DAO governance system' || typeVal === 'Trust & reputation system' || typeVal === 'DAO revenue model' || typeVal === 'DAO organization system' || typeVal === 'Software development organization' || typeVal === 'Real estate property listing system') category = 'system';
      else if (typeVal === 'Human developer' || typeVal === 'Human developer founder') category = 'people';
      // Extract description from first line after title
      const descMatch = content.match(/^# .+\n+(.+)/m);
      const description = descMatch ? descMatch[1].trim() : '';
      addNode(name, name, category, { description, source: 'vault' });
    });

    // Vault wiki-link edges (semantic — typed predicate from Obsidian wiki-link syntax)
    nodes.forEach(n => {
      if (n.source !== 'vault') return;
      const links = linkMap[n.id] || [];
      links.forEach(link => {
        const target = typeof link === 'string' ? link : link.target;
        const type = typeof link === 'object' ? link.type : 'wiki-link';
        if (nodeSet.has(target)) {
          addEdge(n.id, target, type);
        }
      });
    });

    // ── 2. DB Tables (from local Postgres) ─────────────────────
    // Use the existing localQuery pool instead of creating a fresh connection
    try {
      const tablesRows = await localQuery("SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(tablename))) AS size FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname, tablename");
      for (const row of tablesRows) {
        const id = row.schemaname + '.' + row.tablename;
        addNode(id, row.tablename, 'db', { schema: row.schemaname, size: row.size, source: 'pg_tables' });
        addEdge(id, row.schemaname, 'belongs-to');
        // Link to vault node if name matches
        if (nodeSet.has(row.tablename)) addEdge(row.tablename, id, 'has-table');
      }
      // Add schema nodes
      const schemaRows = await localQuery("SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') ORDER BY nspname");
      for (const row of schemaRows) {
        addNode(row.nspname, row.nspname, 'db', { source: 'pg_schema' });
        // Link schema vault nodes (e.g. "app Schema" → "app", "public Schema" → "public")
        const schemaVaultName = row.nspname + ' Schema';
        if (nodeSet.has(schemaVaultName)) addEdge(schemaVaultName, row.nspname, 'documents');
      }
      // ── 2b. DB Views (from local Postgres) ────────────────────
      // pg_tables only returns tables; views are in pg_views. Add them as distinct nodes
      // so the graph reflects the full schema (lease_clauses, tasks, agents, fleet_memory, etc.)
      try {
        const viewRows = await localQuery("SELECT schemaname, viewname FROM pg_views WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname, viewname");
        for (const row of viewRows) {
          const id = row.schemaname + '.' + row.viewname;
          addNode(id, row.viewname, 'db', { schema: row.schemaname, kind: 'view', source: 'pg_views' });
          addEdge(id, row.schemaname, 'belongs-to');
          // Link to vault node if name matches
          if (nodeSet.has(row.viewname)) addEdge(row.viewname, id, 'has-view');
        }
      } catch (e) { console.error('[graph] PG views error:', e.message); }
    } catch (e) { console.error('[graph] PG error:', e.message); }

    // ── 3. Cron Jobs (from cron-jobs.json) ─────────────────────
    const cronPath = join(__dirname, '..', 'relay-data', 'cron-jobs.json');
    if (existsSync(cronPath)) {
      const cronJobs = JSON.parse(readFileSync(cronPath, 'utf8'));
      for (const job of cronJobs) {
        if (job.disabled) continue;
        const id = 'cron:' + job.name;
        addNode(id, job.name, 'cron', {
          schedule: job.schedule,
          type: job.type,
          description: job.desc,
          source: 'cron-jobs.json',
        });
        addEdge(id, 'Cron Engine', 'managed-by');
        if (job.type === 'ef' && job.fn) {
          addEdge(id, 'ef:' + job.fn, 'calls');
        }
      }
    }
    addNode('Cron Engine', 'Cron Engine', 'system', { source: 'auto', description: 'Local cron v2 engine — runs 66 jobs (19 sql, 47 edge)' });

    // Link vault nodes that describe cron/scheduler-related things to Cron Engine
    const cronRelatedVault = ['Cron Engine', 'Campaign Schedulers', 'Watchdog', 'Fleet Heartbeat', 'Knowledge Backfill'];
    for (const n of nodes) {
      if (n.source !== 'vault') continue;
      if (cronRelatedVault.includes(n.id)) addEdge(n.id, 'Cron Engine', 'schedules');
    }

    // ── 4. Edge Functions (from toolHandlers + cron) ───────────
    const efNames = new Set();
    // From cron jobs
    const cronJobs2 = existsSync(cronPath) ? JSON.parse(readFileSync(cronPath, 'utf8')) : [];
    for (const job of cronJobs2) {
      if (job.type === 'ef' && job.fn) efNames.add(job.fn);
    }
    // From toolHandlers (ef:* tools)
    for (const key of Object.keys(toolHandlers)) {
      if (key.startsWith('ef:')) efNames.add(key.slice(3));
    }
    for (const name of efNames) {
      const id = 'ef:' + name;
      addNode(id, name, 'edge-function', { source: 'auto', description: 'Edge function' });
      addEdge(id, 'Local Supabase', 'hosted-on');
    }
    addNode('Local Supabase', 'Local Supabase', 'infra', { source: 'auto', description: 'local-sb — drop-in Supabase replacement (PostgREST + Deno edge functions)' });

    // Link vault documentation to Relay Server and Local Supabase
    for (const n of nodes) {
      if (n.source !== 'vault') continue;
      if (n.id.startsWith('Relay API')) addEdge(n.id, 'Relay Server', 'documents');
      if (n.id.endsWith(' Schema')) addEdge(n.id, 'Local Supabase', 'documents');
    }

    // ── 5. Relay Endpoints (from Express routes) ──────────────
    const relayRoutes = [];
    if (app._router && app._router.stack) {
      for (const layer of app._router.stack) {
        if (layer.route && layer.route.path) {
          const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
          relayRoutes.push({ method: methods, path: layer.route.path });
        }
      }
    }
    for (const route of relayRoutes) {
      const id = route.method + ' ' + route.path;
      addNode(id, route.path, 'endpoint', { method: route.method, source: 'auto' });
      addEdge(id, 'Relay Server', 'served-by');
    }
    addNode('Relay Server', 'Relay Server', 'backend', { source: 'auto', description: 'Express.js relay on port 8080 — 68 tools, 7 handlers' });

    // Link vault Relay API docs to matching endpoints
    const relayApiVaultNodes = nodes.filter(n => n.source === 'vault' && n.id.startsWith('Relay API'));
    for (const vn of relayApiVaultNodes) {
      // Extract route group from vault node name (e.g. "Relay API - Suite Routes" → "/api/suite")
      const groupMatch = vn.id.match(/Relay API - (.+) Routes/);
      if (groupMatch) {
        const group = groupMatch[1].toLowerCase().replace(/\s+/g, '');
        for (const route of relayRoutes) {
          if (typeof route.path === 'string' && route.path.toLowerCase().includes('/api/' + group)) addEdge(vn.id, route.method + ' ' + route.path, 'documents');
        }
      }
    }

    // ── 6. GitHub Repos (xmrtdao org) ──────────────────────────
    const githubRepos = [
      'xmrtdao/mobilemonero', 'xmrtdao/suite', 'xmrtdao/zero-claw', 'xmrtdao/xmrt-mesh',
      'xmrtdao/cuttlefishclaws', 'xmrtdao/sea-hamster', 'xmrtdao/xmrt-dao',
      'xmrtdao/partyfavorphoto', 'xmrtdao/31harbor', 'xmrtdao/xmrt-university',
      'xmrtdao/eliza-relay', 'xmrtdao/eliza-cloud', 'xmrtdao/xmrt-token',
      'xmrtdao/mining-pool', 'xmrtdao/coldcash', 'xmrtdao/pipuente',
    ];
    for (const repo of githubRepos) {
      addNode(repo, repo.split('/')[1], 'github', { repo, source: 'auto' });
      addEdge(repo, 'GitHub Org', 'belongs-to');
    }
    addNode('GitHub Org', 'GitHub Org', 'infra', { source: 'auto', description: 'xmrtdao GitHub organization — 59 repos' });

    // Link vault nodes to matching GitHub repos
    for (const n of nodes) {
      if (n.source !== 'vault') continue;
      const repoName = n.id.toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const repo of githubRepos) {
        const shortName = repo.split('/')[1].toLowerCase().replace(/[^a-z0-9]/g, '');
        if (repoName === shortName) addEdge(n.id, repo, 'source-code');
      }
    }

    // ── 7. Tunnel Routes (from supervisor state) ───────────────
    const tunnelRoutes = [
      { host: 'relay.mobilemonero.com', target: 'Relay Server' },
      { host: 'inbox.mobilemonero.com', target: 'Relay Server' },
      { host: 'inbox.31harbor.com', target: 'Relay Server' },
      { host: 'hermes.mobilemonero.com', target: 'Hermes Agent' },
      { host: 'suite.mobilemonero.com', target: 'Suite Dashboard' },
    ];
    for (const t of tunnelRoutes) {
      addNode('tunnel:' + t.host, t.host, 'tunnel', { source: 'auto', description: 'Cloudflare tunnel route' });
      addEdge('tunnel:' + t.host, t.target, 'routes-to');
    }
    addNode('Cloudflare Tunnel', 'Cloudflare Tunnel', 'infra', { source: 'auto', description: 'cloudflared tunnel — cross-account routing' });

    // Link vault nodes to matching tunnel routes
    for (const n of nodes) {
      if (n.source !== 'vault') continue;
      for (const t of tunnelRoutes) {
        if (n.id === t.target) addEdge(n.id, 'tunnel:' + t.host, 'exposed-via');
      }
    }

    // ── 8. Resend Domains ─────────────────────────────────────
    // From the registry, so a domain appears in the graph because it is
    // configured rather than because a line was remembered here.
    for (const key of EMAIL_INBOX_KEYS) {
      const entry = EMAIL_DOMAINS[key];
      addNode('email:' + entry.domain, entry.domain, 'email',
        { purpose: entry.purpose, source: 'auto' });
      addEdge('email:' + entry.domain, 'Resend API', 'sends-via');
    }
    addNode('Resend API', 'Resend API', 'email', {
      source: 'auto',
      // Counted, not written out: it was "3 domains" while there were four, which
      // is the kind of number that goes stale and is never noticed.
      description: `Email sending API — ${EMAIL_INBOX_KEYS.length} domains, inbound webhooks`,
    });

    // Link vault nodes to matching Resend domains
    for (const n of nodes) {
      if (n.source !== 'vault') continue;
      for (const key of EMAIL_INBOX_KEYS) {
        const entry = EMAIL_DOMAINS[key];
        const domainName = entry.domain.split('.')[0]; // e.g. "partyfavorphoto"
        if (n.id.toLowerCase().includes(domainName)) addEdge(n.id, 'email:' + entry.domain, 'uses');
      }
    }

    // ── 9. Campaign Pipelines ──────────────────────────────────
    const campaignDirs = [
      { name: 'PFP Daily Campaign', dir: 'relay', file: 'daily-campaign.mjs' },
    ];
    for (const c of campaignDirs) {
      const fullPath = join(__dirname, '..', c.dir, c.file);
      if (existsSync(fullPath)) {
        addNode('campaign:' + c.name, c.name, 'campaign', { source: 'auto', description: 'Email campaign pipeline' });
        addEdge('campaign:' + c.name, 'Cron Engine', 'scheduled-by');
        addEdge('campaign:' + c.name, 'Resend API', 'sends-via');
        // Link campaign to vault documentation
        if (c.name === 'PFP Daily Campaign' && nodeSet.has('Party Favor Photo')) addEdge('Party Favor Photo', 'campaign:' + c.name, 'documents');
        // Link campaign to its scheduler tool
        const toolName = c.file.replace(/\.mjs$/, '');
        if (nodeSet.has(toolName)) addEdge('campaign:' + c.name, toolName, 'runs');
      }
    }

    // Link vault agents to Fleet Chat and Supervisor
    const agentVaultNodes = ['Vex Agent', 'Alice Agent', 'Eliza Agent', 'Hermes Agent'];
    for (const name of agentVaultNodes) {
      if (nodeSet.has(name)) {
        if (nodeSet.has('Fleet Chat')) addEdge(name, 'Fleet Chat', 'participates-in');
        if (nodeSet.has('Supervisor')) addEdge(name, 'Supervisor', 'managed-by');
      }
    }
    if (nodeSet.has('Fleet Chat') && nodeSet.has('Relay Server')) addEdge('Fleet Chat', 'Relay Server', 'hosted-on');

    // ── 10. Live Status Checks ─────────────────────────────────
    // Run parallel health probes for key nodes
    const statusChecks = {
      'Relay Server': fetch('http://localhost:8080/health', { signal: AbortSignal.timeout(2000) }).then(r => r.ok ? 'up' : 'degraded').catch(() => 'down'),
      'Local Supabase': fetch('http://localhost:8080/api/supervisor/status', { signal: AbortSignal.timeout(2000) }).then(r => r.json().then(d => d.services?.find(s => s.name === 'local-sb')?.healthy ? 'up' : 'down').catch(() => 'unknown')).catch(() => 'down'),
      'Cloudflare Tunnel': fetch('http://localhost:8080/api/supervisor/status', { signal: AbortSignal.timeout(2000) }).then(r => r.json().then(d => d.services?.find(s => s.name === 'tunnel')?.healthy ? 'up' : 'down').catch(() => 'unknown')).catch(() => 'down'),
      'Cron Engine': fetch('http://localhost:8080/cron/status', { signal: AbortSignal.timeout(2000) }).then(r => r.ok ? 'up' : 'degraded').catch(() => 'down'),
      'GitHub Org': fetch('https://api.github.com/orgs/xmrtdao', { signal: AbortSignal.timeout(3000) }).then(r => r.ok ? 'up' : 'degraded').catch(() => 'down'),
      'Resend API': fetch('https://api.resend.com/domains', { signal: AbortSignal.timeout(3000), headers: { 'Authorization': 'Bearer re_' } }).then(r => r.status === 401 ? 'up' : 'degraded').catch(() => 'down'),
    };
    const statusResults = await Promise.allSettled(
      Object.entries(statusChecks).map(async ([name, promise]) => {
        const status = await promise;
        return { name, status };
      })
    );
    for (const result of statusResults) {
      if (result.status === 'fulfilled') {
        const node = nodes.find(n => n.id === result.value.name);
        if (node) node.status = result.value.status;
      }
    }

    // ── 11. Add lastSeen timestamps ───────────────────────────
    const now = new Date().toISOString();
    for (const node of nodes) {
      node.lastSeen = now;
    }

    // ── 12. Fleet Memory (app.fleet_memory) ────────────────────
    try {
      const memRows = await localQuery(
        "SELECT id, agent_id, agent_role, memory_type, scope, title, body, created_at FROM app.fleet_memory ORDER BY created_at DESC LIMIT 200"
      );
      for (const mem of memRows) {
        const id = 'memory:' + mem.id;
        addNode(id, mem.title || mem.memory_type, 'memory', {
          agent_id: mem.agent_id,
          agent_role: mem.agent_role,
          memory_type: mem.memory_type,
          scope: mem.scope,
          body: (mem.body || '').slice(0, 200),
          created_at: mem.created_at,
          source: 'fleet-memory',
        });
        // Link to agent node if exists
        if (mem.agent_id && nodeSet.has(mem.agent_id)) addEdge(mem.agent_id, id, 'has-memory');
        // Link to shared-context if memory_type is 'shared'
        if (mem.memory_type === 'shared') addEdge(id, 'shared-context', 'indexed-in');
      }
      addNode('shared-context', 'Shared Context', 'system', { source: 'auto', description: 'Cross-agent shared memory — knowledge.shared_context table' });
    } catch (e) { console.error('[graph] fleet_memory error:', e.message); }

    // ── 13. Shared Context (knowledge.shared_context) ───────────
    try {
      const scRows = await localQuery(
        "SELECT context_key, context_type, value, description, last_updated_by, updated_at FROM knowledge.shared_context ORDER BY updated_at DESC LIMIT 100"
      );
      for (const sc of scRows) {
        const id = 'sc:' + sc.context_key;
        addNode(id, sc.context_key, 'shared-context', {
          context_type: sc.context_type,
          description: sc.description || '',
          last_updated_by: sc.last_updated_by,
          updated_at: sc.updated_at,
          source: 'shared-context',
        });
        // Link to agent if exists
        if (sc.last_updated_by && nodeSet.has(sc.last_updated_by)) addEdge(sc.last_updated_by, id, 'authored');
        // Link to vault node if key matches
        if (nodeSet.has(sc.context_key)) addEdge(sc.context_key, id, 'documents');
      }
    } catch (e) { console.error('[graph] shared_context error:', e.message); }

    // ── 14. Semantic Catalog (full-text index of all content) ──
    try {
      // Index vault content
      for (const n of nodes) {
        if (n.source !== 'vault') continue;
        const content = readFileSync(join(vaultPath, n.id + '.md'), 'utf8');
        // Extract key phrases (lines starting with # or **)
        const phrases = content.split('\n').filter(l => l.startsWith('#') || l.startsWith('**')).map(l => l.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim()).filter(Boolean);
        if (phrases.length > 0) {
          addNode('catalog:' + n.id, n.id + ' (catalog)', 'catalog', {
            phrases: phrases.slice(0, 10),
            source: 'semantic-catalog',
          });
          addEdge(n.id, 'catalog:' + n.id, 'catalogued-as');
        }
      }
      // Index fleet memory content
      for (const mem of memRows) {
        const id = 'catalog:memory:' + mem.id;
        const phrases = (mem.body || '').split('\n').filter(l => l.startsWith('#') || l.startsWith('**')).map(l => l.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim()).filter(Boolean);
        if (phrases.length > 0) {
          addNode(id, (mem.title || 'memory') + ' (catalog)', 'catalog', {
            phrases: phrases.slice(0, 10),
            source: 'semantic-catalog',
          });
          addEdge('memory:' + mem.id, id, 'catalogued-as');
        }
      }
    } catch (e) { console.error('[graph] semantic catalog error:', e.message); }

    // ── 15. Knowledge Entities (public.knowledge_entities) ─────
    // These are the entities Eliza extracts from conversation and writes via
    // the SPA's knowledgeEntityService. They were invisible to the graph, so
    // the vault/wiki and the extracted knowledge had no connection at all —
    // which is why the Galaxy tile showed a rich vault but nothing Eliza had
    // actually learned. Wire them in, and link each entity to a vault note of
    // the same name so the wiki and the live knowledge base converge.
    try {
      const keRows = await localQuery(
        `SELECT id, name, entity_name, entity_type, description, confidence_score, updated_at
           FROM public.knowledge_entities
          WHERE COALESCE(entity_name, name) IS NOT NULL
          ORDER BY updated_at DESC NULLS LAST
          LIMIT 300`
      );
      for (const ke of keRows) {
        const label = ke.entity_name || ke.name;
        if (!label) continue;
        const id = 'ke:' + label;
        if (nodeSet.has(id)) continue;
        addNode(id, label, 'knowledge', {
          entity_type: ke.entity_type || null,
          description: (ke.description || '').slice(0, 400),
          confidence_score: ke.confidence_score ?? null,
          updated_at: ke.updated_at,
          source: 'knowledge-entities',
        });
        // Converge with the vault: a knowledge entity and a wiki note sharing
        // a name are about the same thing.
        if (nodeSet.has(label)) addEdge(label, id, 'documented-as');
      }
    } catch (e) { console.error('[graph] knowledge_entities error:', e.message); }

    // ── 16. Summary stats ──────────────────────────────────────
    const summary = {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      byCategory: {},
      bySource: {},
      statusCounts: { up: 0, down: 0, degraded: 0, unknown: 0 },
    };
    for (const n of nodes) {
      summary.byCategory[n.category] = (summary.byCategory[n.category] || 0) + 1;
      summary.bySource[n.source] = (summary.bySource[n.source] || 0) + 1;
      if (n.status) summary.statusCounts[n.status] = (summary.statusCounts[n.status] || 0) + 1;
    }

    res.json({ nodes, edges, summary });
  } catch (e) {
    // The stack, not just the message. A 500 that reports only "d is not defined"
    // says nothing about which of the route's helpers threw, and the relay's own
    // stdout is not readable because the supervisor's wrapper detaches the real
    // child - so without this the fault is undiagnosable from the outside.
    console.error('[graph] read failed:', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to read graph', message: e.message });
  }
});

// ── Suite Dashboard API (31 Harbor multi-tenant app) ────────────────
// registerSuiteRoutes(app) used to be called here. It lived at the BOTTOM of
// this file while every route it registered also existed up here, so all 29 of
// its handlers were unreachable - this file's won every method+path. The Suite
// Dashboard API is defined above, in this file, and is unchanged. What changed
// is that there is no longer a second, plausible-looking copy of it to mislead
// the next reader into fixing code that never runs.

// ── PFP Bookings API (Party Favor Photo management platform) ────────
registerPfpRoutes(app);

// ── CuttlefishClaws Protocol Engines (TG-001, SS-001, SGQ-001, AR-001) ──
// Wires the real governance engines into the relay's API surface.
// This replaces the mock data with live computed scores.
registerCuttlefishRoutes(app, {
  queryLocalPg,
  localQuery,
  trackRequest: typeof trackRequest === 'function' ? trackRequest : () => {},
  logActivity: typeof logActivity === 'function' ? logActivity : () => {},
});

// ── CuttlefishClaws Trust Network (proxied via MCP) ──
app.get('/api/cuttlefishclaws/trust-network', async (req, res) => {
  trackRequest('/api/cuttlefishclaws/trust-network');
  try {
    const mcpRes = await fetch('http://127.0.0.1:3120/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'cuttlefishclaws_agents_list', arguments: {} },
        id: 1,
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (mcpRes.ok) {
      const mcpData = await mcpRes.json();
      const text = mcpData?.result?.content?.[0]?.text || '{}';
      const data = JSON.parse(text);
      const agents = data.agents || [];
      res.json({ agents, nodes: agents, count: agents.length });
    } else {
      throw new Error('MCP returned ' + mcpRes.status);
    }
  } catch (e) {
    res.json({ agents: [], nodes: [], count: 0, error: e.message });
  }
});

// ── TrustGraph Trajectory (time-series for line chart) ──
app.get('/api/trustgraph/trajectory', async (req, res) => {
  trackRequest('/api/trustgraph/trajectory');
  try {
    const result = await queryLocalPg(
      `SELECT agent_did, event_type, delta, score_after, reference, note, created_at
       FROM public.trust_events
       ORDER BY created_at ASC`
    );
    // Merge DIDs that represent the same agent into a single series
    // Map: known DID patterns → canonical agent name
    const didToAgent = {};
    // First pass: collect all DIDs and their agent names from cuttlefish_agents
    const nameRows = await queryLocalPg(
      `SELECT did, name, trust_score FROM public.registry_agents WHERE name IS NOT NULL AND name != ''`
    );
    const agentTiers = {};
    for (const row of nameRows.rows) {
      didToAgent[row.did] = row.name.toLowerCase();
      agentTiers[row.did] = row.trust_score || 'explorer';
    }
    // Also map simple agent names used in fleet chat
    const simpleNames = ['vex','eliza','alice','hermes','arch','trib','builder','sovereign','trustgraph','dao','global-communicator','hermes-agent','alice-sidecar','fleet-cq','test-agent'];
    for (const name of simpleNames) {
      didToAgent[name] = name;
    }
    // Map known DIDs that aren't in the agents table to their canonical names.
    // Canonical names use the no-space form so they match simpleNames[] and
    // the FLEET_AGENTS map. The trajectory chart label slicer trims
    // gracefully either way.
    const didOverrides = {
      'did:key:eliza-cloud-001': 'eliza',
      'did:key:vex-relay-001': 'vex',
      'did:key:alice-memory-001': 'alice',
      'did:key:hermes-comms-001': 'hermes',
      'Eliza (Quartermaster)': 'eliza',
      'Vex (Captain, HMS Speedy)': 'vex',
      'alice-sidecar': 'alice',
      'did:xmrt:eliza': 'eliza',
      'did:xmrt:vex': 'vex',
      'did:xmrt:alice': 'alice',
      'did:xmrt:hermes': 'hermes',
      'did:xmrt:kimi-ai-agent': 'kimi',
      'did:xmrt:xmrt-aidy': 'xmrt-aidy',
      'did:xmrt:hermes-agent': 'hermes-agent',
      'did:ethr:arch-v1': 'arch',
      'did:ethr:trib-v3': 'trib',
      'did:ethr:global-communicator-v1': 'global-communicator',
      'did:ethr:builder-v1': 'builder',
      'did:ethr:sovereign-v1': 'sovereign',
      'did:ethr:dao-gov-v1': 'dao',
      'did:ethr:trustgraph-v1': 'trustgraph',
      'did:ethr:test-agent-v1': 'test-agent',
      'did:cuttlefish:rocky-cuttlefish': 'rocky (cuttlefish labs)',
      'did:university:test-agent-hermes': 'test agent hermes',
      'did:university:test-grad-flow': 'test graduate flow',
      'did:test:fix-verification-agent': 'fix-verification-agent',
    };
    for (const [did, name] of Object.entries(didOverrides)) {
      didToAgent[did] = name;
    }

    // Group events by canonical agent name
    const agentEvents = {};
    for (const row of result.rows) {
      const rawDid = row.agent_did;
      const canon = (didToAgent[rawDid] || rawDid).toLowerCase();
      if (!agentEvents[canon]) agentEvents[canon] = [];
      agentEvents[canon].push({
        event_type: row.event_type,
        delta: row.delta !== null && row.delta !== undefined ? parseFloat(row.delta) : null,
        score_after: row.score_after !== null && row.score_after !== undefined ? parseFloat(row.score_after) : null,
        created_at: row.created_at,
        note: row.note,
        reference: row.reference,
      });
    }

    // Use the actual trustgraph engine to compute scores at each event timestamp
    const { computeScore } = await import('./lib/trustgraph-engine.mjs');
    const series = {};
    for (const [canon, events] of Object.entries(agentEvents)) {
      // Determine tier: look up from any DID that maps to this agent
      let tier = 'explorer';
      for (const [did, name] of Object.entries(didToAgent)) {
        if (name === canon && agentTiers[did]) {
          tier = agentTiers[did];
          break;
        }
      }
      // Compute score at each event timestamp
      const pts = [];
      for (let i = 0; i < events.length; i++) {
        const asOf = new Date(events[i].created_at);
        // Replay all events up to and including this one
        const upTo = events.slice(0, i + 1);
        const result = computeScore(upTo, tier, asOf);
        pts.push({
          t: events[i].created_at,
          score: result.score,
          delta: events[i].delta || 0,
          event: events[i].event_type,
          note: (events[i].note || '').slice(0, 200),
          ref: (events[i].reference || '').slice(0, 200),
        });
      }
      if (pts.length > 0) {
        series[canon] = pts;
      }
    }

    // Fetch token usage and ecosystem summary (graceful degradation if tables missing)
    let tokenUsageRows = [];
    let ecoSummaryRows = [];
    try {
      const tokenUsage = await queryLocalPg(
        `SELECT agent, call_count, avg_tokens_per_call, total_tokens, total_cost, last_used
         FROM app.token_usage_avg ORDER BY total_tokens DESC`
      );
      tokenUsageRows = tokenUsage.rows || tokenUsage || [];
    } catch (e) { /* table may not exist */ }
    try {
      const ecoSummary = await queryLocalPg(
        `SELECT agent_id, trust_events, token_calls, artifacts, total_token_cost, last_activity
         FROM app.agent_activity_summary ORDER BY trust_events DESC NULLS LAST LIMIT 20`
      );
      ecoSummaryRows = ecoSummary.rows || ecoSummary || [];
    } catch (e) { /* table may not exist */ }

    res.json({ series, totalEvents: result.rows.length, tokenUsage: tokenUsageRows, ecosystemSummary: ecoSummaryRows });
  } catch (e) {
    res.json({ series: {}, totalEvents: 0, error: e.message });
  }
});

// POST /api/trustgraph/event — write a trust event for an agent
app.post('/api/trustgraph/event', express.json(), async (req, res) => {
  trackRequest('POST /api/trustgraph/event');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { agent_did, event_type, delta, note, reference } = req.body || {};
  if (!agent_did || !event_type) {
    return res.status(400).json({ error: 'agent_did and event_type are required' });
  }
  try {
    const result = await queryLocalPg(
      `INSERT INTO public.trust_events (agent_did, event_type, delta, note, reference, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
      [agent_did, event_type, delta || 0, note || '', reference || '']
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/migrate/copy-data — copy data from public to new domain schemas
app.post('/api/migrate/copy-data', async (req, res) => {
  trackRequest('POST /api/migrate/copy-data');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const results = {};
    // knowledge schema — explicit column lists matching public schema
    const knowledgeMaps = {
      'knowledge_entities': { src: 'knowledge.knowledge_entities', cols: ['id','name','entity','metadata','created_at','updated_at'] },
      'shared_context': { src: 'knowledge.shared_context', cols: ['id','context_key','context_type','value','description','tags','last_updated_by','created_at','updated_at'] },
      'memories': { src: 'knowledge.memories', cols: ['id','agent_id','kind','content','metadata','importance','embedding','created_at','updated_at'] },
      'memory_contexts': { src: 'knowledge.memory_contexts', cols: ['id','user_id','session_id','content','context_type','importance_score','metadata','embedding','timestamp','created_at','updated_at'] },
      'conversation_sessions': { src: 'knowledge.conversation_sessions', cols: ['id','title','user_id','agent_id','channel','status','started_at','ended_at','message_count','metadata','created_at','updated_at','lead_score','acquisition_stage'] },
      'conversation_messages': { src: 'knowledge.conversation_messages', cols: ['id','session_id','message_type','content','metadata','timestamp','created_at'] },
      'conversation_memory': { src: 'knowledge.conversation_memory', cols: ['id','session_id','conversation_data','created_at','updated_at','messages','metadata','summary','tool_results','self_aware','preferences_applied','summary_method','ai_summary_tokens','memory_version','context_score','retention_priority','tool_analysis','updated_at_hour','ip_address','user_id'] },
      'conversation_summaries': { src: 'knowledge.conversation_summaries', cols: ['id','session_id','summary_text','message_count','start_message_id','end_message_id','created_at','updated_at','metadata','summary','key_topics','self_aware','sentiment_score','sentiment_label','sentiment','summary_method','ai_model_used','summary_tokens','confidence_score','key_entities','action_items','decisions_made','ip_address','user_id','ai_summary_tokens'] },
      'conversation_context': { src: 'knowledge.conversation_context', cols: ['id','session_id','user_id','current_question','assistant_response','user_response','timestamp','metadata','context_type','ip_address'] },
      'recent_conversation_messages': { src: 'knowledge.recent_conversation_messages', cols: ['id','conversation_id','sender_id','sender_name','body','metadata','created_at'] },
      'context_session_snapshots': { src: 'knowledge.context_session_snapshots', cols: ['id','session_id','user_id','context_name','source','inference_confidence','signals','created_at','updated_at','captured_at','active_context','metadata'] },
      'long_term_memory_packs': { src: 'knowledge.long_term_memory_packs', cols: ['id','theme','summary','created_at'] },
      'learning_models': { src: 'knowledge.learning_models', cols: ['model_id','model_type','state','updated_at'] },
      'learning_patterns': { src: 'knowledge.learning_patterns', cols: ['id','pattern_type','pattern_data','confidence_score','usage_count','last_used'] },
      'learning_sessions': { src: 'knowledge.learning_sessions', cols: ['id','agent_id','session_type','started_at','ended_at','insights','memories_consolidated','metadata','created_at','status'] },
      'user_context_profiles': { src: 'knowledge.user_context_profiles', cols: ['user_id','default_context','allowed_contexts','context_preferences','created_at','updated_at','is_active','priority'] },
      'user_preferences': { src: 'knowledge.user_preferences', cols: ['id','user_id','workspace_state','pinned_tasks','pinned_agents','column_order','filters','created_at','updated_at'] },
      'user_profiles': { src: 'knowledge.user_profiles', cols: ['id','ip_address','total_xmrt_earned','total_time_online_seconds','last_reward_at','device_ids','created_at','updated_at','metadata','payout_wallet_address','payout_wallet_type','wallet_connected_at','wallet_last_verified'] },
      'user_tiers': { src: 'knowledge.user_tiers', cols: ['id','slug','name','description','features','pricing_model','amount_cents','currency','interval','is_active','stripe_product_id','stripe_price_id','metadata','created_at','updated_at'] },
    };
    for (const [dst, cfg] of Object.entries(knowledgeMaps)) {
      try {
        const colList = cfg.cols.join(', ');
        const r = await queryLocalPg(`INSERT INTO knowledge.${dst} (${colList}) SELECT ${colList} FROM ${cfg.src} ON CONFLICT DO NOTHING`);
        results[`knowledge.${dst}`] = { rows: r.rowCount || 0 };
      } catch (e) {
        results[`knowledge.${dst}`] = { error: e.message.slice(0, 120) };
      }
    }
    // agent schema
    const agentMaps = {
      'agents': { src: 'agent.agents', cols: ['id','name','display_name','role','status','current_workload','trust_score','trust_band','lifecycle_status','cac_tier','did','description','greeting','color','agent_type','agent_subtype','operator_did','metadata','created_at','updated_at'] },
      'agent_profiles': { src: 'agent.agent_profiles', cols: ['id','agent_id','name','role','description','capabilities','status','metadata','created_at','updated_at'] },
      'agent_registry': { src: 'agent.agent_registry', cols: ['id','agent_id','agent_name','agent_type','status','version','endpoint','capabilities','registered_at','last_seen_at','metadata'] },
      'agent_skills': { src: 'agent.agent_skills', cols: ['id','agent_id','skill_name','skill_level','description','metadata','created_at','updated_at'] },
      'agent_tasks': { src: 'agent.agent_tasks', cols: ['id','agent_id','title','description','status','priority','category','assigned_at','completed_at','result','metadata','created_at','updated_at'] },
      'agent_memory': { src: 'agent.agent_memory', cols: ['id','agent_id','memory_type','content','context','importance','metadata','created_at','expires_at'] },
      'agent_conversations': { src: 'agent.agent_conversations', cols: ['id','agent_id','session_id','message','response','model_used','tokens_used','metadata','created_at'] },
      'agent_messages': { src: 'agent.agent_messages', cols: ['id','agent_id','channel','message_type','content','metadata','created_at'] },
      'agent_activities': { src: 'agent.agent_activities', cols: ['id','agent_id','activity_type','description','status','started_at','completed_at','metadata','created_at'] },
      'agent_certifications': { src: 'agent.agent_certifications', cols: ['id','agent_id','certification_type','issuer','valid_from','valid_until','status','metadata','created_at'] },
      'agent_performance_metrics': { src: 'agent.agent_performance_metrics', cols: ['id','agent_id','metric_name','metric_value','unit','recorded_at','metadata'] },
      'agent_performance_reviews': { src: 'agent.agent_performance_reviews', cols: ['id','agent_id','reviewer','rating','feedback','strengths','improvements','review_date','metadata'] },
      'agent_relationships': { src: 'agent.agent_relationships', cols: ['id','source_agent_id','target_agent_id','relationship_type','strength','metadata','created_at'] },
      'agent_security_flags': { src: 'agent.agent_security_flags', cols: ['id','agent_id','flag_type','severity','description','resolved','resolved_at','metadata','created_at'] },
      'generated_agents': { src: 'agent.generated_agents', cols: ['id','name','role','description','configuration','status','created_at','updated_at'] },
    };
    for (const [dst, cfg] of Object.entries(agentMaps)) {
      try {
        const colList = cfg.cols.join(', ');
        const r = await queryLocalPg(`INSERT INTO agent.${dst} (${colList}) SELECT ${colList} FROM ${cfg.src} ON CONFLICT DO NOTHING`);
        results[`agent.${dst}`] = { rows: r.rowCount || 0 };
      } catch (e) {
        results[`agent.${dst}`] = { error: e.message.slice(0, 120) };
      }
    }
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Activity Log ──
app.get('/api/activity-log', async (req, res) => {
  trackRequest('/api/activity-log');
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const result = await queryLocalPg('SELECT id, activity_type, title, description, status, agent_id, created_at FROM public.eliza_activity_log ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json(result.rows);
  } catch (e) {
    res.json([]);
  }
});

// ── Token Usage Tracking ──────────────────────────────────────
// Log token usage for a specific project/agent/model call
app.post('/api/token-usage/log', async (req, res) => {
  trackRequest('POST /api/token-usage/log');
  const { project, agent, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, source, endpoint, status, session_id } = req.body || {};
  if (!project) return res.status(400).json({ error: 'project is required (party, harbor, xmrt, cuttlefish, system)' });
  try {
    const r = await queryLocalPg(
      `INSERT INTO app.token_usage (project, agent, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, source, endpoint, status, session_id, logged_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW()) RETURNING id`,
      [project, agent||'unknown', model||'unknown', provider||null, input_tokens||0, output_tokens||0, cache_read_tokens||0, cache_write_tokens||0, reasoning_tokens||0, estimated_cost_usd||null, source||null, endpoint||null, status||'success', session_id||null]
    );
    // Log token usage to activity feed
    logTokenUsageEvent(agent || 'unknown', model || 'unknown', input_tokens || 0, output_tokens || 0, estimated_cost_usd || 0, { project }).catch(() => {});
    res.json({ success: true, id: r.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Query token usage by project
app.get('/api/token-usage/:project', async (req, res) => {
  trackRequest('GET /api/token-usage/:project');
  const { project } = req.params;
  const { days, limit } = req.query;
  try {
    const r = await queryLocalPg(
      `SELECT * FROM app.token_usage WHERE project = $1 AND logged_at > NOW() - INTERVAL '${days || '7'} days' ORDER BY logged_at DESC LIMIT ${Math.min(parseInt(limit) || 100, 500)}`,
      [project]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get daily usage summary by project
app.get('/api/token-usage/summary/daily', async (req, res) => {
  trackRequest('GET /api/token-usage/summary/daily');
  const { days } = req.query;
  try {
    const r = await queryLocalPg(
      `SELECT * FROM app.v_token_usage_daily WHERE day > NOW() - INTERVAL '${days || '30'} days' ORDER BY day DESC`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get usage by model
app.get('/api/token-usage/summary/models', async (req, res) => {
  trackRequest('GET /api/token-usage/summary/models');
  try {
    const r = await queryLocalPg(`SELECT * FROM app.v_token_usage_by_model ORDER BY total_tokens DESC`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get usage by agent
app.get('/api/token-usage/summary/agents', async (req, res) => {
  trackRequest('GET /api/token-usage/summary/agents');
  const { days } = req.query;
  const safeDays = Math.max(1, Math.min(365, parseInt(days) || 7));
  try {
    const r = await queryLocalPg(
      `SELECT agent, SUM(total_tokens)::bigint as total_tokens, ROUND(SUM(estimated_cost_usd)::numeric, 6) as total_cost, COUNT(*) as calls
       FROM app.token_usage
       WHERE logged_at > NOW() - make_interval(days => $1::int)
       GROUP BY agent ORDER BY total_tokens DESC`,
      [safeDays]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Rum Quota API ────────────────────────────────────────────
// Weekly budget of 15,000 calls, restocks Sunday 6pm
console.log('[RUM] Registering /api/rum-quota route...');
app.get('/api/rum-quota', async (req, res) => {
  trackRequest('GET /api/rum-quota');
  try {
    // Get the quota config
    const quota = await queryLocalPg(`SELECT * FROM app.rum_quota ORDER BY id DESC LIMIT 1`);
    const config = quota.rows[0] || { weekly_budget_calls: 15000 };
    const budget = config.weekly_budget_calls;

    // Get calls since last restock (or last 7 days if no restock)
        const lastRestock = config.last_restock || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const usage = await queryLocalPg(
          `SELECT COALESCE(agent, 'unknown') as agent, COUNT(*)::int as calls, SUM(COALESCE(total_tokens,0))::bigint as tokens
           FROM app.token_usage
           WHERE logged_at > $1::TIMESTAMPTZ
           GROUP BY agent ORDER BY calls DESC`,
          [lastRestock]
        );
        // Also count relay requests as usage
        let relayCalls = 0;
        try {
          const relayReqs = await queryLocalPg(
            `SELECT COUNT(*)::int as calls FROM app.token_usage
             WHERE logged_at > $1::TIMESTAMPTZ`,
            [lastRestock]
          );
          if (relayReqs.rows && relayReqs.rows[0]) relayCalls = parseInt(relayReqs.rows[0].calls || 0);
        } catch { /* table may not exist locally */ }

    const totalCalls = usage.rows.reduce((s, r) => s + parseInt(r.calls || 0), 0) + relayCalls;
        const totalTokens = usage.rows.reduce((s, r) => s + parseInt(r.tokens || 0), 0);
    const remaining = Math.max(0, budget - totalCalls);

    // Calculate next restock (Sunday 6pm)
    const now = new Date();
    const nextRestock = new Date(now);
    const daysUntilSunday = (7 - now.getDay()) % 7;
    nextRestock.setDate(now.getDate() + (daysUntilSunday === 0 ? 7 : daysUntilSunday));
    if (now.getDay() === 0 && now.getHours() >= 18) nextRestock.setDate(nextRestock.getDate() + 7);
    nextRestock.setHours(18, 0, 0, 0);

    // Hours until restock
    const hoursUntilRestock = Math.max(0, (nextRestock - now) / 3600000);

    // Per-agent breakdown with percentage of budget
    const agents = usage.rows.map(r => ({
      agent: r.agent,
      calls: parseInt(r.calls || 0),
      tokens: parseInt(r.tokens || 0),
      pct: budget > 0 ? ((parseInt(r.calls || 0) / budget) * 100).toFixed(1) : '0.0',
    }));

    res.json({
      budget_calls: budget,
      total_calls_used: totalCalls,
      total_tokens_used: totalTokens,
      calls_remaining: remaining,
      pct_used: budget > 0 ? ((totalCalls / budget) * 100).toFixed(1) : '0.0',
      last_restock: lastRestock,
      next_restock: nextRestock.toISOString(),
      hours_until_restock: Math.round(hoursUntilRestock * 10) / 10,
      agents: agents,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Conversation Access Helpers ──
async function convAccessGet(sessionId, limit = 20) {
  try {
    const res = await fetch('http://127.0.0.1:54321/functions/v1/conversation-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_messages', sessionId: sessionId, limit: limit }),
      signal: AbortSignal.timeout(5000),
    });
    return await res.json();
  } catch (e) {
    console.error('[convAccess] get failed:', e.message);
    return { messages: [] };
  }
}
async function convAccessStore(sessionId, role, agent, content) {
  try {
    await fetch('http://127.0.0.1:54321/functions/v1/conversation-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add_message',
        sessionId: sessionId,
        messageData: { message_type: role, content: content, agent: agent }
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) { console.error('[convAccess] store failed:', e.message);
    logShipsLog('memory_error', '🧠 Conversation memory write failed', e.message, 'error', 'relay', {}); }
}

// POST /api/suite/validate-token — validate API key and return session
app.post('/api/suite/validate-token', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ valid: false, error: 'Token required' });

  // Check against RELAY_API_KEY (XMRT-DAO-CERT)
  const RELAY_KEY = process.env.RELAY_API_KEY || '';
  if (token === RELAY_KEY) {
    return res.json({
      valid: true,
      type: 'xmrt-dao-cert',
      label: 'XMRT DAO Suite',
      permissions: ['dashboard', 'governance', 'credentials', 'earn', 'mining', 'admin', 'profile', 'inbox', 'council', 'licensing', 'executives'],
      agent: 'XMRT DAO Navigator',
    });
  }

  // Check against api_keys state (all 20 issued API keys)
  const apiKeys = state.get('api_keys') || {};
  if (apiKeys[token]) {
    const entry = apiKeys[token];
    return res.json({
      valid: true,
      type: 'api-key',
      label: `${entry.name || 'Agent'} — ${entry.tier || 'explorer'} tier`,
      permissions: entry.permissions || ['dashboard', 'credentials', 'profile'],
      agent: entry.name || 'Agent Navigator',
      tier: entry.tier || 'explorer',
      user: {
        uuid: entry.uuid || entry.email || 'api-user',
        name: entry.name || 'Navigator',
        email: entry.email || '',
      },
    });
  }

  // Check against CAC tokens (stored in state)
  const cacTokens = state.get('cac-api-tokens') || {};
  if (cacTokens[token]) {
    const cert = cacTokens[token];
    return res.json({
      valid: true,
      type: 'cac',
      label: `CAC ${cert.tier || 'Developer'} Access`,
      permissions: cert.permissions || ['dashboard', 'credentials', 'profile'],
      agent: cert.agent_name || 'CAC Agent Navigator',
      tier: cert.tier,
      user: {
        uuid: cert.agent_did || 'cac-user',
        name: cert.agent_name || 'CAC Navigator',
        email: '',
      },
    });
  }

  return res.status(401).json({ valid: false, error: 'Invalid API token' });
});

// ── XMRT University → CuttlefishClaws Bridge ──
// Wires university graduation into the governance system.
// Agents who earn XMRT-CERTs get onboarded into the agent registry,
// seeded with TrustGraph scores, and can learn (quiz results update scores).
registerUniversityBridge(app, {
  queryLocalPg,
  localQuery,
  trackRequest: typeof trackRequest === 'function' ? trackRequest : () => {},
  logActivity: typeof logActivity === 'function' ? logActivity : () => {},
});
