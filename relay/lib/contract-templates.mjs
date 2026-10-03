/**
 * relay/lib/contract-templates.mjs — non-PFP documents.
 *
 * WHY THIS EXISTS
 * ---------------
 * The only contract renderer this project had was a Party Favor Photo renderer:
 * its logo, its red rule, its title, its eleven booth inclusions, its hourly
 * rates and its governing law. An agent asked to draft a consulting agreement had
 * exactly one thing it could produce, and producing it would have asserted a
 * photo-booth price list on a document about something else.
 *
 * So the document TYPE is data here, and the type is chosen by the caller. A
 * consulting agreement is not "the PFP contract with the logo removed" - it has
 * different sections, different money terms and no inclusions list at all.
 *
 * WHAT A GENERIC DOCUMENT WILL NOT DO
 * ----------------------------------
 * It carries no branding unless branding is passed in. No logo, no business name
 * in a title, no rates, no inclusions, no deposit schedule. Those belong to PFP's
 * template and travel with it. `branding: false` is the default, and a document
 * generated without a provider produces a blank on the signature line rather than
 * a plausible-looking company.
 *
 * The governing law is required even here. An agreement with no jurisdiction is
 * the one thing that reliably causes a dispute, so it is asked for rather than
 * defaulted - which is the opposite of the PFP template's original defect, where
 * District of Columbia was a literal and silently applied to whoever came next.
 */

/** The clauses every commercial agreement needs, in the order they belong. */
const STANDARD_CLAUSES = Object.freeze([
  {
    key: 'services',
    title: 'Services',
    required: true,
    prompt: 'What work is the provider actually doing? Be specific enough that a reader knows when it is done.',
    body: (v) =>
      `The Provider will perform the following services for the Client: ${v.services}. ` +
      `Where the parties have agreed a scope, schedule or deliverable schedule, that scope ` +
      `is incorporated into this Agreement and governs over any description here.`,
  },
  {
    key: 'term',
    title: 'Term',
    required: true,
    prompt: 'When does this start and when does it end?',
    body: (v) =>
      `This Agreement begins on ${v.effective_date} and continues until ` +
      `${v.term_end || 'terminated in accordance with this Agreement'}.`,
  },
  {
    key: 'fees',
    title: 'Fees and Payment',
    required: true,
    prompt: 'What is being charged, and when is it due? State a total or a rate - a fee clause with no number in it is not a fee clause.',
    body: (v) =>
      `The Client will pay the Provider ${v.fees_summary}. ` +
      (v.payment_terms
        ? `Payment terms: ${v.payment_terms}`
        : `Payment is due within ${v.payment_days ?? 30} days of invoice.`) +
      ` Amounts not paid when due accrue interest at the lesser of 1.5% per month ` +
      `or the maximum permitted by law.`,
  },
  {
    key: 'expenses',
    title: 'Expenses',
    required: false,
    prompt: 'Who pays for travel, materials, third-party costs?',
    body: (v) =>
      v.expenses_reimbursed
        ? `The Client will reimburse the Provider for reasonable, pre-approved out-of-pocket ` +
          `expenses incurred in performing the services, at cost and upon production of receipts.`
        : `Expenses are the Provider's responsibility unless the Client agrees in writing ` +
          `in advance to reimburse a specific cost.`,
  },
  {
    key: 'confidentiality',
    title: 'Confidentiality',
    required: true,
    prompt: 'Is there anything the provider must keep confidential? Default text covers information received in the course of the engagement.',
    body: (v) =>
      `Each party will keep confidential all non-public information it receives from the ` +
      `other in connection with this Agreement and will use it only to perform its obligations ` +
      `hereunder. This obligation survives termination by ` +
      `${v.confidentiality_years ?? 3} years.`,
  },
  {
    key: 'ip',
    title: 'Intellectual Property',
    required: false,
    prompt: 'Who owns the work product? This is the clause that gets argued about, so it should be deliberate.',
    body: (v) =>
      v.ip_client
        ? `All work product created by the Provider specifically for the Client under this ` +
          `Agreement is assigned to the Client upon full payment. The Provider retains ` +
          `ownership of its pre-existing materials, methods and know-how.`
        : `The Provider retains all rights in its pre-existing and generic materials, ` +
          `including templates, tools and know-how. Work product created specifically for the ` +
          `Client is licensed to the Client for its internal business use upon full payment.`,
  },
  {
    key: 'warranties',
    title: 'Warranties',
    required: true,
    prompt: 'Any warranty carve-outs or limitations?',
    body: (v) =>
      `Each party warrants that it has authority to enter into this Agreement. The Provider ` +
      `warrants that its services will be performed with reasonable skill and care. ` +
      (v.warranty_disclaimer !== false
        ? `Except as stated here, the Provider gives no other warranty, express or implied, ` +
          `including any implied warranty of merchantability or fitness for a particular purpose.`
        : ``),
  },
  {
    key: 'liability',
    title: 'Limitation of Liability',
    required: true,
    prompt: 'Is there a liability cap? A cap that does not exist is worse than a low one, because it leaves unlimited exposure.',
    body: (v) =>
      `Neither party is liable for indirect, incidental, special, consequential or punitive ` +
      `damages, or for lost profits or lost business, however caused. ` +
      (v.liability_cap
        ? `Each party's total liability under this Agreement is limited to ${v.liability_cap}.`
        : `Each party's total liability under this Agreement is limited to the total fees ` +
          `paid by the Client in the twelve months preceding the claim.`) +
      ` Nothing in this Agreement excludes liability that cannot lawfully be excluded.`,
  },
  {
    key: 'termination',
    title: 'Termination',
    required: true,
    prompt: 'How does either party exit, and on what notice?',
    body: (v) =>
      `Either party may terminate this Agreement on ${v.termination_notice || 30} days' written ` +
      `notice to the other. Either party may terminate immediately if the other materially ` +
      `breaches and fails to cure within ${v.cure_days ?? 14} days of notice. ` +
      `The Client will pay for services performed and expenses incurred through the date of ` +
      `termination.`,
  },
  {
    key: 'dispute',
    title: 'Dispute Resolution and Governing Law',
    required: true,
    prompt: 'Which jurisdiction governs, and is there arbitration or mediation first?',
    body: (v) =>
      `This Agreement is governed by the laws of ${v.governing_law}, without regard to its ` +
      `conflict of laws principles. ` +
      (v.arbitration_required
        ? `Any dispute arising out of or relating to this Agreement that cannot be resolved by ` +
          `good-faith discussion within 30 days will be finally settled by binding arbitration ` +
          `in ${v.arbitration_venue || v.governing_law}.`
        : `The parties will attempt to resolve any dispute by good-faith discussion before ` +
          `pursuing litigation. Either party may seek injunctive relief at any time.`),
  },
  {
    key: 'general',
    title: 'General',
    required: true,
    prompt: null,
    body: () =>
      `This Agreement is the entire agreement between the parties and supersedes all prior ` +
      `discussions. Amendments must be in writing and signed by both parties. Neither party may ` +
      `assign this Agreement without the other's written consent, except to a successor in ` +
      `a merger or sale of substantially all assets. If any provision is held unenforceable, ` +
      `the remainder continues in effect. Neither party has assigned its rights under this ` +
      `Agreement. This Agreement may be executed in counterparts and by electronic signature.`,
  },
  {
    key: 'acceptance',
    title: 'Acceptance',
    required: true,
    prompt: null,
    body: () =>
      `By signing below, each party confirms it has read this Agreement, understands its terms, ` +
      `and has authority to bind itself.`,
  },
]);

