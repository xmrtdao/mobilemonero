/**
 * relay/jobby/google.mjs — Per-user Google Workspace access
 *
 * One connected Google account per Jobby client. Tokens are sealed before they
 * touch the database (see secrets.mjs) and are only opened immediately before a
 * call to Google.
 *
 * SCOPES is the whole security posture of this feature, so it is stated here
 * rather than assembled at the call site:
 *
 *   gmail.send      - send applications from the candidate's own address, so
 *                     replies land in their inbox rather than the agent's.
 *   gmail.readonly  - see replies, so follow-up does not depend on the user
 *                     pasting them in. Does NOT allow sending, deleting or
 *                     labelling existing mail.
 *   drive           - read the candidate's existing resume and documents, and
 *                     write Jobby's working files. Broad: this includes reading
 *                     and deleting their whole Drive. Deletion is therefore not
 *                     exposed - only trash, which is recoverable.
 *   userinfo.email  - identify which account is connected.
 *
 * gmail.readonly and drive are RESTRICTED scopes in Google's classification.
 * A public OAuth client requesting them must complete Google's verification and
 * security assessment before real users can grant consent. Domain-restricting
 * the client to a Workspace domain avoids that requirement.
 */

import { sealToken, openToken, encryptionAvailable } from './secrets.mjs';
import * as store from './google-store.mjs';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://oauth2.googleapis.com/v1/userinfo';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
];

/** Scopes Google treats as restricted; worth surfacing in the status panel. */
export const RESTRICTED_SCOPES = SCOPES.filter(s =>
  s.includes('gmail.readonly') || s.endsWith('/drive') || s.includes('gmail.modify'));

const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;

// In-flight refreshes, keyed by account id. Without this, twenty concurrent
// tool calls each see a stale token and each spend a refresh round-trip; Google
// invalidates the previous refresh token in some configurations, so a refresh
// stampede can lock the account out.
const refreshInFlight = new Map();

export function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function configuration() {
  const missing = [];
  if (!process.env.GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
  if (!process.env.GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
  return {
    configured: missing.length === 0,
    missing,
    encryption: { available: encryptionAvailable() },
    clientIdSuffix: process.env.GOOGLE_CLIENT_ID
      ? String(process.env.GOOGLE_CLIENT_ID).slice(-8) : null,
  };
}

function requireConfig() {
  if (!isConfigured()) {
    const err = new Error(
      'Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in relay/.env.'
    );
    err.code = 'GOOGLE_NOT_CONFIGURED';
    throw err;
  }
}

export function defaultRedirectUri() {
  // Deliberately still the mobilemonero hostname, even though the canonical
  // domain is now jobbymcjobberson.com. Google matches this string exactly
  // against what is registered on the OAuth client, and only the old one is
  // registered. Cloudflare 301s the old host to the new one and preserves the
  // query string, so the callback arrives intact either way - which means
  // flipping this needs no code change at all, only the new URI added to the
  // OAuth client's authorised redirect URIs. Doing it in the other order would
  // break sign-in with a redirect_uri_mismatch, which reads as a Google
  // misconfiguration rather than as an unregistered redirect.
  //
  // A stated value always wins, so this can be overridden without a deploy.
  return process.env.GOOGLE_REDIRECT_URI
    || 'https://jobby.mobilemonero.com/api/jobby/google/callback';
}

/** Step 1: mint a state row and return the URL to send the browser to. */
export async function beginAuth(clientId, { redirectTo = null } = {}) {
  requireConfig();
  const state = store.newState();
  await store.putState(state, clientId, redirectTo);
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', defaultRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  // offline + consent are both required to receive a refresh token. Without
  // them Google returns an access token that dies in an hour and the feature
  // silently rots.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return { url: url.toString(), state };
}

/** Step 2: swap the code for tokens, identify the account, seal and store. */
export async function completeAuth({ code, state, error, redirectUri }) {
  if (error) {
    return { ok: false, error: 'authorization_denied', detail: String(error).slice(0, 300) };
  }
  if (!code || !state) {
    return { ok: false, error: 'missing_code_or_state' };
  }
  // Single-use: consuming the row is what stops a replayed code binding a
  // second account to this client.
  const consumed = await store.consumeState(state);
  if (!consumed) {
    return { ok: false, error: 'invalid_or_expired_state' };
  }
  if (Date.now() - consumed.createdAt > STATE_TTL_MS) {
    return { ok: false, error: 'state_expired' };
  }
  requireConfig();

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri || defaultRedirectUri(),
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(20000),
  });
  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) {
    return { ok: false, error: 'token_exchange_failed', detail: tokenText.slice(0, 300) };
  }
  let tokens;
  try { tokens = JSON.parse(tokenText); } catch {
    return { ok: false, error: 'token_response_not_json', detail: tokenText.slice(0, 200) };
  }
  if (!tokens.refresh_token) {
    // Happens when the account already granted access and Google declines to
    // re-issue one. Recoverable by revoking the app, so say so.
    return {
      ok: false,
      error: 'no_refresh_token',
      detail: 'Google did not issue a refresh token. Revoke this app in your Google account permissions and connect again.',
    };
  }

  const info = await fetchUserInfo(tokens.access_token);
  if (!info?.email) {
    return { ok: false, error: 'could_not_read_account_email' };
  }

  await store.saveAccount(consumed.clientId, {
    googleUserId: info.sub || null,
    email: info.email,
    accessToken: sealToken(tokens.access_token),
    refreshToken: sealToken(tokens.refresh_token),
    scopes: String(tokens.scope || SCOPES.join(' ')).split(/\s+/).filter(Boolean),
    expiresAt: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null,
  });

  return {
    ok: true,
    clientId: consumed.clientId,
    email: info.email,
    scopes: String(tokens.scope || SCOPES.join(' ')).split(/\s+/).filter(Boolean),
  };
}

