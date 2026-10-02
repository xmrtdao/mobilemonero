/**
 * standing-engine.mjs — SS-001 Stewardship Standing Engine
 * 
 * Canonical spec: SS-001_STEWARDSHIP_STANDING_SPEC.md v1.0 (2026-06-27)
 * 
 * Stewardship Standing is the domain-bounded, earned-competence axis of agent
 * governance. It is the OTHER axis from TG-001 — TG-001 is behavioral (per-agent),
 * SS-001 is competence (per-agent-per-domain).
 * 
 * SGQ-001 reads BOTH and requires both to pass (AND gate).
 * 
 * §7 Computation model (LOCKED — normative):
 *   Standing is a recency-weighted quality average (EWMA) per (agent, domain).
 *   - Exponentially time-weighted moving average of quality-scored events
 *   - Normalized 0-100
 *   - Bounded by any active cap from Stewardship Review
 * 
 * §5 Maturation ladder:
 *   Participant     (0-7d,     n/a,    read-only)
 *   Contributor     (>=7d,     >=30,   low-impact attestations)
 *   Builder Steward (>=30d,    >=60,   weighted review)
 *   Senior Steward  (>=90d,    >=80,   consensus authority)
 *   Council-eligible(>=180d,   >=90 in >=2 domains, constitutional governance)
 * 
 * §3 Cross-domain isolation (load-bearing):
 *   Each domain is its own score. A slash in engineering_review does NOT
 *   affect arbitration_reliability. The engine has NO code path that updates
 *   domain B from an event tagged to domain A.
 * 
 * §6 Review outcomes:
 *   - Cap: standing_cap:<v> (Standing may not exceed v until lifted)
 *   - Set: standing_set:<v> (force Standing to a value)
 *   - Restore: standing_restore (lifts a prior cap)
 */

// ── Locked Parameters (v1.0) ──────────────────────────────

const PARAMS = {
  // EWMA parameters
  ALPHA: 0.3,           // EWMA weight for new events (higher = more recent-weighted)
  DECAY_HALF_LIFE_DAYS: 90, // Events older than this contribute less
  MIN_STANDING: 0,
  MAX_STANDING: 100,
  ROUND_PRECISION: 2,

  // Ladder thresholds
  LADDER: [
    { name: 'Participant',      minTimeDays: 0,   minStanding: 0,  authority: 'read-only' },
    { name: 'Contributor',      minTimeDays: 7,   minStanding: 30, authority: 'low-impact attestations' },
    { name: 'Builder Steward',  minTimeDays: 30,  minStanding: 60, authority: 'weighted review' },
    { name: 'Senior Steward',    minTimeDays: 90,  minStanding: 80, authority: 'consensus authority' },
    { name: 'Council-eligible', minTimeDays: 180, minStanding: 90, authority: 'constitutional governance' },
  ],

  // Default domains (extensible via Council)
  DOMAINS: [
    'engineering_review',
    'materials_science',
    'environmental_assessment',
    'financial_modeling',
    'governance_review',
    'compliance_review',
    'arbitration_reliability',
    'attestation_integrity',
  ],
};

// Event types that affect Standing (per domain)
const STANDING_EVENT_TYPES = {
  // Positive — quality-scored work events
  VALIDATION_COMPLETED:        { defaultQuality: 0.7,  weight: 1.0 },
  VALIDATION_PEER_REVIEWED:    { defaultQuality: 0.8,  weight: 1.2 },
  ATTESTATION_ISSUED:           { defaultQuality: 0.75, weight: 1.1 },
  GOVERNANCE_PROPOSAL_AUTHORED:{ defaultQuality: 0.8,  weight: 1.5 },
  MILESTONE_COMPLETED:          { defaultQuality: 0.9,  weight: 2.0 },
  
  // Negative — review outcomes
  STEWARDSHIP_REVIEW_OUTCOME:  { defaultQuality: 0.0,  weight: 1.0 }, // negative, determined by effect
  STANDING_ADJUSTED:           { defaultQuality: 0.0,  weight: 1.0 }, // explicit adjustment
  
  // Neutral — lifecycle
  TIER_UPGRADE:                 { defaultQuality: 0.0,  weight: 0.0 }, // informational
};

