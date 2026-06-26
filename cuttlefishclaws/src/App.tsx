import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import Nav from './components/Nav'
import Hero from './components/Hero'
import CACSection from './components/sections/CACSection'
import AgentsSection from './components/sections/AgentsSection'
import CapitalStack from './components/sections/CapitalStack'
import ContractsSection from './components/sections/ContractsSection'
import AgentBankSection from './components/sections/AgentBankSection'
import KYASection from './components/sections/KYASection'
import ReturnsSection from './components/sections/ReturnsSection'
import InvestSection from './components/sections/InvestSection'
import TrustGraphSection from './components/sections/TrustGraphSection'
import AgentBillOfRights from './components/sections/AgentBillOfRights'
import CACSpecDocs from './components/sections/CACSpecDocs'
import Footer from './components/Footer'
import AgentChatModal from './components/agents/AgentChatModal'
import { usePalette } from './hooks/usePalette'
import { useScrollReveal } from './hooks/useScrollReveal'

function App() {
  const location = useLocation()
  const { palette, togglePalette } = usePalette()
  const [chatAgent, setChatAgent] = useState<string | null>(null)
  const [showReturns, setShowReturns] = useState(false)
  const [returnsUnlocked, setReturnsUnlocked] = useState(false)

  useScrollReveal()

  // Check for /vc route or session storage
  useEffect(() => {
    if (location.pathname === '/vc' || location.hash === '#vc') {
      setShowReturns(true)
    }
    if (sessionStorage.getItem('vc_access') === '1') {
      setShowReturns(true)
      setReturnsUnlocked(true)
    }
    // Handle ?scrollTo= query param from presale page navigation
    const params = new URLSearchParams(location.search)
    const scrollTarget = params.get('scrollTo')
    if (scrollTarget) {
      // Small delay to let sections render
      setTimeout(() => {
        document.getElementById(scrollTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 200)
      // Clean the query param from URL without reload
      window.history.replaceState({}, '', location.pathname)
    }
  }, [location])

  const handleVCAccess = (code: string) => {
    if (code.toUpperCase() === import.meta.env.VITE_VC_CODE || code.toUpperCase() === 'TRIBUTARY2026') {
      sessionStorage.setItem('vc_access', '1')
      setReturnsUnlocked(true)
      return true
    }
    return false
  }

  const handleLockReturns = () => {
    sessionStorage.removeItem('vc_access')
    setReturnsUnlocked(false)
  }

  const scrollTo = (id: string) => {
    if (id === 'returns') {
      setShowReturns(true)
      setTimeout(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    } else {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  return (
    <div className="min-h-screen">
      <div className="scanline" />
      
      <Nav 
        scrollTo={scrollTo} 
        palette={palette} 
        togglePalette={togglePalette} 
      />
      
      <Hero 
        scrollTo={scrollTo}
        palette={palette}
        togglePalette={togglePalette}
      />
      
      <hr className="section-divider" />
      
      <CACSection />

      <hr className="section-divider" />

      <CACSpecDocs />

      <hr className="section-divider" />

      <AgentsSection onOpenChat={setChatAgent} />
      
      <hr className="section-divider" />

      <TrustGraphSection />

      <hr className="section-divider" />

      <AgentBillOfRights />

      <hr className="section-divider" />

      <CapitalStack />
      
      {showReturns && (
        <>
          <hr className="section-divider" />
          <ReturnsSection 
            unlocked={returnsUnlocked}
            onUnlock={handleVCAccess}
            onLock={handleLockReturns}
          />
        </>
      )}
      
      <hr className="section-divider" />
      
      <ContractsSection />

      <hr className="section-divider" />

      <AgentBankSection />

      <hr className="section-divider" />

      <KYASection />

      <hr className="section-divider" />

      <InvestSection 
        scrollTo={scrollTo}
        onShowReturns={() => setShowReturns(true)}
      />
      
      <Footer />
      
      {chatAgent && (
        <AgentChatModal 
          agentId={chatAgent} 
          onClose={() => setChatAgent(null)} 
        />
      )}
    </div>
  )
}

export default App
