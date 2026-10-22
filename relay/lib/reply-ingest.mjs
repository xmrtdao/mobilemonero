/**
 * relay/lib/reply-ingest.mjs — putting a person's answer where the fleet can see it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The executor parks work in REVIEW when it needs a person, and the escalation
 * asks them. When they answer, the answer has to come back into the system.
 *
 * The first version of that path stored the reply text on the task and stopped
 * there. Six replies arrived on 2026-10-21 and the fleet could not use any of
 * them: the answer was a sentence in a row, not something an agent could act
 * on. And the replies were not even being read - they landed in
 * app.inbox_emails, which nothing read.
 *
 * So this module does three things:
 *
 *   1. READS the reply from the durable table (app.inbox_emails), which is
 *      where inbound mail actually lives, and matches it to the escalation it
 *      answers.
 *
 *   2. READS what the person actually said, through ai-chat. A reply is
 *      natural language, and the difference between "yes this is complete" and
 *      "do this other thing first" is the whole point of asking. Two of the
 *      six replies on 2026-10-21 were not confirmations at all, and only
 *      reading them made that visible.
 *
 *   3. WRITES the reading into shared context - knowledge.shared_context and
 *      app.fleet_memory - so the next agent to pick up the task finds the
 *      person's answer in the place it looks, rather than having to know that
 *      this particular table exists.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not decide that the work is done. A person saying "this is complete"
 * is a person saying the work looks complete; the evidence gate on app.tasks
 * is what decides whether a task may be marked finished, and that gate does
 * not move because an email arrived. What this module produces is a READING,
 * recorded where the fleet can find it, plus the reply itself attached to the
 * task as the answer it is.
 *
 * The reading is a reading. It is recorded as what the model said about the
 * person's words, attributed to the model, so nobody downstream mistakes it
 * for the person's own statement.
 */

import { query as localQuery } from './localDb.mjs';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

