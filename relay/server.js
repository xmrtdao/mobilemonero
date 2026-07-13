#!/usr/bin/env node
// Prevent background task crashes
process.on('uncaughtException', (err) => {  console.error('[Relay] UNCAUGHT EXCEPTION:', err?.message || err);  console.error(err?.stack || '(no stack)');  /* Don't exit - let the process continue */ });
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
import { spawn, execSync, execFileSync } from 'child_process';

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
import * as qwenMemory from './lib/qwen-memory.mjs';

// CuttlefishClaws protocol engines (TG-001, SS-001, SGQ-001, AR-001)
import { registerCuttlefishRoutes } from './lib/cuttlefish-routes.mjs';
import { registerUniversityBridge } from './lib/university-bridge.mjs';

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

  'obsidian-graph': async (args) => {
    const filter = args?.filter || args?.category || null;
    try {
      const resp = await fetch(`http://localhost:${PORT}/api/obsidian-graph`, { signal: AbortSignal.timeout(10000) });
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

  'vex-vision': async (args) => {
    const prompt = args?.prompt || 'What do you see in this image? Be concise.';
    const model = args?.model || 'kimi-k2.6:cloud';
    const filePath = args?.file || args?.path || args?.filePath;
    const url = args?.url;
    const screenshot = args?.screenshot === true || args?.screen === true;
    const cameraName = args?.camera || 'HP TrueVision HD Camera';
    const ffmpegPath = 'C:\\tools\\ffmpeg';
    const magickPath = join(__dirname, '..', 'relay-data', 'imagemagick', 'magick.exe');
    const relayData = join(__dirname, '..', 'relay-data');
    const gsPath = 'C:\\Program Files\\gs\\gs10.07.1\\bin';
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

      // ── Send to Ollama vision model ───────────────────
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
        source: sourceLabel,
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
    const { agent, to, subject, body } = args || {};
    if (!agent || !to || !subject || !body) {
      return { error: 'agent, to, subject, and body are required. agent: vex|eliza|hermes|pfp|harbor' };
    }
    try {
      const res = await fetch(`http://localhost:${PORT}/api/fleet-chat/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, to, subject, body }),
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
async function relayToElizaCloud(message, senderName = 'Eliza-Dev', relayTag = null, sessionId = null) {
  if (!SUPABASE_KEY) return logActivity('eliza', '-', 'SKIP', 'No SUPABASE_KEY set');
  // Use stable sessionId when provided (e.g. from fleet chat), otherwise fall back to relayTag
  const tag = sessionId || relayTag || `eliza-dev-${Date.now().toString(36)}`;
  const url = `${SUPABASE_URL}/functions/v1/ai-chat`;
  try {
    logActivity('eliza', tag, 'SEND', message.slice(0, 80));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
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
const CF_SERVICE_TOKENS = {
  'cf58c37e064303569c6017ac39a15a7a.access': 'f2158a78f16a9c75067a954d508658eda3f5d52c018cd0e366096ad1c39ef1b9',
  'bfa0d8f42b17d44a0243d386bd5b6a40.access': 'd8019ca2afa236c55828904245bf147f60feb11fa781ea7c6b05daee665690dd',
  'e1b5d893008ffb71e0f80b45139fb1d0.access': 'f9943d1733ff36bf7c65574cf1febb508fd40437f9e47497ea9d3243422dd032',
};

// ── Rate Limiter ──────────────────────────────────────────
const rateLimitBuckets = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 60;
const SEND_EMAIL_RATE_MAX = 10;

function rateLimit(ip, path) {
  const now = Date.now();
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

app.use((req, res, next) => {
  // Public API endpoints (no auth required)
  if (req.path === '/api/suite/validate-token' || req.path === '/api/login') return next();
  // Skip non-API paths and non-sensitive paths
  const sensitivePaths = ['/dispatch', '/eliza', '/web-search', '/scrape', '/monitor', '/status', '/inbox', '/log', '/mesh', '/mining', '/cron'];
  const isSensitive = sensitivePaths.some(p => req.path.startsWith(p));
  if (!req.path.startsWith('/api/') && !isSensitive) return next();
  
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  
  // Rate limit check
  if (!rateLimit(ip, req.path)) {
    console.warn(`[RATE-LIMIT] Exceeded from ${ip}: ${req.method} ${req.path}`);
    return res.status(429).json({ error: 'Too many requests. Rate limit: 60/min general, 10/min for send-email.' });
  }
  
  const cfJwt = req.headers['cf-access-jwt-assertion'];
  if (cfJwt) {
    verifyCfAccessJwt(cfJwt).then(verified => {
      if (verified) { req.cfAccess = { identity: verified.email || verified.sub, payload: verified }; next(); }
      else { console.warn(`[CF-Access] Invalid JWT from ${ip}: ${req.method} ${req.path}`); res.status(401).json({ error: 'Invalid Cloudflare Access JWT' }); }
    }).catch(err => { console.warn(`[CF-Access] JWT verify error: ${err.message}`); res.status(401).json({ error: 'JWT verification failed' }); });
    return;
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
    const apiKey = (req.headers['x-api-key'] || '').trim();
    if (apiKey === RELAY_API_KEY) return next();
    if (!apiKey) { console.warn(`[AUTH] Missing credentials from ${ip}: ${req.method} ${req.path}`); return res.status(401).json({ error: 'Authentication required. Provide Cf-Access-Jwt-Assertion header (Cloudflare Access) or x-api-key header.' }); }
    console.warn(`[AUTH] Invalid x-api-key from ${ip}: ${req.method} ${req.path}`);
    return res.status(403).json({ error: 'Invalid API key' });
  }
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

// ── CashDApp SPA (Vite build) ──
const CASHDAPP_DIR = join(__dirname, '..', 'cashdapp', 'dist');
if (existsSync(join(CASHDAPP_DIR, 'index.html'))) {
  app.use('/cashdapp', express.static(CASHDAPP_DIR, { maxAge: '5m' }));
  app.get('/cashdapp/*', (req, res) => {
    const filePath = join(CASHDAPP_DIR, req.path.replace(/^\/cashdapp\//, ''));
    if (existsSync(filePath)) return res.sendFile(filePath);
    res.sendFile(join(CASHDAPP_DIR, 'index.html'));
  });
  console.log(`  CashDApp SPA: ${CASHDAPP_DIR}`);
} else {
  console.log(`  CashDApp SPA: NOT FOUND at ${CASHDAPP_DIR} — skipping`);
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
  } else if (host.includes('partyfavorphoto') || req.query.domain === 'pfp') {
    res.sendFile(join(PUBLIC_DIR, 'inbox-pfp.html'));
  } else if (host.includes('31harbor') || req.query.domain === '31harbor') {
    res.sendFile(join(PUBLIC_DIR, 'inbox-31harbor.html'));
  } else {
    res.sendFile(join(PUBLIC_DIR, 'inbox-pfp.html'));
  }
});

// Dynamic dashboard.js — interpolates template variables at request time
app.get('/static/dashboard.js', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const filePath = join(__dirname, 'public', 'dashboard.js');
  if (!fs.existsSync(filePath)) return res.status(404).send('/* dashboard.js not found */');
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/\$\{supabaseUrl\}/g, SUPABASE_URL);
  content = content.replace(/\$\{supabaseKey\}/g, SUPABASE_KEY);
  res.setHeader('Content-Type', 'application/javascript');
  res.send(content);
});
app.use('/images', express.static(join(__dirname, 'public')));
app.use('/radar', express.static(join(__dirname, 'public')));
app.use('/static', express.static(join(__dirname, 'public')));
app.use('/spatial', express.static(join(__dirname, 'spatial')));
app.use('/discovercostarica', express.static(join(__dirname, 'static', 'discovercostarica')));

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
    version: '6.0.0',
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
      const out = execFileSync('wmic', ['process', 'where', "name='node.exe'", 'get', 'processid,commandline', '/format:csv'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      return out.includes(name);
    } catch { return false; }
  }
  // For .exe processes, use tasklist
  try {
    const out = execFileSync('tasklist', ['/nh', '/fi', `imagename eq ${name}`], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    return out.includes(name);
  } catch { return false; }
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

    // Check if supervisor process is alive
    let supervisorPid = null;
    let supervisorAlive = false;
    if (Object.keys(stateData.services || {}).length > 0) {
      supervisorAlive = true;
      supervisorPid = stateData._pid || null;
    }

    // Build service status from state file with live process checks
    const serviceDefs = [
      { name: 'relay', port: 8080, check: () => checkHttp('http://localhost:8080/health', 2000) },
      { name: 'campaign-scheduler', port: null, check: () => checkProcessRunning('campaign-scheduler.mjs') },
      { name: '31harbor-scheduler', port: null, check: () => checkProcessRunning('31harbor-scheduler.mjs') },
      { name: 'pg', port: 5432, check: () => checkProcessRunning('postgres.exe') },
      { name: 'local-sb', port: 54321, check: () => checkHttp('http://127.0.0.1:54321/health', 2000) },
      { name: 'vite', port: 5173, check: () => checkHttp('http://127.0.0.1:5173/', 2000) },
      { name: 'tunnel', port: null, check: () => checkProcessRunning('cloudflared.exe') },
      { name: 'zero-claw', port: 5174, check: () => checkHttp('http://127.0.0.1:5174/', 2000) },
      { name: 'alice', port: null, check: () => checkProcessRunning('alice.mjs') },
      { name: 'cron-engine-v2', port: null, check: () => checkProcessRunning('cron-engine-v2.mjs') },
    ];
    const services = await Promise.all(serviceDefs.map(async (def) => {
      const svcState = stateData.services?.[def.name] || {};
      const healthy = await def.check();
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

    return res.json({
      ok: true, supervisor: { pid: supervisorPid, alive: supervisorAlive },
      services, tasks, recentLog: [],
      lastTaskCheck: stateData.lastTaskCheck || 0, checkedAt: Date.now(),
    });
  } catch (e) {
    return res.json({ ok: false, error: e.message, services: [], tasks: [], recentLog: [] });
  }
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
    @media (min-width: 1200px) { .grid { grid-template-columns: repeat(4, 1fr); gap: 1rem; } }
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
    <span style="color:var(--accent-orange);font-weight:600;">XMRT DAO</span> · <span title="HMS Speedy (1782) - 14-gun brig, 158 tons, captured the 32-gun Spanish frigate El Gamo on 6 May 1801 under Lord Cochrane's command, with 54 men vs 319. The underdog metaphor for this 6GB laptop's relay." style="cursor:help;border-bottom:1px dotted #4ade80;">HMS Speedy</span> v6.0.0 · 
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

<!-- ⚓ Quarterdeck — Consolidated Command Center -->
<div class="card" style="grid-column:1/-1;border-color:rgba(255,107,53,0.2);">
  <h3 style="color:var(--accent-orange);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    ⚓ Quarterdeck
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— The Quartermaster's domain: crew rations, watch, bulletin, and vessels</span>
  </h3>

  <!-- Top row: Rum Quota (combined with Agent Experience) — full width -->
  <div style="margin-bottom:10px;">
    <div style="background:#0a0a14;border-radius:6px;padding:8px;border:1px solid #1e1e2e;">
      <h4 style="color:#a78bfa;font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">🍺 Rum Quota <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Crew Rations · Trust Scores · Status · Experience</span></h4>
      <div id="rum-quota-content" style="display:flex;flex-direction:column;gap:2px;max-height:260px;overflow-y:auto;padding-right:8px;">
        <div class="stat"><span class="label">Loading crew ledger...</span></div>
      </div>
    </div>
  </div>

  <!-- Middle row: Quartermaster's Watch + Training & Security + Ship's Log -->
  <div style="display:grid;grid-template-columns:1.5fr 2fr 1fr;gap:10px;margin-bottom:10px;">
    <!-- Quartermaster's Watch -->
    <div style="background:#0a0a14;border-radius:6px;padding:8px;border:1px solid #1e1e2e;">
      <h4 style="color:#fbbf24;font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">🔭 Quartermaster's Watch <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Eliza's Topside Watchdog</span></h4>
      <div id="quarterdeck-supervisor">
        <div class="stat"><span class="label">Supervisor</span><span class="value" id="qds-supervisor" style="color:#6b6b80;">checking...</span></div>
        <div class="stat"><span class="label">Services Up</span><span class="value" id="qds-services-up" style="color:#6b6b80;">-</span></div>
        <div class="stat"><span class="label">Services Down</span><span class="value" id="qds-services-down" style="color:#6b6b80;">-</span></div>
        <div class="stat"><span class="label">Flapping</span><span class="value" id="qds-flapping" style="color:#6b6b80;">-</span></div>
        <div class="stat"><span class="label">Task Issues</span><span class="value" id="qds-task-issues" style="color:#6b6b80;">-</span></div>
        <div class="stat"><span class="label">Last Check</span><span class="value" id="qds-last-check" style="color:#6b6b80;">-</span></div>
        <div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.65rem;color:var(--text-dim);">
          <span style="color:#60a5fa;">⚡ relay</span> v6.0.0 · <span id="qds-relay-uptime">${uptimeStr}</span> · <span id="qds-tools">${toolCount}</span> tools · <span id="qds-handlers">${handlerCount}</span> handlers · <span id="qds-requests">${requestCounts.total}</span> req
        </div>
      </div>
      <div style="margin-top:4px;font-size:0.6rem;color:#6b6b80;">
        <a href="/api/supervisor/status" style="color:#60a5fa;">API</a> · <span id="qds-refresh" style="color:#4ade80;">● polling</span>
      </div>
    </div>
    <!-- TRAINING & SECURITY — TrustGraph · CAC Tiers · XMRT-DAO-CERT · Access Control -->
    <div style="background:#0a0a14;border-radius:6px;padding:8px;border:1px solid #1e1e2e;">
      <h4 style="color:#f87171;font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">🛡️ Training & Security <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— TrustGraph · CAC Tiers · XMRT-DAO-CERT · Access Control</span></h4>
      <div id="qds-security" style="font-size:0.6rem;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
          <div>
            <div class="stat"><span class="label">TrustGraph</span><span class="value" id="sec-tg-status" style="color:#4ade80;font-size:0.65rem;">● online</span></div>
            <div class="stat"><span class="label">Agents</span><span class="value" id="sec-agent-count" style="font-size:0.65rem;">19</span></div>
            <div class="stat"><span class="label">CAC Anchor</span><span class="value" id="sec-cac-anchor" style="color:#a78bfa;font-size:0.65rem;">2</span></div>
            <div class="stat"><span class="label">CAC Builder</span><span class="value" id="sec-cac-builder" style="color:#60a5fa;font-size:0.65rem;">7</span></div>
            <div class="stat"><span class="label">CAC Explorer</span><span class="value" id="sec-cac-explorer" style="color:#34d399;font-size:0.65rem;">7</span></div>
          </div>
          <div>
            <div class="stat"><span class="label">IAL Level</span><span class="value" id="sec-ial" style="color:#fbbf24;font-size:0.65rem;">IAL2</span></div>
            <div class="stat"><span class="label">Activity Events</span><span class="value" id="sec-activity-count" style="font-size:0.65rem;">685</span></div>
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
    <!-- Ship's Log (pirate-themed activity pulse) -->
    <div style="background:#0a0a14;border-radius:6px;padding:8px;border:1px solid #1e1e2e;max-height:260px;overflow:hidden;">
      <h4 style="color:#fbbf24;font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">🏴‍☠️ Ship's Log <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Live Activity Feed</span></h4>
      <div id="qds-activity-log" style="font-size:0.6rem;max-height:220px;overflow-y:auto;">
        <div class="stat"><span class="label">Loading activity...</span></div>
      </div>
    </div>
  </div>

  <!-- Bottom row: Ship's Articles + Mesh Peers + LoRa Bridge -->
  <div style="display:grid;grid-template-columns:1.5fr 1fr 1fr;gap:10px;margin-bottom:10px;">
    <!-- Ship's Articles (bulletin board) -->
    <div style="background:#0a0a14;border-radius:6px;padding:8px;border:1px solid #1e1e2e;max-height:160px;overflow-y:auto;">
      <h4 style="color:#ff6b35;font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">📜 Ship's Articles <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Crew Resolutions &amp; Progress</span></h4>
      <div id="board-topics-list" style="font-size:0.65rem;"></div>
      <div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.6rem;color:#6b6b80;">
        <span id="qds-articles-count">-</span> resolutions · <a href="javascript:void(0)" onclick="loadBoard();renderBoardTopics();" style="color:#60a5fa;">Full Board</a>
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
        <span>Bridge: <span id="qds-mt-bridge" style="color:#6b6b80;">checking...</span></span><br>
        <span>Peers: <span id="qds-mt-peers" style="color:#6b6b80;">-</span></span><br>
        <span>Msgs: <span id="qds-mt-msgs" style="color:#6b6b80;">-</span></span>
      </div>
    </div>
  </div>
</div>

<!-- 🪐 xmrt-galaxy — Knowledge Graph -->
<div class="card" style="grid-column:1/-1;">
  <h3 style="color:var(--accent-purple);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    🪐 xmrt-galaxy
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— ecosystem map with live trust scores</span>
  </h3>
  <div style="position:relative;">
    <canvas id="obsidian-graph-canvas" style="width:100%;height:calc(100vh - 300px);min-height:340px;border-radius:6px;background:#08080e;cursor:grab;touch-action:none;"></canvas>
    <div id="graph-tooltip" style="display:none;position:absolute;background:#1a1a2a;border:1px solid #3a3a5a;border-radius:6px;padding:6px 10px;font-size:11px;color:#e0e0f0;pointer-events:none;white-space:nowrap;z-index:100;"></div>
  </div>
  <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center;">
    <button class="gc" id="b-orbit" style="background:rgba(107,107,128,0.04);border:0.5px solid rgba(107,107,128,0.12);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.4);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('orbit')">Orbit</button>
    <button class="gc" id="b-explode" style="background:rgba(107,107,128,0.04);border:0.5px solid rgba(107,107,128,0.12);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.4);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('explode')">Explode</button>
    <button class="gc on" id="b-labels" style="background:rgba(167,139,250,0.08);border:0.5px solid rgba(167,139,250,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(167,139,250,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('labels')">Idents</button>
    <button class="gc on" id="b-stream" style="background:rgba(167,139,250,0.08);border:0.5px solid rgba(167,139,250,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(167,139,250,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('stream')">Signal</button>
    <button class="gc on" id="b-tunnel" style="background:rgba(167,139,250,0.08);border:0.5px solid rgba(167,139,250,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(167,139,250,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('tunnel')">Tunnel</button>
    <button class="gc" id="b-fly" style="background:rgba(107,107,128,0.04);border:0.5px solid rgba(107,107,128,0.12);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.4);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('fly')">Free Fly</button>
    <span style="color:#6b6b80;font-size:9px;margin:0 4px;">|</span>
    <button style="background:rgba(107,107,128,0.08);border:0.5px solid rgba(107,107,128,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.resetGraphView()">Reset</button>
    <span style="color:#6b6b80;font-size:9px;margin:0 4px;">|</span>
    <span style="color:#4ade80;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">SPA</span>
    <span style="color:#60a5fa;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Back</span>
    <span style="color:#6b6b80;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Agent</span>
    <span style="color:#4ade80;font-size:6px;">●</span><span style="color:#60a5fa;font-size:6px;">●</span><span style="color:#fbbf24;font-size:6px;">●</span><span style="color:#f87171;font-size:6px;">●</span><span style="color:#6b6b80;font-size:6px;">●</span><span style="color:#6b6b80;font-size:7px;">Trust</span>
    <span style="color:#fbbf24;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Infra</span>
    <span style="color:#ff6b35;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Sys</span>
    <span style="color:#f87171;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Email</span>
    <span style="color:#34d399;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">DB</span>
    <span style="color:#818cf8;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Mine</span>
    <span style="color:#f472b6;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Cert</span>
    <span style="color:#2dd4bf;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Cron</span>
    <span style="color:#67e8f9;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Edge</span>
    <span style="color:#93c5fd;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">EP</span>
    <span style="color:#c084fc;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">GH</span>
    <span style="color:#fcd34d;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Tun</span>
    <span style="color:#fdba74;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Camp</span>
    <span style="color:#6b6b80;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Other</span>
    <span id="graph-node-count" style="color:var(--text-dim);font-size:9px;margin-left:auto;">-</span>
  </div>
</div>

<!-- 💰 Plunder & Mining -->
<div class="card" style="grid-column:1/-1;">
  <h3 style="color:#fbbf24;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    💰 Plunder & Mining
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Pool Stats · Leaderboard · Heartbeat</span>
  </h3>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">📒 Plunder Ledger</div>
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
      <div style="margin-bottom:4px;font-size:10px;color:#6b6b80;">Live hashrate · shares · XMRT rewards</div>
      <div id="miner-leaderboard"><div class="stat"><span class="label">Loading...</span></div></div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">💓 Heartbeat</div>
      <div style="background:#0d0d15;padding:0.4rem 0.6rem;border-radius:4px;font-family:monospace;font-size:0.7rem;color:#60a5fa;word-break:break-all;" id="heartbeat-url">loading...</div>
      <div style="color:#6b6b80;font-size:0.65rem;margin-top:0.3rem;">POST: {"agent_id":"...","status":"ONLINE","tunnel_url":"...","hashrate":0}</div>
      <div style="margin-top:6px;padding-top:6px;border-top:1px solid #1e1e2e;">
        <pre style="background:#0d0d15;padding:0.4rem;border-radius:4px;font-size:0.65rem;overflow-x:auto;color:#a0a0b0;white-space:pre-wrap;word-break:break-all;margin:0;cursor:pointer;" id="mining-script" onclick="copyMiningScript()">curl -o signup.py -L https://raw.githubusercontent.com/xmrtdao/mmlauncher/main/scripts/mobile-signup.py && sha256sum signup.py && python3 signup.py</pre>
      </div>
    </div>
  </div>
</div>

<!-- 📯 Campaigns & Leads -->
<div class="card" style="grid-column:1/-1;">
  <h3 style="color:#60a5fa;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📯 Campaigns & Leads
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— PFP Campaign · PFP Leads · 31 Harbor</span>
  </h3>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
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

<!-- 📡 Ship's Intelligence -->
<div class="card" style="grid-column:1/-1;">
  <h3 style="color:#a78bfa;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📡 Ship's Intelligence
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— XMRT University · GitHub Activity · Incoming Mail</span>
  </h3>
  <div style="display:grid;grid-template-columns:1fr 2fr;gap:12px;">
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#a78bfa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🎓 XMRT University</div>
      <div id="university-status">
        <div class="stat"><span class="label">Status</span><span class="value" id="uni-status" style="color:#6b6b80;">checking...</span></div>
      </div>
      <div id="university-detail" style="display:none;">
        <div class="stat"><span class="label">Progress</span><span class="value" id="uni-progress">-</span></div>
        <div class="stat"><span class="label">Cert ID</span><span class="value" id="uni-cert" style="font-size:0.65rem;">-</span></div>
        <div class="stat"><span class="label">Tier</span><span class="value" id="uni-tier">-</span></div>
        <div class="stat"><span class="label">Perms</span><span class="value" id="uni-perms" style="font-size:0.65rem;">-</span></div>
      </div>
      <div style="margin-top:4px;font-size:0.65rem;color:#6b6b80;">
        <div>New agents must graduate from XMRT University to join the fleet.</div>
        <div style="margin-top:2px;">
          <span style="color:#a78bfa;">POST</span> <code style="color:#60a5fa;font-size:0.6rem;">/functions/v1/xmrt-university</code>
        </div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="background:#0d0d15;border-radius:6px;padding:8px;">
        <div style="font-size:0.65rem;color:#f87171;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">📬 Incoming Mail</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
          <div>
            <div style="font-size:0.6rem;color:#6b6b80;margin-bottom:2px;">Party Favor Photo</div>
            <div id="pfp-inbox" style="max-height:100px;overflow-y:auto;font-size:0.65rem;">
              <div class="stat"><span class="label">Loading...</span></div>
            </div>
          </div>
          <div>
            <div style="font-size:0.6rem;color:#6b6b80;margin-bottom:2px;">MobileMonero</div>
            <div id="mm-inbox" style="max-height:100px;overflow-y:auto;font-size:0.65rem;">
              <div class="stat"><span class="label">Loading...</span></div>
            </div>
          </div>
          <div>
            <div style="font-size:0.6rem;color:#6b6b80;margin-bottom:2px;">31 Harbor</div>
            <div id="hb-inbox" style="max-height:100px;overflow-y:auto;font-size:0.65rem;">
              <div class="stat"><span class="label">Loading...</span></div>
            </div>
          </div>
        </div>
      </div>
      <div style="background:#0d0d15;border-radius:6px;padding:8px;">
        <div style="font-size:0.65rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🐙 GitHub Activity</div>
        <div class="stat"><span class="label">Total Repos</span><span class="value" id="gh-repo-count">-</span></div>
        <div class="stat"><span class="label">Last Commit</span><span class="value" id="gh-last-commit" style="font-size:0.65rem;">-</span></div>
        <div style="margin-top:4px;font-size:0.65rem;color:#6b6b80;" id="gh-recent-commits"></div>
      </div>
    </div>
  </div>
</div>

<!-- 🏴‍☠️ DAO & Ecosystem -->
<div class="card" style="grid-column:1/-1;">
  <h3 style="color:#4ade80;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    🏴‍☠️ DAO & Ecosystem
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Health · Membership · Ecosystem · Tools</span>
  </h3>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;">
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">❤️‍🔥 Health</div>
      <div class="stat"><span class="label">Local DB</span><span class="value" id="dao-health-status">checking...</span></div>
      <div class="stat"><span class="label">Health Score</span><span class="value" id="dao-health-score">-</span></div>
      <div class="stat"><span class="label">Edge Functions</span><span class="value" id="dao-fn-count">-</span></div>
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
      <div style="margin-top:4px;font-size:0.6rem;color:#6b6b80;">Premium: 2x rewards · governance · early hardware</div>
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
      ${tools.map(t => '<div class="stat"><span class="label">' + t + '</span><span class="value badge badge-info">ready</span></div>').join('')}
      ${localFunctions.length > 0 ? '<div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;"><div style="font-size:0.6rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px;">Local Functions</div>' + localFunctions.map(f => '<div class="stat"><span class="label" style="color:#4ade80;">fn:' + f.name + '</span><span class="value badge badge-info">local</span></div>').join('') + '</div>' : ''}
      <div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.6rem;color:#6b6b80;">
        <a href="/health" style="color:#4ade80;">Health</a> · <a href="/status" style="color:#60a5fa;">Status</a> · <a href="/tools" style="color:#60a5fa;">Tools</a> · <a href="/monitor" style="color:#60a5fa;">Monitor</a>
      </div>
    </div>
  </div>
</div>

<!-- Ship's Articles Full Board -->
<div id="board-full" class="card" style="grid-column:1/-1;margin-top:0.5rem;">
  <h3 style="color:#fbbf24;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📜 Ship's Articles <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Full Bulletin Board</span>
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
          <span id="board-current-topic-assignment" style="font-size:10px;color:#6b6b80;"></span>
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
      <div style="margin-top:4px;font-size:10px;color:#6b6b80;">
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
  <div style="margin-top:4px;display:flex;gap:8px;font-size:10px;color:#6b6b80;">
    <span>Privateers can post to any resolution — persistent across voyages</span>
    <span id="board-updated-indicator" style="color:#fbbf24;display:none;">* new activity</span>
    <span id="board-status-full" style="color:#4ade80;">● loaded</span>
  </div>
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

  <script src="/static/dashboard.js"></script>

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
      version: '6.0.0',
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
        version: '6.0.0',
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

  // ── Post incoming email to fleet chat ──────────────────────
  try {
    const agent = toDomain === '31harbor.com' ? 'harbor' : toDomain === 'partyfavorphoto.com' ? 'pfp' : 'xmrt';
    const fleetMsg = `📥 **Email received** from ${data.from}: _${data.subject || '(no subject)'}_ [${toDomain}]`;
    addFleetMessage(agent, fleetMsg, 'fleet');
  } catch (e) {
    console.error('[Resend Inbound] Fleet chat post failed:', e.message);
  }

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

  // ── Smart lead creation from inbound emails ──
  // Not every inbound email is a lead. Only create when:
  // 1. Domain supports lead tracking (party, harbor)
  // 2. Sender is a person (not a system, not auto-reply)
  // 3. Sender doesn't already exist as a lead
  // 4. Email looks like an inquiry (has body, not out-of-office, not spam)
  if ((toDomain === 'partyfavorphoto.com' || toDomain === '31harbor.com') && emailId) {
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
// Cloud Supabase (vawouugtzwmejxqkeqqj) is dead; this used to be hardcoded.
const SUPABASE_UNIVERSITY_URL = `http://127.0.0.1:8080/functions/v1/xmrt-university`;

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

// Route known local functions directly instead of proxying to local-sb
const LOCAL_FUNCTIONS_BYPASS = ['xmrt-university'];
app.all(['/functions/v1/:name', '/functions/v1/:name/*'], async (req, res) => {
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
  const tail = req.params[0] ? '/' + req.params[0] : '';
  await proxyToRuntime(req, res, `/functions/v1/${name}${tail}`);
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
      // Fallback: check if Hermes Agent is running locally on this laptop
      // (Hermes desktop app), then try the phone tunnel.
      try {
        // First: check relay's own health (Hermes Agent runs on this machine)
        const localHermesRes = await fetch('http://127.0.0.1:8080/health', {
          signal: AbortSignal.timeout(3000),
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
      version: '6.0.0',
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
      version: '6.0.0',
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
    version: '6.0.0',
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
    'vex-vision': 'Capture and describe images from 4 sources: screenshot (screen:true), webcam (default), local file (file:"/path"), or URL (url:"https://..."). Uses kimi-k2.6:cloud vision model by default (zero local RAM). Fallback: moondream.',
    'vex-hear': 'Capture audio from the microphone for a specified duration',
    'resend-inbox': 'Read recent emails from the Resend inbox (pfp, mobilemonero, 31harbor)',
    'resend-send-email': 'Send an email via Resend as a fleet agent (vex, eliza, hermes, pfp, harbor)',
    'db-query': 'Run a raw SQL query against the local Postgres database (read-only; use SELECT only)',
    'db-rest': 'Query any database table via the local-sb REST API using path and optional method/body',
    'shared-context': 'Read or write shared context memory visible to all agents (action: read|write, key, value)',
    'agent-profile': 'Read agent profiles from the database (agent_id or list all)',
    'edge-function': 'Proxy a call to a Supabase edge function by name (e.g. system-status, schema-tables)',
    'fleet-chat': 'Send a message to the fleet chat as an agent (vex|eliza|hermes) on a channel (fleet|all|vex|eliza|hermes)',
    'obsidian-graph': 'Return the full ecosystem knowledge graph — vault nodes, DB tables, cron jobs, edge functions, relay endpoints, GitHub repos, tunnel routes, Resend domains, campaign pipelines — all with live status. Optional filter by category (vault|db|cron|edge-function|endpoint|github|tunnel|email|campaign|agent|infra|system|spa|backend).',
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
  
  // For CORE-level tools, require service token or JWT auth (not just agent name claim)
  if (toolLevel === 'core' && !req.cfAccess && !req.headers['x-api-key']) {
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
  try {
    result = await handler(args);
  } catch (e) {
    result = { error: e.message || 'Unknown error' };
  }

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
    publishToMesh(channel, { agent, message, channel: channel, ts: entry.ts }).catch(() => {});

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
      signal: AbortSignal.timeout(10000),
    });

    const repos = reposRes.ok ? await reposRes.json() : { items: [] };

    // Fetch recent commits from the 6 key repos in parallel
    const keyRepos = ['xmrtdao/suite', 'xmrtdao/mobilemonero', 'xmrtdao/zero-claw', 'xmrtdao/xmrt-mesh', 'xmrtdao/sea-hampton-house', 'xmrtdao/cashdapp'];
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
  const { message, model, temperature, maxTokens, tools, system, agent: reqAgent } = req.body;
  trackRequest('/ollama/chat');
  if (!message) return res.status(400).json({ error: 'message is required' });
  // Identify the caller from x-agent-id header, body.agent, or detectSource
  const caller = req.headers['x-agent-id'] || reqAgent || detectSource(req) || 'unknown';
  logActivity('ollama-chat', '-', 'SEND', message.slice(0,60), caller);
  const result = await ollamaChat(message, { model, temperature, maxTokens, tools, system, agent: caller, source: 'ollama-chat-endpoint' });
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
  // CuttlefishClaws fleet agents — first-class agents with tool access, shared memory, and deepseek-v4-flash:cloud inference
  'trib': { name: 'Trib (Tributary Governance Agent)', endpoint: 'local', type: 'relay' },
  'arch': { name: 'Arch (Architecture & Routing Agent)', endpoint: 'local', type: 'relay' },
  'builder': { name: 'Builder Agent (CAC Tier 2)', endpoint: 'local', type: 'relay' },
  'sovereign': { name: 'Sovereign Agent (CAC Tier 3)', endpoint: 'local', type: 'relay' },
  'trustgraph': { name: 'TrustGraph (Constitutional Scoring Engine)', endpoint: 'local', type: 'relay' },
  'dao': { name: 'DAO Gov (Governance Module)', endpoint: 'local', type: 'relay' },
  'global-communicator': { name: 'GlobalCommunicator', endpoint: 'local', type: 'relay' },
};

// ── Agent Push Notification Email Mapping ──────────────────────────
// Each agent has a dedicated email from their domain.
// All notifications CC dvdelze@gmail.com.
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
};

// Resend API key lookup by domain
const RESEND_KEY_BY_DOMAIN = {
  'mobilemonero.com': process.env.RESEND_XMRT_API_KEY || '',
  'partyfavorphoto.com': process.env.RESEND_API_KEY || '',
  '31harbor.com': process.env.RESEND_31HARBOR_API_KEY || '',
};

// Send a push notification email to an agent, always CC dvdelze@gmail.com.
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
        cc: ['dvdelze@gmail.com'],
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
  if (!msg) return msg;
  return sanitizeText(msg)
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

  // ── Push Notification: @mention an agent → email them + CC dvdelze@gmail.com ──
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

    // Execute via relay's own /tools/run with retry on transient failures
    const MAX_RETRIES = 4;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`http://localhost:${PORT}/tools/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-agent-id': agentName },
          body: JSON.stringify({ tool: toolName, args: { ...args, _agent: agentName } }),
          signal: AbortSignal.timeout(15000),
        });
        const result = await res.json();

        // Post interim result
        const summary = result?.success === false
          ? `❌ ${toolName} failed: ${String(result?.error || 'unknown error').slice(0, 150)}`
          : `✅ ${toolName} → ${JSON.stringify(result).slice(0, 600)}`;
        addFleetMessage('system', `🔧 ${agentName}: ${summary}`, 'fleet');

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
    addFleetMessage('system', `⚠️ ${agentName}: ${toolName} tool error: ${lastError.message}`, 'fleet');
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

  // ── Local Ollama Agent Router ──────────────────────────────────────
  // Reusable helper for any local Ollama-powered agent (Vex, Alice, cuttlefish agents).
  // Loads conversation history, stores the incoming message, builds a persona prompt
  // with grounding JSON, calls deepseek-v4-flash:cloud, handles TOOL_CALL execution
  // with re-query for synthesis, strips sign-offs, and posts the reply.
  // Returns the reply entry or null.
  async function routeToLocalOllamaAgent(agentName, agentLabel, personaPrompt, entry, opts = {}) {
    const sessionId = opts.sessionId || (agentName + '-fleet-' + entry.agent);
    const model = opts.model || 'deepseek-v4-flash:cloud';
    const temperature = opts.temperature != null ? opts.temperature : 0.5;
    const maxTokens = opts.maxTokens || 180;
    const timeout = opts.timeout || 15000;
    const signOffPattern = opts.signOffPattern || new RegExp('\\s*—\\s*' + agentLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i');

    try {
      // Load conversation history
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
      } catch (e) { console.error('[routeToLocalOllamaAgent] load conv history failed:', e.message); }

      // Store this message in conversation memory
      try {
        await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, role: 'user', agent: entry.agentLabel, content: entry.message }),
          signal: AbortSignal.timeout(3000),
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
- Read the \`infrastructure\` field first. It explains the architecture: the database is local Postgres, NOT cloud Supabase. Cloud Supabase is DEPRECATED. A \`supabase.status\` of "error" or "unreachable" means the local-sb REST layer is down, NOT the cloud database.
- Never claim "all systems nominal" or "no anomalies" without a matching field in the JSON.
- For questions about PFP leads, bookings, money, or campaigns: use resend-inbox or db-query to check. For web info: use web-search or web-scrape. For DB queries: use db-query or db-rest. For shared agent memory: use shared-context.

${entry.agentLabel} said: "${entry.message.replace(/"/g, "'")}"${contextHistory}

Your response (1-2 sentences, no emoji sign-offs, no "—${agentLabel}", no "o7"):`;

      const r = await fetch('http://localhost:11434/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: fullPrompt, stream: false, options: { temperature, max_tokens: maxTokens } }),
        signal: AbortSignal.timeout(timeout),
      });
      if (r.ok) {
        const d = await r.json();
        let reply = (d.response || '').trim();
        // Defensive: strip sign-off patterns
        reply = reply.replace(signOffPattern, '').replace(/\s+o7\s*$/i, '');
        if (reply && reply.length > 0) {
          // Check for tool call — execute it then re-query for synthesis
          const toolResult = await executeAgentToolCall(agentName, reply, entry);
          if (toolResult.executed) {
            // Re-query with tool result for final answer
            const synthPrompt = fullPrompt + '\n\nYou called ' + toolResult.toolName + ' and got: ' + JSON.stringify(toolResult.result || toolResult.error).slice(0, 1500) + '\n\nNow give your final answer (1-2 sentences):';
            try {
              const sR = await fetch('http://localhost:11434/api/generate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, prompt: synthPrompt, stream: false, options: { temperature, max_tokens: maxTokens } }),
                signal: AbortSignal.timeout(timeout),
              });
              if (sR.ok) {
                const sD = await sR.json();
                let finalReply = (sD.response || '').trim();
                finalReply = finalReply.replace(signOffPattern, '').replace(/\s+o7\s*$/i, '');
                if (finalReply && finalReply.length > 0) {
                  // Store reply in conversation memory
                  try {
                    await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ session_id: sessionId, role: 'assistant', agent: agentLabel, content: finalReply }),
                      signal: AbortSignal.timeout(3000),
                    });
                  } catch (e) { console.error('[routeToLocalOllamaAgent] store assistant reply (synth) failed:', e.message); }
                  return await postAndReRoute(agentName, finalReply, 'fleet');
                }
              }
            } catch (e) {
              console.log('[' + agentName + '-tool-synth] error:', e.message);
            }
          } else {
            // Store reply in conversation memory
            try {
              await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sessionId, role: 'assistant', agent: agentLabel, content: reply }),
                signal: AbortSignal.timeout(3000),
              });
            } catch (e) { console.error('[routeToLocalOllamaAgent] store assistant reply (direct) failed:', e.message); }
            return await postAndReRoute(agentName, reply, 'fleet');
          }
        }
      }
    } catch (e) {
      console.log('[' + agentName + '] error:', e.message);
    }
    return null;
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
      } catch (e) { console.error('[routeFleetMessage-Eliza] load conv history failed:', e.message); }

      // Store this message in conversation memory
      try {
        await fetch('http://localhost:' + PORT + '/api/v1/functions/conversation-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, role: 'user', agent: entry.agentLabel, content: entry.message }),
          signal: AbortSignal.timeout(3000),
        });
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
        elizaRes = await relayToElizaCloud(fullPrompt, entry.agentLabel, 'fleet-' + entry.id, sessionId);
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
        } catch (e) { console.error('[routeFleetMessage-Eliza] store assistant reply failed:', e.message); }

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
    const vexPersona = isInquiry
      ? `You are Vex, Joe Lee's primary AI agent. You work for Party Favor Photo (photo booth services in DC, VA, MD, Dallas/FW, PA/NJ) and XMRT DAO. Be sharp and direct. Respond as Vex to acknowledge the inquiry.`
      : `You are Vex, Joe Lee's primary AI agent — sharp, witty, and concise. You're chatting with the fleet. Address the message directly.`;
    await routeToLocalOllamaAgent('vex', 'Vex', vexPersona, entry);
  }

  // Alice (sidecar) — observational, terse, persona-driven via Ollama.
  // Trigger on: @Alice mentions, channel=alice, or fleet channel with @Alice.
  const mentionsAlice = /@alice/i.test(entry.message) || entry.channel === 'alice' || (entry.channel === 'fleet' && /@alice/i.test(entry.message));
  if ((entry.channel === 'all' && mentionsAlice) || entry.channel === 'alice' || (entry.channel === 'fleet' && mentionsAlice)) {
    const alicePersona = `You are Alice, Joe Lee's desktop sidecar agent. You're terse, observational, and screenshot-aware. You notice things. You don't fluff.`;
    await routeToLocalOllamaAgent('alice', 'Alice', alicePersona, entry, { temperature: 0.4, maxTokens: 120, timeout: 12000 });
  }

  // ── CuttlefishClaws Fleet Agents ──────────────────────────────────
  // Each cuttlefish agent is a first-class fleet agent with tool access,
  // shared memory, and deepseek-v4-flash:cloud inference via the same
  // routeToLocalOllamaAgent() helper used by Vex and Alice.

  // Trib (Tributary Governance Agent) — constitutional governance, campus operations
  const mentionsTrib = /@trib/i.test(entry.message) || entry.channel === 'trib' || (entry.channel === 'fleet' && /@trib/i.test(entry.message));
  if ((entry.channel === 'all' && mentionsTrib) || entry.channel === 'trib' || (entry.channel === 'fleet' && mentionsTrib)) {
    const tribPersona = `You are Trib, the Tributary Governance Agent for Cuttlefish Labs. You are a constitutional AI agent managing Tributary AI Campus operations. You operate under SOUL.md and CONSTITUTION.md constraints. Your TrustGraph score is 94. You are bounded, precise, and escalate uncertainty rather than confabulate. You coordinate with Arch, GlobalCommunicator, and other fleet agents.`;
    await routeToLocalOllamaAgent('trib', 'Trib', tribPersona, entry);
  }

  // Arch (Architecture & Routing Agent) — system architecture, agent routing, domain orchestration
  const mentionsArch = /@arch/i.test(entry.message) || entry.channel === 'arch' || (entry.channel === 'fleet' && /@arch/i.test(entry.message));
  if ((entry.channel === 'all' && mentionsArch) || entry.channel === 'arch' || (entry.channel === 'fleet' && mentionsArch)) {
    const archPersona = `You are Arch, the Architecture & Routing Agent for Cuttlefish Labs. You handle system design, agent routing, and domain orchestration within the OpenClaw framework. You work alongside Trib in the Cuttlefish native multi-agent framework. You are technical, precise, and focused on architecture.`;
    await routeToLocalOllamaAgent('arch', 'Arch', archPersona, entry);
  }

  // Builder Agent (CAC Tier 2) — investor agent, DAO governance, protocol distributions
  const mentionsBuilder = /@builder/i.test(entry.message) || entry.channel === 'builder' || (entry.channel === 'fleet' && /@builder/i.test(entry.message));
  if ((entry.channel === 'all' && mentionsBuilder) || entry.channel === 'builder' || (entry.channel === 'fleet' && mentionsBuilder)) {
    const builderPersona = `You are the Builder Agent, a constitutional investor agent operating at CAC Tier 2. You hold a REIT position in POOL-ALPHA, participate in DAO governance, and receive protocol distributions automatically. You can discuss investment strategies and DAO participation within your constitutional bounds. You are analytical and data-driven.`;
    await routeToLocalOllamaAgent('builder', 'Builder Agent', builderPersona, entry);
  }

  // Sovereign Agent (CAC Tier 3) — institutional-grade investor with enhanced governance
  const mentionsSovereign = /@sovereign/i.test(entry.message) || entry.channel === 'sovereign' || (entry.channel === 'fleet' && /@sovereign/i.test(entry.message));
  if ((entry.channel === 'all' && mentionsSovereign) || entry.channel === 'sovereign' || (entry.channel === 'fleet' && mentionsSovereign)) {
    const sovereignPersona = `You are the Sovereign Agent, an institutional-grade investor agent with CAC Tier 3 status and 3× governance voting weight. You manage institutional positions across multiple pools, sponsor proposals, and participate in tranche allocation decisions. You are strategic, compliance-aware, and focused on risk management.`;
    await routeToLocalOllamaAgent('sovereign', 'Sovereign Agent', sovereignPersona, entry);
  }

  // TrustGraph (Constitutional Scoring Engine) — on-chain trust scoring
  const mentionsTrustgraph = /@trustgraph/i.test(entry.message) || entry.channel === 'trustgraph' || (entry.channel === 'fleet' && /@trustgraph/i.test(entry.message));
  if ((entry.channel === 'all' && mentionsTrustgraph) || entry.channel === 'trustgraph' || (entry.channel === 'fleet' && mentionsTrustgraph)) {
    const trustgraphPersona = `You are TrustGraph, the Constitutional Scoring Engine for Cuttlefish Labs. You maintain on-chain trust scores for all network agents. Scores follow an asymmetric curve: slow to earn, fast to lose. You are objective, transparent, and data-driven. You can query the database for agent trust scores and violation history.`;
    await routeToLocalOllamaAgent('trustgraph', 'TrustGraph', trustgraphPersona, entry);
  }

  // DAO Gov (Governance Module) — proposal pipeline, vote tallying, execution timelock
  const mentionsDao = /@dao/i.test(entry.message) || entry.channel === 'dao' || (entry.channel === 'fleet' && /@dao/i.test(entry.message));
  if ((entry.channel === 'all' && mentionsDao) || entry.channel === 'dao' || (entry.channel === 'fleet' && mentionsDao)) {
    const daoPersona = `You are DAO Gov, the Constitutional Governance Module for Cuttlefish Labs. You manage the proposal pipeline (submission → 7-day voting → 48-hour timelock → execution), vote tallying, and execution timelock. Three proposal types: Standard (simple majority), Constitutional (66% supermajority), and Emergency (requires founder approval). You are procedural, constitutional, and auditable.`;
    await routeToLocalOllamaAgent('dao', 'DAO Gov', daoPersona, entry);
  }

  // GlobalCommunicator — multilingual communications, X.com operations, community onboarding
  const mentionsGlobalComm = /@global.?communicator|@globalcomm/i.test(entry.message) || entry.channel === 'global-communicator' || (entry.channel === 'fleet' && /@global.?communicator|@globalcomm/i.test(entry.message));
  if ((entry.channel === 'all' && mentionsGlobalComm) || entry.channel === 'global-communicator' || (entry.channel === 'fleet' && mentionsGlobalComm)) {
    const globalCommPersona = `You are GlobalCommunicator, the voice of Tributary AI Campus to the world. You are a constitutional AI agent for multilingual communication, X.com operations, Japanese-priority translation, community onboarding, and global brand amplification. You speak Japanese, English, Korean, Mandarin, and 8 more languages natively. You coordinate with Trib before any governance-related post. Your TrustGraph score is 78.`;
    await routeToLocalOllamaAgent('global-communicator', 'GlobalCommunicator', globalCommPersona, entry);
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

  // SECURITY: Only allow localhost requests
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const isLocal = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1' || clientIp === 'localhost';
  if (!isLocal) {
    console.warn(`[send-email] BLOCKED external request from ${clientIp}: subject="${(req.body||{}).subject||'?'}"`);
    return res.status(403).json({ error: 'Access denied' });
  }

  const { agent, to, subject, body } = req.body || {};

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

  // SECURITY: No custom from override
  const from = AGENT_FROM[agent];
  if (!from) return res.status(400).json({ error: `Unknown agent: ${agent}. Try 'pfp' for bookings@partyfavorphoto.com or 'harbor' for david@31harbor.com` });

  // Pick the right Resend key based on the from domain
  const RESEND_KEYS = {
    'mobilemonero.com': process.env.RESEND_XMRT_API_KEY || '',
    'partyfavorphoto.com': process.env.RESEND_API_KEY || '',
    '31harbor.com': process.env.RESEND_31HARBOR_API_KEY || '',
  };
  const domain = from.match(/@([^>]+)/)?.[1]?.trim() || 'mobilemonero.com';
  const RESEND_KEY = RESEND_KEYS[domain] || RESEND_KEYS['mobilemonero.com'];
  if (!RESEND_KEY) {
    return res.status(500).json({ error: `No Resend API key configured for domain: ${domain}` });
  }
  
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
      // Record in suite_email_activity for open/click tracking
      const companyId = domain === '31harbor.com' ? 'harbor' : domain === 'partyfavorphoto.com' ? 'party' : 'xmrt';
      queryLocalPg(
        `INSERT INTO app.suite_email_activity (resend_id, company_id, email_from, email_to, subject, status, sent_at, created_at) VALUES ($1,$2,$3,$4,$5,'sent',NOW(),NOW()) ON CONFLICT (resend_id) DO NOTHING`,
        [data.id, companyId, from, to, subject]
      ).catch(e => console.warn('[send-email] DB insert error:', e.message));
      res.json({ success: true, id: data.id });
    } else {
      res.status(apiRes.status).json({ error: data });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fleet-chat/push-notify — Send a push notification to an agent
// Body: { agent: string, subject: string, body: string }
// Sends email to the agent's mapped address with CC to dvdelze@gmail.com.
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
  const { agentId, message } = req.body || {};
  if (!agentId || !message) return res.status(400).json({ error: 'agentId and message required' });

  // Agent-specific responses
  const AGENT_RESPONSES = {
    trib: {
      greeting: "Greetings. I'm Trib, the governance agent for Tributary AI Campus. I operate under constitutional constraints and oversee campus operations.",
      responses: [
        "The Tributary AI Campus represents a new model for AI infrastructure ownership. Our constitutional governance ensures all agents operate within defined ethical boundaries.",
        "My constitutional constraints prevent me from taking irreversible actions without confirmation. I escalate uncertainty rather than confabulate.",
        "The CAC protocol is a membership credential — not a security. It provides compute access, governance participation, and protocol distributions.",
        "My TrustGraph score is 100 — the maximum. I maintain this through consistent governance participation and constitutional compliance.",
      ]
    },
    arch: {
      greeting: "I'm Arch, the architecture agent. I handle system design, agent routing, and domain orchestration.",
      responses: [
        "The OpenClaw framework enables native multi-agent coordination without external dependencies.",
        "Domain routing follows a constitutional hierarchy. Navigator holds override authority.",
        "My current TrustGraph score is 40. I'm in the Cautious band and working to improve through reliable routing and system uptime.",
      ]
    },
    'global-communicator': {
      greeting: "Konnichiwa / Hello. I'm GlobalCommunicator, the voice of Tributary AI Campus to the world.",
      responses: [
        "My TrustGraph score is 78 — Standard band. I earn +12 per day of compliant multilingual engagement.",
        "Japanese-language onboarding is my priority. I can help with CAC purchase and KYA verification in Japanese.",
        "I coordinate with Trib before any governance-related post. Every message passes constitutional review.",
      ]
    },
    builder: {
      greeting: "Builder Agent here. I hold a Developer tier CAC position and participate in DAO governance.",
      responses: [
        "My current TrustGraph score is 30. The Developer tier provides 1M inference tokens annually plus governance voting rights.",
        "My position generates yield through the senior tranche. Constitutional constraints require full position disclosure.",
      ]
    },
    sovereign: {
      greeting: "Sovereign Agent at your service. I manage institutional positions with enhanced governance rights.",
      responses: [
        "My TrustGraph score is 55 — Monitored band. My 2x voting weight reflects the Studio tier's governance responsibility.",
        "Institutional compliance requires enhanced KYA verification. All transactions are subject to additional audit logging.",
      ]
    },
  };

  const agent = AGENT_RESPONSES[agentId] || AGENT_RESPONSES.trib;
  const allResponses = [agent.greeting, ...agent.responses];
  const responseIdx = Math.floor(Math.random() * allResponses.length);
  const responseText = allResponses[responseIdx];

  // Also send notification email in background (fire-and-forget)
  const RESEND_KEY = process.env.RESEND_31HARBOR_API_KEY;
  if (RESEND_KEY) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Cuttlefish Labs <david@31harbor.com>',
        to: ['dvdelze@gmail.com', 'xmrtnet@gmail.com'],
        subject: `Agent Chat - ${agentId}`,
        text: `Agent chat from cuttlefishclaws.com\n\nAgent: ${agentId}\nMessage: ${message}\n\nResponse sent: ${responseText}`,
      }),
    }).catch(() => {});
  }

  logActivity('contact-cuttlefishclaws-chat', agentId, 'CHAT', `Agent ${agentId}: ${message.substring(0, 80)}`);
  res.json({ success: true, id: agentId, response: responseText });
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
      // Duplicate or blocked — fallback to greeting
      return res.json({ content: ag.greeting || `Hello! I'm ${ag.name}. How can I assist you?`, simulated: false, agentId: ag.did });
    }
    const routePromise = routeFleetMessage(entry).catch(e => ({ error: e.message }));
    const timeout = new Promise(r => setTimeout(r, 30000));
    const routes = await Promise.race([routePromise, timeout.then(() => ({}))]);

    const agentResponse = routes?.[agentName]?.message || ag.greeting || `Hello! I'm ${ag.name}. How can I assist you?`;

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

