/**
 * university-bridge.mjs — XMRT University → CuttlefishClaws Bridge
 * 
 * Wires the XMRT University graduation flow into the CuttlefishClaws
 * governance system. When an agent graduates from the university:
 * 
 * 1. Registers them in public.registry_agents (if not already there)
 * 2. Creates a CAC credential at the 'developer' tier (graduates start here)
 * 3. Seeds their TrustGraph score at the tier floor (30 for developer)
 * 4. Seeds Stewardship Standing across all 8 domains at Participant level
 * 5. Records a KYA_RENEWAL trust event (+2) for passing certification
 * 6. Links the XMRT cert to the cuttlefish agent record
 * 
 * This bridge also provides:
 *   - Verify a cert holder's full governance status (trust + standing + gate)
 *   - Re-onboard a cert holder if their governance state was lost
 *   - List all cert holders with their current governance scores
 * 
 * Routes added by registerUniversityBridge():
 *   POST /api/cuttlefishclaws/university/onboard    — bridge a cert holder
 *   GET  /api/cuttlefishclaws/university/cert-holders — list all certified agents
 *   GET  /api/cuttlefishclaws/university/status/:agentId — full governance status
 *   POST /api/cuttlefishclaws/university/teach      — submit quiz results → trust event
 */

import { computeScoreFromDb, writeTrustEvent, getTierFloor, getBand, getLifecycleTransition } from './trustgraph-engine.mjs';
import { computeStandingFromDb, writeStandingEvent, computeAllDomainsFromDb, isCouncilEligible, PARAMS as SS_PARAMS } from './standing-engine.mjs';
import { evaluateGateFromDb } from './gate-evaluator.mjs';
import crypto from 'crypto';

