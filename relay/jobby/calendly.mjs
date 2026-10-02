/**
 * relay/jobby/calendly.mjs — OAuth and API for a candidate's own Calendly
 *
 * What this is for: a recruiter asks for a call and the candidate currently has to
 * negotiate times in a thread. Connecting their own Calendly turns that into one
 * link, using a calendar they already pay for and already trust. It is also the
 * only third-party account this touches that the candidate chose to connect, so
 * the scopes are the minimum that does the job and the token never leaves the
 * server.
 *
 * Endpoints, scopes and behaviour below are taken from Calendly's own
 * documentation rather than from memory, because three of them differ from a
 * conventional OAuth provider and getting any of them wrong fails silently:
 *
 *   authorize  https://auth.calendly.com/oauth/authorize
 *   token      POST https://auth.calendly.com  (base host, not a /oauth/token path)
 *   scopes     space-separated on the authorize URL, explicitly approved at app
 *               creation - a new app is granted nothing until scopes are set
 *   PKCE       required, S256, verifier stored against the state row
 *   refresh    SINGLE-USE and rotating. A refresh token is revoked the moment it
 *               is exchanged; a spent one fails with invalid_grant. Calendly's
 *               enforcement date for this was 2026-08-31, so it is current
 *               behaviour, not a future migration.
 */

import * as store from './calendly-store.mjs';
import { newPkceVerifier, pkceChallenge, encryptionAvailable } from './secrets.mjs';

const AUTHORIZE_URL = 'https://auth.calendly.com/oauth/authorize';
const TOKEN_URL = 'https://auth.calendly.com';
const API_BASE = 'https://api.calendly.com';

/**
 * The minimum that lets Jobby show availability and hand over a booking link.
 *
 * Deliberately not `scheduled_events:write` or `scheduling_links:write`. Writing
 * would let Jobby book a candidate's time without asking, which is not a thing
 * an agent should be able to do on its own - and a scope not requested here cannot
 * be exercised later, because Calendly grants nothing that was not approved when
 * the app was created.
 */
export const SCOPES = [
  'users:read',
  'event_types:read',
  'availability:read',
  'scheduled_events:read',
];

const STATE_TTL_MS = 10 * 60 * 1000;
// Refresh a little before expiry rather than on it, so a call never starts with a
// token that expires mid-request.
const REFRESH_SKEW_MS = 60 * 1000;

/**
 * Refreshes in flight, keyed by account id.
 *
 * Two concurrent tool calls would otherwise both see a stale token and both spend
 * a refresh. With single-use refresh tokens, the second one presents a token the
 * first has just invalidated and gets invalid_grant - so the connection breaks
 * itself under exactly the load where it is being used. This collapses the
 * concurrent refreshes into one round trip.
 */
const refreshInFlight = new Map();

export function isConfigured() {
  return Boolean(clientId() && clientSecret());
}

export function configuration() {
  return {
    configured: isConfigured(),
    clientIdPresent: Boolean(clientId()),
    clientSecretPresent: Boolean(clientSecret()),
    redirectUri: redirectUri(),
    scopes: SCOPES,
    tokensEncrypted: encryptionAvailable(),
  };
}

function clientId() {
  return String(process.env.CALENDLY_CLIENT_ID || '').trim();
}
function clientSecret() {
  return String(process.env.CALENDLY_CLIENT_SECRET || '').trim();
}
function redirectUri() {
  // A stated value always wins, so the sandbox/production difference can be
  // changed without a code edit. Calendly requires HTTPS in production and allows
  // http://localhost only in sandbox, so this is per-environment on purpose.
  const stated = String(process.env.CALENDLY_REDIRECT_URI || '').trim();
  if (stated) return stated;
  const base = String(process.env.PUBLIC_RELAY_URL || 'https://relay.mobilemonero.com')
    .replace(/\/+$/, '');
  return `${base}/api/jobby/calendly/callback`;
}

function requireConfig() {
  if (!isConfigured()) {
    const err = new Error(
      'Calendly is not configured: set CALENDLY_CLIENT_ID and CALENDLY_CLIENT_SECRET');
    err.code = 'calendly_not_configured';
    throw err;
  }
}

/* ── Step 1: send the browser to Calendly ─────────────────────────────────── */

export async function beginAuth(clientId_, { redirectTo = null } = {}) {
  requireConfig();
  const state = store.newState();
  const verifier = newPkceVerifier();
  // The verifier goes in the row, not a closure, because the browser leaves this
  // process between here and the callback.
  await store.putState(state, clientId_, redirectTo, verifier);

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  // PKCE, S256. Required by Calendly, and it is what stops an intercepted
  // authorization code from being redeemable by anyone else.
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  return { url: url.toString(), state, redirectUri: redirectUri() };
}

/* ── Step 2: swap the code for tokens, identify the account, store it ────── */

