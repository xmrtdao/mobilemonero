/**
 * relay/jobby/store.mjs — Postgres access for the Jobby agent
 *
 * Every write to a dossier goes through recordEdit, so job_dossier_edits is a
 * complete history. Nothing in here updates a dossier directly.
 */

import { randomUUID } from 'node:crypto';
import {
  MAILBOX_DOMAIN, deriveLocalPart, fallbackAddress, uniqueLocalPart, localPartOf,
  isCandidateMailbox,
} from './mailbox.mjs';

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
export async function closeStore() {
  if (pool) { await pool.end(); pool = null; }
}

// The shared connection, for the modules that need to run their own queries
// rather than go through a store function - client reconciliation, for one, which
// has to move rows across several tables inside a single transaction and so cannot
// be expressed as a sequence of store calls.
export async function getPool() {
  return db();
}

const COOLDOWN_MS = 30 * 60 * 1000;
// A resume upload is the natural moment to start a session, so a brand new
// client is created and claimed in one statement.
const UPSERT_CLIENT = `
  INSERT INTO app.job_clients (session_key, display_name)
  VALUES ($1, $2)
  ON CONFLICT (session_key) DO UPDATE SET updated_at = now()
  RETURNING *`;

export async function getOrCreateClient(sessionKey, displayName = null) {
  const p = await db();
  const { rows } = await p.query(UPSERT_CLIENT, [sessionKey, displayName]);
  return rows[0];
}

/**
 * Record that `sessionKey` was seen from `ip`, and pin that IP to the client.
 *
 * IP is kept in two places on purpose: `first_ip`/`last_ip` on the client row so
 * a person can be recognised at a glance, and one row per session in
 * `job_client_sessions` so "this account has been used from four addresses" is a
 * question that can be answered rather than guessed at.
 *
 * `ip` is normalised before it is stored. An IPv4 address arriving through an
 * IPv6 socket shows up as ::ffff:203.0.113.9, and storing the two forms as
 * different values would make one visitor look like two.
 */
export async function recordSession(clientId, { sessionKey, ip = null, userAgent = null } = {}) {
  const p = await db();
  const norm = normaliseIp(ip);
  await p.query(
    `UPDATE app.job_clients
        SET last_ip = COALESCE($2::inet, last_ip),
            first_ip = COALESCE(first_ip, $2::inet),
            updated_at = now()
      WHERE id = $1`,
    [clientId, norm]
  );
  if (sessionKey) {
    await p.query(
      `INSERT INTO app.job_client_sessions (client_id, session_key, ip, user_agent)
       VALUES ($1, $2, $3::inet, $4)
       ON CONFLICT DO NOTHING`,
      [clientId, sessionKey, norm, userAgent]
    );
    await p.query(
      `UPDATE app.job_client_sessions
          SET last_seen = now(), ip = COALESCE($3::inet, ip), user_agent = COALESCE($4, user_agent)
        WHERE client_id = $1 AND session_key = $2`,
      [clientId, sessionKey, norm, userAgent]
    );
  }
  return getClient(clientId);
}

/** Strip a port, an IPv4-mapped IPv6 prefix, and surrounding whitespace. */
function normaliseIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  let v = ip.trim();
  if (!v) return null;
  if (v.startsWith('::ffff:')) v = v.slice(7);
  // "[::1]:443" and "203.0.113.9:51234" -> the address alone
  const bracketed = v.match(/^\[(.+)\](?::\d+)?$/);
  if (bracketed) v = bracketed[1];
  else if ((v.match(/:/g) || []).length === 1) v = v.split(':')[0];
  return /^[0-9.]+$/.test(v) || v.includes(':') ? v : null;
}

export { normaliseIp };

/**
 * Find clients that are probably the same person as the one described by
 * `probe`, ranked by how strong the evidence is.
 *
 * WHY THIS DOES NOT MERGE ANYTHING
 * ---------------------------------
 * An IP address is the weakest possible identity signal. Two candidates looking
 * for work from the same office, the same university library, or the same phone
 * hotspot share one address, and merging them would union two people's
 * employment history into one record - inventing a tenure that neither of them
 * worked. That is the same failure mode as unioning two documents that disagree.
 *
 * So this function only ever *reports* candidates. The caller decides, and a
 * caller that wants an automatic answer must use a signal that identifies a
 * person: the session cookie, a claimed address, or a phone number.
 *
 * Signals, strongest first:
 *   claimed_address  - the address was proved by reading a code out of an inbox
 *   phone            - stated by the candidate
 *   name_and_ip      - same name from the same address: suggestive, never proof
 *   ip_only          - reported as context; must not be used to merge
 */
