/**
 * relay/jobby/dossier.mjs — Dossier reads and audited writes
 *
 * Jobby is allowed to change this person's professional identity, which is a
 * serious thing to hand an LLM. Three rules make it safe enough to build:
 *
 *   1. Whitelisted paths. Only real dossier fields are writable. No
 *      `__proto__`, no arbitrary keys, no inventing a new shape.
 *   2. Every write is an audit row: op, path, before, after, actor, and whether
 *      the user actually confirmed it. "What did the AI change about my
 *      profile" is answerable from the table, not from anyone's memory.
 *   3. Unconfirmed writes are visible. Jobby may stage a correction, but a
 *      change to claimed experience is only marked confirmed when the user
 *      said so.
 *
 * Pure functions live here and are exported separately from the DB layer so
 * they can be tested without Postgres.
 */

import { randomUUID } from 'node:crypto';

/** Dossier fields Jobby must never write: they describe the extraction, not the person. */
export const READ_ONLY_PATHS = new Set(['confidence', 'verification_flags', 'dates_from']);

/** Writable scalar fields, with a light type check. */
export const SCALAR_FIELDS = {
  name: 'string', current_title: 'string', current_company: 'string',
  email: 'string', phone: 'string', location: 'string', summary: 'string',
  seniority: 'string', experience_years: 'number',
};

/** Writable list-of-string fields. */
export const LIST_FIELDS = [
  'skills', 'job_fields', 'roles_in_resume', 'target_roles', 'domain_expertise',
  'certifications', 'achievements', 'not_stated', 'verification_flags',
];

/** Writable object fields. */
export const OBJECT_FIELDS = ['links'];

/** Writable array-of-object fields. */
export const OBJECT_LIST_FIELDS = {
  employment: {
    company: 'string', title: 'string', location: 'string',
    description: 'string',
    start: 'string', end: 'string', current: 'boolean',
    team_size: 'number', highlights: 'list', dates_from: 'string',
  },
  education: { institution: 'string', degree: 'string', field: 'string', year: 'string' },
};

/**
 * Key names the model reaches for that mean a real field under another name.
 *
 * Observed in a live session: asked to add a 1997-2004 role, the model sent
 * `start_date` and `end_date` where the schema says `start` and `end`. All
 * three of its keys were rejected and only the first was reported, so it had
 * no way to learn the other two and would have retried identically. These are
 * not guesses being accommodated, they are the same field under a name the
 * dossier normaliser already accepts elsewhere, so the edit API and the parser
 * now agree.
 */
const KEY_ALIASES = new Map(Object.entries({
  start_date: 'start', startdate: 'start', start_year: 'start', from: 'start', began: 'start',
  end_date: 'end', enddate: 'end', end_year: 'end', to: 'end', until: 'end', finished: 'end',
  role: 'title', position: 'title', job_title: 'title', position_title: 'title',
  employer: 'company', organisation: 'company', organization: 'company', org: 'company',
  company_name: 'company', employer_name: 'company', workplace: 'company',
  role_location: 'location', job_location: 'location', based_in: 'location', city: 'location',
  // A prose description of one role. Observed twice in a live session: the
  // model reached for "description" and then for "summary", both meaning the
  // same thing, and declined to retry after each was refused. Accepting the
  // natural names is cheaper than making the user resend.
  summary: 'description', role_summary: 'description', responsibilities: 'description',
  school: 'institution', university: 'institution', college: 'institution',
  field_of_study: 'field', major: 'field', subject: 'field',
  team: 'team_size', headcount: 'team_size', size: 'team_size',
}));

/**
 * Aliases that only make sense for one particular record type.
 *
 * The global table above maps `to`, `until` and `finished` to `end`, which is right
 * for employment — a role has a start and an end. Education has no `end` field: it
 * carries a single `year`. So those aliases resolved to a name education does not
 * have, `canonicalKey` returned null, and the key was reported as unknown.
 *
 * Observed repeatedly in a live chat, and it is the reason Jobby could not make
 * edits: a candidate saying "I was at SaskPoly from 2012 to 2014" produced an
 * education record carrying `start`, `end` and `honors`, and every one of those
 * was refused — so the institution and the degree, which were perfectly valid and
 * had been read straight out of that sentence, were thrown away with them. The
 * reply said "renamed what it could", then "nothing was written on that step",
 * which is the least useful possible answer to someone who has just told Jobby
 * something true about themselves.
 *
 * Checked before the global table, because these mappings are field-specific and a
 * global one would break employment: `end` has to stay `end` on a role.
 */
