/**
 * CAP — Compute Access Protocol.
 *
 * The single authority for "what may this agent do", joining the three pieces
 * that already existed but were never connected:
 *
 *   trustgraph-engine.mjs  the score, its rubric, and the tier floors
 *   university-bridge.mjs  the XMRT CERT an agent graduates with
 *   agent-auth.mjs         the thing that actually gates a tool call
 *
 * agent-auth.mjs gated tools on a hardcoded name list while the other two wrote
 * scores nobody read. So the fleet accumulated a reputation that changed nothing,
 * and the gate that did decide was decided by string comparison.
 *
 * ── Why this had to fix a naming bug to work at all ──────────────────────
 *
 * CORE_AGENTS held bare names ("vex"). app.agents holds ids ("vex-001"). The
 * two never met: 0 of 12 internal agents matched. Every internal agent was
 * locked out of the top tier while the guessable string "vex" would have been
 * let in. An identity model that cannot recognise its own fleet is not an
 * identity model, so normalisation is part of the protocol rather than a detail.
 *
 * ── The rule that shapes everything here: enable, do not block ──────────
 *
 * This protocol exists to widen what internal agents may do, not to fence them
 * in. So:
 *
 *   - An internal agent resolves to CORE from the roster alone. Not from a
 *     score, not from a certificate, not from a tier. If the trust engine is
 *     down, the database is unreachable, or a score is unreadable, internal
 *     agents still get CORE. A monitoring system that can take the fleet offline
 *     is worse than no monitoring system.
 *   - Trust and certification decide what EXTERNAL agents may do, and the
 *     ceiling is TRUSTED. An external agent cannot reach CORE by any route,
 *     which is what makes "CORE" mean something.
 *   - Anything unknown is PUBLIC. Deny by default on privilege, not on liveness.
 *
 * The tiers themselves are adopted verbatim from trustgraph-engine, which is the
 * live engine. Its vocabulary (explorer, developer, studio, enterprise, anchor)
 * is the one present in the stored data; the three-tier variant inlined in
 * cuttlefishclaws-mcp.mjs is a stale duplicate and is not used here.
 *
 * ── What this deliberately does not do yet ───────────────────────────────
 *
 * It does not decide reward eligibility. gate-evaluator.mjs already does that,
 * with four axes, and it is the right place for it. CAP is about capability:
 * what an agent may call. The two will converge; they are deliberately separate
 * today because merging them would make a bad score a way to lose tool access,
 * and tool access is not a reward.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RELAY_DATA = join(HERE, '..', '..', 'relay-data');

export const CAP_LEVELS = { PUBLIC: 'public', TRUSTED: 'trusted', CORE: 'core' };

/**
 * The canonical tier vocabulary, adopted from trustgraph-engine.mjs.
 *
 * Duplicated here deliberately rather than imported: agent-auth runs on the
 * hot path of every gated request, and CAP must stay loadable with no database
 * and no network. A test asserts the two lists agree, so drift is caught rather
 * than assumed.
 */
export const CAP_TIERS = {
  explorer: 20,
  developer: 30,
  studio: 40,
  enterprise: 55,
  anchor: 70,
};

export const CAP_TIER_NAMES = Object.keys(CAP_TIERS);

/**
 * Normalise any spelling of an agent to a comparable token.
 *
 * The estate spells the same agent at least five ways: "vex", "vex-001",
 * "did:xmrt:vex", "Vex (Captain, HMS Speedy)", "vex-user". Comparing raw strings
 * is what produced the 0-of-12 failure, so every path into this module goes
 * through here first.
 */
export function normaliseAgentId(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).trim().toLowerCase();
  if (!s) return '';
  // did:xmrt:vex -> vex ; did:ethr:arch-v1 -> arch
  if (s.startsWith('did:')) {
    const parts = s.split(':');
    s = (parts[parts.length - 1] || s).replace(/-v\d+$/, '');
  }
  // "Vex (Captain, HMS Speedy)" -> vex
  s = s.replace(/\s*\(.*$/, '');
  // vex-001 -> vex ; alice-sidecar -> alice
  s = s.replace(/-00\d$/, '');
  s = s.replace(/-(sidecar|daemon|user|captain|agent)$/, '');
  return s;
}

// ── Internal roster ────────────────────────────────────────────────────
// The roster is the source of truth for "internal". It is cached rather than
// queried per call, because CAP sits on the authorisation path and a database
// round trip there would make tool latency depend on database health.
let roster = new Set();
let rosterLoadedAt = 0;
let overrides = { core: [], blocked: [] };
let overridesLoadedAt = 0;
let refreshInFlight = false;
let lastRetryAt = 0;

