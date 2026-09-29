// Merge a newly-uploaded resume into an existing dossier, rather than replacing it.
//
// This exists because people commonly keep two or three resumes, each aimed at a
// different kind of work: one for sales, one for a specific industry, one trimmed
// to a page. Uploading the second used to overwrite the first completely -
// onboardFromDossier called saveDossier() with the whole parsed object and the
// audit entry read "(whole dossier)". A candidate with three tailored resumes
// could only ever have one of them on file, and the two most distinctive facts
// about them - the extra roles and the extra skills - were the first thing lost.
//
// The governing rule is augment, never replace. A later resume may add to a field
// or fill a hole in it; it may never empty one, and it may never remove a role,
// a credential or a link that an earlier resume established. That is what makes it
// safe to upload a deliberately narrow resume: the narrowness is a property of the
// document, not a statement about the person.
//
// Pure and exported separately from the DB layer so it can be tested without
// Postgres, and so the semantics are readable in one place rather than spread
// through a route handler.

import {
  SCALAR_FIELDS, LIST_FIELDS, OBJECT_LIST_FIELDS, READ_ONLY_PATHS,
} from './dossier.mjs';
import { sameRole } from './role-match.mjs';

/** Keys the extractor emits that describe the extraction, not the person. */
const EXTRACTION_KEYS = [
  'sourceFilename', 'experience_years_stated', 'experience_years_from_dates',
  'experience_years_source', 'onboarding', 'sourceText', 'rawText',
];

/** Identity: a second resume restating these is not new information. */
const IDENTITY_FIELDS = new Set(['name', 'email', 'phone']);

/**
 * Subfields that name something, where the fuller spelling is the better one.
 *
 * A tailored resume shortens names - the employer to its acronym, a role to its
 * shortest form. The dedup pairs those entries correctly, and then a plain
 * last-write-wins quietly replaces the informative spelling with the abbreviated
 * one, so merging degrades the record it was meant to round out. Keeping the
 * longer value is the conservative choice: it cannot lose information, and
 * changing a name on file is jobby_update_dossier's job, not the merge's.
 */
const NAME_SUBFIELDS = new Set(['company', 'title', 'institution', 'degree', 'field', 'location']);

