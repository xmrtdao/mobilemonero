/**
 * relay/lib/task-escalation.mjs — telling a human that something is waiting.
 *
 * A task that needs a person used to wait in silence. The executor parks
 * work in REVIEW when it cannot finish on its own, and nothing told anybody:
 * seven tasks sat there for five days with a reason that nothing writes,
 * waiting for a person who was never told there was anything to wait for.
 *
 * So an escalation is a record with a recipient, a question, and whether it
 * has been answered. ONE open escalation per task, because the rule is "tell
 * them once", not "tell them every cycle until they answer" - a task that
 * emails its owner every ten minutes is a task nobody reads.
 *
 * THE RECIPIENT IS NEVER GUESSED. An agent that wants to reach somebody
 * either names an address this system already knows how to reach, or it does
 * not get to send anything and is told to ask the client instead. The
 * fallback is the founder, who is the default for everything.
 */
import { query as localQuery } from './localDb.mjs';

const FOUNDER_EMAIL = process.env.FOUNDER_EMAIL || 'joeyleepcs@gmail.com';

/** Where a task came from, as far as the board knows. */
export function originOf(task) {
  const meta = task?.metadata || {};
  return {
    userId: task?.created_by_user_id || meta.created_by_user_id || null,
    ip: meta.originated_from_ip || null,
    email: meta.originated_from_email || null,
  };
}

/**
 * Find an address we already know, or nothing.
 *
 * The address book is the humans this system has actually met: the PFP
 * contacts, the Jobby clients (whose address was proved by reading a code
 * out of an inbox), and the suite's own users. A name or a guess is not an
 * address.
 */
export async function knownAddress(address) {
  const a = String(address || '').trim().toLowerCase();
  if (!a || !a.includes('@')) return null;

  const contact = await localQuery(
    `SELECT id, name, email FROM public.pfp_contacts
      WHERE lower(email) = $1 LIMIT 1`, [a]).catch(() => []);
  if (contact.length) {
    return { address: a, userId: contact[0].id, name: contact[0].name, source: 'contact' };
  }

  const job = await localQuery(
    `SELECT id, display_name, COALESCE(claimed_email, email) AS email
       FROM app.job_clients
      WHERE lower(COALESCE(claimed_email, email)) = $1 LIMIT 1`, [a]).catch(() => []);
  if (job.length) {
    return { address: a, userId: null, name: job[0].display_name, source: 'jobby' };
  }

  const suite = await localQuery(
    `SELECT id, name, email FROM app.suite_users
      WHERE lower(email) = $1 LIMIT 1`, [a]).catch(() => []);
  if (suite.length) {
    return { address: a, userId: null, name: suite[0].name, source: 'suite' };
  }

  return null;
}

/**
 * Work out who to ask.
 *
 * In order: the person the agent named (only if we know them), the person who
 * started the task, the address that started the task, and the founder.
 *
 * @returns {Promise<{address:string,userId:string|null,name:string,source:string}>}
 */
export async function resolveRecipient(task, { to } = {}) {
  if (to) {
    const known = await knownAddress(to);
    if (known) return known;
    // The agent asked for somebody we cannot reach. Say so rather than
    // guessing at an address.
    return null;
  }

  const origin = originOf(task);

  if (origin.userId) {
    const byUser = await localQuery(
      `SELECT email FROM app.user_address_book
        WHERE user_id = $1 AND email IS NOT NULL
        ORDER BY last_seen DESC LIMIT 1`, [origin.userId]).catch(() => []);
    if (byUser.length && byUser[0].email) {
      return { address: byUser[0].email, userId: origin.userId, name: null, source: 'origin-user' };
    }
  }

  if (origin.ip) {
    const byIp = await localQuery(
      `SELECT email, user_id FROM app.user_address_book
        WHERE ip_address = $1::inet AND email IS NOT NULL
        ORDER BY last_seen DESC LIMIT 1`, [origin.ip]).catch(() => []);
    if (byIp.length && byIp[0].email) {
      return { address: byIp[0].email, userId: byIp[0].user_id, name: null, source: 'origin-address' };
    }
  }

  if (origin.email) {
    return { address: origin.email, userId: origin.userId, name: null, source: 'origin-email' };
  }

  return { address: FOUNDER_EMAIL, userId: null, name: 'the founder', source: 'founder' };
}

/** Record that an address was seen, and who it belongs to. */
export async function rememberAddress(ip, { userId = null, email = null } = {}) {
  if (!ip) return null;
  try {
    await localQuery(
      `INSERT INTO app.user_address_book (ip_address, user_id, email)
            VALUES ($1::inet, $2, $3)
       ON CONFLICT (ip_address) DO UPDATE
              SET user_id = COALESCE(EXCLUDED.user_id, app.user_address_book.user_id),
                  email   = COALESCE(EXCLUDED.email, app.user_address_book.email),
                  seen_count = app.user_address_book.seen_count + 1,
                  last_seen = now()`,
      [String(ip), userId, email]);
  } catch (e) {
    // The address book is a convenience, not a gate. A failure to record it
    // must never stop the work.
  }
  return null;
}

