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
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync, statSync, openSync, renameSync } from 'node:fs';
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
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_FILES = 5;

function rotateLogIfNeeded() {
  try {
    const st = statSync(LOG_FILE);
    if (st.size > MAX_LOG_SIZE) {
      // Rotate: log -> log.1 -> log.2 -> ... -> log.5 (delete oldest)
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const src = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
        const dst = `${LOG_FILE}.${i}`;
        try {
          if (existsSync(src)) {
            if (i === MAX_LOG_FILES - 1 && existsSync(dst)) unlinkSync(dst);
            renameSync(src, dst);
          }
        } catch {}
      }
    }
  } catch {}
}

function log(line) {
  const stamp = new Date().toISOString();
  const full = `${stamp} [supervisor] ${line}`;
  console.log(full);
  try {
    rotateLogIfNeeded();
    appendFileSync(LOG_FILE, full + '\n');
  } catch {}
}

// ── Service definitions ──────────────────────────────────────────────
const SERVICE_DEFS = [
  {
    name: 'relay',
    cmd: 'node',
    args: ['--max-old-space-size=512', 'relay/server.js'],
    cwd: ROOT,
    tcpPort: 8080,
    // HTTP health check: a wedged relay keeps TCP 8080 LISTENING but stops
    // answering HTTP (event-loop block). A bare TCP check reports it healthy
    // forever, so the supervisor never restarts it. Checking /health with a
    // short timeout catches that — checkHttp() times out if no response.
    healthUrl: 'http://127.0.0.1:8080/health',
    healthCheck: (body) => {
      try { const d = JSON.parse(body); return d && d.status === 'ok'; } catch { return false; }
    },
    startupGraceMs: 90000,
    maxFailures: 2,
    dependsOn: ['pg', 'local-sb', 'health-server'],
  },
  {
    name: 'health-server',
    cmd: 'node',
    args: ['relay/health-server.mjs'],
    cwd: ROOT,
    healthUrl: 'http://127.0.0.1:8088/ping',
    healthCheck: (body) => {
      try { const d = JSON.parse(body); return d && d.ok === true; } catch { return false; }
    },
    startupGraceMs: 3000,
    maxFailures: 3,
    dependsOn: [],
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
    name: 'page-agent-mcp',
    // Alibaba Page Agent — JavaScript in-page GUI agent for natural language web control.
    // Provides MCP stdio server on port 38401 (hub) for browser automation.
    // Used for dashboard observation, E2E testing, and fleet chat interaction.
    // Chrome extension at ~/Desktop/page-agent-extension connects to localhost:38401.
    cmd: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Users\\PureTrek\\Desktop\\page-agent\\packages\\mcp\\src\\index.js'],
    cwd: 'C:\\Users\\PureTrek\\Desktop\\page-agent\\packages\\mcp',
    healthUrl: null, // check via process existence (stdio MCP)
    healthCheck: null,
    tcpPort: 38401, // hub port — prevents false "external" adoption via node.exe
    startupGraceMs: 5000,
    dependsOn: [],
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
    tcpPort: 54321,
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
  {
    // DeepSeek Harness web UI — Builder's workspace + watchable harness on :3080.
    // The detached .cjs launcher sets DEEPSEEK_BASE_URL/API_KEY in the child env
    // and writes the one-time auth-token URL to dsh/dsh-web-harness.log (that's
    // the file dsh-open reads to open an authenticated window). Health is TCP :3080
    // (the bare URL returns a 401 auth-wall, which is the healthy state, so a raw
    // HTTP probe would false-negative — a TCP port check is correct here).
    name: 'dsh',
    cmd: 'node',
    args: ['dsh/dsh-web-supervised.cjs'],
    cwd: ROOT,
    healthUrl: null,
    healthCheck: null,
    tcpPort: 3080,
    startupGraceMs: 30000,
    dependsOn: ['relay'],
  },
  {
    name: 'resume-server',
    cmd: 'py',
    args: ['resume_server.py', '--host', '127.0.0.1', '--port', '5175'],
    cwd: join(ROOT, 'jobby-mcjobberson'),
    healthUrl: 'http://127.0.0.1:5175/',
    healthCheck: () => true,
    startupGraceMs: 5000,
    dependsOn: [],
  },
  {
    // AstraGaze / GrayTech Security - the face recognition console published at
    // graytech.mobilemonero.com through the cloudflared tunnel.
    //
    // Supervised because it was not, and that is how it went dark: the process
    // had been started by hand from a shell that has since closed, so nothing
    // brought it back when it died, and there was no entry here to restart it.
    // A public demo that cannot survive a crash is not a service.
    //
    // The venv is the project's own rather than a system python, and cwd is the
    // project root because both `graytech.server:app` and the `app` package
    // resolve relative to it. `--workers 1` is not optional: each worker loads
    // its own copy of the recognition model.
    name: 'graytech',
    cmd: join(ROOT, 'face-service', '.venv', 'Scripts', 'python.exe'),
    args: ['-m', 'uvicorn', 'graytech.server:app', '--host', '127.0.0.1', '--port', '8090', '--workers', '1'],
    cwd: join(ROOT, 'face-service'),
    healthUrl: 'http://127.0.0.1:8090/health',
    // The model load is slow, so a short grace would restart-loop a service that
    // was merely still booting. Measured cold start on this machine: ~70s from
    // spawn to answering /health (insightface + SCRFD/ArcFace load), so the grace
    // is set above that with margin. At 60s a cold start could fail its first
    // probe and get restarted while it was still coming up.
    startupGraceMs: 95000,
      // The port this service listens on, declared on the definition rather than
      // left to the module-level port map.
      //
      // That map was the actual cause of the flapping. There are four copies of
      // it in this file and graytech appeared in NONE of them, so every restart
      // path skipped the two things that make a restart reliable:
      //
      //   * killing the real port owner, so a stale instance survived and the
      //     fresh spawn died on EADDRINUSE - which is the EXIT code=1 two seconds
      //     after spawn in the log, not a crash;
      //   * waiting for the port to be released before spawning.
      //
      // So the sequence was: kill the child, spawn immediately, new instance
      // loses the port race, exits, count a failure, wait three ticks, retry. The
      // service was down for 74-92s at a time and each attempt could lose the
      // race again. Declaring tcpPort here makes all four call sites work,
      // because each one already reads `def.tcpPort || tcpPorts[name]`.
      tcpPort: 8090,
      // Two consecutive failures to the threshold, not the default three.
      //
      // startupGraceMs only covers a process that is still booting. Once the
      // process is up and then dies, startedAt is old, so every probe counts
      // immediately, and at ~33s per tick a dead service takes 100s to recover.
      // Measured from the log: 92s and 74s outages on consecutive deaths.
      //
      // For this service a dead process is unambiguous - /health answers in
      // milliseconds once the model is loaded (16ms measured), so a failure is a
      // genuine one and not a slow boot or a blip.
      maxFailures: 2,
    dependsOn: [],
  },
];

// graytech is independent of every other service - it needs no database and no
// tunnel to answer on :8090 - so it starts last and blocks nothing.
const START_ORDER = ['pg', 'local-sb', 'vite', 'health-server', 'cuttlefishclaws-mcp', 'xmrtdao-suite-mcp', 'page-agent-mcp', 'relay', 'tunnel', 'alice', 'cron-engine-v2', 'campaign-scheduler', 'dsh', 'resume-server', 'graytech'];

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
    // `degradedBy` is cleared rather than copied when absent, so a recovered
    // dependency does not leave a stale degradation marker behind.
    if (s.degradedBy && s.degradedBy.length) out.services[name].degradedBy = s.degradedBy;
    else delete out.services[name].degradedBy;
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
  // Find a node process running a specific script — returns ALL matching PIDs
  // (not just the first) so the supervisor can self-prune duplicates.
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `wmic process where "name='node.exe' and commandline like '%${scriptName}%'" get processid /format:csv 2>nul`,
        { stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, encoding: 'utf8', windowsHide: true }
      );
      // Skip the header row ("Node,ProcessId") — only data rows have an integer pid
      const dataRows = out.trim().split('\n')
        .filter(l => l.includes(','))
        .filter(l => /,\d+\s*$/.test(l));
      const pids = dataRows.map(l => parseInt(l.split(',').pop().trim(), 10)).filter(Boolean);
      return pids.length > 0 ? pids : null;
    }
    const out = execSync(`pgrep -f "node.*${scriptName}" 2>/dev/null`, {
      stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, encoding: 'utf8',
    }).trim();
    return out ? out.split('\n').map(l => parseInt(l, 10)).filter(Boolean) : null;
  } catch {
    return null;
  }
}

