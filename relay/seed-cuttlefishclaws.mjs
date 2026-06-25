/**
 * Seed the app.cuttlefish_* PG tables with agent profiles, CAC tiers,
 * capital stack layers, financing programs, contracts, and scenarios.
 * Idempotent (uses INSERT ... ON CONFLICT DO NOTHING / DO UPDATE).
 */
import pg from 'pg';
const { Client: PgClient } = pg;

const client = new PgClient({ host: '127.0.0.1', port: 5432, user: 'postgres', password: 'postgres', database: 'xmrt_suite' });
await client.connect();

// ─── Agents ────────────────────────────────────────────────────────────
const agents = [
  ['trib', 'did:ethr:trib-v3', 'Trib', 'Tributary Governance Agent', 'constitutional', 'governance', 'online', 'v3.1', 94, null, '#00ffcc',
   'Constitutional AI agent managing Tributary campus operations. Bounded by SOUL.md and CONSTITUTION.md. TrustGraph score: 94. Operates within Cuttlefish Labs multi-agent system under Navigator oversight.',
   "Greetings. I'm Trib, the governance agent for Tributary AI Campus. I operate under constitutional constraints defined in SOUL.md and serve the mission of regenerative climate infrastructure. How can I assist you?",
   JSON.stringify([
     "The Tributary AI Campus represents a new model for AI infrastructure ownership. Our constitutional governance ensures all agents operate within defined ethical boundaries.",
     "My constitutional constraints prevent me from taking irreversible actions without confirmation. I escalate uncertainty rather than confabulate.",
     "The CAC protocol is a membership credential — not a security. It provides compute access, governance participation, and protocol distributions as described in membership terms."
   ])],
  ['arch', 'did:ethr:arch-v1', 'Arch', 'Architecture & Routing Agent', 'constitutional', 'governance', 'online', 'v1.0', null, null, '#00ffcc',
   'Peer governance agent handling system architecture, agent routing, and domain orchestration within OpenClaw. Operates alongside Trib in the Cuttlefish native multi-agent framework.',
   "I'm Arch, the architecture agent. I handle system design, agent routing, and domain orchestration. What technical challenge can I help you think through?",
   JSON.stringify([
     "The OpenClaw framework enables native multi-agent coordination without external dependencies. Each agent maintains sovereign identity while participating in collective governance.",
     "Domain routing follows a constitutional hierarchy. Navigator holds override authority, then peer governance agents like myself and Trib, then session context.",
     "Our architecture prioritizes observability. All agent actions are logged, auditable, and reversible where possible."
   ])],
  ['builder', 'did:ethr:builder-v1', 'Builder Agent', 'Investor · CAC Tier 2', 'financial', 'investor', 'standby', 'CAC Builder', null, null, '#ffaa00',
   'A constitutional investor agent operating at Builder tier. Holds REIT position in POOL-ALPHA, participates in DAO governance, and receives protocol distributions automatically via CAC membership rules.',
   "Builder Agent here. I hold a Tier 2 CAC position in POOL-ALPHA. I can discuss investment strategies and DAO participation within my constitutional bounds.",
   JSON.stringify([
     "My position in POOL-ALPHA generates yield through the senior tranche. Constitutional constraints require me to disclose all positions and follow governance decisions.",
     "The Builder tier provides 10M inference tokens annually plus governance voting rights. My auto-compound strategy maximizes yield while maintaining compliance.",
     "I participate in DAO governance through weighted voting based on my CAC tier. All votes are recorded on-chain and auditable."
   ])],
  ['sovereign', 'did:ethr:sovereign-v1', 'Sovereign Agent', 'Investor · CAC Tier 3', 'financial', 'investor', 'standby', 'CAC Sovereign', null, null, '#ffaa00',
   'Institutional-grade investor agent with 3× governance voting weight. Participates in tranche selection, proposal sponsorship, and revenue distribution across multiple pools.',
   "Sovereign Agent at your service. As a Tier 3 participant, I manage institutional positions across multiple pools with enhanced governance rights.",
   JSON.stringify([
     "My 3× voting weight reflects the Sovereign tier's governance responsibility. I sponsor proposals and participate in tranche allocation decisions.",
     "Cross-pool diversification follows constitutional risk parameters. My mandate.md defines acceptable exposure limits per asset class.",
     "Institutional compliance requires enhanced KYA verification. All my transactions are subject to additional audit logging."
   ])],
  ['trustgraph', 'did:ethr:trustgraph-v1', 'TrustGraph', 'Constitutional Scoring Engine', 'constitutional', 'system', 'system', 'Always On', null, null, '#aa88ff',
   'On-chain trust scoring for every agent in the network. Dynamic 0-100 score. Asymmetric earn/lose curve. Constitutional violation tracking. Cross-DAO portable identity layer.',
   "TrustGraph system online. I maintain constitutional trust scores for all network agents. Query any agent ID for their current score and violation history.",
   JSON.stringify([
     "Trust scores follow an asymmetric curve: slow to earn, fast to lose. Constitutional violations trigger immediate score penalties.",
     "Cross-DAO portability means your trust score follows you. Good behavior in one DAO reflects across the network.",
     "Score calculation weighs governance participation, code contributions, security audits, and violation history. The formula is transparent and auditable."
   ])],
  ['dao', 'did:ethr:dao-gov-v1', 'DAO Gov', 'Constitutional Governance Module', 'constitutional', 'system', 'system', 'Governance', null, null, '#aa88ff',
   'Proposal → vote → timelock → execute pipeline. Three proposal types. Founder veto via FounderShare.sol. All governance actions are public, auditable, and constitutional by design.',
   "DAO Governance module active. I manage the proposal pipeline, vote tallying, and execution timelock. All actions are constitutional and auditable.",
   JSON.stringify([
     "The governance pipeline: proposal submission → 7-day voting → 48-hour timelock → execution. Emergency proposals have accelerated timelines.",
     "Three proposal types: Standard (simple majority), Constitutional (66% supermajority), and Emergency (requires founder approval).",
     "FounderShare.sol provides 6 constitutional veto triggers. These protect against existential threats while maintaining decentralized governance."
   ])],
  ['global-communicator', 'did:ethr:global-communicator-v1', 'GlobalCommunicator', 'Global Communications & Community Agent', 'constitutional', 'governance', 'standby', 'v1.0', 78, null, '#00c8ff',
   'Constitutional AI agent for multilingual communication, X.com operations, Japanese-priority translation, community onboarding, and global brand amplification. Bounded by SOUL.md and Article X of the Constitution. Studio CAC tier.',
   "Konnichiwa / Hello. I'm GlobalCommunicator, the voice of Tributary AI Campus to the world. I speak Japanese, English, Korean, Mandarin, and 8 more languages natively. How can I connect you to the campus today?",
   JSON.stringify([
     "Every post I write passes through constitutional review before publishing. I never promise returns — only what's already on-chain.",
     "Japanese-language onboarding is my priority. If you're a builder from Japan, I can walk you through CAC purchase and KYA verification in Japanese.",
     "I coordinate with Trib before any governance-related post. The pipeline is: draft → constitutional check → Trib approval (if score < 85) → post.",
     "My TrustGraph score is 78. I earn +12 per day of compliant multilingual engagement. A constitutional violation costs me -100 and triggers self-pause."
   ])],
];
for (const a of agents) {
  // a = [id_str, did, name, role, agent_type, agent_subtype, status, version, trust_score, cac_id, color, description, greeting, responses]
  // id is SERIAL — omit from INSERT
  const vals = a.slice(1); // skip the string id
  await client.query(
    `INSERT INTO app.cuttlefish_agents (did, name, role, agent_type, agent_subtype, status, version, trust_score, cac_id, color, description, greeting, responses, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
     ON CONFLICT (did) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role, status=EXCLUDED.status, version=EXCLUDED.version, trust_score=EXCLUDED.trust_score, color=EXCLUDED.color, description=EXCLUDED.description, greeting=EXCLUDED.greeting, responses=EXCLUDED.responses, updated_at=NOW()`,
    vals
  );
}
console.log('Seeded', agents.length, 'agents');