async function fetchUserInfo(accessToken) {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Whether a stored account needs a new access token. */
function needsRefresh(account) {
  if (!account?.expiresAt) return false;
  return new Date(account.expiresAt).getTime() - REFRESH_SKEW_MS <= Date.now();
}

/**
 * A valid access token for the client's account, refreshing if needed.
 * Concurrent callers share one refresh.
 */
export async function getAccessToken(clientId) {
  const account = await store.getActiveAccount(clientId);
  if (!account) {
    const err = new Error('No Google account is connected for this client.');
    err.code = 'GOOGLE_NOT_CONNECTED';
    throw err;
  }

  let accessToken = null;
  try {
    accessToken = openToken(account.accessTokenEnc);
  } catch {
    accessToken = null; // fall through to a refresh
  }
  if (accessToken && !needsRefresh(account)) {
    return { accessToken, account };
  }

  const inFlight = refreshInFlight.get(account.id);
  if (inFlight) {
    const shared = await inFlight;
    return { accessToken: shared, account };
  }

  const work = (async () => {
    const refreshToken = openToken(account.refreshTokenEnc);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (!res.ok) {
      const detail = safeDetail(text);
      await store.markAccountError(account.id, detail);
      // A rejected refresh_token means the user revoked us. Do not keep
      // retrying it; mark the account dead so the UI can say so.
      if (res.status === 400 || res.status === 401) {
        await store.revokeAccount(account.id, 'refresh token rejected by Google');
      }
      const err = new Error(`Google rejected the refresh token (HTTP ${res.status}). ${detail}`.trim());
      err.code = 'GOOGLE_REFRESH_FAILED';
      throw err;
    }
    const tokens = JSON.parse(text);
    await store.updateTokens(account.id, {
      accessToken: sealToken(tokens.access_token),
      expiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null,
    });
    return tokens.access_token;
  })();

  refreshInFlight.set(account.id, work);
  try {
    const token = await work;
    return { accessToken: token, account };
  } finally {
    refreshInFlight.delete(account.id);
  }
}

function safeDetail(text) {
  try {
    const parsed = JSON.parse(text);
    return String(parsed.error_description || parsed.error?.message || 'no detail').slice(0, 200);
  } catch {
    return String(text || '').slice(0, 200);
  }
}

/** Call a Google API with the client's token, mapping failures to codes. */
async function googleFetch(clientId, url, init = {}, { method = 'GET' } = {}) {
  const { accessToken } = await getAccessToken(clientId);
  const res = await fetch(url, {
    ...init,
    method,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(init.timeoutMs || 30000),
  });
  if (!res.ok) {
    const detail = safeDetail(await res.text());
    const err = new Error(`Google API ${res.status} on ${method} ${new URL(url).pathname}: ${detail}`);
    err.code = 'GOOGLE_API_ERROR';
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

/* -- Gmail ----------------------------------------------------------- */

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Build an RFC 2822 message. Kept separate so it is unit-testable. */
export function buildMimeMessage({ from, to, subject, body, html, inReplyTo, references }) {
  const boundary = 'xmrt_' + Math.random().toString(36).slice(2, 14);
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  let payload;
  if (html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    payload = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body || stripHtml(html),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      html,
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    payload = body || '';
  }
  return b64url(Buffer.from([...headers, '', payload].join('\r\n'), 'utf8'));
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Send from the connected account. This is the path that fixes Jobby sending
 * from the agent's own address: the From is the candidate's Gmail, so employer
 * replies arrive in their inbox.
 */
export async function sendGmail({ clientId, to, subject, body, html, inReplyTo, threadId, references }) {
  const account = await store.getActiveAccount(clientId);
  if (!account) {
    const err = new Error('No Google account is connected for this client.');
    err.code = 'GOOGLE_NOT_CONNECTED';
    throw err;
  }
  const from = `${account.displayName || account.email} <${account.email}>`;
  const raw = buildMimeMessage({ from, to, subject, body, html, inReplyTo, threadId, references });

  const result = await googleFetch(
    clientId,
    `${GMAIL_API}/users/me/messages/send`,
    { body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }) },
    { method: 'POST' },
  );

  await store.recordSent({
    clientId,
    accountId: account.id,
    to,
    subject,
    threadId: result?.threadId || threadId || null,
    messageId: result?.id || null,
    status: 'sent',
  });

  return { id: result?.id, threadId: result?.threadId, from, labelIds: result?.labelIds };
}

/** Pull message headers for a Gmail query, newest first. */
export async function listMessages({ clientId, query = '', maxResults = 20, labelIds = null }) {
  const params = new URLSearchParams({ maxResults: String(Math.min(Math.max(maxResults, 1), 50)) });
  if (query) params.set('q', query);
  if (labelIds) params.set('labelIds', labelIds);
  const list = await googleFetch(clientId, `${GMAIL_API}/users/me/messages?${params}`);
  const messages = list?.messages || [];
  if (!messages.length) return [];

  const detail = await googleFetch(
    clientId,
    `${GMAIL_API}/users/me/messages?${new URLSearchParams({
      maxResults: String(messages.length), format: 'metadata',
      metadataHeaders: 'From', metadataHeaders: 'To',
      metadataHeaders: 'Subject', metadataHeaders: 'Date',
    })}`,
  );
  const byId = new Map((detail?.messages || []).map(m => [m.id, m]));
  return messages.map(m => {
    const d = byId.get(m.id) || {};
    const h = {};
    for (const item of d.payload?.headers || []) h[item.name.toLowerCase()] = item.value;
    return {
      id: m.id,
      threadId: m.threadId,
      from: h.from || null,
      to: h.to || null,
      subject: h.subject || null,
      date: h.date || null,
      labelIds: d.labelIds || [],
    };
  });
}

export async function getMessage({ clientId, messageId, format = 'full' }) {
  const params = new URLSearchParams({ format });
  const m = await googleFetch(clientId, `${GMAIL_API}/users/me/messages/${encodeURIComponent(messageId)}?${params}`);
  const h = {};
  for (const item of m?.payload?.headers || []) h[item.name.toLowerCase()] = item.value;
  return {
    id: m?.id, threadId: m?.threadId,
    from: h.from || null, to: h.to || null, subject: h.subject || null, date: h.date || null,
    snippet: m?.snippet || null, text: extractBodyText(m?.payload),
  };
}

/** Walk a MIME tree for the text/plain or text/html part. */
export function extractBodyText(part, depth = 0) {
  if (!part || depth > 6) return '';
  if (part.mimeType === 'text/plain' && typeof part.body?.data === 'string') {
    return b64urlDecode(part.body.data).toString('utf8');
  }
  for (const child of part.parts || []) {
    const found = extractBodyText(child, depth + 1);
    if (found) return found;
  }
  if (typeof part.body?.data === 'string') {
    const raw = b64urlDecode(part.body.data).toString('utf8');
    return part.mimeType === 'text/html' ? stripHtml(raw) : raw;
  }
  return '';
}

/* -- Drive ----------------------------------------------------------- */

/**
 * List files. `query` is passed to Drive as-is; callers should constrain it.
 * The full Drive scope means an unrestricted query sees everything.
 */
export async function listFiles({ clientId, query = 'trashed = false', pageSize = 25, orderBy = 'modifiedTime desc' }) {
  const params = new URLSearchParams({
    q: query,
    pageSize: String(Math.min(Math.max(pageSize, 1), 100)),
    orderBy,
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,parents,trashed),nextPageToken',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const res = await googleFetch(clientId, `${DRIVE_API}/files?${params}`);
  return { files: res?.files || [], nextPageToken: res?.nextPageToken || null };
}

export async function getFile({ clientId, fileId, fields = null }) {
  const params = new URLSearchParams({
    fields: fields || 'id,name,mimeType,size,modifiedTime,webViewLink,parents,trashed,description',
    supportsAllDrives: 'true',
  });
  return googleFetch(clientId, `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params}`);
}

/** Download a file's text content, or its bytes for a binary. */
export async function downloadFile({ clientId, fileId }) {
  const meta = await getFile({ clientId, fileId });
  if (meta?.trashed) {
    const err = new Error('That file is in the trash.');
    err.code = 'DRIVE_FILE_TRASHED';
    throw err;
  }
  const { accessToken } = await getAccessToken(clientId);
  const res = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(45000),
    },
  );
  if (!res.ok) {
    const err = new Error(`Google Drive ${res.status} downloading file: ${safeDetail(await res.text())}`);
    err.code = 'DRIVE_API_ERROR';
    throw err;
  }
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  return { meta, content: body, contentType: type };
}

export async function createFile({ clientId, name, content, mimeType = 'text/plain', description }) {
  const boundary = 'xmrt_upload_' + Math.random().toString(36).slice(2, 12);
  const metadata = { name, mimeType };
  if (description) metadata.description = String(description).slice(0, 500);
  const multipart = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    '',
    typeof content === 'string' ? content : JSON.stringify(content),
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return googleFetch(clientId, `${UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true`, {
    body: multipart,
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    timeoutMs: 60000,
  }, { method: 'POST' });
}

export async function updateFile({ clientId, fileId, content, name, description }) {
  const boundary = 'xmrt_update_' + Math.random().toString(36).slice(2, 12);
  const metadata = {};
  if (name) metadata.name = name;
  if (description !== undefined) metadata.description = description;
  const parts = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata)];
  if (content !== undefined) parts.push(`--${boundary}`, 'Content-Type: text/plain', '', String(content));
  parts.push(`--${boundary}--`, '');
  const multipart = parts.join('\r\n');

  return googleFetch(
    clientId,
    `${UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=multipart&supportsAllDrives=true&fields=id,name,modifiedTime,webViewLink`,
    {
      body: multipart,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      timeoutMs: 60000,
    },
    { method: 'PATCH' },
  );
}

/**
 * Move a file to the trash.
 *
 * Deliberately not permanent deletion. The full Drive scope allows removing a
 * file irrecoverably, and an agent driven by a language model should not hold
 * that. Trashing is reversible from the user's own Drive UI.
 */
export async function trashFile({ clientId, fileId }) {
  return googleFetch(
    clientId,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    {},
    { method: 'DELETE' },
  );
}

/** Disconnect: revoke at Google, then deactivate locally. */
export async function disconnect({ clientId }) {
  const account = await store.getActiveAccount(clientId);
  if (!account) return { ok: true, alreadyDisconnected: true };
  // Best-effort revoke so the grant disappears from the user's Google account
  // rather than lingering there.
  try {
    const refreshToken = openToken(account.refreshTokenEnc);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    // Local revocation still happens; a failed remote revoke is not fatal.
    await store.markAccountError(account.id, `revoke call failed: ${e.message}`);
  }
  await store.revokeAccount(account.id, 'disconnected by user');
  return { ok: true, email: account.email };
}
