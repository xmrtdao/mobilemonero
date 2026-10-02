/**
 * relay/jobby/jd.mjs — parse a job description into a posting we can publish
 *
 * ── Why this is not the resume parser with the words swapped ───────────────
 *
 * A resume parser is allowed to be generous: it guesses at a section heading and
 * being wrong costs a field the candidate can correct. A job description parser
 * does the opposite. Everything it extracts is a *requirement*, and a requirement
 * is a claim about what the employer will accept. Two failure modes, and the
 * second is the dangerous one:
 *
 *   - Under-extract and a real requirement is dropped. The candidate applies
 *     without knowing they needed a ticket. That is the parser looking helpful.
 *   - Over-extract and a requirement is invented. The candidate is told they are
 *     unqualified for something the employer never asked for, and passes on a job
 *     they could have had.
 *
 * So the second failure is treated as the serious one throughout. Every extracted
 * requirement carries `evidence` — the exact span of text it came from — and
 * anything that cannot quote its source is not extracted at all. `unclear` holds
 * what a human should read rather than the parser guess at, and the posting is
 * marked `needs_review` so it cannot be published by accident.
 *
 * ── Salary is the field that proves the rule ───────────────────────────────
 *
 * "Competitive salary" is not a salary. Extracting that as one and showing a
 * candidate "$Competitive" in a filtered list is worse than showing nothing,
 * because it looks like the employer declined to say. `salary.min`/`salary.max`
 * are null unless a real number with a real period is present, and the raw text
 * is kept either way.
 */

import { matchTitles, detectTickets } from './titles.mjs';

// ── Requirements ────────────────────────────────────────────────────────────

/**
 * How strongly a line asserts a requirement.
 *
 * "must have" and "nice to have" are opposites and collapsing them tells a
 * candidate to disqualify themselves over a preference.
 */
const REQUIREMENT_STRENGTH = [
  // Must. These are the ones that actually gate.
  { re: /\b(?:must\s+(?:have|possess|be\s+able\s+to|hold)|required\b|essential\b|mandatory\b|minimum\b|we\s+require|you\s+must)\b/i, strength: 'required' },
  { re: /\b(?:certified|certified?\s+in|licensed?|licence\s+required|registration\s+required)\b/i, strength: 'required' },
  // Preferred. Real, but not a gate.
  { re: /\b(?:preferred|preferably|desirable|an\s+asset|is\s+an?\s+asset|nice\s+to\s+have|bonus|ideally|advantageous)\b/i, strength: 'preferred' },
  // Experience duration. Its own strength, because "5 years" is a claim a
  // candidate argues with rather than accepts.
  { re: /\b\d+\s*\+?\s*(?:to\s*\d+\s*)?years?\b/i, strength: 'experience' },
];

