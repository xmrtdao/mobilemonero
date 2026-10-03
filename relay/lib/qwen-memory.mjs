#!/usr/bin/env node
/**
 * qwen-memory.mjs — Qwen Code memory persistence via Suite's local-sb tables
 *
 * Talks to public.conversation_memory, public.conversation_summaries,
 * and public.memory_contexts in the xmrt_suite database via the local-sb
 * REST API (port 54321).
 *
 * Design notes:
 *   - Follows the same pattern as fleet-memory.mjs (HTTP request helpers,
 *     local-first with cloud fallback, resolveBase() caching).
 *   - Uses Joe's UUID (1b865599-e9ae-45df-8e50-a2abec6811b4) as user_id
 *     for memory_contexts writes.
 *   - Session IDs follow the pattern "qwen-code-YYYY-MM-DD" for daily
 *     conversation tracking.
 *   - All writes go through the local-sb REST API; cloud fallback is
 *     available but unused in practice.
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

const LOCAL_URL = process.env.LOCAL_SUPABASE_URL || 'http://127.0.0.1:54321';
const LOCAL_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || 'local-dev-no-auth';
const CLOUD_URL = process.env.SUPABASE_URL || '';
const CLOUD_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const JOE_UUID = '1b865599-e9ae-45df-8e50-a2abec6811b4';
const MAX_CONTENT = 10000;
const MAX_SUMMARY = 5000;

// Convert a JS array to a PostgreSQL text[] literal: ["a","b"] → {a,b}
function toPgArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '{}';
  return '{' + arr.map(v => String(v).replace(/[{}"]/g, '')).join(',') + '}';
}

// ── HTTP helpers (mirrors fleet-memory.mjs) ─────────────────
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      timeout: options.timeout || 10_000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const code = res.statusCode;
        if (code >= 200 && code < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve({ raw: data, status: code }); }
        } else {
          reject(new Error(`HTTP ${code}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

async function postgrest(opts) {
  const { base, key } = await resolveBase();
  const url = `${base}/rest/v1/${opts.path}`;
  return request(url, {
    method: opts.method || 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(opts.prefer ? { Prefer: opts.prefer } : {}),
    },
    body: opts.body,
    timeout: opts.timeout,
  });
}

// ── Local-first with cloud fallback ─────────────────────────
let cachedBase = null;
let cachedKey = null;
let cachedAt = 0;
const RESOLVE_TTL_MS = 30_000;

async function resolveBase() {
  if (cachedBase && Date.now() - cachedAt < RESOLVE_TTL_MS) {
    return { base: cachedBase, key: cachedKey };
  }
  // Probe local-sb conversation_memory table
  try {
    const r = await request(`${LOCAL_URL}/rest/v1/conversation_memory?select=id&limit=1`, {
      method: 'GET',
      headers: { apikey: LOCAL_KEY, Authorization: `Bearer ${LOCAL_KEY}` },
      timeout: 3000,
    });
    cachedBase = LOCAL_URL;
    cachedKey = LOCAL_KEY;
    cachedAt = Date.now();
    return { base: cachedBase, key: cachedKey };
  } catch (e) {
    // fall through to cloud
  }
  if (CLOUD_URL && CLOUD_KEY) {
    cachedBase = CLOUD_URL;
    cachedKey = CLOUD_KEY;
    cachedAt = Date.now();
    return { base: cachedBase, key: cachedKey };
  }
  throw new Error('No Supabase available (local + cloud both unreachable)');
}

// ── Public API ──────────────────────────────────────────────

/**
 * Save full conversation state to conversation_memory.
 * @param {string} sessionId - e.g. "qwen-code-2026-06-28"
 * @param {object[]} messages - array of {role, content, timestamp}
 * @param {string} [summary] - optional summary text
 * @param {object} [metadata] - optional metadata (topics, tool_calls, etc.)
 * @returns {object|null} inserted row, or null on failure
 */
