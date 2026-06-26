'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { STACK_LAYERS } from '../../lib/mockData'

// ── CAPITAL STACK NODE DATA ───────────────────────────────────────────
interface CSNode {
  id: string
  name: string
  sub: string
  amountM: number   // dollars in millions
  pct: number       // % of total cap
  color: string
  seniority: number // 0-1, higher = more senior
  yield: number     // 0-1 normalized attractiveness
  coverage: number  // 0-1 LTV / coverage proxy
  x: number; y: number
  vx: number; vy: number
  r: number
  pulsePhase: number
}

const CS_NODE_DEFS = [
  { id: 'cpace',    name: 'C-PACE',     sub: 'Senior Retrofit',  amountM: 25.5,  pct: 75,   color: '#00ffcc', seniority: 0.88, yield: 0.72, coverage: 0.92 },
  { id: 'sba_priv', name: 'SBA Private',sub: '1st Lien',         amountM: 2.75,  pct: 8,    color: '#ff8800', seniority: 0.70, yield: 0.60, coverage: 0.75 },
  { id: 'sba_cdc',  name: 'SBA 504',    sub: '2nd Lien Gov',     amountM: 2.2,   pct: 6.5,  color: '#ffaa00', seniority: 0.60, yield: 0.68, coverage: 0.65 },
  { id: 'dao_reit', name: 'DAO-REIT',   sub: 'Equity · Open',    amountM: 0.55,  pct: 1.6,  color: '#ff3399', seniority: 0.28, yield: 0.95, coverage: 0.30 },
  { id: 'founder',  name: 'Founder',    sub: 'Equity Floor',     amountM: 0.055, pct: 0.18, color: '#aa88ff', seniority: 0.18, yield: 1.00, coverage: 0.20 },
]

const CS_PIE_SECTORS = [
  { key: 'CAPITAL',  color: '#00ffcc' },
  { key: 'SENIOR',   color: '#ffaa00' },
  { key: 'YIELD',    color: '#ff3399' },
  { key: 'COVERAGE', color: '#6274ea' },
]

const CS_EDGES = [
  ['cpace', 'sba_priv'],
  ['sba_priv', 'sba_cdc'],
  ['sba_cdc', 'dao_reit'],
  ['dao_reit', 'founder'],
]

