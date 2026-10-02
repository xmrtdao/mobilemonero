/**
 * relay/jobby/titles.mjs — the known-role library
 *
 * Jobby could tell a candidate "I found nothing for you" but had no vocabulary
 * to tell them "I don't know that role". It knew four tracks and nothing about
 * what a job actually is. That matters in both directions: a role it has never
 * heard of is invisible to matching, and a role it recognises badly is
 * misrouted.
 *
 * ── What each entry carries, and why ───────────────────────────────────────
 *
 * `definition` is not decoration. "Data Engineer" is close enough to "Data
 * Scientist" and "Data Analyst" that a matcher reading only the title will
 * confidently send the wrong things. Stating what the role *is* lets a candidate
 * see whether Jobby understood the job, and lets a correction land somewhere.
 *
 * `supersedes` is the same honesty for displacement. Several of these roles
 * exist because they replaced something: a data engineer takes work a data entry
 * clerk used to do. Recording that is what lets Jobby tell a candidate their
 * background maps onto a newer role — which is the single most useful thing it
 * can say to someone whose title has been phased out.
 *
 * `signals` are drawn from what resumes actually contain, not from job-posting
 * boilerplate. A posting says "AI Engineer"; a resume says "built RAG pipelines
 * on Bedrock, owned evaluation". Matching the former finds noise; the latter
 * finds the person.
 *
 * `notableFor` is separate from signals on purpose: it is context worth showing a
 * candidate, not a filter that decides whether they are a fit.
 *
 * ── The trades half ────────────────────────────────────────────────────────
 *
 * Lives in titles-trades.mjs and is merged in here, because a matcher that knows
 * about "AI Engineer" and has never heard of "welder" is not a library — it is a
 * library for one kind of person. The trades vocabulary is genuinely different in
 * kind (tasks, tickets and jurisdictions rather than tooling), so it is authored
 * separately and merged at the bottom. Both halves are searched together; see
 * matchTitles below.
 */

// Merged at the end of the file; declared here so the JSDoc above can mention it.
import { TRADE_TITLES, TRADE_FAMILIES, TICKET_SYSTEMS, TICKET_SIGNALS } from './titles-trades.mjs';
import { PROFESSION_TITLES, PROFESSION_FAMILIES, CERTIFYING_BODY } from './titles-professions.mjs';

/**
 * @typedef {object} KnownTitle
 * @property {string} id
 * @property {string} name
 * @property {string} family       grouping for display and for narrowing a search
 * @property {string} definition   what the role actually is
 * @property {string[]} signals    terms in a resume that indicate this role
 * @property {string[]} supersedes older roles this has taken work from
 * @property {string[]} notEqualTo roles that sound similar and are NOT this one
 * @property {string[]} notableFor what this role is usually valued for
 */

export const TITLE_FAMILIES = {
  ai_eng: 'AI engineering',
  data: 'Data',
  forward_deployed: 'Solutions engineering',
  platform: 'Platform and infrastructure',
  security: 'Security',
  product: 'Product and delivery',
};

