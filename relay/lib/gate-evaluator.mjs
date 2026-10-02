/**
 * gate-evaluator.mjs — SGQ-001 Standing Gate
 * 
 * Canonical spec: SGQ-001_STANDING_GATE_QUERY.md v1.0
 * 
 * The single service that answers:
 *   "Is actor A entitled — by Stewardship Standing, CAC tier, and identity
 *    assurance — to perform (and be rewarded for) activity_type in domain,
 *    as of time T?"
 * 
 * Two-axis AND gate (§2):
 *   1. TrustGraph (TG-001): status NOT in {SUSPENDED, REVOKED} AND
 *      not below_floor AND score >= required.min_trust_score
 *   2. Standing (SS-001): standing >= required.min_standing in domain AND
 *      ladder_tier >= required.min_ladder_tier AND
 *      not provisional where non-provisional required
 *   3. Tier: cac_tier >= required.min_cac_tier
 *   4. Identity: ial >= required.min_ial
 *   5. No active Stewardship Review/suspension
 * 
 * A failure on ANY axis sets allowed=false and reasons lists EVERY failing
 * condition (no silent denial).
 */

import { computeScore, getBand, getTierFloor, getLifecycleTransition } from './trustgraph-engine.mjs';
import { computeStanding, getLadderTier, isCouncilEligible, deriveTimeInDomainDays, readStandingCap } from './standing-engine.mjs';

// ── Threshold configuration (governed, not hardcoded here permanently) ──

// Activity-type minimums (from the canonical specs — pilot values)
const ACTIVITY_REQUIREMENTS = {
  VALIDATION_COMPLETED:        { minTrustScore: 20, minStanding: 30, minLadderTier: 'Contributor',      minCacTier: 'developer', minIal: 'IAL2' },
  VALIDATION_PEER_REVIEWED:    { minTrustScore: 30, minStanding: 40, minLadderTier: 'Contributor',      minCacTier: 'developer', minIal: 'IAL2' },
  ATTESTATION_ISSUED:           { minTrustScore: 40, minStanding: 60, minLadderTier: 'Builder Steward',  minCacTier: 'studio',    minIal: 'IAL2' },
  GOVERNANCE_VOTE:              { minTrustScore: 20, minStanding: 0,  minLadderTier: 'Participant',      minCacTier: 'developer', minIal: 'IAL2' },
  GOVERNANCE_PROPOSAL_AUTHORED:{ minTrustScore: 50, minStanding: 50, minLadderTier: 'Contributor',      minCacTier: 'studio',    minIal: 'IAL2' },
  CLEAN_SECURITY_AUDIT:         { minTrustScore: 50, minStanding: 60, minLadderTier: 'Builder Steward',  minCacTier: 'enterprise', minIal: 'IAL3' },
  KYA_RENEWAL:                  { minTrustScore: 20, minStanding: 0,  minLadderTier: 'Participant',      minCacTier: 'developer', minIal: 'IAL2' },
  MILESTONE_COMPLETED:          { minTrustScore: 40, minStanding: 60, minLadderTier: 'Builder Steward',  minCacTier: 'studio',    minIal: 'IAL2' },
  // ── Financial activities ────────────────────────────────────────────────
  // Money is the one axis where a wrong answer cannot be walked back, so these
  // sit at or above the strictest of everything above. Reading a balance is
  // cheap; issuing a refund is not, and is the only activity here that demands
  // IAL3 - an agent with two-factor identity assurance before it can send a
  // client's money back.
  //
  // Jobby currently sits at trust 40 with zero standing, so pfp_refund denies
  // him. That is the gate working, not a misconfiguration.
  PAYMENT_REPORT_READ:         { minTrustScore: 10, minStanding: 0,  minLadderTier: 'Participant',      minCacTier: 'explorer',  minIal: 'IAL1' },
  PAYMENT_LINK_CREATED:        { minTrustScore: 40, minStanding: 30, minLadderTier: 'Contributor',      minCacTier: 'developer', minIal: 'IAL2' },
  PAYMENT_RECEIVED:            { minTrustScore: 40, minStanding: 30, minLadderTier: 'Contributor',      minCacTier: 'developer', minIal: 'IAL2' },
  REFUND_ISSUED:               { minTrustScore: 60, minStanding: 60, minLadderTier: 'Builder Steward',  minCacTier: 'studio',    minIal: 'IAL3' },
  PAYOUT_SENT:                 { minTrustScore: 80, minStanding: 80, minLadderTier: 'Senior Steward',   minCacTier: 'enterprise',minIal: 'IAL3' },
  // Default for unknown activity types
  _default:                      { minTrustScore: 20, minStanding: 0,  minLadderTier: 'Participant',      minCacTier: 'developer', minIal: 'IAL2' },
};

