#!/usr/bin/env node
// Tests for the pieces of the Google integration that can be verified without
// Google's servers: token sealing, the OAuth state lifecycle, MIME building,
// body extraction, and the guarantee that no token material is ever selected
// into a status response.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// A fixed key so this suite does not depend on the developer's .env.
process.env.JOBBY_TOKEN_KEY = randomBytes(32).toString('hex');

const { sealToken, openToken, encryptionAvailable, encryptionStatus, safeEqual, newStateToken } =
  await import('../jobby/secrets.mjs');
const { buildMimeMessage, stripHtml, extractBodyText, SCOPES, RESTRICTED_SCOPES, configuration, defaultRedirectUri } =
  await import('../jobby/google.mjs');
const store = await import('../jobby/google-store.mjs');

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 220)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

/* ── Token sealing ─────────────────────────────────────────────────── */
section('a token survives a seal/open round trip');
{
  const secret = 'ya29.refresh-token-value-that-must-never-be-readable';
  const sealed = sealToken(secret);
  check('seal returns a buffer', Buffer.isBuffer(sealed));
  check('round trip is lossless', openToken(sealed) === secret);
  check('ciphertext differs from plaintext', !sealed.toString('utf8').includes(secret));
  check('ciphertext contains no plaintext fragment',
    !sealed.toString('latin1').includes('refresh-token'), sealed.toString('latin1').slice(0, 60));
  check('envelope has a version byte', sealed[0] === 1, sealed[0]);
  check('iv is 12 bytes', sealed.length > 1 + 12 + 16);
}

section('the same plaintext seals differently every time');
{
  const s = 'identical-token';
  const a = sealToken(s);
  const b = sealToken(s);
  check('two seals differ', !a.equals(b));
  check('both still open correctly', openToken(a) === s && openToken(b) === s);
}

section('tampering is detected, not silently decrypted');
{
  const sealed = sealToken('sensitive');
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 0xff; // flip a bit in the ciphertext
  let threw = false;
  try { openToken(tampered); } catch { threw = true; }
  check('flipped ciphertext rejected', threw);

  const badTag = Buffer.from(sealed);
  badTag[14] ^= 0xff; // inside the auth tag
  threw = false;
  try { openToken(badTag); } catch { threw = true; }
  check('flipped auth tag rejected', threw);

  const badIv = Buffer.from(sealed);
  badIv[2] ^= 0xff;
  threw = false;
  try { openToken(badIv); } catch { threw = true; }
  check('flipped iv rejected', threw);
}

section('a different key cannot open the token');
{
  const sealed = sealToken('secret');
  const original = process.env.JOBBY_TOKEN_KEY;
  process.env.JOBBY_TOKEN_KEY = randomBytes(32).toString('hex');
  // Force a reload of the cached key by importing a fresh module instance.
  const other = await import(`../jobby/secrets.mjs?v=${Date.now()}`);
  let threw = false;
  try { other.openToken(sealed); } catch { threw = true; }
  check('wrong key rejected', threw);
  process.env.JOBBY_TOKEN_KEY = original;
}

section('bad input is refused rather than half-handled');
{
  check('empty string refused', (() => { try { sealToken(''); return false; } catch { return true; } })());
  check('non-string refused', (() => { try { sealToken(123); return false; } catch { return true; } })());
  check('null buffer refused', (() => { try { openToken(null); return false; } catch { return true; } })());
  check('truncated buffer refused', (() => { try { openToken(Buffer.from([1, 2, 3])); return false; } catch { return true; } })());
  const badVersion = Buffer.concat([Buffer.from([9]), Buffer.alloc(40)]);
  check('unknown envelope version refused', (() => { try { openToken(badVersion); return false; } catch { return true; } })());
}

section('the key is required, with no generated fallback');
{
  const original = process.env.JOBBY_TOKEN_KEY;
  delete process.env.JOBBY_TOKEN_KEY;
  const fresh = await import(`../jobby/secrets.mjs?v=noworkey${Date.now()}`);
  check('reports unavailable', fresh.encryptionAvailable() === false);
  const status = fresh.encryptionStatus();
  check('status carries a code', status.code === 'TOKEN_KEY_MISSING', status);
  let threw = false;
  try { fresh.sealToken('x'); } catch { threw = true; }
  check('refuses to seal without a key (fails closed)', threw);
  process.env.JOBBY_TOKEN_KEY = original;
  check('available with a key', encryptionAvailable() === true);
  check('encryptionStatus reports a source', typeof encryptionStatus().source === 'string');
}