/** @type {KnownTitle[]} */
export const KNOWN_TITLES = [
  // ── AI engineering ───────────────────────────────────────────────────────
  {
    id: 'ai_engineer',
    name: 'AI Engineer',
    family: 'ai_eng',
    definition:
      'Integrates LLM systems into existing business software, rather than building '
      + 'standalone models. The work is plumbing: retrieval, tool calls, evaluation, '
      + 'cost control, and making the thing behave predictably inside a product that '
      + 'already has users and a P&L attached to it.',
    signals: [
      'llm', 'large language model', 'rag', 'retrieval augmented', 'retrieval-augmented',
      'vector database', 'vector db', 'embeddings', 'semantic search', 'fine-tune',
      'fine tuning', 'prompt engineering', 'tool use', 'function calling',
      'agentic', 'ai agent', 'llmops', 'evaluation harness', 'evals',
      'openai', 'anthropic', 'bedrock', 'langchain', 'llamaindex', 'huggingface',
      'inference', 'ai platform', 'chat completion',
    ],
    supersedes: ['data entry', 'data entry clerk', 'data entry specialist', 'manual reporting'],
    notEqualTo: ['data scientist', 'ml engineer', 'research scientist', 'machine learning engineer'],
    notableFor:
      'These roles integrate LLMs into business frameworks that already exist — the '
      + 'scarce skill is shipping an LLM feature inside a real product, not training a model.',
  },
  {
    id: 'ai_product_engineer',
    name: 'AI Product Engineer',
    family: 'ai_eng',
    definition:
      'Ships AI features end to end with product sense attached: decides what the user '
      + 'actually needs from the model, then builds it. Closer to a product engineer '
      + 'than to an ML engineer, and expects interface judgement, not model training.',
    signals: [
      'ai product', 'ai-powered product', 'product engineer', 'ai ux', 'prompt design',
      'ai feature', 'llm feature', 'chat interface', 'human in the loop', 'ai safety',
    ],
    supersedes: [],
    notEqualTo: ['product manager', 'data scientist'],
    notableFor: 'Wants someone who can decide what to build, not only someone who can build it.',
  },
  {
    id: 'mlops_engineer',
    name: 'MLOps Engineer',
    family: 'ai_eng',
    definition:
      'Runs models in production: deployment, monitoring, retraining pipelines, cost '
      + 'and latency budgets, and the rollback story when a model starts behaving badly.',
    signals: [
      'mlops', 'model deployment', 'model serving', 'feature store', 'model registry',
      'kubeflow', 'mlflow', 'drift detection', 'model monitoring', 'canary deploy',
      'inference endpoint', 'gpu scheduling', 'training pipeline',
    ],
    supersedes: [],
    notEqualTo: ['devops engineer', 'data engineer'],
    notableFor: 'Owns whether the model keeps working after launch, which is most of the job.',
  },

  // ── Data ─────────────────────────────────────────────────────────────────
  {
    id: 'data_engineer',
    name: 'Data Engineer',
    family: 'data',
    definition:
      'Builds and owns the pipelines, warehouses and contracts that data is moved and '
      + 'trusted through. Increasingly the schema, the quality checks, and the '
      + 'guarantee that a number means the same thing to everyone.',
    signals: [
      'data engineering', 'etl', 'elt', 'data pipeline', 'data warehouse', 'snowflake',
      'bigquery', 'redshift', 'databricks', 'airflow', 'dbt', 'dagster', 'prefect',
      'spark', 'kafka', 'pub/sub', 'data ingestion', 'data modeling', 'dimensional model',
      'star schema', 'data quality', 'data contract', 'batch pipeline', 'streaming pipeline',
      'change data capture', 'cdc',
    ],
    supersedes: ['data entry', 'data entry clerk', 'data entry specialist', 'report writer', 'etl developer'],
    notEqualTo: ['data analyst', 'data scientist', 'business intelligence analyst'],
    notableFor:
      'Has taken over work data entry specialists used to do — moving, validating and '
      + 'publishing data is now an engineering problem with tooling, not a clerical one.',
  },
  {
    id: 'analytics_engineer',
    name: 'Analytics Engineer',
    family: 'data',
    definition:
      'The dbt-shaped middle ground between analyst and engineer: models the metrics so '
      + 'the numbers are defined once and reused, rather than each analyst rebuilding '
      + 'their own version.',
    signals: [
      'analytics engineer', 'dbt', 'semantic layer', 'metrics layer', 'metricflow',
      'cube', 'looker', 'transformations', 'test coverage', 'data tests',
    ],
    supersedes: ['report writer', 'excel reporting'],
    notEqualTo: ['data analyst', 'data engineer'],
    notableFor: 'Frequent path out of a BI or reporting role into engineering.',
  },
  {
    id: 'data_architect',
    name: 'Data Architect',
    family: 'data',
    definition:
      'Decides how data is shaped and governed across an organisation: the model, the '
      + 'ownership, the lineage, and what may be joined to what.',
    signals: [
      'data architect', 'data strategy', 'data governance', 'data catalog', 'lineage',
      'master data management', 'mdm', 'data mesh', 'information architecture',
    ],
    supersedes: [],
    notEqualTo: ['solutions architect', 'enterprise architect'],
    notableFor: 'Decides the conventions everyone else then has to live inside.',
  },

  // ── Solutions / forward deployed ─────────────────────────────────────────
  {
    id: 'forward_deployed_engineer',
    name: 'Forward-Deployed Engineer',
    family: 'forward_deployed',
    definition:
      'An engineer embedded with the customer, on their problem rather than on a '
      + 'backlog. Ship working software inside someone else’s environment, learn the '
      + 'business while building, and treat the deployment as the deliverable. Origin '
      + 'in defence and defence-tech, now common in AI and data companies.',
    signals: [
      'forward deployed', 'forward-deployed', 'forward deployed engineer', 'fde',
      'embedded engineer', 'customer engineer', 'deployment engineer', 'field engineer',
      'on-site engineer', 'onsite engineer', 'palantir', 'customer-facing engineer',
      'mission team', 'expeditionary',
    ],
    supersedes: ['solutions consultant', 'pre-sales engineer', 'technical consultant'],
    notEqualTo: ['solutions architect', 'implementation consultant', 'field service engineer'],
    notableFor:
      'One of the more unusual jobs worth knowing about: deliberately hybrid, sits '
      + 'between engineering and the customer, and is usually a fast path to scope and '
      + 'ownership that a pure engineering role does not offer.',
  },
  {
    id: 'solutions_engineer',
    name: 'Solutions Engineer',
    family: 'forward_deployed',
    definition:
      'Translates between the product and the buyer’s problem — demos, proofs of '
      + 'concept, integration design. Usually commercial-adjacent and pre-revenue.',
    signals: [
      'solutions engineer', 'solutions engineering', 'pre-sales', 'presales',
      'proof of concept', 'poc', 'demo engineering', 'technical sales', 'rfp',
      'solution architect',
    ],
    supersedes: [],
    notEqualTo: ['forward deployed engineer', 'sales engineer'],
    notableFor: 'Distinct from an FDE: SE leans pre-deal, FDE leans post-deal delivery.',
  },
  {
    id: 'implementation_engineer',
    name: 'Implementation Engineer',
    family: 'forward_deployed',
    definition:
      'Carries a signed deal into a working installation: configuration, data migration, '
      + 'integration, and the first weeks of the customer actually using it.',
    signals: [
      'implementation engineer', 'implementation consultant', 'deployment consultant',
      'onboarding engineer', 'professional services engineer', 'implementation consultant',
    ],
    supersedes: [],
    notEqualTo: ['solutions engineer', 'forward deployed engineer'],
    notableFor: 'Close cousin of an FDE; usually on a customer’s existing stack.',
  },

  // ── Platform ─────────────────────────────────────────────────────────────
  {
    id: 'platform_engineer',
    name: 'Platform Engineer',
    family: 'platform',
    definition:
      'Builds the paved road other engineers run on: CI/CD, environments, observability, '
      + 'and the self-service tooling that stops every team hand-rolling deploys.',
    signals: [
      'platform engineering', 'developer platform', 'internal developer platform', 'idp',
      'golden path', 'developer experience', 'devex', 'ci/cd', 'terraform', 'kubernetes',
      'infrastructure as code', 'build system', 'self-service infrastructure',
    ],
    supersedes: ['devops engineer', 'build engineer', 'release engineer'],
    notEqualTo: ['site reliability engineer', 'devops engineer', 'cloud architect'],
    notableFor: 'The modern name for much of what was called a DevOps role, with more product intent.',
  },
  {
    id: 'sre',
    name: 'Site Reliability Engineer',
    family: 'platform',
    definition:
      'Owns production behaviour: reliability targets, on-call, incident response, and '
      + 'the toil reduction that keeps a team able to keep doing this.',
    signals: [
      'site reliability', 'sre', 'reliability engineering', 'on-call', 'incident response',
      'postmortem', 'error budget', 'slo', 'slos', 'observability', 'uptime',
      'toil reduction', 'chaos engineering',
    ],
    supersedes: [],
    notEqualTo: ['platform engineer', 'devops engineer'],
    notableFor: 'Engineering role with a service obligation attached, and it is respected as one.',
  },

  // ── Security ─────────────────────────────────────────────────────────────
  {
    id: 'application_security_engineer',
    name: 'Application Security Engineer',
    family: 'security',
    definition:
      'Security inside the development loop: threat modelling, secure design review, '
      + 'SAST/DAST, and fixing findings in the code rather than in a report.',
    signals: [
      'application security', 'appsec', 'secure code review', 'threat model', 'threat modelling',
      'sast', 'dast', 'static analysis', 'appsec pipeline', 'security champions',
      'owasp', 'code audit',
    ],
    supersedes: [],
    notEqualTo: ['security operations analyst', 'security researcher'],
    notableFor: 'Has absorbed part of what pen-testing and audit used to cover.',
  },

  // ── Product ──────────────────────────────────────────────────────────────
  {
    id: 'product_manager',
    name: 'Product Manager',
    family: 'product',
    definition:
      'Decides what gets built and why, holds the prioritisation, and is accountable '
      + 'for the outcome rather than the output.',
    signals: [
      'product management', 'product roadmap', 'prioritisation', 'prioritization', 'prd',
      'user research', 'discovery', 'product strategy', 'okrs', 'north star metric',
      'stakeholder management',
    ],
    supersedes: [],
    notEqualTo: ['project manager', 'product owner'],
    notableFor: 'Frequently paired with an FDE on AI teams, because the model’s behaviour is not specifiable up front.',
  },
];