// ── Self-pruning ───────────────────────────────────────────────────
// Keep one healthy process per supervised service and kill duplicates.
// This is the guard against the known failure mode where repeated
// supervisor/relay/mcp launches accumulate (double relay on :8080, three
// cuttlefishclaws-mcp daemons, etc.) and silently eat RAM until the box
// OOMs. For each service it enumerates every matching PID, keeps the one
// that owns the service's TCP port (or the single instance if a service
// runs portless), and kills the rest — skipping its own children so a
// legitimately restarted service isn't reaped.
function pruneDuplicateProcesses() {
  const tcpPorts = { pg: 5432, 'local-sb': 54321, relay: 8080, vite: 5173, 'cuttlefishclaws-mcp': 3120, 'xmrtdao-suite-mcp': 3121, 'cuttlefish-mcp': 3122, dsh: 3080 };
  let pruned = 0;

  for (const name of START_ORDER) {
    const def = SERVICE_DEFS.find(d => d.name === name);
    if (!def) continue;

    const scriptName = def.args.find(a => a.endsWith('.mjs') || a.endsWith('.js'));
    if (!scriptName) continue;
    // Use the full relative path (e.g. "relay/health-server.mjs") for matching
    // instead of just the base name — prevents false positives where "server.mjs"
    // also matches "health-server.mjs".
    const matchPath = scriptName.replace(/^[/\\]+/, '');

    let pids;
    try { pids = findProcessByScript(matchPath); } catch { continue; }
    if (!pids || pids.length < 2) {
      // single instance (or none) — nothing to prune for this service
      if (pids && pids.length === 1) continue;
      continue;
    }

    // Determine which PID is the "keeper":
    //   1. the supervisor's own live child for this service, if any
    //   2. else the PID owning the service's TCP port
    let keeper = null;
    if (state[name]?.child && !state[name].child.killed) {
      keeper = state[name].child.pid;
    } else {
      const port = def.tcpPort || tcpPorts[name];
      if (port) {
        try {
          const out = execSync(`netstat -ano | findstr ":${port} " | findstr LISTENING`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
          const m = out.match(/(\d+)\s*$/m);
          if (m) keeper = parseInt(m[1], 10);
        } catch {}
      }
    }

    for (const pid of pids) {
      if (pid === process.pid) continue;             // never kill ourselves
      if (pid === state[name]?.child?.pid) continue; // never kill our managed child
      if (pid === keeper) continue;                  // keep the one serving
      // Heuristic safety: never kill a relay/MCP that the relay actively tracks
      // (avoid reaping during a restart race). Only prune if not the keeper.
      try { killProcess(pid); pruned++; log(`[self-prune] ${name}: killed duplicate pid ${pid} (keeper=${keeper})`); }
      catch {}
    }
  }
  if (pruned > 0) log(`[self-prune] pruned ${pruned} duplicate process(es)`);
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
  // Try the given host first, then the other loopback (IPv4/IPv6).
  // Some services (e.g. page-agent-mcp) bind only ::1, so a 127.0.0.1
  // check would falsely report "not running" and cause duplicate spawns.
  const hosts = host === '127.0.0.1' ? ['127.0.0.1', '::1'] : host === '::1' ? ['::1', '127.0.0.1'] : [host];
  for (const h of hosts) {
    const ok = await new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(timeoutMs);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(port, h);
    });
    if (ok) return true;
  }
  return false;
}

