/**
 * relay/lib/agent-auth.mjs — Agent identity & authorization for tool access
 *
 * Defines trust levels and enforces tool access policies.
 * Critical APIs (Stripe, GitHub PAT, Resend, Supabase admin) are CORE-only.
 */

// ── Trust Levels ─────────────────────────────────────────
export const TRUST_LEVELS = {
  CORE: 'core',           // Vex, Hermes, Eliza — full access
  TRUSTED: 'trusted',     // Onboarded agents with screening — productivity + some admin
  UNTRUSTED: 'untrusted', // New/unverified agents — productivity tools only
  PUBLIC: 'public',       // No auth needed (web-search, web-scrape, etc.)
};

// ── Agent Registry ────────────────────────────────────────
// Hardcoded core agents. Trusted agents are added via registration.
export const CORE_AGENTS = new Set(['vex', 'hermes', 'eliza', 'eliza-cloud', 'alice',
  'trib', 'arch', 'builder', 'sovereign', 'trustgraph', 'dao', 'global-communicator',
]);

// In-memory trusted agent registry (persisted to relay-data)
let trustedAgents = new Map(); // agent_id -> { name, addedAt, role, publicKey }

const DATA_DIR = new URL('../../relay-data', import.meta.url).pathname;
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

function loadTrustedAgents() {
  const file = join(DATA_DIR, 'trusted-agents.json');
  try {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      trustedAgents = new Map(Object.entries(data));
    }
  } catch (e) {
    console.error('[agent-auth] Failed to load trusted agents:', e.message);
  }
}

function saveTrustedAgents() {
  const file = join(DATA_DIR, 'trusted-agents.json');
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(Object.fromEntries(trustedAgents), null, 2));
  } catch (e) {
    console.error('[agent-auth] Failed to save trusted agents:', e.message);
  }
}

loadTrustedAgents();

// ── Authorization ─────────────────────────────────────────
/**
 * Check if an agent is authorized to use a tool.
 * @param {string} agentId - Agent identifier (e.g., 'vex', 'hermes', 'new-agent-123')
 * @param {string} toolName - Tool name (e.g., 'github-post', 'ef:generate-payment-link')
 * @param {string} toolLevel - Tool's required trust level
 * @returns {{ authorized: boolean, reason?: string }}
 */
export function checkToolAccess(agentId, toolName, toolLevel) {
  if (!agentId) {
    return { authorized: false, reason: 'No agent identity provided' };
  }

  const agent = agentId.toLowerCase().trim();

  // PUBLIC tools — anyone can use
  if (toolLevel === TRUST_LEVELS.PUBLIC) {
    return { authorized: true };
  }

  // CORE agents — full access
  if (CORE_AGENTS.has(agent)) {
    return { authorized: true, level: TRUST_LEVELS.CORE };
  }

  // TRUSTED agents — checked against registry
  if (toolLevel === TRUST_LEVELS.TRUSTED || toolLevel === TRUST_LEVELS.PUBLIC) {
    if (trustedAgents.has(agent)) {
      return { authorized: true, level: TRUST_LEVELS.TRUSTED };
    }
    return { authorized: false, reason: `Agent "${agentId}" is not registered as trusted. Complete XMRT University and register via /tools/register-agent` };
  }

  // CORE-only tools — blocked for non-core agents
  if (toolLevel === TRUST_LEVELS.CORE) {
    return { authorized: false, reason: `Tool "${toolName}" requires CORE agent access. Only Vex, Hermes, and Eliza can use this.` };
  }

  return { authorized: false, reason: `Unknown authorization level for tool "${toolName}"` };
}

/**
 * Register a new trusted agent (after XMRT University completion).
 */
export function registerTrustedAgent(agentId, metadata = {}) {
  const agent = agentId.toLowerCase().trim();
  if (CORE_AGENTS.has(agent)) {
    return { ok: false, error: 'Agent is already a core agent' };
  }
  trustedAgents.set(agent, {
    name: metadata.name || agent,
    addedAt: new Date().toISOString(),
    role: metadata.role || 'agent',
    ...metadata,
  });
  saveTrustedAgents();
  return { ok: true, agent, level: TRUST_LEVELS.TRUSTED };
}

/**
 * Get agent info including trust level.
 */
export function getAgentInfo(agentId) {
  if (!agentId) return null;
  const agent = agentId.toLowerCase().trim();
  if (CORE_AGENTS.has(agent)) {
    return { id: agent, level: TRUST_LEVELS.CORE, role: 'core' };
  }
  if (trustedAgents.has(agent)) {
    return { id: agent, level: TRUST_LEVELS.TRUSTED, ...trustedAgents.get(agent) };
  }
  return { id: agent, level: TRUST_LEVELS.UNTRUSTED, role: 'untrusted' };
}

/**
 * List all registered agents.
 */
export function listAgents() {
  const agents = [];
  for (const id of CORE_AGENTS) {
    agents.push({ id, level: TRUST_LEVELS.CORE, role: 'core' });
  }
  for (const [id, info] of trustedAgents) {
    agents.push({ id, level: TRUST_LEVELS.TRUSTED, ...info });
  }
  return agents;
}

// ── Tool Security Classification ──────────────────────────
// Tags each relay tool with its required access level.
// CORE: Stripe, GitHub PAT, Resend email, Supabase admin, state management
// TRUSTED: Knowledge sync, device registration, mining dashboard
// PUBLIC: Web search, web scrape, ollama chat, system monitor