/** Fast lookup by id. */
const BY_ID = new Map(KNOWN_TITLES.map((t) => [t.id, t]));

/**
 * Merge the trades half in.
 *
 * Two exports of the same name from two modules is the one genuinely awkward bit
 * here, so the merge is done once, explicitly, rather than having two KNOWN_TITLES
 * and no way to tell which one a caller got. Everything downstream reads the
 * merged list, so a trades title and an AI title are matched by the same code and
 * scored on the same scale — which matters, because a candidate is usually
 * somewhere between the two.
 */
export const ALL_TITLES = [...KNOWN_TITLES, ...TRADE_TITLES, ...PROFESSION_TITLES];
export const ALL_FAMILIES = {
  ...TITLE_FAMILIES, ...TRADE_FAMILIES, ...PROFESSION_FAMILIES,
};

for (const t of TRADE_TITLES) BY_ID.set(t.id, t);
for (const t of PROFESSION_TITLES) BY_ID.set(t.id, t);

export function knownTitle(id) {
  return BY_ID.get(String(id || '').toLowerCase()) || null;
}

// Re-exported so callers have one import for the whole library. Without these the
// trades were merged in but unreachable by name, which is how a merged list ends
// up decorative.
export { TRADE_TITLES, TRADE_FAMILIES, TICKET_SYSTEMS, TICKET_SIGNALS };
export { PROFESSION_TITLES, PROFESSION_FAMILIES, CERTIFYING_BODY };