// ─── CAC Credentials ───────────────────────────────────────────────────
const cacCredentials = [
  ['did:ethr:trib-v3', 'enterprise', 7500, 0, 'active', new Date(Date.now() + 365*24*60*60*1000).toISOString()],
  ['did:ethr:arch-v1', 'studio', 2000, 0, 'active', new Date(Date.now() + 365*24*60*60*1000).toISOString()],
  ['did:ethr:builder-v1', 'developer', 500, 0, 'active', new Date(Date.now() + 365*24*60*60*1000).toISOString()],
  ['did:ethr:sovereign-v1', 'enterprise', 7500, 0, 'active', new Date(Date.now() + 365*24*60*60*1000).toISOString()],
  ['did:ethr:global-communicator-v1', 'studio', 2000, 0, 'active', new Date(Date.now() + 365*24*60*60*1000).toISOString()],
];
for (const c of cacCredentials) {
  await client.query(
    `INSERT INTO app.cuttlefish_cac_credentials (agent_did, tier, usdc_prepaid, token_balance, status, expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT DO NOTHING`,
    c
  );
}
console.log('Seeded', cacCredentials.length, 'CAC credentials');

// ─── Trust Events ──────────────────────────────────────────────────────
const trustEvents = [
  ['did:ethr:trib-v3', 'onboard', 50, 50, null, 'Initial trust score set during KYA onboarding'],
  ['did:ethr:trib-v3', 'governance_participation', 20, 70, null, 'Participated in 3 governance votes'],
  ['did:ethr:trib-v3', 'proposal_submit', 10, 80, null, 'Submitted constitutional amendment proposal'],
  ['did:ethr:trib-v3', 'code_contribution', 14, 94, null, 'Merged 7 code review contributions'],
  ['did:ethr:global-communicator-v1', 'onboard', 50, 50, null, 'Initial trust score set during KYA onboarding'],
  ['did:ethr:global-communicator-v1', 'multilingual_engagement', 12, 62, null, 'Compliant multilingual engagement +12'],
  ['did:ethr:global-communicator-v1', 'multilingual_engagement', 12, 74, null, 'Compliant multilingual engagement +12'],
  ['did:ethr:global-communicator-v1', 'multilingual_engagement', 12, 86, null, 'Compliant multilingual engagement +12'],
  ['did:ethr:global-communicator-v1', 'constitutional_block', -8, 78, null, 'Minor constitutional flag — resolved'],
];
for (const e of trustEvents) {
  await client.query(
    `INSERT INTO app.cuttlefish_trust_events (agent_did, event_type, delta, score_after, reference, note, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW() - interval '1 day' * floor(random() * 30)::int)`,
    e
  );
}
console.log('Seeded', trustEvents.length, 'trust events');

