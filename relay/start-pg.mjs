#!/usr/bin/env node
/**
 * relay/start-pg.mjs — Launch Postgres with no visible console windows
 *
 * Replaces the old start-pg-hidden.vbs wrapper. Uses Node's spawn with
 * windowsHide: true to suppress the checkpointer / bgwriter / wal_writer
 * child console windows that otherwise pop up on Windows.
 *
 * Started by supervisor.mjs as the 'pg' service.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PG_BIN = join(ROOT, 'pg', 'bin', 'postgres.exe');
const PG_DATA = join(ROOT, 'pg', 'data');

if (!existsSync(PG_BIN)) {
  console.error(`[start-pg] FATAL: postgres binary not found at ${PG_BIN}`);
  process.exit(1);
}
if (!existsSync(PG_DATA)) {
  console.error(`[start-pg] FATAL: pg data dir not found at ${PG_DATA}`);
  process.exit(1);
}

console.log(`[start-pg] starting postgres: ${PG_BIN} -D ${PG_DATA} -p 5432`);

// Stale postmaster.pid cleanup
const PID_FILE = join(PG_DATA, 'postmaster.pid');
if (existsSync(PID_FILE)) {
  try {
    const fs = await import('node:fs');
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim().split('\n')[0], 10);
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        // process exists — don't start a second one
        console.log(`[start-pg] postgres already running (pid ${pid}), exiting`);
        process.exit(0);
      } catch {
        // pid is dead — clean stale file
        fs.unlinkSync(PID_FILE);
        console.log(`[start-pg] removed stale postmaster.pid (pid ${pid} not running)`);
      }
    }
  } catch (e) {
    console.log(`[start-pg] could not inspect postmaster.pid: ${e.message}`);
  }
}

const child = spawn(PG_BIN, ['-D', PG_DATA, '-p', '5432'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'ignore'],
  windowsHide: true,
  detached: false,
});

console.log(`[start-pg] postgres spawned (pid ${child.pid})`);

child.on('error', (err) => {
  console.error(`[start-pg] spawn error: ${err.message}`);
  process.exit(1);
});

// If parent dies, take postgres with us — supervisor will restart both
process.on('SIGINT', () => { try { child.kill('SIGINT'); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch {} process.exit(0); });

// Keep the wrapper process alive until postgres exits
child.on('exit', (code, signal) => {
  console.log(`[start-pg] postgres exited (code=${code}, signal=${signal})`);
  process.exit(code || 0);
});
