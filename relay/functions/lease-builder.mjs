#!/usr/bin/env node
/**
 * ef:lease-builder — Local edge function for Elze Contract Writer™
 *
 * Generates commercial real estate lease documents from structured input.
 * Provides a clause library with VA-compliant defaults, template engine,
 * and compliance pre-check using the lease-analyzer rule IDs (CL-xxx).
 *
 * Usage via relay:
 *   edge-function { "function": "lease-builder", "args": { "action": "build", ... } }
 */

const META = {
  description: 'Build commercial real estate lease documents from structured input. Clause library with VA-compliant defaults, compliance pre-check, and multi-format export.',
  category: 'legal',
  version: '1.0.0',
  author: 'hermes-agent',
  dependencies: ['lease-analyzer'],
};

// ── Clause Library ──────────────────────────────────────────
// Each clause has: id, name, category, defaultText (VA-compliant),
// statuteRef, severity (if violated), editable, required
const CLAUSE_LIBRARY = [
  {
    id: 'parties',
    name: 'Parties and Premises',
    category: 'core',
    required: true,
    editable: true,
    statuteRef: null,
    defaultText: `THIS LEASE AGREEMENT (the "Lease") is made and entered into as of {{effectiveDate}}, by and between {{landlordName}} ("Landlord") and {{tenantName}} ("Tenant").

PREMISES. Landlord hereby leases to Tenant and Tenant hereby leases from Landlord approximately {{premisesSF}} rentable square feet of {{premisesType}} space located at {{premisesAddress}} (the "Premises"), within the building commonly known as {{buildingName}} (the "Building").`,
  },
  {
    id: 'term',
    name: 'Lease Term',
    category: 'core',
    required: true,
    editable: true,
    statuteRef: null,
    defaultText: `TERM. The initial term of this Lease shall be {{leaseTermYears}} year(s) commencing on {{commencementDate}} (the "Commencement Date") and expiring on {{expirationDate}} (the "Expiration Date"), unless sooner terminated in accordance with the terms hereof.`,
  },
  {
    id: 'baseRent',
    name: 'Base Rent',
    category: 'financial',
    required: true,
    editable: true,
    statuteRef: null,
    defaultText: `BASE RENT. Tenant agrees to pay annual Base Rent as follows:
   Year 1: \$` + `{{baseRentPSF}} per rentable square foot (\$` + `{{baseRentAnnual}} annually; \$` + `{{baseRentMonthly}} monthly)
   {{escalationClause}}
   Base Rent shall be paid in advance on the first day of each calendar month.`,
  },
  {
    id: 'securityDeposit',
    name: 'Security Deposit',
    category: 'financial',
    required: true,
    editable: true,
    statuteRef: '55.1-1212',
    compliance: { maxMonthsRent: 2, returnDays: 45 },
    defaultText: `SECURITY DEPOSIT. Tenant shall deposit with Landlord the sum of {{securityDepositAmount}} ({{securityDepositMonths}} months' Base Rent) as security for the faithful performance of all terms, covenants, and conditions of this Lease. Said deposit shall be returned to Tenant within forty-five (45) days after the Expiration Date or earlier termination, less any sums applied to damages.`,
  },
  {
    id: 'lateFee',
    name: 'Late Payment Fee',
    category: 'financial',
    required: false,
    editable: true,
    statuteRef: '55.1-1214',
    compliance: { maxPercent: 10, graceDays: 5 },
    defaultText: `LATE PAYMENT. If any installment of Base Rent or additional rent is not received by Landlord within five (5) days after the date due, Tenant shall pay a late fee equal to ten percent (10%) of the delinquent amount. Said late fee shall be in addition to the delinquent rent and shall not constitute a waiver of any other remedy available to Landlord.`,
  },
  {
    id: 'cam',
    name: 'Common Area Maintenance (CAM)',
    category: 'financial',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `COMMON AREA MAINTENANCE (CAM). Tenant shall pay Tenant's Pro Rata Share ({{proRataShare}}%) of all Operating Expenses, including but not limited to: landscaping, parking lot maintenance, snow removal, utilities for common areas (separately metered where applicable; any tenant-specific utility charges shall be separately metered and billed directly to Tenant), property management fees (capped at 4% of gross collections), and capital improvements amortized over their useful life.`,
  },
  {
    id: 'use',
    name: 'Permitted Use',
    category: 'operational',
    required: true,
    editable: true,
    statuteRef: null,
    defaultText: `USE. The Premises shall be used solely for {{permittedUse}}. Tenant shall not use the Premises for any unlawful purpose or any use that would increase insurance premiums.`,
  },
  {
    id: 'assignment',
    name: 'Assignment and Subletting',
    category: 'operational',
    required: true,
    editable: true,
    statuteRef: null,
    defaultText: `ASSIGNMENT AND SUBLETTING. Tenant shall not assign this Lease or sublet the Premises or any part thereof without the prior written consent of Landlord, which consent shall not be unreasonably withheld, conditioned, or delayed. In the event of any assignment or sublease, Tenant shall remain fully liable for all obligations hereunder.`,
  },
  {
    id: 'insurance',
    name: 'Insurance Requirements',
    category: 'operational',
    required: true,
    editable: true,
    statuteRef: null,
    defaultText: `INSURANCE. Tenant shall maintain comprehensive general liability insurance with limits not less than $2,000,000 per occurrence, $4,000,000 aggregate, naming Landlord as additional insured. Tenant shall also maintain business interruption insurance, workers' compensation, and property insurance covering Tenant's personal property and leasehold improvements.`,
  },
  {
    id: 'indemnification',
    name: 'Indemnification',
    category: 'legal',
    required: true,
    editable: true,
    statuteRef: null,
    defaultText: `INDEMNIFICATION. Tenant agrees to indemnify, defend, and hold harmless Landlord, its members, managers, agents, and employees from and against any and all claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees) arising out of or in connection with Tenant's use and occupancy of the Premises, except to the extent caused by Landlord's gross negligence or willful misconduct.`,
  },
  {
    id: 'landlordEntry',
    name: 'Landlord Entry Rights',
    category: 'legal',
    required: true,
    editable: true,
    statuteRef: '55.1-1216',
    compliance: { minNoticeHours: 24 },
    defaultText: `LANDLORD'S ENTRY. Landlord and its agents shall have the right to enter the Premises upon twenty-four (24) hours' prior notice for the purpose of inspecting, repairing, altering, or showing the Premises for lease or sale. In the event of an emergency posing imminent danger to persons or property, Landlord may enter without prior notice.`,
  },
  {
    id: 'alterations',
    name: 'Alterations and Improvements',
    category: 'operational',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `ALTERATIONS. Tenant shall not make any alterations, additions, or improvements to the Premises without Landlord's prior written consent. All alterations shall become the property of Landlord upon installation and shall remain upon termination, unless Landlord elects otherwise.`,
  },
  {
    id: 'defaultRemedies',
    name: 'Default and Remedies',
    category: 'legal',
    required: true,
    editable: true,
    statuteRef: null,
    defaultText: `DEFAULT AND REMEDIES. In the event of any default by Tenant, Landlord may, upon thirty (30) days' written notice, terminate this Lease and re-enter the Premises. Landlord shall have a duty to mitigate damages. Tenant shall have the right to cure any non-monetary default within the notice period.`,
  },
  {
    id: 'forceMajeure',
    name: 'Force Majeure',
    category: 'legal',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `FORCE MAJEURE. Neither party shall be liable for failure to perform obligations (other than payment obligations) due to causes beyond its reasonable control, including acts of God, war, terrorism, labor disputes, pandemic, or governmental action.`,
  },
  {
    id: 'environmental',
    name: 'Environmental Compliance',
    category: 'legal',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `ENVIRONMENTAL. Tenant shall comply with all applicable environmental laws and regulations. Tenant shall indemnify Landlord for any contamination caused by Tenant's operations, including hazardous materials storage, disposal, or release.`,
  },
  {
    id: 'parking',
    name: 'Parking Rights',
    category: 'operational',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `PARKING. Tenant shall have the non-exclusive right to use {{parkingSpaces}} unreserved parking spaces in the Building's surface lot, subject to Landlord's parking rules and regulations.`,
  },
  {
    id: 'signage',
    name: 'Signage Rights',
    category: 'operational',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `SIGNAGE. Tenant shall have the right to install non-illuminated signage on the Building directory and suite entrance, subject to Landlord's sign criteria and applicable zoning laws.`,
  },
  {
    id: 'quietEnjoyment',
    name: 'Quiet Enjoyment',
    category: 'legal',
    required: true,
    editable: true,
    statuteRef: null,
    defaultText: `QUIET ENJOYMENT. Landlord covenants that Tenant shall quietly enjoy the Premises during the Term, provided Tenant pays rent and performs all covenants.`,
  },
  {
    id: 'attorneysFees',
    name: 'Attorneys\' Fees',
    category: 'legal',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `ATTORNEYS' FEES. In the event of any litigation or arbitration arising out of this Lease, the prevailing party shall be entitled to recover reasonable attorneys' fees, costs, and expenses from the non-prevailing party.`,
  },
  {
    id: 'governingLaw',
    name: 'Governing Law',
    category: 'legal',
    required: true,
    editable: true,
    statuteRef: null,
    defaultText: `GOVERNING LAW. This Lease shall be governed by and construed in accordance with the laws of the Commonwealth of Virginia, without regard to its conflicts of law principles.`,
  },
  {
    id: 'entireAgreement',
    name: 'Entire Agreement',
    category: 'legal',
    required: true,
    editable: true,
    statuteRef: null,
    defaultText: `ENTIRE AGREEMENT. This Lease contains the entire agreement between the parties and supersedes all prior negotiations, understandings, and agreements.`,
  },
  {
    id: 'renewalOption',
    name: 'Renewal Option',
    category: 'financial',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `RENEWAL OPTION. Tenant shall have the option to renew this Lease for {{renewalTermYears}} additional year(s) at {{renewalRentPSF}} per rentable square foot, provided Tenant gives Landlord written notice of its intent to renew not less than one hundred eighty (180) days prior to the Expiration Date.`,
  },
  {
    id: 'holdover',
    name: 'Holdover Tenancy',
    category: 'legal',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `HOLDOVER. If Tenant remains in possession of the Premises after the Expiration Date without Landlord's written consent, Tenant shall pay rent at one hundred fifty percent (150%) of the Base Rent in effect immediately prior to expiration, on a month-to-month basis.`,
  },
  {
    id: 'estoppel',
    name: 'Estoppel Certificate',
    category: 'legal',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `ESTOPPEL CERTIFICATE. Within fifteen (15) days of Landlord's written request, Tenant shall deliver to Landlord an estoppel certificate certifying that this Lease is in full force and effect, the amount of any prepaid rent or security deposit, and that Landlord is not in default under this Lease (or, if in default, specifying the nature thereof).`,
  },
  {
    id: 'notices',
    name: 'Notices',
    category: 'legal',
    required: true,
    editable: true,
    statuteRef: null,
    defaultText: `NOTICES. All notices under this Lease shall be in writing and delivered by certified mail, return receipt requested, or by reputable overnight courier to the parties at the addresses set forth above.`,
  },
  {
    id: 'waiver',
    name: 'Waiver',
    category: 'legal',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `WAIVER. No waiver by either party of any breach shall be deemed a waiver of any subsequent breach. No waiver shall be effective unless in writing signed by the waiving party.`,
  },
  {
    id: 'snowRemoval',
    name: 'Snow Removal',
    category: 'operational',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `SNOW REMOVAL. Landlord shall be responsible for snow and ice removal from common areas, parking lots, and walkways serving the Building. Tenant shall be responsible for snow removal at the entrance to the Premises.`,
  },
  {
    id: 'trashDisposal',
    name: 'Trash and Recycling',
    category: 'operational',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `TRASH AND RECYCLING. Tenant shall dispose of all trash and recyclables in the receptacles provided by Landlord in compliance with all applicable laws and Landlord's recycling program.`,
  },
  {
    id: 'ADA',
    name: 'ADA Compliance',
    category: 'legal',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `ADA COMPLIANCE. Landlord represents that the Building's common areas comply with the Americans with Disabilities Act (ADA). Tenant shall be responsible for ADA compliance within the Premises, including any tenant improvements.`,
  },
  {
    id: 'subordination',
    name: 'Subordination, Non-Disturbance, and Attornment',
    category: 'legal',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `SUBORDINATION. This Lease shall be subordinate to any mortgage or deed of trust encumbering the Building, provided that the holder of such mortgage executes a non-disturbance agreement protecting Tenant's rights under this Lease. Tenant shall attorn to any successor in interest to Landlord.`,
  },
  {
    id: 'rightOfFirstRefusal',
    name: 'Right of First Refusal',
    category: 'financial',
    required: false,
    editable: true,
    statuteRef: null,
    defaultText: `RIGHT OF FIRST REFUSAL. If Landlord receives a bona fide offer to purchase the Building during the Term, Tenant shall have the right of first refusal to purchase the Premises on the same terms as such offer, provided Tenant gives Landlord written notice of its intent to exercise this right within thirty (30) days of receiving notice of the offer.`,
  },
];

