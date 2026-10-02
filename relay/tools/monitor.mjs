/**
 * relay/tools/monitor.mjs — System monitoring and telemetry
 * 
 * Provides real-time system metrics:
 *   - CPU / Memory / Disk usage
 *   - Relay uptime and request counts
 *   - Task handler statistics
 *   - External service health (Supabase, Ollama, GitHub)
 */

import { execSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY_DATA_DIR = join(__dirname, '..', '..', 'relay-data');

/**
 * Get system resource usage
 */
export function getSystemResources() {
  const info = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    uptime: process.uptime(),
    memory: {},
    cpu: {},
  };

  // Memory
  const memUsage = process.memoryUsage();
  info.memory = {
    rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
    external: Math.round(memUsage.external / 1024 / 1024) + ' MB',
  };

  // CPU info (cross-platform)
  try {
    if (process.platform === 'win32') {
      const cpu = execSync('wmic cpu get loadpercentage /value', { encoding: 'utf8', timeout: 5000 });
      const match = cpu.match(/LoadPercentage=(\d+)/);
      if (match) info.cpu.usage = `${match[1]}%`;
      
      const mem = execSync('wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /value', { encoding: 'utf8', timeout: 5000 });
      const freeMatch = mem.match(/FreePhysicalMemory=(\d+)/);
      const totalMatch = mem.match(/TotalVisibleMemorySize=(\d+)/);
      if (freeMatch && totalMatch) {
        const freeMB = Math.round(parseInt(freeMatch[1]) / 1024);
        const totalMB = Math.round(parseInt(totalMatch[1]) / 1024);
        info.memory.system = {
          total: `${totalMB} MB`,
          free: `${freeMB} MB`,
          used: `${totalMB - freeMB} MB`,
          usagePercent: `${Math.round(((totalMB - freeMB) / totalMB) * 100)}%`,
        };
      }
    } else {
      // Linux/Mac
      try {
        const cpuInfo = execSync("top -bn1 | grep 'Cpu(s)'", { encoding: 'utf8', timeout: 5000 });
        info.cpu.usage = cpuInfo.trim();
      } catch {}
      
      try {
        const memInfo = execSync('free -m | grep Mem', { encoding: 'utf8', timeout: 5000 });
        const parts = memInfo.trim().split(/\s+/);
        if (parts.length >= 3) {
          info.memory.system = {
            total: `${parts[1]} MB`,
            used: `${parts[2]} MB`,
            free: `${parts[3]} MB`,
            usagePercent: `${Math.round((parseInt(parts[2]) / parseInt(parts[1])) * 100)}%`,
          };
        }
      } catch {}
    }
  } catch (e) {
    info.cpu.error = e.message;
  }

  // Disk
  try {
    const relayLog = join(RELAY_DATA_DIR, '..', 'relay.log');
    if (existsSync(relayLog)) {
      const stats = statSync(relayLog);
      info.relayLogSize = `${Math.round(stats.size / 1024)} KB`;
    }
  } catch {}

  return info;
}

/**
 * Check external service health
 */
async function probeSupabase(url, key) {
  try {
    const res = await fetch(url + '/rest/v1/tasks?select=id&limit=1', {
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    return { status: res.ok ? 'ok' : `error (${res.status})`, latency: null, url };
  } catch (e) {
    return { status: 'unreachable', error: e.message };
  }
}

async function probeOllama() {
  try {
    const start = Date.now();
    const res = await fetch(`${process.env.OLLAMA_HOST || 'http://localhost:11434'}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    const latency = Date.now() - start;
    if (!res.ok) return { status: `error (${res.status})` };
    const data = await res.json();
    return { status: 'ok', models: (data.models || []).map(m => m.name), latency: `${latency}ms` };
  } catch (e) {
    return { status: 'unreachable', error: e.message };
  }
}

async function probeGithub() {
  try {
    const res = await fetch('https://api.github.com/repos/xmrtdao/mobilemonero', {
      headers: { 'User-Agent': 'xmrtdao-monitor' },
      signal: AbortSignal.timeout(8000),
    });
    return { status: res.ok ? 'ok' : `error (${res.status})` };
  } catch (e) {
    return { status: 'unreachable', error: e.message };
  }
}

async function probeHermes(url) {
  try {
    // Hermes Agent runs on this laptop (Hermes desktop) — check localhost first,
    // then fall back to the configured URL (phone Termux).
    // If the URL is the relay itself, a simple GET /health suffices.
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.ok ? 'ok' : `error (${res.status})` };
  } catch (e) {
    // Fallback: check the relay's own health (this Hermes session IS the relay)
    try {
      const relayRes = await fetch('http://127.0.0.1:8080/health', {
        signal: AbortSignal.timeout(3000),
      });
      if (relayRes.ok) {
        return { status: 'ok (local relay)', note: 'phone endpoint unreachable, relay is running locally' };
      }
    } catch {}
    return { status: 'unreachable', error: e.message };
  }
}

export async function checkExternalServices() {
  // Run all 4 probes in parallel so a slow GitHub response doesn't
  // starve the gatherFleetContext 6s timeout and cause every service to
  // report "fetch_failed".
  const [supabase, ollama, github, hermes] = await Promise.all([
    probeSupabase(process.env.SUPABASE_URL || 'http://127.0.0.1:54321',
                  process.env.SUPABASE_SERVICE_ROLE_KEY || 'local-dev-service-role-key'),
    probeOllama(),
    probeGithub(),
    probeHermes(process.env.HERMES_ENDPOINT || 'http://192.168.14.115:9090'),
  ]);

  return { supabase, ollama, github, hermes };
}

/**
 * Get relay request statistics
 */
export function getRelayStats() {
  // Count files in relay-data
  let activityCount = 0;
  try {
    const { readdirSync } = require('fs');
    // We don't persist request counts separately, rely on relay's activityLog
  } catch {}

  return {
    handlers: ['email-smtp-fix', 'alice-sidecar', 'knowledge-sync', 'device-registration', 'mining-dashboard', 'alice'],
    relayPort: parseInt(process.env.RELAY_PORT || '8080'),
    agentName: 'Eliza-Dev',
  };
}

/**
 * Get a full snapshot of the system state
 */
export async function getFullSnapshot() {
  const systemResources = getSystemResources();
  const externalServices = await checkExternalServices();
  const relayStats = getRelayStats();

  return {
    timestamp: new Date().toISOString(),
    system: systemResources,
    services: externalServices,
    relay: relayStats,
  };
}

export default { getSystemResources, checkExternalServices, getRelayStats, getFullSnapshot };