export async function findIdentityCandidates({ claimedEmail, phone, name, ip, excludeClientId } = {}) {
  const p = await db();
  const norm = normaliseIp(ip);
  const found = [];
  const seen = new Set();
  const push = (row, reason, strength) => {
    if (!row || seen.has(row.id) || row.id === excludeClientId) return;
    seen.add(row.id);
    found.push({ ...row, reason, strength });
  };

  if (claimedEmail) {
    const r = await p.query(
      `SELECT id, display_name, email, claimed_email, phone, last_ip, mailbox
         FROM app.job_clients WHERE lower(claimed_email) = lower($1) LIMIT 5`,
      [claimedEmail]
    );
    r.rows.forEach((x) => push(x, 'claimed_address', 'strong'));
  }
  if (phone) {
    const r = await p.query(
      `SELECT id, display_name, email, claimed_email, phone, last_ip, mailbox
         FROM app.job_clients WHERE phone = $1 LIMIT 5`,
      [phone]
    );
    r.rows.forEach((x) => push(x, 'phone', 'strong'));
  }
  if (name && norm) {
    const r = await p.query(
      `SELECT id, display_name, email, claimed_email, phone, last_ip, mailbox
         FROM app.job_clients
        WHERE lower(display_name) = lower($1) AND last_ip = $2::inet LIMIT 5`,
      [name, norm]
    );
    r.rows.forEach((x) => push(x, 'name_and_ip', 'suggestive'));
  }
  if (norm) {
    const r = await p.query(
      `SELECT id, display_name, email, claimed_email, phone, last_ip, mailbox
         FROM app.job_clients WHERE last_ip = $1::inet
        ORDER BY updated_at DESC LIMIT 10`,
      [norm]
    );
    r.rows.forEach((x) => push(x, 'ip_only', 'context_only'));
  }
  return found.sort((a, b) => rank(b.strength) - rank(a.strength));
}

function rank(strength) {
  return { strong: 3, suggestive: 2, context_only: 1 }[strength] || 0;
}