// ── Process detection ────────────────────────────────────────────────
//
// The one true port map. This was duplicated as a local `const` inside four
// separate functions, and they had drifted: one copy had 'cuttlefish-mcp',
// three did not, and graytech was in none of them. A service missing from a copy
// silently loses every port-aware behaviour at that call site - it is not an
// error, the lookup just returns undefined and the branch is skipped. That is
// precisely how graytech came to lose the port-kill and port-wait on restart and
// then start failing EADDRINUSE.
//
// Definitions remain the source of truth: `def.tcpPort` wins, and this map is
// only the fallback for services that predate the field.
const TCP_PORTS = { pg: 5432, 'local-sb': 54321, relay: 8080, vite: 5173, 'cuttlefishclaws-mcp': 3120, 'xmrtdao-suite-mcp': 3121, 'cuttlefish-mcp': 3122, dsh: 3080, graytech: 8090 };

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
      // If health check fails but port is open, kill the stale process
      if (def.tcpPort || tcpPorts[name]) {
        const port = def.tcpPort || tcpPorts[name];
        const portOpen = await checkTcpPort('127.0.0.1', port, 1000);
        if (portOpen) {
          log(`${name} port ${port} is open but health check failed — killing stale process`);
          // Find what's on that port and kill it
          try {
            const pids = execSync(`netstat -ano | findstr ":${port} " | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
            const pidMatch = pids.match(/(\d+)\s*$/m);
            if (pidMatch) {
              killProcess(parseInt(pidMatch[1]));
              log(`${name} killed stale pid ${pidMatch[1]} on port ${port}`);
            }
          } catch {}
        }
      }
    } catch {}
  }

  // For services known by TCP port, try a socket connect
  const tcpPorts = TCP_PORTS;
  const port = def.tcpPort || tcpPorts[name];
  if (port) {
    try {
      const alive = await checkTcpPort('127.0.0.1', port, 1000);
      if (alive) return -1;
      // Explicit tcpPort that is NOT listening → not running, start it.
      // Do NOT fall through to the .exe fallback (node.exe is always running
      // and would falsely report "adopting" for page-agent-mcp).
      if (def.tcpPort) return null;
    } catch {}
  }

  // For services without HTTP/TCP (schedulers, alice, cron-engine, tunnel):
  // check by process name / script name
  const scriptName = def.args.find(a => a.endsWith('.mjs') || a.endsWith('.js'));
  if (scriptName) {
    const pids = findProcessByScript(scriptName.replace(/^.*[/\\]/, ''));
    if (pids && pids.length > 0) return pids[0];
  }
  if (def.cmd && def.cmd.endsWith('.exe')) {
    const exeName = def.cmd.split(/[/\\]/).pop();
    if (findProcessByName(exeName)) return -1;
  }

  return null;
}

// ── Service lifecycle ────────────────────────────────────────────────
async function startService(name) {
  const def = SERVICE_DEFS.find(d => d.name === name);
  if (!def) { log(`unknown service: ${name}`); return; }

  if (state[name] && state[name].child && !state[name].child.killed) {
    log(`${name} already running (pid ${state[name].child.pid})`);
    return;
  }

  log(`starting ${name}: ${def.cmd} ${def.args.join(' ')}`);

  try {
    // ── Redirect stdio to log files ─────────────────────────────
    // Pipes ('pipe') fill up the 64KB OS buffer and block the child's event
    // loop. 'ignore' maps to NUL on Windows which can also block console.log
    // in detached processes. Redirecting to a file is the only safe option —
    // files have no buffer limit, writes never block, and we get crash logs.
    const serviceLogPath = join(LOG_DIR, `${name}.log`);
    let logFd, errFd;
    try {
      // Truncate if > 5MB, otherwise append
      try {
        const st = statSync(serviceLogPath);
        if (st.size > 5 * 1024 * 1024) {
          logFd = openSync(serviceLogPath, 'w');
        } else {
          logFd = openSync(serviceLogPath, 'a');
        }
      } catch {
        logFd = openSync(serviceLogPath, 'w');
      }
      errFd = logFd; // stdout + stderr go to same file
    } catch (e) {
      log(`Warning: could not open log file for ${name}: ${e.message}`);
    }
    // Do not spawn on top of a port we are still releasing.
    //
    // This is the second half of the graytech flapping, and it is separate from
    // the missing tcpPort. The health-failure path kills the port owner and waits
    // for release (with tcpPort now declared, graytech finally takes that path),
    // but this function - startService - is also reached from the tick loop when
    // no live process is found, and it spawned immediately. A uvicorn process
    // that has just been killed can hold :8090 for a moment while Windows reaps
    // it, so the new one lost the bind and exited with code 1 within ~2 seconds.
    // That exit then counted as a failure, which cost another 60-90 seconds.
    //
    // Checking first costs a couple of seconds in the rare case where the port
    // really is free, and saves a full restart cycle in the case where it is not.
    const wantPort = def.tcpPort || TCP_PORTS[def.name];
    if (wantPort) {
      let waited = 0;
      while (waited < 15000) {
        let busy = false;
        try { busy = await checkTcpPort('127.0.0.1', wantPort, 500); } catch { busy = false; }
        if (!busy) break;
        if (waited === 0) {
          log(`  ${name}: port ${wantPort} still held, waiting for release`);
        }
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
      }
      if (waited > 0) {
        log(`  ${name} waited ${waited}ms for port ${wantPort}`);
        let stillBusy = false;
        try { stillBusy = await checkTcpPort('127.0.0.1', wantPort, 500); } catch { stillBusy = false; }
        if (stillBusy) {
          // Something is holding it and did not let go in 15s. Find and kill the
          // owner rather than spawning into a guaranteed EADDRINUSE.
          try {
            const out = execSync(`netstat -ano | findstr ":${wantPort} " | findstr LISTENING`,
                                 { encoding: 'utf8', timeout: 5000, windowsHide: true });
            const m = out.match(/(\d+)\s*$/m);
            if (m) {
              const owner = parseInt(m[1], 10);
              if (owner && owner !== process.pid) {
                log(`  ${name}: port ${wantPort} still held by pid ${owner}, killing it`);
                killProcess(owner);
                await new Promise(r => setTimeout(r, 1500));
              }
            }
          } catch { /* best effort */ }
        }
      }
    }

    const child = spawn(def.cmd, def.args, {
      cwd: def.cwd,
      detached: true,
      stdio: ['ignore', logFd || 'ignore', errFd || 'ignore'],
      windowsHide: true,
      env: { ...process.env },
    });
    let stderrBuf = '';
    // Flush on exit — write any captured stderr to the crash log
    child.on('exit', (code, signal) => {
      log(`${name} EXIT: code=${code} signal=${signal}`);
      if (stderrBuf) {
        log(`${name} STDERR (last 10KB):\n${stderrBuf}`);
        try {
          const crashEntry = `[${new Date().toISOString()}] ${name} (pid=${child.pid}) EXIT code=${code} signal=${signal}\n${stderrBuf.slice(-2000)}\n---\n`;
          appendFileSync('C:/Users/PureTrek/Desktop/xmrtdao/logs/process-crashes.log', crashEntry);
        } catch (e) { /* best effort */ }
      }
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
  if (s && s.child) {
    try { process.kill(s.child.pid, 0); return true; } catch {}
  }

  // 5. For services with no HTTP/TCP/child: check process by script name in the live table
  // This catches cases where the child reference is stale but a healthy instance exists.
  const scriptName = def.args.find(a => a.endsWith('.mjs') || a.endsWith('.js') || a.endsWith('.exe'));
  if (scriptName) {
    if (findProcessByScript(scriptName.replace(/^.*\//, ''))) return true;
  }
  if (def.cmd && def.cmd.endsWith('.exe')) {
    const exeName = def.cmd.split(/[/\\]/).pop();
    if (findProcessByName(exeName)) return true;
  }

  return false;
}

// ── Tick ─────────────────────────────────────────────────────────────
async function tick() {
  const stateFile = loadState();

  // ── Process agent-queued service actions ──
  // The relay's `service_control` tool writes actions to service-actions.json;
  // the supervisor executes them here. Without this, queued restarts pile up
  // with `processed: false` forever and agents' restart requests never happen.
  try {
    const queueFile = join(DATA_DIR, 'service-actions.json');
    if (existsSync(queueFile)) {
      const queue = JSON.parse(readFileSync(queueFile, 'utf8'));
      if (Array.isArray(queue) && queue.length > 0) {
        const pending = queue.filter(a => !a.processedAt);
        for (const action of pending) {
          const def = SERVICE_DEFS.find(d => d.name === action.service);
          if (!def) {
            log(`service_control: unknown service "${action.service}"`);
            action.processedAt = Date.now();
            action.result = 'unknown_service';
            continue;
          }
          if (action.action === 'restart') {
            log(`service_control: restarting ${action.service} (requested by ${action.requestedBy || 'unknown'})`);
            // Kill the port owner first (handles external/adopted services whose
            // childPid is null — stopService() alone can't kill them, and a fresh
            // spawn would crash with EADDRINUSE while the old process holds the port).
            const tcpPorts = TCP_PORTS;
            const port = def.tcpPort || tcpPorts[action.service];
            if (port) {
              try {
                const out = execSync(`netstat -ano | findstr ":${port} " | findstr LISTENING`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
                const pidMatch = out.match(/(\d+)\s*$/m);
                if (pidMatch) {
                  const ownerPid = parseInt(pidMatch[1], 10);
                  if (ownerPid && ownerPid !== process.pid) {
                    log(`service_control: killing port ${port} owner pid ${ownerPid}`);
                    killProcess(ownerPid);
                  }
                }
              } catch {}
            }
            stopService(action.service);
            await startService(action.service);
            action.processedAt = Date.now();
            action.result = 'restarted';
          } else if (action.action === 'start') {
            const healthy = await checkServiceHealth(action.service);
            if (!healthy) {
              log(`service_control: starting ${action.service} (requested by ${action.requestedBy || 'unknown'})`);
              await startService(action.service);
              action.processedAt = Date.now();
              action.result = 'started';
            } else {
              log(`service_control: ${action.service} already healthy, skipping start`);
              action.processedAt = Date.now();
              action.result = 'already_healthy';
            }
          } else if (action.action === 'stop') {
            log(`service_control: stopping ${action.service} (requested by ${action.requestedBy || 'unknown'})`);
            stopService(action.service);
            action.processedAt = Date.now();
            action.result = 'stopped';
          } else if (action.action === 'status') {
            // status is handled inline by the relay tool, not queued
            action.processedAt = Date.now();
            action.result = 'status_inline';
          }
        }
        writeFileSync(queueFile, JSON.stringify(queue, null, 2));
      }
    }
  } catch (e) {
    log(`service_control queue processing error: ${e.message}`);
  }

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
        await startService(name);
        continue;
      }
      // Our child should be running — health check
      await performHealthCheck(name, def);
    }

    // Check dependency health.
    //
    // This used to write `state[name].healthy = false` and nothing ever wrote
    // it back to true: `performHealthCheck` above only *raises* healthy to
    // true, and it runs before this block, so a service that was latched false
    // by an unhealthy dependency stayed false forever even after the service
    // itself and all its dependencies recovered. dsh (dependsOn: ['relay'])
    // got stuck reporting unhealthy after a relay restart, which is what made
    // service_control tell agents dsh was down while it had been up for hours.
    //
    // Degradation is now recorded as its own field and never overwrites the
    // service's own health verdict.
    if (def.dependsOn) {
      const unhealthyDeps = def.dependsOn.filter(d => !state[d]?.healthy);
      // The entry can be missing by this point: the branches above delete it
      // when an external process dies or a service is started, so the service
      // will be (re)started next tick. Writing here unconditionally threw
      // "Cannot set properties of undefined (setting 'degradedBy')" and took
      // the whole tick down with it.
      const entry = state[name];
      if (!entry) {
        if (unhealthyDeps.length) {
          log(`${name} pending restart — degraded by ${unhealthyDeps.join(', ')}`);
        }
      } else if (unhealthyDeps.length > 0) {
        entry.degradedBy = unhealthyDeps;
      } else {
        delete entry.degradedBy;
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
    const maxFail = def.maxFailures || 3;
    s.failures = (s.failures || 0) + 1;
    log(`${name} unhealthy (failure ${s.failures}/${maxFail})`);
    if (s.failures >= maxFail) {
      log(`${name} ${maxFail} consecutive failures — restarting`);
      // Kill the actual TCP port owner FIRST, not just our tracked child pid.
      // A stale instance can hold the port while state[] points at a dead or
      // different pid (e.g. after a supervisor restart the real owner gets
      // orphaned from state). Killing only s.child leaves the port taken, so
      // every fresh spawn dies on EADDRINUSE — the suite-mcp restart loop.
      const tcpPorts = TCP_PORTS;
      const port = def.tcpPort || tcpPorts[name];
      if (port) {
        try {
          const out = execSync(`netstat -ano | findstr ":${port} " | findstr LISTENING`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
          const pidMatch = out.match(/(\d+)\s*$/m);
          if (pidMatch) {
            const ownerPid = parseInt(pidMatch[1], 10);
            if (ownerPid && ownerPid !== process.pid && (!s.child || ownerPid !== s.child.pid)) {
              log(`${name}: killing port ${port} owner pid ${ownerPid}`);
              killProcess(ownerPid);
            }
          }
        } catch {}
      }
      // Also kill our tracked child if it's still alive
      if (s.child) killProcess(s.child.pid);
      // Wait for port to be released before spawning new instance
      if (port) {
        let waited = 0;
        while (waited < 10000) {
          try {
            const inUse = await checkTcpPort('127.0.0.1', port, 500);
            if (!inUse) break;
          } catch {}
          await new Promise(r => setTimeout(r, 500));
          waited += 500;
        }
        if (waited > 0) log(`${name} waited ${waited}ms for port ${port} to be released`);
      }
      delete state[name];
      await startService(name);
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
    try {
      await tick();
      // Self-prune duplicates each tick so repeated launches can't accumulate
      // a double-relay / triple-MCP memory leak. Runs after tick so the keeper
      // selection reflects the freshly-adopted/started processes.
      try { pruneDuplicateProcesses(); } catch (pe) { log(`self-prune ERROR: ${pe.message}`); }
    } catch (e) { log(`TICK ${cycle} ERROR: ${e.stack || e.message}`); }
    log(`=== TICK ${cycle} done, sleeping 30s ===`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

// ── Daemonize (Windows-friendly self-detach) ─────────────────────────
function daemonize() {
  // Guard against piling up duplicate --serve supervisors. Every --daemon
  // invocation used to spawn a fresh --serve child unconditionally, so the
  // three boot scripts (start-everything.bat, start-supervisor.bat, and the
  // Vex-Supervisor logon task) each left a long-lived daemon behind →
  // 5+ supervisors fighting over the same state file. Check the lock first:
  if (!acquireLock()) {
    log(`daemonize: another supervisor is already running (PID lock held) — refusing to spawn duplicate`);
    console.log('Supervisor already running — no duplicate spawned');
    process.exit(0);
  }
  releaseLock(); // hand the lock to the child we're about to spawn
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
/**
 * Kill every stale owner of a supervised port at daemon start.
 *
 * Windows allows two sockets to bind the same port when SO_REUSEADDR is set,
 * and netstat then lists both. When this daemon is killed and relaunched, the
 * `py` launcher it spawned survives as an orphan and keeps the port, so the
 * freshly started service load-balances against stale code. That is not a
 * visible failure: requests appear to work, they just answer from the old
 * build about half the time. It has twice cost an hour of debugging a "fix that
 * did not take effect".
 *
 * Only ports this supervisor owns are touched, and the daemon's own pid is
 * never a candidate.
 */
function sweepStalePortOwners() {
  // pids of services this supervisor is already tracking, which must survive
  // the sweep. Read fresh from the state file: a restarted daemon has no
  // in-memory children yet, but the previous run's pids are still recorded.
  //
  // loadState() nests service entries under `.services`. Reading the top level
  // instead finds nothing, and the sweep then kills every live service — which
  // it did, taking Postgres with it.
  const trackedChildPids = new Set();
  const persisted = loadState() || {};
  const entries = persisted.services && typeof persisted.services === 'object'
    ? Object.entries(persisted.services)
    : [];
  for (const [, entry] of entries) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of ['childPid', 'externalPid', 'pid']) {
      const pid = Number(entry[key]);
      if (Number.isInteger(pid) && pid > 0) trackedChildPids.add(pid);
    }
  }
  log(`startup sweep: ${trackedChildPids.size} tracked child pid(s) to preserve`);

  // With no record of what we own, killing listeners is a guess. Refuse rather
  // than take the whole stack down on a bad state file.
  if (trackedChildPids.size === 0) {
    log('startup sweep: no tracked pids found — skipping sweep to avoid killing live services');
    return;
  }

  const ports = new Set();
  for (const def of SERVICE_DEFS) {
    if (def.tcpPort) ports.add(def.tcpPort);
  }
  // Ports the daemon monitors but which are not in SERVICE_DEFS.
  for (const port of [5432, 54321, 8080, 5173, 3120, 3121, 3080, 5175, 5174, 38401]) {
    ports.add(port);
  }

  for (const port of ports) {
    let out = '';
    try {
      out = execSync(`netstat -ano | findstr ":${port} " | findstr LISTENING`, {
        encoding: 'utf8', timeout: 5000,
      });
    } catch { continue; }

    // Every pid, not just the first: with two bound sockets there are two.
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/(\d+)\s*$/);
      if (m) pids.add(parseInt(m[1], 10));
    }
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (pid === process.pid) continue;
      // `state` is keyed by service name, not pid, so the tracked children have
      // to be collected explicitly. Killing one of our own live services here
      // would be a self-inflicted outage.
      if (trackedChildPids.has(pid)) continue;
      try {
        log(`startup sweep: killing stale pid ${pid} on port ${port}`);
        killProcess(pid);
      } catch (e) {
        log(`startup sweep: could not kill pid ${pid} on port ${port}: ${e.message}`);
      }
    }
  }
}

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

  // Clear orphaned listeners before anything adopts or starts a service.
  if (mode === 'serve') {
    try { sweepStalePortOwners(); } catch (e) {
      log(`startup sweep failed: ${e.message}`);
    }
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
