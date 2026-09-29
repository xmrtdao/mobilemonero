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
  const { rows } = await p.query(
    `SELECT split_part(lower(mailbox), '@', 1) AS local FROM app.job_clients
     WHERE mailbox IS NOT NULL AND ($1::int IS NULL OR id <> $1)`,
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

  for (let attempt = 0; attempt < 12; attempt++) {
    const taken = await takenLocalParts(clientId);
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
        return { address: rows[0].mailbox, created: true, displayName: rows[0].display_name };
      }
      // The WHERE matched nothing, so another request assigned it first. Re-read
      // rather than trying again: the address now exists and it is this client's.
      const now = await getClient(clientId);
      if (now?.mailbox) return { address: now.mailbox, created: false, displayName: now.display_name };
    } catch (e) {
      // 23505 is the unique index firing: someone claimed this address between
      // our read and our write. Retry with the next suffix.
      if (e.code === '23505' || /job_clients_mailbox_uniq/.test(String(e.message))) continue;
      throw e;
    }
  }
  return { address: null, reason: 'contention' };
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
  return rows[0] || null;
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
 * The daily send allowance.
 *
 * Returns a decision rather than throwing, because the caller needs to tell the
 * user *why* nothing went out — cap reached, kill switch on, autonomy set to
 * draft — and a silent no-op reads as a broken agent.
 */
export async function canSend(clientId) {
  const client = await getClient(clientId);
  if (!client) return { allowed: false, reason: 'no client' };
  if (client.kill_switch) {
    return { allowed: false, reason: 'kill switch is engaged', code: 'kill_switch' };
  }
  if (client.autonomy !== 'auto') {
    return { allowed: false, reason: 'client is in draft mode', code: 'draft_mode' };
  }
  const p = await db();
  const { rows } = await p.query(
    `SELECT count(*)::int AS n FROM app.job_outreach
     WHERE client_id = $1 AND status = 'sent' AND created_at > now() - INTERVAL '24 hours'`,
    [clientId]);
  const sent = rows[0]?.n ?? 0;
  if (sent >= client.daily_send_cap) {
    return {
      allowed: false, code: 'daily_cap', sent, cap: client.daily_send_cap,
      reason: `daily send cap reached (${sent}/${client.daily_send_cap})`,
    };
  }
  return { allowed: true, sent, cap: client.daily_send_cap, remaining: client.daily_send_cap - sent };
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
