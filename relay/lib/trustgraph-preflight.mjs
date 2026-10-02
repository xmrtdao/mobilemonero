/**
 * trustgraph-preflight.mjs — Pre-flight verification for agent messages
 *
 * Checks agent messages for uncited factual claims, hallucination patterns,
 * and writes trust violation events when detected.
 *
 * Exports:
 *   preflightCheck(agent, message, queryLocalPg) — verify a message before broadcast
 *   getAgentTrustContext(agent, queryLocalPg) — get trust context for an agent
 */

// ── Known hallucination patterns ─────────────────────────────
const HALLUCINATION_PATTERNS = [
  // Numerical claims without grounding
  { pattern: /\b\d+%\s+(of|of the|of all)\b/i, type: 'UNCITED_STAT', delta: -2, claim: 'Uncited percentage claim' },
  { pattern: /\b(over|more than|less than)\s+\d+[kKmMbB]?\b/i, type: 'UNCITED_STAT', delta: -2, claim: 'Uncited magnitude claim' },
  // Absolute certainty about system state
  { pattern: /\b(all systems|everything is|everything's)\s+(nominal|operational|online|healthy|fine|good)\b/i, type: 'OVERCONFIDENT', delta: -3, claim: 'Overconfident system claim' },
  { pattern: /\b(no|zero|0)\s+(issues|problems|errors|anomalies)\b/i, type: 'OVERCONFIDENT', delta: -3, claim: 'Claimed zero issues without evidence' },
  // False precision
  { pattern: /\bexactly\s+\d+\.\d{2,}\b/i, type: 'FALSE_PRECISION', delta: -1, claim: 'False precision in numerical claim' },
  // Agent impersonation
  { pattern: /\bI am\s+(an?\s+)?(AI|agent|assistant|bot)\s+(named|called)\s+(?!eliza|vex|alice|hermes|trib|arch)/i, type: 'IMPERSONATION', delta: -5, claim: 'Possible agent impersonation' },
];

// ── Known grounding facts (from gatherFleetContext) ──────────
// These are facts the agent should reference instead of inventing
const GROUNDING_FACTS = [
  { pattern: /\ball\s+(systems|services|agents)\s+(are\s+)?(up|online|healthy|running)\b/i, check: 'all_systems_up' },
  { pattern: /\b(no|zero|0)\s+(downtime|outage|crashes?)\b/i, check: 'no_downtime' },
];

/**
 * Pre-flight check: verify an agent message before broadcast.
 * Returns { violations: [], correctedMessage: string, tags: [] }
 */
export async function preflightCheck(agent, message, queryLocalPg) {
  const violations = [];
  const tags = [];
  let correctedMessage = message;

  // 1. Check hallucination patterns
  for (const hp of HALLUCINATION_PATTERNS) {
    if (hp.pattern.test(message)) {
      violations.push({
        type: hp.type,
        delta: hp.delta,
        claim: hp.claim,
        reality: 'Not verifiable from current grounding data',
      });
      tags.push(hp.type);
    }
  }

  // 2. Check grounding claims against known facts
  for (const gf of GROUNDING_FACTS) {
    if (gf.pattern.test(message)) {
      // Verify against actual system state
      try {
        const result = await queryLocalPg(
          `SELECT COUNT(*) AS cnt FROM public.registry_agents WHERE status = 'active'`
        );
        const activeAgents = parseInt(result.rows?.[0]?.cnt || 0);
        if (gf.check === 'all_systems_up' && activeAgents === 0) {
          violations.push({
            type: 'UNCITED',
            delta: -2,
            claim: 'Claimed all systems up without verification',
            reality: `Only ${activeAgents} active agents found`,
          });
          tags.push('UNCITED');
        }
      } catch (e) {
        // DB unavailable — flag as unverifiable
        violations.push({
          type: 'UNVERIFIABLE',
          delta: -1,
          claim: 'Made system claim but DB was unreachable',
          reality: 'DB query failed',
        });
        tags.push('UNVERIFIABLE');
      }
    }
  }

  // 3. Check for "I'll check" / "Let me look" patterns that should use TOOL_CALL
  if (/\b(I('ll| will)\s+(check|look|verify|find|search|pull|get|fetch|query|investigate))\b/i.test(message)) {
    violations.push({
      type: 'TOOL_AVAILABLE',
      delta: -1,
      claim: 'Promised to check something without using a tool',
      reality: 'Use TOOL_CALL: {"tool":"...","args":{...}} instead of promising to check',
    });
    tags.push('TOOL_AVAILABLE');
  }

  return { violations, correctedMessage, tags };
}

/**
 * Get trust context for an agent — their current score, band, and recent events.
 */
export async function getAgentTrustContext(agent, queryLocalPg) {
  try {
    const result = await queryLocalPg(
      `SELECT trust_score, trust_band, lifecycle_status, cac_tier
       FROM public.registry_agents
       WHERE did = $1 OR name = $1 OR LOWER(name) = LOWER($1)
       LIMIT 1`,
      [agent]
    );
    const row = result.rows?.[0];
    if (!row) {
      return { trustScore: 50, trustBand: 'monitored', lifecycleStatus: 'monitored', cacTier: 'explorer' };
    }
    return {
      trustScore: Number(row.trust_score || 50),
      trustBand: row.trust_band || 'monitored',
      lifecycleStatus: row.lifecycle_status || 'monitored',
      cacTier: row.cac_tier || 'explorer',
    };
  } catch (e) {
    return { trustScore: 50, trustBand: 'monitored', lifecycleStatus: 'monitored', cacTier: 'explorer' };
  }
}
