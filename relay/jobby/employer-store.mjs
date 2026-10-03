/**
 * relay/jobby/employer-store.mjs — employers and their postings
 *
 * The employer side's persistence, kept apart from `store.mjs` for the reason
 * the tables are: a candidate and an employer are different people doing
 * different things, and a shared module is how one ends up querying the other.
 *
 * The load-bearing function here is `publishPosting`. Everything else writes rows;
 * that one decides whether a document strangers will believe is fit to be read by
 * strangers, and it refuses on the two failures that matter:
 *
 *   - the parse said it is incomplete (`needs_review`), and
 *   - there is nowhere for a candidate to go (no apply route).
 *
 * Both refusals name what is wrong and what would fix it. A posting blocked with
 * "cannot publish" and no reason is the same as no posting at all, from the
 * employer's side of the screen.
 */

// The pool accessor lives in store.mjs, not applications.mjs. Importing it from
// the wrong module resolves to undefined and every call below fails at runtime
// with "getPool is not a function" — while `node --check` passes, because it
// validates syntax and not bindings.
import { getPool } from './store.mjs';

const asText = (v, max = 400) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const asNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const asBool = (v) => (v === true || v === 'true' || v === 'on' || v === 1 || v === '1');

// ── Employers ───────────────────────────────────────────────────────────────

/**
 * Get or create the employer behind a session.
 *
 * `create: false` is the default on reads, matching the candidate side: a GET
 * must never mint a row, because then a crawler hitting the endpoint once would
 * create an employer and the board's author counts would be fiction.
 */
export async function getOrCreateEmployer(sessionKey, displayName = null, { create = true } = {}) {
  if (!sessionKey) throw new Error('sessionKey is required');
  const pool = await getPool();

  if (!create) {
    const { rows } = await pool.query('SELECT * FROM app.job_employers WHERE session_key = $1', [sessionKey]);
    return rows[0] || null;
  }

  const { rows } = await pool.query(
    `INSERT INTO app.job_employers (session_key, display_name)
     VALUES ($1, $2)
     ON CONFLICT (session_key) DO UPDATE
       SET display_name = COALESCE(NULLIF(app.job_employers.display_name, ''), EXCLUDED.display_name),
           updated_at = now()
     RETURNING *`,
    [sessionKey, asText(displayName, 200)]);
  return rows[0] || null;
}

export async function getEmployer(employerId) {
  const pool = await getPool();
  const { rows } = await pool.query('SELECT * FROM app.job_employers WHERE id = $1', [employerId]);
  return rows[0] || null;
}

const EMPLOYER_FIELDS = ['display_name', 'company', 'email', 'phone', 'website', 'verification_note'];

/**
 * Update the employer's own details.
 *
 * `verified` is not in the list. Verification is not something an employer can
 * set about themselves — a self-declared "verified" badge is the exact shape of
 * the trust mark this repo refuses to hand out, so it is writable only by
 * something acting as the service.
 */