/** Is this a value that carries information, as opposed to an absent field? */
function present(v) {  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true; // numbers, booleans
}

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Union of two string lists, case-insensitively, existing order first. */
function unionLists(existing, incoming) {
  const out = Array.isArray(existing) ? existing.filter(present).map(String) : [];
  const seen = new Set(out.map(norm));
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (!present(item)) continue;
    const s = String(item);
    const k = norm(s);
    // A later resume may restate a skill in different words. Keeping both is
    // correct - the phrase is how the candidate writes it, and two phrasings
    // are two pieces of evidence - but an identical one adds nothing.
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * The identity of a role, for deciding whether two resumes describe the same one.
 *
 * Exact, and used only for education - where an institution plus a qualification
 * really is the whole identity. Employment goes through sameRole(), which weighs
 * the employer, the title and the dates together, because the same job is
 * routinely written four different ways across a person's documents.
 */
function eduKey(entry) {
  return [entry.institution, entry.degree, entry.field].filter(present).map(norm).join('|');
}

/**
 * Merge one array-of-objects field.
 *
 * Employment is matched with sameRole(); education with an exact key. Matching
 * either too loosely is how a real job gets deleted, so unmatched entries are
 * appended rather than folded into the nearest neighbour.
 */
function mergeObjectList(existing, incoming, field) {
  const isEmployment = field === 'employment';
  const out = Array.isArray(existing) ? existing.filter(e => e && typeof e === 'object').map(e => ({ ...e })) : [];
  const conflicts = [];
  const ambiguous = [];

  for (const entry of Array.isArray(incoming) ? incoming : []) {
    if (!entry || typeof entry !== 'object') continue;

    let at = -1;
    if (isEmployment) {
      // Take the best match, not the first. A broad resume may hold three roles at
      // one organisation across different years, and the incoming entry belongs to
      // whichever of them its dates fit.
      let best = null;
      out.forEach((e, i) => {
        const r = sameRole(e, entry);
        if (!r.same) return;
        if (!best || r.score > best.score) best = { i, r };
      });
      if (best) {
        at = best.i;
        if (best.r.dateConflict) {
          conflicts.push({
            path: `${field}[${at}].${best.r.dateConflict.field}`,
            field: best.r.dateConflict.field,
            have: best.r.dateConflict.a,
            incoming: best.r.dateConflict.b,
          });
        }
        if (best.r.ambiguous) {
          ambiguous.push({ path: `${field}[${at}]`, company: entry.company, title: entry.title });
        }
      }
    } else {
      const k = eduKey(entry);
      if (k) at = out.findIndex(e => eduKey(e) === k);
    }

    if (at === -1) {
      out.push({ ...entry });
      continue;
    }

    // Same role, two documents. The later resume wins per subfield, but only
    // where it actually has something: a two-role resume carries no `highlights`
    // for a role the four-role resume described in detail, and overwriting with
    // an empty array would delete the detail.
    const target = out[at];
    for (const [k2, v2] of Object.entries(entry)) {
      if (k2 === 'highlights') {
        target.highlights = unionLists(target.highlights, v2);
        continue;
      }
      // A date the merge has already flagged as a disagreement is left alone.
      // Silently overwriting 2025 with 2015 - or the reverse - would settle a
      // factual question about the candidate that only they can answer.
      if (conflicts.some(c => c.path === `${field}[${at}].${k2}`)) continue;
      if (!present(v2)) continue;

      if (NAME_SUBFIELDS.has(k2)) {
        // A tailored resume abbreviates. "United Service Organizations (USO)"
        // became "USO", and "Party Favor Photo" became "PARTY FAVOR PHOTO" - the
        // dedup correctly paired those entries and then quietly downgraded the
        // record, so a recruiter reading the dossier saw a less informative
        // employer name than the candidate ever wrote.
        //
        // The fuller name is kept, because the abbreviation carries strictly less
        // information. Corrections are not made here: a merge augments, and
        // jobby_update_dossier is the path for changing what is on file.
        const cur = target[k2];
        if (!present(cur) || String(v2).trim().length > String(cur).trim().length) {
          target[k2] = v2;
        }
        continue;
      }

      target[k2] = v2;
    }
  }
  return { list: out, conflicts, ambiguous };
}

/**
 * Merge a second resume's dossier into the existing one.
 *
 * @param {object|null} existing  the dossier on file, or null for a first upload
 * @param {object} incoming       the newly parsed dossier
 * @returns {{dossier: object, changes: object[], stats: object}}
 */
export function mergeDossiers(existing, incoming) {
  if (!present(existing)) {
    return {
      dossier: { ...incoming },
      changes: [{ path: '(whole dossier)', op: 'created' }],
      stats: { added_skills: 0, added_roles: 0, filled_gaps: 0, preserved: 0, conflicts: 0 },
    };
  }

  const before = existing;
  const out = { ...before };
  const changes = [];
  const stats = { added_skills: 0, added_roles: 0, filled_gaps: 0, preserved: 0, conflicts: 0 };

  // ── Scalars ────────────────────────────────────────────────────────────────
  for (const [key, type] of Object.entries(SCALAR_FIELDS)) {
    const inc = incoming[key];
    const cur = before[key];
    if (!present(inc)) {
      if (present(cur)) stats.preserved++;
      continue; // the narrow resume simply does not mention it
    }
    if (!present(cur)) {
      out[key] = inc;
      stats.filled_gaps++;
      changes.push({ path: key, op: 'filled', value: inc });
      continue;
    }
    if (IDENTITY_FIELDS.has(key)) {
      if (norm(cur) === norm(inc)) continue;
      // Identity changing across two resumes is either a correction or a document
      // for someone else. Either way it is the user's call, so it is recorded
      // rather than applied.
      changes.push({ path: key, op: 'conflict', from: cur, to: inc });
      continue;
    }
    // A summary or a current title is exactly what a tailored resume rewrites, so
    // the later document wins - and the user can see that it did.
    if (String(cur) !== String(inc)) {
      out[key] = inc;
      changes.push({ path: key, op: 'updated', from: cur, to: inc });
    }
  }

  // ── Plain string lists: union ──────────────────────────────────────────────
  for (const key of LIST_FIELDS) {
    if (key === 'not_stated' || key === 'verification_flags') continue; // handled below
    const merged = unionLists(before[key], incoming[key]);
    const added = merged.length - (Array.isArray(before[key]) ? before[key].filter(present).length : 0);
    if (added > 0) {
      out[key] = merged;
      if (key === 'skills') stats.added_skills += added;
      changes.push({ path: key, op: 'added', count: added });
    } else if (merged.length) {
      out[key] = merged;
    }
  }

  // ── links: per subfield, never emptied ─────────────────────────────────────
  const curLinks = (before.links && typeof before.links === 'object') ? before.links : {};
  const incLinks = (incoming.links && typeof incoming.links === 'object') ? incoming.links : {};
  if (Object.keys(incLinks).length || Object.keys(curLinks).length) {
    const links = { ...curLinks };
    for (const [k, v] of Object.entries(incLinks)) {
      if (Array.isArray(v)) links[k] = unionLists(curLinks[k], v);
      else if (present(v)) {
        if (!present(curLinks[k])) { stats.filled_gaps++; changes.push({ path: `links.${k}`, op: 'filled', value: v }); }
        links[k] = v;
      }
    }
    out.links = links;
  }

  // ── Roles and education ────────────────────────────────────────────────────
  for (const field of Object.keys(OBJECT_LIST_FIELDS)) {
    const curList = Array.isArray(before[field]) ? before[field].filter(e => e && typeof e === 'object') : [];
    const incList = Array.isArray(incoming[field]) ? incoming[field].filter(e => e && typeof e === 'object') : [];
    if (!incList.length) {
      if (curList.length) { out[field] = curList; stats.preserved += curList.length; }
      continue;
    }
    const { list: merged, conflicts: fieldConflicts, ambiguous: fieldAmbiguous } =
      mergeObjectList(curList, incList, field);

    if (merged.length > curList.length) {
      stats.added_roles += merged.length - curList.length;
      changes.push({ path: field, op: 'added', count: merged.length - curList.length });
    }
    for (let i = 0; i < merged.length; i++) {
      for (const k of Object.keys(merged[i])) {
        if (JSON.stringify(merged[i][k]) !== JSON.stringify(curList[i]?.[k])) {
          changes.push({ path: `${field}[${i}].${k}`, op: 'updated' });
        }
      }
    }
    // Surfaced, not resolved. A disagreement about when a job started is a claim
    // about the candidate, and the merge has no standing to pick a winner.
    for (const c of fieldConflicts) {
      changes.push({ ...c, op: 'conflict' });
      stats.conflicts = (stats.conflicts || 0) + 1;
    }
    for (const a of fieldAmbiguous) {
      changes.push({ ...a, op: 'ambiguous' });
    }
    out[field] = merged;
  }

  // ── not_stated: recomputed, never accumulated ──────────────────────────────
  // A union would be permanently wrong: once a resume reported "github" as a gap,
  // a second resume supplying it would leave the gap listed, and the dossier would
  // go on claiming the candidate has no GitHub while holding the URL. The gaps are
  // re-derived from what the merged record now actually answers.
  const answered = new Set();
  if (present(out.links?.linkedin)) answered.add('linkedin');
  if (present(out.links?.github)) answered.add('github');
  if (present(out.links?.portfolio)) answered.add('portfolio');
  if (present(out.links?.website)) answered.add('website');
  if (present(out.summary)) answered.add('summary');
  if (present(out.seniority)) answered.add('seniority');
  if (present(out.experience_years)) answered.add('experience_years');

  const gapPool = [
    ...(Array.isArray(before.not_stated) ? before.not_stated : []),
    ...(Array.isArray(incoming.not_stated) ? incoming.not_stated : []),
  ];
  const gaps = [];
  const gapSeen = new Set();
  for (const g of gapPool) {
    if (!present(g)) continue;
    const k = norm(g);
    const bare = String(g).trim();
    if (gapSeen.has(k) || answered.has(k)) continue;
    gapSeen.add(k);
    gaps.push(bare);
  }
  const beforeGaps = Array.isArray(before.not_stated) ? before.not_stated : [];
  if (gaps.length !== beforeGaps.length) {
    changes.push({ path: 'not_stated', op: 'recomputed', from: beforeGaps, to: gaps });
  }
  out.not_stated = gaps;

  // ── Extraction outputs: kept, and the newest kept alongside ────────────────
  for (const key of EXTRACTION_KEYS) {
    if (present(incoming[key])) out[key] = incoming[key];
    else if (present(before[key])) out[key] = before[key];
  }
  // Every document seen, so the candidate can be told what the dossier is built
  // from rather than being asked to remember.
  const sources = [];
  for (const list of [before.sourceFilenames, before.sourceFilename ? [before.sourceFilename] : []]) {
    for (const f of Array.isArray(list) ? list : []) {
      if (present(f) && !sources.includes(f)) sources.push(f);
    }
  }
  if (present(incoming.sourceFilename) && !sources.includes(incoming.sourceFilename)) {
    sources.push(incoming.sourceFilename);
  }
  if (sources.length) {
    out.sourceFilenames = sources;
    if (present(incoming.sourceFilename)) out.sourceFilename = incoming.sourceFilename;
  }

  // Read-only fields describe the extraction. A second document's confidence must
  // not overwrite the first, and its verification flags are merged rather than
  // replaced so a discrepancy found in either document stays on the record.
  for (const key of READ_ONLY_PATHS) {
    if (!present(before[key]) && present(incoming[key])) out[key] = incoming[key];
  }
  out.verification_flags = unionLists(before.verification_flags, incoming.verification_flags);

  return { dossier: out, changes, stats };
}