const FIELD_ALIASES = {
  education: {
    end: 'year', to: 'year', until: 'year', finished: 'year', finished_in: 'year',
    graduated: 'year', graduation: 'year', graduation_year: 'year', completion: 'year',
    completed: 'year', completion_year: 'year', class_of: 'year', year_graduated: 'year',
    degree_name: 'degree', qualification: 'degree', course: 'degree', credential: 'degree',
    discipline: 'field', subject_area: 'field', field_of_study: 'field',
    school: 'institution', university: 'institution', college: 'institution',
    institute: 'institution', institution_name: 'institution', attended: 'institution',
  },
};

/** Map an incoming key to its canonical name, or null when it is unknown. */
function canonicalKey(field, key) {
  if (has(OBJECT_LIST_FIELDS[field], key)) return key;
  // Field-specific aliases win: they know things about this record type that the
  // global table cannot. Applying the global one first would map `end` to a field
  // education does not have, and then reject the key for having it.
  const specific = FIELD_ALIASES[field]?.[String(key).toLowerCase()];
  if (specific && has(OBJECT_LIST_FIELDS[field], specific)) return specific;
  const alias = KEY_ALIASES.get(String(key).toLowerCase());
  if (alias && has(OBJECT_LIST_FIELDS[field], alias)) return alias;
  return null;
}

const LINKS_SUBFIELDS = ['linkedin', 'github', 'portfolio', 'website', 'other'];

/**
 * Section names the model prefixes a path with, meaning "the panel called X".
 *
 * The dossier is shown to people in sections - identity, contact - so the model
 * reaches for the label on screen rather than the key in the table. Observed
 * live: a user asked to change the headline, and the model sent
 * `identity.headline`, which was refused because "identity" is not a field.
 *
 * The prefix is stripped and the remainder resolved. That is the difference
 * between a refusal the model learns from and one it repeats: the same user would
 * otherwise have to say the same sentence twice because the tool knew what was
 * meant and would not say so.
 */
const SECTION_PREFIXES = new Set([
  'identity', 'contact', 'personal', 'profile', 'details', 'about', 'basics', 'general',
]);

/**
 * Root-level aliases: a word that names a real field without being its key.
 *
 * These are the words a person would use, or that a model reaches for, and each
 * maps to exactly one field. `title` is deliberately absent - at the root it is
 * ambiguous between the person's current title and a job title, and quietly
 * guessing which one was meant is the failure mode this whole table exists to
 * avoid. `current_title` and `headline` are not ambiguous.
 */
/**
 * Root-level aliases: a word that names a real field without being its key.
 *
 * These are the words a person would use, or that a model reaches for, and each
 * maps to exactly one field. `title` is deliberately absent - at the root it is
 * ambiguous between the person's current title and a job title, and quietly
 * guessing which one was meant is the failure mode this whole table exists to
 * avoid. `current_title` and `headline` are not ambiguous.
 *
 * A Map, not an object literal, and that is not a style preference. `ROOT_ALIASES
 * ['toString']` on a plain object returns Object.prototype.toString, so a path
 * called `toString` resolved to a function and the code assigning it blew up
 * mid-validation. The same trap the rest of this file already guards against for
 * `__proto__`, walked into again by a table that did not use Object.hasOwn.
 */
const ROOT_ALIASES = new Map(Object.entries({
  headline: 'current_title',
  current_role: 'current_title',
  role_title: 'current_title',
  job_title: 'current_title',
  title_line: 'current_title',
  company_name: 'current_company',
  employer_name: 'current_company',
  current_org: 'current_company',
  organisation: 'current_company',
  organization: 'current_company',
  org: 'current_company',
  employer: 'current_company',
  company: 'current_company',
  bio: 'summary',
  about_me: 'summary',
  professional_summary: 'summary',
  tagline: 'summary',
  descriptor: 'summary',
  seniority_level: 'seniority',
  level: 'seniority',
  years_experience: 'experience_years',
  years_of_experience: 'experience_years',
  years: 'experience_years',
  experience: 'experience_years',
  skills_list: 'skills',
  fields: 'job_fields',
  job_areas: 'job_fields',
  target_titles: 'target_roles',
  desired_roles: 'target_roles',
  roles_wanted: 'target_roles',
}));