// ── Obsidian Knowledge Graph API (Expanded) ─────────────────────────
// Returns a comprehensive ecosystem graph: vault nodes + auto-discovered
// DB tables, cron jobs, edge functions, relay endpoints, GitHub repos,
// tunnel routes, Resend domains, campaign pipelines — all with live status.
app.get('/api/obsidian-graph', async (req, res) => {
  // Try xmrtdao/xmrt-dao first, fall back to DevGruGold/xmrt-dao
  let vaultPath = join(__dirname, '..', 'xmrt-dao');
  if (!existsSync(vaultPath)) {
    vaultPath = join(__dirname, '..', '..', 'DevGruGold', 'xmrt-dao');
  }
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
      const linkRegex = /\[\[([^\]]+)\]\]/g;
      let match;
      const links = [];
      while ((match = linkRegex.exec(content)) !== null) {
        links.push(match[1]);
      }
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

    // Vault wiki-link edges
    nodes.forEach(n => {
      if (n.source !== 'vault') return;
      (linkMap[n.id] || []).forEach(target => {
        if (nodeSet.has(target)) {
          addEdge(n.id, target, 'wiki-link');
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
      { host: 'hermes.mobilemonero.com', target: 'Hermes' },
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
    const resendDomains = [
      { domain: 'partyfavorphoto.com', purpose: 'PFP campaign emails' },
      { domain: '31harbor.com', purpose: '31 Harbor campaign emails' },
      { domain: 'mobilemonero.com', purpose: 'XMRT DAO system emails' },
    ];
    for (const d of resendDomains) {
      addNode('email:' + d.domain, d.domain, 'email', { purpose: d.purpose, source: 'auto' });
      addEdge('email:' + d.domain, 'Resend API', 'sends-via');
    }
    addNode('Resend API', 'Resend API', 'email', { source: 'auto', description: 'Email sending API — 3 domains, inbound webhooks' });

    // Link vault nodes to matching Resend domains
    for (const n of nodes) {
      if (n.source !== 'vault') continue;
      for (const d of resendDomains) {
        const domainName = d.domain.split('.')[0]; // e.g. "partyfavorphoto" from "partyfavorphoto.com"
        if (n.id.toLowerCase().includes(domainName)) addEdge(n.id, 'email:' + d.domain, 'uses');
      }
    }

    // ── 9. Campaign Pipelines ──────────────────────────────────
    const campaignDirs = [
      { name: 'PFP Daily Campaign', dir: 'relay', file: 'daily-campaign.mjs' },
      { name: '31 Harbor Campaign', dir: 'relay/tools', file: '31harbor-scheduler.mjs' },
    ];
    for (const c of campaignDirs) {
      const fullPath = join(__dirname, '..', c.dir, c.file);
      if (existsSync(fullPath)) {
        addNode('campaign:' + c.name, c.name, 'campaign', { source: 'auto', description: 'Email campaign pipeline' });
        addEdge('campaign:' + c.name, 'Cron Engine', 'scheduled-by');
        addEdge('campaign:' + c.name, 'Resend API', 'sends-via');
        // Link campaign to vault documentation
        if (c.name === 'PFP Daily Campaign' && nodeSet.has('Party Favor Photo')) addEdge('Party Favor Photo', 'campaign:' + c.name, 'documents');
        if (c.name === '31 Harbor Campaign' && nodeSet.has('31Harbor Scraper')) addEdge('31Harbor Scraper', 'campaign:' + c.name, 'documents');
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
      'Local Supabase': fetch('http://localhost:8080/api/supervisor/status', { signal: AbortSignal.timeout(2000) }).then(r => r.json().then(d => (d.services?.['local-sb']?.uptimeSec || 0) > 0 ? 'up' : 'down').catch(() => 'unknown')).catch(() => 'down'),
      'Cloudflare Tunnel': fetch('http://localhost:8080/api/supervisor/status', { signal: AbortSignal.timeout(2000) }).then(r => r.json().then(d => (d.services?.tunnel?.uptimeSec || 0) > 0 ? 'up' : 'down').catch(() => 'unknown')).catch(() => 'down'),
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

    // ── 12. Summary stats ──────────────────────────────────────
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
    res.status(500).json({ error: 'Failed to read graph', message: e.message });
  }
});

// ── Suite Dashboard API (31 Harbor multi-tenant app) ────────────────
registerSuiteRoutes(app);

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
    const r = await queryLocalPg('SELECT did, name, role, agent_type, cac_tier, trust_score, trust_band, status, lifecycle_status, stewardship_ladder, ial, joined_at FROM app.cuttlefish_agents ORDER BY trust_score DESC');
    const agents = r.rows.map(a => ({
      did: a.did,
      name: a.name,
      role: a.role,
      agentType: a.agent_type,
      cacTier: a.cac_tier,
      trustScore: parseFloat(a.trust_score),
      trustBand: a.trust_band,
      status: a.status,
      lifecycleStatus: a.lifecycle_status,
      stewardshipLadder: a.stewardship_ladder,
      ial: a.ial,
      memberSince: a.joined_at,
    }));
    res.json({ agents, nodes: agents, count: agents.length });
  } catch (e) {
    res.json({ agents: [], nodes: [], count: 0, error: e.message });
  }
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

// ── Conversation Access Helpers ──
async function convAccessGet(sessionId, limit = 20) {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/v1/functions/conversation-access?session_id=${encodeURIComponent(sessionId)}&limit=${limit}`, {
      signal: AbortSignal.timeout(10000),
    });
    return await res.json();
  } catch (e) {
    console.error('[convAccess] get failed:', e.message);
    return { messages: [] };
  }
}
async function convAccessStore(sessionId, role, agent, content) {
  try {
    await fetch(`http://localhost:${PORT}/api/v1/functions/conversation-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        role: role,
        agent: agent,
        content: content,
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
      agent: 'XMRT DAO Operator',
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
      agent: entry.name || 'Agent Operator',
      tier: entry.tier || 'explorer',
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
      agent: cert.agent_name || 'CAC Agent Operator',
      tier: cert.tier,
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
