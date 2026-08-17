import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'relay-data');

async function main() {
  try {
    // Check relay health
    const res = await fetch('http://127.0.0.1:8080/health', {
      signal: AbortSignal.timeout(5000)
    });
    const health = res.ok ? await res.json() : null;
    
    // Check supervisor status
    const supRes = await fetch('http://127.0.0.1:8080/api/supervisor/status', {
      signal: AbortSignal.timeout(5000)
    });
    const sup = supRes.ok ? await supRes.json() : null;
    
    // Read supervisor state
    const stateFile = join(DATA_DIR, 'supervisor-state.json');
    let state = null;
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {}
    
    const status = {
      timestamp: new Date().toISOString(),
      relay: health ? 'healthy' : 'down',
      tools: health?.tools || 0,
      supervisor: sup ? 'running' : 'down',
      services: {}
    };
    
    if (state?.services) {
      for (const [name, svc] of Object.entries(state.services)) {
        status.services[name] = {
          pid: svc.childPid,
          restarts: svc.restartTimestamps?.length || 0,
          lastRestart: svc.restartTimestamps?.slice(-1)[0] || null
        };
      }
    }
    
    // Write status
    const statusFile = join(DATA_DIR, 'fleet-status.json');
    writeFileSync(statusFile, JSON.stringify(status, null, 2));
    
    console.log('[health-check] wrote fleet-status.json');
    // NOTE: do NOT call process.exit() here. On Windows, calling process.exit()
    // while an AbortSignal.timeout() timer is still pending triggers a libuv
    // assertion crash (UV_HANDLE_CLOSING) that the cron engine logs as a FAIL.
    // Let the process exit naturally once the abort timers drain.
  } catch (e) {
    console.error(`[health-check] FAIL: ${e.message}`);
    process.exit(1);
  }
}

main();
