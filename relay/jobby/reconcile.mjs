// Consolidating duplicate client records, and detecting duplicates inside one
// dossier.
//
// Two separate problems, both observed in real data.
//
// 1. THE SAME PERSON, MANY CLIENTS. resolveJobbyClient keys on the session id
//    alone, so every new browser session is a new person. One resume uploaded
//    repeatedly produced 21 client records for one human. Everything that
//    matters hangs off client_id - opportunities, outreach, actions, chat - so a
//    duplicate is not cosmetic: an application sent under the wrong record, and a
//    recruiter's reply filed against a client with no history.
//
// 2. THE SAME URL, MANY FIELDS. One extraction put github.com/xmrtdao into
//    links.github, links.website AND links.portfolio. A form asking separately
//    for a website and a portfolio then gets the same answer twice, and the
//    candidate looks as though they have three things to show rather than one.
//
// Both are safe to collapse only in one direction: duplicates are merged into a
// survivor, and the survivor is never deleted, because it is the record an
// application and a reply will be filed against.

import pg from 'pg';

/** Every table hanging off client_id, and what a consolidation has to move. */
const CHILD_TABLES = [
  'job_actions', 'job_chat_messages', 'job_dossier_edits', 'job_dossiers',
  'job_google_accounts', 'job_oauth_states', 'job_calendly_accounts',
  'job_opportunities', 'job_outreach', 'job_seen_replies', 'job_sent_messages',
];