/** Every address this client has ever sent from, and whether one is still live. */
export async function listMailboxes(clientId) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, address, is_active, reason, assigned_at, released_at
       FROM app.job_client_mailboxes WHERE client_id = $1 ORDER BY id`,
    [clientId]
  );
  return rows;
}

/**
 * The one address this candidate may send from.
 *
 * The rule the product needs is "one person, one jobbymcjobberson.com account",
 * and that has to hold across renames too - a candidate who corrects their name
 * must not end up with two live addresses, because either could then receive a
 * reply and there is no way to tell which conversation it belongs to.
 *
 * Returns an existing live address rather than minting a new one, so a repeat
 * call is idempotent instead of accumulating `name2@`, `name3@`, ...
 */
export async function primaryMailbox(clientId) {
  const all = await listMailboxes(clientId);
  const live = all.filter((m) => m.is_active);
  if (live.length > 1) {
    throw new Error(
      `client ${clientId} has ${live.length} live mailboxes (${live.map((m) => m.address).join(', ')}). ` +
      `Exactly one is allowed - release the others before sending.`
    );
  }
  return live[0] || all[all.length - 1] || null;
}

/**
 * What to call this candidate, and which record it was read from.
 *
 * There are two places a candidate's name lives: `job_clients.display_name`,
 * written once at onboarding, and `dossier.name`, which the candidate and Jobby
 * both edit afterwards. The dossier wins, because it is the record the candidate
 * is looking at when they correct a mistake and the one the agent is told to
 * change.
 *
 * The reason this is a function rather than a `COALESCE` at each call site is
 * that the call sites disagreed. `persona.mjs` read dossier-first, `server.js`
 * read client-only, and `reconcile.mjs` read client-first. So a candidate could be
 * "Joe Lee" in the agent's own system prompt and "Jordan Ellis" on the page
 * naming them, at the same moment, with nothing broken anywhere — which is the
 * hardest kind of bug to report because both halves look correct.
 *
 * `job_clients.display_name` is kept in step by `setDisplayName` rather than being
 * read as an authority, so the two cannot drift again. It is still written because
 * the mailbox is derived from it and a mailbox cannot be renamed after mail has
 * gone out from it.
 *
 * Returns the name and where it came from, because the page says so: a candidate
 * who edits the dossier and watches the card not move needs to be told which
 * record won, not left to infer it.
 */
export function effectiveName(client, dossier) {
  const fromDossier = typeof dossier?.name === 'string' ? dossier.name.trim() : '';
  if (fromDossier) return { value: fromDossier, source: 'dossier' };
  const fromClient = typeof client?.display_name === 'string' ? client.display_name.trim() : '';
  if (fromClient) return { value: fromClient, source: 'client' };
  return { value: null, source: 'not_stated' };
}

/**
 * The candidate's own contact details, from one record.
 *
 * Same split as the name, and it was the same bug: a resume carries a phone and a
 * location, they land in the dossier, and the mission card reads columns that
 * nothing writes. So a candidate who had given their number on their resume saw
 * "not given" on the card and was asked for it again by an edit form that
 * pre-filled from the wrong place.
 *
 * Field names line up between the two — `dossier.phone` and `job_clients.phone`,
 * `dossier.location` and `job_clients.location` — so this is a per-field fallback
 * rather than a whole-record choice. One can be present and the other absent, and
 * the card should show whichever has something in it.
 */
export function effectiveContact(client, dossier) {
  const pick = (dossierKey, clientKey) => {
    const d = typeof dossier?.[dossierKey] === 'string' ? dossier[dossierKey].trim() : '';
    if (d) return { value: d, source: 'dossier' };
    const c = typeof client?.[clientKey] === 'string' ? client[clientKey].trim() : '';
    if (c) return { value: c, source: 'client' };
    return { value: null, source: 'not_stated' };
  };
  return {
    name: effectiveName(client, dossier),
    phone: pick('phone', 'phone'),
    location: pick('location', 'location'),
  };
}

/**
 * Move the candidate's sending address to match a new name.
 *
 * A rename changes the address, because an address derived from the old name is a
 * lie about who is applying: `jordan.ellis@` on an application from Joe Lee is
 * something a recruiter will notice, and something the candidate cannot explain.
 *
 * The old address is *not* released. It is marked superseded and stays resolvable,
 * so a reply to an application that went out last week still finds the person who
 * sent it. "Stopped sending from it" and "nobody owns it any more" are different
 * states and only the second is dangerous.
 *
 * One transaction, because the two halves have to agree: a new address in
 * `job_clients` with no history row, or a history row with the column still
 * pointing at the old address, would either orphan replies or send from an
 * address the record does not claim.
 *
 * Reuses an address this candidate held before if it is free of *other* people —
 * renaming back to a previous name returns the address they had, rather than
 * growing a suffix for no reason.
 *
 * Returns what changed, including when nothing did, because a caller that reports
 * "your address is now X" when it is already X is making a claim about a change
 * that did not happen.
 */
export async function renameMailbox(clientId, name, { reason = 'renamed' } = {}) {
  const p = await db();
  const c = await p.connect();
  try {
    await c.query('BEGIN');

    const { rows } = await c.query(
      'SELECT id, display_name, mailbox FROM app.job_clients WHERE id = $1 FOR UPDATE', [clientId]);
    const client = rows[0];
    if (!client) { await c.query('ROLLBACK'); return { changed: false, reason: 'no-client' }; }

    const base = deriveLocalPart(name || client.display_name);
    const wanted = base
      ? `${base}@${MAILBOX_DOMAIN}`
      // Nothing derivable from the name. An obviously-generated address, because a
      // plausible-looking wrong one would be trusted.
      : fallbackAddress(clientId);

    // Addresses this candidate has already used, so a rename back to an earlier
    // name can reclaim one rather than accumulating suffixes.
    const { rows: mine } = await c.query(
      'SELECT address FROM app.job_client_mailboxes WHERE client_id = $1', [clientId]);
    const alreadyMine = new Set(mine.map((r) => r.address.toLowerCase()));

    // Anything held by somebody else, in use or only historically.
    const { rows: theirs } = await c.query(
      `SELECT split_part(lower(address), '@', 1) AS local FROM app.job_client_mailboxes
        WHERE client_id <> $1
        UNION
       SELECT split_part(lower(mailbox), '@', 1) AS local FROM app.job_clients
        WHERE mailbox IS NOT NULL AND id <> $1`,
      [clientId]);
    const taken = new Set(theirs.map((r) => r.local).filter(Boolean));

    const current = client.mailbox ? client.mailbox.toLowerCase() : null;
    if (current && current === wanted.toLowerCase()) {
      await c.query('ROLLBACK');
      return { changed: false, reason: 'already-correct', address: current };
    }

    // Reclaim one of their own former addresses if it is the one the new name
    // derives and nobody else holds it.
    const local = (() => {
      const want = localPartOf(wanted);
      if (alreadyMine.has(wanted.toLowerCase()) && !taken.has(want)) return want;
      return uniqueLocalPart(want, taken);
    })();
    if (!local) { await c.query('ROLLBACK'); return { changed: false, reason: 'exhausted' }; }
    const next = `${local}@${MAILBOX_DOMAIN}`;
    if (next.toLowerCase() === current) {
      await c.query('ROLLBACK');
      return { changed: false, reason: 'already-correct', address: next };
    }

    // Release the outgoing address BEFORE claiming the incoming one.
    //
    // `job_client_mailboxes_one_active_per_client` is UNIQUE (client_id) WHERE
    // is_active, so claiming first briefly holds two active rows for one client and
    // the insert raises 23505 — rolling the whole rename back and leaving a caller
    // that believes it renamed somebody. That is how the first version of this
    // reported a successful rename and moved nothing at all: the name was saved, the
    // address was not, and the tool said it had done both.
    //
    // The old row is kept and only marked inactive, so mail to it still resolves to
    // the person who used it.
    if (current) {
      await c.query(
        `UPDATE app.job_client_mailboxes
            SET is_active = false, released_at = now(),
                reason = COALESCE(reason, '') || ' | superseded by a rename'
          WHERE client_id = $1 AND is_active AND lower(address) <> $2`,
        [clientId, next]);
    }

    // Now the incoming address can be active without a second one existing.
    const { rows: claimed } = await c.query(
      `INSERT INTO app.job_client_mailboxes (client_id, address, is_active, reason)
       VALUES ($1, $2, true, $3)
       ON CONFLICT (address) DO UPDATE
         SET is_active = true, released_at = NULL, reason = EXCLUDED.reason
       WHERE app.job_client_mailboxes.client_id = $1
       RETURNING address`,
      [clientId, next, reason]);
    // The ON CONFLICT only updates when the existing row is already this client's,
    // so an empty result means somebody else holds it and the suffix was wrong.
    if (!claimed[0]) { await c.query('ROLLBACK'); return { changed: false, reason: 'address-held-elsewhere' }; }

    await c.query(
      'UPDATE app.job_clients SET mailbox = $2, display_name = $3, updated_at = now() WHERE id = $1',
      [clientId, next, name || client.display_name]);

    await c.query('COMMIT');
    return { changed: true, address: next, previous: current, reclaimed: alreadyMine.has(next.toLowerCase()) };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* the connection is already gone */ }
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Set the candidate's name, in both records, in one call.
 *
 * Two writes, and the dossier one is the real one. The client column is kept in
 * step rather than being treated as a separate truth, because leaving it to drift
 * is what produced a mission card reading "not set" for a candidate whose dossier
 * was complete — 12 of them, all of them from the onboarding path writing a name
 * that arrived before the resume did.
 *
 * The mailbox is deliberately not touched. `ensureMailbox` holds whatever address
 * it first assigned, on purpose: an application that went out from
 * jordan.ellis@jobbymcjobberson.com cannot be recalled by renaming the person to
 * Joe Lee, and a candidate whose applications land in an address nobody reads
 * because the product tidied up after itself has been harmed by the tidying.
 */
export async function setDisplayName(clientId, name, { updatedBy = 'jobby' } = {}) {
  return setCandidateDetails(clientId, { name }, { updatedBy });
}

/**
 * Write the candidate's own details to the dossier, and mirror them onto the
 * client columns that need one.
 *
 * One call, because the two records are one fact. A function that set the name
 * and left the phone to a different code path is how the name got fixed and the
 * phone stayed broken in the same release.
 *
 * The mirror columns are not authorities — `effectiveName` and `effectiveContact`
 * read the dossier first — but the mailbox is derived from the name, and the
 * reconcile job and the claim flow read the columns directly, so they are kept in
 * step rather than left to drift.
 *
 * Blank is a real value here: a candidate clearing their phone is recorded as
 * having no phone on file, and the audit row says so. Silently ignoring it would
 * make the edit form look broken.
 *
 * Only the dossier is written when nothing actually changed, so re-saving an
 * unchanged form does not bump the revision and make the page think the record
 * moved when it did not.
 */
export async function setCandidateDetails(clientId, details, { updatedBy = 'jobby' } = {}) {
  const clean = (v) => (typeof v === 'string' ? v.trim() : v === null ? null : undefined);
  const want = {
    name: clean(details.name),
    phone: clean(details.phone),
    location: clean(details.location),
  };
  const touched = Object.entries(want).filter(([, v]) => v !== undefined);
  if (!touched.length) return null;

  const p = await db();
  const current = await getDossier(clientId);
  // The client row, for the "did the name actually change" test that decides
  // whether the address has to move. Read before the column writes below, or the
  // comparison is always false and the address never follows the name.
  const clientRow = await getClient(clientId);
  const dossier = { ...(current?.dossier || {}) };
  const audits = [];
  for (const [key, value] of touched) {
    const before = typeof dossier[key] === 'string' ? dossier[key] : null;
    if (before === value) continue;
    dossier[key] = value;
    audits.push({
      op: value === null ? 'delete' : 'update',
      path: key,
      before_value: before,
      after_value: value,
      reason: 'changed by the candidate',
      actor: updatedBy,
      confirmedByUser: true,
    });
  }

  // The client columns, for the readers that bypass the dossier entirely.
  const columnFor = { name: 'display_name', phone: 'phone', location: 'location' };
  const sets = [];
  const values = [clientId];
  for (const [key, value] of touched) {
    sets.push(`${columnFor[key]} = $${values.length + 1}`);
    values.push(value);
  }
  if (sets.length) {
    await p.query(
      `UPDATE app.job_clients SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
      values);
  }

  if (audits.length) {
    await saveDossier(clientId, dossier, { updatedBy, audits });
  }

  // The address follows the name.
  //
  // A candidate whose name changed and whose address did not is applying as
  // `jordan.ellis@` while being Joe Lee, and the mismatch is visible to every
  // recruiter who reads the application. So the address moves with the name.
  //
  // Deliberately after the dossier write, not before: if the rename cannot find a
  // free address, the name is still saved and the candidate still goes by it. The
  // address is a convenience; the name is who they are. Losing the name because a
  // local part was taken would be exactly backwards.
  let mailbox = null;
  if (want.name !== undefined && want.name && want.name !== clientRow?.display_name) {
    try {
      mailbox = await renameMailbox(clientId, want.name, { reason: `renamed from "${clientRow?.display_name || 'unset'}"` });
    } catch (e) {
      // Logged and out of the way. The name is saved either way, and the next
      // rename or the send path will settle the address.
      console.warn(`[jobby] client ${clientId}: name saved but the address did not move: ${e.message}`);
    }
  }

  return { changed: audits.map((a) => a.path), details: want, mailbox };
}

