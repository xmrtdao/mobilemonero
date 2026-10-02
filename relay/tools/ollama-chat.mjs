/**
 * relay/tools/ollama-chat.mjs — Local LLM chat via Ollama with cloud fallback chain
 *
 * Primary:   Ollama Pro Cloud (api.ollama.com/v1/chat/completions) via
 *            OLLAMA_API_KEY or OLLAMA_XMRT_API_KEY or OLLAMA_3RD_API_KEY
 * Fallback:  OpenRouter (openrouter.ai/api/v1/chat/completions) via
 *            OPENROUTER_API_KEY with minimax-m3 model (vision) or
 *            nvidia/nemotron-3.5-lightning:free (text-only, longer rate limits)
 *
 * Cascade order:
 *   1) OpenCode Zen (opencode.ai/zen/v1) via OPENCODE_API_KEY — space-bunny-free.
 *      First tier because the Ollama Cloud and OpenRouter free tiers get
 *      rate-limited together and take the whole fleet offline together; Zen
 *      bills against a separate quota pool.
 *   2) Ollama Pro Cloud — gemma4:31b on each of 3 keys (primary daily driver)
 *   3) Ollama Pro Cloud — gpt-oss:120b, gpt-oss:20b, nemotron-3-nano:30b,
 *      nemotron-3-super, nemotron-3-ultra — each on each of the 3 keys
 *   4) OpenRouter — minimax/minimax-m3:free (vision-only; text goes to nemotron-3.5-lightning)
 *   5) OpenRouter — nvidia/nemotron-3.5-lightning:free (text-only daily driver, longer rate limits)
 *
 * Tracks which agent/source made each request for token-usage logging.
 */

