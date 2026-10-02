// Detached launcher for supervisor (reliable on Windows git-bash).
// The scheduled task used `cmd /c start /B node ... --daemon` (dev stub) which
// is fragile on Windows. This uses spawn(detached)+unref with FILE stdio
// redirect (the built-in daemonize() uses stdio:'ignore' → NUL, which can block
// console.log in detached node on Windows and wedge the supervisor). It also
// guards against duplicates via the supervisor.pid lock, matching daemonize().
const { spawn } = require('child_process');
const fs = require('fs');
const dir = 'C:/Users/PureTrek/Desktop/xmrtdao';
const pidFile = dir + '/relay-data/supervisor.pid';
const log = dir + '/logs/supervisor-launch.log';

// Duplicate guard: if a supervisor is already running, don't spawn another.
try {
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (pid > 0) {
      try { process.kill(pid, 0); console.log('supervisor already running pid ' + pid + ' — no duplicate'); process.exit(0); }
      catch (e) { /* stale pid, proceed */ }
    }
  }
} catch (e) {}

const out = fs.openSync(log, 'a');
const err = fs.openSync(log, 'a');
const p = spawn(process.execPath, ['supervisor.mjs', '--serve'], {
  cwd: dir,
  stdio: ['ignore', out, err],
  detached: true,
  windowsHide: true,
});
p.unref();
console.log('supervisor spawned pid', p.pid);