export async function saveConversationState(sessionId, messages, summary, metadata = {}) {
  if (!sessionId) throw new Error('saveConversationState: sessionId is required');
  const row = {
    session_id: sessionId,
    messages: JSON.stringify(messages || []),
    tool_results: JSON.stringify(metadata.tool_results || []),
    summary: summary || '',
    metadata: JSON.stringify({ ...metadata, source: 'qwen-code' }),
    user_id: JOE_UUID,
    memory_version: '3.0',
    self_aware: true,
    preferences_applied: true,
    summary_method: 'auto',
    ai_summary_tokens: summary ? Math.ceil(summary.length / 4) : 0,
    context_score: 1.0,
    retention_priority: 5,
    tool_analysis: JSON.stringify(metadata.tool_analysis || {}),
    updated_at_hour: new Date().toISOString(),
  };
  try {
    const data = await postgrest({
      path: 'conversation_memory?on_conflict=session_id',
      method: 'POST',
      prefer: 'return=representation,resolution=merge-duplicates',
      body: [row],
    });
    return Array.isArray(data) ? data[0] : data;
  } catch (e) {
    console.error('[qwen-memory] saveConversationState failed:', e.message);
    return null;
  }
}

/**
 * Load the most recent conversation state for a session.
 * @param {string} sessionId - session identifier
 * @returns {object|null} most recent row, or null
 */
