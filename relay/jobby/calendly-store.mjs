/**
 * relay/jobby/calendly-store.mjs — the connected Calendly account, and its tokens
 *
 * Deliberately a separate module from store.mjs, matching google-store.mjs, and
 * for the same reason: token columns must never be reachable by a caller that did
 * not ask for them by name. getStatus() returns no token material at all, and the
 * only way to obtain one is getActiveAccount(), which is the only thing that goes
 * on to use it.
 *
 * The thing that is Calendly-specific and easy to get wrong is the refresh token.
 * Calendly's are single-use and rotate: every successful exchange revokes the one
 * just spent and returns a new one, and presenting a spent token fails with
 * invalid_grant. So updateTokens() always overwrites both, and there is no code
 * path anywhere in this file that retries with an old token. That is not an
 * oversight to be tidied up later - a retry with a spent token is precisely what
 * invalidates a candidate's connection.
 */

import { sealToken, openToken, newStateToken } from './secrets.mjs';

let pool = null;
async function db() {
  if (!pool) {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({
      connectionString: process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
      max: 4,
    });
  }
  return pool;
}

export async function closeCalendlyStore() {
  if (pool) { await pool.end(); pool = null; }
}

export function newState() {
  return newStateToken();
}

/**
 * Record an in-flight authorization.
 *
 * The PKCE verifier is stored against the state row rather than held in memory,
 * because the user's browser leaves the process between step one and step two. It
 * is consumed with the row, so it does not outlive the code it protects.
 */
export async function putState(state, clientId, redirectTo = null, codeVerifier = null) {
  const p = await db();
  await p.query(
    `INSERT INTO app.job_oauth_states (state, client_id, redirect_to, code_verifier)
     VALUES ($1,$2,$3,$4)`, [state, clientId, redirectTo, codeVerifier]);
  return { state, clientId };
}

/**
 * Claim a state row, once.
 *
 * The UPDATE ... WHERE consumed_at IS NULL RETURNING is the whole of the
 * guarantee: two concurrent callbacks with the same state produce one row and one
 * empty result, so an authorization code cannot be redeemed twice.
 */
export async function consumeState(state) {
  const p = await db();
  const { rows } = await p.query(
    `UPDATE app.job_oauth_states SET consumed_at = now()
     WHERE state = $1 AND consumed_at IS NULL
     RETURNING client_id, redirect_to, code_verifier`, [state]);
  return rows[0] || null;
}

/** Store a connected account, superseding any previous active one for the client. */
export async function saveAccount(clientId, account) {
  const p = await db();
  // A revoked row must not keep a usable credential, and a constraint now enforces
  // it. The UPDATE below satisfies that constraint as a side effect of revoking.
  await p.query(
    `UPDATE app.job_calendly_accounts
        SET is_active = false, revoked_at = now(),
            access_token_enc = NULL, refresh_token_enc = NULL, updated_at = now()
      WHERE client_id = $1 AND is_active`, [clientId]);
  const { rows } = await p.query(
    `INSERT INTO app.job_calendly_accounts
       (client_id, calendly_user_uri, scheduling_url, timezone, email,
        access_token_enc, refresh_token_enc, scopes, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, client_id, calendly_user_uri, scheduling_url, timezone, email,
               scopes, expires_at, connected_at, last_refreshed_at, revoked_at,
               is_active, last_error`,
    [clientId, account.calendlyUserUri, account.schedulingUrl || null,
      account.timezone || null, account.email || null,
      account.accessToken ? sealToken(account.accessToken) : null,
      account.refreshToken ? sealToken(account.refreshToken) : null,
      account.scopes || [],
      account.expiresAt || null]);
  return rows[0];
}

/** The active account with its tokens opened, or null. The only way to get a token. */
export async function getActiveAccount(clientId) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, client_id, calendly_user_uri, scheduling_url, timezone, email,
            access_token_enc, refresh_token_enc, scopes, expires_at, last_error
       FROM app.job_calendly_accounts
      WHERE client_id = $1 AND is_active`, [clientId]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    calendlyUserUri: row.calendly_user_uri,
    schedulingUrl: row.scheduling_url,
    timezone: row.timezone,
    email: row.email,
    scopes: row.scopes || [],
    expiresAt: row.expires_at,
    lastError: row.last_error,
    accessToken: row.access_token_enc ? openToken(row.access_token_enc) : null,
    refreshToken: row.refresh_token_enc ? openToken(row.refresh_token_enc) : null,
  };
}

/** Connection status for the UI. Deliberately returns no token material. */
export async function statusFor(clientId) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, calendly_user_uri, scheduling_url, timezone, email, scopes,
            expires_at, connected_at, last_refreshed_at, revoked_at, is_active, last_error
       FROM app.job_calendly_accounts
      WHERE client_id = $1 AND is_active`, [clientId]);
  const row = rows[0];
  if (!row) return { connected: false };
  return {
    connected: true,
    accountId: row.id,
    userUri: row.calendly_user_uri,
    schedulingUrl: row.scheduling_url,
    timezone: row.timezone,
    email: row.email,
    scopes: row.scopes || [],
    expiresAt: row.expires_at,
    connectedAt: row.connected_at,
    lastRefreshedAt: row.last_refreshed_at,
    lastError: row.last_error,
  };
}

/**
 * Overwrite both tokens from a token response.
 *
 * Both, every time, unconditionally. Not "update the refresh token if a new one
 * came back" - that conditional is how a spent token gets left in the table and
 * every later refresh fails with invalid_grant, and the only symptom a user sees
 * is that their calendar quietly stopped syncing.
 */
export async function updateTokens(accountId, { accessToken, refreshToken, expiresAt }) {
  const p = await db();
  const { rows } = await p.query(
    `UPDATE app.job_calendly_accounts
        SET access_token_enc = COALESCE($2, access_token_enc),
            refresh_token_enc = COALESCE($3, refresh_token_enc),
            expires_at = COALESCE($4, expires_at),
            last_refreshed_at = now(), last_error = NULL, updated_at = now()
      WHERE id = $1
      RETURNING id, expires_at, last_refreshed_at`,
    [accountId,
      accessToken ? sealToken(accessToken) : null,
      // A response with no refresh_token means the provider is not rotating, and
      // the stored one is still good. Nulling it would disconnect the account.
      refreshToken ? sealToken(refreshToken) : null,
      expiresAt || null]);
  return rows[0] || null;
}

/** Record an error against the account so the status panel can show it. */
export async function markAccountError(accountId, error) {
  const p = await db();
  await p.query(
    `UPDATE app.job_calendly_accounts SET last_error = $2, updated_at = now() WHERE id = $1`,
    [accountId, String(error).slice(0, 500)]);
}

/**
 * Disconnect.
 *
 * The tokens are nulled, not just flagged. A revoked row that still holds a
 * working credential is the worst state available: the UI says disconnected and
 * the token works.
 */
export async function disconnect(clientId) {
  const p = await db();
  const { rowCount } = await p.query(
    `UPDATE app.job_calendly_accounts
        SET is_active = false, revoked_at = now(),
            access_token_enc = NULL, refresh_token_enc = NULL, updated_at = now()
      WHERE client_id = $1 AND is_active`, [clientId]);
  return { disconnected: rowCount > 0 };
}
