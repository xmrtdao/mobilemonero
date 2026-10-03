/**
 * relay/jobby/views.mjs — per-track views of one dossier
 *
 * ── The idea, and who it is for ────────────────────────────────────────────
 *
 * The site used to say "One version of you". That was wrong, and specifically
 * wrong for the people this product exists to serve.
 *
 * A former Marine Sergeant who ran LV Switchers overseas and now works in
 * technical writing and journalism has a resume full of office roles. Handed to
 * a FIFO recruiter, that resume is nearly useless: nothing on it says heavy
 * equipment, camp, or rotation. Handed to an editor, the same resume is exactly
 * right. Nothing about the person changed — only which slice you looked at.
 *
 * So the dossier is not a document. It is a source, and each track reads a
 * different slice of it. The same career history supports a journalism view and
 * a FIFO view; which one exists depends on what is *in* the dossier, not on which
 * one the resume happened to lead with.
 *
 * ── Why a view cannot invent anything ──────────────────────────────────────
 *
 * Every view reads from the same stored dossier. A view reorders, re-labels and
 * re-frames; it never adds a fact that is not in the data. If a FIFO view cannot
 * find equipment experience, it says the view has nothing — it does not reach for
 * the closest office adjective and pass it off as site experience. That is the
 * same rule the dossier already follows about unconfirmed fields, and the reason
 * a view can be trusted to be shown to an employer.
 *
 * Military service is the case this was built for, and it is called out because
 * it is the most common thing a resume omits that a recruiter cares about. It
 * is not a decorative signal: it carries the discipline vocabulary that maps onto
 * site roles, and its absence is the single most common reason a trades candidate
 * is filtered out by keyword before a human reads them.
 */

/** How much a view leans on each part of the dossier. 0 = ignore, 1 = normal. */
const VIEW_WEIGHTS = {
  fifo: {
    // Equipment, licences, physical capability, and anything willingness-based.
    military_service: 3.0,
    equipment_operating: 3.0,
    certifications: 3.0,
    safety_training: 3.0,
    tickets: 2.5,
    remote_site_experience: 2.5,
    willingness: 3.0,
    employment: 1.2,
    skills: 1.0,
    achievements: 0.8,
    summary: 1.0,
    // Almost irrelevant to a camp supervisor, and actively unhelpful: office
    // accomplishments read as noise on a FIFO posting.
    education: 0.3,
  },
  journalism: {
    summary: 2.5,
    employment: 2.5,
    achievements: 3.0,
    skills: 2.0,
    certifications: 0.6,
    military_service: 0.4,
    equipment_operating: 0.3,
    education: 1.5,
    willingness: 0.8,
    tickets: 0.3,
  },
  technical: {
    skills: 3.0,
    certifications: 2.5,
    employment: 2.0,
    summary: 2.0,
    achievements: 1.8,
    education: 1.5,
    equipment_operating: 0.8,
    military_service: 0.5,
    willingness: 0.8,
  },
  office: {
    education: 2.5,
    employment: 2.5,
    skills: 2.0,
    summary: 2.0,
    achievements: 1.5,
    certifications: 1.5,
    equipment_operating: 0.2,
    military_service: 0.3,
    willingness: 1.0,
  },
  contract_consulting: {
    achievements: 3.0,
    summary: 2.5,
    employment: 2.0,
    skills: 1.8,
    certifications: 1.5,
    education: 1.2,
    equipment_operating: 0.4,
    military_service: 0.6,
    willingness: 1.5,
  },
  // The neutral reading, used when nothing says which slice fits.
  //
  // It exists because "I do not know which view applies" was producing an empty
  // packet rather than a plain one: the agent often has a URL and a role but no
  // track, every view is keyed on a track, and the candidate got a document with
  // no sections while their dossier sat there full. An empty packet reads as
  // "nothing about you applies" — a claim, and a false one.
  //
  // Every weight is near-neutral on purpose. This view is the absence of a
  // judgement, not a sixth opinion: it reorders nothing aggressively and invents
  // nothing, it just stops the packet coming out blank.
  general: {
    summary: 2.2,
    employment: 2.2,
    skills: 1.8,
    certifications: 1.6,
    achievements: 1.5,
    education: 1.4,
    tickets: 1.4,
    safety_training: 1.5,
    equipment_operating: 1.0,
    military_service: 1.0,
    remote_site_experience: 1.0,
    willingness: 1.0,
  },
};

// The five real lenses. `general` is deliberately NOT in this list: buildAllViews
// iterates it, so anything here becomes a switcher button in the dossier UI, and
// "read my whole record neutrally" is the absence of a lens, not a sixth one. It
// lives in VIEW_WEIGHTS and is reached only as a fallback — see GENERAL_VIEW.
export const VIEW_IDS = ['fifo', 'technical', 'journalism', 'office', 'contract_consulting'];

