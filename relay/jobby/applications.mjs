/**
 * relay/jobby/applications.mjs — one durable row per job listing Jobby tries
 *
 * Why this exists
 * ---------------
 * `jobby_apply` used to return a blob of the page agent's prose and stop there.
 * That is fine for the conversation and useless for everything after it. When a
 * run is stopped by a CAPTCHA, three facts have to survive the process, and none
 * of them did:
 *
 *   1. WHICH listing it was. A candidate coming back later cannot say "carry on
 *      with that one" about a URL buried in a chat scrollback.
 *   2. WHAT it is stuck on, verbatim. "I need your work authorisation status" is
 *      the entire content of the email they have to read; "stopped for a reason"
 *      is not.
 *   3. THAT they were already told. Without a marker, every retry mails the same
 *      wall again and the second mail reads like a new problem.
 *
 * So an application is an object with an id, a status, and a recorded blocker.
 * The id is what makes the sentence the user actually wants to be able to say -
 * "continue on job 41" - a thing the system can act on.
 *
 * The distinction this module exists to protect
 * ---------------------------------------------
 * Resuming is not retrying, and the two must never share a code path.
 *
 *   retry  = dispatch the task again, which re-opens the URL. The form is blank
 *            again, everything the agent already typed is gone, and a CAPTCHA the
 *            candidate just solved appears again.
 *   resume = the browser is still sitting on the half-finished form, with the
 *            candidate's own session in it. Tell the agent to carry on from where
 *            it stopped, and do not navigate.
 *
 * Getting that backwards costs the candidate the whole form and, worse, makes
 * the feature feel broken in exactly the situation it was built for. The task
 * text is therefore built in `buildResumeTask` below, which cannot navigate.
 */

import { getPool } from './store.mjs';

/**
 * Blocker kinds.
 *
 * `unanswerable_question` and the rest are a closed set because the caller's
 * next move differs for each: a question is answered by editing the dossier, a
 * login by the candidate signing in, a CAPTCHA by the candidate clicking, and a
 * file-upload wall by us fixing the renderer. Branching on English prose to tell
 * them apart is how "I stopped" ends up meaning three different things.
 */
export const BLOCKER_KINDS = Object.freeze([
  'unanswerable_question',
  'login',
  'captcha',
  'file_upload',
  'browser_unavailable',
  'unknown',
]);

/** Short, plain-language label per kind. Used in the email and on the site. */
export const BLOCKER_LABELS = Object.freeze({
  unanswerable_question: 'a question your details do not answer',
  login: 'a sign-in',
  captcha: 'a human-verification step',
  file_upload: 'attaching your CV',
  browser_unavailable: 'not being able to reach your browser',
  unknown: 'something it could not get past',
});

/**
 * Work out why a run stopped, in a form the rest of the system can branch on.
 *
 * Order matters, and it is not alphabetical. A CAPTCHA is checked before a
 * login because a Cloudflare interstitial usually says both - it mentions
 * logging in AND verifying you are human - and the candidate has to click the
 * checkbox, not go and find a password. `file_upload` is checked before
 * `unanswerable_question` for the same reason: "I cannot attach the CV" is
 * reported in the same voice as "I cannot answer this field", and treating the
 * first as a missing fact would have the candidate typing their work
 * authorisation into a box that wanted a PDF.
 *
 * @param {object} input
 * @param {string} [input.report]  the agent's prose report
 * @param {string} [input.error]   a transport-level error, if the run never ran
 * @param {Array}  [input.outstanding] parsed `{index, question, why}` entries
 * @returns {{kind: string, step: string|null, detail: string}}
 */
