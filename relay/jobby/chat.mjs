/**
 * relay/jobby/chat.mjs — Jobby's conversation loop
 *
 * Bounded tool loop: the model may call tools for a few turns, then must
 * answer. Same shape as Eliza's, because the failure mode is the same — a small
 * model will happily call tools forever and never reply, and a raw tool error
 * will otherwise become the user-facing answer.
 */

import { buildSystemPrompt, RAILS } from './persona.mjs';
import { createJobbyTools } from './tools.mjs';
import * as store from './store.mjs';
import { applyEdits, describeAudit, parseEditRequest, newBatchId } from './dossier.mjs';
import { mergeDossiers } from './dossier-merge.mjs';
import { parseUserEditIntent, looksLikeEditRequest, describeOutcome } from './edit-intent.mjs';

const MAX_TOOL_TURNS = 4;
const MAX_TOOL_ROUNDS = 6;

/** Parse `TOOL_CALL: {...}` lines. Returns [{tool, args}] and the text without them. */
export function parseToolCalls(reply) {
  const calls = [];
  const kept = [];
  for (const raw of String(reply || '').split('\n')) {
    let line = raw.trim().replace(/^`{1,3}\s*/, '').replace(/\s*`{1,3}$/, '');
    line = line.replace(/^\*\*|\*\*$/g, '').replace(/^\*|\*$/g, '').trim();
    const m = line.match(/^TOOL_CALL:\s*(\{.*\})$/);
    if (m) {
      try { calls.push(JSON.parse(m[1])); continue; } catch { /* fall through to text */ }
    }
    kept.push(raw);
  }
  return { calls, text: kept.join('\n').trim() };
}

/**
 * Does this reply leak machinery to the user instead of talking to them?
 *
 * This used to be far broader: any reply *starting* with "error", "failed",
 * "exception" or "traceback" was discarded and replaced with a canned apology.
 * In a live session that swallowed the answer to a direct question. The user
 * asked why a field was rejected, and the model opened with "Error -", which
 * matched, so the explanation was thrown away and replaced with "Something went
 * sideways on my end there and I would rather not guess."
 *
 * So the test is now structural rather than lexical. Ordinary English prose
 * that happens to start with a word like "failed" is exactly what a candid
 * answer sounds like, and it must pass. What actually must not reach the user
 * is a bare machine artefact: a whole message that is nothing but JSON, a
 * TOOL_CALL line, or a stack trace with no sentence in it.
 */
export function looksLikeToolEcho(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (!t) return true;
  if (/^TOOL_CALL:/m.test(t) && t.replace(/^TOOL_CALL:.*$/gm, '').trim().length < 40) return true;
  // A whole message that is one JSON value, and nothing else.
  if (/^\{[\s\S]*\}$/.test(t) && /"(path|op|tool|error|ok|result)"\s*:/.test(t)) return true;
  if (/^\[[\s\S]*\]$/.test(t) && /"(path|op|tool|error|result)"\s*:/.test(t)) return true;
  // A stack trace with no sentence anywhere in it.
  if (/(?:Traceback \(most recent call last\)|\n\s+at [\w.$]+ \(|Error:\s*[\w.]+\n\s+at )/.test(t)
      && !/[.!?]\s+\S/.test(t.replace(/(?:Traceback.*|\n\s+at .*)/g, ''))) return true;
  return false;
}

/**
 * The replacement text for a reply that was pure machinery.
 *
 * Says what was attempted and that nothing was changed, rather than inventing a
 * mood. Kept short so the next turn has room to recover.
 */
export function toolEchoNotice(attempted) {
  const what = attempted?.length
    ? ` I tried to run ${attempted.join(', ')}, but the response came back as raw data rather than an answer.`
    : '';
  return `I did not get a usable answer out of that one.${what} Nothing was changed. `
    + 'Ask me again and I will take another run at it.';
}

function sanitiseForPrompt(value, depth = 0) {
  if (depth > 3) return '[deep]';
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 1200);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => sanitiseForPrompt(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 30)) out[k] = sanitiseForPrompt(v, depth + 1);
    return out;
  }
  return null;
}