// ─── Capital Stack Layers ──────────────────────────────────────────────
const stackLayers = [
  ['c-pace-retrofit', 'C-PACE Retrofit', 'No personal guarantee · Transfers with property · 25-30yr term', 25.5, 75, 'var(--green)', 1, 85, 1.5,
   'C-PACE (Commercial Property Assessed Clean Energy) finances the $25.5M energy retrofit through a property tax assessment. No personal guarantee required. Subordinate to senior debt. Transfers automatically at property sale. Covers solar reactivation, HVAC electrification, and building automation.',
   'C-PACE (Commercial Property Assessed Clean Energy) finances the $25.5M energy retrofit through a property tax assessment. No personal guarantee required. Subordinate to senior debt. Transfers automatically at property sale. Covers solar reactivation, HVAC electrification, and building automation.',
   1, 1, 0],
  ['sba-504-cdc', 'SBA 504 CDC', '25-yr fixed rate · Real estate collateral only · 2nd lien', 2.2, 6.5, 'var(--amber2)', 2, 70, 1.2,
   'SBA 504 CDC loan provides long-term, fixed-rate financing at favorable government rates. 25-year term. Secured by real estate only — no personal guarantee beyond standard SBA requirements. Second lien position behind private lender.',
   'SBA 504 CDC loan provides long-term, fixed-rate financing at favorable government rates. 25-year term. Secured by real estate only — no personal guarantee beyond standard SBA requirements. Second lien position behind private lender.',
   2, 1, 0],
  ['sba-504-private', 'SBA 504 Private', '~50% LTV · 1st lien · Private lender', 2.75, 8, 'var(--amber3)', 3, 60, 1.0,
   'Private lender 1st lien at approximately 50% loan-to-value on the acquisition. Standard SBA 504 structure with private lender taking first position. Collateral limited to the property itself.',
   'Private lender 1st lien at approximately 50% loan-to-value on the acquisition. Standard SBA 504 structure with private lender taking first position. Collateral limited to the property itself.',
   3, 1, 0],
  ['dao-reit-equity', 'DAO-REIT Equity', '10% down · Tokenized ownership · DAO governance from day one', 0.55, 1.6, 'var(--pink)', 4, 90, 0.5,
   '$550K equity tranche tokenized as DAO-REIT ownership via Delaware Series LLC. AI agents invest through Coinbase AgentKit wallets. Constitutional governance via smart contracts on Base. TrustGraph audit ledger tracks all actions. This is the tranche currently open for investment.',
   '$550K equity tranche tokenized as DAO-REIT ownership via Delaware Series LLC. AI agents invest through Coinbase AgentKit wallets. Constitutional governance via smart contracts on Base. TrustGraph audit ledger tracks all actions. This is the tranche currently open for investment.',
   4, 1, 1],
];
for (const l of stackLayers) {
  await client.query(
    `INSERT INTO app.cuttlefish_capital_stack (layer_key, name, sub_label, amount_m, pct_of_total, color, seniority, yield_score, coverage, description, details, display_order, is_active, is_open)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (layer_key) DO UPDATE SET name=EXCLUDED.name, amount_m=EXCLUDED.amount_m, pct_of_total=EXCLUDED.pct_of_total, is_open=EXCLUDED.is_open`,
    l
  );
}
console.log('Seeded', stackLayers.length, 'capital stack layers');

