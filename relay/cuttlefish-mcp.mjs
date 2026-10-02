#!/usr/bin/env node
/**
 * cuttlefish-mcp.mjs — Cuttlefish Labs MCP Server
 *
 * Standalone MCP server exposing the Cuttlefish Protocol engines
 * (TG-001 TrustGraph, SS-001 Stewardship Standing, SGQ-001 Standing Gate,
 *  AR-001 Activity Registry, KYA-002 Identity, VOCAB-001 Glossary Guardrail)
 * as MCP tools for any MCP client (Claude Desktop, Codex, Hermes, etc.).
 *
 * Branded for Cuttlefish Labs / CuttlefishClaws — separate from the XMRT DAO relay.
 *
 * Usage:
 *   node cuttlefish-mcp.mjs                    # stdio transport (default for MCP)
 *   node cuttlefish-mcp.mjs --http              # HTTP transport on port 3100
 *   node cuttlefish-mcp.mjs --http --port 3101  # custom port
 *
 * MCP config for Claude Desktop:
 *   {
 *     "mcpServers": {
 *       "cuttlefish": {
 *         "command": "node",
 *         "args": ["path/to/cuttlefish-mcp.mjs"]
 *       }
 *     }
 *   }
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'relay-data');
mkdirSync(DATA_DIR, { recursive: true });

// ── Load .env ──────────────────────────────────────────────
function loadEnv() {
  const envPath = join(ROOT, 'relay', '.env');
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

// ── DB Connection ──────────────────────────────────────────
import pg from 'pg';
import { POOL_CONFIG } from './lib/pool-config.mjs';
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.LOCAL_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
  ...POOL_CONFIG.mcp,
});

// Prevent crash on pool-level errors (ECONNRESET, PG restart, etc.)
pool.on('error', (err) => {
  console.error('[Cuttlefish MCP] Pool error (non-fatal):', err.message);
});

async function query(sql, params) {
  const res = await pool.query(sql, params);
  return res.rows;
}

// ── Engine Imports ─────────────────────────────────────────
import { computeScore, getBand, getTierFloor, getLifecycleTransition, deltaForActivity, writeTrustEvent, PARAMS as TG_PARAMS, TIER_FLOORS, RUBRIC } from './lib/trustgraph-engine.mjs';
import { computeStanding, computeStandingFromDb, computeAllDomainsFromDb, writeStandingEvent, getLadderTier, isCouncilEligible, PARAMS as SS_PARAMS } from './lib/standing-engine.mjs';
import { evaluateGate, evaluateGateFromDb, ACTIVITY_REQUIREMENTS } from './lib/gate-evaluator.mjs';
import crypto from 'crypto';

// ── MCP Protocol Helpers ──────────────────────────────────
// MCP uses JSON-RPC 2.0 over stdio or HTTP.
// This implements the minimal MCP protocol for tool discovery + execution.

let requestId = 0;

function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function mcpResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function mcpNotify(method, params) {
  return { jsonrpc: '2.0', method, params };
}

// ── Tool Definitions ───────────────────────────────────────
// Each tool follows the MCP tool schema format.

const TOOLS = {

  // ════════════════════════════════════════════════════════════
  // TG-001: TrustGraph Engine
  // ════════════════════════════════════════════════════════════

  trust_score: {
    name: 'cuttlefish_trust_score',
    description: 'Get the TrustGraph behavioral score for an agent. Returns 0-100 score, band, tier floor, lifecycle status, and recent events.',
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
         FROM public.registry_agents WHERE did = $1`, [did]
      );
      if (!agent.length) return { error: 'Agent not found' };

      const result = await computeScoreFromDb(did, agent[0].cac_tier || 'explorer');
      const events = await query(
        `SELECT event_type, delta, score_after, note, created_at
         FROM public.trust_events WHERE agent_did = $1
         ORDER BY created_at DESC LIMIT 10`, [did]
      );

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

  trust_history: {
    name: 'cuttlefish_trust_history',
    description: 'Get the full trust event history for an agent, with computed score replay.',
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
         FROM public.trust_events WHERE agent_did = $1
         ORDER BY created_at ASC`, [did]
      );
      const agent = await query(
        `SELECT cac_tier FROM public.registry_agents WHERE did = $1`, [did]
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

  trust_event_write: {
    name: 'cuttlefish_trust_event_write',
    description: 'Write a trust event for an agent. The engine computes the new score, applies rubric deltas, decay, and lifecycle transitions.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Agent DID' },
        eventType: { type: 'string', description: 'Event type (e.g., VALIDATION_COMPLETED, GOVERNANCE_VOTE, SLASH_APPLIED)' },
        deltaOverride: { type: 'number', description: 'Optional: override the rubric delta' },
        reference: { type: 'string', description: 'Optional: reference ID' },
        note: { type: 'string', description: 'Optional: human-readable note' },
        domain: { type: 'string', description: 'Optional: domain tag' },
        evidenceHash: { type: 'string', description: 'Optional: evidence hash' },
      },
      required: ['did', 'eventType'],
    },
    handler: async (args) => {
      const { did, eventType, deltaOverride, reference, note, domain, evidenceHash } = args;
      const agent = await query(
        `SELECT cac_tier FROM public.registry_agents WHERE did = $1`, [did]
      );
      if (!agent.length) return { error: 'Agent not found' };
      const tier = agent[0].cac_tier || 'explorer';

      const result = await writeTrustEvent(
        query, did, eventType, deltaOverride,
        { reference, note, domain, evidence_hash: evidenceHash },
        tier
      );
      return {
        success: true,
        did,
        eventType,
        deltaApplied: result.delta_applied,
        scoreAfter: result.score,
        band: result.band,
        lifecycleTransition: result.lifecycle_transition || null,
        eventId: result.event_id,
      };
    },
  },

  trust_recompute: {
    name: 'cuttlefish_trust_recompute',
    description: 'Recompute an agent\'s TrustGraph score by replaying all events from the registry. Idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Agent DID' },
      },
      required: ['did'],
    },
    handler: async (args) => {
      const { did } = args;
      const agent = await query(
        `SELECT cac_tier FROM public.registry_agents WHERE did = $1`, [did]
      );
      if (!agent.length) return { error: 'Agent not found' };
      const result = await computeScoreFromDb(did, agent[0].cac_tier);
      await query(
        `UPDATE public.registry_agents
         SET trust_score = $1, trust_band = $2, trust_score_updated_at = NOW()
         WHERE did = $3`,
        [result.score, result.band, did]
      );
      return {
        success: true,
        did,
        score: result.score,
        band: result.band,
        eventsProcessed: result.record_version,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // SS-001: Stewardship Standing Engine
  // ════════════════════════════════════════════════════════════

  standing_get: {
    name: 'cuttlefish_standing_get',
    description: 'Get Stewardship Standing for an agent across all domains. Returns ladder tier, provisional status, and council eligibility.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Agent DID' },
      },
      required: ['did'],
    },
    handler: async (args) => {
      const { did } = args;
      const domains = await computeAllDomainsFromDb(query, did);
      const councilEligible = isCouncilEligible(domains);
      return {
        did,
        domains: domains.map(d => ({
          domain: d.domain,
          standing: d.standing,
          ladderTier: d.ladder_tier,
          provisional: d.provisional,
          capActive: d.cap_active,
          eventCount: d.event_count,
        })),
        councilEligible,
      };
    },
  },

  standing_get_domain: {
    name: 'cuttlefish_standing_get_domain',
    description: 'Get Stewardship Standing for an agent in a specific domain. Includes event history.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Agent DID' },
        domain: { type: 'string', description: 'Domain (e.g., engineering_review, governance_review)' },
      },
      required: ['did', 'domain'],
    },
    handler: async (args) => {
      const { did, domain } = args;
      const result = await computeStandingFromDb(query, did, domain);
      const events = await query(
        `SELECT event_type, quality_score, delta, standing_after, note, created_at
         FROM public.standing_events
         WHERE agent_did = $1 AND domain = $2
         ORDER BY created_at DESC LIMIT 10`, [did, domain]
      );
      return {
        did,
        domain,
        standing: result.standing,
        ladderTier: result.ladder_tier,
        provisional: result.provisional,
        capActive: result.cap_active,
        standingCap: result.standing_cap,
        timeInDomainDays: result.time_in_domain_days,
        eventCount: result.event_count,
        lastEventAt: result.last_event_at,
        recentEvents: (events || []).map(e => ({
          type: e.event_type,
          qualityScore: Number(e.quality_score),
          delta: Number(e.delta),
          standingAfter: Number(e.standing_after),
          note: e.note,
          at: e.created_at,
        })),
      };
    },
  },

  standing_event_write: {
    name: 'cuttlefish_standing_event_write',
    description: 'Write a Stewardship Standing event for an agent in a domain. Updates the EWMA score and ladder tier.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Agent DID' },
        domain: { type: 'string', description: 'Domain' },
        eventType: { type: 'string', description: 'Event type' },
        qualityScore: { type: 'number', description: 'Quality score (0-100)' },
        reference: { type: 'string', description: 'Optional reference' },
        note: { type: 'string', description: 'Optional note' },
      },
      required: ['did', 'domain', 'eventType'],
    },
    handler: async (args) => {
      const { did, domain, eventType, qualityScore, reference, note } = args;
      const result = await writeStandingEvent(query, did, domain, eventType, qualityScore, { reference, note });
      return {
        success: true,
        did,
        domain,
        standing: result.standing,
        ladderTier: result.ladder_tier,
        eventId: result.event_id,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // SGQ-001: Standing Gate
  // ════════════════════════════════════════════════════════════

  gate_evaluate: {
    name: 'cuttlefish_gate_evaluate',
    description: 'Evaluate the Standing Gate for an agent: "may this actor be rewarded for this activity, now?" Checks TrustGraph + Standing + CAC tier + IAL. Fail-closed on any axis.',
    inputSchema: {
      type: 'object',
      properties: {
        agentDid: { type: 'string', description: 'Agent DID' },
        activityType: { type: 'string', description: 'Activity type (e.g., VALIDATION_COMPLETED, GOVERNANCE_VOTE)' },
        domain: { type: 'string', description: 'Domain' },
        purpose: { type: 'string', description: 'Purpose (write, read, admin)', default: 'write' },
      },
      required: ['agentDid', 'activityType', 'domain'],
    },
    handler: async (args) => {
      const { agentDid, activityType, domain, purpose } = args;
      const decision = await evaluateGateFromDb(query, {
        agentDid, activityType, domain,
        asOf: new Date(),
        purpose: purpose || 'write',
      });

      // Audit log
      await query(
        `INSERT INTO public.gate_decisions
         (agent_did, activity_type, domain, cac_tier, ial, allowed,
          trustgraph_score, trustgraph_status, standing_value, standing_ladder,
          reasons, purpose)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [decision.agent_did || agentDid, activityType, domain,
         decision.cac_tier || null, decision.ial || null, decision.allowed,
         decision.trustgraph?.score || null, decision.trustgraph?.status || null,
         decision.standing?.value || null, decision.standing?.ladder_tier || null,
         JSON.stringify(decision.reasons || []), decision.purpose || 'write']
      );

      return decision;
    },
  },

  gate_thresholds: {
    name: 'cuttlefish_gate_thresholds',
    description: 'Get the current SGQ-001 thresholds for an activity type. Shows what TrustGraph score, Standing, CAC tier, and IAL are required.',
    inputSchema: {
      type: 'object',
      properties: {
        activityType: { type: 'string', description: 'Activity type (optional — returns defaults if omitted)' },
      },
    },
    handler: async (args) => {
      const { activityType } = args;
      const reqs = ACTIVITY_REQUIREMENTS[activityType] || ACTIVITY_REQUIREMENTS._default;
      return { activityType: activityType || '_default', required: reqs };
    },
  },

  // ════════════════════════════════════════════════════════════
  // AR-001: Activity Registry
  // ════════════════════════════════════════════════════════════

  activity_event_write: {
    name: 'cuttlefish_activity_event_write',
    description: 'Write a signed, hash-chained activity event to the registry. Auto-generates a TrustGraph event if the activity type has a rubric delta.',
    inputSchema: {
      type: 'object',
      properties: {
        actorKyaId: { type: 'string', description: 'KYA ID of the actor' },
        agentDid: { type: 'string', description: 'Agent DID' },
        activityType: { type: 'string', description: 'Activity type' },
        evidenceHash: { type: 'string', description: 'SHA-256 hash of the evidence' },
        domain: { type: 'string', description: 'Optional domain' },
        workUnit: { type: 'object', description: 'Optional work unit { quantity, unit, quality_score }' },
        section404Category: { type: 'string', description: 'Optional §404 category' },
        rewardEligibility: { type: 'object', description: 'Optional reward eligibility flags' },
        signature: { type: 'string', description: 'Optional KYA signature' },
      },
      required: ['actorKyaId', 'agentDid', 'activityType', 'evidenceHash'],
    },
    handler: async (args) => {
      const { actorKyaId, agentDid, activityType, evidenceHash, domain, workUnit,
              section404Category, rewardEligibility, signature } = args;

      const lastEvent = await query(
        `SELECT current_hash FROM public.activity_registry
         WHERE agent_did = $1 ORDER BY id DESC LIMIT 1`, [agentDid]
      );
      const previousHash = lastEvent[0]?.current_hash || null;
      const timestamp = new Date().toISOString();
      const hashInput = (previousHash || '') + evidenceHash + agentDid + activityType + timestamp;
      const currentHash = crypto.createHash('sha256').update(hashInput).digest('hex');

      const [inserted] = await query(
        `INSERT INTO public.activity_registry
         (actor_kya_id, agent_did, activity_type, domain, work_unit, evidence_hash,
          section_404_category, reward_eligibility, signature, previous_hash, current_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, event_id, created_at`,
        [actorKyaId, agentDid, activityType, domain || null,
         JSON.stringify(workUnit || {}), evidenceHash,
         section404Category || null, JSON.stringify(rewardEligibility || {}),
         signature || '', previousHash, currentHash]
      );

      // Auto-write trust event if this activity type has a TG delta
      const tgDelta = deltaForActivity(activityType, workUnit || {});
      if (tgDelta !== 0) {
        const agent = await query(
          `SELECT cac_tier FROM public.registry_agents WHERE did = $1`, [agentDid]
        );
        const tier = agent[0]?.cac_tier || 'explorer';
        await writeTrustEvent(query, agentDid, activityType, tgDelta,
          { reference: `AR-001:${inserted.event_id}`,
            note: `Auto-generated from activity registry`,
            domain: domain || null, evidence_hash: evidenceHash,
            ar_event_ref: inserted.event_id }, tier);
      }

      return {
        success: true,
        eventId: inserted.event_id,
        registryId: inserted.id,
        currentHash,
        previousHash,
        trustGraphDelta: tgDelta,
        createdAt: inserted.created_at,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // Agent Management
  // ════════════════════════════════════════════════════════════

  agents_list: {
    name: 'cuttlefish_agents_list',
    description: 'List all agents with computed TrustGraph scores, CAC status, and Stewardship ladder tiers.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const agents = await query(
        `SELECT a.did, a.name, a.role, a.agent_type, a.status, a.cac_tier, a.ial,
                a.trust_band, a.lifecycle_status, a.stewardship_ladder, a.created_at,
                c.tier as cac_tier_name, c.status as cac_status, c.usdc_prepaid,
                c.token_balance
         FROM public.registry_agents a
         LEFT JOIN public.cac_credentials c
           ON c.agent_did = a.did AND c.id = (
             SELECT MAX(id) FROM public.cac_credentials WHERE agent_did = a.did
           )
         ORDER BY a.id`
      );

      const allEvents = await query(
        `SELECT agent_did, event_type, delta, score_after, created_at, note, reference, domain
         FROM public.trust_events ORDER BY created_at ASC`
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
          memberSince: a.created_at,
        });
      }
      return { agents: results, total: results.length };
    },
  },

  rate_card: {
    name: 'cuttlefish_rate_card',
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
         FROM public.rate_card
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

  trust_network: {
    name: 'cuttlefish_trust_network',
    description: 'Get the full TrustGraph network — all agents with computed scores and all trust events. For visualization and analysis.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const [agents, allEvents] = await Promise.all([
        query(`SELECT did, name, role, agent_type, status, cac_tier, trust_band,
                      lifecycle_status, created_at
               FROM public.registry_agents ORDER BY id`),
        query(`SELECT agent_did, event_type, delta, score_after, reference, note, domain, created_at
               FROM public.trust_events ORDER BY created_at ASC`),
      ]);

      const eventsByDid = {};
      for (const ev of allEvents || []) {
        if (!eventsByDid[ev.agent_did]) eventsByDid[ev.agent_did] = [];
        eventsByDid[ev.agent_did].push(ev);
      }

      const nodes = (agents || []).map(a => {
        const tier = a.cac_tier || 'explorer';
        const agentEvents = eventsByDid[a.did] || [];
        const score = computeScore(agentEvents, tier);
        return {
          id: a.did,
          name: a.name,
          role: a.role,
          agentType: a.agent_type,
          status: a.status,
          cacTier: a.cac_tier,
          trustScore: score.score,
          trustBand: score.band,
          tierFloor: score.tier_floor,
          lifecycleStatus: a.lifecycle_status,
          memberSince: a.created_at,
          eventCount: agentEvents.length,
        };
      });

      return {
        nodes,
        totalAgents: nodes.length,
        totalEvents: (allEvents || []).length,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // VOCAB-001: Glossary Guardrail
  // ════════════════════════════════════════════════════════════

  vocab_guardrail: {
    name: 'cuttlefish_vocab_guardrail',
    description: 'Validate text against the Cuttlefish canonical glossary. Returns violations for banned/retired terms (validator, staker, APY, TRIB, etc.) with canonical replacements.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to validate' },
        context: { type: 'string', description: 'Optional context identifier' },
      },
      required: ['text'],
    },
    handler: async (args) => {
      const { text, context } = args;
      const DICTIONARY = [
        ['validator', 'Builder Steward', 'error'],
        ['staker', 'Builder Steward', 'error'],
        ['node operator', 'Builder Steward', 'warn'],
        ['constitutional agent license', 'Compute Access Certificate (CAC)', 'error'],
        ['constitutional audit card', 'Compute Access Certificate (CAC)', 'error'],
        ['trib token', '$E2R', 'error'],
        ['builder tier', 'Developer/Studio/Enterprise/Anchor', 'error'],
        ['apy', '§404 activity rewards', 'warn'],
        ['savings account', '§404 activity rewards', 'warn'],
        ['staking rewards', '§404 activity rewards', 'error'],
        ['soulbound', 'non-transferable / identity-bound', 'warn'],
        ['whitelist', 'allowlist', 'warn'],
        ['blacklist', 'denylist', 'warn'],
        ['master', 'primary / main / operator', 'warn'],
        ['slave', 'replica / secondary', 'error'],
      ];
      const tribRegex = /\btrib\b(?!utary)/gi;
      const lowerText = text.toLowerCase();
      const violations = [];

      for (const [term, canonical, severity] of DICTIONARY) {
        let idx = lowerText.indexOf(term);
        if (idx !== -1) {
          violations.push({
            term: text.slice(idx, idx + term.length),
            canonical, severity,
            position: [idx, idx + term.length],
            reference: 'CFL-GLOSSARY-001',
          });
        }
      }
      let match;
      while ((match = tribRegex.exec(text)) !== null) {
        violations.push({
          term: match[0], canonical: '$E2R', severity: 'error',
          position: [match.index, match.index + match[0].length],
          reference: 'CFL-DECISION-001',
        });
      }

      if (violations.length > 0) {
        return {
          valid: false,
          checks: violations.length,
          violations,
          handoff: 'Fix the flagged terms above, then re-submit. See CFL-GLOSSARY-001 for the canonical term set.',
        };
      }
      return { valid: true, checks: 0, context: context || null };
    },
  },

  // ════════════════════════════════════════════════════════════
  // Link Management (self-hosted branded short links)
  // ════════════════════════════════════════════════════════════

  links_create: {
    name: 'cuttlefish_links_create',
    description: 'Create a branded short link for any project. Supports custom slugs, QR codes, tags, and expiration. Projects: party (pfp.foto), harbor (31harbor.com), xmrt (xmrtsolutions.com), cuttlefish (cuttlefishlabs.io), mobilemonero (mobilemonero.com).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', enum: ['party', 'harbor', 'xmrt', 'cuttlefish', 'mobilemonero'], description: 'Project name' },
        url: { type: 'string', description: 'Destination URL' },
        key: { type: 'string', description: 'Custom slug (auto-generated if omitted)' },
        title: { type: 'string', description: 'Link title for previews' },
        qrCode: { type: 'boolean', default: true },
        expiresAt: { type: 'string', description: 'ISO-8601 expiration date' },
      },
      required: ['project', 'url'],
    },
    handler: async (args) => {
      const { project, url, key, title, qrCode, expiresAt } = args;
      const result = await query(
        `INSERT INTO links.links (project_id, domain, key, url, title, qr_code, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, domain, key, url, title, created_at`,
        [project, `${project === 'party' ? 'pfp.foto' : project === 'harbor' ? '31harbor.com' : project === 'xmrt' ? 'xmrtsolutions.com' : project === 'cuttlefish' ? 'cuttlefishlabs.io' : 'mobilemonero.com'}`, key || crypto.randomBytes(6).toString('base64url'), url, title || null, qrCode !== false, expiresAt || null]
      );
      if (!result.length) throw new Error('Failed to create link');
      const link = result[0];
      return {
        id: link.id,
        shortLink: `https://${link.domain}/${link.key}`,
        domain: link.domain,
        key: link.key,
        url: link.url,
        title: link.title,
        qrCodeUrl: qrCode !== false ? `/api/links/qr/${link.domain}/${link.key}` : null,
        createdAt: link.created_at,
      };
    },
  },

  links_list: {
    name: 'cuttlefish_links_list',
    description: 'List all short links for a project with search and pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', enum: ['party', 'harbor', 'xmrt', 'cuttlefish', 'mobilemonero'], description: 'Project name' },
        search: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
      required: ['project'],
    },
    handler: async (args) => {
      const { project, search, limit } = args;
      const pageSize = Math.min(limit || 50, 100);
      let sql = 'SELECT l.*, COALESCE(c.click_count, 0) AS clicks FROM links.links l LEFT JOIN (SELECT link_id, COUNT(*) AS click_count FROM links.clicks GROUP BY link_id) c ON c.link_id = l.id WHERE l.project_id = $1';
      const params = [project];
      if (search) {
        sql += ' AND (l.url ILIKE $2 OR l.key ILIKE $2 OR l.title ILIKE $2)';
        params.push(`%${search}%`);
      }
      sql += ' ORDER BY l.created_at DESC LIMIT $' + (params.length + 1);
      params.push(pageSize);
      const links = await query(sql, params);
      return {
        links: (links || []).map(l => ({
          id: l.id,
          shortLink: `https://${l.domain}/${l.key}`,
          domain: l.domain,
          key: l.key,
          url: l.url,
          title: l.title,
          clicks: Number(l.clicks || 0),
          createdAt: l.created_at,
        })),
        total: (links || []).length,
      };
    },
  },

  links_analytics: {
    name: 'cuttlefish_links_analytics',
    description: 'Get click analytics for a short link.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain (e.g. cuttlefishlabs.io)' },
        key: { type: 'string', description: 'Short link slug' },
        interval: { type: 'string', enum: ['24h', '7d', '30d', '90d', 'all'], default: '30d' },
      },
      required: ['domain', 'key'],
    },
    handler: async (args) => {
      const { domain, key, interval } = args;
      const link = await query(
        'SELECT id FROM links.links WHERE domain = $1 AND key = $2',
        [domain, key]
      );
      if (!link.length) throw new Error('Link not found');
      const linkId = link[0].id;
      const days = interval === '24h' ? 1 : interval === '7d' ? 7 : interval === '30d' ? 30 : interval === '90d' ? 90 : null;
      let clickSql = 'SELECT COUNT(*) AS total FROM links.clicks WHERE link_id = $1';
      const clickParams = [linkId];
      if (days) clickSql += ` AND clicked_at > NOW() - INTERVAL '${days} days'`;
      const totalClicks = await query(clickSql, clickParams);
      const clicksOverTime = await query(
        `SELECT DATE(clicked_at) AS date, COUNT(*) AS count FROM links.clicks WHERE link_id = $1 GROUP BY DATE(clicked_at) ORDER BY date DESC LIMIT 30`,
        [linkId]
      );
      return {
        link: `https://${domain}/${key}`,
        totalClicks: Number(totalClicks[0]?.total || 0),
        clicksOverTime: (clicksOverTime || []).map(c => ({ date: c.date, count: Number(c.count) })),
      };
    },
  },

  links_projects: {
    name: 'cuttlefish_links_projects',
    description: 'List all configured brands with their short domains.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const projects = await query('SELECT id, name, domain, tag_color FROM links.projects ORDER BY id', []);
      return {
        projects: (projects || []).map(p => ({ id: p.id, name: p.name, domain: p.domain, color: p.tag_color })),
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // Engine Health
  // ════════════════════════════════════════════════════════════

  engine_health: {
    name: 'cuttlefish_engine_health',
    description: 'Get the health status of all Cuttlefish Protocol engines (TG-001, SS-001, SGQ-001, AR-001).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      return {
        status: 'ok',
        engines: {
          trustgraph: { spec: 'TG-001 v1.0', version: '1.0.0', params: { CEIL: TG_PARAMS.CEIL, ATTEN: TG_PARAMS.ATTEN, DECAY: TG_PARAMS.DECAY, CAP: TG_PARAMS.CAP } },
          standing: { spec: 'SS-001 v1.0', version: '1.0.0', domains: SS_PARAMS.DOMAINS ? SS_PARAMS.DOMAINS.length : 'configured' },
          gate: { spec: 'SGQ-001 v1.0', version: '1.0.0', activityTypes: Object.keys(ACTIVITY_REQUIREMENTS).length - 1 },
          activityRegistry: { spec: 'AR-001', version: '1.0.0' },
        },
        timestamp: new Date().toISOString(),
      };
    },
  },
};

// ── Helper: computeScoreFromDb ─────────────────────────────
async function computeScoreFromDb(did, tier) {
  const events = await query(
    `SELECT event_type, delta, score_after, created_at, note, reference, domain
     FROM public.trust_events WHERE agent_did = $1
     ORDER BY created_at ASC`, [did]
  );
  return computeScore(events || [], tier);
}

// ── MCP Request Handler ────────────────────────────────────
async function handleRequest(req) {
  const { id, method, params } = req;

  switch (method) {

    // ── MCP Core: initialize ──
    case 'initialize':
      return mcpResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: {
          name: 'cuttlefish-mcp',
          version: '1.0.0',
        },
      });

    // ── MCP Core: list tools ──
    case 'tools/list':
      const tools = Object.values(TOOLS).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return mcpResult(id, { tools });

    // ── MCP Core: call tool ──
    case 'tools/call':
      const tool = Object.values(TOOLS).find(t => t.name === params.name);
      if (!tool) {
        return mcpError(id, -32601, `Unknown tool: ${params.name}`);
      }
      try {
        const result = await tool.handler(params.arguments || {});
        return mcpResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        return mcpError(id, -32603, err.message);
      }

    // ── MCP Core: notifications ──
    case 'notifications/initialized':
      return null;

    default:
      return mcpError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Transport: stdio (default MCP transport) ───────────────
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
    } catch (e) {
      // Ignore malformed JSON
    }
  }
}

function sendMessage(msg) {
  if (msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }
}

// ── Transport: HTTP (optional) ─────────────────────────────
function startHttp(port) {
  import('http').then(http => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const jsonReq = JSON.parse(body);
            const response = await handleRequest(jsonReq);
            if (res.headersSent) return;
            if (response) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(response));
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'ok' }] } }));
            }
          } catch (e) {
            if (res.headersSent) { console.error('[MCP-HTTP] headers already sent, cannot send error:', e.message); return; }
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else {
        if (res.headersSent) return;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Cuttlefish Labs MCP Server</title>
<style>body{font-family:'Share Tech Mono',monospace;background:#0a0a0f;color:#34d399;max-width:600px;margin:40px auto;padding:20px}
h1{color:#34d399;border-bottom:1px solid #34d399;padding-bottom:8px}
pre{background:#1a1a2e;padding:12px;border-radius:6px;overflow-x:auto}
a{color:#60a5fa}</style></head><body>
<h1>🐙 Cuttlefish Labs MCP Server</h1>
<p>TG-001 · SS-001 · SGQ-001 · AR-001 · KYA-002 · VOCAB-001</p>
<p>This is an MCP (Model Context Protocol) server. Connect via an MCP client.</p>
<h2>Available Tools</h2>
<pre>${Object.values(TOOLS).map(t => t.name).join('\n')}</pre>
<h2>Connect</h2>
<p><b>Stdio:</b> <code>node cuttlefish-mcp.mjs</code></p>
<p><b>HTTP:</b> <code>http://localhost:${port}/</code></p>
<p><b>Config for Claude Desktop:</b></p>
<pre>{
  "mcpServers": {
    "cuttlefish": {
      "command": "node",
      "args": ["path/to/cuttlefish-mcp.mjs"]
    }
  }
}</pre>
<p><a href="https://cuttlefishlabs.io">cuttlefishlabs.io</a> · <a href="https://relay.mobilemonero.com/cuttlefishclaws">CuttlefishClaws</a></p>
</body></html>`);
      }
    });
    server.listen(port, () => {
      console.error(`[Cuttlefish MCP] HTTP server listening on http://127.0.0.1:${port}`);
      console.error(`[Cuttlefish MCP] ${Object.keys(TOOLS).length} tools registered`);
    });
  });
}

// ── Entry Point ────────────────────────────────────────────
const useHttp = process.argv.includes('--http');
const portIdx = process.argv.indexOf('--port');
const port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1]) : 3100;

console.error(`[Cuttlefish MCP] Starting Cuttlefish Labs MCP Server v1.0.0`);
console.error(`[Cuttlefish MCP] Engines: TG-001, SS-001, SGQ-001, AR-001, KYA-002, VOCAB-001`);
console.error(`[Cuttlefish MCP] Transport: ${useHttp ? `HTTP on :${port}` : 'stdio'}`);
console.error(`[Cuttlefish MCP] ${Object.keys(TOOLS).length} tools registered`);

export { TOOLS };

if (useHttp) {
  startHttp(port);
} else {
  process.stdin.on('data', onStdioData);
  // Only auto-exit on stdin end when running standalone (not imported in-process)
  const isMain = process.argv[1] && fileURLToPath(import.meta.url).replace(/\\/g, '/').endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
  if (isMain) {
    process.stdin.on('end', () => process.exit(0));
  }
}
