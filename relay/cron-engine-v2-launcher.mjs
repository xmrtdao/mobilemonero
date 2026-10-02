/**
 * cron-engine-v2-launcher.mjs
 * Wrapper that spawns cron-engine-v2.mjs detached with stdio redirected,
 * avoiding the "stdin is not a tty" Windows error.
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, 'cron-engine-v2.mjs');

console.log('[cron-launcher] Spawning cron-engine-v2.mjs detached...');

const child = spawn(process.execPath, [scriptPath, '--daemon'], {
  cwd: __dirname,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
child.stdout.on('data', d => {
  const s = d.toString();
  output += s;
  process.stdout.write(s);
});

child.stderr.on('data', d => {
  const s = d.toString();
  output += s;
  process.stderr.write(s);
});

child.on('exit', (code) => {
  console.log(`[cron-launcher] Child exited with code ${code}`);
  console.log('[cron-launcher] Will respawn in 10 seconds...');
  setTimeout(() => {
    spawn(process.execPath, [import.meta.filename], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  }, 10000);
});

// Write PID file
import { writeFileSync } from 'fs';
writeFileSync(
  join(__dirname, 'relay-data', 'cron-engine-v2.pid'),
  String(child.pid),
  'utf8'
);

console.log(`[cron-launcher] Spawned PID ${child.pid}`);

// Detach from parent
child.unref();

// Keep this process alive to monitor
echo '[cron-launcher] Monitoring cron-engine-v2...';
setInterval(() => {
  try {
    process.kill(child.pid, 0); // Check if alive
  } catch {
    console.log('[cron-launcher] Detected death, respawning...');
    const newChild = spawn(process.execPath, [scriptPath, '--daemon'], {
      cwd: __dirname,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    writeFileSync(
      join(__dirname, 'relay-data', 'cron-engine-v2.pid'),
      String(newChild.pid),
      'utf8'
    );
    newChild.unref();
  }
}, 30000);