export async function updateEmployer(employerId, patch = {}) {
  const keys = Object.keys(patch).filter((k) => EMPLOYER_FIELDS.includes(k));
  if (!keys.length) return getEmployer(employerId);
  const pool = await getPool();
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) => patch[k] === null ? null : asText(String(patch[k]), 500));
  const { rows } = await pool.query(
    `UPDATE app.job_employers SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [employerId, ...values]);
  return rows[0] || null;
}

// ── Postings ────────────────────────────────────────────────────────────────

/**
 * Turn a parsed job description into a row.
 *
 * A parse always produces a row, even an incomplete one, because the employer's
 * next move is to fix the things the review queue named — which means they need
 * something to fix them on.
 */
export async function savePosting(employerId, parsed = {}, {
  id = null, applyUrl = null, contactEmail = null, status = null,
} = {}) {
  const pool = await getPool();
  const description = parsed.sourceText || '';
  const comp = parsed.compensation || {};
  const loc = parsed.location || {};
  const title = parsed.title || {};

  const args = [
    employerId,
    asText(title.title, 300),
    asText(parsed.company?.name, 200),
    description,
    description.length,
    parsed.sourceWords ?? null,
    asText(loc.text, 200),
    loc.specificity || 'not_stated',
    Array.isArray(loc.arrangement) ? loc.arrangement : [],
    comp.stated ? comp.min : null,
    comp.stated ? comp.max : null,
    comp.stated ? comp.unit : null,
    comp.stated ? comp.basis : null,
    !!comp.stated,
    !!comp.vague,
    asText(comp.raw, 400),
    !!title.recognised,
    asText(title.family, 60),
    JSON.stringify({ matched: title.matched || [], source: title.titleSource }),
    JSON.stringify(parsed.requirements || []),
    parsed.requiredTickets || [],
    parsed.preferredTickets || [],
    parsed.unstatedTickets || [],
    !!parsed.coverage?.hasStructuredRequirements,
    parsed.needsReview !== false,
    JSON.stringify(parsed.review || []),
    JSON.stringify(parsed.coverage || {}),
    asText(applyUrl, 800),
    asText(contactEmail, 320),
    asText(status, 20),
  ];

  const cols = `employer_id, title, company, description, description_chars, description_words,
    location_text, location_specificity, arrangement, pay_min, pay_max, pay_unit, pay_basis,
    pay_stated, pay_vague, pay_raw, title_recognised, title_family, title_matched,
    requirements, required_tickets, preferred_tickets, unstated_tickets, requirements_complete,
    needs_review, review_notes, coverage, apply_url, contact_email, status`;
  // One placeholder per bound value, starting at $1.
  //
  // This was ph(2), because employer_id was read as a separate leading argument.
  // It is not separate: it is args[0], so the column list binds $1..$30 and the
  // generated list ran $2..$31, leaving $1 unbound. Postgres resolves a
  // placeholder's type from its value, so an unbound one is "could not determine
  // data type of parameter $1" — the first INSERT into this table never worked,
  // and `node --check` passed on it because the file is syntactically fine.
  const ph = (n) => Array.from({ length: n }, (_, i) => '$' + (i + 1));

  if (id) {
    // A re-save of an existing posting. Routed through updatePostingContent so
    // there is one place that knows the column list; this branch existed as a
    // hand-rolled UPDATE built from `cols`, which cannot work — the column names
    // and the positional parameters are not in step, and it was written with
    // `WHERE 1=0` to satisfy the type checker, which is a confession.
    return updatePostingContent(id, employerId, parsed, { applyUrl, contactEmail, status });
  }

  // The count is derived from the columns, not asserted, so adding a column
  // above cannot silently desynchronise from the placeholder list.
  const columnCount = cols.split(',').length;
  if (columnCount !== args.length) {
    throw new Error(
      `savePosting: ${columnCount} columns but ${args.length} values. `
      + 'The column list and the argument list have drifted apart.');
  }

  const { rows } = await pool.query(
    `INSERT INTO app.job_postings (${cols}) VALUES (${ph(columnCount).join(', ')})
     RETURNING *`, args);
  return rows[0] || null;
}

/**
 * Replace a posting's content in place, keeping its id and counters.
 *
 * Re-parsing a posting must not change its URL or reset its view count, or every
 * correction an employer makes would silently orphan the interest already
 * pointed at it.
 */
export async function updatePostingContent(postingId, employerId, parsed = {}, {
  applyUrl = undefined, contactEmail = undefined, status = undefined,
} = {}) {
  const pool = await getPool();
  const description = parsed.sourceText || '';
  const comp = parsed.compensation || {};
  const loc = parsed.location || {};
  const title = parsed.title || {};

  // ── pay is preserved when the new read finds nothing ─────────────────────
  //
  // A re-parse that cannot find a figure used to overwrite a stored one with
  // null, so an employer whose posting said "62000 to 74000 a year" lost the
  // salary the moment anything else in the description was edited. The figure
  // had been read correctly once and was destroyed by a later edit that was not
  // about pay at all.
  //
  // So: a read that finds a figure wins, and a read that finds nothing leaves
  // what is already on file. It is never the case that editing a location
  // removes a salary.
  //
  // The converse still holds — a stale figure is worse than none, so the
  // employer_update_posting path passes the whole parse and a deliberate
  // "competitive" rewrite does clear it, because that read *succeeds* and
  // reports vague rather than nothing.
  // Both preservations are expressed in the SQL below — `COALESCE` for the
  // company and a `CASE` on pay_stated for the figure — so there is no boolean
  // computed here to drift out of step with the statement that acts on it. A
  // first version computed `keepPay` and `keepCompany` in JS and then never used
  // either, and kept a `getPosting` call alive only to feed them. That is the
  // shape of bug where a guard looks present in review and is absent at runtime:
  // the company is COALESCEd so a re-read that finds none cannot blank one on
  // file, and the pay figure survives an edit that was about something else.

  const { rows } = await pool.query(
    `UPDATE app.job_postings SET
        title = $3, company = COALESCE($4, company), description = $5, description_chars = $6, description_words = $7,
        location_text = $8, location_specificity = $9, arrangement = $10,
        pay_min = CASE WHEN $15::boolean THEN $11 ELSE pay_min END,
        pay_max = CASE WHEN $15::boolean THEN $12 ELSE pay_max END,
        pay_unit = CASE WHEN $15::boolean THEN $13 ELSE pay_unit END,
        pay_basis = CASE WHEN $15::boolean THEN $14 ELSE pay_basis END,
        pay_stated = pay_stated OR $15::boolean,
        pay_vague = $16, pay_raw = COALESCE($17, pay_raw),
        title_recognised = $18, title_family = $19, title_matched = $20,
        requirements = $21, required_tickets = $22, preferred_tickets = $23,
        unstated_tickets = $24, requirements_complete = $25,
        needs_review = $26, review_notes = $27, coverage = $28,
        apply_url = COALESCE($29, apply_url),
        contact_email = COALESCE($30, contact_email),
        status = COALESCE($31, status),
        updated_at = now()
      WHERE id = $1 AND employer_id = $2
      RETURNING *`,
    [
      postingId, employerId,
      asText(title.title, 300),
      asText(parsed.company?.name, 200),
      description,
      description.length,
      parsed.sourceWords ?? null,
      asText(loc.text, 200),
      loc.specificity || 'not_stated',
      Array.isArray(loc.arrangement) ? loc.arrangement : [],
      comp.stated ? comp.min : null, comp.stated ? comp.max : null,
      comp.stated ? comp.unit : null, comp.stated ? comp.basis : null,
      !!comp.stated, !!comp.vague, asText(comp.raw, 400),
      !!title.recognised, asText(title.family, 60),
      JSON.stringify({ matched: title.matched || [], source: title.titleSource }),
      JSON.stringify(parsed.requirements || []),
      parsed.requiredTickets || [], parsed.preferredTickets || [], parsed.unstatedTickets || [],
      !!parsed.coverage?.hasStructuredRequirements,
      parsed.needsReview !== false,
      JSON.stringify(parsed.review || []),
      JSON.stringify(parsed.coverage || {}),
      applyUrl === undefined ? null : asText(applyUrl, 800),
      contactEmail === undefined ? null : asText(contactEmail, 320),
      status === undefined ? null : asText(status, 20),
    ]);
  return rows[0] || null;
}

export async function getPosting(postingId, employerId = null) {
  const pool = await getPool();
  const { rows } = employerId
    ? await pool.query('SELECT * FROM app.job_postings WHERE id = $1 AND employer_id = $2', [postingId, employerId])
    : await pool.query('SELECT * FROM app.job_postings WHERE id = $1', [postingId]);
  return rows[0] || null;
}

/**
 * Everything this employer has written.
 *
 * Drafts first: an employer who has three in progress and one live is working on
 * something, and the list should show them the work in the order it needs doing.
 */
export async function listEmployerPostings(employerId, { status = null, limit = 50 } = {}) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT id, employer_id, title, company, status, needs_review, review_notes,
            location_text, location_specificity, arrangement, pay_stated, pay_min, pay_max,
            pay_unit, pay_vague, title_recognised, required_tickets, preferred_tickets,
            unstated_tickets, requirements_complete, description_words, apply_url,
            contact_email, view_count, application_count, published_at, created_at, updated_at
       FROM app.job_postings
      WHERE employer_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY (status = 'published') DESC, updated_at DESC
      LIMIT $3`,
    [employerId, status, Math.min(Number(limit) || 50, 200)]);
  return rows;
}

