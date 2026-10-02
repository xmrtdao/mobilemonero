#!/usr/bin/env node
/**
 * Multi-jurisdiction rule sets for ef:contract-analyzer.
 *
 * Each contributor: { state: 'DE'|'MD'|'NY'|..., rules: { docType: [rule,...] }, statutes: {...}, corrections: {...} }
 * Rules follow the VA analyzer's shape: { id, title, statute, severity, check(text)->{finding,cite}|null }.
 *
 * ⚠️ AUTHORED ONLY FROM PRIMARY-SOURCE-VERIFIED STATUTES (see Desktop/landlord-tenant-research/verified_{de,md,ny,pa,nj}.md):
 *   DE: delcode.delaware.gov | MD: MD Real Prop | NY: nysenate.gov (GOL 7-103) | PA: 68 P.S. 250.511a/.512 | NJ: N.J.S.A. 46:8-19/21.1/21.2
 * All 5 states verified 2026-08-29 (PA/NJ via Firecrawl REST API → official/Justia statute text).
 */

// ── Utility: shared lease-vulnerability regexes (mirror VA base) ──────────────
const rx = {
  selfHelp: /re[-\s]?enter|take possession without (?:a )?court|court order not|self[-\s]?help|lock\s?out|change the locks|remove.*tenant['’]?s (?:possessions|belongings)|disconnect.*utilit/i,
  confession: /confess.*judgment|warrant of attorney|judgment by confession|authoriz\w* any person to confess/i,
  negligenceWaive: /waive.*(?:negligence|liability)|release.*landlord.*(?:from|of).*liab|exculpat|not liable for.*(?:injur|damage|neglig)|hold.*harmless.*landlord/i,
  noMitigation: /no (?:duty|obligation).*mitigat|shall not.*mitigat|without (?:duty|obligation).*mitigat|landlord (?:shall )?not (?:be )?(?:obligated|required).*re-?let/i,
  depositExcess: /security deposit.*(?:in excess|greater than|exceeds|more than)|deposit.*exceed/i,
  lateFee: /late fee|late charge|delinquen.*fee|overdue.*fee/i,
  entry: /entry.*notice|landlord.*(?:enter|access|inspect)|right to enter|entry.*24|\d+\s*hours.*notice/i,
};

// ── DELAWARE ─────────────────────────────────────────────────────────────────
const DE_RESIDENTIAL_RULES = [
  { id: 'DE-RL-1', title: 'Security deposit exceeds DE cap (1 month)', statute: '25 Del. C. § 5514(a)', severity: 'high',
    check: (text) => {
      if (/security deposit[^\n.]{0,80}(?:two|2)\s*\(?\s*2?\s*\)?\s*months?['’]?\s*(?:rent|of rent|deposit)/i.test(text))
        return { finding: 'Security deposit likely exceeds Delaware cap of one month rent', cite: '25 Del. C. § 5514(a) caps at 1 month of rent' };
      if (/(?:two|2)\s*\(?\s*2?\s*\)?\s*months?['’]?\s*(?:rent|of rent|deposit).{0,80}security deposit/i.test(text))
        return { finding: 'Security deposit likely exceeds Delaware cap of one month rent', cite: '25 Del. C. § 5514(a) caps at 1 month of rent' };
      return null;
    } },
  { id: 'DE-RL-2', title: 'Security deposit not in escrow / no return timeline', statute: '25 Del. C. § 5514(b),(e)', severity: 'medium',
    check: (text) => {
      if (!/(?:escrow|bank account|returned? within|20 days|itemized list of damages)/i.test(text))
        return { finding: 'Missing DE security-deposit escrow/return provisions', cite: 'DE requires escrow account (b) and return within 20 days with itemized damages (e),(f): 25 Del. C. § 5514' };
      return null;
    } },
  { id: 'DE-RL-3', title: 'Self-help eviction', statute: '25 Del. C. § 5701-5702', severity: 'critical',
    check: (text) => rx.selfHelp.test(text)
      ? { finding: 'Self-help eviction prohibited in Delaware', cite: 'Possession only via summary possession in JP Court: 25 Del. C. § 5701-5702' } : null },
  { id: 'DE-RL-4', title: 'Confession of judgment', statute: '25 Del. C. § 5301(2)', severity: 'critical',
    check: (text) => rx.confession.test(text)
      ? { finding: 'Confession of judgment prohibited in DE rental agreements', cite: '25 Del. C. § 5301(2); 3-months-rent penalty (b)' } : null },
  { id: 'DE-RL-5', title: 'Waiver of landlord negligence', statute: '25 Del. C. § 5301(3)', severity: 'high',
    check: (text) => rx.negligenceWaive.test(text)
      ? { finding: 'Exculpation/negligence waiver prohibited in DE rental agreements', cite: '25 Del. C. § 5301(3)' } : null },
  { id: 'DE-RL-6', title: 'Entry notice short of 48 hours', statute: '25 Del. C. § 5509(b)', severity: 'medium',
    check: (text) => {
      if (/(?:less than|under)\s*48|24\s*hours['’]?\s*notice/i.test(text)) return { finding: 'Entry notice less than DE-required 48 hours', cite: '25 Del. C. § 5509(b) requires at least 48 hours notice, entry 8am-9pm' };
      if (rx.entry.test(text) && !/\d+\s*hours|\d+\s*day/i.test(text)) return { finding: 'Entry notice period unspecified; DE requires 48 hours', cite: '25 Del. C. § 5509(b)' };
      return null;
    } },
  { id: 'DE-RL-7', title: 'Nonrefundable fee charged as occupancy condition', statute: '25 Del. C. § 5311', severity: 'medium',
    check: (text) => {
      if (/non[-\s]?refundable\s*(?:fee|charge)|(?:fee|charge).*non[-\s]?refundable/i.test(text) && !/optional service|pool|tennis/i.test(text))
        return { finding: 'Nonrefundable fee as condition of occupancy — prohibited except optional service fee', cite: '25 Del. C. § 5311' };
      return null;
    } },
];

// DE COMMERCIAL: §5101(b) EXCLUDES commercial from Residential L-T Code — governed by general contract principles + Ch 57.
// Commercial still can't use self-help eviction (Ch 57 summary possession is the remedy) nor confession-of-judgment in a
// consumer/rental context; but DE does NOT impose residential deposit caps on commercial. Mirror VA commercial common-law rules.
const DE_COMMERCIAL_RULES = [
  { id: 'DE-CL-1', title: 'Commercial self-help eviction (must use Ch 57)', statute: '25 Del. C. § 5701', severity: 'high',
    check: (text) => rx.selfHelp.test(text)
      ? { finding: 'Commercial self-help eviction not permitted — use summary possession (Ch 57)', cite: '25 Del. C. § 5701' } : null },
  { id: 'DE-CL-2', title: 'Commercial confession of judgment', statute: '25 Del. C. § 5301(2)', severity: 'high',
    check: (text) => rx.confession.test(text)
      ? { finding: 'Confession of judgment in rental agreement prohibited in DE', cite: '25 Del. C. § 5301(2)' } : null },
  { id: 'DE-CL-3', title: 'Commercial negligence waiver', statute: '25 Del. C. § 5301(3)', severity: 'medium',
    check: (text) => rx.negligenceWaive.test(text)
      ? { finding: 'Exculpation clause may be unenforceable', cite: '25 Del. C. § 5301(3)' } : null },
];

// ── MARYLAND ─────────────────────────────────────────────────────────────────
const MD_RESIDENTIAL_RULES = [
  { id: 'MD-RL-1', title: 'Security deposit exceeds MD cap (2 months)', statute: 'MD Real Prop. § 8-203(b)', severity: 'critical',
    check: (text) => {
      if (/security deposit[^\n.]{0,80}(?:three|3|4|more than two)\s*\(?\s*3?\s*\)?\s*months?['’]?\s*(?:rent|of rent|deposit)/i.test(text))
        return { finding: 'Security deposit likely exceeds Maryland cap of two months rent', cite: 'MD Real Prop. § 8-203(b) caps at 2 months; excess → 3x recovery + fees' };
      if (/(?:three|3|4|more than two)\s*\(?\s*3?\s*\)?\s*months?['’]?\s*(?:rent|of rent|deposit).{0,80}security deposit/i.test(text))
        return { finding: 'Security deposit likely exceeds Maryland cap of two months rent', cite: 'MD Real Prop. § 8-203(b) caps at 2 months; excess → 3x recovery + fees' };
      return null;
    } },
  { id: 'MD-RL-2', title: 'Security deposit return without 45-day timeline', statute: 'MD Real Prop. § 8-203', severity: 'medium',
    check: (text) => {
      if (!/\b45\s*days?\b/i.test(text) && /security deposit/i.test(text))
        return { finding: 'Missing MD 45-day security-deposit return timeline / interest', cite: 'MD Real Prop. § 8-203: return within 45 days + interest at 1-yr Treasury or 1.5% after 6 months' };
      return null;
    } },
  { id: 'MD-RL-3', title: 'Self-help eviction', statute: 'MD Real Prop. § 8-401', severity: 'critical',
    check: (text) => rx.selfHelp.test(text)
      ? { finding: 'Self-help eviction prohibited in MD — repossession only via District Court', cite: 'MD Real Prop. § 8-401' } : null },
  { id: 'MD-RL-4', title: 'Missing security-deposit receipt', statute: 'MD Real Prop. § 8-203(c)', severity: 'medium',
    check: (text) => {
      if (/security deposit/i.test(text) && !/(?:receipt|written lease)/i.test(text))
        return { finding: 'MD requires receipt for security deposit included in written lease', cite: 'MD Real Prop. § 8-203(c), § 8-203.1' };
      return null;
    } },
  { id: 'MD-RL-5', title: 'Residential negligence waiver', statute: 'MD Real Prop. Title 8 / public policy', severity: 'medium',
    check: (text) => rx.negligenceWaive.test(text)
      ? { finding: 'Residential exculpation clause disfavored / may be unenforceable', cite: 'Maryland public policy (residential lease negligence waiver)' } : null },
];

// MD COMMERCIAL: Title 8 applies largely to residential; commercial governed by general contract law. Core commercial rules.
const MD_COMMERCIAL_RULES = [
  { id: 'MD-CL-1', title: 'Commercial self-help eviction', statute: 'MD Real Prop. § 8-401', severity: 'high',
    check: (text) => rx.selfHelp.test(text)
      ? { finding: 'Commercial repossession should proceed via District Court action, not self-help', cite: 'MD Real Prop. § 8-401' } : null },
  { id: 'MD-CL-2', title: 'Commercial negligence waiver', statute: 'MD general contract principles', severity: 'low',
    check: (text) => rx.negligenceWaive.test(text)
      ? { finding: 'Exculpation clause — review enforceability', cite: 'Maryland general contract law' } : null },
];

// ── NEW YORK (verified: GOL 7-103 security deposit trust) ────────────────────
const NY_RESIDENTIAL_RULES = [
  { id: 'NY-RL-1', title: 'Security deposit trust / mingling', statute: 'NY GOL § 7-103', severity: 'critical',
    check: (text) => {
      if (/security deposit/i.test(text) && !/(?:trust|shall not be mingled|separate account)/i.test(text))
        return { finding: 'NY requires security deposits held in trust, not mingled with landlord funds', cite: 'NY GOL § 7-103(1)' };
      return null;
    } },
  { id: 'NY-RL-2', title: 'Security deposit bank notification missing', statute: 'NY GOL § 7-103(2)', severity: 'medium',
    check: (text) => {
      if (/security deposit/i.test(text) && !/(?:bank.*notif|notif.*bank|name and address of the banking)/i.test(text))
        return { finding: 'NY requires written notice of the bank where the deposit is held', cite: 'NY GOL § 7-103(2)' };
      return null;
    } },
  { id: 'NY-RL-3', title: 'Self-help eviction / lockout', statute: 'NY RPAPL Art 7; § 853', severity: 'critical',
    check: (text) => rx.selfHelp.test(text)
      ? { finding: 'Self-help eviction prohibited in NY (treble damages for lockout)', cite: 'NY RPAPL § 853, Art 7' } : null },
  { id: 'NY-RL-4', title: 'Residential negligence waiver', statute: 'NY GOL § 5-321', severity: 'high',
    check: (text) => rx.negligenceWaive.test(text)
      ? { finding: 'Lease clause exempting landlord from own negligence is void in NY', cite: 'NY GOL § 5-321 (residential + commercial)' } : null },
];

// NY COMMERCIAL: GOL 5-321 negligence-waiver applies to commercial too; commercial leases get no HSTPA res cap.
const NY_COMMERCIAL_RULES = [
  { id: 'NY-CL-1', title: 'Commercial negligence waiver (void)', statute: 'NY GOL § 5-321', severity: 'high',
    check: (text) => rx.negligenceWaive.test(text)
      ? { finding: 'Clause exempting landlord from its own negligence is void in NY (residential AND commercial)', cite: 'NY GOL § 5-321' } : null },
  { id: 'NY-CL-2', title: 'Commercial self-help eviction', statute: 'NY RPAPL Art 7', severity: 'high',
    check: (text) => rx.selfHelp.test(text)
      ? { finding: 'Commercial eviction via summary proceeding (RPAPL Art 7), not self-help', cite: 'NY RPAPL Art 7' } : null },
];



// ── Per-state CORRECTIONS (suggested-fix text for redline) ──────────────────
// Format matches VA CORRECTIONS: { clause, suggested_text, comment }.
// Keyed by rule_id. Authored ONLY from verified statute law (see verified_*.md).

const DE_CORRECTIONS = {
  'DE-RL-1': { clause: 'Security Deposit', suggested_text: 'SECURITY DEPOSIT. Tenant shall pay a security deposit equal to one (1) month\'s rent, to be held in an escrow account and returned within twenty (20) days after the end of the tenancy, less any itemized damages beyond normal wear and tear.', comment: 'DE cap is 1 month\'s rent (25 Del. C. § 5514(a)); return within 20 days with itemized damages. If Landlord withholds without itemizing, Tenant may recover the amount wrongfully withheld and Landlord is liable for double the amount.' },
  'DE-RL-2': { clause: 'Security Deposit', suggested_text: 'SECURITY DEPOSIT. Tenant shall pay a security deposit equal to one (1) month\'s rent, held in an escrow account in a bank or savings institution, bearing interest. Within twenty (20) days after termination, Landlord shall return the deposit plus any accrued interest and an itemized list of damages.', comment: 'DE § 5514(b) requires escrow; (e)-(f) return within 20 days with itemized damages.' },
  'DE-RL-3': { clause: 'Default and Remedies', suggested_text: 'DEFAULT AND REMEDIES. Upon any default by Tenant, Landlord may terminate this Lease and recover possession only by summary possession proceedings in the Justice of the Peace Court.', comment: 'DE forbids self-help eviction; possession via summary possession (25 Del. C. § 5701-5702).' },
  'DE-RL-4': { clause: 'Default and Remedies', suggested_text: 'DEFAULT AND REMEDIES. Upon any default by Tenant, Landlord may pursue all remedies available at law or in equity.', comment: 'Confession of judgment is void in Delaware rental agreements (25 Del. C. § 5301(2)); 3-month penalty.' },
  'DE-RL-5': { clause: 'Waiver of Negligence', suggested_text: 'INDEMNIFICATION. Tenant agrees to indemnify Landlord except to the extent caused by Landlord\'s negligence, gross negligence, or willful misconduct.', comment: 'Exculpation/negligence-waiver clauses are void in DE rental agreements (25 Del. C. § 5301(3)).' },
  'DE-RL-6': { clause: 'Landlord Entry', suggested_text: 'LANDLORD\'S ENTRY. Landlord shall provide at least forty-eight (48) hours\' notice before entering the Premises, and shall enter only between the hours of 8:00 a.m. and 9:00 p.m.', comment: 'DE requires at least 48 hours notice for entry, 8am-9pm (25 Del. C. § 5509(b)).' },
  'DE-RL-7': { clause: 'Fees', suggested_text: 'FEES. No nonrefundable fee shall be required as a condition of the tenancy.', comment: 'DE § 5311 restricts nonrefundable fees as a condition of occupancy.' },
  'DE-CL-1': { clause: 'Default and Remedies (Commercial)', suggested_text: 'DEFAULT AND REMEDIES. Upon Tenant\'s default, Landlord may recover possession through summary possession proceedings under the Delaware Code.', comment: 'Commercial repossession also runs through Ch 57 summary possession, not self-help.' },
  'DE-CL-2': { clause: 'Default and Remedies (Commercial)', suggested_text: 'DEFAULT AND REMEDIES. Landlord may pursue all legal and equitable remedies.', comment: '25 Del. C. § 5301(2) bars confession of judgment in rental agreements.' },
  'DE-CL-3': { clause: 'Indemnification (Commercial)', suggested_text: 'INDEMNIFICATION. Tenant indemnifies Landlord except for Landlord\'s gross negligence or willful misconduct.', comment: '25 Del. C. § 5301(3) bars exculpation in rental agreements.' },
};

const MD_CORRECTIONS = {
  'MD-RL-1': { clause: 'Security Deposit', suggested_text: 'SECURITY DEPOSIT. Tenant shall pay a security deposit equal to no more than two (2) months\' rent.', comment: 'MD cap is 2 months rent (Real Prop. § 8-203(b)); excess amounts are subject to 3x recovery plus fees.' },
  'MD-RL-2': { clause: 'Security Deposit', suggested_text: 'SECURITY DEPOSIT. Landlord shall return the security deposit within forty-five (45) days after the tenancy ends, with interest and an itemized list of deductions.', comment: 'MD requires return within 45 days plus interest at the annual interest rate or 1.5% after 6 months (Real Prop. § 8-203).' },
  'MD-RL-3': { clause: 'Default and Remedies', suggested_text: 'DEFAULT AND REMEDIES. Landlord shall recover possession only by action in the District Court.', comment: 'MD bars self-help repossession; must sue in District Court (Real Prop. § 8-401).' },
  'MD-RL-4': { clause: 'Security Deposit - Receipt', suggested_text: 'SECURITY DEPOSIT. Tenant shall receive a written receipt for the security deposit, and its terms shall be included in the written lease.', comment: 'MD requires a receipt/written-lease disclosure of the security deposit (Real Prop. § 8-203(c)).' },
  'MD-RL-5': { clause: 'Waiver of Negligence', suggested_text: 'INDEMNIFICATION. Tenant agrees to indemnify Landlord except to the extent caused by Landlord\'s gross negligence or willful misconduct.', comment: 'Residential exculpation clauses are disfavored under Maryland public policy.' },
  'MD-CL-1': { clause: 'Default and Remedies (Commercial)', suggested_text: 'DEFAULT AND REMEDIES. Landlord shall recover possession through a civil action in the District Court.', comment: 'MD repossession via District Court action, not self-help (Real Prop. § 8-401).' },
  'MD-CL-2': { clause: 'Indemnification (Commercial)', suggested_text: 'INDEMNIFICATION. Tenant indemnifies Landlord except for Landlord\'s gross negligence or willful misconduct.', comment: 'Maryland general contract law governs commercial exculpation enforceability.' },
};

const NY_CORRECTIONS = {
  'NY-RL-1': { clause: 'Security Deposit', suggested_text: 'SECURITY DEPOSIT. All money deposited as security shall be held in trust by Landlord and shall not be mingled with Landlord\'s personal funds.', comment: 'NY GOL § 7-103(1) requires deposits held in trust, not mingled.' },
  'NY-RL-2': { clause: 'Security Deposit', suggested_text: 'SECURITY DEPOSIT. If the security deposit is placed in a banking organization, Landlord shall notify the tenant in writing of the bank\'s name and address and the amount deposited.', comment: 'NY GOL § 7-103(2) requires written bank notification.' },
  'NY-RL-3': { clause: 'Default and Remedies', suggested_text: 'DEFAULT AND REMEDIES. Landlord shall recover possession only through a summary proceeding under the RPAPL.', comment: 'NY bars self-help eviction; lockout is treble damages (RPAPL § 853, Art 7).' },
  'NY-RL-4': { clause: 'Waiver of Negligence', suggested_text: 'INDEMNIFICATION. Tenant agrees to indemnify Landlord except to the extent caused by Landlord\'s negligence, gross negligence, or willful misconduct.', comment: 'NY GOL § 5-321 voids lease clauses exempting landlord from its own negligence.' },
  'NY-CL-1': { clause: 'Indemnification (Commercial)', suggested_text: 'INDEMNIFICATION. Tenant shall not be liable for Landlord\'s negligence or willful misconduct.', comment: 'NY GOL § 5-321 applies to commercial leases too — void.' },
  'NY-CL-2': { clause: 'Default and Remedies (Commercial)', suggested_text: 'DEFAULT AND REMEDIES. Landlord shall recover possession through a summary proceeding (RPAPL Art 7).', comment: 'NY commercial eviction via summary proceeding, not self-help.' },
};

const PA_CORRECTIONS = {
  'PA-RL-1': { clause: 'Security Deposit', suggested_text: 'SECURITY DEPOSIT. Tenant shall pay a security deposit of no more than two (2) months\' rent during the first year of the Lease, and no more than one (1) month\'s rent thereafter.', comment: 'PA cap: 2 months first year, 1 month after (68 P.S. § 250.511a).' },
  'PA-RL-2': { clause: 'Security Deposit - Return', suggested_text: 'SECURITY DEPOSIT. Within thirty (30) days after termination, Landlord shall provide a written itemized list of damages and return the balance of the escrowed deposit.', comment: 'PA requires 30-day written itemized list + return (68 P.S. § 250.512).' },
  'PA-RL-3': { clause: 'Default and Remedies', suggested_text: 'DEFAULT AND REMEDIES. Landlord shall recover possession by an action of ejectment.', comment: 'PA eviction via ejectment (68 P.S. § 250.511).' },
  'PA-RL-4': { clause: 'Security Deposit - Interest', suggested_text: 'SECURITY DEPOSIT. Any security deposit held past the second year of the Lease shall be placed in an interest-bearing account, and Landlord shall pay Tenant the yearly interest received less a one percent (1%) administrative fee.', comment: 'PA § 250.511b — interest from the 3rd year, less a 1% fee.' },
  'PA-RL-5': { clause: 'Rent Escalation', suggested_text: 'RENT ESCALATION. Annual rent increases shall be capped at [X]% or the annual increase in CPI, whichever is lower.', comment: 'Define a cap/index so escalation is reasonable and enforceable.' },
  'PA-CL-1': { clause: 'Default and Remedies (Commercial)', suggested_text: 'DEFAULT AND REMEDIES. Landlord shall recover possession by an action of ejectment.', comment: 'PA commercial repossession via ejectment (68 P.S. § 250.511 / 42 Pa.C.S. Ch 2950).' },
};

const NJ_CORRECTIONS = {
  'NJ-RL-1': { clause: 'Security Deposit', suggested_text: 'SECURITY DEPOSIT. Tenant shall pay a security deposit of no more than one and one-half (1.5) times one month\'s rent.', comment: 'NJ cap is 1.5x monthly rent (N.J.S.A. 46:8-21.2).' },
  'NJ-RL-2': { clause: 'Security Deposit', suggested_text: 'SECURITY DEPOSIT. All security deposits shall be held in trust and deposited in an interest-bearing account or insured money-market fund; the annual interest shall be paid to the tenant.', comment: 'NJ requires trust + investment/interest-bearing (N.J.S.A. 46:8-19).' },
  'NJ-RL-3': { clause: 'Security Deposit - Return', suggested_text: 'SECURITY DEPOSIT. Within thirty (30) days after termination, Landlord shall return the deposit plus the tenant\'s share of interest, with an itemized accounting of any deductions.', comment: 'NJ requires 30-day return with itemized accounting (N.J.S.A. 46:8-21.1).' },
  'NJ-RL-4': { clause: 'Default and Remedies', suggested_text: 'DEFAULT AND REMEDIES. Landlord shall recover possession only by summary dispossession proceedings.', comment: 'NJ eviction via summary dispossession (N.J.S.A. 2A:18-53 et seq.).' },
  'NJ-RL-5': { clause: 'Mitigation (Residential)', suggested_text: 'MITIGATION. Landlord shall use reasonable efforts to re-let the Premises upon Tenant\'s abandonment to mitigate damages.', comment: 'NJ residential duty to mitigate on abandonment (Sommer v. Kridel, 74 N.J. 446 (1977)).' },
  'NJ-CL-1': { clause: 'Default and Remedies (Commercial)', suggested_text: 'DEFAULT AND REMEDIES. Landlord shall recover possession through summary dispossession proceedings.', comment: 'NJ commercial dispossession via summary proceeding (N.J.S.A. 2A:18-53).' },
};

export const DE_RULES = [
  { state: 'DE', rules: { residential_lease: DE_RESIDENTIAL_RULES, commercial_lease: DE_COMMERCIAL_RULES },
    statutes: { residential_lease: { 'DE-RL-1': '25 Del. C. § 5514(a)', 'DE-RL-3': '25 Del. C. § 5701', 'DE-RL-4': '25 Del. C. § 5301(2)', 'DE-RL-5': '25 Del. C. § 5301(3)' } }, corrections: DE_CORRECTIONS },
];
export const MD_RULES = [
  { state: 'MD', rules: { residential_lease: MD_RESIDENTIAL_RULES, commercial_lease: MD_COMMERCIAL_RULES },
    statutes: { residential_lease: { 'MD-RL-1': 'MD Real Prop. § 8-203(b)', 'MD-RL-3': 'MD Real Prop. § 8-401' } }, corrections: MD_CORRECTIONS },
];

// ── PENNSYLVANIA (verified: 68 P.S. 250.511a/.512 deposits; .511 ejectment) ────
const PA_RESIDENTIAL_RULES = [
  { id: 'PA-RL-1', title: 'Security deposit exceeds PA cap (2 mo yr1 / 1 mo after)', statute: '68 P.S. § 250.511a', severity: 'high',
    check: (text) => {
      if (/security deposit[^\n.]{0,80}(?:three|3|four|4|more than two)\s*\(?\s*3?\s*\)?\s*months?['’]?\s*(?:rent|of rent|deposit)/i.test(text))
        return { finding: 'Security deposit likely exceeds PA cap', cite: '68 P.S. § 250.511a: max 2 months first year, 1 month after' };
      return null;
    } },
  { id: 'PA-RL-2', title: 'Security deposit no 30-day return / itemized list', statute: '68 P.S. § 250.512', severity: 'medium',
    check: (text) => {
      if (/security deposit/i.test(text) && !/(?:30 days|thirty days|itemized list|returned? within 30)/i.test(text))
        return { finding: 'Missing PA 30-day return + itemized damages list', cite: '68 P.S. § 250.512(a)' };
      return null;
    } },
  { id: 'PA-RL-3', title: 'Self-help eviction', statute: '68 P.S. § 250.511', severity: 'critical',
    check: (text) => rx.selfHelp.test(text)
      ? { finding: 'PA eviction via ejectment action, not raw self-help', cite: '68 P.S. § 250.511 (ejectment preserved)' } : null },
  { id: 'PA-RL-4', title: 'Security deposit interest not provided (post-2nd-year)', statute: '68 P.S. § 250.511b', severity: 'low',
    check: (text) => {
      if (/security deposit/i.test(text) && /third year|3rd year/i.test(text) && !/(?:interest|interest[\s-]*bearing)/i.test(text))
        return { finding: 'PA requires interest on deposits held past the 2nd year', cite: '68 P.S. § 250.511b (interest from 3rd year, less 1% fee)' };
      return null;
    } },
  { id: 'PA-RL-5', title: 'Rent escalation without cap', statute: 'PA general contract / public policy', severity: 'low',
    check: (text) => {
      if (/escalat|increase.{0,40}rent|rent.{0,60}(?:per year|annually)/i.test(text) && !/(?:\d+\s*%|\d+\s*percent|cpi|consumer price index)/i.test(text))
        return { finding: 'Rent escalation lacks a defined cap/index; may be scrutinized', cite: 'PA contract principles on reasonable rent adjustments' };
      return null;
    } },
];
// PA COMMERCIAL: deposit rules are residential; commercial governed by general contract/common law.
const PA_COMMERCIAL_RULES = [
  { id: 'PA-CL-1', title: 'Commercial self-help eviction', statute: '68 P.S. § 250.511 / 42 Pa.C.S.', severity: 'high',
    check: (text) => rx.selfHelp.test(text)
      ? { finding: 'Commercial repossession via ejectment action, not self-help', cite: '68 P.S. § 250.511' } : null },
];

// ── NEW JERSEY (verified: 46:8-19 trust/invest; 21.1 return; 21.2 cap) ────────
const NJ_RESIDENTIAL_RULES = [
  { id: 'NJ-RL-1', title: 'Security deposit exceeds NJ cap (1.5x monthly rent)', statute: 'N.J.S.A. 46:8-21.2', severity: 'high',
    check: (text) => {
      // NJ cap = 1.5x monthly rent (46:8-21.2). Flag 2+ months (incl. "two (2) months")
      if (/security deposit[^\n.]{0,80}(?:two|2|three|3|four|4|in excess of one and one-half)|(?:two|2|three|3|four|4)[\s(]*months?['’]?\s*(?:rent|of rent|deposit).{0,80}security deposit/i.test(text))
        return { finding: 'Security deposit likely exceeds NJ cap of 1.5x monthly rent', cite: 'N.J.S.A. 46:8-21.2' };
      return null;
    } },
  { id: 'NJ-RL-2', title: 'Security deposit not held in trust/invested', statute: 'N.J.S.A. 46:8-19', severity: 'high',
    check: (text) => {
      if (/security deposit/i.test(text) && !/(?:trust|shall not be mingled|money market|interest.{0,30}account)/i.test(text))
        return { finding: 'NJ requires security deposit held in trust and invested/interest-bearing', cite: 'N.J.S.A. 46:8-19' };
      return null;
    } },
  { id: 'NJ-RL-3', title: 'Security deposit no 30-day return / itemization', statute: 'N.J.S.A. 46:8-21.1', severity: 'medium',
    check: (text) => {
      if (/security deposit/i.test(text) && !/(?:30 days|thirty days|itemized)/i.test(text))
        return { finding: 'Missing NJ 30-day return of deposit + itemized accounting', cite: 'N.J.S.A. 46:8-21.1' };
      return null;
    } },
  { id: 'NJ-RL-4', title: 'Self-help eviction', statute: 'N.J.S.A. 2A:18-53', severity: 'critical',
    check: (text) => rx.selfHelp.test(text)
      ? { finding: 'NJ eviction via summary dispossession (2A:18-53), not self-help', cite: 'N.J.S.A. 2A:18-53 et seq.' } : null },
  { id: 'NJ-RL-5', title: 'Residential mitigation duty (abandonment)', statute: 'Sommer v. Kridel, 74 N.J. 446 (1977)', severity: 'medium',
    check: (text) => {
      if (/abandon|vacat|leave (?:the )?premises|move out/i.test(text) && /landlord.*(?:no duty|not.*obligat|need not|shall not).{0,40}mitigat/i.test(text))
        return { finding: 'NJ residential duty to mitigate on abandonment (Sommer v. Kridel)', cite: 'Sommer v. Kridel, 74 N.J. 446 (1977) — landlord must mitigate residential damages' };
      return null;
    } },
];
// NJ COMMERCIAL: deposit cap 46:8-21.2 is residential ("dwelling purposes"); commercial via general contract.
const NJ_COMMERCIAL_RULES = [
  { id: 'NJ-CL-1', title: 'Commercial self-help eviction', statute: 'N.J.S.A. 2A:18-53', severity: 'high',
    check: (text) => rx.selfHelp.test(text)
      ? { finding: 'Commercial dispossession via summary proceeding (2A:18-53), not self-help', cite: 'N.J.S.A. 2A:18-53' } : null },
];

export const NY_RULES = [
  { state: 'NY', rules: { residential_lease: NY_RESIDENTIAL_RULES, commercial_lease: NY_COMMERCIAL_RULES },
    statutes: { residential_lease: { 'NY-RL-1': 'NY GOL § 7-103', 'NY-RL-4': 'NY GOL § 5-321' } }, corrections: NY_CORRECTIONS },
];

// Combined contributor list consumed by lease-analyzer's loadStateRuleSets().
export const PA_RULES = [
  { state: 'PA', rules: { residential_lease: PA_RESIDENTIAL_RULES, commercial_lease: PA_COMMERCIAL_RULES },
    statutes: { residential_lease: { 'PA-RL-1': '68 P.S. § 250.511a', 'PA-RL-2': '68 P.S. § 250.512' } }, corrections: PA_CORRECTIONS },
];
export const NJ_RULES = [
  { state: 'NJ', rules: { residential_lease: NJ_RESIDENTIAL_RULES, commercial_lease: NJ_COMMERCIAL_RULES },
    statutes: { residential_lease: { 'NJ-RL-1': 'N.J.S.A. 46:8-21.2', 'NJ-RL-2': 'N.J.S.A. 46:8-19' } }, corrections: NJ_CORRECTIONS },
];

export default [].concat(DE_RULES, MD_RULES, NY_RULES, PA_RULES, NJ_RULES);