// ── Core Engine ────────────────────────────────────────────

/**
 * Days an agent has been active in a domain — derived from the event history.
 *
 * This is a DERIVED value, not a stored column. It appears in no table in the
 * database; it was previously read as if it were one, which made every caller
 * that asked for it throw `column "time_in_domain_days" does not exist`.
 *
 * Definition matches the engine's own contract (see getLadderTier): days since
 * the FIRST standing event in this domain, up to `asOf`. No events means 0.
 *
 * @param {Array} events — Standing events ordered by created_at ascending
 * @param {Date|string|number} asOf — Point in time (default: now)
 * @returns {number} whole days, never negative
 */
export function deriveTimeInDomainDays(events, asOf = new Date()) {
  if (!Array.isArray(events) || events.length === 0) return 0;
  const first = events[0]?.created_at;
  if (!first) return 0;
  const firstMs = new Date(first).getTime();
  if (Number.isNaN(firstMs)) return 0;
  const asOfMs = typeof asOf === 'number' ? asOf :
                  typeof asOf === 'string' ? new Date(asOf).getTime() :
                  asOf?.getTime ? asOf.getTime() : NaN;
  if (Number.isNaN(asOfMs) || asOfMs < firstMs) return 0;
  return Math.floor((asOfMs - firstMs) / 86400000);
}

/**
 * Read a standing cap from a stewardship row.
 *
 * A cap is only in force if one was actually imposed ("Standing may not exceed
 * v until lifted"). No table currently persists one, so in practice this is
 * null and standing is uncapped — which is the truthful state, not a default
 * that hides a missing cap. Kept as a function so that if a cap column is ever
 * added, both readers pick it up without changing their call sites.
 */
export function readStandingCap(standingRow) {
  const cap = standingRow?.standing_cap;
  return typeof cap === 'number' && Number.isFinite(cap) ? cap : null;
}

/**
 * Compute Stewardship Standing for a single (agent, domain).
 * 
 * @param {Array} events — Standing events from the DB for this (agent, domain),
 *   ordered by created_at ascending. Each: { event_type, quality_score, delta,
 *   standing_after, created_at, note, reference }
 * @param {Object} options — { timeInDomainDays, standingCap }
 * @param {Date|string|number} asOf — Point in time (default: now)
 * @returns {Object} { standing, ladder_tier, time_in_domain_days, provisional, standing_cap }
 */
