import { useState } from 'react'
import type { PaletteKey } from '../hooks/usePalette'

interface NavProps {
  scrollTo: (id: string) => void
  palette: PaletteKey
  togglePalette: () => void
}

const NAV_LINKS = [
  { id: 'cac', label: 'CAC Protocol' },
  { id: 'cac-spec', label: 'Spec Docs' },
  { id: 'agents', label: 'Agents' },
  { id: 'trustgraph', label: 'TrustGraph' },
  { id: 'bill-of-rights', label: 'Bill of Rights' },
  { id: 'capital', label: 'Capital Stack' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'agent-bank', label: 'Agent Bank' },
  { id: 'kya', label: 'KYA Protocol' },
]

export default function Nav({ scrollTo }: NavProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  const handleNavClick = (id: string) => {
    scrollTo(id)
    setMenuOpen(false)
  }

  return (
    <nav className="fixed top-0 left-0 right-0 z-[100] px-4 md:px-8 py-3.5 flex items-center justify-between border-b border-[var(--border)] bg-[rgba(6,2,0,0.85)] backdrop-blur-sm">
      <a href="#" className="font-display text-base font-bold tracking-[0.2em] text-[var(--amber)] no-underline">
        Tributary
      </a>

      {/* Desktop nav links */}
      <ul className="hidden md:flex gap-7 list-none">
        {NAV_LINKS.map(link => (
          <li key={link.id}>
            <button
              onClick={() => scrollTo(link.id)}
              className="text-[10px] tracking-[0.14em] uppercase text-[rgba(255,160,0,0.6)] hover:text-[var(--amber)] transition-colors bg-transparent border-none cursor-pointer font-mono"
            >
              {link.label}
            </button>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2 md:gap-3">
        {/* Mobile hamburger */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="md:hidden flex flex-col gap-[3px] p-2 bg-transparent border-none cursor-pointer"
          aria-label="Toggle navigation menu"
        >
          <span className={`block w-5 h-[1.5px] bg-[var(--amber)] transition-all ${menuOpen ? 'rotate-45 translate-y-[4.5px]' : ''}`} />
          <span className={`block w-5 h-[1.5px] bg-[var(--amber)] transition-all ${menuOpen ? 'opacity-0' : ''}`} />
          <span className={`block w-5 h-[1.5px] bg-[var(--amber)] transition-all ${menuOpen ? '-rotate-45 -translate-y-[4.5px]' : ''}`} />
        </button>

        <a
          href="/cuttlefishclaws/presale"
          className="text-[9px] md:text-[10px] tracking-[0.14em] uppercase py-1.5 px-3 md:px-4 border border-[var(--green)] text-[var(--green)] bg-[rgba(0,255,204,0.08)] hover:bg-[rgba(0,255,204,0.18)] transition-all font-mono no-underline whitespace-nowrap"
        >
          Reserve &rarr;
        </a>
        <button
          onClick={() => scrollTo('invest')}
          className="text-[9px] md:text-[10px] tracking-[0.14em] uppercase py-1.5 px-3 md:px-4 border border-[var(--amber2)] text-[var(--amber)] bg-[rgba(255,140,0,0.08)] hover:bg-[rgba(255,140,0,0.18)] transition-all cursor-pointer font-mono whitespace-nowrap"
        >
          Invest &rarr;
        </button>
      </div>

      {/* Mobile slide-out menu */}
      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-40 md:hidden"
            onClick={() => setMenuOpen(false)}
          />
          <div className="fixed top-[57px] left-0 right-0 z-50 md:hidden border-b border-[var(--border)] bg-[rgba(6,2,0,0.97)] backdrop-blur-sm max-h-[70vh] overflow-y-auto">
            <ul className="flex flex-col list-none py-2">
              {NAV_LINKS.map(link => (
                <li key={link.id}>
                  <button
                    onClick={() => handleNavClick(link.id)}
                    className="w-full text-left px-6 py-3 text-[10px] tracking-[0.14em] uppercase text-[rgba(255,160,0,0.6)] hover:text-[var(--amber)] hover:bg-[rgba(255,140,0,0.06)] transition-colors bg-transparent border-none cursor-pointer font-mono"
                  >
                    {link.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </nav>
  )
}
