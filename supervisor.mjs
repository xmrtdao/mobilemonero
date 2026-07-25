#!/usr/bin/env node
/**
 * supervisor.mjs — Proper Windows daemon for XMRT DAO local stack
 *
 * Manages all services with health checks, auto-restart, and flapping
 * detection. Writes to relay-data/supervisor-state.json so the relay's
 * /api/supervisor/status endpoint reflects real state.
 *
 * Usage:
 *   node supervisor.mjs --serve     # Run the daemon (foreground)
 *   node supervisor.mjs --daemon    # Self-detach as background daemon
 *   node supervisor.mjs --once      # Single health-check tick (for Task Scheduler)
 *   node supervisor.mjs --status    # Print status and exit
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import http from 'node:http';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DATA_DIR = join(ROOT, 'relay-data');
const LOG_DIR = join(ROOT, 'logs');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

const PID_FILE = join(DATA_DIR, 'supervisor.pid');
const STATE_FILE = join(DATA_DIR, 'supervisor-state.json');
const LOG_FILE = join(LOG_DIR, 'supervisor.log');

// ── Logging ──────────────────────────────────────────────────────────
function log(line) {
  const stamp = new Date().toISOString();
  const full = `${stamp} [supervisor] ${line}`;
  console.log(full);
  try { appendFileSync(LOG_FILE, full + '\n'); } catch {}
}

// ── Service definitions ──────────────────────────────────────────────
const SERVICE_DEFS = [
  {
    name: 'relay',
    cmd: 'node',
    args: ['--max-old-space-size=512', 'relay/server.js'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:8080/health',
    healthCheck: (body) => body && body.status === 'ok',
    startupGraceMs: 8000,
    dependsOn: ['pg', 'local-sb'],
  },
  {
    name: 'campaign-scheduler',
    cmd: 'node',
    args: ['relay/campaign-scheduler.mjs', '--daemon'],
    cwd: ROOT,
    healthUrl: null,
    healthCheck: null,
    startupGraceMs: 5000,
    dependsOn: ['pg'],
  },
  {
    name: '31harbor-scheduler',
    cmd: 'node',
    args: ['relay/tools/31harbor-scheduler.mjs', '--daemon'],
    cwd: ROOT,
    healthUrl: null,
    healthCheck: null,
    startupGraceMs: 5000,
    dependsOn: ['pg'],
  },
  {
    name: 'cuttlefishclaws-mcp',
    cmd: 'node',
    args: ['relay/cuttlefishclaws-mcp.mjs', '--http', '--port', '3120'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:3120/health',
    healthCheck: () => true,
    startupGraceMs: 10000,
    dependsOn: ['pg'],
  },
  {
    name: 'xmrtdao-suite-mcp',
    cmd: 'node',
    args: ['relay/xmrtdao-suite-mcp.mjs', '--http', '--port', '3121'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:3121/health',
    healthCheck: () => true,
    startupGraceMs: 10000,
    dependsOn: ['pg'],
  },
  {
    name: 'cuttlefish-mcp',
    cmd: 'node',
    args: ['relay/cuttlefish-mcp.mjs', '--http', '--port', '3122'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:3122/health',
    healthCheck: () => true,
    startupGraceMs: 10000,
    dependsOn: ['pg'],
  },
  {
    name: 'pg',
    // Pure Node launcher (relay/start-pg.mjs) — replaces the old
    // start-pg-hidden.vbs wrapper. windowsHide: true suppresses the
    // checkpointer / bgwriter / wal_writer child console windows.
    cmd: process.execPath,
    args: ['relay/start-pg.mjs'],
    cwd: ROOT,
    healthUrl: null,
    healthCheck: null,
    tcpPort: 5432,          // TCP port for health checking
    startupGraceMs: 12000,
    dependsOn: [],
  },
  {
    name: 'local-sb',
    cmd: 'node',
    args: ['local-supabase/server.mjs'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:54321/health',
    healthCheck: (body) => typeof body === 'object',
    startupGraceMs: 10000,
    dependsOn: ['pg'],
  },
  {
    name: 'vite',
    cmd: 'node',
    // .bin/vite is a #!/bin/sh script on Windows — node cannot run it.
    // Point node directly at vite's JS entry point instead.
    args: ['node_modules/vite/bin/vite.js', '--port', '5173', '--host', '127.0.0.1'],
    cwd: join(ROOT, 'suite'),
    healthUrl: 'http://127.0.0.1:5173/',
    healthCheck: () => true,  // any HTTP response = alive
    startupGraceMs: 10000,
    dependsOn: [],
  },
  {
    name: 'tunnel',
    cmd: join(ROOT, 'cloudflared.exe'),
    args: ['tunnel', '--config', join(homedir(), '.cloudflared', 'config.yml'), 'run'],
    cwd: ROOT,
    healthUrl: null,  // check via process existence
    healthCheck: null,
    startupGraceMs: 15000,
    dependsOn: ['relay'],
  },
  {
    name: 'alice',
    cmd: 'node',
    args: ['relay/alice.mjs', '--daemon'],
    cwd: ROOT,
    healthUrl: null,  // check via process existence
    healthCheck: null,
    startupGraceMs: 8000,
    dependsOn: ['relay'],
  },
  {
    name: 'cron-engine-v2',
    cmd: 'node',
    args: ['relay/cron-engine-v2.mjs', '--daemon'],
    cwd: ROOT,
    healthUrl: null,  // check via process existence
    healthCheck: null,
    startupGraceMs: 5000,
    dependsOn: ['relay'],
  },
];

const START_ORDER = ['pg', 'local-sb', 'vite', 'relay', 'cuttlefishclaws-mcp', 'xmrtdao-suite-mcp', 'cuttlefish-mcp', 'tunnel', 'alice', 'cron-engine-v2', 'campaign-scheduler', '31harbor-scheduler'];

// ── State ────────────────────────────────────────────────────────────
const state = {};
let shuttingDown = false;

function getStateFilePath() { return STATE_FILE; }

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        return {
          services: raw.services || {},
          alerts: raw.alerts || {},
          lastTaskCheck: raw.lastTaskCheck || 0,
          lastTaskResults: raw.lastTaskResults || {},
          _pid: raw._pid,
          _updatedAt: raw._updatedAt,
        };
      }
    }
  } catch {}
  return { services: {}, alerts: {}, lastTaskCheck: 0, lastTaskResults: {} };
}

function saveState() {
  const out = loadState();
  const now = Date.now();
  for (const [name, s] of Object.entries(state)) {
    if (!out.services[name]) out.services[name] = {};
    out.services[name].childPid = s.child?.pid || null;
    out.services[name].startedAt = s.startedAt || out.services[name].startedAt || now;
    if (s.healthy !== undefined) out.services[name].healthy = s.healthy;
    if (s.failures !== undefined) out.services[name].failures = s.failures;
    if (s.isExternal) out.services[name].isExternal = true;
  }
  out._pid = process.pid;
  out._updatedAt = now;
  try { writeFileSync(STATE_FILE, JSON.stringify(out, null, 2)); } catch (e) { log(`saveState error: ${e.message}`); }
}

function writePid() {
  try { writeFileSync(PID_FILE, String(process.pid)); } catch {}
}

// ── Process helpers ──────────────────────────────────────────────────
function isProcessRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function findProcessByName(name) {
  // On Windows, use tasklist /NH /FO CSV to find processes by name
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /NH /FO CSV /FI "IMAGENAME eq ${name}"`, {
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 5000,
        encoding: 'utf8',
        windowsHide: true,
      });
      return out.includes(name);
    }
    // Linux/Mac
    const out = execSync(`pgrep -f "${name}" 2>/dev/null`, {
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    return out.length > 0;
  } catch {
    // tasklist or pgrep returns non-zero exit if no process found
    return false;
  }
}

function findProcessByScript(scriptName) {
  // Find a node process running a specific script
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `wmic process where "name='node.exe' and commandline like '%${scriptName}%'" get processid /format:csv 2>nul`,
        { stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, encoding: 'utf8', windowsHide: true }
      );
      const lines = out.trim().split('\n').filter(l => l.includes(','));
      return lines.length > 0 ? parseInt(lines[0].split(',')[1]) : null;
    }
    const out = execSync(`pgrep -f "node.*${scriptName}" 2>/dev/null`, {
      stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, encoding: 'utf8',
    }).trim();
    return out ? parseInt(out.split('\n')[0]) : null;
  } catch {
    return null;
  }
}

function killProcess(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid} /T 2>nul`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {}
}

// ── HTTP health check ────────────────────────────────────────────────
async function checkHttp(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function checkTcpPort(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

// ── Process detection ────────────────────────────────────────────────
async function findExistingProcess(name) {
  // Read the existing state file (populated by server.js / previous runs)
  const st = loadState();
  const existing = st.services?.[name]?.childPid;
  if (existing && isProcessRunning(existing)) return existing;

  const def = SERVICE_DEFS.find(d => d.name === name);
  if (!def) return null;

  // For services with HTTP health, try a quick check
  if (def.healthUrl && !def.healthUrl.includes('127.0.0.1:0')) {
    try {
      const alive = await checkHttp(def.healthUrl, 2000);
      if (alive) return -1; // running externally, unknown PID
    } catch {}
  }

  // For services known by TCP port, try a socket connect
  const tcpPorts = { pg: 5432, 'local-sb': 54321, relay: 8080, vite: 5173, 'cuttlefishclaws-mcp': 3120, 'xmrtdao-suite-mcp': 3121, 'cuttlefish-mcp': 3122 };
  const port = def.tcpPort || tcpPorts[name];
  if (port) {
    try {
      const alive = await checkTcpPort('127.0.0.1', port, 1000);
      if (alive) return -1;
    } catch {}
  }

  // For services without HTTP/TCP (schedulers, alice, cron-engine, tunnel):
  // check by process name / script name
  const scriptName = def.args.find(a => a.endsWith('.mjs') || a.endsWith('.js'));
  if (scriptName) {
    const pid = findProcessByScript(scriptName.replace(/^.*\//, ''));
    if (pid) return pid;
  }
  if (def.cmd && def.cmd.endsWith('.exe')) {
    const exeName = def.cmd.split(/[/\\]/).pop();
    if (findProcessByName(exeName)) return -1;
  }

  return null;
}

// ── Service lifecycle ────────────────────────────────────────────────
function startService(name) {
  const def = SERVICE_DEFS.find(d => d.name === name);
  if (!def) { log(`unknown service: ${name}`); return; }

  if (state[name] && state[name].child && !state[name].child.killed) {
    log(`${name} already running (pid ${state[name].child.pid})`);
    return;
  }

  log(`starting ${name}: ${def.cmd} ${def.args.join(' ')}`);

  try {
    const child = spawn(def.cmd, def.args, {
      cwd: def.cwd,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      env: { ...process.env },
    });
    child.unref();
    state[name] = {
      child,
      failures: 0,
      startedAt: Date.now(),
      healthy: false,
    };
    log(`  ${name} spawned as pid ${child.pid}`);
    saveState();
  } catch (e) {
    log(`  ${name} spawn FAILED: ${e.message}`);
  }
}

function stopService(name) {
  const s = state[name];
  if (!s || !s.child) return;
  log(`stopping ${name} (pid ${s.child.pid})`);
  killProcess(s.child.pid);
  delete state[name];
  saveState();
}

function stopAll() {
  log('stopping all services...');
  for (const name of [...START_ORDER].reverse()) {
    stopService(name);
  }
  try { writeFileSync(STATE_FILE, JSON.stringify({ services: {}, alerts: {}, _stoppedAt: Date.now() }, null, 2)); } catch {}
  try { writeFileSync(PID_FILE, ''); } catch {}
  log('all services stopped');
}

// ── Health checking ──────────────────────────────────────────────────
async function checkServiceHealth(name) {
  const def = SERVICE_DEFS.find(d => d.name === name);
  if (!def) return false;

  // 1. Check if our managed child process is alive
  const s = state[name];
  if (s && s.child) {
    try { process.kill(s.child.pid, 0); } catch { return false; }
  }

  // 2. If service has an HTTP health endpoint, check it
  if (def.healthUrl) {
    return await checkHttp(def.healthUrl);
  }

  // 3. TCP port check (for services like pg that listen on a port but have no HTTP)
  if (def.tcpPort) {
    return await checkTcpPort('127.0.0.1', def.tcpPort, 2000);
  }

  // 4. Our child process is alive (for spawned services without HTTP/TCP like schedulers)
  if (s && s.child) return true;

  // 5. For externally adopted services with no HTTP/TCP: check process by name
  if (s && s.isExternal) {
    // Use the script name from args to find the process
    const scriptName = def.args.find(a => a.endsWith('.mjs') || a.endsWith('.js') || a.endsWith('.exe'));
    if (scriptName) {
      const pid = findProcessByScript(scriptName.replace(/^.*\//, ''));
      if (pid) return true;
    }
    // For processes like cloudflared.exe, check by binary name
    if (def.cmd && def.cmd.endsWith('.exe')) {
      const exeName = def.cmd.split(/[/\\]/).pop();
      if (findProcessByName(exeName)) return true;
    }
  }

  return false;
}

// ── Tick ─────────────────────────────────────────────────────────────
async function tick() {
  const stateFile = loadState();

  for (const name of START_ORDER) {
    if (shuttingDown) return;

    const def = SERVICE_DEFS.find(d => d.name === name);
    if (!def) continue;

    // Check if process already exists (maybe started by previous supervisor run)
    const existingPid = await findExistingProcess(name);

    if (existingPid) {
      // Process exists — adopt it if we haven't already
      const isUnknownPid = existingPid === -1;
      if (!state[name]) {
        log(`${name} already running externally${isUnknownPid ? '' : ` (pid ${existingPid})`} — adopting`);
        state[name] = {
          child: null,
          externalPid: isUnknownPid ? null : existingPid,
          failures: 0,
          startedAt: Date.now(),
          healthy: false,
          isExternal: true,
        };
      }
      // Health check
      await performHealthCheck(name, def);
    } else if (state[name]?.isExternal) {
      // External process died — remove from state so we restart it
      log(`${name} external process died — will restart`);
      delete state[name];
    } else {
      // Process not found — need to start
      const s = state[name];
      if (!s || !s.child || s.child.killed) {
        startService(name);
        continue;
      }
      // Our child should be running — health check
      await performHealthCheck(name, def);
    }

    // Check dependency health
    if (def.dependsOn) {
      const depsHealthy = def.dependsOn.every(d => state[d]?.healthy);
      if (!depsHealthy && state[name]?.healthy) {
        log(`${name} dependency unhealthy — marking as degraded`);
        state[name].healthy = false;
      }
    }
  }

  saveState();
}

async function performHealthCheck(name, def) {
  const s = state[name];
  if (!s) return;

  // Skip health check during grace period
  if (Date.now() - s.startedAt < def.startupGraceMs) return;

  const healthy = await checkServiceHealth(name);
  if (healthy) {
    if (!s.healthy) log(`${name} HEALTHY`);
    s.healthy = true;
    s.failures = 0;
  } else {
    s.failures = (s.failures || 0) + 1;
    log(`${name} unhealthy (failure ${s.failures}/3)`);
    if (s.failures >= 3) {
      log(`${name} 3 consecutive failures — restarting`);
      // Kill and re-spawn
      if (s.child) killProcess(s.child.pid);
      delete state[name];
      startService(name);
    }
  }
}

// ── Boot sequence ────────────────────────────────────────────────────
async function boot() {
  log('===== supervisor booting =====');
  log(`workspace: ${ROOT}`);
  log(`state: ${STATE_FILE}`);
  log(`pid: ${process.pid}`);

  // Check for existing services and adopt them
  for (const name of START_ORDER) {
    const existingPid = await findExistingProcess(name);
    if (existingPid) {
      log(`${name} already running (pid ${existingPid}) — adopting`);
      state[name] = {
        child: null,
        externalPid: existingPid,
        failures: 0,
        startedAt: Date.now(),
        healthy: false,
        isExternal: true,
      };
    }
  }

  saveState();
  writePid();
  log(`${Object.keys(state).length} services adopted, ${START_ORDER.length - Object.keys(state).length} to start`);
}

// ── Daemon loop ──────────────────────────────────────────────────────
async function daemonLoop() {
  log('daemon mode; polling every 30s');
  let cycle = 0;
  while (!shuttingDown) {
    cycle++;
    log(`=== TICK ${cycle} starting ===`);
    try { await tick(); } catch (e) { log(`TICK ${cycle} ERROR: ${e.stack || e.message}`); }
    log(`=== TICK ${cycle} done, sleeping 30s ===`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

// ── Daemonize (Windows-friendly self-detach) ─────────────────────────
function daemonize() {
  log('daemonizing...');
  const child = spawn(process.execPath, [process.argv[1], '--serve'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  log(`daemon child pid: ${child.pid}`);
  console.log(`Supervisor daemon started (pid ${child.pid})`);
  process.exit(0);
}

// ── PID lock ─────────────────────────────────────────────────────────
function acquireLock() {
  try {
    if (existsSync(PID_FILE)) {
      const oldPid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
      if (oldPid && isProcessRunning(oldPid)) {
        return false; // another supervisor is running
      }
    }
    writeFileSync(PID_FILE, String(process.pid));
    return true;
  } catch {
    return true; // if we can't read/write the lock, proceed anyway
  }
}

function releaseLock() {
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
      if (pid === process.pid) writeFileSync(PID_FILE, '');
    }
  } catch {}
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const mode = process.argv.includes('--once') ? 'once'
    : process.argv.includes('--serve') ? 'serve'
    : process.argv.includes('--daemon') ? 'daemon'
    : process.argv.includes('--status') ? 'status'
    : 'serve';  // default: foreground serve

  if (mode === 'daemon') {
    daemonize();
    return;
  }

  if (mode === 'status') {
    const st = loadState();
    console.log(JSON.stringify({ pid: process.pid, supervisor: st._pid, alive: !!st._pid, ...st }, null, 2));
    return;
  }

  // For --once mode: skip if a --serve daemon is already running
  if (mode === 'once') {
    if (existsSync(PID_FILE)) {
      try {
        const servePid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
        if (servePid && isProcessRunning(servePid)) {
          // A --serve daemon is active — let it handle everything
          return;
        }
      } catch {}
    }
    // No daemon running — proceed with one-shot tick
    // Load persistent failure counts from state file
    const persistentState = loadState();
    for (const name of START_ORDER) {
      const saved = persistentState.services?.[name];
      if (saved && typeof saved.failures === 'number') {
        state[name] = state[name] || {};
        state[name].failures = saved.failures;
        state[name].startedAt = saved.startedAt || Date.now();
        state[name].healthy = saved.healthy || false;
      }
    }
    await boot();
    await tick();
    log('===== one-shot done =====');
    setTimeout(() => process.exit(0), 1000);
    return;
  }

  // serve mode — foreground daemon
  if (!acquireLock()) {
    log('another supervisor is already running (PID lock held) — exiting');
    process.exit(0);
  }
  process.on('SIGINT', () => { shuttingDown = true; stopAll(); releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { shuttingDown = true; stopAll(); releaseLock(); process.exit(0); });
  process.on('unhandledRejection', (reason) => {
    log(`UNHANDLED REJECTION: ${reason?.stack || reason}`);
  });

  await boot();
  await daemonLoop();
}

main().catch((e) => { log(`FATAL: ${e.stack}`); process.exit(1); });