/** The closest real field name to a word that was not recognised. */
function suggestField(word) {
  const w = String(word || '').toLowerCase();
  if (!w) return null;
  const pool = [...Object.keys(SCALAR_FIELDS), ...LIST_FIELDS, ...OBJECT_FIELDS,
    ...Object.keys(OBJECT_LIST_FIELDS)];
  let best = null;
  let bestScore = 0.34; // below this it is noise rather than a near miss
  for (const cand of pool) {
    const c = cand.toLowerCase();
    let score = 0;
    if (c === w) score = 1;
    else if (c.includes(w) || w.includes(c)) score = 0.8;
    else {
      const shared = [...new Set(c)].filter(ch => w.includes(ch)).length;
      score = shared / Math.max(c.length, w.length);
    }
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  return best;
}

export const WRITABLE_PATHS = [
  ...Object.keys(SCALAR_FIELDS),
  ...LIST_FIELDS,
  ...OBJECT_FIELDS,
  ...Object.keys(OBJECT_LIST_FIELDS),
  'links.linkedin', 'links.github', 'links.portfolio', 'links.website', 'links.other',
  ...Object.keys(OBJECT_LIST_FIELDS).flatMap(f => Object.keys(OBJECT_LIST_FIELDS[f]).map(k => `${f}.${k}`)),
];

/**
 * Keys that must never be written, checked independently of the field tables.
 *
 * `key in SOME_OBJECT` walks the prototype chain, so '__proto__' in
 * SCALAR_FIELDS is true and '__proto__' would have been accepted as a known
 * field. Every membership test below uses Object.hasOwn for that reason; this
 * list is the second lock on the same door.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const has = (obj, key) => Object.hasOwn(obj, key);

/** Parse 'employment[0].title' into ['employment', '0', 'title']. */
export function parsePath(path) {
  if (typeof path !== 'string' || !path.trim()) {
    return { ok: false, error: 'path must be a non-empty string' };
  }
  const trimmed = path.trim();
  if (trimmed.length > 200) return { ok: false, error: 'path is too long' };
  if (/[.[]/.test(trimmed.slice(1)) === false && !trimmed.includes('.')) {
    // fine, simple field
  }
  const parts = [];
  const re = /^([^.[\]]+)|\[(\d+)\]|\.([^.[\]]+)/g;
  let m;
  while ((m = re.exec(trimmed)) !== null) {
    if (m[1] !== undefined) parts.push(m[1]);
    else if (m[2] !== undefined) parts.push(m[2]);
    else if (m[3] !== undefined) parts.push(m[3]);
    if (re.lastIndex === 0) break;
  }
  if (!parts.length) return { ok: false, error: 'path could not be parsed' };

  // Strip a leading section name. `identity.headline` means the headline, and the
  // panel it is shown in is not part of where it is stored.
  if (parts.length > 1 && SECTION_PREFIXES.has(String(parts[0]).toLowerCase())) {
    parts.shift();
  }

  // Resolve a root-level alias before anything is rejected. A word that names a
  // real field is not a bad path, and refusing it teaches the model nothing it can
  // use - it has no way to know the key is `current_title` unless told, and being
  // told is cheaper than having the candidate restate the request.
  //
  // The lookup is on an underscored form, because the model writes these in prose:
  // "current role", "years of experience", "skills list" all arrived with spaces
  // where the table has underscores. Without folding them, four natural phrasings
  // missed aliases that were already listed under a different spelling.
  if (parts.length && !has(SCALAR_FIELDS, parts[0]) && !LIST_FIELDS.includes(parts[0])
    && !OBJECT_FIELDS.includes(parts[0]) && !has(OBJECT_LIST_FIELDS, parts[0])) {
    const spoken = String(parts[0]).toLowerCase().replace(/[\s-]+/g, '_');
    const alias = ROOT_ALIASES.get(spoken) ?? ROOT_ALIASES.get(String(parts[0]).toLowerCase());
    if (alias) parts[0] = alias;
  }

  // Validate: root must be writable, and any index must be numeric.
  for (const part of parts) {
    if (FORBIDDEN_KEYS.has(part)) {
      return { ok: false, error: `"${part}" is not a writable field` };
    }
  }
  const root = parts[0];
  if (READ_ONLY_PATHS.has(root)) {
    return { ok: false, error: `"${root}" is read-only: it describes the extraction, not the person` };
  }
  const known = has(SCALAR_FIELDS, root) || LIST_FIELDS.includes(root) ||
    OBJECT_FIELDS.includes(root) || has(OBJECT_LIST_FIELDS, root);
  if (!known) {
    // A bare link name means links.<name>. The model writes `github` because that
    // is what the field is called everywhere else in the system - the extract
    // reports links.github, the resume renderer reads it, and the ingest sets it -
    // so refusing the unqualified name taught it nothing except that its edit
    // failed. Observed live: "GitHub is not an available dossier field, so
    // github.com/xmrtdao was not saved", while links.github sat right there
    // writable.
    if (parts.length === 1 && LINKS_SUBFIELDS.includes(root.toLowerCase())) {
      return { ok: true, parts: ['links', root.toLowerCase()], root: 'links' };
    }
    // Name the nearest real field. A bare list of writable keys is true and
    // useless: the model cannot tell which of twenty-two is meant by a word it
    // reached for, so it would either guess again or ask the candidate to reword a
    // request that was perfectly clear.
    const near = suggestField(root);
    return {
      ok: false,
      error: `"${root}" is not a dossier field.`
        + (near ? ` Did you mean "${near}"?` : '')
        + ` Writable: ${WRITABLE_PATHS.slice(0, 12).join(', ')}, ...`,
    };
  }
  if (OBJECT_FIELDS.includes(root) && parts.length > 1 && !LINKS_SUBFIELDS.includes(parts[1])) {
    return { ok: false, error: `links.${parts[1]} is not a link field (${LINKS_SUBFIELDS.join(', ')})` };
  }
  // A scalar or plain list has no named subfields — but `skills[0]` is a valid
  // position, so only a non-numeric second segment is wrong here.
  if (parts.length > 1 && !OBJECT_FIELDS.includes(root) && !has(OBJECT_LIST_FIELDS, root)) {
    if (!/^\d+$/.test(parts[1])) {
      return { ok: false, error: `"${root}" holds a single ${LIST_FIELDS.includes(root) ? 'list' : 'value'}, so "${root}.${parts[1]}" is not a field of it` };
    }
    if (parts.length > 2) {
      return { ok: false, error: `"${root}[${parts[1]}]" is a text item, so "${parts[2]}" is not a field of it` };
    }
  }
  if (has(OBJECT_LIST_FIELDS, root) && parts.length > 1 && /^\d+$/.test(parts[1])) {
    // A trailing index with no subfield is legal — deleting a whole entry is
    // `employment[0]`. The subfield, when present, must be a real one.
    const sub = parts[2];
    if (sub !== undefined && !Object.keys(OBJECT_LIST_FIELDS[root]).includes(sub)) {
      // Normalise the key before rejecting it. KEY_ALIASES exists for exactly
      // this - the model writes `startDate` where the schema says `start` - but
      // it was only consulted when the value was applied, so the path was
      // refused first and the alias never got a chance. Observed live: a user
      // said "I founded Party Favor Photo in 2015", the model sent
      // `employment[0].startDate`, and the edit was rejected even though
      // `startdate` has been in the alias table all along.
      const canonical = canonicalKey(root, sub);
      if (canonical) {
        parts[2] = canonical;
      } else {
        return {
          ok: false,
          error: `${root}.${sub} is not a field (${Object.keys(OBJECT_LIST_FIELDS[root]).join(', ')})`,
        };
      }
    }
  }
  return { ok: true, parts, root };
}

/** Coerce a value to the type the field expects. Returns {ok, value} or {ok:false,error}. */
export function coerce(root, subfield, value) {
  let type;
  if (subfield) {
    if (has(OBJECT_LIST_FIELDS, root)) type = OBJECT_LIST_FIELDS[root][subfield] || 'string';
    else type = 'string'; // links.* and anything else textual
  } else if (has(SCALAR_FIELDS, root)) {
    type = SCALAR_FIELDS[root];
  } else if (LIST_FIELDS.includes(root)) {
    type = 'list';
  } else {
    type = 'string';
  }
  if (type === 'number') {
    if (value === null || value === '') return { ok: true, value: null };
    const n = typeof value === 'number' ? value : Number(String(value).match(/-?\d+(\.\d+)?/)?.[0]);
    if (!Number.isFinite(n)) return { ok: false, error: `"${value}" is not a number` };
    return { ok: true, value: n };
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    const s = String(value).toLowerCase();
    if (['true', 'yes', 'y', '1', 'current'].includes(s)) return { ok: true, value: true };
    if (['false', 'no', 'n', '0', ''].includes(s)) return { ok: true, value: false };
    return { ok: false, error: `"${value}" is not a yes/no value` };
  }
  if (type === 'list') {
    // An object here would stringify to "[object Object]" and end up in the
    // dossier as a skill called that. Refuse it instead.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: false, error: 'expected a list of text, got an object' };
    }
    const arr = Array.isArray(value) ? value : String(value).split(/[,;\n]/);
    const out = arr.map(v => (typeof v === 'string' ? v.trim() : v)).filter(v => v !== '' && v != null);
    if (out.some(v => typeof v !== 'string')) return { ok: false, error: 'list items must be text' };
    return { ok: true, value: out };
  }
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === 'string') return { ok: true, value: value.trim() || null };
  if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) };
  return { ok: false, error: 'value must be text, a number, a list, or null' };
}

