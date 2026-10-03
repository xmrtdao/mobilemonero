/**
 * relay/jobby/tracks.mjs — Which search tracks to run
 *
 * The base plan is tracks 3 (full-time) and 4 (ATS automation); those are how
 * anyone gets hired. Tracks 1 (contract consulting) and 2 (temporary/contract)
 * are added when the resume supports selling services directly — a consultant,
 * a business owner, or a senior practitioner with a specialisation someone
 * would pay for.
 *
 * This is deliberately keyword-and-structure based rather than an LLM call.
 * It decides which money streams open, the client can see the exact signals
 * that turned each one on, and it returns the same answer every time.
 */

export const TRACKS = {
  1: {
    id: 1,
    key: 'contract_consulting',
    name: 'Contract consulting',
    blurb: 'High-engagement direct outreach selling your time and outcomes.',
  },
  2: {
    id: 2,
    key: 'temporary_contract',
    name: 'Temporary & contract roles',
    blurb: 'Contract and interim positions, usually via an agency or employer page.',
  },
  3: {
    id: 3,
    key: 'full_time',
    name: 'Full-time employment',
    blurb: 'Permanent roles, the main path to salary plus benefits.',
  },
  4: {
    id: 4,
    key: 'ats_automation',
    name: 'ATS application automation',
    blurb: 'Volume applications through applicant tracking systems, behind the page-agent boundary.',
  },
  5: {
    id: 5,
    key: 'fifo_remote_site',
    name: 'FIFO & remote-site roles',
    blurb: 'Rotational fly-in/fly-out and austere-site work: mining, offshore, polar, remote trades, shipboard.',
  },
};

export const BASE_TRACKS = [3, 4];

/**
 * Why track 5 is opt-in rather than base.
 *
 * A FIFO rotation is a different shape of commitment from a normal job: fixed
 * weeks on site away from home, bunk or camp accommodation, and contracts that
 * run a season. Opening it by default would put roles in front of candidates who
 * have not said they can leave, which is worse than leaving it closed and
 * saying so. It opens on a stated willingness to rotate, or when the client asks.
 */
export const FIFO_TRACK = 5;

/**
 * Signals that the candidate can be sold as a service rather than only hired.
 * Each records where it was found so the decision is explainable.
 */
const CONSULTING_SIGNALS = [
  { re: /\b(independent\s+consultant|consultant|consulting)\b/i, label: 'consulting work named' },
  { re: /\b(founder|co-?founder|owner|proprietor|partner)\b/i, label: 'founder/owner title' },
  { re: /\b(self-?employed|freelance|freelancer|independent\s+contractor|1099)\b/i, label: 'self-employed or freelance' },
  { re: /\b(principal|managing\s+partner|executive\s+director)\b/i, label: 'principal-level title' },
  // A registered entity is the strongest possible signal.
  { re: /\b(llc|llp|inc\.?|incorporated|ltd\.?|plc|gmbh|s\.?a\.?)\b/i, label: 'registered business entity' },
  { re: /\b(my\s+(clients|customers|book\s+of\s+business)|advisory|advisor)\b/i, label: 'advisory/client-facing business' },
  // Sold deliverables rather than employed for them.
  { re: /\b(led\s+consultanc|ran\s+(a\s+)?(practice|agency|studio)|built\s+a\s+(practice|client\s+base))\b/i, label: 'ran an independent practice' },
];

const CONTRACT_SIGNALS = [
  { re: /\b(contract|contractor|contracting|temporary|temp|interim)\b/i, label: 'contract/temp work named' },
  { re: /\b(contract-?to-?hire|fixed[- ]term|short[- ]term\s+contract|project[- ]based)\b/i, label: 'fixed-term or project-based work' },
  { re: /\b(day[- ]rate|hourly\s+rate|day\s+rate|per\s+diem|rate\s+card)\b/i, label: 'billable rate language' },
  { re: /\b(available\s+immediately|open\s+to\s+(work|contracts)|immediately\s+available)\b/i, label: 'stated availability' },
  { re: /\b(agency|staffing|recruiter|staffing\s+agency)\b/i, label: 'agency/staffing channel' },
];