/**
 * The public board.
 *
 * Published only, and each row carries what a candidate needs to decide whether
 * to care: the title, the place, the pay if it was stated, and the tickets it
 * asks for. It does not carry `needs_review` or the review notes — a candidate is
 * not the person who has to fix the posting.
 */
export async function listPublishedPostings({
  limit = 50, offset = 0, ticket = null, family = null, q = null, remote = false, arrangement = null,
} = {}) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.company, p.location_text, p.location_specificity, p.arrangement,
            p.pay_stated, p.pay_min, p.pay_max, p.pay_unit, p.pay_basis, p.pay_vague,
            p.title_recognised, p.title_family, p.required_tickets, p.preferred_tickets,
            p.requirements_complete, p.description_words, p.apply_url, p.published_at,
            p.view_count, p.application_count,
            e.verified, e.website, e.display_name AS employer_name
       FROM app.job_postings p
       JOIN app.job_employers e ON e.id = p.employer_id
      WHERE p.status = 'published'
        AND ($1::text IS NULL OR $1 = ANY (p.required_tickets))
        AND ($2::text IS NULL OR p.title_family = $2)
        AND ($3::text IS NULL OR p.title ILIKE '%' || $3 || '%' OR p.company ILIKE '%' || $3 || '%')
        AND ($4::boolean = false OR 'remote' = ANY (p.arrangement))
        AND ($5::text IS NULL OR $5 = ANY (p.arrangement))
      ORDER BY p.published_at DESC NULLS LAST, p.id DESC
      LIMIT $6 OFFSET $7`,
    // Placeholders run $1..$7 with no gaps. A gap is not a harmless omission: an
    // unbound placeholder is "could not determine data type of parameter $N",
    // which surfaced as a 500 on the public board on first contact.
    [ticket, family, q, remote, arrangement, Math.min(Number(limit) || 50, 200), Math.max(Number(offset) || 0, 0)]);
  return rows;
}

export async function countPublishedPostings(filters = {}) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM app.job_postings p
      WHERE p.status = 'published'
        AND ($1::text IS NULL OR $1 = ANY (p.required_tickets))
        AND ($2::text IS NULL OR p.title_family = $2)
        AND ($3::text IS NULL OR p.title ILIKE '%' || $3 || '%' OR p.company ILIKE '%' || $3 || '%')
        AND ($4::boolean = false OR 'remote' = ANY (p.arrangement))
        AND ($5::text IS NULL OR $5 = ANY (p.arrangement))`,
    [filters.ticket || null, filters.family || null, filters.q || null,
      !!filters.remote, filters.arrangement || null]);
  return rows[0]?.n ?? 0;
}