// ── Lease Templates ─────────────────────────────────────────
const TEMPLATES = {
  commercial_office: {
    name: 'Commercial Office Lease',
    description: 'Standard office space lease with CAM, parking, and standard protections',
    leaseType: 'commercial',
    premisesType: 'office',
    defaultClauses: ['parties', 'term', 'baseRent', 'securityDeposit', 'lateFee', 'cam', 'use', 'assignment', 'insurance', 'indemnification', 'landlordEntry', 'alterations', 'defaultRemedies', 'forceMajeure', 'parking', 'signage', 'quietEnjoyment', 'attorneysFees', 'governingLaw', 'entireAgreement', 'holdover', 'estoppel', 'notices', 'waiver', 'ADA', 'subordination'],
    defaults: {
      permittedUse: 'general office and administrative purposes',
      parkingSpaces: 10,
      proRataShare: 15.0,
      leaseTermYears: 5,
      baseRentPSF: 18.50,
      securityDepositMonths: 2,
    },
  },
  commercial_warehouse: {
    name: 'Commercial Warehouse/Industrial Lease',
    description: 'Industrial/warehouse space with environmental and snow removal clauses',
    leaseType: 'commercial',
    premisesType: 'warehouse and light industrial',
    defaultClauses: ['parties', 'term', 'baseRent', 'securityDeposit', 'lateFee', 'cam', 'use', 'assignment', 'insurance', 'indemnification', 'landlordEntry', 'alterations', 'defaultRemedies', 'forceMajeure', 'environmental', 'parking', 'signage', 'quietEnjoyment', 'attorneysFees', 'governingLaw', 'entireAgreement', 'holdover', 'estoppel', 'notices', 'snowRemoval', 'trashDisposal', 'ADA', 'subordination'],
    defaults: {
      permittedUse: 'light assembly, warehousing, and distribution',
      parkingSpaces: 15,
      proRataShare: 28.5,
      leaseTermYears: 5,
      baseRentPSF: 8.50,
      securityDepositMonths: 2,
    },
  },
  commercial_retail: {
    name: 'Commercial Retail Lease',
    description: 'Retail space lease with CAM, signage, and right of first refusal',
    leaseType: 'commercial',
    premisesType: 'retail',
    defaultClauses: ['parties', 'term', 'baseRent', 'securityDeposit', 'lateFee', 'cam', 'use', 'assignment', 'insurance', 'indemnification', 'landlordEntry', 'alterations', 'defaultRemedies', 'forceMajeure', 'parking', 'signage', 'quietEnjoyment', 'attorneysFees', 'governingLaw', 'entireAgreement', 'holdover', 'estoppel', 'notices', 'waiver', 'ADA', 'subordination', 'rightOfFirstRefusal'],
    defaults: {
      permittedUse: 'retail sales and related activities',
      parkingSpaces: 20,
      proRataShare: 12.0,
      leaseTermYears: 5,
      baseRentPSF: 24.00,
      securityDepositMonths: 2,
    },
  },
  triple_net: {
    name: 'Triple Net (NNN) Lease',
    description: 'Tenant pays all taxes, insurance, and maintenance — minimal landlord obligations',
    leaseType: 'commercial',
    premisesType: 'commercial',
    defaultClauses: ['parties', 'term', 'baseRent', 'securityDeposit', 'lateFee', 'use', 'assignment', 'insurance', 'indemnification', 'landlordEntry', 'alterations', 'defaultRemedies', 'forceMajeure', 'environmental', 'parking', 'signage', 'quietEnjoyment', 'attorneysFees', 'governingLaw', 'entireAgreement', 'holdover', 'estoppel', 'notices', 'waiver', 'ADA', 'subordination', 'rightOfFirstRefusal', 'renewalOption'],
    defaults: {
      permittedUse: 'general commercial purposes',
      parkingSpaces: 25,
      proRataShare: 100.0,
      leaseTermYears: 10,
      baseRentPSF: 12.00,
      securityDepositMonths: 1,
    },
  },
  ground_lease: {
    name: 'Ground Lease',
    description: 'Long-term land lease — tenant builds and owns improvements',
    leaseType: 'commercial',
    premisesType: 'land',
    defaultClauses: ['parties', 'term', 'baseRent', 'use', 'assignment', 'insurance', 'indemnification', 'defaultRemedies', 'forceMajeure', 'environmental', 'quietEnjoyment', 'attorneysFees', 'governingLaw', 'entireAgreement', 'holdover', 'estoppel', 'notices', 'waiver', 'subordination', 'renewalOption'],
    defaults: {
      permittedUse: 'construction and operation of improvements',
      leaseTermYears: 99,
      baseRentPSF: 1.50,
      securityDepositMonths: 1,
    },
  },
};

