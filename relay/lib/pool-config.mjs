/**
 * relay/lib/pool-config.mjs — Central Postgres pool tuning
 *
 * SINGLE source of truth for connection-pool sizing across the whole stack.
 * Previously each consumer hardcoded its own `max` (5, 20, 25, 2, 3...), and
 * the theoretical sum (~110) could exceed a 100-connection Postgres limit,
 * causing "too many clients" / connection-exhaustion on the write path.
 *
 * Budget (max_connections = 200 on this host):
 *   relay shared pool (db.mjs)        20
 *   relay localDb pool (localDb.mjs)  20
 *   local-sb REST pool                 25
 *   local-sb shared pool               20
 *   MCP servers (cuttlefish, claws, suite)  5 each = 15
 *   ad-hoc (server.js, workflow, registry)   2+3+5 = 10
 *   headroom / other                   90
 *   ─────────────────────────────────────
 *   TOTAL budgeted                    110  (well under 200)
 *
 * All values are overridable via env so a single tuning knob can rescale the
 * whole stack without editing code.
 */

const DEFAULT_MAX = 20;

// Per-consumer pool sizes. Env override: POOL_MAX_<NAME> (e.g. POOL_MAX_RELAY).
function poolMax(name, fallback) {
  const v = process.env[`POOL_MAX_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  if (v && !Number.isNaN(parseInt(v, 10))) return parseInt(v, 10);
  return fallback ?? DEFAULT_MAX;
}

export const POOL_CONFIG = {
  relay:      { max: poolMax('relay', 20), idleTimeoutMillis: 60_000, connectionTimeoutMillis: 5_000 },
  localDb:    { max: poolMax('localdb', 20), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 },
  localSb:    { max: poolMax('localsb', 20), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 },
  rest:       { max: poolMax('rest', 25), idleTimeoutMillis: 30_000 },
  mcp:        { max: poolMax('mcp', 5), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 },
  workflow:   { max: poolMax('workflow', 3), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 },
  adhoc:      { max: poolMax('adhoc', 2), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 },
};

export default POOL_CONFIG;
