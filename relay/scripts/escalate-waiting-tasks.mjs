#!/usr/bin/env node
/**
 * relay/scripts/escalate-waiting-tasks.mjs — tell somebody that a task is
 * waiting for them.
 *
 * The executor parks work in REVIEW when it cannot finish on its own, and
 * nothing told anybody. Seven tasks sat there for five days with a reason
 * that nothing writes, waiting for a person who was never told there was
 * anything to wait for.
 *
 * This runs on the relay's own clock and goes through the relay's own tool, so
 * there is ONE way to escalate a task: the agent calls it, and this calls it.
 * The tool sends once per task, so running this every few minutes is safe -
 * a task already waiting on somebody is not emailed again.
 *
 * A TASK THAT HAS BEEN ANSWERED IS NOT ASKED AGAIN
 * -------------------------------------------------
 * The query below excludes any task whose escalation has been answered. It
 * used to leave them in, and that was the loop: the answer CLOSES the
 * escalation, so "is there an open escalation?" goes from true to false the
 * moment the person replies - and the tool read that as "nobody has been
 * asked" and asked again. One task was asked nine times in an afternoon, and
 * every one of those answers was already in hand.
 *
 * A task with an answer is not waiting for a person. It is waiting for the
 * fleet to act on what the person said, and asking again cannot help with
 * that.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(__dirname, '..');

// The relay's own key, for the loopback call.
const env = {};
for (const line of fs.readFileSync(path.join(RELAY, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const KEY = env.RELAY_API_KEY || '';
const BASE = process.env.RELAY_BASE_URL || 'http://127.0.0.1:8080';

/** The question, in the words of the reason the task was parked. */
function questionFor(task) {
  const reason = String(task.reason || '');
  if (/awaiting_confirmation/.test(reason)) {
    return 'The work on this task is finished and it is waiting for a person to confirm it. '
      + 'Please look it over and say whether it is good to print.';
  }
  if (/missing_artifact/.test(reason)) {
    return 'This task is done but there is no deliverable we can point at. Please tell us what '
      + 'the finished work should link to, or confirm that it is fine as it is.';
  }
  return 'This task has been parked and it needs a person to move it. Please take a look.';
}

async function main() {
  // A Windows absolute path is not an ESM specifier; it has to be a file://
  // URL. Every other script in here does the same thing.
  const { query } = await import(pathToFileURL(path.join(RELAY, 'lib', 'localDb.mjs')).href);
  const rows = await query(
    `SELECT id, title, status, category, assignee_agent_id,
            metadata->>'terminal_reason' AS reason
       FROM app.tasks
      WHERE status = 'REVIEW'
        AND (metadata->>'terminal_reason' ILIKE '%awaiting%'
             OR metadata->>'terminal_reason' ILIKE '%confirm%')
        AND NOT EXISTS (
          SELECT 1 FROM app.task_escalations e
           WHERE e.task_id = app.tasks.id
             AND e.answered_at IS NOT NULL
        )
      ORDER BY updated_at ASC
      LIMIT 10`);

  if (!rows.length) {
    console.log('[escalate] no task is waiting on a person');
    return;
  }

  for (const t of rows) {
    const r = await fetch(`${BASE}/tools/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'x-agent-id': 'alice' },
      body: JSON.stringify({
        tool: 'escalate-to-human',
        args: {
          task_id: t.id,
          question: questionFor(t),
          reason: t.reason || 'needs a human',
        },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.success) {
      console.log(`[escalate] ${t.id} -> ${j.to} (${j.matched_by || 'known'})`
        + (j.already_escalated ? ' — already waiting, not sent again' : ''));
    } else {
      console.log(`[escalate] ${t.id} -> not sent: ${j.error || j.message || r.status}`);
    }
  }
}

main().catch((e) => {
  console.error('[escalate] failed:', e.message);
  process.exit(1);
});