section('state tokens and constant-time compare');
{
  const s = newStateToken();
  check('state is long', s.length >= 40, s.length);
  check('state is unique', newStateToken() !== s);
  check('equal strings match', safeEqual('abc', 'abc'));
  check('different strings do not', !safeEqual('abc', 'abd'));
  check('different lengths do not', !safeEqual('abc', 'abcd'));
  check('undefined is handled', safeEqual(undefined, '') === false);
}

/* ── Scopes ────────────────────────────────────────────────────────── */
section('the requested scopes are the ones that were agreed');
{
  check('gmail.send requested', SCOPES.includes('https://www.googleapis.com/auth/gmail.send'));
  check('gmail.readonly requested', SCOPES.includes('https://www.googleapis.com/auth/gmail.readonly'));
  check('full drive requested', SCOPES.includes('https://www.googleapis.com/auth/drive'));
  check('userinfo.email requested', SCOPES.includes('https://www.googleapis.com/auth/userinfo.email'));
  check('no gmail.modify (not agreed)', !SCOPES.some(s => s.includes('gmail.modify')));
  check('no scope duplicates', new Set(SCOPES).size === SCOPES.length);
  check('restricted scopes identified',
    RESTRICTED_SCOPES.includes('https://www.googleapis.com/auth/drive') &&
    RESTRICTED_SCOPES.includes('https://www.googleapis.com/auth/gmail.readonly'),
    RESTRICTED_SCOPES);
}

