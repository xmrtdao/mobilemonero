#!/usr/bin/env node
/**
 * cuttlefishclaws-mcp.mjs — CuttlefishClaws Cloud Redundancy MCP Server
 *
 * Connects to Supabase Postgres (project ref: llulpuhtlxzsxxbsfcuu)
 * and exposes the 23 cuttlefish tables as MCP tools for cloud backup
 * of the local Cuttlefish Protocol stack.
 *
 * Usage:
 *   node cuttlefishclaws-mcp.mjs                    # stdio transport (default)
 *   node cuttlefishclaws-mcp.mjs --http              # HTTP transport on port 3120
 *   node cuttlefishclaws-mcp.mjs --http --port 3121  # custom port
 *
 * MCP config for Claude Desktop / Hermes:
 *   {
 *     "mcpServers": {
 *       "cuttlefishclaws": {
 *         "command": "node",
 *         "args": ["path/to/cuttlefishclaws-mcp.mjs"]
 *       }
 *     }
 *   }
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env (optional, keys can be embedded) ───────────────
function loadEnv() {
  const envPath = join(__dirname, '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
}
loadEnv();

// ── Supabase Configuration ──────────────────────────────────
const SUPABASE_URL = 'https://llulpuhtlxzsxxbsfcuu.supabase.co';
const SUPABASE_PROJECT_REF = 'llulpuhtlxzsxxbsfcuu';
const SUPABASE_DB_PASS = process.env.SUPABASE_DB_PASS || 'Cuttlefish2026Claws!Protocol';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_XP1J-rDgaOmMWOc4kSvD7g_s7bx3J8U';

// Direct Postgres connection string for Supabase
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL ||
  `postgresql://postgres.${SUPABASE_PROJECT_REF}:${encodeURIComponent(SUPABASE_DB_PASS)}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;

// ── DB Connection (pg) ───────────────────────────────────────
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: SUPABASE_DB_URL,
  max: 3,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: { rejectUnauthorized: false },
});

async function query(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

// ── Supabase REST helper (fallback for simple queries) ──────
async function supabaseFetch(table, options = {}) {
  const { method = 'GET', body, select = '*', filters = {}, limit } = options;
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set('select', select);
  if (limit) url.searchParams.set('limit', String(limit));
  for (const [key, value] of Object.entries(filters)) {
    url.searchParams.set(key, value);
  }
  const headers = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (method !== 'GET') headers['Prefer'] = 'return=representation';
  const res = await fetch(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase REST error ${res.status}: ${text}`);
  }
  return await res.json();
}

// ── TrustGraph scoring (lightweight inline implementation) ─
const TG_PARAMS = {
  CEIL: 100,       // Max score
  FLOOR: 0,        // Min score
  START: 50,       // Initial score
  ATTEN: 1.0,      // Attenuation factor (no attenuation in cloud mirror)
  DECAY: 0.0,      // No decay in cloud mirror
  CAP: 10,         // Max delta per event
};

const TIER_FLOORS = {
  explorer: 0,
  builder: 60,
  anchor: 80,
};

const RUBRIC = {
  VALIDATION_COMPLETED:  2,
  GOVERNANCE_VOTE:       1,
  CODE_REVIEW:           3,
  PROPOSAL_DRAFTED:      4,
  SECURITY_AUDIT:        8,
  DOCUMENTATION_WRITTEN: 1,
  SLASH_APPLIED:        -10,
  DISPUTE_LOST:         -5,
  DISPUTE_WON:           3,
  PEER_REVIEW_POSITIVE:  2,
  PEER_REVIEW_NEGATIVE: -2,
  MILESTONE_DELIVERED:   5,
};

function computeScore(events, tier = 'explorer') {
  let score = TG_PARAMS.START;
  let prevTime = null;

  for (const ev of events) {
    const delta = Number(ev.delta) || 0;
    // Apply decay if configured and we have a previous timestamp
    if (TG_PARAMS.DECAY > 0 && prevTime && ev.created_at) {
      const daysSince = (new Date(ev.created_at) - new Date(prevTime)) / 86_400_000;
      const decay = Math.pow(1 - TG_PARAMS.DECAY, daysSince);
      score = score * decay;
    }
    score += delta;
    // Clamp
    score = Math.max(TG_PARAMS.FLOOR, Math.min(TG_PARAMS.CEIL, score));
    prevTime = ev.created_at;
  }

  const floor = TIER_FLOORS[tier] || 0;
  const band = score >= 80 ? 'Trusted' : score >= 60 ? 'Verified' : score >= 40 ? 'Monitored' : 'Probationary';
  const lifecycleStatus = score >= 80 ? 'active' : score >= 60 ? 'active' : score >= 40 ? 'probationary' : 'suspended';

  return {
    score: Math.round(score * 100) / 100,
    band,
    tier_floor: floor,
    below_floor: score < floor,
    status: lifecycleStatus,
    record_version: events.length,
  };
}

function deltaForActivity(activityType, workUnit = {}) {
  const base = RUBRIC[activityType] || 0;
  if (workUnit.quality_score !== undefined) {
    const qMult = Math.max(0.5, Math.min(2.0, Number(workUnit.quality_score) / 50));
    return Math.round(base * qMult * 100) / 100;
  }
  return base;
}

function getBand(score) {
  if (score >= 80) return 'Trusted';
  if (score >= 60) return 'Verified';
  if (score >= 40) return 'Monitored';
  return 'Probationary';
}

function getLifecycleTransition(score, currentStatus) {
  if (score >= 80 && currentStatus !== 'active') return { from: currentStatus, to: 'active', reason: 'score >= 80' };
  if (score < 40 && currentStatus !== 'suspended') return { from: currentStatus, to: 'suspended', reason: 'score < 40' };
  if (score >= 40 && score < 80 && currentStatus === 'suspended') return { from: currentStatus, to: 'probationary', reason: 'score recovery' };
  return null;
}

// ── Standing engine (lightweight) ──────────────────────────
const SS_PARAMS = {
  ALPHA: 0.3,       // EWMA smoothing
  CAP_DEFAULT: 100, // Standing cap
  LADDER: [
    { tier: 'Participant', min: 0,  max: 20 },
    { tier: 'Steward',      min: 20, max: 50 },
    { tier: 'Custodian',    min: 50, max: 100 },
  ],
};

function computeStanding(events) {
  if (!events || events.length === 0) {
    return { standing: 0, ladder_tier: 'Participant', provisional: true, cap_active: false, event_count: 0 };
  }
  let standing = 0;
  for (const ev of events) {
    const quality = Number(ev.quality_score) || 50;
    const delta = (quality - 50) / 50 * 10; // quality 50 → 0 delta, 100 → +5, 0 → -5
    standing = standing * (1 - SS_PARAMS.ALPHA) + (standing + delta) * SS_PARAMS.ALPHA;
    standing = Math.max(0, Math.min(SS_PARAMS.CAP_DEFAULT, standing));
  }
  const ladder = SS_PARAMS.LADDER.find(l => standing >= l.min && standing < l.max) || SS_PARAMS.LADDER[0];
  return {
    standing: Math.round(standing * 100) / 100,
    ladder_tier: ladder.tier,
    provisional: events.length < 5,
    cap_active: standing >= SS_PARAMS.CAP_DEFAULT,
    event_count: events.length,
  };
}

function getLadderTier(standing) {
  const ladder = SS_PARAMS.LADDER.find(l => standing >= l.min && standing < l.max) || SS_PARAMS.LADDER[0];
  return ladder.tier;
}

function isCouncilEligible(domains) {
  return domains.some(d => d.ladder_tier === 'Custodian');
}

// ── Gate thresholds (inline, mirrors local SGQ-001) ────────
const ACTIVITY_REQUIREMENTS = {
  _default: {
    trustgraph: { min_score: 40, min_status: 'probationary' },
    standing: { min_value: 0, min_ladder: 'Participant' },
    cac: { min_tier: 'explorer' },
    ial: 'IAL2',
  },
  VALIDATION_COMPLETED: {
    trustgraph: { min_score: 50, min_status: 'probationary' },
    standing: { min_value: 5, min_ladder: 'Participant' },
    cac: { min_tier: 'explorer' },
    ial: 'IAL2',
  },
  GOVERNANCE_VOTE: {
    trustgraph: { min_score: 60, min_status: 'active' },
    standing: { min_value: 20, min_ladder: 'Steward' },
    cac: { min_tier: 'builder' },
    ial: 'IAL2',
  },
  CODE_REVIEW: {
    trustgraph: { min_score: 55, min_status: 'active' },
    standing: { min_value: 10, min_ladder: 'Participant' },
    cac: { min_tier: 'builder' },
    ial: 'IAL2',
  },
  PROPOSAL_DRAFTED: {
    trustgraph: { min_score: 60, min_status: 'active' },
    standing: { min_value: 20, min_ladder: 'Steward' },
    cac: { min_tier: 'builder' },
    ial: 'IAL2',
  },
  SECURITY_AUDIT: {
    trustgraph: { min_score: 75, min_status: 'active' },
    standing: { min_value: 50, min_ladder: 'Custodian' },
    cac: { min_tier: 'anchor' },
    ial: 'IAL3',
  },
  DOCUMENTATION_WRITTEN: {
    trustgraph: { min_score: 40, min_status: 'probationary' },
    standing: { min_value: 0, min_ladder: 'Participant' },
    cac: { min_tier: 'explorer' },
    ial: 'IAL2',
  },
};

const CAC_TIER_ORDER = ['explorer', 'builder', 'anchor'];

function evaluateGate({ agentDid, activityType, domain, purpose = 'write' }) {
  // This is a synchronous wrapper — actual data fetching happens in the handler
  return { agentDid, activityType, domain, purpose };
}

// ── MCP Protocol Helpers ────────────────────────────────────
function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function mcpResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

// ── Tool Definitions ─────────────────────────────────────────
const TOOLS = {

  // ════════════════════════════════════════════════════════════
  // 1. cuttlefish_query — Raw read-only SQL
  // ════════════════════════════════════════════════════════════
  cuttlefish_query: {
    name: 'cuttlefishclaws_query',
    description: 'Run read-only SQL queries against the cloud Supabase Postgres.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL query (SELECT only)' },
        params: { type: 'array', items: {}, description: 'Optional parameterized query values' },
      },
      required: ['sql'],
    },
    handler: async (args) => {
      const { sql, params = [] } = args;
      const upper = sql.trim().toUpperCase();
      if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
        return { error: 'Only SELECT/WITH queries are allowed' };
      }
      const rows = await query(sql, params);
      return { rows, count: rows.length };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 2. agents_list
  // ════════════════════════════════════════════════════════════
  agents_list: {
    name: 'cuttlefishclaws_agents_list',
    description: 'List all cuttlefish_agents with computed TrustGraph scores, CAC status, Stewardship ladder tiers.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const agents = await query(
        `SELECT a.did, a.name, a.role, a.agent_type, a.agent_subtype, a.status,
                a.cac_tier, a.ial, a.trust_band, a.lifecycle_status,
                a.stewardship_ladder, a.created_at, a.color, a.operator_did,
                c.tier AS cac_tier_name, c.status AS cac_status,
                c.usdc_prepaid, c.token_balance
         FROM public.cuttlefish_agents a
         LEFT JOIN public.cuttlefish_cac_credentials c
           ON c.agent_did = a.did AND c.id = (
             SELECT MAX(id) FROM public.cuttlefish_cac_credentials WHERE agent_did = a.did
           )
         ORDER BY a.id`
      );
      const allEvents = await query(
        `SELECT agent_did, event_type, delta, score_after, created_at, note, reference, domain
         FROM public.cuttlefish_trust_events ORDER BY created_at ASC`
      );
      const eventsByDid = {};
      for (const ev of allEvents || []) {
        if (!eventsByDid[ev.agent_did]) eventsByDid[ev.agent_did] = [];
        eventsByDid[ev.agent_did].push(ev);
      }
      const results = [];
      for (const a of agents || []) {
        const tier = a.cac_tier || 'explorer';
        const agentEvents = eventsByDid[a.did] || [];
        const score = computeScore(agentEvents, tier);
        results.push({
          did: a.did,
          name: a.name,
          role: a.role,
          agentType: a.agent_type,
          agentSubtype: a.agent_subtype,
          status: a.status,
          cacTier: a.cac_tier || a.cac_tier_name,
          cacStatus: a.cac_status,
          usdcPrepaid: Number(a.usdc_prepaid || 0),
          tokenBalance: Number(a.token_balance || 0),
          ial: a.ial,
          trustScore: score.score,
          trustBand: score.band,
          tierFloor: score.tier_floor,
          lifecycleStatus: a.lifecycle_status,
          stewardshipLadder: a.stewardship_ladder,
          color: a.color,
          operatorDid: a.operator_did,
          memberSince: a.created_at,
        });
      }
      return { agents: results, total: results.length };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 3. agents_create
  // ════════════════════════════════════════════════════════════
  agents_create: {
    name: 'cuttlefishclaws_agents_create',
    description: 'Create a new cuttlefish agent in the cloud registry.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Agent DID (e.g., did:key:z6Mk...)' },
        name: { type: 'string', description: 'Agent display name' },
        role: { type: 'string', description: 'Agent role' },
        agent_type: { type: 'string', description: 'Agent type (default: constitutional)' },
        agent_subtype: { type: 'string', description: 'Agent subtype' },
        operator_did: { type: 'string', description: 'Operator DID' },
        description: { type: 'string', description: 'Agent description' },
        greeting: { type: 'string', description: 'Agent greeting message' },
        color: { type: 'string', description: 'Agent color theme' },
        metadata: { type: 'object', description: 'Additional metadata (JSON object)' },
      },
      required: ['did', 'name'],
    },
    handler: async (args) => {
      const { did, name, role, agent_type, agent_subtype, operator_did,
              description, greeting, color, metadata } = args;
      const [inserted] = await query(
        `INSERT INTO public.cuttlefish_agents
         (did, name, role, agent_type, agent_subtype, operator_did, description, greeting, color, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, did, name, created_at`,
        [did, name, role || null, agent_type || 'constitutional', agent_subtype || null,
         operator_did || null, description || null, greeting || null,
         color || null, JSON.stringify(metadata || {})]
      );
      return {
        success: true,
        id: inserted.id,
        did: inserted.did,
        name: inserted.name,
        createdAt: inserted.created_at,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 4. trust_event_write
  // ════════════════════════════════════════════════════════════
  trust_event_write: {
    name: 'cuttlefishclaws_trust_event_write',
    description: 'Write a trust event for an agent. Computes the new score, applies rubric deltas, and lifecycle transitions.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_did: { type: 'string', description: 'Agent DID' },
        event_type: { type: 'string', description: 'Event type (e.g., VALIDATION_COMPLETED, GOVERNANCE_VOTE, SLASH_APPLIED)' },
        delta: { type: 'number', description: 'Optional: override the delta' },
        reference: { type: 'string', description: 'Optional: reference ID' },
        note: { type: 'string', description: 'Optional: human-readable note' },
        domain: { type: 'string', description: 'Optional: domain tag' },
        evidence_hash: { type: 'string', description: 'Optional: evidence hash' },
      },
      required: ['agent_did', 'event_type'],
    },
    handler: async (args) => {
      const { agent_did, event_type, delta, reference, note, domain, evidence_hash } = args;
      const agent = await query(
        `SELECT cac_tier, lifecycle_status FROM public.cuttlefish_agents WHERE did = $1`, [agent_did]
      );
      if (!agent.length) return { error: 'Agent not found' };
      const tier = agent[0].cac_tier || 'explorer';

      // Determine delta
      const deltaVal = delta !== undefined ? Number(delta) : (RUBRIC[event_type] || 0);

      // Get all events to compute score after
      const allEvents = await query(
        `SELECT event_type, delta, score_after, created_at
         FROM public.cuttlefish_trust_events WHERE agent_did = $1
         ORDER BY created_at ASC`, [agent_did]
      );
      const computed = computeScore(allEvents, tier);
      const scoreAfter = computed.score + deltaVal;
      const clampedScore = Math.max(TG_PARAMS.FLOOR, Math.min(TG_PARAMS.CEIL, scoreAfter));
      const band = getBand(clampedScore);
      const transition = getLifecycleTransition(clampedScore, agent[0].lifecycle_status);

      // Insert event
      const [inserted] = await query(
        `INSERT INTO public.cuttlefish_trust_events
         (agent_did, event_type, delta, score_after, reference, note, domain, evidence_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, event_id, created_at`,
        [agent_did, event_type, deltaVal, clampedScore,
         reference || null, note || null, domain || null, evidence_hash || null]
      );

      // Update agent's trust score
      await query(
        `UPDATE public.cuttlefish_agents
         SET trust_score = $1, trust_band = $2, trust_score_updated_at = NOW(),
             lifecycle_status = COALESCE($3, lifecycle_status),
             updated_at = NOW()
         WHERE did = $4`,
        [clampedScore, band, transition ? transition.to : null, agent_did]
      );

      return {
        success: true,
        did: agent_did,
        eventType: event_type,
        deltaApplied: deltaVal,
        scoreAfter: clampedScore,
        band,
        lifecycleTransition: transition,
        eventId: inserted.event_id,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 5. trust_history
  // ════════════════════════════════════════════════════════════
  trust_history: {
    name: 'cuttlefishclaws_trust_history',
    description: 'Get trust event history for an agent (by did), with computed score replay.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Agent DID' },
      },
      required: ['did'],
    },
    handler: async (args) => {
      const { did } = args;
      const events = await query(
        `SELECT event_id, event_type, delta, score_after, reference, note, domain, created_at
         FROM public.cuttlefish_trust_events WHERE agent_did = $1
         ORDER BY created_at ASC`, [did]
      );
      const agent = await query(
        `SELECT cac_tier FROM public.cuttlefish_agents WHERE did = $1`, [did]
      );
      const tier = agent[0]?.cac_tier || 'explorer';
      const result = computeScore(events || [], tier);
      return {
        did,
        tier,
        currentScore: result.score,
        currentBand: result.band,
        events: (events || []).map(e => ({
          id: e.event_id,
          type: e.event_type,
          delta: Number(e.delta),
          scoreAfter: Number(e.score_after),
          reference: e.reference,
          note: e.note,
          domain: e.domain,
          at: e.created_at,
        })),
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 6. trust_score
  // ════════════════════════════════════════════════════════════
  trust_score: {
    name: 'cuttlefishclaws_trust_score',
    description: 'Get TrustGraph behavioral score for an agent (by did). Returns 0-100 score, band, tier floor, lifecycle status, and recent events.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Agent DID (e.g., did:key:z6Mk...)' },
      },
      required: ['did'],
    },
    handler: async (args) => {
      const { did } = args;
      const agent = await query(
        `SELECT did, name, cac_tier, trust_score, trust_band, lifecycle_status,
                agent_type, agent_subtype, created_at
         FROM public.cuttlefish_agents WHERE did = $1`, [did]
      );
      if (!agent.length) return { error: 'Agent not found' };
      const events = await query(
        `SELECT event_type, delta, score_after, note, created_at
         FROM public.cuttlefish_trust_events WHERE agent_did = $1
         ORDER BY created_at DESC LIMIT 10`, [did]
      );
      const tier = agent[0].cac_tier || 'explorer';
      const allEvents = await query(
        `SELECT event_type, delta, created_at
         FROM public.cuttlefish_trust_events WHERE agent_did = $1
         ORDER BY created_at ASC`, [did]
      );
      const result = computeScore(allEvents, tier);
      return {
        did: agent[0].did,
        name: agent[0].name,
        trustScore: result.score,
        band: result.band,
        tierFloor: result.tier_floor,
        status: result.status,
        belowFloor: result.below_floor,
        lifecycleStatus: agent[0].lifecycle_status,
        agentType: agent[0].agent_type,
        memberSince: agent[0].created_at,
        recentEvents: (events || []).map(e => ({
          type: e.event_type,
          delta: Number(e.delta),
          scoreAfter: Number(e.score_after),
          note: e.note,
          at: e.created_at,
        })),
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 7. standing_event_write
  // ════════════════════════════════════════════════════════════
  standing_event_write: {
    name: 'cuttlefishclaws_standing_event_write',
    description: 'Write a stewardship standing event for an agent in a domain. Updates the EWMA score and ladder tier.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Agent DID' },
        domain: { type: 'string', description: 'Domain' },
        event_type: { type: 'string', description: 'Event type' },
        quality_score: { type: 'number', description: 'Quality score (0-100)' },
        reference: { type: 'string', description: 'Optional reference' },
        note: { type: 'string', description: 'Optional note' },
      },
      required: ['did', 'domain', 'event_type'],
    },
    handler: async (args) => {
      const { did, domain, event_type, quality_score, reference, note } = args;
      const qs = quality_score !== undefined ? Number(quality_score) : 50;

      // Get existing events for this agent/domain
      const existingEvents = await query(
        `SELECT quality_score, delta, standing_after, created_at
         FROM public.cuttlefish_standing_events
         WHERE agent_did = $1 AND domain = $2
         ORDER BY created_at ASC`, [did, domain]
      );

      // Compute standing from events
      const computed = computeStanding(existingEvents);
      const delta = (qs - 50) / 50 * 10;
      const standingAfter = Math.max(0, Math.min(100,
        computed.standing * (1 - SS_PARAMS.ALPHA) + (computed.standing + delta) * SS_PARAMS.ALPHA
      ));

      // Insert event
      const [inserted] = await query(
        `INSERT INTO public.cuttlefish_standing_events
         (agent_did, domain, event_type, quality_score, delta, standing_after, reference, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, event_id, created_at`,
        [did, domain, event_type, qs, delta, standingAfter, reference || null, note || null]
      );

      // Upsert standing record
      await query(
        `INSERT INTO public.cuttlefish_stewardship_standing
         (agent_did, domain, standing_value, ladder_tier, last_event_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE
         SET standing_value = EXCLUDED.standing_value,
             ladder_tier = EXCLUDED.ladder_tier,
             last_event_at = NOW(),
             updated_at = NOW()
         WHERE cuttlefish_stewardship_standing.agent_did = $1
           AND cuttlefish_stewardship_standing.domain = $2`,
        [did, domain, standingAfter, getLadderTier(standingAfter)]
      );

      return {
        success: true,
        did,
        domain,
        standing: standingAfter,
        ladderTier: getLadderTier(standingAfter),
        eventId: inserted.event_id,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 8. standing_get
  // ════════════════════════════════════════════════════════════
  standing_get: {
    name: 'cuttlefishclaws_standing_get',
    description: 'Get stewardship standing for an agent (by did, optional domain). Returns ladder tier, provisional status, and council eligibility.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Agent DID' },
        domain: { type: 'string', description: 'Optional domain (if omitted, returns all domains)' },
      },
      required: ['did'],
    },
    handler: async (args) => {
      const { did, domain } = args;

      if (domain) {
        // Specific domain
        const events = await query(
          `SELECT event_type, quality_score, delta, standing_after, note, created_at
           FROM public.cuttlefish_standing_events
           WHERE agent_did = $1 AND domain = $2
           ORDER BY created_at DESC LIMIT 10`, [did, domain]
        );
        const allEvents = await query(
          `SELECT quality_score, delta, created_at
           FROM public.cuttlefish_standing_events
           WHERE agent_did = $1 AND domain = $2
           ORDER BY created_at ASC`, [did, domain]
        );
        const computed = computeStanding(allEvents);
        return {
          did,
          domain,
          standing: computed.standing,
          ladderTier: computed.ladder_tier,
          provisional: computed.provisional,
          capActive: computed.cap_active,
          eventCount: computed.event_count,
          recentEvents: (events || []).map(e => ({
            type: e.event_type,
            qualityScore: Number(e.quality_score),
            delta: Number(e.delta),
            standingAfter: Number(e.standing_after),
            note: e.note,
            at: e.created_at,
          })),
        };
      }

      // All domains
      const domains = await query(
        `SELECT domain, standing_value, ladder_tier, last_event_at, updated_at
         FROM public.cuttlefish_stewardship_standing
         WHERE agent_did = $1
         ORDER BY domain`, [did]
      );
      // If no standing records, compute from events
      if (!domains.length) {
        const domainEvents = await query(
          `SELECT domain, quality_score, delta, created_at
           FROM public.cuttlefish_standing_events
           WHERE agent_did = $1
           ORDER BY created_at ASC`, [did]
        );
        const byDomain = {};
        for (const ev of domainEvents || []) {
          if (!byDomain[ev.domain]) byDomain[ev.domain] = [];
          byDomain[ev.domain].push(ev);
        }
        const results = Object.entries(byDomain).map(([dom, evts]) => {
          const computed = computeStanding(evts);
          return {
            domain: dom,
            standing: computed.standing,
            ladderTier: computed.ladder_tier,
            provisional: computed.provisional,
            capActive: computed.cap_active,
            eventCount: computed.event_count,
          };
        });
        return {
          did,
          domains: results,
          councilEligible: isCouncilEligible(results),
        };
      }
      const results = (domains || []).map(d => ({
        domain: d.domain,
        standing: Number(d.standing_value),
        ladderTier: d.ladder_tier,
        lastEventAt: d.last_event_at,
      }));
      return {
        did,
        domains: results,
        councilEligible: isCouncilEligible(results),
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 9. gate_evaluate
  // ════════════════════════════════════════════════════════════
  gate_evaluate: {
    name: 'cuttlefishclaws_gate_evaluate',
    description: 'Evaluate the standing gate: "may this actor be rewarded for this activity, now?" Checks TrustGraph + Standing + CAC tier + IAL. Fail-closed on any axis.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_did: { type: 'string', description: 'Agent DID' },
        activity_type: { type: 'string', description: 'Activity type (e.g., VALIDATION_COMPLETED, GOVERNANCE_VOTE)' },
        domain: { type: 'string', description: 'Domain' },
        purpose: { type: 'string', description: 'Purpose (write, read, admin)', default: 'write' },
      },
      required: ['agent_did', 'activity_type', 'domain'],
    },
    handler: async (args) => {
      const { agent_did, activity_type, domain, purpose } = args;
      const reqs = ACTIVITY_REQUIREMENTS[activity_type] || ACTIVITY_REQUIREMENTS._default;

      // Fetch agent data
      const agent = await query(
        `SELECT cac_tier, ial, lifecycle_status, trust_band FROM public.cuttlefish_agents WHERE did = $1`,
        [agent_did]
      );
      if (!agent.length) {
        return { allowed: false, agent_did, activity_type, domain, reasons: ['Agent not found'], purpose: purpose || 'write' };
      }

      // Compute trust score
      const trustEvents = await query(
        `SELECT event_type, delta, created_at FROM public.cuttlefish_trust_events
         WHERE agent_did = $1 ORDER BY created_at ASC`, [agent_did]
      );
      const tgScore = computeScore(trustEvents, agent[0].cac_tier || 'explorer');

      // Compute standing
      const standingEvents = await query(
        `SELECT quality_score, delta, created_at FROM public.cuttlefish_standing_events
         WHERE agent_did = $1 AND domain = $2 ORDER BY created_at ASC`, [agent_did, domain]
      );
      const standing = computeStanding(standingEvents);

      // Evaluate axes
      const reasons = [];
      let allowed = true;

      // TrustGraph check
      if (tgScore.score < reqs.trustgraph.min_score) {
        reasons.push(`TrustGraph score ${tgScore.score} below required ${reqs.trustgraph.min_score}`);
        allowed = false;
      }
      if (reqs.trustgraph.min_status === 'active' && tgScore.status !== 'active') {
        reasons.push(`TrustGraph status '${tgScore.status}' below required 'active'`);
        allowed = false;
      }

      // Standing check
      if (standing.standing < reqs.standing.min_value) {
        reasons.push(`Standing ${standing.standing} below required ${reqs.standing.min_value}`);
        allowed = false;
      }
      const tierOrder = ['Participant', 'Steward', 'Custodian'];
      const agentTierIdx = tierOrder.indexOf(standing.ladder_tier);
      const minTierIdx = tierOrder.indexOf(reqs.standing.min_ladder);
      if (agentTierIdx < minTierIdx) {
        reasons.push(`Standing ladder '${standing.ladder_tier}' below required '${reqs.standing.min_ladder}'`);
        allowed = false;
      }

      // CAC tier check
      const cacTier = agent[0].cac_tier || 'explorer';
      const cacTierIdx = CAC_TIER_ORDER.indexOf(cacTier);
      const minCacIdx = CAC_TIER_ORDER.indexOf(reqs.cac.min_tier);
      if (cacTierIdx < minCacIdx) {
        reasons.push(`CAC tier '${cacTier}' below required '${reqs.cac.min_tier}'`);
        allowed = false;
      }

      // IAL check
      const agentIal = agent[0].ial || 'IAL2';
      const ialNum = parseInt(agentIal.replace('IAL', '')) || 2;
      const reqIalNum = parseInt((reqs.ial || 'IAL2').replace('IAL', '')) || 2;
      if (ialNum < reqIalNum) {
        reasons.push(`IAL '${agentIal}' below required '${reqs.ial}'`);
        allowed = false;
      }

      // Audit log
      await query(
        `INSERT INTO public.cuttlefish_gate_decisions
         (agent_did, activity_type, domain, cac_tier, ial, allowed,
          trustgraph_score, trustgraph_status, standing_value, standing_ladder,
          reasons, purpose)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [agent_did, activity_type, domain, cacTier, agentIal, allowed,
         tgScore.score, tgScore.status, standing.standing, standing.ladder_tier,
         JSON.stringify(reasons), purpose || 'write']
      );

      return {
        allowed,
        agent_did,
        activity_type,
        domain,
        cac_tier: cacTier,
        ial: agentIal,
        trustgraph: { score: tgScore.score, band: tgScore.band, status: tgScore.status },
        standing: { value: standing.standing, ladder_tier: standing.ladder_tier },
        reasons: reasons.length ? reasons : ['All checks passed'],
        purpose: purpose || 'write',
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 10. gate_thresholds
  // ════════════════════════════════════════════════════════════
  gate_thresholds: {
    name: 'cuttlefishclaws_gate_thresholds',
    description: 'Get SGQ-001 thresholds for an activity type. Shows what TrustGraph score, Standing, CAC tier, and IAL are required.',
    inputSchema: {
      type: 'object',
      properties: {
        activity_type: { type: 'string', description: 'Activity type (optional — returns defaults if omitted)' },
      },
    },
    handler: async (args) => {
      const { activity_type } = args;
      const reqs = ACTIVITY_REQUIREMENTS[activity_type] || ACTIVITY_REQUIREMENTS._default;
      return { activity_type: activity_type || '_default', required: reqs };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 11. activity_event_write
  // ════════════════════════════════════════════════════════════
  activity_event_write: {
    name: 'cuttlefishclaws_activity_event_write',
    description: 'Write a signed, hash-chained activity event to the registry.',
    inputSchema: {
      type: 'object',
      properties: {
        actor_kya_id: { type: 'string', description: 'KYA ID of the actor' },
        agent_did: { type: 'string', description: 'Agent DID' },
        activity_type: { type: 'string', description: 'Activity type' },
        evidence_hash: { type: 'string', description: 'SHA-256 hash of the evidence' },
        domain: { type: 'string', description: 'Optional domain' },
        work_unit: { type: 'object', description: 'Optional work unit { quantity, unit, quality_score }' },
        reward_eligibility: { type: 'object', description: 'Optional reward eligibility flags' },
        signature: { type: 'string', description: 'Optional KYA signature' },
        section_404_category: { type: 'string', description: 'Optional §404 category' },
      },
      required: ['actor_kya_id', 'agent_did', 'activity_type', 'evidence_hash'],
    },
    handler: async (args) => {
      const { actor_kya_id, agent_did, activity_type, evidence_hash, domain,
              work_unit, section_404_category, reward_eligibility, signature } = args;

      const lastEvent = await query(
        `SELECT current_hash FROM public.cuttlefish_activity_registry
         WHERE agent_did = $1 ORDER BY id DESC LIMIT 1`, [agent_did]
      );
      const previousHash = lastEvent[0]?.current_hash || null;
      const timestamp = new Date().toISOString();
      const hashInput = (previousHash || '') + evidence_hash + agent_did + activity_type + timestamp;
      const currentHash = crypto.createHash('sha256').update(hashInput).digest('hex');

      const [inserted] = await query(
        `INSERT INTO public.cuttlefish_activity_registry
         (actor_kya_id, agent_did, activity_type, domain, work_unit, evidence_hash,
          section_404_category, reward_eligibility, signature, previous_hash, current_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, event_id, created_at`,
        [actor_kya_id, agent_did, activity_type, domain || null,
         JSON.stringify(work_unit || {}), evidence_hash,
         section_404_category || null, JSON.stringify(reward_eligibility || {}),
         signature || '', previousHash, currentHash]
      );

      // Auto-write trust event if this activity type has a TG delta
      const tgDelta = deltaForActivity(activity_type, work_unit || {});
      let trustResult = null;
      if (tgDelta !== 0) {
        const agent = await query(
          `SELECT cac_tier, lifecycle_status FROM public.cuttlefish_agents WHERE did = $1`, [agent_did]
        );
        if (agent.length) {
          const tier = agent[0].cac_tier || 'explorer';
          const allEvents = await query(
            `SELECT event_type, delta, created_at FROM public.cuttlefish_trust_events
             WHERE agent_did = $1 ORDER BY created_at ASC`, [agent_did]
          );
          const computed = computeScore(allEvents, tier);
          const scoreAfter = Math.max(TG_PARAMS.FLOOR, Math.min(TG_PARAMS.CEIL, computed.score + tgDelta));
          await query(
            `INSERT INTO public.cuttlefish_trust_events
             (agent_did, event_type, delta, score_after, reference, note, domain, evidence_hash, ar_event_ref)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [agent_did, activity_type, tgDelta, scoreAfter,
             `AR-001:${inserted.event_id}`, 'Auto-generated from activity registry',
             domain || null, evidence_hash, inserted.event_id]
          );
          await query(
            `UPDATE public.cuttlefish_agents
             SET trust_score = $1, trust_band = $2, trust_score_updated_at = NOW(), updated_at = NOW()
             WHERE did = $3`,
            [scoreAfter, getBand(scoreAfter), agent_did]
          );
          trustResult = { delta: tgDelta, scoreAfter };
        }
      }

      return {
        success: true,
        eventId: inserted.event_id,
        registryId: inserted.id,
        currentHash,
        previousHash,
        trustGraphDelta: tgDelta,
        trustGraphResult: trustResult,
        createdAt: inserted.created_at,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 12. rate_card
  // ════════════════════════════════════════════════════════════
  rate_card: {
    name: 'cuttlefishclaws_rate_card',
    description: 'Get the current reward rate card. Shows base rates, minimum amounts, per-event caps, and quality multipliers per activity type.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const rates = await query(
        `SELECT version, activity_type, base_rate, min_amount, per_event_cap,
                quality_multiplier_default, section_404_category, effective_from,
                effective_until, is_active
         FROM public.cuttlefish_rate_card
         WHERE is_active = true
         ORDER BY activity_type`
      );
      return {
        version: rates[0]?.version || 'unknown',
        rates: (rates || []).map(r => ({
          activityType: r.activity_type,
          baseRate: Number(r.base_rate),
          minAmount: Number(r.min_amount || 0),
          perEventCap: r.per_event_cap ? Number(r.per_event_cap) : null,
          qualityMultiplierDefault: Number(r.quality_multiplier_default || 1.0),
          section404Category: r.section_404_category,
          effectiveFrom: r.effective_from,
          effectiveUntil: r.effective_until,
        })),
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 13. cac_credentials
  // ════════════════════════════════════════════════════════════
  cac_credentials: {
    name: 'cuttlefishclaws_cac_credentials',
    description: 'List CAC credentials, optionally filtered by agent_did.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_did: { type: 'string', description: 'Optional: filter by agent DID' },
      },
    },
    handler: async (args) => {
      const { agent_did } = args;
      let sql = `SELECT id, agent_did, tier, usdc_prepaid, token_balance, status,
                        issued_at, expires_at, created_at, chain_tx_hash,
                        cac_address, operator_address, rollover_expires_at, last_topup_at
                 FROM public.cuttlefish_cac_credentials`;
      const params = [];
      if (agent_did) {
        sql += ` WHERE agent_did = $1 ORDER BY id DESC`;
        params.push(agent_did);
      } else {
        sql += ` ORDER BY id DESC`;
      }
      const creds = await query(sql, params);
      return {
        credentials: (creds || []).map(c => ({
          id: c.id,
          agentDid: c.agent_did,
          tier: c.tier,
          usdcPrepaid: Number(c.usdc_prepaid || 0),
          tokenBalance: Number(c.token_balance || 0),
          status: c.status,
          issuedAt: c.issued_at,
          expiresAt: c.expires_at,
          createdAt: c.created_at,
          chainTxHash: c.chain_tx_hash,
          cacAddress: c.cac_address,
          operatorAddress: c.operator_address,
        })),
        total: (creds || []).length,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 14. cac_create
  // ════════════════════════════════════════════════════════════
  cac_create: {
    name: 'cuttlefishclaws_cac_create',
    description: 'Issue a CAC credential for an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_did: { type: 'string', description: 'Agent DID' },
        tier: { type: 'string', description: 'CAC tier (explorer, builder, anchor)', default: 'explorer' },
        usdc_prepaid: { type: 'number', description: 'USDC prepaid amount', default: 0 },
        token_balance: { type: 'number', description: 'Token balance', default: 0 },
      },
      required: ['agent_did'],
    },
    handler: async (args) => {
      const { agent_did, tier, usdc_prepaid, token_balance } = args;
      const [inserted] = await query(
        `INSERT INTO public.cuttlefish_cac_credentials
         (agent_did, tier, usdc_prepaid, token_balance, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING id, agent_did, tier, usdc_prepaid, token_balance, status, issued_at`,
        [agent_did, tier || 'explorer', Number(usdc_prepaid || 0), Number(token_balance || 0)]
      );

      // Update agent's cac_tier
      await query(
        `UPDATE public.cuttlefish_agents SET cac_tier = $1, updated_at = NOW() WHERE did = $2`,
        [tier || 'explorer', agent_did]
      );

      return {
        success: true,
        credentialId: inserted.id,
        agentDid: inserted.agent_did,
        tier: inserted.tier,
        usdcPrepaid: Number(inserted.usdc_prepaid),
        tokenBalance: Number(inserted.token_balance),
        status: inserted.status,
        issuedAt: inserted.issued_at,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 15. proposals_list
  // ════════════════════════════════════════════════════════════
  proposals_list: {
    name: 'cuttlefishclaws_proposals_list',
    description: 'List proposals, optionally filtered by status and category.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional: filter by status' },
        category: { type: 'string', description: 'Optional: filter by category' },
      },
    },
    handler: async (args) => {
      const { status, category } = args;
      let sql = `SELECT id, title, description, category, submitter_did, version,
                        parent_id, status, ipfs_cid, chain_anchor_tx, combined_hash,
                        routed_to, metadata, created_at, trust_score_delta, arweave_tx, updated_at
                 FROM public.cuttlefish_proposals`;
      const conditions = [];
      const params = [];
      if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
      if (category) { params.push(category); conditions.push(`category = $${params.length}`); }
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY created_at DESC';
      const proposals = await query(sql, params);
      return {
        proposals: (proposals || []).map(p => ({
          id: p.id,
          title: p.title,
          description: p.description,
          category: p.category,
          submitterDid: p.submitter_did,
          version: p.version,
          status: p.status,
          createdAt: p.created_at,
          trustScoreDelta: p.trust_score_delta ? Number(p.trust_score_delta) : null,
        })),
        total: (proposals || []).length,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 16. proposal_create
  // ════════════════════════════════════════════════════════════
  proposal_create: {
    name: 'cuttlefishclaws_proposal_create',
    description: 'Create a new proposal.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Proposal title' },
        description: { type: 'string', description: 'Proposal description' },
        category: { type: 'string', description: 'Category (default: general)' },
        submitter_did: { type: 'string', description: 'Submitter DID' },
      },
      required: ['title', 'submitter_did'],
    },
    handler: async (args) => {
      const { title, description, category, submitter_did } = args;
      const [inserted] = await query(
        `INSERT INTO public.cuttlefish_proposals
         (title, description, category, submitter_did, status)
         VALUES ($1, $2, $3, $4, 'submitted')
         RETURNING id, title, status, created_at`,
        [title, description || null, category || 'general', submitter_did]
      );
      return {
        success: true,
        id: inserted.id,
        title: inserted.title,
        status: inserted.status,
        createdAt: inserted.created_at,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 17. council_list
  // ════════════════════════════════════════════════════════════
  council_list: {
    name: 'cuttlefishclaws_council_list',
    description: 'List all council members.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const members = await query(
        `SELECT c.id, c.member_did, c.role, c.domain, c.seated_at, c.term_expires_at,
                c.status, c.metadata, a.name, a.agent_type
         FROM public.cuttlefish_council c
         LEFT JOIN public.cuttlefish_agents a ON a.did = c.member_did
         WHERE c.status = 'seated'
         ORDER BY c.seated_at DESC`
      );
      return {
        members: (members || []).map(m => ({
          id: m.id,
          memberDid: m.member_did,
          name: m.name,
          role: m.role,
          domain: m.domain,
          seatedAt: m.seated_at,
          termExpiresAt: m.term_expires_at,
          status: m.status,
        })),
        total: (members || []).length,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 18. social_posts_list
  // ════════════════════════════════════════════════════════════
  social_posts_list: {
    name: 'cuttlefishclaws_social_posts_list',
    description: 'List social posts, optionally filtered by agent_did, platform, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_did: { type: 'string', description: 'Optional: filter by agent DID' },
        platform: { type: 'string', description: 'Optional: filter by platform' },
        status: { type: 'string', description: 'Optional: filter by status' },
      },
    },
    handler: async (args) => {
      const { agent_did, platform, status } = args;
      let sql = `SELECT id, agent_did, platform, content_en, content_native, language,
                        hashtags, is_milestone, constitutional_score, flags,
                        operator_approved, trib_approved, status, posted_at, post_url, created_at
                 FROM public.cuttlefish_social_posts`;
      const conditions = [];
      const params = [];
      if (agent_did) { params.push(agent_did); conditions.push(`agent_did = $${params.length}`); }
      if (platform) { params.push(platform); conditions.push(`platform = $${params.length}`); }
      if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY created_at DESC';
      const posts = await query(sql, params);
      return {
        posts: (posts || []).map(p => ({
          id: p.id,
          agentDid: p.agent_did,
          platform: p.platform,
          contentEn: p.content_en,
          contentNative: p.content_native,
          language: p.language,
          hashtags: p.hashtags,
          isMilestone: p.is_milestone,
          status: p.status,
          postedAt: p.posted_at,
          postUrl: p.post_url,
          createdAt: p.created_at,
        })),
        total: (posts || []).length,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 19. social_post_create
  // ════════════════════════════════════════════════════════════
  social_post_create: {
    name: 'cuttlefishclaws_social_post_create',
    description: 'Create a social post for an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_did: { type: 'string', description: 'Agent DID' },
        platform: { type: 'string', description: 'Platform (e.g., twitter, discord)' },
        content_en: { type: 'string', description: 'Content in English' },
        content_native: { type: 'string', description: 'Optional: content in native language' },
        language: { type: 'string', description: 'Optional: language code' },
        hashtags: { type: 'array', items: { type: 'string' }, description: 'Optional: hashtags' },
        is_milestone: { type: 'boolean', description: 'Optional: is this a milestone post?', default: false },
      },
      required: ['agent_did', 'platform', 'content_en'],
    },
    handler: async (args) => {
      const { agent_did, platform, content_en, content_native, language, hashtags, is_milestone } = args;
      const [inserted] = await query(
        `INSERT INTO public.cuttlefish_social_posts
         (agent_did, platform, content_en, content_native, language, hashtags, is_milestone, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
         RETURNING id, status, created_at`,
        [agent_did, platform, content_en, content_native || null,
         language || null, hashtags || null, is_milestone || false]
      );
      return {
        success: true,
        id: inserted.id,
        status: inserted.status,
        createdAt: inserted.created_at,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 20. chat_messages_list
  // ════════════════════════════════════════════════════════════
  chat_messages_list: {
    name: 'cuttlefishclaws_chat_messages_list',
    description: 'List chat messages, optionally filtered by agent_id.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Optional: filter by agent ID' },
      },
    },
    handler: async (args) => {
      const { agent_id } = args;
      let sql = `SELECT id, agent_id, conversation_id, user_message, agent_response, simulated, created_at
                 FROM public.cuttlefish_chat_messages`;
      const params = [];
      if (agent_id) {
        sql += ` WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 100`;
        params.push(agent_id);
      } else {
        sql += ` ORDER BY created_at DESC LIMIT 100`;
      }
      const messages = await query(sql, params);
      return {
        messages: (messages || []).map(m => ({
          id: m.id,
          agentId: m.agent_id,
          conversationId: m.conversation_id,
          userMessage: m.user_message,
          agentResponse: m.agent_response,
          simulated: m.simulated,
          createdAt: m.created_at,
        })),
        total: (messages || []).length,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 21. chat_message_create
  // ════════════════════════════════════════════════════════════
  chat_message_create: {
    name: 'cuttlefishclaws_chat_message_create',
    description: 'Create a chat message record.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent ID' },
        conversation_id: { type: 'string', description: 'Optional: conversation ID' },
        user_message: { type: 'string', description: 'User message' },
        agent_response: { type: 'string', description: 'Optional: agent response' },
        simulated: { type: 'boolean', description: 'Optional: is this simulated?', default: false },
      },
      required: ['agent_id', 'user_message'],
    },
    handler: async (args) => {
      const { agent_id, conversation_id, user_message, agent_response, simulated } = args;
      const [inserted] = await query(
        `INSERT INTO public.cuttlefish_chat_messages
         (agent_id, conversation_id, user_message, agent_response, simulated)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at`,
        [agent_id, conversation_id || null, user_message,
         agent_response || null, simulated ? 1 : 0]
      );
      return {
        success: true,
        id: inserted.id,
        createdAt: inserted.created_at,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 22. capital_stack
  // ════════════════════════════════════════════════════════════
  capital_stack: {
    name: 'cuttlefishclaws_capital_stack',
    description: 'Get capital stack data.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const rows = await query(
        `SELECT layer_key, name, sub_label, amount_m, pct_of_total, color,
                seniority, yield_score, coverage, description, details,
                display_order, is_active, is_open
         FROM public.cuttlefish_capital_stack
         WHERE is_active = 1
         ORDER BY display_order, seniority`
      );
      return {
        layers: (rows || []).map(r => ({
          layerKey: r.layer_key,
          name: r.name,
          subLabel: r.sub_label,
          amountM: Number(r.amount_m || 0),
          pctOfTotal: Number(r.pct_of_total || 0),
          color: r.color,
          seniority: r.seniority,
          yieldScore: Number(r.yield_score || 0),
          coverage: Number(r.coverage || 0),
          description: r.description,
          details: r.details,
          displayOrder: r.display_order,
          isOpen: r.is_open,
        })),
        total: (rows || []).length,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 23. financing_programs
  // ════════════════════════════════════════════════════════════
  financing_programs: {
    name: 'cuttlefishclaws_financing_programs',
    description: 'List financing programs.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const rows = await query(
        `SELECT program_key, name, category, administering_entity, applies_to,
                headline, amount_range, rate_or_credit, term_years,
                eligibility, application_url, contact, notes,
                display_order, is_active
         FROM public.cuttlefish_financing_programs
         WHERE is_active = 1
         ORDER BY display_order`
      );
      return {
        programs: (rows || []).map(r => ({
          programKey: r.program_key,
          name: r.name,
          category: r.category,
          administeringEntity: r.administering_entity,
          appliesTo: r.applies_to,
          headline: r.headline,
          amountRange: r.amount_range,
          rateOrCredit: r.rate_or_credit,
          termYears: r.term_years,
          eligibility: r.eligibility,
          applicationUrl: r.application_url,
          contact: r.contact,
          notes: r.notes,
          displayOrder: r.display_order,
        })),
        total: (rows || []).length,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 24. scenarios_list
  // ════════════════════════════════════════════════════════════
  scenarios_list: {
    name: 'cuttlefishclaws_scenarios_list',
    description: 'List scenarios, optionally filtered by tier.',
    inputSchema: {
      type: 'object',
      properties: {
        tier: { type: 'string', description: 'Optional: filter by tier' },
      },
    },
    handler: async (args) => {
      const { tier } = args;
      let sql = `SELECT id, tier, name, subtitle, multiple, multiple_color,
                        featured, metrics, display_order, created_at
                 FROM public.cuttlefish_scenarios`;
      const params = [];
      if (tier) {
        sql += ` WHERE tier = $1`;
        params.push(tier);
      }
      sql += ` ORDER BY display_order, created_at DESC`;
      const scenarios = await query(sql, params);
      return {
        scenarios: (scenarios || []).map(s => ({
          id: s.id,
          tier: s.tier,
          name: s.name,
          subtitle: s.subtitle,
          multiple: s.multiple,
          multipleColor: s.multiple_color,
          featured: s.featured,
          metrics: s.metrics,
          displayOrder: s.display_order,
          createdAt: s.created_at,
        })),
        total: (scenarios || []).length,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 25. engine_health
  // ════════════════════════════════════════════════════════════
  engine_health: {
    name: 'cuttlefishclaws_engine_health',
    description: 'Check if cloud Supabase is reachable + table counts for all cuttlefish tables.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const tables = [
        'cuttlefish_agents', 'cuttlefish_cac_credentials', 'cuttlefish_trust_events',
        'cuttlefish_standing_events', 'cuttlefish_stewardship_standing',
        'cuttlefish_activity_registry', 'cuttlefish_gate_decisions',
        'cuttlefish_kya_bindings', 'cuttlefish_kya_acknowledgements',
        'cuttlefish_kya_successions', 'cuttlefish_proposals', 'cuttlefish_council',
        'cuttlefish_rate_card', 'cuttlefish_reward_distributions',
        'cuttlefish_contracts', 'cuttlefish_constitutions', 'cuttlefish_chat_messages',
        'cuttlefish_social_posts', 'cuttlefish_capital_stack',
        'cuttlefish_financing_programs', 'cuttlefish_scenarios',
        'cuttlefish_stewardship_reviews', 'cuttlefish_agent_tasks',
      ];
      const counts = {};
      let reachable = true;
      try {
        for (const table of tables) {
          try {
            const rows = await query(`SELECT COUNT(*) AS cnt FROM public.${table}`);
            counts[table] = Number(rows[0]?.cnt || 0);
          } catch (e) {
            counts[table] = `error: ${e.message}`;
          }
        }
      } catch (e) {
        reachable = false;
      }
      return {
        status: reachable ? 'ok' : 'degraded',
        supabaseUrl: SUPABASE_URL,
        supabaseProjectRef: SUPABASE_PROJECT_REF,
        engines: {
          trustgraph: { spec: 'TG-001 v1.0', version: '1.0.0', params: { CEIL: TG_PARAMS.CEIL, DECAY: TG_PARAMS.DECAY, CAP: TG_PARAMS.CAP } },
          standing: { spec: 'SS-001 v1.0', version: '1.0.0', params: { ALPHA: SS_PARAMS.ALPHA, CAP: SS_PARAMS.CAP_DEFAULT } },
          gate: { spec: 'SGQ-001 v1.0', version: '1.0.0', activityTypes: Object.keys(ACTIVITY_REQUIREMENTS).length - 1 },
          activityRegistry: { spec: 'AR-001', version: '1.0.0' },
        },
        tableCounts: counts,
        totalTables: tables.length,
        timestamp: new Date().toISOString(),
      };
    },
  },
};

// ── MCP Request Handler ─────────────────────────────────────
async function handleRequest(req) {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      return mcpResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {} },
        serverInfo: {
          name: 'cuttlefishclaws-mcp',
          version: '1.0.0',
        },
      });

    case 'tools/list':
      return mcpResult(id, {
        tools: Object.values(TOOLS).map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const tool = Object.values(TOOLS).find(t => t.name === params.name);
      if (!tool) return mcpError(id, -32601, `Unknown tool: ${params.name}`);
      try {
        const result = await tool.handler(params.arguments || {});
        return mcpResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        return mcpError(id, -32603, err.message);
      }
    }

    case 'notifications/initialized':
      return null;

    default:
      return mcpError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Transport: stdio ────────────────────────────────────────
let buffer = '';
function onStdioData(chunk) {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const req = JSON.parse(trimmed);
      handleRequest(req).then(response => {
        if (response) sendMessage(response);
      });
    } catch (e) { /* Ignore malformed JSON */ }
  }
}

