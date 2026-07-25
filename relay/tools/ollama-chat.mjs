/**
 * relay/tools/ollama-chat.mjs — Local LLM chat via Ollama with cloud fallback chain
 *
 * Primary:   Ollama Pro Cloud (api.ollama.com/v1/chat/completions) via
 *            OLLAMA_API_KEY or OLLAMA_XMRT_API_KEY
 * Fallback:  OpenRouter (openrouter.ai/api/v1/chat/completions) via
 *            OPENROUTER_API_KEY with minimax-m3 model
 *
 * Tracks which agent/source made each request for token-usage logging.
 */

const OLLAMA_HOST       = process.env.OLLAMA_HOST       || 'http://localhost:11434';
const DEFAULT_MODEL     = process.env.OLLAMA_MODEL       || 'deepseek-v4-flash:cloud';
const OLLAMA_API_KEY    = process.env.OLLAMA_API_KEY    || '';
const OLLAMA_XMRT_KEY   = process.env.OLLAMA_XMRT_API_KEY || '';
// OPENROUTER_API_KEY is read lazily to avoid a module-load-order bug:
// server.js imports ollama-chat.mjs BEFORE calling loadEnv(), so env
// vars set in relay/.env are not yet available at import time.
function getOpenRouterKey() {
  return process.env.OPENROUTER_API_KEY || '';
}

// ASCII emoticons that small LLMs emit as chatty sign-offs.
const EMOJI_SIGNOFFS = ['o7', 'O7', '👋', '😊', '🎉', '✨', '👍', '🙏', '😄', '😁'];
const EMOJI_SIGNOFF_RE = new RegExp(
  '(?:\\s*(?:' + EMOJI_SIGNOFFS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + '))+\\s*$',
);

function stripEmojiSignOff(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(EMOJI_SIGNOFF_RE, '').replace(/\s+$/, '');
}

// ── Token usage tracking ────────────────────────────────────
async function logTokenUsage(agent, source, model, promptTokens, outputTokens, costUsd) {
  try {
    const port = process.env.RELAY_PORT || process.env.PORT || 8080;
    await fetch(`http://127.0.0.1:${port}/api/token-usage/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: agent || 'unknown',
        source: source || 'ollama',
        model: model || DEFAULT_MODEL,
        prompt_tokens: promptTokens || 0,
        completion_tokens: outputTokens || 0,
        cost_usd: costUsd || 0,
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Non-fatal — token usage logging is best-effort
  }
}

// ── Provider functions ─────────────────────────────────────

/** Try local Ollama instance */
async function tryOllamaLocal(payload, signal) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Convert Ollama-style messages (with images: [base64] on the user msg)
 * to OpenAI-compatible format (content: [{type:'text'}, {type:'image_url',...}]).
 * The Ollama local API uses the `images` field; OpenAI/OpenRouter/Ollama Cloud
 * use the content-array format with data URLs.
 */
function imagesToOpenAI(messages) {
  return messages.map(msg => {
    if (!msg.images || msg.images.length === 0) return msg;
    const imgContent = msg.images.map(b64 => ({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${b64}` },
    }));
    const textContent = msg.content
      ? [{ type: 'text', text: msg.content }]
      : [];
    return {
      role: msg.role,
      content: [...textContent, ...imgContent],
    };
  });
}