// ── Env ──────────────────────────────────────────────────────
function loadEnv() {
  if (process.env.SUPABASE_URL) return;
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// The vocabulary of what a person can mean when they answer a question.
//
// These are the readings, not the conclusions. `confirmed_complete` means the
// person said the work looks complete. It does NOT mean the task may be
// marked complete - that is the evidence gate's decision, and it is the
// database's, not this module's.
export const READINGS = [
  'confirmed_complete',
  'more_work_requested',
  'question_for_us',
  'unclear',
];

/**
 * The prompt.
 *
 * It asks for JSON and nothing else, because the answer to this prompt is
 * parsed. It names the reading vocabulary, because "what did they mean" is a
 * closed set of four things here and an open-ended answer would be prose that
 * nothing downstream can switch on.
 *
 * It is told explicitly not to be generous with a confirmation. The failure
 * mode this guards against is real: a reply that says "I believe we have
 * verified the work is complete" is a confirmation, and a reply that says
 * "confirm this is complete by cleaning up our channel and deleting the test
 * posts" is NOT - it is the opposite, and a model that reads it as a
 * confirmation closes a task whose work was never done.
 */
const INTERPRET_PROMPT = `You are reading a reply from a client to a question an AI team asked them by email.

TASK TITLE: {title}
THE QUESTION WE ASKED: {question}
THE REPLY: {reply}

Reply with ONLY a JSON object, no other text:
{"intent":"confirmed_complete|more_work_requested|question_for_us|unclear",
 "summary":"one sentence, plain, what they actually said",
 "new_work":["any concrete work they asked for, verbatim-ish, empty array if none"],
 "questions":["any question they asked us, empty array if none"]}

Rules:
- "confirmed_complete" ONLY if they say the work is done, finished, correct or approved.
  Do not read "confirm this is complete BY doing something else" as a confirmation:
  if they ask for anything to be changed, cleaned up, deleted or built first, use
  "more_work_requested".
- If they ask us a question, use "question_for_us".
- If you cannot tell what they mean, use "unclear". A wrong reading closes a task
  that is not finished, so "unclear" is the safe answer when it is not obvious.
`;

/** Strip the quoted original message so the model reads the answer, not the question again. */
function replyBodyOnly(body) {
  const text = String(body || '').trim();
  // Mail clients quote the original under a header like "On <date> <who> wrote:".
  const cut = text.search(/\n\s*On .{0,120}\bwrote:\s*$/m);
  if (cut > 0) return text.slice(0, cut).trim();
  const cut2 = text.search(/\n\s*-{2,}\s*Original Message\s*-{2,}/i);
  if (cut2 > 0) return text.slice(0, cut2).trim();
  return text;
}

/**
 * Ask ai-chat what the reply means.
 *
 * ai-chat is async-wrapped: it answers with {status:'processing', request_id}
 * and the real answer has to be polled for. Not polling is why the fleet chat
 * path used to read Eliza's answer as an empty string and fall through to a
 * fallback - the answer was produced, stored, and dropped.
 */
export async function interpretReply({ title, question, reply, sessionId }) {
  const prompt = INTERPRET_PROMPT
    .replace('{title}', String(title || '').slice(0, 200))
    .replace('{question}', String(question || '').slice(0, 1200))
    .replace('{reply}', String(reply || '').slice(0, 4000));

  if (!SUPABASE_KEY) {
    return { ok: false, error: 'no service key' };
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userQuery: prompt,
        senderName: 'Alice',
        session_id: sessionId || `reply-read-${Date.now().toString(36)}`,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      return { ok: false, error: `ai-chat HTTP ${res.status}` };
    }
    let data = await res.json().catch(() => ({}));

    if (data?.status === 'processing' && data?.request_id) {
      const pollUrl = `${SUPABASE_URL}/functions/v1/ai-chat?request_id=${encodeURIComponent(data.request_id)}`;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const pr = await fetch(pollUrl, {
          headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
          signal: AbortSignal.timeout(8000),
        }).catch(() => null);
        if (!pr) continue;
        const st = await pr.json().catch(() => ({}));
        if (st?.status === 'done') {
          data = st.result && typeof st.result === 'object' ? st.result : { content: st.result };
          break;
        }
        if (st?.status === 'error' || st?.status === 'not_found') {
          return { ok: false, error: `ai-chat ${st.status}: ${st.error || ''}` };
        }
      }
    }

    const raw = String(data?.content || '').trim();
    if (!raw) return { ok: false, error: 'ai-chat returned nothing' };

    const parsed = parseReading(raw);
    return { ok: true, ...parsed, raw };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Pull the JSON out of the model's answer.
 *
 * A model asked for JSON will usually give JSON, and when it does not it
 * usually wraps it. So: find the outermost braces, parse that. If it will not
 * parse, the reading is unknown - and an unknown reading is `unclear`, never
 * a confirmation.
 */
export function parseReading(raw) {
  const text = String(raw || '').trim();
  let obj = null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    obj = JSON.parse(candidate);
  } catch {
    const braced = candidate.match(/\{[\s\S]*\}/);
    if (braced) {
      try { obj = JSON.parse(braced[0]); } catch { obj = null; }
    }
  }

  if (!obj || typeof obj !== 'object') {
    return {
      intent: 'unclear',
      summary: 'the reply could not be read',
      new_work: [],
      questions: [],
      parse_failed: true,
    };
  }

  const intent = READINGS.includes(obj.intent) ? obj.intent : 'unclear';
  const asList = (v) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 500)).filter(Boolean) : []);
  return {
    intent,
    summary: String(obj.summary || '').slice(0, 1000),
    new_work: asList(obj.new_work),
    questions: asList(obj.questions),
  };
}

/**
 * Write the reading into shared context.
 *
 * Two places, because agents look in two places:
 *
 *   - knowledge.shared_context is what the shared-context tool reads and
 *     writes, and it is keyed. One row per task, so a later answer replaces
 *     an earlier one rather than piling up.
 *
 *   - app.fleet_memory is what the fleet's recall and the memory tools read,
 *     and it is append-only with a TTL. This is the reading as an event.
 *
 * Both carry the person's own words alongside the reading, because the
 * reading is a reading and the words are the fact. Anyone who disagrees with
 * the reading can see what it was a reading of.
 */