/** Read a value at a parsed path. */
export function getAtPath(dossier, parts) {
  let cur = dossier;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Immutably set a value at a parsed path, creating intermediate objects. */
function setAtPath(target, parts, value) {
  const [head, ...rest] = parts;
  // Belt and braces: the path validator already rejects these, but this is the
  // function that would actually create the key.
  if (FORBIDDEN_KEYS.has(head)) return target;
  if (!rest.length) {
    // Assign via a plain object literal so no setter on Object.prototype runs.
    return Object.assign({}, target, { [head]: value });
  }
  const child = target[head];
  if (Array.isArray(child) || (child && typeof child === 'object')) {
    return { ...target, [head]: setAtPath(child, rest, value) };
  }
  return { ...target, [head]: setAtPath({}, rest, value) };
}

/** Immutably remove a value at a parsed path. */
function deleteAtPath(target, parts) {
  const [head, ...rest] = parts;
  if (FORBIDDEN_KEYS.has(head)) return target;
  if (!rest.length) {
    const next = { ...target };
    delete next[head];
    return next;
  }
  const child = target[head];
  if (child == null || typeof child !== 'object') return target;
  if (Array.isArray(child) && /^\d+$/.test(rest[0])) {
    const idx = Number(rest[0]);
    if (idx < 0 || idx >= child.length) return target;
    const next = [...child];
    if (rest.length === 1) next.splice(idx, 1);
    else next[idx] = deleteAtPath(child[idx], rest);
    return { ...target, [head]: next };
  }
  return { ...target, [head]: deleteAtPath(child, rest) };
}

const caseFold = s => String(s || '').trim().toLowerCase();

/**
 * Apply one edit to a dossier. Pure — returns a new dossier and the audit row
 * describing exactly what changed.
 *
 * @param dossier current dossier
 * @param edit {op:'set'|'add'|'update'|'delete', path, value, reason, confirmedByUser, actor}
 */
export function applyEdit(dossier, edit) {
  const base = dossier && typeof dossier === 'object' ? dossier : {};
  const op = String(edit?.op || '').toLowerCase();
  if (!['set', 'add', 'update', 'delete'].includes(op)) {
    return { ok: false, error: `op must be set, add, update or delete (got "${edit?.op}")` };
  }
  const parsed = parsePath(edit?.path);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { parts, root } = parsed;
  const subfield = has(OBJECT_LIST_FIELDS, root) ? parts[2] : (root === 'links' ? parts[1] : undefined);

  const before = getAtPath(base, parts);
  const beforeExists = before !== undefined;

  if (op === 'delete') {
    if (!beforeExists) return { ok: false, error: `nothing at "${edit.path}" to delete` };
    const after = deleteAtPath(base, parts);
    return {
      ok: true, dossier: after,
      audit: { op, path: parts.join('.'), before_value: before, after_value: null },
    };
  }

  // 'add' on a list appends rather than replacing — that is the whole point of
  // "add a skill" as opposed to "set skills".
  if (op === 'add' && LIST_FIELDS.includes(root) && parts.length === 1) {
    const coerced = coerce(root, undefined, edit.value);
    if (!coerced.ok) return { ok: false, error: coerced.error };
    const incoming = Array.isArray(coerced.value) ? coerced.value : [coerced.value];
    if (!incoming.length) return { ok: false, error: 'nothing to add' };
    const existing = Array.isArray(base[root]) ? base[root] : [];
    const seen = new Set(existing.map(caseFold));
    const added = [];
    for (const v of incoming) {
      if (!seen.has(caseFold(v))) { seen.add(caseFold(v)); added.push(v); }
    }
    if (!added.length) {
      return { ok: false, error: `already present: ${incoming.join(', ')}` };
    }
    return {
      ok: true,
      dossier: { ...base, [root]: [...existing, ...added] },
      audit: { op: 'add', path: root, before_value: existing, after_value: [...existing, ...added] },
      added,
    };
  }

  if (op === 'add' && has(OBJECT_LIST_FIELDS, root) && parts.length === 1) {
    const item = edit.value;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `adding to ${root} needs an object, e.g. {"company":"Acme","title":"Engineer"}` };
    }
    const allowed = OBJECT_LIST_FIELDS[root];
    const fieldList = Object.keys(allowed).join(', ');
    const clean = {};
    // Every unusable key is collected rather than returning on the first. One
    // bad key used to discard the whole entry while naming only itself, so a
    // model with three wrong key names was told about one and had no way to
    // learn the rest. Aliases are applied here too: start_date is start.
    const unknown = [];
    const invalid = [];
    const aliased = [];
    for (const [rawKey, v] of Object.entries(item)) {
      if (v === undefined || v === null || v === '') continue;
      const k = canonicalKey(root, rawKey);
      if (!k) { unknown.push(rawKey); continue; }
      if (k !== rawKey) aliased.push(`${rawKey} -> ${k}`);
      const c = coerce(root, k, v);
      if (!c.ok) { invalid.push(c.error); continue; }
      clean[k] = c.value;
    }
    if (invalid.length) return { ok: false, error: invalid.join('; ') };
    if (!Object.keys(clean).length) {
      // Nothing usable came out of the record. That is a genuine refusal: an entry
      // built entirely from keys we cannot store would be an empty shell that looks
      // like a fact in the dossier.
      return {
        ok: false,
        error: `${root}.${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not a field, so there was nothing to save. Valid fields: ${fieldList}.`
          + (aliased.length ? ` Renamed what it could: ${aliased.join(', ')}.` : ''),
        unknownKeys: unknown,
        validFields: fieldList,
        acceptedSoFar: clean,
      };
    }
    // A record with SOME good keys is written, and the ones we dropped are
    // reported rather than refused.
    //
    // This was the single reason Jobby could not make edits. Refusing the whole
    // entry on the strength of one unrecognised key meant that a candidate saying
    // "I did a BSc at SaskPoly, finished 2014" could not get the institution and
    // the degree into their own dossier whenever the model also attached an
    // `honors` or a `start` — and the model, having been refused, said so and
    // stopped. The two halves of that failure compound: the candidate believes
    // Jobby cannot remember them, and Jobby believes the candidate cannot be
    // trusted with their own record.
    //
    // What we cannot store is dropped, never invented, and named in the reply so
    // the candidate can say "and also I was on the dean's list" and have it
    // recorded once there is somewhere to record it.
    const dropped = unknown.length
      ? `${root}.${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not a field and ${unknown.length > 1 ? 'were' : 'was'} not saved. Valid fields: ${fieldList}.`
        + (aliased.length ? ` Renamed what it could: ${aliased.join(', ')}.` : '')
      : null;
    const existing = Array.isArray(base[root]) ? base[root] : [];
    return {
      ok: true,
      renamedKeys: aliased,
      // Carried so the caller can tell the candidate what did not get kept. A write
      // that silently discards part of what was said is how a dossier quietly stops
      // matching the person, which is the one thing this record exists to prevent.
      droppedNote: dropped,
      droppedKeys: unknown,
      dossier: { ...base, [root]: [...existing, clean] },
      audit: {
        op: 'add', path: `${root}[]`, before_value: existing, after_value: [...existing, clean],
        dropped_note: dropped,
      },
    };
  }

  // set / update, and add on a scalar (which behaves like set).
  if (op === 'add' && has(OBJECT_LIST_FIELDS, root) && parts.length > 1 && /^\d+$/.test(parts[1])) {
    return {
      ok: false,
      error: `"${edit.path}" is a position in an existing list. Use op "add" with just "${root}" to append a new entry.`,
    };
  }
  if ((op === 'set' || op === 'update') && /^\d+$/.test(parts[parts.length - 1] || '')) {
    // One element of a list-of-text, e.g. skills[0] = "Rust".
    if (!has(OBJECT_LIST_FIELDS, root)) {
      if (!LIST_FIELDS.includes(root)) {
        return { ok: false, error: `${root} is not a list, so "${edit.path}" is not a position in one` };
      }
      if (typeof edit.value !== 'string' || !edit.value.trim()) {
        return { ok: false, error: `${root}[n] needs the text to put at that position` };
      }
      const textList = Array.isArray(base[root]) ? [...base[root]] : [];
      const textIdx = Number(parts[1]);
      if (textIdx >= textList.length) {
        return { ok: false, error: `${root}[${textIdx}] does not exist (${root} has ${textList.length} item${textList.length === 1 ? '' : 's'}). Use op "add" to append.` };
      }
      const prior = textList[textIdx];
      textList[textIdx] = edit.value.trim();
      return {
        ok: true, dossier: { ...base, [root]: textList },
        audit: { op, path: `${root}[${textIdx}]`, before_value: prior, after_value: textList[textIdx] },
      };
    }
    // Writing a whole object-list element: `employment[0]` with an object value.
    const item = edit.value;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `setting ${root}[n] needs an object, e.g. {"company":"Acme","title":"Engineer"}` };
    }
    const allowed = OBJECT_LIST_FIELDS[root];
    const fieldList = Object.keys(allowed).join(', ');
    const clean = {};
    const unknown = [];
    const invalid = [];
    for (const [rawKey, v] of Object.entries(item)) {
      if (v === undefined) continue;
      const k = canonicalKey(root, rawKey);
      if (!k) { unknown.push(rawKey); continue; }
      const c = coerce(root, k, v);
      if (!c.ok) { invalid.push(c.error); continue; }
      clean[k] = c.value;
    }
    if (invalid.length) return { ok: false, error: invalid.join('; ') };
    if (!Object.keys(clean).length) {
      return {
        ok: false,
        error: `${root}.${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not a field, so nothing changed. Valid fields: ${fieldList}.`,
        unknownKeys: unknown,
        validFields: fieldList,
        acceptedSoFar: clean,
      };
    }
    // Same rule as the append path: keep what is valid, name what was dropped. An
    // edit that could not be applied for the want of one key used to lose the whole
    // record, including the parts that were already known to be true.
    const dropped = unknown.length
      ? `${root}.${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not a field and ${unknown.length > 1 ? 'were' : 'was'} not saved. Valid fields: ${fieldList}.`
      : null;
    const list = Array.isArray(base[root]) ? [...base[root]] : [];
    const idx = Number(parts[1]);
    if (idx >= list.length) return { ok: false, error: `${root}[${idx}] does not exist (there ${list.length === 1 ? 'is' : 'are'} ${list.length})` };
    const merged = op === 'update' ? { ...list[idx], ...clean } : clean;
    list[idx] = merged;
    return {
      ok: true,
      droppedNote: dropped,
      droppedKeys: unknown,
      dossier: { ...base, [root]: list },
      audit: {
        op, path: parts.join('.'), before_value: before ?? null, after_value: merged,
        dropped_note: dropped,
      },
    };
  }
  if (op === 'update' && !beforeExists) {
    return { ok: false, error: `nothing at "${edit.path}" to update. Use op "set" to create it.` };
  }
  if (op === 'set' && LIST_FIELDS.includes(root) && parts.length === 1) {
    const coerced = coerce(root, undefined, edit.value);
    if (!coerced.ok) return { ok: false, error: coerced.error };
    if (!Array.isArray(coerced.value)) return { ok: false, error: `${root} needs a list` };
    return {
      ok: true, dossier: { ...base, [root]: coerced.value },
      audit: { op, path: root, before_value: before ?? null, after_value: coerced.value },
    };
  }
  if (op === 'set' && has(OBJECT_LIST_FIELDS, root) && parts.length === 1) {
    const coerced = coerce(root, undefined, edit.value);
    if (!coerced.ok) return { ok: false, error: coerced.error };
    const arr = Array.isArray(coerced.value) ? coerced.value : [coerced.value];
    if (arr.some(v => typeof v !== 'string' || !v)) {
      return { ok: false, error: `${root} needs a list of text, e.g. ["cut p99 latency 42%"]` };
    }
    return {
      ok: true, dossier: { ...base, [root]: arr },
      audit: { op, path: root, before_value: before ?? null, after_value: arr },
    };
  }

  const coerced = coerce(root, subfield, edit.value);
  if (!coerced.ok) return { ok: false, error: coerced.error };
  let after = setAtPath(base, parts, coerced.value);
  if (op === 'update' && JSON.stringify(before) === JSON.stringify(coerced.value)) {
    return { ok: false, error: `"${edit.path}" is already ${JSON.stringify(before)}` };
  }
  // A field that now holds a value is no longer a field that was not stated.
  //
  // Without this the dossier says "phone: 804-555-0142" and "not_stated:
  // [phone]" at the same time, and anything that renders the missing list - which
  // is how a candidate is told what Jobby still needs - goes on reporting a
  // phone number as missing after it has been supplied. That is not cosmetic: it
  // is the difference between the change having landed and appearing not to have.
  after = reconcileNotStated(after, parts, coerced.value);
  return {
    ok: true, dossier: after,
    audit: { op, path: parts.join('.'), before_value: before ?? null, after_value: coerced.value },
  };
}