/** Which client wins when several match. The oldest holds the history. */
function pickSurvivor(clients) {
  return [...clients].sort((a, b) => {
    const at = new Date(a.created_at || 0).getTime();
    const bt = new Date(b.created_at || 0).getTime();
    if (at !== bt) return at - bt;
    return a.id - b.id;
  })[0];
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

/** A name, company, title - anything that should read the same twice. */
function normText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Normalise a phone number down to something comparable.
 *
 * Formatting is the only thing that varies between two records of the same
 * number - country codes, spaces, dashes, brackets - so all of it is stripped.
 * The leading + is kept because it is the one character that distinguishes a
 * full international number from a local one, and dropping it makes a US number
 * and a number elsewhere with the same digits look identical.
 */
function normPhone(p) {
  const digits = String(p || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  // A bare country code with no subscriber number carries no information.
  if (digits.replace(/\D/g, '').length < 7) return '';
  return digits;
}

/**
 * Find records that look like the same person on name AND phone, where the email
 * did not catch them.
 *
 * This exists because of a real miss. The candidate had two records - one on a
 * gmail address, one on a jobbymcjobberson.com mailbox - and every function here
 * keyed on email, so the two were never joined. They were the same human, and it
 * took reading both dossiers by hand to establish it. `claimed_email` fixes this
 * going forward, but only once somebody has verified an address, and a candidate
 * who has not yet verified anything still accumulates records.
 *
 * Why both fields, and why this is not identity:
 *
 *   name alone  useless. There are 868 clients on this database called
 *               "Jordan Ellis", because the tests create them. Matching on a name
 *               would propose merging hundreds of unrelated people.
 *   phone alone unsafe. Households share numbers, and a recycled one belongs to
 *               two people across a decade.
 *   name+phone  a strong signal that two records are one person, and still only
 *               a SUGGESTION. This function never merges. It returns candidates
 *               for the dedupe tool, which is dry-run by default and needs the
 *               user to say yes - the same gate every other merge passes through.
 *
 * The group-size cap is the other half. A signal that fires on 885 records is
 * describing the test fixtures, not a person, and offering to merge 885 rows is
 * both useless and slow. Above the cap the result is reported as noise so the
 * caller can say so rather than shrug.
 */
export async function findDuplicatesByIdentity(pool, { name, phone, maxGroup = 10 } = {}) {
  const key = normText(name);
  const tel = normPhone(phone);
  if (!key || !tel) return { supported: false, reason: 'need both a name and a phone number', clients: [] };

  const { rows } = await pool.query(
    `WITH ids AS (
       SELECT c.id, c.session_key, c.display_name, c.email, c.phone, c.location, c.created_at,
              COALESCE(NULLIF(TRIM(c.email), ''), NULLIF(TRIM(d.dossier->>'email'), '')) AS effective_email,
              -- Dossier first, for the same reason the session route and the agent's
              -- prompt read it that way: the dossier is the record a candidate is
              -- looking at when they correct a name, and the column is a mirror kept
              -- in step by setCandidateDetails. This used to be column-first, so
              -- reconcile judged two people to be the same or different on the
              -- copy rather than on the record — the one place where picking the
              -- wrong one merges two candidates' histories.
              COALESCE(NULLIF(TRIM(d.dossier->>'name'), ''), NULLIF(TRIM(c.display_name), '')) AS effective_name,
              COALESCE(NULLIF(TRIM(c.phone), ''), NULLIF(TRIM(d.dossier->>'phone'), '')) AS effective_phone
         FROM app.job_clients c
         LEFT JOIN app.job_dossiers d ON d.client_id = c.id
     )
     SELECT * FROM ids
      WHERE regexp_replace(effective_phone, '[^0-9+]', '', 'g') = $2
        -- Order matters: LOWER() must be INSIDE, applied before the character
        -- class runs. Writing it as LOWER(regexp_replace(name, '[^a-z0-9]+','','g'))
        -- deletes the capital letters instead of folding them, because [^a-z0-9]
        -- does not match A-Z - "JosephAndrewLee" normalises to "osephndrewee".
        -- That fails silently and in the most convincing direction possible: a
        -- capitalised name matches nothing, a lowercased one matches, and the
        -- function reports "no duplicates found" having found none.
        AND regexp_replace(LOWER(effective_name), '[^a-z0-9]+', '', 'g') = $1
      ORDER BY created_at, id`,
    [key, tel]);

  // Different addresses on purpose: if they already matched by email this adds
  // nothing, and reporting them again would train the candidate to ignore the tool.
  const distinct = new Map();
  for (const r of rows) {
    const e = normEmail(r.effective_email);
    if (!distinct.has(e)) distinct.set(e, r);
  }
  const clients = [...distinct.values()].map((r) => ({ ...r, email: r.effective_email || r.email }));

  if (clients.length < 2) {
    return { supported: true, clients: [], duplicate: false };
  }
  if (clients.length > maxGroup) {
    return {
      supported: true, clients: [], duplicate: false, noise: true,
      groupSize: clients.length,
      reason: `${clients.length} records share this name and phone number, which is a shared `
        + `number or test data rather than one person. Not offering to merge them.`,
    };
  }
  return { supported: true, clients, duplicate: true, groupSize: clients.length };
}

/**
 * Find every client that is the same person, by email.
 *
 * Only email is used to identify. Names collide, phone formats vary, and neither is
 * something to assert identity on - but an email address is a claim the candidate
 * made about themselves in a document, and two records carrying the same one are
 * the same person for every practical purpose here.
 *
 * The address is looked for in BOTH places it can live. The candidate's email is
 * written into the parsed dossier, not into job_clients.email, so a search of the
 * client column alone finds nothing: for one real person with twenty-one records it
 * returned zero, and the dedupe tool built on it would have reported "there is only
 * one record" while there were twenty-one. Both columns are searched, and the
 * dossier is the one that actually holds it.
 *
 * Email alone is also not enough on its own. A candidate who uses a personal
 * address on one device and their jobbymcjobberson.com mailbox on another has two
 * records and no shared email, which is exactly what happened here - see
 * findDuplicatesByIdentity, which is offered alongside this and never merges on
 * its own.
 */
export async function findDuplicatesByEmail(pool, email) {
  const key = normEmail(email);
  if (!key) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (c.id)
            c.id, c.session_key, c.display_name, c.email, c.phone, c.location,
            c.mailbox, c.created_at,
            COALESCE(NULLIF(TRIM(c.email), ''),
                     NULLIF(TRIM(d.dossier->>'email'), '')) AS effective_email
       FROM app.job_clients c
       LEFT JOIN app.job_dossiers d ON d.client_id = c.id
      WHERE LOWER(TRIM(COALESCE(c.email, ''))) = $1
         OR LOWER(TRIM(COALESCE(d.dossier->>'email', ''))) = $1
      ORDER BY c.id, c.created_at`, [key]);
  return rows.map(r => ({ ...r, email: r.effective_email || r.email }));
}

/**
 * Consolidate a set of duplicate clients into one.
 *
 * The survivor keeps its own id. Everything the other records held is moved to it,
 * and only where the survivor has nothing - a dossier the survivor has is richer
 * than a blank one, and an outreach row that already has a provider_id must not be
 * duplicated into a second "sent".
 *
 * @param {object} opts.dryRun  report what would move without writing
 */
export async function consolidateClients(pool, clientIds, { dryRun = false, reason = 'duplicate records for one person' } = {}) {
  if (!Array.isArray(clientIds) || clientIds.length < 2) {
    return { error: 'need at least two client ids to consolidate' };
  }
  const ids = [...new Set(clientIds.map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
  if (ids.length < 2) return { error: 'need at least two distinct client ids' };

  const { rows } = await pool.query(
    `SELECT id, session_key, display_name, email, phone, location, mailbox, created_at
       FROM app.job_clients WHERE id = ANY($1::int[]) ORDER BY created_at, id`, [ids]);
  if (rows.length < 2) {
    return { error: `only ${rows.length} of those clients exist` };
  }

  const survivor = pickSurvivor(rows);
  const doomed = rows.filter(r => r.id !== survivor.id);
  const report = { survivor: survivor.id, merged: [], moved: {}, skipped: [], dryRun };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── One active row per table where the schema demands it ────────────────
    // job_dossiers, job_google_accounts and job_calendly_accounts each hold one
    // row per client, so a naive re-point would violate a unique constraint.
    //
    // The dossier is MERGED, not picked. This is the correction: the rule used to
    // be "the survivor's row wins", and that is backwards. The survivor is chosen
    // for being the oldest, which is right for the identity - it holds the history -
    // but its dossier is the one most likely to be the most stale. Consolidating 23
    // records this way kept a revision-5 dossier with four roles and no skills and
    // discarded every newer, richer upload behind it. The candidate's own record
    // was the thing being lost.
    //
    // So the dossiers are folded together oldest-first, which is the same
    // augment-don't-replace rule the multi-resume merge follows. Connected
    // accounts are the opposite case and are still taken wholesale: a refresh
    // token is not a document, and there is only one that can be live.
    const SINGLE_ROW = new Set(['job_google_accounts', 'job_calendly_accounts', 'job_oauth_states']);

    {
      const { mergeDossiers } = await import('./dossier-merge.mjs');
      const all = await client.query(
        `SELECT client_id, dossier, revision, updated_at FROM app.job_dossiers
          WHERE client_id = ANY($1::int[])
          ORDER BY updated_at NULLS FIRST, client_id`, [[survivor.id, ...doomed.map(d => d.id)]]);
      if (all.rows.length > 1) {
        let merged = null;
        const stats = { added_roles: 0, added_skills: 0, filled_gaps: 0, conflicts: 0 };
        for (const r of all.rows) {
          const step = mergeDossiers(merged, r.dossier || {});
          merged = step.dossier;
          for (const k of Object.keys(stats)) stats[k] = Math.max(stats[k], step.stats?.[k] || 0);
        }
        report.dossierMerged = {
          sources: all.rows.length,
          roles: (merged?.employment || []).length,
          skills: (merged?.skills || []).length,
          conflicts: stats.conflicts,
        };
        if (!dryRun) {
          await client.query(
            `INSERT INTO app.job_dossiers (client_id, dossier, revision, updated_at)
                  VALUES ($1, $2, 1, now())
             ON CONFLICT (client_id) DO UPDATE
                SET dossier = EXCLUDED.dossier,
                    revision = app.job_dossiers.revision + 1,
                    updated_at = now()`,
            [survivor.id, JSON.stringify(merged)]);
          const drop = await client.query(
            'DELETE FROM app.job_dossiers WHERE client_id = ANY($1::int[])', [doomed.map(d => d.id)]);
          report.moved['job_dossiers (discarded)'] = drop.rowCount;
        }
      } else if (all.rows.length === 1 && !dryRun) {
        await client.query('UPDATE app.job_dossiers SET client_id = $1 WHERE client_id = $2',
          [survivor.id, all.rows[0].client_id]);
        report.moved['job_dossiers'] = 1;
      }
    }

    for (const table of SINGLE_ROW) {
      const has = await client.query(
        `SELECT count(*)::int c FROM ${table} WHERE client_id = $1`, [survivor.id]);
      if (has.rows[0].c > 0) { report.skipped.push(`${table}: survivor already has a row`); continue; }
      const donors = await client.query(
        `SELECT count(*)::int c FROM ${table} WHERE client_id = ANY($1::int[])`, [doomed.map(d => d.id)]);
      if (!donors.rows[0].c) continue;
      const take = await client.query(
        `UPDATE ${table} SET client_id = $1
          WHERE ctid = (SELECT ctid FROM ${table}
                         WHERE client_id = ANY($2::int[])
                         ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST, id DESC
                         LIMIT 1)
          RETURNING client_id`, [survivor.id, doomed.map(d => d.id)]);
      if (take.rowCount) {
        report.moved[table] = 1;
        const drop = await client.query(
          `DELETE FROM ${table} WHERE client_id = ANY($1::int[])`, [doomed.map(d => d.id)]);
        if (drop.rowCount > 1) report.moved[`${table} (discarded)`] = drop.rowCount - 1;
      }
    }

    // ── Everything else moves wholesale ─────────────────────────────────────
    for (const table of CHILD_TABLES) {
      if (SINGLE_ROW.has(table) || table === 'job_dossiers') continue;
      const exists = await client.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema='app' AND table_name=$1`, [table]);
      if (!exists.rowCount) continue;
      const res = await client.query(
        `UPDATE ${table} SET client_id = $1 WHERE client_id = ANY($2::int[])`, [survivor.id, doomed.map(d => d.id)]);
      if (res.rowCount) report.moved[table] = res.rowCount;
    }

    // ── Fill the survivor's profile from the duplicates ─────────────────────
    for (const field of ['display_name', 'email', 'phone', 'location', 'mailbox']) {
      const have = survivor[field];
      if (have) continue;
      const donor = doomed.find(d => d[field]);
      if (donor) {
        report.merged.push({ field, from: donor.id, value: donor[field] });
        if (!dryRun) await client.query(`UPDATE app.job_clients SET ${field} = $2 WHERE id = $1`, [survivor.id, donor[field]]);
      }
    }

    // ── The duplicates go ──────────────────────────────────────────────────
    if (!dryRun) {
      for (const d of doomed) {
        // The mailbox is unique per client, so it cannot simply travel with the
        // row; it is released first and the survivor adopts it if it has none.
        await client.query('UPDATE app.job_clients SET mailbox = NULL WHERE id = $1', [d.id]);
        const del = await client.query('DELETE FROM app.job_clients WHERE id = $1', [d.id]);
        report.merged.push({ removed: d.id, deleted: del.rowCount });
      }
      if (survivor.mailbox) {
        await client.query('UPDATE app.job_clients SET mailbox = NULL WHERE id = $1', [survivor.id]);
        const adopt = doomed.find(d => d.mailbox);
        if (adopt) {
          await client.query('UPDATE app.job_clients SET mailbox = $2 WHERE id = $1', [survivor.id, adopt.mailbox]);
          report.merged.push({ field: 'mailbox', from: adopt.id, value: adopt.mailbox });
        }
      }
    }

    if (!dryRun) await client.query('COMMIT');
    else await client.query('ROLLBACK');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already gone */ }
    return { error: e.message, survivor: survivor.id };
  } finally {
    client.release();
  }

  return {
    ok: true,
    survivor: survivor.id,
    survivorEmail: survivor.email,
    removed: doomed.map(d => d.id),
    reason,
    ...report,
  };
}

