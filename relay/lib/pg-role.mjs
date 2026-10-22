/**
 * relay/lib/pg-role.mjs — the database should know the person who owns the machine.
 *
 * WHAT WAS BROKEN
 *
 * The local PostgreSQL cluster has exactly one superuser role: `postgres`.
 * Every connection string in this project says so explicitly —
 * `postgres://postgres@127.0.0.1:5432/xmrt_suite` — because the cluster
 * was initialised without a role for the operating system's user.
 *
 * That works right up until something connects WITHOUT naming a user. Then
 * libpq falls back to the OS username, and the cluster answers:
 *
 *     FATAL: role "PureTrek" does not exist
 *
 * which is what a test run without a connection string hit. The same thing
 * happens to `psql` opened in a terminal, to pgAdmin, and to any ad-hoc
 * script. The person who owns the machine is, to the database, nobody.
 *
 * WHAT THIS DOES
 *
 * It makes sure a login role exists for the OS user, with the same
 * authority the rest of the stack uses. The cluster's pg_hba.conf is `trust`
 * for local connections, so the role needs no password and cannot be used
 * from off the machine — the role is not a new way in, it is the same way
 * in that already exists.
 *
 * It runs at boot from relay/start-pg.mjs, so it survives the cluster being
 * re-initialised. A role that only exists until the next rebuild is a role
 * that will bite again.
 */

import os from 'os';
import pg from 'pg';

/** The cluster's admin connection. `postgres` is the cluster's own superuser. */
export const ADMIN_URL = 'postgres://postgres@127.0.0.1:5432/xmrt_suite';

/**
 * Postgres identifiers: letters, digits, underscore, dollar. Anything else
 * is quoted, but a name with a quote or a newline in it is more likely to be
 * a mistake than a real account, so it is refused rather than escaped.
 */
const SAFE_ROLE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function osRoleName() {
  try {
    return (os.userInfo().username || '').trim();
  } catch {
    return '';
  }
}

/**
 * Ensure the OS user has a login role in the local cluster.
 *
 * Idempotent, and safe to call when the cluster is not up yet: it returns a
 * reason instead of throwing, because the caller is a boot script and a
 * database that is still starting is not a failure worth stopping for.
 */
export async function ensureOsUserRole({ port = 5432, logger = console } = {}) {
  const role = osRoleName();
  if (!role) return { ok: false, reason: 'no OS username available' };
  if (!SAFE_ROLE.test(role)) {
    return { ok: false, reason: `the OS username is not a valid role name: ${JSON.stringify(role)}` };
  }

  const client = new pg.Client({
    connectionString: `postgres://postgres@127.0.0.1:${port}/xmrt_suite`,
    connectionTimeoutMillis: 5000,
  });

  let created = false;
  let granted = 0;
  try {
    await client.connect();
    const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (existing.rows.length) {
      // The role exists. Make sure it can actually log in: a role created
      // for something else and left NOLOGIN would fail the same way.
      await client.query(`ALTER ROLE "${role}" WITH LOGIN`);
    } else {
      // SUPERUSER, deliberately. Every component in this stack connects as
      // the `postgres` superuser and runs migrations that create schemas,
      // tables and indexes. A lesser role would be able to read the data
      // and not be able to work on it, which is the worst of both worlds:
      // it would look like the database is broken.
      await client.query(`CREATE ROLE "${role}" WITH LOGIN SUPERUSER`);
      created = true;
    }

    // Grant on every database, so a role that predates a new database is
    // not left unable to reach it.
    const dbs = await client.query('SELECT datname FROM pg_database WHERE datistemplate = false');
    for (const db of dbs.rows) {
      await client.query(`GRANT ALL PRIVILEGES ON DATABASE "${db.datname}" TO "${role}"`);
      granted++;
    }
    await client.end();
  } catch (e) {
    try { await client.end(); } catch { /* already closed */ }
    return { ok: false, reason: e.message, role };
  }

  const summary = { ok: true, role, created, granted };
  if (created) {
    logger.log?.(`[pg-role] created login role "${role}" in the local cluster`);
  } else {
    logger.log?.(`[pg-role] role "${role}" is present (${granted} database grant(s))`);
  }
  return summary;
}
