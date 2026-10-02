#!/usr/bin/env node
/**
 * fleet-firehose.mjs — Terse operational posts for Alice
 *
 * Three jobs, in priority order:
 *   1. diffAndPostServices(state, current) — single post per service status
 *      transition. "supabase: down -> up (DNS recovered)". No flood, no
 *      essays. Empty when nothing changed.
 *   2. postCycleDelta(state, current, emailStats) — at end of each cycle,
 *      a 2-line terse post ONLY when something changed since the last
 *      cycle (services, emails, errors). Otherwise silent.
 *   3. summarizeGoalStatus(goalsFile) — daily 9am goal-tender (out of
 *      scope for the foundation build; stub returns null).
 *
 * All posts are operational and terse. No opinions, no LLM in the hot
 * path. Format is fixed so it parses cleanly in fleet chat.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'relay-data');
const RELAY_URL = 'http://localhost:8080';

async function postFleetMessage(message) {
  try {
    const r = await fetch(`${RELAY_URL}/api/fleet-chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'alice-sidecar', message, channel: 'fleet' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Stable string key for one service's status. Used to diff transitions.
function serviceKey(s) {
  return `${s.service}:${s.status}`;
}

export function diffServices(prev, current) {
  if (!Array.isArray(prev) || prev.length === 0) return []; // first run: skip
  const out = [];
  const curMap = new Map(current.map(s => [s.service, s]));
  for (const c of current) {
    const p = prev.find(x => x.service === c.service);
    if (!p) continue; // new service — don't post on first sighting
    if (p.status !== c.status) {
      out.push({ service: c.service, from: p.status, to: c.status, detail: c.detail });
    }
  }
  return out;
}

export async function postServiceTransitions(transitions) {
  if (!transitions || transitions.length === 0) return { posted: 0 };
  let posted = 0;
  for (const t of transitions) {
    const arrow = t.from ? `${t.from} -> ${t.to}` : t.to;
    const msg = `Alice: ${t.service} ${arrow}${t.detail ? ' (' + t.detail.slice(0, 80) + ')' : ''}`;
    const r = await postFleetMessage(msg);
    if (r.ok) posted++;
  }
  return { posted };
}

// End-of-cycle terse post — only when something changed since the
// previous cycle. Returns true if a post was made.
export async function postCycleDelta(prevState, currentServices, emailStats) {
  if (!prevState || !prevState.lastServices) return { posted: false, reason: 'no_prev' };
  const transitions = diffServices(prevState.lastServices, currentServices);
  const prevEmail = prevState.lastEmailParse;
  const emailChanged = emailStats && (
    !prevEmail ||
    prevEmail.parsed !== emailStats.parsed ||
    prevEmail.errors !== emailStats.errors
  );

  // Build the terse line. Operational, structured, no narrative.
  const ok = currentServices.filter(s => s.status === 'ok').length;
  const total = currentServices.length;
  const bad = currentServices.filter(s => s.status !== 'ok');
  // List each service with its status so there's no ambiguity
  const serviceList = currentServices.map(s => s.service + '(' + s.status + ')').join(', ');
  const badStr = bad.length
    ? '. Issues: ' + bad.map(s => s.service + ' (' + s.status + ')').join(', ')
    : '';
  const cycle = (prevState.cycle || 0) + 1;
  const emailPart = emailStats
    ? ` | Emails: ${emailStats.parsed} parsed, ${emailStats.errors} errors`
    : '';

  // Three triggers, in priority:
  //  (a) any service transitioned — must post (transitions are signal)
  //  (b) email parse result changed — must post (parses are signal)
  //  (c) issues are still present and haven't been posted in last 3 cycles
  //      — keep the watch visible without spamming
  const hasIssues = bad.length > 0;
  const lastIssuePost = prevState.lastIssuePostCycle || 0;
  const issueStale = hasIssues && (cycle - lastIssuePost) >= 3;

  if (transitions.length === 0 && !emailChanged && !issueStale) {
    return { posted: false, reason: 'no_change' };
  }

  const msg = `Alice cycle ${cycle}: ${ok}/${total} services ok — [${serviceList}]${emailPart}${badStr}`;
  const r = await postFleetMessage(msg);
  if (r.ok) {
    return { posted: true, transitions: transitions.length, emailChanged, issueStale };
  }
  return { posted: false, reason: 'send_failed' };
}

export function shouldUpdateIssuePost(state, cycle) {
  // Marks a cycle number as "we last told the fleet about persistent issues here"
  state.lastIssuePostCycle = cycle;
}

// Stub for the daily goal-tender. Out of scope for the foundation build;
// left here so the import path is stable.
export async function postGoalTender() {
  return { posted: false, reason: 'not_implemented_foundation' };
}

// ── Ollama synthesis ──────────────────────────────────────
// Local Ollama: synthesize a 1-2 line "what's happening, what needs attention"
// digest from recent fleet memory. Operational tone, no essays, no opinions.
// Falls back to a template line if Ollama is unreachable.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-v4-flash:cloud';
const OLLAMA_TIMEOUT_MS = 25_000;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

async function ollamaGenerate(prompt) {
  // Try Ollama first
  try {
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.2, num_predict: 120, stop: ['\n\n'] },
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    const j = await r.json();
    return (j.response || '').trim();
  } catch (ollamaErr) {
    // Fallback to DeepSeek
    if (DEEPSEEK_API_KEY) {
      try {
        const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            max_tokens: 120,
          }),
          signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
        });
        if (!r.ok) throw new Error(`deepseek ${r.status}`);
        const j = await r.json();
        return (j.choices?.[0]?.message?.content || '').trim();
      } catch (deepseekErr) {
        // Fallback to OpenRouter
        if (OPENROUTER_API_KEY) {
          try {
            const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://relay.mobilemonero.com' },
              body: JSON.stringify({
                model: 'deepseek/deepseek-chat',
                messages: [{ role: 'user', content: prompt }],
                stream: false,
                max_tokens: 120,
              }),
              signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
            });
            if (!r.ok) throw new Error(`openrouter ${r.status}`);
            const j = await r.json();
            return (j.choices?.[0]?.message?.content || '').trim();
          } catch (openrouterErr) {
            throw new Error(`All providers failed: ${ollamaErr.message}; ${deepseekErr.message}; ${openrouterErr.message}`);
          }
        }
        throw new Error(`Ollama and DeepSeek failed: ${ollamaErr.message}; ${deepseekErr.message}`);
      }
    }
    throw ollamaErr;
  }
}

// Build a focused, bounded prompt. Goal: a 1-2 line terse digest
// in the same operational voice as the rest of Alice's posts.
function buildSynthPrompt(memoryRows, services, openQuestions) {
  const lines = [];
  lines.push('You are Alice, an operational sidecar reporting to the human and the fleet.');
  lines.push('Tone: terse, operational, no marketing language, no emoji, no exclamation marks.');
  lines.push('Length: 1-2 lines, <= 220 characters. No preamble, no conclusion, no labels.');
  lines.push('If there is nothing interesting to say, return: "All clear."');
  lines.push('');
  lines.push('Recent service state:');
  for (const s of services || []) {
    lines.push(`- ${s.service}: ${s.status}${s.detail ? ' (' + s.detail.slice(0, 80) + ')' : ''}`);
  }
  lines.push('');
  if (openQuestions && openQuestions.length > 0) {
    lines.push('Open questions/contradictions:');
    for (const q of openQuestions.slice(0, 3)) {
      lines.push(`- [${q.memory_type}] ${q.title} — ${q.body.slice(0, 120)}`);
    }
    lines.push('');
  }
  if (memoryRows && memoryRows.length > 0) {
    lines.push('Recent memory (last 24h, newest first):');
    for (const m of memoryRows.slice(0, 8)) {
      lines.push(`- [${m.memory_type}/${m.scope}] ${m.title} — ${m.body.slice(0, 120)}`);
    }
  }
  return lines.join('\n');
}

// Public: synthesize a digest, then post it to fleet chat.
// Returns the posted message and what ollama produced.
export async function synthesizeAndPost({ memoryRows, services, openQuestions, prefix = 'Alice digest' } = {}) {
  let message;
  try {
    const prompt = buildSynthPrompt(memoryRows, services, openQuestions);
    const out = await ollamaGenerate(prompt);
    // Sanitize: strip leading bullet/list markers, clamp length
    message = out
      .replace(/^[-*•\s]+/, '')
      .replace(/^"|"$/g, '')
      .replace(/\n.*$/s, '') // first line only
      .trim()
      .slice(0, 240);
    if (!message || message.length < 4) throw new Error('empty response');
  } catch (e) {
    // Fallback: template line so the post still goes out
    const bad = (services || []).filter(s => s.status !== 'ok');
    message = bad.length === 0
      ? 'All clear.'
      : 'Issues: ' + bad.map(s => s.service + '(' + s.status + ')').join(', ');
  }
  const fullMessage = `${prefix}: ${message}`;
  const r = await postFleetMessage(fullMessage);
  return { posted: !!r.ok, message: fullMessage, source: r.ok ? 'ollama_or_template' : 'send_failed' };
}
