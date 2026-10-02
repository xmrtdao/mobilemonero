/**
 * relay/jobby/verification.mjs — independent checks of dossier claims
 *
 * The rule this module exists to enforce
 * ---------------------------------------
 * A mark that reads "verified" is a claim about the *verification*, not about
 * the candidate. It tells an employer that something outside both Jobby's and
 * the candidate's control was checked and agreed. That is worth a great deal,
 * and it is worth nothing at all if it can be attached to something nobody
 * checked.
 *
 * So exactly one verdict may be shown:
 *
 *   verified      an INDEPENDENT source was checked and agrees          -> mark
 *   corroborated  sources agree, none independent of the candidate      -> no mark
 *   disputed      sources conflict with each other or with the claim    -> no mark, flagged
 *   unverifiable  nothing found either way                              -> no mark
 *
 * Two failure modes this is built against:
 *
 *   1. Self-assertion. The candidate says "I hold a graduate certificate in
 *      Web Tech". If Jobby simply believed them, a third party would be
 *      vouching for it. Nobody can self-verify, so that claim stays
 *      unverifiable until a registrar says otherwise, and it earns no mark.
 *
 *   2. Self-published corroboration. The candidate links a page they wrote, or
 *      a profile they control, and two sources then "agree". That is one claim
 *      counted twice. Such a source is recorded as `independent: false`, can
 *      contribute to `corroborated`, and can never on its own produce `verified`
 *      - no matter how many of them there are. Counting is deliberately not used
 *      as a route to `verified`, because agreement between sources a candidate
 *      controls is not evidence of anything.
 *
 * The other thing this refuses to do is let a verdict outlive its claim. The
 * text is hashed at check time and re-hashed on read, so editing a claim drops
 * its mark instead of leaving a medal on wording nobody verified.
 */
import { createHash } from 'node:crypto';
import { getPool } from './store.mjs';

export const VERDICTS = Object.freeze(['verified', 'corroborated', 'disputed', 'unverifiable']);

/** The only verdict that may be shown to an employer. */
export const MARKABLE = 'verified';

/**
 * What a mark is allowed to say.
 *
 * A bare tick is worse than nothing, because it invites the reader to assume a
 * check they cannot picture. Each mark names what was checked, against what, and
 * when, so a reader can judge the scope of the verification rather than trusting
 * a symbol.
 */
export const MARK_LABELS = Object.freeze({
  verified: 'Checked against an independent source',
  corroborated: 'Sources agree, but none is independent',
  disputed: 'Sources disagree - not verified',
  unverifiable: 'Not independently checked',
});

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export function claimHash(claim) {
  return createHash('sha256').update(norm(claim)).digest('hex').slice(0, 32);
}

/**
 * Decide a verdict from what was found.
 *
 * Pure, and deliberately so: the badge rules are the whole point of the feature
 * and they must be testable without a database, a browser or a network.
 *
 * @param {object} input
 * @param {string} input.claim           the assertion being checked
 * @param {Array}  [input.sources]       [{name, url, says, independent, contradicts}]
 * @returns {{verdict: string, markable: boolean, reason: string, independent: boolean}}
 */
export function judgeClaim({ claim, sources = [] } = {}) {
  const text = norm(claim);
  if (!text) {
    return {
      verdict: 'unverifiable', markable: false, independent: false,
      reason: 'There is no claim to check.',
    };
  }
  const list = sources.filter((s) => s && typeof s === 'object');

  // A contradiction outranks everything. A disputed claim is not an unverified
  // one: something was found and it does not agree, and the difference matters
  // to whoever reads it.
  const contradicting = list.filter((s) => s.contradicts === true);
  if (contradicting.length) {
    return {
      verdict: 'disputed', markable: false, independent: false,
      reason: 'A source contradicts this: ' + contradicting.map((s) => s.name || s.url).filter(Boolean).join(', '),
    };
  }

  const independent = list.filter((s) => s.independent === true && s.says);
  if (independent.length) {
    return {
      verdict: 'verified', markable: true, independent: true,
      reason: 'Checked against ' + independent.map((s) => s.name || s.url).filter(Boolean).join('; '),
    };
  }

  // Everything that agreed is something the candidate can edit. Agreement among
  // those is one claim counted more than once.
  const agreeing = list.filter((s) => s.says);
  if (agreeing.length) {
    return {
      verdict: 'corroborated', markable: false, independent: false,
      reason: 'Sources agree, but every one of them is within the candidate\'s control, so this '
        + 'is not independent confirmation. No mark is shown.',
    };
  }

  return {
    verdict: 'unverifiable', markable: false, independent: false,
    reason: 'Nothing outside the candidate\'s control was found that speaks to this.',
  };
}

