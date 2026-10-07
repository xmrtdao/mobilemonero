#!/usr/bin/env node
// SUPERSEDED 2026-10-07 - do not run this file.
//
// The live supervisor is ../supervisor.mjs (repo root), started with
// "node supervisor.mjs --serve", logging to ../logs/supervisor.log.
// This older copy last logged to ../relay-data/supervisor.log, which went
// silent on 2026-10-01 - that stale file was mistaken for the live log and
// sent an agent chasing a nonexistent outage. Kept only for history; its
// service list is NOT maintained.

/**
 * supervisor.mjs â€” Vex's top-level watchdog
 *
 * Single long-running process that:
 *   1. Keeps the relay (relay/server.js) alive
 *   2. Keeps the campaign-scheduler daemon alive
 *   3. Monitors Windows scheduled tasks for failures/missed-runs
 *   4. Sends Resend alerts on anomalies (debounced)
 *
 * Different from relay-watchdog.mjs:
 *   - relay-watchdog = "is the relay responding?" (5min poll, email alert)
 *   - supervisor     = "are the processes running?" (live restart loop)
 *
 * Install:
 *   node relay/supervisor.mjs --install     # registers Windows Task at logon
 *
 * Run:
 *   node relay/supervisor.mjs               # foreground (recommended for dev)
 *   node relay/supervisor.mjs --daemon      # background, no console output
 */