/**
 * Signals that a candidate can (or wants to) take rotational or remote-site work.
 *
 * Split into two tiers on purpose, and the split is load-bearing. Willingness to
 * go is a different claim from having done the work, and only the first opens the
 * track. Someone who has done site work is not someone who wants to do it again,
 * and plenty of those people are bound by dependants, health, or a partner who
 * cannot travel.
 *
 * Note the tiering is not cosmetic. Track 5 leads to applications, and
 * applications send mail in the candidate's name, so every send still passes the
 * existing claim gate exactly as the other three tracks do. Opening the track
 * changes what Jobby looks for; it never changes who is allowed to speak.
 */
const FIFO_SIGNALS = [
  // ── Stated willingness. These open the track. ───────────────────────────
  // A preference written in the resume is the candidate saying so in their own
  // words, which is the only thing this track should open on.
  { re: /\b(fly[- ]in[- ]fly[- ]out|FIFO)\b/i, label: 'fly-in/fly-out named', opens: true },
  // "Willing to relocate" counts, and "willing to travel" has to as well — a
  // candidate who will relocate is exactly the one FIFO can be for. The verb
  // list is kept short so a bare "open to new opportunities" cannot trip it.
  // `to|for` is optional after "willing", and the trailing word group allows an
  // optional "e" so the pattern matches BOTH "relocate" and "relocating".
  //
  // That last detail was a real bug. Written as `\brelocat\b`, the trailing \b
  // requires a word character after the stem, so the infinitive "willing to
  // relocate" could never match — only "relocating" did. The same trap applies
  // to camp/camping and travel/travelling, so every alternative below is spelled
  // with an explicit optional suffix rather than relying on \b.
  { re: /\b(willing|open|available|keen|happy)\b(?:\s+(?:to|for))?[^.]{0,40}?\b(travel\w*|relocat\w*|rotat\w*|be\s+away|mov(?:e|ing)|remote\s+site|camp\w*|offshore|fly[- ]in)\b/i, label: 'stated willingness to travel or relocate', opens: true },
  { re: /\b(looking\s+for|seeking|interested\s+in|prefers?|wants?|considering)\b[^.]{0,40}\b(fifo|fly[- ]in|rotational|rotation|remote\s+site|camp\s+work|offshore)\b/i, label: 'stated looking for rotational work', opens: true },
  { re: /\b(can|able\s+to)\b[^.]{0,30}\b(do|start|available\s+for)\b[^.]{0,30}\b(rotations?|fifo|fly[- ]in|camp|offshore)\b/i, label: 'stated availability for rotations', opens: true },

  // ── Site experience. These NEVER open it. ───────────────────────────────
  //
  // An earlier cut of this list treated these as openers and it was wrong. "Red
  // Seal electrician, five years at a northern mine camp" opened track 5, which
  // is precisely the inference this tier exists to prevent: someone who has done
  // site work is not someone who wants to do it again. Plenty are bound by
  // dependants, health, or a partner who cannot travel. They are recorded, and
  // surfaced through fifo.offeredByExperience so the candidate is told the track
  // exists and can open it with a word.
  { re: /\b(remote\s+(site|village|site\s+work|operations)|fly[- ]camp|bunkhouse|camp\s+life|camp\s+accommodation|camp\s+job|accommodation\s+provided)\b/i, label: 'remote or camp site work', opens: false },
  // Kept deliberately wider than the opener version: "offshore rig technician"
  // and "steel erector on remote construction camp" are both plain statements
  // about work already done, and both belong here. Only the "seeking/willing"
  // patterns above may open the track.
  { re: /\b(offshore|off[- ]shore|rig|oil\s?&?\s?gas|wellsite|derrick|oil\s+sands)\b/i, label: 'offshore or oil and gas', opens: false },
  { re: /\b(northern|arctic|antarcti|tundra|permafrost|alaska|nunavut|yellowknife|perth|katanning|oil\s+sands)\b/i, label: 'northern or isolated region work', opens: false },
  { re: /\b(red\s+seal|trade\s+ticket|ticketed\s+trade|journeyperson|apprenticeship\s+complete)\b/i, label: 'ticketed trade', opens: false },
  { re: /\b(polar\s+station|antarctic\s+program|ice\s+core|research\s+station)\b/i, label: 'polar or research station', opens: false },
  { re: /\b(merchant\s+marine|seaman|deck\s+hands?|marine\s+engineer|motorman|aboard)\b/i, label: 'shipboard or marine', opens: false },
  { re: /\b(medevac|rotator|hospital\s+advocate|remote\s+medicine)\b/i, label: 'remote or expedition medical', opens: false },
  { re: /\b(rig\s+tech|rigger|driller|derrickhand|offshore\s+crew|well\s+intervention)\b/i, label: 'offshore or wellsite crew role', opens: false },
];

