#!/usr/bin/env node
/**
 * start-tunnel-detached.mjs — Supervisor-friendly tunnel launcher
 *
 * Launches the named cloudflared tunnel (relay.mobilemonero.com → :8080)
 * as a process tree that survives this script's exit. Used by:
 *   - relay/supervisor.mjs   (auto-restart)
 *   - start-everything.bat    (boot)
 *
 * Why this exists: the canonical start-tunnel.mjs ends with `process.exit(0)`
 * which kills the detached cloudflared child on Windows. The fix is to launch
 * cloudflared via `start /B` so the cmd console owns the process tree, not us.
 *
 * If cloudflared is already running, exits 0 (idempotent).
 *
 * Usage:
 *   node relay/start-tunnel-detached.mjs
 */

import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLOUDFLARED = join(__dirname, '..', 'cloudflared.exe');
const CONFIG      = 'C:\\Users\\PureTrek\\.cloudflared\\config.yml';
const TUNNEL_ID   = '61492f26-c8f8-45d2-be65-ffb7340683fa';

function log(m) { console.log(`[start-tunnel] ${m}`); }

function isTunnelUp() {
  try {
    const out = execSync(
      `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'cloudflared.exe'\\\" | Select-Object -First 1 -ExpandProperty ProcessId"`,
      { encoding: 'utf8', timeout: 4000, windowsHide: true }
    ).trim();
    return /^\d+$/.test(out);
  } catch { return false; }
}

if (!existsSync(CLOUDFLARED)) {
  log(`cloudflared.exe not found at ${CLOUDFLARED}`);
  process.exit(1);
}
if (!existsSync(CONFIG)) {
  log(`Tunnel config not found at ${CONFIG}`);
  process.exit(1);
}

if (isTunnelUp()) {
  log('Tunnel already up');
  process.exit(0);
}

log('Launching named tunnel via start /B');
// `/B` detaches from THIS console; `start` makes cmd own the child process tree
// so it survives this node process exiting.
const cmd = `start "cloudflared" /B "${CLOUDFLARED}" tunnel --config "${CONFIG}" run`;
log(`Cmd: ${cmd}`);

try {
  // shell: true so cmd.exe's `start` builtin is found
  const child = spawn(cmd, { stdio: 'ignore', windowsHide: true, shell: true });
  child.unref();
} catch (e) {
  log(`Failed to launch: ${e.message}`);
  process.exit(1);
}

// Give cloudflared a moment, then verify
const t0 = Date.now();
while (Date.now() - t0 < 10000) {
  execSync('powershell.exe -NoProfile -Command "Start-Sleep -Milliseconds 500"', { stdio: 'ignore', windowsHide: true });
  if (isTunnelUp()) {
    log(`Tunnel is up after ${Math.round((Date.now() - t0) / 1000)}s`);
    process.exit(0);
  }
}

log('Tunnel did not register a process within 10s — see cloudflared logs');
process.exit(1);
