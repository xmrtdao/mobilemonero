/**
 * trustgraph-engine.mjs — TG-001 TrustGraph Scoring Engine
 * 
 * Canonical spec: TG-001_TRUSTGRAPH_SPEC.md v1.0 (2026-06-27)
 * Reference implementation: cuttlefish-registry/trustgraph.py (13 test vectors)
 * 
 * The engine is a deterministic projection of AR-001 events into a 0-100
 * behavioral score. It is:
 *   - Event-sourced (replays trust_events from the DB)
 *   - Deterministic (same events + as_of = same score, always)
 *   - Asymmetric (slow to earn, fast to lose)
 *   - Decaying (-2/week after last positive signal, floors at tier floor)
 * 
 * §5 Computation model (LOCKED — normative):
 * 
 *   score(agent, as_of) = round(clamp(fold(seed(tier), ordered_events) - decay, 0, 100), 2)
 * 
 * The fold processes events in ascending timestamp order:
 *   1. For positive deltas: apply daily cap (micro-signals), then asymmetry attenuation
 *   2. For negative deltas: apply in full, no cap, no attenuation
 *   3. Track last_pos timestamp for decay computation
 * 
 * Decay is applied once after the fold:
 *   if last_pos != null and score > seed(tier):
 *     decay = DECAY * (as_of - last_pos) / 604800  (linear, per-week)
 *     score = max(seed(tier), score - decay)  (floors at tier floor)
 * 
 * Locked parameters (v1.0):
 *   seed(tier): Developer 30, Studio 40, Enterprise 55, Anchor 70, Explorer 20
 *   CEIL: 90 (asymmetry ceiling)
 *   ATTEN: 0.5 (positive deltas halved above ceiling)
 *   DECAY: 2.0 points per 7 days (604800 seconds)
 *   CAP: 10.0 points per UTC day (micro-positives only)
 *   Micro-positive types: GOVERNANCE_VOTE, INFERENCE_CONSUMPTION
 *   Bounds: [0, 100], rounded to 2 decimals
 * 
 * Scoring rubric (§4 — LOCKED, keyed to AR-001 ActivityTypes):
 *   VALIDATION_COMPLETED (clean):           +3
 *   VALIDATION_PEER_REVIEWED (passed):      +2
 *   ATTESTATION_ISSUED (by Senior+, upheld): +1..+3 (weighted by attestor Standing)
 *   GOVERNANCE_VOTE:                         +1  (micro, capped)
 *   GOVERNANCE_PROPOSAL_AUTHORED (accepted): +5
 *   clean security audit:                    +8
 *   clean inference (INFERENCE_CONSUMPTION): +0.05 (micro, capped)
 *   KYA_RENEWAL (passed):                    +2
 *   milestone completed:                      +5
 *   SLASH_APPLIED — constitutional violation, minor:  -15
 *   constitutional violation, major:                  -30
 *   prompt-injection attempt detected:               -50
 *   fabrication detected:                             -25
 *   attempted transaction with suspended/revoked:     -10
 *   abusive transfer pattern (>20/hr):               -15
 *   inactivity:                                       -2/week (decay, not event)
 * 
 * Bands:
 *   90-100: Trusted    (full transfer + governance, reduced fee 0.20%)
 *   70-89:  Standard   (full transfer + governance, standard fee 0.25%)
 *   50-69:  Monitored  (transfers capped at Studio limits, no governance voting)
 *   20-49:  Cautious   (transfers restricted, no cross-DAO, elevated fee 0.35%, no voting)
 *   10-19:  SUSPENDED  (signing blocked, reads allowed, Stewardship Review may open)
 *   0-9:    REVOKED    (credential revoked, forensic read-only — terminal)
 * 
 * Lifecycle transitions (Phase 2, with hysteresis):
 *   Enter SUSPENDED when score < 20
 *   Restore ACTIVE when score >= 25 (not merely re-crossing 20)
 *   Enter REVOKED when score < 10 (terminal — requires re-onboarding)
 */

