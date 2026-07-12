/**
 * Quarterdeck — Consolidated dashboard card layout
 * Replaces the old standalone cards with 7 themed full-width cards.
 * 
 * Card 1: Ship-to-Ship (fleet chat) — unchanged
 * Card 2: ⚓ Quarterdeck — Agent Experience + Grog Quota + Quartermaster's Watch + Ships + Articles + Agent Fleet
 * Card 3: Knowledge Graph — ecosystem map with live trust scores (xmrt-galaxy engine)
 * Card 4: 💰 Plunder & Mining — Plunder Ledger + Leaderboard + Heartbeat
 * Card 5: 📯 Campaigns & Leads — PFP Campaign + PFP Leads + 31 Harbor
 * Card 6: 📡 Ship's Intelligence — XMRT University + GitHub Activity + Incoming Mail
 * Card 7: 🏴‍☠️ DAO & Ecosystem — DAO Health + Membership + Ecosystem + Tools & Actions + AI Templates
 */

export function buildQuarterdeckHTML({ uptimeStr, toolCount, handlerCount, requestCounts, tools, localFunctions, campaignSent, poolSize, sentToday, freshAvailable, campaignLastRun, harborSent, harborPool, harborSentToday, harborFresh, harborLastRun, tunnelUrl, hostname }) {
  return `
<!-- ⚓ Quarterdeck — Consolidated Command Center -->
<div class="card" style="grid-column:1/-1;border-color:rgba(255,107,53,0.2);">
  <h3 style="color:var(--accent-orange);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    ⚓ Quarterdeck
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Agent Experience · Grog Quota · Watch · Ships · Articles · Fleet</span>
  </h3>
  <div style="display:grid;grid-template-columns:1.5fr 2fr 1fr;gap:12px;">
    <!-- Left: Quartermaster's Watch -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🔭 Quartermaster's Watch</div>
      <div id="supervisor-status">
        <div class="stat"><span class="label">Supervisor</span><span class="value" id="sv-supervisor" style="color:#6b6b80;">checking...</span></div>
        <div class="stat"><span class="label">Services Up</span><span class="value" id="sv-services-up" style="color:#6b6b80;">-</span></div>
        <div class="stat"><span class="label">Services Down</span><span class="value" id="sv-services-down" style="color:#6b6b80;">-</span></div>
        <div class="stat"><span class="label">Flapping</span><span class="value" id="sv-flapping" style="color:#6b6b80;">-</span></div>
        <div class="stat"><span class="label">Task Issues</span><span class="value" id="sv-task-issues" style="color:#6b6b80;">-</span></div>
        <div class="stat"><span class="label">Last Check</span><span class="value" id="sv-last-check" style="color:#6b6b80;">-</span></div>
      </div>
      <div style="margin-top:4px;font-size:0.65rem;color:var(--text-dim);">
        <span style="color:#60a5fa;">⚡ relay</span> v6.0.0 · <span id="sv-relay-uptime">${uptimeStr}</span> · <span id="sv-tools">${toolCount}</span> tools · <span id="sv-handlers">${handlerCount}</span> handlers · <span id="sv-requests">${requestCounts.total}</span> req
      </div>
      <div id="supervisor-detail" style="display:none;margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;">
        <div id="sv-service-list" style="font-size:0.7rem;"></div>
        <div id="sv-task-list" style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.7rem;"></div>
        <div id="sv-log" style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.65rem;color:#6b6b80;max-height:100px;overflow-y:auto;"></div>
      </div>
      <div style="margin-top:4px;font-size:0.6rem;color:#6b6b80;">
        <a href="/api/supervisor/status" style="color:#60a5fa;">API</a> ·
        <span id="sv-refresh" style="color:#4ade80;">● polling</span>
        <span style="float:right;">
          <a href="javascript:void(0)" onclick="toggleSupervisorDetail()" id="sv-toggle-link" style="color:#fbbf24;">▼ Expand</a>
        </span>
      </div>
    </div>

    <!-- Center: Agent Experience + Grog Quota -->
    <div style="display:flex;flex-direction:column;gap:8px;">
      <!-- Agent Experience -->
      <div style="background:#0d0d15;border-radius:6px;padding:8px;">
        <div style="font-size:0.65rem;color:#a78bfa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🏴 Agent Experience</div>
        <div id="fleet-agents-list">
          <div class="stat"><span class="label">Loading fleet...</span></div>
        </div>
        <div style="margin-top:4px;font-size:0.6rem;color:#6b6b80;">
          <span id="fleet-count"></span> agents · <a href="/api/fleet-chat/agents" style="color:#60a5fa;">API</a>
        </div>
      </div>
      <!-- Grog Quota (Token Usage) -->
      <div style="background:#0d0d15;border-radius:6px;padding:8px;">
        <div style="font-size:0.65rem;color:#a78bfa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🍺 Grog Quota <span style="color:#6b6b80;font-weight:400;font-size:0.6rem;">— token usage · 7 days</span></div>
        <div id="token-usage-content">
          <div class="stat"><span class="label">Loading token data...</span></div>
        </div>
        <div style="margin-top:4px;font-size:0.6rem;color:#6b6b80;">
          <a href="/api/token-usage/summary/daily" style="color:#60a5fa;">Daily</a> ·
          <a href="/api/token-usage/summary/agents?days=7" style="color:#60a5fa;">By Agent</a>
        </div>
      </div>
    </div>

    <!-- Right: Ships + Articles -->
    <div style="display:flex;flex-direction:column;gap:8px;">
      <!-- Ships -->
      <div style="background:#0d0d15;border-radius:6px;padding:8px;">
        <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">⛵ Ships</div>
        <div class="stat"><span class="label">Vessel</span><span class="value" style="color:#4ade80;">HMS Speedy</span></div>
        <div class="stat"><span class="label">Captain</span><span class="value" style="color:#fbbf24;">Vex</span></div>
        <div class="stat"><span class="label">Crew</span><span class="value" style="color:#a78bfa;">Eliza · Hermes · Alice · Kimi</span></div>
        <div class="stat"><span class="label">Tunnel</span><span class="value"><a href="${tunnelUrl}" style="color:#60a5fa;text-decoration:none;">relay.mobilemonero.com</a></span></div>
        <div class="stat"><span class="label">Uptime</span><span class="value" style="color:#6b6b80;">${uptimeStr}</span></div>
      </div>
      <!-- Articles (Bulletin Board) -->
      <div style="background:#0d0d15;border-radius:6px;padding:8px;">
        <div style="font-size:0.65rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">📜 Ship's Articles</div>
        <div id="board-topics-list" style="max-height:120px;overflow-y:auto;"></div>
        <div style="margin-top:4px;font-size:0.6rem;color:#6b6b80;">
          <span id="board-status" style="color:#4ade80;">● loaded</span>
          <span style="float:right;"><a href="javascript:void(0)" onclick="document.getElementById('board-full').scrollIntoView({behavior:'smooth'})" style="color:#fbbf24;">Full Board →</a></span>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Knowledge Graph — xmrt-galaxy engine -->
<div class="card" style="grid-column:1/-1;">
  <h3 style="color:var(--accent-purple);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    🪐 xmrt-galaxy
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— ecosystem map with live trust scores</span>
  </h3>
  <div style="position:relative;">
    <canvas id="obsidian-graph-canvas" style="width:100%;height:calc(100vh - 300px);min-height:340px;border-radius:6px;background:#08080e;cursor:grab;touch-action:none;"></canvas>
    <div id="graph-tooltip" style="display:none;position:absolute;background:#1a1a2a;border:1px solid #3a3a5a;border-radius:6px;padding:6px 10px;font-size:11px;color:#e0e0f0;pointer-events:none;white-space:nowrap;z-index:100;"></div>
  </div>
  <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center;">
    <button class="gc" id="b-orbit" style="background:rgba(107,107,128,0.04);border:0.5px solid rgba(107,107,128,0.12);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.4);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('orbit')">Orbit</button>
    <button class="gc" id="b-explode" style="background:rgba(107,107,128,0.04);border:0.5px solid rgba(107,107,128,0.12);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.4);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('explode')">Explode</button>
    <button class="gc on" id="b-labels" style="background:rgba(167,139,250,0.08);border:0.5px solid rgba(167,139,250,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(167,139,250,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('labels')">Idents</button>
    <button class="gc on" id="b-stream" style="background:rgba(167,139,250,0.08);border:0.5px solid rgba(167,139,250,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(167,139,250,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('stream')">Signal</button>
    <button class="gc on" id="b-tunnel" style="background:rgba(167,139,250,0.08);border:0.5px solid rgba(167,139,250,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(167,139,250,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('tunnel')">Tunnel</button>
    <button class="gc" id="b-fly" style="background:rgba(107,107,128,0.04);border:0.5px solid rgba(107,107,128,0.12);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.4);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('fly')">Free Fly</button>
    <span style="color:#6b6b80;font-size:9px;margin:0 4px;">|</span>
    <button style="background:rgba(107,107,128,0.08);border:0.5px solid rgba(107,107,128,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.resetGraphView()">Reset</button>
    <span style="color:#6b6b80;font-size:9px;margin:0 4px;">|</span>
    <span style="color:#4ade80;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">SPA</span>
    <span style="color:#60a5fa;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Back</span>
    <span style="color:#6b6b80;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Agent</span>
    <span style="color:#4ade80;font-size:6px;">●</span><span style="color:#60a5fa;font-size:6px;">●</span><span style="color:#fbbf24;font-size:6px;">●</span><span style="color:#f87171;font-size:6px;">●</span><span style="color:#6b6b80;font-size:6px;">●</span><span style="color:#6b6b80;font-size:7px;">Trust</span>
    <span style="color:#fbbf24;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Infra</span>
    <span style="color:#ff6b35;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Sys</span>
    <span style="color:#f87171;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Email</span>
    <span style="color:#34d399;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">DB</span>
    <span style="color:#818cf8;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Mine</span>
    <span style="color:#f472b6;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Cert</span>
    <span style="color:#2dd4bf;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Cron</span>
    <span style="color:#67e8f9;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Edge</span>
    <span style="color:#93c5fd;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">EP</span>
    <span style="color:#c084fc;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">GH</span>
    <span style="color:#fcd34d;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Tun</span>
    <span style="color:#fdba74;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Camp</span>
    <span style="color:#6b6b80;font-size:9px;">●</span><span style="color:#6b6b80;font-size:8px;">Other</span>
    <span id="graph-node-count" style="color:var(--text-dim);font-size:9px;margin-left:auto;">-</span>
  </div>
</div>

<!-- 💰 Plunder & Mining -->
<div class="card" style="grid-column:1/-1;">
  <h3 style="color:#fbbf24;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    💰 Plunder & Mining
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Pool Stats · Leaderboard · Heartbeat</span>
  </h3>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
    <!-- Plunder Ledger -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">📒 Plunder Ledger</div>
      <div class="stat"><span class="label">Pool Hashrate</span><span class="value" id="pool-hash">checking...</span></div>
      <div class="stat"><span class="label">Valid Shares</span><span class="value" id="pool-shares">-</span></div>
      <div class="stat"><span class="label">XMR Paid / Due</span><span class="value" id="pool-xmr">-</span></div>
      <div class="stat"><span class="label">Pool Global Hashrate</span><span class="value" id="pool-global-hash" style="color:#818cf8;">-</span></div>
      <div class="stat"><span class="label">Pool Miners</span><span class="value" id="pool-total-miners" style="color:#818cf8;">-</span></div>
      <div class="stat"><span class="label">Treasury (85%) / Ops (15%)</span><span class="value" id="pool-treasury" style="color:#fbbf24;">-</span></div>
      <div class="stat"><span class="label">Status</span><span class="value" id="pool-health" style="color:#818cf8;">-</span></div>
    </div>
    <!-- Leaderboard -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🏆 Leaderboard</div>
      <div style="margin-bottom:4px;font-size:10px;color:#6b6b80;">Live hashrate · shares · XMRT rewards</div>
      <div id="miner-leaderboard"><div class="stat"><span class="label">Loading...</span></div></div>
    </div>
    <!-- Heartbeat -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">💓 Heartbeat</div>
      <div style="background:#0d0d15;padding:0.4rem 0.6rem;border-radius:4px;font-family:monospace;font-size:0.7rem;color:#60a5fa;word-break:break-all;" id="heartbeat-url">loading...</div>
      <div style="color:#6b6b80;font-size:0.65rem;margin-top:0.3rem;">POST: {"agent_id":"...","status":"ONLINE","tunnel_url":"...","hashrate":0}</div>
      <div style="margin-top:6px;padding-top:6px;border-top:1px solid #1e1e2e;">
        <pre style="background:#0d0d15;padding:0.4rem;border-radius:4px;font-size:0.65rem;overflow-x:auto;color:#a0a0b0;white-space:pre-wrap;word-break:break-all;margin:0;cursor:pointer;" id="mining-script" onclick="copyMiningScript()">curl -o signup.py -L https://raw.githubusercontent.com/xmrtdao/mmlauncher/main/scripts/mobile-signup.py && sha256sum signup.py && python3 signup.py</pre>
      </div>
    </div>
  </div>
</div>

<!-- 📯 Campaigns & Leads -->
<div class="card" style="grid-column:1/-1;">
  <h3 style="color:#60a5fa;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📯 Campaigns & Leads
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— PFP Campaign · PFP Leads · 31 Harbor</span>
  </h3>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
    <!-- PFP Campaign -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#60a5fa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">📸 PFP Campaign</div>
      <div class="stat"><span class="label">Contact Pool</span><span class="value" id="pfp-pool">${poolSize}</span></div>
      <div class="stat"><span class="label">Sent Today</span><span class="value" id="pfp-sent-today">${sentToday}</span></div>
      <div class="stat"><span class="label">Sent Total</span><span class="value" id="pfp-sent-total">${campaignSent.length}</span></div>
      <div class="stat"><span class="label">Fresh Avail</span><span class="value" id="pfp-fresh">${freshAvailable}</span></div>
      <div class="stat"><span class="label">Last Run</span><span class="value" id="pfp-last-run">${campaignLastRun}</span></div>
      <div class="stat"><span class="label">Next Drop</span><span class="value" id="next-drop">-</span></div>
    </div>
    <!-- PFP Leads -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#60a5fa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🎯 PFP Leads</div>
      <div class="stat"><span class="label">Total</span><span class="value" id="pfp-leads-total">-</span></div>
      <div class="stat"><span class="label">By Status</span><span class="value" id="pfp-leads-by-status" style="font-size:0.65rem;">-</span></div>
      <div class="stat"><span class="label">By Source</span><span class="value" id="pfp-leads-by-source" style="font-size:0.65rem;">-</span></div>
      <div class="stat"><span class="label">Hot (≥7)</span><span class="value" id="pfp-leads-hot">-</span></div>
      <div class="stat"><span class="label">Newest</span><span class="value" id="pfp-leads-newest" style="font-size:0.65rem;">-</span></div>
    </div>
    <!-- 31 Harbor -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#60a5fa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🏠 31 Harbor</div>
      <div class="stat"><span class="label">Contact Pool</span><span class="value" id="harbor-pool">${harborPool}</span></div>
      <div class="stat"><span class="label">Sent Today</span><span class="value" id="harbor-sent-today">${harborSentToday}</span></div>
      <div class="stat"><span class="label">Sent Total</span><span class="value" id="harbor-sent-total">${harborSent}</span></div>
      <div class="stat"><span class="label">Fresh Avail</span><span class="value" id="harbor-fresh">${harborFresh}</span></div>
      <div class="stat"><span class="label">Last Run</span><span class="value" id="harbor-last-run">${harborLastRun}</span></div>
      <div class="stat"><span class="label">Next Drop</span><span class="value" id="harbor-next-drop">-</span></div>
    </div>
  </div>
</div>

<!-- 📡 Ship's Intelligence -->
<div class="card" style="grid-column:1/-1;">
  <h3 style="color:#a78bfa;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📡 Ship's Intelligence
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— XMRT University · GitHub Activity · Incoming Mail</span>
  </h3>
  <div style="display:grid;grid-template-columns:1fr 2fr;gap:12px;">
    <!-- XMRT University -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#a78bfa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🎓 XMRT University</div>
      <div id="university-status">
        <div class="stat"><span class="label">Status</span><span class="value" id="uni-status" style="color:#6b6b80;">checking...</span></div>
      </div>
      <div id="university-detail" style="display:none;">
        <div class="stat"><span class="label">Progress</span><span class="value" id="uni-progress">-</span></div>
        <div class="stat"><span class="label">Cert ID</span><span class="value" id="uni-cert" style="font-size:0.65rem;">-</span></div>
        <div class="stat"><span class="label">Tier</span><span class="value" id="uni-tier">-</span></div>
        <div class="stat"><span class="label">Perms</span><span class="value" id="uni-perms" style="font-size:0.65rem;">-</span></div>
      </div>
      <div style="margin-top:4px;font-size:0.65rem;color:#6b6b80;">
        <div>New agents must graduate from XMRT University to join the fleet.</div>
        <div style="margin-top:2px;">
          <span style="color:#a78bfa;">POST</span> <code style="color:#60a5fa;font-size:0.6rem;">/functions/v1/xmrt-university</code>
        </div>
      </div>
    </div>
    <!-- Incoming Mail (3 inboxes) -->
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="background:#0d0d15;border-radius:6px;padding:8px;">
        <div style="font-size:0.65rem;color:#f87171;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">📬 Incoming Mail</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
          <div>
            <div style="font-size:0.6rem;color:#6b6b80;margin-bottom:2px;">Party Favor Photo</div>
            <div id="pfp-inbox" style="max-height:100px;overflow-y:auto;font-size:0.65rem;">
              <div class="stat"><span class="label">Loading...</span></div>
            </div>
          </div>
          <div>
            <div style="font-size:0.6rem;color:#6b6b80;margin-bottom:2px;">MobileMonero</div>
            <div id="mm-inbox" style="max-height:100px;overflow-y:auto;font-size:0.65rem;">
              <div class="stat"><span class="label">Loading...</span></div>
            </div>
          </div>
          <div>
            <div style="font-size:0.6rem;color:#6b6b80;margin-bottom:2px;">31 Harbor</div>
            <div id="hb-inbox" style="max-height:100px;overflow-y:auto;font-size:0.65rem;">
              <div class="stat"><span class="label">Loading...</span></div>
            </div>
          </div>
        </div>
      </div>
      <!-- GitHub Activity -->
      <div style="background:#0d0d15;border-radius:6px;padding:8px;">
        <div style="font-size:0.65rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🐙 GitHub Activity</div>
        <div class="stat"><span class="label">Total Repos</span><span class="value" id="gh-repo-count">-</span></div>
        <div class="stat"><span class="label">Last Commit</span><span class="value" id="gh-last-commit" style="font-size:0.65rem;">-</span></div>
        <div style="margin-top:4px;font-size:0.65rem;color:#6b6b80;" id="gh-recent-commits"></div>
      </div>
    </div>
  </div>
</div>

<!-- 🏴‍☠️ DAO & Ecosystem -->
<div class="card" style="grid-column:1/-1;">
  <h3 style="color:#4ade80;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    🏴‍☠️ DAO & Ecosystem
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Health · Membership · Ecosystem · Tools</span>
  </h3>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;">
    <!-- DAO Health -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">❤️‍🔥 Health</div>
      <div class="stat"><span class="label">Local DB</span><span class="value" id="dao-health-status">checking...</span></div>
      <div class="stat"><span class="label">Health Score</span><span class="value" id="dao-health-score">-</span></div>
      <div class="stat"><span class="label">Edge Functions</span><span class="value" id="dao-fn-count">-</span></div>
      <div class="stat"><span class="label">Agents</span><span class="value" id="dao-agent-count">-</span></div>
      <div class="stat"><span class="label">Tasks</span><span class="value" id="dao-task-count">-</span></div>
      <div class="stat"><span class="label">Services</span><span class="value" id="dao-service-status">-</span></div>
    </div>
    <!-- Membership -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🎫 Membership</div>
      <div class="stat"><span class="label"><a href="https://whop.com/xmrt-dao" target="_blank" style="color:#4ade80;text-decoration:none;">Free Tier</a></span><span class="value">free</span></div>
      <div class="stat"><span class="label"><a href="https://whop.com/checkout/plan_W6r4uqGWNaKHp" target="_blank" style="color:#ff6b35;text-decoration:none;">Premium</a></span><span class="value">$9.99/mo</span></div>
      <div class="stat"><span class="label"><a href="https://whop.com/checkout/plan_Wj1nh8AJhdsLN" target="_blank" style="color:#ff6b35;text-decoration:none;">Premium Yearly</a></span><span class="value">$99.99/yr</span></div>
      <div class="stat"><span class="label"><a href="https://whop.com/checkout/plan_n853GD3f5IXm0" target="_blank" style="color:#60a5fa;text-decoration:none;">Supporter</a></span><span class="value">$19.99</span></div>
      <div style="margin-top:4px;font-size:0.6rem;color:#6b6b80;">Premium: 2x rewards · governance · early hardware</div>
    </div>
    <!-- Ecosystem -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🌐 Ecosystem</div>
      <div class="stat"><span class="label"><a href="https://xmrtsolutions.vercel.app" target="_blank" style="color:#60a5fa;text-decoration:none;">XMRT Token Faucet</a></span><span class="value">testnet</span></div>
      <div class="stat"><span class="label"><a href="https://coldcash.vercel.app" target="_blank" style="color:#60a5fa;text-decoration:none;">ColdCash</a></span><span class="value">private payments</span></div>
      <div class="stat"><span class="label"><a href="https://pipuente.vercel.app" target="_blank" style="color:#60a5fa;text-decoration:none;">PiPuente</a></span><span class="value">cross-chain bridge</span></div>
      <div class="stat"><span class="label"><a href="https://paragraph.com/@xmrt" target="_blank" style="color:#60a5fa;text-decoration:none;">Paragraph Blog</a></span><span class="value">DAO journal</span></div>
      <div class="stat"><span class="label"><a href="https://sepolia.etherscan.io/token/0x77307DFbc436224d5e6f2048d2b6bDfA66998a15" target="_blank" style="color:#60a5fa;text-decoration:none;">XMRT Token</a></span><span class="value">0x7730...8a15</span></div>
      <div class="stat"><span class="label"><a href="https://github.com/xmrtdao" target="_blank" style="color:#60a5fa;text-decoration:none;">GitHub Org</a></span><span class="value">59 repos</span></div>
    </div>
    <!-- Tools & Actions -->
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🔧 Tools</div>
      ${tools.map(t => '<div class="stat"><span class="label">' + t + '</span><span class="value badge badge-info">ready</span></div>').join('')}
      ${localFunctions.length > 0 ? '<div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;"><div style="font-size:0.6rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px;">Local Functions</div>' + localFunctions.map(f => '<div class="stat"><span class="label" style="color:#4ade80;">fn:' + f.name + '</span><span class="value badge badge-info">local</span></div>').join('') + '</div>' : ''}
      <div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.6rem;color:#6b6b80;">
        <a href="/health" style="color:#4ade80;">Health</a> · <a href="/status" style="color:#60a5fa;">Status</a> · <a href="/tools" style="color:#60a5fa;">Tools</a> · <a href="/monitor" style="color:#60a5fa;">Monitor</a>
      </div>
    </div>
  </div>
</div>

<!-- Ship's Articles Full Board -->
<div id="board-full" class="card" style="grid-column:1/-1;margin-top:0.5rem;">
  <h3 style="color:#fbbf24;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📜 Ship's Articles <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Full Bulletin Board</span>
  </h3>
  <div class="board-tabs" id="board-tabs">
    <span class="board-tab active" onclick="switchBoardView('topics')" id="tab-topics">Resolutions</span>
    <span class="board-tab" onclick="switchBoardView('new')" id="tab-newtopic">+ New Topic</span>
  </div>
  <div id="board-filter-bar" style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;">
    <span class="board-filter active" data-filter="all" onclick="setBoardFilter('all')">All</span>
    <span class="board-filter" data-filter="active" onclick="setBoardFilter('active')">Active</span>
    <span class="board-filter" data-filter="in-progress" onclick="setBoardFilter('in-progress')">In Progress</span>
    <span class="board-filter" data-filter="completed" onclick="setBoardFilter('completed')">Completed</span>
    <span class="board-filter" data-filter="archived" onclick="setBoardFilter('archived')">Archived</span>
  </div>
  <div id="board-topics-view">
    <div class="board-topics" id="board-topics-list-full"></div>
    <div id="board-topic-posts" style="display:none;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1;min-width:0;">
          <span id="board-current-topic-title" style="font-size:13px;font-weight:600;color:var(--text-primary);"></span>
          <span id="board-current-topic-status"></span>
          <span id="board-current-topic-assignment" style="font-size:10px;color:#6b6b80;"></span>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button onclick="renameBoardTopic()" id="board-rename-btn" style="padding:2px 8px;border-radius:4px;border:1px solid #3a3a5a;background:transparent;color:#8b8ba0;cursor:pointer;font-size:10px;">Rename</button>
          <select id="board-status-select" onchange="changeTopicStatus(this.value)" style="padding:2px 4px;border-radius:4px;border:1px solid #3a3a5a;background:#12121a;color:#c0c0d0;font-size:10px;">
            <option value="active">Active</option>
            <option value="in-progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="archived">Archived</option>
          </select>
          <button onclick="togglePinTopic()" id="board-pin-btn" style="padding:2px 8px;border-radius:4px;border:1px solid #3a3a5a;background:transparent;color:#fbbf24;cursor:pointer;font-size:10px;">Pin</button>
          <button onclick="deleteBoardTopic()" id="board-delete-btn" style="padding:2px 8px;border-radius:4px;border:1px solid #5a2a2a;background:transparent;color:#f87171;cursor:pointer;font-size:10px;">Delete</button>
          <button onclick="closeBoardTopic()" style="padding:2px 8px;border-radius:4px;border:1px solid #3a3a5a;background:transparent;color:#8b8ba0;cursor:pointer;font-size:10px;">Back</button>
        </div>
      </div>
      <div class="board-posts" id="board-posts-list"></div>
      <div class="board-input-wrap">
        <input id="board-post-input" type="text" placeholder="Add to this resolution..." onkeypress="if(event.key==='Enter')sendBoardPost()">
        <button onclick="sendBoardPost()" style="padding:6px 14px;border-radius:6px;border:none;background:#ff6b35;color:white;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;">Post</button>
      </div>
      <div style="margin-top:4px;font-size:10px;color:#6b6b80;">
        <span>Posted as <strong id="board-post-agent" style="color:var(--accent-orange);">vex</strong> — all privateers see this resolution</span>
      </div>
    </div>
  </div>
  <div id="board-new-topic-view" style="display:none;">
    <div class="board-new-topic" style="display:flex;flex-direction:column;gap:6px;">
      <input id="board-new-topic-input" type="text" placeholder="Resolution (e.g. Deployment Q2, AgentPay Strategy, PFP Partnerships...)" onkeypress="if(event.key==='Enter')createBoardTopic()">
      <div style="display:flex;gap:6px;align-items:center;">
        <select id="board-new-status" style="padding:4px 8px;border-radius:4px;border:1px solid #3a3a5a;background:#12121a;color:#c0c0d0;font-size:11px;">
          <option value="active">Active</option>
          <option value="in-progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="archived">Archived</option>
        </select>
        <input id="board-new-assignment" type="text" placeholder="Assign to agent (optional)" style="flex:1;padding:4px 8px;font-size:11px;">
        <input type="checkbox" id="board-new-pinned" style="accent-color:#fbbf24;"> <label for="board-new-pinned" style="font-size:10px;color:#fbbf24;">Pin</label>
        <button onclick="createBoardTopic()" style="padding:6px 14px;border-radius:6px;border:none;background:#ff6b35;color:white;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;">Create</button>
      </div>
    </div>
  </div>
  <div style="margin-top:4px;display:flex;gap:8px;font-size:10px;color:#6b6b80;">
    <span>Privateers can post to any resolution — persistent across voyages</span>
    <span id="board-updated-indicator" style="color:#fbbf24;display:none;">* new activity</span>
    <span id="board-status-full" style="color:#4ade80;">● loaded</span>
  </div>
</div>
`;
}