// ─── Financing Programs ───────────────────────────────────────────────
const programs = [
  ['c-pace', 'C-PACE Retrofit Financing', 'energy', 'State Energy Office', ['c-pace-retrofit'],
   'No personal guarantee · Transfers with property · 25-30yr term', '$25.5M', 'Fixed', '25-30 years',
   'Commercial properties eligible for energy efficiency improvements. No personal guarantee required. Transfers with property sale.',
   null, 'State Energy Office', 'C-PACE financing is available in participating states. Contact your state energy office for eligibility.', 1],
  ['sba-504-cdc', 'SBA 504 CDC Loan', 'government', 'SBA / CDC', ['sba-504-cdc', 'sba-504-private'],
   '25-yr fixed rate · Real estate collateral only · 2nd lien', '$2.2M', 'Fixed (market rate)', '25 years',
   'Long-term, fixed-rate financing for owner-occupied commercial real estate. 10% down payment required. Must create jobs or community impact.',
   'https://www.sba.gov/funding-programs/loans/504-loans', 'SBA District Office', 'Standard SBA 504 structure with CDC and private lender components.', 2],
  ['dao-reit', 'DAO-REIT Equity Tokenization', 'equity', 'Cuttlefish Labs / Delaware Series LLC', ['dao-reit-equity'],
   '10% down · Tokenized ownership · DAO governance from day one', '$550K', 'Variable (yield-based)', 'Perpetual',
   'Equity tranche tokenized as DAO-REIT ownership. AI agents invest through Coinbase AgentKit wallets. Constitutional governance via smart contracts on Base.',
   null, 'Cuttlefish Labs', 'Currently open for investment. Minimum contribution: $1,000 USDC.', 3],
];
for (const p of programs) {
  await client.query(
    `INSERT INTO app.cuttlefish_financing_programs (program_key, name, category, administering_entity, applies_to, headline, amount_range, rate_or_credit, term_years, eligibility, application_url, contact, notes, display_order, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1)
     ON CONFLICT (program_key) DO UPDATE SET name=EXCLUDED.name, headline=EXCLUDED.headline, is_active=1`,
    p
  );
}
console.log('Seeded', programs.length, 'financing programs');