/**
 * Drop a top-level field from not_stated once it holds a real value.
 *
 * Top-level scalars only: a nested path like employment[0].title corresponds to
 * nothing in not_stated, and "the value is no longer empty" is the whole test.
 * A field explicitly set to null, "" or an empty list goes back onto the list,
 * because "I have no phone number" is itself a statement about the dossier.
 */
function reconcileNotStated(dossier, parts, value) {
  if (parts.length !== 1) return dossier;
  const root = parts[0];
  const list = Array.isArray(dossier.not_stated) ? dossier.not_stated : null;
  if (!list) return dossier;
  const empty = value === null || value === undefined || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
  const present = list.some(e => String(e).toLowerCase() === root.toLowerCase());
  if (empty && !present) return { ...dossier, not_stated: [...list, root] };
  if (!empty && present) {
    return {
      ...dossier,
      not_stated: list.filter(e => String(e).toLowerCase() !== root.toLowerCase()),
    };
  }
  return dossier;
}

/** Apply many edits in order. Stops at the first failure and reports which. */
export function applyEdits(dossier, edits) {
  let current = dossier && typeof dossier === 'object' ? dossier : {};
  const audits = [];
  // Collected across the whole batch. A partial write is still a write, and the
  // candidate has to be told which parts of what they said did not get kept —
  // otherwise "saved" reads as "all of it", and the dossier is quietly less
  // complete than the conversation they just had.
  const dropped = [];
  for (let i = 0; i < edits.length; i++) {
    const res = applyEdit(current, edits[i]);
    if (!res.ok) {
      return { ok: false, error: `edit ${i + 1} (${edits[i]?.op} ${edits[i]?.path}): ${res.error}`, applied: audits, dossier: current };
    }
    current = res.dossier;
    if (res.droppedNote) dropped.push(res.droppedNote);
    audits.push({
      ...res.audit,
      reason: edits[i]?.reason ?? null,
      confirmedByUser: Boolean(edits[i]?.confirmedByUser),
      actor: edits[i]?.actor || 'jobby',
      batchId: edits[i]?.batchId || null,
    });
  }
  return { ok: true, dossier: current, audits, dropped };
}