// CAC tier ordering (for comparison)
const TIER_ORDER = ['explorer', 'developer', 'studio', 'enterprise', 'anchor'];
const LADDER_ORDER = ['Participant', 'Contributor', 'Builder Steward', 'Senior Steward', 'Council-eligible'];
const IAL_ORDER = ['IAL1', 'IAL2', 'IAL3'];

/**
 * Evaluate the standing gate for a single actor/activity/domain.
 * 
 * @param {Object} query — GateQuery:
 *   { agentDid, activityType, domain, cacTier, ial, asOf, purpose }
 * @param {Object} trustData — { score, band, status, below_floor, tier_floor }
 * @param {Object} standingData — { standing, ladder_tier, provisional, standing_cap }
 * @returns {Object} GateDecision: { allowed, trustgraph, standing, required, reasons, purpose, evaluated_at, as_of }
 */
export function evaluateGate(query, trustData, standingData) {
  const { agentDid, activityType, domain, cacTier, ial, asOf, purpose } = query;
  
  // Get requirements for this activity type
  const req = ACTIVITY_REQUIREMENTS[activityType] || ACTIVITY_REQUIREMENTS._default;
  
  const reasons = [];
  
  // ── Axis 1: TrustGraph (behavioral) ──
  const trustgraph = {
    score: trustData.score,
    band: trustData.band,
    status: trustData.status,
    below_floor: trustData.below_floor || false,
  };
  
  if (trustData.status === 'suspended' || trustData.status === 'revoked') {
    reasons.push(`TrustGraph status is ${trustData.status.toUpperCase()} — agent may not act`);
  }
  if (trustData.below_floor) {
    reasons.push(`TrustGraph score ${trustData.score} is below tier floor ${trustData.tier_floor}`);
  }
  if (trustData.score < req.minTrustScore) {
    reasons.push(`TrustGraph score ${trustData.score} < required ${req.minTrustScore} for ${activityType}`);
  }
  
  // ── Axis 2: Standing (competence) ──
  const standing = {
    domain,
    value: standingData.standing,
    ladder_tier: standingData.ladder_tier,
    provisional: standingData.provisional || false,
  };
  
  if (standingData.standing < req.minStanding) {
    reasons.push(`Standing ${standingData.standing} in ${domain} < required ${req.minStanding} for ${activityType}`);
  }
  
  const standingLadderIdx = LADDER_ORDER.indexOf(standingData.ladder_tier);
  const requiredLadderIdx = LADDER_ORDER.indexOf(req.minLadderTier);
  if (standingLadderIdx < requiredLadderIdx) {
    reasons.push(`Ladder tier ${standingData.ladder_tier} < required ${req.minLadderTier} for ${activityType}`);
  }
  
  if (standingData.provisional && req.minLadderTier !== 'Participant') {
    reasons.push(`Standing is provisional (insufficient events) in ${domain}`);
  }
  
  // ── Axis 3: CAC Tier ──
  const agentTierIdx = TIER_ORDER.indexOf(cacTier);
  const requiredTierIdx = TIER_ORDER.indexOf(req.minCacTier);
  if (agentTierIdx < requiredTierIdx) {
    reasons.push(`CAC tier ${cacTier} < required ${req.minCacTier} for ${activityType}`);
  }
  
  // ── Axis 4: IAL (Identity Assurance Level) ──
  const agentIalIdx = IAL_ORDER.indexOf(ial);
  const requiredIalIdx = IAL_ORDER.indexOf(req.minIal);
  if (agentIalIdx < requiredIalIdx) {
    reasons.push(`IAL ${ial} < required ${req.minIal} for ${activityType}`);
  }
  
  // ── Axis 5: Active Stewardship Review ──
  if (standingData.cap_active) {
    reasons.push(`Active Standing cap in ${domain} from Stewardship Review`);
  }
  
  // ── Decision ──
  const allowed = reasons.length === 0;
  
  return {
    allowed,
    agent_did: agentDid,
    trustgraph,
    standing,
    cac_tier: cacTier,
    ial,
    required: {
      min_trust_score: req.minTrustScore,
      min_standing: req.minStanding,
      min_ladder_tier: req.minLadderTier,
      min_cac_tier: req.minCacTier,
      min_ial: req.minIal,
    },
    reasons,
    purpose: purpose || 'write',
    evaluated_at: new Date().toISOString(),
    as_of: asOf ? (asOf instanceof Date ? asOf.toISOString() : asOf) : new Date().toISOString(),
  };
}