const OLLAMA_HOST       = process.env.OLLAMA_HOST       || 'http://localhost:11434';
const DEFAULT_MODEL     = process.env.OLLAMA_MODEL       || 'minimax/minimax-m3:free';
// All API keys are read lazily to avoid a module-load-order bug:
// server.js imports ollama-chat.mjs BEFORE calling loadEnv(), so env
// vars set in relay/.env are not yet available at import time.
function getOllamaKey()    { return process.env.OLLAMA_API_KEY    || ''; }
function getOllamaXmrtKey() { return process.env.OLLAMA_XMRT_API_KEY || ''; }
function getOllama3rdKey() { return process.env.OLLAMA_3RD_API_KEY  || ''; }
function getOpenRouterKey() { return process.env.OPENROUTER_API_KEY || ''; }
function getOpenCodeKey()   { return process.env.OPENCODE_API_KEY   || ''; }
function getOpenCodeBase()  { return process.env.OPENCODE_BASE_URL  || 'https://opencode.ai/zen/v1'; }

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
async function logTokenUsage(agent, source, provider, model, promptTokens, outputTokens, costUsd) {
  try {
    const port = process.env.RELAY_PORT || process.env.PORT || 8080;
    await fetch("http://127.0.0.1:" + port + "/api/token-usage/log", {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'xmrt-dao',
        agent: agent || 'unknown',
        model: model || DEFAULT_MODEL,
        // The real upstream that served the request. This used to be the
        // `source` label, which made every row read "relay" and left the
        // cascade unobservable — you could not tell which provider answered.
        provider: provider || 'unknown',
        source: source || 'relay',
        input_tokens: promptTokens || 0,
        output_tokens: outputTokens || 0,
        estimated_cost_usd: costUsd || 0,
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Non-fatal — token usage logging is best-effort
  }
}

// ── Provider cascade configuration ─────────────────────────────────────
// Model priority order for the fallback chain:
// 1) Ollama Pro Cloud — each of the free models below, tried on each of the 3 keys
//    (gemma4:31b first as primary daily driver, then gpt-oss / nemotron-3 chain)
// 2) OpenRouter — minimax/minimax-m3:free (vision-only; text goes to nemotron-3.5-lightning)
// 3) OpenRouter — nvidia/nemotron-3.5-lightning:free (text-only daily driver, longer rate limits)

// Ollama Pro Cloud free-model cascade — every model is attempted on every key
// (primary → xmrt → 3rd) before the chain falls through to the next model.
const CLOUD_FALLBACK_MODELS = [
  'gemma4:31b',          // primary daily driver
  'gpt-oss:120b',
  'gpt-oss:20b',
  'nemotron-3-nano:30b',
  'nemotron-3-super',
  'nemotron-3-ultra',
];

// OpenRouter-only models (suffix '/' or ':free') skip Ollama Cloud entirely — it 404s.
function isOpenRouterOnly(model) {
  return typeof model === 'string' && (model.includes('/') || model.endsWith(':free'));
}

/** Try Ollama Pro Cloud cascade:
 *  The requested model goes first (if cloud-eligible), then the CLOUD_FALLBACK_MODELS
 *  chain. Each model is tried on each of the 3 keys in order:
 *    attempt N: <model> on primary key → xmrt key → 3rd key
 *  Returns on first success, throws if all model/key combinations fail.
 */
async function tryOllamaCloud(messages, model, signal) {
  const keys = [
    { key: getOllamaKey(), label: 'primary' },
    { key: getOllamaXmrtKey(), label: 'xmrt' },
    { key: getOllama3rdKey(), label: '3rd' },
  ].filter(k => k.key);

  if (keys.length === 0) throw new Error('No OLLAMA_API_KEY configured');

  // Build the attempt list: requested model first (if cloud-eligible), then the fallback chain.
  const cloudModels = [];
  const addCloudModel = (m) => {
    const name = (m || '').replace(':cloud', '');
    if (!name || isOpenRouterOnly(name)) return;  // '/' or ':free' → not on Ollama Cloud
    if (!cloudModels.includes(name)) cloudModels.push(name);
  };
  addCloudModel(model);
  for (const m of CLOUD_FALLBACK_MODELS) addCloudModel(m);

  let lastError = null;

  // Each model in turn, on each of the 3 keys. Return on first success.
  for (const m of cloudModels) {
    for (const { key, label } of keys) {
      try {
        // For vision/image requests, keep the native Ollama format (images: [base64])
        // which the Ollama Cloud API accepts natively. For text-only, use OpenAI format.
        const hasImages = messages.some(msg => msg.images && msg.images.length > 0);
        const body = hasImages
          ? JSON.stringify({
              model: m,
              messages,  // messages have images field; Ollama cloud accepts this natively
              stream: false,
              max_tokens: 4096,
            })
          : JSON.stringify({
              model: m,
              messages: imagesToOpenAI(messages),
              stream: false,
              max_tokens: 4096,
            });
        const res = await fetch('https://ollama.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body,
          signal,
        });
        if (!res.ok) throw new Error(`Ollama Cloud HTTP ${res.status} (${m} on ${label}): ${(await res.text()).slice(0, 150)}`);
        return res.json();
      } catch (err) {
        lastError = err;
        continue;
      }
    }
  }

  throw lastError || new Error('All Ollama Cloud keys failed');
}

// ── Provider functions ─────────────────────────────────────

/** OpenCode Zen cascade (tier 0 — first provider tried).
 *  OpenAI-compatible chat-completions endpoint at https://opencode.ai/zen/v1.
 *
 *  Only `space-bunny-free` is reachable from the relay. Every other *-free Zen
 *  model (longcat-2.5-preview-free, jev-1.13-free, big-pickle,
 *  nemotron-3.5-lightning-free, muse-spark-1.3-contributor-free, ...) answers
 *  403 "OpenCode's free tier can only be used from within OpenCode", so probing
 *  them on every request would just burn the timeout budget. Keep the list here
 *  explicit rather than auto-discovering, and drop a model in only once it has
 *  been verified to return 200 from outside the OpenCode client.
 */
const OPENCODE_ZEN_MODELS = [
  'space-bunny-free',
];

function isOpenCodeOnly(model) {
  return typeof model === 'string' && OPENCODE_ZEN_MODELS.includes(model);
}

async function tryOpenCodeZen(messages, signal, requestedModel) {
  const key = getOpenCodeKey();
  if (!key) throw new Error('No OPENCODE_API_KEY configured');
  const base = getOpenCodeBase().replace(/\/+$/, '');

  const models = [];
  const add = (m) => {
    if (m && !models.includes(m)) models.push(m);
  };
  add(requestedModel && isOpenCodeOnly(requestedModel) ? requestedModel : null);
  for (const m of OPENCODE_ZEN_MODELS) add(m);

  let lastError = null;
  for (const model of models) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: imagesToOpenAI(messages),
          stream: false,
          max_tokens: 4096,
        }),
        signal,
      });
      if (!res.ok) {
        throw new Error(`OpenCode Zen HTTP ${res.status} (${model}): ${(await res.text()).slice(0, 200)}`);
      }
      return res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('No OpenCode Zen models configured');
}

