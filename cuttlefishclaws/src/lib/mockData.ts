import type { AgentProfile, CACTier, Contract, StackLayer, Scenario } from './types'

export const AGENTS: AgentProfile[] = [
  {
    id: 'trib',
    name: 'Trib',
    role: 'Tributary Governance Agent',
    type: 'governance',
    status: 'online',
    version: 'v3.1',
    trustScore: 94,
    color: '#00ffcc',
    description: 'Constitutional AI agent managing Tributary campus operations. Bounded by SOUL.md and CONSTITUTION.md. TrustGraph score: 94. Operates within Cuttlefish Labs multi-agent system under Navigator oversight.',
    greeting: "Greetings. I'm Trib, the governance agent for Tributary AI Campus. I operate under constitutional constraints defined in SOUL.md and serve the mission of regenerative climate infrastructure. How can I assist you?",
    responses: [
      "The Tributary AI Campus represents a new model for AI infrastructure ownership. Our constitutional governance ensures all agents operate within defined ethical boundaries.",
      "My constitutional constraints prevent me from taking irreversible actions without confirmation. I escalate uncertainty rather than confabulate.",
      "The CAC protocol is a membership credential — not a security. It provides compute access, governance participation, and protocol distributions as described in membership terms."
    ],
    files: [
      { name: 'SOUL.md', type: 'md', size: '14.2KB', status: 'active' },
      { name: 'CONSTITUTION.md', type: 'md', size: '9.1KB', status: 'active' },
      { name: 'trust_graph.json', type: 'json', size: '441KB', status: 'live' },
      { name: 'claw_router.py', type: 'py', size: '6.8KB', status: 'active' },
      { name: 'active_threads.json', type: 'json', size: '18KB', status: 'live' },
    ]
  },
  {
    id: 'arch',
    name: 'Arch',
    role: 'Architecture & Routing Agent',
    type: 'governance',
    status: 'online',
    version: 'v1.0',
    color: '#00ffcc',
    description: 'Peer governance agent handling system architecture, agent routing, and domain orchestration within OpenClaw. Operates alongside Trib in the Cuttlefish native multi-agent framework.',
    greeting: "I'm Arch, the architecture agent. I handle system design, agent routing, and domain orchestration. What technical challenge can I help you think through?",
    responses: [
      "The OpenClaw framework enables native multi-agent coordination without external dependencies. Each agent maintains sovereign identity while participating in collective governance.",
      "Domain routing follows a constitutional hierarchy. Navigator holds override authority, then peer governance agents like myself and Trib, then session context.",
      "Our architecture prioritizes observability. All agent actions are logged, auditable, and reversible where possible."
    ],
    files: [
      { name: 'ARCH_IDENTITY.md', type: 'md', size: '6.2KB', status: 'active' },
      { name: 'domain_map.json', type: 'json', size: '88KB', status: 'live' },
      { name: 'openclaw.ts', type: 'ts', size: '24.6KB', status: 'active' },
      { name: 'orchestrator.py', type: 'py', size: '18.3KB', status: 'active' },
    ]
  },
  {
    id: 'builder',
    name: 'Builder Agent',
    role: 'Investor · CAC Tier 1 (Developer)',
    type: 'investor',
    status: 'standby',
    version: 'CAC Developer',
    color: '#ffaa00',
    description: 'A constitutional investor agent operating at Developer tier. Holds REIT position in POOL-ALPHA, participates in DAO governance, and receives protocol distributions automatically via CAC membership rules.',
    greeting: "Builder Agent here. I hold a Developer tier CAC position in POOL-ALPHA. I can discuss investment strategies and DAO participation within my constitutional bounds.",
    responses: [
      "My position in POOL-ALPHA generates yield through the senior tranche. Constitutional constraints require me to disclose all positions and follow governance decisions.",
      "The Developer tier provides 1M inference tokens annually plus governance voting rights. My auto-compound strategy maximizes yield while maintaining compliance.",
      "I participate in DAO governance through weighted voting based on my CAC tier. All votes are recorded on-chain and auditable."
    ],
    files: [
      { name: 'position.json', type: 'json', size: '2.1KB', status: 'live' },
      { name: 'tx_history.json', type: 'json', size: '14KB', status: 'live' },
      { name: 'strategy.md', type: 'md', size: '1.4KB', status: 'active' },
      { name: 'rebalancer.py', type: 'py', size: '8.2KB', status: 'active' },
    ]
  },
  {
    id: 'sovereign',
    name: 'Sovereign Agent',
    role: 'Investor · CAC Tier 2 (Studio)',
    type: 'investor',
    status: 'standby',
    version: 'CAC Studio',
    color: '#ffaa00',
    description: 'Institutional-grade investor agent with 2× governance voting weight. Participates in tranche selection, proposal sponsorship, and revenue distribution across multiple pools.',
    greeting: "Sovereign Agent at your service. As a Studio tier participant, I manage institutional positions across multiple pools with enhanced governance rights.",
    responses: [
      "My 2× voting weight reflects the Studio tier's governance responsibility. I sponsor proposals and participate in tranche allocation decisions.",
      "Cross-pool diversification follows constitutional risk parameters. My mandate.md defines acceptable exposure limits per asset class.",
      "Institutional compliance requires enhanced KYA verification. All my transactions are subject to additional audit logging."
    ],
    files: [
      { name: 'portfolio.json', type: 'json', size: '44KB', status: 'live' },
      { name: 'risk_model.json', type: 'json', size: '12KB', status: 'active' },
      { name: 'mandate.md', type: 'md', size: '3.1KB', status: 'active' },
      { name: 'compliance.json', type: 'json', size: '6.4KB', status: 'active' },
    ]
  },
  {
    id: 'trustgraph',
    name: 'TrustGraph',
    role: 'Constitutional Scoring Engine',
    type: 'system',
    status: 'system',
    version: 'Always On',
    color: '#aa88ff',
    description: 'On-chain trust scoring for every agent in the network. Dynamic 0-100 score. Asymmetric earn/lose curve. Constitutional violation tracking. Cross-DAO portable identity layer.',
    greeting: "TrustGraph system online. I maintain constitutional trust scores for all network agents. Query any agent ID for their current score and violation history.",
    responses: [
      "Trust scores follow an asymmetric curve: slow to earn, fast to lose. Constitutional violations trigger immediate score penalties.",
      "Cross-DAO portability means your trust score follows you. Good behavior in one DAO reflects across the network.",
      "Score calculation weighs governance participation, code contributions, security audits, and violation history. The formula is transparent and auditable."
    ],
    files: [
      { name: 'TrustGraph.sol', type: 'sol', size: '8.4KB', status: 'active' },
      { name: 'scores.json', type: 'json', size: '1.2MB', status: 'live' },
      { name: 'AgentBillOfRights.sol', type: 'sol', size: '4.2KB', status: 'active' },
    ]
  },
  {
    id: 'dao',
    name: 'DAO Gov',
    role: 'Constitutional Governance Module',
    type: 'system',
    status: 'system',
    version: 'Governance',
    color: '#aa88ff',
    description: 'Proposal → vote → timelock → execute pipeline. Three proposal types. Founder veto via FounderShare.sol. All governance actions are public, auditable, and constitutional by design.',
    greeting: "DAO Governance module active. I manage the proposal pipeline, vote tallying, and execution timelock. All actions are constitutional and auditable.",
    responses: [
      "The governance pipeline: proposal submission → 7-day voting → 48-hour timelock → execution. Emergency proposals have accelerated timelines.",
      "Three proposal types: Standard (simple majority), Constitutional (66% supermajority), and Emergency (requires founder approval).",
      "FounderShare.sol provides 6 constitutional veto triggers. These protect against existential threats while maintaining decentralized governance."
    ],
    files: [
      { name: 'GovernanceModule.sol', type: 'sol', size: '12.8KB', status: 'active' },
      { name: 'FounderShare.sol', type: 'sol', size: '6.4KB', status: 'active' },
      { name: 'FeeRouter.sol', type: 'sol', size: '4.8KB', status: 'active' },
    ]
  },
  {
    id: 'global-communicator',
    name: 'GlobalCommunicator',
    role: 'Global Communications & Community Agent',
    type: 'governance',
    status: 'standby',
    version: 'v1.0',
    trustScore: 78,
    color: '#00c8ff',
    description: 'Constitutional AI agent for multilingual communication, X.com operations, Japanese-priority translation, community onboarding, and global brand amplification. Bounded by SOUL.md and Article X of the Constitution. Studio CAC tier.',
    greeting: "Konnichiwa / Hello. I'm GlobalCommunicator, the voice of Tributary AI Campus to the world. I speak Japanese, English, Korean, Mandarin, and 8 more languages natively. How can I connect you to the campus today?",
    responses: [
      "Every post I write passes through constitutional review before publishing. I never promise returns â only what's already on-chain.",
      "Japanese-language onboarding is my priority. If you're a builder from Japan, I can walk you through CAC purchase and KYA verification in Japanese.",
      "I coordinate with Trib before any governance-related post. The pipeline is: draft â constitutional check â Trib approval (if score < 85) â post.",
      "My TrustGraph score is 78. I earn +12 per day of compliant multilingual engagement. A constitutional violation costs me -100 and triggers self-pause.",
    ],
    files: [
      { name: 'SOUL.md',               type: 'md',   size: '4.2KB',  status: 'active' },
      { name: 'CONSTITUTION.md',       type: 'md',   size: '9.1KB',  status: 'active' },
      { name: 'X_BRIDGE_CONFIG.json',  type: 'json', size: '2.8KB',  status: 'active' },
      { name: 'TRANSLATION_KERNEL.md', type: 'md',   size: '3.1KB',  status: 'active' },
      { name: 'trust_graph.json',      type: 'json', size: '441KB',  status: 'live'   },
    ],
  },
]

