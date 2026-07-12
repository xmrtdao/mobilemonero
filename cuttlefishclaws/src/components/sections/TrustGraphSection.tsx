'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import graphData from '../../lib/trustGraphData.json'

// ── TYPES ────────────────────────────────────────────────────────────
interface TGNode {
  id: string
  label: string
  score: number
  targetScore: number
  type: 'governance' | 'investor' | 'system' | 'unknown'
  color: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  pulsePhase: number
  lastEvent: string
  eventAlpha: number
}

interface TGEdge {
  a: TGNode
  b: TGNode
  strength: number
  flowPhase: number
}

interface ScoreEvent {
  nodeId: string
  label: string
  delta: number
  ts: number
}

// ── CONSTANTS ─────────────────────────────────────────────────────────
const NODE_COLOR: Record<string, string> = {
  governance: '#00ffcc',
  investor: '#ffaa00',
  system: '#aa88ff',
  unknown: '#ffbb33',
}

const SCORE_EVENTS = [
  { label: 'Governance vote cast', delta: +5, type: 'governance' },
  { label: 'Code contribution merged', delta: +3, type: 'governance' },
  { label: 'Security audit passed', delta: +8, type: 'system' },
  { label: 'Proposal sponsored', delta: +4, type: 'investor' },
  { label: 'Cross-DAO attestation', delta: +6, type: 'governance' },
  { label: 'Rule violation detected', delta: -15, type: 'investor' },
  { label: 'Injection attempt blocked', delta: -50, type: 'system' },
  { label: 'KYA re-attestation', delta: +2, type: 'investor' },
  { label: 'Constitutional audit', delta: +7, type: 'governance' },
  { label: 'Governance participation', delta: +3, type: 'investor' },
]

// Sectors shown on the pie ring when a node is selected
const PIE_SECTORS = [
  { key: 'TRUST',  color: '#44ffaa' },
  { key: 'FILES',  color: '#6274ea' },
  { key: 'WEIGHT', color: '#9945ff' },
  { key: 'LINKS',  color: '#00d2ff' },
]

function scoreColor(s: number): string {
  if (s >= 80) return '#44ffaa'
  if (s >= 60) return '#ffbb33'
  if (s >= 35) return '#ff8800'
  return '#ff3399'
}

function scoreLabel(s: number): string {
  if (s >= 85) return 'Trusted'
  if (s >= 70) return 'Established'
  if (s >= 50) return 'Neutral'
  if (s >= 25) return 'Flagged'
  return 'Restricted'
}

function getSectorValues(n: TGNode, edgeCount: number) {
  const gn = graphData.nodes.find(gn => gn.id === n.id)
  return [
    n.score / 100,
    gn && gn.files ? gn.files.length / Math.max(gn.files.length, 1) : 0.5,
    n.type === 'governance' ? 0.85 : n.type === 'investor' ? 0.65 : 0.75,
    Math.min(1, edgeCount / 10),
  ]
}

