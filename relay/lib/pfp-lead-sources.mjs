/**
 * relay/lib/pfp-lead-sources.mjs — where a lead came from, as data.
 *
 * WHY THIS IS A TABLE AND NOT A STRING
 * ------------------------------------
 * `public.pfp_leads.source` is free text, and it was being typed by hand:
 *
 *     email-inquiry                     11
 *     inbound-email/partyfavorphoto     7
 *     inbound email                      1   <- the same thing, typed again
 *     website-booking                    3
 *     text-inquiry                       1
 *     voicemail-referral                 1
 *     sms                                2
 *     manual                             2
 *
 * "inbound-email/partyfavorphoto" and "inbound email" are one source written
 * two ways. A "where did they come from" tile that groups by that column cannot
 * answer the question, and the campaign selectors already broke on it:
 * pfp-reintroduction-campaign.mjs filters `status IN ('lead','vsco_import')` and
 * matches zero rows.
 *
 * So: a lookup table of codes, a resolver that maps raw text to a code, and the
 * raw string KEPT. Nothing is overwritten, because the raw value is the only
 * evidence of what somebody actually typed, and destroying it would make a
 * mis-mapping unrecoverable.
 *
 * UNMAPPED VALUES ARE REPORTED, NOT GUESSED
 * ------------------------------------------
 * A source nobody recognises returns `mapped: false` with a suggested code, and
 * the caller decides. Mapping `inbound-email/partyfavorphoto` to `email_inquiry`
 * is a judgement; making it silently in SQL is how a lead gets reported as
 * coming from a channel it never came from.
 */

/** The lookup, as data. `category` is what a dashboard groups by. */
export const LEAD_SOURCES = Object.freeze([
  Object.freeze({
    code: 'email_inquiry', label: 'Email inquiry', category: 'inbound',
    description: 'A client wrote to us first.',
  }),
  Object.freeze({
    code: 'web_form', label: 'Website form', category: 'inbound',
    description: 'Submitted the booking form on partyfavorphoto.com.',
  }),
  Object.freeze({
    code: 'sms', label: 'SMS / text message', category: 'inbound',
    description: 'Came in by text.',
  }),
  Object.freeze({
    code: 'phone', label: 'Phone call', category: 'inbound',
    description: 'Called the business line.',
  }),
  Object.freeze({
    code: 'voicemail_referral', label: 'Voicemail referral', category: 'referral',
    description: 'Left a voicemail that referred us to someone, or arrived by referral in a voicemail.',
  }),
  Object.freeze({
    code: 'referral', label: 'Client referral', category: 'referral',
    description: 'Named by an existing client.',
  }),
  Object.freeze({
    code: 'manual', label: 'Entered by hand', category: 'internal',
    description: 'Added by a person with no system capture. Worth asking about.',
  }),
  Object.freeze({
    code: 'vsco_import', label: 'VSCO import', category: 'import',
    description:
      'Backfilled from VSCO, the previous CMS. These are PAST CLIENTS, which is ' +
      'why the reintroduction campaign targets this code - do not put cold ' +
      'scraped contacts here.',
  }),
  Object.freeze({
    code: 'scraped_ai', label: 'Scraped - AI / networking', category: 'scraped',
    description: 'Found by lead-scraper/scraper_ai.py. Never contacted before. NOT a past client.',
  }),
  Object.freeze({
    code: 'scraped_wedding', label: 'Scraped - wedding vendors', category: 'scraped',
    description: 'Found by lead-scraper/scraper_wedding.py. Never contacted before. NOT a past client.',
  }),
  Object.freeze({
    code: 'campaign_outbound', label: 'Outbound campaign', category: 'outbound',
    description: 'Went out through relay-data/campaign-contacts.json, not pfp_leads.',
  }),
]);

/**
 * Raw text as typed, mapped to a code.
 *
 * Exact keys first, then a normalised comparison so case, spaces, hyphens,
 * underscores and slashes do not create a new "source". Normalisation is why
 * "inbound email" and "inbound-email/partyfavorphoto" can land on one code
 * rather than two.
 */
/**
 * Aliases are keyed by NORMALISED text, because that is what resolveLeadSource
 * looks up. The original keys were written as typed - "inbound email" with a
 * space, "inbound-email/partyfavorphoto" with a slash - and `normaliseSource`
 * turns those into underscored forms, so none of them were ever found. Three
 * real source strings silently failed to resolve, which is exactly the
 * confidence-without-evidence pattern: the lookup looked exhaustive and was not.
 *
 * Order matters below, because containment is tried in table order and the first
 * hit wins. Longer, more specific keys come first so "text_inquiry" cannot be
 * swallowed by a shorter match.
 */