/**
 * The view used when nothing identifies a track.
 *
 * It has weights but no VIEW_META entry, so it cannot be picked in the switcher.
 * buildView needs meta for the label, so the fallback is given the smallest
 * honest description available rather than a specialism: this is your record as
 * written, with nothing suppressed for a particular kind of reader.
 */
export const GENERAL_VIEW = 'general';
export const GENERAL_VIEW_META = {
  id: 'general',
  label: 'Your record as written',
  blurb: 'No particular reader in mind, so nothing is suppressed for one.',
  audience: 'Used when the job has not been tied to a track yet.',
};

export const VIEW_META = {
  fifo: {
    id: 'fifo',
    label: 'Fly-in / fly-out and site work',
    blurb: 'Leads on equipment, licences, safety training and any evidence you can do rotations.',
    audience: 'Site supervisors, recruiters and hiring managers for remote and rotational roles.',
  },
  technical: {
    id: 'technical',
    label: 'Technical',
    blurb: 'Leads on tools, certifications and the engineering detail.',
    audience: 'Technical hiring managers and engineering leads.',
  },
  journalism: {
    id: 'journalism',
    label: 'Media and communications',
    blurb: 'Leads on published work, audience and measurable results.',
    audience: 'Editors, comms leads and publishers.',
  },
  office: {
    id: 'office',
    label: 'Business and administration',
    blurb: 'Leads on education, process and the operational record.',
    audience: 'Recruiters for corporate and administrative roles.',
  },
  contract_consulting: {
    id: 'contract_consulting',
    label: 'Consulting and contracting',
    blurb: 'Leads on outcomes delivered and the rate that goes with them.',
    audience: 'Clients who want to buy your time and results.',
  },
};

/**
 * Sections a view can lead on, in order.
 *
 * Absent sections are simply skipped, so a candidate with no equipment history
 * gets a FIFO view that starts with what they do have — and says it is thin.
 */
const VIEW_ORDER = {
  fifo: ['military_service', 'equipment_operating', 'certifications', 'safety_training',
    'tickets', 'remote_site_experience', 'willingness', 'employment', 'skills'],
  technical: ['certifications', 'skills', 'employment', 'achievements', 'education'],
  journalism: ['achievements', 'employment', 'skills', 'summary', 'education'],
  office: ['education', 'employment', 'skills', 'certifications', 'summary'],
  contract_consulting: ['achievements', 'summary', 'employment', 'skills', 'certifications'],
  // The neutral order: the things a recruiter reads first regardless of sector.
  // Every field is in VIEW_FRAMING.general with lead: true, because with no
  // specialism chosen there is no principled way to rank one above another — and
  // leaving the general view's framing empty is what made its packets produce an
  // empty `leadingWith`, so the agent was told to open with nothing.
  general: ['summary', 'employment', 'certifications', 'skills', 'achievements',
    'education', 'tickets', 'safety_training', 'equipment_operating',
    'remote_site_experience', 'willingness', 'military_service'],
};

/**
 * How a field should read once it has been filtered through a view.
 *
 * `label` is the frame the recruiter reads it in. Re-labelling is the whole
 * mechanism: "LV Switcher" read to a FIFO recruiter is equipment experience, and
 * the same string read to an editor is nothing. Neither reading is a lie; they
 * are answers to different questions.
 */
const VIEW_FRAMING = {
  fifo: {
    military_service: { label: 'Service and operational background', lead: true },
    equipment_operating: { label: 'Heavy equipment and machinery operated', lead: true },
    safety_training: { label: 'Safety training and certifications held', lead: true },
    remote_site_experience: { label: 'Remote and site-based experience', lead: true },
    willingness: { label: 'Availability and rotation preference', lead: true },
    tickets: { label: 'Licences and tickets held', lead: true },
  },
  journalism: {
    achievements: { label: 'Published work and results', lead: true },
    employment: { label: 'Reporting and editorial roles', lead: true },
  },
  technical: {
    certifications: { label: 'Technical certifications held', lead: true },
    skills: { label: 'Tools and technologies', lead: true },
  },
  office: {
    education: { label: 'Education and qualifications', lead: true },
    employment: { label: 'Roles and scope of responsibility', lead: true },
  },
  contract_consulting: {
    achievements: { label: 'Outcomes delivered', lead: true },
    summary: { label: 'What you sell, and to whom', lead: true },
  },
  // Plain labels, on purpose. This view exists to say "here is your record", so
  // it reframes nothing. Re-labelling is a per-track device; applying it here
  // would dress an untracked application up in some track's language.
  general: {
    summary: { label: 'Summary', lead: true },
    employment: { label: 'Roles held', lead: true },
    certifications: { label: 'Certifications held', lead: true },
    skills: { label: 'Skills', lead: true },
    achievements: { label: 'Achievements', lead: true },
    education: { label: 'Education', lead: true },
    tickets: { label: 'Licences and tickets', lead: true },
    safety_training: { label: 'Safety training', lead: true },
    equipment_operating: { label: 'Equipment operated', lead: true },
    remote_site_experience: { label: 'Remote and site-based experience', lead: true },
    willingness: { label: 'Availability', lead: true },
    military_service: { label: 'Service background', lead: true },
  },
};