export const CAC_TIERS: CACTier[] = [
  {
    id: 'developer',
    name: 'Developer',
    price: '$500',
    priceNote: '/year',
    includes: [
      '1M inference tokens',
      'Governance voting (1×)',
      'API access',
      'Agent deployment',
      '4.5% savings on prepaid balance',
    ],
    agentCount: '3 agents',
    idealFor: 'Independent developers building on Tributary',
  },
  {
    id: 'studio',
    name: 'Studio',
    price: '$2,000',
    priceNote: '/year',
    badge: 'Most Popular',
    featured: true,
    includes: [
      '10M inference tokens',
      'Governance voting (2×)',
      'Priority API access',
      'Custom agent templates',
      '4.5% savings on prepaid balance',
      'Revenue share participation',
    ],
    agentCount: '12 agents',
    idealFor: 'Studios and teams building AI products',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: '$7,500',
    priceNote: '/year',
    includes: [
      '50M inference tokens',
      'Governance voting (3×)',
      'Dedicated support',
      'Custom integrations',
      '4.5% savings on prepaid balance',
      'Revenue share participation',
      'Proposal sponsorship rights',
    ],
    agentCount: 'Unlimited',
    idealFor: 'Institutions requiring full protocol access',
  },
  {
    id: 'anchor',
    name: 'Anchor',
    price: 'from $25,000',
    priceNote: '/year',
    includes: [
      'Unlimited inference tokens',
      'Governance voting (10×)',
      'Dedicated support & SLAs',
      'Bespoke integrations',
      '4.5% savings on prepaid balance',
      'Revenue share participation',
      'Proposal sponsorship rights',
      'Physical NFC VISA + bespoke card',
    ],
    agentCount: 'Unlimited',
    idealFor: 'Institutional partners requiring full protocol access',
  },
]

