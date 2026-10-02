/**
 * relay/lib/agent-auth.mjs — Agent identity & authorization for tool access
 *
 * Defines trust levels and enforces tool access policies.
 * Critical APIs (Stripe, GitHub PAT, Resend, Supabase admin) are CORE-only.
 *
 * ── Identity now comes from CAP, not from a name list ──────────────────
 *
 * This used to grant CORE to a hardcoded set of bare names - "vex", "eliza",
 * "hermes" - while the fleet roster stores ids like "vex-001". The two never
 * matched, so 0 of 12 internal agents were recognised as CORE: the fleet could
 * not use its own top tier, and the guessable string "vex" would have been
 * let in. Identity now resolves through CAP, which normalises every spelling and
 * takes internal status from the roster.
 *
 * That matters more than a tidy-up. agent-auth was the only part of the trust
 * stack that actually gated anything, and it was the one part not connected to
 * trustgraph-engine or the University. A fleet can accumulate a reputation that
 * changes nothing; this is where that stops being true.
 *
 * The ordering rule CAP enforces, preserved here: internal agents resolve to CORE
 * from the roster alone, with no dependency on a score, a certificate, or the
 * trust engine being reachable. Trust and certification decide what EXTERNAL
 * agents may do, and their ceiling is TRUSTED.
 */
import {
  CAP_LEVELS, resolveAccessLevel, isInternalAgent, refreshRoster, tierFloor,
} from './cap.mjs';

// Kick the roster load once at module load. Deliberately not awaited: a slow or
// unreachable database must not delay boot, and an empty roster resolves unknown
// agents to PUBLIC rather than granting privilege.
refreshRoster().catch(() => {});

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
  'ai-chat-local-context', 'anya-sharma', 'cron', 'jobby', 'jobby-mcjobberson', 'jobby-001',
  // Fleet chat aliases (same agents, different name format)
  'vex-user', 'vex-captain,-hms-speedy', 'alice-sidecar', 'alice-daemon', 'eliza-quartermaster',
  'hermes-agent', 'hermes',
]);

