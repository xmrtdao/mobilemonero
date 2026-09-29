// Claiming an email address, so one person is one person across devices.
//
// The problem this solves: the client table is keyed on a browser session, so the
// same human on a laptop and a phone is two records, and everything that matters -
// opportunities, outreach, chat, the dossier - splits across them. Session cookies
// fix that for one browser and nothing else.
//
// The obvious alternative, keying on IP address, is not usable. Carrier-grade NAT
// puts thousands of phones behind one public address, so two job seekers in one
// city would share an identity; mobile addresses also rotate mid-session, and
// every device behind one router shares an address. Merging on that would attach
// one person's history to another person's name.
//
// So identity is an explicit claim, proved by a code the person receives at an
// address only they can read. Two properties follow, and both matter:
//
//   - An address nobody has verified merges with nothing. A typed-but-unproven
//     email cannot pull another person's record into this one, which is what
//     closes the NAT hole.
//   - Verification is per-address, not per-session, so verifying once on the
//     laptop verifies the phone.

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** How long a code stays usable. Long enough to walk to another device. */
const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Wrong guesses allowed per code.
 *
 * Six digits is a million possibilities, and an unlimited-attempt endpoint is a
 * free oracle - a few thousand requests and the code falls out, with no rate limit
 * anywhere else to stop it. Three attempts, then the code is spent and a new one
 * must be requested.
 */
const MAX_ATTEMPTS = 3;

/** Codes one client may ask for per hour, which is what stops mail-bombing. */
const MAX_REQUESTS_PER_HOUR = 5;

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

export async function closeClaim() {
  if (pool) { await pool.end(); pool = null; }
}

const normEmail = e => String(e || '').trim().toLowerCase();

