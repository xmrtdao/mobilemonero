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
 * IT DOES NOT CLOSE ANYTHING
 * --------------------------
 * The reading is recorded, the answer is attached to the task, and the task
 * stays where the evidence gate put it. Marking a task done is the board's
 * job and it has a rule about what counts as proof. This script has no
 * opinion about whether any of this work was finished.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(__dirname, '..');

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