/** One published posting, for the detail view. Counts the view. */
export async function getPublishedPosting(postingId, { countView = true } = {}) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT p.*, e.verified, e.website, e.display_name AS employer_name, e.company AS employer_company
       FROM app.job_postings p
       JOIN app.job_employers e ON e.id = p.employer_id
      WHERE p.id = $1 AND p.status = 'published'`,
    [postingId]);
  if (!rows[0]) return null;
  if (countView) {
    // Best-effort: a failed counter must not fail the read.
    await pool.query('UPDATE app.job_postings SET view_count = view_count + 1 WHERE id = $1', [postingId])
      .catch(() => {});
  }
  return rows[0];
}

// ── The publication gate ────────────────────────────────────────────────────

/**
 * Can this posting go live?
 *
 * Returns a verdict with the reasons attached, never a bare boolean, because the
 * employer has to be told what to do next and a boolean gives them nothing.
 *
 * The three refusals, and why each one is a refusal:
 *
 *  1. **The parse is incomplete.** Something a candidate needs is not stated.
 *     Publishing it means a person reads a claim the posting does not make.
 *  2. **No title.** Nobody can search for it, and the library cannot match it, so
 *     it is a posting that exists and cannot be found.
 *  3. **Nowhere to apply.** A published posting with no apply URL and no contact
 *     is a dead end. It is worse than a draft, because it looks live.
 */
export function assessForPublication(posting) {
  const blockers = [];
  const warnings = [];
  const p = posting || {};

  if (!asText(p.title)) {
    blockers.push({
      kind: 'no_title',
      fix: 'Add the job title. Candidates search by it, and without it nobody can find this posting.',
    });
  } else if (p.title_recognised === false) {
    warnings.push({
      kind: 'title_unrecognised',
      detail: `"${p.title}" is not a title this system knows, so it will not be matched against `
        + "anyone's record. It can still be published, but far fewer candidates will land on it.",
    });
  }

  if (p.location_specificity === 'not_stated') {
    blockers.push({
      kind: 'no_location',
      fix: 'Add a location. Candidates filter on it, and a posting with no place cannot appear in any search.',
    });
  } else if (p.location_specificity === 'free_text' || p.location_specificity === 'country_or_region') {
    // A warning, not a blocker. "Northern Canada" is a real and legitimate thing
    // to say about a mine posting, and an employer who names the nearest town
    // can. It was a blocker before, which meant a correct posting could not be
    // published over a wording preference.
    warnings.push({
      kind: 'location_vague',
      detail: `"${p.location_text}" is a region rather than a place a candidate can be, so they `
        + 'cannot filter on it. Naming the nearest town or community would reach more people.',
    });
  }

  if (p.needs_review) {
    // The parse's own queue, carried through rather than re-derived.
    const notes = Array.isArray(p.review_notes) ? p.review_notes
      : (typeof p.review_notes === 'string' ? safeParse(p.review_notes) : null) || [];

    // The location and pay checks above already produce a blocker for the same
    // two facts, and the parse queue says so again in its own words. Passing
    // both through meant an employer fixing a missing location was told
    // "Add a location" and "No location stated" as two of the five things to do.
    // Not wrong, and not worth the employer's patience.
    const covered = [];
    if (!asText(p.title)) covered.push(/no job title/i);
    if (p.location_specificity === 'not_stated') covered.push(/no location|too vague/i);
    if (p.pay_stated === false) covered.push(/pay is|compensation|no pay|figure/i);

    for (const n of notes) {
      const text = typeof n === 'string' ? n : (n?.detail || String(n));
      if (covered.some((re) => re.test(text))) continue;
      blockers.push({ kind: 'needs_review', detail: text });
    }
    if (!notes.length) {
      blockers.push({
        kind: 'needs_review',
        fix: 'The description could not be read completely. Re-check the title, location and requirements.',
      });
    }
  }

  if (!p.apply_url && !p.contact_email) {
    blockers.push({
      kind: 'no_apply_route',
      fix: 'Add somewhere for candidates to apply — an application link or an email address. '
        + 'A live posting with nowhere to go sends people nowhere.',
    });
  }

  if (p.pay_stated === false) {
    warnings.push({
      kind: 'pay_not_stated',
      detail: p.pay_vague
        ? 'You described pay without giving a figure. Candidates filter on salary and will skip this.'
        : 'No pay figure was found. Candidates will assume the worst, which is usually unfair to you.',
    });
  }

  if (p.requirements_complete === false) {
    warnings.push({
      kind: 'requirements_incomplete',
      detail: 'The requirements could not be read as a list, so candidates cannot be told what is needed. '
        + 'One requirement per line fixes this.',
    });
  }

  return {
    canPublish: blockers.length === 0,
    blockers,
    warnings,
    // A posting can be published with warnings. The employer is told about them
    // and allowed to proceed, because some of them are their call to make.
    summary: blockers.length === 0
      ? (warnings.length ? `Ready to publish, with ${warnings.length} thing(s) candidates will notice.`
        : 'Ready to publish.')
      : `${blockers.length} thing(s) to fix before this can be published.`,
  };
}

/**
 * Publish, or refuse and say why.
 *
 * The database constraint `job_postings_publishable` is the backstop; this is the
 * friendly version of it. A CHECK constraint fires as a 500 and a stranger
 * cannot act on it, so the checks live here and the constraint catches only what
 * someone forgot.
 */
export async function publishPosting(postingId, employerId) {
  const posting = await getPosting(postingId, employerId);
  if (!posting) return { ok: false, error: 'That posting is not on your account.' };

  // Already live: report it as already published rather than re-publishing it.
  // Re-publishing an identical draft is a thing an employer does by clicking
  // twice, and it should not read as either an error or a new event.
  if (posting.status === 'published') {
    return {
      ok: true, alreadyPublished: true, ...assessForPublication(posting), posting,
    };
  }

  const verdict = assessForPublication(posting);
  if (!verdict.canPublish) return { ok: false, ...verdict };

  // The live-unique index refuses a second published posting with the same
  // employer, title and location. That constraint is right — an employer who
  // clicks publish twice should not double the board — but it fires as a raw
  // 23505, which the employer sees as a 500. It is caught here and answered in
  // their terms, naming the posting already on the board so they know which one
  // to edit instead.
  const existing = await findLiveDuplicate(posting, employerId);
  if (existing) {
    return {
      ok: false,
      alreadyOnBoard: true,
      summary: `"${posting.title}" at ${posting.location_text || 'this location'} is already on the board `
        + `as posting #${existing.id}. Edit that one rather than posting it twice.`,
      blockers: [{
        kind: 'duplicate_live',
        fix: `Posting #${existing.id} is already live with this title and location. `
          + 'Open it, change it there, and publish again.',
        duplicateId: existing.id,
      }],
      warnings: verdict.warnings,
    };
  }

  const pool = await getPool();
  const { rows } = await pool.query(
    `UPDATE app.job_postings
        SET status = 'published',
            published_at = COALESCE(published_at, now()),
            updated_at = now()
      WHERE id = $1 AND employer_id = $2
      RETURNING *`,
    [postingId, employerId]);
  return { ok: true, ...verdict, posting: rows[0] || null };
}