// ── Locked Parameters (v1.0) ──────────────────────────────
//
// Exported because the CuttlefishClaws health endpoint reports these values, and
// because a second inline copy of them is exactly how the estate ended up with
// two engines that disagree. There is one set of numbers and it is readable.
//
// These are the live values. The stale inline copy in cuttlefishclaws-mcp.mjs
// carried CEIL 100, ATTEN 1.0 and DECAY 0.0 - no decay at all, and no
// attenuation above the ceiling - which is part of why it reported every agent
// in the estate at a flat 100/Trusted.
//
// Exported from the bottom of this file along with TIER_FLOORS, BANDS and RUBRIC.
const PARAMS = {
  CEIL: 90,           // Asymmetry ceiling — positive deltas halved above this
  ATTEN: 0.5,         // Attenuation factor for positives above CEIL
  DECAY: 2.0,         // Decay points per 7 days (604800 seconds)
  DECAY_PERIOD_S: 604800,  // 7 days in seconds
  CAP: 10.0,          // Daily cap for micro-positive signals
  MIN_SCORE: 0,
  MAX_SCORE: 100,
  ROUND_PRECISION: 2,
};

const TIER_FLOORS = {
  explorer: 20,
  developer: 30,
  studio: 40,
  enterprise: 55,
  anchor: 70,
};

const BANDS = [
  { min: 90, max: 100, name: 'Trusted',   status: 'active' },
  { min: 70, max: 89,  name: 'Standard',  status: 'active' },
  { min: 50, max: 69,  name: 'Monitored', status: 'active' },
  { min: 20, max: 49,  name: 'Cautious',  status: 'active' },
  { min: 10, max: 19,  name: 'SUSPENDED', status: 'suspended' },
  { min: 0,  max: 9,   name: 'REVOKED',   status: 'revoked' },
];

const MICRO_POSITIVE_TYPES = new Set([
  'GOVERNANCE_VOTE',
  'INFERENCE_CONSUMPTION',
]);

// The rubric: maps event_type → base delta
// Negative deltas are applied in full, no cap, no attenuation.
// Positive deltas are subject to daily cap (micro) and asymmetry (above CEIL).
const RUBRIC = {
  // Positive (productive signals)
  VALIDATION_COMPLETED:            { delta: 3,    micro: false },
  VALIDATION_PEER_REVIEWED:        { delta: 2,    micro: false },
  ATTESTATION_ISSUED:               { delta: 2,    micro: false, weighted: true }, // 1..3 by Standing
  GOVERNANCE_VOTE:                  { delta: 1,    micro: true },
  GOVERNANCE_PROPOSAL_AUTHORED:     { delta: 5,    micro: false },
  CLEAN_SECURITY_AUDIT:            { delta: 8,    micro: false },
  INFERENCE_CONSUMPTION:            { delta: 0.05, micro: true },
  KYA_RENEWAL:                      { delta: 2,    micro: false },
  MILESTONE_COMPLETED:              { delta: 5,    micro: false },
  
  // Positive (existing seed events from the DB that aren't in the canonical rubric
  // but were used in seeding — treat as non-micro positives)
  onboard:                          { delta: 0,    micro: false, seed: true },
  multilingual_engagement:          { delta: 12,   micro: false, custom: true },
  governance_participation:        { delta: 20,   micro: false, custom: true },
  proposal_submit:                  { delta: 2,    micro: false, custom: true },
  post_queued:                      { delta: 0,    micro: false, custom: true },
  
  // Negative (violations — applied in full, never capped)
  SLASH_APPLIED:                    { delta: -15,  micro: false },      // minor constitutional violation
  CONSTITUTIONAL_VIOLATION_MAJOR:   { delta: -30,  micro: false },
  PROMPT_INJECTION_DETECTED:        { delta: -50,  micro: false },
  FABRICATION_DETECTED:             { delta: -25,  micro: false },
  ATTEMPTED_TX_SUSPENDED_AGENT:     { delta: -10,  micro: false },
  ABUSIVE_TRANSFER_PATTERN:         { delta: -15,  micro: false },
  
  // Negative (existing seed events)
  constitutional_block:             { delta: -8,   micro: false, custom: true },
};