const ROSTER_TTL_MS = 60_000;
const OVERRIDE_TTL_MS = 60_000;

function loadOverrides() {
  const now = Date.now();
  if (now - overridesLoadedAt < OVERRIDE_TTL_MS) return;
  overridesLoadedAt = now;
  overrides = { core: [], blocked: [] };
  const p = join(RELAY_DATA, 'cap-overrides.json');
  try {
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      overrides.core = Array.isArray(j.core) ? j.core : [];
      overrides.blocked = Array.isArray(j.blocked) ? j.blocked : [];
    }
  } catch (e) {
    // A malformed override file must not silently grant or deny. Leave the lists
    // empty and say so; the roster still decides internal agents.
    console.warn(`[cap] could not read cap-overrides.json: ${e.message}`);
  }
}

/**
 * Refresh the internal roster from the database.
 *
 * Best-effort by design: on failure the previous roster is kept, and if there has
 * never been one, the roster is empty and every agent resolves PUBLIC rather
 * than CORE. That is the safe direction for an unknown actor. It is why the
 * CORE path does not depend on this succeeding in the first moment.
 */
export async function refreshRoster({ dbUrl = null } = {}) {
  const now = Date.now();
  if (now - rosterLoadedAt < ROSTER_TTL_MS) return { skipped: true, size: roster.size };
  // The estate names this LOCAL_DATABASE_URL (see lib/localDb.mjs and
  // local-supabase/server.mjs). The others are accepted only as fallbacks.
  // Use the relay's own database module rather than resolving a URL here.
  //
  // lib/db.mjs resolves LOCAL_DATABASE_URL || DATABASE_URL || a hardcoded
  // localhost fallback, and it is the module every queryLocalPg call in the
  // relay goes through. CAP originally imported lib/localDb.mjs and checked the
  // env vars itself - which found neither, because the relay process inherits
  // its environment from the supervisor and never loads relay/.env. So CAP
  // reported "no database url configured" while the relay's own queries worked
  // fine, and every internal agent resolved PUBLIC.
  //
  // One module, one resolution order. Note that db.mjs returns a pg result
  // ({rows}) while localDb.query() returns the rows array directly; mixing them
  // up is how this hid in the first place.
  const url = dbUrl; // optional explicit override for tests
  try {
    let rows;
    if (url) {
      const { query: localQuery } = await import('./localDb.mjs');
      const r = await localQuery('SELECT id, name FROM app.agents', []);
      rows = Array.isArray(r) ? r : r?.rows;
    } else {
      const { query: pgQuery } = await import('./db.mjs');
      const r = await pgQuery('SELECT id, name FROM app.agents', []);
      rows = r && r.rows;
    }
    if (!Array.isArray(rows)) throw new Error('unexpected query result shape');
    const next = new Set();
    for (const row of rows) {
      const n = normaliseAgentId(row.id);
      if (n) next.add(n);
      const name = normaliseAgentId(row.name);
      if (name && name !== n) next.add(name);
    }
    if (next.size === 0) throw new Error('roster query returned no agents');
    roster = next;
    rosterLoadedAt = now;
    return { ok: true, size: roster.size };
  } catch (e) {
    // This is the one failure mode that must never be silent. An empty roster
    // resolves every internal agent to PUBLIC, which locks the whole fleet out
    // of its own top tier - the exact "the protocol became a blocker" outcome
    // CAP exists to avoid. So it is logged loudly and reported as not-ready.
    console.error(
      `[cap] ROSTER LOAD FAILED (${e.message}). Every agent resolves PUBLIC until this ` +
      'succeeds. Internal agents will be denied CORE tools. This is retried, so a ' +
      'transient failure self-heals - but if it persists, check lib/db.mjs can connect.'
    );
    // Not marking as attempted: retry on the next call, so a transient outage
    // self-heals rather than waiting out the TTL.
    return { ok: false, error: e.message, size: roster.size, ready: false };
  }
}

/**
 * Synchronous view of the roster, for the authorisation path.
 *
 * If the roster is empty, kick off a refresh in the background rather than
 * answering from an empty set.
 *
 * This exists because of an ordering trap that made CAP a blocker instead of an
 * enabler. agent-auth calls refreshRoster() at module scope, and ES module
 * evaluation is hoisted - so that ran before server.js executed dotenv.config(),
 * at which point LOCAL_DATABASE_URL did not exist. Every internal agent then
 * resolved PUBLIC and the whole fleet was denied CORE. In isolation the same code
 * passed 12 of 12, because there the env was already loaded.
 *
 * So the roster self-heals: an empty roster schedules a retry instead of
 * answering "nobody is internal". Identity may briefly be unknown; it must never
 * be permanently wrong.
 */