// ── Explicit per-agent tool denials ─────────────────────────────────────
//
// Jobby is a CORE agent, with one deliberate exception. It reads untrusted
// text all day — resumes, job postings, employer pages, recruiter mail — and
// that text arrives inside model context. With shell-exec and sql-migrate
// reachable, a prompt hidden in a job posting becomes arbitrary code
// execution on this machine. Those two tools are the whole blast radius, so
// they are withheld from Jobby specifically and every other agent keeps them.
//
// Denials are checked before the level logic, so they cannot be overridden by
// a CORE grant.
export const TOOL_DENIALS = {
  jobby: {
    'shell-exec': 'Jobby reads untrusted job postings and resumes; shell access would turn injected text into code execution on this host.',
    'sql-migrate': 'Schema changes are not part of a job search. Jobby reads and writes job data, not DDL.',
    'page-agent-task': 'Driving the browser is only legitimate inside a job application, where the applicant facts, the stop-on-anything-unstated rule and the no-bypass-a-CAPTCHA rule are written into the task itself. The raw tool would let the same live browser session be aimed at anything, so Jobby goes through jobby_apply instead.',
  },
  'jobby-mcjobberson': {},
  'jobby-001': {},
};
// The aliases above resolve to the same rule set.
TOOL_DENIALS['jobby-mcjobberson'] = TOOL_DENIALS.jobby;
TOOL_DENIALS['jobby-001'] = TOOL_DENIALS.jobby;

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

  // Per-agent denials win over everything, including CORE.
  const denied = TOOL_DENIALS[agent];
  if (denied && Object.hasOwn(denied, toolName)) {
    return { authorized: false, denied: true, reason: denied[toolName] };
  }

  // PUBLIC tools — anyone can use
  if (toolLevel === TRUST_LEVELS.PUBLIC) {
    return { authorized: true };
  }

  // Identity, via CAP. Internal status comes from the roster, normalised across
  // every spelling the estate uses ("vex", "vex-001", "did:xmrt:vex", "Vex
  // (Captain, HMS Speedy)"). Without normalisation this check matched nothing.
  const access = resolveAccessLevel(agentId);

  if (access.level === CAP_LEVELS.CORE) {
    return { authorized: true, level: TRUST_LEVELS.CORE, resolvedBy: 'cap' };
  }

  // TRUSTED tools — an external agent needs a credential tier, a TrustGraph score
  // at or above that tier's floor, and an XMRT CERT. Anything missing denies, and
  // the reason says which.
  if (toolLevel === TRUST_LEVELS.TRUSTED) {
    // Registered agents (the pre-CAP path) still count, so nothing that worked
    // before this change stops working.
    if (access.level === CAP_LEVELS.TRUSTED) {
      return { authorized: true, level: TRUST_LEVELS.TRUSTED, resolvedBy: 'cap', detail: access.detail };
    }
    if (trustedAgents.has(agent)) {
      return { authorized: true, level: TRUST_LEVELS.TRUSTED, resolvedBy: 'registry' };
    }
    return { authorized: false, reason: access.reason };
  }

  // CORE-only tools — blocked for non-core agents
  if (toolLevel === TRUST_LEVELS.CORE) {
    return {
      authorized: false,
      reason: `Tool "${toolName}" requires CORE agent access. CORE is reserved for internal fleet agents resolved from the roster.`,
    };
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
    const denied = TOOL_DENIALS[agent];
    return {
      id: agent, level: TRUST_LEVELS.CORE, role: 'core',
      ...(denied && Object.keys(denied).length ? { deniedTools: Object.keys(denied) } : {}),
    };
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
  'ef:paragraph-publish': TRUST_LEVELS.PUBLIC,
  'paragraph-publish': TRUST_LEVELS.PUBLIC,
  // Obsidian vault. Reads are safe for anyone; writes modify the shared
  // "second brain", so they are CORE like the other knowledge writers
  // (knowledge-graph, state-set, fleet memory).
  'vault-list': TRUST_LEVELS.PUBLIC,
  'vault-read': TRUST_LEVELS.PUBLIC,
  'vault-write': TRUST_LEVELS.CORE,
  'vault-update': TRUST_LEVELS.CORE,
  'vault-sync-entities': TRUST_LEVELS.CORE,

  'ef:cron-proxy': TRUST_LEVELS.CORE,
  'ef:universal-invoke': TRUST_LEVELS.CORE,
  'github-post': TRUST_LEVELS.CORE,
  'state-get': TRUST_LEVELS.CORE,
  'state-set': TRUST_LEVELS.CORE,
  'service_control': TRUST_LEVELS.TRUSTED,
  'ship_logs': TRUST_LEVELS.TRUSTED,
  'eliza-send': TRUST_LEVELS.CORE,
  'resend-inbox': TRUST_LEVELS.CORE,
  'resend-send-email': TRUST_LEVELS.CORE,
  'shell-exec': TRUST_LEVELS.CORE,

  // ── EDGE FUNCTION PROXIES (CORE — they call cloud functions with service key) ──
  'edge-function': TRUST_LEVELS.CORE,
  'ef:schema-introspect': TRUST_LEVELS.PUBLIC,
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
  'device-registration': TRUST_LEVELS.TRUSTED,
  'mining-dashboard': TRUST_LEVELS.TRUSTED,
  'fleet-chat': TRUST_LEVELS.TRUSTED,
  'obsidian-graph': TRUST_LEVELS.TRUSTED,
  'vex-vision': TRUST_LEVELS.TRUSTED,
  'vex-hear': TRUST_LEVELS.TRUSTED,

  // ── PERCEPTION (TRUSTED, deliberately not PUBLIC) ──
  // These take a path on the host, hand the file to ffmpeg, and - in video-brief -
  // base64 a contact sheet and send it to a cloud model. That is the same risk
  // class as vex-vision directly above, which was already TRUSTED, so they sit at
  // the same tier rather than inventing a new one.
  //
  // They are NOT public, and should not be made public: an arbitrary local path
  // plus outbound egress is a file-read and a data-exfiltration primitive. If these
  // ever need to be reachable by untrusted callers, the fix is to take a
  // fleet-registered media id rather than a filesystem path - not to lower the
  // level.
  'video-brief': TRUST_LEVELS.TRUSTED,
  'media-probe': TRUST_LEVELS.TRUSTED,
  'media-shots': TRUST_LEVELS.TRUSTED,
  'media-contact-sheet': TRUST_LEVELS.TRUSTED,
  'media-loudness': TRUST_LEVELS.TRUSTED,
  'media-waveform': TRUST_LEVELS.TRUSTED,

  // The registry itself. media-register is the one tool in the estate that accepts
  // a filesystem path or a URL, and it is TRUSTED for the same reason vex-vision
  // is: it touches the filesystem. What it does with that path is copy the bytes
  // into a managed root and hand back an id - it never reads the file to the
  // caller and never returns the path from a lookup, so it is strictly less
  // exposing than vex-vision, which base64s an arbitrary file to a cloud model.
  //
  // These are not PUBLIC because entries record `origin` and `registeredBy`, and
  // a filesystem path is information the fleet does not need broadcast.
  'media-register': TRUST_LEVELS.TRUSTED,
  'media-list': TRUST_LEVELS.TRUSTED,
  'media-get': TRUST_LEVELS.TRUSTED,
  'media-remove': TRUST_LEVELS.TRUSTED,

  // ── DATABASE TOOLS (TRUSTED — agents need to query shared memory) ──
  'db-query': TRUST_LEVELS.TRUSTED,
  'sql-migrate': TRUST_LEVELS.CORE,
  'db-rest': TRUST_LEVELS.TRUSTED,
  'shared-context': TRUST_LEVELS.TRUSTED,
  'recall_context': TRUST_LEVELS.TRUSTED,
  'knowledge-dedup': TRUST_LEVELS.TRUSTED,
  'task-dedup': TRUST_LEVELS.TRUSTED,
  'assign_task': TRUST_LEVELS.TRUSTED,
  'advance_task': TRUST_LEVELS.TRUSTED,
  'agent-profile': TRUST_LEVELS.TRUSTED,
  'get_agent_key': TRUST_LEVELS.TRUSTED,

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
