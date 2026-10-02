const { spawn } = require('child_process');
const { join } = require('path');
const { writeFileSync, mkdirSync } = require('fs');

const scriptDir = __dirname;
const scriptPath = join(scriptDir, 'cron-engine-v2.mjs');
const dataDir = join(scriptDir, '..', 'relay-data');
const logDir = join(dataDir, 'cron-logs');

mkdirSync(logDir, { recursive: true });

function startEngine() {
  console.log(`[cron-spawner] Starting cron-engine-v2...`);
  
  const out = require('fs').openSync(join(logDir, 'stdout.log'), 'a');
  const err = require('fs').openSync(join(logDir, 'stderr.log'), 'a');
  
  const child = spawn(process.execPath, [scriptPath, '--daemon'], {
    cwd: scriptDir,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  
  child.on('exit', (code) => {
    console.log(`[cron-spawner] Engine exited with code ${code}, restarting in 10s...`);
    setTimeout(startEngine, 10000);
  });
  
  child.unref();
  
  writeFileSync(join(dataDir, 'cron-engine-v2.pid'), String(child.pid), 'utf8');
  console.log(`[cron-spawner] Engine PID ${child.pid}`);
  
  // Keep parent alive but detached
  return child;
}

startEngine();

// Keep process alive
setInterval(() => {}, 60000);
