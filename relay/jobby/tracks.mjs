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
};

export const BASE_TRACKS = [3, 4];

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

    // Keep the declared order 1,2,3,4.
    tracks.sort((a, b) => a - b);
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
  return lines.join('\n');
}
