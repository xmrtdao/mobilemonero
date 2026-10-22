#!/usr/bin/env node
/**
 * relay/scripts/ingest-task-replies.mjs — read the answers to the questions we asked.
 *
 * A task that needed a person was escalated by email. This finds the answers
 * that have come back, reads them, and puts them where the fleet can see
 * them.
 *
 * WHY A SEPARATE SCRIPT, AND NOT THE INBOUND PARSER
 * --------------------------------------------------
 * The inbound parser reads mail and files it. It runs on Alice's hourly cycle
 * and its job is to notice that mail exists. This job is different in three
 * ways that matter:
 *
 *   - IT IS ABOUT ANSWERS, NOT MAIL. A reply to a question we asked is not
 *     new work; it is the answer to work already on the board. Filing it as
 *     an inquiry would create a second task for a task that already exists.
 *
 *   - IT READS THE WORDS. A reply says what it means, and that has to be read
 *     by something that can read. A classifier that tags "reply" has not
 *     noticed that one of the replies asked for different work entirely.
 *
 *   - IT IS TIMELY. A person answered; the fleet should find out while the
 *     answer is still worth answering. Alice's cycle is hourly and the
 *     escalation watcher's is every ten minutes, which is the right tempo for
 *     a conversation.
 *
 * IT DOES NOT DECIDE WHETHER THE WORK WAS DONE — BUT IT DOES MOVE THE TASK
 * -----------------------------------------------------------------------
 * The reading is recorded and the answer is attached to the task. The task
 * then goes where the ANSWER says it goes, and not one step further:
 *
 *   "yes, that is right"   -> the task is completed. The person said so, and
 *                              the human-confirmation artifact that carries
 *                              their words is the evidence the board's
 *                              completion rule asks for.
 *   "there is more to do"   -> back to EXECUTION, for the fleet to work on.
 *   "we have a question"    -> back to DISCUSS, for the answer to be
 *                              discussed.
 *   "we could not read it"  -> it stays exactly where it is, and says why.
 *
 * This script does not decide whether any of the WORK was finished - that is
 * the board's rule, and the board's rule is unchanged. What this script does
 * is stop the ANSWER from being a dead end.
 *
 * Until it did that, a reply was recorded, the escalation was closed, a
 * confirmation was written - and the task stayed in REVIEW at stage
 * COMPLETION for ever. Nothing moved it: the only job that advances tasks
 * selects status IN ('PENDING','CLAIMED','IN_PROGRESS'), and a task parked
 * in REVIEW is invisible to it. Five tasks were in that state on the morning
 * of 2026-10-22, each with a human confirmation already recorded against
 * it, each of them waiting for something that was never going to happen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(__dirname, '..');
// The relay's own address, for the loopback calls this script makes.
const RELAY_BASE = process.env.RELAY_BASE_URL || 'http://127.0.0.1:8080';

const { query } = await import(pathToFileURL(path.join(RELAY, 'lib', 'localDb.mjs')).href);
const {
  findEscalationByToken,
  findEscalationBySubject,
  answerEscalation,
} = await import(pathToFileURL(path.join(RELAY, 'lib', 'task-escalation.mjs')).href);
const {
  interpretReply,
  writeToSharedContext,
  attachAnswerToTask,
  replyBodyOnly,
} = await import(pathToFileURL(path.join(RELAY, 'lib', 'reply-ingest.mjs')).href);
const {
  recordConfirmation,
  releaseTaskForAnswer,
} = await import(pathToFileURL(path.join(RELAY, 'lib', 'task-confirmation.mjs')).href);

/**
 * The mail that answers a question.
 *
 * Read from app.inbox_emails, which is where inbound mail actually lands.
 * The relay's own in-memory inbox is not read here: it holds 45 pfp messages
 * and nothing for mobilemonero, because it is filled by a poller that races
 * the webhook. The durable table is the one that had all six of the replies
 * nobody had seen.
 *
 * The subject carries the token for questions asked from now on, and the
 * question itself for the older ones - so both are matched, by token first.
 */