import { spawn, execSync, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, statSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

// â”€â”€ Text Sanitization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'relay-data');
const LOGS_DIR = join(DATA_DIR, 'logs');
const STATE_FILE = join(DATA_DIR, 'supervisor-state.json');
const LOG_FILE = join(ROOT, 'relay-data', 'supervisor.log');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(LOGS_DIR, { recursive: true });

// â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CHECK_INTERVAL_MS = 30_000;             // 30s health loop
const RELAY_STARTUP_GRACE_MS = 8_000;         // wait for relay to bind :8080
const CAMPAIGN_DAEMON_STARTUP_GRACE_MS = 3_000;
const PG_STARTUP_GRACE_MS    = 18_000;        // pg_ctl start can be slow
const LOCAL_SB_STARTUP_GRACE_MS = 6_000;      // deno cold start
const TUNNEL_STARTUP_GRACE_MS    = 12_000;    // cloudflared handshake
const VITE_STARTUP_GRACE_MS      = 45_000;    // Vite cold start (~38s: dep pre-bundling on heavy suite SPA)
const ALERT_COOLDOWN_MS = 30 * 60_000;        // 30min between repeat alerts
const TASK_CHECK_INTERVAL_MS = 15 * 60_000;   // check scheduled tasks every 15min
const TASK_MAX_AGE_MS = 24 * 60 * 60_000;     // alert if no run in 24h
const TASK_FAIL_CODES = new Set([1, 2, 3221225786, 3221225477, -1073741511]);

// Processes to supervise.
// `wrapperExits` = true means the launcher script exits 0 after detaching its
// real child. We track the *child's* process tree, not the launcher, via
// healthCheck â€” otherwise we'd restart-loop on a healthy stack.
const SERVICES = [
  {
    name: 'relay',
    cmd: 'node',
    args: ['relay/server.js'],
    cwd: ROOT,
    healthCheck: () => checkHttp('http://localhost:8080/health', 2000, true),
    startupGrace: RELAY_STARTUP_GRACE_MS,
    maxRestartsPerHour: 6,
  },
  {
    name: 'campaign-scheduler',
    cmd: 'node',
    args: ['relay/campaign-scheduler.mjs', '--daemon'],
    cwd: ROOT,
    healthCheck: () => checkProcessByScript('campaign-scheduler.mjs'),
    startupGrace: CAMPAIGN_DAEMON_STARTUP_GRACE_MS,
    maxRestartsPerHour: 4,
    paused: false, // Unpaused 2026-07-09: Resend Pro account active
  },
    {
    name: 'pg',
    cmd: 'node',
    args: ['relay/start-pg.mjs'],
    cwd: ROOT,
    healthCheck: () => checkProcessByName('postgres.exe'),
    startupGrace: PG_STARTUP_GRACE_MS,
    maxRestartsPerHour: 3,
    wrapperExits: true,
  },
  {
    name: 'local-sb',
    cmd: 'node',
    args: ['local-supabase/server.mjs'],
    cwd: ROOT,
    healthCheck: () => checkHttp('http://127.0.0.1:54321/health', 2000),
    startupGrace: LOCAL_SB_STARTUP_GRACE_MS,
    maxRestartsPerHour: 4,
  },
  {
    // The Vite dev server for the suite SPA, on :5173 with base '/suite/'.
    //
    // This used to be `relay/start-vite-detached.mjs suite`. That launcher is gone
    // from the tree, so the entry could never have started anything: on a
    // supervisor restart it would have spawned node with a missing script, seen it
    // exit, and then restart-looped on a service that was in fact healthy - because
    // the health check probes the port, not the launcher.
    //
    // That is the specific failure this shape invites: a health check that
    // answers for a process the supervisor cannot itself start. The dev server is
    // a long-lived foreground process, so it is spawned directly here and does not
    // need wrapperExits.
    name: 'vite',
    cmd: 'node',
    args: ['node_modules/vite/bin/vite.js', '--port', '5173', '--host', '127.0.0.1'],
    cwd: join(ROOT, 'suite'),
    healthCheck: () => checkHttp('http://127.0.0.1:5173/', 2000),
    startupGrace: VITE_STARTUP_GRACE_MS,
    maxRestartsPerHour: 3,
  },
  {
    // The relay can wedge behind synchronous work, and this is the one endpoint
    // that stays answerable when it does - which is what makes an external liveness
    // probe possible at all. Small, static, no dependencies on the relay.
    name: 'health-server',
    cmd: 'node',
    args: ['relay/health-server.mjs'],
    cwd: ROOT,
    healthCheck: () => checkHttp('http://127.0.0.1:8088/', 2000),
    startupGrace: 3_000,
    maxRestartsPerHour: 4,
  },
  {
    // The resume/PDF renderer behind Jobby's download link. Lives in its own
    // project directory, so cwd is that directory and the script path is relative
    // to it - the reason this cannot use the relay-relative form the others do.
    name: 'resume-server',
    cmd: 'py',
    args: ['resume_server.py', '--host', '127.0.0.1', '--port', '5175'],
    cwd: join(ROOT, 'jobby-mcjobberson'),
    healthCheck: () => checkHttp('http://127.0.0.1:5175/', 2000),
    startupGrace: 8_000,
    maxRestartsPerHour: 3,
    // The Windows `py` shim spawns the real python.exe as a child and exits, so a
    // clean exit here is the launcher detaching, not the service dying.
    wrapperExits: true,
  },
  {
    // The page-agent MCP hub. It lives outside this repository entirely
    // (Desktop\page-agent), so cwd is an absolute path and the supervisor is the
    // only thing in the tree that knows where it is.
    name: 'page-agent-mcp',
    cmd: 'node',
    args: ['relay-data/pa-mcp-launch.cjs'],
    cwd: ROOT,
    // A detached launcher, so the child is tracked through the health check
    // rather than the wrapper's exit code. The entry point is matched by name
    // because the hub binds no port to poll.
    healthCheck: () => checkProcessByScript('page-agent') || checkProcessByScript('packages/mcp'),
    startupGrace: 10_000,
    maxRestartsPerHour: 3,
    wrapperExits: true,
  },
  {
    name: 'tunnel',
    cmd: 'node',
    args: ['relay/start-tunnel-detached.mjs'],
    cwd: ROOT,
    healthCheck: () => checkProcessByName('cloudflared.exe') || checkProcessByName('cloudflared'),
    startupGrace: TUNNEL_STARTUP_GRACE_MS,
    maxRestartsPerHour: 3,
    wrapperExits: true,
  },
  // Removed: python-exec, miner, zero-claw.
  //
  // All three named entry points that are not in the tree (python-exec-service.mjs,
  // xmrig-service.mjs, start-vite-detached.mjs) and none of the three was running
  // either. They were keeping the count honest rather than describing anything:
  // the dashboard derives its service list from this array, so a service that can
  // never start still appeared as supervised.
  //
  // The ports they claimed (8070, 5174) answer nothing, so there was no live
  // process for their health checks to be answering on. Restored from git history
  // if any of them is ever wanted again.
  {
    name: 'alice',
    cmd: 'node',
    args: ['relay/alice.mjs', '--daemon'],
    cwd: ROOT,
    healthCheck: () => checkProcessByScript('alice.mjs'),
    startupGrace: 8_000,
    maxRestartsPerHour: 4,
  },
  {
    name: 'cron-engine-v2',
    cmd: 'node',
    args: ['relay/cron-engine-v2.mjs'],
    cwd: ROOT,
    healthCheck: () => checkProcessByScript('cron-engine-v2.mjs'),
    startupGrace: 4_000,
    maxRestartsPerHour: 4,
  },
  // â”€â”€ MCP Servers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    name: 'cuttlefishclaws-mcp',
    cmd: 'node',
    args: ['relay/cuttlefishclaws-mcp.mjs', '--http', '--port', '3120'],
    cwd: ROOT,
    healthCheck: () => checkHttp('http://127.0.0.1:3120/health', 2000),
    startupGrace: 5_000,
    maxRestartsPerHour: 4,
  },
  {
    // The suite MCP server.
    //
    // Two corrections to what was here. The name was 'suite-mcp' while every
    // consumer - supervisor-state.json, the dashboard tile, relay-data/suite-mcp-
    // launch.cjs - calls it 'xmrtdao-suite-mcp', so the on-disk name did not match
    // the running one. And the port was 3200 when the server actually listens on
    // 3121 (3120 belongs to cuttlefishclaws-mcp): 3200 answers nothing, so this
    // health check would have failed forever against a perfectly healthy server.
    name: 'xmrtdao-suite-mcp',
    cmd: 'node',
    args: ['relay/xmrtdao-suite-mcp.mjs', '--http', '--port', '3121'],
    cwd: ROOT,
    healthCheck: () => checkHttp('http://127.0.0.1:3121/health', 2000),
    startupGrace: 5_000,
    maxRestartsPerHour: 4,
  },
  {
    // DeepSeek Harness web UI (Builder's workspace + watchable harness on :3080).
    // Runs via the detached .cjs launcher which sets DEEPSEEK_BASE_URL/API_KEY in
    // the process env and writes the one-time auth-token URL to dsh/dsh-web-harness.log
    // (that's the file dsh-open reads to open an authenticated window). wrapperExits:
    // the launcher detaches the real node child, so health is a process check for
    // the running harness bin, not a bare-URL HTTP probe (the bare URL returns 401
    // auth-wall, which is the healthy state). Matches the vite/tunnel pattern.
    name: 'dsh',
    cmd: 'node',
    args: ['dsh/dsh-web-launch.cjs'],
    cwd: ROOT,
    healthCheck: () => checkProcessByScript('apps/cli/src/bin.ts --profile web'),
    wrapperExits: true,
    startupGrace: 30_000,
    maxRestartsPerHour: 3,
  },
];