/**
 * The badge a claim may carry, or null.
 *
 * Null is the common case and is not a failure. A dossier where most claims are
 * unverified is an honest dossier; the alternative is a dossier where every
 * claim has a medal, which is a decoration and not a record.
 */
export function markFor(verdict, { sourceName = null, checkedAt = null } = {}) {
  if (verdict !== MARKABLE) return null;
  return {
    mark: MARK_LABELS.verified,
    source: sourceName,
    checkedAt,
    // Carried so the reader can judge it rather than assume it.
    scope: 'This mark says the claim above was checked against the named source. '
      + 'It is not a judgement of the candidate, and it does not cover any other claim.',
  };
}

/* ── Store ─────────────────────────────────────────────────────────────── */

/**
 * Record the outcome of a check.
 *
 * Upsert on (client_id, path): a claim is either verified or not, and stacking
 * rows per check means a reader has to work out which verdict is current.
 */
export async function recordVerification(clientId, {
  path, claim, verdict, method = null, sourceName = null, sourceUrl = null,
  evidence = null, independent = false, expiresAt = null, checkedBy = 'jobby',
} = {}) {
  if (!VERDICTS.includes(verdict)) {
    return { error: 'verdict must be one of ' + VERDICTS.join(', ') };
  }
  // Belt and braces with the CHECK constraint: a markable row must have an
  // independent source, or the table could be made to say something the code
  // would never produce.
  const markable = verdict === MARKABLE;
  if (markable && independent !== true) {
    return { error: 'a verified claim must have an independent source' };
  }
  if (!markable && independent === true) {
    return { error: 'an independent source was used, so the verdict is verified, not ' + verdict };
  }

  const pool = await getPool();
  const { rows } = await pool.query(
    `INSERT INTO app.job_claim_verifications
       (client_id, path, claim, claim_hash, verdict, method, source_independent,
        source_name, source_url, evidence, expires_at, checked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (client_id, path) DO UPDATE
       SET claim = EXCLUDED.claim, claim_hash = EXCLUDED.claim_hash,
           verdict = EXCLUDED.verdict, method = EXCLUDED.method,
           source_independent = EXCLUDED.source_independent,
           source_name = EXCLUDED.source_name, source_url = EXCLUDED.source_url,
           evidence = EXCLUDED.evidence, expires_at = EXCLUDED.expires_at,
           checked_by = EXCLUDED.checked_by, checked_at = now()
     RETURNING *`,
    [
      clientId,
      String(path).slice(0, 200),
      String(claim).slice(0, 2000),
      claimHash(claim),
      verdict,
      asText(method, 1000),
      independent === true,
      asText(sourceName, 300),
      asText(sourceUrl, 800),
      evidence ? JSON.stringify(evidence) : null,
      expiresAt,
      asText(checkedBy, 100),
    ],
  );
  return rows[0] || null;
}

/**
 * Read a client's verifications, dropping any whose claim has since changed.
 *
 * The staleness check is the reason `claim_hash` exists. Editing a claim and
 * keeping its medal is the worst outcome available: it puts a mark next to
 * wording that was never checked, and it looks deliberate.
 */
export async function listVerifications(clientId, { includeStale = false } = {}) {
  const pool = await getPool();
  const { rows } = await pool.query(
    'SELECT * FROM app.job_claim_verifications WHERE client_id = $1 ORDER BY path',
    [clientId],
  );
  const out = [];
  for (const r of rows) {
    const live = r.claim_hash === claimHash(r.claim);
    if (!live && !includeStale) continue;
    const expired = r.expires_at ? new Date(r.expires_at) < new Date() : false;
    const usable = live && !expired;
    out.push({
      path: r.path,
      claim: r.claim,
      verdict: usable ? r.verdict : (live ? 'unverifiable' : 'disputed'),
      // A stale or expired check is never markable, whatever verdict it holds.
      mark: usable ? markFor(r.verdict, { sourceName: r.source_name, checkedAt: r.checked_at }) : null,
      stale: !live,
      expired,
      method: r.method,
      source: r.source_name,
      url: r.source_url,
      checkedAt: r.checked_at,
      expiresAt: r.expires_at,
    });
  }
  return out;
}

/** Only the claims that may be shown, for putting on a CV. */
export async function listMarked(clientId) {
  const all = await listVerifications(clientId);
  return all.filter((v) => v.mark);
}

/** Claims still worth checking. Drives anything that goes looking for evidence. */
export async function listUnverified(clientId) {
  const all = await listVerifications(clientId, { includeStale: true });
  return all.filter((v) => !v.mark);
}

function asText(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
