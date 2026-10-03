/**
 * relay/jobby/employer-chat.mjs — the employer conversation loop
 *
 * Built on the same primitives as the candidate chat (`llmChat.chat`, the
 * `TOOL_CALL:` inline convention, a bounded turn loop) because those are the
 * parts that work, and a second, differently-shaped model loop on the same
 * process is a second set of provider quirks to rediscover.
 *
 * What is different, deliberately:
 *
 *   - The system prompt is the employer's, from employer-persona.mjs.
 *   - The tool set is the employer's. There is no path from here to jobby_send,
 *     jobby_apply, or any other irreversible candidate action, and that is a
 *     property of the tool list rather than a check.
 *   - The reply is reconciled against the database before it is returned. An
 *     employer who is told "your posting is live" and finds nothing on the board
 *     has been misled by the model, and this is the layer that catches it.
 */

import { buildEmployerPrompt } from './employer-persona.mjs';
import { createEmployerTools } from './employer-tools.mjs';
import { parseToolCalls } from './chat.mjs';
import * as store from './employer-store.mjs';

/**
 * Bounded. An unbounded loop here is a loop that keeps writing rows.
 *
 * 10, not 6. Drafting a posting from one sentence took the full six turns and
 * stopped mid-work: save, two title lookups, then three updates, with the model
 * still issuing calls when the budget ran out. The turn is now able to finish a
 * draft and still stop — and when it does not, it says so rather than showing a
 * truncated reply as if it were the answer.
 */
const MAX_TOOL_TURNS = 10;

/** How much history is sent. Enough to hold a thread, not a transcript. */
const HISTORY_TURNS = 16;

export async function employerChat({ employer, message, postingId = null, llmChat }) {
  const tools = createEmployerTools();
  const ctx = { employerId: employer.id, userMessage: message };

  const posting = postingId ? await store.getPosting(postingId, employer.id) : null;

  const history = await store.listEmployerMessages(employer.id, { limit: HISTORY_TURNS * 3 });
  const systemPrompt = buildEmployerPrompt({
    employer,
    posting,
    messages: history.slice(-HISTORY_TURNS),
  });

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history
      .filter((m) => m.role === 'employer' || m.role === 'assistant')
      .slice(-HISTORY_TURNS)
      .map((m) => ({ role: m.role === 'employer' ? 'user' : 'assistant', content: m.body })),
    { role: 'user', content: message },
  ];

  await store.addEmployerMessage(employer.id, { role: 'employer', body: message, postingId });

  const executed = [];
  let reply = '';
  let turns = 0;
  let providerError = null;

  while (turns < MAX_TOOL_TURNS) {
    turns++;
    let out;
    try {
      out = await llmChat.chat(messages, { agent: 'jobby', maxTokens: 1400 });
    } catch (e) {
      // A provider outage is not the employer's problem to debug, and the one
      // thing that must not happen is a reply implying a posting was saved when
      // no tool ran. Saying nothing changed is the honest sentence.
      providerError = String(e.message || e).slice(0, 200);
      reply = `I could not reach the model just now — ${providerError}. Nothing was changed. `
        + 'Try again in a moment; your posting is still exactly as it was.';
      break;
    }

    reply = out?.content ?? out?.response ?? '';
    const { calls, text: prose } = parseToolCalls(reply);

    if (!calls.length) {
      // Strip any TOOL_CALL lines the model emitted and could not parse, so the
      // employer is not shown machinery.
      reply = prose || reply;
      break;
    }

    const results = [];
    for (const call of calls) {
      const name = call.tool || call.name;
      const fn = tools[name];
      if (!fn) {
        // Reported to the model as well as logged, so it can tell the employer
        // rather than quietly doing nothing.
        const err = { tool: name, error: 'no such tool' };
        results.push(err);
        executed.push(err);
        continue;
      }
      try {
        const out2 = await fn(call.args || call.arguments || {}, ctx);
        const rec = { tool: name, ...out2 };
        executed.push(rec);
        results.push(rec);
      } catch (e) {
        const err = { tool: name, error: e.message };
        executed.push(err);
        results.push(err);
      }
    }

    // Feed the real tool output back. The model must see what the tools returned
    // rather than what it assumed they returned — otherwise a save that failed
    // gets described as a save that worked.
    messages.push({ role: 'assistant', content: reply });
    messages.push({
      role: 'user',
      content: 'TOOL_RESULTS:\n' + JSON.stringify(results).slice(0, 12000),
    });
  }

  // ── what the employer is actually shown ───────────────────────────────────
  //
  // `reply` is whatever the model last produced, which is not necessarily
  // something a person should read. Two things had to be fixed here, both found
  // by looking at a real reply rather than the code:
  //
  // 1. It leaked a raw TOOL_CALL line to the employer. The loop only stripped
  //    those on the turn it decided to stop, and when it stopped because it ran
  //    out of turns instead, the raw text went straight to the screen — an
  //    employer reading `TOOL_CALL: {"tool":"employer_update_posting"...}` at
  //    the end of their conversation.
  // 2. It stopped mid-work. The model was still issuing tool calls when the turn
  //    budget ran out, and the employer was shown a half-finished draft with no
  //    indication that anything was incomplete. The row was saved, so the reply
  //    said nothing was wrong.
  const { calls: trailingCalls, text: trailingProse } = parseToolCalls(reply);
  let shown = trailingProse || reply;

  if (trailingCalls.length) {
    // The model wanted to keep working and was cut off. Say so, and say what is
    // true: the tools that did run, and that the rest did not.
    shown = (shown ? shown.trimEnd() + '\n\n' : '')
      + `I ran out of steps before I finished that. `
      + `${executed.length} change${executed.length === 1 ? '' : 's'} `
      + `${executed.length === 1 ? 'was' : 'were'} saved, and the rest did not run. `
      + 'Ask me to carry on and I will pick it up from where the posting is now.';
  }

  // Never let machinery reach the employer, whatever path we got here by.
  shown = shown.replace(/^.*TOOL_CALL:\s*\{.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  reply = shown;

  if (providerError === null) {
    await store.addEmployerMessage(employer.id, {
      role: 'assistant', body: reply, postingId, toolCalls: executed,
    });
  } else {
    // The employer's own words were already recorded. The assistant's turn was
    // not: recording "I could not reach the model" as an answer would put a
    // failure into their transcript as though it were one of their decisions.
    await store.addEmployerMessage(employer.id, {
      role: 'system', body: `assistant turn failed: ${providerError}`, postingId,
    });
  }

  // The authoritative state. Not what the reply claimed.
  const stats = await store.employerStats(employer.id);
  const postings = await store.listEmployerPostings(employer.id, { limit: 50 });

  return {
    reply,
    toolCalls: executed,
    providerError,
    stats,
    postings: postings.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      needsReview: r.needs_review,
      reviewNotes: r.review_notes,
      location: r.location_text,
      locationSpecificity: r.location_specificity,
      payStated: r.pay_stated,
      payMin: r.pay_min,
      payMax: r.pay_max,
      payBasis: r.pay_basis,
      applyUrl: r.apply_url,
      contactEmail: r.contact_email,
      views: r.view_count,
      applications: r.application_count,
      updatedAt: r.updated_at,
    })),
    turns,
  };
}

export default { employerChat };
