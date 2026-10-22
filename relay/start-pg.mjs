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
import { existsSync, statSync, openSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PG_BIN = join(ROOT, 'pg', 'bin', 'postgres.exe');
const PG_DATA = join(ROOT, 'pg', 'data');
const LOG_DIR = join(ROOT, 'logs');
const PG_STDERR_LOG = join(LOG_DIR, 'pg-stderr.log');

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
// ── Make sure the person who owns the machine can log in ──────────────────
//
// The cluster has one superuser, `postgres`, and every connection string in
// this project names it. Anything that connects WITHOUT naming a user falls
// back to the OS username and is told the role does not exist — which is
// what a test run without a connection string, a `psql` in a terminal, and
// pgAdmin all hit.
//
// So the role is made here, at boot, where it survives the cluster being
// re-initialised. A role created by hand lasts until the next rebuild, and
// a role that only exists until the next rebuild is a role that will bite
// again.
//
// It must never be able to take the database down: every failure here is
// logged and swallowed. A missing role is an inconvenience; a boot script
// that throws is an outage.
async function ensureOperatorRole() {
  try {
    const { ensureOsUserRole } = await import('./lib/pg-role.mjs');
    // Postgres needs a moment before it accepts connections. Retry for a
    // while, because the alternative is a boot race: the role is missing on
    // the one boot where the cluster was rebuilt.
    for (let attempt = 1; attempt <= 12; attempt++) {
      const result = await ensureOsUserRole({ logger: console });
      if (result.ok) return;
      if (attempt === 12) {
        console.warn(`[start-pg] could not create the operator role: ${result.reason}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e) {
    console.warn(`[start-pg] operator role check failed: ${e.message}`);
  }
}

if (existsSync(PID_FILE)) {
  try {
    const fs = await import('node:fs');
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim().split('\n')[0], 10);
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        // process exists — don't start a second one
        console.log(`[start-pg] postgres already running (pid ${pid}), exiting`);
        // The cluster is already up, so the operator's role can be ensured
        // right now. This path is the one that runs when the supervisor
        // re-launches the wrapper around a live cluster, and it is exactly
        // the path that would otherwise skip the role.
        await ensureOperatorRole();
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

// Ensure logs dir exists
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// Open pg stderr log (truncate if >5MB, else append) so postgres crash/fatal
// messages that appear before logging_collector is initialized are preserved.
let stderrFd = null;
try {
  if (existsSync(PG_STDERR_LOG)) {
    const st = statSync(PG_STDERR_LOG);
    stderrFd = openSync(PG_STDERR_LOG, st.size > 5 * 1024 * 1024 ? 'w' : 'a');
  } else {
    stderrFd = openSync(PG_STDERR_LOG, 'w');
  }
} catch (e) {
  console.error(`[start-pg] could not open pg-stderr.log: ${e.message}`);
}

const child = spawn(PG_BIN, ['-D', PG_DATA, '-p', '5432'], {
  cwd: ROOT,
  stdio: ['ignore', stderrFd || 'ignore', stderrFd || 'ignore'],
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
// The child exited before we could hand it the operator's role — there is
// nothing to do.
child.on('exit', (code, signal) => {
  console.log(`[start-pg] postgres exited (code=${code}, signal=${signal})`);
  process.exit(code || 0);
});

ensureOperatorRole();

