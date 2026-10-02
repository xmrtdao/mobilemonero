/**
 * cron-wrapper.mjs
 * Minimal wrapper that imports tick() from cron-engine-v2 and runs it every 30s.
 * Avoids the stdin/TTY issues with the daemon mode.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PID_FILE = join(__dirname, 'relay-data', 'cron-wrapper.pid');

// Import tick from cron-engine-v2 using absolute path
const enginePath = join(__dirname, 'cron-engine-v2.mjs');
const engineUrl = 'file:///' + enginePath.replace(/\\/g, '/');
const { runOnce } = await import(engineUrl);

// Write PID file
mkdirSync(join(__dirname, 'relay-data'), { recursive: true });
writeFileSync(PID_FILE, String(process.pid), 'utf8');

console.log(`[cron-wrapper] PID ${process.pid} — tick every 30s`);

// Run first tick immediately
await runOnce().catch(err => console.error('[cron-wrapper] tick error:', err.message));

// Schedule subsequent ticks
setInterval(async () => {
  try {
    await runOnce();
  } catch (err) {
    console.error(`[cron-wrapper] tick error: ${err.message}`);
  }
}, 30_000);

// Keep alive
console.log('[cron-wrapper] Running...');