export function classifyBlocker({ report = '', error = '', outstanding = [] } = {}) {
  const text = `${report || ''}\n${error || ''}`.toLowerCase();
  const questions = Array.isArray(outstanding) ? outstanding : [];

  // The transport never ran the task at all. Nothing was attempted, so there is
  // no form to resume - and the fix is on our side of the wire, not the user's.
  if (error && /not connected|extension|hub|fetch failed|could not run|not connected/i.test(error)
      && !report) {
    return {
      kind: 'browser_unavailable',
      step: null,
      detail: 'Jobby could not reach your browser, so nothing was filled in. '
        + 'Check that Chrome is open and the Page Agent extension is enabled.',
    };
  }

  if (/captcha|recaptcha|hcaptcha|verify (that )?you (are|'re) (a )?human|are you a robot|human verification|bot check|cloudflare|press and hold/i.test(text)) {
    return {
      kind: 'captcha',
      step: 'human verification',
      detail: 'The site put up a human-verification step. Only you can clear that, '
        + 'so the application is paused. Jobby carries on with the next job '
        + 'and will come back to this one when you say so.',
    };
  }

  if (/\b(sign in|log ?in|logon|password|create an account|sign ?up|authentication required|one-time (code|password)|2fa|mfa)\b/i.test(text)) {
    return {
      kind: 'login',
      step: 'sign-in',
      detail: 'The site wants you signed in before it will accept an application. '
        + 'Jobby will not enter or ask for your password. Sign in yourself in that '
        + 'tab, then tell Jobby to continue.',
    };
  }

  if (/file input|file upload|could not attach|cannot attach|attach(ment)? (the |your )?(resume|cv|file)|choose a file|upload (the |your )?(resume|cv)|native (file )?(dialog|picker)|paperclip/i.test(text)) {
    return {
      kind: 'file_upload',
      step: 'CV attachment',
      detail: 'Jobby got the form but could not attach the CV, because that opens a '
        + 'file picker no browser agent can drive. Everything else is ready - '
        + 'attach your resume in that tab and tell Jobby to continue.',
    };
  }

  // A question the dossier cannot answer. This is the one that is genuinely
  // fixable by the user giving a fact, so the exact wording is carried through
  // verbatim: it is what they have to answer, and paraphrasing it is how the
  // wrong thing gets filled into the right box.
  if (questions.length) {
    const first = questions[0];
    const asked = String(first.question || '').trim();
    const all = questions.map((q) => String(q.question || '').trim()).filter(Boolean);
    return {
      kind: 'unanswerable_question',
      step: asked || null,
      detail: asked
        ? `The form asks "${asked}", and that is not something in your details yet.`
          + (all.length > 1
            ? ` It also asks: ${all.slice(1).map((q) => `"${q}"`).join(', ')}.`
            : '')
        : 'The form asked something your details do not answer.',
    };
  }

  if (/not listed|do not know|cannot answer|can'?t answer|unable to|not stated|missing|require action|still need/i.test(text)) {
    return {
      kind: 'unanswerable_question',
      step: null,
      detail: 'The form asked something your details do not answer, and Jobby would '
        + 'not guess at it. Tell Jobby what to put and it will carry on.',
    };
  }

  if (/no tab|no page|could not get to your browser|browser is (closed|not)/i.test(text)) {
    return {
      kind: 'browser_unavailable',
      step: null,
      detail: 'Jobby could not reach a real page in your browser, so nothing was '
        + 'filled in. Open the application in Chrome and tell Jobby to continue.',
    };
  }

  return {
    kind: 'unknown',
    step: null,
    detail: 'Jobby stopped and could not say why in a way it trusts. '
      + 'The notes from the run are below.',
  };
}

/* ── Store ─────────────────────────────────────────────────────────────── */

/** Trim a URL for identity purposes: case-insensitive host, no fragment. */
function normaliseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    u.hash = '';
    return u.toString();
  } catch {
    return raw;
  }
}

const asText = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
};

/**
 * Coerce an optional id to a positive integer, or null.
 *
 * The obvious `Number.isFinite(Number(v))` is wrong in a way that only shows up
 * against a real database: `Number(null)` is 0, which IS finite, so an absent
 * opportunity_id becomes 0 and the insert dies on the foreign key. Callers pass
 * `null` for "there isn't one" as a matter of course - the model omits the field
 * and the object literal carries `opportunity_id: null` - so this was reachable
 * from the ordinary path, not an edge case. A 0 id can never be a real row, so
 * it is rejected here alongside null, undefined and the empty string.
 */
