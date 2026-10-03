/**
 * relay/jobby/mailbox.mjs — a candidate's own address on jobbymcjobberson.com
 *
 * Why this exists: Jobby sends job applications on someone's behalf, and until
 * now it sent as the agent. The code said so plainly — "sends as the agent, not
 * as the candidate" — with the consequence that the candidate's replies landed in
 * the agent's inbox rather than theirs. A shared sending domain is also how a
 * domain gets blocked: unrelated cold outreach from one address is the pattern
 * senders look for. Per-candidate sending is the version that survives.
 *
 * Everything here is pure. No database, no network, no environment - so the
 * rules that decide a person's address can be tested exhaustively, which matters
 * because this function decides what a human being is called in every email they
 * will ever send from a job application.
 *
 * Two rules govern the shape:
 *
 *  - The local part is derived from the name, never invented. If a name cannot be
 *    reduced to something address-shaped, this returns null and the caller falls
 *    back to the client's id. A wrong-but-plausible address is worse than an
 *    obviously-generated one, because the first is trusted and the second is not.
 *
 *  - Sanitisation is total. Whatever comes in, the local part matches
 *    /^[a-z0-9]+([.-][a-z0-9]+)*$/ or it is null. That is enforced by the tests
 *    rather than assumed, because the value ends up in a DNS label and in a URL
 *    path. A hyphen is allowed because both permit it in the middle; names have
 *    theirs joined away, and the generated fallback uses one deliberately, so that
 *    an address nobody chose is visibly nobody's.
 */

export const MAILBOX_DOMAIN = 'jobbymcjobberson.com';

/** Longest local part we will ever produce, well under the RFC's 64. */
const MAX_LOCAL = 60;

/**
 * Latin letters that do not decompose into a base letter plus a combining mark.
 *
 * NFD handles "é" and "ö" by splitting them, but ø, æ and ß are single
 * codepoints with no decomposition, so stripping the marks leaves nothing and the
 * name loses a letter: "Søren Kierkegaard" became "s.kierkegaard". These are
 * mapped explicitly so a Danish or Icelandic name gets a readable address instead
 * of one that is quietly wrong.
 */
const TRANSLITERATE = {
  ø: 'o', Ø: 'O', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE',
  ß: 'ss', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', ł: 'l', Ł: 'L',
  þ: 'th', Þ: 'TH', ı: 'i', İ: 'I', ŧ: 't', Ŧ: 'T',
};

/**
 * Reduce a name to an address-shaped token list.
 *
 * Accents are decomposed and the combining marks dropped, so "José" and "Müller"
 * become "jose" and "muller" rather than being rejected - a candidate with an
 * accented name should not end up with a generated address.
 *
 * A hyphen joins rather than splits, so "Mary-Jane Watson" stays two names
 * instead of becoming "mary.watson" - which would collide with "Mary Watson" and
 * hand two different people the same address.
 */
