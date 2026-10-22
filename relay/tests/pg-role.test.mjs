#!/usr/bin/env node
// Guards the operator's database role.
//
// The local cluster has one superuser — `postgres` — and every connection
// string in this project names it explicitly. Anything that connects
// WITHOUT naming a user falls back to the OS username, and the cluster
// answers `FATAL: role "<os user>" does not exist`.
//
// That is not a cosmetic problem. It is what a `psql` in a terminal hits,
// what pgAdmin hits, and what a test run without a connection string hit —
// the last of which reported a failure that said nothing at all about the
// thing being tested.
//
// These checks prove the fix holds: the role exists, it can log in, and
// the boot path creates it so it survives the cluster being rebuilt.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { ensureOsUserRole, osRoleName } from '../lib/pg-role.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const role = osRoleName();

section('the operator has a role in the cluster');
{
  check('the OS username is readable', !!role, role);
  check('the role exists', await (async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });
    try {
      const r = await pool.query('SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = $1', [role]);
      return r.rows.length === 1 && r.rows[0].rolcanlogin === true;
    } finally { await pool.end().catch(() => {}); }
  })());
}

section('a client that names no user can still log in');
{
  // Exactly what a bare psql does: a host, a port, a database, and no user.
  const pool = new pg.Pool({ host: '127.0.0.1', port: 5432, database: 'xmrt_suite', connectionTimeoutMillis: 5000 });
  try {
    const me = await pool.query('SELECT current_user');
    check('the connection lands as the OS user', me.rows[0].current_user === role, me.rows[0]);
    const read = await pool.query('SELECT COUNT(*)::int c FROM public.eliza_activity_log');
    check('and can read the fleet tables', read.rows[0].c >= 0, read.rows[0].c);
  } catch (e) {
    check('the connection lands as the OS user', false, e.message);
  } finally {
    await pool.end().catch(() => {});
  }
}

section('the role is created at boot, not by hand');
{
  const startPg = readFileSync(new URL('../start-pg.mjs', import.meta.url), 'utf8');
  check('start-pg.mjs ensures the role', startPg.includes('ensureOperatorRole'));
  // Both paths matter: the one that spawns postgres, and the one that finds
  // it already running. The second is the path the supervisor takes on every
  // boot after the first, and it is the path that would otherwise skip it.
  const alreadyRunning = startPg.indexOf('postgres already running');
  const callInThatPath = startPg.indexOf('await ensureOperatorRole();');
  check('the already-running path ensures it too',
    alreadyRunning >= 0 && callInThatPath >= 0 && callInThatPath > alreadyRunning,
    { alreadyRunning, callInThatPath });
  check('and so does the path that spawns postgres',
    startPg.includes('ensureOperatorRole();') && startPg.lastIndexOf('ensureOperatorRole();') > startPg.indexOf('const child = spawn('));
  check('a failure in the role check cannot take the database down',
    /catch \(e\) \{[\s\S]{0,120}console\.warn/.test(startPg));
}

section('the check is idempotent');
{
  const again = await ensureOsUserRole({ logger: { log() {} } });
  check('running it again is safe', again.ok === true, again);
  check('and does not recreate the role', again.created === false, again);
}

console.log(fails === 0
  ? '\n  the person who owns the machine can log into the database'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
