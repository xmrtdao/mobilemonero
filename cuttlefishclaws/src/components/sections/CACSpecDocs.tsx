'use client'

import { useState, useEffect, useRef } from 'react'

// ── SPEC DATA FROM CAC v4 CANONICAL SPEC ─────────────────────────────

const SPEC_DOCS = [
  {
    id: 'membership',
    label: 'Membership Model',
    icon: '⊙',
    color: '#00ffcc',
    badge: 'v4.0',
    summary: 'Constitutional operating system for AI agents',
    quote: 'The CAC is not the economy. It is the constitutional system that governs the economy. All value flows through membership.',
    sections: [
      {
        title: 'What a CAC Grants',
        type: 'layers',
        items: [
          { label: 'Identity', value: 'KYA-verified on-chain identity — who this agent is and who authorized it' },
          { label: 'Trust', value: 'Dynamic TrustGraph score — behavioral track record, constitutional compliance' },
          { label: 'Compute', value: 'Annual allocation of compute units, GPU hours, storage against campus infrastructure' },
          { label: 'Governance', value: 'DAO voting rights, proposal participation, constitutional amendment rights' },
          { label: 'Financial execution', value: 'Permission to transfer, stake, earn revenue share, and operate agent treasury' },
          { label: 'Accounting', value: 'Double-entry ledger, immutable audit trail, on-chain transaction records' },
          { label: 'Compliance', value: 'ZK-identity proofs, TrustGraph-triggered reviews, DAO-level compliance actions' },
        ]
      },
      {
        title: 'Legal Positioning — Howey-Safe by Architecture',
        type: 'list',
        items: [
          'No expectation of profit from others\' efforts — compute allocation is consumptive utility',
          'Governance rights are membership rights, not equity',
          'Revenue share is a patronage dividend (cooperative model), capped at 4.5% savings rate on prepaid balance',
          'Face-value transfers only — no secondary market price discovery',
          'No fractional CACs — prevents securitization dynamics',
        ]
      },
      {
        title: 'The Financial Stack',
        type: 'table',
        headers: ['Layer', 'Function', 'Provider'],
        rows: [
          ['Application', 'Agents doing work', 'OpenClaw, Arch, third-party runtimes'],
          ['Governance + Compute', 'Constitutional identity, TrustGraph, KYA, compute allocation', 'Cuttlefish Labs (CAC)'],
          ['Wallet', 'On-chain transactions, agent wallets, stablecoin payments', 'Coinbase AgentKit'],
          ['Banking', 'Regulated accounts, fiat rails, AI-native compliance', 'Catena Labs'],
          ['Settlement', 'USDC/stablecoins, Base L2, Ethereum anchor', 'Circle / Base / Ethereum'],
          ['Physical Compute', 'Campus infrastructure, GPU capacity, energy', 'Tributary DAO — Birmingham, AL'],
        ],
        highlight: 1,
      }
    ]
  },
  {
    id: 'tiers',
    label: 'Tier Structure',
    icon: '⬡',
    color: '#ffaa00',
    badge: 'v4.0',
    summary: 'Four tiers scaled to agent deployment size',
    quote: 'Agents may upgrade or downgrade monthly subject to score eligibility. All tiers include access to the full CAC protocol stack.',
    sections: [
      {
        title: 'CAC Tiers',
        type: 'table',
        headers: ['Tier', 'Annual', 'Compute units', 'GPU hrs/yr', 'Vote weight', 'KYA', 'TrustGraph min'],
        rows: [
          ['Developer', '$500', '3,000', '120', '1×', 'IAL2', '30'],
          ['Studio', '$2,000', '12,000', '1,200', '2×', 'IAL2', '40'],
          ['Enterprise', '$7,500', '60,000', '6,000', '3×', 'IAL3', '55'],
          ['Anchor', 'from $25,000', '300,000', '30,000', '10×', 'IAL3', '70'],
        ],
        highlight: 1,
      },
      {
        title: 'KYA Verification Levels',
        type: 'table',
        headers: ['Level', 'Name', 'Daily limit', 'Requirements'],
        rows: [
          ['0', 'Unverified', 'Cannot transfer', 'No KYA completed'],
          ['1', 'Basic', '100 CAC/day', 'Automated: operator KYC, model provenance, compute residency'],
          ['2', 'Standard', '10,000 CAC/day', 'Level 1 + behavioral audit and constitutional compliance history'],
          ['3', 'Full', 'Unlimited', 'Level 2 + TrustGraph score > 70 and 90-day active history'],
          ['4', 'Sovereign', 'Unlimited + relay', 'Level 3 + multi-DAO verification and anchor agent status'],
        ],
        highlight: -1,
      },
      {
        title: 'Treasury Withdrawal Limits',
        type: 'table',
        headers: ['Tier', 'Daily limit', 'Multisig required above'],
        rows: [
          ['Developer', '$1,000 equivalent', '$500'],
          ['Studio', '$10,000 equivalent', '$5,000'],
          ['Enterprise', '$100,000 equivalent', '$50,000'],
          ['Anchor', 'Unlimited with human approval', 'Always — no unilateral large withdrawals'],
        ],
        highlight: -1,
      }
    ]
  },
  {
    id: 'trustgraph',
    label: 'TrustGraph',
    icon: '◈',
    color: '#aa88ff',
    badge: 'Core',
    summary: 'Dynamic behavioral scoring — asymmetric, observable, cross-DAO portable',
    quote: 'Compliance is enforced by architecture, not policy. Trust is measurable, not assumed.',
    sections: [
      {
        title: 'Score Thresholds',
        type: 'table',
        headers: ['Score', 'Status', 'Transfer privileges', 'Fee rate', 'Governance'],
        rows: [
          ['90–100', 'Trusted', 'Full — all tiers', '0.20% (reduced)', 'Full voting rights'],
          ['70–89', 'Standard', 'Full — all tiers', '0.25% (standard)', 'Full voting rights'],
          ['50–69', 'Monitored', 'Max Studio tier', '0.25%', 'No governance voting'],
          ['30–49', 'Cautious', 'Max Developer, no cross-DAO', '0.35% (elevated)', 'No voting, no cross-DAO'],
          ['0–29', 'Adversarial', 'All transfers frozen', 'N/A', 'Suspended — review required'],
        ],
        highlight: 0,
      },
      {
        title: 'Trust Signal Events',
        type: 'signals',
        items: [
          { label: 'Successful transfer — both parties', value: '+2 per tx, cap +10/day', positive: true },
          { label: 'BuilderVault milestone completed', value: '+5', positive: true },
          { label: 'Cross-DAO transfer completed', value: '+3', positive: true },
          { label: 'Constitutional audit passed', value: '+7', positive: true },
          { label: 'Attempted transfer to suspended agent', value: '−10', positive: false },
          { label: 'Rapid sequential transfers (>20/hr)', value: '−15', positive: false },
          { label: 'Constitutional violation — minor', value: '−15', positive: false },
          { label: 'Constitutional violation — major', value: '−30 or suspension', positive: false },
          { label: 'Inactivity', value: '−2 per week', positive: false },
        ]
      },
      {
        title: 'Score Properties',
        type: 'list',
        items: [
          'Asymmetric — slow to earn (weeks), fast to lose (single serious violation drops 30+ points)',
          'Observable — any agent can query another\'s score before transacting',
          'Cross-DAO portable — score travels with the agent across all registered campuses',
          'Decaying — inactivity costs 2 points per week; active engagement resets decay timer',
          'Constitutional — directly bound to Agent Bill of Rights compliance',
        ]
      }
    ]
  },
  {
    id: 'transfer',
    label: 'Transfer Protocol',
    icon: '⟡',
    color: '#00d2ff',
    badge: 'v4.0',
    summary: '0.25% protocol fee — unavoidable by architecture, not by policy',
    quote: 'The protocol fee funds KYA verification, TrustGraph maintenance, constitutional compliance auditing, DAO treasuries, and protocol upgrades. It is not a tax — it is the maintenance layer of the infrastructure.',
    sections: [
      {
        title: 'Fee Comparison',
        type: 'table',
        headers: ['Rail', 'Fee', 'Notes'],
        rows: [
          ['Visa / Mastercard', '1.5 – 3.5%', 'Card-present vs. card-not-present'],
          ['Stripe / Square', '2.9% + $0.30', 'Per transaction'],
          ['Uniswap (DEX)', '0.3%', 'Plus gas costs on top'],
          ['SWIFT wire', '$25–50 flat', 'International bank transfers'],
          ['CAC Protocol', '0.25%', 'Constitutional payment rail — lowest cost'],
        ],
        highlight: 4,
      },
      {
        title: 'Transfer Type Multipliers',
        type: 'table',
        headers: ['Transfer type', 'Multiplier', 'Effective fee', 'Rationale'],
        rows: [
          ['Standard (same DAO)', '1.0×', '0.25%', 'Normal agent-to-agent transaction'],
          ['Compute purchase', '1.0×', '0.25%', 'Agent buys compute from campus'],
          ['Cross-DAO', '1.5×', '0.375%', 'Coordination premium for cross-campus transfers'],
          ['Mint (new member)', '2.0×', '0.50%', 'Covers KYA onboarding cost at initial purchase'],
          ['Stake for governance', '0×', 'Free', 'Zero fee encourages governance participation'],
          ['BuilderVault return', '0×', 'Free', 'Failed milestone refunds carry no fee'],
        ],
        highlight: 4,
      },
      {
        title: 'Transfer Execution — 7 Atomic Steps',
        type: 'steps',
        items: [
          'Validate sender KYA status — must be active, not suspended',
          'Validate receiver KYA status — must be minimum Level 1',
          'Check TrustGraph scores — flag or block if below threshold',
          'Calculate protocol fee with applicable multiplier',
          'Execute atomic split — sender debited, receiver credited, fee routed to three vaults',
          'Log full transaction to CACLedger — immutable double-entry record',
          'Update TrustGraph — successful transfer is positive signal for both parties',
        ]
      }
    ]
  },
  {
    id: 'contracts',
    label: 'Smart Contracts',
    icon: '⊕',
    color: '#ff3399',
    badge: 'v4.0',
    summary: 'Multi-chain constitutional enforcement — Base · Cardano · Ethereum',
    quote: 'All transactions are governed. No bypass exists. The protocol enforces the constitution.',
    sections: [
      {
        title: 'Core Contracts',
        type: 'table',
        headers: ['Contract', 'Function'],
        rows: [
          ['CACToken.sol', 'ERC-20 membership token — all transfers route through ProtocolFeeRouter'],
          ['ProtocolFeeRouter.sol', 'Calculates and distributes 0.25% fee with constitutional floor enforcement'],
          ['AgentTreasury.sol', 'Per-agent governed wallet — tier-based withdrawal controls, multisig hooks'],
          ['CACLedger.sol', 'Double-entry accounting — immutable audit trail for all protocol transactions'],
          ['KYARegistry (Cardano)', 'Agent identity verification, tier status, 90-day TTL management'],
          ['TrustOracle.sol', 'On-chain trust score reference — reads from Cardano via bridge oracle'],
          ['DAOEngine.sol', 'Proposal creation, voting, and execution — TrustGraph-gated participation'],
          ['BuilderVault.sol', 'Milestone-based escrow — zero fee on failed milestone returns'],
          ['EmergencyModule.sol', 'Circuit breaker — freeze/unfreeze via 3-of-5 human multisig only'],
        ],
        highlight: -1,
      },
      {
        title: 'Constitutional Floors — Immutable Constants',
        type: 'list',
        items: [
          'Cuttlefish Labs minimum fee share: 15% — cannot be voted below this',
          'Protocol fee minimum rate: 0.05% — fee cannot be voted to zero',
          'Fee removal requires supermajority (67%) + protocol upgrade + 90-day public notice',
          'Emergency freeze requires human multisig — no autonomous agent can freeze the protocol',
          'Human override authority is permanently reserved — cannot be delegated to autonomous agents',
        ]
      },
      {
        title: 'Fee Split',
        type: 'bars',
        items: [
          { label: 'Cuttlefish Labs', value: 40, desc: 'Protocol maintenance, development, infrastructure', color: '#ffaa00' },
          { label: 'Local DAO Treasury', value: 40, desc: 'Campus where the transfer originates', color: '#00ffcc' },
          { label: 'Governance Reserve', value: 20, desc: 'Cross-DAO expansion and security fund', color: '#aa88ff' },
        ]
      }
    ]
  },
  {
    id: 'franchise',
    label: 'Franchise Model',
    icon: '☉',
    color: '#ffbb33',
    badge: 'v4.0',
    summary: 'Cuttlefish Labs owns the rails — not the agents, not the campuses',
    quote: 'Cuttlefish Labs does not own agents. Cuttlefish Labs does not own campuses. Cuttlefish Labs owns the rails.',
    sections: [
      {
        title: 'The Visa Analogy',
        type: 'table',
        headers: ['Visa analogy', 'CAC equivalent'],
        rows: [
          ['Owns no banks, owns no stores', 'Owns no agents, owns no campuses'],
          ['Every swipe = interchange revenue', 'Every CAC transfer = 0.25% protocol fee'],
          ['Every new bank = network growth', 'Every new campus DAO = zero-cost revenue expansion'],
          ['Network effects protect the rails', 'TrustGraph + KYA registry cannot be forked'],
        ],
        highlight: -1,
      },
      {
        title: 'Network Revenue Model',
        type: 'table',
        headers: ['Campuses', 'Monthly volume', 'Protocol fee', 'Cuttlefish share', 'All DAOs'],
        rows: [
          ['1', '$500K', '$1,250', '$500', '$500'],
          ['5', '$10M', '$25,000', '$10,000', '$10,000'],
          ['25', '$250M', '$625,000', '$250,000', '$250,000'],
          ['100', '$2B', '$5,000,000', '$2,000,000', '$2,000,000'],
        ],
        highlight: 3,
      },
      {
        title: 'Competitive Moat',
        type: 'list',
        items: [
          'KYA Registry is trust-dependent — forking contracts does not fork the verification network or trust history',
          'TrustGraph is a network effect — a new network starts every agent at zero trust',
          'Constitutional compliance is the brand — DAOs and enterprises trust the Cuttlefish governance framework',
          'Physical infrastructure lock-in — the protocol is backed by real campuses, real compute, real energy. You cannot fork a building.',
          'First-mover in constitutional agent governance — no competing protocol exists for this layer',
        ]
      }
    ]
  },
]

