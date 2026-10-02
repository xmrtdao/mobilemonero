const { spawn } = require('child_process');
const { join } = require('path');
const { writeFileSync, mkdirSync } = require('fs');

const scriptDir = __dirname;
const scriptPath = join(scriptDir, 'cron-engine-v2.mjs');
const dataDir = join(scriptDir, '..', 'relay-data');
const logDir = join(dataDir, 'cron-logs');

mkdirSync(logDir, { recursive: true });

function startEngine() {
  const logFile = join(logDir, `cron-${Date.now()}.log`);
  
  console.log(`[cron-launcher] Starting cron-engine-v2...`);
  
  const child = spawn(process.execPath, [scriptPath, '--daemon'], {
    cwd: scriptDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  
  // Write PID file
  writeFileSync(join(dataDir, 'cron-engine-v2.pid'), String(child.pid), 'utf8');
  console.log(`[cron-launcher] Engine PID ${child.pid}`);
  
  let stdout = '';
  let stderr = '';
  
  child.stdout.on('data', d => {
    stdout += d.toString();
    console.log(`[cron-stdout] ${d.toString().trim()}`);
  });
  
  child.stderr.on('data', d => {
    stderr += d.toString();
    console.error(`[cron-stderr] ${d.toString().trim()}`);
  });
  
  child.on('exit', (code) => {
    console.log(`[cron-launcher] Engine exited with code ${code}`);
    console.log('[cron-launcher] Respawning in 10 seconds...');
    setTimeout(startEngine, 10000);
  });
  
  // Detach from parent
  child.unref();
  
  return child;
}

// Start the engine
const child = startEngine();

// Keep parent alive but allow it to exit without killing child
setTimeout(() => {
  console.log('[cron-launcher] Parent exiting, child is detached');
  process.exit(0);
}, 5000);