// Windows tasks we expect to fire (must match TaskName exactly)
const WATCHED_TASKS = [
  { name: 'XMRT-DAO-DailyCampaign',      expectedMaxAgeMs: 26 * 60 * 60 * 1000 },  // daily
  { name: 'XMRT-DAO-NoonCampaign',       expectedMaxAgeMs: 26 * 60 * 60 * 1000 },
  { name: 'XMRT-DAO-4PMCampaign',        expectedMaxAgeMs: 26 * 60 * 60 * 1000 },
  { name: 'XMRT-DAO-SeasonalScraper',    expectedMaxAgeMs: 26 * 60 * 60 * 1000 },
  { name: 'Vex-Supervisor',              expectedMaxAgeMs: 7  * 24 * 60 * 60 * 1000 },  // logon, just monitor
];

// â”€â”€ Env / Resend â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function loadEnv() {
  const envPath = join(__dirname, '.env');
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const ENV = loadEnv();
const RESEND_KEY = ENV.RESEND_XMRT_API_KEY || ENV.RESEND_API_KEY;
const ALERT_EMAILS = ['xmrtsolutions@gmail.com', 'xmrtnet@gmail.com'];
// Disabled 2026-07-09: Resend 403 on mobilemonero.com domain verification.
// Supervisor still runs and restarts services â€” just no email alerts.
const ALERTS_DISABLED = true;

