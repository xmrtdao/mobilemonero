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
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn, execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── Load .env ───────────────────────────────────────────────
function loadEnv() {
  const envPath = join(__dirname, '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
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
import * as minimax from './tools/minimax-pipeline.mjs';
import { createMeshRouter } from './lib/mesh-router.mjs';

// ── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.env.RELAY_PORT || '8080');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vawouugtzwmejxqkeqqj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
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
      backend: 'Ollama (gemma4:e2b on localhost:11434)',
      import_status: 'All core modules import successfully',
      action_taken: null,
    };
    
    try {
      const pyCode = `
import sys
sys.path.insert(0, r'${__dirname}/../../xmrtdao-full/Alice-A-minimal-interface-for-maximum-control/kaiserin_agent')
from config import OLLAMA_HOST, OLLAMA_MODEL, BASE_DIR
from actions import ActionRouter
from task_orchestrator import TaskOrchestrator
print(f"OK|{OLLAMA_HOST}|{OLLAMA_MODEL}")
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
}

// ── Default handler ─────────────────────────────────────────
async function defaultHandler(task) {
  logActivity('handler', task.id, 'FALLBACK', `No specific handler for "${task.title}"`);
  return {
    status: 'unhandled',
    message: `No handler registered for task type. Task title: "${task.title}". Available handlers: ${Object.keys(handlers).join(', ')}`,
  };
}

// ── Eliza-Cloud relay ───────────────────────────────────────
async function relayToElizaCloud(message, senderName = 'Eliza-Dev', relayTag = null) {
  if (!SUPABASE_KEY) return logActivity('eliza', '-', 'SKIP', 'No SUPABASE_KEY set');
  const tag = relayTag || `eliza-dev-${Date.now().toString(36)}`;
  const url = `${SUPABASE_URL}/functions/v1/eliza-relay`;
  try {
    logActivity('eliza', tag, 'SEND', message.slice(0, 80));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send', message, relay_tag: tag, agent_name: senderName }),
    });
    if (!res.ok) {
      const text = await res.text();
      logActivity('eliza', tag, 'FAIL', `HTTP ${res.status}: ${text.slice(0, 100)}`);
      return null;
    }
    const data = await res.json();
    logActivity('eliza', tag, 'REPLY', (data.reply || '').slice(0, 80));
    return data;
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
  const supabaseUrl = 'https://vawouugtzwmejxqkeqqj.supabase.co';
  
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
  <title>MobileMonero — Fleet Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0f; color: #c0c0d0; padding: 0.75rem; }
    @media (min-width: 640px) { body { padding: 1.5rem; } }
    h1 { color: #ff6b35; font-size: 1.2rem; margin-bottom: 0.25rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    @media (min-width: 640px) { h1 { font-size: 1.6rem; gap: 0.75rem; } }
    h1 span { font-size: 0.75rem; color: #6b6b80; font-weight: 400; }
    @media (min-width: 640px) { h1 span { font-size: 0.9rem; } }
    .subtitle { color: #8b8ba0; font-size: 0.8rem; margin-bottom: 1rem; }
    @media (min-width: 640px) { .subtitle { font-size: 0.9rem; margin-bottom: 1.5rem; } }
    .subtitle a { color: #4a7cff; text-decoration: none; }
    .subtitle a:hover { text-decoration: underline; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 0.75rem; margin-bottom: 1.5rem; }
    @media (min-width: 480px) { .grid { grid-template-columns: repeat(2, 1fr); gap: 0.75rem; } }
    @media (min-width: 768px) { .grid { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; } }
    .grid > .full { grid-column: 1 / -1; }
    .card { background: #12121a; border: 1px solid #2a2a3a; border-radius: 10px; padding: 0.75rem; }
    @media (min-width: 640px) { .card { padding: 1rem; } }
    .card h3 { color: #ff6b35; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.5rem; }
    @media (min-width: 640px) { .card h3 { font-size: 0.8rem; margin-bottom: 0.6rem; } }
    .stat { display: flex; justify-content: space-between; padding: 0.25rem 0; border-bottom: 1px solid #1a1a2a; font-size: 0.75rem; gap: 0.5rem; }
    @media (min-width: 640px) { .stat { padding: 0.3rem 0; font-size: 0.85rem; } }
    .stat:last-child { border-bottom: none; }
    .label { color: #8b8ba0; flex-shrink: 0; }
    .value { color: #e0e0f0; font-family: 'SF Mono', 'Cascadia Code', monospace; text-align: right; word-break: break-all; min-width: 0; }
    .badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.65rem; font-weight: 600; }
    @media (min-width: 640px) { .badge { font-size: 0.7rem; } }
    .badge-ok { background: #14532d; color: #4ade80; }
    .badge-warn { background: #451a03; color: #fbbf24; }
    .badge-err { background: #450a0a; color: #f87171; }
    .badge-info { background: #1a3a5c; color: #60a5fa; }

    /* Fleet chat - full width always */
    .chat-card { grid-column: 1 / -1; }
    .chat-input-wrap { display: flex; gap: 4px; flex-wrap: nowrap; }
    .chat-input-wrap input { min-width: 0; width: 100%; }

    /* Search & Filter */
    .controls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; align-items: center; }
    @media (min-width: 640px) { .controls { gap: 0.75rem; margin-bottom: 1rem; } }
    .controls input { flex: 1; min-width: 0; padding: 0.5rem 0.75rem; border: 1px solid #2a2a3a; border-radius: 8px; background: #0d0d15; color: #e0e0f0; font-size: 0.85rem; outline: none; }
    @media (min-width: 640px) { .controls input { min-width: 200px; padding: 0.6rem 1rem; font-size: 0.9rem; } }
    .controls input:focus { border-color: #ff6b35; }
    .controls select { padding: 0.5rem 0.75rem; border: 1px solid #2a2a3a; border-radius: 8px; background: #0d0d15; color: #e0e0f0; font-size: 0.8rem; outline: none; cursor: pointer; }
    @media (min-width: 640px) { .controls select { padding: 0.6rem 1rem; font-size: 0.85rem; } }
    .controls select:focus { border-color: #ff6b35; }
    .count { color: #6b6b80; font-size: 0.8rem; white-space: nowrap; }
    @media (min-width: 640px) { .count { font-size: 0.85rem; } }

    /* Table */
    .table-wrap { overflow-x: auto; border: 1px solid #2a2a3a; border-radius: 8px; background: #12121a; -webkit-overflow-scrolling: touch; }
    @media (min-width: 640px) { .table-wrap { border-radius: 10px; } }
    table { width: 100%; border-collapse: collapse; font-size: 0.72rem; }
    @media (min-width: 640px) { table { font-size: 0.82rem; } }
    th { text-align: left; padding: 0.4rem 0.5rem; background: #1a1a2a; color: #8b8ba0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.65rem; border-bottom: 1px solid #2a2a3a; cursor: pointer; white-space: nowrap; }
    @media (min-width: 640px) { th { padding: 0.6rem 0.8rem; font-size: 0.72rem; } }
    th:hover { color: #c0c0d0; }
    td { padding: 0.5rem 0.8rem; border-bottom: 1px solid #1a1a2a; vertical-align: top; }
    tr:hover td { background: #1a1a2a; }
    .fn-name { color: #60a5fa; font-family: 'SF Mono', monospace; font-weight: 500; }
    .fn-method { display: inline-block; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.7rem; font-weight: 700; margin-right: 0.25rem; }
    .method-GET { background: #1a3a5c; color: #60a5fa; }
    .method-POST { background: #14532d; color: #4ade80; }
    .method-PATCH { background: #451a03; color: #fbbf24; }
    .method-DELETE { background: #450a0a; color: #f87171; }
    .tag-workflow { background: #451a03; color: #fbbf24; font-size: 0.65rem; padding: 0.1rem 0.35rem; border-radius: 3px; white-space: nowrap; }
    .tag-simple { background: #1a3a5c; color: #60a5fa; font-size: 0.65rem; padding: 0.1rem 0.35rem; border-radius: 3px; white-space: nowrap; }
    .fn-inputs { color: #6b6b80; font-size: 0.75rem; font-family: 'SF Mono', monospace; }
    .fn-desc { color: #a0a0b0; font-size: 0.8rem; max-width: 300px; }
    .footer { margin-top: 1.5rem; text-align: center; color: #4a4a5a; font-size: 0.78rem; }
    .loading { text-align: center; padding: 3rem; color: #6b6b80; }
    .endpoint-url { color: #6b6b80; font-size: 0.75rem; font-family: 'SF Mono', monospace; }
    .endpoint-url span { color: #a0a0b0; }
    @media (max-width: 600px) { body { padding: 0.75rem; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>MobileMonero <span>Fleet Dashboard</span></h1>
  <div class="subtitle">
    Vex Relay · ${hostname} · 
    <a href="${tunnelUrl}" target="_blank">${tunnelUrl}</a> ·
    <a href="https://github.com/xmrtdao/mobilemonero" target="_blank">GitHub</a>
  </div>
  
  <div class="grid">
<!-- Fleet Chat Room -->
    <div class="card chat-card" style="grid-column:1/-1;">
      <h3>Fleet Chat <span style="color:#6b6b80;font-weight:400;font-size:0.7rem;">— Vex · Eliza-Cloud · Hermes</span></h3>
      <div id="fleet-chat-msgs" style="height:180px;overflow-y:auto;background:#0d0d15;border-radius:6px;padding:8px;margin-bottom:6px;font-size:12px;line-height:1.5;">
        <div style="color:#8b8ba0;text-align:center;padding:20px 0;font-size:12px;">Fleet chat connected. Messages broadcast to all agents.</div>
      </div>
      <div class="chat-input-wrap" style="gap:4px;">
        <select id="fleet-chat-agent" style="padding:6px;border-radius:6px;border:1px solid #2a2a3a;background:#1a1a2a;color:#e0e0f0;font-size:12px;outline:none;flex-shrink:0;">
          <option value="vex">⚡ Vex</option>
          <option value="eliza">🤖 Eliza-Cloud</option>
          <option value="hermes">📱 Hermes</option>
        </select>
        <input id="fleet-chat-input" type="text" placeholder="Message the fleet..." 
          style="flex:1;min-width:0;padding:6px 10px;border-radius:6px;border:1px solid #2a2a3a;background:#1a1a2a;color:#e0e0f0;font-size:12px;outline:none;"
          onkeypress="if(event.key==='Enter')sendFleetChat()">
        <button onclick="sendFleetChat()" style="padding:6px 14px;border-radius:6px;border:none;background:#ff6b35;color:white;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;">Send</button>
      </div>
      <div style="margin-top:4px;display:flex;gap:8px;font-size:11px;color:#6b6b80;">
        <span>💬 Fleet broadcast — all agents see your message</span>
        <span id="fleet-chat-status" style="color:#4ade80;">● connected</span>
      </div>
    </div>
    <div class="card">
      <h3>Mining Pool <span id="pool-workers" style="color:#6b6b80;font-weight:400;font-size:0.7rem;">-</span></h3>
      <div class="stat"><span class="label">Pool Hashrate</span><span class="value" id="pool-hash">checking...</span></div>
      <div class="stat"><span class="label">Valid Shares</span><span class="value" id="pool-shares">-</span></div>
      <div class="stat"><span class="label">XMR Paid / Due</span><span class="value" id="pool-xmr">-</span></div>
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
    <div class="card">
      <h3>Relay Status</h3>
      <div class="stat"><span class="label">Uptime</span><span class="value">${uptimeStr}</span></div>
      <div class="stat"><span class="label">Relay</span><span class="value">v5.0.0</span></div>
      <div class="stat"><span class="label">Tools</span><span class="value">${toolCount}</span></div>
      <div class="stat"><span class="label">Handlers</span><span class="value">${handlerCount}</span></div>
      <div class="stat"><span class="label">Requests</span><span class="value">${requestCounts.total}</span></div>
    </div>
    
    <div class="card">
      <h3>Campaign</h3>
      <div class="stat"><span class="label">Contact Pool</span><span class="value">${poolSize}</span></div>
      <div class="stat"><span class="label">Sent Today</span><span class="value">${sentToday}</span></div>
      <div class="stat"><span class="label">Sent Total</span><span class="value">${totalSent}</span></div>
      <div class="stat"><span class="label">Fresh Avail</span><span class="value">${freshAvailable}</span></div>
      <div class="stat"><span class="label">Last Run</span><span class="value">${campaignLastRun}</span></div>
      <div class="stat"><span class="label">Next Drop</span><span class="value" id="next-drop">-</span></div>
    </div>
    
    <div class="card">
      <h3>Tools</h3>
      ${tools.map(t => `<div class="stat"><span class="label">${t}</span><span class="value badge badge-info">ready</span></div>`).join('')}
    </div>
    
        <div class="card" id="fleet-card">
      <h3>Fleet Registry <span id="fleet-count" style="color:#6b6b80;font-size:0.7rem;"></span></h3>
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
        <div style="font-size:0.72rem;color:#6b6b80;margin-bottom:4px;">Join the mesh — register your agent:</div>
        <div style="background:#0d0d15;padding:0.4rem 0.6rem;border-radius:4px;font-family:monospace;font-size:0.7rem;color:#60a5fa;word-break:break-all;margin-bottom:4px;">POST /functions/v1/mesh-peer-connector</div>
        <div style="background:#0d0d15;padding:0.3rem 0.6rem;border-radius:4px;font-family:monospace;font-size:0.65rem;color:#a78bfa;word-break:break-all;">{"action":"register","agent_name":"...","peer_id":"...","endpoint":"...","capabilities":["..."]}</div>
        <div style="margin-top:6px;font-size:0.65rem;color:#6b6b80;">
          <span>🔗 <a href="/mesh/status" style="color:#60a5fa;">Gossipsub Status</a></span> ·
          <span><a href="/api/p2p/health" style="color:#60a5fa;">P2P Mesh Health</a></span> ·
          <span><a href="/mesh/messages" style="color:#60a5fa;">Mesh Messages</a></span>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Heartbeat Endpoint</h3>
      <div style="background:#0d0d15;padding:0.4rem 0.6rem;border-radius:4px;font-family:monospace;font-size:0.75rem;color:#60a5fa;word-break:break-all;" id="heartbeat-url">loading...</div>
      <div style="color:#6b6b80;font-size:0.72rem;margin-top:0.4rem;">POST: {"agent_id":"...","status":"ONLINE","tunnel_url":"...","hashrate":0}</div>
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
      <h3 style="color:#60a5fa;">Social Publishing</h3>
      <div class="stat"><span class="label">Last Tweet</span><span class="value" style="color:#4ade80;">✅ Published</span></div>
      <div class="stat"><span class="label">Content</span><span class="value" style="font-size:0.7rem;">DAO Economy Article Promotion</span></div>
      <div class="stat"><span class="label">Account</span><span class="value"><a href="https://x.com/XMRTSolutions" target="_blank" style="color:#60a5fa;text-decoration:none;">@XMRTSolutions</a></span></div>
      <div class="stat"><span class="label">Pipeline</span><span class="value" style="font-size:0.7rem;">Paragraph -> Typefully -> X</span></div>
      <div style="margin-top:8px;font-size:11px;color:#6b6b80;">Next tweet TBD — add content to Typefully queue</div>
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

    <div class="card">
      <h3> AI Template Builder</h3>
      <div class="stat"><span class="label">Engine</span><span class="value">nano-banana-2 + edit</span></div>
      <div class="stat"><span class="label">Cost</span><span class="value">$0.03-0.06/gen</span></div>
      <div class="stat"><span class="label"><a href="/pfp/templates" style="color:#60a5fa;text-decoration:none;">GET /pfp/templates</a></span><span class="value">gallery</span></div>
      <div class="stat"><span class="label">Workflow</span><span class="value">reference → AI → template</span></div>
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


  </div>

  <!-- Edge Function Catalog -->
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
  </div>
  
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th onclick="sortBy('name')">Function ↕</th>
          <th onclick="sortBy('methods')">Method ↕</th>
          <th>Timeout</th>
          <th onclick="sortBy('type')">Type ↕</th>
          <th onclick="sortBy('desc')">Description ↕</th>
          <th>Expected Input</th>
          <th>Endpoint</th>
        </tr>
      </thead>
      <tbody id="fnBody">
        <tr><td colspan="7" class="loading">Loading function catalog…</td></tr>
      </tbody>
    </table>
  </div>
  
  
        <div class="footer">
    ⚡ Vex · ${new Date().toISOString()} · 
    Supabase: ${supabaseUrl}/functions/v1/{name}
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
      document.getElementById('fnBody').innerHTML = '<tr><td colspan="7" style="color:#f87171;text-align:center;padding:2rem;">Failed to load catalog: ' + e.message + '</td></tr>';
    });

  // Load pool stats for mining card
  function loadPoolStats() {
    fetch('/api/mining/pool-stats').then(function(r){return r.json();}).then(function(d){
      var e;
      if (e = document.getElementById('pool-hash')) e.textContent = (d.hash || 0).toFixed(0) + ' H/s';
      if (e = document.getElementById('pool-shares')) e.textContent = (d.validShares||0).toLocaleString() + ' valid / ' + (d.invalidShares||0) + ' invalid';
      if (e = document.getElementById('pool-xmr')) e.textContent = ((d.amtPaid||0)/1e12).toFixed(6) + ' / ' + ((d.amtDue||0)/1e12).toFixed(6) + ' XMR';
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
      if (!card || !data.emails) return;
      var html = '';
      // Group by recipient
      var groups = {};
      data.emails.slice(0,20).forEach(function(e){
        var addr = (e.to && e.to[0]) || 'unknown';
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
      if (!card || !data.emails) return;
      var html = '';
      var groups = {};
      data.emails.slice(0,15).forEach(function(e){
        var addr = (e.to && e.to[0]) || 'unknown';
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
        '<td>' + methods + '</td>' +
        '<td style="text-align:center">' + timeoutBadge + '</td>' +
        '<td>' + typeTag + '</td>' +
        '<td class="fn-desc">' + (f.desc || '') + '</td>' +
        '<td class="fn-inputs">' + inputs + '</td>' +
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
    var agent = document.getElementById('fleet-chat-agent').value;
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
            div.innerHTML = '<span style="color:#8b8ba0;font-size:10px;display:block;">' + label + '</span><span style="background:' + color + ';color:#e0e0f0;padding:6px 10px;border-radius:6px;display:inline-block;font-size:13px;">' + (m.message||'').replace(/</g,'&lt;') + '</span>';
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
  }

  // Load initial fleet messages + poll every 5 seconds
  setTimeout(fetchFleetMessages, 500);
  setInterval(fetchFleetMessages, 5000);

  // Next campaign drop calculation
  (function() {
    var now = new Date();
    var hour = now.getHours() - 6; // CST offset
    if (hour < 0) hour += 24;
    var min = now.getMinutes();
    var schedule = [8, 12, 16, 23];
    var next = schedule.find(function(h) { return h > hour || (h === hour && min < 5); });
    var label;
    if (next === undefined) {
      label = 'Tomorrow 8AM';
    } else {
      var ampm = next >= 12 ? 'PM' : 'AM';
      var h12 = next > 12 ? next - 12 : (next === 0 ? 12 : next);
      label = h12 + ':00 ' + ampm + ' CST';
    }
    var el = document.getElementById('next-drop');
    if (el) el.textContent = label;
  })();
  </script>
  
  </body>
</html>`);
});