export async function completeAuth({ code, state }) {
  requireConfig();
  const row = await store.consumeState(state);
  if (!row) {
    // Either never issued or already redeemed. Redeeming twice is the case worth
    // distinguishing, because a user who clicked twice should be told to retry
    // rather than left with a connection that half-worked.
    const err = new Error('This authorization link has already been used or has expired. Start again.');
    err.code = 'bad_state';
    throw err;
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: clientId(),
    client_secret: clientSecret(),
    // Required, and required to match the one sent in step 1.
    code_verifier: row.code_verifier || '',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Calendly rejected the authorization: ${json.error || res.status}`);
    err.code = json.error || 'token_exchange_failed';
    throw err;
  }

  const me = await getCurrentUser(json.access_token);
  const saved = await store.saveAccount(row.client_id, {
    calendlyUserUri: me.resource.uri,
    schedulingUrl: me.resource.scheduling_url,
    timezone: me.resource.timezone,
    email: me.resource.email,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    scopes: scopeList(json.scope, SCOPES),
    expiresAt: expiresAtFrom(json.expires_in),
  });
  return { saved, redirectTo: row.redirect_to };
}

function scopeList(raw, fallback) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) return raw.trim().split(/\s+/);
  // A response with no scope field is not a reason to store nothing: the scopes
  // sent in the request were the ones granted, and an empty array reads as "no
  // access" in the status panel.
  return fallback;
}

function expiresAtFrom(expiresIn) {
  const n = Number(expiresIn);
  return Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 1000) : null;
}

/* ── Token refresh, with rotation handled correctly ───────────────────────── */

/**
 * An access token that is current, refreshing first if it is about to expire.
 *
 * This is the one function that must never be retried with a token it has already
 * spent, so the refresh is deduped and the stored refresh token is overwritten
 * before this returns.
 */
export async function accessToken(clientId_) {
  const account = await store.getActiveAccount(clientId_);
  if (!account) {
    const err = new Error('No Calendly account is connected.');
    err.code = 'not_connected';
    throw err;
  }
  if (account.accessToken && account.expiresAt
    && new Date(account.expiresAt).getTime() - REFRESH_SKEW_MS > Date.now()) {
    return account.accessToken;
  }
  if (!account.refreshToken) {
    const err = new Error('The Calendly connection has no refresh token; reconnect it.');
    err.code = 'no_refresh_token';
    throw err;
  }

  const existing = refreshInFlight.get(account.id);
  if (existing) return existing;

  const work = (async () => {
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: account.refreshToken,
          client_id: clientId(),
          client_secret: clientSecret(),
        }),
        signal: AbortSignal.timeout(20000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // invalid_grant is the expected consequence of a spent token, and it means
        // the account needs a human to re-authorise. Anything else is recorded
        // against the account so the status panel can show it.
        const spent = json.error === 'invalid_grant';
        await store.markAccountError(account.id, json.error || `HTTP ${res.status}`);
        const err = new Error(spent
          ? 'The Calendly connection needs to be re-authorised.'
          : `Calendly token refresh failed: ${json.error || res.status}`);
        err.code = spent ? 'reauth_required' : 'refresh_failed';
        throw err;
      }
      // Overwrite both, unconditionally, before anything else can ask again.
      await store.updateTokens(account.id, {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: expiresAtFrom(json.expires_in),
      });
      return json.access_token;
    } finally {
      refreshInFlight.delete(account.id);
    }
  })();

  refreshInFlight.set(account.id, work);
  return work;
}

/* ── API calls ────────────────────────────────────────────────────────────── */

/** GET /users/me - who am I, and what is the link a recruiter should be sent. */
export async function getCurrentUser(token) {
  const res = await fetch(`${API_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Calendly /users/me failed: ${json.message || res.status}`);
    err.code = 'api_error';
    throw err;
  }
  return json;
}

/** The caller's own event types - "30 minute recruiter call", and its link. */
export async function listEventTypes(clientId_, { active = true } = {}) {
  const token = await accessToken(clientId_);
  const url = new URL(`${API_BASE}/event_types`);
  url.searchParams.set('user', await userUriFor(clientId_));
  url.searchParams.set('active', String(active));
  url.searchParams.set('count', '50');
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Calendly /event_types failed: ${json.message || res.status}`);
    err.code = 'api_error';
    throw err;
  }
  return json.collection || [];
}

/** Upcoming events, so the portal can show what is already booked. */
export async function listScheduledEvents(clientId_, { minStartTime, count = 20 } = {}) {
  const token = await accessToken(clientId_);
  const url = new URL(`${API_BASE}/scheduled_events`);
  url.searchParams.set('user', await userUriFor(clientId_));
  url.searchParams.set('status', 'active');
  url.searchParams.set('sort', 'start_time:asc');
  url.searchParams.set('count', String(Math.min(Number(count) || 20, 100)));
  if (minStartTime) url.searchParams.set('min_start_time', new Date(minStartTime).toISOString());
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Calendly /scheduled_events failed: ${json.message || res.status}`);
    err.code = 'api_error';
    throw err;
  }
  return json.collection || [];
}

async function userUriFor(clientId_) {
  const account = await store.getActiveAccount(clientId_);
  if (!account) {
    const err = new Error('No Calendly account is connected.');
    err.code = 'not_connected';
    throw err;
  }
  return account.calendlyUserUri;
}

/** Available start times for one event type over a window - the actual answer. */
export async function listAvailableTimes(clientId_, { eventType, startTime, endTime }) {
  const token = await accessToken(clientId_);
  const url = new URL(`${API_BASE}/event_type_available_times`);
  url.searchParams.set('event_type', eventType);
  url.searchParams.set('start_time', new Date(startTime).toISOString());
  url.searchParams.set('end_time', new Date(endTime).toISOString());
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Calendly available times failed: ${json.message || res.status}`);
    err.code = 'api_error';
    throw err;
  }
  return json.collection || [];
}