/** Vocabulary that maps an office-era title onto site language. */
const MILITARY_TO_SITE = {
  'infantry': ['ground movement', 'field operations', 'route and area security'],
  'motor transport': ['heavy equipment transport', 'fleet movement', 'vehicle recovery'],
  'driver': ['commercial driving', 'load transport', 'vehicle inspection'],
  'combat engineer': ['construction', 'demolition', 'field fortification'],
  'engineer': ['equipment operation', 'field systems', 'power distribution'],
  'aviation': ['rotorcraft operation', 'aerial observation', 'flight operations'],
  'logistics': ['supply chain', 'material handling', 'distribution'],
  'medical': ['first aid and casualty response', 'remote medical support'],
  'artillery': ['heavy equipment', 'survey and targeting', 'explosives handling'],
  'marine': ['seagoing operations', 'watchkeeping', 'deck and engine maintenance'],
  'supply': ['logistics', 'warehouse operations', 'inventory control'],
  'admin': ['administration', 'records and scheduling'],
};

/**
 * Build one view of a dossier.
 *
 * @param {object} dossier  the stored dossier
 * @param {string} viewId   one of VIEW_IDS
 * @returns {{view, sections, empty, honest}}
 */
export function buildView(dossier, viewId = 'fifo') {
  // `general` is a real view with weights but no switcher entry, so it is
  // accepted here explicitly. It used to be swept up by the fallback below and
  // silently read as fifo — the one view that suppresses education and
  // emphasises equipment — so a packet built for an untracked job was dressed up
  // as a camp job. An untracked job now reads as untracked.
  const view = VIEW_IDS.includes(viewId) || viewId === GENERAL_VIEW
    ? viewId
    : 'fifo';
  const meta = view === GENERAL_VIEW ? GENERAL_VIEW_META : VIEW_META[view];
  const weights = VIEW_WEIGHTS[view];
  const d = dossier && typeof dossier === 'object' ? dossier : {};

  const sections = [];
  for (const field of (VIEW_ORDER[view] || VIEW_ORDER.fifo)) {
    const value = readField(d, field) ?? deriveField(d, field);
    if (!value) continue;
    const framing = (VIEW_FRAMING[view] || {})[field];
    sections.push({
      field,
      label: framing?.label || humanise(field),
      lead: framing?.lead ?? false,
      weight: weights[field] ?? 1,
      value,
      // Carried on every derived section so the page can show where the content
      // came from. A view that read "open to rotations" out of a summary has to
      // say so, or the candidate cannot tell a recorded fact from a reading of one.
      derivedFrom: value?.derivedFrom ?? null,
      // For FIFO, military and equipment entries carry the mapped site
      // vocabulary alongside the original wording, never instead of it.
      alsoShows: view === 'fifo' && field === 'military_service'
        ? mapMilitaryToSite(value?.items || value)
        : null,
    });
  }

  // Rank by weight, keep declaration order within a weight.
  sections.sort((a, b) => b.weight - a.weight);

  // What this view has nothing on. Named, so a thin view reads as thin.
  //
  // Measured against the sections actually rendered, not against the source
  // fields. The first version checked the fields directly and produced a view
  // that showed "Safety training and certifications held — 3 items" in the same
  // breath as "this view cannot show: safety training". Both true of the source
  // data, and together they read as a contradiction rather than as a nuance.
  const shown = new Set(sections.map((s) => s.field));
  const missing = [];
  if (view === 'fifo') {
    const gaps = [
      ['equipment operated', 'equipment_operating'],
      ['licences or tickets', 'tickets'],
      ['safety training', 'safety_training'],
      ['availability for rotations', 'willingness'],
      ['service background', 'military_service'],
    ];
    for (const [label, field] of gaps) {
      if (!shown.has(field)) missing.push(label);
    }
  }

  return {
    view,
    label: meta.label,
    blurb: meta.blurb,
    audience: meta.audience,
    sections,
    // The honest lead: a view with nothing on it says so instead of borrowing
    // from another slice.
    empty: sections.length === 0,
    whatItCannotShow: missing,
    // Never presented as a rewrite of the person. It is a lens on one dossier.
    note:
      'This is a view of the same dossier, not a different person. Every line here is ' +
      'something your resume or your own corrections established — nothing has been ' +
      'invented to fill a gap.',
  };
}