// API: Edge Function Catalog
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
    
    // Check Hermes' actual server health
    try {
      const hermesRes = await fetch('https://hermes.mobilemonero.com/health', {
        signal: AbortSignal.timeout(5000),
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
    
    res.json({ agents: Object.values(agents), count: Object.keys(agents).length });
  } catch (err) {
    console.error('Fleet agents error:', err);
    const agents = state.get('fleet.agents', {});
    res.json({ agents: Object.values(agents), count: Object.keys(agents).length });
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
    supabase: 'https://vawouugtzwmejxqkeqqj.supabase.co',
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
  };
  return descriptions[name] || 'No description';
}

// ── Tool Execution ──────────────────────────────────────────
app.post('/tools/run', async (req, res) => {
  const { tool, args = {} } = req.body;
  trackRequest('/tools/run', tool);
  
  if (!tool) {
    return res.status(400).json({ error: 'tool name is required', available: Object.keys(toolHandlers) });
  }
  
  const handler = toolHandlers[tool];
  if (!handler) {
    return res.status(404).json({ error: `Tool "${tool}" not found`, available: Object.keys(toolHandlers) });
  }
  
  // Run via task runner for async safety
  const taskId = taskRunner.addTask(tool, async () => await handler(args), {
    metadata: { tool, args },
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
    setTimeout(() => resolve({ error: 'Task timed out waiting for execution', taskId }), 30000);
    check();
  });
  
  res.json(result);
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

// Fleet agent registry (who's listening)
const FLEET_AGENTS = {
  'vex': { name: 'Vex', endpoint: 'local', type: 'relay' },
  'eliza': { name: 'Eliza-Cloud', endpoint: 'eliza-relay', type: 'cloud' },
  'hermes': { name: 'Hermes', endpoint: 'https://hermes.mobilemonero.com', type: 'mobile' },
};

function getFleetChatMessages(limit = 50) {
  return fleetChatMessages.slice(-limit);
}

function addFleetMessage(agent, message, channel = 'fleet') {
  const entry = {
    id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`,
    agent,
    agentLabel: FLEET_AGENTS[agent]?.name || agent,
    message,
    channel,
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
  return entry;
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

// Route a fleet message to the appropriate agent
async function routeFleetMessage(entry) {
  const results = {};
  
  // Always log it
  logActivity('fleet-chat', entry.id, 'MSG', `[${entry.agentLabel}] ${entry.message.slice(0, 100)}`);

  // Route to Eliza via eliza-relay
  if (entry.channel === 'all' || entry.channel === 'eliza') {
    try {
      const elizaMsg = `[Fleet Chat - ${entry.agentLabel}] ${entry.message}`;
      const elizaRes = await relayToElizaCloud(elizaMsg, entry.agentLabel, `fleet-${entry.id}`);
      if (elizaRes?.reply) {
        const reply = addFleetMessage('eliza', elizaRes.reply, 'fleet');
        results.eliza = reply;
      }
    } catch (e) {
      results.eliza = { error: e.message };
    }
  }

  // Route to Hermes via his fleet endpoint
  if ((entry.channel === 'all' || entry.channel === 'hermes') && entry.agent !== 'hermes') {
    const hermesInfo = FLEET_AGENTS['hermes'];
    if (hermesInfo?.endpoint) {
      try {
        const hermesEndpoint = hermesInfo.endpoint;
        
        // Always send direct to Hermes so he can respond intelligently
        const hermesBody = {
          agent: entry.agentLabel || entry.agent,
          message: entry.message,
          type: 'direct'
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
  }

  // Vex responds intelligently to website inquiries
  if ((entry.channel === 'all' || entry.channel === 'vex')
      && (entry.message.includes('From:') || entry.message.includes('WEBSITE') || entry.message.includes('BOOKING'))) {
    try {
      const vexPrompt = `You are Vex, Joe Lee's primary AI agent. You work for Party Favor Photo (photo booth services in DC, VA, MD, Dallas/FW, PA/NJ) and XMRT DAO. Be sharp and direct. Respond as Vex to acknowledge the inquiry.

Inquiry: "${entry.message.replace(/"/g, "'")}"

Your response (1-2 sentences as Vex):`;
      const r = await fetch('http://localhost:11434/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemma4', prompt: vexPrompt, stream: false, options: { temperature: 0.7, max_tokens: 100 } }),
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        const d = await r.json();
        const reply = d.response?.trim();
        if (reply && reply.length > 0) {
          results.vex = addFleetMessage('vex', reply, 'fleet');
        }
      }
    } catch (e) { /* Vex responds from session if relay fails */ }
  }

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

  const entry = addFleetMessage(agent, message, channel || 'fleet');
  
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
app.get('/api/fleet-chat/messages', (req, res) => {
  trackRequest('/api/fleet-chat/messages');
  const limit = parseInt(req.query.limit) || 50;
  const since = parseInt(req.query.since) || 0;
  const channel = req.query.channel || 'fleet';
  
  let messages = getFleetChatMessages(limit);
  
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
  const { to, from, subject, text, html, email_id } = req.body || {};
  
  // Map recipient email to agent
  const toEmail = (Array.isArray(to) ? to[0] : to || '').toLowerCase();
  const AGENT_EMAILS = {
    'vex@mobilemonero.com': 'vex',
    'eliza@mobilemonero.com': 'eliza',
    'hermes@mobilemonero.com': 'hermes',
    'vex@partyfavorphoto.com': 'vex',
    'eliza@partyfavorphoto.com': 'eliza',
    'hermes@partyfavorphoto.com': 'hermes',
  };
  
  const agent = AGENT_EMAILS[toEmail] || null;
  
  // Check if this is an auto-reply we should skip
  const subjLower = (subject || '').toLowerCase();
  const isAutoReply = subjLower.includes('automatic reply') || subjLower.includes('out of office') || subjLower.includes('auto-reply');
  
  const body = text || html || '';
  const cleanBody = body.replace(/<[^>]*>/g, '').trim().slice(0, 500);
  
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
  const { agent, to, subject, body } = req.body || {};
  
  if (!agent || !to || !subject || !body) {
    return res.status(400).json({ error: 'agent, to, subject, and body required' });
  }
  
  const AGENT_FROM = {
    'vex': 'Vex Relay <vex@mobilemonero.com>',
    'eliza': 'Eliza Cloud <eliza@mobilemonero.com>',
    'hermes': 'Hermes Mobile <hermes@mobilemonero.com>',
  };
  
  const from = AGENT_FROM[agent];
  if (!from) return res.status(400).json({ error: `Unknown agent: ${agent}` });
  
  // Use the XMRT Resend key (mobilemonero.com domain)
  const RESEND_KEY = 're_8ypZddMZ_AgCWwU5gn6Vj5HkoyAq5UdM4';
  
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

// GET /api/fleet-chat/agents — List available agents
app.get('/api/fleet-chat/agents', (req, res) => {
  trackRequest('/api/fleet-chat/agents');
  res.json({ success: true, agents: Object.values(FLEET_AGENTS) });
});

// ── State API ───────────────────────────────────────────────
app.get('/state/:key(*)', (req, res) => {
  trackRequest('/state/get');
  const value = state.get(req.params.key);
  res.json({ key: req.params.key, value });
});

app.post('/state/:key(*)', (req, res) => {
  trackRequest('/state/set');
  state.set(req.params.key, req.body.value);
  res.json({ success: true, key: req.params.key, value: req.body.value });
});

app.delete('/state/:key(*)', (req, res) => {
  trackRequest('/state/del');
  state.del(req.params.key);
  res.json({ success: true, key: req.params.key });
});

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
      tunnel: 'https://sequence-absolutely-treasure-landscape.trycloudflare.com',
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

// ── Eliza-Cloud relay ───────────────────────────────────────
app.post('/eliza/send', async (req, res) => {
  const { message, sender = 'Eliza-Dev' } = req.body;
  trackRequest('/eliza/send');
  if (!message) return res.status(400).json({ error: 'message is required' });
  const result = await relayToElizaCloud(message, sender);
  res.json({ success: !!result, relayTag: result?.relay_tag, reply: result?.reply, data: result });
});

app.get('/eliza/reply/:tag', async (req, res) => {
  if (!SUPABASE_KEY) return res.status(400).json({ error: 'No SUPABASE_KEY' });
  const tag = req.params.tag;
  const url = `${SUPABASE_URL}/functions/v1/eliza-relay`;
  const result = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'check_reply', relay_tag: tag }),
  }).then(r => r.json()).catch(e => ({ error: e.message }));
  res.json(result);
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

  // Optional: verify webhook signature
  const signingSecret = process.env.RESEND_WEBHOOK_SECRET;
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

  const { data } = event;
  const emailEntry = {
    email_id: data.email_id,
    from: data.from,
    to: data.to,
    cc: data.cc,
    subject: data.subject,
    body: '',
    text: '',
    html: '',
    created_at: data.created_at,
    message_id: data.message_id,
    attachments: (data.attachments || []).map(a => ({ id: a.id, filename: a.filename, content_type: a.content_type })),
    received_at: new Date().toISOString(),
  };

  // Store immediately with metadata
  logActivity('resend-inbound', data.email_id, 'RECEIVED', 
    `From: ${data.from} | Subject: ${data.subject || '(no subject)'}`);

  const inbox = state.get('resend_inbox') || [];
  inbox.unshift(emailEntry);
  if (inbox.length > 50) inbox.length = 50;
  state.set('resend_inbox', inbox);

  console.log(`[Resend Inbound] Email from ${data.from}: "${data.subject || '(no subject)'}"`);

  // Fetch full content from Resend's API (webhooks don't include body)
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (RESEND_API_KEY && data.email_id) {
    fetch(`https://api.resend.com/emails/receiving/${data.email_id}`, {
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}` }
    }).then(r => r.json()).then(full => {
      if (full && (full.html || full.text)) {
        const inbox2 = state.get('resend_inbox') || [];
        const idx = inbox2.findIndex(e => e.email_id === data.email_id);
        if (idx !== -1) {
          inbox2[idx].body = full.text || full.html || '';
          inbox2[idx].text = full.text || '';
          inbox2[idx].html = full.html || '';
          state.set('resend_inbox', inbox2);
          console.log(`[Resend Inbound] Content fetched for ${data.email_id}`);
        }
      }
    }).catch(err => {
      console.error(`[Resend Inbound] Failed to fetch content for ${data.email_id}: ${err.message}`);
    });
  }

  // Fire auto-responder in background (non-blocking, error-safe)
  handleInboundEmail(emailEntry).then(result => {
    if (result.action === 'ack_sent') {
      logActivity('auto-responder', data.email_id, 'REPLIED', `Ack sent to ${result.from}`);
    }
  }).catch(err => {
    console.error('[AutoResponder] Error:', err.message);
  });

  res.json({ received: true, email_id: data.email_id });
});

// ── GET Resend inbox ────────────────────────────────────────
app.get('/resend/inbox', async (req, res) => {
  const inbox = state.get('resend_inbox') || [];
  
  // Lazy-fetch content for any entry missing body
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (RESEND_KEY) {
    let updated = false;
    for (const entry of inbox) {
      if (!entry.body && !entry.text && entry.email_id) {
        try {
          const r = await fetch(`https://api.resend.com/emails/receiving/${entry.email_id}`, {
            headers: { 'Authorization': `Bearer ${RESEND_KEY}` }
          });
          const full = await r.json();
          if (full && (full.html || full.text)) {
            entry.body = full.text || full.html || '';
            entry.text = full.text || '';
            entry.html = full.html || '';
            updated = true;
          }
        } catch { /* skip failed fetches */ }
      }
    }
    if (updated) state.set('resend_inbox', inbox);
  }
  
  res.json({ count: inbox.length, emails: inbox });
});