/**
 * Full gate evaluation from DB — reads TrustGraph, Standing, and agent metadata
 * from the database, then evaluates.
 * 
 * @param {Function} queryFn — queryLocalPg
 * @param {Object} query — { agentDid, activityType, domain, asOf, purpose }
 * @returns {Promise<Object>} GateDecision
 */
export async function evaluateGateFromDb(queryFn, query) {
  const { agentDid, activityType, domain, asOf } = query;
  
  // Fetch agent metadata
  const agentResult = await queryFn(
    `SELECT cac_tier, ial, lifecycle_status, trust_score, trust_band
     FROM public.registry_agents WHERE did = $1`,
    [agentDid]
  );
  const agentRows = agentResult.rows || agentResult;
  const agent = agentRows[0];
  
  if (!agent) {
    return {
      allowed: false,
      reasons: ['Agent not found in registry'],
      agent_did: agentDid,
      evaluated_at: new Date().toISOString(),
    };
  }
  
  // Compute TrustGraph score
  const trustResult = await queryFn(
    `SELECT event_type, delta, score_after, created_at
     FROM public.trust_events
     WHERE agent_did = $1
     ORDER BY created_at ASC`,
    [agentDid]
  );
  const trustEvents = trustResult.rows || trustResult;
  
  const trustData = computeScore(trustEvents, agent.cac_tier || 'explorer', asOf || new Date());
  
  // Compute Standing in the requested domain
  const standingResult = await queryFn(
    `SELECT event_type, quality_score, delta, standing_after, created_at
     FROM public.standing_events
     WHERE agent_did = $1 AND domain = $2
     ORDER BY created_at ASC`,
    [agentDid, domain]
  );
  const standingEvents = standingResult.rows || standingResult;
  
  const standingRowResult = await queryFn(
    `SELECT last_event_at, standing_value, ladder_tier
     FROM public.stewardship_standing
     WHERE agent_did = $1 AND domain = $2`,
    [agentDid, domain]
  );
  const standingRowRows = standingRowResult.rows || standingRowResult;
  const standingRow = standingRowRows[0];
  
  // time_in_domain_days is derived from the event history, not stored anywhere,
  // and standing_cap is null unless a cap was actually imposed. Both used to be
  // selected as columns, which threw 42703 and made the gate unusable for every
  // agent and every domain.
  const standingData = computeStanding(
    standingEvents,
    {
      timeInDomainDays: deriveTimeInDomainDays(standingEvents, asOf || new Date()),
      standingCap: readStandingCap(standingRow),
    },
    asOf || new Date()
  );
  
  // Evaluate the gate
  return evaluateGate(
    {
      ...query,
      cacTier: agent.cac_tier || 'explorer',
      ial: agent.ial || 'IAL2',
    },
    trustData,
    standingData
  );
}

export { ACTIVITY_REQUIREMENTS, TIER_ORDER, LADDER_ORDER, IAL_ORDER };