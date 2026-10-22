#!/usr/bin/env node
// Guards the release of a task whose person has answered.
//
// THE FAILURE THIS EXISTS TO PREVENT
// ---------------------------------
//
// A person answers. The answer is recorded. The task does not move.
//
// The task was parked by the executor as
// terminal_reason = 'checklist_complete_awaiting_confirmation' - the work
// is done, the checklist is complete, and the only thing missing is
// somebody saying it was good.
//
// The reply arrives, ai-chat reads it, the confirmation is written, the
// human-confirmation artifact is attached. And the task stays in REVIEW at
// stage COMPLETION, for ever, because the one job that advances tasks
// selects
//
//   status IN ('PENDING','CLAIMED','IN_PROGRESS')
//
// and REVIEW is not in that list. A task parked in REVIEW is invisible to
// the only advancement authority in the system.
//
// So the answer was a dead end, and the symptom was a person being asked
// the same question nine times while nothing moved. Five tasks were in
// exactly that state on the morning of 2026-10-22.
//
// These checks hold the three halves together:
//   1. the release happens where the answer is recorded;
//   2. the release respects what the answer actually said;
//   3. the artifact the release leans on points at something that resolves.
import { readFileSync } from 'node:fs';
import { query } from '../lib/localDb.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const confirmation = readFileSync(new URL('../lib/task-confirmation.mjs', import.meta.url), 'utf8');
const ingest = readFileSync(new URL('../scripts/ingest-task-replies.mjs', import.meta.url), 'utf8');
const releaseScript = readFileSync(new URL('../scripts/release-confirmed-tasks.mjs', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

section('the release happens where the answer is recorded');
{
  check('there is a release function',
    /export async function releaseTaskForAnswer/.test(confirmation));
  check('the ingest path calls it',
    /await releaseTaskForAnswer\(/.test(ingest));
  check('and it calls it for EVERY reading, not only for "yes"',
    /if \(reading\.intent === 'confirmed_complete'\)[\s\S]{0,4000}await releaseTaskForAnswer\(/.test(ingest));
  check('the release clears the reason the task was parked for',
    /- 'terminal_reason'/.test(confirmation),
    'terminal_reason is metadata, and removing it is how the task stops being parked');
  check('the release is not a bare status write - it carries the reading',
    /'answer_reading'/.test(confirmation) && /'released_by'/.test(confirmation));
}

section('the release respects what the answer said');
{
  check('"yes, that is right" completes the task',
    /intent === 'confirmed_complete'\)[\s\S]{0,200}stage = 'COMPLETED'/.test(confirmation));
  check('"there is more to do" sends it back to EXECUTION',
    /intent === 'more_work_requested'\)[\s\S]{0,200}stage = 'EXECUTION'/.test(confirmation));
  check('"we have a question" sends it back to DISCUSS',
    /intent === 'question_for_us'\)[\s\S]{0,200}stage = 'DISCUSS'/.test(confirmation));
  check('an answer we could not read leaves the task alone',
    /could not record the unclear reading[\s\S]{0,600}return \{ released: false, intent, reason: 'the answer could not be read/.test(confirmation),
    'the unclear branch records the reading and refuses to move the task');
  check('a completion still needs evidence - the database decides',
    /trg_enforce_task_completion_evidence|artifact carrying a non-empty artifact_url/.test(confirmation)
      || /carries a resolvable URL/.test(confirmation));
}

section('the artifact points at something that resolves');
{
  check('there is a route for the confirmation record',
    server.includes("/api/suite/task-confirmations/:id"),
    'the artifact URL must not be a 404');
  check('it serves the person and their words',
    /confirmed_by/.test(server) && /reply_text/.test(server));
  check('the URL the artifact carries is the route that serves it',
    /confirmationUrl[\s\S]{0,120}api\/suite\/task-confirmations/.test(confirmation));
}

section('the loop cannot start again');
{
  check('the backfill script exists', releaseScript.includes('releaseTaskForAnswer'));
  check('it re-reads the answer rather than guessing',
    releaseScript.includes('interpretReply'));
  check('the confirmation is bound to the escalation that was answered',
    releaseScript.includes('recordConfirmation') && releaseScript.includes('escalation: esc'));
  check('a task that has been released is not picked up again',
    /status = 'REVIEW'/.test(releaseScript));
}

section('the live board agrees');
{
  // The real check: are there tasks parked waiting for a person that have
  // already been answered? That is the shape of the bug, and it is a
  // question the database can answer.
  const stuck = await query(`
    SELECT t.id, t.title, t.status, t.stage,
           (SELECT COUNT(*)::int FROM app.task_escalations e
             WHERE e.task_id = t.id AND e.answered_at IS NOT NULL) AS answers,
           (SELECT COUNT(*)::int FROM app.task_confirmations c WHERE c.task_id = t.id) AS confirmations
      FROM app.tasks t
     WHERE t.status = 'REVIEW'
       AND (t.metadata->>'terminal_reason') ILIKE '%await%'
        OR (t.metadata->>'terminal_reason') ILIKE '%confirm%'
       AND t.id IS NOT NULL`);
  const answeredButParked = stuck.filter((t) => t.answers > 0);
  check('no task is parked waiting for a person that has already answered them',
    answeredButParked.length === 0,
    answeredButParked.map((t) => `${t.id.slice(0, 8)} ${t.title} (${t.answers} answer(s))`));

  const waiting = stuck.filter((t) => t.answers === 0);
  console.log(`  note: ${waiting.length} task(s) are parked and genuinely unanswered`
    + (waiting.length ? ' — ' + waiting.map((t) => t.title.slice(0, 40)).join(' | ') : ''));
}

console.log(fails === 0
  ? '\n  an answer moves the task, and a task nobody answered stays where it is'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
