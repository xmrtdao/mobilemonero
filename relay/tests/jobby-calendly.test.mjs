#!/usr/bin/env node
// Tests for the Calendly connection: PKCE, single-use refresh rotation, and the
// scopes requested.
//
// The rotation tests are the point of this file. Calendly revokes a refresh token
// the moment it is exchanged, and presenting a spent one fails with invalid_grant.
// An implementation that keeps the old token, or that retries a failed refresh,
// breaks the candidate's connection under exactly the load where it is being used
// - and the only symptom is a calendar that quietly stopped syncing.
import pg from 'pg';
import { getOrCreateClient, closeStore } from '../jobby/store.mjs';
import * as store from '../jobby/calendly-store.mjs';
import { closeCalendlyStore } from '../jobby/calendly-store.mjs';
// AUTHORIZE_URL and TOKEN_URL are deliberately not exported - they are not part
// of the module's surface, and the endpoints are asserted from source below
// rather than by importing them, so a rename cannot be satisfied by updating an
// import.
import { SCOPES, isConfigured, configuration } from '../jobby/calendly.mjs';

// The relay loads relay/.env into process.env at startup and lets it overwrite,
// because the local stack is canonical. A test that does not do the same cannot
// exercise token sealing at all: secrets.mjs reads JOBBY_TOKEN_KEY lazily and
// throws TOKEN_KEY_MISSING without it, so the sealing assertions below would be
// untestable rather than passing.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(RELAY_DIR, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 220)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const pool = new pg.Pool({
  connectionString: process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
});
const made = [];

async function client() {
  const key = `calendly-test-${Math.random().toString(36).slice(2)}`;
  const c = await getOrCreateClient(key, 'Calendly Test');
  made.push(c.id);
  return c;
}

section('the scopes requested are the minimum that does the job');
{
  // Calendly grants nothing that was not approved when the app was created, so a
  // scope not asked for here cannot be exercised later without a new app.
  check('read-only, nothing that can book time',
    SCOPES.every(s => s.endsWith(':read')), SCOPES);
  for (const needed of ['users:read', 'event_types:read', 'scheduled_events:read']) {
    check(`${needed} is requested`, SCOPES.includes(needed));
  }
  for (const forbidden of ['scheduled_events:write', 'scheduling_links:write',
    'event_types:write', 'data_compliance:write']) {
    check(`${forbidden} is NOT requested`, !SCOPES.includes(forbidden));
  }
  check('no duplicates', new Set(SCOPES).size === SCOPES.length, SCOPES);
}

