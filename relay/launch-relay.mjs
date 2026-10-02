const { spawn } = require('child_process');
const path = require('path');

const relayDir = 'C:/Users/PureTrek/Desktop/xmrtdao/relay';
const p = spawn('node', ['server.js'], {
  cwd: relayDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
  detached: true
});

p.unref();

let out = '';
p.stdout.on('data', d => { out += d.toString(); process.stdout.write(d); });
p.stderr.on('data', d => { out += '[ERR] ' + d.toString(); process.stderr.write(d); });

p.on('exit', (code) => {
  console.error(`[launcher] Relay exited with code ${code}`);
});

// Keep alive
setInterval(() => {}, 60000);

console.error(`[launcher] Relay started, PID: ${p.pid}`);