/** Convert Ollama-style messages (with images: [base64] on the user msg)
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
async function tryOpenRouter(messages, signal, requestedModel = 'minimax/minimax-m3:free') {
  const key = getOpenRouterKey();
  if (!key) throw new Error('No OPENROUTER_API_KEY configured');
  // Vision-capable on OpenRouter: minimax/minimax-m3 supports text+image+video→text.
  // Text-only: same model — tool-calling support is the priority over cheap/fast.
  const FREE_TIER_MODELS = [
    'minimax/minimax-m3:free',     // tier 1: vision + tool-calling
    'thinkingmachines/inkling:free',  // tier 2: confirmed working 2026-09-20 (agent identity/self-ID provider)
    'nvidia/nemotron-3.5-lightning:free', // tier 3: text-only, long rate limits
    'nex-n2.5-pro:free',           // tier 4: newest 2026-09-19 fallback (new model)
  ];
  const hasImages = messages.some(m => m.images && m.images.length > 0);
  // Vision: pin minimax (only vision-capable in free tier). Text: cycle through
  // FREE_TIER_MODELS, preferring the requested model when it matches, else tier 1.
  const model = hasImages ? 'minimax/minimax-m3:free'
    : (requestedModel && FREE_TIER_MODELS.includes(requestedModel)
        ? requestedModel : FREE_TIER_MODELS[0]);
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://relay.mobilemonero.com',
    },
    body: JSON.stringify({
      model,
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

  // ── 1) Try OpenCode Zen (tier 0 — space-bunny-free) ──────────
  //  Added ahead of Ollama Cloud because the Ollama/OpenRouter free tiers get
  //  rate-limited hard and take the whole fleet offline together. Zen bills
  //  against a separate quota pool.
  if (getOpenCodeKey()) {
    try {
      const data = await tryOpenCodeZen(messages, controller.signal, model);
      result = normalizeResponse(data, model, 'opencode-zen');
    } catch (err) {
      errors.push(`OpenCodeZen: ${err.message}`);
    }
  }

  // ── 2) Try Ollama Pro Cloud (primary) ─────────────────────
  // SKIP for OpenRouter-only models (anything with '/' suffix or ':free' suffix)
  // — Ollama Cloud 404s on those and wastes the timeout budget.
  if (!result && !isOpenRouterOnly(model) && (getOllamaKey() || getOllamaXmrtKey() || getOllama3rdKey())) {
    try {
      const data = await tryOllamaCloud(messages, model, controller.signal);
      result = normalizeResponse(data, model, 'ollama-cloud');
    } catch (err) {
      errors.push(`OllamaCloud: ${err.message}`);
    }
  }

  // ── 3) Fallback: OpenRouter ──────────────────────────────────
  if (!result && getOpenRouterKey()) {
    try {
      const data = await tryOpenRouter(messages, controller.signal, model);
      result = normalizeResponse(data, result?.model || model, 'openrouter');
    } catch (err) {
      errors.push(`OpenRouter: ${err.message}`);
    }
  }

  // ── 4) No local fallback ─────────────────────────────────────
    // This machine has no local models (6GB RAM, no room for inference).
    // Cloud models (OpenCode Zen + Ollama Cloud + OpenRouter) are the only pipeline.
    // If all fail, surface the errors immediately.
    clearTimeout(timer);
  if (!result) {
    return { error: `All cloud providers failed: ${errors.join('; ')}` };
  }

  // Log token usage with agent/source attribution
  await logTokenUsage(agent, source, result.provider, result.model, result.promptEvalCount, result.evalCount, result.costUsd);

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

  // ── 1) Try OpenCode Zen (tier 0 — space-bunny-free) ──────────
  //  Separate quota pool from Ollama Cloud / OpenRouter, so it survives a
  //  simultaneous free-tier rate limit on both of those.
  if (getOpenCodeKey()) {
    try {
      const zenMessages = [
        { role: 'system', content: 'You are an AI agent. Be concise, helpful, and do not use emoji sign-offs.' },
        { role: 'user', content: prompt },
      ];
      const data = await tryOpenCodeZen(zenMessages, controller.signal, DEFAULT_MODEL);
      result = normalizeResponse(data, DEFAULT_MODEL, 'opencode-zen');
    } catch (err) {
      errors.push(`OpenCodeZen: ${err.message}`);
    }
  }

  // ── 2) Try Ollama Pro Cloud with the configured DEFAULT_MODEL ──
  // All Ollama keys share one model (set via OLLAMA_MODEL in relay/.env).
  // The previous cascade split keys across deepseek-v4-flash / gemma4:31b —
  // neither supported tool calling, so we collapsed to a single free model
  // (minimax/minimax-m3:free) that does.
  // SKIP Ollama Cloud for OpenRouter-only models ('/' suffix or ':free' suffix)
  // — Ollama Cloud 404s and burns the timeout budget.
  if (!result && !isOpenRouterOnly(DEFAULT_MODEL) && (getOllamaKey() || getOllamaXmrtKey() || getOllama3rdKey())) {
    try {
      const messages = [
        { role: 'system', content: 'You are an AI agent. Be concise, helpful, and do not use emoji sign-offs.' },
        { role: 'user', content: prompt },
      ];
      const data = await tryOllamaCloud(messages, DEFAULT_MODEL, controller.signal);
      result = normalizeResponse(data, DEFAULT_MODEL, 'ollama-cloud');
    } catch (err) {
      errors.push(`OllamaCloud: ${err.message}`);
    }
  }

  // ── 3) Fallback: OpenRouter (minimax/minimax-m3:free, supports tools) ──
  if (!result && getOpenRouterKey()) {
    try {
      const messages = [
        { role: 'system', content: 'You are an AI agent. Be concise, helpful, and do not use emoji sign-offs.' },
        { role: 'user', content: prompt },
      ];
      const data = await tryOpenRouter(messages, controller.signal, 'minimax/minimax-m3:free');
      result = normalizeResponse(data, 'minimax/minimax-m3:free', 'openrouter');
    } catch (err) {
      errors.push(`OpenRouter: ${err.message}`);
    }
  }

  // ── 4) No local fallback ─────────────────────────────────────
  // This machine has no local models (6GB RAM, no room for inference).
  // Cloud models (Ollama Cloud + OpenRouter) are the only pipeline.
  // If both fail, surface the errors immediately.
  clearTimeout(timer);
  if (!result) return { error: `All providers failed: ${errors.join('; ')}` };
  return result;
}

export default { ollamaChat, ollamaGenerate, listModels, checkOllamaHealth };