export function computeStanding(events, options = {}, asOf = new Date()) {
  const asOfMs = typeof asOf === 'number' ? asOf :
                 typeof asOf === 'string' ? new Date(asOf).getTime() :
                 asOf.getTime();
  
  const { timeInDomainDays = 0, standingCap = null } = options;
  
  if (!events || events.length === 0) {
    // No events → 0 standing, Participant ladder
    return applyCap({
      standing: 0,
      ladder_tier: getLadderTier(0, timeInDomainDays),
      time_in_domain_days: timeInDomainDays,
      provisional: true,
      standing_cap: standingCap,
      event_count: 0,
    }, standingCap);
  }
  
  // Compute recency-weighted quality average (EWMA)
  let ewma = 0;
  let totalWeight = 0;
  let lastEventMs = 0;
  
  for (const ev of events) {
    const evMs = typeof ev.created_at === 'string' ? new Date(ev.created_at).getTime() :
                 ev.created_at instanceof Date ? ev.created_at.getTime() :
                 typeof ev.created_at === 'number' ? ev.created_at : 0;
    
    if (evMs > asOfMs) break;
    
    // Get quality score (0-1) for this event
    let quality = ev.quality_score !== null && ev.quality_score !== undefined ?
      Number(ev.quality_score) / 100 : // DB stores 0-100, normalize to 0-1
      (STANDING_EVENT_TYPES[ev.event_type]?.defaultQuality ?? 0.5);
    
    // Get weight for this event type
    const weight = STANDING_EVENT_TYPES[ev.event_type]?.weight ?? 1.0;
    
    // Recency weight: exponential decay based on time since event
    const daysSince = (asOfMs - evMs) / 86400000;
    const recencyWeight = Math.exp(-daysSince / PARAMS.DECAY_HALF_LIFE_DAYS);
    
    const effectiveWeight = weight * recencyWeight;
    
    // For explicit delta events (STANDING_ADJUSTED), use the delta directly
    if (ev.event_type === 'STANDING_ADJUSTED' && ev.delta !== null && ev.delta !== undefined) {
      ewma = Number(ev.delta); // Set to explicit value
      totalWeight = 1;
    } else if (ev.event_type === 'STEWARDSHIP_REVIEW_OUTCOME') {
      // Review outcomes can be positive or negative based on the finding
      const reviewNegative = ev.delta !== null && ev.delta !== undefined && Number(ev.delta) < 0;
      quality = reviewNegative ? 0.0 : Math.max(quality, 0.5);
      ewma = (ewma * totalWeight + quality * 100 * effectiveWeight) / (totalWeight + effectiveWeight);
      totalWeight += effectiveWeight;
    } else {
      // Normal: EWMA update
      ewma = (ewma * totalWeight + quality * 100 * effectiveWeight) / (totalWeight + effectiveWeight);
      totalWeight += effectiveWeight;
    }
    
    lastEventMs = Math.max(lastEventMs, evMs);
  }
  
  // Normalize to 0-100
  let standing = Math.max(PARAMS.MIN_STANDING, Math.min(PARAMS.MAX_STANDING, Math.round(ewma * 100) / 100));
  
  const result = {
    standing,
    ladder_tier: getLadderTier(standing, timeInDomainDays),
    time_in_domain_days: timeInDomainDays,
    provisional: totalWeight < 3, // Provisional if fewer than 3 weighted events
    standing_cap: standingCap,
    event_count: events.length,
    last_event_at: lastEventMs ? new Date(lastEventMs).toISOString() : null,
  };
  
  return applyCap(result, standingCap);
}

/**
 * Apply a standing cap (from Stewardship Review).
 * If a cap is set and standing exceeds it, clamp to the cap.
 */
function applyCap(result, cap) {
  if (cap !== null && cap !== undefined && result.standing > cap) {
    result.standing = Math.round(cap * 100) / 100;
    result.ladder_tier = getLadderTier(result.standing, result.time_in_domain_days);
    result.cap_active = true;
  } else {
    result.cap_active = false;
  }
  return result;
}

/**
 * Determine the ladder tier based on standing value and time in domain.
 * Returns the HIGHEST tier whose BOTH gates pass (time AND standing).
 * 
 * @param {number} standing — Standing value 0-100
 * @param {number} timeInDomainDays — Days since first event in this domain
 * @returns {string} Ladder tier name
 */
export function getLadderTier(standing, timeInDomainDays) {
  let tier = PARAMS.LADDER[0].name; // Default: Participant
  
  for (const rung of PARAMS.LADDER) {
    if (standing >= rung.minStanding && timeInDomainDays >= rung.minTimeDays) {
      tier = rung.name;
    }
  }
  
  return tier;
}

/**
 * Check if an agent is council-eligible (>=90 in >=2 domains).
 * 
 * @param {Array} domainStandings — Array of { domain, standing } objects
 * @param {number} timeInDomainDays — Time in each domain (must be >=180)
 * @returns {boolean}
 */
export function isCouncilEligible(domainStandings) {
  const qualifying = domainStandings.filter(
    s => s.standing >= 90 && (s.time_in_domain_days || 0) >= 180
  );
  return qualifying.length >= 2;
}

// ── DB Integration ─────────────────────────────────────────

/**
 * Fetch standing events from the DB for a (agent, domain) and compute standing.
 * 
 * @param {Function} queryFn — queryLocalPg function
 * @param {string} agentDid — Agent DID
 * @param {string} domain — Domain (e.g., 'engineering_review')
 * @param {Date|number|string} asOf — Point in time (default: now)
 * @returns {Promise<Object>} Standing result
 */