/** Every signal in one list, for building a single regex. */
export function allTitleSignals() {
  const out = [];
  const seen = new Set();
  for (const t of ALL_TITLES) {
    for (const s of t.signals) {
      if (!seen.has(s)) { seen.add(s); out.push(s); }
    }
  }
  return out;
}

/**
 * Which tickets the text evidences, independent of any title.
 *
 * Worth exposing separately because the ticket is often the thing that decides
 * whether someone can be hired, and a resume states it plainly ("Red Seal
 * Journeyperson") without the surrounding words ever naming a job title we
 * recognise. Matching on the ticket alone tells you more about eligibility than
 * matching on the title does.
 */
export function detectTickets(text) {
  const blob = String(text || '');
  if (!blob.trim()) return [];
  const found = [];
  for (const probe of TICKET_SIGNALS) {
    const m = probe.re.exec(blob);
    if (!m) continue;
    const sys = TICKET_SYSTEMS[probe.ticket];
    found.push({
      ticket: probe.ticket,
      label: sys?.label || probe.ticket,
      where: sys?.where || null,
      gates: sys?.gates || null,
      evidence: m[0].trim(),
    });
  }
  return found;
}

/**
 * Match a free-text blob (a resume, a posting, a candidate's answer) to known titles.
 *
 * Returns every title with at least one signal hit, strongest first, each with the
 * evidence — the phrase that matched, not a bare score. A candidate asked "why do
 * you think I'm a data engineer?" deserves to be shown the words, and so does
 * anyone auditing the decision.
 */