// ── Compliance Pre-Check ────────────────────────────────────
// Same rules as lease-analyzer but for the builder side
function compliancePreCheck(leaseData) {
  const warnings = [];

  // Security deposit: max 2 months (VA § 55.1-1212)
  if (leaseData.securityDepositMonths && leaseData.securityDepositMonths > 2) {
    warnings.push({
      severity: 'high',
      rule: 'CL-021',
      statute: '55.1-1212',
      message: `Security deposit of ${leaseData.securityDepositMonths} months exceeds VA maximum of 2 months' rent.`,
      fix: 'Reduce security deposit to 2 months or fewer.',
    });
  }

  // Late fee: max 10% (VA § 55.1-1214)
  if (leaseData.lateFeePercent && leaseData.lateFeePercent > 10) {
    warnings.push({
      severity: 'high',
      rule: 'CL-005',
      statute: '55.1-1214',
      message: `Late fee of ${leaseData.lateFeePercent}% exceeds VA maximum of 10% of monthly rent.`,
      fix: 'Reduce late fee to 10% or less.',
    });
  }

  // Late fee grace period: min 5 days
  if (leaseData.lateFeeGraceDays && leaseData.lateFeeGraceDays < 5) {
    warnings.push({
      severity: 'medium',
      rule: 'CL-005',
      statute: '55.1-1214',
      message: `Grace period of ${leaseData.lateFeeGraceDays} days is less than VA minimum of 5 days.`,
      fix: 'Increase grace period to at least 5 days.',
    });
  }

  // Landlord entry: min 24 hours notice (VA § 55.1-1216)
  if (leaseData.entryNoticeHours && leaseData.entryNoticeHours < 24) {
    warnings.push({
      severity: 'high',
      rule: 'CL-006',
      statute: '55.1-1216',
      message: `Entry notice of ${leaseData.entryNoticeHours} hours is less than VA minimum of 24 hours.`,
      fix: 'Increase entry notice to at least 24 hours.',
    });
  }

  // Self-help eviction: prohibited
  if (leaseData.selfHelpEviction) {
    warnings.push({
      severity: 'critical',
      rule: 'CL-001',
      statute: '55.1-1245',
      message: 'Self-help eviction clause (lockout without court order) is prohibited under VA law.',
      fix: 'Remove self-help eviction language and require judicial process.',
    });
  }

  // Waiver of VRLTA rights: prohibited
  if (leaseData.waiverOfRights) {
    warnings.push({
      severity: 'critical',
      rule: 'CL-003',
      statute: '55.1-1202',
      message: 'Waiver of tenant rights under VRLTA is void and unenforceable.',
      fix: 'Remove waiver of rights clause.',
    });
  }

  // No duty to mitigate
  if (leaseData.noMitigation) {
    warnings.push({
      severity: 'high',
      rule: 'CL-002',
      statute: '55.1-1251',
      message: 'No-duty-to-mitigate clause may be unenforceable. VA courts require landlord mitigation.',
      fix: 'Add duty to mitigate damages clause.',
    });
  }

  // Security deposit return: max 45 days
  if (leaseData.securityDepositReturnDays && leaseData.securityDepositReturnDays > 45) {
    warnings.push({
      severity: 'high',
      rule: 'CL-021',
      statute: '55.1-1212',
      message: `Security deposit return period of ${leaseData.securityDepositReturnDays} days exceeds VA maximum of 45 days.`,
      fix: 'Reduce return period to 45 days or less.',
    });
  }

  return warnings;
}

