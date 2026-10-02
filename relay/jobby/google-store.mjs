/**
 * relay/jobby/google-store.mjs — Persistence for Google connections
 *
 * Deliberately separate from store.mjs: token columns must never be selected
 * into a response object, and keeping them in their own module makes that
 * structurally obvious rather than a rule to remember.
 *
 * Note the column list in statusFor() — it is explicit and excludes every
 * *_enc column. Nothing in this module returns a sealed buffer to a caller that
 * could serialise it.
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';

let pool = null;
async function db() {
  if (!pool) {
    const { Pool } = pg;
    pool = new Pool({
      connectionString: process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
      max: 3,
    });
  }
  return pool;
}
export async function closeGoogleStore() {
  if (pool) { await pool.end(); pool = null; }
}

export function newState() {
  return randomBytes(32).toString('base64url');
}

export async function putState(state, clientId, redirectTo = null) {
  const p = await db();
  await p.query(
    'INSERT INTO app.job_oauth_states (state, client_id, redirect_to) VALUES ($1,$2,$3)',
    [state, clientId, redirectTo],
  );
  // Housekeeping: a state is worthless after ten minutes.
  await p.query(`DELETE FROM app.job_oauth_states WHERE created_at < now() - INTERVAL '1 hour'`);
}

/** Atomically claim a state. Returns null if unknown or already used. */
export async function consumeState(state) {
  const p = await db();
  const { rows } = await p.query(
    `UPDATE app.job_oauth_states SET consumed_at = now()
     WHERE state = $1 AND consumed_at IS NULL
     RETURNING client_id, redirect_to, created_at, consumed_at`,
    [state],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    clientId: r.client_id,
    redirectTo: r.redirect_to,
    createdAt: new Date(r.consumed_at || r.created_at).getTime(),
  };
}

export async function saveAccount(clientId, account) {
  const p = await db();
  // One active account per client: retire any previous connection first, so
  // reconnecting replaces rather than accumulates.
  await p.query(
    'UPDATE app.job_google_accounts SET is_active = false, revoked_at = now() WHERE client_id = $1 AND is_active',
    [clientId],
  );
  const { rows } = await p.query(
    `INSERT INTO app.job_google_accounts
       (client_id, google_user_id, email, access_token_enc, refresh_token_enc, scopes, expires_at, last_refreshed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     RETURNING id, email, scopes`,
    [clientId, account.googleUserId, account.email,
      account.accessToken, account.refreshToken, account.scopes, account.expiresAt],
  );
  return rows[0];
}

/** The sealed columns, for internal use only. Never return this to a client. */
export async function getActiveAccount(clientId) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, client_id, google_user_id, email, access_token_enc, refresh_token_enc,
            scopes, expires_at, is_active, revoked_at, last_error
     FROM app.job_google_accounts
     WHERE client_id = $1 AND is_active
     ORDER BY id DESC LIMIT 1`,
    [clientId],
  );
  return rows[0] || null;
}

/** Everything safe to show a user: no token material. */
export async function statusFor(clientId) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, email, scopes, expires_at, connected_at, last_refreshed_at,
            revoked_at, is_active, last_error
     FROM app.job_google_accounts
     WHERE client_id = $1 ORDER BY id DESC LIMIT 1`,
    [clientId],
  );
  const a = rows[0];
  if (!a) return { connected: false };
  return {
    connected: a.is_active === true,
    email: a.email,
    scopes: a.scopes || [],
    connectedAt: a.connected_at,
    lastRefreshedAt: a.last_refreshed_at,
    revokedAt: a.revoked_at,
    lastError: a.last_error,
    // Telling the user the token is stale before it bites them.
    tokenExpired: a.expires_at ? new Date(a.expires_at).getTime() <= Date.now() : null,
  };
}

export async function updateTokens(accountId, { accessToken, expiresAt }) {
  const p = await db();
  await p.query(
    `UPDATE app.job_google_accounts
     SET access_token_enc = $2, expires_at = $3, last_refreshed_at = now(),
         last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [accountId, accessToken, expiresAt],
  );
}

export async function markAccountError(accountId, error) {
  const p = await db();
  await p.query(
    'UPDATE app.job_google_accounts SET last_error = $2, updated_at = now() WHERE id = $1',
    [accountId, String(error || '').slice(0, 500)],
  );
}

export async function revokeAccount(accountId, reason) {
  const p = await db();
  // Tokens are overwritten with NULL on disconnect: a revoked account should
  // not leave a usable credential sitting in the table.
  await p.query(
    `UPDATE app.job_google_accounts
     SET is_active = false, revoked_at = now(), last_error = $2,
         access_token_enc = NULL, refresh_token_enc = NULL, updated_at = now()
     WHERE id = $1`,
    [accountId, reason || null],
  );
}

export async function recordSent({ clientId, accountId, to, subject, threadId, messageId, status, error }) {
  const p = await db();
  const { rows } = await p.query(
    `INSERT INTO app.job_sent_messages
       (client_id, account_id, to_address, subject, thread_id, message_id, status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [clientId, accountId, to, subject, threadId, messageId, status || 'sent', error || null],
  );
  return rows[0];
}

export async function listSent(clientId, limit = 30) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, to_address, subject, thread_id, message_id, status, error, created_at
     FROM app.job_sent_messages WHERE client_id = $1 ORDER BY id DESC LIMIT $2`,
    [clientId, limit],
  );
  return rows;
}

/** Record a reply as seen so Jobby does not re-handle the same one. */
export async function markReplySeen({ clientId, threadId, messageId, from, snippet }) {
  const p = await db();
  const { rows } = await p.query(
    `INSERT INTO app.job_seen_replies (client_id, thread_id, message_id, from_address, snippet)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (client_id, message_id) DO NOTHING
     RETURNING id`,
    [clientId, threadId, messageId, from || null, String(snippet || '').slice(0, 500)],
  );
  // No returned row means it was already recorded.
  return rows.length > 0;
}

export async function seenReplyIds(clientId, messageIds) {
  if (!messageIds?.length) return new Set();
  const p = await db();
  const { rows } = await p.query(
    'SELECT message_id FROM app.job_seen_replies WHERE client_id = $1 AND message_id = ANY($2::text[])',
    [clientId, messageIds],
  );
  return new Set(rows.map(r => r.message_id));
}

export async function listSeenReplies(clientId, limit = 30) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, thread_id, message_id, from_address, snippet, seen_at
     FROM app.job_seen_replies WHERE client_id = $1 ORDER BY id DESC LIMIT $2`,
    [clientId, limit],
  );
  return rows;
}