/** Is this employer already running this title at this location? */
async function findLiveDuplicate(posting, employerId) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT id, title, location_text, published_at
       FROM app.job_postings
      WHERE employer_id = $1
        AND status = 'published'
        AND id <> $2
        AND lower(btrim(coalesce(title,''))) = lower(btrim(coalesce($3,'')))
        AND lower(btrim(coalesce(location_text,''))) = lower(btrim(coalesce($4,'')))
      LIMIT 1`,
    [employerId, posting.id, posting.title, posting.location_text]);
  return rows[0] || null;
}

/** Take a posting down, keeping the row and its history. */
export async function closePosting(postingId, employerId, { status = 'closed' } = {}) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `UPDATE app.job_postings SET status = $3, updated_at = now()
      WHERE id = $1 AND employer_id = $2 AND status = 'published'
      RETURNING *`,
    [postingId, employerId, status]);
  return rows[0] || null;
}

// ── Employer conversation ───────────────────────────────────────────────────

export async function addEmployerMessage(employerId, { role, body, postingId = null, toolCalls = null }) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `INSERT INTO app.job_employer_messages (employer_id, posting_id, role, body, tool_calls)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [employerId, postingId, role, body, JSON.stringify(Array.isArray(toolCalls) ? toolCalls : [])]);
  return rows[0] || null;
}

