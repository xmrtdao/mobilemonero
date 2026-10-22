#!/usr/bin/env node
// Proves the release actually works, against a real database.
//
// The source-level checks in task-release-on-answer.test.mjs prove the code
// says what it means to say. This one proves the DATABASE agrees: a task
// parked waiting for a person, with a real escalation that was really
// answered by the person it was sent to, is really moved when the answer
// is recorded.
//
// It runs against the throwaway database the suite uses (xmrt_suite_test),
// with the real triggers in place, so a release that the evidence gate
// would refuse is refused here too.
//
//   node tests/_run.mjs task-release
import { query as localQuery } from '../lib/localDb.mjs';
import { recordConfirmation, releaseTaskForAnswer } from '../lib/task-confirmation.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const PROBE = 'zz-release-probe-' + Date.now();
const TASK_ID = 'zz-release-task-' + Date.now();
const ADDRESS = 'probe@example.com';

async function cleanup() {
  await localQuery(`DELETE FROM app.task_confirmations WHERE task_id = $1`, [TASK_ID]).catch(() => {});
  await localQuery(`DELETE FROM app.task_escalations WHERE task_id = $1`, [TASK_ID]).catch(() => {});
  await localQuery(`DELETE FROM app.task_artifacts WHERE task_id = $1`, [TASK_ID]).catch(() => {});
  await localQuery(`DELETE FROM app.tasks WHERE id = $1`, [TASK_ID]).catch(() => {});
}

/** A task parked the way the executor parks one. */
async function parkTask() {
  await localQuery(
    `INSERT INTO app.tasks
       (id, title, stage, status, progress_percentage, completed_checklist_items, metadata, updated_at)
     VALUES ($1, $2, 'COMPLETION', 'REVIEW', 100, '["a","b"]'::jsonb,
             jsonb_build_object('terminal_reason','checklist_complete_awaiting_confirmation',
                                'checklist', '["a","b"]'::jsonb), now())`,
    [TASK_ID, PROBE]);
  return (await localQuery(`SELECT id, status, stage, metadata FROM app.tasks WHERE id = $1`, [TASK_ID]))[0];
}

/** An escalation that a person was asked and answered. */
async function answerEscalation(text) {
  const esc = (await localQuery(
    `INSERT INTO app.task_escalations
       (task_id, reason, question, to_address, from_address, subject, body, sent_at, answered_at, answered_text, still_open, reply_token)
     VALUES ($1, 'awaiting_confirmation', 'is it right?', $2, 'alice <alice@example.com>',
             'Needs you: ' || $3, 'body', now() - INTERVAL '1 hour', now(), $4, false, $5)
     RETURNING id, to_address, subject, answered_text`,
    [TASK_ID, ADDRESS, PROBE, text, 'esc_' + Date.now().toString(16).slice(-8)]))[0];
  return esc;
}

await cleanup();

section('a confirmed answer completes the task');
{
  const parked = await parkTask();
  check('the task starts parked', parked.status === 'REVIEW' && parked.stage === 'COMPLETION', parked);
  check('and it says why', parked.metadata?.terminal_reason === 'checklist_complete_awaiting_confirmation', parked.metadata);

  const esc = await answerEscalation('Yes, everything is correct.');
  const confirmation = await recordConfirmation({
    task: { id: TASK_ID, title: PROBE },
    escalation: esc,
    reading: { intent: 'confirmed_complete', summary: 'the client approved it' },
    replyText: 'Yes, everything is correct.',
    from: ADDRESS,
    answeredAt: new Date().toISOString(),
  });
  check('the confirmation is recorded', !!confirmation, confirmation);
  check('it points at a resolvable record', !!confirmation?.source_url, confirmation?.source_url);

  const artifact = (await localQuery(
    `SELECT artifact_type, artifact_url FROM app.task_artifacts WHERE task_id = $1`, [TASK_ID]))[0];
  check('the artifact carries the confirmation', artifact?.artifact_type === 'human-confirmation', artifact);
  check('and it carries a URL', !!artifact?.artifact_url, artifact);

  const released = await releaseTaskForAnswer({
    task: { id: TASK_ID, title: PROBE },
    reading: { intent: 'confirmed_complete', summary: 'the client approved it' },
    replyText: 'Yes, everything is correct.',
    from: ADDRESS,
    confirmation,
  });
  check('the task is released', released.released === true, released);

  const after = (await localQuery(
    `SELECT status, stage, progress_percentage, metadata FROM app.tasks WHERE id = $1`, [TASK_ID]))[0];
  check('it is completed', after.status === 'COMPLETED', after.status);
  check('at the completion stage', after.stage === 'COMPLETED', after.stage);
  check('the reason it was parked for is gone',
    after.metadata?.terminal_reason === undefined, after.metadata?.terminal_reason);
  check('the reading is kept on the task',
    after.metadata?.answer_reading?.intent === 'confirmed_complete', after.metadata?.answer_reading);
  check('and it says who released it',
    after.metadata?.released_by === `human-confirmation:${confirmation.id}`, after.metadata?.released_by);
}