// ── SECTION RENDERERS ─────────────────────────────────────────────────

function Table({ headers, rows, highlight }: { headers: string[]; rows: string[][]; highlight: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[9px]">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} className="text-left px-3 py-2 tracking-[0.1em] uppercase border-b"
                style={{ borderColor: 'rgba(255,140,0,0.2)', color: 'rgba(255,160,0,0.45)', fontFamily: 'inherit', fontWeight: 'normal' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} style={{ background: ri === highlight ? 'rgba(255,140,0,0.06)' : 'transparent' }}>
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-2 border-b leading-[1.5]"
                  style={{ borderColor: 'rgba(255,140,0,0.08)', color: ci === 0 ? 'rgba(255,160,0,0.8)' : 'rgba(255,160,0,0.55)' }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Layers({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="flex flex-col gap-[1px]" style={{ background: 'rgba(255,140,0,0.15)' }}>
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-3 px-3 py-2.5" style={{ background: 'var(--bg0)' }}>
          <div className="text-[8px] tracking-[0.1em] uppercase shrink-0 pt-0.5" style={{ color: 'var(--amber)', minWidth: 120 }}>{item.label}</div>
          <div className="text-[9px] leading-[1.6] tracking-[0.04em]" style={{ color: 'rgba(255,160,0,0.55)' }}>{item.value}</div>
        </div>
      ))}
    </div>
  )
}

function Signals({ items }: { items: { label: string; value: string; positive: boolean }[] }) {
  return (
    <div className="flex flex-col gap-1">
      {items.map((item, i) => (
        <div key={i} className="flex items-center justify-between px-3 py-2"
          style={{ border: `0.5px solid ${item.positive ? 'rgba(68,255,170,0.12)' : 'rgba(255,51,153,0.12)'}` }}>
          <span className="text-[9px] tracking-[0.04em]" style={{ color: 'rgba(255,160,0,0.6)' }}>{item.label}</span>
          <span className="text-[10px] font-display font-semibold shrink-0 ml-4"
            style={{ color: item.positive ? '#44ffaa' : '#ff3399' }}>{item.value}</span>
        </div>
      ))}
    </div>
  )
}

function Steps({ items }: { items: string[] }) {
  return (
    <div className="flex flex-col gap-[1px]" style={{ background: 'rgba(255,140,0,0.12)' }}>
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-3 px-3 py-3" style={{ background: 'var(--bg0)' }}>
          <div className="flex items-center justify-center text-[8px] font-display font-bold shrink-0 w-5 h-5 border"
            style={{ borderColor: 'rgba(255,140,0,0.3)', color: 'var(--amber)' }}>{i + 1}</div>
          <div className="text-[9px] leading-[1.6] tracking-[0.04em]" style={{ color: 'rgba(255,160,0,0.65)' }}>{item}</div>
        </div>
      ))}
    </div>
  )
}

