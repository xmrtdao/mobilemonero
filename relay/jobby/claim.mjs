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

/**
 * What the candidate needs to know about their own verification state.
 *
 * This existed in no form, which is why a completely broken verification flow
 * stayed invisible: the site could not show "prove your email" because nothing
 * told it whether the email was proved, and Jobby could not warn the candidate
 * either. The first sign of trouble was a refusal to send an application - the
 * one action that cannot be undone.
 *
 * `pending` is the interesting field. A candidate who has asked for a code and
 * not yet typed it in is mid-flow, and telling them "your email is not verified"
 * in that state is both true and useless: what they need is "we sent you a
 * code, here is where to put it".
 */
export async function claimState(clientId) {
  const p = await db();
  const c = await p.query(
    'SELECT claimed_email, claimed_at FROM app.job_clients WHERE id = $1', [clientId]);
  const row = c.rows[0] || {};
  if (row.claimed_email) {
    return {
      verified: true,
      email: row.claimed_email,
      verifiedAt: row.claimed_at,
      pending: false,
    };
  }
  // Is there a live code outstanding? Superseded and spent ones do not count:
  // a candidate looking at "we sent you a code" when the code is dead is worse
  // than not saying anything.
  const live = await p.query(
    `SELECT email, expires_at FROM app.job_claim_codes
      WHERE client_id = $1 AND verified_at IS NULL AND superseded_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`, [clientId]);
  const outstanding = live.rows[0];
  return {
    verified: false,
    email: null,
    verifiedAt: null,
    pending: !!outstanding,
    pendingEmail: outstanding ? outstanding.email : null,
    // Kept short on purpose: a timestamp is enough for the UI to say "expires
    // in N minutes" without the client doing date arithmetic on a string.
    pendingExpiresAt: outstanding ? outstanding.expires_at : null,
  };
}

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
 * someone's name, and it is only allowed from a session that can be tied to a
 * real, deliverable identity.
 *
 * ── Two identities, and the difference between them ────────────────────────
 *
 * There are two ways this product can send mail on someone's behalf, and they
 * are not equally trustworthy. The gate distinguishes them rather than treating
 * "has an address" as one thing:
 *
 *   1. **A claimed, code-verified address the candidate owns.** Proved by a code
 *      only the real owner can read. This is the strong case.
 *
 *   2. **An assigned mailbox on our own domain** — `firstname.lastname@
 *      jobbymcjobberson.com`, allocated at onboarding, with Resend catching the
 *      whole domain and the relay holding what arrives. This is the case that
 *      used to be blocked, and blocking it was wrong.
 *
 * Why blocking it was wrong: the original hazard was a *mistyped or borrowed*
 * address sending in a stranger's name. A mailbox derived from the candidate's
 * own stated name, on a domain we own and receive, cannot do that. Nobody's real
 * inbox is ever addressed, so there is no stranger to impersonate, and the
 * delivery failure the check was protecting against — mail to an address that
 * does not exist — is impossible, because we control the receiving end.
 *
 * What the change does NOT do, deliberately:
 *
 *   - It does not verify anything. A derived mailbox is issued, not proved. It
 *     says "this is the name on file", not "this person controls this inbox".
 *   - It does not merge the two identities. `verified` still means a code was
 *     read, and a candidate who claims their own address is on the stronger
 *     footing; `verified: true` is never set by this path.
 *   - It does not let two people share a mailbox. `uniqueLocalPart` suffixes on
 *     collision, so a second "Jordan Ellis" gets `jordan.ellis2@` and the first
 *     keeps the clean one. The dashboard shows the exact address so the
 *     candidate can see which one they have.
 *
 * The residual risk, stated plainly: a candidate who gives a false *name* gets a
 * mailbox derived from it. The address is not theirs in any meaningful sense, so
 * replies go to the relay and to whoever holds the session. That is the same
 * exposure any unregistered account has, and the claim flow remains available to
 * anyone who wants the strong identity.
 */
export async function assertCanRepresent(clientId) {
  const status = await isVerified(clientId);
  if (status.verified) return { ok: true, via: 'claimed_address', address: status.email };

  // The assigned mailbox. Allocated at onboarding from the candidate's own name,
  // on a domain whose mail we receive, so there is no unproved third-party
  // address in the path and nothing to bounce.
  const p = await db();
  const { rows } = await p.query(
    'SELECT mailbox, display_name FROM app.job_clients WHERE id = $1', [clientId]);
  const client = rows[0] || null;
  if (client?.mailbox) {
    return {
      ok: true,
      via: 'assigned_mailbox',
      address: client.mailbox,
      // Not a warning that gets logged and forgotten: the candidate should be
      // able to see that this is a weaker identity than a claimed one, and to
      // upgrade it whenever they want to.
      note: 'Sending from your Jobby address. Claim your own email to send from that instead.',
      displayName: client.display_name,
    };
  }

  return {
    ok: false,
    code: 'no_send_identity',
    error: 'I need to know what to send as before I send anything for you. '
      + 'Tell me your name and I will give you an address on this service.',
    howToFix: 'Tell me the name you want to be known by, or ask me to verify an email you own.',
    claimed: status.email,
  };
}