async function repliesWaiting() {
  return query(`
    SELECT e.id AS escalation_id, e.task_id, e.subject AS escalation_subject,
           e.question, e.to_address, e.sent_at,
           m.id AS mail_id, m.email_id, m.sender, m.subject AS mail_subject,
           m.body_text, m.received_at, m.domain
      FROM app.task_escalations e
      LEFT JOIN LATERAL (
        SELECT id, email_id, sender, subject, body_text, received_at, domain
          FROM app.inbox_emails
         WHERE read = false
           AND body_text IS NOT NULL
           AND btrim(body_text) <> ''
           AND (sender ILIKE '%' || split_part(e.to_address, '@', 2) || '%'
                OR sender ILIKE '%' || split_part(e.to_address, '@', 1) || '%')
           AND (
             (e.subject LIKE '%[esc_%' AND subject LIKE '%' || substring(e.subject from '%\[esc_[a-f0-9]+\]%') || '%')
             OR lower(subject) ILIKE '%' || lower(replace(e.subject, 'Needs you: ', '')) || '%'
           )
         ORDER BY received_at ASC
         LIMIT 1
      ) m ON true
     WHERE e.still_open
       AND m.id IS NOT NULL
     ORDER BY e.sent_at ASC
  `);
}

async function main() {
  const waiting = await repliesWaiting();
  if (!waiting.length) {
    console.log('[ingest] no reply is waiting for us');
    return;
  }

  console.log(`[ingest] ${waiting.length} repl${waiting.length === 1 ? 'y' : 'ies'} waiting`);

  for (const r of waiting) {
    const subject = r.mail_subject || '';
    const tokenMatch = subject.match(/\[(esc_[a-f0-9]+)\]/i);

    // The escalation this reply answers. By token when the question carried
    // one, and by the question's subject for the older ones.
    const esc = tokenMatch
      ? await findEscalationByToken(tokenMatch[1])
      : await findEscalationBySubject(subject);

    if (!esc) {
      console.warn(`[ingest] a reply for ${r.task_id} matches no open escalation - leaving it`);
      continue;
    }
    if (Number(esc.id) !== Number(r.escalation_id)) {
      console.warn(`[ingest] the reply matched escalation ${esc.id}, not ${r.escalation_id} - leaving it`);
      continue;
    }

    const taskRows = await query(
      `SELECT id, title FROM app.tasks WHERE id = $1`, [esc.task_id]);
    if (!taskRows.length) {
      console.warn(`[ingest] escalation ${esc.id} names task ${esc.task_id}, which is not on the board`);
      continue;
    }
    const task = taskRows[0];

    const replyText = replyBodyOnly(r.body_text);
    const from = r.sender || null;

    console.log(`\n[ingest] ${task.title}`);
    console.log(`        ${String(r.mail_subject).slice(0, 80)}`);
    console.log(`        ${String(replyText).replace(/\s+/g, ' ').slice(0, 200)}`);

    // Read it.
    const reading = await interpretReply({
      title: task.title,
      question: esc.question,
      reply: replyText,
      sessionId: `reply-read-${esc.id}`,
    });

    if (!reading.ok) {
      // The answer is real and it is in the mailbox. Failing to read it is a
      // problem with the reading, not with the answer, so the answer is NOT
      // marked as handled: the next pass will try again. Closing the
      // escalation here would lose it.
      console.error(`[ingest] could not read the reply for ${esc.id}: ${reading.error} - leaving it open`);
      continue;
    }

    console.log(`        reading: ${reading.intent} — ${reading.summary}`);
    if (reading.new_work?.length) {
      console.log(`        they asked for: ${reading.new_work.join('; ')}`);
    }
    if (reading.questions?.length) {
      console.log(`        they asked us: ${reading.questions.join('; ')}`);
    }

    // Put it where the fleet will find it.
    await writeToSharedContext({
      task,
      escalation: esc,
      reading,
      replyText,
      from,
      answeredAt: r.received_at ? new Date(r.received_at).toISOString() : null,
    });

    // Attach it to the task, as the answer.
    await attachAnswerToTask(esc.task_id, {
      escalation: esc,
      reading,
      replyText,
      from,
      answeredAt: r.received_at ? new Date(r.received_at).toISOString() : null,
    });

    // And close the escalation, so it is not answered twice.
    await answerEscalation(esc.id, replyText, { from });

    // A CONFIRMATION IS EVIDENCE.
    //
    // Until this, the answer stopped at the task's metadata: the reading
    // was attached, the escalation was closed, and the task stayed in
    // REVIEW with the same reason it had before. Nothing could complete it,
    // because the completion gate wants an artifact carrying a resolvable
    // URL, and a sentence in a metadata column is not one.
    //
    // So the confirmation is recorded as its own row and attached as a
    // human-confirmation artifact. The trigger on that artifact checks the
    // substance: that the question was put to somebody, that it was
    // answered, that the words recorded are the words that were answered
    // with, and that the address that answered is the address the question
    // went to. A confirmation cannot be invented.
    //
    // It has to come AFTER the escalation is closed, because the trigger
    // refuses a confirmation of a question that has not been answered.
    if (reading.intent === 'confirmed_complete') {
      // The address that answered has to be the address the question went
      // to. The reply may carry a display name around it - "Joe <joe@x>"
      // is the same person as "joe@x" - so the comparison is on the
      // address part, and the canonical form of the address is what is
      // recorded.
      const answeredAddress = String(from || '').match(/<([^>]+)>/)?.[1] || String(from || '').trim();
      const askedAddress = String(esc.to_address || '').trim();
      if (answeredAddress && askedAddress && answeredAddress.toLowerCase() !== askedAddress.toLowerCase()) {
        console.warn(`[ingest] the reply came from ${answeredAddress}, but the question went to ${askedAddress}`
          + ' - not recording a confirmation');
      } else {
        const confirmation = await recordConfirmation({
          task,
          escalation: esc,
          reading,
          replyText,
          from: askedAddress || answeredAddress || null,
          answeredAt: r.received_at ? new Date(r.received_at).toISOString() : null,
        });
        if (confirmation) {
          console.log(`        ✓ recorded as a confirmation: ${confirmation.source_url}`);
        } else {
          console.error('        ! the confirmation could not be recorded');
        }
      }
    }

    // ── AND THEN MOVE THE TASK ────────────────────────────────────────────
    //
    // Recording the answer was the end of the loop and not the end of the
    // job. The task was parked as "checklist complete, awaiting
    // confirmation"; the confirmation has now arrived, so the task is not
    // waiting for a person any more.
    //
    // Without this, the task stays in REVIEW at stage COMPLETION with a
    // complete checklist, a 100% progress bar, a recorded confirmation and
    // a human-confirmation artifact - and it stays there forever, because
    // the only job that moves tasks forward selects
    // status IN ('PENDING','CLAIMED','IN_PROGRESS') and REVIEW is not in
    // that list. Five tasks were in exactly that state on the morning of
    // 2026-10-22.
    //
    // The release happens for EVERY reading, not only for "yes": a reply
    // that asks for more work sends the task back to EXECUTION, and a reply
    // that asks us something sends it back to DISCUSS. Only an answer we
    // could not read leaves it parked, and it says why.
    {
      const release = await releaseTaskForAnswer({
        task,
        reading,
        replyText,
        from: String(esc.to_address || from || '').trim(),
        confirmation: null,
      });
      if (release.released) {
        console.log(`        ✓ released the task: ${release.status} at stage ${release.stage}`);
        // Say so on the bus. A task that completed because a person said so
        // is worth the fleet knowing, and the board change is not otherwise
        // visible anywhere an agent looks.
        try {
          await fetch(`${RELAY_BASE}/api/fleet-chat/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agent: 'alice-daemon',
              message: `✅ **Task completed by human confirmation** — ${task.title}\n`
                + `The client replied: "${String(replyText).slice(0, 200)}"`,
              channel: 'fleet',
            }),
            signal: AbortSignal.timeout(8000),
          });
        } catch { /* the announcement is a courtesy, not the mechanism */ }
      } else if (release.reason) {
        console.log(`        · task not released: ${release.reason}`);
      }
    }

    // Mark the mail read, so it is not read again. The reply is recorded in
    // three places now; this only stops the next pass repeating the work.
    await query(
      `UPDATE app.inbox_emails
          SET read = true,
              metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                    'parsed_by', 'alice-sidecar',
                    'parsed_at', now(),
                    'category', 'reply',
                    'event', 'escalation_answered',
                    'escalation_id', $2::text,
                    'task_id', $1::text)
        WHERE id = $3::int`,
      [esc.task_id, String(esc.id), r.mail_id]).catch((e) => {
      console.error(`[ingest] could not mark the mail read: ${e.message}`);
    });

    console.log('        ✓ read, recorded, and attached to the task');
  }
}

main().catch((e) => {
  console.error('[ingest] failed:', e.message);
  process.exit(1);
});
