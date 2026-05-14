import { useState, useEffect } from 'react'
import { Wifi, WifiOff, Bot, Globe, Server, Activity, AlertCircle, ArrowUpRight, RefreshCw } from 'lucide-react'

interface Tunnel {
  id: string
  name: string
  targetHost: string
  targetPort: number
  localPort: number
  status: 'open' | 'closed' | 'error'
  lastActivity: number
  bytesIn: number
  bytesOut: number
}

interface Agent {
  id: string
  name: string
  role: 'gateway' | 'miner' | 'relay'
  status: 'online' | 'offline' | 'busy'
  peers: number
  latencyMs: number
  version: string
  lastSeen: number
}

const DEMO_AGENTS: Agent[] = [
  { id: 'a1', name: 'Alpha Gateway', role: 'gateway', status: 'online', peers: 8, latencyMs: 42, version: 'v2.1.0', lastSeen: Date.now() },
  { id: 'a2', name: 'Beta Miner', role: 'miner', status: 'online', peers: 3, latencyMs: 67, version: 'v2.1.0', lastSeen: Date.now() - 120000 },
  { id: 'a3', name: 'Gamma Relay', role: 'relay', status: 'busy', peers: 12, latencyMs: 89, version: 'v2.0.4', lastSeen: Date.now() - 30000 },
  { id: 'a4', name: 'Delta Miner', role: 'miner', status: 'offline', peers: 0, latencyMs: 0, version: 'v2.0.3', lastSeen: Date.now() - 900000 },
]

const DEMO_TUNNELS: Tunnel[] = [
  { id: 't1', name: 'XMR Pool', targetHost: 'pool.supportxmr.com', targetPort: 3333, localPort: 3333, status: 'open', lastActivity: Date.now() - 5000, bytesIn: 1245000, bytesOut: 89000 },
  { id: 't2', name: 'Ollama Local', targetHost: '127.0.0.1', targetPort: 11434, localPort: 11434, status: 'open', lastActivity: Date.now() - 20000, bytesIn: 45000, bytesOut: 12000 },
  { id: 't3', name: 'Node RPC', targetHost: 'node.xmr.to', targetPort: 18081, localPort: 18081, status: 'error', lastActivity: Date.now() - 600000, bytesIn: 0, bytesOut: 0 },
]

function formatBytes(b: number): string {
  if (b >= 1_000_000) return (b / 1_000_000).toFixed(2) + ' MB'
  if (b >= 1_000) return (b / 1_000).toFixed(1) + ' KB'
  return b + ' B'
}