/** Build every view, so a candidate can see which ones have real content. */
export function buildAllViews(dossier) {
  return VIEW_IDS.map((id) => {
    const v = buildView(dossier, id);
    return {
      view: id,
      label: v.label,
      blurb: v.blurb,
      audience: v.audience,
      // Counts AND the sections themselves. The page switches view without a
      // round trip, which matters because the switch is the interaction — a
      // candidate flicking between "FIFO" and "journalism" to see what changes
      // should not wait on a request each time.
      sections: v.sections,
      sectionCount: v.sections.length,
      leadSections: v.sections.filter((s) => s.lead).length,
      whatItCannotShow: v.whatItCannotShow,
      empty: v.empty,
      note: v.note,
    };
  });
}

/** The view that best matches a track, for automatic selection. */
export const TRACK_TO_VIEW = {
  1: 'contract_consulting',
  2: 'contract_consulting',
  3: 'technical',
  4: 'technical',
  5: 'fifo',
};

export function viewForTrack(trackId) {
  return TRACK_TO_VIEW[Number(trackId)] || null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function readField(d, field) {
  const v = d[field];
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? v : null;
  if (typeof v === 'object') return Object.keys(v).length ? v : null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * Read a concept from wherever the dossier happens to keep it.
 *
 * ── Why this exists, and why it is not a fudge ─────────────────────────────
 *
 * The dossier has nine scalar fields and eleven list fields. It has no
 * `willingness`, no `safety_training`, no `equipment_operating` — and it never
 * will, because a resume is prose and the schema is a fixed vocabulary. The
 * concept of "open to rotations" will therefore keep arriving as a sentence in
 * `summary`, and "H2S Alive / SCBA" will keep arriving as a string in
 * `certifications`.
 *
 * The first version of this read only the dedicated fields, so a resume that
 * said all four certifications in prose produced a FIFO view reporting "safety
 * training" and "licences or tickets" as gaps. That is not a small error: the
 * view was claiming the candidate lacked credentials they had written down.
 *
 * So: look for the fact where it already lives, and **say where it came from**.
 * Nothing here creates content — it only locates existing content and attaches
 * `derivedFrom` so the UI can show that it was read out of the summary rather
 * than recorded as a field. A candidate can correct either, and neither is a
 * guess.
 */
function deriveField(d, field) {
  switch (field) {
    case 'willingness': {
      // A stated preference, in the candidate's or the resume's own words.
      const m = /\b(?:open|available|seeking|looking|interested|prefer|willing|keen)[^.!?]{0,90}?\b(?:fly[- ]in|rotational|rotation|remote\s+site|camp|offshore|relocat\w*|travel)\b[^.!?]*/i
        .exec(String(d.summary || ''));
      if (m) {
        return { text: m[0].trim().replace(/\s+/g, ' '), derivedFrom: 'stated in your summary' };
      }
      return null;
    }

    case 'safety_training': {
      const certs = asArray(d.certifications);
      const found = certs.filter((c) =>
        /\b(h2s|scba|confined\s*space|working\s*at\s*height|fall\s*arrest|first\s*aid|huet|survival|rigging\s*level|blaster|shotfir)/i.test(c));
      if (!found.length) return null;
      return { items: found, derivedFrom: 'listed among your certifications' };
    }

    case 'tickets': {
      const certs = asArray(d.certifications);
      const found = certs.filter((c) =>
        /\b(red\s*seal|journeyman|cdl|class\s*[ab]\b|licen[cs]e|certificat\w*\s+of\s+competence|asic|red\s?seal|apprentice(ship)?\s+complete|flag\s*state)\b/i.test(c));
      if (!found.length) return null;
      return { items: found, derivedFrom: 'listed among your certifications' };
    }

    case 'equipment_operating': {
      // Equipment named in the role titles or the skills list. Both are the
      // candidate's own words rather than anything this module chose.
      const fromTitles = asArray(d.roles_in_resume).concat(asArray(d.target_roles));
      const fromSkills = asArray(d.skills);
      const equipmentRe = /\b(lv\s?switcher|hemtt|excavator|dozer|loader|haul\s?truck|grader|backhoe|crane|skid\s?steer|side\s?boom|jumbo|drill\s?rig|tractor|forklift|reach\s?truck|bulldozer|mulcher|feller\s?buncher|scraper|shovell|water\s?cart|generator|tower\s?crane)/i;
      const found = [...new Set([
        ...fromTitles.filter((x) => equipmentRe.test(String(x))),
        ...fromSkills.filter((x) => equipmentRe.test(String(x))),
      ])];
      if (!found.length) return null;
      return { items: found, derivedFrom: 'named in your roles and skills' };
    }

    case 'remote_site_experience': {
      // Site and rotation evidence in the employment highlights, which is where
      // a resume actually puts it.
      const highlights = asArray(d.employment)
        .flatMap((j) => (Array.isArray(j?.highlights) ? j.highlights : []));
      const found = highlights.filter((h) =>
        /\b(remote|rural|offshore|camp|rotation|rotational|fly[- ]in|fly[- ]out|14\/14|12\/12|2 weeks on|site based|field work)\b/i.test(String(h)));
      if (!found.length) return null;
      return { items: found, derivedFrom: 'from your role descriptions' };
    }

    case 'military_service': {
      // Only ever from a recorded service entry. Nothing infers this — the
      // absence is reported as a gap rather than guessed at, because a Marine
      // heading in a FIFO packet that they never served would be indefensible.
      const ms = d.military_service;
      if (!ms) return null;
      if (Array.isArray(ms) && ms.length) return { items: ms, derivedFrom: 'as you recorded it' };
      return { text: String(ms), derivedFrom: 'as you recorded it' };
    }

    default:
      return null;
  }
}

function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null && String(x).trim());
  if (typeof v === 'string') return v.trim() ? [v] : [];
  return [];
}

