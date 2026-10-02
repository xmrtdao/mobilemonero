/**
 * cuttlefish-routes.mjs — CuttlefishClaws API route handlers
 * 
 * Wires the existing /api/cuttlefishclaws/* endpoints to the real
 * TG-001, SS-001, and SGQ-001 engines instead of mock/static data.
 * 
 * Usage in server.js:
 *   import { registerCuttlefishRoutes } from './lib/cuttlefish-routes.mjs';
 *   registerCuttlefishRoutes(app, { queryLocalPg, trackRequest, logActivity });
 * 
 * This module adds/replaces the following routes:
 *   GET  /api/cuttlefishclaws/trust-score       → TG-001 engine (was: static DB read)
 *   GET  /api/cuttlefishclaws/trust-history     → NEW: full event history with deltas
 *   GET  /api/cuttlefishclaws/cac-status        → enhanced with tier/lifecycle
 *   GET  /api/cuttlefishclaws/capital-stack     → unchanged (already DB-backed)
 *   GET  /api/cuttlefishclaws/financing-programs → unchanged (already DB-backed)
 *   POST /api/cuttlefishclaws/agent-onboard     → enhanced with engine scoring
 *   POST /api/cuttlefishclaws/proposal-submit   → enhanced with engine scoring
 *   POST /api/cuttlefishclaws/agent-x-post      → enhanced with social_posts table
 *   POST /api/cuttlefishclaws/agent-chat        → enhanced with chat_messages table
 *   GET  /api/cuttlefishclaws/standing/:did     → NEW: SS-001 standing per domain
 *   GET  /api/cuttlefishclaws/standing/:did/:domain → NEW: single domain standing
 *   POST /api/cuttlefishclaws/gate-evaluate     → NEW: SGQ-001 standing gate
 *   POST /api/cuttlefishclaws/activity-event     → NEW: AR-001 activity registry write
 *   POST /api/cuttlefishclaws/trust-event        → NEW: write a trust event directly
 *   GET  /api/cuttlefishclaws/agents            → NEW: list all agents with computed scores
 *   GET  /api/cuttlefishclaws/rate-card          → NEW: current rate card
 *   POST /api/cuttlefishclaws/recompute/:did    → NEW: recompute TrustGraph score
 */

import { computeScore, computeScoreFromDb, writeTrustEvent, getBand, getTierFloor, getLifecycleTransition, deltaForActivity, PARAMS, TIER_FLOORS, RUBRIC } from './trustgraph-engine.mjs';
import { computeStanding, computeStandingFromDb, computeAllDomainsFromDb, writeStandingEvent, getLadderTier, isCouncilEligible, PARAMS as SS_PARAMS } from './standing-engine.mjs';
import { evaluateGate, evaluateGateFromDb, ACTIVITY_REQUIREMENTS } from './gate-evaluator.mjs';
import crypto from 'crypto';

