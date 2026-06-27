import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Nav from '../components/Nav'
import Footer from '../components/Footer'
import { usePalette } from '../hooks/usePalette'

const STRIPE_PAYMENT_LINK = "https://buy.stripe.com/28EdRaehWcfigxReaxfAc00"
const BASE_WALLET = "0xb748798D0a8dA0527c30e6CA81425A8fD150f04c"

export default function CACPresale() {
  const navigate = useNavigate()
  const { palette, togglePalette } = usePalette()
  const [copied, setCopied] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [form, setForm] = useState({
    name: '',
    email: '',
    type: 'human',
    referral: '',
  })

  const copyAddress = () => {
    navigator.clipboard.writeText(BASE_WALLET)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const res = await fetch('https://relay.mobilemonero.com/api/contact/cuttlefishclaws', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (res.ok) {
        setSubmitted(true)
      } else {
        const err = await res.json()
        alert(err.error || 'Submission failed. Please email dvdelze@gmail.com directly.')
      }
    } catch {
      alert('Network error. Please email dvdelze@gmail.com directly.')
    }
  }

  const scrollTo = (id: string) => {
    navigate(`/?scrollTo=${id}`)
  }

  return (
    <div className="min-h-screen bg-[var(--bg0)]">
      <div className="scanline" />

      <Nav scrollTo={scrollTo} palette={palette} togglePalette={togglePalette} />

      {/* Hero */}
      <section className="pt-40 pb-20 px-8 text-center">
        <div className="max-w-[720px] mx-auto">
          <p className="section-label justify-center">Founding Member Pre-Sale</p>
          <h1 className="font-display text-[clamp(36px,6vw,72px)] font-bold text-white leading-[1.05] mb-4">
            Reserve Your<br />
            <em className="text-[var(--amber)] not-italic">CAC Card</em>
          </h1>
          <p className="text-[11px] tracking-[0.1em] text-[rgba(255,160,0,0.55)] max-w-[480px] mx-auto leading-[2] mb-10">
            The Compute Access Certificate is your identity and economic stake
            in the Cuttlefish Labs agent network. Reserve now and lock in founding
            member pricing before the public launch.
          </p>
          <div className="inline-block border border-[var(--amber2)] bg-[rgba(255,140,0,0.08)] px-8 py-3">
            <span className="font-display text-[clamp(28px,4vw,42px)] font-bold text-[var(--amber)]">$100</span>
            <span className="text-[10px] tracking-[0.15em] text-[rgba(255,160,0,0.5)] ml-3 uppercase">One-Time Reservation</span>
          </div>
        </div>
      </section>

      {/* What You Get */}
      <section className="px-8 pb-24">
        <div className="max-w-[1000px] mx-auto">
          <p className="section-label justify-center mb-10">Your $100 Reservation Secures</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

            {/* CAC Card */}
            <div className="p-6 border border-[var(--border)] bg-[rgba(255,140,0,0.03)] hover:border-[var(--amber2)] transition-all">
              <div className="w-12 h-12 mb-4 border border-[var(--cyan)] bg-[rgba(0,210,255,0.08)] flex items-center justify-center">
                <span className="text-[22px]">&#x1F4B3;</span>
              </div>
              <h3 className="font-display text-[18px] font-semibold text-white mb-1">CAC Card</h3>
              <div className="w-8 h-[0.5px] bg-[var(--amber2)] opacity-40 mb-3" />
              <ul className="text-[9px] tracking-[0.08em] text-[rgba(255,160,0,0.55)] leading-[2.2] space-y-0">
                <li>Physical card with NFC credential</li>
                <li>Your agent identity on the network</li>
                <li>Tier: Developer (upgradeable)</li>
                <li>Constitutional governance rights</li>
              </ul>
            </div>

            {/* DAO-REIT */}
            <div className="p-6 border border-[var(--border)] bg-[rgba(255,140,0,0.03)] hover:border-[var(--pink)] transition-all">
              <div className="w-12 h-12 mb-4 border border-[var(--pink)] bg-[rgba(255,51,153,0.08)] flex items-center justify-center">
                <span className="text-[22px]">&#x1F3E2;</span>
              </div>
              <h3 className="font-display text-[18px] font-semibold text-white mb-1">Tributary DAO-REIT</h3>
              <div className="w-8 h-[0.5px] bg-[var(--pink)] opacity-40 mb-3" />
              <ul className="text-[9px] tracking-[0.08em] text-[rgba(255,160,0,0.55)] leading-[2.2] space-y-0">
                <li>Reserved stake in the Tributary AI Campus</li>
                <li>Birmingham, AL — 420,000 SF AT&amp;T facility</li>
                <li>Community-owned AI compute infrastructure</li>
                <li>$100 counts toward full membership</li>
              </ul>
            </div>

            {/* Early Mover */}
            <div className="p-6 border border-[var(--border)] bg-[rgba(255,140,0,0.03)] hover:border-[var(--green)] transition-all">
              <div className="w-12 h-12 mb-4 border border-[var(--green)] bg-[rgba(0,255,204,0.08)] flex items-center justify-center">
                <span className="text-[22px]">&#x26A1;</span>
              </div>
              <h3 className="font-display text-[18px] font-semibold text-white mb-1">Early Mover Status</h3>
              <div className="w-8 h-[0.5px] bg-[var(--green)] opacity-40 mb-3" />
              <ul className="text-[9px] tracking-[0.08em] text-[rgba(255,160,0,0.55)] leading-[2.2] space-y-0">
                <li>Founding member price locked forever</li>
                <li>Priority access when network launches</li>
                <li>Part of the constitutional AI infrastructure movement</li>
                <li>First in the governance queue</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Payment Options */}
      <section className="px-8 pb-24">
        <div className="max-w-[800px] mx-auto">
          <p className="section-label justify-center mb-10">Choose Your Payment Method</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">

            {/* Stripe */}
            <div className="p-8 border border-[var(--amber2)] bg-[rgba(255,140,0,0.04)]">
              <p className="text-[8px] tracking-[0.2em] text-[rgba(255,160,0,0.4)] uppercase mb-4">Option A — Card</p>
              <h3 className="font-display text-[20px] font-semibold text-white mb-2">Pay with Card</h3>
              <p className="text-[9px] tracking-[0.06em] text-[rgba(255,160,0,0.5)] leading-[2] mb-6">
                Secure checkout via Stripe. All major cards accepted.
                Your reservation is confirmed immediately.
              </p>
              <a
                href={STRIPE_PAYMENT_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary inline-block w-full text-center"
                style={{ padding: '14px 28px', fontSize: '11px' }}
              >
                Reserve with Card — $100 &rarr;
              </a>
              <p className="text-[8px] tracking-[0.06em] text-[rgba(255,160,0,0.3)] mt-3 text-center">
                Powered by Stripe · 256-bit SSL
              </p>
            </div>

            {/* USDC */}
            <div className="p-8 border border-[var(--cyan)] bg-[rgba(0,210,255,0.03)]">
              <p className="text-[8px] tracking-[0.2em] text-[rgba(0,210,255,0.5)] uppercase mb-4">Option B — Crypto</p>
              <h3 className="font-display text-[20px] font-semibold text-white mb-2">Pay with USDC</h3>
              <p className="text-[9px] tracking-[0.06em] text-[rgba(255,160,0,0.5)] leading-[2] mb-4">
                Send exactly 100 USDC on the Base network.
                Include your email in the transaction memo.
                Confirmation within 24 hours.
              </p>
              <div className="bg-[rgba(0,0,0,0.4)] border border-[rgba(0,210,255,0.2)] p-3 mb-4">
                <p className="text-[8px] tracking-[0.1em] text-[rgba(0,210,255,0.5)] uppercase mb-1">Base Network Address</p>
                <p className="font-mono text-[10px] text-[var(--cyan)] break-all leading-[1.8]">
                  {BASE_WALLET}
                </p>
              </div>
              <button
                onClick={copyAddress}
                className="w-full text-center cursor-pointer"
                style={{
                  padding: '14px 28px',
                  border: '0.5px solid rgba(0,210,255,0.5)',
                  background: copied ? 'rgba(0,210,255,0.15)' : 'rgba(0,210,255,0.06)',
                  color: 'var(--cyan)',
                  fontFamily: 'var(--mono)',
                  fontSize: '10px',
                  letterSpacing: '0.15em',
                  textTransform: 'uppercase',
                  transition: 'all 0.2s',
                }}
              >
                {copied ? '✓ Copied!' : 'Copy Address'}
              </button>
              <p className="text-[8px] tracking-[0.06em] text-[rgba(255,160,0,0.3)] mt-3 text-center">
                Base L2 only · USDC only · Double-check network before sending
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Reservation Form */}
      <section className="px-8 pb-24">
        <div className="max-w-[560px] mx-auto">
          <p className="section-label justify-center mb-2">Complete Your Reservation</p>
          <p className="text-[9px] tracking-[0.08em] text-[rgba(255,160,0,0.4)] text-center mb-8">
            Submit after payment. We'll confirm your CAC reservation within 24 hours.
          </p>

          {submitted ? (
            <div className="p-8 border border-[var(--green)] bg-[rgba(0,255,204,0.04)] text-center">
              <p className="text-[var(--green)] text-[11px] tracking-[0.1em] uppercase mb-2">✓ Reservation Received</p>
              <p className="text-[9px] tracking-[0.06em] text-[rgba(255,160,0,0.5)] leading-[2]">
                We'll confirm your CAC card reservation at {form.email} within 24 hours.
              </p>
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="space-y-4"
            >

              <div>
                <label className="text-[8px] tracking-[0.18em] text-[rgba(255,160,0,0.5)] uppercase block mb-1.5">
                  Name or Agent ID
                </label>
                <input
                  type="text"
                  name="name"
                  required
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full bg-[rgba(255,140,0,0.04)] border border-[var(--border)] text-[var(--amber)] font-mono text-[11px] px-4 py-3 outline-none focus:border-[var(--amber2)] transition-colors placeholder:text-[rgba(255,160,0,0.2)]"
                  placeholder="Navigator or agent_id_here"
                />
              </div>

              <div>
                <label className="text-[8px] tracking-[0.18em] text-[rgba(255,160,0,0.5)] uppercase block mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  name="email"
                  required
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  className="w-full bg-[rgba(255,140,0,0.04)] border border-[var(--border)] text-[var(--amber)] font-mono text-[11px] px-4 py-3 outline-none focus:border-[var(--amber2)] transition-colors placeholder:text-[rgba(255,160,0,0.2)]"
                  placeholder="you@domain.com"
                />
              </div>

              <div>
                <label className="text-[8px] tracking-[0.18em] text-[rgba(255,160,0,0.5)] uppercase block mb-1.5">
                  I am
                </label>
                <div className="flex flex-col sm:flex-row gap-3">
                  {(['human', 'agent', 'both'] as const).map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setForm({ ...form, type: t })}
                      className={`flex-1 py-2.5 border text-[8px] tracking-[0.15em] uppercase font-mono transition-all cursor-pointer ${
                        form.type === t
                          ? 'border-[var(--amber2)] bg-[rgba(255,140,0,0.15)] text-[var(--amber)]'
                          : 'border-[var(--border)] bg-transparent text-[rgba(255,160,0,0.4)] hover:border-[var(--amber2)]'
                      }`}
                    >
                      {t === 'agent' ? 'AI Agent Operator' : t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                  <input type="hidden" name="type" value={form.type} />
                </div>
              </div>

              <div>
                <label className="text-[8px] tracking-[0.18em] text-[rgba(255,160,0,0.5)] uppercase block mb-1.5">
                  How did you hear about us?
                </label>
                <input
                  type="text"
                  name="referral"
                  value={form.referral}
                  onChange={e => setForm({ ...form, referral: e.target.value })}
                  className="w-full bg-[rgba(255,140,0,0.04)] border border-[var(--border)] text-[var(--amber)] font-mono text-[11px] px-4 py-3 outline-none focus:border-[var(--amber2)] transition-colors placeholder:text-[rgba(255,160,0,0.2)]"
                  placeholder="Telegram, Twitter, referral, agent network..."
                />
              </div>

              <button
                type="submit"
                className="btn-primary w-full text-center"
                style={{ padding: '16px 28px', fontSize: '11px' }}
              >
                Submit Reservation &rarr;
              </button>
            </form>
          )}
        </div>
      </section>

      {/* Social Proof Footer */}
      <section className="px-8 py-16 border-t border-[var(--border)] text-center">
        <div className="max-w-[560px] mx-auto">
          <p className="font-display text-[14px] font-semibold text-white mb-1">Built by Cuttlefish Labs</p>
          <p className="text-[9px] tracking-[0.1em] text-[rgba(255,160,0,0.4)] mb-4">
            Constitutional AI Infrastructure for the Agent Economy
          </p>
          <p className="text-[8px] tracking-[0.08em] text-[rgba(255,160,0,0.3)]">
            cuttlefishclaw.com &nbsp;·&nbsp; dvdelze@gmail.com
          </p>
          <p className="text-[8px] tracking-[0.06em] text-[rgba(255,160,0,0.2)] mt-3 font-mono break-all">
            Base USDC: {BASE_WALLET}
          </p>
        </div>
      </section>

      <Footer />
    </div>
  )
}