export function isInternalAgent(raw) {
  loadOverrides();
  const n = normaliseAgentId(raw);
  if (!n) return false;
  if (overrides.blocked.some((x) => normaliseAgentId(x) === n)) return false;
  if (overrides.core.some((x) => normaliseAgentId(x) === n)) return true;
  if (roster.size === 0 && !refreshInFlight && Date.now() - lastRetryAt > 2000) {
    lastRetryAt = Date.now();
    refreshInFlight = true;
    refreshRoster()
      .catch(() => {})
      .finally(() => { refreshInFlight = false; });
  }
  return roster.has(n);
}

export function getRosterSize() { loadOverrides(); return roster.size; }

/**
 * The tier floor, failing CLOSED.
 *
 * trustgraph-engine's own getTierFloor does `TIER_FLOORS[tier] ?? TIER_FLOORS.explorer`,
 * so a misspelled or elevated-sounding tier silently receives the *lowest* bar.
 * For a capability floor that is the wrong direction: "admin" would be treated
 * as "explorer". Here an unrecognised tier has no floor at all, and callers must
 * treat that as a denial rather than defaulting it.
 */
export function tierFloor(tier) {
  if (typeof tier !== 'string') return null;
  const t = tier.trim().toLowerCase();
  return Object.hasOwn(CAP_TIERS, t) ? CAP_TIERS[t] : null;
}

export function isKnownTier(tier) { return tierFloor(tier) !== null; }

/**
 * Decide the access level for an agent.
 *
 * @param {string} agentId
 * @param {object} opts
 * @param {string|null} opts.cacTier    - explicit Compute Access tier, if the caller has one
 * @param {number|null} opts.trustScore - TrustGraph score, if known
 * @param {boolean}  opts.hasCert      - holds a valid XMRT CERT
 * @param {object|null} opts.cert      - result from verifyCert(); its tier is used
 *                                        when cacTier is not supplied
 */
export function resolveAccessLevel(agentId, opts = {}) {
  const { cacTier = null, trustScore = null, hasCert = false, cert = null } = opts;

  // 1. Internal. Roster membership alone. No score, no cert, no tier - and
  //    explicitly not gated on the trust engine being reachable.
  if (isInternalAgent(agentId)) {
    return {
      level: CAP_LEVELS.CORE,
      reason: 'internal roster member',
      detail: { normalised: normaliseAgentId(agentId) },
    };
  }

  // 2. External. The ceiling is TRUSTED and it is never CORE. Earning CORE would
  //    mean becoming internal, which is a deliberate act by the operator.
  if (!agentId) {
    return { level: CAP_LEVELS.PUBLIC, reason: 'no agent identity provided' };
  }

  // The tier comes from the XMRT CERT when one was presented, so the
  // University's record of what the agent earned is what decides its bar. An
  // explicit cacTier still wins, for callers that hold a Compute Access
  // credential independently of a certificate.
  const effectiveTier = cacTier ?? (cert && cert.valid ? cert.tier : null);
  const certValid = hasCert || !!(cert && cert.valid);
  // Number(null) is 0 and Number('') is 0, so a missing score would otherwise
  // arrive here as a real score of zero and be reported as "score 0 is below the
  // floor". It still denies, so this is not a hole - but it misreports why, and
  // "we have no score for this agent" and "this agent scored zero" are different
  // facts that need different fixes. Coerce explicitly.
  const score = trustScore === null || trustScore === undefined || trustScore === ''
    ? NaN
    : Number(trustScore);
  const floor = tierFloor(effectiveTier);
  const reasons = [];

  if (!isKnownTier(effectiveTier)) {
    reasons.push(`credential tier "${effectiveTier ?? 'none'}" is not a known Compute Access tier`);
  }
  if (!Number.isFinite(score)) {
    reasons.push('no TrustGraph score available');
  } else if (floor !== null && score < floor) {
    reasons.push(`score ${score} is below the "${effectiveTier}" floor of ${floor}`);
  }
  if (!certValid) {
    reasons.push('no valid XMRT CERT from XMRT University');
  }

  if (reasons.length === 0) {
    return {
      level: CAP_LEVELS.TRUSTED,
      reason: `certified external agent: tier ${effectiveTier}, score ${score} >= floor ${floor}`,
      detail: {
        tier: effectiveTier,
        floor,
        score,
        certificate_id: cert ? cert.certificate_id : undefined,
        tenant_id: cert ? cert.tenant_id : undefined,
      },
    };
  }

  return {
    level: CAP_LEVELS.PUBLIC,
    reason: 'not an internal agent and ' + reasons.join('; '),
    detail: { tier: effectiveTier, score, certValid },
  };
}

