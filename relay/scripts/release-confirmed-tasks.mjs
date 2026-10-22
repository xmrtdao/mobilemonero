#!/usr/bin/env node
/**
 * relay/scripts/release-confirmed-tasks.mjs — release the tasks a person has
 * already answered.
 *
 * WHY THIS EXISTS
 * ---------------
 *
 * A person answers; the answer is recorded; the task does not move. The
 * task was parked by the executor as
 *
 *   terminal_reason = 'checklist_complete_awaiting_confirmation'
 *
 * and the only job in the system that advances tasks selects
 *
 *   status IN ('PENDING','CLAIMED','IN_PROGRESS')
 *
 * A task parked in REVIEW is invisible to it. So a confirmed task sat in
 * REVIEW at stage COMPLETION, with a complete checklist, 100% progress, a
 * recorded confirmation and a human-confirmation artifact — and stayed
 * there for ever, because nothing in the system was looking at it.
 *
 * Five tasks were in that state on the morning of 2026-10-22, and one of
 * them had been asked about nine times.
 *
 * WHAT THIS DOES
 * --------------
 *
 * It finds every task that is parked waiting for a person AND already has
 * an answer, and it moves the task the way the answer says it should go:
 *
 *   confirmed_complete   -> completed
 *   more_work_requested  -> back to EXECUTION
 *   question_for_us      -> back to DISCUSS
 *   unclear              -> left alone, and it says why
 *
 * The answer is READ, not guessed. Where the reading is missing it is
 * produced by the same ai-chat reader the live path uses, from the words
 * the person actually wrote, which are on the escalation.
 *
 * The confirmation is created against the escalation that was answered, so
 * the database's own trigger checks the binding: the question must have
 * been put to somebody, must have been answered, must be about this task,
 * and the words must be the words that were answered with. If any of that
 * is wrong the insert is REFUSED, which is the right outcome - a release
 * that cannot be substantiated does not happen.
 *
 * It is safe to run again: a task that has been released is no longer
 * parked, so it is not picked up again.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(__dirname, '..');

const { query } = await import(pathToFileURL(path.join(RELAY, 'lib', 'localDb.mjs')).href);
const { interpretReply } = await import(pathToFileURL(path.join(RELAY, 'lib', 'reply-ingest.mjs')).href);
const {
  recordConfirmation, releaseTaskForAnswer,
} = await import(pathToFileURL(path.join(RELAY, 'lib', 'task-confirmation.mjs')).href);

/** Is this task parked waiting for a person? */
const PARKED = `status = 'REVIEW'
  AND metadata->>'terminal_reason' ILIKE '%await%'
  OR (status = 'REVIEW' AND metadata->>'terminal_reason' ILIKE '%confirm%')`;

async function main() {
  const tasks = await query(`
    SELECT t.id, t.title, t.status, t.stage, t.assignee_agent_id,
           t.metadata->>'terminal_reason' AS reason,
           (SELECT e.id FROM app.task_escalations e
             WHERE e.task_id = t.id AND e.answered_at IS NOT NULL
               AND btrim(coalesce(e.answered_text,'')) <> ''
             ORDER BY e.answered_at DESC LIMIT 1) AS escalation_id
      FROM app.tasks t
     WHERE ${PARKED}
     ORDER BY t.updated_at ASC`);

  if (!tasks.length) {
    console.log('[release] no task is parked waiting on a person');
    return;
  }
  console.log(`[release] ${tasks.length} task(s) parked waiting on a person`);

  let released = 0;
  let alreadyConfirmed = 0;
  let couldNotRead = 0;
  let refused = 0;

  for (const t of tasks) {
    if (!t.escalation_id) {
      console.log(`  · ${t.id.slice(0, 8)} ${t.title} — no answered escalation; still waiting`);
      continue;
    }

    const esc = (await query(
      `SELECT id, task_id, question, subject, to_address, answered_at, answered_text
         FROM app.task_escalations WHERE id = $1`, [t.escalation_id]))[0];
    if (!esc) { console.log(`  · ${t.id.slice(0, 8)} — escalation ${t.escalation_id} is gone`); continue; }

    // The confirmation, if it already exists, is the record of the answer.
    const existing = (await query(
      `SELECT id, reading_intent, reading_summary, source_url
         FROM app.task_confirmations WHERE task_id = $1 ORDER BY confirmed_at DESC LIMIT 1`,
      [t.id]))[0];

    let confirmation = existing || null;
    let reading = null;

    if (existing) {
      alreadyConfirmed++;
      reading = { intent: existing.reading_intent, summary: existing.reading_summary };
    } else {
      // Read the person's words the same way the live path does. The words
      // are on the escalation, so nothing has to be guessed.
      const reply = String(esc.answered_text || '');
      try {
        const read = await interpretReply({
          title: esc.subject || t.title,
          question: esc.question || '',
          reply,
        });
        reading = { intent: read.intent, summary: read.summary, new_work: read.new_work, questions: read.questions };
      } catch (e) {
        console.log(`  ! ${t.id.slice(0, 8)} — could not read the answer: ${e.message}`);
        reading = { intent: 'unclear', summary: 'the answer could not be read' };
      }

      if (reading.intent !== 'confirmed_complete') {
        // Only a confirmation is a confirmation. The other intents still move
        // the task, but they do not need a confirmation row.
        console.log(`  · ${t.id.slice(0, 8)} ${t.title} — answer reads as "${reading.intent}", not a confirmation`);
      } else {
        try {
          confirmation = await recordConfirmation({
            task: t,
            escalation: esc,
            reading,
            replyText: reply,
            from: esc.to_address,
            answeredAt: esc.answered_at,
          });
          if (confirmation) {
            console.log(`  ✓ ${t.id.slice(0, 8)} — confirmation recorded: ${confirmation.source_url}`);
          } else {
            refused++;
            console.log(`  ! ${t.id.slice(0, 8)} — the confirmation was refused by the database`);
            continue;
          }
        } catch (e) {
          refused++;
          console.log(`  ! ${t.id.slice(0, 8)} — the confirmation was refused: ${e.message}`);
          continue;
        }
      }
    }

    if (!reading) { couldNotRead++; continue; }

    const release = await releaseTaskForAnswer({
      task: t,
      reading,
      replyText: esc.answered_text,
      from: esc.to_address,
      confirmation,
    });
    if (release.released) {
      released++;
      console.log(`  ✓ ${t.id.slice(0, 8)} ${t.title} — ${release.status} at stage ${release.stage}`);
    } else {
      couldNotRead++;
      console.log(`  · ${t.id.slice(0, 8)} — not released: ${release.reason}`);
    }
  }

  console.log(`\n[release] ${released} released, ${alreadyConfirmed} already had a confirmation, `
    + `${couldNotRead} left waiting, ${refused} refused by the database`);
}

main().catch((e) => {
  console.error('[release] failed:', e.message);
  process.exit(1);
});