export async function getClient(clientId) {
  const p = await db();
  const { rows } = await p.query('SELECT * FROM app.job_clients WHERE id = $1', [clientId]);
  return rows[0] || null;
}

export async function updateClient(clientId, patch) {
  const allowed = ['display_name', 'email', 'phone', 'location', 'tracks', 'track_reasons',
    'daily_send_cap', 'mission_state', 'autonomy', 'kill_switch', 'notes', 'mailbox'];
  const keys = Object.keys(patch).filter(k => allowed.includes(k));
  if (!keys.length) return getClient(clientId);
  const p = await db();
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const { rows } = await p.query(
    `UPDATE app.job_clients SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [clientId, ...keys.map(k => patch[k])]);
  return rows[0] || null;
}

export async function getDossier(clientId) {
  const p = await db();
  const { rows } = await p.query(
    'SELECT * FROM app.job_dossiers WHERE client_id = $1', [clientId]);
  return rows[0] || null;
}

/* ── Per-candidate mailbox ─────────────────────────────────────────────────
 *
 * A candidate's address is derived once from their name and then held. It is not
 * recomputed on read, because a candidate who fixes a typo in their name
 * mid-search would otherwise lose the address they have already sent
 * applications from, and every reply already sent to it would go nowhere.
 */

/**
 * Every local part already in use, lowercased.
 *
 * Local parts rather than whole addresses, because that is what
 * uniqueLocalPart compares and the domain is fixed for all of them - so
 * local-part uniqueness and address uniqueness are the same constraint here.
 *
 * This returns split_part(...) rather than the raw column because getting that
 * wrong is silent: the column holds "maria.garcia@jobbymcjobberson.com", so
 * comparing it against the base "maria.garcia" finds no collision, returns the
 * same string, and the unique index then rejects the write on every attempt.
 */
async function takenLocalParts(exceptClientId = null) {
  const p = await db();
  // Both the address in use and every address this client or anyone else has ever
  // sent from. A released address is still claimed — replies to it are still
  // attributed to a person — so handing it to a new candidate would deliver one
  // person's mail to another. `job_clients.mailbox` alone would not catch that,
  // because a renamed client's old address is no longer in that column.
  const { rows } = await p.query(
    `SELECT local FROM (
       SELECT split_part(lower(mailbox), '@', 1) AS local, id
         FROM app.job_clients
        WHERE mailbox IS NOT NULL
        UNION ALL
       SELECT split_part(lower(address), '@', 1) AS local, client_id AS id
         FROM app.job_client_mailboxes
     ) t
     WHERE local IS NOT NULL AND ($1::int IS NULL OR id <> $1)`,
    [exceptClientId]);
  return new Set(rows.map(r => r.local).filter(Boolean));
}

/**
 * The candidate's address, assigning one on first use.
 *
 * Two candidates called Maria Garcia both derive "maria.garcia", so the choice
 * between them is made here rather than in the pure function - only the database
 * knows who has what. The unique index is the authority: this picks a candidate
 * address and then claims it, and a lost race is retried with the next suffix
 * rather than swallowed. Swallowing it would hand one candidate the other's mail.
 */
export async function ensureMailbox(clientId, name) {
  const existing = await getClient(clientId);
  if (!existing) return { address: null, reason: 'no-client' };
  if (existing.mailbox) {
    return { address: existing.mailbox, created: false, displayName: existing.display_name };
  }

  const base = deriveLocalPart(name || existing.display_name);
  const address = base
    ? `${base}@${MAILBOX_DOMAIN}`
    // Nothing derivable from the name, so an obviously-generated address. A
    // plausible-looking wrong address would be trusted; an obvious one is not.
    : fallbackAddress(clientId);

  // One suffix rule, in one place: `uniqueLocalPart`.
  //
  // The first version wrapped it in a retry loop that re-read the same `taken` set
  // each time, so it derived the same candidate every attempt and only advanced on a
  // lost race. The second replaced it with a private walk of its own — which started
  // its suffixes at 1 while `uniqueLocalPart` starts at 2, so the second Maria Garcia
  // was offered `maria.garcia1@` by one path and `maria.garcia2@` by the other. Two
  // rules for one decision, which is worse than the loop it replaced: the loop had one
  // rule inside it, this had two rules and a comment explaining why not to write a
  // second.
  //
  // So the walk is `uniqueLocalPart`'s alone, and a collision feeds back into the
  // exclusion set so the next call resumes further along. The bound is a guard
  // against a pathological loop, not a cap on the search — finding a free suffix is
  // `uniqueLocalPart`'s job and it has its own ceiling.
  const avoid = new Set();

  for (let attempt = 0; attempt < 1000; attempt++) {
    const taken = await takenLocalParts(clientId);
    for (const skip of avoid) taken.add(skip);
    const local = uniqueLocalPart(localPartOf(address), taken);
    if (!local) return { address: null, reason: 'exhausted' };
    const candidate = `${local}@${MAILBOX_DOMAIN}`;
    const p = await db();
    try {
      const { rows } = await p.query(
        `UPDATE app.job_clients SET mailbox = $2, updated_at = now()
          WHERE id = $1 AND mailbox IS NULL RETURNING mailbox, display_name`,
        [clientId, candidate]);
      if (rows[0]) {
        // Recorded in the address history as well as the column.
        //
        // Without this, a first address assigned after the migration had no history
        // row at all, so a later rename's "supersede the old row" matched nothing
        // and mail to the address this candidate had been answering stopped
        // resolving to them. Every path that creates an address writes here, not
        // only the one that creates a second one — and this is the common one.
        //
        // Never fatal. The address is live and in use; a missing history row is a far
        // smaller problem than a candidate left with no address at all.
        await p.query(
          `INSERT INTO app.job_client_mailboxes (client_id, address, is_active, reason)
           VALUES ($1, $2, true, 'first address assigned')
           ON CONFLICT (address) DO UPDATE
             SET is_active = true, released_at = NULL
           WHERE app.job_client_mailboxes.client_id = $1`,
          [clientId, candidate],
        ).catch((e) => {
          console.warn(`[jobby] client ${clientId}: assigned ${candidate} but could not record it in the address history: ${e.message}`);
        });
        return { address: rows[0].mailbox, created: true, displayName: rows[0].display_name };
      }
      // The WHERE matched nothing, so this client already holds an address. Re-read
      // rather than trying another: it exists and it is this client's.
      const now = await getClient(clientId);
      if (now?.mailbox) return { address: now.mailbox, created: false, displayName: now.display_name };
      return { address: null, reason: 'client-changed' };
    } catch (e) {
      // 23505: claimed between our read and our write. It is taken now, so the walk
      // steps over it — which only works because `avoid` carries it forward.
      if (e.code === '23505' || /job_clients_mailbox_uniq/.test(String(e.message))) {
        avoid.add(local);
        continue;
      }
      throw e;
    }
  }
  return { address: null, reason: 'exhausted' };
}

/**
 * The client a reply to this address belongs to.
 *
 * Compared as a whole, lowercased address, because that is what the column
 * stores. Comparing a local part against a stored address never matches, which
 * is the quiet version of this bug: every reply resolves to nobody and nothing
 * reports an error.
 *
 * The domain is checked as well as the local part, and matched exactly. A
 * substring comparison would let "grace.hopper@jobbymcjobberson.com.evil.test"
 * resolve to this candidate, which is precisely the address an attacker
 * registers to have mail delivered into their own inbox.
 */
export async function getClientByMailbox(address) {
  const value = String(address || '').trim().toLowerCase();
  if (!isCandidateMailbox(value)) return null;
  const p = await db();
  const { rows } = await p.query(
    'SELECT * FROM app.job_clients WHERE lower(mailbox) = $1 LIMIT 1', [value]);
  if (rows[0]) return rows[0];
  // A former address still resolves.
  //
  // Renaming moves the address a candidate sends from, so mail to the old one has
  // to keep finding them. The catch-all delivers it either way — the domain is
  // ours — but delivery is not attribution: without this, a recruiter's reply to
  // last week's application arrives with nobody attached and is silently never
  // read, which is worse than the reply not arriving because at least a bounce
  // would have been noticed.
  //
  // The history table rather than a scan of released columns, because there is no
  // column left to scan: the rename replaced it.
  const { rows: old } = await p.query(
    `SELECT c.* FROM app.job_client_mailboxes m
       JOIN app.job_clients c ON c.id = m.client_id
      WHERE lower(m.address) = $1 LIMIT 1`, [value]);
  return old[0] || null;
}

/** The client's address, or null if they have not been given one yet. */
export async function getMailbox(clientId) {
  const c = await getClient(clientId);
  return c?.mailbox || null;
}
/** Write a dossier and append its audit rows in the same transaction. */
export async function saveDossier(clientId, dossier, { updatedBy = 'jobby', sourceFilename = null, audits = [] } = {}) {
  const p = await db();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      'SELECT revision FROM app.job_dossiers WHERE client_id = $1', [clientId]);
    const revision = (existing[0]?.revision ?? 0) + 1;
    await client.query(
      `INSERT INTO app.job_dossiers (client_id, dossier, revision, updated_by, source_filename)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id) DO UPDATE SET
         dossier = EXCLUDED.dossier, revision = EXCLUDED.revision,
         updated_by = EXCLUDED.updated_by, source_filename = EXCLUDED.source_filename,
         updated_at = now()`,
      [clientId, JSON.stringify(dossier ?? {}), revision, updatedBy, sourceFilename]);
    for (const a of audits) {
      await client.query(
        `INSERT INTO app.job_dossier_edits
           (client_id, revision, op, path, before_value, after_value, reason, actor, confirmed_by_user)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [clientId, revision, a.op, a.path,
          a.before_value === undefined ? null : JSON.stringify(a.before_value),
          a.after_value === undefined ? null : JSON.stringify(a.after_value),
          a.reason ?? null, a.actor ?? 'jobby', Boolean(a.confirmedByUser)]);
    }
    await client.query('COMMIT');
    return revision;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getDossierEdits(clientId, limit = 50) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, client_id, revision, op, path, before_value, after_value, reason, actor,
            confirmed_by_user, created_at
     FROM app.job_dossier_edits WHERE client_id = $1 ORDER BY id DESC LIMIT $2`,
    [clientId, limit]);
  return rows;
}

export async function replaceActions(clientId, actions) {
  const p = await db();
  await p.query('DELETE FROM app.job_actions WHERE client_id = $1 AND status = $2', [clientId, 'pending']);
  for (const a of actions) {
    await p.query(
      `INSERT INTO app.job_actions (client_id, track, title, detail, status, priority)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [clientId, a.track ?? null, a.title, a.detail ?? null, a.status ?? 'pending', a.priority ?? 3]);
  }
  return listActions(clientId);
}

