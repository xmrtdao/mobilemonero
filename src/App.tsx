import { useState, useEffect } from 'react'
import {
  Wallet, Activity, Cpu, Globe, Zap, TrendingUp, AlertCircle, CheckCircle,
  ArrowUpRight, ArrowDownRight, Clock, Smartphone, Wifi, WifiOff,
  Bot, ChevronLeft, Settings, Copy, RefreshCw, Send, Download, X
} from 'lucide-react'
import { translations } from './translations'
import MeshTab from './tabs/Mesh'
import SettingsTab from './tabs/Settings'

/* ─── IndexedDB ─── */
function openDB() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('mobilemonero_v1', 2)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('workers'))
        db.createObjectStore('workers', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('stats'))
        db.createObjectStore('stats', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('settings'))
        db.createObjectStore('settings', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('ollama_chat'))
        db.createObjectStore('ollama_chat', { keyPath: 'id', autoIncrement: true })
    }
  })
}
async function dbPut(store: string, item: any) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    const os = tx.objectStore(store)
    const req = os.put(item)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => db.close()
  })
}
async function dbGetAll(store: string): Promise<any[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result ?? [])
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => db.close()
  })
}

/* ─── Types ─── */
interface Worker {
  id: string
  name: string
  device: string
  hashrate: number
  accepted: number
  rejected: number
  uptimeSec: number
  lastSeen: number
  status: 'online' | 'offline' | 'idle'
  poolUrl: string
  wallet: string
}

interface Stats {
  totalHashrate: number
  totalAccepted: number
  totalRejected: number
  estimatedDailyXmr: number
  xmrPrice: number
  networkDifficulty: string
  blockHeight: number
}

/* ─── Simulated local data ─── */
const DEMO_WORKERS: Worker[] = [
  { id: 'w1', name: 'Phone Alpha', device: 'Pixel 8 Pro (Tensor G3)', hashrate: 842, accepted: 1247, rejected: 3, uptimeSec: 86400 * 2 + 3600, lastSeen: Date.now(), status: 'online', poolUrl: 'pool.supportxmr.com:3333', wallet: '4A...Z9' },
  { id: 'w2', name: 'Phone Beta', device: 'Galaxy S24 (Exynos 2400)', hashrate: 715, accepted: 982, rejected: 1, uptimeSec: 86400 + 18000, lastSeen: Date.now() - 300000, status: 'online', poolUrl: 'pool.supportxmr.com:3333', wallet: '4A...Z9' },
  { id: 'w3', name: 'Phone Gamma', device: 'OnePlus 12 (Snapdragon 8)', hashrate: 0, accepted: 4321, rejected: 12, uptimeSec: 0, lastSeen: Date.now() - 3600000, status: 'offline', poolUrl: 'pool.supportxmr.com:3333', wallet: '4A...Z9' },
  { id: 'w4', name: 'Tablet Node', device: 'Xiaomi Pad 6 (SD 870)', hashrate: 423, accepted: 567, rejected: 0, uptimeSec: 43200, lastSeen: Date.now() - 60000, status: 'idle', poolUrl: 'pool.supportxmr.com:3333', wallet: '4A...Z9' },
]

const DEMO_STATS: Stats = {
  totalHashrate: 1980,
  totalAccepted: 8047,
  totalRejected: 16,
  estimatedDailyXmr: 0.00042,
  xmrPrice: 178.34,
  networkDifficulty: '2.34e11',
  blockHeight: 3284567,
}