/**
 * One turn of conversation.
 *
 * @param clientId
 * @param userMessage
 * @param deps.llmChat  { chat(messages, opts) -> {content, provider}, search(q) -> [] }
 * @param deps.deliver  optional mail transport
 */
export async function chat(clientId, userMessage, deps = {}) {
  const { llmChat, deliver } = deps;
  if (!llmChat?.chat) throw new Error('chat requires an llmChat dependency');
  const text = String(userMessage ?? '').trim();
  if (!text) return { error: 'message is required' };
  if (text.length > 8000) return { error: 'message is too long (8000 characters max)' };

  const ctx0 = await store.loadContext(clientId);
  if (!ctx0.client) return { error: 'unknown client' };

  const tools = createJobbyTools({ llmChat });
  // preferGmail is decided by the caller from the client's connection state: it
  // is what makes outreach land in the candidate's own inbox.
  const ctx = { clientId, userMessage: text, deliver, preferGmail: deps.preferGmail !== false };

  await store.appendMessage(clientId, 'user', text);

  // ── The user's own words are applied before the model is involved ──────────
  //
  // This is the fix for a real failure. A user said "update my phone number to
  // X", Jobby replied that it had added it, and the dossier still said the phone
  // number was missing. The model had claimed a change nobody made.
  //
  // The cause was structural. Every route from a plain request to a written
  // dossier went through the model emitting a TOOL_CALL line and embedding JSON
  // in its reply, and that whole branch sat behind `if (!calls.length) break`.
  // Asked something conversational, a model answers in prose, takes the early
  // exit, and its own sentence becomes the record. Nothing failed, so nothing
  // reported that nothing had happened.
  //
  // So the sentence is read here, deterministically, and written before the
  // model runs. The model still handles anything structural - employment history,
  // skills, reorganisation - because that genuinely needs understanding. It just
  // is not the only route to recording a phone number.
  const intent = parseUserEditIntent(text);
  const appliedEdits = [];
  const failedEdits = [];
  let dossierForPrompt = ctx0.dossier;
  if (intent.edits.length) {
    const stamped = intent.edits.map(e => ({
      ...e,
      // The user said it in this turn, so it is confirmed. This is read from
      // their message, not taken from anything the model asserted.
      confirmedByUser: true,
      actor: 'jobby',
      batchId: newBatchId(),
    }));
    const current = await store.getDossier(clientId);
    const res = applyEdits(current?.dossier ?? {}, stamped);
    if (res.ok) {
      try {
        await store.saveDossier(clientId, res.dossier, {
          updatedBy: 'jobby', audits: res.audits,
        });
        appliedEdits.push(...res.audits);
        // The prompt is built from this, so the model is not told the phone
        // number is missing in the same turn it was just given one.
        dossierForPrompt = res.dossier;
      } catch (e) {
        failedEdits.push(...stamped.map(x => `${x.path}: ${e.message}`));
        console.error('[jobby] failed to save a stated change:', e.message);
      }
    } else {
      failedEdits.push(...stamped.map(x => `${x.path}: ${res.error}`));
    }
  }

  const priorTurns = await store.history(clientId, 12);
  const systemPrompt = buildSystemPrompt({
    client: ctx0.client,
    dossier: dossierForPrompt,
    plan: ctx0.plan,
    tracks: ctx0.client.tracks,
    recentOutreach: ctx0.outreach,
  });

  const messages = [
    { role: 'system', content: systemPrompt },
    ...priorTurns.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: text },
  ];

  const executed = [];
  // The changes taken straight from the user's message, recorded as executed
  // before the model is consulted. They are facts, not intentions, and the reply
  // is reconciled against them below.
  for (const audit of appliedEdits) {
    executed.push({ tool: 'jobby_update_dossier', ...describeAudit(audit) });
  }
  let reply = '';
  let turns = 0;

  while (turns < MAX_TOOL_TURNS) {
    turns++;
    let out;
    try {
      out = await llmChat.chat(messages, { agent: 'jobby', maxTokens: 1200 });
    } catch (e) {
      // A provider outage is not the user's problem to debug. Say so plainly
      // rather than surfacing a stack trace or an empty reply.
      reply = `I could not reach the model just now — ${String(e.message || e).slice(0, 160)}. ` +
        'Nothing was changed. Try again in a moment.';
      break;
    }
    // Accept either shape: adapters differ on whether the normalised field is
    // called `content` or `response`.
    reply = out?.content ?? out?.response ?? '';
    const { calls, text: prose } = parseToolCalls(reply);

    // The model's own inline JSON is read whether or not it also emitted a tool
    // call. This used to sit below `if (!calls.length) break`, so a reply with no
    // tool call skipped it entirely - and since a prose answer is exactly what a
    // model gives when asked something conversational, the one case that most
    // needed it was the one that could not reach it.
    const inline = parseEditRequest(prose);
    if (inline.ok && inline.edits.length) {
      const stamped = inline.edits.map(e => ({
        ...e,
        confirmedByUser: /my|i'?m|i am|it'?s|use|set|change|correct|actually/i.test(text),
        actor: 'jobby', batchId: newBatchId(),
      }));
      const current = await store.getDossier(clientId);
      const res = applyEdits(current?.dossier ?? {}, stamped);
      if (res.ok) {
        await store.saveDossier(clientId, res.dossier, { updatedBy: 'jobby', audits: res.audits });
        executed.push(...res.audits.map(a => ({ tool: 'jobby_update_dossier', ...describeAudit(a) })));
      } else {
        executed.push({ tool: 'jobby_update_dossier', error: res.error });
      }
    }

    if (!calls.length) { reply = prose; break; }

    // Apply dossier edits the model asked for directly from its message. Kept as
    // a second route: the user's own words are handled above, but a model can
    // still propose a structured change the phrasing rules do not cover.
    const results = [];
    for (const call of calls.slice(0, MAX_TOOL_ROUNDS)) {
      const name = String(call.tool || '').replace(/^jobby[.:]/, 'jobby_');
      const handler = tools[name];
      if (!handler) {
        results.push(`Tool "${call.tool}" does not exist. Available: ${Object.keys(tools).join(', ')}`);
        executed.push({ tool: call.tool, error: 'unknown tool' });
        continue;
      }
      try {
        const res = await handler(call.args || {}, ctx);
        executed.push({ tool: name, args: call.args, result: sanitiseForPrompt(res) });
        results.push(`${name} -> ${JSON.stringify(sanitiseForPrompt(res))}`);
      } catch (e) {
        executed.push({ tool: name, error: String(e.message || e) });
        results.push(`${name} -> ERROR: ${String(e.message || e)}`);
      }
    }

    messages.push({ role: 'assistant', content: reply });
    messages.push({
      role: 'user',
      content: `Tool results:\n${results.join('\n')}\n\nNow reply to the user in your own voice. Say what you actually did. Do not output another TOOL_CALL line.`,
    });
  }

  if (turns >= MAX_TOOL_TURNS && /TOOL_CALL:/.test(reply)) {
    reply = reply.replace(/TOOL_CALL:.*$/gm, '').trim() +
      '\n\n(I stopped there — that is as far as I will go in one go. Say the word and I will continue.)';
  }
  if (looksLikeToolEcho(reply)) {
    reply = toolEchoNotice(executed.map(e => e.tool));
  }
  if (!reply.trim()) {
    reply = 'I did not get a usable answer out of that one. Try asking me again in a different way.';
  }
  // A tool that failed is the most useful thing in the turn. If the model's own
  // wording does not mention the failure, say so plainly rather than letting a
  // cheerful reply imply the work landed. A user who was told an edit was
  // rejected must not have to guess whether it was retried and succeeded.
  const failed = executed.filter(e => e.error || e.result?.error);
  if (failed.length) {
    const detail = failed
      .map(e => `${e.tool}: ${String(e.error || e.result.error).slice(0, 220)}`)
      .join(' | ');
    reply += `\n\n(That did not go through — ${detail} Nothing was written on that step.)`;
  }

  // ── The reply is reconciled against what was actually written ──────────────
  //
  // Everything above the model is a fact; the reply is the model's own sentence,
  // and a model asked "update my phone number" will cheerfully say "Done, I've
  // added it" whether or not anything was written. That is exactly the failure
  // reported: a change claimed, and not made.
  //
  // So when the user's message was about changing the dossier and nothing was
  // written, the reply says so in plain words. The model's sentence is left in
  // place - it may be perfectly accurate about something else - but it is no
  // longer the last word on whether the change happened.
  const wroteSomething = executed.some(e => e.tool === 'jobby_update_dossier' && !e.error);
  if (!wroteSomething && (looksLikeEditRequest(text) || intent.edits.length || intent.unmatched.length)) {
    reply += '\n\n(' + describeOutcome(appliedEdits, failedEdits, intent.unmatched) + ')';
  } else if (appliedEdits.length) {
    reply += '\n\n(' + describeOutcome(appliedEdits, failedEdits, intent.unmatched) + ')';
  }

  await store.appendMessage(clientId, 'jobby', reply, executed);

  const gate = await store.canSend(clientId);
  return {
    reply,
    toolCalls: executed,
    turns,
    client: {
      id: clientId,
      tracks: ctx0.client.tracks,
      missionState: ctx0.client.mission_state,
      killSwitch: ctx0.client.kill_switch,
      autonomy: ctx0.client.autonomy,
      sending: gate,
    },
  };
}