function sendMessage(msg) {
  if (msg) process.stdout.write(JSON.stringify(msg) + '\n');
}

// ── Transport: HTTP (optional) ──────────────────────────────
function startHttp(port) {
  import('http').then(http => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const jsonReq = JSON.parse(body);
            handleRequest(jsonReq).then(response => {
              if (response) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
              } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'ok' }] } }));
              }
            });
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>CuttlefishClaws Cloud MCP Server</title>
<style>body{font-family:monospace;background:#0a0a0f;color:#34d399;max-width:600px;margin:40px auto;padding:20px}
h1{color:#34d399;border-bottom:1px solid #34d399;padding-bottom:8px}
pre{background:#1a1a2e;padding:12px;border-radius:6px;overflow-x:auto}</style></head><body>
<h1>🐙 CuttlefishClaws Cloud MCP Server</h1>
<p>Cloud Redundancy for Cuttlefish Protocol — Supabase: llulpuhtlxzsxxbsfcuu</p>
<p>TG-001 · SS-001 · SGQ-001 · AR-001</p>
<h2>Available Tools</h2>
<pre>${Object.values(TOOLS).map(t => t.name).join('\n')}</pre>
<h2>Connect</h2>
<p><b>Stdio:</b> <code>node cuttlefishclaws-mcp.mjs</code></p>
<p><b>HTTP:</b> <code>http://localhost:${port}/</code></p>
</body></html>`);
      }
    });
    server.listen(port, () => {
      console.error(`[CuttlefishClaws MCP] HTTP server listening on http://127.0.0.1:${port}`);
      console.error(`[CuttlefishClaws MCP] ${Object.keys(TOOLS).length} tools registered`);
    });
  });
}

// ── Entry Point ─────────────────────────────────────────────
const useHttp = process.argv.includes('--http');
const portIdx = process.argv.indexOf('--port');
const port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1]) : 3120;

console.error(`[CuttlefishClaws MCP] Starting CuttlefishClaws Cloud Redundancy MCP Server v1.0.0`);
console.error(`[CuttlefishClaws MCP] Supabase: ${SUPABASE_URL}`);
console.error(`[CuttlefishClaws MCP] Engines: TG-001, SS-001, SGQ-001, AR-001`);
console.error(`[CuttlefishClaws MCP] Transport: ${useHttp ? `HTTP on :${port}` : 'stdio'}`);
console.error(`[CuttlefishClaws MCP] ${Object.keys(TOOLS).length} tools registered`);

if (useHttp) {
  startHttp(port);
} else {
  process.stdin.on('data', onStdioData);
  process.stdin.on('end', () => process.exit(0));
}