function formatHashrate(h: number): string {
  if (h >= 1000) return (h / 1000).toFixed(2) + ' KH/s'
  return h.toFixed(0) + ' H/s'
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatLastSeen(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`
  return `${Math.floor(diff/86400)}d ago`
}

/* ─── Ollama Chat ─── */
function OllamaChatPanel() {
  const [input, setInput] = useState('')
  const [msgs, setMsgs] = useState<{role:string; content:string}[]>([
    { role: 'assistant', content: 'I am your MobileMonero AI. Ask me about mining optimization, hardware settings, or pool configuration.' }
  ])
  const [thinking, setThinking] = useState(false)

  async function send() {
    if (!input.trim()) return
    const userMsg = { role: 'user', content: input.trim() }
    setMsgs(p => [...p, userMsg])
    setInput('')
    setThinking(true)

    // Save to IndexedDB
    await dbPut('ollama_chat', { ...userMsg, timestamp: Date.now(), model: 'llama3.2' }).catch(() => {})

    // Ollama local call
    try {
      const res = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama3.2',
          messages: [...msgs.slice(-6), userMsg].map(m => ({ role: m.role, content: m.content })),
          stream: false,
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        const data = await res.json()
        const reply = data.message?.content ?? 'No response'
        setMsgs(p => [...p, { role: 'assistant', content: reply }])
        await dbPut('ollama_chat', { role: 'assistant', content: reply, timestamp: Date.now(), model: 'llama3.2' }).catch(() => {})
      } else {
        throw new Error('ollama error')
      }
    } catch {
      // Fallback: mining optimization rule engine
      const txt = userMsg.content.toLowerCase()
      let reply = ''
      if (txt.includes('hashrate') || txt.includes('slow'))
        reply = 'For better hashrate: close background apps, enable performance mode, ensure phone has active cooling. Pixel 8 Pro can reach ~850 H/s on big cores.'
      else if (txt.includes('pool') || txt.includes('pools'))
        reply = 'Recommended pools: supportXMR (0.6% fee, global), MoneroOcean (auto algo switching), MineXMR (2% fee). For mesh mining, use solo pool on local gateway.'
      else if (txt.includes('battery') || txt.includes('heat') || txt.includes('hot'))
        reply = 'Mining generates heat. Use a phone stand with fan, mine overnight while charging, or reduce threads to 50%. Monitor battery temperature — stop if >45°C.'
      else if (txt.includes('wallet') || txt.includes('address'))
        reply = 'For mobile mining, use a lightweight wallet like Cake Wallet or Monerujo. Store your seed phrase offline. The address shown in the dashboard is your receive address.'
      else
        reply = 'I can help with mining optimization, pool selection, battery management, and wallet setup. What would you like to know?'
      setMsgs(p => [...p, { role: 'assistant', content: reply }])
    }
    setThinking(false)
  }

  return (
    <div className="w-full max-w-md mx-auto bg-black/30 border border-white/10 rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-pink-400" />
          <span className="font-semibold text-white">Mining AI</span>
        </div>
        <span className="text-xs text-zinc-500">Local Ollama</span>
      </div>

      <div className="h-48 overflow-y-auto space-y-2 pr-1">
        {msgs.map((m, i) => (
          <div key={i} className={`text-sm leading-relaxed ${m.role === 'user' ? 'text-pink-200 text-right' : 'text-zinc-200'}`}>
            {m.content}
          </div>
        ))}
        {thinking && <div className="text-xs text-zinc-500 animate-pulse">Thinking...</div>}
      </div>

      <div className="flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send() }}
          placeholder="Ask about mining..."
          className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-pink-500/50"
        />
        <button onClick={send} disabled={thinking} className="bg-pink-600 hover:bg-pink-500 text-white rounded-xl px-4 py-2 text-sm font-medium transition-all disabled:opacity-50">
          Send
        </button>
      </div>
    </div>
  )
}

/* ─── Dashboard ─── */
function Dashboard({ workers, stats, onConfig }: { workers: Worker[]; stats: Stats; onConfig: () => void }) {
  const onlineWorkers = workers.filter(w => w.status === 'online')
  const totalHash = onlineWorkers.reduce((s, w) => s + w.hashrate, 0)
  const dailyUsd = stats.estimatedDailyXmr * stats.xmrPrice

  return (
    <div className="space-y-6 pb-8">
      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-gradient-to-br from-violet-900/50 to-purple-900/30 border border-violet-500/20 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="w-4 h-4 text-violet-400" />
            <span className="text-xs font-medium text-violet-300 uppercase tracking-wider">Hashrate</span>
          </div>
          <div className="text-2xl font-bold text-white">{formatHashrate(totalHash)}</div>
          <div className="text-xs text-emerald-400 flex items-center gap-1">
            <ArrowUpRight className="w-3 h-3" /> +<TrendingUp className="w-3 h-3" /> 3.2% vs yesterday
          </div>
        </div>

        <div className="bg-gradient-to-br from-amber-900/50 to-orange-900/30 border border-amber-500/20 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Wallet className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-medium text-amber-300 uppercase tracking-wider">Daily Est.</span>
          </div>
          <div className="text-2xl font-bold text-white">${dailyUsd.toFixed(4)}</div>
          <div className="text-xs text-zinc-400">{stats.estimatedDailyXmr.toFixed(6)} XMR/day</div>
        </div>

        <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Accepted</span>
          </div>
          <div className="text-xl font-bold text-white">{stats.totalAccepted.toLocaleString()}</div>
          <div className="text-xs text-emerald-400">{(stats.totalAccepted / (stats.totalAccepted + stats.totalRejected) * 100).toFixed(1)}% accepted rate</div>
        </div>

        <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Globe className="w-4 h-4 text-sky-400" />
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Network</span>
          </div>
          <div className="text-xl font-bold text-white">#{stats.blockHeight.toLocaleString()}</div>
          <div className="text-xs text-zinc-400">Difficulty: {stats.networkDifficulty}</div>
        </div>
      </div>

      {/* Online vs offline */}
      <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-violet-400" />
            <span className="font-semibold text-white">Workers ({workers.length})</span>
          </div>
          <button onClick={onConfig} className="text-xs text-violet-300 hover:text-white transition-colors">
            Configure All
          </button>
        </div>

        <div className="space-y-2">
          {workers.map(w => (
            <div key={w.id} className={`flex items-center gap-3 p-3 rounded-xl border ${
              w.status === 'online' ? 'bg-emerald-900/10 border-emerald-500/20' :
              w.status === 'idle' ? 'bg-amber-900/10 border-amber-500/20' :
              'bg-red-900/10 border-red-500/20'
            }`}>
              <div className={`w-2.5 h-2.5 rounded-full ${
                w.status === 'online' ? 'bg-emerald-500 animate-pulse' :
                w.status === 'idle' ? 'bg-amber-500' :
                'bg-red-500'
              }`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white truncate">{w.name}</span>
                  <span className="text-xs font-mono text-zinc-400">{formatHashrate(w.hashrate)}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <span>{w.device}</span>
                  <span>·</span>
                  <span>{formatLastSeen(w.lastSeen)}</span>
                  {w.status === 'online' && (
                    <>
                      <span>·</span>
                      <span className="text-emerald-400">{formatUptime(w.uptimeSec)}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* AI Chat — Mining Optimization */}
      <OllamaChatPanel />
    </div>
  )
}

/* ─── Receive XMR ─── */
function ReceiveMonero({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="space-y-6">
      <div className="bg-white/5 border border-white/10 rounded-2xl p-6 text-center space-y-4">
        <div className="w-32 h-32 mx-auto bg-white rounded-xl flex items-center justify-center">
          <Wallet className="w-12 h-12 text-violet-900" />
        </div>
        <div className="font-mono text-sm text-zinc-300 break-all bg-black/30 rounded-xl p-3">
          {address}
        </div>
        <button onClick={copy} className="flex items-center justify-center gap-2 mx-auto text-sm text-violet-300 hover:text-white transition-colors"
        >
          {copied ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          {copied ? 'Copied!' : 'Copy Address'}
        </button>
      </div>
    </div>
  )
}

/* ─── Main App ─── */
function App() {
  const [language, setLanguage] = useState<'en' | 'es'>('en')
  const [tab, setTab] = useState<'dashboard' | 'receive' | 'mesh' | 'settings'>('dashboard')
  const [workers, setWorkers] = useState<Worker[]>([])
  const [stats, setStats] = useState<Stats>(DEMO_STATS)
  const [showFab, setShowFab] = useState(false)
  const t = translations[language]

  // Load workers from IndexedDB + merge demo
  useEffect(() => {
    dbGetAll('workers').then((rows) => {
      const dbWorkers = (rows as Worker[]).length > 0 ? rows as Worker[] : DEMO_WORKERS
      setWorkers(dbWorkers)
    }).catch(() => setWorkers(DEMO_WORKERS))

    // Simulate live hashrate updates
    const interval = setInterval(() => {
      setWorkers(prev => prev.map(w => {
        if (w.status !== 'online') return w
        return { ...w, hashrate: Math.max(200, w.hashrate + (Math.random() - 0.5) * 40), lastSeen: Date.now() }
      }))
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  // Register SW
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])

  const xmrAddress = '4A1X2Y3Z4A1X2Y3Z4A1X2Y3Z4A1X2Y3Z4A1X2Y3Z4A1X2Y3Z4A1X2Y3Z4A1X2Y3Z9'

  return (
    <div className="min-h-screen bg-gradient-to-b from-violet-950 to-purple-950 text-white">
      {/* Header */}
      <div className="fixed top-0 left-0 right-0 bg-black/20 backdrop-blur-sm py-3 px-4 flex items-center justify-between z-50">
        <div className="flex items-center gap-2">
          <Wallet className="w-7 h-7 text-orange-500" />
          <span className="font-bold text-lg">MobileMonero</span>
        </div>
        <button
          onClick={() => setLanguage(l => l === 'en' ? 'es' : 'en')}
          className="text-xs text-zinc-400 hover:text-white px-3 py-1 rounded-full bg-white/10"
        >
          {language.toUpperCase()}
        </button>
      </div>

      {/* Content */}
      <div className="pt-16 px-4 pb-24">
        {tab === 'dashboard' && <Dashboard workers={workers} stats={stats} onConfig={() => setTab('settings')} />}
        {tab === 'receive' && <ReceiveMonero address={xmrAddress} />}
        {tab === 'mesh' && <MeshTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>

      {/* Bottom Nav */}
      <div className="fixed bottom-0 left-0 right-0 bg-black/40 backdrop-blur-xl border-t border-white/5 flex justify-around py-2 z-50">
        {[
          { key: 'dashboard', icon: Activity, label: t.nav?.dashboard || 'Dashboard' },
          { key: 'receive', icon: Download, label: 'Receive' },
          { key: 'mesh', icon: Wifi, label: 'Mesh' },
          { key: 'settings', icon: Settings, label: 'Settings' },
        ].map(item => (
          <button
            key={item.key}
            onClick={() => setTab(item.key as any)}
            className={`flex flex-col items-center gap-0.5 py-1 px-4 rounded-xl transition-all ${
              tab === item.key ? 'text-orange-400' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <item.icon className="w-5 h-5" />
            <span className="text-[10px] font-medium">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export default App