const RAW_ALIASES = Object.freeze({
  // inbound email, in every spelling actually typed
  inbound_email_partyfavorphoto: 'email_inquiry',
  inbound_email: 'email_inquiry',
  email_inquiry: 'email_inquiry',
  // text before sms: "text_inquiry" must not fall through to an sms rule
  text_inquiry: 'sms',
  website_booking: 'web_form',
  voicemail_referral: 'voicemail_referral',
  // referral phrasings
  word_of_mouth: 'referral',
  referral: 'referral',
  referred_by: 'referral',
  // plain codes
  web: 'web_form',
  web_form: 'web_form',
  sms: 'sms',
  manual: 'manual',
  vsco: 'vsco_import',
  vsco_import: 'vsco_import',
  scraped_ai: 'scraped_ai',
  scraped_wedding: 'scraped_wedding',
  campaign_outbound: 'campaign_outbound',
});

/**
 * Fold a raw source string to a comparable key.
 * Lowercase, non-alphanumerics to underscore, trimmed.
 */
export function normaliseSource(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Map a raw source to a code.
 *
 * Never throws and never invents. An unrecognised value comes back with
 * `mapped: false`, the raw string intact, and a suggestion when the text is
 * close to a known code - so a reviewer can approve a mapping instead of
 * discovering a wrong one in a dashboard.
 *
 * @returns {{raw:(string|null), code:(string|null), label:(string|null),
 *            category:(string|null), mapped:boolean, suggestion:(string|null)}}
 */
export function resolveLeadSource(raw) {
  const rawStr = raw === null || raw === undefined ? null : String(raw);
  const rawKey = normaliseSource(raw);

  if (rawKey === '') {
    return { raw: rawStr, code: null, label: null, category: null, mapped: false, suggestion: null, reason: 'no source recorded' };
  }

  // 1. an exact key match
  if (RAW_ALIASES[rawKey]) {
    return describe(rawStr, RAW_ALIASES[rawKey], true, null);
  }

  // 2. an exact match on a code
  const byCode = LEAD_SOURCES.find((s) => s.code === rawKey);
  if (byCode) return describe(rawStr, byCode.code, true, null);

  // 3. containment either way. "inbound email from website" -> email_inquiry.
  //    First match wins, so the alias table is ordered by specificity and a
  //    substring rule can never be ambiguous in practice.
  for (const [alias, code] of Object.entries(RAW_ALIASES)) {
    if (rawKey.includes(alias) || alias.includes(rawKey)) {
      return describe(rawStr, code, true, null);
    }
  }

  // 4. a near miss worth a human's eye: one edit apart from a known code.
  const near = nearestCode(rawKey);
  return describe(rawStr, null, false, near);
}

function describe(raw, code, mapped, suggestion) {
  const s = code ? LEAD_SOURCES.find((x) => x.code === code) : null;
  return {
    raw,
    code: s?.code ?? null,
    label: s?.label ?? null,
    category: s?.category ?? null,
    mapped: Boolean(s),
    suggestion,
  };
}

/**
 * Levenshtein distance, capped. Small inputs only - this runs over a few dozen
 * distinct source strings, not over rows.
 */
function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      last = cur;
    }
  }
  return prev[b.length];
}

function nearestCode(rawKey) {
  let best = null;
  let bestD = 99;
  for (const s of LEAD_SOURCES) {
    const d = levenshtein(rawKey, s.code);
    if (d < bestD) { bestD = d; best = s.code; }
  }
  // Two edits is a typo; three is a different word and guessing would invent.
  return bestD <= 2 ? best : null;
}

/**
 * Group leads by resolved source for a dashboard.
 *
 * `unmapped` is a first-class bucket, not a footnote. If it is non-empty the
 * tile is telling you the data is dirty, which is the useful thing to show.
 */
export function summariseSources(rows) {
  const byCode = new Map();
  const unmapped = new Map();

  for (const r of rows) {
    const resolved = resolveLeadSource(r.source);
    if (resolved.mapped) {
      const cur = byCode.get(resolved.code) || {
        code: resolved.code, label: resolved.label, category: resolved.category, count: 0,
      };
      cur.count += 1;
      byCode.set(resolved.code, cur);
    } else {
      const cur = unmapped.get(String(r.source)) || { raw: r.source, count: 0 };
      cur.count += 1;
      unmapped.set(String(r.source), cur);
    }
  }

  const byCategory = {};
  for (const v of byCode.values()) {
    byCategory[v.category] = (byCategory[v.category] || 0) + v.count;
  }

  return {
    total: rows.length,
    by_source: [...byCode.values()].sort((a, b) => b.count - a.count),
    by_category: byCategory,
    unmapped: [...unmapped.values()].sort((a, b) => b.count - a.count),
    unmapped_total: [...unmapped.values()].reduce((a, b) => a + b.count, 0),
  };
}

export default { LEAD_SOURCES, resolveLeadSource, normaliseSource, summariseSources };