export async function listActions(clientId, { status = null, limit = 100 } = {}) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT * FROM app.job_actions
     WHERE client_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY priority, id LIMIT $3`,
    [clientId, status, limit]);
  return rows;
}

export async function updateAction(clientId, actionId, patch) {
  const allowed = ['status', 'result', 'due_at', 'priority', 'title', 'detail', 'track'];
  const keys = Object.keys(patch).filter(k => allowed.includes(k));
  if (!keys.length) return null;
  const p = await db();
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  const { rows } = await p.query(
    `UPDATE app.job_actions SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $1 AND client_id = $2 RETURNING *`,
    [actionId, clientId, ...keys.map(k => patch[k])]);
  return rows[0] || null;
}

export async function addOpportunity(clientId, opp) {
  const p = await db();
  const { rows } = await p.query(
    `INSERT INTO app.job_opportunities
       (client_id, action_id, company, role, url, source, track, status, match_score, match_notes, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [clientId, opp.action_id ?? null, opp.company ?? null, opp.role,
      opp.url ?? null, opp.source ?? null, opp.track ?? null, opp.status ?? 'new',
      opp.match_score ?? null, opp.match_notes ?? null,
      JSON.stringify(opp.evidence ?? {})]);
  return rows[0];
}

export async function listOpportunities(clientId, { status = null, limit = 100 } = {}) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT * FROM app.job_opportunities
     WHERE client_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY match_score DESC NULLS LAST, id DESC LIMIT $3`,
    [clientId, status, limit]);
  return rows;
}

/**
 * One opportunity, by id or by url.
 *
 * Both lookups, because the agent holds an id in one turn and a url in the next
 * and has no reason to remember which. Scoped to the client on both: an id is
 * guessable, and an opportunity belonging to another candidate is not something
 * to return on the strength of a number.
 */
export async function getOpportunity(clientId, { id = null, url = null } = {}) {
  if (!id && !url) return null;
  const p = await db();
  const { rows } = await p.query(
    `SELECT * FROM app.job_opportunities
      WHERE client_id = $1
        AND ($2::int IS NOT NULL AND id = $2
             OR $2::int IS NULL AND $3::text IS NOT NULL AND url = $3)
      ORDER BY id DESC LIMIT 1`,
    [clientId, id ?? null, url ?? null]);
  return rows[0] || null;
}

/**
 * The daily send allowance.
 *
 * Returns a decision rather than throwing, because the caller needs to tell the
 * user *why* nothing went out — cap reached, kill switch on, autonomy set to
 * draft — and a silent no-op reads as a broken agent.
 */
export async function canSend(clientId) {
  const client = await getClient(clientId);
  if (!client) return { allowed: false, reason: 'no client', sent: 0, cap: 0 };

  // The count and the cap are read before any of the verdicts, and returned with
  // every one of them.
  //
  // They used to be computed last, so the three early returns — kill switch, draft
  // mode, and no client — returned an object with no `sent` and no `cap` in it.
  // The mission card renders "Sent today" as `${sent} of ${cap}`, so a candidate
  // who switched to draft mode, which is the single most common setting to switch
  // to, saw the literal text "undefined of undefined" where their send count
  // should be. The numbers are wanted for display whether or not sending is
  // allowed, so they are no longer conditional on the answer.
  const p = await db();
  const { rows } = await p.query(
    `SELECT count(*)::int AS n FROM app.job_outreach
     WHERE client_id = $1 AND status = 'sent' AND created_at > now() - INTERVAL '24 hours'`,
    [clientId]);
  const sent = rows[0]?.n ?? 0;
  const cap = client.daily_send_cap;
  const counts = { sent, cap, remaining: Math.max(0, cap - sent) };

  if (client.kill_switch) {
    return { ...counts, allowed: false, reason: 'kill switch is engaged', code: 'kill_switch' };
  }
  if (client.autonomy !== 'auto') {
    return { ...counts, allowed: false, reason: 'client is in draft mode', code: 'draft_mode' };
  }
  if (sent >= cap) {
    return {
      ...counts, allowed: false, code: 'daily_cap',
      reason: `daily send cap reached (${sent}/${cap})`,
    };
  }
  return { allowed: true, ...counts };
}

/** Identical recipient + subject inside the cooldown is almost always a retry loop. */
export async function findRecentDuplicate(clientId, recipient, subject) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, created_at, status FROM app.job_outreach
     WHERE client_id = $1 AND lower(recipient) = lower($2) AND subject = $3
       AND created_at > now() - ($4 || ' milliseconds')::interval
     ORDER BY id DESC LIMIT 1`,
    [clientId, recipient ?? '', subject ?? '', String(COOLDOWN_MS)]);
  return rows[0] || null;
}