// ── Core Engine ────────────────────────────────────────────

/**
 * Compute the TrustGraph score for an agent.
 * 
 * @param {Array} events - Trust events from the DB, ordered by created_at ascending.
 *   Each event: { event_type, delta, score_after, created_at, note, reference }
 *   If delta is null/0, we derive it from the rubric by event_type.
 * @param {string} tier - Agent's CAC tier (explorer, developer, studio, enterprise, anchor)
 * @param {Date|string|number} asOf - The point in time to compute the score at.
 *   Defaults to now.
 * @returns {Object} { score, band, tier_floor, status, record_version, last_pos, decay_applied }
 */
export function computeScore(events, tier = 'explorer', asOf = new Date()) {
  const asOfMs = typeof asOf === 'number' ? asOf : 
                 typeof asOf === 'string' ? new Date(asOf).getTime() :
                 asOf.getTime();
  
  const seed = TIER_FLOORS[tier] ?? TIER_FLOORS.explorer;
  let score = seed;
  let lastPosMs = null;
  const dailyUsed = {}; // day string → accumulated micro-positive points
  
  // Process events in ascending timestamp order
  for (const ev of events) {
    const evMs = typeof ev.created_at === 'string' ? new Date(ev.created_at).getTime() :
                 ev.created_at instanceof Date ? ev.created_at.getTime() :
                 typeof ev.created_at === 'number' ? ev.created_at : 0;
    
    if (evMs > asOfMs) break; // Don't process events after as_of
    
    // Determine the delta
    let d = ev.delta;
    if (d === null || d === undefined || d === 0) {
      const rubricEntry = RUBRIC[ev.event_type];
      if (rubricEntry) {
        d = rubricEntry.delta;
      } else {
        continue; // Unknown event type with no delta, skip
      }
    }
    
    d = Number(d);
    if (isNaN(d) || d === 0) continue;
    
    const isMicroPositive = RUBRIC[ev.event_type]?.micro === true;
    
    if (d > 0) {
      // ── Positive delta ──
      
      // (a) Daily cap for micro-positives
      if (isMicroPositive) {
        const dayKey = new Date(evMs).toISOString().slice(0, 10); // YYYY-MM-DD
        const used = dailyUsed[dayKey] || 0;
        const remaining = Math.max(0, PARAMS.CAP - used);
        d = Math.min(d, remaining);
        if (d === 0) continue; // Cap exhausted, skip (does NOT set last_pos)
        dailyUsed[dayKey] = used + d;
      }
      
      // (b) Asymmetry attenuation (applied to post-cap delta)
      if (score >= PARAMS.CEIL) {
        d = d * PARAMS.ATTEN;
      }
      
      // (c) Apply
      score = Math.min(PARAMS.MAX_SCORE, score + d);
      lastPosMs = evMs;
      
    } else {
      // ── Negative delta ──
      // No cap, no attenuation, applied in full at any score level
      score = Math.max(PARAMS.MIN_SCORE, score + d);
      // Negative events do NOT update last_pos
    }
  }
  
  // ── Decay (applied once, after the fold) ──
  let decayApplied = 0;
  if (lastPosMs !== null && score > seed) {
    const elapsedS = (asOfMs - lastPosMs) / 1000;
    if (elapsedS > 0) {
      decayApplied = PARAMS.DECAY * (elapsedS / PARAMS.DECAY_PERIOD_S);
      // Decay never pushes below the tier floor; only negative events go lower
      const decayedScore = Math.max(seed, score - decayApplied);
      decayApplied = score - decayedScore; // actual decay applied (may be less than computed)
      score = decayedScore;
    }
  }
  
  // Round to 2 decimals
  score = Math.round(score * 100) / 100;
  
  // Determine band
  const band = getBand(score);
  
  return {
    score,
    band: band.name,
    tier_floor: seed,
    status: band.status,
    below_floor: score < seed,
    record_version: events.length, // Number of events processed
    last_positive_at: lastPosMs ? new Date(lastPosMs).toISOString() : null,
    decay_applied: Math.round(decayApplied * 100) / 100,
  };
}