function tokenise(name) {
  return String(name || '')
    // Decompose so accents become a base letter plus a combining mark.
    .normalize('NFD')
    // Drop the combining marks, leaving the base letters.
    .replace(/[\u0300-\u036f]/g, '')
    // Map the letters that never decomposed, before lowercasing.
    .replace(/[øØæÆœŒßđĐðÐłŁþÞıİŧŦ]/g, (c) => TRANSLITERATE[c] || c)
    .toLowerCase()
    // Apostrophes join rather than split: O'Brien is one name, not two.
    .replace(/['\u2019]/g, '')
    // Hyphens join too, for the same reason.
    .replace(/[-\u2010-\u2015]/g, '')
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/**
 * The local part for a candidate's name, or null if the name cannot be reduced.
 *
 * First and last only. A middle name is part of the person but not part of an
 * address: "Joseph Andrew Lee" and "Joseph Lee" are the same person, and giving
 * them two addresses would split their inbox and their history.
 */
export function deriveLocalPart(name) {
  const tokens = tokenise(name);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) return clip(tokens[0]);

  const first = clip(tokens[0]);
  const last = clip(tokens[tokens.length - 1]);
  if (!first || !last) return null;
  return clip(`${first}.${last}`);
}

function clip(token) {
  if (token.length <= MAX_LOCAL) return token;
  return token.slice(0, MAX_LOCAL);
}

/** The full address for a name, or null. */
export function candidateAddress(name, domain = MAILBOX_DOMAIN) {
  const local = deriveLocalPart(name);
  return local ? `${local}@${domain}` : null;
}

/** The address for a client that has no usable name: stable, and obviously generated. */
export function fallbackAddress(clientId, domain = MAILBOX_DOMAIN) {
  return `candidate-${clientId}@${domain}`;
}

/**
 * A local part that is not already taken.
 *
 * Uniqueness has to be decided against the database, because two candidates can
 * share a name and only the store knows who has what. This takes the set of taken
 * local parts and finds the first free variant, so the caller owns the race with
 * the unique index rather than guessing.
 *
 * The suffix goes on the last name: "maria.garcia2" reads as a second Maria
 * Garcia, where "maria2.garcia" reads as a different person entirely.
 */
export function uniqueLocalPart(base, taken) {
  if (!base) return null;
  if (!taken || !taken.has(base)) return base;
  // From 2, and that is a contract rather than an accident.
  //
  // The first holder of a name gets the plain address and the second gets `…2`.
  // Briefly started at 1, on the reasoning that `name1` was an unreachable address
  // being wasted. It broke three tests and, more to the point, it would have
  // changed an address a candidate had already been given and a recruiter had
  // already written to. An unreachable slot is a cosmetic gap; a renumbering is
  // somebody's inbox. The walk starts at 2 and stays there.
  for (let n = 2; n < 1000; n++) {
    const candidate = clip(`${base}${n}`);
    if (!taken.has(candidate)) return candidate;
  }
  // 999 collisions on one name is not a name problem, it is a bug upstream.
  return null;
}

/** The domain part of an address, lowercased, or null. */
export function domainOf(address) {
  const s = String(address || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at === -1 ? null : s.slice(at + 1) || null;
}

/**
 * Whether this is a well-formed address on our own domain.
 *
 * One definition, used both when choosing a From and when resolving an inbound
 * reply, because the two must not disagree. The local part is checked for
 * non-emptiness as well as shape: "includes('@')" alone accepts
 * "@jobbymcjobberson.com", which produced the header "Joe Lee <@jobbymcjobberson.com>"
 * and would have been handed to the provider as a send.
 */
export function isCandidateMailbox(address, domain = MAILBOX_DOMAIN) {
  const s = String(address || '').trim().toLowerCase();
  if (!s || /\s/.test(s)) return false;
  if (domainOf(s) !== domain) return false;
  const local = localPartOf(s);
  if (!local) return false;
  return /^[a-z0-9]+([.-][a-z0-9]+)*$/.test(local);
}

/** The local part of an address, lowercased, or null. */
export function localPartOf(address) {
  const s = String(address || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at === -1 ? null : s.slice(0, at) || null;
}

/**
 * The display name to put in a From header for a candidate.
 *
 * The candidate's own name, not "Jobby", and not the agent's: the whole point of
 * a per-candidate address is that a recruiter sees a person. Falls back to the
 * local part when no name is stored, because an empty display name is worse than
 * a technical one.
 */
export function displayNameFor(name, address) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().replace(/[<>"\\]/g, '');
  if (clean) return clean;
  return localPartOf(address) || 'Candidate';
}

/** Format a From header value. Quote the name if it contains anything awkward. */
export function formatFrom(name, address) {
  const display = displayNameFor(name, address);
  const needsQuotes = /[,;:<>@"\\()\[\]]/.test(display);
  return `${needsQuotes ? `"${display}"` : display} <${address}>`;
}