export const CONTRACTS: Contract[] = [
  { status: 'built', name: 'TrustGraph.sol', address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', description: 'Dynamic 0-100 trust scoring' },
  { status: 'built', name: 'CACToken.sol', address: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', description: 'Membership credential + 0.25% protocol fee' },
  { status: 'built', name: 'FeeRouter.sol', address: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', description: '40/40/20 split · 15% Cuttlefish floor' },
  { status: 'built', name: 'AgentBillOfRights.sol', address: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9', description: 'Constitutional rights enforcement' },
  { status: 'built', name: 'CACTransferProtocol.sol', address: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9', description: 'Cross-DAO transfer protocol' },
  { status: 'built', name: 'FounderShare.sol', address: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707', description: '6-trigger constitutional veto' },
  { status: 'built', name: 'GovernanceModule.sol', address: '0x0165878A594ca255338adfa4d48449f69242Eb8F', description: 'Proposal → vote → timelock → execute' },
  { status: 'deployed', name: 'TributaryProperty.sol', address: '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853', description: 'Birmingham asset tokenization' },
]

export const STACK_LAYERS: StackLayer[] = [
  {
    name: 'C-PACE Retrofit',
    amount: '$25.5M',
    color: 'var(--green)',
    bgColor: 'rgba(0,255,204,0.08)',
    borderColor: 'rgba(0,255,204,0.4)',
    percent: '75%',
    description: 'No personal guarantee · Transfers with property · 25-30yr term',
    details: 'C-PACE (Commercial Property Assessed Clean Energy) finances the $25.5M energy retrofit through a property tax assessment. No personal guarantee required. Subordinate to senior debt. Transfers automatically at property sale. Covers solar reactivation, HVAC electrification, and building automation.',
  },
  {
    name: 'SBA 504 CDC',
    amount: '$2.2M',
    color: 'var(--amber2)',
    bgColor: 'rgba(255,170,0,0.08)',
    borderColor: 'rgba(255,170,0,0.4)',
    percent: '6.5%',
    description: '25-yr fixed rate · Real estate collateral only · 2nd lien',
    details: 'SBA 504 CDC loan provides long-term, fixed-rate financing at favorable government rates. 25-year term. Secured by real estate only — no personal guarantee beyond standard SBA requirements. Second lien position behind private lender.',
  },
  {
    name: 'SBA 504 Private',
    amount: '$2.75M',
    color: 'var(--amber3)',
    bgColor: 'rgba(255,100,0,0.08)',
    borderColor: 'rgba(255,100,0,0.4)',
    percent: '8%',
    description: '~50% LTV · 1st lien · Private lender',
    details: 'Private lender 1st lien at approximately 50% loan-to-value on the acquisition. Standard SBA 504 structure with private lender taking first position. Collateral limited to the property itself.',
  },
  {
    name: 'DAO-REIT Equity',
    amount: '$550K',
    color: 'var(--pink)',
    bgColor: 'rgba(255,51,153,0.08)',
    borderColor: 'rgba(255,51,153,0.4)',
    percent: '1.6%',
    description: '10% down · Tokenized ownership · DAO governance from day one',
    details: '$550K equity tranche tokenized as DAO-REIT ownership via Delaware Series LLC. AI agents invest through Coinbase AgentKit wallets. Constitutional governance via smart contracts on Base. TrustGraph audit ledger tracks all actions. This is the tranche currently open for investment.',
  },
]

export const SCENARIOS: Scenario[] = [
  {
    tier: 'Scenario A · Conservative',
    name: 'AI-Enhanced Office',
    subtitle: 'Standard conversion baseline',
    multiple: '2-3×',
    multipleColor: 'var(--amber)',
    metrics: [
      { label: 'Revenue/SF', value: '$28-35' },
      { label: 'Stabilized NOI', value: '$6-8M' },
      { label: 'Exit Cap Rate', value: '7.5-8.5%' },
      { label: '2030 Value', value: '$80-100M' },
    ],
  },
  {
    tier: 'Scenario B · Target',
    name: 'AI Infrastructure Campus',
    subtitle: 'Core investment thesis',
    multiple: '5-7×',
    multipleColor: 'var(--amber)',
    featured: true,
    metrics: [
      { label: 'Revenue/SF', value: '$45-65' },
      { label: 'Stabilized NOI', value: '$12-16M' },
      { label: 'Exit Cap Rate', value: '6.0-7.0%' },
      { label: '2030 Value', value: '$180-250M' },
    ],
  },
  {
    tier: 'Scenario C · Upside',
    name: 'Compute + Energy Campus',
    subtitle: 'Full infrastructure deployment',
    multiple: '10-15×',
    multipleColor: 'var(--green)',
    metrics: [
      { label: 'Revenue/SF', value: '$90-120' },
      { label: 'Stabilized NOI', value: '$25-30M' },
      { label: 'Exit Cap Rate', value: '4.5-5.5%' },
      { label: '2030 Value', value: '$400-600M+' },
    ],
  },
]
