/**
 * relay/lib/db.mjs — Shared Postgres connection pool
 *
 * SINGLE source of truth for all database connections across the relay.
 * Prevents "too many clients" by ensuring all consumers share one pool
 * instead of each creating their own (which was the root cause of the
 * connection exhaustion bug fixed on July 16-17, 2026).
 *
 * Auto-recovery: if the pool's connections go stale (PG-side idle timeout),
 * a periodic health check detects it and recreates the pool automatically
 * without requiring a relay restart.
 */

import pg from 'pg';
const { Pool } = pg;

const DB_URL = process.env.LOCAL_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';

let _pool = null;
let _healthTimer = null;
let _recovering = false;

/**
 * Create a new pool with the standard config.
 */
function createPool() {
  const p = new Pool({
    connectionString: DB_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });

  p.on('error', (err) => {
    console.error('[db] idle client error:', err?.message || err);
  });

  return p;
}

/**
 * Get the shared connection pool. Creates it once on first call.
 */
export function getPool() {
  if (_pool) return _pool;
  _pool = createPool();
  startHealthCheck();
  return _pool;
}

/**
 * Periodically check that the pool can actually acquire a connection.
 * If it fails, drain the old pool and create a fresh one.
 * Runs every 60 seconds.
 */
function startHealthCheck() {
  if (_healthTimer) clearInterval(_healthTimer);
  _healthTimer = setInterval(async () => {
    if (_recovering) return;
    try {
      const c = await _pool.connect();
      await c.query('SELECT 1');
      c.release();
    } catch (err) {
      console.error('[db] Pool health check failed — recreating pool:', err.message);
      _recovering = true;
      try {
        await _pool.end();
      } catch (_) {}
      _pool = createPool();
      _recovering = false;
      console.log('[db] Pool recreated successfully');
    }
  }, 60_000);
  // Don't let the timer keep the process alive
  if (_healthTimer && _healthTimer.unref) _healthTimer.unref();
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