/**
 * The post-parse handoff: persist a freshly parsed dossier, decide the tracks,
 * and build the plan. Called by the resume server the moment a dossier is ready.
 */
export async function onboardFromDossier(clientId, dossier, { sourceFilename = null } = {}) {
  const client = await store.getClient(clientId);
  if (!client) return { error: 'unknown client' };

  // A second resume augments the dossier rather than replacing it. People keep
  // several resumes aimed at different work, and this used to call saveDossier()
  // with the whole parsed object, so uploading a narrow sales CV over a broad one
  // silently deleted the roles, skills and links the broad one had established.
  const existing = await store.getDossier(clientId);
  const { dossier: merged, changes, stats } = mergeDossiers(existing?.dossier ?? null, dossier);

  const revision = await store.saveDossier(clientId, merged, {
    updatedBy: 'resume-parse', sourceFilename,
    audits: [{
      op: 'merge', path: '(dossier)', before_value: existing?.dossier ?? null, after_value: merged,
      reason: existing?.dossier
        ? `merged a second resume (${sourceFilename || 'unnamed'}) into the dossier on file`
        : 'parsed from the uploaded resume',
      actor: 'resume-parse', confirmedByUser: false,
      changes,
    }],
  });

  const { decideTracks } = await import('./tracks.mjs');
  const { buildPlan, planSummary } = await import('./plan.mjs');
  const decision = decideTracks(dossier, { userOverride: client.tracks?.length ? client.tracks : null });
  const plan = buildPlan(dossier, { tracks: decision.tracks });
  const actions = await store.replaceActions(clientId, plan.actions);
  await store.updateClient(clientId, {
    tracks: decision.tracks,
    track_reasons: decision.reasons,
    display_name: client.display_name || dossier.name || client.display_name,
  });

  return {
    ok: true,
    revision,
    tracks: decision.tracks,
    trackReasons: decision.reasons,
    signals: decision.signals,
    sellsServices: decision.sellsServices,
    actions: actions.length,
    summary: planSummary(plan, dossier),
  };
}

export { RAILS };
