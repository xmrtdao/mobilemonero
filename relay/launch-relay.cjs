// Detached launcher for relay (reliable on Windows git-bash)
const { spawn } = require('child_process');
const fs = require('fs');
const dir = 'C:/Users/PureTrek/Desktop/xmrtdao/relay';
const log = 'C:/Users/PureTrek/Desktop/xmrtdao/logs/relay.log';
const out = fs.openSync(log, 'a');
const err = fs.openSync(log, 'a');
const p = spawn('node', ['--max-old-space-size=512', 'server.js'], {
  cwd: dir,
  stdio: ['ignore', out, err],
  detached: true,
  windowsHide: true,
});
p.unref();
console.log('relay spawned pid', p.pid);