export function matchTitles(text, { limit = 6 } = {}) {
  const blob = String(text || '');
  if (!blob.trim()) return [];
  const haystack = ` ${blob.toLowerCase().replace(/\s+/g, ' ')} `;

  const results = [];
  // ALL_TITLES, not KNOWN_TITLES: the trades have to be searchable by the same
  // code as everything else, or the merged list is cosmetic.
  for (const title of ALL_TITLES) {
    const hits = [];
    for (const sig of title.signals) {
      // Word-boundary-ish on each side so "poc" does not match inside "pocket".
      const needle = sig.toLowerCase();
      const re = new RegExp(`(^|[^a-z0-9])${escapeRe(needle)}([^a-z0-9]|$)`, 'i');
      const m = re.exec(haystack);
      if (m) hits.push(m[0].trim());
    }
    if (!hits.length) continue;

    // A title named outright is the strongest evidence there is.
    const namedDirectly = new RegExp(
      `(^|[^a-z0-9])${escapeRe(title.name.toLowerCase())}([^a-z0-9]|$)`, 'i'
    ).test(haystack);

    let score = Math.min(hits.length, 8) * 8;
    if (namedDirectly) score += 40;
    // A title that replaced something is likelier to be the modern fit.
    if (title.supersedes.length) score += 2;

    results.push({
      id: title.id,
      name: title.name,
      family: title.family,
      score,
      namedDirectly,
      evidence: hits.slice(0, 5),
      // Not a verdict. A resume mentioning "poc" once is not a career in
      // solution architecture, and the UI shows the evidence so the candidate
      // can say otherwise.
      confidence: namedDirectly ? 'stated' : 'inferred',
    });
  }

  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return results.slice(0, limit);
}

/**
 * Given a title someone was previously doing, what is the modern equivalent?
 *
 * This is the useful one for a candidate whose role has been phased out: the
 * honest answer is "here is the title that absorbed this work, and here is what
 * you would need to show". Nothing is asserted as fact — the mapping comes from
 * each entry's own `supersedes` list, so it cannot drift from the definitions.
 */
export function modernEquivalent(previousTitle) {
  const needle = String(previousTitle || '').toLowerCase().trim();
  if (!needle) return [];
  return ALL_TITLES
    .filter((t) => (t.supersedes || []).some((s) => {
      const k = s.toLowerCase();
      return needle === k || needle.includes(k) || k.includes(needle);
    }))
    .map((t) => ({
      id: t.id,
      name: t.name,
      definition: t.definition,
      superseded: t.supersedes.filter((s) => needle.includes(s.toLowerCase())),
      // What a resume should show to be credible in the new title.
      showsFor: t.signals.slice(0, 6),
    }));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  KNOWN_TITLES, TITLE_FAMILIES, ALL_TITLES, ALL_FAMILIES,
  TRADE_TITLES, TRADE_FAMILIES, TICKET_SYSTEMS,
  knownTitle, allTitleSignals, matchTitles, modernEquivalent, detectTickets,
};
