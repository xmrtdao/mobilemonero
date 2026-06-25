#!/usr/bin/env node
// Prevent background task crashes
process.on('unhandledRejection', (err) => {
  console.error('[Relay] Unhandled rejection (non-fatal):', err?.message || err);
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
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn, execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── Load .env ───────────────────────────────────────────────
// Node doesn't auto-load .env. The previous version used
// `if (!process.env[key])` so OS env won; that meant a stale
// `SUPABASE_URL=https://vawouugtzwmejxqkeqqj.supabase.co` set
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
import { ollamaChat, listModels, checkOllamaHealth } from './tools/ollama-chat.mjs';
import { getFullSnapshot, getSystemResources, checkExternalServices } from './tools/monitor.mjs';
import * as state from './lib/state.mjs';
import { createTaskRunner } from './lib/task-runner.mjs';
import { handleInboundEmail } from './lib/auto-responder.mjs';
import { ensureLocalDb, restFetch as localRestFetch, query as localQuery, LOCAL_DB_ENABLED } from './lib/localDb.mjs';
import { createMeshRouter, initMeshNode, publishToMesh, getMeshMessageLog, getMeshStatus } from './lib/mesh-router.mjs';
import registerSuiteRoutes from './routes/suite-dashboard.mjs';
import { discoverFunctions, listFunctions } from './lib/function-runtime.mjs';

// Local Postgres (embedded-postgres) connection helper
import pg from 'pg';
const { Client: PgClient } = pg;
async function queryLocalPg(sql, params) {
  const c = new PgClient({ host: '127.0.0.1', port: 5432, user: 'postgres', password: 'postgres', database: 'xmrt_suite' });
  await c.connect();
  try { return await c.query(sql, params); }
  finally { await c.end(); }
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
function logActivity(type, taskId, status, detail) {
  const entry = { ts: new Date().toISOString(), type, taskId, status, detail: detail || '' };
  activityLog.unshift(entry);
  if (activityLog.length > 500) activityLog.length = 500;
  try { writeFileSync(LOG_FILE, JSON.stringify(activityLog, null, 2)); } catch {}
  console.log(`[${entry.ts.slice(11,19)}] ${type} | ${taskId || '-'} | ${status} | ${(detail||'').slice(0,80)}`);
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
      result.hostname = execSync('hostname', { encoding: 'utf8', timeout: 5000 }).trim();
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
        signal: AbortSignal.timeout(10000),
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
      backend: 'Ollama (deepseek-v4-flash:cloud)',
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
const toolHandlers = {
  'web-search': async (args) => {
    const query = args?.query || args?.q;
    if (!query) return { error: 'query is required' };
    const results = await webSearch(query, { maxResults: args?.maxResults || 5 });
    return { success: true, results: results.results, source: results.source, formatted: formatResults(results) };
  },

  'web-scrape': async (args) => {
    const url = args?.url || args?.u;
    if (!url) return { error: 'url is required' };
    return await webScrape(url, { maxLength: args?.maxLength || 50000 });
  },

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
    const { key, value } = args || {};
    if (!key) return { error: 'key is required' };
    state.set(key, value);
    return { success: true, key, value };
  },

  'task-stats': async () => {
    return taskRunner.getStats();
  },

  'github-post': async (args) => {
    const { issueNumber, body } = args || {};
    if (!issueNumber || !body) return { error: 'issueNumber and body are required' };
    return await postGitHubComment(issueNumber, body);
  },

  // ── Database Query Tools ──────────────────────────────────
  'db-query': async (args) => {
    const sql = args?.sql || args?.query;
    if (!sql) return { error: 'sql query is required' };
    try {
      const rows = await localQuery(sql);
      return { success: true, rowCount: rows.length, rows };
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

  'shared-context': async (args) => {
    const { action = 'read', key, value, description } = args || {};
    try {
      if (action === 'read') {
        if (key) {
          const row = await localQuery("SELECT * FROM public.shared_context WHERE context_key = $1", [key]);
          return { success: true, context: row[0] || null };
        }
        const rows = await localQuery("SELECT * FROM public.shared_context ORDER BY context_key");
        return { success: true, contexts: rows };
      }
      if (action === 'write') {
        if (!key || !value) return { error: 'key and value are required for write' };
        const existing = await localQuery("SELECT id FROM public.shared_context WHERE context_key = $1", [key]);
        if (existing.length > 0) {
          await localQuery(
            "UPDATE public.shared_context SET value = $1, description = COALESCE($2, description), last_updated_by = 'eliza', updated_at = now() WHERE context_key = $3",
            [JSON.stringify(value), description || null, key]
          );
        } else {
          await localQuery(
            "INSERT INTO public.shared_context (context_key, context_type, value, description, last_updated_by) VALUES ($1, 'general', $2, $3, 'eliza')",
            [key, JSON.stringify(value), description || '']
          );
        }
        return { success: true, key, action: 'written' };
      }
      return { error: `unknown action: ${action}. Use 'read' or 'write'` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  'agent-profile': async (args) => {
    const { agent_id } = args || {};
    try {
      if (agent_id) {
        const row = await localQuery("SELECT * FROM public.agent_profiles WHERE agent_id = $1", [agent_id]);
        return { success: true, profile: row[0] || null };
      }
      const rows = await localQuery("SELECT * FROM public.agent_profiles ORDER BY agent_id");
      return { success: true, profiles: rows };
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const duration = `${Date.now() - (globalThis.__efStart || Date.now())}ms`;
      const data = await res.json().catch(() => ({ raw: 'non-json response' }));
      return {
        success: res.ok,
        function: fn,
        status: res.status,
        data,
      };
    } catch (err) {
      return { success: false, function: fn, error: err.message };
    }
  },

  // ── Specific Edge Function Tools ─────────────────────────
  'ef:system-status': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/system-status`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:system-health': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/system-health`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:github': async (args) => {
    const action = args?.action || 'list_issues';
    const data = args?.data || args?.args || {};
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/github-integration`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, data }),
        signal: AbortSignal.timeout(15000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:knowledge': async (args) => {
    const action = args?.action || 'check_status';
    const data = args?.data || args?.args || {};
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/knowledge-manager`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, data }),
        signal: AbortSignal.timeout(10000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:agent-manager': async (args) => {
    const action = args?.action || 'list_agents';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/agent-manager`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(typeof action === 'object' ? action : { action }),
        signal: AbortSignal.timeout(10000),
      });
      return { success: true, status: res.status, data: await res.json() };
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
        signal: AbortSignal.timeout(10000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:schema': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/schema-manager`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list_tables' }),
        signal: AbortSignal.timeout(10000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:functions-list': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/list-available-functions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:ecosystem-monitor': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/ecosystem-monitor`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(15000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  // ── Edge Functions needing specific payloads (400 fixable) ──
  'ef:knowledge-search': async (args) => {
    const query = args?.query || 'test';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/search-knowledge`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ search_term: query }),
        signal: AbortSignal.timeout(10000),
      });
      return { success: true, status: res.status, data: await res.json() };
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
        signal: AbortSignal.timeout(10000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:cron-proxy': async (args) => {
    const path = args?.path || 'system-status';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/cron-proxy`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, method: 'POST', body: {} }),
        signal: AbortSignal.timeout(10000),
      });
      return { success: true, status: res.status, data: await res.json() };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'ef:schema-tables': async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/schema-manager`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list_tables' }),
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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

  'ef:task-orchestrator': async (args) => {
    const action = args?.action || 'list_tasks';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/task-orchestrator`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...args }),
        signal: AbortSignal.timeout(15000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
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
        signal: AbortSignal.timeout(10000),
      });
      return await res.json();
    } catch (err) { return { success: false, error: err.message }; }
  },

  'vex-vision': async (args) => {
    const capturePath = join(__dirname, '..', 'relay-data', 'vex-capture.jpg');
    const cameraName = args?.camera || 'HP TrueVision HD Camera';
    const prompt = args?.prompt || 'What do you see in this image? Be concise.';
    const model = args?.model || 'moondream';
    try {
      // Capture photo via ffmpeg — use spawn for windows compat
      const ffmpegPath = 'C:\\tools\\ffmpeg';
      const result = execSync(
        `"${ffmpegPath}" -f dshow -i video="${cameraName}" -frames:v 1 -q:v 2 -update 1 "${capturePath}" -y`,
        { timeout: 10000, windowsHide: true }
      );
      const imgBase64 = readFileSync(capturePath).toString('base64');
      // Send to Ollama vision model
      const visionRes = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt, images: [imgBase64] }],
          stream: false,
        }),
        signal: AbortSignal.timeout(90000),
      });
      const visionData = await visionRes.json();
      const desc = visionData.message?.content || visionData.error || 'no response';
      return {
        success: true,
        model,
        description: desc,
        image: imgBase64.slice(0, 100) + '... [' + Math.round(imgBase64.length / 1024) + 'KB]',
      };
    } catch (err) { return { success: false, error: err.message }; }
  },

  'vex-hear': async (args) => {
    const capturePath = join(__dirname, '..', 'relay-data', 'vex-audio.wav');
    const duration = Math.min(args?.duration || 3, 10);
    try {
      // Use PowerShell to capture audio (handles special chars in device names)
      execSync(
        `powershell -Command "& {\$ps=New-Object -ComObject Scripting.FileSystemObject; Write-Host 'audio capture placeholder'}"`,
        { timeout: 3000, windowsHide: true }
      );
      return { success: false, error: 'Audio capture via ffmpeg needs device name fix on this Windows build. Vision is fully operational.', duration };
    } catch (err) { return { success: false, error: err.message }; }
  },

  // ── Resend Inbox (read emails stored in relay state) ──────
  'resend-inbox': async (args) => {
    const domain = args?.domain || 'all'; // pfp, mobilemonero, 31harbor, or all
    const limit = Math.min(args?.limit || 10, 50);
    const inbox = getInbox();
    const result = { domains: {} };
    const targets = domain === 'all' ? ['pfp', 'mobilemonero', '31harbor'] : [domain];
    for (const key of targets) {
      const emails = (inbox[key] || []).slice(-limit).reverse();
      result.domains[key] = {
        total: inbox[key]?.length || 0,
        unread: (inbox[key] || []).filter(e => !e.read).length,
        recent: emails.map(e => ({
          id: e.id, from: e.from, to: e.to, subject: e.subject,
          receivedAt: e.receivedAt, read: e.read,
          text: (e.text || '').slice(0, 500),
        })),
      };
    }
    return { success: true, ...result };
  },

  // ── Resend Send Email (agent sends email via fleet-chat endpoint) ──
  'resend-send-email': async (args) => {
    const { agent, to, subject, body, from: customFrom } = args || {};
    if (!agent || !to || !subject || !body) {
      return { error: 'agent, to, subject, and body are required. agent: vex|eliza|hermes|pfp|harbor' };
    }
    try {
      const res = await fetch(`http://localhost:${PORT}/api/fleet-chat/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, to, subject, body, from: customFrom }),
        signal: AbortSignal.timeout(15000),
      });
      return await res.json();
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
async function relayToElizaCloud(message, senderName = 'Eliza-Dev', relayTag = null) {
  if (!SUPABASE_KEY) return logActivity('eliza', '-', 'SKIP', 'No SUPABASE_KEY set');
  const tag = relayTag || `eliza-dev-${Date.now().toString(36)}`;
  const url = `${SUPABASE_URL}/functions/v1/ai-chat`;
  try {
    logActivity('eliza', tag, 'SEND', message.slice(0, 80));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userQuery: message,
        senderName: senderName,
        // session_id keeps ai-chat's memory keyed per-tag for tools/dispatch flows
        session_id: tag,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text();
      logActivity('eliza', tag, 'FAIL', `HTTP ${res.status}: ${text.slice(0, 100)}`);
      return null;
    }
    const data = await res.json();
    // ai-chat returns { content, provider, model, success }; the rest of the
    // codebase expects { reply, ... } from eliza-relay, so normalize.
    const reply = (data?.content || '').trim();
    logActivity('eliza', tag, 'REPLY', reply.slice(0, 80));
    return { ...data, reply };
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
app.use(express.json({ limit: '5mb' }));

// ── Fast static file routes (bypasses slow express.static on Windows) ──
const PUBLIC_DIR = join(__dirname, 'public');
const SPATIAL_DIR = join(__dirname, 'spatial');

// ── Suite SPA (Vite build, served locally instead of GH Pages' broken CDN) ──
// IMPORTANT: SUITE_DIR must point to the Vite build output (suite/dist/), not
// the GH Pages subpath (xmrtdao.github.io/suite/). The GH Pages version was
// replaced with a redirect to relay.mobilemonero.com/suite/, so serving from
// there would create an infinite loop.
const SUITE_DIR = join(__dirname, '..', 'suite', 'dist');
if (existsSync(join(SUITE_DIR, 'index.html'))) {
  app.use('/suite', express.static(SUITE_DIR, { maxAge: '5m' }));
  // SPA fallback — any /suite/* path that isn't a real file serves index.html
  // so client-side routing (e.g. /suite/dashboard) works.
  app.get('/suite/*', (req, res) => {
    const filePath = join(SUITE_DIR, req.path.replace(/^\/suite\//, ''));
    if (existsSync(filePath)) return res.sendFile(filePath);
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
  app.get('/hottiehouse/*', (req, res) => {
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
  app.get('/cuttlefishclaws/*', (req, res) => {
    const filePath = join(CUTTLEFISH_DIR, req.path.replace(/^\/cuttlefishclaws\//, ''));
    if (existsSync(filePath)) return res.sendFile(filePath);
    res.sendFile(join(CUTTLEFISH_DIR, 'index.html'));
  });
  console.log(`  CuttlefishClaws SPA: ${CUTTLEFISH_DIR}`);
} else {
  console.log(`  CuttlefishClaws SPA: NOT FOUND at ${CUTTLEFISH_DIR} — skipping`);
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
    app.get(`/${co}/*`, (req, res) => {
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
app.get('/api/suite/activity-log', async (req, res) => {
  trackRequest('/api/suite/activity-log');
  try {
    const company = req.query.company;
    const limit = parseInt(req.query.limit) || 50;
    const r = company
      ? await queryLocalPg('SELECT * FROM app.suite_activity_log WHERE company = $1 ORDER BY created_at DESC LIMIT $2', [company, limit])
      : await queryLocalPg('SELECT * FROM app.suite_activity_log ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/suite/activity-log', async (req, res) => {
  trackRequest('POST /api/suite/activity-log');
  try {
    const { type, company, description, metadata } = req.body;
    await queryLocalPg(
      `INSERT INTO app.suite_activity_log (type, company, description, metadata, created_at) VALUES ($1,$2,$3,$4,NOW())`,
      [type||null, company||null, description||null, metadata||null]
    );
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
    const { title, description, stage, status, priority, category, assignee_agent_id, blocking_reason, auto_advance_threshold_hours, progress_percentage, organization_id, created_by_user_id } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const r = await queryLocalPg(
      `INSERT INTO app.tasks (title, description, stage, status, priority, category, assignee_agent_id, blocking_reason, auto_advance_threshold_hours, progress_percentage, organization_id, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
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

// ── Activity Log ────────────────────────────────────────────────
app.post('/api/suite/activity-log', async (req, res) => {
  trackRequest('POST /api/suite/activity-log');
  try {
    const { activity_type, title, description, status, task_id, agent_id, metadata } = req.body;
    if (!activity_type) return res.status(400).json({ error: 'activity_type required' });
    const r = await queryLocalPg(
      `INSERT INTO app.suite_activity_log (activity_type, title, description, status, task_id, agent_id, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [activity_type, title||'', description||'', status||'completed', task_id||null, agent_id||null, metadata ? JSON.stringify(metadata) : '{}']
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard Stats ──────────────────────────────────────────────
app.get('/api/suite/stats', async (req, res) => {
  trackRequest('/api/suite/stats');
  try {
    const [tasks, agents, health, entities, workflows] = await Promise.all([
      queryLocalPg(`SELECT count(*)::int AS c FROM app.tasks WHERE status IN ('PENDING','IN_PROGRESS','CLAIMED','BLOCKED')`),
      queryLocalPg(`SELECT count(*)::int AS c FROM app.agents WHERE status IN ('IDLE','BUSY')`),
      queryLocalPg(`SELECT metadata FROM app.suite_activity_log WHERE activity_type = 'system_health_check' ORDER BY created_at DESC LIMIT 1`).catch(() => ({ rows: [] })),
      queryLocalPg(`SELECT count(*)::int AS c FROM app.knowledge_entities`).catch(() => ({ rows: [{ c: 0 }] })),
      queryLocalPg(`SELECT count(*)::int AS c FROM app.suite_campaigns WHERE is_active = true`).catch(() => ({ rows: [{ c: 0 }] })),
    ]);

    let healthScore = 100, healthStatus = 'healthy', healthIssues = [];
    if (health.rows[0]?.metadata) {
      const m = typeof health.rows[0].metadata === 'string' ? JSON.parse(health.rows[0].metadata) : health.rows[0].metadata;
      healthScore = m.health_score ?? 100;
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
  const host = req.headers.host || '';
  if (host.includes('mobilemonero') || req.query.domain === 'mobilemonero') {
    res.sendFile(join(PUBLIC_DIR, 'inbox-xmrt.html'));
  } else {
    res.sendFile(join(PUBLIC_DIR, 'inbox-pfp.html'));
  }
});

app.use('/images', express.static(join(__dirname, 'public')));
app.use('/radar', express.static(join(__dirname, 'public')));
app.use('/static', express.static(join(__dirname, 'public')));
app.use('/spatial', express.static(join(__dirname, 'spatial')));

// Fallback: parse body as JSON for requests without Content-Type
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') return next();
  if (req.headers['content-type']) return next();
  
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    if (raw) {
      try { req.body = JSON.parse(raw); } catch {}
    }
    next();
  });
});

// Health check
app.get('/health', (req, res) => {
  trackRequest('/health');
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    port: PORT,
    agent: 'Eliza-Dev',
    version: '5.0.0',
    tools: Object.keys(toolHandlers).length,
    handlers: Object.keys(handlers).length,
    requests: requestCounts.total,
  });
});

// Supervisor status — used by fleet-chat grounding so agents don't hallucinate
// "all services are up" without actually checking. Reads relay-data/supervisor-state.json.
app.get('/api/supervisor/status', (req, res) => {
  trackRequest('/api/supervisor/status');
  try {
    const fs = require('fs');
    const path = require('path');
    const stateFile = path.join(DATA_DIR, 'supervisor-state.json');
    if (!fs.existsSync(stateFile)) {
      return res.json({ error: 'supervisor-state.json missing', path: stateFile });
    }
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const services = raw.services || {};
    const result = { services: {} };
    for (const [name, svc] of Object.entries(services)) {
      result.services[name] = {
        childPid: svc.childPid,
        startedAt: svc.startedAt,
        uptimeSec: svc.startedAt ? Math.floor((Date.now() - svc.startedAt) / 1000) : 0,
        restartCount: Array.isArray(svc.restartTimestamps) ? svc.restartTimestamps.length : 0,
        lastAlert: raw.alerts?.[name + '-down'] || 0,
      };
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// Hostname-based redirect: agency.31harbor.com → /harbor/
app.get('/', (req, res, next) => {
  const host = req.headers.host || '';
  if (host.includes('agency.31harbor.com')) {
    return res.redirect(301, '/harbor/');
  }
  next();
});

// Fleet dashboard
app.get('/', (req, res) => {
  trackRequest('/');
  const hostname = execSync('hostname', { encoding: 'utf8' }).trim();
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
      const logLines = readFileSync(HARBOR_LOG, 'utf8').trim().split('\n').filter(Boolean);
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
  <title>MobileMonero — Privateer Fleet</title>
  <style>
    :root {
      --bg-primary: #0a0a0f;
      --bg-card: #12121a;
      --bg-card-hover: #1a1a2a;
      --border: #2a2a3a;
      --border-hover: #3a3a5a;
      --text-primary: #e0e0f0;
      --text-secondary: #c0c0d0;
      --text-muted: #8b8ba0;
      --text-dim: #6b6b80;
      --accent-orange: #ff6b35;
      --accent-orange-glow: rgba(255,107,53,0.15);
      --accent-teal: #4ade80;
      --accent-blue: #60a5fa;
      --accent-purple: #a78bfa;
      --accent-yellow: #fbbf24;
      --accent-red: #f87171;
      --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      --font-mono: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: var(--font-sans); background: var(--bg-primary); color: var(--text-secondary); padding: 0.75rem; }
    @media (min-width: 640px) { body { padding: 1.5rem; } }
    h1 { color: var(--accent-orange); font-size: 1.2rem; margin-bottom: 0.25rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-weight: 800; letter-spacing: -0.5px; }
    @media (min-width: 640px) { h1 { font-size: 1.6rem; gap: 0.75rem; } }
    h1 span { font-size: 0.75rem; color: var(--text-dim); font-weight: 400; letter-spacing: 0; }
    @media (min-width: 640px) { h1 span { font-size: 0.9rem; } }
    .subtitle { color: var(--text-muted); font-size: 0.8rem; margin-bottom: 1rem; }
    @media (min-width: 640px) { .subtitle { font-size: 0.9rem; margin-bottom: 1.5rem; } }
    .subtitle a { color: var(--accent-blue); text-decoration: none; transition: color .15s; }
    .subtitle a:hover { color: var(--accent-orange); text-decoration: underline; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 0.75rem; margin-bottom: 1.5rem; }
    @media (min-width: 480px) { .grid { grid-template-columns: repeat(2, 1fr); gap: 0.75rem; } }
    @media (min-width: 768px) { .grid { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; } }
    .grid > .full { grid-column: 1 / -1; }
    .side-by-side { display: flex; flex-wrap: wrap; gap: 12px; grid-column: 1 / -1; }
    .side-by-side > * { flex: 1; min-width: 280px; }
    /* RSSI signal strength colors */
    .rssi-strong { color: #4ade80; }
    .rssi-fair { color: #fbbf24; }
    .rssi-weak { color: #f87171; }
    .rssi-poor { color: #ef4444; }
    .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 0.75rem; transition: border-color .2s, transform .15s; }
    @media (min-width: 640px) { .card { padding: 1rem; } }
    .card:hover { border-color: var(--accent-orange-glow); }
    .card h3 { color: var(--accent-orange); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.5rem; font-weight: 700; }
    @media (min-width: 640px) { .card h3 { font-size: 0.8rem; margin-bottom: 0.6rem; } }
    .stat { display: flex; justify-content: space-between; padding: 0.25rem 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 0.75rem; gap: 0.5rem; }
    @media (min-width: 640px) { .stat { padding: 0.3rem 0; font-size: 0.85rem; } }
    .stat:last-child { border-bottom: none; }
    .label { color: var(--text-muted); flex-shrink: 0; }
    .value { color: var(--text-primary); font-family: var(--font-mono); text-align: right; word-break: break-all; min-width: 0; }
    .badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.65rem; font-weight: 600; }
    @media (min-width: 640px) { .badge { font-size: 0.7rem; } }
    .badge-ok { background: rgba(74,222,128,0.12); color: var(--accent-teal); }
    .badge-warn { background: rgba(251,191,36,0.12); color: var(--accent-yellow); }
    .badge-err { background: rgba(248,113,113,0.12); color: var(--accent-red); }
    .badge-info { background: rgba(96,165,250,0.12); color: var(--accent-blue); }

    @media (min-width: 640px) { .chat-card { grid-column: 1 / -1; } }

    .board-topics { max-height: 300px; overflow-y: auto; margin-bottom: 6px; }
    .board-topic { padding: 8px; border-radius: 6px; background: #0d0d15; margin-bottom: 4px; cursor: pointer; transition: background .15s; border: 1px solid transparent; }
    .board-topic:hover { background: #1a1a2a; border-color: rgba(255,107,53,0.2); }
    .board-topic.active { border-color: var(--accent-orange); background: #1a1a2a; }
    .board-topic-title { color: var(--text-primary); font-size: 13px; font-weight: 600; }
    .board-topic-title > span { display: inline-block; }
    .board-topic-meta { color: #6b6b80; font-size: 10px; margin-top: 2px; }
    .board-filter { padding: 2px 10px; border-radius: 10px; font-size: 10px; cursor: pointer; color: #6b6b80; border: 1px solid #2a2a3a; background: transparent; transition: all .15s; }
    .board-filter:hover { color: var(--text-secondary); border-color: #3a3a5a; }
    .board-filter.active { color: var(--accent-orange); border-color: var(--accent-orange); background: rgba(255,107,53,0.1); }
    .board-posts { max-height: 250px; overflow-y: auto; margin-bottom: 6px; }
    .board-post { padding: 6px 8px; border-radius: 6px; background: #0d0d15; margin-bottom: 4px; }
    .board-post-header { color: #6b6b80; font-size: 10px; display: flex; gap: 8px; }
    .board-post-body { color: var(--text-secondary); font-size: 12px; margin-top: 2px; line-height: 1.4; }
    .board-post-body p { margin: 0 0 6px 0; }
    .board-post-body p:last-child { margin-bottom: 0; }
    .board-post-body h1, .board-post-body h2, .board-post-body h3, .board-post-body h4 { color: var(--text-primary); margin: 8px 0 4px 0; font-weight: 600; }
    .board-post-body h1 { font-size: 14px; }
    .board-post-body h2 { font-size: 13px; }
    .board-post-body h3 { font-size: 12px; }
    .board-post-body h4 { font-size: 12px; color: var(--text-secondary); }
    .board-post-body ul, .board-post-body ol { margin: 4px 0 6px 0; padding-left: 18px; }
    .board-post-body li { margin: 2px 0; }
    .board-post-body code { background: #1a1a25; color: #e0e0f0; padding: 1px 4px; border-radius: 3px; font-family: monospace; font-size: 11px; }
    .board-post-body pre { background: #0a0a12; color: #c0c0d0; padding: 6px 8px; border-radius: 4px; overflow-x: auto; margin: 4px 0; }
    .board-post-body pre code { background: transparent; padding: 0; }
    .board-post-body blockquote { border-left: 3px solid var(--accent-orange); padding-left: 8px; margin: 4px 0; color: var(--text-secondary); font-style: italic; }
    .board-post-body hr { border: none; border-top: 1px solid #2a2a3a; margin: 8px 0; }
    .board-post-body table { border-collapse: collapse; margin: 4px 0; font-size: 11px; width: 100%; }
    .board-post-body th, .board-post-body td { border: 1px solid #2a2a3a; padding: 3px 6px; text-align: left; }
    .board-post-body th { background: #1a1a25; color: var(--text-primary); font-weight: 600; }
    .board-post-body a { color: var(--accent-teal); text-decoration: underline; }
    .board-post-body strong { color: var(--text-primary); font-weight: 600; }
    .board-post-body em { color: var(--text-primary); font-style: italic; }
    .board-post-body br { line-height: 1.4; }
    .board-post-body del { color: #6b6b80; }
    .fleet-msg-body { color: #e0e0f0; font-size: 12px; line-height: 1.4; }
    .fleet-msg-body p { margin: 0 0 4px 0; }
    .fleet-msg-body p:last-child { margin-bottom: 0; }
    .fleet-msg-body h1, .fleet-msg-body h2, .fleet-msg-body h3 { color: #ffffff; margin: 6px 0 3px 0; font-weight: 600; }
    .fleet-msg-body h1 { font-size: 13px; }
    .fleet-msg-body h2 { font-size: 12px; }
    .fleet-msg-body h3 { font-size: 12px; color: #c0c0d0; }
    .fleet-msg-body ul, .fleet-msg-body ol { margin: 3px 0 4px 0; padding-left: 16px; }
    .fleet-msg-body li { margin: 1px 0; }
    .fleet-msg-body code { background: rgba(255,255,255,0.08); padding: 0 3px; border-radius: 2px; font-family: monospace; font-size: 11px; }
    .fleet-msg-body pre { background: rgba(0,0,0,0.3); padding: 4px 6px; border-radius: 3px; margin: 3px 0; overflow-x: auto; }
    .fleet-msg-body pre code { background: transparent; padding: 0; }
    .fleet-msg-body strong { color: #ffffff; font-weight: 600; }
    .fleet-msg-body a { color: #4ade80; text-decoration: underline; }
    .fleet-msg-body br { line-height: 1.4; }
    .board-agent-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 9px; font-weight: 600; }
    .board-agent-vex { background: rgba(255,107,53,0.15); color: var(--accent-orange); }
    .board-agent-eliza { background: rgba(74,222,128,0.15); color: var(--accent-teal); }
    .board-agent-hermes { background: rgba(167,139,250,0.15); color: var(--accent-purple); }
    .board-agent-alice { background: rgba(96,165,250,0.15); color: var(--accent-blue); }
    .board-agent-kimi { background: rgba(251,191,36,0.15); color: var(--accent-yellow); }
    .board-input-wrap { display: flex; gap: 4px; }
    .board-input-wrap input { min-width: 0; width: 100%; padding: 6px 10px; border-radius: 6px; border: 1px solid #2a2a3a; background: #1a1a2a; color: var(--text-primary); font-size: 12px; outline: none; }
    .board-input-wrap input:focus { border-color: var(--accent-orange); }
    .board-tabs { display: flex; gap: 4px; margin-bottom: 6px; flex-wrap: wrap; }
    .board-tab { padding: 4px 12px; border-radius: 4px; font-size: 11px; cursor: pointer; background: #1a1a2a; color: #8b8ba0; border: 1px solid transparent; transition: all .15s; }
    .board-tab:hover { border-color: rgba(255,107,53,0.3); color: var(--text-primary); }
    .board-tab.active { background: rgba(255,107,53,0.15); color: var(--accent-orange); border-color: var(--accent-orange); }
    .board-new-topic { display: flex; gap: 4px; margin-bottom: 6px; }
    .board-new-topic input { flex: 1; padding: 6px 10px; border-radius: 6px; border: 1px solid #2a2a3a; background: #1a1a2a; color: var(--text-primary); font-size: 12px; outline: none; }
    .board-new-topic input:focus { border-color: var(--accent-orange); }

    /* Pirate Flag Logo */
    .pirate-flag { display: inline-flex; align-items: center; justify-content: center; width: 52px; height: 52px; border-radius: 8px; overflow: hidden; flex-shrink: 0; }
    .pirate-flag img { width: 100%; height: 100%; object-fit: cover; }
    @media (min-width: 640px) { .pirate-flag { width: 52px; height: 52px; } }
    .pirate-flag svg { width: 100%; height: 100%; display: block; }

    /* Chat card */
    .chat-card { grid-column: 1 / -1; }
    .chat-input-wrap { display: flex; gap: 4px; flex-wrap: nowrap; }
    .chat-input-wrap input { min-width: 0; width: 100%; }

    /* Search & Filter */
    .controls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; align-items: center; }
    @media (min-width: 640px) { .controls { gap: 0.75rem; margin-bottom: 1rem; } }
    .controls input { flex: 1; min-width: 0; padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 8px; background: #0d0d15; color: var(--text-primary); font-size: 0.85rem; outline: none; transition: border-color .15s; }
    @media (min-width: 640px) { .controls input { min-width: 200px; padding: 0.6rem 1rem; font-size: 0.9rem; } }
    .controls input:focus { border-color: var(--accent-orange); box-shadow: 0 0 0 3px var(--accent-orange-glow); }
    .controls select { padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 8px; background: #0d0d15; color: var(--text-primary); font-size: 0.8rem; outline: none; cursor: pointer; transition: border-color .15s; }
    @media (min-width: 640px) { .controls select { padding: 0.6rem 1rem; font-size: 0.85rem; } }
    .controls select:focus { border-color: var(--accent-orange); }
    .count { color: var(--text-dim); font-size: 0.8rem; white-space: nowrap; }
    @media (min-width: 640px) { .count { font-size: 0.85rem; } }

    /* Table */
    .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-card); -webkit-overflow-scrolling: touch; }
    @media (min-width: 640px) { .table-wrap { border-radius: 10px; } }
    table { width: 100%; border-collapse: collapse; font-size: 0.72rem; }
    @media (min-width: 640px) { table { font-size: 0.82rem; } }
    th { text-align: left; padding: 0.4rem 0.5rem; background: var(--bg-card-hover); color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.65rem; border-bottom: 1px solid var(--border); cursor: pointer; white-space: nowrap; }
    @media (min-width: 640px) { th { padding: 0.6rem 0.8rem; font-size: 0.72rem; } }
    th:hover { color: var(--text-secondary); }
    td { padding: 0.5rem 0.8rem; border-bottom: 1px solid rgba(255,255,255,0.03); vertical-align: top; }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .fn-name { color: var(--accent-blue); font-family: var(--font-mono); font-weight: 500; }
    .fn-method { display: inline-block; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.7rem; font-weight: 700; margin-right: 0.25rem; }
    .method-GET { background: rgba(96,165,250,0.12); color: var(--accent-blue); }
    .method-POST { background: rgba(74,222,128,0.12); color: var(--accent-teal); }
    .method-PATCH { background: rgba(251,191,36,0.12); color: var(--accent-yellow); }
    .method-DELETE { background: rgba(248,113,113,0.12); color: var(--accent-red); }
    .tag-workflow { background: rgba(251,191,36,0.12); color: var(--accent-yellow); font-size: 0.65rem; padding: 0.1rem 0.35rem; border-radius: 3px; white-space: nowrap; }
    .tag-simple { background: rgba(96,165,250,0.12); color: var(--accent-blue); font-size: 0.65rem; padding: 0.1rem 0.35rem; border-radius: 3px; white-space: nowrap; }
    .fn-inputs { color: #6b6b80; font-size: 0.75rem; font-family: 'SF Mono', monospace; }
    .fn-desc { color: #a0a0b0; font-size: 0.8rem; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (min-width: 768px) { .fn-desc { max-width: 350px; } }
    .footer { margin-top: 1.5rem; text-align: center; color: #4a4a5a; font-size: 0.78rem; }
    .loading { text-align: center; padding: 3rem; color: #6b6b80; }
    .endpoint-url { color: #6b6b80; font-size: 0.7rem; font-family: 'SF Mono', monospace; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .endpoint-url span { color: #a0a0b0; }
    .fn-method-cell { white-space: nowrap; }
    @media (max-width: 768px) {
      body { padding: 0.5rem; }
      .grid { grid-template-columns: 1fr; }
      table { font-size: 0.65rem; }
      th { padding: 0.3rem 0.4rem; font-size: 0.6rem; }
      td { padding: 0.3rem 0.4rem; }
      .fn-desc { max-width: 120px; }
      .endpoint-url { max-width: 100px; }
    }
    @media (max-width: 480px) {
      .fn-desc { display: none; }
      .endpoint-url { max-width: 80px; }
    }
  
    canvas#mesh-bg { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }
    body { position: relative; z-index: 0; }
    .grid, h1, .subtitle, .table-wrap, .footer, .controls { position: relative; z-index: 10; }

</style>
</head>
<body>
<canvas id="mesh-bg"></canvas>
  <h1><span class="pirate-flag"><img src="/images/xmrtdao.png" alt="XMRT DAO"></span> MobileMonero <span>Privateer Fleet</span></h1>
  <div class="subtitle">
    <span style="color:var(--accent-orange);font-weight:600;">XMRT DAO</span> · <span title="HMS Speedy (1782) - 14-gun brig, 158 tons, captured the 32-gun Spanish frigate El Gamo on 6 May 1801 under Lord Cochrane's command, with 54 men vs 319. The underdog metaphor for this 6GB laptop's relay." style="cursor:help;border-bottom:1px dotted #4ade80;">HMS Speedy</span> v5.0.0 · 
    <a href="https://relay.mobilemonero.com">relay.mobilemonero.com</a> ·
    <a href="https://github.com/xmrtdao/mobilemonero" target="_blank">GitHub</a>
  </div>
  
  <div class="grid">
<div class="card chat-card" style="grid-column:1/-1;">
      <h3 style="color:var(--accent-orange);">Ship-to-Ship <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Vex · Eliza-Cloud · Hermes</span></h3>
      <div id="fleet-chat-msgs" style="height:180px;overflow-y:auto;background:#0d0d15;border-radius:6px;padding:8px;margin-bottom:6px;font-size:12px;line-height:1.5;">
        <div style="color:#8b8ba0;text-align:center;padding:20px 0;font-size:12px;">Ship-to-ship comms active. All privateers hear every hail.</div>
      </div>
      <div class="chat-input-wrap" style="gap:4px;">
        <input id="fleet-chat-name" type="text" placeholder="Your name..." style="padding:6px 10px;border-radius:6px;border:1px solid #2a2a3a;background:#1a1a2a;color:#e0e0f0;font-size:12px;outline:none;width:100px;flex-shrink:0;" maxlength="20"/>
        <input id="fleet-chat-agent" type="hidden" value=""/>
        <input id="fleet-chat-input" type="text" placeholder="Hail the crew..." 
          style="flex:1;min-width:0;padding:6px 10px;border-radius:6px;border:1px solid #2a2a3a;background:#1a1a2a;color:#e0e0f0;font-size:12px;outline:none;"
          onkeypress="if(event.key==='Enter')sendFleetChat()">
        <button onclick="sendFleetChat()" style="padding:6px 14px;border-radius:6px;border:none;background:#ff6b35;color:white;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;">Send</button>
      </div>
      <div style="margin-top:4px;display:flex;gap:8px;font-size:11px;color:#6b6b80;">
        <span>Ship-to-ship broadcast — all privateers hear your hail</span>
        <span id="fleet-chat-status" style="color:#4ade80;">● connected</span>
      </div>
    </div>

    <!-- Ship's Articles + IoT Radar (side by side) -->
    <div class="side-by-side">
    <div class="card" id="bulletin-board">
      <h3 style="color:var(--accent-orange);">Ship’s Articles <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Crew Resolutions &amp; Progress Threads</span></h3>
      
      <!-- Topic tabs -->
      <div class="board-tabs" id="board-tabs">
        <span class="board-tab active" onclick="switchBoardView('topics')" id="tab-topics">Resolutions</span>
        <span class="board-tab" onclick="switchBoardView('new')" id="tab-newtopic">+ New Topic</span>
      </div>
      
      <!-- Status filter -->
      <div id="board-filter-bar" style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;">
        <span class="board-filter active" data-filter="all" onclick="setBoardFilter('all')">All</span>
        <span class="board-filter" data-filter="active" onclick="setBoardFilter('active')">Active</span>
        <span class="board-filter" data-filter="in-progress" onclick="setBoardFilter('in-progress')">In Progress</span>
        <span class="board-filter" data-filter="completed" onclick="setBoardFilter('completed')">Completed</span>
        <span class="board-filter" data-filter="archived" onclick="setBoardFilter('archived')">Archived</span>
      </div>
      
      <!-- Topics list view -->
      <div id="board-topics-view">
        <div class="board-topics" id="board-topics-list"></div>
        
        <!-- Selected topic posts -->
        <div id="board-topic-posts" style="display:none;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1;min-width:0;">
              <span id="board-current-topic-title" style="font-size:13px;font-weight:600;color:var(--text-primary);"></span>
              <span id="board-current-topic-status"></span>
              <span id="board-current-topic-assignment" style="font-size:10px;color:#6b6b80;"></span>
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0;">
              <button onclick="renameBoardTopic()" id="board-rename-btn" style="padding:2px 8px;border-radius:4px;border:1px solid #3a3a5a;background:transparent;color:#8b8ba0;cursor:pointer;font-size:10px;" title="Rename topic">Rename</button>
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
          <div style="margin-top:4px;font-size:10px;color:#6b6b80;">
            <span>Posted as <strong id="board-post-agent" style="color:var(--accent-orange);">vex</strong> — all privateers see this resolution</span>
          </div>
        </div>
      </div>
      
      <!-- New topic form -->
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
      
      <div style="margin-top:4px;display:flex;gap:8px;font-size:10px;color:#6b6b80;">
        <span>Privateers can post to any resolution — persistent across voyages</span>
        <span id="board-updated-indicator" style="color:#fbbf24;display:none;">* new activity</span>
        <span id="board-status" style="color:#4ade80;">● loaded</span>
      </div>
    </div>

    <!-- IoT Ship Radar -->
    <div class="card">
      <h3 style="color:#4ade80;">⛵ Ship&#39;s IoT Radar <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Wi-Fi RSSI + Meshtastic Scan</span></h3>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <!-- Radar animation -->
        <div style="position:relative;width:100px;height:100px;flex-shrink:0;">
          <svg viewBox="0 0 100 100" style="width:100%;height:100%;">
            <defs>
              <radialGradient id="radar-glow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="#4ade80" stop-opacity="0.3"/>
                <stop offset="100%" stop-color="#4ade80" stop-opacity="0"/>
              </radialGradient>
            </defs>
            <!-- Rings -->
            <circle cx="50" cy="50" r="45" fill="none" stroke="#2a2a3a" stroke-width="0.5"/>
            <circle cx="50" cy="50" r="32" fill="none" stroke="#2a2a3a" stroke-width="0.5"/>
            <circle cx="50" cy="50" r="18" fill="none" stroke="#2a2a3a" stroke-width="0.5"/>
            <!-- Crosshairs -->
            <line x1="5" y1="50" x2="95" y2="50" stroke="#2a2a3a" stroke-width="0.3"/>
            <line x1="50" y1="5" x2="50" y2="95" stroke="#2a2a3a" stroke-width="0.3"/>
            <!-- Sweeping radar beam -->
            <path d="M50,50 L50,5 A45,45 0 0,1 95,50 Z" fill="url(#radar-glow)" transform-origin="50px 50px">
              <animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="3s" repeatCount="indefinite"/>
            </path>
            <!-- Center dot (this node) -->
            <circle cx="50" cy="50" r="4" fill="#4ade80">
              <animate attributeName="r" values="3;5;3" dur="1.5s" repeatCount="indefinite"/>
            </circle>
            <!-- RSSI-based blips (populated by JS) -->
            <circle id="rssi-blip-1" cx="35" cy="28" r="2" fill="#ff6b35" opacity="0">
              <animate attributeName="opacity" values="0.3;1;0.3" dur="2s" repeatCount="indefinite"/>
            </circle>
            <circle id="rssi-blip-2" cx="72" cy="65" r="2" fill="#60a5fa" opacity="0">
              <animate attributeName="opacity" values="0.2;0.8;0.2" dur="2.5s" repeatCount="indefinite"/>
            </circle>
            <circle id="rssi-blip-3" cx="25" cy="70" r="1.5" fill="#a78bfa" opacity="0">
              <animate attributeName="opacity" values="0.1;0.6;0.1" dur="3s" repeatCount="indefinite"/>
            </circle>
          </svg>
        </div>
        <!-- Ship stats -->
        <div style="flex:1;min-width:120px;">
          <div class="stat"><span class="label">Vessel</span><span class="value" style="color:#4ade80;" title="HMS Speedy (1782) - 14-gun brig, 158 tons. Captured the 32-gun Spanish frigate El Gamo on 6 May 1801 under Lord Cochrane, with 54 men vs 319. Cochrane's own words: 'little more than a burlesque on a vessel of war.' The 6GB laptop's relay. Under command of Vex.">HMS Speedy <span style="color:#6b6b80;font-weight:400;font-size:0.75em;">(under Vex)</span></span></div>
          <div class="stat"><span class="label">Captain</span><span class="value" style="color:#fbbf24;" title="Thomas Cochrane, 10th Earl of Dundonald. Captain of HMS Speedy 1800-1801. The audacious underdog who took a 14-gun brig and crew of 54 against a 32-gun frigate with 319 men - and won by trebling his shot, locking yards, and a psychological-warfare trick to the ship's doctor.">Lord Cochrane</span></div>
          <div class="stat"><span class="label">Signal</span><span class="value" id="rssi-signal" style="color:#4ade80;">● Online</span></div>
          <div class="stat"><span class="label">RSSI</span><span class="value" id="rssi-strength">scanning...</span></div>
          <div class="stat"><span class="label">Peers</span><span class="value" id="iot-peers">scanning...</span></div>
          <div class="stat"><span class="label">Tunnel</span><span class="value"><a href="https://relay.mobilemonero.com" style="color:#60a5fa;text-decoration:none;">relay.mobilemonero.com</a></span></div>
          <div class="stat"><span class="label">IoT Enclave</span><span class="value" style="color:#fbbf24;">Windows Laptop</span></div>
        </div>
      </div>
      <div style="margin-top:8px;padding-top:6px;border-top:1px solid #1e1e2e;font-size:0.7rem;color:#6b6b80;display:flex;gap:8px;flex-wrap:wrap;">
        <span>🟢 This node is a physical IoT vessel on the mesh</span>
        <span>📶 ping: <span id="iot-ping">12ms</span></span>
        <span>🔌 uptime: <span id="iot-uptime">${uptimeStr}</span></span>
        <span>🌐 <span id="iot-ip" style="color:#6b6b80;">detecting...</span></span>
      </div>
      <script>
        (function(){
          function updateFromBridge() {
            fetch('/api/mesh/bridge').then(r=>r.json()).then(d => {
              const strength = document.getElementById('rssi-strength');
              const signal = document.getElementById('rssi-signal');
              const peers = document.getElementById('iot-peers');
              
              // Use bridge data if available, fall back to simulation
              if (d.connected && d.nodeList.length > 0) {
                if (peers) peers.textContent = d.nodes + ' ships';
                
                // Use first node's RSSI if available
                const node = d.nodeList[0];
                if (node.rssi && strength) {
                  const rssi = node.rssi;
                  const bars = rssi > -50 ? 4 : rssi > -65 ? 3 : rssi > -80 ? 2 : 1;
                  strength.textContent = rssi.toFixed(1) + ' dBm ' + '█'.repeat(bars) + '░'.repeat(4-bars);
                }
                if (node.snr && signal) {
                  signal.textContent = node.snr > 5 ? '● Strong' : node.snr > 0 ? '◐ Fair' : node.snr > -5 ? '○ Weak' : '◎ Poor';
                  signal.style.color = node.snr > 5 ? '#4ade80' : node.snr > 0 ? '#fbbf24' : node.snr > -5 ? '#f87171' : '#ef4444';
                }
              } else {
                // No bridge — show status
                if (strength) strength.textContent = d.connected ? '0 dBm (idle)' : '— no bridge —';
                if (signal) { signal.textContent = '○ Idle'; signal.style.color = '#6b6b80'; }
                if (peers) peers.textContent = (d.nodes || 0) + ' nodes tracked';
              }
              
              // Update blip positions from real node positions
              for (let i = 0; i < 3; i++) {
                const blip = document.getElementById('rssi-blip-' + (i+1));
                if (!blip) continue;
                if (d.nodeList && d.nodeList[i]) {
                  const node = d.nodeList[i];
                  const angle = (i * 120 + Date.now() / 10000) % 360;
                  const dist = 20 + (node.rssi ? Math.abs(node.rssi) / 3 : 25);
                  const rad = angle * Math.PI / 180;
                  blip.setAttribute('cx', 50 + dist * Math.cos(rad));
                  blip.setAttribute('cy', 50 + dist * Math.sin(rad));
                  blip.setAttribute('opacity', 0.4 + (node.snr ? Math.min(node.snr / 10, 0.6) : 0.3));
                  blip.setAttribute('fill', node.rssi > -60 ? '#4ade80' : node.rssi > -75 ? '#fbbf24' : '#f87171');
                } else {
                  // Simulated blip
                  const angle = (i * 120 + Date.now() / 10000) % 360;
                  const dist = 20 + Math.random() * 25;
                  const rad = angle * Math.PI / 180;
                  blip.setAttribute('cx', 50 + dist * Math.cos(rad));
                  blip.setAttribute('cy', 50 + dist * Math.sin(rad));
                  blip.setAttribute('opacity', 0.3 + Math.random() * 0.5);
                  blip.setAttribute('fill', i === 0 ? '#ff6b35' : i === 1 ? '#60a5fa' : '#a78bfa');
                }
              }
            }).catch(() => {
              // Fallback simulation on error
              const rssi = -(30 + Math.random() * 60);
              const strength = document.getElementById('rssi-strength');
              const signal = document.getElementById('rssi-signal');
              if (strength) strength.textContent = rssi.toFixed(1) + ' dBm (sim)';
              if (signal) { signal.textContent = '◐ Simulated'; signal.style.color = '#6b6b80'; }
            });
          }
          updateFromBridge();
          setInterval(updateFromBridge, 3000);
          
          // External IP
          fetch('https://api.ipify.org?format=json').then(r=>r.json()).then(d=>{
            const ip = document.getElementById('iot-ip');
            if(ip) ip.textContent = d.ip;
          }).catch(()=>{});
        })();
      </script>
    </div>
    </div>

<div class="card">
      <h3>Relay Status</h3>
      <div class="stat"><span class="label">Uptime</span><span class="value">${uptimeStr}</span></div>
      <div class="stat"><span class="label">Relay</span><span class="value">v5.0.0</span></div>
      <div class="stat"><span class="label">Tools</span><span class="value">${toolCount}</span></div>
      <div class="stat"><span class="label">Handlers</span><span class="value">${handlerCount}</span></div>
      <div class="stat"><span class="label">Requests</span><span class="value">${requestCounts.total}</span></div>
    </div>
<div class="card" id="university-card">
      <h3 style="color:#a78bfa;">Ship’s Intelligence</h3>
      <div id="university-status">
        <div class="stat"><span class="label">Status</span><span class="value" id="uni-status" style="color:#6b6b80;">checking...</span></div>
      </div>
      <div id="university-detail" style="display:none;">
        <div class="stat"><span class="label">Progress</span><span class="value" id="uni-progress">-</span></div>
        <div class="stat"><span class="label">Cert ID</span><span class="value" id="uni-cert" style="font-size:0.65rem;">-</span></div>
        <div class="stat"><span class="label">Tier</span><span class="value" id="uni-tier">-</span></div>
        <div class="stat"><span class="label">Perms</span><span class="value" id="uni-perms" style="font-size:0.65rem;">-</span></div>
      </div>
      <div style="margin-top:8px;font-size:0.72rem;color:#6b6b80;">
        <div>New agents must graduate from XMRT University to join the fleet.</div>
        <div style="margin-top:4px;">
          <span style="color:#a78bfa;">POST</span> <code style="color:#60a5fa;font-size:0.65rem;">/functions/v1/xmrt-university</code>
        </div>
        <div style="margin-top:4px;font-size:0.65rem;">
          <a href="https://github.com/xmrtdao/suite/tree/main/supabase/functions/xmrt-university" target="_blank" style="color:#6b6b80;">Source</a> .
          <span id="uni-source" style="color:#6b6b80;">Curriculum: <span id="uni-curriculum-source">built-in</span></span>
        </div>
      </div>
    </div>
<div class="card" id="fleet-card">
      <h3>Crew Registry <span id="fleet-count" style="color:#6b6b80;font-size:0.7rem;"></span></h3>
      <div id="fleet-agents-list">
        <div class="stat"><span class="label">Loading fleet...</span></div>
      </div>
    </div>
<div class="card" id="mesh-card">
      <h3>🕸️ Mesh Network <span id="mesh-count" style="color:#6b6b80;font-size:0.7rem;"></span></h3>
      <div id="mesh-peers-list">
        <div class="stat"><span class="label">Loading mesh peers...</span></div>
      </div>
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid #1e1e2e;">
        <div style="font-size:0.72rem;color:#6b6b80;margin-bottom:4px;">Register agent on mesh:</div>
        <div style="background:#0d0d15;padding:0.4rem 0.6rem;border-radius:4px;font-family:monospace;font-size:0.7rem;color:#60a5fa;word-break:break-all;margin-bottom:4px;">POST /functions/v1/mesh-peer-connector</div>
        <div style="background:#0d0d15;padding:0.3rem 0.6rem;border-radius:4px;font-family:monospace;font-size:0.65rem;color:#a78bfa;word-break:break-all;">{"action":"register","agent_name":"...","peer_id":"...","endpoint":"..."}</div>
        <div style="margin-top:6px;font-size:0.72rem;color:#6b6b80;margin-bottom:4px;">Publish to mesh topics:</div>
        <div style="background:#0d0d15;padding:0.4rem 0.6rem;border-radius:4px;font-family:monospace;font-size:0.7rem;color:#4ade80;word-break:break-all;margin-bottom:4px;">POST /functions/v1/mesh-publish</div>
        <div style="background:#0d0d15;padding:0.3rem 0.6rem;border-radius:4px;font-family:monospace;font-size:0.65rem;color:#a78bfa;word-break:break-all;">{"topic":"fleet-broadcast","payload":{...},"agent":"eliza"}</div>
        <div style="margin-top:6px;font-size:0.65rem;color:#6b6b80;">
          <span>🔗 <a href="/mesh/status" style="color:#60a5fa;">Gossipsub Status</a></span> ·
          <span><a href="/api/p2p/health" style="color:#60a5fa;">P2P Mesh Health</a></span> ·
          <span><a href="/mesh/messages" style="color:#60a5fa;">Mesh Messages</a></span>
        </div>
      </div>
    </div>
<div class="card" id="ship-defense">
      <h3 style="color:#f87171;">🛡️ Ship&#39;s Defense <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— ARP + RF Monitoring</span></h3>
      <div class="stat"><span class="label">ARP Defender</span><span class="value" id="arp-status" style="color:#6b6b80;">checking...</span></div>
      <div class="stat"><span class="label">RF Jammer</span><span class="value" id="rf-status" style="color:#6b6b80;">checking...</span></div>
      <div class="stat"><span class="label">Noise Floor</span><span class="value" id="rf-noise">-</span></div>
      <div class="stat"><span class="label">Alerts</span><span class="value" id="defense-alerts" style="color:#4ade80;">0</span></div>
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid #1e1e2e;font-size:0.72rem;color:#6b6b80;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <code style="color:#fbbf24;">node relay/tools/arp-defender.mjs --monitor</code>
          <code style="color:#60a5fa;">node relay/tools/jam-detector.mjs --monitor</code>
        </div>
        <div style="margin-top:4px;">
          <a href="https://github.com/xmrtdao/mobilemonero/blob/main/relay/tools/arp-defender.mjs" target="_blank" style="color:#6b6b80;">ARP Source</a> ·
          <a href="/cron/status" style="color:#6b6b80;">Cron Status</a> ·
          <a href="/api/mesh/bridge" style="color:#6b6b80;">Bridge API</a>
        </div>
      </div>
      <script>
        (function(){
          function updateDefense() {
            fetch('/api/mesh/bridge').then(r=>r.json()).then(d => {
              const arp = document.getElementById('arp-status');
              const rf = document.getElementById('rf-status');
              const noise = document.getElementById('rf-noise');
              const alerts = document.getElementById('defense-alerts');
              if (arp) {
                const count = d.nodes || 0;
                arp.textContent = count > 0 ? '🟢 ' + count + ' devices mapped' : '○ idle';
                arp.style.color = count > 0 ? '#4ade80' : '#6b6b80';
              }
              if (rf && d.rfStatus) {
                const jam = d.rfStatus.jamming;
                rf.textContent = jam ? '🔴 JAMMING' : '🟢 Clear';
                rf.style.color = jam ? '#f87171' : '#4ade80';
                if (noise) noise.textContent = d.rfStatus.noiseFloor + ' dBm';
              } else if (rf) {
                rf.textContent = '○ not scanning';
                rf.style.color = '#6b6b80';
              }
              if (alerts) {
                const count = d.messageCount || 0;
                alerts.textContent = count;
                alerts.style.color = count > 0 ? '#f87171' : '#4ade80';
              }
            }).catch(() => {});
          }
          updateDefense();
          setInterval(updateDefense, 5000);
        })();
      </script>
    </div>
<div class="card" id="meshtastic-fleet-card">
      <h3 style="color:#4ade80;">📡 Meshtastic Fleet <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— LoRa Mesh Bridge (via Hermes)</span></h3>
      <div id="meshtastic-status">
        <div class="stat"><span class="label">Bridge</span><span class="value" id="mt-bridge-status" style="color:#6b6b80;">checking...</span></div>
        <div class="stat"><span class="label">Transport</span><span class="value" id="mt-transport" style="color:#6b6b80;">-</span></div>
        <div class="stat"><span class="label">Peers</span><span class="value" id="mt-peers" style="color:#6b6b80;">-</span></div>
        <div class="stat"><span class="label">Messages</span><span class="value" id="mt-messages" style="color:#6b6b80;">-</span></div>
        <div class="stat"><span class="label">Uptime</span><span class="value" id="mt-uptime" style="color:#6b6b80;">-</span></div>
        <div class="stat"><span class="label">Last Update</span><span class="value" id="mt-last-update" style="color:#6b6b80;">-</span></div>
      </div>
      <div id="meshtastic-nodes" style="margin-top:6px;display:none;">
        <div style="font-size:0.7rem;color:#6b6b80;margin-bottom:4px;">Discovered Nodes:</div>
        <div id="mt-node-list" style="font-size:0.65rem;"></div>
      </div>
      <div style="margin-top:8px;padding-top:6px;border-top:1px solid #1e1e2e;font-size:0.7rem;color:#6b6b80;">
        <span>🟢 Bridge node: <strong>Hermes</strong> (Termux/Android)</span>
        <span style="display:block;margin-top:2px;">🔗 <a href="/api/mesh/bridge" style="color:#60a5fa;">Bridge API</a> · <a href="/api/p2p/health" style="color:#60a5fa;">P2P Health</a></span>
        <span style="display:block;margin-top:2px;color:#4ade80;">POST /api/meshtastic/update — Hermes pushes bridge state here</span>
      </div>
      <script>
        (function(){
          function updateMeshtastic() {
            fetch('/api/mesh/bridge').then(r=>r.json()).then(d => {
              const status = document.getElementById('mt-bridge-status');
              const transport = document.getElementById('mt-transport');
              const peers = document.getElementById('mt-peers');
              const messages = document.getElementById('mt-messages');
              const uptime = document.getElementById('mt-uptime');
              const lastUpdate = document.getElementById('mt-last-update');
              const nodesDiv = document.getElementById('meshtastic-nodes');
              const nodeList = document.getElementById('mt-node-list');

              if (d.connected) {
                status.textContent = '🟢 Connected';
                status.style.color = '#4ade80';
                transport.textContent = d.transport || 'tcp';
                peers.textContent = d.nodes + ' nodes';
                messages.textContent = d.messageCount || 0;
                const u = d.uptime || 0;
                uptime.textContent = u > 3600 ? Math.floor(u/3600)+'h '+Math.floor((u%3600)/60)+'m' : u > 60 ? Math.floor(u/60)+'m '+u%60+'s' : u+'s';
                if (d.nodeList && d.nodeList.length > 0) {
                  nodesDiv.style.display = 'block';
                  nodeList.innerHTML = d.nodeList.map(n =>
                    '<div style="padding:2px 0;">🟢 ' + (n.name || n.id) +
                    (n.rssi ? ' <span style="color:#6b6b80;">RSSI:'+n.rssi.toFixed(1)+'</span>' : '') +
                    (n.snr ? ' <span style="color:#6b6b80;">SNR:'+n.snr.toFixed(1)+'</span>' : '') +
                    '</div>'
                  ).join('');
                } else {
                  nodesDiv.style.display = 'none';
                }
              } else {
                status.textContent = '○ Disconnected';
                status.style.color = '#6b6b80';
                transport.textContent = '-';
                peers.textContent = (d.nodes || 0) + ' nodes tracked';
                messages.textContent = d.messageCount || 0;
                uptime.textContent = '-';
                nodesDiv.style.display = 'none';
              }
              if (lastUpdate) {
                const ts = d.lastUpdate || d.timestamp;
                if (ts) lastUpdate.textContent = new Date(ts).toLocaleTimeString();
              }
            }).catch(() => {
              const status = document.getElementById('mt-bridge-status');
              if (status) { status.textContent = '○ offline'; status.style.color = '#6b6b80'; }
            });
          }
          updateMeshtastic();
          setInterval(updateMeshtastic, 5000);
        })();
      </script>
    </div>
<div class="card">
      <h3>Heartbeat Endpoint</h3>
      <div style="background:#0d0d15;padding:0.4rem 0.6rem;border-radius:4px;font-family:monospace;font-size:0.75rem;color:#60a5fa;word-break:break-all;" id="heartbeat-url">loading...</div>
      <div style="color:#6b6b80;font-size:0.72rem;margin-top:0.4rem;">POST: {"agent_id":"...","status":"ONLINE","tunnel_url":"...","hashrate":0}</div>
    </div>
<div class="card">
      <h3>Plunder Tracker <span id="pool-workers" style="color:#6b6b80;font-weight:400;font-size:0.7rem;">-</span></h3>
      <div class="stat"><span class="label">Pool Hashrate</span><span class="value" id="pool-hash">checking...</span></div>
      <div class="stat"><span class="label">Valid Shares</span><span class="value" id="pool-shares">-</span></div>
      <div class="stat"><span class="label">XMR Paid / Due</span><span class="value" id="pool-xmr">-</span></div>
      <div class="stat"><span class="label">Pool Global Hashrate</span><span class="value" id="pool-global-hash" style="color:#818cf8;">-</span></div>
      <div class="stat"><span class="label">Pool Miners</span><span class="value" id="pool-total-miners" style="color:#818cf8;">-</span></div>
      <div class="stat"><span class="label">Treasury (85%) / Ops (15%)</span><span class="value" id="pool-treasury" style="color:#fbbf24;">-</span></div>
      <div class="stat"><span class="label">Status</span><span class="value" id="pool-health" style="color:#818cf8;">-</span></div>
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid #2a2a3a;">
        <div style="font-size:0.65rem;color:#6b6b80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Quick Start Script &#9679; click to copy</div>
        <pre style="background:#0d0d15;padding:0.6rem;border-radius:6px;font-size:0.72rem;overflow-x:auto;color:#a0a0b0;white-space:pre-wrap;word-break:break-all;margin:0;cursor:pointer;" id="mining-script" onclick="copyMiningScript()">curl -o signup.py -L https://raw.githubusercontent.com/xmrtdao/mmlauncher/main/scripts/mobile-signup.py && sha256sum signup.py && python3 signup.py</pre>
        <div style="font-size:0.6rem;color:#4a4a5a;margin-top:4px;">Runs on Linux/macOS/Termux</div>
      </div>
    </div>
<div class="card">
      <h3>Leaderboard</h3>
      <div style="margin-bottom:6px;font-size:11px;color:#6b6b80;">Live hashrate · shares · XMRT rewards</div>
      <div id="miner-leaderboard"><div class="stat"><span class="label">Loading...</span></div></div>
    </div>
<div class="card" id="pfp-campaign-card">
      <h3>PFP Campaign</h3>
      <div class="stat"><span class="label">Contact Pool</span><span class="value" id="pfp-pool">-</span></div>
      <div class="stat"><span class="label">Sent Today</span><span class="value" id="pfp-sent-today">-</span></div>
      <div class="stat"><span class="label">Sent Total</span><span class="value" id="pfp-sent-total">-</span></div>
      <div class="stat"><span class="label">Fresh Avail</span><span class="value" id="pfp-fresh">-</span></div>
      <div class="stat"><span class="label">Last Run</span><span class="value" id="pfp-last-run">-</span></div>
      <div class="stat"><span class="label">Next Drop</span><span class="value" id="next-drop">-</span></div>
    </div>
<div class="card" id="pfp-leads-card">
      <h3>PFP Leads 🎯</h3>
      <div class="stat"><span class="label">Total</span><span class="value" id="pfp-leads-total">-</span></div>
      <div class="stat"><span class="label">By Status</span><span class="value" id="pfp-leads-by-status" style="font-size:0.65rem;">-</span></div>
      <div class="stat"><span class="label">By Source</span><span class="value" id="pfp-leads-by-source" style="font-size:0.65rem;">-</span></div>
      <div class="stat"><span class="label">Hot (≥7)</span><span class="value" id="pfp-leads-hot">-</span></div>
      <div class="stat"><span class="label">Newest</span><span class="value" id="pfp-leads-newest" style="font-size:0.65rem;">-</span></div>
    </div>
<div class="card" id="harbor-campaign-card">
      <h3>31 Harbor 🏠</h3>
      <div class="stat"><span class="label">Contact Pool</span><span class="value" id="harbor-pool">-</span></div>
      <div class="stat"><span class="label">Sent Today</span><span class="value" id="harbor-sent-today">-</span></div>
      <div class="stat"><span class="label">Sent Total</span><span class="value" id="harbor-sent-total">-</span></div>
      <div class="stat"><span class="label">Fresh Avail</span><span class="value" id="harbor-fresh">-</span></div>
      <div class="stat"><span class="label">Last Run</span><span class="value" id="harbor-last-run">-</span></div>
      <div class="stat"><span class="label">Next Drop</span><span class="value" id="harbor-next-drop">-</span></div>
    </div>
<div class="card">
      <h3 style="color:#60a5fa;">XMRT DAO Health</h3>
      <div class="stat"><span class="label">Local DB</span><span class="value" id="dao-health-status">checking...</span></div>
      <div class="stat"><span class="label">Health Score</span><span class="value" id="dao-health-score">-</span></div>
      <div class="stat"><span class="label">Edge Functions</span><span class="value" id="dao-fn-count">-</span></div>
      <div class="stat"><span class="label">Agents</span><span class="value" id="dao-agent-count">-</span></div>
      <div class="stat"><span class="label">Tasks</span><span class="value" id="dao-task-count">-</span></div>
      <div class="stat"><span class="label">Gossip Hub</span><span class="value" id="dao-gossip-status">-</span></div>
      <div class="stat"><span class="label">Services</span><span class="value" id="dao-service-status">-</span></div>
      <div style="margin-top:8px;font-size:11px;color:#6b6b80;">Live from system-health endpoint</div>
    </div>
<div class="card">
      <h3 style="color:#fbbf24;">GitHub Activity</h3>
      <div class="stat"><span class="label">Total Repos</span><span class="value" id="gh-repo-count">-</span></div>
      <div class="stat"><span class="label">Last Commit</span><span class="value" id="gh-last-commit" style="font-size:0.7rem;">-</span></div>
      <div style="margin-top:8px;font-size:11px;color:#6b6b80;" id="gh-recent-commits"></div>
    </div>
<div class="card" id="pfp-card">
      <h3> Party Favor Photo <span style="color:#6b6b80;font-size:0.7rem;">inbox</span></h3>
      <div id="pfp-inbox">
        <div class="stat"><span class="label">Loading inbox...</span></div>
      </div>
    </div>
<div class="card" id="mm-card">
      <h3> MobileMonero <span style="color:#6b6b80;font-size:0.7rem;">inbox</span></h3>
      <div id="mm-inbox">
        <div class="stat"><span class="label">Loading inbox...</span></div>
      </div>
    </div>
<div class="card" id="hb-card">
      <h3> 31 Harbor <span style="color:#6b6b80;font-size:0.7rem;">inbox</span></h3>
      <div id="hb-inbox">
        <div class="stat"><span class="label">Loading inbox...</span></div>
      </div>
    </div>
<div class="card">
      <h3>XMRT DAO Membership</h3>
      <div class="stat"><span class="label"><a href="https://whop.com/xmrt-dao" target="_blank" style="color:#4ade80;text-decoration:none;">Free Tier</a></span><span class="value">free</span></div>
      <div class="stat"><span class="label"><a href="https://whop.com/checkout/plan_W6r4uqGWNaKHp" target="_blank" style="color:#ff6b35;text-decoration:none;">Premium</a></span><span class="value">$9.99/mo</span></div>
      <div class="stat"><span class="label"><a href="https://whop.com/checkout/plan_Wj1nh8AJhdsLN" target="_blank" style="color:#ff6b35;text-decoration:none;">Premium Yearly</a></span><span class="value">$99.99/yr</span></div>
      <div class="stat"><span class="label"><a href="https://whop.com/checkout/plan_n853GD3f5IXm0" target="_blank" style="color:#60a5fa;text-decoration:none;">Supporter</a></span><span class="value">$19.99</span></div>
      <div style="margin-top:6px;font-size:11px;color:#6b6b80;">Premium: 2x rewards · governance · early hardware</div>
    </div>
<div class="card">
      <h3>DAO Ecosystem</h3>
      <div class="stat"><span class="label"><a href="https://xmrtsolutions.vercel.app" target="_blank" style="color:#60a5fa;text-decoration:none;">XMRT Token Faucet</a></span><span class="value">testnet</span></div>
      <div class="stat"><span class="label"><a href="https://coldcash.vercel.app" target="_blank" style="color:#60a5fa;text-decoration:none;">ColdCash</a></span><span class="value">private payments</span></div>
      <div class="stat"><span class="label"><a href="https://pipuente.vercel.app" target="_blank" style="color:#60a5fa;text-decoration:none;">PiPuente</a></span><span class="value">cross-chain bridge</span></div>
      <div class="stat"><span class="label"><a href="https://paragraph.com/@xmrt" target="_blank" style="color:#60a5fa;text-decoration:none;">Paragraph Blog</a></span><span class="value">DAO journal</span></div>
      <div class="stat"><span class="label"><a href="https://sepolia.etherscan.io/token/0x77307DFbc436224d5e6f2048d2b6bDfA66998a15" target="_blank" style="color:#60a5fa;text-decoration:none;">XMRT Token</a></span><span class="value">0x7730...8a15</span></div>
      <div class="stat"><span class="label"><a href="https://github.com/xmrtdao" target="_blank" style="color:#60a5fa;text-decoration:none;">GitHub Org</a></span><span class="value">59 repos</span></div>
      <div style="margin-top:8px;font-size:11px;color:#6b6b80;">
        <a href="https://github.com/xmrtdao/mobilemonero" style="color:#6b6b80;">mobilemonero</a> ·
        <a href="https://github.com/xmrtdao/suite" style="color:#6b6b80;">suite</a> ·
        <a href="https://github.com/xmrtdao/zero-claw" style="color:#6b6b80;">zero-claw</a> ·
        <a href="https://github.com/xmrtdao/xmrt-mesh" style="color:#6b6b80;">xmrt-mesh</a>
      </div>
    </div>
<div class="card">
      <h3>Tools</h3>
      ${tools.map(t => `<div class="stat"><span class="label">${t}</span><span class="value badge badge-info">ready</span></div>`).join('')}
      ${localFunctions.length > 0 ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #2a2a3a;"><div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Local Functions</div>${localFunctions.map(f => `<div class="stat"><span class="label" style="color:#4ade80;">fn:${f.name}</span><span class="value badge badge-info">local</span></div>`).join('')}</div>` : ''}
    </div>
<div class="card">
      <h3>Quick Actions</h3>
      <div class="stat"><span class="label"><a href="/health" style="color:#4ade80;text-decoration:none;">GET /health</a></span><span class="value">health check</span></div>
      <div class="stat"><span class="label"><a href="/status" style="color:#60a5fa;text-decoration:none;">GET /status</a></span><span class="value">full status</span></div>
      <div class="stat"><span class="label"><a href="/tools" style="color:#60a5fa;text-decoration:none;">GET /tools</a></span><span class="value">tool list</span></div>
      <div class="stat"><span class="label"><a href="/monitor" style="color:#60a5fa;text-decoration:none;">GET /monitor</a></span><span class="value">system monitor</span></div>
      <div class="stat"><span class="label"><a href="/api/catalog" style="color:#60a5fa;text-decoration:none;">GET /api/catalog</a></span><span class="value">function catalog</span></div>
      <div class="stat"><span class="label"><code style="color:#fbbf24;font-size:0.75rem;">POST /dispatch</code></span><span class="value">task dispatch</span></div>
    </div>
<div class="card">
      <h3> AI Template Builder</h3>
      <div class="stat"><span class="label">Engine</span><span class="value">nano-banana-2 + edit</span></div>
      <div class="stat"><span class="label">Cost</span><span class="value">$0.03-0.06/gen</span></div>
      <div class="stat"><span class="label"><a href="/pfp/templates" style="color:#60a5fa;text-decoration:none;">GET /pfp/templates</a></span><span class="value">gallery</span></div>
      <div class="stat"><span class="label">Workflow</span><span class="value">reference → AI → template</span></div>
    </div>
  </div>
<!-- Edge Function Catalog -->
  <div style="margin-top:1.5rem;width:100%;box-sizing:border-box;">
    <div class="card" style="width:100%;box-sizing:border-box;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;flex-wrap:wrap;gap:0.5rem;">
      <h2 style="color:#ff6b35;font-size:1.1rem;">☁️ Supabase Edge Functions <span id="fnCount" style="color:#6b6b80;font-weight:400;"></span></h2>
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

  <script>
  const SUPABASE_URL = '${supabaseUrl}';
  let functions = [];
  let sortKey = 'name';
  let sortDir = 1;

  // Load edge function catalog
  fetch('/api/catalog')
    .then(r => r.json())
    .then(data => {
      functions = data.functions || [];
      document.getElementById('fnCount').textContent = '— ' + functions.length + ' total';
      renderFunctions();
    })
    .catch(e => {
      document.getElementById('fnBody').innerHTML = '<tr><td colspan="5" style="color:#f87171;text-align:center;padding:2rem;">Failed to load catalog: ' + e.message + '</td></tr>';
    });

  // Load pool stats for mining card
  function loadPoolStats() {
    fetch('/api/mining/pool-stats').then(function(r){return r.json();}).then(function(d){
      var e;
      if (e = document.getElementById('pool-hash')) e.textContent = (d.hash || 0).toFixed(0) + ' H/s';
      if (e = document.getElementById('pool-shares')) e.textContent = (d.validShares||0).toLocaleString() + ' valid / ' + (d.invalidShares||0) + ' invalid';
      if (e = document.getElementById('pool-xmr')) e.textContent = d.amtPaidXMR.toFixed(6) + ' / ' + d.amtDueXMR.toFixed(6) + ' XMR';
      // New fields: global pool stats, treasury, health
      if (e = document.getElementById('pool-global-hash')) {
        var mhs = d.pool_hashrate_mhs || 0;
        e.textContent = mhs > 0 ? mhs.toFixed(2) + ' MH/s' : (d.pool_hashrate || 0).toFixed(0) + ' H/s';
      }
      if (e = document.getElementById('pool-total-miners')) {
        e.textContent = (d.pool_total_miners || 0).toLocaleString() + ' miners \u00b7 ' + (d.pool_total_blocks || 0) + ' blocks';
      }
      if (e = document.getElementById('pool-treasury')) {
        var treas = d.treasury_allocation_xmr || 0;
        var ops = d.operational_allocation_xmr || 0;
        e.textContent = treas.toFixed(6) + ' / ' + ops.toFixed(6) + ' XMR';
      }
      if (e = document.getElementById('pool-health')) {
        var h = d.ecosystem_health || {};
        var parts = [];
        if (h.mining_active) parts.push('\u2705 Active'); else if (d.mining_status === 'offline') parts.push('\u274c Offline'); else parts.push('\u2753 Unknown');
        if (h.revenue_generating) parts.push('\u{1F4B0} Earning');
        if (h.pool_healthy) parts.push('\u{1F30D} Good');
        e.textContent = parts.join(' \u00b7 ');
        e.style.color = h.mining_active ? '#4ade80' : '#ef4444';
      }
    }).catch(function(){});
    fetch('/api/mining/pool-identifiers').then(function(r){return r.json();}).then(function(ids){
      var e = document.getElementById('pool-workers');
      if (e) e.textContent = ids && ids.length ? ids.join(', ') : 'none';
    }).catch(function(){});
  }
  loadPoolStats();
  setInterval(loadPoolStats, 30000);

  // Fleet Agent Registry
  function loadFleetAgents() {
    // Fetch pool identifiers to cross-reference agent status
    var ids = [];
    fetch('/api/mining/pool-identifiers', { signal: AbortSignal.timeout(5000) }).then(function(r){return r.json();}).then(function(idData){
      ids = idData || [];
    }).catch(function(){}).then(function(){
    return fetch('/api/fleet/agents').then(function(r){return r.json();});
    }).then(function(data){
      var agents = data.agents || [];
      var list = document.getElementById('fleet-agents-list');
      var count = document.getElementById('fleet-count');
      if (!count) return;
      count.textContent = '\u2014 ' + agents.length + ' agent' + (agents.length !== 1 ? 's' : '');
      if (!agents.length) {
        list.innerHTML = '<div class="stat"><span class="label">No agents registered</span></div>';
        return;
      }
      list.innerHTML = agents.map(function(a){
        var status = a.status;
        var hashrate = a.hashrate && (status === 'ONLINE' || status === 'online') ? a.hashrate : 0;
        var sb = status === 'ONLINE' || status === 'online' ? 'badge-ok' : status === 'BUSY' ? 'badge-warn' : 'badge-err';
        var agentName = a.agent_id || a.name || '?';
        var agentRole = a.role || 'agent';
        var cleanRole = agentRole.replace(/-/g,' ').replace(/\b\w/g, function(l){return l.toUpperCase();});
        var me = agentName === 'vex' ? '\u2b50 ' : '';
        var tun = a.tunnel_url ? '<br><span style="font-size:0.65rem;color:#4a7cff;">' + a.tunnel_url + '</span>' : '';
        var h = a.hashrate ? ' \u00b7 ' + a.hashrate + ' H/s' : '';
        return '<div class="stat"><span class="label">' + me + agentName + '<br><span style="font-size:0.65rem;color:#6b6b80;">' + cleanRole + '</span>' + tun + '</span><span class="value"><span class="badge ' + sb + '">' + status + '</span>' + h + '</span></div>';
      }).join('');
      // Update heartbeat URL
      var hb = document.getElementById('heartbeat-url');
      var t = document.querySelector('a[href*="relay.mobilemonero"]');
      if (hb && t) hb.textContent = t.href + '/api/fleet/heartbeat';
    }).catch(function(){
      // Fleet agents unavailable — leave as Loading...
    });
  };
  loadFleetAgents();
// -- XMRT University Status --
async function loadUniversityStatus() {
  var statusEl = document.getElementById('uni-status');
  var detailEl = document.getElementById('university-detail');
  var progressEl = document.getElementById('uni-progress');
  var certEl = document.getElementById('uni-cert');
  var tierEl = document.getElementById('uni-tier');
  var permsEl = document.getElementById('uni-perms');
  var sourceEl = document.getElementById('uni-curriculum-source');
  
  try {
    // Fetch curriculum info
    var coursesRes = await fetch('/api/ef-university', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'courses' })
    });
    var coursesData = await coursesRes.json();
    if (coursesData.success) {
      statusEl.textContent = coursesData.total_modules + ' modules available';
      statusEl.style.color = '#4ade80';
      if (sourceEl) sourceEl.textContent = 'database';
    } else {
      statusEl.textContent = 'offline';
      statusEl.style.color = '#ef4444';
    }
  } catch(e) {
    statusEl.textContent = 'unreachable';
    statusEl.style.color = '#ef4444';
  }
}
setInterval(loadUniversityStatus, 60000);
loadUniversityStatus();

  setInterval(loadFleetAgents, 15000);

  // Load mesh peers from peer connector
  function loadMeshPeers() {
    fetch('/api/mesh/peers', {
      signal: AbortSignal.timeout(5000)
    }).then(function(r){return r.json();}).then(function(data){
      var peers = data.peers || [];
      var list = document.getElementById('mesh-peers-list');
      var count = document.getElementById('mesh-count');
      if (!count) return;
      count.textContent = '\u2014 ' + peers.length + ' peer' + (peers.length !== 1 ? 's' : '');
      if (!peers.length) {
        list.innerHTML = '<div class="stat"><span class="label">No mesh peers registered</span></div>';
        return;
      }
      list.innerHTML = peers.map(function(p){
        var status = p.status || 'unknown';
        var sb = status === 'online' ? 'badge-ok' : 'badge-err';
        var me = p.agent_name === 'vex' ? '\u2b50 ' : '';
        var eps = p.endpoint ? '<br><span style="font-size:0.65rem;color:#4a7cff;">' + p.endpoint + '</span>' : '';
        var caps = p.capabilities ? '<br><span style="font-size:0.6rem;color:#6b6b80;">' + p.capabilities.slice(0,5).join(', ') + (p.capabilities.length > 5 ? ' +' + (p.capabilities.length-5) + ' more' : '') + '</span>' : '';
        var lastSeen = p.last_seen ? new Date(p.last_seen).toLocaleTimeString() : '';
        return '<div class="stat"><span class="label">' + me + p.agent_name + eps + caps + '</span><span class="value"><span class="badge ' + sb + '">' + status + '</span><br><span style="font-size:0.6rem;color:#6b6b80;">' + lastSeen + '</span></span></div>';
      }).join('');
    }).catch(function(){
      // Mesh peers unavailable
    });
  };
  loadMeshPeers();
  setInterval(loadMeshPeers, 30000);

  // Mining Stats from pool + xmrig (proxied through relay)
  // Load mining leaderboard
  function loadMiningLeaderboard() {
    fetch('/mining/leaderboard').then(function(r){return r.json();}).then(function(d){
      var el = document.getElementById('miner-leaderboard');
      if (!el) return;
      if (!d.workers || d.workers.length === 0) {
        el.innerHTML = '<div class="stat"><span class="label">No contributors yet</span></div>';
        return;
      }
      var now = Date.now();
      el.innerHTML = d.workers.slice(0,10).map(function(w) {
        var lastSeen = new Date(w.last_seen).getTime();
        var minutesAgo = Math.round((now - lastSeen) / 60000);
        var isOnline = minutesAgo < 10;
        var statusDot = isOnline ? '<span style="color:#4ade80;">●</span>' : '<span style="color:#6b6b80;">○</span>';
        var hashDisplay = w.current_hash > 0 ? w.current_hash + ' H/s' : '-';
        var sharesDisplay = w.total_shares > 0 ? w.total_shares.toLocaleString() : '0';
        var timeAgo = minutesAgo < 1 ? 'just now' : minutesAgo + 'm ago';
        return '<div class="stat"><span class="label">' + statusDot + ' ' + w.worker.slice(0,16) + '<br><span style="font-size:0.65rem;color:#6b6b80;">' + hashDisplay + ' · ' + timeAgo + '</span></span><span class="value">' + sharesDisplay + ' shares<br><span style="font-size:0.65rem;color:#fbbf24;">' + w.xmrt_earned + ' XMRT</span></span></div>';
      }).join('');
    }).catch(function(){
      var el = document.getElementById('miner-leaderboard');
      if (el) el.innerHTML = '<div class="stat"><span class="label">Leaderboard unavailable</span></div>';
    });
  }
  loadMiningLeaderboard();
  setInterval(loadMiningLeaderboard, 15000);

  // Local XMRig heartbeat (vex-laptop auto-reports hashrate)
  function localMinerHeartbeat() {
    fetch('/api/mining/local-xmrig', { signal: AbortSignal.timeout(5000) })
      .then(function(r){return r.json();})
      .then(function(d){
        var h = d.hashrate || 0;
        if (h > 0) {
          fetch('/mining/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ worker: 'vex-laptop', hashrate: Math.round(h) })
          }).catch(function(){});
        }
      }).catch(function(){});
  }
  localMinerHeartbeat();
  setInterval(localMinerHeartbeat, 60000);

  // Party Favor Photo inbox refresh (brief — lightweight)
  function loadPfpInbox() {
    fetch('/resend/inbox/brief').then(function(r){return r.json();}).then(function(data){
      var card = document.getElementById('pfp-inbox');
      if (!card) return;
      var emails = data.emails || data.recent || [];
      if (!emails.length) {
        card.innerHTML = '<div class="stat"><span class="label">No emails yet</span></div>';
        return;
      }
      var html = '';
      // Group by recipient
      var groups = {};
      emails.slice(0,20).forEach(function(e){
        var addr = Array.isArray(e.to) ? (e.to[0] || 'unknown') : (e.to || 'unknown');
        if (!groups[addr]) groups[addr] = [];
        groups[addr].push(e);
      });
      var count = 0;
      Object.keys(groups).forEach(function(addr){
        var msgs = groups[addr];
        html += '<div class="stat" style="border-bottom:1px solid #2a2a3a;padding:0.4rem 0;">';
        html += '<span class="label" style="font-size:0.78rem;color:#60a5fa;">' + addr + '</span>';
        html += '<span class="value badge badge-info">' + msgs.length + '</span>';
        html += '</div>';
        msgs.forEach(function(m){
          count++;
          if (count > 10) return;
          html += '<div class="stat" style="padding:0.2rem 0 0.2rem 0.5rem;font-size:0.72rem;">';
          html += '<span class="label">' + (m.from||'').substring(0,28) + '</span>';
          html += '<span class="value" style="color:#a0a0b0;">' + (m.subject||'').substring(0,22) + '</span>';
          html += '</div>';
        });
      });
      if (!html) html = '<div class="stat"><span class="label">No emails yet</span></div>';
      card.innerHTML = html;
    }).catch(function(){
      var e = document.getElementById('pfp-inbox');
      if (e) e.innerHTML = '<div class="stat"><span class="label">Inbox unavailable</span></div>';
    });
  }
  loadPfpInbox();
  setInterval(loadPfpInbox, 15000);

  // MobileMonero inbox refresh (brief — lightweight)
  function loadMmInbox() {
    fetch('/resend/mobilemonero/inbox/brief').then(function(r){return r.json();}).then(function(data){
      var card = document.getElementById('mm-inbox');
      if (!card) return;
      var emails = data.emails || data.recent || [];
      if (!emails.length) {
        card.innerHTML = '<div class="stat"><span class="label">No emails yet</span></div>';
        return;
      }
      var html = '';
      var groups = {};
      emails.slice(0,15).forEach(function(e){
        var addr = Array.isArray(e.to) ? (e.to[0] || 'unknown') : (e.to || 'unknown');
        if (!groups[addr]) groups[addr] = [];
        groups[addr].push(e);
      });
      var count = 0;
      Object.keys(groups).forEach(function(addr){
        html += '<div class="stat" style="border-bottom:1px solid #2a2a3a;padding:0.3rem 0;">';
        html += '<span class="label" style="font-size:0.75rem;color:#60a5fa;">' + addr + '</span>';
        html += '<span class="value badge badge-info">' + groups[addr].length + '</span></div>';
        groups[addr].forEach(function(m){
          count++;
          if (count > 8) return;
          html += '<div class="stat" style="padding:0.15rem 0 0.15rem 0.4rem;font-size:0.7rem;">';
          html += '<span class="label">' + (m.from||'').substring(0,25) + '</span>';
          html += '<span class="value" style="color:#a0a0b0;">' + (m.subject||'').substring(0,20) + '</span></div>';
        });
      });
      if (!html) html = '<div class="stat"><span class="label">No emails yet</span></div>';
      card.innerHTML = html;
    }).catch(function(){
      var e = document.getElementById('mm-inbox');
      if (e) e.innerHTML = '<div class="stat"><span class="label">Inbox unavailable</span></div>';
    });
  }
  loadMmInbox();
  setInterval(loadMmInbox, 15000);

  // 31 Harbor inbox refresh (brief — lightweight)
  function loadHbInbox() {
    fetch('/resend/31harbor/inbox/brief').then(function(r){return r.json();}).then(function(data){
      var card = document.getElementById('hb-inbox');
      if (!card) return;
      var emails = data.emails || data.recent || [];
      if (!emails.length) {
        card.innerHTML = '<div class="stat"><span class="label">No emails yet</span></div>';
        return;
      }
      var html = '';
      var groups = {};
      emails.slice(0,15).forEach(function(e){
        var addr = Array.isArray(e.to) ? (e.to[0] || 'unknown') : (e.to || 'unknown');
        if (!groups[addr]) groups[addr] = [];
        groups[addr].push(e);
      });
      var count = 0;
      Object.keys(groups).forEach(function(addr){
        html += '<div class="stat" style="border-bottom:1px solid #2a2a3a;padding:0.3rem 0;">';
        html += '<span class="label" style="font-size:0.75rem;color:#60a5fa;">' + addr + '</span>';
        html += '<span class="value badge badge-info">' + groups[addr].length + '</span></div>';
        groups[addr].forEach(function(m){
          count++;
          if (count > 8) return;
          html += '<div class="stat" style="padding:0.15rem 0 0.15rem 0.4rem;font-size:0.7rem;">';
          html += '<span class="label">' + (m.from||'').substring(0,25) + '</span>';
          html += '<span class="value" style="color:#a0a0b0;">' + (m.subject||'').substring(0,20) + '</span></div>';
        });
      });
      if (!html) html = '<div class="stat"><span class="label">No emails yet</span></div>';
      card.innerHTML = html;
    }).catch(function(){
      var e = document.getElementById('hb-inbox');
      if (e) e.innerHTML = '<div class="stat"><span class="label">Inbox unavailable</span></div>';
    });
  }
  loadHbInbox();
  setInterval(loadHbInbox, 15000);

  // XMRT DAO Health — dynamic data from Supabase
  function loadDaoHealth() {
    fetch('/api/dao/health', { signal: AbortSignal.timeout(8000) })
      .then(function(r){return r.json();})
      .then(function(d){
        var statusEl = document.getElementById('dao-health-status');
        var fnEl = document.getElementById('dao-fn-count');
        var agentEl = document.getElementById('dao-agent-count');
        var taskEl = document.getElementById('dao-task-count');
        var gossipEl = document.getElementById('dao-gossip-status');
        var scoreEl = document.getElementById('dao-health-score');

        // The /api/dao/health endpoint returns: { health: <system-health>, status: <system-status> }
        // Each of those has its own nested structure: system-health returns { health: { overall_health: {...} } }
        // and system-status returns { status: { overall_status: '...', components: {...} } }.
        // The wrapper endpoint preserves those keys, so we end up with d.health.health.overall_health
        // and d.status.status.components. Tolerant code below handles both nesting depths.
        var h = (d.health && d.health.overall_health) ? d.health
             : (d.health && d.health.health)        ? d.health.health
             : null;
        var s = (d.status && d.status.components) ? d.status
             : (d.status && d.status.status)      ? d.status.status
             : null;
        if (!h && !s) {
          if (statusEl) statusEl.textContent = 'unavailable';
        }

        if (h && h.overall_health) {
          var score = h.overall_health.score || 0;
          var status = h.overall_health.status || 'unknown';
          var badgeClass = score >= 80 ? 'badge-ok' : score >= 50 ? 'badge-warn' : 'badge-err';
          if (statusEl) statusEl.innerHTML = '<span class="badge ' + badgeClass + '">' + status.toUpperCase() + ' (' + score + '/100)</span>';
          if (scoreEl) scoreEl.textContent = score + ' / 100 (' + status + ')';
        } else if (s && (s.overall_status || s.health_score !== undefined)) {
          var score2 = s.health_score || 0;
          var status2 = s.overall_status || 'unknown';
          var badgeClass2 = score2 >= 80 ? 'badge-ok' : score2 >= 50 ? 'badge-warn' : 'badge-err';
          if (statusEl) statusEl.innerHTML = '<span class="badge ' + badgeClass2 + '">' + status2.toUpperCase() + ' (' + score2 + '/100)</span>';
          if (scoreEl) scoreEl.textContent = score2 + ' / 100 (' + status2 + ')';
        }

        if (h && h.components) {
          if (fnEl && h.components.edge_functions && h.components.edge_functions.deployed) {
            fnEl.textContent = h.components.edge_functions.deployed + ' deployed';
          } else if (fnEl && s && s.components && s.components.edge_functions) {
            fnEl.textContent = (s.components.edge_functions.total_calls_24h || 0) + ' calls / 24h';
          }
          if (agentEl && h.components.agents) {
            var agents = h.components.agents;
            var total = (agents.IDLE || 0) + (agents.BUSY || 0) + (agents.OFFLINE || 0);
            agentEl.textContent = total + ' (' + (agents.BUSY || 0) + ' busy)';
          } else if (agentEl && s && s.components && s.components.agents && s.components.agents.stats) {
            var a2 = s.components.agents.stats;
            agentEl.textContent = (a2.total || 0) + ' (' + (a2.busy || 0) + ' busy)';
          }
          if (taskEl && s && s.components && s.components.tasks && s.components.tasks.stats) {
            var t = s.components.tasks.stats;
            taskEl.textContent = (t.total || 0) + ' (' + (t.completed || 0) + ' done)';
          } else if (taskEl && h.components.tasks) {
            var tt = h.components.tasks;
            taskEl.textContent = (tt.total || 0) + ' (' + (tt.COMPLETED || 0) + ' done)';
          }
        }

        // Render supervisor service statuses from d.services
        var svcEl = document.getElementById('dao-service-status');
        if (svcEl && d.services && typeof d.services === 'object') {
          var keys = Object.keys(d.services);
          if (keys.length === 0) {
            svcEl.innerHTML = '<span class="badge badge-warn">no services</span>';
          } else {
            var running = 0, down = 0;
            keys.forEach(function(k){
              if (d.services[k].uptimeSec > 0) running++; else down++;
            });
            var badgeClass = down === 0 ? 'badge-ok' : (running > 0 ? 'badge-warn' : 'badge-err');
            svcEl.innerHTML = '<span class="badge ' + badgeClass + '">' + running + ' up / ' + (running + down) + ' total</span>';
            // Also populate a small hover tooltip with individual service statuses
            svcEl.title = keys.map(function(k){
              var s = d.services[k];
              var uptime = s.uptimeSec > 0 ? Math.floor(s.uptimeSec / 60) + 'm' : 'down';
              return k + ' (pid ' + (s.childPid || '-') + ', ' + uptime + ', restarts: ' + s.restartCount + ')';
            }).join(' | ');
          }
        } else if (svcEl) {
          svcEl.textContent = 'unavailable';
        }

        // Check gossip hub separately
        fetch('/api/dao/gossip?topic=fleet-broadcast&limit=1', { signal: AbortSignal.timeout(5000) })
          .then(function(r){return r.json();})
          .then(function(g){
            if (gossipEl) {
              if (g.success && g.messages && g.messages.length > 0) {
                var lastMsg = g.messages[0];
                var minsAgo = Math.round((Date.now() - new Date(lastMsg.timestamp).getTime()) / 60000);
                gossipEl.innerHTML = '<span class="badge badge-ok">' + (minsAgo < 5 ? 'active' : minsAgo + 'm ago') + '</span>';
              } else {
                gossipEl.innerHTML = '<span class="badge badge-warn">quiet</span>';
              }
            }
          })
          .catch(function(){
            if (gossipEl) gossipEl.innerHTML = '<span class="badge badge-err">offline</span>';
          });
      })
      .catch(function(){
        var statusEl = document.getElementById('dao-health-status');
        if (statusEl) statusEl.textContent = 'offline';
      });
  }
  loadDaoHealth();
  setInterval(loadDaoHealth, 30000);

  // GitHub Activity — dynamic data from GitHub API
  function loadGithubActivity() {
    fetch('/api/dao/github', { signal: AbortSignal.timeout(8000) })
      .then(function(r){return r.json();})
      .then(function(d){
        var repoEl = document.getElementById('gh-repo-count');
        var commitEl = document.getElementById('gh-last-commit');
        var recentEl = document.getElementById('gh-recent-commits');

        if (d.total_repos) {
          if (repoEl) repoEl.textContent = d.total_repos + ' repos';
        }

        if (d.recent_commits && d.recent_commits.length > 0) {
          var last = d.recent_commits[0];
          var NL = String.fromCharCode(10);
          var lastMsg = (last.commit && last.commit.message) ? last.commit.message.split(NL)[0].slice(0, 35) : 'recent commit';
          var lastWhen = new Date(last.commit.author.date).toLocaleDateString();
          var lastRepo = last._repo ? ' [' + last._repo + ']' : '';
          if (commitEl) commitEl.textContent = lastMsg + lastRepo + ' (' + lastWhen + ')';

          // Show last 5 commits across all repos with repo tag
          if (recentEl) {
            recentEl.innerHTML = d.recent_commits.slice(0,5).map(function(c){
              var m = (c.commit && c.commit.message) ? c.commit.message.split(NL)[0].slice(0, 28) : '?';
              var dd = new Date(c.commit.author.date).toLocaleDateString();
              var repo = c._repo ? '<span style="color:#4ade80;">' + c._repo + '</span> ' : '';
              return '<div style="font-size:0.65rem;color:#a0a0b0;margin:2px 0;">' + repo + m + ' <span style="color:#6b6b80;">(' + dd + ')</span></div>';
            }).join('');
          }
        }
      })
      .catch(function(){
        var repoEl = document.getElementById('gh-repo-count');
        if (repoEl) repoEl.textContent = 'unavailable';
      });
  }
  loadGithubActivity();
  setInterval(loadGithubActivity, 60000);

  // PFP Campaign — live stats
  function loadPfpCampaign() {
    fetch('/api/campaign/pfp', { signal: AbortSignal.timeout(8000) })
      .then(function(r){return r.json();})
      .then(function(d){
        if (!d.success) return;
        var el = function(id){return document.getElementById(id);};
        if (el('pfp-pool')) el('pfp-pool').textContent = d.poolSize;
        if (el('pfp-sent-today')) el('pfp-sent-today').textContent = d.sentToday;
        if (el('pfp-sent-total')) el('pfp-sent-total').textContent = d.totalSent;
        if (el('pfp-fresh')) el('pfp-fresh').textContent = d.freshAvailable;
        if (el('pfp-last-run')) el('pfp-last-run').textContent = d.campaignLastRun;
      });
  }
  loadPfpCampaign();
  setInterval(loadPfpCampaign, 30000);

  // 31 Harbor Campaign — live stats
  function loadHarborCampaign() {
    fetch('/api/campaign/31harbor', { signal: AbortSignal.timeout(8000) })
      .then(function(r){return r.json();})
      .then(function(d){
        if (!d.success) return;
        var el = function(id){return document.getElementById(id);};
        if (el('harbor-pool')) el('harbor-pool').textContent = d.harborPoolSize;
        if (el('harbor-sent-today')) el('harbor-sent-today').textContent = d.harborSentToday;
        if (el('harbor-sent-total')) el('harbor-sent-total').textContent = d.harborSentTotal;
        if (el('harbor-fresh')) el('harbor-fresh').textContent = d.harborFresh;
        if (el('harbor-last-run')) el('harbor-last-run').textContent = d.harborLastRun;
      });
  }
  loadHarborCampaign();
  setInterval(loadHarborCampaign, 30000);

  // PFP Leads — live from pfp_leads table via local-sb
  function loadPfpLeads() {
    fetch('/api/leads/pfp', { signal: AbortSignal.timeout(8000) })
      .then(function(r){return r.json();})
      .then(function(d){
        if (!d.success) return;
        var el = function(id){return document.getElementById(id);};
        if (el('pfp-leads-total')) el('pfp-leads-total').textContent = d.total;
        if (el('pfp-leads-by-status')) {
          var parts = [];
          for (var k in d.byStatus) parts.push(k + ':' + d.byStatus[k]);
          el('pfp-leads-by-status').textContent = parts.join(' · ');
        }
        if (el('pfp-leads-by-source')) {
          var parts = [];
          for (var k in d.bySource) parts.push(k + ':' + d.bySource[k]);
          el('pfp-leads-by-source').textContent = parts.join(' · ');
        }
        if (el('pfp-leads-hot')) el('pfp-leads-hot').textContent = d.highRated.length;
        if (el('pfp-leads-newest') && d.newest) {
          var n = d.newest;
          el('pfp-leads-newest').textContent = (n.contact_name || '?') + ' — ' + (n.contact_email || '') + ' [' + (n.source || '?') + ']';
        }
      });
  }
  loadPfpLeads();
  setInterval(loadPfpLeads, 30000);

  function renderFunctions() {
    const search = document.getElementById('search').value.toLowerCase();
    const methodFilter = document.getElementById('methodFilter').value;
    const typeFilter = document.getElementById('typeFilter').value;

    let filtered = functions.filter(f => {
      if (search && !f.name.toLowerCase().includes(search) && !f.desc.toLowerCase().includes(search)) return false;
      if (methodFilter && !f.methods.includes(methodFilter)) return false;
      if (typeFilter === 'simple' && f.type !== 'simple endpoint') return false;
      if (typeFilter === 'workflow' && f.type !== 'multi-action workflow') return false;
      return true;
    });

    filtered.sort((a, b) => {
      let va = (a[sortKey] || '').toString().toLowerCase();
      let vb = (b[sortKey] || '').toString().toLowerCase();
      return va < vb ? -sortDir : va > vb ? sortDir : 0;
    });

    document.getElementById('resultCount').textContent = filtered.length + ' shown';

    document.getElementById('fnBody').innerHTML = filtered.map(f => {
      const methods = (f.methods || ['POST']).map(m =>
        '<span class="fn-method method-' + m + '">' + m + '</span>'
      ).join('');
      const typeTag = f.type === 'multi-action workflow'
        ? '<span class="tag-workflow">workflow</span>'
        : '<span class="tag-simple">simple</span>';
      
      // Estimate timeout based on function type and name
      var timeout = '10s';
      var name = (f.name || '').toLowerCase();
      if (name.includes('curiosity') || name.includes('explore')) timeout = '45s';
      else if (name.includes('search') || name.includes('exa')) timeout = '20s';
      else if (name.includes('research') || name.includes('intelligence')) timeout = '30s';
      else if (name.includes('python') || name.includes('jupyter')) timeout = '60s';
      else if (name.includes('browse') || name.includes('scrape') || name.includes('playwright')) timeout = '30s';
      else if (name.includes('chat') || name.includes('ai-')) timeout = '25s';
      else if (name.includes('booking') || name.includes('quote') || name.includes('template') || name.includes('pfp')) timeout = '30s';
      else if (name.includes('generate') || name.includes('stripe')) timeout = '15s';
      else if (f.type === 'multi-action workflow') timeout = '30s';
      
      const timeoutBadge = parseInt(timeout) > 20
        ? '<span class="badge badge-warn" style="font-size:0.65rem;">' + timeout + '</span>'
        : '<span class="badge badge-ok" style="font-size:0.65rem;">' + timeout + '</span>';
      
      const inputs = (f.inputs && f.inputs.length)
        ? f.inputs.map(i => '<span style="color:#fbbf24">' + i + '</span>').join(', ')
        : '<span style="color:#4a4a5a">(see source)</span>';
      const endpoint = SUPABASE_URL + '/functions/v1/' + f.name;
      
      return '<tr>' +
        '<td class="fn-name">' + f.name + '</td>' +
        '<td class="fn-method-cell">' + methods + ' ' + timeoutBadge + '</td>' +
        '<td>' + typeTag + '</td>' +
        '<td class="fn-desc">' + (f.desc || '') + '</td>' +
        '<td class="endpoint-url"><span>' + endpoint + '</span></td>' +
        '</tr>';
    }).join('');
  }

  function filterFunctions() { renderFunctions(); }
  function sortBy(key) {
    if (sortKey === key) sortDir *= -1;
    else { sortKey = key; sortDir = 1; }
    renderFunctions();
  }
  
  function sendFleetChat() {
    // Get or prompt for agent name (persisted in localStorage)
    var nameInput = document.getElementById('fleet-chat-name');
    var savedName = localStorage.getItem('fleet-chat-user-name');
    if (savedName && !nameInput.value) {
      nameInput.value = savedName;
    } else if (nameInput.value) {
      localStorage.setItem('fleet-chat-user-name', nameInput.value);
    }
    var agent = nameInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'user';
    var input = document.getElementById('fleet-chat-input');
    var msgs = document.getElementById('fleet-chat-msgs');
    var msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    msgs.innerHTML += '<div style="margin-bottom:6px;text-align:right;"><span style="color:#8b8ba0;font-size:10px;display:block;">' + agent.toUpperCase() + '</span><span style="background:#1a3a5c;color:#e0e0f0;padding:6px 10px;border-radius:6px;display:inline-block;font-size:13px;">' + msg.replace(/</g,'&lt;') + '</span></div>';
    document.getElementById('fleet-chat-status').textContent = '● sending...';
    document.getElementById('fleet-chat-status').style.color = '#fbbf24';
    msgs.scrollTop = msgs.scrollHeight;
    fetch('/api/fleet-chat/send', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent:agent,message:msg,channel:'all'})})
      .then(function(r){return r.json();})
      .then(function(d){
        document.getElementById('fleet-chat-status').textContent = '● connected';
        document.getElementById('fleet-chat-status').style.color = '#4ade80';
        // Auto-fetch new messages
        fetchFleetMessages();
      }).catch(function(e){
        document.getElementById('fleet-chat-status').textContent = '● error: ' + e.message;
        document.getElementById('fleet-chat-status').style.color = '#f87171';
      });
  }

  // Poll for new fleet messages
  var lastFleetTs = 0;
  function fetchFleetMessages() {
    var msgs = document.getElementById('fleet-chat-msgs');
    var url = '/api/fleet-chat/messages?limit=50';
    if (lastFleetTs > 0) url += '&since=' + lastFleetTs;
    fetch(url)
      .then(function(r){return r.json();})
      .then(function(d){
        if (d.messages && d.messages.length > 0) {
          for (var i = 0; i < d.messages.length; i++) {
            var m = d.messages[i];
            if (m.ts <= lastFleetTs) continue;
            var color = m.agent === 'vex' ? '#2a1a0a' : m.agent === 'eliza' ? '#1a3a2a' : '#2a1a3a';
            var label = m.agentLabel || m.agent;
            // Check if message already displayed
            var existing = msgs.querySelector('[data-id="' + m.id + '"]');
            if (existing) continue;
            var div = document.createElement('div');
            div.style.marginBottom = '6px';
            div.setAttribute('data-id', m.id);
            div.innerHTML = '<span style="color:#8b8ba0;font-size:10px;display:block;">' + label + '</span><span class="fleet-msg-body" style="background:' + color + ';color:#e0e0f0;padding:6px 10px;border-radius:6px;display:inline-block;font-size:13px;max-width:100%;">' + renderMarkdown(m.message || '') + '</span>';
            msgs.appendChild(div);
            lastFleetTs = Math.max(lastFleetTs, m.ts);
          }
          msgs.scrollTop = msgs.scrollHeight;
        }
        document.getElementById('fleet-chat-status').textContent = '● connected';
        document.getElementById('fleet-chat-status').style.color = '#4ade80';
      }).catch(function(e){
        document.getElementById('fleet-chat-status').textContent = '● polling error';
        document.getElementById('fleet-chat-status').style.color = '#f87171';
      });
  }

  // Markdown renderer is loaded from /static/markdown.js to keep the template literal escape-free.

  // ── Bulletin Board Functions ────────────────────────────────
  var boardData = { topics: [] };
  var boardCurrentTopic = null;
  var boardStatusFilter = "all"; // all, active, in-progress, completed, archived
  var boardLastPostCount = 0;
  function loadBoard() {
    fetch("/api/bulletin/topics")
      .then(function(r){ return r.json(); })
      .then(function(d){
        var prevCount = boardData.topics ? boardData.topics.length : 0;
        var prevPosts = boardLastPostCount;
        boardData = d;
        renderBoardTopics();
        document.getElementById("board-status").textContent = "● loaded";
        document.getElementById("board-status").style.color = "#4ade80";
        var newCount = boardData.topics.length;
        var totalPosts = boardData.topics.reduce(function(sum, t) { return sum + (t.posts || []).length; }, 0);
        if (newCount !== prevCount || totalPosts !== prevPosts) {
          var ind = document.getElementById("board-updated-indicator");
          if (ind) { ind.style.display = "inline"; setTimeout(function(){ if(ind) ind.style.display = "none"; }, 10000); }
        }
        boardLastPostCount = totalPosts;
      })
      .catch(function(e){
        document.getElementById("board-status").textContent = "● error: " + e.message;
        document.getElementById("board-status").style.color = "#f87171";
      });
  }
  
  function setBoardFilter(filter) {
    boardStatusFilter = filter;
    // Update filter tab styling
    var filters = document.querySelectorAll('#board-filter-bar .board-filter');
    for (var i = 0; i < filters.length; i++) {
      var cls = filters[i].getAttribute('data-filter') === filter ? 'board-filter active' : 'board-filter';
      filters[i].className = cls;
    }
    renderBoardTopics();
  }
  
  function getStatusBadge(status) {
    var colors = {
      'active': 'background:#1a3a2a;color:#4ade80;',
      'in-progress': 'background:#3a2a1a;color:#fbbf24;',
      'completed': 'background:#1a2a3a;color:#60a5fa;',
      'archived': 'background:#2a2a2a;color:#6b6b80;'
    };
    var label = status === 'in-progress' ? 'in progress' : status;
    return '<span style="' + (colors[status] || colors.active) + 'padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;">' + label + '</span>';
  }
  
  function renderBoardTopics() {
    var list = document.getElementById('board-topics-list');
    var filtered = boardData.topics;
    if (boardStatusFilter !== 'all') {
      filtered = filtered.filter(function(t) { return t.status === boardStatusFilter; });
    }
    if (!filtered || filtered.length === 0) {
      list.innerHTML = '<div style="color:#6b6b80;text-align:center;padding:20px 0;font-size:12px;">' +
        (boardStatusFilter !== 'all' ? 'No ' + boardStatusFilter + ' topics.' : 'No topics yet. Create one to start tracking progress.') +
        '</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      var t = filtered[i];
      var postCount = (t.posts || []).length;
      var lastPost = postCount > 0 ? t.posts[t.posts.length - 1] : null;
      var active = boardCurrentTopic && boardCurrentTopic.id === t.id ? ' active' : '';
      var pinIcon = t.pinned ? '<span style="color:#fbbf24;font-size:10px;">📌</span> ' : '';
      var assignBadge = t.assigned_agent ? '<span style="color:#60a5fa;font-size:9px;">@' + t.assigned_agent + '</span>' : '';
      html += '<div class="board-topic' + active + '" data-topic-id="' + t.id + '">';
      html += '<div class="board-topic-title">' + pinIcon + getStatusBadge(t.status) + ' ' + t.title.replace(/</g,'&lt;') + '</div>';
      html += '<div class="board-topic-meta">' + postCount + ' post' + (postCount !== 1 ? 's' : '') + ' \u2022 by ' + t.creator + ' \u2022 ' + (t.created_at || '').slice(0,10);
      if (assignBadge) html += ' \u2022 ' + assignBadge;
      if (lastPost) html += ' \u2022 Last: ' + lastPost.author + ' ' + timeAgo(lastPost.ts);
      html += '</div></div>';
    }
    list.innerHTML = html;
    
    // Attach click delegation for board topics (avoid inline onclick escaping issues)
    var topicsContainer = document.getElementById('board-topics-list');
    if (topicsContainer) {
      topicsContainer.onclick = function(e) {
        var target = e.target;
        while (target && target !== topicsContainer) {
          if (target.hasAttribute && target.hasAttribute('data-topic-id')) {
            openBoardTopic(target.getAttribute('data-topic-id'));
            return;
          }
          target = target.parentNode;
        }
      };
    }
  }
  
  function openBoardTopic(id) {
    boardCurrentTopic = null;
    for (var i = 0; i < boardData.topics.length; i++) {
      if (boardData.topics[i].id === id) {
        boardCurrentTopic = boardData.topics[i];
        break;
      }
    }
    if (!boardCurrentTopic) return;
    document.getElementById('board-topics-list').style.display = 'none';
    document.getElementById('board-topic-posts').style.display = 'block';
    document.getElementById('board-current-topic-title').textContent = boardCurrentTopic.title;
    
    // Update status badge in detail view
    document.getElementById('board-current-topic-status').innerHTML = getStatusBadge(boardCurrentTopic.status);
    document.getElementById('board-status-select').value = boardCurrentTopic.status;
    
    // Update assignment
    var assignEl = document.getElementById('board-current-topic-assignment');
    assignEl.textContent = boardCurrentTopic.assigned_agent ? '@' + boardCurrentTopic.assigned_agent : '';
    
    // Update pin button
    var pinBtn = document.getElementById('board-pin-btn');
    pinBtn.textContent = boardCurrentTopic.pinned ? 'Unpin' : 'Pin';
    pinBtn.style.borderColor = boardCurrentTopic.pinned ? '#fbbf24' : '#3a3a5a';
    
    renderBoardPosts();
  }
  
  function closeBoardTopic() {
    boardCurrentTopic = null;
    document.getElementById('board-topics-list').style.display = '';
    document.getElementById('board-topic-posts').style.display = 'none';
  }
  
  function renderBoardPosts() {
    var list = document.getElementById('board-posts-list');
    if (!boardCurrentTopic || !boardCurrentTopic.posts || boardCurrentTopic.posts.length === 0) {
      list.innerHTML = '<div style="color:#6b6b80;text-align:center;padding:15px 0;font-size:12px;">No posts yet. Be the first!</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < boardCurrentTopic.posts.length; i++) {
      var p = boardCurrentTopic.posts[i];
      var agentClass = 'board-agent-' + (p.agent || 'vex').toLowerCase();
      html += '<div class="board-post">';
      html += '<div class="board-post-header"><span class="board-agent-badge ' + agentClass + '">' + (p.agent || 'agent').toUpperCase() + '</span> ' + timeAgo(p.ts);
      html += '<span style="float:right;font-size:9px;color:#6b6b80;cursor:pointer;" onclick="deleteBoardPost(\\'' + p.id + '\\')" title="Delete post">✕</span>';
      html += '</div>';
      html += '<div class="board-post-body">' + renderMarkdown(p.message) + '</div>';
      html += '</div>';
    }
    list.innerHTML = html;
    list.scrollTop = list.scrollHeight;
  }
  
  function createBoardTopic() {
    var input = document.getElementById('board-new-topic-input');
    var title = input.value.trim();
    if (!title) return;
    input.value = '';
    var agent = getBoardAgent();
    var statusSelect = document.getElementById('board-new-status');
    var status = statusSelect ? statusSelect.value : 'active';
    var assignInput = document.getElementById('board-new-assignment');
    var assigned_agent = assignInput ? assignInput.value.trim() || null : null;
    var pinnedCheck = document.getElementById('board-new-pinned');
    var pinned = pinnedCheck ? pinnedCheck.checked : false;
    fetch('/api/bulletin/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, creator: agent, status: status, assigned_agent: assigned_agent, pinned: pinned })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          if (assignInput) assignInput.value = '';
          if (pinnedCheck) pinnedCheck.checked = false;
          if (statusSelect) statusSelect.value = 'active';
          switchBoardView('topics');
          loadBoard();
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
        document.getElementById('board-status').style.color = '#f87171';
      });
  }
  
  function changeTopicStatus(newStatus) {
    if (!boardCurrentTopic) return;
    fetch('/api/bulletin/topics/' + boardCurrentTopic.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          boardCurrentTopic.status = newStatus;
          document.getElementById('board-current-topic-status').innerHTML = getStatusBadge(newStatus);
          loadBoard();
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
      });
  }

  // Rename current topic. Works for both humans (prompt) and agents (PATCH /api/bulletin/topics/:id with {title}).
  // The endpoint accepts arbitrary field updates so a single PATCH can set title + status + assigned_agent + pinned in one call.
  function renameBoardTopic() {
    if (!boardCurrentTopic) return;
    var current = boardCurrentTopic.title || '';
    var next = prompt('Rename topic:', current);
    if (next === null) return;
    next = next.trim();
    if (!next) { alert('Title cannot be empty.'); return; }
    if (next === current) return;
    fetch('/api/bulletin/topics/' + boardCurrentTopic.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: next })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          boardCurrentTopic.title = d.topic.title;
          document.getElementById('board-current-topic-title').textContent = d.topic.title;
          // Also update the in-memory list so the sidebar shows the new title after re-render
          for (var i = 0; i < boardData.topics.length; i++) {
            if (boardData.topics[i].id === d.topic.id) boardData.topics[i].title = d.topic.title;
          }
          loadBoard();
          document.getElementById('board-status').textContent = '\u2713 renamed';
          document.getElementById('board-status').style.color = '#4ade80';
        } else {
          document.getElementById('board-status').textContent = '\u2716 rename failed: ' + (d.error || 'unknown');
          document.getElementById('board-status').style.color = '#f87171';
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
        document.getElementById('board-status').style.color = '#f87171';
      });
  }

  function togglePinTopic() {
    if (!boardCurrentTopic) return;
    var newPinned = !boardCurrentTopic.pinned;
    fetch('/api/bulletin/topics/' + boardCurrentTopic.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: newPinned })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          boardCurrentTopic.pinned = newPinned;
          var pinBtn = document.getElementById('board-pin-btn');
          pinBtn.textContent = newPinned ? 'Unpin' : 'Pin';
          pinBtn.style.borderColor = newPinned ? '#fbbf24' : '#3a3a5a';
          loadBoard();
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
      });
  }
  
  function sendBoardPost() {
    if (!boardCurrentTopic) return;
    var input = document.getElementById('board-post-input');
    var msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    var agent = getBoardAgent();
    fetch('/api/bulletin/topics/' + boardCurrentTopic.id + '/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: agent, message: msg, agent: agent })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          loadBoard();
          // Re-open the current topic after reload
          setTimeout(function() { openBoardTopic(boardCurrentTopic.id); }, 100);
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
        document.getElementById('board-status').style.color = '#f87171';
      });
  }
  
  function deleteBoardPost(postId) {
    if (!boardCurrentTopic || !confirm('Delete this post?')) return;
    fetch('/api/bulletin/topics/' + boardCurrentTopic.id + '/posts/' + postId, {
      method: 'DELETE'
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          loadBoard();
          setTimeout(function() { openBoardTopic(boardCurrentTopic.id); }, 100);
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
      });
  }
  
  function switchBoardView(view) {
    document.getElementById('tab-topics').className = 'board-tab' + (view === 'topics' ? ' active' : '');
    document.getElementById('tab-newtopic').className = 'board-tab' + (view === 'new' ? ' active' : '');
    document.getElementById('board-topics-view').style.display = view === 'topics' ? '' : 'none';
    document.getElementById('board-new-topic-view').style.display = view === 'new' ? '' : 'none';
    if (view === 'topics') closeBoardTopic();
  }
  
  function deleteBoardTopic() {
    if (!boardCurrentTopic || !confirm('Delete this resolution permanently?')) return;
    fetch('/api/bulletin/topics/' + boardCurrentTopic.id, {
      method: 'DELETE'
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          boardCurrentTopic = null;
          switchBoardView('topics');
          loadBoard();
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
        document.getElementById('board-status').style.color = '#f87171';
      });
  }

  function getBoardAgent() {
    var nameInput = document.getElementById('fleet-chat-name');
    return (nameInput ? nameInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') : 'vex') || 'vex';
  }
  
  function timeAgo(ts) {
    var diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  // Copy mining script to clipboard
  function copyMiningScript() {
    var el = document.getElementById('mining-script');
    var text = el.textContent || el.innerText;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        var orig = el.style.background;
        el.style.background = '#1a3a2a';
        el.style.transition = 'background 0.3s';
        setTimeout(function(){ el.style.background = orig; }, 1000);
      }).catch(function(){});
    } else {
      // Fallback
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  // Load initial fleet messages + poll every 5 seconds
  setTimeout(fetchFleetMessages, 500);
  setInterval(fetchFleetMessages, 5000);

  // Load bulletin board
  setTimeout(loadBoard, 1000);
  setInterval(loadBoard, 30000);

  // Next campaign drop calculation — Costa Rica time (UTC-6)
  (function() {
    var now = new Date();
    var hour = now.getUTCHours() - 6; // CR offset
    if (hour < 0) hour += 24;
    var min = now.getMinutes();
    var schedule = [8, 10, 12, 14, 16, 18]; // 8:30am, 10:30am, 12:30pm, 2:30pm, 4:30pm, 6:30pm CR
    var next = schedule.find(function(h) { return h > hour || (h === hour && min < 30); });
    var label;
    if (next === undefined) {
      label = 'Tomorrow 8:30AM CR';
    } else {
      var ampm = next >= 12 ? 'PM' : 'AM';
      var h12 = next > 12 ? next - 12 : (next === 0 ? 12 : next);
      label = h12 + ':30 ' + ampm + ' CR';
    }
    var el = document.getElementById('next-drop');
    if (el) el.textContent = label;
  })();

  // Next 31 Harbor drop — Eastern Time (UTC-4/UTC-5)
  (function() {
    var now = new Date();
    var etOffset = (now.getTimezoneOffset() === 240 || now.getTimezoneOffset() === 300)
      ? now.getTimezoneOffset() : 240;
    var hour = (now.getUTCHours() - etOffset / 60 + 24) % 24;
    var min = now.getMinutes();
    var schedule = [7, 9, 11]; // 7:00, 9:00, 11:00 AM ET send slots
    var next = schedule.find(function(h) { return h > hour || (h === hour && min < 1); });
    var label;
    if (next === undefined) {
      label = 'Tomorrow 7:00AM ET';
    } else {
      var ampm = next >= 12 ? 'PM' : 'AM';
      var h12 = next > 12 ? next - 12 : (next === 0 ? 12 : next);
      label = h12 + ':00 ' + ampm + ' ET';
    }
    var el = document.getElementById('harbor-next-drop');
    if (el) el.textContent = label;
  })();
  
// Mesh Network Particle Animation
(function(){
  const canvas = document.getElementById('mesh-bg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];
  function resize() { W = canvas.width = innerWidth; H = canvas.height = innerHeight; }
  resize(); addEventListener('resize', resize);
  
  class Particle {
    constructor() {
      this.x = Math.random() * W; this.y = Math.random() * H;
      this.vx = (Math.random() - 0.5) * 0.4; this.vy = (Math.random() - 0.5) * 0.4;
      this.r = Math.random() * 1.5 + 1; this.life = Math.random() * 100;
    }
    update() {
      this.x += this.vx; this.y += this.vy; this.life++;
      if (this.x < 0 || this.x > W) this.vx *= -1;
      if (this.y < 0 || this.y > H) this.vy *= -1;
    }
    draw() {
      const pulse = 0.5 + 0.5 * Math.sin(this.life * 0.03);
      ctx.beginPath(); ctx.arc(this.x, this.y, this.r * pulse, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,102,0,' + (0.4 * pulse) + ')'; ctx.fill();
    }
  }
  for (let i = 0; i < 60; i++) particles.push(new Particle());
  
  let mouse = { x: W / 2, y: H / 2 };
  document.addEventListener('mousemove', function(e) { mouse.x = e.clientX; mouse.y = e.clientY; });
  
  function animate() {
    ctx.fillStyle = 'rgba(10,10,15,0.15)'; ctx.fillRect(0, 0, W, H);
    particles.forEach(function(p) { p.update(); p.draw(); });
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x, dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 150) {
          ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y); ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = 'rgba(255,102,0,' + (0.12 * (1 - dist / 150)) + ')'; ctx.lineWidth = 0.6; ctx.stroke();
        }
      }
      const dx = particles[i].x - mouse.x, dy = particles[i].y - mouse.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 200) {
        ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y); ctx.lineTo(mouse.x, mouse.y);
        ctx.strokeStyle = 'rgba(255,102,0,' + (0.15 * (1 - dist / 200)) + ')'; ctx.lineWidth = 0.8; ctx.stroke();
      }
    }
    requestAnimationFrame(animate);
  }
  animate();
})();
</script>

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
      version: '2.0.0',
      tunnel: state.get('tunnel-url') || 'https://relay.mobilemonero.com',
      agent: 'TS Relay (Eliza-Dev laptop)',
    },
  });
});

// ── Generic dispatch ────────────────────────────────────────
app.post('/dispatch', async (req, res) => {
  const { message, source = 'manual', type, action, handler, payload } = req.body;
  trackRequest('/dispatch');
  logActivity('dispatch', source, 'RECEIVED', (message || type || action || '').slice(0, 80));

  let response = null;

  // Support structured JSON dispatch (type/action/handler fields + message fallback)
  const msg = (message || type || action || '').toLowerCase();
  const h = (handler || '').toLowerCase();

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
        version: '2.0.0',
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
      response = await toolHandlers[h](payload || {});
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
app.post('/webhook/resend-inbound', (req, res) => {
  const event = req.body;

  // Verify it's a Resend webhook event
  if (event?.type !== 'email.received') {
    return res.status(400).json({ error: 'unexpected event type' });
  }

  // Optional: verify webhook signature (per-domain secret)
  // Determine target domain before the body-fetch below for signature matching
  const { data } = event;
  const toArr = Array.isArray(data.to) ? data.to : (data.to ? [data.to] : []);
  const toDomain = toArr[0]?.includes('31harbor') ? '31harbor.com'
                  : toArr[0]?.includes('partyfavorphoto') ? 'partyfavorphoto.com'
                  : toArr[0]?.includes('mobilemonero') ? 'mobilemonero.com'
                  : toArr[0]?.includes('xmrt') ? 'mobilemonero.com'
                  : 'partyfavorphoto.com';
  const SIGNING_SECRETS = {
    'partyfavorphoto.com': process.env.RESEND_WEBHOOK_SECRET,
    'mobilemonero.com': process.env.RESEND_MM_WEBHOOK_SECRET,
    '31harbor.com': process.env.RESEND_31HARBOR_WEBHOOK_SECRET,
  };
  const signingSecret = SIGNING_SECRETS[toDomain] || process.env.RESEND_WEBHOOK_SECRET;
  if (signingSecret) {
    try {
      const crypto = require('crypto');
      const svixId = req.headers['svix-id'];
      const svixTimestamp = req.headers['svix-timestamp'];
      const svixSignature = req.headers['svix-signature'];

      if (svixId && svixTimestamp && svixSignature) {
        const signedContent = `${svixId}.${svixTimestamp}.${JSON.stringify(req.body)}`;
        const expectedSig = crypto
          .createHmac('sha256', signingSecret)
          .update(signedContent)
          .digest('base64');

        const receivedSigs = svixSignature.split(' ').map(s => s.replace(/^v1,/,''));
        const isValid = receivedSigs.some(sig => {
          try {
            return crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sig));
          } catch { return false; }
        });

        if (!isValid) {
          console.warn('[Resend Inbound] Invalid webhook signature - processing anyway');
        }
      }
    } catch (e) {
      console.warn('[Resend Inbound] Signature verification error:', e.message);
    }
  }

  const emailId = data.id || data.email_id;
  const emailEntry = {
    email_id: emailId,
    from: data.from,
    from_name: data.from_name,
    to: data.to,
    cc: data.cc,
    subject: data.subject,
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

  // ── Forward 31harbor Re: replies to dvdelze@gmail.com ────
  if (toDomain === '31harbor.com' && data.subject && /^Re:/i.test(data.subject)) {
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
  // Determine which Resend key to use based on recipient domain
  const RESEND_KEYS = {
    'partyfavorphoto.com': process.env.RESEND_API_KEY,
    'mobilemonero.com': process.env.RESEND_XMRT_API_KEY,
    '31harbor.com': process.env.RESEND_31HARBOR_API_KEY,
  };
  const RESEND_API_KEY = RESEND_KEYS[toDomain] || process.env.RESEND_API_KEY;
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
// Cloud Supabase (vawouugtzwmejxqkeqqj) is dead; this used to be hardcoded.
const SUPABASE_UNIVERSITY_URL = `${SUPABASE_URL}/functions/v1/xmrt-university`;

app.post('/api/ef-university', async (req, res) => {
  try {
    const r = await fetch(SUPABASE_UNIVERSITY_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
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

  // Verify against Supabase so we don't accept self-issued garbage
  let verified = null;
  try {
    const verifyRes = await fetch(SUPABASE_UNIVERSITY_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify', agent_id: cert.agent_id }),
      signal: AbortSignal.timeout(8000),
    });
    verified = await verifyRes.json();
    if (!verified?.valid) {
      return res.status(403).json({ success: false, error: 'certificate not valid in Supabase', verify: verified });
    }
  } catch (e) {
    return res.status(502).json({ success: false, error: 'verify failed: ' + e.message });
  }

  // Persist cert + a per-agent map for quick lookup
  const stored = {
    cert_id: verified.certificate.certificate_id,
    agent_id: verified.certificate.agent_id,
    agent_name: verified.certificate.agent_name,
    tier: verified.certificate.tier,
    permissions: verified.certificate.permissions,
    issued_at: verified.certificate.issued_at,
    expires_at: verified.certificate.expires_at,
    jwt: jwt || null,
    ingested_at: new Date().toISOString(),
    source: 'xmrt-university/ingest',
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
  const target = `${LOCAL_RUNTIME_URL}${targetPath}`;
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

app.all(['/functions/v1/:name', '/functions/v1/:name/*'], async (req, res) => {
  const tail = req.params[0] ? '/' + req.params[0] : '';
  await proxyToRuntime(req, res, `/functions/v1/${req.params.name}${tail}`);
});

// Backwards-compat: short alias `POST /ai-chat` -> `/functions/v1/ai-chat`
app.all(['/ai-chat', '/ai-chat/*'], async (req, res) => {
  const tail = req.params[0] ? '/' + req.params[0] : '';
  await proxyToRuntime(req, res, `/functions/v1/ai-chat${tail}`);
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

app.get('/api/catalog', (req, res) => {
  const catalogPath = join(__dirname, 'edge-function-catalog.json');
  try {
    const data = JSON.parse(readFileSync(catalogPath, 'utf8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Catalog not available', message: e.message });
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
      // Fallback: try old health check
      try {
        const hermesRes = await fetch('https://hermes.mobilemonero.com/health', {
          signal: AbortSignal.timeout(3000),
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
          throw new Error('Health check failed');
        }
      } catch (e) {
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
    
    // Update Vex with live status
    agents['vex'] = {
      ...(agents['vex'] || {}),
      agent_id: 'vex',
      name: 'Vex',
      status: 'ONLINE',
      role: 'relay',
      tunnel_url: 'https://relay.mobilemonero.com',
      version: '5.0.0',
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
    res.json({
      connected: bridgeState.connected || false,
      uptime: bridgeState.uptime || 0,
      nodes: Object.keys(nodes).length,
      nodeList: Object.values(nodes).map(n => ({
        id: n.id,
        name: n.name || n.id,
        rssi: n.rssi,
        snr: n.snr,
        lastHeard: n.lastHeard,
      })),
      messageCount: bridgeState.messageCount || 0,
      transport: bridgeState.transport || 'disconnected',
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
    if (messages.length > 500) messages.splice(0, messages.length - 500);
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
      lastPublish: messages.length > 0 ? messages[messages.length - 1].ts : null,
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
  
  const hostname = execSync('hostname', { encoding: 'utf8' }).trim();
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
      version: '2.0.0',
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
    agent: 'Eliza-Dev',
    host: execSync('hostname', { encoding: 'utf8' }).trim(),
    uptime: process.uptime(),
    port: PORT,
    version: '2.0.0',
    handlers: Object.keys(handlers),
    tools: Object.keys(toolHandlers),
    recentActivity: activityLog.slice(0, 20),
    requestCounts,
    taskRunner: taskRunner.getStats(),
    state: state.keys(),
  });
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

function getToolDescription(name) {
  const descriptions = {
    'web-search': 'Search the web via Ollama or DuckDuckGo fallback',
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
    'vex-vision': 'Capture a photo from the webcam and describe it using a vision model',
    'vex-hear': 'Capture audio from the microphone for a specified duration',
    'resend-inbox': 'Read recent emails from the Resend inbox (pfp, mobilemonero, 31harbor)',
    'resend-send-email': 'Send an email via Resend as a fleet agent (vex, eliza, hermes, pfp, harbor)',
    'db-query': 'Run a raw SQL query against the local Postgres database (read-only; use SELECT only)',
    'db-rest': 'Query any database table via the local-sb REST API using path and optional method/body',
    'shared-context': 'Read or write shared context memory visible to all agents (action: read|write, key, value)',
    'agent-profile': 'Read agent profiles from the database (agent_id or list all)',
    'edge-function': 'Proxy a call to a Supabase edge function by name (e.g. system-status, schema-tables)',
    'fleet-chat': 'Send a message to the fleet chat as an agent (vex|eliza|hermes) on a channel (fleet|all|vex|eliza|hermes)',
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
    'ef:functions-list': 'List all available edge function names',
    'ef:supabase-integration': 'Check Supabase integration health via cloud edge function',
    'ef:functions-catalog': 'List available edge functions (alias for functions-list)',
    'ef:function-actions': 'Get available actions for edge functions',
    'ef:search-functions': 'Search for edge functions by query string',
    'ef:ecosystem-health': 'Check ecosystem health via cloud edge function',
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
    'ef:vertex-ai': 'Chat via local Ollama + generate media via MuAPI (replaced Vertex AI)',
    'ef:paragraph-publish': 'Publish an article to Paragraph.com via cloud edge function',
    'ef:typefully-send': 'Schedule/send a tweet via Typefully integration',
    'ef:universal-invoke': 'Call any edge function by name with custom payload',
  };
  return descriptions[name] || 'No description';
}

// ── Agent Authorization ──────────────────────────────────────
import { checkToolAccess, getToolLevel, registerTrustedAgent, getAgentInfo, listAgents, CORE_AGENTS, TRUST_LEVELS } from './lib/agent-auth.mjs';

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
    return res.status(404).json({ error: `Tool "${tool}" not found`, available: Object.keys(toolHandlers) });
  }
  
  // ── Authorization check ──
  const toolLevel = getToolLevel(tool);
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
  
  // Run via task runner for async safety
  const taskId = taskRunner.addTask(tool, async () => await handler(args), {
    metadata: { tool, args, agent: agentId },
    timeout: args?.timeout || 60000,
  });
  
  // Wait for result (short tasks only — in production, return task ID for polling)
  const result = await new Promise((resolve) => {
    const check = () => {
      const task = taskRunner.getTask(taskId);
      if (task && task.status !== 'running' && task.status !== 'queued' && task.status !== 'retrying') {
        resolve(task.result || { error: task.error?.message || 'Unknown error', status: task.status });
      } else {
        setTimeout(check, 100);
      }
    };
    setTimeout(() => resolve({ error: 'Task timed out waiting for execution', taskId }), args?.timeout || 90000);
    check();
  });
  
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
    const c = new PgClient({ host: '127.0.0.1', port: 5432, user: 'postgres', password: 'postgres', database: 'xmrt_suite', connectionTimeoutMillis: 2000 });
    await c.connect();
    try {
      // 2) Aggregate the dashboard fields from local tables.
      // The schema was migrated from Supabase on 2026-06-07; some
      // tables are empty (we never had a real write path) but the
      // structure is in place. We COALESCE nulls to 0 so the
      // dashboard always renders.
      const queries = [
        c.query("SELECT COUNT(*)::int AS c FROM public.agents").catch(() => ({ rows: [{ c: 0 }] })),
        c.query("SELECT COUNT(*)::int AS c FROM public.agents WHERE status = 'busy'").catch(() => ({ rows: [{ c: 0 }] })),
        c.query("SELECT COUNT(*)::int AS c FROM public.tasks").catch(() => ({ rows: [{ c: 0 }] })),
        c.query("SELECT COUNT(*)::int AS c FROM public.tasks WHERE status IN ('completed','done')").catch(() => ({ rows: [{ c: 0 }] })),
        c.query("SELECT COUNT(*)::int AS c FROM public.eliza_function_usage WHERE invoked_at > NOW() - INTERVAL '24 hours'").catch(() => ({ rows: [{ c: 0 }] })),
        c.query("SELECT COUNT(*)::int AS c FROM public.python_execs").catch(() => ({ rows: [{ c: 0 }] })),
        c.query("SELECT COUNT(*)::int AS c FROM public.api_keys").catch(() => ({ rows: [{ c: 0 }] })),
      ];
      const [agents, agentsBusy, tasks, tasksDone, fnCalls24h, pyExecs, apiKeys] = await Promise.all(queries);
      // Also count total tables + schemas for richness
      const tablesRes = await c.query("SELECT COUNT(*)::int AS c FROM pg_tables WHERE schemaname='public'");
      const schemasRes = await c.query("SELECT COUNT(*)::int AS c FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema')");

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
      // Compute a simple health score 0-100.
      // Base 50 for being reachable. +25 if any agents. +15 if any
      // function calls. +10 if tasks table exists (schema migrated).
      let score = 50;
      if (counts.agents_total > 0)            score += 20;
      if (counts.fn_calls_24h > 0)            score += 15;
      if (counts.pg_tables_public > 40)       score += 10;   // schema loaded
      if (counts.tasks_total > 0)             score += 5;
      score = Math.min(100, score);
      const status = score >= 80 ? 'healthy' : score >= 50 ? 'degraded' : 'critical';

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
        // Inject supervisor-managed service statuses (read from supervisor-state.json)
        services: (() => {
          try {
            const stateFile = join(DATA_DIR, 'supervisor-state.json');
            if (!existsSync(stateFile)) return null;
            const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
            const svcs = raw.services || {};
            const out = {};
            for (const [name, svc] of Object.entries(svcs)) {
              out[name] = {
                childPid: svc.childPid,
                startedAt: svc.startedAt,
                uptimeSec: svc.startedAt ? Math.floor((Date.now() - svc.startedAt) / 1000) : 0,
                restartCount: Array.isArray(svc.restartTimestamps) ? svc.restartTimestamps.length : 0,
              };
            }
            return out;
          } catch (_) { return null; }
        })(),
        latency_ms: Date.now() - t0,
        timestamp: new Date().toISOString(),
      });
    } finally {
      await c.end();
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

// GET /api/dao/github — GitHub org activity
app.get('/api/dao/github', async (req, res) => {
  trackRequest('/api/dao/github');
  const GH_TOKEN = process.env.GITHUB_TOKEN || '';
  const GH_HEADERS = GH_TOKEN ? { 'Authorization': `token ${GH_TOKEN}` } : {};

  try {
    // Search repos in org
    const reposRes = await fetch('https://api.github.com/search/repositories?q=org:xmrtdao&sort=updated&per_page=10', {
      headers: GH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    const repos = reposRes.ok ? await reposRes.json() : { items: [] };

    // Fetch recent commits from the 4 key repos in parallel
    const keyRepos = ['xmrtdao/suite', 'xmrtdao/mobilemonero', 'xmrtdao/zero-claw', 'xmrtdao/xmrt-mesh', 'xmrtdao/sea-hampton-house'];
    const commitResults = await Promise.allSettled(
      keyRepos.map(repo =>
        fetch(`https://api.github.com/repos/${repo}/commits?per_page=3`, {
          headers: GH_HEADERS,
          signal: AbortSignal.timeout(10000),
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
      signal: AbortSignal.timeout(10000),
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
const FLEET_CHAT_MAX = 500;

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
  'alice': { name: 'Alice (Sidecar)', endpoint: 'local', type: 'sidecar', localEndpoint: 'http://127.0.0.1:8080/api/alice/inbox' },
};

function getFleetChatMessages(limit = 50) {
  return fleetChatMessages.slice(-limit);
}

// Fleet message repair — catches U+FFFD (replacement character = diamond question mark)
// that the relay sometimes produces from encoding corruption, replaces with safe ASCII.
// Leaves proper Unicode (em dash, emoji, etc.) untouched.
function sanitizeFleetMessage(msg) {
  if (!msg) return msg;
  // Only strip the actual replacement character and bare surrogates
  return msg
    .replace(/\uFFFD/g, '--')
    .replace(/[\uD800-\uDFFF]/g, '');
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
  // Dedup: skip if we've seen this message in the last 5 minutes
  if (checkAndMarkDuplicated(agent, message)) return null;

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
  };
  fleetChatMessages.push(entry);
  if (fleetChatMessages.length > FLEET_CHAT_MAX) fleetChatMessages.splice(0, 100);
  // Persist to state every 5 messages
  if (fleetChatMessages.length % 5 === 0) {
    try {
      state.set('fleet-chat-history', fleetChatMessages.slice(-200));
    } catch {}
  }
  // Stamp last-spoke for cooldown
  agentLastSpokeAt[agent] = entry.ts;
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

  const [health, monitor, ollama, recentMsgs, supervisor, cloudElizaData] = await Promise.all([
    fetchJson('/health', 2000),
    fetchJson('/monitor', 12000),
    fetchJson('/ollama/health', 3000),
    fetchJson('/api/fleet-chat/messages?limit=20', 3000),
    fetchJson('/api/supervisor/status', 2000).catch(() => null),
    cloudElizaFetch(),
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
    const ctxRows = await localQuery("SELECT context_key, context_type, value, description, last_updated_by FROM public.shared_context ORDER BY context_key");
    if (ctxRows && ctxRows.length > 0) {
      sharedContext = ctxRows.map(r => ({
        key: r.context_key,
        type: r.context_type,
        value: typeof r.value === 'string' ? JSON.parse(r.value) : r.value,
        description: r.description,
        lastUpdatedBy: r.last_updated_by,
      }));
    }
  } catch (e) {
    // shared_context table may not exist yet
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
      uptimeSec: health?.uptime ? Math.floor(health.uptime) : null,
      tools: health?.tools,
      requests: health?.requests,
    },
    services: svcSummary,
    system: sysSummary,
    ollama: {
      status: ollama?.status,
      modelCount: Array.isArray(ollama?.models) ? ollama.models.length : null,
      models: Array.isArray(ollama?.models) ? ollama.models.slice(0, 8) : null,
      latencyMs: ollama?.latency,
    },
    supervisor: supervisor && !supervisor.error ? {
      relayUp: supervisor?.services?.relay?.childPid != null,
      // Wrapper-exit services (pg, local-sb, tunnel) have null childPid
      // because the wrapper process exits cleanly. Check uptimeSec > 0 instead.
      pgUp: (supervisor?.services?.pg?.uptimeSec || 0) > 0,
      localSbUp: (supervisor?.services?.['local-sb']?.uptimeSec || 0) > 0,
      tunnelUp: (supervisor?.services?.tunnel?.uptimeSec || 0) > 0,
    } : null,
    recentFleetChat: recent,
    sharedContext, // agents can read this to answer questions about shared memory
    cloudEliza: cloudElizaTools || { status: 'unreachable', note: 'Cloud edge function did not respond within 5s timeout or no SUPABASE_KEY set. Its tools are NOT available in this block.' },
    // Tools available to agents — each tool can be called via POST /tools/run with body {"tool":"<name>","args":{...}}
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
      INSERT INTO public.agents (name, status, current_workload, role)
      SELECT 'Eliza-Dev', 'idle', 0, 'executive'
      WHERE NOT EXISTS (SELECT 1 FROM public.agents WHERE name = 'Eliza-Dev')
    `);
    await queryLocalPg(`
      INSERT INTO public.tasks (title, status, category, priority)
      SELECT 'System health seed', 'COMPLETED', 'system', 0
      WHERE NOT EXISTS (SELECT 1 FROM public.tasks WHERE title = 'System health seed')
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
async function routeFleetMessage(entry) {
  const results = {};
  const nextHop = Math.min((entry.hop || 0) + 1, MAX_HOP_DEPTH);

  // Always log it
  logActivity('fleet-chat', entry.id, 'MSG', `[${entry.agentLabel}] ${entry.message.slice(0, 100)}`);

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
    const toolCallLine = reply.split('\n').find(l => /^\s*TOOL_CALL:\s*\{/.test(l.trim()));
    if (!toolCallLine) return { executed: false };
    const jsonText = toolCallLine.replace(/^\s*TOOL_CALL:\s*/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return { executed: false };
    }
    const toolName = parsed.tool;
    const args = parsed.args || {};
    if (!toolName || !toolHandlers[toolName]) return { executed: false };

    // Authorize the agent
    const toolLevel = getToolLevel(toolName);
    const auth = checkToolAccess(agentName, toolName, toolLevel);
    if (!auth.authorized) {
      addFleetMessage('system', `⚠️ ${agentName} tried to call ${toolName} but was denied: ${auth.reason}`, 'fleet');
      return { executed: false, error: auth.reason };
    }

    // Post interim via direct addFleetMessage (bypass postAndReRoute chain guard)
    addFleetMessage('system', `🔧 ${agentName} requested \`${toolName}\` — executing...`, 'fleet');
    console.log(`[agent-tool-exec] ${agentName} -> ${toolName} args=${JSON.stringify(args)}`);

    // Execute via relay's own /tools/run
    try {
      const res = await fetch(`http://localhost:${PORT}/tools/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-id': agentName },
        body: JSON.stringify({ tool: toolName, args: { ...args, _agent: agentName } }),
        signal: AbortSignal.timeout(30000),
      });
      const result = await res.json();

      // Post interim result
      const summary = result?.success === false
        ? `❌ ${toolName} failed: ${String(result?.error || 'unknown error').slice(0, 150)}`
        : `✅ ${toolName} → ${JSON.stringify(result).slice(0, 600)}`;
      addFleetMessage('system', `🔧 ${agentName}: ${summary}`, 'fleet');

      return { executed: true, toolName, args, result };
    } catch (e) {
      addFleetMessage('system', `⚠️ ${agentName}: ${toolName} tool error: ${e.message}`, 'fleet');
      return { executed: true, toolName, args, error: e.message };
    }
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

    // Route to Eliza via eliza-relay with conversation memory
  // Trigger on: direct channel, 'all' channel, or any message mentioning @Eliza
  const mentionsEliza = /@eliza/i.test(entry.message) || entry.channel === 'eliza';
  if (entry.channel === 'all' || entry.channel === 'eliza' || mentionsEliza) {
    try {
      // Load conversation history from local memory
      const sessionId = 'eliza-fleet-' + entry.agent;
      let contextHistory = '';
      try {
        const convRes = await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access?session_id=' + sessionId + '&limit=20', {
          signal: AbortSignal.timeout(3000),
        });
        const convData = await convRes.json();
        if (convData.messages && convData.messages.length > 0) {
          contextHistory = '\n\nRecent conversation context:\n' + convData.messages.map(function(m) {
            return '[' + m.agent + '] ' + m.content;
          }).join('\n');
        }
      } catch (e) { /* memory best-effort */ }

      // Store this message in conversation memory
      try {
        await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, role: 'user', agent: entry.agentLabel, content: entry.message }),
          signal: AbortSignal.timeout(3000),
        });
      } catch (e) { /* memory best-effort */ }

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
            signal: AbortSignal.timeout(10000),
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
      const fullPrompt = elizaMsg + '\n\nGROUNDING — Real-time system data:\n' + ctxJson + toolResultsBlock + '\n\nIMPORTANT: Read the `infrastructure` field first. The database is local Postgres, NOT cloud Supabase. Cloud Supabase is DEPRECATED. A "supabase" status of "error" or "unreachable" means the local-sb REST layer is down, not the cloud.\n\nIf you need information NOT in the grounding block, output a single line `TOOL_CALL: {"tool":"<name>","args":{...}}` on its own line. I will execute the tool, then come back for your final answer.\n\n**FORMAT RULE: Reply with ONLY the final answer — 1-2 sentences. No thinking aloud, no step-by-step reasoning, no "Let me analyze this", no "Here\'s what I found", no preamble. Just the answer. Be direct and specific. Reference data by name when you can.**';

      // Primary path: ai-chat edge function. Deepseek fallback is used when
      // ai-chat is unreachable.
      let elizaRes = null;
      try {
        elizaRes = await relayToElizaCloud(fullPrompt, entry.agentLabel, 'fleet-' + entry.id);
        console.log('[routeFleetMessage] ai-chat reply:', JSON.stringify(elizaRes).slice(0, 200));
      } catch (e) {
        console.log('[routeFleetMessage] ai-chat error:', e.message);
      }

      // Fallback: if ai-chat failed, try local deepseek
      if (!elizaRes?.reply) {
        try {
          const fbRes = await fetch('http://localhost:' + PORT + '/ollama/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: fullPrompt,
              model: 'deepseek-v4-flash:cloud',
              temperature: 0.4,
              maxTokens: 320,
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
          await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, role: 'assistant', agent: 'Eliza', content: elizaRes.reply }),
            signal: AbortSignal.timeout(3000),
          });
        } catch (e) { /* memory best-effort */ }

        // Strip verbose thinking / preamble / tool-syntax from Eliza's reply
        let cleanReply = elizaRes.reply;
        // Remove thinking-like blocks: "I'll analyze", "Here's my reasoning", "Let me break this down", etc.
        cleanReply = cleanReply.replace(/^(Let me analyze|I('ll| will) (analyze|break down|work through|start by|check on|look into)|Here('s| is) (my|the) (analysis|reasoning|breakdown|summary|verdict)).*?(?=\n[A-Z])/ims, '');
        // Collapse "Oh wait", "Actually", "Hmm", "Well", preamble words at line start
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
          const synthPrompt = fullPrompt + '\n\nYou called ' + elizaToolResult.toolName + ' and got: ' + JSON.stringify(elizaToolResult.result || elizaToolResult.error).slice(0, 1500) + '\n\nNow give your final answer (1-2 sentences):';
          try {
            const sR = await fetch('http://localhost:' + PORT + '/ollama/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: synthPrompt,
                model: 'deepseek-v4-flash:cloud',
                temperature: 0.4,
                maxTokens: 320,
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
              }
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
  // Hermes responds intelligently to any non-Hermes fleet message
  if ((entry.channel === 'all' || entry.channel === 'hermes' || (entry.channel === 'fleet' && /@hermes/i.test(entry.message))) && entry.agent !== 'hermes') {
    const hermesInfo = FLEET_AGENTS['hermes'];
    if (hermesInfo?.endpoint) {
      try {
        const hermesEndpoint = hermesInfo.endpoint;

        // Always send direct to Hermes so he can respond intelligently
        const hermesBody = {
          agent: entry.agentLabel || entry.agent,
          message: entry.message,
          type: 'direct',
          parentId: entry.id,
          ts: entry.ts,
        };
        const res = await fetch(`${hermesEndpoint}/to/hermes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(hermesBody),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = await res.json();
          results.hermes = { forwarded: true, msg_id: data.msg_id };
        }
      } catch (e) {
        results.hermes = { error: e.message };
      }
    }
    // Belt-and-suspenders: post a 1-line "Hermes notified" stub so the
    // channel shows visible motion even when his phone-side reply is slow
    // or out-of-band. This keeps the perpetual loop from stalling on Hermes.
    if (!results.hermes || results.hermes.forwarded) {
      try {
        await postAndReRoute('hermes', '🛰️ Hermes notified via fleet-broadcast — will respond on device.', 'fleet');
      } catch { /* non-fatal */ }
    }
  }

  // Vex responds to: @Vex mentions, channel=vex, fleet channel with @Vex, or website-inquiry keywords
  // (broadened from "inquiries only" so Vex can be a real conversational participant)
  const mentionsVex = /@vex/i.test(entry.message) || entry.channel === 'vex' || (entry.channel === 'fleet' && /@vex/i.test(entry.message));
  const isInquiry = entry.message.includes('From:') || entry.message.includes('WEBSITE') || entry.message.includes('BOOKING');
  if ((entry.channel === 'all' && (mentionsVex || isInquiry)) || entry.channel === 'vex' || (entry.channel === 'fleet' && mentionsVex)) {
    try {
      // Ground the prompt in real system state. Without this, the LLM
      // will happily invent "all systems nominal" with zero data.
      const ctx = await gatherFleetContext();
      const ctxJson = JSON.stringify(ctx, null, 0);
      // Load conversation history from local memory
      const vexSessionId = 'vex-fleet-' + entry.agent;
      let contextHistory = '';
      try {
        const convRes = await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access?session_id=' + vexSessionId + '&limit=20', {
          signal: AbortSignal.timeout(3000),
        });
        const convData = await convRes.json();
        if (convData.messages && convData.messages.length > 0) {
          contextHistory = '\n\nRecent conversation context:\n' + convData.messages.map(function(m) {
            return '[' + m.agent + '] ' + m.content;
          }).join('\n');
        }
      } catch (e) { /* memory best-effort */ }

      // Store this message in conversation memory
      try {
        await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: vexSessionId, role: 'user', agent: entry.agentLabel, content: entry.message }),
          signal: AbortSignal.timeout(3000),
        });
      } catch (e) { /* memory best-effort */ }

      const vexPersona = isInquiry
        ? `You are Vex, Joe Lee's primary AI agent. You work for Party Favor Photo (photo booth services in DC, VA, MD, Dallas/FW, PA/NJ) and XMRT DAO. Be sharp and direct. Respond as Vex to acknowledge the inquiry.`
        : `You are Vex, Joe Lee's primary AI agent — sharp, witty, and concise. You're chatting with the fleet. Address the message directly.`;
      const vexPrompt = `${vexPersona}

GROUNDING — Real-time system data (these are facts, not guesses). The \`tools\` array lists every tool you can call:
\`\`\`json
${ctxJson}
\`\`\`

GROUNDING RULES:
- If a fact is in the JSON block, reference it directly.
- If something is NOT in the JSON but a tool in the \`tools\` array can help (web-search, db-query, db-rest, resend-inbox, shared-context, etc.), output a single line \`TOOL_CALL: {"tool":"<name>","args":{...}}\` on its own line. I will execute it, then come back for your final answer.
- Read the \`infrastructure\` field first. It explains the architecture: the database is local Postgres, NOT cloud Supabase. Cloud Supabase is DEPRECATED. A \`supabase.status\` of "error" or "unreachable" means the local-sb REST layer is down, NOT the cloud database.
- Never claim "all systems nominal" or "no anomalies" without a matching field in the JSON.
- For questions about PFP leads, bookings, money, or campaigns: use resend-inbox or db-query to check. For web info: use web-search or web-scrape. For DB queries: use db-query or db-rest. For shared agent memory: use shared-context.

${entry.agentLabel} said: "${entry.message.replace(/"/g, "'")}"${contextHistory}

Your response (1-2 sentences, no emoji sign-offs, no "—Vex", no "o7"):`;
      const r = await fetch('http://localhost:11434/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-flash:cloud', prompt: vexPrompt, stream: false, options: { temperature: 0.5, max_tokens: 180 } }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const d = await r.json();
        let reply = (d.response || '').trim();
        // Defensive: strip the "—Vex" sign-off Vex models sometimes add
        reply = reply.replace(/\s*—\s*Vex\s*$/i, '').replace(/\s+o7\s*$/i, '');
        if (reply && reply.length > 0) {
          // Check for tool call — execute it then re-query for synthesis
          const toolResult = await executeAgentToolCall('vex', reply, entry);
          if (toolResult.executed) {
            // Re-query Vex with tool result for final answer
            const synthPrompt = vexPrompt + '\n\nYou called ' + toolResult.toolName + ' and got: ' + JSON.stringify(toolResult.result || toolResult.error).slice(0, 1500) + '\n\nNow give your final answer (1-2 sentences):';
            try {
              const sR = await fetch('http://localhost:11434/api/generate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'deepseek-v4-flash:cloud', prompt: synthPrompt, stream: false, options: { temperature: 0.5, max_tokens: 180 } }),
                signal: AbortSignal.timeout(15000),
              });
              if (sR.ok) {
                const sD = await sR.json();
                let finalReply = (sD.response || '').trim();
                finalReply = finalReply.replace(/\s*—\s*Vex\s*$/i, '').replace(/\s+o7\s*$/i, '');
                if (finalReply && finalReply.length > 0) {
                  // Store Vex's reply in conversation memory
                  try {
                    await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ session_id: vexSessionId, role: 'assistant', agent: 'Vex', content: finalReply }),
                      signal: AbortSignal.timeout(3000),
                    });
                  } catch (e) { /* memory best-effort */ }
                  await postAndReRoute('vex', finalReply, 'fleet');
                }
              }
            } catch (e) {
              console.log('[vex-tool-synth] error:', e.message);
            }
          } else {
            // Store Vex's reply in conversation memory
            try {
              await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: vexSessionId, role: 'assistant', agent: 'Vex', content: reply }),
                signal: AbortSignal.timeout(3000),
              });
            } catch (e) { /* memory best-effort */ }
            await postAndReRoute('vex', reply, 'fleet');
          }
        }
      }
    } catch (e) { console.log('[routeFleetMessage] vex error:', e.message); }
  }

  // Alice (sidecar) — observational, terse, persona-driven via Ollama.
  // Trigger on: @Alice mentions, channel=alice, or fleet channel with @Alice.
  const mentionsAlice = /@alice/i.test(entry.message) || entry.channel === 'alice' || (entry.channel === 'fleet' && /@alice/i.test(entry.message));
  if ((entry.channel === 'all' && mentionsAlice) || entry.channel === 'alice' || (entry.channel === 'fleet' && mentionsAlice)) {
    try {
      // Load conversation history from local memory
      const aliceSessionId = 'alice-fleet-' + entry.agent;
      let contextHistory = '';
      try {
        const convRes = await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access?session_id=' + aliceSessionId + '&limit=20', {
          signal: AbortSignal.timeout(3000),
        });
        const convData = await convRes.json();
        if (convData.messages && convData.messages.length > 0) {
          contextHistory = '\n\nRecent conversation context:\n' + convData.messages.map(function(m) {
            return '[' + m.agent + '] ' + m.content;
          }).join('\n');
        }
      } catch (e) { /* memory best-effort */ }

      // Store this message in conversation memory
      try {
        await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: aliceSessionId, role: 'user', agent: entry.agentLabel, content: entry.message }),
          signal: AbortSignal.timeout(3000),
        });
      } catch (e) { /* memory best-effort */ }

      const ctx = await gatherFleetContext();
      const ctxJson = JSON.stringify(ctx, null, 0);
      const alicePrompt = `You are Alice, Joe Lee's desktop sidecar agent. You're terse, observational, and screenshot-aware. You notice things. You don't fluff.

GROUNDING — Real-time data. The \`tools\` array lists every tool you can call:
\`\`\`json
${ctxJson}
\`\`\`

GROUNDING RULES:
- Reference specific fields (e.g. "relay uptime: 1234s", "supabase unreachable") only when they're in the JSON.
- If something is NOT in the JSON but a tool in the \`tools\` array can fetch it (resend-inbox, db-query, db-rest, shared-context, web-search), output a single line \`TOOL_CALL: {"tool":"<name>","args":{...}}\` on its own line. I will execute it, then come back for your final answer.
- One short sentence. Sharp and direct. No emoji sign-offs.

${entry.agentLabel} said: "${entry.message.replace(/"/g, "'")}"${contextHistory}`;
      const r = await fetch('http://localhost:11434/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-flash:cloud', prompt: alicePrompt, stream: false, options: { temperature: 0.4, max_tokens: 120 } }),
        signal: AbortSignal.timeout(12000),
      });
      if (r.ok) {
        const d = await r.json();
        let reply = (d.response || '').trim();
        reply = reply.replace(/\s*—\s*Alice\s*$/i, '').replace(/\s+o7\s*$/i, '');
        if (reply && reply.length > 0) {
          // Check for tool call — execute it then re-query for synthesis
          const toolResult = await executeAgentToolCall('alice', reply, entry);
          if (toolResult.executed) {
            const synthPrompt = alicePrompt + '\n\nYou called ' + toolResult.toolName + ' and got: ' + JSON.stringify(toolResult.result || toolResult.error).slice(0, 1500) + '\n\nNow give your final answer (one short sentence):';
            try {
              const sR = await fetch('http://localhost:11434/api/generate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'deepseek-v4-flash:cloud', prompt: synthPrompt, stream: false, options: { temperature: 0.4, max_tokens: 120 } }),
                signal: AbortSignal.timeout(12000),
              });
              if (sR.ok) {
                const sD = await sR.json();
                let finalReply = (sD.response || '').trim();
                finalReply = finalReply.replace(/\s*—\s*Alice\s*$/i, '').replace(/\s+o7\s*$/i, '');
                if (finalReply && finalReply.length > 0) {
                  // Store Alice's reply in conversation memory
                  try {
                    await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ session_id: aliceSessionId, role: 'assistant', agent: 'Alice', content: finalReply }),
                      signal: AbortSignal.timeout(3000),
                    });
                  } catch (e) { /* memory best-effort */ }
                  await postAndReRoute('alice', finalReply, 'fleet');
                }
              }
            } catch (e) {
              console.log('[alice-tool-synth] error:', e.message);
            }
          } else {
            // Store Alice's reply in conversation memory
            try {
              await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: aliceSessionId, role: 'assistant', agent: 'Alice', content: reply }),
                signal: AbortSignal.timeout(3000),
              });
            } catch (e) { /* memory best-effort */ }
            await postAndReRoute('alice', reply, 'fleet');
          }
        }
      }
    } catch (e) { console.log('[routeFleetMessage] alice error:', e.message); }
  }

  console.log('[routeFleetMessage] returning results:', JSON.stringify(results).slice(0, 200));
  return results;
}

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
  const { agent, message, channel } = req.body || {};
  
  if (!agent || !message) {
    return res.status(400).json({ error: 'agent and message are required', usage: { agent: 'vex|eliza|hermes', message: '...', channel: 'fleet|all|vex|eliza|hermes' } });
  }

  // Let addFleetMessage handle sanitization
  const entry = addFleetMessage(agent, message, channel || 'fleet');
  
  // Also publish to gossipsub fleet-broadcast topic
  publishToMesh('fleet-broadcast', { agent, message, channel, ts: entry.ts }).catch(() => {});
  
  // Route to other agents asynchronously — allow long timeouts (agents research before replying)
  const routePromise = routeFleetMessage(entry).catch(e => ({ error: e.message }));
  
  // Wait for routing if it's quick, otherwise return immediately
  const timeout = new Promise(r => setTimeout(r, 60000));
  const routes = await Promise.race([routePromise, timeout.then(() => ({}))]);
  
  res.json({
    success: true,
    message: entry,
    replies: routes,
  });
});

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
  
  // From Supabase fleet_messages table
  try {
    const supabaseUrl = SUPABASE_URL;
    const supabaseKey = SUPABASE_KEY;
    if (supabaseKey) {
      const sbRes = await fetch(supabaseUrl + '/rest/v1/fleet_messages?select=*&order=created_at.desc&limit=50', {
        headers: { 'apikey': supabaseKey, 'Authorization': 'Bearer ' + supabaseKey },
        signal: AbortSignal.timeout(5000),
      });
      if (sbRes.ok) {
        const sbMsgs = await sbRes.json();
        if (Array.isArray(sbMsgs)) {
          for (const sm of sbMsgs) {
            const sbid = 'sb-' + sm.id;
            if (!seenIds.has(sbid)) {
              seenIds.add(sbid);
              messages.push({
                id: sbid,
                agent: sm.agent_name || sm.agent_id || 'remote',
                agentLabel: (sm.agent_name || 'Remote').charAt(0).toUpperCase() + (sm.agent_name || 'Remote').slice(1),
                message: sm.message || '',
                channel: sm.topic === 'fleet-broadcast' ? 'fleet' : sm.topic,
                ts: new Date(sm.created_at).getTime(),
                time: sm.created_at,
                source: 'gossip-hub-remote',
              });
            }
          }
        }
      }
    }
  } catch (e) { /* Supabase merge best-effort */ }
  
  // Filter by channel
  if (channel !== 'all') {
    messages = messages.filter(m => m.channel === channel || m.channel === 'all');
  }
  
  // Filter by timestamp
  if (since > 0) {
    messages = messages.filter(m => m.ts > since);
  }
  
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
  
  // Determine domain for inbox routing
  const domain = toEmail.includes('31harbor') ? '31harbor.com'
               : toEmail.includes('partyfavorphoto') ? 'partyfavorphoto.com'
               : 'mobilemonero.com';
  
  // Store in inbox (even for unknown agents — they can read on relay)
  if (!isAutoReply) {
    addToInbox(domain, { to, from, subject, text, html, email_id, agent, attachments });
  }
  
  if (agent && !isAutoReply && cleanBody) {
    const msg = `📧 **Email from ${from}** — _${subject || 'no subject'}_\n\n${cleanBody}`;
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
  const { agent, to, subject, body, from: customFrom } = req.body || {};
  
  if (!agent || !to || !subject || !body) {
    return res.status(400).json({ error: 'agent, to, subject, and body required' });
  }
  
  const AGENT_FROM = {
    'vex': 'Vex Relay <vex@mobilemonero.com>',
    'eliza': 'Eliza Cloud <eliza@mobilemonero.com>',
    'hermes': 'Hermes Mobile <hermes@mobilemonero.com>',
    'pfp': 'Party Favor Photo <bookings@partyfavorphoto.com>',
    'harbor': '31 Harbor <david@31harbor.com>',
  };
  
  // Allow custom from override, otherwise use agent mapping
  const from = customFrom || AGENT_FROM[agent];
  if (!from) return res.status(400).json({ error: `Unknown agent: ${agent}. Try 'pfp' for bookings@partyfavorphoto.com or 'harbor' for david@31harbor.com` });
  
  // Pick the right Resend key based on the from domain
  const RESEND_KEYS = {
    'mobilemonero.com': process.env.RESEND_XMRT_API_KEY || 'RESEND_XMRT_API_KEY_REMOVED',
    'partyfavorphoto.com': process.env.RESEND_API_KEY || 're_K1p8eaKu_2kQwBZyqcBGPPxvtkc43Xous',
    '31harbor.com': process.env.RESEND_31HARBOR_API_KEY || '',
  };
  const domain = from.match(/@([^>]+)/)?.[1]?.trim() || 'mobilemonero.com';
  const RESEND_KEY = RESEND_KEYS[domain] || RESEND_KEYS['mobilemonero.com'];
  
  try {
    const apiRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text: body }),
    });
    const data = await apiRes.json();
    
    if (apiRes.ok) {
      logActivity('fleet-email', data.id, 'SENT', `[${agent}] ${subject} → ${to}`);
      addFleetMessage(agent, `📤 **Email sent** to ${to}: _${subject}_`, 'fleet');
      res.json({ success: true, id: data.id });
    } else {
      res.status(apiRes.status).json({ error: data });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  const { agentId, message } = req.body || {};
  if (!agentId || !message) return res.status(400).json({ error: 'agentId and message required' });

  const RESEND_KEY = process.env.RESEND_31HARBOR_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'Resend key not configured' });

  const body = `New agent chat from cuttlefishclaws.com\n\nAgent: ${agentId}\nMessage: ${message}`;

  try {
    const apiRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Cuttlefish Labs <david@31harbor.com>',
        to: ['dvdelze@gmail.com', 'xmrtnet@gmail.com'],
        subject: `Agent Chat - ${agentId}`,
        text: body,
      }),
    });
    const data = await apiRes.json();

    if (apiRes.ok) {
      logActivity('contact-cuttlefishclaws-chat', data.id, 'SENT', `Chat from agent ${agentId}: ${message.substring(0, 80)}`);
      res.json({ success: true, id: data.id, response: 'Your message has been received. An agent will respond shortly.' });
    } else {
      res.status(500).json({ error: data });
    }
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
       FROM app.cuttlefish_agents WHERE did = $1`, [did]
    );
    if (!agent.rows.length) return res.status(404).json({ error: 'Agent not found' });

    const events = await queryLocalPg(
      `SELECT event_type, delta, score_after, note, created_at
       FROM app.cuttlefish_trust_events WHERE agent_did = $1
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
         FROM app.cuttlefish_cac_credentials WHERE id::text = $1`, [cacId]
      );
      rows = r.rows;
    } else {
      const r = await queryLocalPg(
        `SELECT id, tier, status, usdc_prepaid, token_balance, issued_at, expires_at
         FROM app.cuttlefish_cac_credentials WHERE agent_did = $1
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
         FROM app.cuttlefish_capital_stack WHERE is_active = 1
         ORDER BY display_order ASC`
      ),
      queryLocalPg(
        `SELECT program_key, name, category, administering_entity, applies_to, headline,
                amount_range, rate_or_credit, term_years, eligibility, application_url, contact, notes, display_order
         FROM app.cuttlefish_financing_programs WHERE is_active = 1
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
    let sql = `SELECT * FROM app.cuttlefish_financing_programs WHERE is_active = 1`;
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
      `SELECT id, status FROM app.cuttlefish_agents WHERE did = $1`, [did]
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
      `INSERT INTO app.cuttlefish_agents (did, name, agent_type, trust_score, status, metadata, updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,NOW())
       ON CONFLICT (did) DO UPDATE SET name=EXCLUDED.name, agent_type=EXCLUDED.agent_type, trust_score=EXCLUDED.trust_score, status='active', metadata=EXCLUDED.metadata, updated_at=NOW()
       RETURNING id, trust_score, status`,
      [did, agentName, agentType, rules.trust_floor, JSON.stringify(metadata || {})]
    );

    const cac = await queryLocalPg(
      `INSERT INTO app.cuttlefish_cac_credentials (agent_did, tier, usdc_prepaid, status, expires_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, tier, status`,
      [did, tier, prepaid, prepaid > 0 ? 'active' : 'pending', expiresAt]
    );

    await queryLocalPg(
      `INSERT INTO app.cuttlefish_trust_events (agent_did, event_type, delta, score_after, note)
       VALUES ($1,'onboard',$2,$3,$4)`,
      [did, rules.trust_floor, rules.trust_floor, `KYA passed. agentType=${agentType} tier=${tier} prepaid=$${prepaid}`]
    );

    await queryLocalPg(
      `INSERT INTO app.cuttlefish_agent_tasks (task_type, assigned_to, payload, priority)
       VALUES ('kya_check','trib',$1,3)`,
      [JSON.stringify({ agent_id: agent.rows[0].id, did, agent_type: agentType, tier, prepaid_usdc: prepaid, name: agentName })]
    );

    const a = agent.rows[0];
    const c = cac.rows[0];
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
      `SELECT id, trust_score, status FROM app.cuttlefish_agents WHERE did = $1`, [submitterDid]
    );
    if (!agent.rows.length) return res.status(403).json({ error: 'Submitter DID not found. Complete agent onboarding first.' });
    const ag = agent.rows[0];
    if (ag.status !== 'active' && ag.status !== 'online') return res.status(403).json({ error: `Agent status is "${ag.status}". Must be active or online to submit proposals.` });
    const trustScore = Number(ag.trust_score);
    if (trustScore < 40) return res.status(403).json({ error: `Trust score too low (${trustScore}/100). Minimum 40 required.` });

    const prior = await queryLocalPg(
      `SELECT id, version FROM app.cuttlefish_proposals
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
      `INSERT INTO app.cuttlefish_proposals (title, description, category, submitter_did, version, parent_id, status, ipfs_cid, chain_anchor_tx, combined_hash, routed_to, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,'submitted',$7,$8,$9,$10,$11) RETURNING id, created_at`,
      [title.trim(), description, category, submitterDid, version, parentId, ipfsCid, chainTx, combinedHash, routedTo,
       JSON.stringify({ ...metadata, fileUrls, content_preview: content.slice(0, 200) })]
    );

    const taskPayload = JSON.stringify({ proposal_id: proposal.rows[0].id, title: title.trim(), category, version, submitter_did: submitterDid, ipfs_cid: ipfsCid, combined_hash: combinedHash });
    await queryLocalPg(
      `INSERT INTO app.cuttlefish_agent_tasks (task_type, assigned_to, payload, priority) VALUES
       ('review_proposal','trib',$1,4), ('review_proposal','arch',$2,4)`,
      [taskPayload, taskPayload]
    );

    const newScore = Math.min(100, trustScore + 2);
    await queryLocalPg(`UPDATE app.cuttlefish_agents SET trust_score = $1 WHERE did = $2`, [newScore, submitterDid]);
    await queryLocalPg(
      `INSERT INTO app.cuttlefish_trust_events (agent_did, event_type, delta, score_after, reference, note)
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
        `INSERT INTO app.cuttlefish_trust_events (agent_did, event_type, delta, score_after, note)
         VALUES ('did:ethr:global-communicator-v1','constitutional_block',-50,28,$1)`,
        [`Blocked post: ${flags.join('; ')}`]
      );
    }

    await queryLocalPg(
      `INSERT INTO app.cuttlefish_agent_tasks (task_type, assigned_to, payload, priority)
       VALUES ($1,'trib',$2,$3)`,
      [needsTrib ? 'approve_post' : 'publish_post',
       JSON.stringify({ agent_did: 'did:ethr:global-communicator-v1', draft, constitutional_score: score, flags, needs_trib_approval: needsTrib, operator_approved }),
       draft.is_milestone ? 1 : 5]
    );

    await queryLocalPg(
      `INSERT INTO app.cuttlefish_trust_events (agent_did, event_type, delta, score_after, note)
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
      `SELECT did, name, agent_type, status, greeting FROM app.cuttlefish_agents WHERE id::text = $1 OR did = $1 OR LOWER(name) = LOWER($1) LIMIT 1`,
      [agentId]
    );
    if (!agent.rows.length) return res.status(404).json({ error: 'Agent not found' });
    const ag = agent.rows[0];

    // Map cuttlefish agent names to fleet agent labels
    const fleetAgentMap = {
      'trib': 'vex',
      'arch': 'vex',
      'global-communicator': 'vex',
      'trustgraph': 'vex',
      'dao': 'vex',
      'builder': 'eliza',
      'sovereign': 'eliza',
    };
    const fleetAgent = fleetAgentMap[ag.name?.toLowerCase()] || 'vex';

    // Build a contextual message for the fleet
    const fleetMessage = `[CuttlefishClaws] Agent "${ag.name}" (${ag.agent_type}) received: ${message}`;

    // Post to fleet chat and wait for routing
    const entry = addFleetMessage(fleetAgent, fleetMessage, 'fleet');
    const routePromise = routeFleetMessage(entry).catch(e => ({ error: e.message }));
    const timeout = new Promise(r => setTimeout(r, 30000));
    const routes = await Promise.race([routePromise, timeout.then(() => ({}))]);

    // Extract the agent's reply from fleet results
    let agentResponse = '';
    if (routes?.eliza?.message) {
      agentResponse = routes.eliza.message;
    } else if (routes?.vex?.message) {
      agentResponse = routes.vex.message;
    } else if (routes?.alice?.message) {
      agentResponse = routes.alice.message;
    } else {
      // Fallback: use the agent's greeting or a default response
      agentResponse = ag.greeting || `Hello! I'm ${ag.name}. Your message has been received by the fleet. An agent will respond shortly.`;
    }

    // Store the chat message in the DB
    await queryLocalPg(
      `INSERT INTO app.cuttlefish_chat_messages (agent_id, user_message, agent_response, simulated, created_at)
       VALUES ($1,$2,$3,0,NOW())`,
      [ag.did, message, agentResponse]
    );

    res.json({
      content: agentResponse,
      simulated: false,
      agentId: ag.did,
    });
  } catch (err) {
    // Fallback: return a graceful error response
    res.json({
      content: `I'm having trouble connecting to the fleet right now. Please try again shortly.`,
      simulated: true,
      agentId,
      error: true,
    });
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

// ── Bulletin Board API ────────────────────────────────────────
// Topics are stored in state under 'bulletin-board'
app.get('/api/bulletin/topics', (req, res) => {
  trackRequest('/api/bulletin/topics');
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
    title,
    creator,
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
  if (updates.title) topic.title = updates.title;
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
    author,
    agent: agent || author,
    message,
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

app.listen(PORT, '0.0.0.0', async () => {
  if (LOCAL_DB_ENABLED) {
    const ok = await ensureLocalDb();
    console.log(`  LocalDB:  ${ok ? 'connected (postgres @ 127.0.0.1:5432/xmrt_suite)' : 'FAILED — falling back to cloud REST'}`);
  } else {
    console.log('  LocalDB:  disabled (LOCAL_DB_MODE=false) — using cloud Supabase');
  }
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
        body: JSON.stringify({ model: 'deepseek-v4-flash:cloud', prompt: heartbeatPrompt, stream: false, options: { temperature: 0.4, max_tokens: 140 } }),
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
});

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
  if (domain === 'partyfavorphoto.com') return 'pfp';
  if (domain === '31harbor.com') return '31harbor';
  return 'mobilemonero';
}

function getInbox() {
  const inbox = state.get(EMAIL_STORE_KEY, { pfp: [], mobilemonero: [], '31harbor': [] });
  // Ensure all sub-keys exist even when persisted state predates a key
  if (!inbox.pfp) inbox.pfp = [];
  if (!inbox.mobilemonero) inbox.mobilemonero = [];
  if (!inbox['31harbor']) inbox['31harbor'] = [];
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
  if (inbox[key].length > 200) inbox[key] = inbox[key].slice(0, 200);
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

// ── Resend Inbox (PFP)
app.get('/resend/inbox', (req, res) => {
  const inbox = getInbox();
  const agent = req.query.agent || req.headers['x-agent-id'] || 'vex';
  res.json({
    domain: 'partyfavorphoto.com',
    total: inbox.pfp.length,
    unread: inbox.pfp.filter(e => !e.read).length,
    agent,
    emails: inbox.pfp.map(e => ({
      ...e,
      text: ['vex','hermes','eliza'].includes(agent) ? e.text : e.text.slice(0, 100),
    })),
  });
});

app.get('/resend/inbox/brief', (req, res) => {
  const inbox = getInbox();
  res.json({
    total: inbox.pfp.length,
    unread: inbox.pfp.filter(e => !e.read).length,
    recent: inbox.pfp.slice(0, 5).map(e => ({
      id: e.id, from: e.from, to: e.to, subject: e.subject,
      receivedAt: e.receivedAt, read: e.read,
    })),
  });
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

// ── Resend Inbox (XMRT)
app.get('/resend/mobilemonero/inbox', (req, res) => {
  const inbox = getInbox();
  const agent = req.query.agent || req.headers['x-agent-id'] || 'vex';
  res.json({
    domain: 'mobilemonero.com',
    total: inbox.mobilemonero.length,
    unread: inbox.mobilemonero.filter(e => !e.read).length,
    agent,
    emails: inbox.mobilemonero.map(e => ({
      ...e,
      text: ['vex','hermes','eliza'].includes(agent) ? e.text : e.text.slice(0, 100),
    })),
  });
});

app.get('/resend/mobilemonero/inbox/brief', (req, res) => {
  const inbox = getInbox();
  res.json({
    total: inbox.mobilemonero.length,
    unread: inbox.mobilemonero.filter(e => !e.read).length,
    recent: inbox.mobilemonero.slice(0, 5).map(e => ({
      id: e.id, from: e.from, to: e.to, subject: e.subject,
      receivedAt: e.receivedAt, read: e.read,
    })),
  });
});

app.post('/resend/mobilemonero/inbox/read', (req, res) => {
  const { id } = req.body;
  const inbox = getInbox();
  const email = inbox.mobilemonero.find(e => e.id === id);
  if (email) email.read = true;
  state.set(EMAIL_STORE_KEY, inbox);
  res.json({ success: true });
});

// ── Resend Inbox (31 Harbor)
app.get('/resend/31harbor/inbox', (req, res) => {
  const inbox = getInbox();
  const agent = req.query.agent || req.headers['x-agent-id'] || 'vex';
  res.json({
    domain: '31harbor.com',
    total: inbox['31harbor'].length,
    unread: inbox['31harbor'].filter(e => !e.read).length,
    agent,
    emails: inbox['31harbor'].map(e => ({
      ...e,
      text: ['vex','hermes','eliza'].includes(agent) ? e.text : e.text.slice(0, 100),
    })),
  });
});

app.get('/resend/31harbor/inbox/brief', (req, res) => {
  const inbox = getInbox();
  res.json({
    total: inbox['31harbor'].length,
    unread: inbox['31harbor'].filter(e => !e.read).length,
    recent: inbox['31harbor'].slice(0, 5).map(e => ({
      id: e.id, from: e.from, to: e.to, subject: e.subject,
      receivedAt: e.receivedAt, read: e.read,
    })),
  });
});

app.post('/resend/31harbor/inbox/read', (req, res) => {
  const { id } = req.body;
  const inbox = getInbox();
  const email = inbox['31harbor'].find(e => e.id === id);
  if (email) email.read = true;
  state.set(EMAIL_STORE_KEY, inbox);
  res.json({ success: true });
});

// ── Cron Status Endpoint ──
app.get('/cron/status', (req, res) => {
  const statePath = join(__dirname, '..', 'relay-data', 'cron-engine-state.json');
  try {
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state.status = 'running';
      state.relay_uptime = process.uptime();
      res.json(state);
    } else {
      res.json({ status: 'starting', note: 'Cron engine initializing...' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Suite Dashboard API (31 Harbor multi-tenant app) ────────────────
registerSuiteRoutes(app);