const asId = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
};

/**
 * Record that the browser is about to be dispatched for a listing.
 *
 * An upsert, deliberately. The obvious implementation - INSERT, and let a repeat
 * be an error - turns every duplicate dispatch into a failure, and duplicates
 * are the normal case: the agent retries, the user clicks twice, the portal is
 * reloaded mid-run. All of those are the SAME application, and splitting them
 * across rows means the dashboard shows five blocked applications where there is
 * one, and "continue on job 41" picks an arbitrary one of the five.
 *
 * `attempts` counts dispatches so the cost of a listing that keeps failing is
 * visible, without inflating the number of applications.
 *
 * The blocker columns are deliberately NOT cleared here. A retry that is about
 * to be told about the same wall again must not be able to re-send the mail,
 * and `notified_at` is the guard. Clearing the blocker is `resumeAttempt`'s job,
 * because resuming is the candidate saying they have dealt with it.
 */
export async function startAttempt(clientId, {
  url, company = null, role = null, opportunityId = null, resumeFilename = null,
  packet = null, notes = null, validation = null, validatedAt = null,
  viewUsed = null, eligibility = null,
} = {}) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `INSERT INTO app.job_applications
     (client_id, url, company, role, opportunity_id, status, attempts, resume_filename,
      packet, notes, validation, validated_at, view_used, eligibility, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'running', 1, $6, $7, COALESCE($8::jsonb, '[]'::jsonb), $9, $10, $11, $12, now())
     ON CONFLICT (client_id, LOWER(url)) DO UPDATE
       SET status = 'running',
           attempts = app.job_applications.attempts + 1,
           -- COALESCE so a retry that knows less than the row does cannot blank
           -- out a company name that was already captured.
           company = COALESCE(EXCLUDED.company, app.job_applications.company),
           role = COALESCE(EXCLUDED.role, app.job_applications.role),
           opportunity_id = COALESCE(EXCLUDED.opportunity_id, app.job_applications.opportunity_id),
           resume_filename = COALESCE(EXCLUDED.resume_filename, app.job_applications.resume_filename),
           -- The packet columns overwrite on a rebuild rather than being held back.
           -- A packet that silently outlives the opportunity it was written for is worse
           -- than no packet at all, so the current one always wins.
           packet = COALESCE(EXCLUDED.packet, app.job_applications.packet),
           -- The notes column is NOT NULL DEFAULT '[]' and predates this work,
           -- so the INSERT above substitutes an empty array rather than failing.
           -- The upsert therefore cannot use the plain COALESCE the other columns
           -- use: an absent $8 arrives here as '[]', which is a real value and
           -- would wipe notes a previous run wrote. Empty is treated as absent
           -- so the two paths agree on what "nothing supplied" means.
           notes = CASE WHEN EXCLUDED.notes = '[]'::jsonb
                        THEN app.job_applications.notes
                        ELSE EXCLUDED.notes END,
           validation = COALESCE(EXCLUDED.validation, app.job_applications.validation),
           validated_at = COALESCE(EXCLUDED.validated_at, app.job_applications.validated_at),
           view_used = COALESCE(EXCLUDED.view_used, app.job_applications.view_used),
           eligibility = COALESCE(EXCLUDED.eligibility, app.job_applications.eligibility),
           updated_at = now()
     RETURNING *`,
    [
      clientId,
      normaliseUrl(url),
      asText(company, 200),
      asText(role, 200),
      asId(opportunityId),
      asText(resumeFilename, 300),
      packet ? JSON.stringify(packet) : null,
      notes ? JSON.stringify(notes) : null,
      validation ? JSON.stringify(validation) : null,
      validatedAt,
      asText(viewUsed, 40),
      eligibility ? JSON.stringify(eligibility) : null,
    ],
  );
  return rows[0] || null;
}

