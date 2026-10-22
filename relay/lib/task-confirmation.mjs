/**
 * relay/lib/task-confirmation.mjs — turning a person's answer into evidence.
 *
 * WHY THIS IS SEPARATE FROM THE ESCALATION
 * ----------------------------------------
 * app.task_escalations records that a question was asked and whether it was
 * answered. That is the QUESTION. This is the ANSWER: who answered, when, what
 * they wrote, and what it means.
 *
 * The distinction matters because of what the completion guard accepts. A task
 * can only be marked DONE or COMPLETED if it carries an artifact with a
 * non-empty URL that does not point at the task's own record. Before this, the
 * only artifacts that existed were work-logs and screenshots - pointers at work
 * an agent claimed to have done, and (in the case of the screenshots) pointers
 * at nothing at all.
 *
 * A confirmation is a different kind of evidence and it is worth having
 * separately: it is not a pointer at the work, it is a pointer at a person's
 * own words, which is something no agent can write for itself.
 *
 * WHAT IT MAY NOT DO
 * ------------------
 * It may not close a task on its own. The evidence gate stays exactly as it
 * was - an artifact with a resolvable URL - and a confirmation supplies one
 * such artifact, bound by the database to an escalation that was actually put
 * to somebody and actually answered by the person it was put to. That binding
 * is a trigger, not a promise: see relay/migrations/tasks_020_task_confirmations.sql.
 */

import { query as localQuery } from './localDb.mjs';

const PUBLIC_RELAY = process.env.RELAY_PUBLIC_URL || 'https://relay.mobilemonero.com';

/** The public address of a confirmation record. It has to resolve. */
export function confirmationUrl(id) {
  return `${PUBLIC_RELAY}/api/suite/task-confirmations/${id}`;
}

/**
 * Record the confirmation, and attach it to the task as an artifact.
 *
 * The artifact is what the completion guard sees. The confirmation row is
 * what the artifact points at, and what the trigger checks.
 */
export async function recordConfirmation({ task, escalation, reading, replyText, from, answeredAt }) {
  const reply = String(replyText || '').trim();
  const confirmedAt = answeredAt ? new Date(answeredAt).toISOString() : new Date().toISOString();

  // The confirmation row. The trigger checks that the escalation it names was
  // answered, that the escalation is about this task, and that the address
  // that answered is the address the question went to.
  const rows = await localQuery(
    `INSERT INTO app.task_confirmations
       (task_id, escalation_id, confirmed_by, reply_text,
        reading_intent, reading_summary, read_by, source_url, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, task_id, escalation_id, confirmed_by, confirmed_at, source_url`,
    [
      task.id,
      escalation.id,
      from || null,
      reply,
      reading.intent || null,
      reading.summary || null,
      'ai-chat',
      null, // set below, once the id is known
      confirmedAt,
    ]).catch((e) => {
    console.error('[task-confirmation] could not record the confirmation:', e.message);
    return [];
  });

  const confirmation = rows[0];
  if (!confirmation) return null;

  // The record's own address, now that it has an id.
  const url = confirmationUrl(confirmation.id);
  await localQuery(
    `UPDATE app.task_confirmations SET source_url = $2 WHERE id = $1`,
    [confirmation.id, url]).catch(() => []);

  // And the artifact, which is what the completion guard looks for.
  //
  // artifact_type is 'human-confirmation' rather than 'work-log' because it
  // ISN'T a pointer at work. It is a pointer at a person's words. Naming it
  // for what it is keeps the artifact table honest: a reader can see that
  // this task was closed on a human's say-so rather than on a deliverable.
  await localQuery(
    `INSERT INTO app.task_artifacts
       (task_id, artifact_type, artifact_url, description, payload, created_at)
     VALUES ($1, 'human-confirmation', $2, $3, $4, $5)`,
    [
      task.id,
      url,
      [
        `Confirmed by ${from || 'the client'} on ${confirmedAt.slice(0, 10)}.`,
        reading.summary ? `Reading: ${reading.summary}` : null,
        `The client's words: "${reply.slice(0, 600)}"`,
      ].filter(Boolean).join(' ').slice(0, 1500),
      JSON.stringify({
        confirmation_id: confirmation.id,
        escalation_id: escalation.id,
        intent: reading.intent || null,
        read_by: 'ai-chat',
      }),
      confirmedAt,
    ]).catch((e) => {
    console.error('[task-confirmation] could not attach the confirmation artifact:', e.message);
  });

  return { ...confirmation, source_url: url };
}

/**
 * The confirmations on a task, newest first.
 */
export async function confirmationsFor(taskId) {
  return localQuery(
    `SELECT id, task_id, escalation_id, confirmed_by, reply_text,
            reading_intent, reading_summary, read_by, source_url, confirmed_at
       FROM app.task_confirmations
      WHERE task_id = $1
      ORDER BY confirmed_at DESC`,
    [taskId]).catch(() => []);
}

/**
 * Has a person confirmed this task?
 *
 * Used by the review stage, and by anything that wants to know whether the
 * human gate is open.
 */
export async function hasConfirmation(taskId) {
  const rows = await localQuery(
    `SELECT id, reading_intent, confirmed_at FROM app.task_confirmations
      WHERE task_id = $1 ORDER BY confirmed_at DESC LIMIT 1`,
    [taskId]).catch(() => []);
  return rows[0] || null;
}

export default { recordConfirmation, confirmationsFor, hasConfirmation, confirmationUrl };