section('the endpoints are the real ones, not conventional guesses');
{
  const src = (await import('node:child_process')).execFileSync('node', ['-e', `
    const fs = require('fs');
    process.stdout.write(fs.readFileSync('jobby/calendly.mjs', 'utf8'));
  `], { encoding: 'utf8' });
  check('authorize is auth.calendly.com/oauth/authorize',
    /const AUTHORIZE_URL = 'https:\/\/auth\.calendly\.com\/oauth\/authorize'/.test(src));
  // Not "/oauth/token" - Calendly's token endpoint is the bare host, which is the
  // detail a conventional OAuth assumption gets wrong.
  check('the token endpoint is the bare host, not /oauth/token',
    /const TOKEN_URL = 'https:\/\/auth\.calendly\.com'/.test(src)
    && !/const TOKEN_URL = '[^']*\/oauth\/token'/.test(src));
  check('the API base is api.calendly.com', /const API_BASE = 'https:\/\/api\.calendly\.com'/.test(src));
  check('PKCE is sent as S256', /code_challenge_method',?\s*'S256'/.test(src.replace(/set\(/g, 'set(')));
  check('scopes are space separated on the authorize URL',
    /SCOPES\.join\(' '\)/.test(src));
}

section('it refuses to pretend it is configured when it is not');
{
  const before = process.env.CALENDLY_CLIENT_ID;
  delete process.env.CALENDLY_CLIENT_ID;
  check('isConfigured() is false without a client id', isConfigured() === false);
  check('configuration() says so rather than throwing',
    configuration().configured === false && configuration().clientIdPresent === false);
  if (before) process.env.CALENDLY_CLIENT_ID = before;
}

section('a state row is claimed exactly once');
{
  const c = await client();
  const state = store.newState();
  const verifier = 'a-verifier-that-must-survive-the-redirect';
  await store.putState(state, c.id, '/back', verifier);

  const first = await store.consumeState(state);
  check('the first claim returns the row', first && first.client_id === c.id, first);
  check('and the PKCE verifier with it', first?.code_verifier === verifier, first?.code_verifier);
  check('and the return path', first?.redirect_to === '/back', first?.redirect_to);

  const second = await store.consumeState(state);
  check('a second claim with the same state returns nothing', second === null, second);
  // This is what stops an authorization code being redeemed twice.
}

section('tokens are sealed at rest and opened only where needed');
{
  const c = await client();
  await store.saveAccount(c.id, {
    calendlyUserUri: 'https://api.calendly.com/users/AAA111',
    schedulingUrl: 'https://calendly.com/joe-abc123',
    timezone: 'America/New_York',
    email: 'joe@example.com',
    accessToken: 'ACCESS-TOKEN-VALUE-abc123',
    refreshToken: 'REFRESH-TOKEN-VALUE-xyz789',
    scopes: SCOPES,
    expiresAt: new Date(Date.now() + 3600_000),
  });

  // Straight out of the table: not the plaintext.
  const raw = await pool.query(
    `SELECT access_token_enc, refresh_token_enc FROM app.job_calendly_accounts
      WHERE client_id = $1 AND is_active`, [c.id]);
  const sealed = raw.rows[0]?.access_token_enc;
  check('the stored token is not the plaintext',
    sealed && !sealed.toString('utf8').includes('ACCESS-TOKEN-VALUE'), sealed?.length);

  // The status endpoint must not carry token material at all.
  const status = await store.statusFor(c.id);
  check('statusFor never returns a token',
    !JSON.stringify(status).includes('ACCESS-TOKEN')
    && !JSON.stringify(status).includes('REFRESH-TOKEN'), Object.keys(status));

  // The one place that may open them.
  const account = await store.getActiveAccount(c.id);
  check('getActiveAccount returns the real access token',
    account?.accessToken === 'ACCESS-TOKEN-VALUE-abc123', account?.accessToken);
  check('and the real refresh token', account?.refreshToken === 'REFRESH-TOKEN-VALUE-xyz789');
  check('with the scheduling link, which is the point of connecting',
    account?.schedulingUrl === 'https://calendly.com/joe-abc123', account?.schedulingUrl);
}

section('a refresh overwrites both tokens, unconditionally');
{
  const c = await client();
  await store.saveAccount(c.id, {
    calendlyUserUri: 'https://api.calendly.com/users/BBB222',
    accessToken: 'ACCESS-1', refreshToken: 'REFRESH-1', scopes: SCOPES,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const acct = await store.getActiveAccount(c.id);

  // The rotation case: a new refresh token comes back, and the old one is spent.
  await store.updateTokens(acct.id, {
    accessToken: 'ACCESS-2', refreshToken: 'REFRESH-2',
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const after = await store.getActiveAccount(c.id);
  check('the new access token is stored', after.accessToken === 'ACCESS-2', after.accessToken);
  check('the new refresh token replaced the old one', after.refreshToken === 'REFRESH-2',
    after.refreshToken);
  check('the spent refresh token is gone, not kept as a fallback',
    after.refreshToken !== 'REFRESH-1', after.refreshToken);

  // A response with no refresh_token means the provider is not rotating. Nulling
  // the stored one would disconnect the account for no reason.
  await store.updateTokens(acct.id, { accessToken: 'ACCESS-3', refreshToken: null });
  const noRotation = await store.getActiveAccount(c.id);
  check('a response with no refresh token keeps the stored one',
    noRotation.refreshToken === 'REFRESH-2', noRotation.refreshToken);
  check('while still updating the access token', noRotation.accessToken === 'ACCESS-3');
}

section('the single-use trap is not coded anywhere');
{
  // A structural assertion, because this cannot be proven by running it: there is
  // no retry, and no path that re-sends a refresh token already presented.
  // Only comments are stripped.
  //
  // Strings are kept, because the identifiers this asserts on - invalid_grant,
  // reauth_required - live in string literals, and an earlier version removed
  // them and then could not find what it came to check.
  //
  // The order still matters: an earlier version stripped regex literals before
  // comments, and since a line comment begins "//" and a regex-literal stripper
  // runs from there to the next "/", it ate the comment opener and left the text
  // behind - which was the word being searched for. Comments first, and regex
  // literals left alone.
  const raw = (await import('node:child_process')).execFileSync('node', ['-e', `
    const fs = require('fs');
    const strip = (t) => t
      .replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ')
      .replace(/^\\s*\\/\\/.*$/gm, ' ');
    process.stdout.write(strip(fs.readFileSync('jobby/calendly.mjs', 'utf8'))
      + '\\n' + strip(fs.readFileSync('jobby/calendly-store.mjs', 'utf8')));
  `], { encoding: 'utf8' });

  check('no retry of a token exchange',
    !/\bretry\b|\battempt\s*<|for \(let attempt/.test(raw),
    (raw.match(/.{0,50}\bretry\b.{0,40}/) || [])[0]);
  check('concurrent refreshes are deduped', raw.includes('refreshInFlight'));
  check('the dedupe is cleared in a finally, so a failure cannot wedge it',
    /finally \{[\s\S]{0,80}refreshInFlight\.delete/.test(raw));
  check('invalid_grant is recognised as needing a human',
    /invalid_grant/.test(raw) && /reauth_required/.test(raw));
  check('and it is not retried', !/invalid_grant[\s\S]{0,200}\bretry\b/.test(raw));
}

section('disconnect leaves no usable credential behind');
{
  const c = await client();
  await store.saveAccount(c.id, {
    calendlyUserUri: 'https://api.calendly.com/users/CCC333',
    accessToken: 'ACCESS-STILL-HERE', refreshToken: 'REFRESH-STILL-HERE', scopes: SCOPES,
  });
  const r = await store.disconnect(c.id);
  check('disconnect reports that it did something', r.disconnected === true, r);
  check('there is no active account afterwards', (await store.getActiveAccount(c.id)) === null);

  const raw = await pool.query(
    `SELECT access_token_enc, refresh_token_enc FROM app.job_calendly_accounts
      WHERE client_id = $1 AND revoked_at IS NOT NULL`, [c.id]);
  check('the revoked row keeps no access token',
    raw.rows[0]?.access_token_enc === null, raw.rows[0]?.access_token_enc);
  check('and no refresh token', raw.rows[0]?.refresh_token_enc === null);
  check('the row is kept for the audit trail', raw.rows.length === 1);
  check('statusFor reports disconnected', (await store.statusFor(c.id)).connected === false);
}

section('reconnecting supersedes the previous account');
{
  const c = await client();
  await store.saveAccount(c.id, {
    calendlyUserUri: 'https://api.calendly.com/users/FIRST', accessToken: 'A1', refreshToken: 'R1',
  });
  const second = await store.saveAccount(c.id, {
    calendlyUserUri: 'https://api.calendly.com/users/SECOND', accessToken: 'A2', refreshToken: 'R2',
  });
  check('the new account is active', second.is_active === true);

  const active = await pool.query(
    `SELECT count(*)::int n FROM app.job_calendly_accounts
      WHERE client_id = $1 AND is_active`, [c.id]);
  check('exactly one active account per client', active.rows[0].n === 1, active.rows[0].n);
  const stale = await pool.query(
    `SELECT access_token_enc FROM app.job_calendly_accounts
      WHERE client_id = $1 AND calendly_user_uri LIKE '%FIRST'`, [c.id]);
  check('the superseded account kept no token',
    stale.rows[0]?.access_token_enc === null, stale.rows[0]?.access_token_enc);
  check('the active one is the new one',
    (await store.getActiveAccount(c.id))?.calendlyUserUri.endsWith('SECOND'));
}

async function cleanup() {
  if (made.length) {
    await pool.query('DELETE FROM app.job_clients WHERE id = ANY($1::int[])', [made]);
  }
  await pool.end();
}
await cleanup();
await closeCalendlyStore();
await closeStore();

console.log(fails === 0
  ? '\n  all Calendly connection checks passed'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