// ── CANVAS ENGINE ─────────────────────────────────────────────────────
function initTrustGraph(
  canvas: HTMLCanvasElement,
  onNodeClick: (nodeId: string | null, xFrac: number, yFrac: number) => void,
): {
  destroy: () => void
  applyEvent: (nodeId: string, delta: number, label: string) => void
  setSelected: (nodeId: string | null) => void
} {
  const ctx = canvas.getContext('2d')!
  let W = 0, H = 0
  let tick = 0
  let rafId = 0
  let nodes: TGNode[] = []
  let edges: TGEdge[] = []
  let selectedId: string | null = null
  const dpr = Math.min(window.devicePixelRatio || 1, 2)

  function resize() {
    W = canvas.offsetWidth
    H = canvas.offsetHeight
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function initNodes() {
    const cx = W / 2, cy = H / 2

    // Named nodes from real graph data (governance, investor, system types)
    const namedGraphNodes = graphData.nodes.filter(n =>
      n.type === 'governance' || n.type === 'investor' || n.type === 'system'
    )
    nodes = namedGraphNodes.map((gn, i) => {
      const angle = (i / namedGraphNodes.length) * Math.PI * 2
      const r = Math.min(W, H) * 0.28
      return {
        id: gn.id,
        label: gn.label,
        score: gn.trustScore ?? 50,
        targetScore: gn.trustScore ?? 50,
        type: gn.type as 'governance' | 'investor' | 'system' | 'unknown',
        color: NODE_COLOR[gn.type] || '#ffbb33',
        x: cx + Math.cos(angle) * r + (Math.random() - 0.5) * 40,
        y: cy + Math.sin(angle) * r + (Math.random() - 0.5) * 40,
        vx: 0, vy: 0,
        r: 18 + (gn.trustScore ?? 50) * 0.12,
        pulsePhase: Math.random() * Math.PI * 2,
        lastEvent: '',
        eventAlpha: 0,
      }
    })

    // Background unknown nodes for visual density
    for (let i = 0; i < 18; i++) {
      const angle = Math.random() * Math.PI * 2
      const r = Math.min(W, H) * (0.12 + Math.random() * 0.38)
      nodes.push({
        id: `unknown-${i}`,
        label: `AGT-${Math.floor(Math.random() * 9000 + 1000)}`,
        score: 20 + Math.floor(Math.random() * 70),
        targetScore: 20 + Math.floor(Math.random() * 70),
        type: 'unknown',
        color: '#ffbb33',
        x: W / 2 + Math.cos(angle) * r,
        y: H / 2 + Math.sin(angle) * r,
        vx: 0, vy: 0,
        r: 6 + Math.random() * 8,
        pulsePhase: Math.random() * Math.PI * 2,
        lastEvent: '', eventAlpha: 0,
      })
    }

    // Build edges from real graph data
    const nodeMap = new Map(nodes.map(n => [n.id, n]))
    edges = []
    const usedPairs = new Set<string>()
    graphData.edges.forEach(ge => {
      const a = nodeMap.get(ge.source)
      const b = nodeMap.get(ge.target)
      if (!a || !b) return
      const key = [a.id, b.id].sort().join('::')
      if (usedPairs.has(key)) return
      usedPairs.add(key)
      edges.push({ a, b, strength: ge.strength, flowPhase: Math.random() * Math.PI * 2 })
    })

    // Also connect named nodes to unknown background nodes for visual richness
    const named = nodes.slice(0, namedGraphNodes.length)
    named.forEach(a => {
      nodes.slice(namedGraphNodes.length).filter(() => Math.random() > 0.65).forEach(u => {
        edges.push({ a, b: u, strength: 0.15 + Math.random() * 0.3, flowPhase: Math.random() * Math.PI * 2 })
      })
    })
  }

  function physics() {
    const cx = W / 2, cy = H / 2
    nodes.forEach(n => {
      n.score += (n.targetScore - n.score) * 0.04
      n.r = (n.type === 'unknown' ? 6 : 14) + n.score * (n.type === 'unknown' ? 0.04 : 0.1)
      n.vx += (Math.random() - 0.5) * 0.15
      n.vy += (Math.random() - 0.5) * 0.15
      n.vx += (cx - n.x) * 0.0008
      n.vy += (cy - n.y) * 0.0008
      nodes.forEach(m => {
        if (m === n) return
        const dx = n.x - m.x, dy = n.y - m.y
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.01
        const minDist = n.r + m.r + 20
        if (dist < minDist) {
          const force = (minDist - dist) / minDist * 0.6
          n.vx += (dx / dist) * force
          n.vy += (dy / dist) * force
        }
      })
      n.vx *= 0.88; n.vy *= 0.88
      n.x += n.vx; n.y += n.vy
      const pad = n.r + 20
      if (n.x < pad) n.vx += 0.5
      if (n.x > W - pad) n.vx -= 0.5
      if (n.y < pad) n.vy += 0.5
      if (n.y > H - pad) n.vy -= 0.5
      if (n.eventAlpha > 0) n.eventAlpha -= 0.008
    })
    edges.forEach(e => { e.flowPhase += 0.018 })
  }

  function drawSelectedRings(n: TGNode, sc: string, nr: number) {
    // ── Selection highlight ring
    ctx.beginPath(); ctx.arc(n.x, n.y, nr + 3, 0, Math.PI * 2)
    ctx.strokeStyle = `${sc}99`; ctx.lineWidth = 1.5; ctx.stroke()

    // ── Ring 1: trust arc donut (nr+7 to nr+13)
    const r1i = nr + 7, r1o = nr + 13
    // background full ring
    ctx.beginPath(); ctx.arc(n.x, n.y, r1o, 0, Math.PI * 2); ctx.arc(n.x, n.y, r1i, Math.PI * 2, 0, true); ctx.closePath()
    ctx.fillStyle = sc; ctx.globalAlpha = 0.1; ctx.fill(); ctx.globalAlpha = 1
    // filled arc proportional to trust score
    const trustEnd = -Math.PI / 2 + Math.PI * 2 * (n.score / 100)
    ctx.beginPath(); ctx.arc(n.x, n.y, r1o, -Math.PI / 2, trustEnd); ctx.arc(n.x, n.y, r1i, trustEnd, -Math.PI / 2, true); ctx.closePath()
    ctx.fillStyle = sc; ctx.globalAlpha = 0.75; ctx.fill(); ctx.globalAlpha = 1

    // ── Ring 2: 4-sector pie donut (nr+17 to nr+27)
    const r2i = nr + 17, r2o = nr + 27
    const nodeEdgeCount = edges.filter(e => e.a.id === n.id || e.b.id === n.id).length
    const sectorVals = getSectorValues(n, nodeEdgeCount)

    sectorVals.forEach((val, i) => {
      const color = PIE_SECTORS[i].color
      const sStart = -Math.PI / 2 + i * (Math.PI / 2)
      const sEnd   = sStart + Math.PI / 2
      const fillEnd = sStart + (Math.PI / 2) * Math.min(1, val)

      // Background sector
      ctx.beginPath(); ctx.arc(n.x, n.y, r2o, sStart, sEnd); ctx.arc(n.x, n.y, r2i, sEnd, sStart, true); ctx.closePath()
      ctx.fillStyle = color; ctx.globalAlpha = 0.08; ctx.fill(); ctx.globalAlpha = 1

      // Filled sector
      if (fillEnd > sStart) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r2o, sStart, fillEnd); ctx.arc(n.x, n.y, r2i, fillEnd, sStart, true); ctx.closePath()
        ctx.fillStyle = color; ctx.globalAlpha = 0.6; ctx.fill(); ctx.globalAlpha = 1
      }

      // Divider line between sectors
      ctx.beginPath()
      ctx.moveTo(n.x + Math.cos(sStart) * r2i, n.y + Math.sin(sStart) * r2i)
      ctx.lineTo(n.x + Math.cos(sStart) * r2o, n.y + Math.sin(sStart) * r2o)
      ctx.strokeStyle = 'rgba(6,2,0,0.9)'; ctx.lineWidth = 1; ctx.stroke()

      // Sector label
      const midA = sStart + Math.PI / 4
      ctx.font = '6px monospace'; ctx.textAlign = 'center'
      ctx.fillStyle = `${color}cc`
      ctx.fillText(PIE_SECTORS[i].key, n.x + Math.cos(midA) * (r2o + 9), n.y + Math.sin(midA) * (r2o + 9) + 2)
    })

    // ── Ring 3: outer tick ring (nr+32)
    const r3 = nr + 32
    ctx.beginPath(); ctx.arc(n.x, n.y, r3, 0, Math.PI * 2)
    ctx.strokeStyle = `${sc}33`; ctx.lineWidth = 0.5; ctx.stroke()
    for (let t3 = 0; t3 < 16; t3++) {
      const a = (t3 / 16) * Math.PI * 2
      const len = t3 % 4 === 0 ? 5 : 3
      ctx.beginPath()
      ctx.moveTo(n.x + Math.cos(a) * r3, n.y + Math.sin(a) * r3)
      ctx.lineTo(n.x + Math.cos(a) * (r3 + len), n.y + Math.sin(a) * (r3 + len))
      ctx.strokeStyle = `${sc}55`; ctx.lineWidth = 0.5; ctx.stroke()
    }

    // ── Ring 4: animated outer pulse
    const pulseR = nr + 44 + Math.sin(tick * 0.06) * 5
    ctx.beginPath(); ctx.arc(n.x, n.y, pulseR, 0, Math.PI * 2)
    ctx.strokeStyle = `${sc}22`; ctx.lineWidth = 0.75; ctx.stroke()
  }

  function draw() {
    tick++
    ctx.clearRect(0, 0, W, H)

    // Background grid dots
    ctx.fillStyle = 'rgba(255,140,0,0.04)'
    for (let gx = 0; gx < W; gx += 40)
      for (let gy = 0; gy < H; gy += 40)
        ctx.fillRect(gx, gy, 1, 1)

    // Edges
    edges.forEach(e => {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const alpha = e.strength * 0.18 * Math.min(1, 200 / dist)
      ctx.strokeStyle = `rgba(255,140,0,${alpha})`
      ctx.lineWidth = 0.5
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke()
      const t = ((e.flowPhase % (Math.PI * 2)) / (Math.PI * 2))
      const px = e.a.x + dx * t, py = e.a.y + dy * t
      ctx.beginPath(); ctx.arc(px, py, 1.5, 0, Math.PI * 2)
      ctx.fillStyle = scoreColor(e.a.score)
      ctx.globalAlpha = e.strength * 0.5; ctx.fill(); ctx.globalAlpha = 1
    })

    // Nodes (draw selected last so rings aren't hidden by other nodes)
    const orderedNodes = [...nodes].sort((a, b) => (a.id === selectedId ? 1 : b.id === selectedId ? -1 : 0))

    orderedNodes.forEach(n => {
      const sc = scoreColor(n.score)
      const pulse = Math.sin(tick * 0.04 + n.pulsePhase) * 0.15 + 0.85
      const named = n.type !== 'unknown'
      const isSelected = n.id === selectedId

      // Draw expanded rings BEHIND the node if selected
      if (isSelected && named) {
        drawSelectedRings(n, sc, n.r * pulse)
      }

      // Outer glow
      if (named) {
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 2.8, 0, Math.PI * 2)
        ctx.fillStyle = `${sc}22`; ctx.fill()
      }

      // Outer ring
      if (named) {
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r * pulse * 1.35, 0, Math.PI * 2)
        ctx.strokeStyle = `${sc}44`; ctx.lineWidth = 0.5; ctx.stroke()
      }

      // Main ring
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r * pulse, 0, Math.PI * 2)
      ctx.strokeStyle = named ? `${sc}cc` : `${sc}55`
      ctx.lineWidth = named ? 1.5 : 0.5; ctx.stroke()

      // Fill
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r * pulse * 0.85, 0, Math.PI * 2)
      ctx.fillStyle = named ? `${sc}18` : `${sc}08`; ctx.fill()

      // Score arc
      if (named && !isSelected) {
        const arcEnd = -Math.PI / 2 + (Math.PI * 2) * (n.score / 100)
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r * pulse + 4, -Math.PI / 2, arcEnd)
        ctx.strokeStyle = `${sc}99`; ctx.lineWidth = 2; ctx.stroke()
      }

      // Tick marks
      if (named && !isSelected) {
        for (let t2 = 0; t2 < 8; t2++) {
          const a = (t2 / 8) * Math.PI * 2
          const ri = n.r * pulse + 7, ro = ri + 3
          ctx.beginPath()
          ctx.moveTo(n.x + Math.cos(a) * ri, n.y + Math.sin(a) * ri)
          ctx.lineTo(n.x + Math.cos(a) * ro, n.y + Math.sin(a) * ro)
          ctx.strokeStyle = `${sc}44`; ctx.lineWidth = 0.5; ctx.stroke()
        }
      }

      // Label
      if (named) {
        const labelR = isSelected ? n.r * pulse + 52 : n.r * pulse + 18
        ctx.font = `9px 'Share Tech Mono', monospace`
        ctx.textAlign = 'center'
        ctx.fillStyle = isSelected ? `${sc}ff` : `${sc}cc`
        ctx.fillText(n.label, n.x, n.y + labelR)
        ctx.fillStyle = `rgba(255,160,0,0.5)`
        ctx.font = `8px 'Share Tech Mono', monospace`
        ctx.fillText(`${Math.round(n.score)}`, n.x, n.y + labelR + 10)
      }

      // Event label
      if (n.eventAlpha > 0 && n.lastEvent) {
        const delta = n.targetScore - n.score
        const positive = delta >= 0
        ctx.font = `8px 'Share Tech Mono', monospace`
        ctx.textAlign = 'center'
        ctx.fillStyle = positive
          ? `rgba(68,255,170,${n.eventAlpha})`
          : `rgba(255,51,153,${n.eventAlpha})`
        ctx.fillText(n.lastEvent, n.x, n.y - n.r * pulse - 14)
      }
    })

    physics()
    rafId = requestAnimationFrame(draw)
  }

  function start() {
    resize()
    initNodes()
    draw() // Start the animation loop
  }

  // Click detection
  canvas.addEventListener('click', (evt) => {
    const rect = canvas.getBoundingClientRect()
    const mx = (evt.clientX - rect.left) * (W / rect.width)
    const my = (evt.clientY - rect.top) * (H / rect.height)
    let bestDist = Infinity
    const hit = nodes.filter(n => n.type !== 'unknown').reduce<TGNode | null>((best, n) => {
      const d = Math.hypot(mx - n.x, my - n.y)
      if (d <= n.r + 35 && d < bestDist) { bestDist = d; return n }
      return best
    }, null)
    if (hit) {
      const newId = hit.id === selectedId ? null : hit.id
      selectedId = newId
      onNodeClick(newId, hit.x / W, hit.y / H)
    } else {
      selectedId = null
      onNodeClick(null, 0, 0)
    }
  })

  // Pointer cursor on hover
  canvas.addEventListener('mousemove', (evt) => {
    const rect = canvas.getBoundingClientRect()
    const mx = (evt.clientX - rect.left) * (W / rect.width)
    const my = (evt.clientY - rect.top) * (H / rect.height)
    const hit = nodes.filter(n => n.type !== 'unknown').some(n => Math.hypot(mx - n.x, my - n.y) <= n.r + 35)
    canvas.style.cursor = hit ? 'pointer' : 'default'
  })

  const resizeObserver = new ResizeObserver(() => { resize(); initNodes() })
  resizeObserver.observe(canvas)
  start()

  function applyEvent(nodeId: string, delta: number, label: string) {
    const n = nodes.find(n => n.id === nodeId)
    if (!n) return
    n.targetScore = Math.max(0, Math.min(100, n.targetScore + delta))
    n.lastEvent = `${delta > 0 ? '+' : ''}${delta} ${label}`
    n.eventAlpha = 1
  }

  return {
    destroy: () => {
      cancelAnimationFrame(rafId)
      resizeObserver.disconnect()
    },
    applyEvent,
    setSelected: (id: string | null) => { selectedId = id },
  }
}