/**
 * Save or rebuild the tailored packet for one opportunity.
 *
 * Deliberately separate from startAttempt, and it does not call it. Building the
 * artefact for an opening is not the same act as applying to it: a candidate can
 * review three packets before sending one, and marking all three in flight just to
 * look at them would make the pipeline lie about what is actually happening.
 *
 * That was not hypothetical. The first version of this function called
 * startAttempt to create the row, which set status='running' and incremented
 * attempts. Preparing two packets produced two 'running' rows with attempts=1 and
 * nothing submitted to any employer, and the dashboard's stuck-list counts
 * 'running'. So this writes status='pending', attempts=0, and on conflict touches
 * neither - a packet is a document, and it does not move the pipeline until an
 * actual run does.
 *
 * Creates the row when absent, because for a newly-sourced opportunity the packet
 * is frequently the first thing that exists.
 */
export async function savePacket(clientId, {
  url, company = null, role = null, opportunityId = null,
  packet = null, notes = null, validation = null, validatedAt = null,
  viewUsed = null, eligibility = null,
} = {}) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `INSERT INTO app.job_applications
       (client_id, url, company, role, opportunity_id, status, attempts, updated_at,
        packet, notes, validation, validated_at, view_used, eligibility)
     VALUES ($1, $2, $3, $4, $5, 'pending', 0, now(),
             $6, COALESCE($7::jsonb, '[]'::jsonb), $8, $9, $10, $11)
     ON CONFLICT (client_id, LOWER(url)) DO UPDATE
       SET -- status and attempts are deliberately absent from this SET list.
           packet = COALESCE(EXCLUDED.packet, app.job_applications.packet),
           -- The notes column is NOT NULL DEFAULT '[]' and predates the packet
           -- work, so an absent value arrives as an empty array. Treating that
           -- as a real value would wipe notes a previous run wrote.
           notes = CASE WHEN EXCLUDED.notes = '[]'::jsonb
                        THEN app.job_applications.notes
                        ELSE EXCLUDED.notes END,
           validation = COALESCE(EXCLUDED.validation, app.job_applications.validation),
           validated_at = COALESCE(EXCLUDED.validated_at, app.job_applications.validated_at),
           view_used = COALESCE(EXCLUDED.view_used, app.job_applications.view_used),
           eligibility = COALESCE(EXCLUDED.eligibility, app.job_applications.eligibility),
           company = COALESCE(EXCLUDED.company, app.job_applications.company),
           role = COALESCE(EXCLUDED.role, app.job_applications.role),
           opportunity_id = COALESCE(EXCLUDED.opportunity_id, app.job_applications.opportunity_id),
           updated_at = now()
     RETURNING *`,
    [
      clientId,
      normaliseUrl(url),
      asText(company, 200),
      asText(role, 200),
      asId(opportunityId),
      packet ? JSON.stringify(packet) : null,
      notes ? JSON.stringify(notes) : null,
      validation ? JSON.stringify(validation) : null,
      validatedAt,
      asText(viewUsed, 40),
      eligibility ? JSON.stringify(eligibility) : null,
    ],
  );
  return rows[0] || null;
}


/**
 * Write the outcome of a run against the row.
 *
 * `status` is validated rather than trusted: an unknown value would make the
 * dashboard's "show me what is stuck" filter silently drop the row, which is
 * the one row that matters most.
 */
export async function recordOutcome(clientId, rawId, {
  status, blocker = null, outstanding = null, filled = null, error = null,
} = {}) {
  const pool = await getPool();
  const allowed = new Set(['pending', 'running', 'blocked', 'submitted', 'failed', 'skipped']);
  const st = allowed.has(status) ? status : 'failed';
  const { rows } = await pool.query(
    `UPDATE app.job_applications
        SET status = $3,
            blocker_kind = $4,
            blocker_detail = $5,
            blocker_step = $6,
            outstanding = $7,
            filled = $8,
            last_error = $9,
            submitted_at = CASE WHEN $3 = 'submitted' THEN now() ELSE submitted_at END,
            updated_at = now()
      WHERE id = $1 AND client_id = $2
      RETURNING *`,
    [
      asId(rawId),
      clientId,
      st,
      blocker ? (BLOCKER_KINDS.includes(blocker.kind) ? blocker.kind : 'unknown') : null,
      blocker ? asText(blocker.detail, 2000) : null,
      blocker ? asText(blocker.step, 300) : null,
      outstanding ? JSON.stringify(outstanding) : null,
      filled ? JSON.stringify(filled) : null,
      asText(error, 2000),
    ],
  );
  return rows[0] || null;
}