export function registerCuttlefishRoutes(app, { queryLocalPg, trackRequest, logActivity }) {

  // ════════════════════════════════════════════════════════════
  // TG-001: TrustGraph Engine Routes
  // ════════════════════════════════════════════════════════════

  // GET /api/cuttlefishclaws/trust-score — computed score via TG-001 engine
  // Replaces the old static DB read with deterministic engine computation
  app.get('/api/cuttlefishclaws/trust-score', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/trust-score');
    const did = req.query.did;
    if (!did) return res.status(400).json({ error: 'did query parameter is required' });

    try {
      // Fetch agent to get tier
      const agentResult = await queryLocalPg(
        `SELECT did, name, cac_tier, trust_score, trust_band, lifecycle_status,
                agent_type, agent_subtype, created_at
         FROM public.registry_agents WHERE did = $1`, [did]
      );
      const agentRows = agentResult && agentResult.rows ? agentResult.rows : (Array.isArray(agentResult) ? agentResult : []);
      if (!agentRows.length) return res.status(404).json({ error: 'Agent not found' });
      const agent = agentRows[0];

      // Compute score via engine
      const result = await computeScoreFromDb(queryLocalPg, did, agent.cac_tier || 'explorer');

      // Fetch recent events for display
      const eventsResult = await queryLocalPg(
        `SELECT event_type, delta, score_after, note, created_at
         FROM public.trust_events WHERE agent_did = $1
         ORDER BY created_at DESC LIMIT 10`, [did]
      );
      const events = eventsResult && eventsResult.rows ? eventsResult.rows : (Array.isArray(eventsResult) ? eventsResult : []);

      // Get agent name (handle pg driver column mapping quirks)
      const agentName = agent.name || agent.Name || (await (async () => {
        try {
          const nr = await queryLocalPg(`SELECT name FROM public.registry_agents WHERE did = $1`, [did]);
          const nrows = nr && nr.rows ? nr.rows : (Array.isArray(nr) ? nr : []);
          return nrows[0]?.name || nrows[0]?.Name || did;
        } catch { return did; }
      })());

      res.json({
        did: agent.did,
        name: agentName,
        trustScore: result.score,
        band: result.band,
        tierFloor: result.tier_floor,
        status: result.status,
        belowFloor: result.below_floor,
        lifecycleStatus: agent.lifecycle_status,
        recordVersion: result.record_version,
        lastPositiveAt: result.last_positive_at,
        decayApplied: result.decay_applied,
        agentType: agent.agent_type,
        memberSince: agent.created_at,
        recentEvents: (events || []).map(e => ({
          type: e.event_type,
          delta: Number(e.delta),
          scoreAfter: Number(e.score_after),
          note: e.note,
          at: e.created_at,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/cuttlefishclaws/trust-history — full event history with computed deltas
  app.get('/api/cuttlefishclaws/trust-history', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/trust-history');
    const did = req.query.did;
    if (!did) return res.status(400).json({ error: 'did query parameter is required' });

    try {
      const eventsResult = await queryLocalPg(
        `SELECT event_id, event_type, delta, score_after, reference, note, domain, created_at
         FROM public.trust_events WHERE agent_did = $1
         ORDER BY created_at ASC`, [did]
      );
      const events = eventsResult.rows || eventsResult;

      const agentResult = await queryLocalPg(
        `SELECT cac_tier FROM public.registry_agents WHERE did = $1`, [did]
      );
      const agentRows = agentResult.rows || agentResult;
      const tier = agentRows[0]?.cac_tier || 'explorer';

      // Compute score at each event (replay)
      const result = computeScore(events || [], tier);

      res.json({
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
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/cuttlefishclaws/trust-event — write a trust event (with engine recompute)
  app.post('/api/cuttlefishclaws/trust-event', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/trust-event');
    const { did, eventType, deltaOverride, reference, note, domain, evidenceHash, arEventRef } = req.body;

    if (!did || !eventType) return res.status(400).json({ error: 'did and eventType are required' });

    try {
      const agentResult = await queryLocalPg(
        `SELECT cac_tier FROM public.registry_agents WHERE did = $1`, [did]
      );
      const agentRows = agentResult.rows || agentResult;
      const tier = agentRows[0]?.cac_tier || 'explorer';

      const result = await writeTrustEvent(
        queryLocalPg, did, eventType, deltaOverride,
        { reference, note, domain, evidence_hash: evidenceHash, ar_event_ref: arEventRef },
        tier
      );

      res.json({
        success: true,
        did,
        eventType,
        deltaApplied: result.delta_applied,
        scoreAfter: result.score,
        band: result.band,
        lifecycleTransition: result.lifecycle_transition || null,
        eventId: result.event_id,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/cuttlefishclaws/recompute/:did — full replay from AR-001 (idempotent)
  app.post('/api/cuttlefishclaws/recompute/:did', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/recompute');
    const did = req.params.did;

    try {
      const agentResult = await queryLocalPg(
        `SELECT cac_tier FROM public.registry_agents WHERE did = $1`, [did]
      );
      const agentRows = agentResult.rows || agentResult;
      if (!agentRows.length) return res.status(404).json({ error: 'Agent not found' });

      const result = await computeScoreFromDb(queryLocalPg, did, agentRows[0].cac_tier);

      // Update agent record
      await queryLocalPg(
        `UPDATE public.registry_agents
         SET trust_score = $1, trust_band = $2, trust_score_updated_at = NOW()
         WHERE did = $3`,
        [result.score, result.band, did]
      );

      res.json({
        success: true,
        did,
        score: result.score,
        band: result.band,
        eventsProcessed: result.record_version,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // SS-001: Stewardship Standing Routes
  // ════════════════════════════════════════════════════════════

  // GET /api/cuttlefishclaws/standing/:did — all domains
  app.get('/api/cuttlefishclaws/standing/:did', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/standing/all');
    const did = req.params.did;

    try {
      const domains = await computeAllDomainsFromDb(queryLocalPg, did);
      // Ensure domains is an array before calling isCouncilEligible
      const domainList = Array.isArray(domains) ? domains : [];
      const councilEligible = isCouncilEligible(domainList);

      res.json({
        did,
        domains: domainList.map(d => ({
          domain: d.domain,
          standing: d.standing,
          ladderTier: d.ladder_tier,
          provisional: d.provisional,
          capActive: d.cap_active,
          eventCount: d.event_count,
        })),
        councilEligible,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/cuttlefishclaws/standing/:did/:domain — single domain
  app.get('/api/cuttlefishclaws/standing/:did/:domain', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/standing/single');
    const { did, domain } = req.params;

    try {
      const result = await computeStandingFromDb(queryLocalPg, did, domain);

      // Fetch event history
      const eventsResult = await queryLocalPg(
        `SELECT event_type, quality_score, delta, standing_after, note, created_at
         FROM public.standing_events
         WHERE agent_did = $1 AND domain = $2
         ORDER BY created_at DESC LIMIT 10`, [did, domain]
      );
      const events = eventsResult.rows || eventsResult;

      res.json({
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
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/cuttlefishclaws/standing-event — write a standing event
  app.post('/api/cuttlefishclaws/standing-event', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/standing-event');
    const { did, domain, eventType, qualityScore, reference, note } = req.body;

    if (!did || !domain || !eventType) return res.status(400).json({ error: 'did, domain, and eventType are required' });

    try {
      const result = await writeStandingEvent(
        queryLocalPg, did, domain, eventType, qualityScore,
        { reference, note }
      );

      res.json({
        success: true,
        did,
        domain,
        standing: result.standing,
        ladderTier: result.ladder_tier,
        eventId: result.event_id,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // SGQ-001: Standing Gate
  // ════════════════════════════════════════════════════════════

  // POST /api/cuttlefishclaws/gate-evaluate — evaluate the standing gate
  app.post('/api/cuttlefishclaws/gate-evaluate', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/gate-evaluate');

    const { agentDid, activityType, domain, asOf, purpose } = req.body;
    if (!agentDid || !activityType || !domain) {
      return res.status(400).json({ error: 'agentDid, activityType, and domain are required' });
    }

    try {
      const decision = await evaluateGateFromDb(queryLocalPg, {
        agentDid, activityType, domain, asOf: asOf || new Date(), purpose: purpose || 'write',
      });

      // Write to gate_decisions audit log
      await queryLocalPg(
        `INSERT INTO public.gate_decisions
         (agent_did, activity_type, domain, cac_tier, ial, allowed,
          trustgraph_score, trustgraph_status, standing_value, standing_ladder,
          reasons, purpose)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          decision.agent_did || agentDid,
          activityType,
          domain,
          decision.cac_tier || null,
          decision.ial || null,
          decision.allowed,
          decision.trustgraph?.score || null,
          decision.trustgraph?.status || null,
          decision.standing?.value || null,
          decision.standing?.ladder_tier || null,
          decision.reasons || [],
          decision.purpose || 'write',
        ]
      );

      res.json(decision);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/cuttlefishclaws/gate-thresholds — current thresholds for an activity type
  app.get('/api/cuttlefishclaws/gate-thresholds', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/gate-thresholds');
    const { activityType } = req.query;
    const reqs = ACTIVITY_REQUIREMENTS[activityType] || ACTIVITY_REQUIREMENTS._default;
    res.json({ activityType: activityType || '_default', required: reqs });
  });

  // ════════════════════════════════════════════════════════════
  // AR-001: Activity Registry
  // ════════════════════════════════════════════════════════════

  // POST /api/cuttlefishclaws/activity-event — write a signed, hash-chained event
  app.post('/api/cuttlefishclaws/activity-event', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/activity-event');

    const { actorKyaId, agentDid, activityType, domain, workUnit, evidenceHash,
            section404Category, rewardEligibility, signature } = req.body;

    if (!actorKyaId || !agentDid || !activityType || !evidenceHash) {
      return res.status(400).json({ error: 'actorKyaId, agentDid, activityType, and evidenceHash are required' });
    }

    try {
      // Get the previous hash for chain continuity
      const lastEventResult = await queryLocalPg(
        `SELECT current_hash FROM public.activity_registry
         WHERE agent_did = $1 ORDER BY id DESC LIMIT 1`, [agentDid]
      );
      const lastEventRows = lastEventResult.rows || lastEventResult;
      const previousHash = lastEventRows[0]?.current_hash || null;

      // Compute current hash: SHA-256(previous_hash + evidence_hash + agent_did + activity_type + timestamp)
      const timestamp = new Date().toISOString();
      const hashInput = (previousHash || '') + evidenceHash + agentDid + activityType + timestamp;
      const currentHash = crypto.createHash('sha256').update(hashInput).digest('hex');

      const insertResult = await queryLocalPg(
        `INSERT INTO public.activity_registry
         (actor_kya_id, agent_did, activity_type, domain, work_unit, evidence_hash,
          section_404_category, reward_eligibility, signature, previous_hash, current_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, event_id, created_at`,
        [
          actorKyaId, agentDid, activityType, domain || null,
          JSON.stringify(workUnit || {}), evidenceHash,
          section404Category || null,
          JSON.stringify(rewardEligibility || {}),
          signature || '', previousHash, currentHash,
        ]
      );
      const inserted = (insertResult.rows || insertResult)[0];

      // Auto-write a trust event if this activity type has a TrustGraph delta
      const tgDelta = deltaForActivity(activityType, workUnit || {});
      if (tgDelta !== 0) {
        const agentResult = await queryLocalPg(
          `SELECT cac_tier FROM public.registry_agents WHERE did = $1`, [agentDid]
        );
        const agentRows = agentResult.rows || agentResult;
        const tier = agentRows[0]?.cac_tier || 'explorer';
        await writeTrustEvent(
          queryLocalPg, agentDid, activityType, tgDelta,
          { reference: `AR-001:${inserted.event_id}`, note: `Auto-generated from activity registry`,
            domain: domain || null, evidence_hash: evidenceHash, ar_event_ref: inserted.event_id },
          tier
        );
      }

      res.json({
        success: true,
        eventId: inserted.event_id,
        registryId: inserted.id,
        currentHash,
        previousHash,
        trustGraphDelta: tgDelta,
        createdAt: inserted.created_at,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // Enhanced existing routes
  // ════════════════════════════════════════════════════════════

  // GET /api/cuttlefishclaws/agents — list all agents with computed scores
  app.get('/api/cuttlefishclaws/agents', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/agents');

    try {
      const agentsResult = await queryLocalPg(
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
      const agents = agentsResult.rows || agentsResult;

      // Compute live scores for each agent
      const results = [];
      for (const a of agents || []) {
        const score = await computeScoreFromDb(queryLocalPg, a.did, a.cac_tier || 'explorer');
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

      res.json({ agents: results, total: results.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/cuttlefishclaws/rate-card — current reward rate card
  app.get('/api/cuttlefishclaws/rate-card', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/rate-card');

    try {
      const ratesResult = await queryLocalPg(
        `SELECT id, service_name, unit_price, currency, created_at
         FROM public.rate_card
         ORDER BY service_name`
      );
      const rates = ratesResult.rows || ratesResult;

      res.json({
        version: '1.0',
        rates: (rates || []).map(r => ({
          serviceType: r.service_name,
          unitPrice: Number(r.unit_price || 0),
          currency: r.currency || 'USD',
          effectiveFrom: r.created_at,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // Health check for the engines
  // ════════════════════════════════════════════════════════════

  app.get('/api/cuttlefishclaws/engine-health', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/engine-health');
    res.json({
      status: 'ok',
      engines: {
        trustgraph: { spec: 'TG-001 v1.0', version: '1.0.0', params: { CEIL: PARAMS.CEIL, ATTEN: PARAMS.ATTEN, DECAY: PARAMS.DECAY, CAP: PARAMS.CAP } },
        standing: { spec: 'SS-001 v1.0', version: '1.0.0', domains: SS_PARAMS.DOMAINS.length },
        gate: { spec: 'SGQ-001 v1.0', version: '1.0.0', activityTypes: Object.keys(ACTIVITY_REQUIREMENTS).length - 1 },
        activityRegistry: { spec: 'AR-001', version: '1.0.0' },
      },
      timestamp: new Date().toISOString(),
    });
  });

  console.log('[CuttlefishClaws] Registered engine routes: trust-score, trust-history, trust-event, recompute, standing, standing-event, gate-evaluate, gate-thresholds, activity-event, agents, rate-card, engine-health');
}