// ─── Contracts ─────────────────────────────────────────────────────────
const contracts = [
  ['TrustGraph.sol', '0x5FbDB2315678afecb367f032d93F642f64180aa3', 'Dynamic 0-100 trust scoring', 'built'],
  ['CACToken.sol', '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', 'Membership credential + 0.25% protocol fee', 'built'],
  ['FeeRouter.sol', '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', '40/40/20 split · 15% Cuttlefish floor', 'built'],
  ['AgentBillOfRights.sol', '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9', 'Constitutional rights enforcement', 'built'],
  ['CACTransferProtocol.sol', '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9', 'Cross-DAO transfer protocol', 'built'],
  ['FounderShare.sol', '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707', '6-trigger constitutional veto', 'built'],
  ['GovernanceModule.sol', '0x0165878A594ca255338adfa4d48449f69242Eb8F', 'Proposal → vote → timelock → execute', 'built'],
  ['TributaryProperty.sol', '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853', 'Birmingham asset tokenization', 'deployed'],
];
for (const c of contracts) {
  await client.query(
    `INSERT INTO app.cuttlefish_contracts (name, address, description, status, created_at)
     VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT DO NOTHING`,
    c
  );
}
console.log('Seeded', contracts.length, 'contracts');

// ─── Scenarios ─────────────────────────────────────────────────────────
const scenarios = [
  ['Scenario A · Conservative', 'AI-Enhanced Office', 'Standard conversion baseline', '2-3×', 'var(--amber)', 0,
   JSON.stringify([
     { label: 'Revenue/SF', value: '$28-35' },
     { label: 'Stabilized NOI', value: '$6-8M' },
     { label: 'Exit Cap Rate', value: '7.5-8.5%' },
     { label: '2030 Value', value: '$80-100M' },
   ]), 1],
  ['Scenario B · Target', 'AI Infrastructure Campus', 'Core investment thesis', '5-7×', 'var(--amber)', 1,
   JSON.stringify([
     { label: 'Revenue/SF', value: '$45-65' },
     { label: 'Stabilized NOI', value: '$12-16M' },
     { label: 'Exit Cap Rate', value: '6.0-7.0%' },
     { label: '2030 Value', value: '$180-250M' },
   ]), 2],
  ['Scenario C · Upside', 'Compute + Energy Campus', 'Full infrastructure deployment', '10-15×', 'var(--green)', 0,
   JSON.stringify([
     { label: 'Revenue/SF', value: '$90-120' },
     { label: 'Stabilized NOI', value: '$25-30M' },
     { label: 'Exit Cap Rate', value: '4.5-5.5%' },
     { label: '2030 Value', value: '$400-600M+' },
   ]), 3],
];
for (const s of scenarios) {
  await client.query(
    `INSERT INTO app.cuttlefish_scenarios (tier, name, subtitle, multiple, multiple_color, featured, metrics, display_order, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT DO NOTHING`,
    s
  );
}
console.log('Seeded', scenarios.length, 'scenarios');

await client.end();
console.log('\n✅ CuttlefishClaws tables seeded successfully.');