/**
 * Mark the candidate as told, and say whether this call is the one that mailed.
 *
 * Returns true only for the first caller. This is the whole reason `notified_at`
 * is a column rather than something re-derived: the email is a side effect with
 * an external cost, and "did we already tell them" cannot be answered by
 * looking at the report, because the report is written after the fact and says
 * nothing about mail.
 */
export async function markNotified(clientId, id) {
  const key = asId(id);
  // No id means there is no row to stamp, and returning true here would claim a
  // send that never happened - which is how a candidate ends up told they were
  // emailed when they were not.
  if (key === null) return false;
  const pool = await getPool();
  const { rows } = await pool.query(
    `UPDATE app.job_applications
        SET notified_at = now(), updated_at = now()
      WHERE id = $1 AND client_id = $2 AND notified_at IS NULL
      RETURNING id`,
    [key, clientId],
  );
  return (rows[0] || null) !== null;
}

/**
 * A candidate has come back to clear the blocker.
 *
 * This is the one transition that re-arms the notification, and it has to.
 * Someone who solved a CAPTCHA, signed in, or supplied a missing fact, and then
 * hit a *different* wall, must hear about the new one. Clearing `notified_at` is
 * also what makes `resumed_at` meaningful: the gap between the two is how long
 * the wall actually cost them.
 */
export async function resumeAttempt(clientId, id) {
  const key = asId(id);
  if (key === null) return null;
  const pool = await getPool();
  const { rows } = await pool.query(
    `UPDATE app.job_applications
        SET status = 'running',
            blocker_kind = NULL,
            blocker_detail = NULL,
            blocker_step = NULL,
            outstanding = NULL,
            notified_at = NULL,
            resumed_at = now(),
            last_error = NULL,
            updated_at = now()
      WHERE id = $1 AND client_id = $2
      RETURNING *`,
    [key, clientId],
  );
  return rows[0] || null;
}

/** Fetch one application, scoped to its owner. Never across clients. */
export async function getApplication(clientId, id) {
  const key = asId(id);
  if (key === null) return null;
  const pool = await getPool();
  const { rows } = await pool.query(
    'SELECT * FROM app.job_applications WHERE id = $1 AND client_id = $2',
    [key, clientId],
  );
  return rows[0] || null;
}

/**
 * List a candidate's applications, newest activity first.
 *
 * `status` accepts a comma-separated list because the dashboard's two useful
 * views are "everything" and "what is stuck", and asking the model to call this
 * twice to build one list is how a blocked row gets left out of a summary.
 */
export async function listApplications(clientId, { status = null, limit = 50 } = {}) {
  const pool = await getPool();
  const wanted = String(status || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cap = Math.min(200, Math.max(1, Number(limit) || 50));
  const { rows } = await pool.query(
    `SELECT * FROM app.job_applications
      WHERE client_id = $1
        AND ($2::text[] IS NULL OR status = ANY($2::text[]))
      ORDER BY updated_at DESC
      LIMIT $3`,
    [clientId, wanted.length ? wanted : null, cap],
  );
  return rows;
}

/**
 * The next listing worth working on.
 *
 * "Next" is not the same as "oldest" and not "newest". A listing that is
 * already submitted is finished; one that is blocked is waiting on a human, and
 * re-running it unprompted is the behaviour that produced the original problem
 * (a run that stops, gets retried, stops again, and spams the candidate). So
 * this returns only what can be acted on unattended, and the blocked ones are
 * deliberately excluded - they come back through `jobby_continue`, which the
 * candidate triggers.
 */
export async function nextActionable(clientId) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT * FROM app.job_applications
      WHERE client_id = $1 AND status IN ('pending', 'failed')
      ORDER BY updated_at ASC
      LIMIT 1`,
    [clientId],
  );
  return rows[0] || null;
}

/** Everything currently stuck, which is what the notification sweep walks. */
export async function listBlocked(clientId, { unnotifiedOnly = false } = {}) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT * FROM app.job_applications
      WHERE client_id = $1
        AND status = 'blocked'
        ${unnotifiedOnly ? 'AND notified_at IS NULL' : ''}
      ORDER BY updated_at DESC`,
    [clientId],
  );
  return rows;
}