// ── COMPONENT ─────────────────────────────────────────────────────────
export default function TrustGraphSection() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<ReturnType<typeof initTrustGraph> | null>(null)
  const [events, setEvents] = useState<ScoreEvent[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [clickedNode, setClickedNode] = useState<{ id: string; xFrac: number; yFrac: number } | null>(null)

  // Named nodes from real graph data (governance, investor, system types)
  const namedGraphNodes = graphData.nodes.filter(n =>
    n.type === 'governance' || n.type === 'investor' || n.type === 'system'
  )

  const [agentScores, setAgentScores] = useState<Record<string, number>>(() =>
    Object.fromEntries(namedGraphNodes.map(n => [n.id, n.trustScore ?? 50]))
  )

  const handleNodeClick = useCallback((nodeId: string | null, xFrac: number, yFrac: number) => {
    if (!nodeId) {
      setClickedNode(null)
      setSelectedAgent(null)
    } else {
      setClickedNode({ id: nodeId, xFrac, yFrac })
      setSelectedAgent(nodeId)
    }
  }, [])

  // ── Fetch real trust events from the database ──
  useEffect(() => {
    const agentIds = ['trib', 'arch', 'builder', 'sovereign', 'trustgraph', 'dao', 'global-communicator']
    const AGENT_ID_MAP: Record<string, string> = {
      'trib': 'trib', 'arch': 'arch', 'builder': 'builder-agent',
      'sovereign': 'sovereign-agent', 'trustgraph': 'trustgraph',
      'dao': 'dao-gov', 'global-communicator': 'global-communicator',
    }
    const lastScores: Record<string, number> = {}

    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout>

    async function pollEvents() {
      if (cancelled) return
      try {
        const results = await Promise.all(
          agentIds.map(id =>
            fetch(`https://relay.mobilemonero.com/api/cuttlefishclaws/trust-score?agentId=${id}`)
              .then(r => r.ok ? r.json() : null)
              .catch(() => null)
          )
        )
        if (cancelled) return

        const newScores: Record<string, number> = {}
        const newEvents: ScoreEvent[] = []

        results.forEach((d, i) => {
          if (!d || d.trustScore == null) return
          const agentId = agentIds[i]
          const graphId = AGENT_ID_MAP[agentId]
          newScores[graphId] = d.trustScore

          // Apply the real score to the canvas engine
          if (engineRef.current && graphId) {
            const prev = lastScores[graphId]
            if (prev !== undefined && prev !== d.trustScore) {
              const delta = d.trustScore - prev
              engineRef.current.applyEvent(graphId, delta, `DB sync: ${d.trustScore}`)
              newEvents.push({
                nodeId: graphId,
                label: `${graphId}: score synced to ${d.trustScore}`,
                delta,
                ts: Date.now(),
              })
            }
            lastScores[graphId] = d.trustScore
          }
        })

        if (Object.keys(newScores).length > 0) setAgentScores(prev => ({ ...prev, ...newScores }))
        if (newEvents.length > 0) setEvents(prev => [...newEvents.slice(0, 8), ...prev.slice(0, 7)])
      } catch (e) {
        // silent
      }
      if (!cancelled) pollTimer = setTimeout(pollEvents, 15000)
    }

    // Initial fetch after engine is ready
    const initTimer = setTimeout(pollEvents, 1000)
    return () => {
      cancelled = true
      clearTimeout(initTimer)
      clearTimeout(pollTimer)
    }
  }, [namedGraphNodes])

  useEffect(() => {
    if (!canvasRef.current) return
    engineRef.current = initTrustGraph(canvasRef.current, handleNodeClick)
    return () => engineRef.current?.destroy()
  }, [handleNodeClick])

  const fireManualEvent = useCallback((agentId: string, delta: number, label: string) => {
    engineRef.current?.applyEvent(agentId, delta, label)
    setAgentScores(prev => ({
      ...prev,
      [agentId]: Math.max(0, Math.min(100, (prev[agentId] ?? 50) + delta))
    }))
    setEvents(prev => [{
      nodeId: agentId,
      label: `${namedGraphNodes.find(n => n.id === agentId)?.label ?? agentId}: ${label}`,
      delta,
      ts: Date.now(),
    }, ...prev.slice(0, 7)])
  }, [namedGraphNodes])

  const selected = namedGraphNodes.find(n => n.id === selectedAgent)
  const selectedScore = selectedAgent ? (agentScores[selectedAgent] ?? 50) : null

  // Build overlay data for clicked node
  const clickedGraphNode = clickedNode ? namedGraphNodes.find(n => n.id === clickedNode.id) : null
  const clickedScore = clickedNode ? (agentScores[clickedNode.id] ?? 50) : 0
  const clickedSc = scoreColor(clickedScore)
  const clickedSectorVals = clickedGraphNode
    ? [
        clickedScore / 100,
        clickedGraphNode.files ? clickedGraphNode.files.length / Math.max(clickedGraphNode.files.length, 1) : 0.5,
        clickedGraphNode.type === 'governance' ? 0.85 : clickedGraphNode.type === 'investor' ? 0.65 : 0.75,
        0.6, // placeholder for link density
      ]
    : []

  return (
    <section id="trustgraph" className="py-24" style={{ background: 'var(--bg1)' }}>
      <div className="max-w-[1200px] mx-auto px-8">

        {/* Header */}
        <div className="reveal mb-10">
          <p className="section-label">Constitutional Infrastructure</p>
          <h2 className="section-title">TrustGraph —<br /><em>live constitutional scoring</em></h2>
          <p className="text-[11px] tracking-[0.06em] text-[rgba(255,160,0,0.55)] max-w-[600px] leading-[1.9] mt-3">
            Every agent interaction is scored in real-time. Trust is slow to earn and fast to lose — asymmetric by design. Click any named node to expand its constitutional detail rings.
          </p>
        </div>

        <div className="reveal grid grid-cols-1 md:grid-cols-[1fr_320px] gap-[1px]" style={{ background: 'var(--border)' }}>

          {/* Canvas */}
          <div className="relative" style={{ background: 'var(--bg0)', height: 'clamp(320px, 50vw, 480px)' }}>
            <canvas ref={canvasRef} className="block w-full h-full" />

            {/* Click-node overlay panel */}
            {clickedNode && clickedGraphNode && (
              <div
                className="absolute z-10 pointer-events-none"
                style={{
                  left: `${Math.min(Math.max(clickedNode.xFrac * 100, 8), 62)}%`,
                  top: `${Math.min(Math.max(clickedNode.yFrac * 100, 10), 80)}%`,
                  transform: clickedNode.xFrac > 0.55 ? 'translate(-100%, -50%)' : 'translate(20px, -50%)',
                  width: 168,
                }}
              >
                <div
                  className="flex flex-col gap-2 p-3"
                  style={{
                    background: 'rgba(6,2,0,0.92)',
                    border: `0.5px solid ${clickedSc}55`,
                    backdropFilter: 'blur(8px)',
                  }}
                >
                  {/* Header */}
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-display text-[13px] font-semibold" style={{ color: clickedSc }}>
                        {clickedGraphNode.label}
                      </div>
                      <div className="text-[7px] tracking-[0.1em] uppercase" style={{ color: 'rgba(255,160,0,0.45)' }}>
                        {clickedGraphNode.type}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="w-1.5 h-1.5 rounded-full"
                        style={{ background: clickedGraphNode.type === 'governance' ? '#44ffaa' : clickedGraphNode.type === 'investor' ? '#ffaa00' : '#aa88ff' }} />
                      <span className="text-[7px] tracking-[0.08em] uppercase" style={{ color: 'rgba(255,160,0,0.4)' }}>
                        {clickedGraphNode.type}
                      </span>
                    </div>
                  </div>

                  {/* Trust score */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[7px] tracking-[0.1em] uppercase" style={{ color: 'rgba(255,160,0,0.4)' }}>Trust</span>
                      <span className="font-display text-[14px] font-semibold" style={{ color: clickedSc }}>{Math.round(clickedScore)}</span>
                    </div>
                    <div className="h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,140,0,0.12)' }}>
                      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${clickedScore}%`, background: clickedSc }} />
                    </div>
                    <div className="text-[7px] tracking-[0.08em] mt-0.5" style={{ color: `${clickedSc}88` }}>
                      {scoreLabel(clickedScore)}
                    </div>
                  </div>

                  {/* 4 pie sector bars */}
                  <div className="flex flex-col gap-1">
                    {PIE_SECTORS.map((s, i) => (
                      <div key={s.key} className="flex items-center gap-1.5">
                        <span className="text-[6px] tracking-[0.1em] uppercase shrink-0" style={{ color: `${s.color}99`, width: 36 }}>{s.key}</span>
                        <div className="flex-1 h-0.5 rounded-full" style={{ background: 'rgba(255,140,0,0.1)' }}>
                          <div className="h-full rounded-full" style={{ width: `${(clickedSectorVals[i] ?? 0) * 100}%`, background: s.color }} />
                        </div>
                        <span className="text-[6px] font-display shrink-0" style={{ color: `${s.color}aa`, minWidth: 20, textAlign: 'right' }}>
                          {Math.round((clickedSectorVals[i] ?? 0) * 100)}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Files */}
                  <div className="flex flex-wrap gap-1 pt-1" style={{ borderTop: '0.5px solid rgba(255,140,0,0.12)' }}>
                    {clickedGraphNode.files && clickedGraphNode.files.slice(0, 3).map((f, i) => (
                      <span key={i} className="text-[6.5px] tracking-[0.06em] px-1 py-0.5"
                        style={{ border: '0.5px solid rgba(255,140,0,0.2)', color: 'rgba(255,160,0,0.5)' }}>
                        {f.name}
                      </span>
                    ))}
                  </div>

                  <div className="text-[6px] tracking-[0.08em]" style={{ color: 'rgba(255,160,0,0.3)' }}>
                    {clickedGraphNode.type} · click node to dismiss
                  </div>
                </div>
              </div>
            )}

            {/* Score legend */}
            <div className="absolute top-4 left-4 flex flex-col gap-1.5">
              {[
                { label: '80–100 Trusted', color: '#44ffaa' },
                { label: '60–79 Established', color: '#ffbb33' },
                { label: '35–59 Neutral', color: '#ff8800' },
                { label: '0–34 Flagged', color: '#ff3399' },
              ].map((l, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full" style={{ background: l.color }} />
                  <span className="text-[8px] tracking-[0.08em]" style={{ color: 'rgba(255,160,0,0.45)' }}>{l.label}</span>
                </div>
              ))}
            </div>

            {/* Live + click hint */}
            <div className="absolute top-4 right-4 flex flex-col items-end gap-1">
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: '#44ffaa', boxShadow: '0 0 5px #44ffaa', animation: 'pulse-dot 1.5s infinite' }} />
                <span className="text-[8px] tracking-[0.12em] uppercase" style={{ color: 'rgba(68,255,170,0.6)' }}>Live</span>
              </div>
              <span className="text-[7px] tracking-[0.08em]" style={{ color: 'rgba(255,160,0,0.3)' }}>click node to inspect</span>
            </div>
          </div>

          {/* Right panel */}
          <div className="flex flex-col" style={{ background: 'var(--bg1)' }}>

            {/* Agent selector */}
            <div className="p-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.4)] uppercase mb-3">Agent Scores</div>
              <div className="flex flex-col gap-1">
                {namedGraphNodes.map(n => {
                  const score = agentScores[n.id] ?? 50
                  const sc = scoreColor(score)
                  return (
                    <button key={n.id}
                      onClick={() => {
                        const newId = selectedAgent === n.id ? null : n.id
                        setSelectedAgent(newId)
                        engineRef.current?.setSelected(newId)
                        if (!newId) setClickedNode(null)
                      }}
                      className="flex items-center justify-between p-2 text-left transition-all cursor-pointer"
                      style={{
                        background: selectedAgent === n.id ? `${sc}12` : 'transparent',
                        border: `0.5px solid ${selectedAgent === n.id ? `${sc}55` : 'transparent'}`,
                      }}>
                      <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full" style={{ background: sc }} />
                        <span className="text-[9px] tracking-[0.06em]" style={{ color: sc }}>{n.label}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-1 rounded-full overflow-hidden" style={{ width: 48, background: 'rgba(255,140,0,0.1)' }}>
                          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${score}%`, background: sc }} />
                        </div>
                        <span className="text-[9px] font-display" style={{ color: sc, minWidth: 24, textAlign: 'right' }}>{Math.round(score)}</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Selected agent actions */}
            {selected && selectedScore !== null && (
              <div className="p-4 border-b" style={{ borderColor: 'var(--border)' }}>
                <div className="text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.4)] uppercase mb-2">
                  Fire Event → {selected.label}
                </div>
                <div className="flex flex-col gap-1">
                  {[
                    { label: 'Governance vote', delta: +5 },
                    { label: 'Security audit', delta: +8 },
                    { label: 'Rule violation', delta: -15 },
                    { label: 'Injection attempt', delta: -50 },
                  ].map((ev, i) => (
                    <button key={i}
                      onClick={() => fireManualEvent(selected.id, ev.delta, ev.label)}
                      className="flex items-center justify-between px-2.5 py-1.5 text-left transition-all cursor-pointer font-mono"
                      style={{
                        border: `0.5px solid ${ev.delta > 0 ? 'rgba(68,255,170,0.2)' : 'rgba(255,51,153,0.2)'}`,
                        color: ev.delta > 0 ? 'rgba(68,255,170,0.7)' : 'rgba(255,51,153,0.7)',
                        fontSize: 8, letterSpacing: '0.08em', textTransform: 'uppercase', background: 'transparent',
                      }}
                      onMouseOver={e => (e.currentTarget.style.background = ev.delta > 0 ? 'rgba(68,255,170,0.05)' : 'rgba(255,51,153,0.05)')}
                      onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                      <span>{ev.label}</span>
                      <span className="font-display text-[14px] font-semibold">{ev.delta > 0 ? '+' : ''}{ev.delta}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Event log */}
            <div className="flex-1 p-4 overflow-hidden">
              <div className="text-[8px] tracking-[0.14em] text-[rgba(255,160,0,0.4)] uppercase mb-3">Event Log</div>
              <div className="flex flex-col gap-1.5">
                {events.length === 0 && (
                  <div className="text-[8px] text-[rgba(255,160,0,0.3)] tracking-[0.06em]">Awaiting events...</div>
                )}
                {events.map((ev, i) => (
                  <div key={`${ev.ts}-${i}`} className="flex items-start justify-between gap-2"
                    style={{ opacity: 1 - i * 0.1 }}>
                    <span className="text-[8px] tracking-[0.04em] text-[rgba(255,160,0,0.55)] leading-[1.5]">{ev.label}</span>
                    <span className="text-[9px] font-display shrink-0 font-semibold"
                      style={{ color: ev.delta > 0 ? '#44ffaa' : '#ff3399' }}>
                      {ev.delta > 0 ? '+' : ''}{ev.delta}
                    </span>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>

        {/* Mechanics explainer */}
        <div className="reveal grid grid-cols-1 md:grid-cols-3 gap-[1px] mt-[1px]" style={{ background: 'var(--border)' }}>
          {[
            { icon: '⊙', color: 'var(--green)', title: 'Asymmetric Curve', desc: 'Trust is earned slowly through consistent governance participation, code contributions, and security audits. It is lost quickly through violations — by constitutional design.' },
            { icon: '⟡', color: 'var(--cyan)', title: 'Cross-DAO Portable', desc: 'TrustGraph scores follow agents across the network via CACTransferProtocol.sol. Your constitutional reputation is your identity — it travels with your CAC.' },
            { icon: '◈', color: 'var(--purple)', title: 'Permanent Record', desc: 'All scoring events are anchored on-chain. Constitutional violations are immutable record. Agents cannot escape history — which is the point.' },
          ].map((m, i) => (
            <div key={i} className="p-6" style={{ background: 'var(--bg1)', borderLeft: i > 0 ? '0.5px solid var(--border)' : 'none' }}>
              <div className="text-[20px] mb-2" style={{ color: m.color }}>{m.icon}</div>
              <div className="text-[9px] tracking-[0.14em] uppercase mb-2" style={{ color: m.color }}>{m.title}</div>
              <div className="text-[9px] leading-[1.8] tracking-[0.04em] text-[rgba(255,160,0,0.55)]">{m.desc}</div>
            </div>
          ))}
        </div>

      </div>
    </section>
  )
}
