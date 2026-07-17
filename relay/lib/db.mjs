/**
 * relay/lib/db.mjs — Shared Postgres connection pool
 *
 * SINGLE source of truth for all database connections across the relay.
 * Prevents "too many clients" by ensuring all consumers share one pool
 * instead of each creating their own (which was the root cause of the
 * connection exhaustion bug fixed on July 16-17, 2026).
 *
 * History:
 * - July 16: queryLocalPg() created new PgClient per call → "too many clients"
 * - July 17: Fixed with PgPool in server.js, but cron-engine and localDb
 *            still had their own separate pools → 3 pools × 5 max = 15 potential
 *            connections, still exhausting the pool under load
 * - July 17: Consolidated into this single shared module
 */

import pg from 'pg';
const { Pool } = pg;

const DB_URL = process.env.LOCAL_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';

let _pool = null;

/**
 * Get the shared connection pool. Creates it once on first call.
 * Max 10 connections — enough for relay + cron + localDb concurrently
 * without exhausting Postgres's default 100 connection limit.
 */
export function getPool() {
  if (_pool) return _pool;
  _pool = new Pool({
    connectionString: DB_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });
  _pool.on('error', (err) => {
    console.error('[db] idle client error:', err?.message || err);
  });
  return _pool;
}

/**
 * Run a parameterized query. Returns pg query result object
 * with .rows, .rowCount, etc.
 */
export async function query(sql, params) {
  const pool = getPool();
  const c = await pool.connect();
  try {
    return await c.query(sql, params);
  } finally {
    c.release();
  }
}

/**
 * Run a query and return rows only.
 */
export async function queryRows(sql, params) {
  const result = await query(sql, params);
  return result.rows;
}

/**
 * Run a query and return the first row (or null).
 */
export async function queryOne(sql, params) {
  const rows = await queryRows(sql, params);
  return rows[0] || null;
}

export default { getPool, query, queryRows, queryOne };