export async function listEmployerMessages(employerId, { limit = 100 } = {}) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT id, posting_id, role, body, tool_calls, created_at
       FROM app.job_employer_messages
      WHERE employer_id = $1 ORDER BY id ASC LIMIT $2`,
    [employerId, Math.min(Number(limit) || 100, 400)]);
  return rows;
}

export async function employerMessageCount(employerId) {
  const pool = await getPool();
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM app.job_employer_messages WHERE employer_id = $1', [employerId]);
  return rows[0]?.n ?? 0;
}

/** Counts for the employer's own dashboard. */
export async function employerStats(employerId) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT id, title, company, status, needs_review, review_notes,
            location_text, location_specificity, pay_stated, title_recognised,
            requirements_complete, apply_url, contact_email
       FROM app.job_postings WHERE employer_id = $1`,
    [employerId]);

  const live = rows.filter((r) => r.status === 'published');
  const drafts = rows.filter((r) => r.status === 'draft');
  const blocked = drafts.filter((r) => !assessForPublication(r).canPublish);

  const totals = await pool.query(
    `SELECT coalesce(sum(view_count), 0)::int AS views,
            coalesce(sum(application_count), 0)::int AS applications
       FROM app.job_postings WHERE employer_id = $1 AND status = 'published'`,
    [employerId]);

  return {
    published: live.length,
    drafts: drafts.length,
    closed: rows.filter((r) => r.status === 'closed').length,
    // What the Publish button would refuse, counted by the same rule it uses.
    // This was `count(*) FILTER (WHERE needs_review)` in SQL, which is
    // arithmetically correct and useless: it counts postings whose *parse* was
    // incomplete, so a posting that parsed perfectly with no apply route — which
    // cannot be published — reported "0 to fix" beside a disabled Publish button.
    // The employer was told nothing was outstanding and simultaneously shown a
    // control that would not work. The number and the button have to come from
    // one rule or they disagree exactly when it matters.
    needs_review: blocked.length,
    // Kept separate because they are different problems: a parse gap is fixed by
    // editing the description, a publication blocker by adding an apply route.
    parse_gaps: rows.filter((r) => r.needs_review).length,
    views: totals.rows[0]?.views ?? 0,
    applications: totals.rows[0]?.applications ?? 0,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export default {
  getOrCreateEmployer, getEmployer, updateEmployer,
  savePosting, updatePostingContent, getPosting, listEmployerPostings,
  listPublishedPostings, countPublishedPostings, getPublishedPosting,
  assessForPublication, publishPosting, closePosting,
  addEmployerMessage, listEmployerMessages, employerMessageCount, employerStats,
};