function formatLastSeen(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export default function MeshTab() {
  const [agents, setAgents] = useState<Agent[]>(DEMO_AGENTS)
  const [tunnels, setTunnels] = useState<Tunnel[]>(DEMO_TUNNELS)
  const [refreshing, setRefreshing] = useState(false)

  const onlineAgents = agents.filter(a => a.status === 'online')
  const totalPeers = agents.reduce((s, a) => s + a.peers, 0)
  const openTunnels = tunnels.filter(t => t.status === 'open')
  const avgLatency = onlineAgents.length > 0
    ? Math.round(onlineAgents.reduce((s, a) => s + a.latencyMs, 0) / onlineAgents.length)
    : 0

  function refresh() {
    setRefreshing(true)
    setTimeout(() => {
      setAgents(prev => prev.map(a => a.status === 'online' ? { ...a, latencyMs: Math.max(10, a.latencyMs + Math.round((Math.random() - 0.5) * 20)) } : a))
      setTunnels(prev => prev.map(t => t.status === 'open' ? { ...t, bytesIn: t.bytesIn + Math.floor(Math.random() * 5000), bytesOut: t.bytesOut + Math.floor(Math.random() * 2000), lastActivity: Date.now() } : t))
      setRefreshing(false)
    }, 800)
  }

  useEffect(() => {
    const interval = setInterval(() => {
      setAgents(prev => prev.map(a => a.status === 'online' ? { ...a, lastSeen: Date.now() } : a))
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="space-y-6 pb-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="w-5 h-5 text-sky-400" />
          <span className="font-semibold text-white">Mesh Network</span>
        </div>
        <button onClick={refresh} disabled={refreshing} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Bot className="w-4 h-4 text-violet-400" />
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Agents</span>
          </div>
          <div className="text-2xl font-bold text-white">{onlineAgents.length}/{agents.length}</div>
          <div className="text-xs text-emerald-400">{totalPeers} total peers</div>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Server className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Tunnels</span>
          </div>
          <div className="text-2xl font-bold text-white">{openTunnels.length}/{tunnels.length}</div>
          <div className="text-xs text-zinc-400">{tunnels.filter(t => t.status === 'error').length} errors</div>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Avg Latency</span>
          </div>
          <div className="text-2xl font-bold text-white">{avgLatency} ms</div>
          <div className="text-xs text-zinc-400">mesh round-trip</div>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <ArrowUpRight className="w-4 h-4 text-sky-400" />
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Throughput</span>
          </div>
          <div className="text-2xl font-bold text-white">{formatBytes(openTunnels.reduce((s, t) => s + t.bytesOut, 0))}</div>
          <div className="text-xs text-zinc-400">{formatBytes(openTunnels.reduce((s, t) => s + t.bytesIn, 0))} in</div>
        </div>
      </div>

      <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Bot className="w-5 h-5 text-violet-400" />
          <span className="font-semibold text-white">Agents</span>
        </div>
        <div className="space-y-2">
          {agents.map(a => (
            <div key={a.id} className={`flex items-center gap-3 p-3 rounded-xl border ${
              a.status === 'online' ? 'bg-emerald-900/10 border-emerald-500/20' :
              a.status === 'busy' ? 'bg-amber-900/10 border-amber-500/20' :
              'bg-red-900/10 border-red-500/20'
            }`}>
              <div className={`w-2.5 h-2.5 rounded-full ${
                a.status === 'online' ? 'bg-emerald-500 animate-pulse' :
                a.status === 'busy' ? 'bg-amber-500' :
                'bg-red-500'
              }`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white truncate">{a.name}</span>
                  <span className="text-xs font-mono text-zinc-400">{a.latencyMs > 0 ? `${a.latencyMs} ms` : '—'}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <span className="capitalize">{a.role}</span>
                  <span>·</span>
                  <span>{a.peers} peers</span>
                  <span>·</span>
                  <span>{a.version}</span>
                  <span>·</span>
                  <span>{formatLastSeen(a.lastSeen)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Server className="w-5 h-5 text-amber-400" />
          <span className="font-semibold text-white">Tunnels</span>
        </div>
        <div className="space-y-2">
          {tunnels.map(t => (
            <div key={t.id} className={`flex items-center gap-3 p-3 rounded-xl border ${
              t.status === 'open' ? 'bg-emerald-900/10 border-emerald-500/20' :
              t.status === 'error' ? 'bg-red-900/10 border-red-500/20' :
              'bg-zinc-900/30 border-white/5'
            }`}>
              {t.status === 'open' ? <Wifi className="w-4 h-4 text-emerald-400" /> :
               t.status === 'error' ? <AlertCircle className="w-4 h-4 text-red-400" /> :
               <WifiOff className="w-4 h-4 text-zinc-500" />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white truncate">{t.name}</span>
                  <span className="text-xs font-mono text-zinc-400">:{t.localPort}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <span>{t.targetHost}:{t.targetPort}</span>
                  <span>·</span>
                  <span>{formatLastSeen(t.lastActivity)}</span>
                  {t.status === 'open' && (
                    <>
                      <span>·</span>
                      <span className="text-emerald-400">{formatBytes(t.bytesIn)} in / {formatBytes(t.bytesOut)} out</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