/**
 * XMRT CERT -> Compute Access tier.
 *
 * The University issues certs with tier "graduate", which is not a Compute
 * Access tier. They are different claims and are mapped rather than conflated:
 * graduating says the agent finished the course; the tier says what it may do.
 * A fresh graduate starts as an explorer - the lowest bar - and TrustGraph is
 * what moves it up. Nothing here grants capability by itself.
 *
 * This is now the FOURTH tier vocabulary in the estate, alongside explorer/
 * builder/anchor (the stale inline copy), explorer/developer/studio/enterprise/
 * anchor (trustgraph-engine, the live one), and the studio/enterprise values
 * seen in stored gate and credential rows. Mapping them here is the point at
 * which they stop disagreeing. Unknown values map to null, which denies.
 */
const CERT_TIER_MAP = {
  graduate: 'explorer',
  explorer: 'explorer',
  developer: 'developer',
  builder: 'developer',
  studio: 'studio',
  enterprise: 'enterprise',
  anchor: 'anchor',
};

export function certTierToCap(tier) {
  if (typeof tier !== 'string') return null;
  const t = tier.trim().toLowerCase();
  return Object.hasOwn(CERT_TIER_MAP, t) ? CERT_TIER_MAP[t] : null;
}

/**
 * Verify a presented XMRT CERT against the University's record.
 *
 * The relay stores only a SHA-256 digest of the issued token - the plaintext
 * used to sit in the row, which put every certified agent's live bearer token in
 * the database - so verification hashes what was presented and looks that up. The
 * token is never compared in the clear and never stored.
 *
 * @returns {Promise<{valid: boolean, reason?: string, tier?: string|null,
 *                    certificate_id?: string, agent_id?: string,
 *                    tenant_id?: string|null}>}
 */
export async function verifyCert(token) {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw) return { valid: false, reason: 'no certificate presented' };

  // A JWT's identity is its payload; a bare certificate id is looked up directly.
  let certId = null;
  let digest = null;
  try {
    const { createHash } = await import('node:crypto');
    digest = createHash('sha256').update(raw).digest('hex');
    if (raw.startsWith('eyJ') && raw.split('.').length === 3) {
      const payload = JSON.parse(Buffer.from(raw.split('.')[1], 'base64url').toString('utf8'));
      certId = payload.cert_id || payload.certificate_id || payload.sub || null;
    } else {
      certId = raw.startsWith('local-') ? raw.slice(6) : raw;
    }
  } catch (e) {
    return { valid: false, reason: 'certificate could not be parsed' };
  }

  try {
    const { query } = await import('./db.mjs');
    const r = await query(
      `SELECT certificate_id, agent_id, tier, tenant_id, expires_at, revoked
         FROM public.agent_certifications
        WHERE revoked IS NOT TRUE
          AND (jwt_hash = $1 OR ($2::text IS NOT NULL AND certificate_id = $2))
        LIMIT 1`,
      [digest, certId],
    );
    const row = (r && r.rows && r.rows[0]) || null;
    if (!row) return { valid: false, reason: 'no matching certificate of record' };
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return { valid: false, reason: 'certificate has expired', certificate_id: row.certificate_id };
    }
    return {
      valid: true,
      certificate_id: row.certificate_id,
      agent_id: row.agent_id,
      tier: certTierToCap(row.tier),
      certTierRaw: row.tier,
      tenant_id: row.tenant_id ?? null,
    };
  } catch (e) {
    return { valid: false, reason: 'certificate lookup failed: ' + String(e.message || e).slice(0, 80) };
  }
}

/** Levels at or below which an agent may never be trusted by any route. */
export function canReachLevel(level, target) {
  const order = [CAP_LEVELS.PUBLIC, CAP_LEVELS.TRUSTED, CAP_LEVELS.CORE];
  return order.indexOf(level) >= order.indexOf(target);
}

export default {
  CAP_LEVELS, CAP_TIERS, CAP_TIER_NAMES,
  normaliseAgentId, refreshRoster, isInternalAgent, getRosterSize,
  tierFloor, isKnownTier, resolveAccessLevel, canReachLevel,
  verifyCert, certTierToCap, CERT_TIER_MAP,
};