/** Sections, in the order employers actually write them. */
const SECTION_PATTERNS = [
  { key: 'responsibilities', re: /^\s*(?:what\s+you(?:'ll| will)\s+do|duties|responsibilities|the\s+role|your\s+role|about\s+the\s+(?:role|job|position)|job\s+description)\b/i },
  { key: 'requirements', re: /^\s*(?:what\s+you(?:'ll| will)?\s*need|requirements?|qualifications|what\s+we(?:'re| are)\s+looking\s+for|minimum\s+qualifications|basic\s+qualifications|skills?\s+(?:and|&)\s+experience|who\s+you\s+are)\b/i },
  { key: 'preferred', re: /^\s*(?:preferred\s+qualifications|nice\s+to\s+have|bonus\s+points?|desirable|preferred\s+experience|assets?)\b/i },
  { key: 'compensation', re: /^\s*(?:compensation|salary|pay|what\s+we\s+offer|benefits|perks|we\s+offer)\b/i },
  { key: 'about', re: /^\s*(?:about\s+(?:us|the\s+company|the\s+team|this\s+role)|who\s+we\s+are|our\s+company)\b/i },
  { key: 'location', re: /^\s*(?:location|where|job\s+location|work\s+location)\b/i },
];

/**
 * Split a JD into sections, keeping the original text of each.
 *
 * A JD with no headings at all is common and not a failure — it returns one
 * unnamed block and the extractors still work off the whole thing. Refusing to
 * parse an unheaded JD would be a parser that only handles the tidy case.
 */
export function splitSections(text = '') {
  const lines = String(text).split(/\r?\n/);
  const sections = [];
  let current = { key: 'body', heading: null, lines: [] };

  for (const line of lines) {
    const isHeading = line.trim().length > 0 && line.trim().length < 72 && !/[.;,]$/.test(line.trim());
    const match = isHeading ? SECTION_PATTERNS.find((p) => p.re.test(line)) : null;
    if (match) {
      if (current.lines.length) sections.push({ ...current, text: current.lines.join('\n') });
      current = { key: match.key, heading: line.trim(), lines: [] };
      continue;
    }
    // Markdown headings and ALL-CAPS titles count as headings too.
    const md = line.match(/^\s*(?:#{1,6}\s*|\*\*)?\s*([A-Z][A-Za-z /&'()-]{2,40})\s*(?:\*\*)?\s*:?\s*$/);
    if (isHeading && md && /[A-Z]{3}/.test(line) && !SECTION_PATTERNS.some((p) => p.re.test(line))) {
      if (current.lines.length) sections.push({ ...current, text: current.lines.join('\n') });
      current = { key: 'other', heading: md[1].trim(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length) sections.push({ ...current, text: current.lines.join('\n') });
  return sections.filter((s) => s.text.trim().length > 0);
}

/**
 * Pull requirements out, each with the line it came from.
 *
 * `evidence` is the whole point. A requirement the parser cannot quote is a
 * requirement it invented, and it is dropped rather than softened.
 */
export function extractRequirements(sections = []) {
  const out = [];
  const seen = new Set();

  for (const section of sections) {
    // Preferred requirements are read only from the preferred section and from
    // "preferred" phrasing elsewhere, so a nice-to-have in the requirements list
    // is still marked preferred when the employer said so on the line.
    const sectionDefault = section.key === 'preferred' ? 'preferred' : null;

    for (const rawLine of section.text.split(/\r?\n/)) {
      const line = rawLine.replace(/^\s*[-*•·–—]\s*/, '').replace(/\s+/g, ' ').trim();
      if (line.length < 4 || line.length > 400) continue;
      if (/^(?:we|our|about|join|apply|please|note|equal|benefits|the company)\b/i.test(line) && line.length < 60) continue;

      let strength = sectionDefault;
      for (const rule of REQUIREMENT_STRENGTH) {
        if (rule.re.test(line)) {
          // Explicit phrasing on the line beats the section it sits in.
          if (rule.strength !== 'experience' || !strength) strength = rule.strength;
          break;
        }
      }
      if (!strength) continue;

      // A ticket or certification named here is a requirement with a body
      // behind it, so it is recorded twice: once as a line of prose and once
      // against the ticket, which is what the candidate's dossier is checked on.
      const key = line.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        kind: 'requirement',
        strength,
        section: section.key,
        text: line,
        evidence: rawLine.trim(),
        heading: section.heading,
      });
    }
  }
  return out;
}

/**
 * Tickets and certifications this posting asks for, with the line that asked.
 *
 * The link back to the source is not decoration: `assessEligibility` puts a
 * gap on a candidate's application because of these, and "you do not have it"
 * is not something to say on the strength of a regex.
 */
export function extractTickets(sections = [], fullText = '') {
  const out = [];
  const seen = new Set();

  // The heading is part of the evidence, not just decoration. A ticket listed
  // under "Requirements" is required; the same ticket under "Preferred
  // qualifications" is not. The first version passed only the section body, so
  // every ticket came back `unstated` — the headings were discarded and the one
  // piece of the document that settles the question was thrown away. A Red Seal
  // posted plainly under Requirements was reported as "the posting does not say".
  const scan = (text, where, sectionKey) => {
    for (const hit of detectTickets(text)) {
      const key = hit.ticket;
      if (seen.has(key)) continue;
      seen.add(key);

      // Strongest signal first, and the section is only consulted when the line
      // itself is silent. A line that says "must have" wins over the section it
      // sits in, because the employer said the stronger thing.
      const line = where;
      const inPreferred = sectionKey === 'preferred';
      const inRequired = sectionKey === 'requirements' || sectionKey === 'responsibilities';

      const strength = /must\b|required\b|essential\b|mandatory\b|certified\b|licen[cs]ed\b|need(?:s|ed)?\b/i.test(line)
        ? 'required'
        : /preferred|desirable|nice\s+to\s+have|an?\s+asset|bonus|ideally/i.test(line)
          ? 'preferred'
          : inPreferred
            ? 'preferred'
            : inRequired
              // Under a requirements heading, the employer's placement is itself
              // the statement. That is not a guess about the role — it is what
              // the document says by where they put it.
              ? 'required'
              : 'unstated';

      out.push({
        ticket: hit.ticket,
        label: hit.label,
        strength,
        // How the strength was decided, so the employer can see it was read and
        // not assumed.
        strengthFrom: /must\b|required\b|essential\b|mandatory\b/i.test(line) ? 'wording'
          : /preferred|desirable|nice\s+to\s+have|an?\s+asset|bonus/i.test(line) ? 'wording'
            : inPreferred ? 'listed under preferred qualifications'
              : inRequired ? 'listed under requirements' : 'not stated',
        evidence: where.slice(0, 240),
        evidenceType: 'quoted_line',
      });
    }
  };

  for (const s of sections) scan(s.text, s.text.slice(0, 240), s.key);
  // Also scan the whole document, because tickets are routinely named in a
  // summary line or a bullet with no section around them. Scanned last so a
  // ticket already placed by its section keeps that placement.
  if (!out.length) scan(fullText, fullText.slice(0, 240), null);
  return out;
}

// ── Title ───────────────────────────────────────────────────────────────────

/**
 * The role title, and whether the library recognises it.
 *
 * `recognised: false` is a real and common answer — internal codes, "Req 4471 -
 * Technician II", and abbreviations the library has never seen. It is surfaced
 * rather than papered over, because a posting the library cannot classify is a
 * posting the candidate's own titles will never be matched against.
 */
export function extractTitle(text = '', hint = null) {
  const fromHint = typeof hint === 'string' ? hint.trim() : '';
  const firstLine = String(text).split(/\r?\n/).map((l) => l.trim())
    .find((l) => l.length > 2 && l.length < 90) || '';

  const candidate = fromHint || firstLine;
  const matches = matchTitles(candidate, { limit: 3 });

  return {
    title: fromHint || (firstLine && firstLine.length < 90 ? firstLine : null),
    titleSource: fromHint ? 'employer_supplied' : firstLine ? 'first_line' : 'not_stated',
    // The library's canonical title for it, when there is one.
    matched: matches.map((m) => ({ name: m.name, family: m.family, confidence: m.confidence })),
    recognised: matches.length > 0,
    family: matches.length ? matches[0].family : null,
  };
}

// ── Compensation ────────────────────────────────────────────────────────────

/**
 * A real number with a real period, or nothing.
 *
 * "Competitive", "DOE", "commensurate with experience" and "$50k+" all produce
 * null here. The prose is preserved under `raw` so the employer can see what they
 * wrote and the candidate can see that it was not a number.
 */
export function extractCompensation(sections = [], fullText = '') {
  const compText = sections.filter((s) => s.key === 'compensation').map((s) => s.text).join('\n')
    || fullText;

  // $55,000 - $70,000 / $55k-$70k / 55 000 $ par an / $28.50/hour
  //
  // The digit class is [\d,] and never [\d,\s]. Whitespace inside a greedy
  // character class eats the space before the dash and then the "k" of "85k",
  // so "$85k - $102k" matched nothing at all and fell through to the single
  // pattern, which reported the ceiling as the floor: min=102000, max=null.
  // A posting paying 85-102k was being shown to candidates as paying 102k.
  // Space-separated thousands ("55 000") are handled by an explicit thousands
  // group rather than by a permissive character class.
  const NUM = String.raw`(?:\d{1,3}(?:[,\s]?\d{3})+|\d+(?:\.\d{1,2})?)`;
  const KSUF = String.raw`(k\b)?`;
  // The dollar sign is optional, and the range separators accept "a" as in
  // "62,000 a year" being read as the low end of nothing.
  //
  // It was mandatory, so a posting reading "62000 to 74000 a year" produced no
  // pay at all — the figure was in the document, plainly, and was dropped. The
  // `a` in "a year" is a real hazard once the sign is optional, so the separator
  // class deliberately excludes it: "to" is allowed, a bare "a" is not.
  const SEP = String.raw`\s*(?:-|–|—|to|until|through)\s*`;
  const range = compText.match(
    new RegExp(String.raw`\$?\s*(${NUM})${KSUF}${SEP}\$?\s*(${NUM})${KSUF}`, 'i'));
  const single = compText.match(new RegExp(String.raw`\$\s*(${NUM})${KSUF}`, 'i'));
  const hourly = compText.match(/\$?\s*(\d{1,3}(?:\.\d{1,2})?)\s*(?:\/|per\s+)\s*(?:an?\s+)?(hour|hr)\b/i);
  const period = compText.match(/\b(per\s+(?:an?\s+)?(?:hour|year|month|week|day)|\/ ?(?:hr|hour|yr|year|mo|month)|annually|hourly|weekly|monthly)\b/i);

  // Returns null for anything that is not a real figure, including undefined and
  // the empty string. `Number('')` is 0, not null, so the obvious
  // `Number(String(s).replace(...)) || null` returned null on zero but this
  // guard is what stops an unmatched capture group — which is undefined, whose
  // String() is "undefined", whose Number() is NaN — from becoming a salary.
  // A posting whose ceiling could not be read must show no ceiling, not $0.
  const clean = (s) => {
    if (s === null || s === undefined) return null;
    const digits = String(s).replace(/[,\s]/g, '');
    if (!digits || !/\d/.test(digits)) return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  };
  const k = (s) => (s && /k/i.test(s) ? 1000 : 1);
  const scale = (num, suffix) => (num === null ? null : num * k(suffix));

  let min = null;
  let max = null;
  let unit = null;
  let basis = null;

  if (hourly) {
    min = Number(hourly[1]);
    unit = 'hour';
    basis = 'hourly';
  } else if (range) {
    // Group order is (number)(k)(number)(k) — 1,2,3,4. It was read as 1,2,3,5
    // against the old pattern, so the ceiling was always read from a group that
    // did not exist.
    min = scale(clean(range[1]), range[2]);
    max = scale(clean(range[3]), range[4]);
    unit = 'year';
  } else if (single) {
    min = scale(clean(single[1]), single[2]);
    unit = 'year';
  }

  if (basis === null && period) {
    const p = period[1].toLowerCase();
    basis = p.includes('hour') ? 'hourly' : p.includes('week') ? 'weekly'
      : p.includes('month') ? 'monthly' : 'annual';
    if (unit === 'year' && basis === 'hourly') { unit = 'hour'; max = null; }
  }
  if (basis === null) basis = hourly ? 'hourly' : (min === null ? null : 'annual');
  if (unit === null) unit = basis === 'hourly' ? 'hour' : 'year';

  const rawLine = compText.split(/\r?\n/).map((l) => l.trim())
    .find((l) => /\$|salary|pay|compensation|rate|wage/i.test(l)) || null;

  // The distinction the whole function exists for.
  const stated = min !== null;
  const vague = /\b(competitive|commensurate|negotiable|doe|dependent\s+on\s+experience|market\s+rate|unpaid|voluntary)\b/i
    .test(compText);

  return {
    stated,
    vague: vague && !stated,
    min,
    max,
    unit: stated ? unit : null,
    basis: stated ? basis : null,
    raw: rawLine,
    // Shown whenever nothing numeric was found, so "no number" is explained
    // rather than looking like a bug.
    note: stated ? null
      : vague
        ? 'The employer described pay without a figure. Treat the number as not stated.'
        : compText.trim() ? 'Pay is mentioned but no figure could be read. Treat the number as not stated.'
          : 'No compensation information in this posting.',
  };
}

// ── Location and arrangement ────────────────────────────────────────────────

const WORK_ARRANGEMENT = [
  { value: 'onsite', re: /\b(?:on[- ]?site|in[- ]office|in person|onsite only)\b/i },
  { value: 'hybrid', re: /\bhybrid\b/i },
  // "Remote" is a work arrangement, not a synonym for "far away". A mine
  // description routinely says "remote underground environment" or "remote
  // community", and matching the bare word turned a camp job into a work-from-
  // home offer — which is the single most damaging field to get wrong on a
  // job board, because a remote-seeking candidate would apply to a rotation they
  // cannot serve. Only an explicit work-from-home phrasing counts.
  { value: 'remote', re: /\b(?:fully\s+remote|100%\s*remote|remote\s+(?:work|role|position|job)|work\s+from\s+home|telecommut\w*|wfh|remote[- ]first|remote\s+ok|anywhere)\b/i },
  // Fly-in/fly-out and camp work, which the FIFO track cares about.
  { value: 'fly_in_fly_out', re: /\b(?:fly[- ]?in[- /]?fly[- ]?out|flyin[- /]?flyout|fifo|rotation(?:al)?|rotations?|work\s+rotation|camp\s+life|14\s*\/\s*14|2\s*weeks?\s+on)\b/i },
  { value: 'contract', re: /\b(?:contract(?:or)?|fixed[- ]term|temporary|temp\b|seasonal)\b/i },
];

/**
 * Location, arrangement, and how much of each is actually stated.
 *
 * "Northern Canada" with no province is a location that cannot be filtered on
 * and cannot be assessed for a work permit. Recorded as free text with
 * `specificity` so nobody downstream treats it as precise.
 */
export function extractLocation(sections = [], fullText = '') {
  // A one-line "Location: Yellowknife, NT" is matched by SECTION_PATTERNS and
  // therefore becomes the *heading* of the location section, not its body — so
  // reading only the body threw the city away and reported not_stated while the
  // text plainly said it. Verified: a posting reading "Location: Yellowknife, NT"
  // came back with location=null and told the employer to add one they had added.
  // The heading is searched alongside the body.
  const locSection = sections
    .filter((s) => s.key === 'location')
    .map((s) => [s.heading, s.text].filter(Boolean).join('\n'))
    .join('\n');
  const hay = locSection || fullText;
  // The full text is searched as a fallback for the named forms, because
  // employers put "based in" in the summary as often as under a heading.
  const search = `${hay}\n${fullText}`;

  // Same reasoning as the arrangement rule: "remote" as a distance, not an
  // arrangement. "Remote community" and "remote underground" are Northern
  // Canada job language, not a work-from-home offer.
  const remote = /\b(?:fully\s+remote|100%\s*remote|remote\s+(?:work|role|position|job)|work\s+from\s+home|telecommut\w*|wfh|remote[- ]first|remote\s+ok|anywhere)\b/i.test(search);
  // A city and a region, in either spelling.
  //
  // This matched only a two-letter postal abbreviation, so "Red Deer, Alberta" —
  // the way a Canadian employer actually writes it, and the way the employer in a
  // live session wrote it — fell through to the generic `named` branch and was
  // classed `region`. The review queue then told them the location "must include
  // a city and region" about a location that said exactly that, and would not
  // publish. A specific city in a named province is as filterable as one with an
  // abbreviation, and treating the two differently is a bug in the parser's
  // spelling tolerance, not a fact about the posting.
  const PROVINCES = 'Alberta|British Columbia|Manitoba|New Brunswick|Newfoundland and Labrador|Nova Scotia|Northwest Territories|Nunavut|Ontario|Prince Edward Island|Quebec|Saskatchewan|Yukon';
  const cityProv = search.match(
    new RegExp(String.raw`\b([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+)?),\s*((?:${PROVINCES})\b|[A-Z]{2})\b`));
  const named = search.match(/\b(?:based\s+in|located\s+in|location[:\s]+|work\s+location[:\s]+|job\s+location[:\s]+)\s*([^\n.]{2,60})/i);
  const canadian = new RegExp(String.raw`\b(canada|ontario|quebec|alberta|manitoba|saskatchewan|calgary|edmonton|winnipeg|regina|toronto|ottawa|hamilton|yellowknife|nunavut|newfoundland|labrador|nova\s+scotia|new\s+brunswick)\b`, 'i').test(search);
  const anywhere = /\b(anywhere|remote[- ]first|multiple\s+locations|no\s+location\s+required)\b/i.test(search);

  // A region with no city in it. "Northern Canada" and "Alberta" are where the
  // work is, not where the candidate is, and a candidate cannot filter a job
  // board on them — so they are not a filter key, whatever the province is
  // called. Previously "Northern Canada" came back filterable: true, which
  // offered candidates a filter that would return every job in the country.
  const regionOnly = (value) => new RegExp(
    String.raw`^\s*(?:northern|southern|eastern|western|central|remote|rural)?\s*(?:canada|alberta|ontario|quebec|manitoba|saskatchewan|bc|british columbia|nova scotia|new brunswick|newfoundland|labrador|prince edward island|nunavut|nwt|northwest territories|yukon|the canadas)\s*$`,
    'i').test(String(value || ''));

  const arrangement = [];
  for (const a of WORK_ARRANGEMENT) {
    if (a.re.test(search)) arrangement.push(a.value);
  }

  // A remote posting is not also onsite unless the text says both.
  if (remote && !arrangement.includes('onsite')) arrangement.unshift('remote');

  let text = null;
  let specificity = 'not_stated';
  if (anywhere) {
    text = named ? named[1].trim() : 'Anywhere';
    specificity = 'anywhere';
  } else if (cityProv) {
    text = `${cityProv[1]}, ${cityProv[2]}`;
    specificity = 'city_and_region';
  } else if (named) {
    text = named[1].trim();
    // A named location that is only a region is not filterable, however
    // Canadian it sounds. "Alberta" is not a place a candidate can be.
    specificity = regionOnly(text) ? 'country_or_region' : (canadian ? 'region' : 'free_text');
  } else if (canadian) {
    const m = search.match(new RegExp(
      String.raw`\b([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+)?),?\s+(?:Canada|North(?:ern)?\s+Canada|${PROVINCES})\b`, 'i'));
    text = m ? m[0].trim() : 'Canada';
    specificity = 'country_or_region';
  } else if (remote) {
    text = 'Remote';
    specificity = 'remote';
  }

  return {
    text,
    specificity,
    remote: arrangement.includes('remote'),
    // A filter key only when there is a place in it a candidate could actually
    // be. `region` and `country_or_region` are deliberately absent: "Alberta" and
    // "Northern Canada" name where the work is, not where the person is, and
    // offering them as filters returns every job in the country under a filter
    // that claims to narrow it.
    filterable: ['city_and_region', 'anywhere'].includes(specificity),
    arrangement: [...new Set(arrangement)],
  };
}

// ── Employer ────────────────────────────────────────────────────────────────

/**
 * Who is hiring.
 *
 * Read from the document, not only from a hint. "Company: Red Deer Aggregates"
 * is a line employers write constantly and the parser ignored it entirely — a
 * live posting with no employer on it, which a candidate cannot act on, because
 * the one field that says who is hiring them was never looked for.
 *
 * An explicit hint still wins, because the employer's own form field is a more
 * deliberate statement than a line inside a description they pasted from a
 * template.
 */
export function readCompany(fullText = '', hint = null) {
  const fromHint = typeof hint === 'string' ? hint.trim() : '';
  if (fromHint) return { name: fromHint, source: 'employer_supplied' };

  const labelled = String(fullText).match(
    /^\s*(?:company|employer|organization|organisation|business)\s*[:\-–]\s*(.{2,120})$/im);
  if (labelled && labelled[1].trim()) {
    return { name: labelled[1].trim(), source: 'stated_in_description' };
  }

  // "Welder at Red Deer Aggregates" / "Red Deer Aggregates is hiring".
  const atForm = String(fullText).match(/^\s*[\w /-]{2,60}?\s+at\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})\s*$/m);
  if (atForm && atForm[1].trim()) {
    return { name: atForm[1].trim(), source: 'stated_in_description' };
  }
  const isHiring = String(fullText).match(/^\s*([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})\s+is\s+(?:hiring|looking|seeking)\b/m);
  if (isHiring && isHiring[1].trim()) {
    return { name: isHiring[1].trim(), source: 'stated_in_description' };
  }

  return { name: null, source: 'not_stated' };
}

// ── The parse itself ────────────────────────────────────────────────────────

/**
 * Parse a job description into a draft posting.
 *
 * `needsReview` is the load-bearing field. It is true whenever the parser could
 * not read something a candidate needs: no title, no location, a title the
 * library does not recognise, a vague salary, or requirements the employer wrote
 * as paragraphs rather than lines. A posting in that state cannot be published
 * without a human looking at it, which is the only safe default for a document
 * whose whole purpose is to be believed by a stranger.
 */
export function parseJobDescription(text = {}, { titleHint = null, companyHint = null } = {}) {
  const body = typeof text === 'string' ? text : (text.text || text.body || text.description || '');
  const clean = String(body).trim();

  if (!clean) {
    return {
      ok: false,
      error: 'The job description is empty. Paste the text or upload the file.',
    };
  }

  const sections = splitSections(clean);
  const t = extractTitle(clean, titleHint);
  const comp = extractCompensation(sections, clean);
  const loc = extractLocation(sections, clean);
  const requirements = extractRequirements(sections);
  const tickets = extractTickets(sections, clean);

  const requiredTickets = tickets.filter((x) => x.strength === 'required').map((x) => x.ticket);
  const preferredTickets = tickets.filter((x) => x.strength === 'preferred').map((x) => x.ticket);
  const unstatedTickets = tickets.filter((x) => x.strength === 'unstated').map((x) => x.ticket);

  // What a human must read before this goes to strangers.
  const review = [];
  if (!t.title) review.push('No job title could be read. Add one.');
  else if (!t.recognised) {
    review.push(`"${t.title}" is not a title this system recognises, so it cannot be matched `
      + 'against anyone\'s record. Give the plain title, or accept that few candidates will find it.');
  }
  if (loc.specificity === 'not_stated') review.push('No location stated. Candidates filter on this.');
  else if (!loc.filterable) {
    // Say what kind of place it is, rather than a generic "name a city". A
    // posting that says "Alberta" is not a posting with a typo, and telling its
    // author to add a city they may not have (a camp with no nearby town) is
    // advice that cannot be followed.
    review.push(`"${loc.text}" is a region, not a place a candidate can be. `
      + 'Name the nearest town or community, and the province or territory.');
  }
  if (comp.vague) review.push('Pay is described but has no figure. Candidates will ask.');
  if (!comp.stated) review.push(comp.note);
  if (requiredTickets.length === 0 && tickets.length > 0) {
    review.push(`${unstatedTickets.length} ticket(s) appear but the posting does not say whether they `
      + 'are required or preferred. Say which — this decides who applies.');
  }
  // Paragraph requirements are a parser problem the employer can fix.
  const proseReqs = requirements.filter((r) => r.text.length > 180);
  if (proseReqs.length) {
    review.push(`${proseReqs.length} requirement(s) are written as paragraphs. Break them into `
      + 'one-per-line so they can be read as requirements rather than description.');
  }
  if (requirements.length === 0) {
    review.push('No requirements could be read. Candidates will apply without knowing what is needed.');
  }

  const wordCount = clean.split(/\s+/).filter(Boolean).length;

  return {
    ok: true,
    // The raw text, always. Everything below is a reading of it and a reader
    // must be able to get back to the original.
    sourceText: clean,
    sourceWords: wordCount,
    title: t,
    company: readCompany(clean, companyHint),
    location: loc,
    compensation: comp,
    sections: sections.map((s) => ({ key: s.key, heading: s.heading, chars: s.text.length })),
    requirements,
    tickets,
    requiredTickets,
    preferredTickets,
    unstatedTickets,
    needsReview: review.length > 0,
    review: review,
    // How much of the document the parser actually understood. Reported so a
    // thin parse is visible rather than dressed up as a complete one.
    coverage: {
      words: wordCount,
      sectionsFound: sections.filter((s) => s.key !== 'other' && s.key !== 'body').length,
      requirementsFound: requirements.length,
      ticketsFound: tickets.length,
      hasStructuredRequirements: requirements.length > 0 && proseReqs.length === 0,
    },
  };
}

export default { parseJobDescription, splitSections, extractRequirements, extractTickets, extractTitle, extractCompensation, extractLocation };