/**
 * Collapse the same URL appearing in more than one link field.
 *
 * github.com/xmrtdao was recorded as github, as website and as portfolio. A
 * tailored resume commonly lists a handful of URLs, and the extractor files each
 * under every field it plausibly fits, so a single account ends up answering three
 * questions on a form.
 *
 * The URL is kept in the most specific field it fits and cleared from the others.
 * Specificity is fixed order rather than a guess: LinkedIn and GitHub name a
 * specific service, portfolio names a kind of artefact, website is the catch-all.
 */
const LINK_SPECIFICITY = ['linkedin', 'github', 'portfolio', 'website', 'other'];

function normUrl(u) {
  return String(u || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

export function dedupeLinks(dossier) {
  const links = dossier?.links;
  if (!links || typeof links !== 'object') return { changed: false, cleared: [] };

  // A plain URL map: field -> url. `other` is a list and handled after.
  const owner = new Map();     // normalised url -> the field that keeps it
  const cleared = [];

  const byField = [...LINK_SPECIFICITY]
    .filter(f => f !== 'other' && typeof links[f] === 'string' && links[f].trim())
    .sort((a, b) => LINK_SPECIFICITY.indexOf(a) - LINK_SPECIFICITY.indexOf(b));

  for (const field of byField) {
    const key = normUrl(links[field]);
    if (!key) continue;
    if (!owner.has(key)) { owner.set(key, field); continue; }
    // A more specific field has already claimed this URL, so this one loses it.
    cleared.push({ field, url: links[field], kept_in: owner.get(key) });
    links[field] = null;
  }

  // `other` is a list; an entry duplicating a named field is removed, and an
  // entry that repeats another `other` entry is collapsed to one.
  if (Array.isArray(links.other)) {
    const seen = new Set();
    const kept = [];
    for (const raw of links.other) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const key = normUrl(raw);
      if (!key || seen.has(key) || owner.has(key)) {
        if (owner.has(key)) cleared.push({ field: 'other', url: raw, kept_in: owner.get(key) });
        continue;
      }
      seen.add(key);
      kept.push(raw);
    }
    if (kept.length !== links.other.length) cleared.push({ field: 'other', url: '(duplicates)', kept_in: '(dropped)' });
    links.other = kept;
  }

  return { changed: cleared.length > 0, cleared };
}