// â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function loadState() {
  const defaults = {
    services: {},        // name -> { childPid, startedAt, restartCount, restartTimestamps: [] }
    alerts: {},          // key -> last alert epoch ms
    lastTaskCheck: 0,
    lastTaskResults: {}, // taskName -> { lastRun, lastResult, numMissed }
  };
  try {
    if (existsSync(STATE_FILE)) {
      const loaded = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      // Merge missing keys so old state files from previous supervisor versions
      // don't crash code that expects new fields.
      return { ...defaults, ...loaded };
    }
  } catch {}
  return defaults;
}
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

const state = loadState();
for (const svc of SERVICES) {
  if (!state.services[svc.name]) {
    state.services[svc.name] = {
      childPid: null,
      startedAt: 0,
      restartTimestamps: [],
      alertKey: null,
    };
  }
}

// â”€â”€ Logging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const isDaemon = process.argv.includes('--daemon');
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${sanitizeText(msg)}`;
  try { writeFileSync(LOG_FILE, line + '\n', { flag: 'a' }); } catch {}
  if (!isDaemon) console.log(line);
}

// â”€â”€ Health checks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function checkHttp(url, timeoutMs, skipAuth = false) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET',
      timeout: timeoutMs,
      headers: {},
    };
    // Add API key for relay health check to bypass Cloudflare Access
    if (skipAuth) {
      options.headers['x-api-key'] = '0de4fe0de4c4723baeb812bb378f95e852a39379b117795da00095481ff14043';
    }
    const req = http.request(options, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function checkProcessByScript(scriptName) {
  try {
    const out = execFileSync('wmic',
      ['process', 'where', "name='node.exe'", 'get', 'processid,commandline', '/format:csv'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    return out.includes(scriptName) && out.includes(',');
  } catch {
    return false;
  }
}

function checkProcessByName(exeName) {
  try {
    const out = execFileSync('wmic',
      ['process', 'where', `name='${exeName}'`, 'get', 'processid', '/format:csv'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    return out.includes(',');
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    const out = execFileSync('wmic',
      ['process', 'where', `processid='${pid}'`, 'get', 'processid', '/format:csv'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true }
    );
    return out.includes(String(pid));
  } catch {
    return false;
  }
}

function pruneOldRestarts(svcState) {
  const cutoff = Date.now() - 60 * 60_000;
  svcState.restartTimestamps = (svcState.restartTimestamps || []).filter(t => t > cutoff);
}

function reconcileStalePids() {
  // Drop childPid entries that point at dead processes. The supervisor's health
  // check is HTTP/script-based, so a manually-spawned process on the right port
  // looks healthy even though we never started it. Forcing a null childPid lets
  // the supervisor startService() on the next outage.
  let touched = 0;
  for (const svc of SERVICES) {
    const svcState = state.services[svc.name];
    if (svcState.childPid && !pidAlive(svcState.childPid)) {
      log('INFO', `Reconciling ${svc.name}: stale childPid ${svcState.childPid} -> null`);
      svcState.childPid = null;
      touched++;
    }
  }
  if (touched > 0) saveState(state);
  return touched;
}

function pruneLegacyState() {
  // Remove services that no longer exist in the SERVICES array (e.g. db-manager,
  // runtime from older supervisor versions). These confuse --status output.
  const valid = new Set(SERVICES.map(s => s.name));
  const stale = Object.keys(state.services).filter(k => !valid.has(k));
  for (const k of stale) {
    log('INFO', `Pruning legacy service state: ${k}`);
    delete state.services[k];
  }
  if (stale.length > 0) saveState(state);
}

// â”€â”€ Duplicate Runtime Detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Scans for duplicate instances of known service scripts and kills extras.
// Keeps the instance with the lowest PID (oldest process).
// Runs on pre-flight and periodically in the health loop.
const KNOWN_SCRIPTS = [
  'server.js',           // relay
  'supervisor.mjs',      // supervisor itself
  'alice.mjs',           // Alice daemon
  'campaign-scheduler.mjs',
  'cron-engine-v2.mjs',
  'cuttlefishclaws-mcp.mjs',
  'cuttlefish-mcp.mjs',
  'xmrtdao-suite-mcp.mjs',
  'start-pg.mjs',
  'start-tunnel-detached.mjs',
  'start-vite-detached.mjs',
];

function deduplicateRuntimes() {
  let totalKilled = 0;
  for (const script of KNOWN_SCRIPTS) {
    try {
      const out = execFileSync('wmic',
        ['process', 'where', "name='node.exe'", 'get', 'processid,commandline', '/format:csv'],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      // Find all PIDs running this script
      const lines = out.split('\n').filter(l => l.includes(script));
      if (lines.length <= 1) continue; // 0 or 1 instance â€” fine

      // Parse PIDs: format is "Node,PID,node relay/server.js" or similar
      const pids = [];
      for (const line of lines) {
        const parts = line.trim().split(',');
        // WMIC CSV: ComputerName,CommandLine,ProcessId (alphabetical order)
        // PID is the third field (index 2)
        const pid = parseInt(parts[2], 10);
        if (Number.isFinite(pid)) pids.push(pid);
      }
      if (pids.length <= 1) continue;

      // Keep the highest PID (newest process), kill the rest
      pids.sort((a, b) => b - a);
      const keepPid = pids[0];
      const killPids = pids.slice(1).filter(pid => pid !== process.pid); // never kill ourselves

      if (killPids.length === 0) continue; // only ourselves running

      for (const pid of killPids) {
        try {
          execSync(`taskkill /F /PID ${pid} 2>nul`, { stdio: 'ignore', timeout: 3000 });
          log('INFO', `Dedup: killed duplicate ${script} (PID ${pid}), kept PID ${keepPid}`);
          totalKilled++;
        } catch {
          log('WARN', `Dedup: failed to kill duplicate ${script} (PID ${pid})`);
        }
      }
    } catch {
      // WMIC failure â€” skip this script
    }
  }
  if (totalKilled > 0) {
    log('INFO', `Dedup: killed ${totalKilled} duplicate process(es)`);
  }
  return totalKilled;
}

function startService(svc) {
  const svcState = state.services[svc.name];
  pruneOldRestarts(svcState);

  // Rate-limit restarts
  if (svcState.restartTimestamps.length >= svc.maxRestartsPerHour) {
    const age = Math.round((Date.now() - svcState.restartTimestamps[0]) / 60_000);
    log('WARN', `${svc.name}: hit ${svc.maxRestartsPerHour} restarts/hr, cooling off (oldest was ${age}m ago)`);
    sendAlert(
      `supervisor: ${svc.name} flapping`,
      `${svc.name} has restarted ${svcState.restartTimestamps.length} times in the last hour. Auto-restart paused. Manual intervention required.`
    );
    return;
  }

  log('INFO', `Starting ${svc.name}: ${svc.cmd} ${svc.args.join(' ')}`);
  try {
    // Set up log rotation for this service
    const logBase = join(LOGS_DIR, svc.name);
    const logPath = `${logBase}.log`;
    
    // Rotate if > 10MB
    try {
      const stats = statSync(logPath);
      if (stats.size > 10 * 1024 * 1024) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        renameSync(logPath, `${logBase}-${timestamp}.log`);
      }
    } catch {}
    
    const logStream = createWriteStream(logPath, { flags: 'a' });
    const child = spawn(svc.cmd, svc.args, {
      cwd: svc.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...ENV },
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    child.unref();
    child.on('exit', (code, signal) => {
      // For wrapperExits services, a clean exit (code=0) just means the launcher
      // detached its real child. The health check will catch a real outage.
      if (svc.wrapperExits && code === 0) {
        log('INFO', `${svc.name} wrapper detached (real child tracked via health check)`);
        // Don't nullify childPid for wrappers â€” the health check handles it
        return;
      }
      const reason = code !== null ? `exit_code_${code}` : `signal_${signal}`;
      log('WARN', `${svc.name} exited (code=${code} signal=${signal})`);
      svcState.childPid = null;
      svcState.restartReason = reason;
      saveState(state);
    });
    svcState.childPid = child.pid;
    svcState.startedAt = Date.now();
    svcState.restartTimestamps.push(Date.now());
    saveState(state);
    log('INFO', `${svc.name} started with PID ${child.pid}, logging to ${logPath}`);
  } catch (e) {
    log('ERROR', `Failed to start ${svc.name}: ${e.message}`);
  }
}

let _dedupDone = false;

async function superviseLoop() {
  // Deduplicate runtimes only once on the first cycle, not every 30s
  if (!_dedupDone) {
    deduplicateRuntimes();
    _dedupDone = true;
  }

  // â”€â”€ Process agent-queued service actions â”€â”€
  // The relay's `service_control` tool writes actions here; supervisor executes them.
  try {
    const { readFileSync, writeFileSync } = await import('fs');
    const { join } = await import('path');
    const queueFile = join(DATA_DIR, 'service-actions.json');
    if (existsSync(queueFile)) {
      const queue = JSON.parse(readFileSync(queueFile, 'utf8'));
      if (Array.isArray(queue) && queue.length > 0) {
        const pending = queue.filter(a => !a.processedAt);
        for (const action of pending) {
          const svc = SERVICES.find(s => s.name === action.service);
          if (!svc) {
            log('WARN', `service_control: unknown service "${action.service}"`);
            action.processedAt = Date.now();
            action.result = 'unknown_service';
            continue;
          }
          if (svc.paused) {
            log('WARN', `service_control: service "${action.service}" is paused (manual-only)`);
            action.processedAt = Date.now();
            action.result = 'paused';
            continue;
          }
          const svcState = state.services[svc.name];
          if (action.action === 'restart') {
            log('INFO', `service_control: restarting ${svc.name} (requested by ${action.requestedBy || 'unknown'})`);
            if (svcState.childPid) {
              try { execSync(`taskkill /F /PID ${svcState.childPid} 2>nul`, { stdio: 'ignore' }); } catch {}
            }
            startService(svc);
            action.processedAt = Date.now();
            action.result = 'restarted';
          } else if (action.action === 'start') {
            const healthy = await svc.healthCheck();
            if (!healthy) {
              log('INFO', `service_control: starting ${svc.name} (requested by ${action.requestedBy || 'unknown'})`);
              startService(svc);
              action.processedAt = Date.now();
              action.result = 'started';
            } else {
              log('INFO', `service_control: ${svc.name} already healthy, skipping start`);
              action.processedAt = Date.now();
              action.result = 'already_healthy';
            }
          } else if (action.action === 'stop') {
            log('INFO', `service_control: stopping ${svc.name} (requested by ${action.requestedBy || 'unknown'})`);
            if (svcState.childPid) {
              try { execSync(`taskkill /F /PID ${svcState.childPid} 2>nul`, { stdio: 'ignore' }); } catch {}
            }
            svcState.childPid = null;
            action.processedAt = Date.now();
            action.result = 'stopped';
          } else if (action.action === 'status') {
            // status is handled inline by the relay tool, not queued
            action.processedAt = Date.now();
            action.result = 'status_inline';
          }
        }
        // Save back with processed markers
        writeFileSync(queueFile, JSON.stringify(queue, null, 2));
      }
    }
  } catch (e) {
    log('WARN', `service_control queue processing error: ${e.message}`);
  }

  for (const svc of SERVICES) {
    // Skip paused services
    if (svc.paused) continue;

    const svcState = state.services[svc.name];
    const healthy = await svc.healthCheck();

    if (!healthy) {
      const wasRunning = svcState.childPid;
      if (wasRunning) {
        log('WARN', `${svc.name} health check failed (pid ${wasRunning}). Restarting.`);
        svcState.restartReason = 'health_check_failed';
        // Best-effort kill (don't await; we don't want to block on dead process)
        try { execSync(`taskkill /F /PID ${wasRunning} 2>nul`, { stdio: 'ignore' }); } catch {}
      } else {
        // For wrappers, childPid=null is the normal post-detach state.
        // But if the health check fails, we still need to restart.
        log('WARN', `${svc.name} health check failed (no tracked pid). Restarting.`);
        svcState.restartReason = 'health_check_failed_no_pid';
      }
      // Debounce: if we already alerted in last 30min, skip email
      const alertKey = `${svc.name}-down`;
      if (Date.now() - (state.alerts[alertKey] || 0) > ALERT_COOLDOWN_MS) {
        sendAlert(`[Vex] ${svc.name} restarted`, `${svc.name} was down. supervisor.mjs is restarting it now.`);
        state.alerts[alertKey] = Date.now();
        saveState(state);
      }
      setTimeout(() => startService(svc), svc.startupGrace);
    } else {
      // Healthy: clear down-alert cooldown
      state.alerts[`${svc.name}-down`] = 0;
    }
  }
}

// â”€â”€ Scheduled task monitor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Cache the per-task PS scripts to avoid disk churn on every check.
const TASK_SCRIPT_DIR = join(DATA_DIR, 'task-scripts');
mkdirSync(TASK_SCRIPT_DIR, { recursive: true });

function getTaskScriptPath(taskName) {
  // Sanitize task name for filesystem; Windows allows most chars in filenames
  // but not <>:"/\|?* â€” and task names use '-' and '_' which are fine.
  const safe = taskName.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(TASK_SCRIPT_DIR, `${safe}.ps1`);
}

function checkScheduledTasks() {
  for (const t of WATCHED_TASKS) {
    try {
      const scriptPath = getTaskScriptPath(t.name);
      const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$info = Get-ScheduledTaskInfo -TaskName '${t.name}'
if ($info) {
  $task = Get-ScheduledTask -TaskName '${t.name}'
  $obj = @{
    lastRun  = $info.LastRunTime.ToString('o')
    nextRun  = if ($info.NextRunTime.Year -gt 1900) { $info.NextRunTime.ToString('o') } else { '' }
    result   = [int]$info.LastTaskResult
    missed   = [int]$info.NumberOfMissedRuns
    state    = [string]$task.State
  }
  $obj | ConvertTo-Json -Compress
}`;
      // Write the script to a file and invoke with -File. This sidesteps
      // cmd.exe â†” PowerShell quoting issues that broke the -Command version.
      writeFileSync(scriptPath, ps, 'utf8');
      const raw = execSync(
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { encoding: 'utf8', timeout: 10_000, windowsHide: true }
      ).trim();
      if (!raw) continue;
      const data = JSON.parse(raw);
      const lastRunEpoch = Date.parse(data.lastRun);
      const ageMs = Date.now() - lastRunEpoch;
      const lastResult = Number(data.result);
      const prev = state.lastTaskResults[t.name] || {};

      // Alert conditions
      const issues = [];
      if (ageMs > t.expectedMaxAgeMs) issues.push(`last run ${Math.round(ageMs/3600000)}h ago (max ${Math.round(t.expectedMaxAgeMs/3600000)}h)`);
      if (data.missed > 0) issues.push(`${data.missed} missed run(s)`);
      if (TASK_FAIL_CODES.has(lastResult)) issues.push(`last exit code ${lastResult} (${lastResult === 3221225786 ? 'CTRL+C/terminated' : 'nonzero'})`);

      if (issues.length > 0) {
        const alertKey = `task-${t.name}`;
        if (Date.now() - (state.alerts[alertKey] || 0) > ALERT_COOLDOWN_MS) {
          sendAlert(
            `[Vex] Task issue: ${t.name}`,
            `Issues detected:\n  - ${issues.join('\n  - ')}\n\nLast run: ${data.lastRun}\nLast result: ${lastResult}\nState: ${data.state}\n\nInvestigate: Task Scheduler -> ${t.name}`
          );
          state.alerts[alertKey] = Date.now();
        }
      }

      state.lastTaskResults[t.name] = {
        lastRun: lastRunEpoch,
        result: lastResult,
        missed: data.missed,
        state: data.state,
        checkedAt: Date.now(),
      };
    } catch (e) {
      log('WARN', `Task check failed for ${t.name}: ${e.message.slice(0, 120)}`);
    }
  }
  state.lastTaskCheck = Date.now();
  saveState(state);
}