// ── Template Engine ─────────────────────────────────────────
function renderTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? String(vars[key]) : match;
  });
}

function formatCurrency(n) {
  if (typeof n !== 'number') return n;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildLeaseDocument(leaseData) {
  // Normalize: accept both nested {template, parties, terms, clauses} and flat input
  const normalized = {
    template: leaseData.templateId || leaseData.template || 'commercial_office',
    parties: leaseData.parties || {
      landlordName: leaseData.landlordName,
      tenantName: leaseData.tenantName,
    },
    terms: leaseData.terms || {
      premisesAddress: leaseData.premisesAddress,
      buildingName: leaseData.buildingName,
      premisesSF: leaseData.premisesSF,
      premisesType: leaseData.premisesType,
      leaseTermYears: leaseData.leaseTermYears,
      commencementDate: leaseData.commencementDate,
      expirationDate: leaseData.expirationDate,
      baseRentPSF: leaseData.baseRentPSF,
      securityDepositMonths: leaseData.securityDepositMonths,
      lateFeePct: leaseData.lateFeePct,
      graceDays: leaseData.graceDays,
      camPct: leaseData.camPct,
      parkingSpaces: leaseData.parkingSpaces,
      escalationPct: leaseData.escalationPct || leaseData.escalationRate,
      permittedUse: leaseData.permittedUse,
      renewalNoticeDays: leaseData.renewalNoticeDays,
      effectiveDate: leaseData.effectiveDate,
    },
    clauses: leaseData.clauses || leaseData.selectedClauses || null,
    customClauses: leaseData.customClauses || {},
  };

  const { template, parties, terms, clauses: selectedClauseIds, customClauses } = normalized;

  const tmpl = TEMPLATES[template] || TEMPLATES.commercial_office;
  const merged = { ...tmpl.defaults, ...terms };
  const vars = {
    ...parties,
    ...merged,
    // Computed values
    baseRentAnnual: formatCurrency((merged.baseRentPSF || 0) * (merged.premisesSF || 0)),
    baseRentMonthly: formatCurrency(((merged.baseRentPSF || 0) * (merged.premisesSF || 0)) / 12),
    securityDepositAmount: '$' + formatCurrency(((merged.baseRentPSF || 0) * (merged.premisesSF || 0)) / 12 * (merged.securityDepositMonths || 2)),
    escalationClause: merged.escalationRate || merged.escalationPct
      ? `Years 2–${merged.leaseTermYears}: $${formatCurrency(merged.baseRentPSF + (merged.escalationRate || merged.escalationPct || 0))} per rentable square foot (${(merged.escalationRate || merged.escalationPct || 0) > 0 ? '+' : ''}$${formatCurrency(merged.escalationRate || merged.escalationPct || 0)}/SF annual escalation)`
      : 'No annual escalation.',
    effectiveDate: merged.effectiveDate || 'the ___ day of __________, 20__',
    commencementDate: merged.commencementDate || '__________',
    expirationDate: merged.expirationDate || '__________',
  };

  // Build clause sections
  const sections = [];
  let clauseNumber = 1;

  // Header
  sections.push(`${tmpl.name.toUpperCase()}\n${'='.repeat(60)}\n`);

  // Add selected clauses in order
  for (const clauseId of selectedClauseIds || tmpl.defaultClauses) {
    const clause = CLAUSE_LIBRARY.find(c => c.id === clauseId);
    if (!clause) continue;

    const customText = customClauses?.[clauseId];
    const text = customText || clause.defaultText;
    const rendered = renderTemplate(text, vars);

    sections.push(`${clauseNumber}. ${clause.name.toUpperCase()}\n${rendered}\n`);
    clauseNumber++;
  }

  // Signature block
  sections.push(`\nIN WITNESS WHEREOF, the parties have executed this Lease as of the date first written above.\n`);
  sections.push(`LANDLORD:                                    TENANT:`);
  sections.push(`${parties.landlordName || '______________________'}          ${parties.tenantName || '______________________'}`);
  sections.push(`By: _______________________                  By: _______________________`);
  sections.push(`Its: Authorized Signatory                     Its: Authorized Signatory\n`);

  return sections.join('\n');
}

// ── Handler ─────────────────────────────────────────────────
export async function handler(reqOrArgs, res) {
  const args = res ? (reqOrArgs.body || reqOrArgs.query || {}) : (reqOrArgs || {});

  switch (args.action) {
    case 'templates':
      return respond(res, {
        success: true,
        templates: Object.entries(TEMPLATES).map(([key, t]) => ({
          id: key,
          name: t.name,
          description: t.description,
          leaseType: t.leaseType,
          clauseCount: t.defaultClauses.length,
          defaults: t.defaults,
        })),
      });

    case 'clauses':
      return respond(res, {
        success: true,
        clauses: CLAUSE_LIBRARY.map(c => ({
          id: c.id,
          name: c.name,
          category: c.category,
          required: c.required,
          editable: c.editable,
          statuteRef: c.statuteRef,
          compliance: c.compliance,
          defaultText: c.defaultText,
        })),
      });

    case 'precheck': {
      const warnings = compliancePreCheck(args.leaseData || {});
      return respond(res, { success: true, warnings, warningCount: warnings.length });
    }

    case 'build': {
      try {
        // Normalize: frontend may send flat data or nested leaseData
        const leaseData = args.leaseData || args;
        const document = buildLeaseDocument(leaseData);
        const warnings = compliancePreCheck(leaseData.terms || leaseData);
        return respond(res, {
          success: true,
          document,
          warnings,
          warningCount: warnings.length,
          format: args.format || 'txt',
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        return respond(res, { success: false, error: e.message });
      }
    }

    default:
      return respond(res, {
        success: true,
        actions: ['templates', 'clauses', 'precheck', 'build'],
        description: META.description,
        version: META.version,
      });
  }
}

function respond(res, data) {
  if (res) return res.json(data);
  return data;
}

export { META, CLAUSE_LIBRARY, TEMPLATES, compliancePreCheck, buildLeaseDocument };