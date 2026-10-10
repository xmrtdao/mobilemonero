/**
 * Office Clerk — offline-capable first responder.
 *
 * L0 (zero AI): matches the operator's message against the intent table
 * (office-clerk-intents.mjs), calls the mapped relay tool directly, and
 * formats the result as markdown.
 *
 * L1 (tiny local model): on an L0 miss, a small Ollama model (default
 * gemma3:1b — runs in ~1 GB RAM) either proposes a tool call as JSON or
 * answers briefly. Proposed tool calls are validated against a read-only
 * allowlist before execution — the model proposes, the validator disposes.
 * If the model is down, slow, or garbage, the caller gets the static
 * capability menu. The clerk never guesses.
 *
 * Mutating intents (confirm: true) require the message to start with
 * "confirm"; otherwise the clerk replies with the exact phrase to say.
 *
 * Usage:
 *   import { createClerk } from './office-clerk.mjs';
 *   const clerk = createClerk({
 *     callTool: (name, args) => toolHandlers[name](args),
 *     l1: { url: 'http://localhost:11434', model: 'gemma3:1b' },
 *   });
 *   const out = await clerk.chat('status');
 *   // → { text, provenance: 'deterministic' | 'local', intent, tool, ms }
 */

import { CLERK_INTENTS, CLERK_MISS_RESPONSE } from './office-clerk-intents.mjs';

// Tools the L1 model may propose. Deliberately read-only / UI-only: no
// restarts, no state writes, no shell. The deterministic confirm gate is
// bypassed by design only for tools that cannot mutate anything.
const L1_ALLOWED_TOOLS = new Set([
  'system-monitor', 'system-resources', 'task-stats', 'external-services',
  'mining-dashboard', 'ollama-health', 'ollama-models', 'state-get',
  'aside-push', 'aside-close',
]);

// Find the deterministic formatter that already exists for a tool so L1
// answers render exactly like L0 answers.
function formatterFor(tool) {
  const intent = CLERK_INTENTS.find(i => i.tool === tool && typeof i.format === 'function');
  return intent ? intent.format : null;
}

function extractToolCall(raw) {
  if (!raw) return null;
  // Find the first balanced {...} that parses and carries a tool name.
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(raw.slice(start, i + 1));
          if (obj && typeof obj.tool === 'string') return obj;
          return null;
        } catch { return null; }
      }
    }
  }
  return null;
}