// â”€â”€ Resend alert â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendAlert(subject, body) {
  if (ALERTS_DISABLED) {
    log('INFO', `[Alert suppressed] ${subject}: ${body.slice(0, 80)}`);
    return;
  }
  if (!RESEND_KEY) {
    log('WARN', `No RESEND_API_KEY; would have sent: ${subject}`);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Vex Supervisor <vex@mobilemonero.com>',
        to: ALERT_EMAILS,
        subject,
        text: body,
      }),
    });
    if (res.ok) log('INFO', `Alert sent: ${subject}`);
    else log('WARN', `Alert failed (${res.status}): ${(await res.text()).slice(0,200)}`);
  } catch (e) {
    log('ERROR', `Alert error: ${e.message}`);
  }
}

// â”€â”€ Install as Windows Task â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function installTask() {
  const scriptPath = join(__dirname, 'supervisor.mjs').replace(/\\/g, '\\\\');
  const nodePath = process.execPath.replace(/\\/g, '\\\\');
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>${new Date().toISOString()}</Date>
    <Author>Vex</Author>
    <Description>Vex Supervisor â€” keeps relay + campaign scheduler alive, monitors scheduled tasks</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>Interactive</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"${nodePath}"</Command>
      <Arguments>"${scriptPath}" --daemon</Arguments>
      <WorkingDirectory>${ROOT.replace(/\\/g, '\\\\')}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;

  const xmlPath = join(DATA_DIR, 'supervisor-task.xml');
  writeFileSync(xmlPath, Buffer.from(xml, 'utf16le'));
  log('INFO', `Task XML written to ${xmlPath}`);
  log('INFO', 'Install with:');
  log('INFO', `  schtasks /create /tn "Vex-Supervisor" /xml "${xmlPath}" /f`);
}

