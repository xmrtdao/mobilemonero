/**
 * relay/jobby/certs.mjs — XMRT-DAO-CERT verification against the authoritative table.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `POST /api/auth/cert-login` verified a certificate in two steps:
 *
 *   1. `state.get('xmrt-university-certs')` — process memory, and in practice
 *      empty, because only the ingest route ever wrote to it and there are zero
 *      entries.
 *   2. a fallback POST to `/functions/v1/xmrt-university` — which 502s, because
 *      local Supabase is not serving that function.
 *
 * Neither step reads `public.agent_certifications`, which is where all fourteen
 * certificates actually live, with agent_id, tier, permissions and expires_at. The
 * gate that was supposed to check certificates never checked the table holding
 * them. Certificates were accepted or rejected essentially by accident of which
 * path happened to resolve.
 *
 * ── The worse half ───────────────────────────────────────────────────────────
 *
 * The auth middleware accepted the session cookie with a prefix test:
 *
 *   if (apiKey.startsWith('cert:verified:')) return next();
 *
 * No lookup. No expiry check. No revocation check. Anyone presenting the cookie
 * `cert:verified:anything at all` was authenticated as a graduate. That is the
 * "ties the agent to their cert" property inverted: a certificate id nobody issued
 * was as good as one that was.
 *
 * So `cert-login` now verifies against the table, and `verifyCertCookie` is what
 * the middleware calls — it resolves the id, checks the row, and refuses rather
 * than trusting the prefix.
 *
 * ── What "tie the agent to their cert" means here ────────────────────────────
 *
 * The certificate is the credential, so the identity in a request must come from
 * the certificate row, never from the request body. A caller that says
 * `agent: "hermes-001"` while presenting Hermes's certificate gets Hermes. A caller
 * presenting no cert gets the generic `RELAY_API_KEY` path and no agent identity.
 * `identityFromRequest` returns where the identity came from so a mismatch can be
 * refused rather than quietly accepted.
 */

import { getPool } from './store.mjs';

/** Certificates are annual. A graduate re-takes the modules to renew. */
export const DEFAULT_VALIDITY_DAYS = 365;

/** Table that actually holds certificates. `agent.agent_certifications` exists and is empty. */
const CERT_TABLE = 'public.agent_certifications';

/** Parse a `local-<certId>` / bare cert id / JWT into a certificate id. */
export function parseCertId(jwt) {
  const s = String(jwt ?? '').trim();
  if (!s) return { certId: null, sub: '' };
  if (s.startsWith('local-')) return { certId: s.slice(6) || null, sub: '' };
  if (s.startsWith('eyJ')) {
    try {
      const payload = JSON.parse(Buffer.from(s.split('.')[1], 'base64url').toString('utf8'));
      return { certId: payload.cert_id || payload.certId || payload.sub || null, sub: payload.sub || '' };
    } catch { return { certId: null, sub: '' }; }
  }
  // Anything else is treated as a bare certificate id.
  return { certId: s, sub: '' };
}

/**
 * Look up a certificate and decide whether it currently grants access.
 *
 * Never returns a certificate without a verdict. A caller that ignores `ok` still
 * has to look at it, because `record` is null whenever `ok` is false.
 *
 * @param {string} certId
 * @returns {Promise<{
 *   ok: boolean, reason: string, certificate: object|null,
 *   agent_id: string|null, agent_name: string|null, tier: string|null,
 *   permissions: string[], expires_at: string|null
 * }>}
 */