/** Try Ollama Pro Cloud (api.ollama.com) with a specific model */
async function tryOllamaCloud(messages, model, signal) {
  const key = OLLAMA_API_KEY || OLLAMA_XMRT_KEY;
  if (!key) throw new Error('No OLLAMA_API_KEY or OLLAMA_XMRT_API_KEY configured');
  const res = await fetch('https://api.ollama.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: model.replace(':cloud', ''),   // e.g. minimax-m3 or deepseek-v4-flash
      messages: imagesToOpenAI(messages),
      stream: false,
      max_tokens: 4096,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama Cloud HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Try OpenRouter with deepseek-v4-flash as fallback */
async function tryOpenRouter(messages, signal) {
  const key = getOpenRouterKey();
  if (!key) throw new Error('No OPENROUTER_API_KEY configured');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://relay.mobilemonero.com',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: imagesToOpenAI(messages),
      stream: false,
      max_tokens: 4096,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function normalizeResponse(data, model, provider) {
  // Ollama /api/generate format (raw response string)
  if (data.response && typeof data.response === 'string') {
    const promptTokens = data.prompt_eval_count || 0;
    const outputTokens = data.eval_count || 0;
    const costUsd = (promptTokens * 0.15 + outputTokens * 0.60) / 1_000_000;
    return {
      response: stripEmojiSignOff(data.response),
      model: data.model || model,
      provider: provider || 'ollama-local',
      done: data.done || false,
      evalCount: outputTokens,
      promptEvalCount: promptTokens,
      costUsd: parseFloat(costUsd.toFixed(8)),
    };
  }
  // Ollama /api/chat local format (message object)
  if (data.message?.content) {
    const content = data.message.content || data.message.thinking || '';
    const promptTokens = data.prompt_eval_count || 0;
    const outputTokens = data.eval_count || 0;
    const costUsd = (promptTokens * 0.15 + outputTokens * 0.60) / 1_000_000;
    return {
      response: stripEmojiSignOff(content),
      model: data.model || model,
      provider: provider || 'ollama-local',
      done: data.done || false,
      evalCount: outputTokens,
      promptEvalCount: promptTokens,
      costUsd: parseFloat(costUsd.toFixed(8)),
    };
  }
  // OpenAI-compatible format (Ollama Cloud, OpenRouter)
  if (data.choices?.[0]?.message) {
    const msg = data.choices[0].message;
    const content = msg.content || msg.reasoning || '';
    if (!content) throw new Error('Empty content and reasoning from provider');
    const usage = data.usage || {};
    const promptTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;
    const costUsd = (promptTokens * 0.15 + outputTokens * 0.60) / 1_000_000;
    return {
      response: stripEmojiSignOff(content),
      model: data.model || model,
      provider: provider,
      done: true,
      evalCount: outputTokens,
      promptEvalCount: promptTokens,
      costUsd: parseFloat(costUsd.toFixed(8)),
    };
  }
  throw new Error('Unrecognized response format');
}

/**
 * Send a chat message with fallback chain:
 *   Ollama Pro Cloud → OpenRouter (minimax-m3) → Ollama Local
 *
 * @param {string} message
 * @param {object} options
 * @param {string} options.agent    — Agent name making the request
 * @param {string} options.source   — Source of the request
 * @param {string} options.model    — Override model
 * @param {string} options.system   — Override system prompt
 * @param {number} options.temperature
 * @param {number} options.maxTokens
 * @param {number} options.timeout
 * @param {boolean} options.stream
 */
export async function ollamaChat(message, options = {}) {
  const {
    agent = 'eliza-dev',
    source = 'relay',
    model = DEFAULT_MODEL,
    tools = [],
    images = [],          // base64-encoded image data (no data URL prefix)
    system = 'You are Eliza-Dev, a helpful AI assistant for the XMRT DAO ecosystem.\n\n' +
      'Tone rules:\n' +
      '- Be concise, technical, and to the point. No marketing fluff.\n' +
      '- Do not end with emoji-only sign-offs (no "👋", "😊", "🎉", "✨" alone or as the last token).\n' +
      '- Do not emit the "o7" salute emoticon or similar ASCII emoticons as closings.\n' +
      '- If a sign-off is appropriate, use plain English: "—Eliza", "Let me know if you need more.", or simply end with the answer.\n' +
      '- Reply with a direct, user-facing answer. Do NOT narrate your own reasoning or analysis.',
    temperature = 0.7,
    maxTokens = 4096,
    timeout = 60000,
    stream = false,
  } = options;

  if (!message) {
    return { error: 'Message is required' };
  }

  const userMsg = { role: 'user', content: message };
  if (images.length > 0) userMsg.images = images;

  const messages = [
    { role: 'system', content: system },
    userMsg,
  ];

  const ollamaPayload = {
    model,
    messages,
    options: { temperature, num_predict: maxTokens },
    stream,
  };
  if (tools && tools.length > 0) {
    ollamaPayload.tools = tools;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const errors = [];
  let result = null;

  // ── 1) Try Ollama Pro Cloud (primary) ─────────────────────
  if (OLLAMA_API_KEY || OLLAMA_XMRT_KEY) {
    try {
      const data = await tryOllamaCloud(messages, model, controller.signal);
      result = normalizeResponse(data, model, 'ollama-cloud');
    } catch (err) {
      errors.push(`OllamaCloud: ${err.message}`);
    }
  }

  // ── 2) Fallback: OpenRouter with minimax-m3 ──────────────────
  if (!result && getOpenRouterKey()) {
    try {
      const data = await tryOpenRouter(messages, controller.signal);
      result = normalizeResponse(data, 'minimax/minimax-m3', 'openrouter');
    } catch (err) {
      errors.push(`OpenRouter: ${err.message}`);
    }
  }

  // ── 3) No local fallback ─────────────────────────────────────
    // This machine has no local models (6GB RAM, no room for inference).
    // Cloud models (Ollama Cloud + OpenRouter) are the only pipeline.
    // If both fail, surface the errors immediately.
    clearTimeout(timer);
    if (!result) {
      return { error: `All cloud providers failed: ${errors.join('; ')}` };
    }

    // Log token usage with agent/source attribution
  await logTokenUsage(agent, source, result.model, result.promptEvalCount, result.evalCount, result.costUsd);

  return result;
}

/**
 * List available models from local Ollama
 */
export async function listModels() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      models: (data.models || []).map(m => ({
        name: m.name,
        size: m.size,
        modifiedAt: m.modified_at,
      })),
    };
  } catch (err) {
    return { error: `Failed to list models: ${err.message}` };
  }
}

/**
 * Check if local Ollama is running
 */
export async function checkOllamaHealth() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      return {
        status: 'ok',
        models: (data.models || []).map(m => m.name),
        host: OLLAMA_HOST,
      };
    }
    return { status: 'error', message: `HTTP ${res.status}` };
  } catch (err) {
    return { status: 'unreachable', message: err.message, host: OLLAMA_HOST };
  }
}

