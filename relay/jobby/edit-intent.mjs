/**
 * relay/jobby/edit-intent.mjs — read a plain-language change request
 *
 * The failure this exists to fix: a user said "update my phone number to
 * 804-555-0142", Jobby replied "Done — I've added your phone number", and the
 * dossier still said the phone number was missing. Jobby had claimed a change it
 * had not made.
 *
 * Why that happened is structural, not a bad prompt. The only path from a
 * natural request to a written dossier ran through the model emitting a tool
 * call *and* embedding JSON in its reply, and the whole branch sat behind
 * `if (!calls.length) break`. A model that simply answered in prose - which is
 * what a model does when asked something conversational - took the early exit,
 * and its own sentence became the record. The dossier was never written and
 * nothing reported an error, because from the code's point of view nothing had
 * failed.
 *
 * So the user's own sentence is parsed here, deterministically, with no model
 * involved. The model is still what handles anything structural - employment
 * history, skills, reorganisation - because that genuinely needs understanding.
 * What it must not be is the only route to recording a phone number.
 *
 * Deliberately narrow. Only top-level scalar fields, only clear phrasings, and
 * only values that look like what they claim to be. A false positive here writes
 * to someone's professional identity without being asked, which is worse than
 * missing an edit and asking.
 */

/** Fields this can set, with the phrasings people actually use for them. */
const FIELDS = [
  {
    field: 'phone',
    // "phone", "phone number", "mobile", "cell", "telephone", and the same with
    // "number" attached, which is how most people write it.
    noun: '(?:phone(?:\\s*(?:number|no\\.?))?|mobile(?:\\s*(?:number|no\\.?))?|cell(?:\\s*(?:number|no\\.?))?|telephone|tel\\b)',
    // A phone number: digits, and the punctuation people put in one.
    valid: (v) => {
      const d = (v.match(/\d/g) || []).length;
      return d >= 7 && d <= 15 && /^[+\d\s().-]+$/.test(v);
    },
  },
  {
    field: 'email',
    noun: '(?:e-?mail(?:\\s*address)?)',
    valid: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v),
  },
  {
    field: 'location',
    noun: '(?:location|city|where\\s+i\\s+live|based\\s+in)',
    // Anything plausible: a location is free text, and refusing valid ones here
    // would be worse than accepting a slightly odd one.
    valid: (v) => v.length >= 2 && v.length <= 80 && !/https?:|@/.test(v),
  },
  {
    field: 'name',
    noun: '(?:full\\s+name|name)',
    valid: (v) => {
      const words = v.split(/\s+/).filter(Boolean);
      // The first token must look like the start of a name. This is what rejects
      // "my name is spelled wrong in the PDF", which is a complaint about the
      // dossier and not a name - and storing that would address a job application
      // to a person called "spelled wrong in the PDF".
      if (words.length < 2 || words.length > 5 || v.length > 60) return false;
      if (!/^[A-ZÀ-Þ]/.test(words[0])) return false;
      // A name does not contain these. Cheap, and it catches the rest.
      if (/\b(?:spelled|wrong|incorrect|missing|should|instead|actually|called|please)\b/i.test(v)) return false;
      return /[A-Za-z]/.test(v);
    },
    // The name is the one field that needs an explicit request. A wrong phone
    // number is an annoyance; a wrong name is an identity error, and it changes
    // how every outgoing application addresses the person. So a bare "my name is
    // X" is read as a statement, not an instruction, while "change my name to X"
    // is honoured.
    requireRequestVerb: true,
  },
];

// Words that turn a statement into a hedged or compound one. "I live in Richmond
// but I might move" is not a settled location, and recording it as one would be
// a fact the user never stated.
const HEDGED = /\b(?:but|though|although|however|because|since|maybe|might|may|perhaps|probably|possibly|not sure|unsure|i think|i guess|unclear|somewhere|near|around|actually|instead|used to|no longer)\b/i;

// Tailing noise that gets typed after the value and is not part of it.
const TAIL = /[\s.,;!?]*(?:please|thanks|thank\s+you|thx|ty|ok|okay|cheers|appreciate\s+it)[\s.,;!?]*$/i;

/** Tidy a captured value without inventing anything. */
function clean(raw) {
  let v = String(raw || '').trim();
  v = v.replace(/^["'`]|["'`]$/g, '').trim();
  v = v.replace(TAIL, '').trim();
  v = v.replace(/[\s.,;!?]+$/, '').trim();
  // A closing bracket left over from "(804) 555-0142)" style input.
  v = v.replace(/[)\]}]+$/, (m) => (m.length > 1 ? '' : m)).trim();
  return v;
}

/**
 * The changes a message is asking for.
 *
 * Returns { ok, edits, unmatched } where each edit is
 * { op: 'set', path, value, reason } ready for applyEdits. `unmatched` names the
 * things it noticed but would not act on, so the caller can say "I noticed you
 * mentioned X but I did not change it" instead of silently ignoring them.
 */