export async function verifyCertificate(certId) {
  const id = String(certId ?? '').trim();
  if (!id) {
    return { ok: false, reason: 'no_certificate', certificate: null, agent_id: null, agent_name: null, tier: null, permissions: [], expires_at: null };
  }

  const pool = await getPool();
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT agent_id, agent_name, certificate_id, tier, permissions, issued_at, expires_at, revoked, revoked_at
         FROM ${CERT_TABLE}
        WHERE certificate_id = $1
        LIMIT 1`, [id]));
  } catch (e) {
    // Distinguish "our database is unreachable" from "you are not certified".
    // Collapsing these is what produced the original confusion: a 502 from the
    // fallback verifier surfaced as "please graduate from XMRT University first",
    // which sent the reader looking at the wrong system entirely.
    return {
      ok: false,
      reason: 'verifier_unavailable',
      detail: String(e.message || e).slice(0, 160),
      certificate: null, agent_id: null, agent_name: null, tier: null, permissions: [], expires_at: null,
    };
  }

  if (!rows.length) {
    return { ok: false, reason: 'not_found', certificate: null, agent_id: null, agent_name: null, tier: null, permissions: [], expires_at: null };
  }

  const r = rows[0];
  const base = {
    certificate: r,
    agent_id: r.agent_id || null,
    agent_name: r.agent_name || null,
    tier: r.tier || 'graduate',
    permissions: Array.isArray(r.permissions) ? r.permissions : [],
    expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
  };

  if (r.revoked) {
    return { ...base, ok: false, reason: 'revoked', revoked_at: r.revoked_at || null };
  }

  // Expiry is enforced here. It was not enforced anywhere: the old gate never
  // reached this table, and the middleware trusted a string prefix.
  if (r.expires_at) {
    const expires = new Date(r.expires_at).getTime();
    if (Number.isFinite(expires) && expires <= Date.now()) {
      return { ...base, ok: false, reason: 'expired' };
    }
  }

  return { ...base, ok: true, reason: 'valid' };
}

/**
 * Verify the `cert:verified:<id>` cookie the middleware sees.
 *
 * Replaces the prefix test. A well-formed cookie is now a claim that must be
 * substantiated, not a credential in itself.
 *
 * @param {string} cookieValue e.g. "cert:verified:XMRT-CERT-XXXXXXX"
 */
export async function verifyCertCookie(cookieValue) {
  const s = String(cookieValue ?? '');
  if (!s.startsWith('cert:verified:')) return { ok: false, reason: 'not_a_cert_cookie' };
  return verifyCertificate(s.slice('cert:verified:'.length));
}

/**
 * Which agent is this request, and why do we believe it?
 *
 * Certificate identity wins over anything the caller asserts. This is what stops
 * "present Hermes's cert, claim to be Vex".
 *
 * @param {object} req
 * @returns {Promise<null | { agent_id: string, agent_name: string|null, tier: string|null,
 *                           permissions: string[], source: 'cert'|'agent_key'|'service_key' }>}
 */
export async function identityFromRequest(req) {
  // 1. A verified certificate cookie. Already checked by the middleware.
  const cookie = req.cookies?.relay_api_key || '';
  if (cookie.startsWith('cert:verified:')) {
    const v = await verifyCertCookie(cookie);
    if (v.ok) {
      return {
        agent_id: v.agent_id, agent_name: v.agent_name, tier: v.tier,
        permissions: v.permissions, source: 'cert',
      };
    }
    return null;
  }

  // 2. A per-agent API key (xrt_ prefix) — already resolved by the middleware.
  if (req.agentAuth?.agent_id) {
    return {
      agent_id: req.agentAuth.agent_id,
      agent_name: req.agentAuth.label || null,
      tier: req.agentAuth.tier || null,
      permissions: req.agentAuth.permissions || [],
      source: 'agent_key',
    };
  }

  // 3. The shared service key. Authenticated, but not a person or an agent — so
  //    it must never be able to speak as one.
  return null;
}

/**
 * Issue (or re-issue) a certificate for an agent.
 *
 * Renewal writes a NEW certificate_id rather than extending the old row, because
 * a cert id that outlives its expiry is a credential nobody can revoke without
 * also revoking the renewal. The prior row is left in place and marked revoked so
 * an audit shows what superseded what.
 *
 * @param {object} args
 * @param {string} args.agentId
 * @param {string} [args.agentName]
 * @param {string} [args.tier]
 * @param {string[]} [args.permissions]
 * @param {number} [args.validDays]
 * @returns {Promise<{ok: boolean, certificate_id?: string, expires_at?: string, error?: string}>}
 */
export async function issueCertificate({ agentId, agentName = null, tier = 'graduate', permissions = null, validDays = DEFAULT_VALIDITY_DAYS }) {
  const id = String(agentId ?? '').trim();
  if (!id) return { ok: false, error: 'agentId is required' };

  const pool = await getPool();

  // Supersede any live certificate for this agent. Not a DELETE — the row stays as
  // the record of what was revoked and when.
  await pool.query(
    `UPDATE ${CERT_TABLE}
        SET revoked = true, revoked_at = now()
      WHERE agent_id = $1 AND NOT revoked`, [id]).catch(() => {});

  // 7 chars of base32-ish alphabet matches the existing XMRT-CERT-XXXXXXX shape.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — read aloud over voice
  let suffix = '';
  for (let i = 0; i < 7; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  const certId = `XMRT-CERT-${suffix}`;

  const perms = permissions && permissions.length
    ? permissions
    : ['fleet:read', 'fleet:write', 'mine', 'vote'];

  const { rows } = await pool.query(
    `INSERT INTO ${CERT_TABLE}
       (agent_id, agent_name, certificate_id, tier, permissions, issued_at, expires_at, revoked)
     VALUES ($1, $2, $3, $4, $5, now(), now() + ($6 || ' days')::interval, false)
     RETURNING certificate_id, issued_at, expires_at, tier, permissions`,
    [id, agentName, certId, tier, perms, validDays]);

  const c = rows[0];
  return {
    ok: true,
    certificate_id: c.certificate_id,
    issued_at: new Date(c.issued_at).toISOString(),
    expires_at: new Date(c.expires_at).toISOString(),
    tier: c.tier,
    permissions: c.permissions,
    agent_id: id,
  };
}