export async function loadConversationState(sessionId) {
  if (!sessionId) throw new Error('loadConversationState: sessionId is required');
  try {
    const data = await postgrest({
      path: `conversation_memory?session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.desc&limit=1`,
      method: 'GET',
    });
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (e) {
    console.error('[qwen-memory] loadConversationState failed:', e.message);
    return null;
  }
}

/**
 * Save a conversation summary to conversation_summaries.
 * @param {string} sessionId - session identifier
 * @param {string} summaryText - the summary text
 * @param {object} opts
 *   keyTopics (string[]), sentiment (number -1..1), actionItems (string[]),
 *   decisionsMade (string[]), keyEntities (object), messageCount (number)
 * @returns {object|null} inserted row
 */
export async function saveConversationSummary(sessionId, summaryText, opts = {}) {
  if (!sessionId || !summaryText) throw new Error('saveConversationSummary: sessionId and summaryText are required');
  const row = {
    session_id: sessionId,
    summary_text: String(summaryText).slice(0, MAX_SUMMARY),
    summary: String(summaryText).slice(0, MAX_SUMMARY),
    message_count: opts.messageCount || 0,
    key_topics: toPgArray(opts.keyTopics || []),
    sentiment_score: typeof opts.sentiment === 'number' ? opts.sentiment : 0,
    sentiment_label: opts.sentiment > 0.3 ? 'positive' : opts.sentiment < -0.3 ? 'negative' : 'neutral',
    self_aware: true,
    key_entities: JSON.stringify(opts.keyEntities || {}),
    action_items: JSON.stringify(opts.actionItems || []),
    decisions_made: JSON.stringify(opts.decisionsMade || []),
    ip_address: '127.0.0.1',
    user_id: JOE_UUID,
    summary_method: 'auto',
    ai_model_used: 'qwen-code',
    summary_tokens: Math.ceil(summaryText.length / 4),
    confidence_score: opts.confidence || 0.8,
    ai_summary_tokens: Math.ceil(summaryText.length / 4),
    metadata: JSON.stringify({ source: 'qwen-code' }),
  };
  try {
    const data = await postgrest({
      path: 'conversation_summaries',
      method: 'POST',
      prefer: 'return=representation',
      body: [row],
    });
    return Array.isArray(data) ? data[0] : data;
  } catch (e) {
    console.error('[qwen-memory] saveConversationSummary failed:', e.message);
    return null;
  }
}

/**
 * Load recent conversation summaries.
 * @param {number} [limit=10] - max rows
 * @returns {object[]} array of summary rows
 */
export async function loadRecentSummaries(limit = 10) {
  try {
    const data = await postgrest({
      path: `conversation_summaries?order=created_at.desc&limit=${limit}`,
      method: 'GET',
    });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[qwen-memory] loadRecentSummaries failed:', e.message);
    return [];
  }
}

/**
 * Save an important conversation fragment to memory_contexts.
 * @param {string} sessionId - session identifier
 * @param {string} content - the important fragment
 * @param {string} contextType - e.g. 'decision', 'insight', 'requirement', 'bug'
 * @param {number} [importanceScore=0.5] - 0.0 to 1.0
 * @param {object} [metadata] - optional metadata
 * @returns {object|null} inserted row
 */
export async function saveMemoryContext(sessionId, content, contextType, importanceScore = 0.5, metadata = {}) {
  if (!sessionId || !content || !contextType) {
    throw new Error('saveMemoryContext: sessionId, content, and contextType are required');
  }
  const row = {
    user_id: JOE_UUID,
    session_id: sessionId,
    content: String(content).slice(0, MAX_CONTENT),
    context_type: contextType,
    importance_score: importanceScore,
    metadata: JSON.stringify({ ...metadata, source: 'qwen-code' }),
  };
  try {
    const data = await postgrest({
      path: 'memory_contexts',
      method: 'POST',
      prefer: 'return=representation',
      body: [row],
    });
    return Array.isArray(data) ? data[0] : data;
  } catch (e) {
    console.error('[qwen-memory] saveMemoryContext failed:', e.message);
    return null;
  }
}

/**
 * Load memory contexts for a session, ordered by importance desc.
 * @param {string} sessionId - session identifier
 * @param {number} [limit=20] - max rows
 * @returns {object[]} array of context rows
 */
export async function loadMemoryContexts(sessionId, limit = 20) {
  if (!sessionId) throw new Error('loadMemoryContexts: sessionId is required');
  try {
    const data = await postgrest({
      path: `memory_contexts?session_id=eq.${encodeURIComponent(sessionId)}&order=importance_score.desc&limit=${limit}`,
      method: 'GET',
    });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[qwen-memory] loadMemoryContexts failed:', e.message);
    return [];
  }
}

/**
 * Search memory contexts by content (trigram-like ilike search).
 * @param {string} query - search term
 * @param {number} [limit=10] - max rows
 * @returns {object[]} matching rows
 */
export async function searchMemoryContexts(query, limit = 10) {
  if (!query || query.length < 2) return [];
  const q = query.replace(/[%_]/g, '\\$&');
  try {
    const data = await postgrest({
      path: `memory_contexts?content=ilike.*${encodeURIComponent(q)}*&order=importance_score.desc&limit=${limit}`,
      method: 'GET',
    });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[qwen-memory] searchMemoryContexts failed:', e.message);
    return [];
  }
}

/**
 * Get all distinct session IDs that have conversation memory.
 * Useful for listing available sessions.
 * @returns {string[]} array of session IDs
 */
export async function listSessions() {
  try {
    const data = await postgrest({
      path: 'conversation_memory?select=session_id&order=created_at.desc',
      method: 'GET',
    });
    if (!Array.isArray(data)) return [];
    const seen = new Set();
    return data.filter(r => {
      if (seen.has(r.session_id)) return false;
      seen.add(r.session_id);
      return true;
    }).map(r => r.session_id);
  } catch (e) {
    console.error('[qwen-memory] listSessions failed:', e.message);
    return [];
  }
}

// ── EnhancedConversationPersistence cascade (from ai-chat/index.ts) ──

/**
 * Load historical summaries with cascade: user_id → ip_address → session_id.
 * Mirrors EnhancedConversationPersistence.loadHistoricalSummaries().
 * @param {object} opts
 *   userId (string), ipAddress (string), sessionId (string)
 * @returns {object[]} array of summary rows
 */
export async function loadHistoricalSummaries(opts = {}) {
  const { userId, ipAddress, sessionId } = opts;
  const seen = new Set();
  const results = [];

  // Cascade 1: user_id
  if (userId) {
    try {
      const data = await postgrest({
        path: `conversation_summaries?user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=5`,
        method: 'GET',
      });
      if (Array.isArray(data)) {
        for (const r of data) {
          const key = r.id || r.session_id;
          if (!seen.has(key)) { seen.add(key); results.push(r); }
        }
      }
    } catch (e) { /* cascade continues */ }
  }

  // Cascade 2: ip_address
  if (ipAddress) {
    try {
      const data = await postgrest({
        path: `conversation_summaries?ip_address=eq.${encodeURIComponent(ipAddress)}&order=created_at.desc&limit=5`,
        method: 'GET',
      });
      if (Array.isArray(data)) {
        for (const r of data) {
          const key = r.id || r.session_id;
          if (!seen.has(key)) { seen.add(key); results.push(r); }
        }
      }
    } catch (e) { /* cascade continues */ }
  }

  // Cascade 3: session_id
  if (sessionId) {
    try {
      const data = await postgrest({
        path: `conversation_summaries?session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.desc&limit=5`,
        method: 'GET',
      });
      if (Array.isArray(data)) {
        for (const r of data) {
          const key = r.id || r.session_id;
          if (!seen.has(key)) { seen.add(key); results.push(r); }
        }
      }
    } catch (e) { /* cascade exhausted */ }
  }

  return results.slice(0, 10);
}

/**
 * Save a question/response context pair to conversation_contexts.
 * Mirrors EnhancedConversationPersistence.saveConversationContext().
 * @param {string} sessionId
 * @param {string} currentQuestion
 * @param {string} assistantResponse
 * @param {string} userResponse
 * @param {object} [metadata]
 * @returns {object|null}
 */
export async function saveConversationContext(sessionId, currentQuestion, assistantResponse, userResponse, metadata = {}) {
  if (!sessionId || !currentQuestion || !assistantResponse || !userResponse) {
    throw new Error('saveConversationContext: sessionId, currentQuestion, assistantResponse, and userResponse are required');
  }
  const row = {
    session_id: sessionId,
    current_question: String(currentQuestion).slice(0, MAX_CONTENT),
    assistant_response: String(assistantResponse).slice(0, MAX_CONTENT),
    user_response: String(userResponse).slice(0, MAX_CONTENT),
    metadata: JSON.stringify({ ...metadata, source: 'qwen-code' }),
    user_id: JOE_UUID,
  };
  try {
    const data = await postgrest({
      path: 'conversation_contexts',
      method: 'POST',
      prefer: 'return=representation',
      body: [row],
    });
    return Array.isArray(data) ? data[0] : data;
  } catch (e) {
    console.error('[qwen-memory] saveConversationContext failed:', e.message);
    return null;
  }
}

/**
 * Load recent context entries by IP address.
 * Mirrors EnhancedConversationPersistence.loadRecentContext().
 * @param {string} ipAddress
 * @param {number} [limit=5]
 * @returns {object[]}
 */
export async function loadRecentContext(ipAddress, limit = 5) {
  if (!ipAddress) return [];
  try {
    const data = await postgrest({
      path: `conversation_contexts?session_id=ilike.*${encodeURIComponent(ipAddress.replace(/\./g, '_'))}*&order=created_at.desc&limit=${limit}`,
      method: 'GET',
    });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[qwen-memory] loadRecentContext failed:', e.message);
    return [];
  }
}

/**
 * Load conversation state by IP address (cascade fallback).
 * Mirrors EnhancedConversationManager.loadConversationHistory() IP-first approach.
 * @param {string} ipAddress
 * @returns {object|null}
 */
export async function loadByIP(ipAddress) {
  if (!ipAddress) return null;
  try {
    const data = await postgrest({
      path: `conversation_memory?ip_address=eq.${encodeURIComponent(ipAddress)}&order=updated_at.desc&limit=1`,
      method: 'GET',
    });
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (e) {
    console.error('[qwen-memory] loadByIP failed:', e.message);
    return null;
  }
}

/**
 * Load conversation state by user_id (cascade fallback).
 * @param {string} userId
 * @returns {object|null}
 */
export async function loadByUserId(userId) {
  if (!userId) return null;
  try {
    const data = await postgrest({
      path: `conversation_memory?user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc&limit=1`,
      method: 'GET',
    });
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (e) {
    console.error('[qwen-memory] loadByUserId failed:', e.message);
    return null;
  }
}

export const _internals = { resolveBase, request, postgrest };