export function createClerk({ callTool, logger = console, l1 = null }) {
  const l1Enabled = !!(l1 && (l1.url || (l1.providers && l1.providers.length)));

  // One provider = one way to get a completion. Order = preference:
  // Ollama local first (works offline), then free-tier hosted providers.
  // `accept(txt)` lets the caller reject a garbage completion (e.g. a tiny
  // model echoing the prompt's literal "<name>" placeholder) so the cascade
  // keeps trying the next model instead of giving up on L1 entirely.
  async function l1Generate(prompt, accept = null) {
    const timeoutMs = l1.timeoutMs || 60000;

    // 1) Ollama local
    if (l1.url && l1.model) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${l1.url}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: l1.model,
            prompt,
            stream: false,
            options: { temperature: 0, num_predict: 200 },
          }),
          signal: controller.signal,
        });
        if (res.ok) {
          const txt = (await res.json())?.response || '';
          if (txt.trim()) {
            if (!accept || accept(txt)) return { text: txt, via: `ollama/${l1.model}` };
            logger.warn?.(`[office-clerk] L1 ollama/${l1.model} returned unusable completion, trying next`);
          }
        }
      } catch (e) {
        logger.warn?.(`[office-clerk] L1 ollama failed:`, e?.message || e);
      } finally {
        clearTimeout(timer);
      }
    }

    // 2) OpenAI-compatible hosted providers (OpenCode Zen, OpenRouter free)
    for (const p of (l1.providers || [])) {
      if (!p.baseUrl || !p.key) continue;
      for (const model of (p.models || [])) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${p.key}` },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0,
              max_tokens: 200,
            }),
            signal: controller.signal,
          });
          if (!res.ok) {
            logger.warn?.(`[office-clerk] L1 ${p.name}/${model} HTTP ${res.status}, trying next`);
            continue;
          }
          const txt = (await res.json())?.choices?.[0]?.message?.content || '';
          if (txt.trim()) {
            if (!accept || accept(txt)) return { text: txt, via: `${p.name}/${model}` };
            logger.warn?.(`[office-clerk] L1 ${p.name}/${model} returned unusable completion, trying next`);
          } else {
            logger.warn?.(`[office-clerk] L1 ${p.name}/${model} returned empty completion, trying next`);
          }
        } catch (e) {
          logger.warn?.(`[office-clerk] L1 ${p.name}/${model} failed:`, e?.message || e);
        } finally {
          clearTimeout(timer);
        }
      }
    }
    return null;
  }

  async function l1Answer(text) {
    const toolMenu = CLERK_INTENTS
      .filter(i => i.tool && L1_ALLOWED_TOOLS.has(i.tool))
      .map(i => `- ${i.tool} (for: ${i.id})`)
      .join('\n');
    const exampleTool = CLERK_INTENTS.find(i => i.tool && L1_ALLOWED_TOOLS.has(i.tool))?.tool || 'system-monitor';
    const prompt = [
      'You are the Office Clerk of a local operations dashboard, running fully offline.',
      `If the request maps to one of these tools, reply with ONLY a JSON object naming that exact tool, for example: {"tool": "${exampleTool}", "args": {}}.`,
      'Available tools:',
      toolMenu,
      'Otherwise answer the question directly in at most 3 short sentences. If you do not know, say so.',
      'Never invent numbers. Never claim live data you did not fetch with a tool.',
      '',
      `Request: ${text}`,
      'Reply:',
    ].join('\n');

    // Reject completions that propose a tool outside the allowlist (tiny
    // models love echoing the prompt's literal "<name>" placeholder) so the
    // provider cascade keeps trying instead of failing L1 outright.
    const accept = (txt) => {
      const c = extractToolCall(txt);
      return !c || L1_ALLOWED_TOOLS.has(c.tool);
    };
    const out = await l1Generate(prompt, accept);
    if (!out) return null;
    const raw = out.text;
    const viaModel = out.via;

    const call = extractToolCall(raw);
    if (call) {
      if (!L1_ALLOWED_TOOLS.has(call.tool)) {
        logger.warn?.(`[office-clerk] L1 proposed disallowed tool: ${call.tool}`);
        return null;
      }
      const result = await callTool(call.tool, call.args && typeof call.args === 'object' ? call.args : {});
      const fmt = formatterFor(call.tool);
      const body = fmt ? fmt(result) : '```json\n' + JSON.stringify(result, null, 1).slice(0, 800) + '\n```';
      return { text: body, tool: call.tool, viaModel };
    }

    const plain = raw.trim();
    if (!plain) return null;
    return { text: plain.slice(0, 1200), tool: null, viaModel };
  }

  async function chat(message, opts = {}) {
    const text = String(message || '').trim();
    if (!text) return { text: 'Say something — `help` lists what I can do.', provenance: 'deterministic', intent: null };

    const started = Date.now();
    for (const intent of CLERK_INTENTS) {
      let m = null;
      for (const re of intent.patterns) {
        m = text.match(re);
        if (m) break;
      }
      if (!m) continue;

      // Static reply intents (help)
      if (!intent.tool) {
        return { text: intent.format(null), provenance: 'deterministic', intent: intent.id, tool: null, ms: Date.now() - started };
      }

      // Confirmation gate for mutating intents
      if (intent.confirm && !/^confirm\b/i.test(text)) {
        return {
          text: `⚠️ That mutates a running service. Say \`confirm ${text}\` and I'll do it.`,
          provenance: 'deterministic', intent: intent.id, tool: intent.tool, needsConfirm: true, ms: Date.now() - started,
        };
      }

      // Execute the tool
      const args = intent.args ? intent.args(m) : {};
      try {
        const result = await callTool(intent.tool, args);
        return {
          text: intent.format(result),
          provenance: 'deterministic',
          intent: intent.id,
          tool: intent.tool,
          ms: Date.now() - started,
        };
      } catch (err) {
        logger.warn?.(`[office-clerk] tool ${intent.tool} failed:`, err?.message || err);
        return {
          text: `⚠️ The \`${intent.tool}\` workflow failed: ${err?.message || err}`,
          provenance: 'deterministic',
          intent: intent.id,
          tool: intent.tool,
          error: String(err?.message || err),
          ms: Date.now() - started,
        };
      }
    }

    // L0 miss → L1 tiny local model (if configured and not disabled by caller)
    if (l1Enabled && opts.l1 !== false) {
      try {
        const out = await l1Answer(text);
        if (out) {
          return {
            text: out.text,
            provenance: 'local',
            intent: null,
            tool: out.tool,
            model: out.viaModel,
            ms: Date.now() - started,
          };
        }
      } catch (err) {
        logger.warn?.(`[office-clerk] L1 failed:`, err?.message || err);
      }
    }

    return { text: CLERK_MISS_RESPONSE, provenance: 'deterministic', intent: null, miss: true, ms: Date.now() - started };
  }

  return { chat };
}