/**
 * Is this task already waiting on somebody?
 *
 * One open escalation per task. The second attempt is not an error: it is the
 * rule working.
 */
export async function openEscalation(taskId) {
  const rows = await localQuery(
    `SELECT id, to_address, from_address, subject, sent_at
       FROM app.task_escalations
      WHERE task_id = $1 AND still_open
      ORDER BY sent_at DESC LIMIT 1`, [taskId]).catch(() => []);
  return rows[0] || null;
}

/** Record an escalation, so nobody is told twice. */
export async function recordEscalation(row) {
  const rows = await localQuery(
    `INSERT INTO app.task_escalations
       (task_id, reason, question, to_address, to_user_id, to_source,
        from_address, subject, body, reply_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, sent_at, reply_token`,
    [row.taskId, row.reason, row.question, row.address, row.userId || null,
      row.source, row.from, row.subject, row.body, row.replyToken || null]).catch((e) => {
      console.error('[task-escalation] could not record the escalation:', e.message);
      return [];
    });
  return rows[0] || null;
}

/**
 * Find the escalation a reply belongs to.
 *
 * A reply keeps the subject, and the subject carries the token - so the answer
 * finds the question it is answering without anybody having to remember which
 * of forty emails it was.
 */
export async function findEscalationByToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const rows = await localQuery(
    `SELECT e.id, e.task_id, e.question, e.to_address, e.still_open, t.title
       FROM app.task_escalations e
       LEFT JOIN app.tasks t ON t.id = e.task_id
      WHERE e.reply_token = $1 LIMIT 1`, [t]).catch(() => []);
  return rows[0] || null;
}

/**
 * The same thing, for a reply that has no token in it.
 *
 * The questions that went out before the token existed are still waiting for
 * their answers, and a reply carries the subject it was sent with - so the
 * subject is matched exactly, and then by the title it names.
 */
export async function findEscalationBySubject(subject) {
  const cleaned = String(subject || '').replace(/^(re|fwd|fw)\s*:\s*/i, '').trim();
  if (!cleaned) return null;

  const exact = await localQuery(
    `SELECT e.id, e.task_id, e.question, e.to_address, e.still_open, t.title
       FROM app.task_escalations e
       LEFT JOIN app.tasks t ON t.id = e.task_id
      WHERE e.still_open AND lower(e.subject) = lower($1)
      ORDER BY e.sent_at DESC LIMIT 1`, [cleaned]).catch(() => []);
  if (exact.length) return exact[0];

  // "Needs you: <title>" - the title is what the reply names.
  const m = cleaned.match(/^Needs you:\s*(.+?)(?:\s*\[esc_[a-f0-9]+\])?$/i);
  if (!m) return null;
  const byTitle = await localQuery(
    `SELECT e.id, e.task_id, e.question, e.to_address, e.still_open, t.title
       FROM app.task_escalations e
       JOIN app.tasks t ON t.id = e.task_id
      WHERE e.still_open AND lower(t.title) = lower($1)
      ORDER BY e.sent_at DESC LIMIT 1`, [m[1].trim()]).catch(() => []);
  return byTitle[0] || null;
}

/**
 * Close an escalation with the answer, and put the answer on the task.
 *
 * The task is where the agent that asked will look, so the answer goes there
 * as well as into the escalation.
 */
export async function answerEscalation(id, text, { from } = {}) {
  const rows = await localQuery(
    `UPDATE app.task_escalations
        SET answered_at = now(), answered_text = $2, still_open = false
      WHERE id = $1
      RETURNING id, task_id, question, to_address, from_address, answered_at`,
    [id, String(text || '').slice(0, 8000)]).catch((e) => {
    console.error('[task-escalation] could not record the answer:', e.message);
    return [];
    });
  const row = rows[0];
  if (!row) return null;

  // The task carries it too, so the agent that asked can see the answer
  // without having to go and read the escalation.
  //
  // Every parameter is cast. Postgres cannot infer the type of a bare
  // parameter inside jsonb_build_object when the same parameter is also used
  // elsewhere in the statement, and the failure was swallowed by the catch
  // below - so the answer was recorded on the escalation and silently NOT
  // recorded on the task, which is the half nobody looks at.
  await localQuery(
    `UPDATE app.tasks
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'escalation_answered',
              jsonb_build_object('escalation_id', $2::text,
                                 'text', $3::text,
                                 'at', now(),
                                 'from', $4::text)),
            updated_at = now()
      WHERE id = $1::text`,
    [row.task_id, row.id, String(text || '').slice(0, 8000), from || null]).catch((e) => {
    console.error('[task-escalation] could not record the answer on the task:', e.message);
  });

  return row;
}

export { FOUNDER_EMAIL };
export default {
  resolveRecipient, knownAddress, rememberAddress, openEscalation, recordEscalation,
  findEscalationByToken, findEscalationBySubject, answerEscalation, originOf, FOUNDER_EMAIL,
};