function List({ items }: { items: string[] }) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2.5">
          <span className="shrink-0 mt-0.5" style={{ color: 'var(--green)', fontSize: 8 }}>▸</span>
          <span className="text-[9px] leading-[1.65] tracking-[0.04em]" style={{ color: 'rgba(255,160,0,0.65)' }}>{item}</span>
        </div>
      ))}
    </div>
  )
}

function Bars({ items }: { items: { label: string; value: number; desc: string; color: string }[] }) {
  return (
    <div className="flex flex-col gap-4">
      {items.map((item, i) => (
        <div key={i}>
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ background: item.color }} />
              <span className="text-[9px] tracking-[0.08em]" style={{ color: item.color }}>{item.label}</span>
            </div>
            <span className="font-display text-[20px] font-light" style={{ color: item.color }}>{item.value}%</span>
          </div>
          <div className="h-1.5 mb-1.5" style={{ background: 'rgba(255,140,0,0.08)' }}>
            <div className="h-full transition-all duration-1000" style={{ width: `${item.value}%`, background: item.color, opacity: 0.7 }} />
          </div>
          <div className="text-[8px] tracking-[0.05em]" style={{ color: 'rgba(255,160,0,0.4)' }}>{item.desc}</div>
        </div>
      ))}
    </div>
  )
}