/* ── The resume task ───────────────────────────────────────────────────── */

/**
 * Build the task for picking a blocked application back up.
 *
 * The first line is the load-bearing one. The browser is still on the form, with
 * everything already typed and the candidate's own session; a task that opens
 * the URL again throws all of that away and puts the candidate back at a CAPTCHA
 * they just solved. So this task cannot navigate, and says so three times,
 * because an LLM asked to "apply to this job" will otherwise open the page on
 * its own initiative and undo the entire point of resuming.
 *
 * `answers` is a flat `{label: value}` map of things the candidate supplied while
 * they were at the blockage. They are passed to the agent as facts, and writing
 * them into the dossier is the caller's job, not this function's - the dossier
 * edit is a separate, auditable act and should not ride along silently inside a
 * browser task.
 */
export function buildResumeTask(application, { facts = {}, answers = {}, resumePath = null } = {}) {
  const known = { ...facts, ...answers };
  const lines = [
    'You are already on a job application form in this browser tab. It is part '
      + 'filled in, and the person you are working for is looking at it right now.',
    '',
    'Do NOT navigate. Do not open the URL again. Do not reload the page. Do not '
      + 'start the form over. Work with the page exactly as it is, because '
      + 'everything already typed into it is real work that would otherwise be lost.',
    '',
  ];

  if (application?.blocker_step) {
    lines.push(
      `Last time you stopped at: ${application.blocker_step}`,
      'The person has now dealt with that. Find that same place on the page and',
      'carry on from it.',
      '',
    );
  }
  if (application?.blocker_detail) {
    lines.push('Why it stopped: ' + application.blocker_detail, '');
  }
  // Sanitised here as well as at the call site. The caller already drops
  // non-scalars, but this function is the one that writes the text, and a
  // nested value stringifies to "[object Object]" - which is not a harmless
  // artefact here, it is a value the agent would happily type into a form. A
  // function that builds the prompt has to be safe for any caller.
  const flat = {};
  for (const [k, v] of Object.entries(known)) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') continue;
    flat[String(k).slice(0, 120)] = String(v).slice(0, 300);
  }
  const answersOnly = {};
  for (const [k, v] of Object.entries(answers)) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') continue;
    answersOnly[k] = v;
  }

  if (Object.keys(answersOnly).length) {
    lines.push(
      'The person has answered what you asked. Use these:',
      ...Object.entries(answersOnly).map(([k, v]) => `  ${k}: ${v}`),
      '',
    );
  }
  if (resumePath) {
    lines.push(`CV file, if the form still needs one: ${resumePath}`, '');
  }

  lines.push(
    'Everything you may put in the form:',
    ...Object.entries(flat).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'Rules:',
    '1. The same rules as any application: only the facts above. If something new',
    '   is asked for that is not in that list, STOP and report the exact question.',
    '   Never guess. A wrong answer on a form is a lie told to an employer.',
    '2. A CAPTCHA or a sign-in appearing again: STOP and report it. Do not try to',
    '   get past either one.',
    '3. Finish the form and press Submit. This is the step that was delegated to',
    '   you, so do not stop at the submit button to ask permission.',
    '4. Say which fields you completed just now, whether it submitted, and the',
    '   exact text of anything you had to stop for.',
  );
  return lines.join('\n');
}