/**
 * The document types available.
 *
 * A type is a shape, not a template file: it selects clauses, requires the fields
 * those clauses need, and decides whether branding is appropriate. Adding a type
 * means describing it here, not writing a renderer.
 */
export const CONTRACT_TYPES = Object.freeze({
  consulting: Object.freeze({
    id: 'consulting',
    label: 'Consulting Agreement',
    title: 'CONSULTING AGREEMENT',
    branding_default: false,
    clauses: ['services', 'term', 'fees', 'expenses', 'confidentiality', 'ip',
              'warranties', 'liability', 'termination', 'dispute', 'general', 'acceptance'],
    // Fields the clause bodies read. Anything not supplied renders as its prompt.
    required_inputs: Object.freeze([
      'client_name', 'client_entity', 'provider_name', 'provider_entity',
      'effective_date', 'services', 'fees_summary', 'governing_law',
    ]),
  }),

  services: Object.freeze({
    id: 'services',
    label: 'Services Agreement',
    title: 'SERVICES AGREEMENT',
    branding_default: false,
    clauses: ['services', 'term', 'fees', 'expenses', 'confidentiality', 'warranties',
              'liability', 'termination', 'dispute', 'general', 'acceptance'],
    required_inputs: Object.freeze([
      'client_name', 'client_entity', 'provider_name', 'provider_entity',
      'effective_date', 'services', 'fees_summary', 'governing_law',
    ]),
  }),

  nda: Object.freeze({
    id: 'nda',
    label: 'Mutual Non-Disclosure Agreement',
    title: 'MUTUAL NON-DISCLOSURE AGREEMENT',
    branding_default: false,
    clauses: ['term', 'confidentiality', 'ip', 'liability', 'dispute', 'general', 'acceptance'],
    required_inputs: Object.freeze([
      'client_name', 'client_entity', 'provider_name', 'provider_entity',
      'effective_date', 'governing_law',
    ]),
  }),

  freelance: Object.freeze({
    id: 'freelance',
    label: 'Freelance / Independent Contractor Agreement',
    title: 'INDEPENDENT CONTRACTOR AGREEMENT',
    branding_default: false,
    clauses: ['services', 'term', 'fees', 'expenses', 'confidentiality', 'ip',
              'warranties', 'liability', 'termination', 'dispute', 'general', 'acceptance'],
    required_inputs: Object.freeze([
      'client_name', 'client_entity', 'provider_name', 'provider_entity',
      'effective_date', 'services', 'fees_summary', 'governing_law',
    ]),
  }),

  sow: Object.freeze({
    id: 'sow',
    label: 'Statement of Work',
    title: 'STATEMENT OF WORK',
    branding_default: false,
    clauses: ['services', 'fees', 'term', 'general', 'acceptance'],
    required_inputs: Object.freeze([
      'client_name', 'client_entity', 'provider_name', 'provider_entity',
      'effective_date', 'services', 'fees_summary',
    ]),
    // An SOW hangs off a master agreement; saying so is better than implying it
    // is standalone.
    note:
      'A Statement of Work normally sits beneath a master services agreement. If there is ' +
      'no master agreement in force, this document stands alone and should say so.',
  }),

  /** Reference to PFP's own templated booth contract. Not a generic type. */
  pfp_booth: Object.freeze({
    id: 'pfp_booth',
    label: 'Party Favor Photo - StudioStation booking',
    title: null,           // rendered by the PFP renderer, which owns its own header
    branding_default: true,
    use_renderer: 'pfp',  // routes to pfp-contract-pdf.mjs
    note: 'Priced from the PFP catalogue. See pfp-pricing.mjs.',
  }),
});