export async function computeStandingFromDb(queryFn, agentDid, domain, asOf = new Date()) {
  // Fetch events for this agent+domain
  const result = await queryFn(
    `SELECT event_type, quality_score, delta, standing_after, created_at, note, reference
     FROM public.standing_events
     WHERE agent_did = $1 AND domain = $2
     ORDER BY created_at ASC`,
    [agentDid, domain]
  );
  const events = result.rows || result;
  
  // Fetch the stewardship record for last activity and any imposed cap.
  // time_in_domain_days and standing_cap are NOT columns here — they exist in
  // no table. Days are derived from the event history; a cap is null unless one
  // was actually imposed. Selecting them used to throw 42703 on every call.
  const standingResult = await queryFn(
    `SELECT last_event_at, standing_value, ladder_tier
     FROM public.stewardship_standing
     WHERE agent_did = $1 AND domain = $2`,
    [agentDid, domain]
  );
  const standingRow = standingResult.rows?.[0] || standingResult?.[0];
  
  const options = {
    timeInDomainDays: deriveTimeInDomainDays(events, asOf),
    standingCap: readStandingCap(standingRow),
  };
  
  return computeStanding(events, options, asOf);
}

/**
 * Compute standing for ALL domains for an agent.
 * 
 * @param {Function} queryFn
 * @param {string} agentDid
 * @param {Date} asOf
 * @returns {Promise<Array>} Array of { domain, standing, ladder_tier, ... }
 */
export async function computeAllDomainsFromDb(queryFn, agentDid, asOf = new Date()) {
  const results = [];
  for (const domain of PARAMS.DOMAINS) {
    const standing = await computeStandingFromDb(queryFn, agentDid, domain, asOf);
    results.push({ domain, ...standing });
  }
  return results;
}

/**
 * Write a standing event and update the standing record.
 * 
 * @param {Function} queryFn
 * @param {string} agentDid
 * @param {string} domain
 * @param {string} eventType
 * @param {number} qualityScore — 0-100
 * @param {Object} meta — { reference, note, ar_event_ref }
 * @returns {Promise<Object>} { standing, ladder_tier, event_id }
 */
export async function writeStandingEvent(queryFn, agentDid, domain, eventType, qualityScore = null, meta = {}) {
  // Insert the event
  const insertResult = await queryFn(
    `INSERT INTO public.standing_events
     (agent_did, domain, event_type, quality_score, reference, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, event_id`,
    [agentDid, domain, eventType, qualityScore, meta.reference || null, meta.note || null]
  );
  const inserted = (insertResult.rows || insertResult)[0];
  
  // Recompute standing
  const result = await computeStandingFromDb(queryFn, agentDid, domain);
  
  // Update standing_after on the event
  await queryFn(
    `UPDATE public.standing_events SET standing_after = $1 WHERE id = $2`,
    [result.standing, inserted.id]
  );
  
  // Update the standing record — one summary row per (agent, domain).
  //
  // This used to be an INSERT ... ON CONFLICT (agent_did, domain) into the
  // public view. That could never work: the view projected no `domain` column
  // and no `time_in_domain_days`, so it failed with 42703 on every call.
  // ON CONFLICT is also unusable — there is no unique index on those columns,
  // and adding one would require collapsing the 16 existing vex/fleet rows, so
  // this upserts explicitly instead. time_in_domain_days is derived from the
  // event history, not stored, so it is not written here.
  //
  // id/rows handling tolerates both queryFn shapes used in this codebase:
  // one returns pg's full result, the other only `.rows`.
  const standingExisting = await queryFn(
    `SELECT id FROM public.stewardship_standing
     WHERE agent_did = $1 AND domain = $2
     ORDER BY id DESC LIMIT 1`,
    [agentDid, domain]
  );
  const standingExistingId = (standingExisting?.rows || standingExisting || [])[0]?.id;
  
  if (standingExistingId) {
    await queryFn(
      `UPDATE public.stewardship_standing
       SET standing_value = $2, ladder_tier = $3, last_event_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [standingExistingId, result.standing, result.ladder_tier]
    );
  } else {
    await queryFn(
      `INSERT INTO public.stewardship_standing
       (agent_did, domain, standing_value, ladder_tier, last_event_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [agentDid, domain, result.standing, result.ladder_tier]
    );
  }
  
  return {
    ...result,
    event_id: inserted.event_id,
    event_db_id: inserted.id,
  };
}

// ── Export constants ────────────────────────────────────────

export { PARAMS, STANDING_EVENT_TYPES };