export async function recordOutreach(clientId, payload) {
  const p = await db();
  const { rows } = await p.query(
    `INSERT INTO app.job_outreach
       (client_id, opportunity_id, action_id, channel, recipient, subject, body, status, provider_id, error, approved_by, sent_at, from_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [clientId, payload.opportunity_id ?? null, payload.action_id ?? null,
      payload.channel ?? 'email', payload.recipient ?? null, payload.subject ?? null,
      payload.body ?? null, payload.status ?? 'queued', payload.provider_id ?? null,
      payload.error ?? null, payload.approved_by ?? null,
      payload.status === 'sent' ? new Date() : null,
      // Recorded because an inbound webhook sees only a recipient address. This
      // is the join that lets a reply be traced back to the send that caused it.
      payload.from_address ?? null]);
  return rows[0];
}

export async function markOutreachSent(outreachId, providerId, fromAddress = null) {
  // from_address is the address it actually went out as. Recorded here because
  // the row is written before the transport runs, so this is the only point at
  // which the real sending address is known - and an inbound webhook sees only
  // a recipient, so this is the join that ties a reply to its send.
  const p = await db();
  const { rows } = await p.query(
    `UPDATE app.job_outreach
     SET status = 'sent', provider_id = $2, from_address = COALESCE($3, from_address), sent_at = now()
     WHERE id = $1 RETURNING *`, [outreachId, providerId ?? null, fromAddress ?? null]);
  return rows[0] || null;
}

export async function recentOutreach(clientId, limit = 10) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT id, channel, recipient, subject, body, status, provider_id, error,
            approved_by, sent_at, created_at
     FROM app.job_outreach WHERE client_id = $1 ORDER BY id DESC LIMIT $2`,
    [clientId, limit]);
  return rows;
}

export async function appendMessage(clientId, role, content, toolCalls = []) {
  const p = await db();
  const { rows } = await p.query(
    `INSERT INTO app.job_chat_messages (client_id, role, content, tool_calls)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [clientId, role, content, JSON.stringify(toolCalls ?? [])]);
  return rows[0];
}

export async function history(clientId, limit = 30) {
  const p = await db();
  const { rows } = await p.query(
    `SELECT role, content, tool_calls, created_at FROM app.job_chat_messages
     WHERE client_id = $1 ORDER BY id DESC LIMIT $2`, [clientId, limit]);
  return rows.reverse();
}

/** Everything the chat needs, in one round trip. */
export async function loadContext(clientId) {
  const [client, dossierRow, actions, opportunities, outreach] = await Promise.all([
    getClient(clientId), getDossier(clientId), listActions(clientId, { limit: 60 }),
    listOpportunities(clientId, { limit: 40 }), recentOutreach(clientId, 10),
  ]);
  return {
    client,
    dossier: dossierRow?.dossier ?? null,
    dossierRow,
    plan: {
      actions,
      trackReasons: client?.track_reasons ?? {},
    },
    actions,
    opportunities,
    outreach,
  };
}

export function newIdempotencyKey() { return randomUUID(); }