/**
 * Work out what a document needs and cannot get.
 *
 * Reports every gap at once rather than one per round trip, and never supplies a
 * default for a required input - a consulting agreement with a guessed
 * jurisdiction and a made-up fee is worse than no agreement.
 *
 * @param {string} typeId
 * @param {object} input
 * @returns {{type, missing, supplied, clauses, gaps}}
 */
export function planGenericContract(typeId, input = {}) {
  const type = CONTRACT_TYPES[typeId];
  if (!type) {
    throw new Error(
      `unknown contract type "${typeId}". Available: ${Object.keys(CONTRACT_TYPES).join(', ')}`
    );
  }
  if (type.use_renderer === 'pfp') {
    throw new Error(
      `"${typeId}" is rendered by the PFP contract renderer, not the generic one. ` +
        `Call renderContract() in pfp-contract-pdf.mjs for that type.`
    );
  }

  const gaps = [];
  const ask = (key, question, why) => gaps.push({ key, question, why });

  for (const key of type.required_inputs) {
    const v = input[key];
    if (v === undefined || v === null || String(v).trim() === '') {
      ask(key, PROMPT_FOR[key] || `What is the ${key.replace(/_/g, ' ')}?`,
          `${type.label} requires it`);
    }
  }

  const clauses = type.clauses.map((key) => {
    const c = STANDARD_CLAUSES.find((x) => x.key === key);
    return { key, title: c.title, required: c.required, prompt: c.prompt, missing: !input[key] && c.required };
  });

  return {
    type,
    missing: gaps,
    supplied: Object.keys(input).filter((k) => input[k] !== undefined && input[k] !== null),
    clauses,
    complete: gaps.length === 0,
  };
}

/** Human questions, not field names. */
const PROMPT_FOR = Object.freeze({
  client_name: 'Who is the client? A full name, or the person signing.',
  client_entity: 'What is the client\'s legal entity? The name on the contract, not a trading name.',
  provider_name: 'Who is the provider? The person signing.',
  provider_entity: 'What is the provider\'s legal entity?',
  effective_date: 'What date does this agreement take effect?',
  services: 'What work is being done? Specific enough to know when it is finished.',
  fees_summary: 'What is the fee? A total, or a rate with its basis.',
  governing_law: 'Which jurisdiction governs? This is asked, never defaulted - an agreement with no jurisdiction is the one thing that reliably causes a dispute.',
  payment_terms: 'When is payment due?',
  liability_cap: 'Is there a liability cap?',
  ip_client: 'Does the client own the work product outright, or take a licence?',
  arbitration_required: 'Arbitration, or court? If arbitration, where?',
});

export { STANDARD_CLAUSES };
export default { CONTRACT_TYPES, planGenericContract, STANDARD_CLAUSES };