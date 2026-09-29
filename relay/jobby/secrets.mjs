/**
 * relay/jobby/secrets.mjs — encryption for stored third-party credentials
 *
 * A Google refresh token is a bearer credential for someone's mailbox. If one
 * leaks out of the database it is a full mailbox compromise, so tokens are
 * sealed with AES-256-GCM before they touch Postgres and are only ever opened
 * server-side, immediately before a call to Google.
 *
 * Design choices worth stating:
 *
 *  - FAIL CLOSED. There is no generated fallback key. If JOBBY_TOKEN_KEY is
 *    absent the module refuses to seal anything, rather than inventing a key
 *    that is discoverable from the data directory.
 *  - A fresh 12-byte IV per encryption, stored with the ciphertext, so the same
 *    plaintext never produces the same bytes twice.
 *  - The key is versioned in the payload header. That means the key can be
 *    rotated: existing rows keep their old version and are re-sealed on next
 *    refresh, instead of becoming permanently unreadable.
 */

import {
  createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const CURRENT_VERSION = 1;

let cachedKey = null;
let cachedKeySource = null;

function loadKey() {
  if (cachedKey) return cachedKey;

  const raw = process.env.JOBBY_TOKEN_KEY;
  if (!raw || !raw.trim()) {
    const err = new Error(
      'JOBBY_TOKEN_KEY is not set. Google tokens cannot be stored. ' +
      'Generate one with: node relay/scripts/gen-token-key.mjs'
    );
    err.code = 'TOKEN_KEY_MISSING';
    throw err;
  }

  let key;
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else {
    // Base64 is also accepted; hash whatever we are given so a short or oddly
    // formatted value still yields exactly 32 bytes.
    key = createHashBytes(trimmed);
  }
  if (key.length !== KEY_BYTES) {
    const err = new Error(`JOBBY_TOKEN_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
    err.code = 'TOKEN_KEY_BAD';
    throw err;
  }
  cachedKey = key;
  cachedKeySource = /^[0-9a-f]{64}$/i.test(trimmed) ? 'hex' : 'derived';
  return key;
}

function createHashBytes(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** True when encryption is available. Used by the status endpoint. */
export function encryptionAvailable() {
  try { loadKey(); return true; } catch { return false; }
}

export function encryptionStatus() {
  try {
    loadKey();
    return { available: true, source: cachedKeySource };
  } catch (e) {
    return { available: false, error: e.message, code: e.code || 'UNKNOWN' };
  }
}

/**
 * Seal a token.
 * @returns {Buffer} version(1) || iv(12) || tag(16) || ciphertext
 */
export function sealToken(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new Error('sealToken requires a non-empty string');
  }
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([CURRENT_VERSION]), iv, tag, ciphertext]);
}

/**
 * Open a sealed token. A tampered payload fails the GCM tag check and throws.
 * @returns {string}
 */
export function openToken(sealed) {
  if (!sealed) throw new Error('openToken requires a sealed buffer');
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
  if (buf.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error('sealed token is truncated');
  }
  const version = buf[0];
  if (version !== CURRENT_VERSION) {
    throw new Error(`unsupported token envelope version ${version}`);
  }
  const key = loadKey();
  const iv = buf.subarray(1, 1 + IV_BYTES);
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Constant-time compare, for state tokens.
 *
 * Rejects non-strings and empty values outright. `String(a ?? '')` would make
 * an absent state and an empty state both compare equal to '', which would let
 * a request with no state parameter pass validation.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!a.length || !b.length) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function newStateToken() {
  return randomBytes(32).toString('base64url');
}

export function newPkceVerifier() {
  return randomBytes(48).toString('base64url');
}

export function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