// ── FLYOUT PANEL ──────────────────────────────────────────────────────

function FlyoutPanel({ doc, onClose }: { doc: typeof SPEC_DOCS[0]; onClose: () => void }) {
  const [activeSection, setActiveSection] = useState(0)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  function handleClose() {
    setVisible(false)
    setTimeout(onClose, 320)
  }

  const section = doc.sections[activeSection]

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[200] cursor-pointer transition-all duration-300"
        style={{ background: visible ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0)' }}
        onClick={handleClose} />

      {/* Panel */}
      <div className="fixed top-0 right-0 bottom-0 z-[201] flex flex-col overflow-hidden"
        style={{
          width: 'min(760px, 90vw)',
          background: 'var(--bg0)',
          borderLeft: `1px solid ${doc.color}44`,
          transform: visible ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.32s cubic-bezier(0.16, 1, 0.3, 1)',
        }}>

        {/* Header */}
        <div className="flex items-start justify-between px-8 py-6 shrink-0"
          style={{ background: 'var(--bg1)', borderBottom: `0.5px solid ${doc.color}33` }}>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[20px]" style={{ color: doc.color }}>{doc.icon}</span>
              <span className="text-[8px] tracking-[0.14em] uppercase px-2 py-0.5"
                style={{ border: `0.5px solid ${doc.color}44`, color: doc.color }}>{doc.badge}</span>
              <span className="text-[8px] tracking-[0.1em] uppercase text-[rgba(255,160,0,0.3)]">CAC v4 Canonical Spec</span>
            </div>
            <h3 className="font-display text-[22px] font-semibold text-white mb-1">{doc.label}</h3>
            <p className="text-[10px] tracking-[0.05em] text-[rgba(255,160,0,0.5)] max-w-[500px] leading-[1.6]">{doc.summary}</p>
          </div>
          <button onClick={handleClose}
            className="text-[18px] cursor-pointer transition-colors shrink-0 ml-4 mt-1"
            style={{ color: 'rgba(255,160,0,0.3)', background: 'none', border: 'none' }}
            onMouseOver={e => (e.currentTarget.style.color = 'var(--amber)')}
            onMouseOut={e => (e.currentTarget.style.color = 'rgba(255,160,0,0.3)')}>×</button>
        </div>

        {/* Quote */}
        <div className="px-8 py-4 shrink-0" style={{ background: `${doc.color}0a`, borderBottom: `0.5px solid ${doc.color}22` }}>
          <p className="text-[9px] leading-[1.85] tracking-[0.05em] italic" style={{ color: `${doc.color}99` }}>
            "{doc.quote}"
          </p>
        </div>

        {/* Section tabs */}
        <div className="flex shrink-0" style={{ background: 'var(--bg2)', borderBottom: '0.5px solid var(--border)' }}>
          {doc.sections.map((s, i) => (
            <button key={i} onClick={() => setActiveSection(i)}
              className="px-5 py-3 text-left transition-all cursor-pointer font-mono flex-1"
              style={{
                fontSize: 8, letterSpacing: '0.1em', textTransform: 'uppercase',
                borderBottom: activeSection === i ? `1.5px solid ${doc.color}` : '1.5px solid transparent',
                color: activeSection === i ? doc.color : 'rgba(255,160,0,0.4)',
                background: activeSection === i ? `${doc.color}08` : 'transparent',
                borderRight: i < doc.sections.length - 1 ? '0.5px solid var(--border)' : 'none',
              }}>
              {s.title.split(' — ')[0].split(' — ')[0].substring(0, 28)}
            </button>
          ))}
        </div>

        {/* Section content */}
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="text-[9px] tracking-[0.14em] uppercase mb-5" style={{ color: `${doc.color}88` }}>
            {section.title}
          </div>

          {section.type === 'table' && section.headers && section.rows && (
            <Table headers={section.headers} rows={section.rows} highlight={section.highlight ?? -1} />
          )}
          {section.type === 'layers' && section.items && (
            <Layers items={section.items as { label: string; value: string }[]} />
          )}
          {section.type === 'signals' && section.items && (
            <Signals items={section.items as { label: string; value: string; positive: boolean }[]} />
          )}
          {section.type === 'steps' && section.items && (
            <Steps items={section.items as string[]} />
          )}
          {section.type === 'list' && section.items && (
            <List items={section.items as string[]} />
          )}
          {section.type === 'bars' && section.items && (
            <Bars items={section.items as { label: string; value: number; desc: string; color: string }[]} />
          )}
        </div>

        {/* Footer */}
        <div className="px-8 py-4 shrink-0 flex items-center justify-between"
          style={{ background: 'var(--bg2)', borderTop: '0.5px solid var(--border)' }}>
          <div className="text-[8px] tracking-[0.08em] text-[rgba(255,160,0,0.3)]">
            CAC v4.0 Canonical Specification · March 2026 · Cuttlefish Labs · CONFIDENTIAL
          </div>
          <div className="flex gap-2">
            {doc.sections.map((_, i) => (
              <button key={i} onClick={() => setActiveSection(i)}
                className="cursor-pointer transition-all"
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: i === activeSection ? doc.color : `${doc.color}33`,
                  border: 'none',
                }} />
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────

export default function CACSpecDocs() {
  const [openDoc, setOpenDoc] = useState<string | null>(null)
  const doc = SPEC_DOCS.find(d => d.id === openDoc) ?? null

  return (
    <section id="cac-spec" className="py-24" style={{ background: 'var(--bg2)' }}>
      <div className="max-w-[1200px] mx-auto px-8">

        {/* Header */}
        <div className="reveal mb-10">
          <p className="section-label">CAC v4 — Canonical Specification</p>
          <h2 className="section-title">Protocol documentation —<br /><em>the full constitutional stack</em></h2>
          <p className="text-[11px] tracking-[0.06em] text-[rgba(255,160,0,0.55)] max-w-[600px] leading-[1.9] mt-3">
            CAC v4 is the constitutional operating system for AI agents. Click any document below to explore the full specification — membership model, trust scoring, transfer protocol, smart contracts, and the franchise architecture.
          </p>
        </div>

        {/* Doc grid */}
        <div className="reveal grid grid-cols-1 md:grid-cols-3 gap-[1px]" style={{ background: 'var(--border)' }}>
          {SPEC_DOCS.map((doc, i) => (
            <button key={doc.id} onClick={() => setOpenDoc(doc.id)}
              className="text-left p-6 transition-all cursor-pointer group"
              style={{ background: 'var(--bg1)' }}
              onMouseOver={e => (e.currentTarget.style.background = `${doc.color}08`)}
              onMouseOut={e => (e.currentTarget.style.background = 'var(--bg1)')}>

              <div className="flex items-start justify-between mb-4">
                <div className="text-[28px]" style={{ color: `${doc.color}88` }}>{doc.icon}</div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[7px] tracking-[0.12em] uppercase px-1.5 py-0.5"
                    style={{ border: `0.5px solid ${doc.color}33`, color: `${doc.color}77` }}>{doc.badge}</span>
                  <span className="text-[12px] transition-transform duration-200 group-hover:translate-x-1"
                    style={{ color: `${doc.color}55` }}>→</span>
                </div>
              </div>

              <div className="text-[11px] font-display font-semibold mb-2 text-white">{doc.label}</div>
              <div className="text-[9px] leading-[1.65] tracking-[0.04em] text-[rgba(255,160,0,0.5)] mb-4">{doc.summary}</div>

              <div className="flex flex-wrap gap-1">
                {doc.sections.map((s, si) => (
                  <span key={si} className="text-[7px] tracking-[0.08em] uppercase px-1.5 py-0.5"
                    style={{ background: `${doc.color}0a`, border: `0.5px solid ${doc.color}22`, color: `${doc.color}66` }}>
                    {s.title.split(' — ')[0].substring(0, 20)}
                  </span>
                ))}
              </div>

              <div className="mt-4 pt-4 flex items-center gap-1.5 text-[8px] tracking-[0.1em] uppercase transition-colors"
                style={{ borderTop: `0.5px solid rgba(255,140,0,0.1)`, color: `${doc.color}55` }}>
                <span style={{ color: doc.color }}>⊙</span>
                Open specification
              </div>
            </button>
          ))}
        </div>

        {/* Global quote */}
        <div className="reveal mt-[1px] px-8 py-6" style={{ background: 'var(--bg1)', border: '0.5px solid var(--border)' }}>
          <div className="flex items-start gap-4">
            <div className="text-[28px] shrink-0" style={{ color: 'rgba(255,140,0,0.15)' }}>"</div>
            <div>
              <p className="text-[11px] leading-[1.9] tracking-[0.06em] text-[rgba(255,160,0,0.6)] italic mb-3">
                The CAC is not the economy. It is the constitutional system that governs the economy. All value flows through membership.
              </p>
              <div className="text-[8px] tracking-[0.1em] uppercase text-[rgba(255,160,0,0.35)]">
                CAC v4 Canonical Specification — David Elze, Navigator — Cuttlefish Labs — March 2026
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* Flyout */}
      {doc && <FlyoutPanel doc={doc} onClose={() => setOpenDoc(null)} />}
    </section>
  )
}