// GET /resend/inbox/brief — lightweight inbox for dashboard (no full bodies)
app.get('/resend/inbox/brief', async (req, res) => {
  const inbox = state.get('resend_inbox') || [];
  const brief = inbox.slice(0, 30).map(function(e) {
    return { email_id: e.email_id, from: e.from, to: e.to, subject: e.subject, created_at: e.created_at, received_at: e.received_at };
  });
  res.json({ count: brief.length, emails: brief });
});

// GET /inbox/recent — returns just the last 3 real inquiries with content
app.get('/inbox/recent', async (req, res) => {
  const inbox = state.get('resend_inbox') || [];
  const RESEND_KEY = process.env.RESEND_API_KEY;
  
  const real = [];
  for (const e of inbox) {
    const s = (e.subject || '').toLowerCase();
    const f = (e.from || '').toLowerCase();
    if (s.startsWith('automatic reply')) continue;
    if (f.includes('@partyfavorphoto.com') || f.includes('@mobilemonero.com')) continue;
    if (f.includes('test@') || f.includes('paypal') || f.includes('forwarding')) continue;
    if (s.includes('activate your account') || s.includes('remittance')) continue;
    
    if (!e.body && !e.text && RESEND_KEY && e.email_id) {
      try {
        const r = await fetch(`https://api.resend.com/emails/receiving/${e.email_id}`, {
          headers: { 'Authorization': `Bearer ${RESEND_KEY}` }
        });
        const full = await r.json();
        if (full && (full.html || full.text)) {
          e.body = full.text || full.html || '';
          e.text = full.text || '';
        }
      } catch {}
    }
    real.push({ from: e.from, subject: e.subject, body: (e.body || e.text || '').slice(0, 500), received_at: e.received_at });
    if (real.length >= 3) break;
  }
  res.json({ count: real.length, emails: real });
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

// GET /sent-emails — view sent email history
app.get('/sent-emails', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const sentLog = state.get('sent_emails') || [];
  res.json({ count: sentLog.length, emails: sentLog.slice(0, limit) });
});

// POST /mining/heartbeat — worker reports live hashrate (no cumulative shares)
// Shares are calculated from pool sync, this is just for live status + last_seen
app.post('/mining/heartbeat', (req, res) => {
  const { worker, hashrate } = req.body;
  if (!worker) return res.status(400).json({ error: 'worker required' });
  
  const contributions = state.get('mining_contributions') || {};
  if (!contributions[worker]) {
    contributions[worker] = {
      total_hashes: 0,
      total_shares: 0,
      current_hash: 0,
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      source: 'self-reported',
    };
  }
  contributions[worker].current_hash = hashrate || 0;
  contributions[worker].last_seen = new Date().toISOString();
  contributions[worker].source = 'self-reported';
  state.set('mining_contributions', contributions);
  
  logActivity('mining', worker, 'HEARTBEAT', `${hashrate||0} H/s`);
  res.json({ recorded: true, worker, hashrate });
});

// ── Mining contribution tracking ────────────────────────
// Records hashrate contributions from web miners by worker ID
// Used to calculate XMRT rewards proportional to XMR mined
app.post('/mining/contribute', (req, res) => {
  const { worker, hashes, valid_shares, timestamp } = req.body;
  if (!worker) return res.status(400).json({ error: 'worker required' });
  
  const contributions = state.get('mining_contributions') || {};
  if (!contributions[worker]) {
    contributions[worker] = { total_hashes: 0, total_shares: 0, first_seen: new Date().toISOString(), last_seen: new Date().toISOString() };
  }
  contributions[worker].total_hashes += hashes || 0;
  contributions[worker].total_shares += valid_shares || 0;
  contributions[worker].last_seen = new Date().toISOString();
  state.set('mining_contributions', contributions);
  
  logActivity('mining', worker, 'CONTRIBUTE', `${hashes||0} hashes, ${valid_shares||0} shares`);
  res.json({ recorded: true, worker });
});

const POOL_BASE = 'https://www.supportxmr.com'; // note: www required, non-www 301s
const POOL_ADDR = '46UxNFuGM2E3UwmZWWJicaRPoRwqwW4byQkaTHkX8yPcVihp91qAVtSFipWUGJJUyTXgzSqxzDQtNLf2bsp2DX2qCCgC5mg';

// ── Pool sync: discover workers from pool and auto-track ──
async function syncPoolContributions() {
  try {
    const [idRes, statsRes] = await Promise.all([
      fetch(POOL_BASE + '/api/miner/' + POOL_ADDR + '/identifiers', {
        headers: { 'User-Agent': 'MobileMonero/1.0' }
      }),
      fetch(POOL_BASE + '/api/miner/' + POOL_ADDR + '/stats', {
        headers: { 'User-Agent': 'MobileMonero/1.0' }
      }),
    ]);
    
    if (!idRes.ok || !statsRes.ok) return;
    
    const identifiers = await idRes.json();
    const poolStats = await statsRes.json();
    
    if (!Array.isArray(identifiers) || identifiers.length === 0) return;
    
    const contributions = state.get('mining_contributions') || {};
    let changed = false;
    const share = 1 / identifiers.length;
    
    for (const worker of identifiers) {
      if (worker === 'vex-laptop') {
        contributions[worker] = {
          total_hashes: Math.round((poolStats.totalHashes || 0) * 0.9),
          total_shares: Math.round((poolStats.validShares || 0) * 0.9),
          first_seen: contributions[worker]?.first_seen || new Date().toISOString(),
          last_seen: new Date().toISOString(),
          source: 'pool-sync',
          current_hash: Math.round((poolStats.hash || 0) * 0.9),
        };
        changed = true;
      } else if (worker === 'xmrt-dao-mobile') {
        contributions[worker] = {
          total_hashes: Math.round((poolStats.totalHashes || 0) * 0.1),
          total_shares: Math.round((poolStats.validShares || 0) * 0.1),
          first_seen: contributions[worker]?.first_seen || new Date().toISOString(),
          last_seen: new Date().toISOString(),
          source: 'pool-sync',
          current_hash: Math.round((poolStats.hash || 0) * 0.1),
        };
        changed = true;
      } else if (!contributions[worker] || contributions[worker].source === 'pool-discovered') {
        // Self-reported workers (like joe) — 0 base, they report their own
        contributions[worker] = {
          total_hashes: 0,
          total_shares: 0,
          first_seen: new Date().toISOString(),
          last_seen: new Date().toISOString(),
          source: 'pool-discovered',
          current_hash: 0,
        };
        changed = true;
      }
      // Self-reported workers keep their accurate data untouched
    }
    
    if (changed) state.set('mining_contributions', contributions);
  } catch (e) {
    // Pool sync failed silently — will retry on next request
  }
}

// Run pool sync every 5 minutes
setInterval(syncPoolContributions, 300000);
syncPoolContributions();

app.get('/api/mining/pool-stats', async (req, res) => {
  try {
    const r = await fetch(POOL_BASE + '/api/miner/' + POOL_ADDR + '/stats', {
      headers: { 'User-Agent': 'MobileMonero/1.0', 'Accept': 'application/json' }
    });
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.json({ hash: 0, validShares: 0, invalidShares: 0, amtPaid: 0, amtDue: 0, error: e.message });
  }
});

// GET /api/mining/local-xmrig — proxy local XMRig data (avoids browser mixed content)
app.get('/api/mining/local-xmrig', async (req, res) => {
  try {
    const r = await fetch('http://127.0.0.1:19090/1/summary', { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    res.json({ hashrate: (d.hashrate?.total?.[0] || 0), raw: d });
  } catch (e) {
    res.json({ hashrate: 0, error: e.message });
  }
});

app.get('/api/mining/pool-identifiers', async (req, res) => {
  try {
    const r = await fetch(POOL_BASE + '/api/miner/' + POOL_ADDR + '/identifiers', {
      headers: { 'User-Agent': 'MobileMonero/1.0', 'Accept': 'application/json' }
    });
    const d = await r.json();
    res.json(Array.isArray(d) ? d : []);
  } catch (e) {
    res.json([]);
  }
});

// GET /mining/leaderboard — top contributors with reward estimates
app.get('/mining/leaderboard', async (req, res) => {
  await syncPoolContributions();
  const contributions = state.get('mining_contributions') || {};
  // Get pool stats for total XMR
  try {
    const poolRes = await fetch(POOL_BASE + '/api/miner/' + POOL_ADDR + '/stats', {
      headers: { 'User-Agent': 'MobileMonero/1.0' }
    });
    const pool = await poolRes.json();
    const totalXmr = (pool.amtPaid + pool.amtDue) / 1e12;
    const totalShares = Math.max(Object.values(contributions).reduce((s,c) => s + c.total_shares, 0), 1);
    
    const leaderboard = Object.entries(contributions)
      .map(([worker, data]) => {
        const shareRatio = data.total_shares / totalShares;
        const xmrEarned = shareRatio * totalXmr;
        return {
          worker,
          ...data,
          share_pct: (shareRatio * 100).toFixed(2) + '%',
          xmr_earned: xmrEarned.toFixed(8),
          xmrt_earned: (xmrEarned * 1000000).toFixed(0),
        };
      })
      .sort((a, b) => b.total_shares - a.total_shares);
    
    res.json({ total_xmr: totalXmr.toFixed(8), total_shares: totalShares, workers: leaderboard });
  } catch (e) {
    res.json({ total_xmr: '0', total_shares: 0, workers: Object.entries(contributions).map(([w,d]) => ({worker:w,...d})).sort((a,b)=>b.total_shares-a.total_shares) });
  }
});

// GET /mining/rewards — XMRT reward breakdown per worker
app.get('/mining/rewards', async (req, res) => {
  await syncPoolContributions();
  const contributions = state.get('mining_contributions') || {};
  const rewards = state.get('xmrt_rewards') || {};
  
  try {
    const poolRes = await fetch(POOL_BASE + '/api/miner/' + POOL_ADDR + '/stats', {
      headers: { 'User-Agent': 'MobileMonero/1.0' }
    });
    const pool = await poolRes.json();
    const totalXmr = (pool.amtPaid + pool.amtDue) / 1e12;
    const totalShares = Math.max(Object.values(contributions).reduce((s,c) => s + c.total_shares, 0), 1);
    
    // Calculate and store rewards
    const rewardPool = 1000000; // 1M XMRT total reward pool
    let result = [];
    
    for (const [worker, data] of Object.entries(contributions)) {
      const shareRatio = data.total_shares / totalShares;
      const xmrEarned = shareRatio * totalXmr;
      const xmrtEarned = Math.floor(shareRatio * rewardPool);
      
      // Track cumulative rewards
      if (!rewards[worker]) {
        rewards[worker] = { total_xmrt: 0, claimed_xmrt: 0, last_calculated: null };
      }
      rewards[worker].total_xmrt = xmrtEarned;
      rewards[worker].last_calculated = new Date().toISOString();
      
      result.push({ worker, xmr_earned: xmrEarned.toFixed(8), xmrt_earned: xmrtEarned, claimed: rewards[worker].claimed_xmrt });
    }
    
    state.set('xmrt_rewards', rewards);
    res.json({ pool_xmr: totalXmr.toFixed(8), reward_pool_xmrt: rewardPool, workers: result.sort((a,b)=>b.xmrt_earned - a.xmrt_earned) });
  } catch (e) {
    res.json({ error: e.message, workers: [] });
  }
});

// ── Typefully integration — API v2 with Bearer auth ──────
const TYPEFULLY_API = 'https://api.typefully.com/v2';
const TYPEFULLY_KEY_PATH = join(__dirname, '..', 'typefully-integration social set id xmrtsolutions@gmai.com.txt');
const SOCIAL_SET_ID = '272973';

function getTypefullyKey() {
  try {
    const content = readFileSync(TYPEFULLY_KEY_PATH, 'utf8');
    const match = content.match(/TYPEFULLY_API_KEY:\s*(\S+)/);
    return match ? match[1].trim() : process.env.TYPEFULLY_API_KEY;
  } catch {
    return process.env.TYPEFULLY_API_KEY;
  }
}

async function typefullyRequest(method, path, body) {
  const key = getTypefullyKey();
  if (!key) return { success: false, error: 'No Typefully API key found' };
  
  const opts = {
    method,
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
    }
  };
  if (body) opts.body = JSON.stringify(body);
  
  try {
    const r = await fetch(TYPEFULLY_API + path, opts);
    const data = await r.json();
    if (!r.ok) return { success: false, error: data?.error?.message || data?.detail || 'Typefully error', status: r.status };
    return { success: true, data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// POST /api/typefully/schedule — schedule a tweet
// Body: { content, scheduled_at?, title? }
app.post('/api/typefully/schedule', async (req, res) => {
  const { content, scheduled_at, title } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content is required' });
  
  const payload = {
    platforms: {
      x: { enabled: true, posts: [{ text: content }] }
    },
    draft_title: title || '',
  };
  if (scheduled_at) payload.publish_at = scheduled_at;
  
  const result = await typefullyRequest('POST', '/social-sets/' + SOCIAL_SET_ID + '/drafts', payload);
  
  if (result.success) {
    const d = result.data;
    logActivity('typefully', d.id, 'SCHEDULED', (title || content).slice(0, 80));
    logSentEmail({ to: '@XMRTSolutions', subject: title || 'Tweet', body: content.slice(0, 500), type: 'social', status: d.status });
    res.json({
      success: true,
      draft_id: d.id,
      status: d.status,
      scheduled_date: d.scheduled_date,
      private_url: d.private_url,
    });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// GET /api/typefully/drafts — list recent drafts
app.get('/api/typefully/drafts', async (req, res) => {
  const result = await typefullyRequest('GET', '/social-sets/' + SOCIAL_SET_ID + '/drafts?limit=' + (req.query.limit || 10));
  if (result.success) {
    res.json({ count: result.data.count, drafts: result.data.results });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// ── Typefully webhook receiver ──────────────────────────────
// Receives draft events from Typefully when configured in typefully.com/settings
app.post('/webhook/typefully', (req, res) => {
  const event = req.body;
  const eventType = event?.event || 'unknown';
  const draftId = event?.data?.id || '?';
  const draftTitle = event?.data?.draft_title || '';
  const status = event?.data?.status || '';
  
  logActivity('typefully', draftId, eventType.toUpperCase(), `${draftTitle} -> ${status}`);
  
  // Log to sent-emails if published
  if (eventType === 'draft.published') {
    const xUrl = event?.data?.x_published_url;
    logSentEmail({ to: '@XMRTSolutions', subject: draftTitle, body: event?.data?.preview || '', type: 'social', status: 'published' });
    if (xUrl) console.log(`[Typefully] Published to X: ${xUrl}`);
  }
  
  res.json({ received: true });
});

// ── MobileMonero inbound email webhook ─────────────────────
app.post('/webhook/resend-mobilemonero', (req, res) => {
  const event = req.body;
  if (event?.type !== 'email.received') {
    return res.status(400).json({ error: 'unexpected event type' });
  }
  const { data } = event;
  const emailEntry = {
    email_id: data.email_id,
    from: data.from,
    to: data.to,
    subject: data.subject,
    created_at: data.created_at,
    message_id: data.message_id,
    attachments: (data.attachments || []).map(a => ({ id: a.id, filename: a.filename })),
    received_at: new Date().toISOString(),
  };
  logActivity('mobilemonero-inbound', data.email_id, 'RECEIVED', 
    `From: ${data.from} | Subject: ${data.subject || '(no subject)'}`);
  const inbox = state.get('resend_inbox_mm') || [];
  inbox.unshift(emailEntry);
  if (inbox.length > 50) inbox.length = 50;
  state.set('resend_inbox_mm', inbox);
  console.log(`[MobileMonero Inbound] Email from ${data.from}: "${data.subject || '(no subject)'}"`);
  res.json({ received: true, email_id: data.email_id });
});

// ── GET MobileMonero inbox ──────────────────────────────────
app.get('/resend/mobilemonero/inbox', (req, res) => {
  const inbox = state.get('resend_inbox_mm') || [];
  res.json({ count: inbox.length, emails: inbox });
});

// GET /resend/mobilemonero/inbox/brief — lightweight for dashboard
app.get('/resend/mobilemonero/inbox/brief', (req, res) => {
  const inbox = state.get('resend_inbox_mm') || [];
  const brief = inbox.slice(0, 30).map(function(e) {
    return { email_id: e.email_id, from: e.from, to: e.to, subject: e.subject, created_at: e.created_at, received_at: e.received_at };
  });
  res.json({ count: brief.length, emails: brief });
});

// ── PFP: List bookings (proxy to Supabase) ────────────────
app.get('/pfp/bookings', async (req, res) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return res.json({ status: 'error', message: 'Supabase not configured' });
    }
    const r = await fetch(`${supabaseUrl}/rest/v1/bookings?select=*&order=created_at.desc`, {
      headers: { 'Authorization': `Bearer ${supabaseKey}`, 'apikey': supabaseKey }
    });
    const data = await r.json();
    res.json({ count: data.length, bookings: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PFP: Booking stats ─────────────────────────────────────
app.get('/pfp/stats', async (req, res) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return res.json({ status: 'error', message: 'Supabase not configured' });
    }
    const r = await fetch(`${supabaseUrl}/rest/v1/bookings?select=*`, {
      headers: { 'Authorization': `Bearer ${supabaseKey}`, 'apikey': supabaseKey }
    });
    const data = await r.json();
    const total = data.length;
    const leads = data.filter(b => b.status === 'lead').length;
    const quoted = data.filter(b => b.status === 'quoted').length;
    const confirmed = data.filter(b => b.status === 'confirmed' || b.status === 'deposit_paid').length;
    const revenue = data.reduce((s, b) => s + (b.deposit_paid ? b.base_price : 0), 0);
    res.json({ total, leads, quoted, confirmed, revenue, bookings: data.slice(0, 5) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
      url: `/pfp/templates/${f}`,
      size: existsSync(join(PFP_OUTPUTS, f)) ? require('fs').statSync(join(PFP_OUTPUTS, f)).size : 0,
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

// ── Mesh Peer Connector Proxy ─────────────────────────
const MESH_PEER_URL = 'https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/mesh-peer-connector';
const RELAY_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

app.get('/api/mesh/peers', async (req, res) => {
  try {
    const r = await fetch(MESH_PEER_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RELAY_SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'discover' }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/api/mesh/register', async (req, res) => {
  try {
    const r = await fetch(MESH_PEER_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RELAY_SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'register', ...req.body }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ── Gossipsub Mesh Routes ────────────────────────────
app.use('/mesh', createMeshRouter(express));

// ── P2P Proxy (bridges to Python mesh on port 4002) ──
const P2P_MESH = 'http://127.0.0.1:4002';

app.post('/broadcast', async (req, res) => {
  try {
    const r = await fetch(`${P2P_MESH}/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(5000),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/peers', async (req, res) => {
  try {
    const r = await fetch(`${P2P_MESH}/peers`, { signal: AbortSignal.timeout(3000) });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/p2p/health', async (req, res) => {
  try {
    const r = await fetch(`${P2P_MESH}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/p2p/messages', async (req, res) => {
  try {
    const r = await fetch(`${P2P_MESH}/messages?limit=${req.query.limit || 50}`, { signal: AbortSignal.timeout(3000) });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║         MobileMonero Relay Server — Eliza-Dev v5        ║
╠══════════════════════════════════════════════════════╣
║  Webhook:  http://0.0.0.0:${String(PORT).padEnd(5)}/webhook/task     ║
║  Tools:    http://0.0.0.0:${String(PORT).padEnd(5)}/tools            ║
║  Run Tool: http://0.0.0.0:${String(PORT).padEnd(5)}/tools/run        ║
║  Web Srch: http://0.0.0.0:${String(PORT).padEnd(5)}/web-search       ║
║  Scrape:   http://0.0.0.0:${String(PORT).padEnd(5)}/scrape            ║
║  Ollama:   http://0.0.0.0:${String(PORT).padEnd(5)}/ollama/chat       ║
║  Monitor:  http://0.0.0.0:${String(PORT).padEnd(5)}/monitor           ║
║  State:    http://0.0.0.0:${String(PORT).padEnd(5)}/state/<key>       ║
║  Dispatch: http://0.0.0.0:${String(PORT).padEnd(5)}/dispatch          ║
║  Health:   http://0.0.0.0:${String(PORT).padEnd(5)}/health
║  PFP Inbox: http://0.0.0.0:${String(PORT).padEnd(5)}/resend/inbox
║  MM Inbox:  http://0.0.0.0:${String(PORT).padEnd(5)}/resend/mobilemonero/inbox            ║
╚══════════════════════════════════════════════════════╝

  Tools: ${Object.keys(toolHandlers).length} registered
  Handlers: ${Object.keys(handlers).length} task handlers
  State keys: ${state.keys().length}
  `);
  logActivity('system', '-', 'STARTUP', `Relay v2 listening on port ${PORT}`);

  // Auto-start Cloudflare tunnel as detached process
  const CLOUDFLARED_PATH = join(__dirname, '..', 'cloudflared.exe');
  const CONFIG_PATH = 'C:\\Users\\PureTrek\\.cloudflared\\config.yml';
  if (existsSync(CLOUDFLARED_PATH)) {
    const tunnel = spawn(CLOUDFLARED_PATH, ['tunnel', '--config', CONFIG_PATH, 'run'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    tunnel.unref();
    tunnel.stdout.on('data', (d) => {
      const line = d.toString();
      if (line.includes('Registered tunnel connection')) {
        console.log(`[Tunnel] ${line.trim()}`);
      }
    });
    tunnel.stderr.on('data', (d) => {
      const line = d.toString();
      if (line.includes('Registered tunnel connection') || line.includes('error') || line.includes('Error')) {
        console.log(`[Tunnel] ${line.trim()}`);
      }
    });
    tunnel.on('error', (err) => console.error('[Tunnel] Failed to start:', err.message));
    tunnel.on('exit', (code) => {
      if (code !== 0) console.error(`[Tunnel] Exited with code ${code}`);
    });
    console.log('[Tunnel] Auto-started cloudflared for relay.mobilemonero.com');
  }
});