/**
 * Map a service record onto the site vocabulary a FIFO recruiter reads.
 *
 * Only ever *adds*. The original entry stays intact and visible, because
 * "Motor Transport MLC" is a fact and "heavy equipment operator" is an
 * interpretation of it. Showing both, labelled as one and the other, is what
 * keeps this honest — and it lets the candidate correct the interpretation.
 *
 * ── On word boundaries, which this got wrong first ─────────────────────────
 *
 * The first version used `text.includes(needle)` and that produced "deck and
 * engine maintenance", "watchkeeping" and "seagoing operations" for a **Marine
 * Corps Motor Transport Sergeant** — because the word "marine" is in "Marine
 * Corps". A substring match cannot tell a branch name from an occupational
 * specialty, and the failure lands in the worst possible place: it tells a
 * ground-equipment operator they have shipboard experience, to a recruiter who
 * knows the difference.
 *
 * So the military branch is now parsed out and never searched for occupational
 * terms, and every occupational needle requires a word boundary.
 */
function mapMilitaryToSite(service) {
  const entries = Array.isArray(service) ? service : [service];
  const out = [];
  const reasons = new Map();

  for (const entry of entries) {
    const parts = typeof entry === 'string'
      ? { text: entry, branch: '', unit: '' }
      : {
        text: [entry?.branch, entry?.role, entry?.unit, entry?.description]
          .filter(Boolean).join(' '),
        branch: entry?.branch || '',
        unit: entry?.unit || '',
      };
    if (!parts.text) continue;

    // The branch is a service-wide fact, not a specialty. It is excluded from
    // occupational matching so "Marine Corps" cannot imply a deckhand.
    const branch = String(parts.branch || '');
    const rest = branch
      ? parts.text.replace(new RegExp(escapeRe(branch), 'gi'), ' ')
      : parts.text;

    for (const [needle, maps] of Object.entries(MILITARY_TO_SITE)) {
      // "marine" is both a branch and an occupational term (Marine Corps
      // logistics). After stripping the branch, a genuine Marine *occupation*
      // still matches, on word boundaries.
      const re = new RegExp(`(^|[^a-z])${escapeRe(needle)}([^a-z]|$)`, 'i');
      if (!re.test(rest)) continue;
      for (const m of maps) {
        if (out.some((o) => o.toLowerCase() === m.toLowerCase())) continue;
        out.push(m);
        reasons.set(m, `read from "${needle}" in your service record — correct me if that is wrong`);
      }
    }
  }

  if (!out.length) return null;
  // Reason is attached last, once, so it is not mutated by the push loop.
  Object.defineProperty(out, 'reason', {
    value: [...reasons.values()][0] || null,
    enumerable: false,
  });
  return out;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function humanise(field) {
  return String(field).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default {
  buildView, buildAllViews, viewForTrack,
  VIEW_IDS, VIEW_META, TRACK_TO_VIEW, VIEW_WEIGHTS,
};