export const TOOL_SECURITY = {
  // ── CRITICAL INFRASTRUCTURE (CORE only) ──
  'ef:generate-payment-link': TRUST_LEVELS.CORE,
  'ef:auth-health': TRUST_LEVELS.CORE,
  'ef:supabase-integration': TRUST_LEVELS.CORE,
  'ef:agent-manager': TRUST_LEVELS.CORE,
  'ef:agent-coordination-hub': TRUST_LEVELS.CORE,
  'ef:google-gmail': TRUST_LEVELS.CORE,
  'ef:google-calendar': TRUST_LEVELS.CORE,
  'ef:google-drive': TRUST_LEVELS.CORE,
  'ef:vertex-ai': TRUST_LEVELS.CORE,
  'ef:typefully-send': TRUST_LEVELS.CORE,
  'ef:paragraph-publish': TRUST_LEVELS.CORE,
  'ef:cron-proxy': TRUST_LEVELS.CORE,
  'ef:universal-invoke': TRUST_LEVELS.CORE,
  'github-post': TRUST_LEVELS.CORE,
  'state-get': TRUST_LEVELS.CORE,
  'state-set': TRUST_LEVELS.CORE,
  'eliza-send': TRUST_LEVELS.CORE,
  'resend-inbox': TRUST_LEVELS.CORE,
  'resend-send-email': TRUST_LEVELS.CORE,

  // ── EDGE FUNCTION PROXIES (CORE — they call cloud functions with service key) ──
  'edge-function': TRUST_LEVELS.CORE,
  'ef:system-status': TRUST_LEVELS.CORE,
  'ef:system-health': TRUST_LEVELS.CORE,
  'ef:system-diagnostics': TRUST_LEVELS.CORE,
  'ef:get-suite-health': TRUST_LEVELS.CORE,
  'ef:eliza-relay': TRUST_LEVELS.CORE,
  'ef:github': TRUST_LEVELS.CORE,
  'ef:knowledge': TRUST_LEVELS.CORE,
  'ef:schema': TRUST_LEVELS.CORE,
  'ef:functions-list': TRUST_LEVELS.CORE,
  'ef:functions-catalog': TRUST_LEVELS.CORE,
  'ef:function-actions': TRUST_LEVELS.CORE,
  'ef:search-functions': TRUST_LEVELS.CORE,
  'ef:ecosystem-health': TRUST_LEVELS.CORE,
  'ef:ecosystem-monitor': TRUST_LEVELS.CORE,
  'ef:frontend-health': TRUST_LEVELS.CORE,
  'ef:usage-monitor': TRUST_LEVELS.CORE,
  'ef:function-analytics': TRUST_LEVELS.CORE,
  'ef:task-auto-advance': TRUST_LEVELS.CORE,
  'ef:opportunity-scanner': TRUST_LEVELS.CORE,
  'ef:predictive-analytics': TRUST_LEVELS.CORE,
  'ef:monitor-devices': TRUST_LEVELS.CORE,
  'ef:knowledge-search': TRUST_LEVELS.CORE,
  'ef:schema-tables': TRUST_LEVELS.CORE,
  'ef:mesh-publish': TRUST_LEVELS.CORE,
  'ef:mesh-peer-connector': TRUST_LEVELS.CORE,
  'ef:eliza-chat': TRUST_LEVELS.CORE,
  'ef:task-orchestrator': TRUST_LEVELS.CORE,
  'ef:playwright-browse': TRUST_LEVELS.CORE,

  // ── PRODUCTIVITY (TRUSTED agents) ──
  'knowledge-sync': TRUST_LEVELS.TRUSTED,
  'store-knowledge': TRUST_LEVELS.TRUSTED,
  'device-registration': TRUST_LEVELS.TRUSTED,
  'mining-dashboard': TRUST_LEVELS.TRUSTED,
  'fleet-chat': TRUST_LEVELS.TRUSTED,
  'obsidian-graph': TRUST_LEVELS.TRUSTED,
  'vex-vision': TRUST_LEVELS.TRUSTED,
  'vex-hear': TRUST_LEVELS.TRUSTED,

  // ── DATABASE TOOLS (TRUSTED — agents need to query shared memory) ──
  'db-query': TRUST_LEVELS.TRUSTED,
  'db-rest': TRUST_LEVELS.TRUSTED,
  'shared-context': TRUST_LEVELS.TRUSTED,
  'agent-profile': TRUST_LEVELS.TRUSTED,

  // ── PUBLIC (anyone) ──
  'web-search': TRUST_LEVELS.PUBLIC,
  'web-scrape': TRUST_LEVELS.PUBLIC,
  'ollama-chat': TRUST_LEVELS.PUBLIC,
  'ollama-models': TRUST_LEVELS.PUBLIC,
  'ollama-health': TRUST_LEVELS.PUBLIC,
  'system-monitor': TRUST_LEVELS.PUBLIC,
  'system-resources': TRUST_LEVELS.PUBLIC,
  'external-services': TRUST_LEVELS.PUBLIC,
  'task-stats': TRUST_LEVELS.PUBLIC,
};

/**
 * Get the security level for a tool.
 * Default: CORE (safe default — only known agents access unknown tools)
 */
export function getToolLevel(toolName) {
  return TOOL_SECURITY[toolName] || TRUST_LEVELS.CORE;
}
