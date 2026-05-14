import { useState, useEffect } from 'react'
import { Settings, Wallet, Bot, Save, ChevronRight, Copy, CheckCircle, Trash2, AlertTriangle } from 'lucide-react'

interface SettingsData {
  agentName: string
  walletAddress: string
  poolUrl: string
  threads: number
  donatePercent: number
}

const DEFAULTS: SettingsData = {
  agentName: 'MobileMonero Agent',
  walletAddress: '4A1X2Y3Z4A1X2Y3Z4A1X2Y3Z4A1X2Y3Z4A1X2Y3Z4A1X2Y3Z4A1X2Y3Z4A1X2Y3Z9',
  poolUrl: 'pool.supportxmr.com:3333',
  threads: 4,
  donatePercent: 1,
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mobilemonero_v1', 2)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('workers')) db.createObjectStore('workers', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('stats')) db.createObjectStore('stats', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('ollama_chat')) db.createObjectStore('ollama_chat', { keyPath: 'id', autoIncrement: true })
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' })
    }
  })
}

async function dbGetSettings(): Promise<Partial<SettingsData>> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readonly')
    const req = tx.objectStore('settings').getAll()
    req.onsuccess = () => {
      const rows = req.result as { key: string; value: any }[]
      const out: Partial<SettingsData> = {}
      for (const r of rows) {
        if (r.key in DEFAULTS) (out as any)[r.key] = r.value
      }
      resolve(out)
      db.close()
    }
    req.onerror = () => { reject(req.error); db.close() }
  })
}

async function dbPutSetting(key: string, value: any) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite')
    const req = tx.objectStore('settings').put({ key, value })
    req.onsuccess = () => { resolve(req.result); db.close() }
    req.onerror = () => { reject(req.error); db.close() }
  })
}

function maskAddress(addr: string): string {
  if (addr.length <= 16) return addr
  return addr.slice(0, 8) + '...' + addr.slice(-8)
}

export default function SettingsTab() {
  const [data, setData] = useState<SettingsData>(DEFAULTS)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [dangerOpen, setDangerOpen] = useState(false)

  useEffect(() => {
    dbGetSettings().then(partial => {
      setData(d => ({ ...d, ...partial }))
    }).catch(() => {})
  }, [])

  function update(key: keyof SettingsData, value: any) {
    setData(prev => ({ ...prev, [key]: value }))
  }

  async function save() {
    try {
      for (const [k, v] of Object.entries(data)) {
        await dbPutSetting(k, v)
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      // IndexedDB may be unavailable in private mode
    }
  }

  function copyAddress() {
    navigator.clipboard.writeText(data.walletAddress).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  function resetDefaults() {
    setData(DEFAULTS)
    setDangerOpen(false)
  }

  return (
    <div className="space-y-6 pb-8">
      <div className="flex items-center gap-2">
        <Settings className="w-5 h-5 text-orange-400" />
        <span className="font-semibold text-white">Settings</span>
      </div>

      {/* Agent Card */}
      <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Bot className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-medium text-white">Agent Identity</span>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">Agent Name</label>
          <input
            value={data.agentName}
            onChange={e => update('agentName', e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-violet-500/50"
            placeholder="Name shown to mesh peers"
          />
        </div>
      </div>

      {/* Wallet Card */}
      <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Wallet className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-medium text-white">Wallet Config</span>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">Pool URL</label>
          <input
            value={data.poolUrl}
            onChange={e => update('poolUrl', e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
            placeholder="host:port"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">Wallet Address</label>
          <div className="flex gap-2">
            <input
              value={data.walletAddress}
              onChange={e => update('walletAddress', e.target.value)}
              className="flex-1 bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
              placeholder="Your XMR receive address"
            />
            <button onClick={copyAddress} className="shrink-0 bg-white/10 hover:bg-white/20 border border-white/10 rounded-xl px-3 py-2 transition-colors">
              {copied ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 text-zinc-300" />}
            </button>
          </div>
          <div className="text-[10px] text-zinc-500">{maskAddress(data.walletAddress)}</div>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">Mining Threads ({data.threads})</label>
          <input
            type="range"
            min={1}
            max={8}
            value={data.threads}
            onChange={e => update('threads', parseInt(e.target.value))}
            className="w-full accent-orange-500"
          />
          <div className="flex justify-between text-[10px] text-zinc-500">
            <span>1</span>
            <span>8</span>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">Dev Donation ({data.donatePercent}%)</label>
          <input
            type="range"
            min={0}
            max={5}
            step={0.5}
            value={data.donatePercent}
            onChange={e => update('donatePercent', parseFloat(e.target.value))}
            className="w-full accent-orange-500"
          />
          <div className="flex justify-between text-[10px] text-zinc-500">
            <span>0%</span>
            <span>5%</span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          className="flex-1 flex items-center justify-center gap-2 bg-orange-600 hover:bg-orange-500 text-white rounded-xl px-4 py-3 text-sm font-medium transition-all"
        >
          <Save className="w-4 h-4" />
          {saved ? 'Saved!' : 'Save Settings'}
        </button>
      </div>

      {/* Danger Zone */}
      <div className="bg-red-950/20 border border-red-500/20 rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="w-4 h-4 text-red-400" />
          <span className="text-sm font-medium text-red-300">Danger Zone</span>
        </div>
        {!dangerOpen ? (
          <button
            onClick={() => setDangerOpen(true)}
            className="flex items-center gap-2 text-xs text-red-400 hover:text-red-300 transition-colors"
          >
            <ChevronRight className="w-3 h-3" />
            Reset to defaults
          </button>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-zinc-400">This will reset agent name, wallet address, and mining config to defaults. Your chat history will not be affected.</p>
            <div className="flex gap-2">
              <button onClick={resetDefaults} className="flex items-center gap-1 bg-red-600 hover:bg-red-500 text-white rounded-lg px-3 py-1.5 text-xs transition-all">
                <Trash2 className="w-3 h-3" />
                Confirm Reset
              </button>
              <button onClick={() => setDangerOpen(false)} className="text-xs text-zinc-400 hover:text-white px-3 py-1.5">Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