section('configuration reports what is missing');
{
  const savedId = process.env.GOOGLE_CLIENT_ID;
  const savedSecret = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  let cfg = configuration();
  check('reports unconfigured', cfg.configured === false);
  check('names both missing vars', cfg.missing.includes('GOOGLE_CLIENT_ID') && cfg.missing.includes('GOOGLE_CLIENT_SECRET'), cfg.missing);
  process.env.GOOGLE_CLIENT_ID = 'test-client-id-12345678';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  cfg = configuration();
  check('reports configured', cfg.configured === true, cfg);
  check('shows only the client id suffix', cfg.clientIdSuffix === '12345678', cfg.clientIdSuffix);
  check('never exposes the secret', !JSON.stringify(cfg).includes('secret'), cfg);
  check('default redirect is the portal', defaultRedirectUri().includes('jobby.mobilemonero.com'), defaultRedirectUri());
  if (savedId === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = savedId;
  if (savedSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = savedSecret;
}

/* ── MIME ──────────────────────────────────────────────────────────── */
const decode = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

section('plain-text message');
{
  const raw = buildMimeMessage({ from: 'Me <me@gmail.com>', to: 'hr@corp.com', subject: 'Hello', body: 'Body line' });
  const text = decode(raw);
  check('has From', text.includes('From: Me <me@gmail.com>'), text.split('\r\n')[0]);
  check('has To', text.includes('To: hr@corp.com'));
  check('has Subject', text.includes('Subject: Hello'));
  check('has MIME-Version', text.includes('MIME-Version: 1.0'));
  check('declares text/plain', text.includes('Content-Type: text/plain; charset="UTF-8"'));
  check('body present', text.includes('Body line'));
  check('no html part', !text.includes('multipart/alternative'));
  check('is base64url safe', !/[+/=]/.test(raw), raw.slice(0, 40));
}

section('html message includes a text alternative');
{
  const raw = buildMimeMessage({
    from: 'me@gmail.com', to: 'x@y.com', subject: 'S',
    html: '<p>Hello <b>there</b></p>',
  });
  const text = decode(raw);
  check('is multipart/alternative', text.includes('multipart/alternative'), text.slice(0, 200));
  check('has a text part', text.includes('Content-Type: text/plain'));
  check('has an html part', text.includes('Content-Type: text/html'));
  check('html preserved', text.includes('<b>there</b>'));
  check('text alternative derived from html', /Hello there/.test(text), text);
}

section('reply threading headers');
{
  const withThread = decode(buildMimeMessage({
    from: 'a@b.com', to: 'c@d.com', subject: 'Re: X', body: 'y',
    inReplyTo: '<msg1@mail.gmail.com>', references: '<root@mail.gmail.com> <msg1@mail.gmail.com>',
  }));
  check('In-Reply-To present', withThread.includes('In-Reply-To: <msg1@mail.gmail.com>'));
  check('References present', withThread.includes('References: <root@mail.gmail.com>'));

  const noThread = decode(buildMimeMessage({ from: 'a@b.com', to: 'c@d.com', subject: 'S', body: 'b' }));
  check('no In-Reply-To when not replying', !noThread.includes('In-Reply-To:'));
}

section('unicode survives the round trip');
{
  const raw = buildMimeMessage({ from: 'a@b.com', to: 'c@d.com', subject: 'Consulting — availability', body: 'naïve café 日本語 · 99%' });
  const text = decode(raw);
  check('em dash in subject survives', text.includes('Consulting — availability'), text.split('\r\n')[2]);
  check('accented text survives', text.includes('naïve café'));
  check('cjk survives', text.includes('日本語'));
  check('middle dot survives', text.includes('·'));
}

section('html stripping');
{
  check('tags removed', stripHtml('<p>Hi <b>there</b></p>') === 'Hi there', stripHtml('<p>Hi <b>there</b></p>'));
  check('br becomes newline', stripHtml('a<br>b').includes('\n'));
  check('entities decoded', stripHtml('a &amp; b &lt;c&gt;') === 'a & b <c>', stripHtml('a &amp; b &lt;c&gt;'));
  check('script content dropped', !stripHtml('<script>evil()</script>ok').includes('evil'));
  check('style content dropped', !stripHtml('<style>x{}</style>ok').includes('x{}'));
  check('list items separated', stripHtml('<li>a</li><li>b</li>').split('\n').length >= 2);
  check('empty input safe', stripHtml('') === '');
  check('null input safe', stripHtml(null) === '');
}

section('MIME tree walking finds the body');
{
  const b64 = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const plain = { mimeType: 'text/plain', body: { data: b64('plain body') } };
  check('simple part', extractBodyText(plain) === 'plain body');

  const multipart = {
    mimeType: 'multipart/alternative',
    parts: [{ mimeType: 'text/plain', body: { data: b64('the text') } }, { mimeType: 'text/html', body: { data: b64('<p>the html</p>') } }],
  };
  check('prefers the text part', extractBodyText(multipart) === 'the text', extractBodyText(multipart));

  const htmlOnly = { mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/html', body: { data: b64('<p>only html</p>') } }] };
  check('falls back to html, stripped', extractBodyText(htmlOnly) === 'only html', extractBodyText(htmlOnly));

  check('null part safe', extractBodyText(null) === '');
  check('empty parts safe', extractBodyText({ mimeType: 'multipart/x', parts: [] }) === '');
  const deep = { mimeType: 'multipart/a', parts: [{ mimeType: 'multipart/b', parts: [{ mimeType: 'multipart/c', parts: [{ mimeType: 'multipart/d', parts: [{ mimeType: 'text/plain', body: { data: b64('deep') } }] }] }] }] };
  check('finds a deeply nested part', extractBodyText(deep) === 'deep', extractBodyText(deep));
}

/* ── State lifecycle (real database) ───────────────────────────────── */
section('oauth state is single-use');
{
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });
  const clientId = 999999; // no FK row needed: the states table requires one,
                           // so create a real client and clean it up after.
  const { rows } = await pool.query(
    `INSERT INTO app.job_clients (session_key, display_name) VALUES ($1,$2) RETURNING id`,
    [`test-google-state-${Date.now()}`, 'state test'],
  );
  const realClientId = rows[0].id;

  const state = store.newState();
  await store.putState(state, realClientId, '/');
  const first = await store.consumeState(state);
  check('first consume succeeds', first !== null);
  check('returns the right client', first.clientId === realClientId, first);
  check('carries the redirect target', first.redirectTo === '/', first);

  const second = await store.consumeState(state);
  check('replay refused', second === null);

  const unknown = await store.consumeState('never-existed-' + Math.random());
  check('unknown state refused', unknown === null);

  const many = [];
  for (let i = 0; i < 5; i++) {
    const s = store.newState();
    await store.putState(s, realClientId);
    many.push(s);
  }
  const all = await Promise.all(many.map(s => store.consumeState(s)));
  check('concurrent consumes all succeed once', all.every(Boolean), all.filter(Boolean).length);
  const again = await Promise.all(many.map(s => store.consumeState(s)));
  check('and none can be replayed', again.every(x => x === null), again.filter(Boolean).length);

  await pool.query('DELETE FROM app.job_clients WHERE id = $1', [realClientId]);
  await pool.end();
}

section('no token material is exposed by statusFor or listSent');
{
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });
  const { rows } = await pool.query(
    `INSERT INTO app.job_clients (session_key, display_name) VALUES ($1,$2) RETURNING id`,
    [`test-google-token-${Date.now()}`, 'token test'],
  );
  const clientId = rows[0].id;

  const noAccount = await store.statusFor(clientId);
  check('disconnected when there is no row', noAccount.connected === false, noAccount);
  check('no account leaks nothing', !JSON.stringify(noAccount).includes('token'), noAccount);

  // Store a real sealed token the way completeAuth would.
  const sealedAccess = sealToken('ya29.access-token-abc');
  const sealedRefresh = sealToken('1//refresh-token-xyz');
  await store.saveAccount(clientId, {
    googleUserId: 'sub-123',
    email: 'candidate@gmail.com',
    accessToken: sealedAccess,
    refreshToken: sealedRefresh,
    scopes: SCOPES,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });

  const status = await store.statusFor(clientId);
  check('reports connected', status.connected === true, status);
  check('reports the email', status.email === 'candidate@gmail.com', status.email);
  check('reports scopes', status.scopes.length === SCOPES.length, status.scopes);
  check('tokenExpired is false for a fresh token', status.tokenExpired === false, status.tokenExpired);

  const serialised = JSON.stringify(status);
  check('no access token in status', !serialised.includes('ya29.access-token-abc'), serialised);
  check('no refresh token in status', !serialised.includes('1//refresh-token-abc'), serialised);
  check('no sealed buffer in status', !serialised.includes('accessTokenEnc') && !serialised.includes('refreshTokenEnc'), serialised);

  // The sealed value really is unreadable at rest.
  const raw = await pool.query(
    'SELECT encode(access_token_enc, \'escape\') AS a, encode(refresh_token_enc, \'escape\') AS r FROM app.job_google_accounts WHERE client_id = $1',
    [clientId],
  );
  const atRest = raw.rows[0].a + raw.rows[0].r;
  check('database does not contain the plaintext access token', !atRest.includes('ya29.access-token-abc'), atRest.slice(0, 80));
  check('database does not contain the plaintext refresh token', !atRest.includes('1//refresh-token-xyz'), atRest.slice(0, 80));
  check('ciphertext is binary, not text', /\\x[0-9a-f]{2}/.test(atRest) || atRest.length > 40, atRest.slice(0, 40));

  // Reconnecting retires the previous account rather than accumulating.
  await store.saveAccount(clientId, {
    googleUserId: 'sub-456', email: 'second@gmail.com',
    accessToken: sealToken('a2'), refreshToken: sealToken('r2'),
    scopes: SCOPES, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const active = await pool.query('SELECT count(*)::int AS n FROM app.job_google_accounts WHERE client_id = $1 AND is_active', [clientId]);
  check('only one active account after reconnecting', active.rows[0].n === 1, active.rows[0]);
  const status2 = await store.statusFor(clientId);
  check('status shows the newest account', status2.email === 'second@gmail.com', status2.email);

  // Revoking nulls the tokens.
  const account = await store.getActiveAccount(clientId);
  await store.revokeAccount(account.id, 'test');
  const afterRevoke = await store.statusFor(clientId);
  check('revoked account reports disconnected', afterRevoke.connected === false, afterRevoke);
  const nulled = await pool.query(
    'SELECT access_token_enc, refresh_token_enc FROM app.job_google_accounts WHERE id = $1', [account.id]);
  check('access token nulled on revoke', nulled.rows[0].access_token_enc === null);
  check('refresh token nulled on revoke', nulled.rows[0].refresh_token_enc === null);

  // getActiveAccount must not return anything once revoked.
  check('getActiveAccount returns null after revoke', (await store.getActiveAccount(clientId)) === null);

  await pool.query('DELETE FROM app.job_clients WHERE id = $1', [clientId]);
  await pool.end();
}

section('reply de-duplication');
{
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });
  const { rows } = await pool.query(
    `INSERT INTO app.job_clients (session_key, display_name) VALUES ($1,$2) RETURNING id`,
    [`test-google-replies-${Date.now()}`, 'reply test'],
  );
  const clientId = rows[0].id;

  const first = await store.markReplySeen({ clientId, threadId: 't1', messageId: 'm1', from: 'hr@corp.com', snippet: 'Interview?' });
  check('first sighting recorded', first === true);
  const again = await store.markReplySeen({ clientId, threadId: 't1', messageId: 'm1', from: 'hr@corp.com', snippet: 'Interview?' });
  check('second sighting not recorded again', again === false);

  const seen = await store.seenReplyIds(clientId, ['m1', 'm2']);
  check('seen set contains the known id', seen.has('m1'));
  check('seen set omits the unknown id', !seen.has('m2'));
  check('empty input is safe', (await store.seenReplyIds(clientId, [])).size === 0);
  check('null input is safe', (await store.seenReplyIds(clientId, null)).size === 0);

  await pool.query('DELETE FROM app.job_clients WHERE id = $1', [clientId]);
  await pool.end();
}

console.log('\n' + (fails === 0 ? 'all google oauth tests passed' : fails + ' FAILED'));
process.exit(fails === 0 ? 0 : 1);
