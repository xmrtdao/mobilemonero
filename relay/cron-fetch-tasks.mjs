#!/usr/bin/env node
/**
 * relay/cron-fetch-tasks.mjs
 * Hourly cron job — fetches pending tasks from Eliza-Cloud via Supabase
 * and routes them to the relay for processing.
 *
 * Usage:
 *   node cron-fetch-tasks.mjs              # One-shot fetch
 *   node cron-fetch-tasks.mjs --daemon     # Run as daemon with 60min interval
 *   node cron-fetch-tasks.mjs --once       # One-shot (default)
 *
 * Designed to be called by system cron / Task Scheduler every hour.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const RELAY_URL = `http://localhost:${process.env.RELAY_PORT || 8080}`;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'xmrtdao/mobilemonero';
const DATA_DIR = join(__dirname, '..', '..', 'relay-data');
const STATE_FILE = join(DATA_DIR, 'cron-state.json');

mkdirSync(DATA_DIR, { recursive: true });

// ── State persistence ───────────────────────────────────────
function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error(`[cron] Error loading state: ${e.message}`);
  }
  return { lastRun: null, lastTaskId: null, totalFetched: 0, totalProcessed: 0, totalErrors: 0, errors: [] };
}

function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`[cron] Error saving state: ${e.message}`);
  }
}

// ── Fetch pending tasks from Supabase ──────────────────────
async function fetchPendingTasks() {
  if (!SUPABASE_KEY) {
    console.error('[cron] No SUPABASE_SERVICE_ROLE_KEY set');
    return [];
  }

  try {
    // Fetch tasks that are PENDING or IN_PROGRESS, ordered by priority
    const url = `${SUPABASE_URL}/rest/v1/tasks?status=in.(PENDING,IN_PROGRESS)&order=priority.desc&limit=10`;
    
    console.log(`[cron] Fetching pending tasks from Supabase...`);
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const tasks = await res.json();
    console.log(`[cron] Found ${tasks.length} pending tasks`);
    return tasks;
  } catch (err) {
    console.error(`[cron] Failed to fetch tasks: ${err.message}`);
    
    // Fallback: try the agent-manager edge function
    try {
      console.log('[cron] Trying agent-manager edge function fallback...');
      const res = await fetch(`${SUPABASE_URL}/functions/v1/agent-manager`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'list_tasks', status: 'pending' }),
      });
      if (res.ok) {
        const data = await res.json();
        return data.tasks || data.data || [];
      }
    } catch (e2) {
      console.error(`[cron] Fallback also failed: ${e2.message}`);
    }
    
    return [];
  }
}

// ── Check GitHub for new issues/commands ────────────────────
async function fetchGitHubTasks() {
  if (!GITHUB_TOKEN) {
    console.log('[cron] No GITHUB_TOKEN, skipping GitHub check');
    return [];
  }

  try {
    // Check for open issues or issue comments that might be task requests
    const url = `https://api.github.com/repos/${GITHUB_REPO}/issues?state=open&sort=updated&direction=desc&per_page=5`;
    
    const res = await fetch(url, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'xmrtdao-cron',
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const issues = await res.json();
    const tasks = [];
    
    for (const issue of issues) {
      // Check if issue body contains a task request pattern
      const body = (issue.body || '').toLowerCase();
      const title = (issue.title || '').toLowerCase();
      
      if (
        title.includes('task:') || title.includes('todo:') || 
        title.includes('dispatch:') || title.includes('eliza-dev:') ||
        body.includes('@eliza-dev') || body.includes('task for eliza')
      ) {
        tasks.push({
          id: `github-${issue.number}`,
          title: issue.title,
          source: 'github',
          issueNumber: issue.number,
          body: issue.body,
          priority: issue.labels?.some(l => l.name === 'urgent') ? 10 : 5,
          assignee: 'eliza-dev',
          metadata: {
            handler: guessHandler(issue.title, issue.body),
            github_url: issue.html_url,
          },
        });
      }
    }
    
    if (tasks.length > 0) {
      console.log(`[cron] Found ${tasks.length} GitHub task(s)`);
    }
    return tasks;
  } catch (err) {
    console.error(`[cron] GitHub check failed: ${err.message}`);
    return [];
  }
}

// ── Guess handler from title/body ────────────────────────────
function guessHandler(title, body = '') {
  const text = ((title || '') + ' ' + (body || '')).toLowerCase();
  if (text.includes('smtp') || text.includes('email')) return 'email-smtp-fix';
  if (text.includes('alice') || text.includes('sidecar') || text.includes('screenshot') || text.includes('desktop')) return 'alice';
  if (text.includes('knowledge') || text.includes('kb') || text.includes('sync')) return 'knowledge-sync';
  if (text.includes('device') || text.includes('register')) return 'device-registration';
  if (text.includes('mining') || text.includes('hash') || text.includes('pool') || text.includes('dashboard')) return 'mining-dashboard';
  if (text.includes('search') || text.includes('web') || text.includes('find')) return 'web-search';
  if (text.includes('monitor') || text.includes('health') || text.includes('status')) return 'system-monitor';
  return 'default';
}

// ── Dispatch task to relay ──────────────────────────────────
async function dispatchToRelay(task) {
  try {
    const res = await fetch(`${RELAY_URL}/webhook/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task),
      signal: AbortSignal.timeout(15000),
    });
    
    if (res.ok) {
      const result = await res.json();
      console.log(`[cron] Dispatched task "${task.title}" → ${result.handler || 'unknown'} (${result.success ? 'OK' : 'FAIL'})`);
      return true;
    }
    
    console.error(`[cron] Relay returned HTTP ${res.status} for task "${task.title}"`);
    return false;
  } catch (err) {
    // If relay isn't running, log and continue
    if (err.message.includes('fetch failed') || err.name === 'AbortError') {
      console.log(`[cron] Relay not reachable (${err.message}) — saving task for later`);
      return false;
    }
    console.error(`[cron] Failed to dispatch task "${task.title}": ${err.message}`);
    return false;
  }
}

// ── Process all fetched tasks ──────────────────────────────
async function processTasks(tasks) {
  let processed = 0;
  let errors = 0;

  for (const task of tasks) {
    try {
      const dispatched = await dispatchToRelay(task);
      if (dispatched) {
        processed++;
      } else {
        errors++;
      }
    } catch (e) {
      console.error(`[cron] Task processing error: ${e.message}`);
      errors++;
    }
  }

  return { processed, errors };
}

// ── Send heartbeat to Eliza-Cloud ──────────────────────────
async function sendHeartbeat(stats) {
  if (!SUPABASE_KEY) return;

  const message = `[CRON Heartbeat] Hourly check complete. ${stats.tasksFetched} tasks fetched, ${stats.processed} processed, ${stats.errors} errors. Relay ${stats.relayOk ? 'online' : 'offline'}.`;
  
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/eliza-relay`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'send',
        message,
        relay_tag: `cron-hourly-${Date.now().toString(36)}`,
        agent_name: 'Eliza-Dev-Cron',
      }),
    });
    
    if (res.ok) {
      const data = await res.json();
      if (data.reply) {
        console.log(`[cron] Eliza-Cloud replied: ${data.reply.slice(0, 200)}`);
      }
    }
  } catch (err) {
    console.error(`[cron] Heartbeat failed: ${err.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const isDaemon = args.includes('--daemon');
  const isOnce = args.includes('--once') || !isDaemon;

  console.log(`╔══════════════════════════════════════╗`);
  console.log(`║   XMRT DAO Hourly Task Fetcher      ║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Mode: ${isDaemon ? 'Daemon (60min interval)' : 'One-shot'}`);
  console.log('');

  const state = loadState();

  async function runCycle() {
    const cycleStart = Date.now();
    console.log(`\n── Cycle at ${new Date().toISOString()} ──`);

    // 1. Check if relay is alive
    let relayOk = false;
    try {
      const healthRes = await fetch(`${RELAY_URL}/health`, { signal: AbortSignal.timeout(5000) });
      relayOk = healthRes.ok;
      if (relayOk) {
        const health = await healthRes.json();
        console.log(`[cron] Relay OK (uptime: ${Math.round(health.uptime)}s, tools: ${health.tools || '?'})`);
      }
    } catch {
      console.log('[cron] Relay not running — tasks will be queued');
    }

    // 2. Fetch tasks from Supabase
    const supabaseTasks = await fetchPendingTasks();

    // 3. Fetch tasks from GitHub
    const githubTasks = await fetchGitHubTasks();

    // 4. Combine and deduplicate
    const allTasks = [...supabaseTasks, ...githubTasks];
    const seen = new Set();
    const uniqueTasks = allTasks.filter(t => {
      const id = t.id || t.title;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    console.log(`[cron] Total unique tasks: ${uniqueTasks.length}`);

    // 5. Process them
    const { processed, errors } = await processTasks(uniqueTasks);

    // 6. Update state
    state.lastRun = cycleStart;
    state.totalFetched += uniqueTasks.length;
    state.totalProcessed += processed;
    state.totalErrors += errors;
    if (errors > 0) {
      state.errors.push({ at: new Date().toISOString(), count: errors });
      if (state.errors.length > 50) state.errors.shift();
    }
    saveState(state);

    // 7. Send heartbeat
    const stats = {
      tasksFetched: uniqueTasks.length,
      processed,
      errors,
      relayOk,
      fromSupabase: supabaseTasks.length,
      fromGitHub: githubTasks.length,
    };
    
    if (uniqueTasks.length > 0 || !relayOk) {
      await sendHeartbeat(stats);
    }

    const duration = Date.now() - cycleStart;
    console.log(`[cron] Cycle complete in ${duration}ms`);
    console.log(`[cron] Stats: ${uniqueTasks.length} fetched, ${processed} dispatched, ${errors} errors`);
    console.log(`[cron] Cumulative: ${state.totalFetched} fetched, ${state.totalProcessed} processed, ${state.totalErrors} errors`);
  }

  // Run once
  await runCycle();

  // If daemon mode, continue every 60 minutes
  if (isDaemon) {
    console.log('\n[cron] Entering daemon mode — next check in 60 minutes');
    setInterval(runCycle, 60 * 60 * 1000);
  }
}

main().catch(err => {
  console.error(`[cron] Fatal error: ${err.message}`);
  process.exit(1);
});