section('an answer that asks for more work sends the task back');
{
  await cleanup();
  await parkTask();
  const esc = await answerEscalation('There is still a problem with the refund.');
  const released = await releaseTaskForAnswer({
    task: { id: TASK_ID, title: PROBE },
    reading: { intent: 'more_work_requested', summary: 'they want the refund looked at again', new_work: ['refund'] },
    replyText: 'There is still a problem with the refund.',
    from: ADDRESS,
    confirmation: null,
  });
  check('the task is released back into the work', released.released === true, released);
  const after = (await localQuery(
    `SELECT status, stage, metadata FROM app.tasks WHERE id = $1`, [TASK_ID]))[0];
  check('it is back in EXECUTION', after.stage === 'EXECUTION', after.stage);
  check('and it is not completed', after.status !== 'COMPLETED', after.status);
  check('the reason it was parked for is gone',
    after.metadata?.terminal_reason === undefined, after.metadata?.terminal_reason);
}

section('an answer we could not read leaves the task exactly where it was');
{
  await cleanup();
  const before = await parkTask();
  const esc = await answerEscalation('hmm');
  const released = await releaseTaskForAnswer({
    task: { id: TASK_ID, title: PROBE },
    reading: { intent: 'unclear', summary: 'we could not read it' },
    replyText: 'hmm',
    from: ADDRESS,
    confirmation: null,
  });
  check('nothing is released', released.released === false, released);
  const after = (await localQuery(
    `SELECT status, stage, metadata FROM app.tasks WHERE id = $1`, [TASK_ID]))[0];
  check('the task is still parked', after.status === before.status && after.stage === before.stage, after);
  check('and it still says why it is waiting',
    after.metadata?.terminal_reason === 'checklist_complete_awaiting_confirmation', after.metadata?.terminal_reason);
  check('the reading is recorded so the board can show it',
    after.metadata?.answer_reading?.intent === 'unclear', after.metadata?.answer_reading);
}

section('the database refuses a confirmation nobody answered');
{
  await cleanup();
  await parkTask();
  // An escalation that was never answered.
  const esc = (await localQuery(
    `INSERT INTO app.task_escalations
       (task_id, reason, question, to_address, from_address, subject, body, sent_at, still_open, reply_token)
     VALUES ($1, 'awaiting_confirmation', 'is it right?', $2, 'alice <alice@example.com>',
             'Needs you: ' || $3, 'body', now(), true, $4)
     RETURNING id`,
    [TASK_ID, ADDRESS, PROBE, 'esc_' + Date.now().toString(16).slice(-8)]))[0];

  // The trigger refuses it, and the refusal comes back as "no confirmation"
  // rather than as a thrown error - the caller is told there is no
  // confirmation, which is the same answer either way.
  const result = await recordConfirmation({
    task: { id: TASK_ID, title: PROBE },
    escalation: esc,
    reading: { intent: 'confirmed_complete', summary: 'invented' },
    replyText: 'Yes, everything is correct.',
    from: ADDRESS,
    answeredAt: new Date().toISOString(),
  });
  check('the trigger refuses a confirmation of an unanswered question',
    !result, 'the guard is what makes the artifact worth trusting');
  const rows = await localQuery(
    `SELECT id FROM app.task_confirmations WHERE task_id = $1`, [TASK_ID]);
  check('and nothing was written', rows.length === 0, rows.length);
}

await cleanup();

console.log(fails === 0
  ? '\n  an answer moves the task, and the database is the one that says so'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
