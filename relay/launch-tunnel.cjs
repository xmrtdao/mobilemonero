// Detached launcher for cloudflared tunnel (reliable path handling on Windows). CommonJS.
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { homedir } = require('node:os');
const fs = require('node:fs');

const ROOT = 'C:/Users/PureTrek/Desktop/xmrtdao';
const CFG = join(homedir(), '.cloudflared', 'config.yml');
const LOG = fs.openSync(join(ROOT, 'logs', 'tunnel.log'), 'a');

console.log('config path:', CFG, '| exists:', fs.existsSync(CFG));
const p = spawn(join(ROOT, 'cloudflared.exe'), ['tunnel', '--config', CFG, 'run'], {
  cwd: ROOT,
  stdio: ['ignore', LOG, LOG],
  detached: true,
  windowsHide: true,
});
p.unref();
console.log('cloudflared spawned pid', p.pid);