// Licences the roster actually names. These gate nothing on their own — they are
// surfaced so a candidate is told what a posting needs before applying, rather
// than discovering it at the offer stage.
const FIFO_TICKETS = [
  { re: /\bred\s+seal\b/i, label: 'Red Seal certification' },
  { re: /\b(ticketed?\s+trade|trade\s+tickets?)\b/i, label: 'a valid trade ticket' },
  { re: /\b(first\s+aid|medic|emt|paramedic|nursing)\b/i, label: 'a current medical certification' },
  { re: /\b(rigging|slinging|certified\s+rigger|signalman|bankman)\b/i, label: 'a lifting/rigging certification' },
  { re: /\b(blasting|shotfirer|explosives)\b/i, label: 'a blasting licence' },
  { re: /\b(h2s|scba|confined\s+space|gas\s+test)\b/i, label: 'H2S/SCBA or confined-space certification' },
];

/** Flatten a dossier into one searchable blob of the text the resume actually asserts. */
export function dossierText(dossier) {
  if (!dossier || typeof dossier !== 'object') return '';
  const parts = [];
  const push = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(push); return; }
    if (typeof v === 'object') { Object.values(v).forEach(push); return; }
    if (typeof v === 'string' || typeof v === 'number') parts.push(String(v));
  };
  push(dossier);
  return parts.join(' \n ');
}

/** Senior individual-contributor standing, which is what makes someone sellable. */
const SENIORITY_RE = /\b(senior|sr\.?|staff|principal|lead|head\s+of|director|vp|vice\s+president|chief|cto|cio|coo|ceo|architect|principal\s+engineer|distinguished|expert)\b/i;

/**
 * Decide the active track set.
 * @returns {{tracks:number[], reasons:Record<string,string>, signals:string[], sellsServices:boolean}}
 */
