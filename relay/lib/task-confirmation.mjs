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
  // The words are stored the same way the answer was stored on the
  // escalation, and the trigger compares the two: it refuses a confirmation
  // whose words are not the words that were answered with. A different
  // length here - even one character - is a different record.
  const reply = String(replyText || '').trim().slice(0, 8000);
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
 * MOVE THE TASK. The confirmation is the answer; the answer is the end of
 * the wait.
 *
 * WHERE THIS WAS MISSING, AND WHAT IT COST
 * ---------------------------------------
 *
 * A task parked by the executor carries
 * terminal_reason = 'checklist_complete_awaiting_confirmation'. The work is
 * done, the checklist is complete, progress is 100%, and the only thing
 * missing is somebody saying it was good.
 *
 * The answer arrives. The confirmation is recorded. The artifact is
 * attached. And then... nothing. The task stays in REVIEW at stage
 * COMPLETION, with the same reason it had before, and it stays there
 * forever, because the one job that moves tasks forward does not look at
 * it:
 *
 *   task-auto-advance selects tasks with
 *     status IN ('PENDING','CLAIMED','IN_PROGRESS')
 *
 * and REVIEW is not in that list. A task parked in REVIEW is invisible to
 * the only advancement authority in the system. Five tasks sat in that
 * state on the morning of 2026-10-22, each with a human confirmation
 * recorded against it and a complete checklist, and each of them would have
 * stayed there indefinitely.
 *
 * So the release happens HERE, in the same place the answer is recorded. A
 * confirmation is not a note about a task; it is the thing that lets the
 * task go. Anything that records a confirmation releases the task, and
 * there is no path where the answer exists and the task does not move.
 *
 * WHAT THE ANSWER MEANS, AND WHERE IT SENDS THE TASK
 * ----------------------------------------------------
 *
 *   confirmed_complete   the work is right. The task is done.
 *   more_work_requested  they want more. The task goes back to EXECUTION.
 *   question_for_us      they asked something. The task goes back to
 *                        DISCUSS, where the answer is discussed.
 *   unclear              we could not read it. The task stays parked and
 *                        says so, because guessing what a person meant and
 *                        closing their work on the guess is the one thing
 *                        this whole mechanism exists to prevent.
 */
export async function releaseTaskForAnswer({ task, reading, replyText, from, confirmation }) {
  const intent = String(reading?.intent || 'unclear');
  const summary = reading?.summary || '';
  const asked = Array.isArray(reading?.new_work) ? reading.new_work : [];
  const questions = Array.isArray(reading?.questions) ? reading.questions : [];

  const note = [
    `Answered by ${from || 'the client'} on ${new Date().toISOString().slice(0, 10)}.`,
    summary ? `Reading: ${summary}` : null,
    asked.length ? `They asked for: ${asked.join('; ')}` : null,
    questions.length ? `They asked us: ${questions.join('; ')}` : null,
    replyText ? `Their words: "${String(replyText).slice(0, 400)}"` : null,
  ].filter(Boolean).join(' ');

  let stage = null;
  let status = null;

  if (intent === 'confirmed_complete') {
    stage = 'COMPLETED';
    status = 'COMPLETED';
  } else if (intent === 'more_work_requested') {
    stage = 'EXECUTION';
    status = 'PENDING';
  } else if (intent === 'question_for_us') {
    stage = 'DISCUSS';
    status = 'PENDING';
  } else {
    // Unclear. The task stays exactly where it is, but the reading is
    // recorded so the board shows WHY it is still waiting.
    await localQuery(
      `UPDATE app.tasks
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'answer_reading', $2::jsonb),
              updated_at = now()
        WHERE id = $1::text`,
      [task.id, JSON.stringify({ intent, summary, at: new Date().toISOString(), from: from || null })]
    ).catch((e) => {
      console.error('[task-confirmation] could not record the unclear reading:', e.message);
    });
    return { released: false, intent, reason: 'the answer could not be read; the task is still waiting on a person' };
  }

  // The completion guard is the database's, not ours: a task cannot take a
  // completed status or enter a completion stage without an artifact that
  // carries a resolvable URL. The human-confirmation artifact is one, and it
  // was attached a moment ago. If the UPDATE is refused, the refusal is the
  // guard working and it is reported rather than swallowed.
  //
  // terminal_reason lives in the METADATA, not in a column — it was added
  // to the metadata JSON and everything that reads it reads it from there.
  // So it is removed from the JSON rather than set to NULL in a column that
  // does not exist.
  const updated = await localQuery(
    `UPDATE app.tasks
        SET stage = $2,
            status = $3,
            progress_percentage = CASE WHEN $3 IN ('COMPLETED','DONE') THEN 100 ELSE progress_percentage END,
            blocking_reason = NULL,
            stage_started_at = now(),
            updated_at = now(),
            metadata = (COALESCE(metadata, '{}'::jsonb) - 'terminal_reason')
                       || jsonb_build_object(
                  'answer_reading', $4::jsonb,
                  'released_by', $5::text,
                  'released_at', now())
      WHERE id = $1::text
      RETURNING id, stage, status, progress_percentage`,
    [task.id, stage, status,
      JSON.stringify({ intent, summary, asked, questions, at: new Date().toISOString(), from: from || null }),
      confirmation ? `human-confirmation:${confirmation.id}` : 'human-answer']
  ).catch((e) => {
    console.error('[task-confirmation] could not release the task:', e.message);
    return [];
  });

  const row = updated[0];
  if (!row) {
    return { released: false, intent, reason: 'the task could not be updated' };
  }
  return { released: true, intent, stage: row.stage, status: row.status, id: row.id };
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

/**
 * The confirmation record, for the URL the artifact points at.
 *
 * The artifact's URL has to RESOLVE, or the evidence is hollow: a link to
 * a 404 is a pointer at nothing, and the whole point of the confirmation
 * being a first-class record is that a reader can go and see the person's
 * own words.
 */
export async function confirmationById(id) {
  const rows = await localQuery(
    `SELECT c.id, c.task_id, c.escalation_id, c.confirmed_by, c.reply_text,
            c.reading_intent, c.reading_summary, c.read_by, c.source_url, c.confirmed_at,
            t.title AS task_title
       FROM app.task_confirmations c
       LEFT JOIN app.tasks t ON t.id = c.task_id
      WHERE c.id = $1 LIMIT 1`,
    [id]).catch(() => []);
  return rows[0] || null;
}

export default {
  recordConfirmation, confirmationsFor, hasConfirmation, confirmationUrl,
  releaseTaskForAnswer, confirmationById,
};
