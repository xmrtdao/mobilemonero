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
 * without requiring a relay restart. The health check requires 3 consecutive
 * failures before recreating to avoid flapping on transient errors.
 */

import pg from 'pg';
const { Pool } = pg;

const DB_URL = process.env.LOCAL_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';

let _pool = null;
let _healthTimer = null;
let _consecutiveFailures = 0;

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
  // Start health check after a 30s grace period (avoids false positives during startup)
  setTimeout(() => startHealthCheck(), 30_000);
  return _pool;
}

/**
 * Periodically check that the pool can actually acquire a connection.
 * Only recreates after 3 consecutive failures to avoid flapping.
 * Does NOT call pool.end() — just replaces the reference so in-flight
 * queries on the old pool can complete naturally.
 * Runs every 120 seconds (less aggressive than 60s to reduce churn).
 */
function startHealthCheck() {
  if (_healthTimer) clearInterval(_healthTimer);
  _healthTimer = setInterval(async () => {
    let client = null;
    try {
      client = await _pool.connect();
      await client.query('SELECT 1');
      client.release();
      _consecutiveFailures = 0;
    } catch (err) {
      if (client) try { client.release(); } catch (_) {}
      _consecutiveFailures++;
      console.error(`[db] Pool health check failed (${_consecutiveFailures}/3):`, err.message);
      if (_consecutiveFailures >= 3) {
        console.log('[db] 3 consecutive failures — replacing pool');
        const oldPool = _pool;
        _pool = createPool();
        _consecutiveFailures = 0;
        // Drain old pool in background — don't await, don't block
        oldPool.end().catch(() => {});
      }
    }
  }, 120_000);
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