/** Reject addresses that cannot be delivered, before anything is stored. */
export function plausibleEmail(e) {
  const v = normEmail(e);
  if (!v || v.length > 320) return false;
  // Deliberately loose. Refusing a valid but unusual address is worse than
  // attempting delivery and having Resend bounce it, which is a normal outcome.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/**
 * Hash a code before storing it.
 *
 * Peppered with JOBBY_TOKEN_KEY, which is already required for token sealing. A
 * database dump then does not hand over live claim codes: without the pepper a
 * captured hash is a million tries away from the code itself, and with the pepper
 * the search has to happen against a secret that never leaves the process.
 */
function hashCode(email, code) {
  const pepper = process.env.JOBBY_TOKEN_KEY || 'unpeppered-development-only';
  return createHash('sha256').update(`${pepper}:${normEmail(email)}:${code}`).digest('hex');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Issue a code for an address.
 *
 * Returns the plaintext code so the caller can mail it. It is never stored and
 * never logged; only its hash goes to the database.
 */
export async function requestClaim(clientId, email) {
  const key = normEmail(email);
  if (!plausibleEmail(key)) {
    return { error: 'That does not look like an email address.' };
  }
  const p = await db();

  const recent = await p.query(
    `SELECT count(*)::int c FROM app.job_claim_codes
      WHERE client_id = $1 AND created_at > now() - interval '1 hour'`, [clientId]);
  if (recent.rows[0].c >= MAX_REQUESTS_PER_HOUR) {
    return { error: `Too many codes requested. Try again in ${60 - 0} minutes.` };
  }

  // Supersede any outstanding code. Marking the row is what frees the one-live-code
  // slot; merely expiring it does not, because the index predicate is on
  // verified_at and superseded_at and an expired-but-unverified row is still live
  // as far as the index is concerned. Without the marker, asking for a second code
  // raised a unique violation and the request failed.
  await p.query(
    `UPDATE app.job_claim_codes
        SET superseded_at = now(), expires_at = now() - interval '1 second'
      WHERE client_id = $1 AND verified_at IS NULL AND superseded_at IS NULL`, [clientId]);

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await p.query(
    `INSERT INTO app.job_claim_codes (client_id, email, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)`,
    [clientId, key, hashCode(key, code), String(CODE_TTL_MS)]);

  return { ok: true, code, email: key, expiresInSeconds: Math.floor(CODE_TTL_MS / 1000) };
}

/**
 * Check a code and, if it is right, bind the address to the client.
 *
 * The failure messages are deliberately uniform. Saying "no such code" versus
 * "wrong code" turns this into an oracle for which addresses have been claimed,
 * and the candidate learns nothing useful from the distinction anyway.
 */
export async function verifyClaim(clientId, email, code) {
  const key = normEmail(email);
  if (!plausibleEmail(key)) return { error: 'That does not look like an email address.' };
  const supplied = String(code || '').replace(/\D/g, '');
  if (supplied.length !== 6) return { error: 'The code is six digits.' };

  const p = await db();
  const row = await p.query(
    `SELECT id, code_hash, attempts, expires_at FROM app.job_claim_codes
      WHERE client_id = $1 AND LOWER(email) = $2
        AND verified_at IS NULL AND superseded_at IS NULL
      ORDER BY created_at DESC LIMIT 1`, [clientId, key]);

  if (!row.rows.length) return { error: 'That code is not right, or it has expired. Ask for a new one.' };
  const rec = row.rows[0];

  if (new Date(rec.expires_at).getTime() < Date.now()) {
    return { error: 'That code has expired. Ask for a new one.' };
  }
  if (rec.attempts >= MAX_ATTEMPTS) {
    return { error: 'Too many attempts on that code. Ask for a new one.' };
  }

  if (!safeEqualHex(hashCode(key, supplied), rec.code_hash)) {
    await p.query('UPDATE app.job_claim_codes SET attempts = attempts + 1 WHERE id = $1', [rec.id]);
    const left = Math.max(0, MAX_ATTEMPTS - (rec.attempts + 1));
    return {
      error: left > 0
        ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`
        : 'That code is not right, and it is now spent. Ask for a new one.',
    };
  }

  await p.query('UPDATE app.job_claim_codes SET verified_at = now() WHERE id = $1', [rec.id]);

  // The address may already be proved on another device - the same person on a
  // phone, or a phone that verified while this laptop was still open. The unique
  // index refuses a second claim, which is the correct backstop, but letting it
  // throw turns an ordinary case into a 500. So the collision is detected here and
  // reported, and the caller consolidates the two records instead.
  const held = await p.query(
    `SELECT id, session_key FROM app.job_clients
      WHERE LOWER(COALESCE(claimed_email,'')) = $1 AND id <> $2 LIMIT 1`,
    [key, clientId]);
  if (held.rows.length) {
    return {
      ok: true,
      verified: true,
      email: key,
      alreadyClaimedBy: held.rows[0].id,
      heldBy: held.rows[0].session_key,
      note: 'This address is already proved on another device, so the two records are the same person.',
    };
  }

  await p.query(
    `UPDATE app.job_clients
        SET claimed_email = $2, claimed_at = now(), updated_at = now()
      WHERE id = $1`, [clientId, key]);

  return { ok: true, verified: true, email: key };
}

/** Is this client's email address proved? */
export async function isVerified(clientId) {
  const p = await db();
  const { rows } = await p.query(
    'SELECT claimed_email, claimed_at FROM app.job_clients WHERE id = $1', [clientId]);
  if (!rows.length || !rows[0].claimed_email || !rows[0].claimed_at) {
    return { verified: false, email: null };
  }
  return { verified: true, email: rows[0].claimed_email, claimedAt: rows[0].claimed_at };
}

/** Clients that have proved the same address. The only safe basis for merging. */
export async function findClaimedPeers(email) {
  const key = normEmail(email);
  if (!key) return [];
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, session_key, display_name, claimed_at
       FROM app.job_clients
      WHERE LOWER(COALESCE(claimed_email,'')) = $1
      ORDER BY claimed_at, id`, [key]);
  return rows;
}

/**
 * The gate on anything irreversible.
 *
 * Reading the portal needs nothing, so browsing works on any device with no setup.
 * Sending an application, or a message to a recruiter, is a representation made in
 * someone's name, and it is only allowed from a session whose address has been
 * proved. A mistyped email therefore cannot send anything.
 */
export async function assertCanRepresent(clientId) {
  const status = await isVerified(clientId);
  if (status.verified) return { ok: true };
  return {
    ok: false,
    code: 'email_not_verified',
    error: 'I need to check that email address is really yours before I send anything on your behalf.',
    howToFix: 'Ask me to send you a verification code, then give me the six digits.',
    claimed: status.email,
  };
}