function initCapitalGraph(
  canvas: HTMLCanvasElement,
  onNodeClick: (nodeId: string | null, xFrac: number, yFrac: number) => void,
): { destroy: () => void; setSelected: (id: string | null) => void } {
  const ctx = canvas.getContext('2d')!
  let W = 0, H = 0
  let tick = 0
  let rafId = 0
  let nodes: CSNode[] = []
  let selectedId: string | null = null
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const maxAmt = Math.log(CS_NODE_DEFS[0].amountM + 1)

  function resize() {
    W = canvas.offsetWidth
    H = canvas.offsetHeight
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function initNodes() {
    nodes = CS_NODE_DEFS.map((d, i) => {
      const r = 12 + (Math.log(d.amountM + 1) / maxAmt) * 24
      const cx = W / 2 + (Math.random() - 0.5) * 60
      const targetY = H * (1 - d.seniority) * 0.75 + H * 0.12
      return {
        ...d,
        x: cx, y: targetY + (Math.random() - 0.5) * 40,
        vx: 0, vy: 0,
        r,
        pulsePhase: (i / CS_NODE_DEFS.length) * Math.PI * 2,
      }
    })
  }

  function resolveEdgeNodes(a: string, b: string) {
    return [nodes.find(n => n.id === a)!, nodes.find(n => n.id === b)!] as [CSNode, CSNode]
  }

  function physics() {
    nodes.forEach(n => {
      const def = CS_NODE_DEFS.find(d => d.id === n.id)!
      const targetY = H * (1 - def.seniority) * 0.75 + H * 0.12

      // Drift
      n.vx += (Math.random() - 0.5) * 0.1
      n.vy += (Math.random() - 0.5) * 0.1

      // Seniority y-gravity (gentle)
      n.vy += (targetY - n.y) * 0.004

      // x-center pull
      n.vx += (W / 2 - n.x) * 0.001

      // Node repulsion
      nodes.forEach(m => {
        if (m === n) return
        const dx = n.x - m.x, dy = n.y - m.y
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.01
        const minDist = n.r + m.r + 24
        if (dist < minDist) {
          const force = (minDist - dist) / minDist * 0.5
          n.vx += (dx / dist) * force
          n.vy += (dy / dist) * force
        }
      })

      n.vx *= 0.86; n.vy *= 0.86
      n.x += n.vx; n.y += n.vy

      const pad = n.r + 16
      if (n.x < pad) n.vx += 0.5
      if (n.x > W - pad) n.vx -= 0.5
      if (n.y < pad) n.vy += 0.5
      if (n.y > H - pad) n.vy -= 0.5
    })
  }

  function drawSelectedRings(n: CSNode, sc: string, nr: number, def: typeof CS_NODE_DEFS[number]) {
    // Selection highlight
    ctx.beginPath(); ctx.arc(n.x, n.y, nr + 3, 0, Math.PI * 2)
    ctx.strokeStyle = `${sc}99`; ctx.lineWidth = 1.5; ctx.stroke()

    // Ring 1: capital share donut (nr+7 to nr+13)
    const r1i = nr + 7, r1o = nr + 13
    const capVal = Math.log(def.amountM + 1) / maxAmt
    ctx.beginPath(); ctx.arc(n.x, n.y, r1o, 0, Math.PI * 2); ctx.arc(n.x, n.y, r1i, Math.PI * 2, 0, true); ctx.closePath()
    ctx.fillStyle = sc; ctx.globalAlpha = 0.1; ctx.fill(); ctx.globalAlpha = 1
    const capEnd = -Math.PI / 2 + Math.PI * 2 * capVal
    ctx.beginPath(); ctx.arc(n.x, n.y, r1o, -Math.PI / 2, capEnd); ctx.arc(n.x, n.y, r1i, capEnd, -Math.PI / 2, true); ctx.closePath()
    ctx.fillStyle = sc; ctx.globalAlpha = 0.75; ctx.fill(); ctx.globalAlpha = 1

    // Ring 2: 4-sector pie (nr+17 to nr+27)
    const r2i = nr + 17, r2o = nr + 27
    const sectorVals = [capVal, def.seniority, def.yield, def.coverage]

    sectorVals.forEach((val, i) => {
      const color = CS_PIE_SECTORS[i].color
      const sStart = -Math.PI / 2 + i * (Math.PI / 2)
      const sEnd   = sStart + Math.PI / 2
      const fillEnd = sStart + (Math.PI / 2) * Math.min(1, val)

      ctx.beginPath(); ctx.arc(n.x, n.y, r2o, sStart, sEnd); ctx.arc(n.x, n.y, r2i, sEnd, sStart, true); ctx.closePath()
      ctx.fillStyle = color; ctx.globalAlpha = 0.08; ctx.fill(); ctx.globalAlpha = 1

      if (fillEnd > sStart) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r2o, sStart, fillEnd); ctx.arc(n.x, n.y, r2i, fillEnd, sStart, true); ctx.closePath()
        ctx.fillStyle = color; ctx.globalAlpha = 0.6; ctx.fill(); ctx.globalAlpha = 1
      }

      ctx.beginPath()
      ctx.moveTo(n.x + Math.cos(sStart) * r2i, n.y + Math.sin(sStart) * r2i)
      ctx.lineTo(n.x + Math.cos(sStart) * r2o, n.y + Math.sin(sStart) * r2o)
      ctx.strokeStyle = 'rgba(6,2,0,0.9)'; ctx.lineWidth = 1; ctx.stroke()

      const midA = sStart + Math.PI / 4
      ctx.font = '6px monospace'; ctx.textAlign = 'center'
      ctx.fillStyle = `${color}cc`
      ctx.fillText(CS_PIE_SECTORS[i].key, n.x + Math.cos(midA) * (r2o + 9), n.y + Math.sin(midA) * (r2o + 9) + 2)
    })

    // Ring 3: outer tick ring
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

    // Ring 4: animated pulse
    const pulseR = nr + 44 + Math.sin(tick * 0.06) * 5
    ctx.beginPath(); ctx.arc(n.x, n.y, pulseR, 0, Math.PI * 2)
    ctx.strokeStyle = `${sc}22`; ctx.lineWidth = 0.75; ctx.stroke()
  }

  function draw() {
    tick++
    ctx.clearRect(0, 0, W, H)

    // Grid dots
    ctx.fillStyle = 'rgba(255,140,0,0.04)'
    for (let gx = 0; gx < W; gx += 40)
      for (let gy = 0; gy < H; gy += 40)
        ctx.fillRect(gx, gy, 1, 1)

    // Seniority bands (background)
    const bandLabels = [
      { label: 'Senior Debt', yFrac: 0.12, color: '#00ffcc' },
      { label: 'Junior Debt', yFrac: 0.45, color: '#ffaa00' },
      { label: 'Equity', yFrac: 0.72, color: '#ff3399' },
    ]
    bandLabels.forEach(b => {
      ctx.font = '7px monospace'; ctx.textAlign = 'left'
      ctx.fillStyle = `${b.color}22`
      ctx.fillText(b.label.toUpperCase(), 8, b.yFrac * H)
    })

    // Edges
    CS_EDGES.forEach(([aId, bId]) => {
      const [a, b] = resolveEdgeNodes(aId, bId)
      if (!a || !b) return
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y)
      ctx.strokeStyle = 'rgba(255,140,0,0.12)'; ctx.lineWidth = 0.5; ctx.stroke()
      // Flow dot
      const t = ((tick * 0.008) % 1)
      const px = a.x + (b.x - a.x) * t
      const py = a.y + (b.y - a.y) * t
      ctx.beginPath(); ctx.arc(px, py, 1.5, 0, Math.PI * 2)
      ctx.fillStyle = a.color; ctx.globalAlpha = 0.4; ctx.fill(); ctx.globalAlpha = 1
    })

    // Nodes (selected drawn last)
    const ordered = [...nodes].sort((a, b) => (a.id === selectedId ? 1 : b.id === selectedId ? -1 : 0))

    ordered.forEach(n => {
      const sc = n.color
      const pulse = Math.sin(tick * 0.035 + n.pulsePhase) * 0.12 + 0.88
      const nr = n.r * pulse
      const isSelected = n.id === selectedId
      const def = CS_NODE_DEFS.find(d => d.id === n.id)!

      if (isSelected) drawSelectedRings(n, sc, nr, def)

      // Glow
      ctx.beginPath(); ctx.arc(n.x, n.y, nr * 2.2, 0, Math.PI * 2)
      ctx.fillStyle = `${sc}18`; ctx.fill()

      // Outer ring
      ctx.beginPath(); ctx.arc(n.x, n.y, nr * 1.3, 0, Math.PI * 2)
      ctx.strokeStyle = `${sc}44`; ctx.lineWidth = 0.5; ctx.stroke()

      // Main ring
      ctx.beginPath(); ctx.arc(n.x, n.y, nr, 0, Math.PI * 2)
      ctx.strokeStyle = isSelected ? `${sc}ff` : `${sc}cc`; ctx.lineWidth = 1.5; ctx.stroke()

      // Fill
      ctx.beginPath(); ctx.arc(n.x, n.y, nr * 0.85, 0, Math.PI * 2)
      ctx.fillStyle = `${sc}14`; ctx.fill()

      // Capital % arc (when not selected)
      if (!isSelected) {
        const capVal = Math.log(def.amountM + 1) / maxAmt
        const arcEnd = -Math.PI / 2 + Math.PI * 2 * capVal
        ctx.beginPath(); ctx.arc(n.x, n.y, nr + 4, -Math.PI / 2, arcEnd)
        ctx.strokeStyle = `${sc}99`; ctx.lineWidth = 2; ctx.stroke()
      }

      // Label
      const labelOffset = isSelected ? nr + 52 : nr + 18
      ctx.font = `9px 'Share Tech Mono', monospace`; ctx.textAlign = 'center'
      ctx.fillStyle = isSelected ? `${sc}ff` : `${sc}cc`
      ctx.fillText(n.name, n.x, n.y + labelOffset)
      ctx.fillStyle = 'rgba(255,160,0,0.5)'; ctx.font = `7px 'Share Tech Mono', monospace`
      ctx.fillText(def.amountM >= 1 ? `$${def.amountM}M` : `$${Math.round(def.amountM * 1000)}K`, n.x, n.y + labelOffset + 10)
    })

    physics()
    rafId = requestAnimationFrame(draw)
  }

  canvas.addEventListener('click', (evt) => {
    const rect = canvas.getBoundingClientRect()
    const mx = (evt.clientX - rect.left) * (W / rect.width)
    const my = (evt.clientY - rect.top) * (H / rect.height)
    let bestDist = Infinity
    const hit = nodes.reduce<CSNode | null>((best, n) => {
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

  canvas.addEventListener('mousemove', (evt) => {
    const rect = canvas.getBoundingClientRect()
    const mx = (evt.clientX - rect.left) * (W / rect.width)
    const my = (evt.clientY - rect.top) * (H / rect.height)
    const hit = nodes.some(n => Math.hypot(mx - n.x, my - n.y) <= n.r + 35)
    canvas.style.cursor = hit ? 'pointer' : 'default'
  })

  const resizeObserver = new ResizeObserver(() => { resize(); initNodes() })
  resizeObserver.observe(canvas)
  resize(); initNodes()
  // draw() self-schedules — no external start needed

  return {
    destroy: () => { cancelAnimationFrame(rafId); resizeObserver.disconnect() },
    setSelected: (id) => { selectedId = id },
  }
}

// ── COMPONENT ─────────────────────────────────────────────────────────
export default function CapitalStack() {
  const [expanded, setExpanded] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<ReturnType<typeof initCapitalGraph> | null>(null)
  const [clickedNode, setClickedNode] = useState<{ id: string; xFrac: number; yFrac: number } | null>(null)

  const handleNodeClick = useCallback((nodeId: string | null, xFrac: number, yFrac: number) => {
    setClickedNode(nodeId ? { id: nodeId, xFrac, yFrac } : null)
  }, [])

  useEffect(() => {
    if (!canvasRef.current) return
    engineRef.current = initCapitalGraph(canvasRef.current, handleNodeClick)
    return () => engineRef.current?.destroy()
  }, [handleNodeClick])

  const clickedDef = clickedNode ? CS_NODE_DEFS.find(d => d.id === clickedNode.id) : null
  const clickedLayer = clickedNode ? STACK_LAYERS.find(l => {
    const map: Record<string, string> = { cpace: 'C-PACE Retrofit', sba_priv: 'SBA 504 Private', sba_cdc: 'SBA 504 CDC', dao_reit: 'DAO-REIT Equity' }
    return l.name === map[clickedNode.id]
  }) : null

  return (
    <section id="capital" className="px-8 py-20">
      <div className="max-w-[1200px] mx-auto">
        <div className="reveal">
          <p className="section-label">$31M Acquisition</p>
          <h2 className="section-title">
            Capital<br />
            <em>Stack</em>
          </h2>
          <p className="text-[11px] tracking-[0.08em] text-[rgba(255,160,0,0.55)] max-w-[560px] leading-[2] mt-4 mb-10">
            Non-recourse debt structure with C-PACE retrofit financing.
            Minimal founder capital at risk. Property transfers encumbered debt.
            DAO-REIT equity tranche now open.
          </p>
        </div>

        {/* ── Node Visualization ── */}
        <div className="reveal mb-8 grid grid-cols-1 md:grid-cols-[1fr,280px] gap-[1px]" style={{ background: 'var(--border)' }}>
          {/* Canvas */}
          <div className="relative" style={{ background: 'var(--bg0)', height: 'clamp(280px, 50vw, 380px)' }}>
            <canvas ref={canvasRef} className="block w-full h-full" />

            {/* Node overlay panel */}
            {clickedNode && clickedDef && (
              <div
                className="absolute z-10 pointer-events-none max-sm:!left-4 max-sm:!right-4 max-sm:!top-auto max-sm:!bottom-4 max-sm:!transform-none max-sm:w-auto"
                style={{
                  left: `${Math.min(Math.max(clickedNode.xFrac * 100, 6), 58)}%`,
                  top: `${Math.min(Math.max(clickedNode.yFrac * 100, 10), 78)}%`,
                  transform: clickedNode.xFrac > 0.5 ? 'translate(-100%, -50%)' : 'translate(20px, -50%)',
                  width: 172,
                }}
              >
                <div
                  className="flex flex-col gap-2 p-3"
                  style={{
                    background: 'rgba(6,2,0,0.92)',
                    border: `0.5px solid ${clickedDef.color}55`,
                    backdropFilter: 'blur(8px)',
                  }}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-display text-[13px] font-semibold" style={{ color: clickedDef.color }}>
                        {clickedDef.name}
                      </div>
                      <div className="text-[7px] tracking-[0.1em] uppercase" style={{ color: 'rgba(255,160,0,0.45)' }}>
                        {clickedDef.sub}
                      </div>
                    </div>
                    <div className="font-display text-[16px] font-bold" style={{ color: clickedDef.color }}>
                      {clickedDef.amountM >= 1 ? `$${clickedDef.amountM}M` : `$${Math.round(clickedDef.amountM * 1000)}K`}
                    </div>
                  </div>

                  {/* 4 sector bars */}
                  <div className="flex flex-col gap-1">
                    {CS_PIE_SECTORS.map((s, i) => {
                      const vals = [
                        Math.log(clickedDef.amountM + 1) / Math.log(CS_NODE_DEFS[0].amountM + 1),
                        clickedDef.seniority,
                        clickedDef.yield,
                        clickedDef.coverage,
                      ]
                      return (
                        <div key={s.key} className="flex items-center gap-1.5">
                          <span className="text-[6px] tracking-[0.1em] uppercase shrink-0" style={{ color: `${s.color}99`, width: 46 }}>{s.key}</span>
                          <div className="flex-1 h-0.5 rounded-full" style={{ background: 'rgba(255,140,0,0.1)' }}>
                            <div className="h-full rounded-full" style={{ width: `${vals[i] * 100}%`, background: s.color }} />
                          </div>
                          <span className="text-[6px] font-display shrink-0" style={{ color: `${s.color}aa`, minWidth: 22, textAlign: 'right' }}>
                            {Math.round(vals[i] * 100)}%
                          </span>
                        </div>
                      )
                    })}
                  </div>

                  {/* Details text */}
                  {clickedLayer && (
                    <div className="text-[7.5px] leading-[1.7] tracking-[0.03em] pt-1" style={{ borderTop: '0.5px solid rgba(255,140,0,0.12)', color: 'rgba(255,160,0,0.6)' }}>
                      {clickedLayer.details.slice(0, 160)}…
                    </div>
                  )}
                  {!clickedLayer && clickedDef.id === 'founder' && (
                    <div className="text-[7.5px] leading-[1.7] tracking-[0.03em] pt-1" style={{ borderTop: '0.5px solid rgba(255,140,0,0.12)', color: 'rgba(255,160,0,0.6)' }}>
                      Founder equity floor — $55K at risk. Delaware Series LLC. No personal guarantee beyond this position.
                    </div>
                  )}

                  <div className="text-[6px] tracking-[0.08em]" style={{ color: 'rgba(255,160,0,0.3)' }}>
                    {clickedDef.pct}% of total cap · click to dismiss
                  </div>
                </div>
              </div>
            )}

            {/* Legend */}
            <div className="absolute top-4 left-4 flex flex-col gap-1.5">
              <div className="text-[7px] tracking-[0.1em] uppercase mb-1" style={{ color: 'rgba(255,160,0,0.3)' }}>Capital Stack</div>
              {CS_NODE_DEFS.map(d => (
                <div key={d.id} className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full" style={{ background: d.color }} />
                  <span className="text-[7.5px] tracking-[0.06em]" style={{ color: 'rgba(255,160,0,0.45)' }}>{d.name}</span>
                </div>
              ))}
            </div>

            {/* Hint */}
            <div className="absolute top-4 right-4">
              <span className="text-[7px] tracking-[0.08em]" style={{ color: 'rgba(255,160,0,0.3)' }}>click node to inspect</span>
            </div>
          </div>

          {/* Right: pie sector legend */}
          <div className="p-5 flex flex-col gap-4" style={{ background: 'var(--bg1)' }}>
            <div className="text-[8px] tracking-[0.14em] uppercase" style={{ color: 'rgba(255,160,0,0.4)' }}>Ring Layers</div>
            <div className="flex flex-col gap-3">
              {[
                { ring: 'Ring 1', label: 'Capital Share', desc: 'Proportional share of $31M total cap. Larger arc = larger tranche.', color: '#00ffcc' },
                { ring: 'Ring 2', label: '4-Sector Pie', desc: 'CAPITAL · SENIOR · YIELD · COVERAGE — each sector fills 0–100%.', color: '#ffaa00' },
                { ring: 'Ring 3', label: 'Tick Ring', desc: '16-point reference ring with major ticks at 90° intervals.', color: '#6274ea' },
                { ring: 'Ring 4', label: 'Pulse Ring', desc: 'Animated outer ring. Breathing speed reflects tranche activity.', color: '#aa88ff' },
              ].map((r, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full" style={{ background: r.color }} />
                    <span className="text-[8px] tracking-[0.1em] uppercase" style={{ color: r.color }}>{r.ring} — {r.label}</span>
                  </div>
                  <div className="text-[8px] leading-[1.65] tracking-[0.03em]" style={{ color: 'rgba(255,160,0,0.45)', paddingLeft: 14 }}>
                    {r.desc}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-auto pt-4" style={{ borderTop: '0.5px solid var(--border)' }}>
              <div className="text-[8px] tracking-[0.1em] uppercase mb-2" style={{ color: 'rgba(255,51,153,0.7)' }}>
                ⊙ Now Open
              </div>
              <div className="font-display text-[13px] font-semibold text-white">DAO-REIT Equity</div>
              <div className="text-[8px] tracking-[0.04em] mt-1" style={{ color: 'rgba(255,160,0,0.5)' }}>
                $550K · min $25K · tokenized
              </div>
            </div>
          </div>
        </div>

        {/* ── Existing stack + summary ── */}
        <div className="grid gap-6 grid-cols-1 md:grid-cols-[1fr,400px]">
          {/* Stack Visualization */}
          <div className="reveal flex flex-col gap-2">
            {STACK_LAYERS.map((layer) => (
              <div
                key={layer.name}
                className="relative cursor-pointer transition-all duration-300"
                style={{
                  flex: `0 0 ${parseFloat(layer.percent) * 1.8}px`,
                  minHeight: '60px'
                }}
                onClick={() => setExpanded(expanded === layer.name ? null : layer.name)}
              >
                <div
                  className={`absolute inset-0 border transition-all ${expanded === layer.name ? 'scale-[1.02]' : ''}`}
                  style={{ background: layer.bgColor, borderColor: layer.borderColor }}
                />
                <div className="relative p-4 flex items-center justify-between h-full">
                  <div className="flex items-center gap-4">
                    <div className="w-2 h-full min-h-[20px]" style={{ background: layer.color }} />
                    <div>
                      <div className="font-display text-[16px] font-semibold" style={{ color: layer.color }}>
                        {layer.name}
                      </div>
                      <div className="text-[9px] tracking-[0.06em] text-[rgba(255,160,0,0.5)] mt-0.5">
                        {layer.description}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-display text-[20px] font-bold" style={{ color: layer.color }}>
                      {layer.amount}
                    </div>
                    <div className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.4)]">
                      {layer.percent}
                    </div>
                  </div>
                </div>
                {expanded === layer.name && (
                  <div className="relative mt-2 p-4 border-t" style={{ borderColor: layer.borderColor }}>
                    <p className="text-[10px] tracking-[0.04em] text-[rgba(255,160,0,0.65)] leading-[1.9]">
                      {layer.details}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Summary Panel */}
          <div className="reveal">
            <div className="p-5 border border-[var(--border)] bg-[rgba(255,140,0,0.02)]">
              <h3 className="font-display text-[14px] font-semibold text-white mb-4">Acquisition Summary</h3>
              <div className="space-y-4">
                <div className="flex justify-between items-center pb-3 border-b border-[var(--border)]">
                  <span className="text-[10px] tracking-[0.08em] text-[rgba(255,160,0,0.5)]">Total Capitalization</span>
                  <span className="font-display text-[18px] font-semibold text-[var(--amber)]">$31M</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] tracking-[0.08em] text-[rgba(255,160,0,0.5)]">Senior Debt (C-PACE)</span>
                  <span className="text-[12px] text-[var(--green)]">$25.5M</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] tracking-[0.08em] text-[rgba(255,160,0,0.5)]">SBA 504 (CDC + Private)</span>
                  <span className="text-[12px] text-[var(--amber)]">$4.95M</span>
                </div>
                <div className="flex justify-between items-center pb-3 border-b border-[var(--border)]">
                  <span className="text-[10px] tracking-[0.08em] text-[rgba(255,160,0,0.5)]">DAO-REIT Equity</span>
                  <span className="text-[12px] text-[var(--pink)]">$550K</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] tracking-[0.08em] text-[rgba(255,160,0,0.5)]">Founder Capital at Risk</span>
                  <span className="text-[12px] text-white">~$55K</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] tracking-[0.08em] text-[rgba(255,160,0,0.5)]">Personal Guarantee</span>
                  <span className="text-[12px] text-[var(--green)]">None</span>
                </div>
              </div>
              <div className="mt-6 pt-4 border-t border-[var(--border)]">
                <div className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.35)] uppercase mb-2">Key Terms</div>
                <div className="text-[9px] tracking-[0.04em] text-[rgba(255,160,0,0.5)] leading-[1.9]">
                  C-PACE transfers with property. No personal guarantee required.
                  Delaware Series LLC structure isolates each asset.
                  DAO governance from day one via smart contracts.
                </div>
              </div>
            </div>

            <div className="mt-4 p-4 border border-[var(--pink)] bg-[rgba(255,51,153,0.05)]">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-[var(--pink)] animate-[pulse-dot_2s_ease-in-out_infinite]" />
                <span className="text-[8px] tracking-[0.12em] text-[var(--pink)] uppercase">Now Open</span>
              </div>
              <div className="font-display text-[14px] font-semibold text-white mb-1">DAO-REIT Equity Tranche</div>
              <div className="text-[9px] tracking-[0.04em] text-[rgba(255,160,0,0.5)]">
                $550K total · Minimum $25K · Tokenized via Delaware Series LLC
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