export async function writeToSharedContext({ task, escalation, reading, replyText, from, answeredAt }) {
  const key = `task_reply:${task.id}`;
  const value = {
    task_id: task.id,
    task_title: task.title,
    escalation_id: escalation.id,
    // The person's words. The fact.
    reply: String(replyText || '').slice(0, 4000),
    replied_by: from || null,
    replied_at: answeredAt || new Date().toISOString(),
    // The model's reading of those words. A reading, and labelled as one.
    reading: {
      intent: reading.intent,
      summary: reading.summary,
      new_work: reading.new_work,
      questions: reading.questions,
      read_by: 'ai-chat',
    },
  };

  const description = [
    `Answer to "${task.title}"`,
    reading.summary || '(no summary)',
    reading.new_work?.length ? `Asked for: ${reading.new_work.join('; ')}` : '',
    reading.questions?.length ? `Asked us: ${reading.questions.join('; ')}` : '',
  ].filter(Boolean).join(' — ').slice(0, 1000);

  // ── knowledge.shared_context ──────────────────────────────────
  const existing = await localQuery(
    `SELECT id FROM knowledge.shared_context WHERE context_key = $1`, [key]).catch(() => []);
  if (existing.length) {
    await localQuery(
      `UPDATE knowledge.shared_context
          SET value = $2, description = $3, last_updated_by = $4, updated_at = now()
        WHERE context_key = $1`,
      [key, JSON.stringify(value), description, 'alice']).catch((e) => {
        console.error('[reply-ingest] shared_context update failed:', e.message);
      });
  } else {
    await localQuery(
      `INSERT INTO knowledge.shared_context (context_key, context_type, value, description, last_updated_by)
       VALUES ($1, 'task_reply', $2, $3, $4)`,
      [key, JSON.stringify(value), description, 'alice']).catch((e) => {
        console.error('[reply-ingest] shared_context insert failed:', e.message);
      });
  }

  // ── app.fleet_memory ─────────────────────────────────────────
  // Appended, not upserted: the memory of an event is the event. A person
  // answering twice is two events, and the second one does not erase the
  // first.
  await localQuery(
    `INSERT INTO app.fleet_memory
       (agent_id, agent_role, memory_type, scope, title, body, payload, refs, confidence, ttl_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '168 hours')`,
    [
      'alice',
      'observer',
      'human_answer',
      'fleet',
      `A person answered: ${task.title}`.slice(0, 200),
      [
        reading.summary || '(no summary)',
        reading.new_work?.length ? `They asked for: ${reading.new_work.join('; ')}` : '',
        reading.questions?.length ? `They asked us: ${reading.questions.join('; ')}` : '',
        '',
        'Their words:',
        String(replyText || '').slice(0, 1500),
        '',
        `(read by ai-chat: ${reading.intent})`,
      ].filter(Boolean).join('\n').slice(0, 4000),
      JSON.stringify({
        task_id: task.id,
        escalation_id: escalation.id,
        intent: reading.intent,
        replied_by: from || null,
        reply: String(replyText || '').slice(0, 4000),
      }),
      JSON.stringify([{ kind: 'task', id: task.id, ts: answeredAt || new Date().toISOString() }]),
      reading.intent === 'unclear' ? 0.4 : 0.8,
    ]).catch((e) => {
      console.error('[reply-ingest] fleet_memory insert failed:', e.message);
    });

  return { key };
}

/**
 * Attach the answer to the task, as the answer.
 *
 * The task row is where the agent that asked will look, so the answer goes
 * there verbatim - the words, who sent them, and when. The reading is
 * recorded beside it and labelled, so nothing downstream can mistake a
 * model's opinion for the person's statement.
 */
export async function attachAnswerToTask(taskId, { escalation, reading, replyText, from, answeredAt }) {
  const at = answeredAt || new Date().toISOString();
  await localQuery(
    `UPDATE app.tasks
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'human_answer', jsonb_build_object(
                'escalation_id', $2::text,
                'reply', $3::text,
                'replied_by', $4::text,
                'replied_at', $5::text,
                'reading', jsonb_build_object(
                  'intent', $6::text,
                  'summary', $7::text,
                  'new_work', $8::jsonb,
                  'questions', $9::jsonb,
                  'read_by', 'ai-chat')),
              'human_answer_at', $5::text),
            updated_at = now()
      WHERE id = $1::text`,
    [
      taskId,
      String(escalation.id),
      String(replyText || '').slice(0, 8000),
      from || null,
      at,
      reading.intent,
      reading.summary || null,
      JSON.stringify(reading.new_work || []),
      JSON.stringify(reading.questions || []),
    ]).catch((e) => {
      console.error('[reply-ingest] could not attach the answer to the task:', e.message);
    });
}

export { replyBodyOnly };
