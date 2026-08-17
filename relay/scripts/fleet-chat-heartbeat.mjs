import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'relay-data');

async function main() {
  try {
    // Ping fleet-chat API to keep pulse alive
    const res = await fetch('http://127.0.0.1:8080/api/fleet-chat/messages?limit=1', {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(`[heartbeat] fleet-chat OK, ${data.messages?.length || 0} messages`);
    
    // Log heartbeat to DB
    const logFile = join(DATA_DIR, 'cron-heartbeat.log');
    const line = `${new Date().toISOString()} fleet-chat-heartbeat OK\n`;
    writeFileSync(logFile, line, { flag: 'a' });
    
    // NOTE: do NOT call process.exit() here. On Windows, calling process.exit()
    // while an AbortSignal.timeout() timer is still pending triggers a libuv
    // assertion crash (UV_HANDLE_CLOSING) that the cron engine logs as a FAIL.
    // Let the process exit naturally once the abort timers drain.
  } catch (e) {
    console.error(`[heartbeat] FAIL: ${e.message}`);
    process.exit(1);
  }
}

main();