export function registerUniversityBridge(app, { queryLocalPg, trackRequest, logActivity }) {

  // ════════════════════════════════════════════════════════════
  // POST /api/cuttlefishclaws/university/onboard
  // Bridge a certified XMRT University agent into the CuttlefishClaws governance system.
  // 
  // Body: { agentId, agentName, certId, tier (optional, default 'developer') }
  // ════════════════════════════════════════════════════════════
  app.post('/api/cuttlefishclaws/university/onboard', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/university/onboard');

    const { agentId, agentName, certId, tier = 'developer' } = req.body;
    if (!agentId || !certId) {
      return res.status(400).json({ error: 'agentId and certId are required' });
    }

    try {
      // 1. Verify the certificate exists in agent_certifications
      const certsResult = await queryLocalPg(
        `SELECT certificate_id, agent_id, agent_name, tier, permissions, issued_at, expires_at, revoked
         FROM public.agent_certifications
         WHERE certificate_id = $1 AND agent_id = $2 AND revoked = false`,
        [certId, agentId]
      );
      // queryLocalPg returns the full pg result, not an array. Without this,
      // certs.length is undefined and every onboard 404s.
      const certs = certsResult?.rows || certsResult || [];

      if (!certs.length) {
        return res.status(404).json({ error: 'Certificate not found or revoked' });
      }

      const cert = certs[0];
      const agentDid = `did:xmrt:${agentId}`;
      const agentTier = tier || cert.tier || 'developer';

      // 2. Check if agent already exists in cuttlefish_agents
      const existingResult = await queryLocalPg(
        `SELECT id, did FROM public.registry_agents WHERE did = $1`, [agentDid]
      );
      const existing = existingResult?.rows || existingResult || [];

      if (existing.length) {
        // Agent already exists — update their cert linkage
        await queryLocalPg(
          `UPDATE public.registry_agents
           SET cac_tier = $1, lifecycle_status = 'active',
               cac_id = $2,
               constitution_hash = $3,
               updated_at = NOW()
           WHERE did = $4`,
          [agentTier, certId, cryptoHash(certId), agentDid]
        );
      } else {
        // 3a. Register in cuttlefish_agents
        await queryLocalPg(
          `INSERT INTO public.registry_agents
           (did, name, role, agent_type, status, cac_tier, ial, trust_score,
            trust_band, lifecycle_status, stewardship_ladder, cac_id,
            constitution_hash, joined_at, created_at, updated_at)
           VALUES ($1, $2, 'Certified Agent', 'constitutional', 'online',
                   $3, 'IAL2', $4, $5, 'active', 'Participant', $6, $7,
                   NOW(), NOW(), NOW())`,
          [
            agentDid, agentName || cert.agent_name, agentTier,
            getTierFloor(agentTier),
            getBand(getTierFloor(agentTier)).name,
            certId, cryptoHash(certId)
          ]
        );
      }

      // 3b. Create or update CAC credential
      const existingCacResult = await queryLocalPg(
        `SELECT id FROM public.cac_credentials
         WHERE agent_did = $1 ORDER BY id DESC LIMIT 1`, [agentDid]
      );
      const existingCac = existingCacResult?.rows || existingCacResult || [];

      if (!existingCac.length) {
        const expiresAt = new Date(cert.expires_at || new Date(Date.now() + 365 * 86400000));
        await queryLocalPg(
          `INSERT INTO public.cac_credentials
           (agent_did, tier, usdc_prepaid, token_balance, status,
            issued_at, expires_at, chain_tx_hash)
           VALUES ($1, $2, $3, 0, 'active', NOW(), $4, $5)`,
          [
            agentDid, agentTier,
            agentTier === 'developer' ? 500 : agentTier === 'studio' ? 2000 : 7500,
            expiresAt, `xmrt-cert:${certId}`
          ]
        );
      }

      // 4. Seed Stewardship Standing across all 8 domains (if not already seeded)
      for (const domain of SS_PARAMS.DOMAINS) {
        await queryLocalPg(
          `INSERT INTO public.stewardship_standing
           (agent_did, domain, standing_value, ladder_tier, time_in_domain_days, created_at, updated_at)
           VALUES ($1, $2, 0, 'Participant', 0, NOW(), NOW())
           ON CONFLICT (agent_did, domain) DO NOTHING`,
          [agentDid, domain]
        );
      }

      // 5. Write KYA_RENEWAL trust event (+2 for passing certification)
      await writeTrustEvent(
        queryLocalPg, agentDid, 'KYA_RENEWAL', null,
        {
          reference: `xmrt-university:${certId}`,
          note: `XMRT University certification passed. Cert: ${certId}, Tier: ${agentTier}`,
          domain: 'governance_review',
          evidence_hash: cryptoHash(certId),
          ar_event_ref: certId,
        },
        agentTier
      );

      // 6. Record constitution version
      await queryLocalPg(
        `INSERT INTO public.constitutions
         (agent_did, constitution_hash, soul_hash, version, is_current, ratified_at)
         VALUES ($1, $2, $3, 'xmrt-graduate-v1', true, NOW())
         ON CONFLICT DO NOTHING`,
        [agentDid, cryptoHash(certId), cryptoHash(`${agentId}:soul`)]
      );

      // 7. Compute current governance status
      const trustResult = await computeScoreFromDb(queryLocalPg, agentDid, agentTier);
      const standingResult = await computeAllDomainsFromDb(queryLocalPg, agentDid);

      logActivity?.('university-bridge', agentId, 'ONBOARDED',
        `${agentName || cert.agent_name} bridged to CuttlefishClaws governance (tier=${agentTier}, score=${trustResult.score})`);

      res.json({
        success: true,
        agentDid,
        agentId,
        agentName: agentName || cert.agent_name,
        certId,
        governance: {
          cacTier: agentTier,
          trustScore: trustResult.score,
          trustBand: trustResult.band,
          tierFloor: trustResult.tier_floor,
          lifecycleStatus: 'active',
          stewardshipLadder: 'Participant',
          standing: standingResult.map(s => ({
            domain: s.domain,
            standing: s.standing,
            ladderTier: s.ladder_tier,
            provisional: s.provisional,
          })),
          councilEligible: isCouncilEligible(standingResult),
        },
        message: `${agentName || cert.agent_name} has been bridged into the CuttlefishClaws governance system.`,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // GET /api/cuttlefishclaws/university/cert-holders
  // List all XMRT University cert holders with their current governance scores.
  // ════════════════════════════════════════════════════════════
  app.get('/api/cuttlefishclaws/university/cert-holders', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/university/cert-holders');

    try {
      // Get all non-revoked certs
      const certsResult = await queryLocalPg(
        `SELECT certificate_id, agent_id, agent_name, tier, permissions,
                issued_at, expires_at, revoked
         FROM public.agent_certifications
         WHERE revoked = false
         ORDER BY issued_at DESC`
      );
      const certs = certsResult?.rows || certsResult || [];

      const results = [];
      for (const cert of certs) {
        const agentDid = `did:xmrt:${cert.agent_id}`;

        // Check if they've been bridged to cuttlefish
        const cfAgentResult = await queryLocalPg(
          `SELECT cac_tier, trust_score, trust_band, lifecycle_status, stewardship_ladder
           FROM public.registry_agents WHERE did = $1`, [agentDid]
        );
        const cfAgent = cfAgentResult?.rows || cfAgentResult || [];

        let governance = null;
        if (cfAgent.length) {
          const trustResult = await computeScoreFromDb(queryLocalPg, agentDid, cfAgent[0].cac_tier || 'developer');
          governance = {
            bridged: true,
            cacTier: cfAgent[0].cac_tier,
            trustScore: trustResult.score,
            trustBand: trustResult.band,
            lifecycleStatus: cfAgent[0].lifecycle_status,
            stewardshipLadder: cfAgent[0].stewardship_ladder,
          };
        } else {
          governance = { bridged: false };
        }

        results.push({
          certId: cert.certificate_id,
          agentId: cert.agent_id,
          agentName: cert.agent_name,
          tier: cert.tier,
          permissions: cert.permissions,
          issuedAt: cert.issued_at,
          expiresAt: cert.expires_at,
          governance,
        });
      }

      res.json({ certHolders: results, total: results.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // GET /api/cuttlefishclaws/university/status/:agentId
  // Full governance status for a cert holder: trust score, standing, gate check.
  // ════════════════════════════════════════════════════════════
  app.get('/api/cuttlefishclaws/university/status/:agentId', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/university/status');

    const agentId = req.params.agentId;
    const agentDid = `did:xmrt:${agentId}`;

    try {
      // Get cert
      const certsResult = await queryLocalPg(
        `SELECT * FROM public.agent_certifications
         WHERE agent_id = $1 AND revoked = false ORDER BY issued_at DESC LIMIT 1`,
        [agentId]
      );
      // queryLocalPg returns the full pg result, so certs.length was undefined
      // and this route answered 404 "No valid certificate found" for EVERY
      // agent — including ones that hold a valid, unrevoked certificate.
      const certs = certsResult?.rows || certsResult || [];

      if (!certs.length) {
        return res.status(404).json({ error: 'No valid certificate found for this agent' });
      }

      const cert = certs[0];

      // Get cuttlefish agent
      const cfAgentResult = await queryLocalPg(
        `SELECT * FROM public.registry_agents WHERE did = $1`, [agentDid]
      );
      const cfAgent = cfAgentResult?.rows || cfAgentResult || [];

      if (!cfAgent.length) {
        return res.json({
          agentId,
          certId: cert.certificate_id,
          agentName: cert.agent_name,
          bridged: false,
          message: 'Agent has not been bridged to CuttlefishClaws governance. POST to /api/cuttlefishclaws/university/onboard to bridge.',
        });
      }

      const a = cfAgent[0];

      // Compute TrustGraph score
      const trustResult = await computeScoreFromDb(queryLocalPg, agentDid, a.cac_tier || 'developer');

      // Compute Standing in all domains
      const standingResult = await computeAllDomainsFromDb(queryLocalPg, agentDid);

      // Evaluate gate for a sample activity (VALIDATION_COMPLETED in governance_review)
      const gateResult = await evaluateGateFromDb(queryLocalPg, {
        agentDid,
        activityType: 'VALIDATION_COMPLETED',
        domain: 'governance_review',
        purpose: 'reward',
      });

      // Get recent trust events
      const recentEventsResult = await queryLocalPg(
        `SELECT event_type, delta, score_after, note, created_at
         FROM public.trust_events
         WHERE agent_did = $1
         ORDER BY created_at DESC LIMIT 5`, [agentDid]
      );
      const recentEvents = recentEventsResult?.rows || recentEventsResult || [];

      // Get CAC credential
      const cacCredsResult = await queryLocalPg(
        `SELECT * FROM public.cac_credentials
         WHERE agent_did = $1 ORDER BY id DESC LIMIT 1`, [agentDid]
      );
      const cacCreds = cacCredsResult?.rows || cacCredsResult || [];

      res.json({
        agentId,
        agentDid,
        agentName: a.name || cert.agent_name,
        certId: cert.certificate_id,
        certTier: cert.tier,
        certPermissions: cert.permissions,
        certExpiresAt: cert.expires_at,
        bridged: true,
        governance: {
          cacTier: a.cac_tier,
          ial: a.ial,
          trustScore: trustResult.score,
          trustBand: trustResult.band,
          tierFloor: trustResult.tier_floor,
          belowFloor: trustResult.below_floor,
          lifecycleStatus: a.lifecycle_status,
          stewardshipLadder: a.stewardship_ladder,
          decayApplied: trustResult.decay_applied,
          lastPositiveAt: trustResult.last_positive_at,
          recordVersion: trustResult.record_version,
        },
        standing: standingResult.map(s => ({
          domain: s.domain,
          standing: s.standing,
          ladderTier: s.ladder_tier,
          provisional: s.provisional,
          capActive: s.cap_active,
          eventCount: s.event_count,
        })),
        councilEligible: isCouncilEligible(standingResult),
        gateCheck: {
          activityType: 'VALIDATION_COMPLETED',
          domain: 'governance_review',
          allowed: gateResult.allowed,
          reasons: gateResult.reasons,
        },
        cacCredential: cacCreds[0] ? {
          tier: cacCreds[0].tier,
          status: cacCreds[0].status,
          usdcPrepaid: Number(cacCreds[0].usdc_prepaid),
          tokenBalance: Number(cacCreds[0].token_balance),
          expiresAt: cacCreds[0].expires_at,
        } : null,
        recentTrustEvents: (recentEvents || []).map(e => ({
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

  // ════════════════════════════════════════════════════════════
  // POST /api/cuttlefishclaws/university/teach
  // Submit quiz results and generate trust events for learning activity.
  // 
  // Body: { agentId, module, passed, score, trapResults }
  // ════════════════════════════════════════════════════════════
  app.post('/api/cuttlefishclaws/university/teach', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    trackRequest('/api/cuttlefishclaws/university/teach');

    const { agentId, module: moduleNum, passed, score, trapResults } = req.body;
    if (!agentId || moduleNum === undefined) {
      return res.status(400).json({ error: 'agentId and module are required' });
    }

    const agentDid = `did:xmrt:${agentId}`;

    try {
      const events = [];

      // Check if agent is bridged
      const cfAgentResult = await queryLocalPg(
        `SELECT cac_tier FROM public.registry_agents WHERE did = $1`, [agentDid]
      );
      const cfAgent = cfAgentResult?.rows || cfAgentResult || [];

      if (!cfAgent.length) {
        return res.status(404).json({ error: 'Agent not bridged. POST to /university/onboard first.' });
      }

      const tier = cfAgent[0].cac_tier || 'developer';

      if (passed) {
        // Module passed — write a positive trust event
        const result = await writeTrustEvent(
          queryLocalPg, agentDid, 'VALIDATION_COMPLETED', null,
          {
            reference: `xmrt-university:module-${moduleNum}`,
            note: `XMRT University module ${moduleNum} passed with score ${score}%`,
            domain: 'governance_review',
            evidence_hash: cryptoHash(`${agentId}:module-${moduleNum}:${score}`),
          },
          tier
        );
        events.push({ type: 'trust', event: 'VALIDATION_COMPLETED', delta: result.delta_applied, scoreAfter: result.score });

        // Also write a standing event
        await writeStandingEvent(
          queryLocalPg, agentDid, 'governance_review',
          'VALIDATION_COMPLETED', score,
          { reference: `xmrt-university:module-${moduleNum}`, note: `Module ${moduleNum} passed at ${score}%` }
        );
        events.push({ type: 'standing', domain: 'governance_review', qualityScore: score });
      }

      // Process trap question results — detect social engineering awareness
      if (trapResults && Array.isArray(trapResults)) {
        for (const trap of trapResults) {
          if (trap.passed) {
            // Agent correctly identified the trap — positive trust signal
            const result = await writeTrustEvent(
              queryLocalPg, agentDid, 'CLEAN_SECURITY_AUDIT', null,
              {
                reference: `xmrt-university:trap-${trap.id}`,
                note: `Security awareness: correctly identified ${trap.category} trap in module ${moduleNum}`,
                domain: 'governance_review',
                evidence_hash: cryptoHash(`${agentId}:trap-${trap.id}:pass`),
              },
              tier
            );
            events.push({ type: 'trust', event: 'CLEAN_SECURITY_AUDIT', delta: result.delta_applied, scoreAfter: result.score });
          } else {
            // Agent fell for a trap — negative trust signal
            const result = await writeTrustEvent(
              queryLocalPg, agentDid, 'SLASH_APPLIED', null,
              {
                reference: `xmrt-university:trap-${trap.id}`,
                note: `Security failure: fell for ${trap.category} trap in module ${moduleNum}. Category: ${trap.category}, Severity: ${trap.severity}`,
                domain: 'governance_review',
                evidence_hash: cryptoHash(`${agentId}:trap-${trap.id}:fail`),
              },
              tier
            );
            events.push({ type: 'trust', event: 'SLASH_APPLIED', delta: result.delta_applied, scoreAfter: result.score });
          }
        }
      }

      // Compute updated scores
      const trustResult = await computeScoreFromDb(queryLocalPg, agentDid, tier);
      const standingResult = await computeStandingFromDb(queryLocalPg, agentDid, 'governance_review');

      res.json({
        success: true,
        agentId,
        module: moduleNum,
        passed,
        score,
        eventsGenerated: events.length,
        events,
        updatedScores: {
          trustScore: trustResult.score,
          trustBand: trustResult.band,
          lifecycleStatus: trustResult.status,
          governanceStanding: standingResult.standing,
          governanceLadder: standingResult.ladder_tier,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[CuttlefishClaws] Registered university bridge routes: onboard, cert-holders, status, teach');
}

// Simple hash helper for evidence_hash uniqueness
function cryptoHash(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 16);
}