export function parseUserEditIntent(message) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, edits: [], unmatched: [] };

  // Only consider what came after the request, so a value mentioned earlier in
  // the sentence ("my old number was 555, my new one is 666") is not misread.
  const edits = [];
  const unmatched = [];
  const claimed = new Set();

  // Where one value stops and the next request begins. "set my phone to 555-0100
  // and my email to a@b.com" is two changes, and without this the phone capture
  // swallowed the whole sentence, failed validation, and lost both.
  const ANOTHER_FIELD = /\s+(?:and|also|plus|then)\s+(?:my|the|our)?\s*(?:phone|e-?mail|email|location|city|name|address|number|telephone|mobile|cell)\b/i;

  // A request verb anywhere in the sentence governs the whole sentence, so
  // "set my phone to X and my email to Y" is two changes even though only the
  // first one is introduced by a verb.
  const sentenceHasVerb = /\b(?:set|change|update|replace|correct|fix|put|make)\b/i.test(text);

  for (const spec of FIELDS) {
    const n = spec.noun;
    // "set my phone to X" / "change my phone number to X" / "update my email to X"
    const setTo = new RegExp(
      `(?:set|change|update|replace|make|put|correct|fix)\\s+(?:my|the|our)?\\s*${n}\\s*(?:to|as|with|into|=|:)\\s*(.+)`,
      'i');
    // "my phone number is X" / "my email is X"
    const isX = new RegExp(
      `(?:my|our)\\s+${n}\\s*(?:number\\s*)?(?:is|=|:)\\s*(.+)`,
      'i');
    // "phone number, it is X" / "my number is X" - the same statement without a
    // possessive, which is how people write it when the sentence already has a
    // verb earlier in it.
    const bareIs = new RegExp(
      `${n}\\s*(?:number\\s*)?,?\\s*(?:it(?:'s)?\\s*)?(?:is|are|=|:)\\s*(.+)`,
      'i');
    // "my email to a@b.com" as a continuation of an earlier request verb.
    const chained = sentenceHasVerb
      ? new RegExp(`(?:my|our)\\s+${n}\\s*(?:to|=|:)\\s*(.+)`, 'i')
      : null;
    // "I live in X" / "I'm based in X" - location only, since the noun reads badly.
    const liveIn = spec.field === 'location'
      ? new RegExp(`\\b(?:i\\s*(?:live|am|'m)\\s+(?:in|at|near)|i'?m\\s+based\\s+in|based\\s+in)\\s+(.+)`, 'i')
      : null;

    for (const [re, hadVerb] of [[setTo, true], [isX, false], [bareIs, false], [chained, true], [liveIn, false]].filter(([r]) => r)) {
      const m = text.match(re);
      if (!m) continue;
      // Greedy to end of line, then cut at the next field request and let
      // clean() take trailing punctuation off. The earlier version stopped the
      // capture at the first "." so "804.555.0142" became "804" and
      // "joe.lee@example.com" became "joe" - which passed a weak digit-count
      // check while writing the wrong value.
      const raw = m[1].split(ANOTHER_FIELD)[0];
      const value = clean(raw.split(/[.!?]\s+[A-Z"']|\s*[.!?]\s*$/)[0]);
      if (!spec.valid(value) || HEDGED.test(value)) {
        // Noted rather than dropped: the user asked for something on a field we
        // know about, and the value did not stand up. Silently ignoring it is
        // how "I added your phone number" gets said.
        if (!claimed.has(spec.field)) {
          unmatched.push({
            field: spec.field,
            value,
            reason: HEDGED.test(value) ? 'the value was hedged, not settled' : 'does not look like a valid value',
          });
          claimed.add(spec.field);
        }
        continue;
      }
      if (spec.requireRequestVerb && !hadVerb) continue;
      if (edits.some(e => e.path === spec.field)) continue;
      edits.push({
        op: 'set',
        path: spec.field,
        value,
        reason: 'stated in the user\'s own message',
      });
      claimed.add(spec.field);
      break;
    }
  }

  return { ok: edits.length > 0, edits, unmatched };
}

/**
 * Whether a message reads as a request to change the dossier.
 *
 * Used to hold the model to account: if this is true and nothing was written,
 * the reply must not claim otherwise. Deliberately loose - a false positive only
 * makes Jobby say "I did not change anything", which is the safe direction.
 */
export function looksLikeEditRequest(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  return new RegExp(
    '\\b(?:set|change|update|replace|correct|fix|add|put|make)\\b[^\\n]{0,40}?\\b(?:my|our)\\b'
    + '|\\bmy\\s+(?:phone|e-?mail|email|location|name|city|number|address)\\b[^\\n]{0,30}?\\b(?:is|should be|needs? to be)\\b'
    // Double-quoted: the alternatives contain an apostrophe, which ends a
    // single-quoted string and produces a syntax error rather than a bad regex.
    + "|\\b(?:it'?s|its)\\s+(?:is\\s+)?(?:not\\s+right|wrong|missing|out of date|outdated|incorrect)\\b"
    // The interrogative form: "is my phone number right?", "do you have my
    // email?". A question is about the dossier without asking for a change, and
    // recognising it is what makes Jobby accountable for having changed nothing.
    + "|\\b(?:is|are)\\s+my\\s+(?:phone|e-?mail|email|location|name|address|number)\\b"
    + "|\\bdo\\s+you\\s+have\\s+my\\b"
    + "|\\bi\\s*(?:live|am|'m)\\s+(?:in|at)\\b",
    'i').test(text);
}

/** A sentence stating plainly what was and was not changed. */
export function describeOutcome(applied, failed, unmatched) {
  const parts = [];
  if (applied.length) {
    const names = applied.map(a => a.path).join(', ');
    parts.push(`Saved to your dossier: ${names}.`);
  }
  if (failed.length) {
    parts.push(`Could not save: ${failed.join('; ')}.`);
  }
  if (unmatched && unmatched.length) {
    const names = unmatched.map(u => `${u.field} ("${u.value}")`).join('; ');
    parts.push(`I did not change ${names} because it did not look valid — tell me again if that is wrong.`);
  }
  return parts.join(' ');
}