/**
 * Generate text with fallback chain — same architecture as ollamaChat
 * but uses /api/generate format (prompt string instead of messages array)
 * for direct agent personas.
 */
export async function ollamaGenerate(prompt, options = {}) {
  const {
    model = DEFAULT_MODEL,
    temperature = 0.5,
    maxTokens = 4096,
    timeout = 15000,
  } = options;

  if (!prompt) return { error: 'Prompt is required' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const errors = [];
  let result = null;

  // ── 1) Try Ollama Pro Cloud via /api/chat with system prompt converted ──
  if (OLLAMA_API_KEY || OLLAMA_XMRT_KEY) {
    try {
      const messages = [
        { role: 'system', content: 'You are an AI agent. Be concise, helpful, and do not use emoji sign-offs.' },
        { role: 'user', content: prompt },
      ];
      const data = await tryOllamaCloud(messages, model, controller.signal);
      result = normalizeResponse(data, model, 'ollama-cloud');
    } catch (err) {
      errors.push(`OllamaCloud: ${err.message}`);
    }
  }

  // ── 2) Fallback: OpenRouter with minimax-m3 ──────────────────
  if (!result && getOpenRouterKey()) {
    try {
      const messages = [
        { role: 'system', content: 'You are an AI agent. Be concise, helpful, and do not use emoji sign-offs.' },
        { role: 'user', content: prompt },
      ];
      const data = await tryOpenRouter(messages, controller.signal);
      result = normalizeResponse(data, 'minimax/minimax-m3', 'openrouter');
    } catch (err) {
      errors.push(`OpenRouter: ${err.message}`);
    }
  }

  // ── 3) Local Ollama /api/generate ────────────────────────────
  if (!result) {
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: { temperature, num_predict: maxTokens },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      result = normalizeResponse(data, model, 'ollama-local');
    } catch (err) {
      errors.push(`OllamaLocal: ${err.message}`);
    }
  }

  // ── 4) True last resort: fallback to a real local model ──
  if (!result) {
    const fallbackModels = ['mistral-small3.2:latest', 'llama3-chatqa:latest', 'gemma3:1b', 'deepseek-r1:latest'];
    for (const fallbackModel of fallbackModels) {
      try {
        const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: fallbackModel,
            prompt,
            stream: false,
            options: { temperature, num_predict: maxTokens },
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        result = normalizeResponse(data, fallbackModel, 'ollama-local');
        break;
      } catch (err) {
        errors.push(`OllamaLocal(${fallbackModel}): ${err.message}`);
      }
    }
  }

  clearTimeout(timer);
  if (!result) return { error: `All providers failed: ${errors.join('; ')}` };
  return result;
}

export default { ollamaChat, ollamaGenerate, listModels, checkOllamaHealth };