/**
 * Pull candidate edits out of a model reply.
 *
 * The model is asked for JSON, but it does not always comply, so this accepts
 * the shapes that actually show up: a bare object, an array, or a fenced block
 * that _extract_json_object already found.
 */
export function parseEditRequest(text) {
  if (!text || typeof text !== 'string') return { ok: false, error: 'no text' };
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  // Strip a leading "here you go:" style preamble.
  const brace = candidate.indexOf('{');
  const bracket = candidate.indexOf('[');
  let start = brace;
  if (brace === -1 || (bracket !== -1 && bracket < brace)) start = bracket;
  if (start > 0) candidate = candidate.slice(start);
  let parsed;
  try { parsed = JSON.parse(candidate); }
  catch {
    try { parsed = JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')); }
    catch { return { ok: false, error: 'reply was not valid JSON' }; }
  }
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.edits) ? parsed.edits : [parsed]);
  const edits = list
    .filter(e => e && typeof e === 'object' && (e.path || e.field))
    .map(e => ({
      op: e.op || e.operation || 'set',
      path: e.path || e.field,
      value: e.value !== undefined ? e.value : e.new_value,
      reason: e.reason || null,
      // Always false here, whatever the model wrote. "The user confirmed this"
      // is a claim about the conversation, not something a model gets to
      // assert about itself; the chat layer sets it from what the user
      // actually said in this turn.
      confirmedByUser: false,
      actor: 'jobby',
    }));
  if (!edits.length) return { ok: false, error: 'no edits found in reply' };
  return { ok: true, edits };
}

/** Short, human-readable diff for the chat reply. */
export function describeAudit(audit) {
  const fmt = v => {
    if (v === null || v === undefined) return 'empty';
    if (Array.isArray(v)) return v.length ? v.join(', ') : 'empty';
    const s = String(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  };
  const verb = { set: 'set', add: 'added', update: 'changed', delete: 'removed' }[audit.op] || audit.op;
  if (audit.op === 'delete') return `I ${verb} **${audit.path}** (was ${fmt(audit.before_value)}).`;
  if (audit.op === 'add' && Array.isArray(audit.after_value)) {
    // Report the delta, not the whole resulting list. "added Spanish" is the
    // fact; reprinting eleven skills buries it.
    const before = Array.isArray(audit.before_value) ? audit.before_value : [];
    const prior = new Set(before.map(caseFold));
    const added = audit.after_value.filter(v => !prior.has(caseFold(v)));
    return `I ${verb} **${audit.path}**: ${fmt(added.length ? added : audit.after_value)}.`;
  }
  return `I ${verb} **${audit.path}** to ${fmt(audit.after_value)}.`;
}

export function newBatchId() { return randomUUID().slice(0, 12); }
