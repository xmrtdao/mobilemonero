// relay/scripts/memory-watchdog.mjs
// Scheduled memory-pressure watchdog (close the cron gap).
// Calls the relay's `memory-pressure` tool for a full snapshot, logs it,
// and auto-kills ONLY verified redundant MCP duplicates when free memory is
// critically low (< 0.8 GB). The relay tool already flags duplicates by name;
// the supervisor's self-prune (every 30s) keeps the port owner. This cron is a
// belt-and-suspenders proactive pass + a persistent memory-health log.
//
// Registered in cron.job as a SHELL job:
//   command = node relay/scripts/memory-watchdog.mjs
//   schedule = */10 * * * *
//   enabled = true
import { readFileSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..', '..');          // <repo>/relay/scripts -> <repo>
const RELAY = join(__dirname, '..');               // relay/
const DATA_DIR = join(ROOT, 'relay-data');
const LOG_DIR = join(DATA_DIR, 'logs');
const LOG_FILE = join(LOG_DIR, 'memory-watchdog.log');

try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function log(line) {
  const ts = new Date().toISOString();
  try { appendFileSync(LOG_FILE, `[${ts}] ${line}\n`, 'utf8'); } catch {}
  console.log(`[${ts}] ${line}`);
}

function readApiKey() {
  try {
    const env = readFileSync(join(RELAY, '.env'), 'utf8');
    const m = env.match(/^RELAY_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return '';
}

// Thresholds in GB
const CRITICAL_FREE_GB = 0.8;
const LOW_FREE_GB = 1.2;

async function main() {
  const apiKey = readApiKey();
  if (!apiKey) { log('WARN: RELAY_API_KEY not found — cannot query memory-pressure tool'); return; }

  // 1. Direct memory snapshot (always reliable, no tool dependency)
  let freeGB = null, totalGB = null;
  try {
    const cp = await import('node:child_process');
    const out = cp.execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize | ConvertTo-Json"',
      { encoding: 'utf8', timeout: 15000 }
    );
    const j = JSON.parse(out);
    freeGB = (j.FreePhysicalMemory || 0) / 1048576;
    totalGB = (j.TotalVisibleMemorySize || 0) / 1048576;
  } catch (e) { log(`WARN: could not read memory snapshot: ${e.message}`); }

  const freeStr = freeGB !== null ? freeGB.toFixed(2) + 'GB' : '?';
  const pct = (freeGB !== null && totalGB) ? Math.round((1 - freeGB / totalGB) * 100) + '%' : '?';
  log(`memory free=${freeStr} used=${pct}`);

  // 2. Query the memory-pressure tool for the full snapshot (flags MCP dups)
  let tool = null;
  try {
    const res = await fetch('http://127.0.0.1:8080/tools/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'x-agent-id': 'cron' },
      body: JSON.stringify({ tool: 'memory-pressure', args: { action: 'status' } }),
      signal: AbortSignal.timeout(20000),
    });
    tool = await res.json();
  } catch (e) {
    log(`WARN: memory-pressure tool call failed: ${e.message}`);
  }

  const dups = tool?.duplicateMCPs || [];
  if (dups.length) log(`detected ${dups.length} duplicate MCP process(es): ${dups.map(d => d.name + ':' + d.pid).join(', ')}`);

  // 3. Auto-kill verified MCP duplicates ONLY when critically low.
  //    Keep the FIRST (port owner / supervisor-managed) instance per name; kill the rest.
  if (freeGB !== null && freeGB < CRITICAL_FREE_GB && dups.length) {
    const seen = {};
    const toKill = [];
    for (const d of dups) {
      if (!seen[d.name]) { seen[d.name] = true; continue; } // keep first
      toKill.push(d);
    }
    for (const p of toKill) {
      if (p.pid) {
        const killRes = await fetch('http://127.0.0.1:8080/tools/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'x-agent-id': 'cron' },
          body: JSON.stringify({ tool: 'memory-pressure', args: { action: 'kill', pid: p.pid, reason: 'memory-watchdog cron (free<0.8GB)' } }),
          signal: AbortSignal.timeout(15000),
        }).then(r => r.json()).catch(() => ({}));
        log(killRes?.success ? `killed duplicate ${p.name}:${p.pid}` : `kill of ${p.name}:${p.pid} failed: ${killRes?.error || '?'}`);
      }
    }
  } else if (freeGB !== null && freeGB < LOW_FREE_GB && dups.length) {
    log(`memory low (${freeStr}) but above critical — reporting duplicates, NOT auto-killing (dups: ${dups.map(d => d.name).join(', ')})`);
  } else if (freeGB !== null && freeGB < LOW_FREE_GB) {
    log('memory low but no duplicate MCPs to reap');
  } else if (freeGB !== null && freeGB >= LOW_FREE_GB) {
    log('memory healthy');
  }

  log(`watchdog pass complete (top: ${(tool?.topConsumers || []).slice(0,3).map(c => c.name + ':' + c.mb + 'MB').join(', ') || 'n/a'})`);
}

main().catch(e => log(`FATAL: ${e.message}`));