/**
 * Get the band for a score.
 * @param {number} score 
 * @returns {{ min, max, name, status }}
 */
export function getBand(score) {
  for (const band of BANDS) {
    if (score >= band.min && score <= band.max) {
      return band;
    }
  }
  // Fallback
  return score >= 90 ? BANDS[0] : BANDS[BANDS.length - 1];
}

/**
 * Get the lifecycle transition needed based on current score and current lifecycle status.
 * Uses hysteresis: enter SUSPENDED at <20, restore ACTIVE at >=25.
 * REVOKED at <10 is terminal.
 * 
 * @param {number} score - Current TrustGraph score
 * @param {string} currentLifecycle - Current lifecycle_status
 * @returns {string|null} New lifecycle status if transition needed, null otherwise
 */
export function getLifecycleTransition(score, currentLifecycle) {
  if (score < 10) {
    return currentLifecycle === 'revoked' ? null : 'revoked';
  }
  if (score < 20) {
    // Enter SUSPENDED
    if (currentLifecycle !== 'suspended' && currentLifecycle !== 'revoked') {
      return 'suspended';
    }
    return null;
  }
  if (score >= 25) {
    // Restore ACTIVE (hysteresis — need 25, not 20)
    if (currentLifecycle === 'suspended') {
      return 'active';
    }
  }
  return null;
}

/**
 * Get the delta for a given event type from the rubric.
 * @param {string} eventType 
 * @returns {number|null} The delta, or null if unknown
 */
export function getDelta(eventType) {
  const entry = RUBRIC[eventType];
  return entry ? entry.delta : null;
}

/**
 * Check if an event type is a micro-positive (subject to daily cap).
 * @param {string} eventType 
 * @returns {boolean}
 */
export function isMicroPositive(eventType) {
  return MICRO_POSITIVE_TYPES.has(eventType);
}

/**
 * Get the tier floor for a given tier.
 * @param {string} tier
 * @returns {number|null} The floor, or null when the tier is not recognised.
 *
 * Fails closed. This used to be `TIER_FLOORS[tier] ?? TIER_FLOORS.explorer`,
 * which quietly answered 20 for any tier it had never heard of - including
 * 'builder', a real tier name from the older vocabulary, and including outright
 * typos. A floor is the bar an agent must clear, so inventing one for an unknown
 * tier understates the bar: it reports "at the floor" for a credential nobody
 * recognised. An unknown tier now returns null, which callers treat as
 * "cannot evaluate" rather than "passed".
 *
 * Note computeScore still seeds from TIER_FLOORS directly, so an unrecognised
 * tier there falls back to explorer; that fallback is deliberate there because
 * a score must start somewhere, but it no longer masquerades as a verdict.
 *
 * @see tierFloor in lib/cap.mjs - the same fail-closed policy applied to CAP.
 */
export function getTierFloor(tier) {
  if (typeof tier !== 'string') return null;
  const t = tier.trim().toLowerCase();
  // 'builder' was the older name for 'developer'. No row uses it, but the stale
  // inline engine in cuttlefishclaws-mcp.mjs still does, so it resolves rather
  // than silently landing on explorer's floor.
  const resolved = t === 'builder' ? 'developer' : t;
  return Object.hasOwn(TIER_FLOORS, resolved) ? TIER_FLOORS[resolved] : null;
}

/**
 * Compute a trust event delta for a given activity type.
 * This is used when writing new AR-001 events that should affect TrustGraph.
 * 
 * @param {string} activityType - The AR-001 ActivityType
 * @param {Object} context - Additional context (e.g., { severity: 'minor'|'major', qualityScore })
 * @returns {number} The delta to apply
 */