export function decideTracks(dossier, { userOverride = null } = {}) {
  const text = dossierText(dossier);
  const signals = [];
  const matched = (list) => {
    const found = [];
    for (const s of list) {
      const m = s.re.exec(text);
      if (m) { found.push(s.label); signals.push(`${s.label} ("${m[0].trim()}")`); }
    }
    return found;
  };

  const consulting = matched(CONSULTING_SIGNALS);
  const contract = matched(CONTRACT_SIGNALS);

  // Track 5. `matched` collects labels, so the tiering is done here rather than
  // baked into the signal list: a ticketed trade is real site experience but is
  // not itself a statement that the candidate will rotate, so it is recorded and
  // reported without opening the track on its own.
  const fifoOpened = [];
  const fifoSupporting = [];
  for (const s of FIFO_SIGNALS) {
    const m = s.re.exec(text);
    if (!m) continue;
    const hit = `${s.label} ("${m[0].trim()}")`;
    if (s.opens) { fifoOpened.push(s.label); signals.push(hit); }
    else { fifoSupporting.push(s.label); signals.push(hit + ' — site experience, not a stated preference to rotate'); }
  }
  const tickets = [];
  for (const t of FIFO_TICKETS) {
    if (t.re.test(text)) tickets.push(t.label);
  }

  // Seniority alone does not open a consulting track — plenty of senior
  // employees are not independent sellers — but combined with any contract
  // signal it does.
  const senior = SENIORITY_RE.test(text);
  if (senior) signals.push('senior-level title');

  // A business owner is by definition a consultant. An established senior
  // practitioner with contract language is sellable too.
  const sellsServices = consulting.length > 0 || (contract.length > 0 && senior);

  const tracks = [...BASE_TRACKS];
  const reasons = {
    3: 'Every search needs a permanent-role path open.',
    4: 'Volume applications through ATS run alongside targeted outreach.',
  };

  if (sellsServices) {
    tracks.push(1);
    reasons[1] = consulting.length
      ? `Resume shows independent practice: ${consulting.join('; ')}.`
      : `Senior practitioner with contract signals: ${contract.join('; ')}.`;
    tracks.push(2);
    reasons[2] = 'Contract and interim roles bridge the gap while permanent roles are pursued.';

    // Keep the declared order 1,2,3,4,5.
    tracks.sort((a, b) => a - b);
  }

  // Track 5. Opened only on a stated willingness to rotate, or asked for below.
  // Site experience alone is reported but does not open it, because "has done
  // northern mine work" is not "will take a rotation" and the difference matters
  // to someone with dependants.
  if (fifoOpened.length) {
    tracks.push(FIFO_TRACK);
    reasons[FIFO_TRACK] = `Resume states fit for remote-site or rotational work: ${fifoOpened.join('; ')}.`;
    if (fifoSupporting.length) {
      reasons[FIFO_TRACK] += ` Supporting site experience: ${fifoSupporting.join('; ')}.`;
    }
    reasons[FIFO_TRACK] += ' Confirm the roster pattern before applying — rotations are weeks away from home.';
  }

  if (userOverride && Array.isArray(userOverride) && userOverride.length) {
    const valid = [...new Set(userOverride.map(Number).filter(n => TRACKS[n]))].sort((a, b) => a - b);
    for (const t of valid) {
      if (!tracks.includes(t)) tracks.push(t);
      reasons[t] = reasons[t] || 'Enabled by the client.';
    }
    tracks.sort((a, b) => a - b);
  }

  return {
    tracks,
    reasons,
    signals: [...new Set(signals)],
    sellsServices,
    // Track 5 detail, kept beside the track list rather than inside it so the
    // decision function's shape stays the same for every other consumer.
    fifo: {
      // open is what actually happened; eligibility is what the resume supports.
      open: tracks.includes(FIFO_TRACK),
      signals: fifoOpened,
      supporting: fifoSupporting,
      tickets,
      // True when there is site experience but no stated wish to rotate. Worth
      // surfacing to the candidate: the track is one word away.
      offeredByExperience: fifoSupporting.length > 0 && fifoOpened.length === 0,
    },
  };
}

/** Human-readable explanation, used in chat and in the plan. */
export function explainTracks(decision) {
  const lines = decision.tracks.map(
    id => `Track ${id} — ${TRACKS[id].name}: ${decision.reasons[id] || 'enabled'}`);
  if (!decision.sellsServices) {
    lines.push(
      'Nothing in the resume yet shows independent practice or a sellable specialisation, ' +
      'so tracks 1 and 2 stay closed. Say the word if you freelance, consult, or own ' +
      'something and I will open them.');
  }
  // Track 5 gets its own note, because "closed" and "closed but you look like you
  // could do it" are different things to a candidate reading a plan.
  const fifo = decision.fifo;
  if (fifo && !fifo.open && fifo.offeredByExperience) {
    lines.push(
      'Track 5 (FIFO and remote-site roles) is closed because you have not said you want to ' +
      'rotate, even though your background fits it: ' + fifo.supporting.join('; ') +
      '. Rotations mean weeks away from home. If that works for you, say so and I will open it.');
  }
  return lines.join('\n');
}
