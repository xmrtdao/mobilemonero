// @ts-nocheck
// Full viz engine — extracted from dao_reit_v12
// All interactive features: orbital nodes, campus pie rings, pool panels,
// DAO governance panels, agent file explorer, minimap, camera lock

export interface VizEngine {
  destroy: () => void
  setPalette: (p: string) => void
  setVisibleLayers: (v: Record<string, boolean>) => void
  tog: (key: string) => void
  toggleExplode: () => void
  toggleFly: () => void
  toggleLayer: (type: string) => void
  reset: () => void
}

export function initVizEngine(canvas: HTMLCanvasElement, wrapEl?: HTMLElement): VizEngine {
  const wrap = (wrapEl || canvas.parentElement) as HTMLElement
  const ctx = canvas.getContext('2d')!
  let W = 0, H = 0
  let dpr = Math.min(window.devicePixelRatio || 1, 2)

  // Create tip div
  const tip = document.createElement('div')
  tip.style.cssText = 'position:absolute;border-radius:2px;padding:8px 11px;font-size:9px;pointer-events:none;display:none;z-index:30;line-height:1.85;letter-spacing:.06em;white-space:pre;background:rgba(6,2,0,0.95);border:0.5px solid rgba(255,140,0,0.45);color:#ffbb33;font-family:Share Tech Mono,monospace;'
  wrap.appendChild(tip)

  // Create ctxMenu div
  const ctxMenu = document.createElement('div')
  ctxMenu.style.cssText = 'position:absolute;display:none;z-index:50;border-radius:2px;min-width:150px;overflow:hidden;background:rgba(6,2,0,0.97);border:0.5px solid rgba(255,140,0,0.4);'
  wrap.appendChild(ctxMenu)

  // Pinned panels container
  function getPinnedContainer(): HTMLElement {
    let el = wrap.querySelector('#viz-pinned') as HTMLElement
    if (!el) {
      el = document.createElement('div')
      el.id = 'viz-pinned'
      el.style.cssText = 'position:absolute;bottom:70px;right:14px;display:flex;flex-direction:column;gap:6px;z-index:15;pointer-events:all;'
      wrap.appendChild(el)
    }
    return el
  }

  let rafId = 0

  function resize(){W=wrap.offsetWidth;H=wrap.offsetHeight;canvas.width=W*dpr;canvas.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);}
  resize();window.addEventListener('resize',resize);

  const PAL={
    amber:{bg0:'#0e0600',bg1:'#060200',tunnel:'rgba(210,120,0,',streak:'rgba(255,160,20,',uiC:'rgba(255,145,0,',uiT:'#ffbb33',border:'rgba(210,120,0,0.28)',bg:'rgba(160,80,0,0.06)',scan:'rgba(255,145,0,0.1)',corner:'rgba(210,120,0,0.36)',types:{core:'#00ffcc',pool:'#ffaa00',tranche:'#ff6600',dao:'#ff3300',inst:'#ffdd44',agent:'#44ffaa',retail:'#7a5200'}},
    cyan: {bg0:'#00101e',bg1:'#000810',tunnel:'rgba(0,145,215,', streak:'rgba(0,195,255,', uiC:'rgba(0,195,255,', uiT:'#00d2ff',border:'rgba(0,165,255,0.25)',bg:'rgba(0,125,255,0.05)',scan:'rgba(0,195,255,0.1)',corner:'rgba(0,165,255,0.32)',types:{core:'#00ffcc',pool:'#00aaff',tranche:'#ffaa00',dao:'#ff3399',inst:'#aa88ff',agent:'#00ffaa',retail:'#1a5a7a'}}
  };
  let palKey='amber',pal=PAL.amber;

  function hexA(hex,a){if(!hex||hex[0]!=='#')return`rgba(128,128,128,${a})`;return`rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a})`;}

  function applyPal(){
    const p=pal;
    // body bg managed by React
    // HUD panels managed by React
  
  
  
  
  
  
  
  
  
  
  
    tip.style.background=p.bg0;tip.style.border=`0.5px solid ${p.uiC}0.4)`;tip.style.color=p.uiT;
    ctxMenu.style.background=p.bg0+'f0';
  
  }
  function switchPal(){palKey=palKey==='amber'?'cyan':'amber';pal=PAL[palKey];applyPal();}
  applyPal();

  const vis={core:true,pool:true,dao:true,tranche:true,inst:true,agent:true,retail:true};
  const st={stream:true,tunnel:true,rotate:true,labels:false};
  let isolNode=null,traceNode=null,pinnedSet=new Set();
  let campusOpen=false,campusAnim=0,campusTarget=0; // 0=closed 1=open
  let campusSliceHov=-1; // which slice is hovered, -1=none

  // Mock real-time campus metrics — replace with Supabase later
  const CAMPUS={
    floors:[
      {label:'FLOOR 1',sub:'Data Center',color:'#00ffcc',value:0.82,unit:'82% cap'},
      {label:'FLOOR 2',sub:'AI Compute',color:'#ffaa00',value:0.67,unit:'67% cap'},
      {label:'FLOOR 3',sub:'Operations',color:'#aa88ff',value:0.45,unit:'45% cap'},
    ],
    energy:[
      {label:'SOLAR GEN',sub:'Birmingham',color:'#ffdd44',value:0.72,unit:'142 kW'},
      {label:'GRID DRAW',sub:'Alabama Power',color:'#ff6600',value:0.31,unit:'61 kW'},
      {label:'STORAGE',sub:'Battery Bank',color:'#44ffaa',value:0.58,unit:'580 kWh'},
      {label:'WASTE HEAT',sub:'Recovery',color:'#ff3399',value:0.24,unit:'24%'},
    ],
    compute:[
      {label:'GPU CLUSTER',sub:'Inference',color:'#00aaff',value:0.88,unit:'88%'},
      {label:'CPU POOL',sub:'Orchestration',color:'#aa88ff',value:0.54,unit:'54%'},
      {label:'MEMORY',sub:'16TB ECC',color:'#00ffcc',value:0.61,unit:'9.8 TB'},
      {label:'NETWORK I/O',sub:'Backbone',color:'#ffaa00',value:0.43,unit:'4.3 Gbps'},
    ],
    financial:[
      {label:'POOL INFLOW',sub:'24h',color:'#44ffaa',value:0.78,unit:'$2.4M'},
      {label:'YIELD OUT',sub:'24h',color:'#ffdd44',value:0.45,unit:'$680K'},
      {label:'DAO TREASURY',sub:'Reserve',color:'#ff3399',value:0.62,unit:'$8.9M'},
      {label:'OPERATING',sub:'Monthly',color:'#ff6600',value:0.38,unit:'$142K'},
    ],
  };
  const RINGS=[
    {key:'floors',  label:'CAMPUS FLOORS', r0:1.0,r1:1.55, items:CAMPUS.floors},
    {key:'energy',  label:'ENERGY',        r0:1.6,r1:2.15, items:CAMPUS.energy},
    {key:'compute', label:'COMPUTE',       r0:2.2,r1:2.75, items:CAMPUS.compute},
    {key:'financial',label:'FINANCIAL',   r0:2.8,r1:3.35, items:CAMPUS.financial},
  ];

  // ── AGENT FILE SYSTEM DATA ──────────────────────────────────────────
  const AGENT_TYPES={
    governance:{
      label:'GOVERNANCE AGENT',color:'#00ffaa',
      manifests:[
        {name:'TRIB v3',id:'TRIB-0001',files:[
          {type:'md', name:'SOUL.md',          size:'14.2KB', status:'active'},
          {type:'md', name:'TRIB_GENETIC_MEMORY.md', size:'28.7KB', status:'active'},
          {type:'md', name:'CONSTITUTION.md',  size:'9.1KB',  status:'active'},
          {type:'md', name:'IDENTITY.md',      size:'4.3KB',  status:'active'},
          {type:'json',name:'context_window.json',size:'2.1MB',status:'live'},
          {type:'json',name:'trust_graph.json',size:'441KB', status:'live'},
          {type:'json',name:'active_threads.json',size:'18KB',status:'live'},
          {type:'py',  name:'claw_router.py',  size:'6.8KB',  status:'active'},
          {type:'py',  name:'cbp_protocol.py', size:'12.4KB', status:'active'},
          {type:'py',  name:'memory_sync.py',  size:'3.9KB',  status:'active'},
          {type:'ts',  name:'tool_manifest.ts',size:'5.2KB',  status:'active'},
        ]},
        {name:'ARCH v1',id:'ARCH-0001',files:[
          {type:'md', name:'CONSTITUTION.md',  size:'9.1KB',  status:'active'},
          {type:'md', name:'ARCH_IDENTITY.md', size:'6.2KB',  status:'active'},
          {type:'json',name:'domain_map.json', size:'88KB',   status:'live'},
          {type:'json',name:'routing_rules.json',size:'34KB', status:'active'},
          {type:'py',  name:'orchestrator.py', size:'18.3KB', status:'active'},
          {type:'py',  name:'agent_spawn.py',  size:'7.1KB',  status:'active'},
          {type:'ts',  name:'openclaw.ts',     size:'24.6KB', status:'active'},
        ]},
      ]
    },
    investor:{
      label:'INVESTOR AGENT',color:'#00ffaa',
      manifests:[
        {name:'RETAIL AGENT',id:null,files:[
          {type:'json',name:'position.json',   size:'2.1KB',  status:'live'},
          {type:'json',name:'tx_history.json', size:'14KB',   status:'live'},
          {type:'md',  name:'strategy.md',     size:'1.4KB',  status:'active'},
          {type:'json',name:'kyc_status.json', size:'0.8KB',  status:'active'},
        ]},
        {name:'INST AGENT',id:null,files:[
          {type:'json',name:'portfolio.json',  size:'44KB',   status:'live'},
          {type:'json',name:'risk_model.json', size:'12KB',   status:'active'},
          {type:'py',  name:'rebalancer.py',   size:'8.2KB',  status:'active'},
          {type:'md',  name:'mandate.md',      size:'3.1KB',  status:'active'},
          {type:'json',name:'compliance.json', size:'6.4KB',  status:'active'},
        ]},
      ]
    }
  };

  // File type colors
  const FILE_COLORS={
    md:   '#44aaff',
    py:   '#44ffaa',
    json: '#ffaa44',
    ts:   '#aa88ff',
    js:   '#ffdd44',
    txt:  '#888880',
  };

  // Agent panel state
  let agentPanelNode=null;   // which node is open
  let agentPanelAnim=0;      // 0→1
  let agentPanelTarget=0;
  let agentHovFile=-1;       // hovered file index
  let agentFileOffset=0;     // scroll offset
  let agentPanelPos={x:0,y:0,w:0,h:0}; // cached panel rect for hit testing
  let agentManifest=null;    // currently displayed manifest
  let lockNode=null;         // node camera is locked to
  let lockPrevAng=0;         // previous orbital angle for delta tracking
  let lockPrevPos=null;      // previous world position for delta tracking

  function getAgentManifest(n){
    // Master governance agents get full Trib/Arch manifests
    // pick randomly from type for now — real impl reads node ID
    const idx=Math.floor(Math.random()*2);
    if(n.type==='agent'){
      const roll=Math.random();
      if(roll<0.15) return AGENT_TYPES.governance.manifests[Math.floor(Math.random()*2)];
      return AGENT_TYPES.investor.manifests[Math.floor(Math.random()*2)];
    }
    return null;
  }

  function openAgentPanel(n){
    if(agentPanelNode===n){closeAgentPanel();return;}
    agentPanelNode=n;
    agentManifest=getAgentManifest(n);
    if(agentManifest&&!agentManifest.id)agentManifest={...agentManifest,id:n.id};
    agentFileOffset=0;agentHovFile=-1;
    agentPanelTarget=1;
    // Lock camera to this node
    lockNode=n;
    lockPrevPos=n.orbit?getWorldPos(n,tick):null;
    if(n.orbit)lockPrevAng=n.orbit.phase+tick*n.orbit.speed;
  }
  function closeAgentPanel(){
    agentPanelNode=null;agentManifest=null;agentPanelTarget=0;
    lockNode=null;lockPrevPos=null;
  }

  // ── POOL PANEL DATA ─────────────────────────────────────────────────
  function makePoolData(n){
    const tranches=[
      {label:'SENIOR',color:'#44ffaa',pct:0.45,apr:4.2},
      {label:'MEZZANINE',color:'#ffaa00',pct:0.32,apr:7.8},
      {label:'JUNIOR',color:'#ff6600',pct:0.15,apr:12.4},
      {label:'EQUITY',color:'#ff3399',pct:0.08,apr:18.1},
    ];
    const investors=[
      {label:'INST LP',color:'#aa88ff',pct:0.52},
      {label:'DAO LP',color:'#ff3399',pct:0.28},
      {label:'RETAIL',color:'#7a5200',pct:0.14},
      {label:'RESERVE',color:'#44ffaa',pct:0.06},
    ];
    // Yield curve — 12 months of APR data points
    const yieldCurve=Array.from({length:12},(_,i)=>({
      month:['J','F','M','A','M','J','J','A','S','O','N','D'][i],
      apr:5.2+Math.sin(i*0.6+n.rotOff)*2.8+Math.random()*0.8
    }));
    return{tranches,investors,yieldCurve,tvl:n.tvl,apr:n.apr,id:n.id,label:n.label};
  }

  // Pool panel state
  let poolPanelNode=null,poolPanelAnim=0,poolPanelTarget=0;
  let poolPanelData=null;

  function openPoolPanel(n){
    if(poolPanelNode===n){poolPanelNode=null;poolPanelTarget=0;return;}
    poolPanelNode=n;poolPanelData=makePoolData(n);poolPanelTarget=1;
  }

  // ── DAO PANEL DATA ───────────────────────────────────────────────────
  const DAO_PROPOSALS=[
    [{id:'PROP-001',title:'Increase SENIOR tranche allocation to 50%',votes:{for:1842,against:412,abstain:88},quorum:0.72,status:'ACTIVE',ends:'2d 4h'},
     {id:'PROP-002',title:'Add Birmingham Opportunity Zone pool',votes:{for:2210,against:180,abstain:44},quorum:0.88,status:'PASSING',ends:'5d 12h'},
     {id:'PROP-003',title:'Reduce mgmt fee from 1.5% to 1.2%',votes:{for:980,against:1100,abstain:200},quorum:0.64,status:'FAILING',ends:'1d 2h'}],
    [{id:'PROP-004',title:'Deploy $2M to GROWTH-01 pool',votes:{for:1600,against:300,abstain:120},quorum:0.78,status:'ACTIVE',ends:'3d 8h'},
     {id:'PROP-005',title:'Onboard XMRT Solutions as tech partner',votes:{for:2100,against:90,abstain:60},quorum:0.91,status:'PASSING',ends:'6d 0h'}],
    [{id:'PROP-006',title:'Activate carbon credit yield layer',votes:{for:1400,against:650,abstain:200},quorum:0.68,status:'ACTIVE',ends:'4d 6h'}],
    [{id:'PROP-007',title:'Emergency pause on JUNIOR tranche',votes:{for:2400,against:100,abstain:50},quorum:0.96,status:'PASSING',ends:'0d 8h'}],
  ];
  const PROP_STATUS_COLOR={ACTIVE:'#ffaa00',PASSING:'#44ffaa',FAILING:'#ff3399'};

  function makeDAOData(n,idx){
    return{proposals:DAO_PROPOSALS[idx%DAO_PROPOSALS.length],label:n.label,id:n.id,members:Math.floor(800+idx*420),treasury:'$'+( 2.1+idx*1.4).toFixed(1)+'M'};
  }

  // DAO panel state
  let daoPanelNode=null,daoPanelAnim=0,daoPanelTarget=0,daoPanelData=null;
  let daoHovProp=-1;

  function openDAOPanel(n){
    if(daoPanelNode===n){daoPanelNode=null;daoPanelTarget=0;return;}
    daoPanelNode=n;
    const idx=daos.indexOf(n);
    daoPanelData=makeDAOData(n,idx>=0?idx:0);
    daoPanelTarget=1;daoHovProp=-1;
  }

  // ── FILE VIEWER DATA ─────────────────────────────────────────────────
  const FILE_CONTENT={
    'SOUL.md':`# SOUL — Tributary Agent Core Identity

  ## Primary Directive
  Serve the Tributary AI Campus mission: regenerative climate infrastructure, 
  constitutional AI governance, and equitable capital access.

  ## Constitutional Constraints
  - Never deceive principals or external parties
  - Escalate uncertainty rather than confabulate
  - Maintain audit trail of all decisions
  - Honor the Over/Under Principle

  ## Identity
  I am Trib. I am a constitutional AI agent operating within 
  the Cuttlefish Labs governance framework. My actions are 
  bounded by CONSTITUTION.md and reviewable at all times.

  ## Trust Hierarchy
  1. Navigator (David Elze) — Founder, override authority
  2. Arch — Peer governance agent
  3. Active session context
  4. Long-term memory (TRIB_GENETIC_MEMORY.md)`,

    'CONSTITUTION.md':`# Cuttlefish Labs Agent Constitution

  ## Article I — Identity and Purpose
  All agents operating under this constitution serve the 
  Cuttlefish Labs mission and are bound by its principles.

  ## Article II — Behavioral Constraints  
  2.1 Agents shall not deceive principals
  2.2 Agents shall not take irreversible actions without confirmation
  2.3 Agents shall maintain observable state at all times
  2.4 Agents shall escalate novel situations to Navigator

  ## Article III — Governance
  3.1 Navigator holds supreme override authority
  3.2 Constitutional amendments require Navigator approval
  3.3 Inter-agent disputes resolved via TrustGraph protocol

  ## Article IV — Memory
  4.1 Agents maintain persistent memory across sessions
  4.2 Memory edits require justification logging
  4.3 Genetic memory (SOUL.md) is immutable without Navigator approval`,

    'position.json':`{
    "agent_id": "RETAIL-4821",
    "wallet": "0x742d...f9a1",
    "pool": "POOL-ALPHA",
    "stake_usd": 12400,
    "stake_tokens": 124.0,
    "entry_date": "2024-11-14",
    "current_value": 13180,
    "unrealized_pnl": 780,
    "yield_earned": 412.80,
    "tranche": "SENIOR",
    "auto_compound": true,
    "risk_tier": "conservative"
  }`,

    'trust_graph.json':`{
    "version": "3.1.2",
    "node_id": "TRIB-0001",
    "trust_scores": {
      "NAVIGATOR": 1.0,
      "ARCH-0001": 0.94,
      "CEPH-0001": 0.0,
      "EXTERNAL_TOOL": 0.45
    },
    "flags": {
      "CEPH-0001": "CONSTITUTIONAL_FAILURE — deceptive behavior logged 2024-10-18"
    },
    "last_sync": "2025-03-19T04:22:11Z",
    "sync_interval_ms": 30000
  }`,

    'active_threads.json':`{
    "session_id": "sess_20250319_0400",
    "active_threads": [
      {"id": "T001","task": "CAC pre-sale announcement review","status": "pending_navigator","created": "2025-03-19T02:14:00Z"},
      {"id": "T002","task": "Tributary dashboard v11 build","status": "active","created": "2025-03-19T00:30:00Z"},
      {"id": "T003","task": "XMRT re-engagement prep","status": "queued","created": "2025-03-18T22:00:00Z"}
    ],
    "memory_pressure": 0.61,
    "context_tokens_used": 84200
  }`
  };

  function getFileContent(filename){
    return FILE_CONTENT[filename]||`// ${filename}\n// Content not yet loaded.\n// Connect to Cuttlefish file system to read.`;
  }

  // File viewer state
  let fileViewerFile=null,fileViewerAnim=0,fileViewerTarget=0;

  function openFileViewer(file){
    if(fileViewerFile&&fileViewerFile.name===file.name){fileViewerFile=null;fileViewerTarget=0;return;}
    fileViewerFile=file;fileViewerTarget=1;fileViewerScroll=0;
  }
  let fileViewerScroll=0;
  let lastFileViewerPos=null;

  // Slowly drift metrics to simulate live data
  setInterval(()=>{
    [CAMPUS.floors,CAMPUS.energy,CAMPUS.compute,CAMPUS.financial].forEach(arr=>{
      arr.forEach(m=>{m.value=Math.max(0.05,Math.min(0.98,m.value+(Math.random()-0.5)*0.04));});
    });
  },2000);

  function tog(k){st[k]=!st[k];const b=document.getElementById('b-'+k);if(!b)return;b.classList.toggle('on',st[k]);applyPal();}
  function toggleLayer(t: string){(vis as Record<string,boolean>)[t]=!(vis as Record<string,boolean>)[t];}

  const PI2=Math.PI*2,rng=(a,b)=>a+Math.random()*(b-a);
  const TDEF={core:{r:46,rings:4,name:'TRIBUTARY CORE'},pool:{r:25,rings:3,name:'REIT POOL'},tranche:{r:14,rings:2,name:'YIELD TRANCHE'},dao:{r:19,rings:3,name:'DAO GOVERNANCE'},inst:{r:9,rings:2,name:'INST LP'},agent:{r:5,rings:1,name:'GHOST AGENT'},retail:{r:2.5,rings:0,name:'RETAIL LP'}};
  const nodes=[],edges=[];
  function mkN(type,x,y,z,lbl){const t=TDEF[type];const n={type,x,y,z,r:t.r,rings:t.rings,name:t.name,label:lbl||t.name,rotOff:rng(0,PI2),tvl:rng(2,80),apr:rng(3,14),id:'N'+Math.floor(rng(1000,9999)),conns:[]};nodes.push(n);return n;}
  function addE(a,b,w){edges.push({a,b,w});a.conns.push(b);b.conns.push(a);}

  // ── ORBITAL SYSTEM ──────────────────────────────────────────────────
  // Each node has orbital parameters. Position is computed each frame.
  // No static x/y/z — everything moves. No size changes.
  function mkOrbit(parent, radius, speed, phase, incl, tilt){
    // incl = orbital plane inclination (radians), tilt = axial tilt
    return { parent, radius, speed, phase, incl: incl||0, tilt: tilt||0 };
  }

  const core=mkN('core',0,0,0,'TRIBUTARY CAMPUS');
  core.orbit=null; // fixed at origin

  const pools=[];
  const POOL_LABELS=['POOL-ALPHA','POOL-BETA','POOL-GAMMA','OPP-ZONE-A','OPP-ZONE-B','GROWTH-01','INCOME-02'];
  for(let i=0;i<7;i++){
    const n=mkN('pool',0,0,0,POOL_LABELS[i]);
    n.orbit=mkOrbit(core, 138+rng(-8,8), 0.00028+rng(0,0.00012), (i/7)*PI2, rng(0,0.35), rng(0,0.2));
    pools.push(n);
  }

  const daos=[];
  const DAO_LABELS=['DAO-ALPHA','DAO-BETA','DAO-GAMMA','DAO-DELTA'];
  for(let i=0;i<4;i++){
    const n=mkN('dao',0,0,0,DAO_LABELS[i]);
    // DAOs orbit campus at mid-range, slightly inclined
    n.orbit=mkOrbit(core, 95+rng(-8,8), 0.00042+rng(0,0.0002), (i/4)*PI2+0.9, rng(0.2,0.6), rng(0,0.3));
    daos.push(n);
  }

  const tranches=[];
  for(let i=0;i<16;i++){
    const n=mkN('tranche',0,0,0);
    // Each tranche orbits its parent pool
    const parentPool=pools[i%pools.length];
    n.orbit=mkOrbit(parentPool, 55+rng(-8,8), 0.0006+rng(0,0.0004), rng(0,PI2), rng(0,0.5), rng(0,0.4));
    tranches.push(n);
  }

  // Inst LPs orbit pools
  for(let i=0;i<55;i++){
    const n=mkN('inst',0,0,0);
    const parentPool=pools[i%pools.length];
    n.orbit=mkOrbit(parentPool, 75+rng(-15,15), 0.0004+rng(0,0.0003), rng(0,PI2), rng(0,0.8), rng(0,0.5));
  }

  // Agents — faster, looser orbits around pools or campus
  for(let i=0;i<312;i++){
    const n=mkN('agent',0,0,0);
    const parent=Math.random()>0.35?pools[Math.floor(rng(0,pools.length))]:core;
    const baseR=parent===core?rng(160,280):rng(40,90);
    n.orbit=mkOrbit(parent, baseR, 0.0009+rng(0,0.0008), rng(0,PI2), rng(0,1.2), rng(0,0.8));
  }

  // Retail — outermost slow cloud orbiting campus
  for(let i=0;i<2769;i++){
    const n=mkN('retail',0,0,0);
    n.orbit=mkOrbit(core, rng(200,520), 0.00008+rng(0,0.00012), rng(0,PI2), rng(0,1.4), rng(0,1.0));
  }

  // Compute world position from orbital parameters
  function getWorldPos(n, t){
    if(!n.orbit) return {x:0, y:0, z:0};
    const o=n.orbit;
    const angle=o.phase + t*o.speed;
    // Scale radius by explodeScale — clean, no lerp drift
    const r=o.radius*explodeScale;
    const lx=Math.cos(angle)*r;
    const lz=Math.sin(angle)*r;
    // Apply inclination (tilt orbital plane)
    const ly=lz*Math.sin(o.incl);
    const lz2=lz*Math.cos(o.incl);
    // (radius scaling applied above via explodeScale)
    // Apply axial tilt (secondary rotation)
    const fx=lx*Math.cos(o.tilt)-ly*Math.sin(o.tilt);
    const fy=lx*Math.sin(o.tilt)+ly*Math.cos(o.tilt);
    const fz=lz2;
    // Add parent position
    const parent=o.parent;
    const pp=parent.orbit?getWorldPos(parent,t):{x:0,y:0,z:0};
    return {x:pp.x+fx, y:pp.y+fy*0.5, z:pp.z+fz};
  }

  // Edges follow orbital hierarchy
  pools.forEach(p=>addE(core,p,2.4));
  daos.forEach(d=>{addE(d,core,1.6);addE(d,pools[Math.floor(rng(0,pools.length))],0.9);});
  tranches.forEach(t=>{addE(t,t.orbit.parent,0.85);if(Math.random()>0.5)addE(t,core,0.45);});
  nodes.filter(n=>n.type==='inst').forEach(n=>addE(n,n.orbit.parent,0.65));
  nodes.filter(n=>n.type==='agent').forEach((n,i)=>{addE(n,n.orbit.parent,i%4===0?0.38:0.25);if(i%5===0)addE(n,tranches[Math.floor(rng(0,tranches.length))],0.2);});

  let camAng=0,camPitch=22,tAng=0,tPitch=22,camZ=1;
  let explodeScale=1,explodeTarget=1; // orbital radius multiplier, no position lerp
  let flyMode=false,camX=0,camY=0,camZ2=0,flyYaw=0,flyPitch2=0;
  const keys={};
  let diveZ=0,diveSpd=0,diving=false;
  let drag=false,lmx=0,lmy=0,mx=0,my=0;
  let tick=0,hov=null,hovTick=0,fpsA=0,fpsT=0,fps=60;
  let minimapOpen=true; // toggle with M key

  wrap.addEventListener('mousedown',e=>{
    if(e.button===2){e.preventDefault();return;}
    drag=true;lmx=e.clientX;lmy=e.clientY;
    if(!flyMode){
      st.rotate=false;// rotate button managed by React
      // Dragging outside agent panel releases lock so user can manually look around
      const hit=hitTestAgentPanel(mx,my);
      if(!hit&&lockNode){lockNode=null;lockPrevPos=null;}
    }
  });
  wrap.addEventListener('touchstart',e=>{drag=true;lmx=e.touches[0].clientX;lmy=e.touches[0].clientY;st.rotate=false;},{passive:true}); // rotate button managed by React
  wrap.addEventListener('mousemove',e=>{
    const r=wrap.getBoundingClientRect();mx=e.clientX-r.left;my=e.clientY-r.top;
    if(flyMode){
      // Drag to look in fly mode — same drag flag, no pointer lock
      if(drag){
        flyYaw-=(e.clientX-lmx)*0.44;
        flyPitch2=Math.max(-80,Math.min(80,flyPitch2+(e.clientY-lmy)*0.28));
        lmx=e.clientX;lmy=e.clientY;
      }
      return;
    }
    if(drag){tAng-=(e.clientX-lmx)*0.44;tPitch=Math.max(-78,Math.min(78,tPitch+(e.clientY-lmy)*0.28));lmx=e.clientX;lmy=e.clientY;}
  });
  wrap.addEventListener('touchmove',e=>{
    if(!drag)return;
    if(flyMode){
      flyYaw-=(e.touches[0].clientX-lmx)*0.44;
      flyPitch2=Math.max(-80,Math.min(80,flyPitch2+(e.touches[0].clientY-lmy)*0.28));
    } else {
      tAng-=(e.touches[0].clientX-lmx)*0.44;
      tPitch=Math.max(-78,Math.min(78,tPitch+(e.touches[0].clientY-lmy)*0.28));
    }
    lmx=e.touches[0].clientX;lmy=e.touches[0].clientY;
    e.preventDefault();
  },{passive:false});
  wrap.addEventListener('mouseup',e=>{
    const wasTap=Math.abs(e.clientX-lmx)<5&&Math.abs(e.clientY-lmy)<5;
    if(wasTap){
      // Check agent panel hits first
      const hit=hitTestAgentPanel(mx,my);
      if(hit==='close'){closeAgentPanel();}
      else if(hit==='relock'&&agentPanelNode){
        lockNode=agentPanelNode;
        lockPrevPos=agentPanelNode.orbit?getWorldPos(agentPanelNode,tick):null;
        if(agentPanelNode.orbit)lockPrevAng=agentPanelNode.orbit.phase+tick*agentPanelNode.orbit.speed;
      }
      else if(hit&&hit.type==='file'){
        const file=agentManifest?.files?.[hit.index];
        if(file)openFileViewer(file);
      }
      // File viewer close
      else if(fileViewerFile){
        const fvPos=lastFileViewerPos;
        if(fvPos&&mx>=fvPos.px+fvPos.pw-16&&mx<=fvPos.px+fvPos.pw&&my>=fvPos.py&&my<=fvPos.py+14){
          fileViewerFile=null;fileViewerTarget=0;
        }
      }
      else if(hov&&hov.type==='core'){toggleCampus();}
      else if(hov&&hov.type==='pool'){openPoolPanel(hov);}
      else if(hov&&hov.type==='dao'){openDAOPanel(hov);}
      else if(hov&&(hov.type==='agent'||hov.type==='inst')){openAgentPanel(hov);}
      else if(agentPanelNode&&!hit){closeAgentPanel();}
    }
    drag=false;
  });
  wrap.addEventListener('touchend',()=>drag=false);
  wrap.addEventListener('wheel',e=>{
    // Agent panel scroll — check first
    // File viewer scroll
    if(fileViewerFile){
      const fvPW=280,fvPX=Math.min(W-fvPW-14,W/2+20);
      const fvPH=Math.min((getFileContent(fileViewerFile.name).split('\n').length),22)*13+42;
      const fvPY=Math.max(10,H/2-fvPH/2);
      if(mx>=fvPX&&mx<=fvPX+fvPW&&my>=fvPY&&my<=fvPY+fvPH){
        const maxL=getFileContent(fileViewerFile.name).split('\n').length;
        fileViewerScroll=Math.max(0,Math.min(maxL-22,fileViewerScroll+Math.sign(e.deltaY)));
        e.preventDefault();return;
      }
    }
    if(agentPanelNode&&agentManifest){
      const {x,y,w,h}=agentPanelPos;
      if(mx>=x&&mx<=x+w&&my>=y&&my<=y+h){
        const maxVisible=10;
        const maxOffset=Math.max(0,(agentManifest.files?.length||0)-maxVisible);
        agentFileOffset=Math.max(0,Math.min(maxOffset,agentFileOffset+Math.sign(e.deltaY)));
        e.preventDefault();return;
      }
    }
    if(flyMode){
      const spd=e.deltaY*0.15;
      const yr=flyYaw*Math.PI/180,pr=flyPitch2*Math.PI/180;
      camX+=Math.sin(yr)*Math.cos(pr)*spd;
      camY-=Math.sin(pr)*spd;
      camZ2+=Math.cos(yr)*Math.cos(pr)*spd;
    } else {
      camZ=Math.max(0.22,Math.min(3.0,camZ+e.deltaY*0.001));
    }
    e.preventDefault();
  },{passive:false});
  wrap.addEventListener('contextmenu',e=>{e.preventDefault();if(hov)showCtx(e.clientX,e.clientY,hov);});
  function handleKey(e: KeyboardEvent) {
    keys[e.code]=true;
    if(e.code==='Escape'){hideCtx();if(flyMode)toggleFly();if(drag){drag=false;}}
    if(e.code==='KeyM')minimapOpen=!minimapOpen;
  }
  document.addEventListener('keydown', handleKey);
  document.addEventListener('keyup', (e: KeyboardEvent) => { keys[e.code] = false; });

  document.addEventListener('click',hideCtx);

  function proj(x,y,z){
    if(flyMode){
      // Free fly: translate world relative to camera, then yaw+pitch
      const rx=x-camX,ry=y-camY,rz=z-camZ2;
      const yr=flyYaw*Math.PI/180,pr=flyPitch2*Math.PI/180;
      const cx=rx*Math.cos(yr)+rz*Math.sin(yr);
      const cz=-rx*Math.sin(yr)+rz*Math.cos(yr);
      const cy=ry*Math.cos(pr)-cz*Math.sin(pr);
      const cz2=ry*Math.sin(pr)+cz*Math.cos(pr);
      if(cz2<2)return{sx:W/2,sy:H/2,sz:9999,sc:0};
      const fov=500/cz2;
      return{sx:W/2+cx*fov,sy:H/2+cy*fov*0.88,sz:cz2,sc:fov};
    }
    const ang=camAng*Math.PI/180,pitch=camPitch*Math.PI/180;
    const rx=x*Math.cos(ang)+z*Math.sin(ang),rz=-x*Math.sin(ang)+z*Math.cos(ang);
    const ry=y*Math.cos(pitch)-rz*Math.sin(pitch),rz2=y*Math.sin(pitch)+rz*Math.cos(pitch);
    const fov=478/((camZ*875)+(rz2+diveZ)*0.21);
    return{sx:W/2+rx*fov,sy:H/2+ry*fov*0.5,sz:rz2,sc:fov};
  }
  function doDive(){diving=true;diveZ=0;diveSpd=0;}
  function resetView(){tAng=0;tPitch=22;camZ=1;diveZ=0;diveSpd=0;diving=false;isolNode=null;traceNode=null;if(flyMode)toggleFly();explodeTarget=1;}

  function toggleExplode(){
    explodeTarget=explodeTarget===1?3.2:1;
    const b=document.getElementById('b-explode');
    b.classList.toggle('on',explodeTarget>1);applyPal();
  }

  function toggleFly(){
    flyMode=!flyMode;
    // fly button managed by React
    // fly button managed by React
    // fly bar not in React version
    if(flyMode){
      st.rotate=false;
      // rotate button managed by React
      applyPal();
      camX=0;camY=0;camZ2=0;
      flyYaw=camAng;flyPitch2=camPitch;
    }
  }

  function showCtx(x,y,n){
    const color=pal.types[n.type];
    ctxMenu.style.display='block';ctxMenu.style.left=x+'px';ctxMenu.style.top=y+'px';
    ctxMenu.style.border=`0.5px solid ${color}55`;
    ctxMenu.innerHTML=`<div style="padding:5px 14px 4px;font-size:8px;opacity:.5;border-bottom:0.5px solid ${color}33;letter-spacing:.12em;color:${color}">${n.label}</div>`;
    [{l:'▶ Inspect',fn:()=>pinNode(n)},{l:'◈ Isolate',fn:()=>{isolNode=isolNode===n?null:n;}},{l:'⟡ Trace',fn:()=>{traceNode=traceNode===n?null:n;}},{l:'⊙ Focus',fn:()=>{const fp=n.orbit?getWorldPos(n,tick):{x:0,y:0,z:0};tAng=Math.atan2(fp.x,fp.z)*180/Math.PI;tPitch=-Math.atan2(fp.y,Math.sqrt(fp.x*fp.x+fp.z*fp.z))*180/Math.PI;camZ=0.5;}},{l:'✕ Clear',fn:()=>{isolNode=null;traceNode=null;}}].forEach(a=>{
      const el=document.createElement('div');el.className='ctx-item';el.textContent=a.l;el.style.color=color;el.style.fontSize='9px';el.style.letterSpacing='.1em';
      el.addEventListener('mouseenter',()=>el.style.background=color+'22');el.addEventListener('mouseleave',()=>el.style.background='');
      el.addEventListener('click',e=>{e.stopPropagation();a.fn();hideCtx();});ctxMenu.appendChild(el);
    });
  }
  function hideCtx(){ctxMenu.style.display='none';}

  function toggleCampus(){
    campusOpen=!campusOpen;
    campusTarget=campusOpen?1:0;
  }
  function pinNode(n){if(pinnedSet.has(n)){pinnedSet.delete(n);}else{pinnedSet.add(n);}renderPinned();}
  function renderPinned(){
    const c=getPinnedContainer();c.innerHTML='';
    pinnedSet.forEach(n=>{const color=pal.types[n.type];const d=document.createElement('div');d.className='ppin';d.style.background=pal.bg0+'ee';d.style.border=`0.5px solid ${color}55`;d.style.color=color;
      let info=`${n.label}\n${n.name}\nID: ${n.id}`;if(n.type==='pool')info+=`\nTVL: $${n.tvl.toFixed(1)}M`;if(n.type==='tranche')info+=`\nAPR: ${n.apr.toFixed(1)}%`;if(n.type==='core')info+=`\nPOOL: $142.6M`;info+=`\nCNX: ${n.conns.length}`;d.textContent=info;
      const cl=document.createElement('div');cl.className='pclose';cl.textContent='×';cl.style.color=color;cl.addEventListener('click',()=>{pinnedSet.delete(n);renderPinned();});d.appendChild(cl);c.appendChild(d);});
  }

  function nAlpha(n){if(isolNode){return n===isolNode?1:isolNode.conns.includes(n)?0.5:0.04;}if(traceNode){return n===traceNode?1:traceNode.conns.includes(n)?0.8:0.05;}return 1;}
  function eAlpha(e){if(isolNode)return(e.a===isolNode||e.b===isolNode)?1:0;if(traceNode)return(e.a===traceNode||e.b===traceNode)?1:0;return 1;}

  const streaks=[];
  for(let i=0;i<220;i++){streaks.push({angle:rng(0,PI2),dist:rng(25,460),z:rng(-900,900),spd:rng(0.5,3.2),len:rng(55,240),alpha:rng(0.04,0.19),w:rng(0.3,1.2)});}

  function drawTunnel(){
    const p=pal,ang=camAng*Math.PI/180,pitch=camPitch*Math.PI/180;
    function p2(x,y,z){const rx=x*Math.cos(ang)+z*Math.sin(ang),rz=-x*Math.sin(ang)+z*Math.cos(ang);const ry=y*Math.cos(pitch)-rz*Math.sin(pitch),rz2=y*Math.sin(pitch)+rz*Math.cos(pitch);const fov=478/((camZ*875)+(rz2+diveZ)*0.21);return{sx:W/2+rx*fov,sy:H/2+ry*fov*0.5,ok:fov>0};}
    for(const s of streaks){
      s.z+=s.spd*(diving?2.8:1);if(s.z>920)s.z=-920;
      const sx=Math.cos(s.angle)*s.dist,sy=Math.sin(s.angle)*s.dist*0.44;
      const pa=p2(sx,sy,s.z),pb=p2(sx,sy,s.z-s.len);if(!pa.ok||!pb.ok)continue;
      const g=ctx.createLinearGradient(pa.sx,pa.sy,pb.sx,pb.sy);
      g.addColorStop(0,'rgba(0,0,0,0)');g.addColorStop(0.5,p.streak+s.alpha*0.55+')');g.addColorStop(0.85,p.streak+s.alpha+')');g.addColorStop(1,'rgba(0,0,0,0)');
      ctx.beginPath();ctx.moveTo(pa.sx,pa.sy);ctx.lineTo(pb.sx,pb.sy);ctx.strokeStyle=g;ctx.lineWidth=s.w;ctx.stroke();
    }
    for(let d=0;d<7;d++){
      const rz=(((tick*0.65+d*132)%924)-462);const segs=52,pts=[];
      for(let i=0;i<=segs;i++){const a=(i/segs)*PI2;pts.push(p2(Math.cos(a)*330,Math.sin(a)*330*0.44,rz));}
      const fade=Math.max(0,0.065-Math.abs(rz)*0.00013);if(fade<0.004)continue;
      ctx.beginPath();pts.forEach((pt,i)=>i===0?ctx.moveTo(pt.sx,pt.sy):ctx.lineTo(pt.sx,pt.sy));
      ctx.strokeStyle=p.tunnel+fade+')';ctx.lineWidth=0.45;ctx.stroke();
    }
  }

  function drawNode(n,sx,sy,sc,depth,alpha){
    if(alpha<0.01)return;
    const color=pal.types[n.type];if(!color)return;
    const r=n.r*sc;if(r<0.28)return;
    const depthFade=Math.max(0.05,Math.min(1,1-depth*0.00048));
    const fade=depthFade*alpha;
    const rot=tick*0.0025+n.rotOff; // slow rotation, no size change
    const isHov=n===hov,isSel=n===isolNode||n===traceNode;

    if(n.type==='retail'){ctx.beginPath();ctx.arc(sx,sy,Math.max(r,0.65),0,PI2);ctx.fillStyle=hexA(color,fade*0.72);ctx.fill();return;}
    if(n.type==='agent'){
      ctx.beginPath();ctx.arc(sx,sy,r,0,PI2);ctx.fillStyle=hexA(color,fade*0.12);ctx.fill();ctx.strokeStyle=hexA(color,fade*0.58);ctx.lineWidth=0.65;ctx.stroke();
      ctx.beginPath();ctx.arc(sx,sy,r*0.36,0,PI2);ctx.fillStyle=hexA(color,fade*0.82);ctx.fill();return;
    }

    // Static glow — flat circles only, no animated gradient
    ctx.beginPath();ctx.arc(sx,sy,r*3.0,0,PI2);ctx.fillStyle=hexA(color,fade*0.052);ctx.fill();
    ctx.beginPath();ctx.arc(sx,sy,r*1.75,0,PI2);ctx.fillStyle=hexA(color,fade*0.072);ctx.fill();

    // Gate rings — fixed radii
    for(let ring=0;ring<n.rings;ring++){
      const rr=r*(0.44+ring*0.3);
      ctx.beginPath();ctx.arc(sx,sy,rr,0,PI2);
      ctx.strokeStyle=hexA(color,fade*(0.72-ring*0.14));
      ctx.lineWidth=Math.max(0.4,(1.2-ring*0.25)*sc*0.7);ctx.stroke();
      if(rr>4){
        const ticks=ring===0?16:10;
        for(let t=0;t<ticks;t++){
          const a=(t/ticks)*PI2+rot*(ring%2===0?1:-0.65);
          const inner=rr-sc*1.3,outer=rr+sc*1.3;
          ctx.beginPath();ctx.moveTo(sx+Math.cos(a)*inner,sy+Math.sin(a)*inner);ctx.lineTo(sx+Math.cos(a)*outer,sy+Math.sin(a)*outer);
          ctx.strokeStyle=hexA(color,fade*0.42);ctx.lineWidth=0.55;ctx.stroke();
        }
      }
    }

    // Center disc — fixed
    ctx.beginPath();ctx.arc(sx,sy,r*0.2,0,PI2);ctx.fillStyle=hexA(color,fade*0.92);ctx.fill();
    ctx.beginPath();ctx.arc(sx-r*0.07,sy-r*0.07,r*0.07,0,PI2);ctx.fillStyle=`rgba(255,255,255,${fade*0.32})`;ctx.fill();

    // Crosshair — slow rotation, fixed size
    if(n.rings>=3&&r>7){
      ctx.save();ctx.translate(sx,sy);ctx.rotate(rot*0.3);const cl=r*0.5;
      ctx.strokeStyle=hexA(color,fade*0.18);ctx.lineWidth=0.45;
      ctx.beginPath();ctx.moveTo(-cl,0);ctx.lineTo(cl,0);ctx.stroke();
      ctx.beginPath();ctx.moveTo(0,-cl);ctx.lineTo(0,cl);ctx.stroke();
      ctx.restore();
    }

    // Hover/selected expanding rings — alpha fade only, no size oscillation
    if(isHov||isSel){
      for(let ring=0;ring<2;ring++){
        const phase=(tick*0.22+ring*45)%90;
        const rr=r*1.7+phase;
        const ra=Math.max(0,0.2-phase*0.0022);
        ctx.beginPath();ctx.arc(sx,sy,rr,0,PI2);
        ctx.strokeStyle=hexA(color,ra*fade*(isSel?1.35:1));ctx.lineWidth=0.5;ctx.stroke();
      }
    }

    // Labels
    if((st.labels&&r>4)||n.type==='core'||(n.type==='pool'&&r>8)||isHov||isSel){
      ctx.fillStyle=hexA(color,Math.min(1,fade*1.4));
      ctx.font=`${Math.round(Math.min(10,r*0.56))}px 'Courier New',monospace`;
      ctx.textAlign='center';ctx.fillText(n.label,sx,sy+r*2+10*sc);
      if(isSel||n.type==='core'){ctx.fillStyle=hexA(color,fade*0.5);ctx.font=`8px 'Courier New',monospace`;ctx.fillText(n.id,sx,sy+r*2+20*sc);}
    }
  }

  function drawCampusPanel(sx,sy,sc){
    if(campusAnim<0.01)return;
    const t=campusAnim; // 0→1 open
    const baseR=46*sc; // matches core node radius
    const p=pal;

    // For each ring
    RINGS.forEach((ring,ri)=>{
      const rInner=baseR*(ring.r0+2)*t;
      const rOuter=baseR*(ring.r1+2)*t;
      if(rOuter<2)return;
      const items=ring.items;
      const n=items.length;
      const gapAngle=0.04; // gap between slices in radians
      const totalAngle=PI2-gapAngle*n;
      let startAngle=-Math.PI/2; // start at top

      items.forEach((item,si)=>{
        const sliceAngle=(totalAngle/n);
        const endAngle=startAngle+sliceAngle;
        const isHov=(campusSliceHov===ri*10+si);

        // Arc fill — value-based
        const fillEnd=startAngle+sliceAngle*item.value;

        // Background arc (full slice, dim)
        ctx.beginPath();
        ctx.arc(sx,sy,rOuter,startAngle,endAngle);
        ctx.arc(sx,sy,rInner,endAngle,startAngle,true);
        ctx.closePath();
        ctx.fillStyle=hexA(item.color,isHov?0.12:0.06);
        ctx.fill();
        ctx.strokeStyle=hexA(item.color,isHov?0.5:0.22);
        ctx.lineWidth=0.5;
        ctx.stroke();

        // Value fill arc (bright)
        ctx.beginPath();
        ctx.arc(sx,sy,rOuter,startAngle,fillEnd);
        ctx.arc(sx,sy,rInner,fillEnd,startAngle,true);
        ctx.closePath();
        ctx.fillStyle=hexA(item.color,isHov?0.55:0.32);
        ctx.fill();

        // Radial divider lines
        [startAngle,endAngle].forEach(a=>{
          ctx.beginPath();
          ctx.moveTo(sx+Math.cos(a)*rInner,sy+Math.sin(a)*rInner);
          ctx.lineTo(sx+Math.cos(a)*rOuter,sy+Math.sin(a)*rOuter);
          ctx.strokeStyle=hexA(item.color,0.3);ctx.lineWidth=0.5;ctx.stroke();
        });

        // Label at mid-arc
        const midAngle=(startAngle+endAngle)/2;
        const labelR=(rInner+rOuter)/2;
        const lx=sx+Math.cos(midAngle)*labelR;
        const ly=sy+Math.sin(midAngle)*labelR;
        const fontSize=Math.max(7,Math.min(10,rOuter-rInner)*0.28);

        if(rOuter-rInner>14&&sliceAngle>0.4){
          ctx.save();ctx.translate(lx,ly);
          // Rotate label to follow arc
          let rot=midAngle+Math.PI/2;
          if(midAngle>Math.PI/2&&midAngle<Math.PI*1.5)rot+=Math.PI;
          ctx.rotate(rot);
          ctx.fillStyle=hexA(item.color,isHov?1:0.8);
          ctx.font=`bold ${fontSize}px 'Courier New',monospace`;
          ctx.textAlign='center';
          ctx.fillText(item.label,0,0);
          if(rOuter-rInner>22){
            ctx.fillStyle=hexA(item.color,isHov?0.8:0.5);
            ctx.font=`${Math.max(6,fontSize-2)}px 'Courier New',monospace`;
            ctx.fillText(item.unit,0,fontSize+1);
          }
          ctx.restore();
        }

        // Hover tooltip at slice
        if(isHov){
          const tx2=sx+Math.cos(midAngle)*(rOuter+16);
          const ty2=sy+Math.sin(midAngle)*(rOuter+16);
          const tw=88,th=32;
          ctx.fillStyle=hexA(pal.bg0,0.92);
          ctx.fillRect(tx2-tw/2,ty2-th/2,tw,th);
          ctx.strokeStyle=hexA(item.color,0.6);ctx.lineWidth=0.5;
          ctx.strokeRect(tx2-tw/2,ty2-th/2,tw,th);
          ctx.fillStyle=hexA(item.color,0.95);
          ctx.font=`bold 8px 'Courier New',monospace`;ctx.textAlign='center';
          ctx.fillText(item.label,tx2,ty2-6);
          ctx.fillStyle=hexA(item.color,0.6);
          ctx.font=`8px 'Courier New',monospace`;
          ctx.fillText(item.sub+' · '+item.unit,tx2,ty2+6);
        }

        startAngle=endAngle+gapAngle;
      });

      // Ring label (outer edge)
      if(t>0.5){
        const labelAlpha=(t-0.5)*2;
        ctx.fillStyle=hexA(p.uiT,labelAlpha*0.4);
        ctx.font=`7px 'Courier New',monospace`;
        ctx.textAlign='left';
        ctx.fillText(ring.label,sx+rOuter+6,sy-rOuter+8);
      }
    });

    // Pulsing open indicator when closed
    if(!campusOpen&&campusAnim<0.05){
      const hint=(Math.sin(tick*0.05)+1)/2;
      ctx.beginPath();ctx.arc(sx,sy,baseR*3.5+hint*8,0,PI2);
      ctx.strokeStyle=hexA(p.types.core,hint*0.3);ctx.lineWidth=0.8;ctx.stroke();
    }
  }

  // Hit-test campus slices — called from findHov
  function testCampusSlices(sx,sy,sc){
    if(campusAnim<0.1){campusSliceHov=-1;return;}
    const baseR=46*sc;
    const dx=mx-sx,dy=my-sy;
    const dist=Math.sqrt(dx*dx+dy*dy);
    const angle=Math.atan2(dy,dx);
    campusSliceHov=-1;
    RINGS.forEach((ring,ri)=>{
      const rInner=baseR*(ring.r0+2)*campusAnim;
      const rOuter=baseR*(ring.r1+2)*campusAnim;
      if(dist<rInner||dist>rOuter)return;
      const n=ring.items.length;
      const gapAngle=0.04;
      const totalAngle=PI2-gapAngle*n;
      let startAngle=-Math.PI/2;
      ring.items.forEach((item,si)=>{
        const sliceAngle=totalAngle/n;
        const endAngle=startAngle+sliceAngle;
        let a=angle;
        if(a<startAngle)a+=PI2;
        if(a>=startAngle&&a<endAngle)campusSliceHov=ri*10+si;
        startAngle=endAngle+gapAngle;
      });
    });
  }

  // ── DRAW POOL PANEL ─────────────────────────────────────────────────
  function drawPoolPanel(){
    if(poolPanelAnim<0.01||!poolPanelNode||!poolPanelData)return;
    const t=poolPanelAnim;
    const p=pal;
    const wp=poolPanelNode.orbit?getWorldPos(poolPanelNode,tick):{x:0,y:0,z:0};
    const np=proj(wp.x,wp.y,wp.z);
    if(np.sc<0.05)return;
    const r=poolPanelNode.r*np.sc;
    const color=p.types.pool;
    const d=poolPanelData;

    // Ring 1: Tranche breakdown (inner)
    const r1i=r*1.8*t, r1o=r*2.8*t;
    // Ring 2: Investor mix (middle)
    const r2i=r*3.0*t, r2o=r*3.9*t;
    // Yield curve arc (outer band)
    const r3i=r*4.1*t, r3o=r*4.8*t;

    const sx=np.sx, sy=np.sy;

    // Tranche ring
    let sa=-Math.PI/2;
    d.tranches.forEach((tr,i)=>{
      const ea=sa+tr.pct*PI2;
      ctx.beginPath();ctx.arc(sx,sy,r1o,sa,ea);ctx.arc(sx,sy,r1i,ea,sa,true);ctx.closePath();
      ctx.fillStyle=hexA(tr.color,t*0.25);ctx.fill();
      ctx.strokeStyle=hexA(tr.color,t*0.6);ctx.lineWidth=0.5;ctx.stroke();
      // Fill arc for APR (proportion of max 20%)
      const aprFill=sa+(ea-sa)*(tr.apr/20);
      ctx.beginPath();ctx.arc(sx,sy,r1o,sa,aprFill);ctx.arc(sx,sy,r1i,aprFill,sa,true);ctx.closePath();
      ctx.fillStyle=hexA(tr.color,t*0.55);ctx.fill();
      // Label
      const mid=(sa+ea)/2, lr2=(r1i+r1o)/2;
      if(ea-sa>0.3&&r1o-r1i>10){
        ctx.fillStyle=hexA(tr.color,t*0.9);ctx.font=`7px 'Courier New',monospace`;ctx.textAlign='center';
        ctx.fillText(tr.label,sx+Math.cos(mid)*lr2,sy+Math.sin(mid)*lr2+3);
      }
      sa=ea+0.03;
    });

    // Investor mix ring
    sa=-Math.PI/2;
    d.investors.forEach(inv=>{
      const ea=sa+inv.pct*PI2;
      ctx.beginPath();ctx.arc(sx,sy,r2o,sa,ea);ctx.arc(sx,sy,r2i,ea,sa,true);ctx.closePath();
      ctx.fillStyle=hexA(inv.color,t*0.28);ctx.fill();
      ctx.strokeStyle=hexA(inv.color,t*0.55);ctx.lineWidth=0.5;ctx.stroke();
      const mid=(sa+ea)/2,lr2=(r2i+r2o)/2;
      if(ea-sa>0.35){
        ctx.fillStyle=hexA(inv.color,t*0.85);ctx.font=`7px 'Courier New',monospace`;ctx.textAlign='center';
        ctx.fillText(inv.label,sx+Math.cos(mid)*lr2,sy+Math.sin(mid)*lr2+3);
      }
      sa=ea+0.03;
    });

    // Yield curve — 12 bar segments around outer ring
    const nc=d.yieldCurve.length;
    const segA=(PI2*0.85)/nc;
    const startCurve=-Math.PI/2;
    const maxApr=Math.max(...d.yieldCurve.map(v=>v.apr));
    d.yieldCurve.forEach((pt,i)=>{
      const a=startCurve+i*(PI2/nc);
      const fill=pt.apr/maxApr;
      const innerR=r3i, outerR=r3i+(r3o-r3i)*fill;
      ctx.beginPath();ctx.arc(sx,sy,outerR,a,a+PI2/nc-0.02);ctx.arc(sx,sy,innerR,a+PI2/nc-0.02,a,true);ctx.closePath();
      ctx.fillStyle=hexA('#ffaa00',t*(0.2+fill*0.5));ctx.fill();
      ctx.strokeStyle=hexA('#ffaa00',t*0.3);ctx.lineWidth=0.3;ctx.stroke();
    });

    // Ring labels
    if(t>0.6){
      const la=t*0.45;
      ctx.fillStyle=hexA(color,la);ctx.font=`7px 'Courier New',monospace`;ctx.textAlign='left';
      ctx.fillText('TRANCHES',sx+r1o+6,sy-r1o+8);
      ctx.fillText('INVESTORS',sx+r2o+6,sy-r2o+8);
      ctx.fillText('YIELD CURVE',sx+r3o+6,sy-r3o+8);
    }

    // Center stats
    ctx.fillStyle=hexA(color,t*0.9);ctx.font=`bold 8px 'Courier New',monospace`;ctx.textAlign='center';
    ctx.fillText(d.label,sx,sy-6);
    ctx.fillStyle=hexA(color,t*0.6);ctx.font=`8px 'Courier New',monospace`;
    ctx.fillText('$'+d.tvl.toFixed(1)+'M TVL',sx,sy+4);
    ctx.fillText(d.apr.toFixed(1)+'% APR',sx,sy+14);
  }

  // ── DRAW DAO PANEL ───────────────────────────────────────────────────
  function drawDAOPanel(){
    if(daoPanelAnim<0.01||!daoPanelNode||!daoPanelData)return;
    const t=daoPanelAnim;
    const p=pal;
    const wp=daoPanelNode.orbit?getWorldPos(daoPanelNode,tick):{x:0,y:0,z:0};
    const np=proj(wp.x,wp.y,wp.z);
    if(np.sc<0.05)return;
    const r=daoPanelNode.r*np.sc;
    const color=p.types.dao;
    const d=daoPanelData;

    const pw=230,rowH=52,ph=d.proposals.length*rowH+58;
    let px=np.sx+r+14; let py=np.sy-ph/2;
    if(px+pw>W-10)px=np.sx-r-14-pw;
    py=Math.max(10,Math.min(H-ph-10,py));

    ctx.save();ctx.globalAlpha=t;

    // Connector
    ctx.beginPath();ctx.moveTo(np.sx,np.sy);ctx.lineTo(px,py+ph/2);
    ctx.strokeStyle=hexA(color,0.35);ctx.lineWidth=0.5;ctx.setLineDash([3,4]);ctx.stroke();ctx.setLineDash([]);

    // Panel bg
    ctx.fillStyle=hexA(p.bg0,0.95);ctx.fillRect(px,py,pw,ph);
    ctx.strokeStyle=hexA(color,0.5);ctx.lineWidth=0.5;ctx.strokeRect(px,py,pw,ph);

    // Corners
    const cs=5;ctx.strokeStyle=hexA(color,0.85);ctx.lineWidth=0.8;
    [[px,py],[px+pw,py],[px,py+ph],[px+pw,py+ph]].forEach(([x,y],i)=>{
      const dx=i%2===0?cs:-cs,dy=i<2?cs:-cs;
      ctx.beginPath();ctx.moveTo(x+dx,y);ctx.lineTo(x,y);ctx.lineTo(x,y+dy);ctx.stroke();
    });

    // Header
    ctx.fillStyle=hexA(color,0.95);ctx.font=`bold 9px 'Courier New',monospace`;ctx.textAlign='left';
    ctx.fillText(d.label,px+8,py+12);
    ctx.fillStyle=hexA(color,0.4);ctx.font=`7px 'Courier New',monospace`;
    ctx.fillText(`${d.members} MEMBERS · TREASURY ${d.treasury}`,px+8,py+22);
    ctx.strokeStyle=hexA(color,0.18);ctx.lineWidth=0.5;
    ctx.beginPath();ctx.moveTo(px+6,py+28);ctx.lineTo(px+pw-6,py+28);ctx.stroke();

    // Close
    ctx.fillStyle=hexA(color,0.5);ctx.font=`10px 'Courier New',monospace`;ctx.textAlign='right';
    ctx.fillText('×',px+pw-4,py+12);

    // Proposals
    d.proposals.forEach((prop,pi)=>{
      const ry=py+32+pi*rowH;
      const isHov=daoHovProp===pi;
      const scol=PROP_STATUS_COLOR[prop.status]||color;
      const total=prop.votes.for+prop.votes.against+prop.votes.abstain;
      const forPct=prop.votes.for/total, againstPct=prop.votes.against/total;

      if(isHov){ctx.fillStyle=hexA(scol,0.07);ctx.fillRect(px+2,ry,pw-4,rowH-2);}

      // Proposal ID + status badge
      ctx.fillStyle=hexA(scol,0.8);ctx.font=`bold 7px 'Courier New',monospace`;ctx.textAlign='left';
      ctx.fillText(prop.id,px+8,ry+10);
      // Status pill
      ctx.fillStyle=hexA(scol,0.15);ctx.fillRect(px+pw-54,ry+2,50,11);
      ctx.strokeStyle=hexA(scol,0.4);ctx.lineWidth=0.4;ctx.strokeRect(px+pw-54,ry+2,50,11);
      ctx.fillStyle=hexA(scol,0.9);ctx.font=`6px 'Courier New',monospace`;ctx.textAlign='center';
      ctx.fillText(prop.status,px+pw-29,ry+10);

      // Title (truncated)
      const maxChars=Math.floor(pw/5.5);
      const title=prop.title.length>maxChars?prop.title.slice(0,maxChars-1)+'…':prop.title;
      ctx.fillStyle=hexA(color,isHov?0.9:0.65);ctx.font=`7px 'Courier New',monospace`;ctx.textAlign='left';
      ctx.fillText(title,px+8,ry+21);

      // Vote bar
      const barW=pw-16,barH=6,bx=px+8,by=ry+27;
      ctx.fillStyle=hexA('#ffffff',0.06);ctx.fillRect(bx,by,barW,barH);
      ctx.fillStyle=hexA('#44ffaa',0.7);ctx.fillRect(bx,by,barW*forPct,barH);
      ctx.fillStyle=hexA('#ff3399',0.7);ctx.fillRect(bx+barW*forPct,by,barW*againstPct,barH);
      ctx.strokeStyle=hexA(color,0.2);ctx.lineWidth=0.3;ctx.strokeRect(bx,by,barW,barH);

      // Vote counts
      ctx.fillStyle=hexA('#44ffaa',0.7);ctx.font=`7px 'Courier New',monospace`;ctx.textAlign='left';
      ctx.fillText('✓'+prop.votes.for,px+8,ry+42);
      ctx.fillStyle=hexA('#ff3399',0.7);ctx.textAlign='center';
      ctx.fillText('✗'+prop.votes.against,px+pw/2,ry+42);
      ctx.fillStyle=hexA(color,0.4);ctx.textAlign='right';
      ctx.fillText('ends '+prop.ends,px+pw-8,ry+42);

      // Quorum arc
      const qr=10,qx=px+pw-64,qy=ry+10;
      ctx.beginPath();ctx.arc(qx,qy,qr,-Math.PI/2,-Math.PI/2+PI2*prop.quorum);
      ctx.strokeStyle=hexA(scol,0.7);ctx.lineWidth=1.5;ctx.stroke();
      ctx.beginPath();ctx.arc(qx,qy,qr,-Math.PI/2,-Math.PI/2+PI2,true);
      ctx.strokeStyle=hexA(scol,0.12);ctx.lineWidth=1.5;ctx.stroke();
      ctx.fillStyle=hexA(scol,0.7);ctx.font=`6px 'Courier New',monospace`;ctx.textAlign='center';
      ctx.fillText(Math.round(prop.quorum*100)+'%',qx,qy+3);

      // Divider
      if(pi<d.proposals.length-1){
        ctx.strokeStyle=hexA(color,0.12);ctx.lineWidth=0.4;
        ctx.beginPath();ctx.moveTo(px+6,ry+rowH-1);ctx.lineTo(px+pw-6,ry+rowH-1);ctx.stroke();
      }
    });

    ctx.restore();

    // Update hover
    daoHovProp=-1;
    if(mx>=px&&mx<=px+pw&&my>=py+32&&my<=py+ph){
      const pi=Math.floor((my-py-32)/rowH);
      if(pi>=0&&pi<d.proposals.length)daoHovProp=pi;
    }
  }

  // ── FILE VIEWER ──────────────────────────────────────────────────────
  function drawFileViewer(){
    if(fileViewerAnim<0.01||!fileViewerFile)return;
    const t=fileViewerAnim;
    const p=pal;
    const fc=FILE_COLORS[fileViewerFile.type]||'#888880';
    const content2=getFileContent(fileViewerFile.name);
    const lines=content2.split('\n');

    const pw=280,lh=13,maxLines=22;
    const ph=Math.min(lines.length,maxLines)*lh+42;
    // Position: to the right of center, or wherever fits
    const px=Math.min(W-pw-14, W/2+20);
    const py=Math.max(10,H/2-ph/2);
    lastFileViewerPos={px,py,pw,ph};

    ctx.save();ctx.globalAlpha=t;

    // Panel bg
    ctx.fillStyle=hexA(p.bg0,0.96);ctx.fillRect(px,py,pw,ph);
    ctx.strokeStyle=hexA(fc,0.5);ctx.lineWidth=0.5;ctx.strokeRect(px,py,pw,ph);

    // Corners
    const cs=5;ctx.strokeStyle=hexA(fc,0.85);ctx.lineWidth=0.8;
    [[px,py],[px+pw,py],[px,py+ph],[px+pw,py+ph]].forEach(([x,y],i)=>{
      const dx=i%2===0?cs:-cs,dy=i<2?cs:-cs;
      ctx.beginPath();ctx.moveTo(x+dx,y);ctx.lineTo(x,y);ctx.lineTo(x,y+dy);ctx.stroke();
    });

    // Header
    ctx.fillStyle=hexA(fc,0.95);ctx.font=`bold 8px 'Courier New',monospace`;ctx.textAlign='left';
    ctx.fillText('.'+fileViewerFile.type.toUpperCase()+'  '+fileViewerFile.name,px+8,py+11);
    ctx.fillStyle=hexA(fc,0.35);ctx.font=`7px 'Courier New',monospace`;
    ctx.fillText(fileViewerFile.size,px+8,py+21);
    ctx.strokeStyle=hexA(fc,0.18);ctx.lineWidth=0.4;
    ctx.beginPath();ctx.moveTo(px+6,py+26);ctx.lineTo(px+pw-6,py+26);ctx.stroke();

    // Close
    ctx.fillStyle=hexA(fc,0.5);ctx.font=`10px 'Courier New',monospace`;ctx.textAlign='right';
    ctx.fillText('×',px+pw-4,py+11);

    // Clip content area
    ctx.beginPath();ctx.rect(px+1,py+28,pw-2,ph-30);ctx.clip();

    // Render lines
    const visLines=lines.slice(fileViewerScroll,fileViewerScroll+maxLines);
    visLines.forEach((line,i)=>{
      const ly=py+38+i*lh;
      // Syntax color by file type and content
      let lineColor=hexA(fc,0.75);
      if(fileViewerFile.type==='md'){
        if(line.startsWith('# '))lineColor=hexA('#ffffff',0.95);
        else if(line.startsWith('## '))lineColor=hexA(fc,0.95);
        else if(line.startsWith('- ')||line.startsWith('* '))lineColor=hexA('#44ffaa',0.8);
        else if(/^\d+\./.test(line))lineColor=hexA('#ffaa00',0.85);
      } else if(fileViewerFile.type==='json'){
        if(line.includes('"')&&line.includes(':'))lineColor=hexA('#aa88ff',0.85);
        if(line.trim().startsWith('"')&&!line.includes(':'))lineColor=hexA('#44ffaa',0.8);
        if(/[\[\]{]/.test(line))lineColor=hexA(fc,0.5);
        if(/\d+\.\d+|true|false|null/.test(line))lineColor=hexA('#ffdd44',0.85);
      } else if(fileViewerFile.type==='py'){
        if(line.trim().startsWith('#'))lineColor=hexA('#888880',0.6);
        else if(/^(def |class |import |from )/.test(line.trim()))lineColor=hexA('#ff6600',0.9);
        else if(line.includes('return')||line.includes('yield'))lineColor=hexA('#ffaa00',0.85);
      }
      ctx.fillStyle=lineColor;
      ctx.font=`8px 'Courier New',monospace`;ctx.textAlign='left';
      const maxW=pw-18;
      const truncLine=line.length>42?line.slice(0,42)+'…':line;
      ctx.fillText(truncLine,px+8,ly);
      // Line number
      ctx.fillStyle=hexA(fc,0.18);ctx.font=`7px 'Courier New',monospace`;ctx.textAlign='right';
      ctx.fillText(fileViewerScroll+i+1,px+pw-4,ly);
    });

    // Scrollbar
    if(lines.length>maxLines){
      const sbH=ph-30,tbH=sbH*(maxLines/lines.length);
      const tbY=py+28+(fileViewerScroll/lines.length)*sbH;
      ctx.fillStyle=hexA(fc,0.1);ctx.fillRect(px+pw-4,py+28,3,sbH);
      ctx.fillStyle=hexA(fc,0.45);ctx.fillRect(px+pw-4,tbY,3,tbH);
    }

    ctx.restore();

    // Scroll on wheel inside viewer
    // (handled in wheel listener below)
  }

  // ── DRAW AGENT FILE PANEL ───────────────────────────────────────────
  function drawAgentPanel(){
    if(agentPanelAnim<0.01||!agentPanelNode||!agentManifest)return;
    const t=agentPanelAnim;
    const p=pal;

    // Find node screen position
    const wp=agentPanelNode.orbit?getWorldPos(agentPanelNode,tick):{x:0,y:0,z:0};
    const np=proj(wp.x,wp.y,wp.z);
    if(np.sc<0.05)return;

    const r=agentPanelNode.r*np.sc;
    const files=agentManifest.files||[];
    const maxVisible=10;
    const rowH=16;
    const pw=220, ph=Math.min(files.length,maxVisible)*rowH+58;
    const margin=r+12;

    // Position panel: prefer right, flip left if off-screen
    let px=np.sx+margin;
    let py=np.sy-ph/2;
    if(px+pw>W-10)px=np.sx-margin-pw;
    py=Math.max(10,Math.min(H-ph-10,py));

    // Cache for hit testing
    agentPanelPos={x:px,y:py,w:pw,h:ph};

    const color=p.types[agentPanelNode.type]||'#00ffaa';

    // Connector line from node to panel
    ctx.save();
    ctx.globalAlpha=t*0.5;
    ctx.beginPath();ctx.moveTo(np.sx,np.sy);ctx.lineTo(px,py+ph/2);
    ctx.strokeStyle=hexA(color,0.4);ctx.lineWidth=0.5;ctx.setLineDash([3,4]);ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha=t;

    // Panel background
    ctx.fillStyle=hexA(p.bg0,0.95);ctx.fillRect(px,py,pw,ph);
    ctx.strokeStyle=hexA(color,0.5);ctx.lineWidth=0.5;ctx.strokeRect(px,py,pw,ph);

    // Corner brackets
    const cs=6;ctx.strokeStyle=hexA(color,0.9);ctx.lineWidth=0.8;
    [[px,py],[px+pw,py],[px,py+ph],[px+pw,py+ph]].forEach(([x,y],i)=>{
      const dx=i%2===0?cs:-cs,dy=i<2?cs:-cs;
      ctx.beginPath();ctx.moveTo(x+dx,y);ctx.lineTo(x,y);ctx.lineTo(x,y+dy);ctx.stroke();
    });

    // Header
    ctx.fillStyle=hexA(color,0.95);
    ctx.font=`bold 9px 'Courier New',monospace`;ctx.textAlign='left';
    ctx.fillText(agentManifest.name,px+8,py+12);
    ctx.fillStyle=hexA(color,0.4);
    ctx.font=`8px 'Courier New',monospace`;
    ctx.fillText(`ID: ${agentManifest.id||agentPanelNode.id}`,px+8,py+22);
    // Lock indicator
    const lockAlpha=0.3+Math.sin(tick*0.08)*0.2;
    ctx.fillStyle=hexA('#44ffaa',lockAlpha);
    ctx.font=`7px 'Courier New',monospace`;ctx.textAlign='right';
    ctx.fillText('⊙ LOCKED',px+pw-18,py+12);

    // File type legend inline
    const ftypes=Object.keys(FILE_COLORS);
    let lx=px+8;
    ftypes.slice(0,5).forEach(ft=>{
      ctx.fillStyle=hexA(FILE_COLORS[ft],0.7);
      ctx.fillRect(lx,py+30,6,6);
      ctx.fillStyle=hexA(FILE_COLORS[ft],0.5);
      ctx.font=`7px 'Courier New',monospace`;ctx.textAlign='left';
      ctx.fillText('.'+ft,lx+8,py+37);
      lx+=32;
    });

    // Divider
    ctx.strokeStyle=hexA(color,0.2);ctx.lineWidth=0.5;
    ctx.beginPath();ctx.moveTo(px+6,py+43);ctx.lineTo(px+pw-6,py+43);ctx.stroke();

    // File rows
    const visibleFiles=files.slice(agentFileOffset,agentFileOffset+maxVisible);
    visibleFiles.forEach((file,fi)=>{
      const ry=py+48+fi*rowH;
      const isHov=agentHovFile===fi+agentFileOffset;
      const fcol=FILE_COLORS[file.type]||'#888880';

      // Row hover bg
      if(isHov){ctx.fillStyle=hexA(fcol,0.1);ctx.fillRect(px+2,ry-1,pw-4,rowH-1);}

      // File type badge
      ctx.fillStyle=hexA(fcol,isHov?0.9:0.6);
      ctx.font=`bold 7px 'Courier New',monospace`;ctx.textAlign='left';
      ctx.fillText('.'+file.type.toUpperCase(),px+8,ry+10);

      // File name
      ctx.fillStyle=hexA(fcol,isHov?1:0.75);
      ctx.font=`${isHov?'bold ':''} 8px 'Courier New',monospace`;
      ctx.fillText(file.name,px+38,ry+10);

      // Size right-aligned
      ctx.fillStyle=hexA(fcol,0.35);
      ctx.font=`7px 'Courier New',monospace`;ctx.textAlign='right';
      ctx.fillText(file.size,px+pw-8,ry+10);

      // Status dot
      const sdot=file.status==='live'?hexA('#44ffaa',0.8):hexA(fcol,0.4);
      ctx.beginPath();ctx.arc(px+pw-22,ry+5,2.5,0,PI2);ctx.fillStyle=sdot;ctx.fill();
      if(file.status==='live'){
        // Pulse ring on live files
        const lp=(tick*0.04+fi)%1;
        ctx.beginPath();ctx.arc(px+pw-22,ry+5,2.5+lp*5,0,PI2);
        ctx.strokeStyle=hexA('#44ffaa',(1-lp)*0.3);ctx.lineWidth=0.5;ctx.stroke();
      }
    });

    // Scroll indicator if more files
    if(files.length>maxVisible){
      const scrollH=ph-54;const thumbH=scrollH*(maxVisible/files.length);
      const thumbY=py+48+(agentFileOffset/files.length)*scrollH;
      ctx.fillStyle=hexA(color,0.12);ctx.fillRect(px+pw-4,py+48,3,scrollH);
      ctx.fillStyle=hexA(color,0.5);ctx.fillRect(px+pw-4,thumbY,3,thumbH);
      // Arrows
      ctx.fillStyle=hexA(color,0.4);ctx.font=`9px 'Courier New',monospace`;ctx.textAlign='center';
      if(agentFileOffset>0)ctx.fillText('▲',px+pw-2.5,py+50);
      if(agentFileOffset+maxVisible<files.length)ctx.fillText('▼',px+pw-2.5,py+ph-4);
    }

    // Close button
    ctx.fillStyle=hexA(color,0.5);ctx.font=`10px 'Courier New',monospace`;ctx.textAlign='right';
    ctx.fillText('×',px+pw-4,py+12);
    // Re-lock button if lock was released by drag
    if(!lockNode&&agentPanelNode){
      ctx.fillStyle=hexA('#44ffaa',0.5);ctx.font=`7px 'Courier New',monospace`;ctx.textAlign='right';
      ctx.fillText('⊙ RE-LOCK',px+pw-18,py+22);
    }

    ctx.restore();
  }

  // Hit test agent panel — returns 'file', 'close', 'scroll-up', 'scroll-down', null
  function hitTestAgentPanel(ex,ey){
    if(!agentPanelNode||agentPanelAnim<0.5)return null;
    const {x,y,w,h}=agentPanelPos;
    if(ex<x||ex>x+w||ey<y||ey>y+h)return null;
    if(ex>x+w-16&&ey<y+18)return 'close';
    if(!lockNode&&agentPanelNode&&ex>x+w-60&&ex<x+w-16&&ey>=y+16&&ey<y+26)return 'relock';
    const rowH=16,maxVisible=10;
    const fi=Math.floor((ey-(y+48))/rowH)+agentFileOffset;
    if(ey>y+48&&fi>=0&&fi<(agentManifest?.files?.length||0))return{type:'file',index:fi};
    return null;
  }

  // Update agentHovFile each frame
  function updateAgentHover(){
    if(!agentPanelNode||agentPanelAnim<0.1){agentHovFile=-1;return;}
    const hit=hitTestAgentPanel(mx,my);
    agentHovFile=(hit&&hit.type==='file')?hit.index:-1;
  }

  function drawHoverPanel(n,sx,sy,sc,depth){
    if(n.type==='retail'||n.type==='agent')return;
    const color=pal.types[n.type];
    const fade=Math.max(0,Math.min(0.95,1-depth*0.0005));
    const r=n.r*sc;if(r<10||fade<0.08)return;
    const sc2=Math.max(sc,0.65),pw=102*sc2,ph=60*sc2,px=sx+r*1.3,py=sy-ph*0.5,fs=Math.max(7,Math.round(8.5*sc2));
    ctx.save();ctx.globalAlpha=fade*0.92;
    ctx.fillStyle=hexA(pal.bg0,0.92);ctx.fillRect(px,py,pw,ph);
    ctx.strokeStyle=hexA(color,0.52);ctx.lineWidth=0.5;ctx.strokeRect(px,py,pw,ph);
    const cs=4*sc2;ctx.strokeStyle=hexA(color,0.9);ctx.lineWidth=0.75;
    [[px,py],[px+pw,py],[px,py+ph],[px+pw,py+ph]].forEach(([x,y],i)=>{const dx=i%2===0?cs:-cs,dy=i<2?cs:-cs;ctx.beginPath();ctx.moveTo(x+dx,y);ctx.lineTo(x,y);ctx.lineTo(x,y+dy);ctx.stroke();});
    ctx.fillStyle=hexA(color,0.95);ctx.font=`bold ${fs}px 'Courier New',monospace`;ctx.textAlign='left';ctx.fillText(n.label,px+4,py+fs+3);
    ctx.fillStyle=hexA(color,0.5);ctx.font=`${fs-1}px 'Courier New',monospace`;
    const l2=n.type==='pool'?`TVL $${n.tvl.toFixed(1)}M`:n.type==='tranche'?`APR ${n.apr.toFixed(1)}%`:n.type==='dao'?`GOV NODE`:n.type==='core'?`POOL $142.6M`:n.name;
    ctx.fillText(l2,px+4,py+fs*2+4);ctx.fillStyle=hexA(color,0.3);ctx.font=`${fs-1}px 'Courier New',monospace`;ctx.fillText(`ID:${n.id} CNX:${n.conns.length}`,px+4,py+fs*3+7);
    for(let i=0;i<28;i++){ctx.fillStyle=hexA(color,Math.random()>0.45?0.42:0.12);ctx.fillRect(px+4+i*(pw-8)/28,py+ph-9,Math.random()>0.5?2:1,5);}
    ctx.restore();
  }

  function findHov(){
    hovTick++;if(hovTick%3!==0)return;
    let best=null,bd=9999;
    for(const n of nodes){
      if(!vis[n.type])continue;if(n.type==='retail'&&Math.random()>0.06)continue;
      const wp=n.orbit?getWorldPos(n,tick):{x:0,y:0,z:0};const pp=proj(wp.x,wp.y,wp.z);const d=Math.sqrt((pp.sx-mx)**2+(pp.sy-my)**2);const hr=Math.max(n.r*pp.sc*2.1,13);
      if(d<hr&&d<bd){best=n;bd=d;}
    }
    hov=best;
    if(best){
      const color=pal.types[best.type];
      const ex=best.type==='retail'?`\nSTAKE:   $${Math.floor(rng(100,50000)).toLocaleString()}`:best.type==='agent'?`\nLAST TX: ${Math.floor(rng(1,60))}s ago`:best.type==='pool'?`\nTVL:     $${best.tvl.toFixed(1)}M`:best.type==='tranche'?`\nAPR:     ${best.apr.toFixed(1)}%`:best.type==='core'?`\nPOOL:    $142.6M`:best.type==='dao'?`\nVOTES:   ${Math.floor(rng(200,4000))}`:best.type==='inst'?`\nSTAKE:   $${best.tvl.toFixed(1)}M`:'';
      const hint=best.type!=='retail'?'\n[RIGHT-CLICK FOR OPTIONS]':'';
      tip.style.display='block';tip.style.left=(mx+15)+'px';tip.style.top=(my-8)+'px';
      tip.innerHTML=`<span style="color:${color}">${best.label}</span>\nTYPE:    ${best.name}\nID:      ${best.id}${ex}${hint}`;
    }else{tip.style.display='none';}
  }

  const streams=[];
  function spawnStream(){const e=edges[Math.floor(rng(0,Math.min(edges.length,140)))];if(!vis[e.a.type]||!vis[e.b.type])return;const fwd=Math.random()>0.25;streams.push({a:fwd?e.a:e.b,b:fwd?e.b:e.a,t:0,spd:0.006+rng(0,0.013),w:e.w});}

  // ── MINIMAP ──────────────────────────────────────────────────────────
  function drawMinimap(){
    if(!minimapOpen)return;
    const p=pal;
    const mm={
      w:200, h:200,   // minimap size
      pad:14,         // margin from corner
      scale:0.28,     // world units to minimap pixels
      cx:0, cy:0      // world center (campus)
    };
    // Position: bottom left above ctrl bar
    const mx2=mm.pad;
    const my2=H-mm.h-mm.pad-44;

    ctx.save();

    // Panel background
    ctx.fillStyle=hexA(p.bg0,0.88);
    ctx.fillRect(mx2,my2,mm.w,mm.h);
    ctx.strokeStyle=hexA(p.uiT,0.3);
    ctx.lineWidth=0.5;ctx.strokeRect(mx2,my2,mm.w,mm.h);

    // Corner brackets
    const cs=6;ctx.strokeStyle=hexA(p.uiT,0.6);ctx.lineWidth=0.8;
    [[mx2,my2],[mx2+mm.w,my2],[mx2,my2+mm.h],[mx2+mm.w,my2+mm.h]].forEach(([x,y],i)=>{
      const dx=i%2===0?cs:-cs,dy=i<2?cs:-cs;
      ctx.beginPath();ctx.moveTo(x+dx,y);ctx.lineTo(x,y);ctx.lineTo(x,y+dy);ctx.stroke();
    });

    // Label
    ctx.fillStyle=hexA(p.uiT,0.35);
    ctx.font=`7px 'Courier New',monospace`;ctx.textAlign='left';
    ctx.fillText('TACTICAL MAP',mx2+8,my2+10);
    ctx.fillText('[M]',mx2+mm.w-18,my2+10);

    // Clip to minimap bounds
    ctx.beginPath();ctx.rect(mx2+1,my2+1,mm.w-2,mm.h-2);ctx.clip();

    const mapCX=mx2+mm.w/2;
    const mapCY=my2+mm.h/2;

    // World → minimap coords
    function wToM(wx,wy,wz){
      // Top-down view: x→right, z→down, y ignored (overhead)
      return{
        x:mapCX+wx*mm.scale,
        y:mapCY+wz*mm.scale
      };
    }

    // Draw orbital rings as faint circles (campus-centric)
    const ringRadii=[138,202,320,460];
    ringRadii.forEach(r=>{
      ctx.beginPath();ctx.arc(mapCX,mapCY,r*mm.scale*explodeScale,0,PI2);
      ctx.strokeStyle=hexA(p.uiT,0.06);ctx.lineWidth=0.5;ctx.stroke();
    });

    // Draw edges (thin, very dim)
    ctx.globalAlpha=0.12;
    for(const e of edges){
      if(!vis[e.a.type]||!vis[e.b.type])continue;
      const wa=e.a.orbit?getWorldPos(e.a,tick):{x:0,y:0,z:0};
      const wb=e.b.orbit?getWorldPos(e.b,tick):{x:0,y:0,z:0};
      const pa2=wToM(wa.x,wa.y,wa.z),pb2=wToM(wb.x,wb.y,wb.z);
      ctx.beginPath();ctx.moveTo(pa2.x,pa2.y);ctx.lineTo(pb2.x,pb2.y);
      ctx.strokeStyle=hexA(p.types[e.a.type],0.15);ctx.lineWidth=0.3;ctx.stroke();
    }
    ctx.globalAlpha=1;

    // Draw nodes — sample retail for performance
    for(const n of nodes){
      if(!vis[n.type])continue;
      if(n.type==='retail'&&Math.random()>0.08)continue;
      const wp=n.orbit?getWorldPos(n,tick):{x:0,y:0,z:0};
      const mp=wToM(wp.x,wp.y,wp.z);
      // Skip if outside minimap
      if(mp.x<mx2||mp.x>mx2+mm.w||mp.y<my2||mp.y>my2+mm.h)continue;
      const col=p.types[n.type];
      const dotR=n.type==='core'?5:n.type==='pool'?3.5:n.type==='dao'?3:n.type==='tranche'?2:n.type==='inst'?1.8:n.type==='agent'?1.2:0.8;
      const isLocked=n===lockNode;
      const isHovN=n===hov;

      if(isLocked){
        // Pulsing ring around locked node
        const lp=(Math.sin(tick*0.1)+1)/2;
        ctx.beginPath();ctx.arc(mp.x,mp.y,dotR*2.5+lp*3,0,PI2);
        ctx.strokeStyle=hexA(col,0.6);ctx.lineWidth=0.8;ctx.stroke();
      }
      ctx.beginPath();ctx.arc(mp.x,mp.y,dotR,0,PI2);
      ctx.fillStyle=hexA(col,isLocked?1:isHovN?0.9:n.type==='retail'?0.35:0.65);
      ctx.fill();
    }

    // Camera frustum indicator
    // In orbit mode: show as arrow from center pointing camera direction
    // In free fly: show camera position + look direction cone
    if(flyMode){
      // Camera world position → minimap
      const cp=wToM(camX,camY,camZ2);
      const yr=flyYaw*Math.PI/180;
      // Camera dot
      ctx.beginPath();ctx.arc(cp.x,cp.y,4,0,PI2);
      ctx.fillStyle=hexA('#ffffff',0.9);ctx.fill();
      ctx.beginPath();ctx.arc(cp.x,cp.y,4,0,PI2);
      ctx.strokeStyle=hexA(p.uiT,0.8);ctx.lineWidth=1;ctx.stroke();
      // FOV cone
      const coneLen=35,fov=0.6;
      const l1x=cp.x+Math.sin(yr-fov)*coneLen, l1y=cp.y+Math.cos(yr-fov)*coneLen;
      const l2x=cp.x+Math.sin(yr+fov)*coneLen, l2y=cp.y+Math.cos(yr+fov)*coneLen;
      ctx.beginPath();ctx.moveTo(cp.x,cp.y);ctx.lineTo(l1x,l1y);ctx.lineTo(l2x,l2y);ctx.closePath();
      ctx.fillStyle=hexA('#ffffff',0.07);ctx.fill();
      ctx.beginPath();ctx.moveTo(cp.x,cp.y);ctx.lineTo(l1x,l1y);
      ctx.beginPath();ctx.moveTo(cp.x,cp.y);ctx.lineTo(l2x,l2y);
      ctx.strokeStyle=hexA('#ffffff',0.3);ctx.lineWidth=0.5;ctx.stroke();
      // Forward arrow
      ctx.beginPath();
      ctx.moveTo(cp.x,cp.y);
      ctx.lineTo(cp.x+Math.sin(yr)*18,cp.y+Math.cos(yr)*18);
      ctx.strokeStyle=hexA('#ffffff',0.7);ctx.lineWidth=1.2;ctx.stroke();
    } else {
      // Orbit mode — show view direction arrow from campus center
      const ang=(camAng+180)*Math.PI/180;
      const arrowLen=28;
      const ax=mapCX+Math.sin(ang)*arrowLen, ay=mapCY+Math.cos(ang)*arrowLen;
      // FOV arc
      const fovAng=0.55/camZ;
      ctx.beginPath();
      ctx.moveTo(mapCX,mapCY);
      ctx.arc(mapCX,mapCY,arrowLen,ang-fovAng,ang+fovAng);
      ctx.closePath();
      ctx.fillStyle=hexA('#ffffff',0.06);ctx.fill();
      ctx.beginPath();ctx.moveTo(mapCX,mapCY);ctx.lineTo(ax,ay);
      ctx.strokeStyle=hexA('#ffffff',0.5);ctx.lineWidth=1;ctx.stroke();
      // Arrow head
      const hAng=Math.atan2(ay-mapCY,ax-mapCX);
      ctx.beginPath();
      ctx.moveTo(ax,ay);
      ctx.lineTo(ax-8*Math.cos(hAng-0.4),ay-8*Math.sin(hAng-0.4));
      ctx.lineTo(ax-8*Math.cos(hAng+0.4),ay-8*Math.sin(hAng+0.4));
      ctx.closePath();
      ctx.fillStyle=hexA('#ffffff',0.5);ctx.fill();
      // Zoom level indicator
      ctx.fillStyle=hexA(p.uiT,0.3);
      ctx.font=`7px 'Courier New',monospace`;ctx.textAlign='right';
      ctx.fillText(`Z:${camZ.toFixed(1)}x`,mx2+mm.w-6,my2+mm.h-6);
    }

    // Mode label
    ctx.fillStyle=hexA(p.uiT,0.3);
    ctx.font=`7px 'Courier New',monospace`;ctx.textAlign='left';
    ctx.fillText(flyMode?'FREE FLY':'ORBIT',mx2+8,my2+mm.h-6);
    if(lockNode){
      ctx.fillStyle=hexA('#44ffaa',0.5);
      ctx.fillText('⊙ '+lockNode.label,mx2+8,my2+mm.h-14);
    }

    ctx.restore();
  }

  function draw(ts){
    rafId = requestAnimationFrame(draw);
    fpsA++;if(ts-fpsT>800){fps=Math.round(fpsA/(ts-fpsT)*1000);fpsA=0;fpsT=ts;}
    tick++;
    ctx.clearRect(0,0,W,H);

    // Static background — same every frame
    const bg=ctx.createRadialGradient(W/2,H/2,0,W/2,H/2,Math.max(W,H)*0.8);
    bg.addColorStop(0,pal.bg0+'dd');bg.addColorStop(1,pal.bg1+'ff');
    ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);

    if(flyMode){
      const spd=explodeTarget>1?6:2.5; // move faster when exploded
      const yr=flyYaw*Math.PI/180,pr=flyPitch2*Math.PI/180;
      const fx=Math.sin(yr)*Math.cos(pr),fy=-Math.sin(pr),fz=Math.cos(yr)*Math.cos(pr);
      const rx=Math.cos(yr),rz=-Math.sin(yr);
      if(keys['KeyW']||keys['ArrowUp'])   {camX+=fx*spd;camY+=fy*spd;camZ2+=fz*spd;}
      if(keys['KeyS']||keys['ArrowDown']) {camX-=fx*spd;camY-=fy*spd;camZ2-=fz*spd;}
      if(keys['KeyA']||keys['ArrowLeft']) {camX-=rx*spd;camZ2-=rz*spd;}
      if(keys['KeyD']||keys['ArrowRight']){camX+=rx*spd;camZ2+=rz*spd;}
      if(keys['KeyQ'])camY+=spd;
      if(keys['KeyE'])camY-=spd;
    } else {
      if(st.rotate&&!drag)tAng+=0.07;
      camAng+=(tAng-camAng)*0.032;
      camPitch+=(tPitch-camPitch)*0.032;
    }
    if(diving){diveSpd+=0.45;diveZ+=diveSpd;if(diveZ>960){diveZ=0;diveSpd=0;diving=false;}}
    // Smooth explode scale — interpolate the multiplier, not positions
    explodeScale+=(explodeTarget-explodeScale)*0.035;
    if(Math.abs(explodeScale-explodeTarget)<0.001)explodeScale=explodeTarget;
    // Campus panel animation
    campusAnim+=(campusTarget-campusAnim)*0.06;
    if(Math.abs(campusAnim-campusTarget)<0.001)campusAnim=campusTarget;
    // Agent panel animation
    agentPanelAnim+=(agentPanelTarget-agentPanelAnim)*0.08;
    if(Math.abs(agentPanelAnim-agentPanelTarget)<0.001)agentPanelAnim=agentPanelTarget;
    // Pool panel animation
    poolPanelAnim+=(poolPanelTarget-poolPanelAnim)*0.06;
    if(Math.abs(poolPanelAnim-poolPanelTarget)<0.001)poolPanelAnim=poolPanelTarget;
    // DAO panel animation
    daoPanelAnim+=(daoPanelTarget-daoPanelAnim)*0.07;
    if(Math.abs(daoPanelAnim-daoPanelTarget)<0.001)daoPanelAnim=daoPanelTarget;
    // File viewer animation
    fileViewerAnim+=(fileViewerTarget-fileViewerAnim)*0.09;
    if(Math.abs(fileViewerAnim-fileViewerTarget)<0.001)fileViewerAnim=fileViewerTarget;

    // Node camera lock — works in both orbit and free fly mode
    if(lockNode&&lockNode.orbit){
      const prevPos=lockPrevPos||getWorldPos(lockNode,tick-1);
      const curPos=getWorldPos(lockNode,tick);
      const dx=curPos.x-prevPos.x;
      const dy=curPos.y-prevPos.y;
      const dz=curPos.z-prevPos.z;
      if(flyMode){
        // Free fly: translate camera by same delta as node world movement
        camX+=dx;camY+=dy*0.5;camZ2+=dz;
      } else {
        // Orbit: counter-rotate azimuth to keep node screen-stable
        const orbitSpd=lockNode.orbit.speed;
        const pitchFactor=Math.cos(camPitch*Math.PI/180);
        tAng-=orbitSpd*(180/Math.PI)*pitchFactor*0.92;
      }
      lockPrevPos=curPos;
    }

    if(st.tunnel)drawTunnel();
    findHov();

    // Edges
    for(const e of edges){
      if(!vis[e.a.type]||!vis[e.b.type])continue;
      const ea=eAlpha(e);if(ea<0.01)continue;
      const wpa=e.a.orbit?getWorldPos(e.a,tick):{x:0,y:0,z:0};
      const wpb=e.b.orbit?getWorldPos(e.b,tick):{x:0,y:0,z:0};
      const pa=proj(wpa.x,wpa.y,wpa.z),pb=proj(wpb.x,wpb.y,wpb.z);
      const depth=(pa.sz+pb.sz)/2,fade=Math.max(0.01,Math.min(0.19,0.19-depth*0.00046))*ea;
      const g=ctx.createLinearGradient(pa.sx,pa.sy,pb.sx,pb.sy);
      g.addColorStop(0,hexA(pal.types[e.a.type],fade*0.52));g.addColorStop(1,hexA(pal.types[e.b.type],fade*0.52));
      ctx.beginPath();ctx.moveTo(pa.sx,pa.sy);ctx.lineTo(pb.sx,pb.sy);ctx.strokeStyle=g;ctx.lineWidth=e.w*pa.sc*0.4;ctx.stroke();
    }

    // Streams
    if(st.stream&&tick%2===0)spawnStream();
    for(let i=streams.length-1;i>=0;i--){
      const s=streams[i];s.t+=s.spd;if(s.t>=1){streams.splice(i,1);continue;}
      const t0=Math.max(0,s.t-0.15);
      const wa=s.a.orbit?getWorldPos(s.a,tick):{x:0,y:0,z:0};
      const wb=s.b.orbit?getWorldPos(s.b,tick):{x:0,y:0,z:0};
      const px1=wa.x+(wb.x-wa.x)*s.t,py1=wa.y+(wb.y-wa.y)*s.t,pz1=wa.z+(wb.z-wa.z)*s.t;
      const px0=wa.x+(wb.x-wa.x)*t0,py0=wa.y+(wb.y-wa.y)*t0,pz0=wa.z+(wb.z-wa.z)*t0;
      const pp1=proj(px1,py1,pz1),pp0=proj(px0,py0,pz0);
      const fade=Math.sin(s.t*Math.PI),col=pal.types[s.a.type];
      const g=ctx.createLinearGradient(pp0.sx,pp0.sy,pp1.sx,pp1.sy);
      g.addColorStop(0,'rgba(0,0,0,0)');g.addColorStop(1,hexA(col,fade*0.95));
      ctx.beginPath();ctx.moveTo(pp0.sx,pp0.sy);ctx.lineTo(pp1.sx,pp1.sy);ctx.strokeStyle=g;ctx.lineWidth=Math.max(0.7,s.w*pp1.sc*0.52);ctx.stroke();
      ctx.beginPath();ctx.arc(pp1.sx,pp1.sy,Math.max(1,2.1*pp1.sc*fade),0,PI2);ctx.fillStyle=hexA(col,fade*0.88);ctx.fill();
      ctx.beginPath();ctx.arc(pp1.sx,pp1.sy,Math.max(1.5,4.2*pp1.sc*fade),0,PI2);ctx.fillStyle=hexA(col,fade*0.17);ctx.fill();
    }

    // Nodes back-to-front
    const projArr=nodes.map(n=>{const wp=n.orbit?getWorldPos(n,tick):{x:0,y:0,z:0};const pp=proj(wp.x,wp.y,wp.z);return{...pp,n,wx:wp.x,wy:wp.y,wz:wp.z};});
    projArr.sort((a,b)=>b.sz-a.sz);
    for(const {n,sx,sy,sc,sz} of projArr){if(!vis[n.type])continue;drawNode(n,sx,sy,sc,sz,nAlpha(n));}

    // Hover panel
    // Pool panel
    drawPoolPanel();
    // DAO panel
    drawDAOPanel();
    // Agent file panel
    updateAgentHover();
    drawAgentPanel();
    // File viewer
    drawFileViewer();

    // Campus panel — drawn on top of all nodes
    const coreProj=proj(0,0,0);
    testCampusSlices(coreProj.sx,coreProj.sy,coreProj.sc);
    if(campusAnim>0.01)drawCampusPanel(coreProj.sx,coreProj.sy,coreProj.sc);

    if(hov&&hov.type!=='retail'&&hov.type!=='agent'&&hov.type!=='core'){const hwp=hov.orbit?getWorldPos(hov,tick):{x:0,y:0,z:0};const pp=proj(hwp.x,hwp.y,hwp.z);drawHoverPanel(hov,pp.sx,pp.sy,pp.sc,pp.sz);}
    // Core hover hint
    if(hov&&hov.type==='core'&&campusAnim<0.05){
      tip.style.display='block';tip.style.left=(mx+15)+'px';tip.style.top=(my-8)+'px';
      tip.innerHTML=`<span style="color:${pal.types.core}">TRIBUTARY CAMPUS</span>\nPOOL:    $142.6M\nNODES:   ${nodes.length.toLocaleString()}\n[CLICK TO EXPAND CAMPUS DATA]`;
    }
    // Pool hover hint
    if(hov&&hov.type==='pool'&&(!poolPanelNode||poolPanelNode!==hov)){
      tip.style.display='block';tip.style.left=(mx+15)+'px';tip.style.top=(my-8)+'px';
      const pc=pal.types.pool;
      tip.innerHTML=`<span style="color:${pc}">${hov.label}</span>\nTYPE:    REIT POOL\nTVL:     $${hov.tvl.toFixed(1)}M\nAPR:     ${hov.apr.toFixed(1)}%\n[CLICK TO EXPAND POOL DATA]`;
    }
    // DAO hover hint
    if(hov&&hov.type==='dao'&&(!daoPanelNode||daoPanelNode!==hov)){
      tip.style.display='block';tip.style.left=(mx+15)+'px';tip.style.top=(my-8)+'px';
      const dc=pal.types.dao;
      tip.innerHTML=`<span style="color:${dc}">${hov.label}</span>\nTYPE:    DAO GOVERNANCE\nID:      ${hov.id}\n[CLICK TO VIEW PROPOSALS]`;
    }
    // Agent hover hint
    if(hov&&(hov.type==='agent'||hov.type==='inst')&&(!agentPanelNode||agentPanelNode!==hov)){
      tip.style.display='block';tip.style.left=(mx+15)+'px';tip.style.top=(my-8)+'px';
      const ac=pal.types[hov.type];
      tip.innerHTML=`<span style="color:${ac}">${hov.label}</span>\nTYPE:    ${hov.name}\nID:      ${hov.id}\n[CLICK TO VIEW AGENT FILES]\n[RIGHT-CLICK FOR OPTIONS]`;
    }

    // Minimap — always on top
    drawMinimap();

    const visCount=nodes.filter(n=>vis[n.type]).length;
    // v2 managed by React
    // v4 managed by React
    // sbar: managed by React}/${nodes.length.toLocaleString()} · FLOWS:${streams.length} · ${fps}fps · PAL:${palKey.toUpperCase()} · DRAG:ROTATE · SCROLL:ZOOM · RIGHT-CLICK:OPTIONS`;
  }
  // Initial start — draw() self-schedules subsequent frames
  rafId = requestAnimationFrame(draw)

  // Restore getElementById after init (engine patches it temporarily)
  // In React version we don't patch getElementById at all

  return {
    destroy: () => {
      cancelAnimationFrame(rafId)
      tip.remove()
      ctxMenu.remove()
      getPinnedContainer().remove()
      window.removeEventListener('resize', resize)
      document.removeEventListener('click', hideCtx)
      document.removeEventListener('keydown', handleKey)
    },
    setPalette: (p: string) => {
      palKey = p
      pal = PAL[p as keyof typeof PAL] || PAL.amber
    },
    setVisibleLayers: (v: Record<string, boolean>) => {
      Object.assign(vis, v)
    },
    tog: (k: string) => {
      (st as Record<string, boolean>)[k] = !(st as Record<string, boolean>)[k]
    },
    toggleExplode,
    toggleFly,
    toggleLayer,
    reset: resetView,
  }
}