export function deltaForActivity(activityType, context = {}) {
  const entry = RUBRIC[activityType];
  if (!entry) return 0;
  
  let delta = entry.delta;
  
  // Special handling for variable deltas
  if (activityType === 'SLASH_APPLIED' && context.severity === 'major') {
    delta = RUBRIC.CONSTITUTIONAL_VIOLATION_MAJOR.delta;
  }
  
  if (activityType === 'ATTESTATION_ISSUED' && context.attestorStanding) {
    // Weighted by attestor Standing: 1-3 based on Standing
    if (context.attestorStanding >= 80) delta = 3;
    else if (context.attestorStanding >= 60) delta = 2;
    else delta = 1;
  }
  
  return delta;
}

// ── DB Integration ─────────────────────────────────────────

/**
 * Fetch trust events from the DB for an agent and compute their score.
 * 
 * @param {Function} queryFn - queryLocalPg function (sql, params) → rows
 * @param {string} agentDid - The agent's DID
 * @param {string} tier - The agent's CAC tier
 * @param {Date|number|string} asOf - Point in time (default: now)
 * @returns {Promise<Object>} Score result
 */
export async function computeScoreFromDb(queryFn, agentDid, tier, asOf = new Date()) {
  const result = await queryFn(
    `SELECT event_type, delta, score_after, created_at, note, reference, domain
     FROM public.trust_events
     WHERE agent_did = $1
     ORDER BY created_at ASC`,
    [agentDid]
  );
  const rows = result.rows || result;
  
  return computeScore(rows, tier, asOf);
}

/**
 * Write a trust event to the DB and return the new score.
 * 
 * @param {Function} queryFn - queryLocalPg function
 * @param {string} agentDid - The agent's DID
 * @param {string} eventType - AR-001 ActivityType
 * @param {number} deltaOverride - Override the rubric delta (null to use rubric)
 * @param {Object} meta - { reference, note, domain, evidence_hash, ar_event_ref }
 * @param {string} tier - Agent's CAC tier (for score computation)
 * @returns {Promise<Object>} { score, band, event_id, score_after }
 */
export async function writeTrustEvent(queryFn, agentDid, eventType, deltaOverride = null, meta = {}, tier = 'explorer') {
  const delta = deltaOverride !== null ? deltaOverride : deltaForActivity(eventType, meta);
  
  // Insert the event
  const insertResult = await queryFn(
    `INSERT INTO public.trust_events
     (agent_did, event_type, delta, reference, note, domain, evidence_hash, ar_event_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, event_id`,
    [agentDid, eventType, delta, meta.reference || null, meta.note || null,
     meta.domain || null, meta.evidence_hash || null, meta.ar_event_ref || null]
  );
  const inserted = (insertResult.rows || insertResult)[0];
  
  // Recompute score from all events
  const result = await computeScoreFromDb(queryFn, agentDid, tier);
  
  // Update score_after on the inserted event
  await queryFn(
    `UPDATE public.trust_events SET score_after = $1 WHERE id = $2`,
    [result.score, inserted.id]
  );
  
  // Update the agent's trust_score and trust_band
  await queryFn(
    `UPDATE public.registry_agents 
     SET trust_score = $1, trust_band = $2, trust_score_updated_at = NOW()
     WHERE did = $3`,
    [result.score, result.band, agentDid]
  );
  
  // Check for lifecycle transition
  const agentResult = await queryFn(
    `SELECT lifecycle_status FROM public.registry_agents WHERE did = $1`,
    [agentDid]
  );
  const agentRow = (agentResult.rows || agentResult)[0];
  
  const transition = getLifecycleTransition(result.score, agentRow?.lifecycle_status || 'active');
  if (transition) {
    await queryFn(
      `UPDATE public.registry_agents SET lifecycle_status = $1 WHERE did = $2`,
      [transition, agentDid]
    );
    result.lifecycle_transition = transition;
  }
  
  return {
    ...result,
    event_id: inserted.event_id,
    event_db_id: inserted.id,
    delta_applied: delta,
  };
}

// ── Export constants for testing ────────────────────────────

export { PARAMS, TIER_FLOORS, BANDS, RUBRIC, MICRO_POSITIVE_TYPES };