// â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
  log('INFO', `Vex supervisor starting (pid ${process.pid}, daemon=${isDaemon})`);

  if (process.argv.includes('--install')) {
    await installTask();
    return;
  }

  if (process.argv.includes('--status')) {
    console.log('=== Vex Supervisor Status ===');
    for (const svc of SERVICES) {
      const s = state.services[svc.name];
      const healthy = await svc.healthCheck();
      console.log(`  ${svc.name}: ${healthy ? '[OK] healthy' : '[!!] DOWN'}  pid=${s.childPid}  restarts/hr=${s.restartTimestamps.length}`);
    }
    console.log('--- Tasks ---');
    checkScheduledTasks();
    for (const t of WATCHED_TASKS) {
      const r = state.lastTaskResults[t.name];
      if (r && Number.isFinite(r.lastRun)) {
        const ageMin = Math.round((Date.now() - r.lastRun) / 60000);
        console.log(`  ${t.name}: lastRun=${ageMin}m ago  result=${r.result}  missed=${r.missed}  state=${r.state}`);
      } else {
        console.log(`  ${t.name}: [not installed on this machine]`);
      }
    }
    return;
  }

  // Pre-flight: deduplicate runtimes, then start everything
  deduplicateRuntimes();
  pruneLegacyState();
  const reconciled = reconcileStalePids();
  if (reconciled > 0) log('INFO', `Reconciled ${reconciled} stale childPid entries`);

  for (const svc of SERVICES) {
    const healthy = await svc.healthCheck();
    if (!healthy) {
      log('WARN', `Pre-flight: ${svc.name} not running. Starting.`);
      startService(svc);
      await new Promise(r => setTimeout(r, svc.startupGrace));
    } else {
      log('INFO', `Pre-flight: ${svc.name} healthy`);
    }
  }

  // Health loop
  setInterval(superviseLoop, CHECK_INTERVAL_MS);
  // Task monitor
  setInterval(checkScheduledTasks, TASK_CHECK_INTERVAL_MS);
  checkScheduledTasks(); // run once on startup

  // Graceful shutdown
  process.on('SIGINT',  () => { log('INFO', 'SIGINT, exiting'); process.exit(0); });
  process.on('SIGTERM', () => { log('INFO', 'SIGTERM, exiting'); process.exit(0); });

  log('INFO', `Supervisor running. Health checks every ${CHECK_INTERVAL_MS/1000}s. Task checks every ${TASK_CHECK_INTERVAL_MS/60000}min.`);
}

main().catch(err => {
  log('ERROR', `Fatal: ${err.message}\n${err.stack}`);
  process.exit(1);
});
