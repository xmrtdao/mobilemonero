  // ── API helper: add x-api-key to bypass Cloudflare Access on tunnel ──
  const API_KEY = '0de4fe0de4c4723baeb812bb378f95e852a39379b117795da00095481ff14043';
  window.apiFetch = function(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['x-api-key'] = API_KEY;
    opts.headers['x-agent-id'] = 'dashboard';
    return fetch(url, opts);
  };

  // ── Quarterdeck Supervisor Watch ──
  function updateQDSupervisor() {
    apiFetch('/api/supervisor/status').then(r=>r.json()).then(d => {
      const up = d.services.filter(s => s.healthy).length;
      const down = d.services.filter(s => !s.healthy).length;
      const flapping = d.services.filter(s => s.flapping).map(s => s.name);
      const taskIssues = d.tasks.filter(t => t.missed > 0 || (t.ageHours > 30));
      document.getElementById('qds-supervisor').textContent = d.supervisor.alive ? '🟢 Online (pid ' + d.supervisor.pid + ')' : '🔴 Offline';
      document.getElementById('qds-supervisor').style.color = d.supervisor.alive ? '#4ade80' : '#f87171';
      document.getElementById('qds-services-up').textContent = up + '/' + d.services.length;
      document.getElementById('qds-services-up').style.color = up === d.services.length ? '#4ade80' : '#fbbf24';
      document.getElementById('qds-services-down').textContent = down > 0 ? down : '0';
      document.getElementById('qds-services-down').style.color = down > 0 ? '#f87171' : '#4ade80';
      document.getElementById('qds-flapping').textContent = flapping.length > 0 ? flapping.join(', ') : 'none';
      document.getElementById('qds-flapping').style.color = flapping.length > 0 ? '#f87171' : '#4ade80';
      document.getElementById('qds-task-issues').textContent = taskIssues.length > 0 ? taskIssues.length + ' issue(s)' : 'none';
      document.getElementById('qds-task-issues').style.color = taskIssues.length > 0 ? '#fbbf24' : '#4ade80';
      document.getElementById('qds-last-check').textContent = new Date(d.checkedAt).toLocaleTimeString();
    }).catch(() => {
      document.getElementById('qds-supervisor').textContent = '○ offline';
      document.getElementById('qds-supervisor').style.color = '#6b6b80';
    });
  }
  updateQDSupervisor();
  setInterval(updateQDSupervisor, 10000);

  // ── Security Tile — TrustGraph · CAC Tiers · Access Control ──
  function updateQDSSecurity() {
    apiFetch('/api/cuttlefishclaws/trust-network', { signal: AbortSignal.timeout(25000) }).then(r=>r.json()).then(d => {
      var agents = d.agents || d.nodes || [];
      var total = agents.length;
      var trusted = 0, cautious = 0, banned = 0;
      var topScore = 0, topName = '—', lowScore = 100, lowName = '—';
      var anchor = 0, builder = 0, explorer = 0;
      agents.forEach(function(a) {
        var s = a.trustScore !== undefined ? a.trustScore : 50;
        if (s >= 80) trusted++;
        else if (s >= 40) cautious++;
        else banned++;
        if (s > topScore) { topScore = s; topName = a.name || '?'; }
        if (s < lowScore) { lowScore = s; lowName = a.name || '?'; }
        var tier = (a.cacTier || '').toLowerCase();
        if (tier === 'anchor') anchor++;
        else if (tier === 'builder') builder++;
        else if (tier === 'explorer') explorer++;
      });
      var el = function(id) { return document.getElementById(id); };
      if (el('sec-agent-count')) el('sec-agent-count').textContent = total;
      if (el('sec-cac-anchor')) el('sec-cac-anchor').textContent = anchor;
      if (el('sec-cac-builder')) el('sec-cac-builder').textContent = builder;
      if (el('sec-cac-explorer')) el('sec-cac-explorer').textContent = explorer;
      if (el('sec-trusted')) el('sec-trusted').textContent = trusted;
      if (el('sec-cautious')) el('sec-cautious').textContent = cautious;
      if (el('sec-banned')) el('sec-banned').textContent = banned;
      if (el('sec-top-agent')) el('sec-top-agent').textContent = topName + ' (' + topScore.toFixed(1) + ')';
      if (el('sec-low-agent')) el('sec-low-agent').textContent = lowName + ' (' + lowScore.toFixed(1) + ')';
      if (el('sec-tg-status')) { el('sec-tg-status').textContent = '● online'; el('sec-tg-status').style.color = '#4ade80'; }
    }).catch(function() {
      var el = function(id) { return document.getElementById(id); };
      if (el('sec-tg-status')) { el('sec-tg-status').textContent = '○ offline'; el('sec-tg-status').style.color = '#6b6b80'; }
    });
    apiFetch('/api/ef-university', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'certificates'}), signal: AbortSignal.timeout(25000) }).then(r=>r.json()).then(function(certData) {
      var certs = certData.certificates || certData.certs || [];
      var el = function(id) { return document.getElementById(id); };
      if (el('sec-cert-count')) el('sec-cert-count').textContent = certs.length + ' issued';
      if (el('sec-uni-status')) el('sec-uni-status').textContent = '● ' + certs.length + ' graduates';
    }).catch(function() {
      var el = function(id) { return document.getElementById(id); };
      if (el('sec-cert-count')) el('sec-cert-count').textContent = 'unavailable';
      if (el('sec-uni-status')) el('sec-uni-status').textContent = '○ offline';
    });
  }
  updateQDSSecurity();
  setInterval(updateQDSSecurity, 30000);

  // ── Ship's Log (pirate-themed activity feed) ──
  function updateShipsLog() {
    var logEl = document.getElementById('qds-activity-log');
    if (!logEl) return;
    apiFetch('/api/activity-log?limit=20', { signal: AbortSignal.timeout(25000) }).then(function(r) { return r.json(); }).then(function(rows) {
      if (!rows.length) { logEl.innerHTML = '<div class="stat"><span class="label" style="color:#6b6b80;">No activity yet</span></div>'; return; }
      logEl.innerHTML = rows.map(function(a) {
        var type = a.activity_type || 'system';
        var title = (a.title || a.description || type).slice(0, 60);
        var status = a.status || 'info';
        var agent = a.agent_id || '';
        var time = a.created_at ? (function() { var d = new Date(a.created_at); var s = Math.floor((Date.now()-d)/1000); if(s<60) return s+'s'; if(s<3600) return Math.floor(s/60)+'m'; return Math.floor(s/3600)+'h'; })() : '';
        var color = '#6b6b80';
        if (status === 'failed' || status === 'error') color = '#f87171';
        else if (status === 'success' || status === 'completed') color = '#4ade80';
        else if (status === 'in_progress' || status === 'pending') color = '#fbbf24';
        else if (status === 'info') color = '#60a5fa';
        if (type === 'fleet_message') color = '#a78bfa';
        else if (type === 'ai_chat') color = '#34d399';
        else if (type === 'system_health_check') color = status === 'completed' ? '#4ade80' : '#f87171';
        else if (type === 'rate_limit' || type === 'auth_failure') color = '#fb923c';
        else if (type === 'db_error' || type === 'email_error' || type === 'fleet_error' || type === 'memory_error' || type === 'kg_error' || type === 'system_error') color = '#f87171';
        else if (type === 'ollama_error' || type === 'mesh_rejection') color = '#fbbf24';
        var icon = '●';
        if (type === 'fleet_message') icon = '📨';
        else if (type === 'ai_chat') icon = '💬';
        else if (type === 'system_health_check') icon = '🏥';
        else if (type === 'daemon_scan') icon = '🔍';
        else if (type === 'rate_limit') icon = '🚦';
        else if (type === 'auth_failure') icon = '🔑';
        else if (type === 'db_error') icon = '🗄️';
        else if (type === 'email_error') icon = '📧';
        else if (type === 'fleet_error') icon = '📡';
        else if (type === 'memory_error') icon = '🧠';
        else if (type === 'ollama_error') icon = '🤖';
        else if (type === 'kg_error') icon = '🕸️';
        else if (type === 'mesh_rejection') icon = '🌐';
        else if (type === 'system_error') icon = '💥';
        else if (status === 'failed' || status === 'error') icon = '❌';
        else if (status === 'success' || status === 'completed') icon = '✅';
        return '<div class="stat" style="font-size:0.6rem;line-height:1.4;"><span class="label" style="color:' + color + ';">' + icon + ' ' + title + '</span><span class="value" style="color:' + color + ';font-size:0.55rem;">' + time + '</span></div>';
      }).join('');
    }).catch(function() {
      var el = document.getElementById('qds-activity-log');
      if (el) el.innerHTML = '<div class="stat"><span class="label" style="color:#6b6b80;">Activity feed unavailable</span></div>';
    });
  }
  updateShipsLog();
  setInterval(updateShipsLog, 5000);

  // ── Mesh Peers ──
  function updateMeshPeers() {
    var meshSeq = Date.now();
    apiFetch('/api/mesh/bridge', { signal: AbortSignal.timeout(25000) }).then(r=>r.json()).then(d => {
      var peers = document.getElementById('qds-mesh-peers');
      if (!peers) return;
      if (peers.dataset.meshSeq && peers.dataset.meshSeq != meshSeq) return;
      peers.dataset.meshSeq = meshSeq;
      if (d.nodeList && d.nodeList.length > 0) {
        peers.innerHTML = d.nodeList.map(function(n) {
          return '<div class="stat" style="font-size:0.6rem;"><span class="label">' + (n.name || n.id || 'node') + '</span><span class="value" style="color:#4ade80;">' + (n.rssi ? n.rssi.toFixed(0) + ' dBm' : '?') + '</span></div>';
        }).join('');
      } else {
        peers.innerHTML = '<div class="stat"><span class="label">No mesh peers</span></div>';
      }
      var bridge = document.getElementById('qds-mt-bridge');
      var mtPeers = document.getElementById('qds-mt-peers');
      var mtMsgs = document.getElementById('qds-mt-msgs');
      if (bridge) bridge.textContent = d.connected ? '🟢 connected' : '○ idle';
      if (bridge) bridge.style.color = d.connected ? '#4ade80' : '#6b6b80';
      if (mtPeers) mtPeers.textContent = d.nodes || 0;
      if (mtMsgs) mtMsgs.textContent = d.messageCount || 0;
    }).catch(() => {});
  }
  updateMeshPeers();
  setInterval(updateMeshPeers, 5000);

  // ── Bulletin Board Topics (in Quarterdeck) ──
  function updateBoardTopics() {
    var seq = Date.now();
    var list = document.getElementById('board-topics-list');
    if (!list) return;
    list.dataset.seq = seq;
    apiFetch('/api/bulletin/topics', { signal: AbortSignal.timeout(25000) }).then(r=>r.json()).then(d => {
      if (list.dataset.seq != seq) return;
      var count = document.getElementById('qds-articles-count');
      if (d.topics && d.topics.length > 0) {
        if (count) count.textContent = d.topics.length;
        list.innerHTML = d.topics.slice(0, 5).map(function(t) {
          var statusColor = t.status === 'completed' ? '#4ade80' : t.status === 'in-progress' ? '#fbbf24' : t.status === 'archived' ? '#6b6b80' : '#60a5fa';
          var statusIcon = t.status === 'completed' ? '✅' : t.status === 'in-progress' ? '🔄' : t.status === 'archived' ? '📦' : '📋';
          return '<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:0.65rem;border-bottom:1px solid #1a1a2e;"><span style="color:#e0e0e0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (t.title || 'untitled') + '</span><span style="color:' + statusColor + ';margin-left:6px;">' + statusIcon + ' ' + (t.status || 'active') + '</span></div>';
        }).join('');
      } else {
        if (count) count.textContent = '0';
        list.innerHTML = '<div style="color:#6b6b80;font-size:0.65rem;">No resolutions yet</div>';
      }
    }).catch(function() {
      if (list.dataset.seq != seq) return;
      list.innerHTML = '<div style="color:#f87171;font-size:0.65rem;">Articles offline</div>';
    });
  }
  updateBoardTopics();
  setInterval(updateBoardTopics, 15000);

  // dashboard.js v7.0.1 — FIX: removed createRadialGradient, shadowBlur, and glow caching to prevent canvas freeze on agent hover
// ── Rum Quota + Agent Fleet (combined) ──
  function updateGrogQuota() {
    var seq = Date.now();
    var content = document.getElementById('rum-quota-content');
    if (!content) return;
    content.dataset.seq = seq;
    Promise.all([
      apiFetch('/api/rum-quota', { signal: AbortSignal.timeout(25000) }).then(function(r){return r.json();}).catch(function(){return null;}),
      apiFetch('/api/fleet-chat/agents', { signal: AbortSignal.timeout(25000) }).then(function(r){return r.json();}).catch(function(){return {agents:[]};}),
      apiFetch('/api/cuttlefishclaws/trust-network', { signal: AbortSignal.timeout(25000) }).then(function(r){return r.json();}).catch(function(){return {};}),
      apiFetch('/api/agent-activity', { signal: AbortSignal.timeout(25000) }).then(function(r){return r.json();}).catch(function(){return {agents:[]};})
    ]).then(function(results) {
      if (content.dataset.seq != seq) return;
      var rumData = results[0];
      var fleetData = results[1] || {agents:[]};
      var trustData = results[2] || {};
      var activityData = results[3] || {agents:[]};
      var trustAgents = trustData.agents || trustData.nodes || [];

      if (!rumData) {
        content.innerHTML = '<div class="stat"><span class="label" style="color:#f87171;">Rum cellar offline</span></div>';
        return;
      }

      // Build activity map
      var activityMap = {};
      (activityData.agents || []).forEach(function(a) {
        activityMap[a.agent_id] = a;
      });

      // Build trust map
      var trustMap = {};
      trustAgents.forEach(function(t) {
        var name = (t.name || '').toLowerCase().trim();
        trustMap[name] = { score: t.trustScore, band: t.trustBand, status: t.status, tier: t.cacTier };
      });

      // Build fleet map
      var fleetMap = {};
      fleetData.agents.forEach(function(a) {
        var name = (a.name || '').toLowerCase().trim();
        fleetMap[name] = a.type || 'relay';
      });

      // Merge rum data with trust and fleet info
      var rows = [];
      var totalCalls = rumData.total_calls_used || 0;
      var budget = rumData.budget_calls || 15000;
      var remaining = rumData.calls_remaining || 0;
      var pctUsed = rumData.pct_used || '0.0';
      var hoursUntil = rumData.hours_until_restock || 0;
      var nextRestock = rumData.next_restock || '';

      // Format hours until restock
      var restockStr = '';
      if (hoursUntil > 24) {
        restockStr = Math.round(hoursUntil / 24) + 'd ' + Math.round(hoursUntil % 24) + 'h';
      } else {
        restockStr = Math.round(hoursUntil) + 'h';
      }

      var emojiMap = { 'eliza': '🤖', 'joe': '🏴‍☠️', 'hermes': '⚡', 'vex': '🦑', 'alice': '📧', 'system': '⚙️', 'trib': '🏛️', 'harbor': '🏠', 'postman': '📬', 'arch': '🏗️', 'builder': '🔨', 'sovereign': '👑', 'trustgraph': '📊', 'dao-gov': '🏛️', 'global-communicator': '📡', 'kimi': '🧠', 'xmrt-aidy': '🛠️', 'pfp': '📸', 'relay': '🔌', '127.0.0.1': '🖥️', 'suite-unified-chat': '💬', 'local-dev': '💻', 'anya-sharma': '👩‍💼', 'vex-user': '🦑', 'eliza-quartermaster': '🤖', 'vex-captain,-hms-speedy': '🦑', 'hermes-agent': '⚡' };

      rumData.agents.forEach(function(a) {
        var canon = a.agent.toLowerCase().trim();
        var trust = trustMap[canon] || {};
        var type = fleetMap[canon] || 'unknown';
        var statusColor = trust.status === 'online' ? '#4ade80' : trust.status === 'standby' ? '#fbbf24' : '#6b6b80';
        var bandColor = trust.band === 'Trusted' ? '#4ade80' : trust.band === 'Cautious' ? '#fbbf24' : trust.band === 'Banned' ? '#f87171' : '#6b6b80';
        var emoji = emojiMap[canon] || '🫡';
        rows.push({ agent: a.agent, emoji: emoji, calls: a.calls, tokens: a.tokens, pct: a.pct, trustScore: trust.score, bandColor: bandColor, statusColor: statusColor, type: type });
      });

      // Add fleet agents with no token usage
      var seen = {};
      rows.forEach(function(r) { seen[r.agent.toLowerCase().trim()] = true; });
      fleetData.agents.forEach(function(a) {
        var name = (a.name || '').toLowerCase().trim();
        if (!seen[name]) {
          seen[name] = true;
          var trust = trustMap[name] || {};
          var statusColor = trust.status === 'online' ? '#4ade80' : trust.status === 'standby' ? '#fbbf24' : '#6b6b80';
          var bandColor = trust.band === 'Trusted' ? '#4ade80' : trust.band === 'Cautious' ? '#fbbf24' : trust.band === 'Banned' ? '#f87171' : '#6b6b80';
          var emoji = emojiMap[name] || '🫡';
          rows.push({ agent: a.name, emoji: emoji, calls: 0, tokens: 0, pct: '0.0', trustScore: trust.score, bandColor: bandColor, statusColor: statusColor, type: a.type || 'relay' });
        }
      });

      rows.sort(function(a, b) { return b.calls - a.calls; });

      // Header with budget info
      var html = '<div style="font-size:0.6rem;color:#6b6b80;margin-bottom:4px;">';
      html += '🍺 <b style="color:#a78bfa;">' + totalCalls.toLocaleString() + '</b> / <b style="color:#fbbf24;">' + budget.toLocaleString() + '</b> calls used · ';
      html += '<b style="color:' + (remaining > 0 ? '#4ade80' : '#f87171') + ';">' + remaining.toLocaleString() + '</b> remaining · ';
      html += '<b style="color:#60a5fa;">' + pctUsed + '%</b> of weekly rum · ';
      html += '⏳ <b style="color:#fbbf24;">' + restockStr + '</b> till restock';
      html += '</div>';

      // Progress bar
      var pctNum = parseFloat(pctUsed) / 100;
      var barColor = pctNum > 0.8 ? '#f87171' : pctNum > 0.5 ? '#fbbf24' : '#4ade80';
      html += '<div style="height:4px;background:#1e1e2e;border-radius:2px;margin-bottom:4px;overflow:hidden;">';
      html += '<div style="height:100%;width:' + Math.min(pctNum * 100, 100) + '%;background:' + barColor + ';border-radius:2px;transition:width 1s;"></div>';
      html += '</div>';

      // Column headers
      html += '<div style="display:flex;align-items:center;gap:4px;font-size:0.55rem;color:#6b6b80;padding:2px 0;border-bottom:1px solid #1e1e2e;margin-bottom:2px;">';
      html += '<span style="width:16px;"></span>';
      html += '<span style="flex:1;">Crew</span>';
      html += '<span style="width:28px;text-align:center;">St</span>';
      html += '<span style="width:32px;text-align:right;">Trust</span>';
      html += '<span style="width:40px;text-align:right;">Calls</span>';
      html += '<span style="width:24px;text-align:right;">%</span>';
      html += '<span style="width:50px;text-align:right;">Tokens</span>';
      html += '</div>';

      // Agent rows
      html += '<div style="display:flex;flex-direction:column;gap:1px;">';
      rows.forEach(function(r) {
        var trustStr = r.trustScore !== undefined && r.trustScore !== null ? '<span style="color:' + r.bandColor + ';">' + r.trustScore.toFixed(1) + '</span>' : '<span style="color:#6b6b80;">-</span>';
        var statusDot = r.statusColor !== '#6b6b80' ? '<span style="color:' + r.statusColor + ';">●</span>' : '';
        // Check if agent is actively working
        var activity = activityMap[r.agent.toLowerCase().trim()];
        var isWorking = activity && activity.status === 'working';
        var workingIndicator = isWorking ? '<span style="color:#fbbf24;font-size:8px;animation:pulse 1s infinite;" title="' + (activity.activity || 'working') + '">⚡</span>' : '';
        var durationStr = isWorking && activity.duration_seconds ? ' (' + activity.duration_seconds + 's)' : '';
        html += '<div style="display:flex;align-items:center;gap:4px;font-size:0.6rem;padding:1px 0;">';
        html += '<span>' + r.emoji + '</span>';
        html += '<span style="flex:1;color:#e0e0e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + r.agent + '</span>';
        html += '<span style="width:28px;text-align:center;">' + (isWorking ? workingIndicator : statusDot) + '</span>';
        html += '<span style="width:32px;text-align:right;">' + trustStr + '</span>';
        html += '<span style="color:#a78bfa;width:40px;text-align:right;font-weight:500;">' + (r.calls || 0) + '</span>';
        html += '<span style="color:#6b6b80;width:24px;text-align:right;">' + r.pct + '%</span>';
        html += '<span style="color:#6b6b80;width:50px;text-align:right;">' + (r.tokens || 0).toLocaleString() + '</span>';
        html += '</div>';
      });
      html += '</div>';
      content.innerHTML = html;
    }).catch(function() {
      if (content.dataset.seq != seq) return;
      content.innerHTML = '<div class="stat"><span class="label" style="color:#f87171;">Rum cellar offline</span></div>';
    });
  }
  updateGrogQuota();
  setInterval(updateGrogQuota, 15000);

  // ── Task Pipeline ──
  function updateTaskPipeline() {
    var content = document.getElementById('task-pipeline-content');
    if (!content) return;
    apiFetch('/api/tasks/pipeline-summary', { signal: AbortSignal.timeout(25000) })
      .then(function(r){return r.json();})
      .then(function(d){
        var html = '<div style="display:flex;gap:8px;margin-bottom:4px;">';
        html += '<span>📋 <b style="color:#60a5fa;">' + d.total + '</b> total</span>';
        html += '</div>';
        // By stage
        if (d.by_stage && d.by_stage.length > 0) {
          html += '<div style="margin-bottom:3px;">';
          d.by_stage.forEach(function(s) {
            var stageColors = { 'PENDING': '#6b6b80', 'DISCUSS': '#fbbf24', 'PLAN': '#60a5fa', 'EXECUTE': '#a78bfa', 'VERIFY': '#4ade80', 'COMPLETED': '#34d399', 'BLOCKED': '#f87171' };
            var color = stageColors[s.stage] || '#6b6b80';
            html += '<span style="display:inline-block;margin-right:6px;font-size:0.55rem;"><span style="color:' + color + ';">●</span> ' + s.stage + ' <b style="color:#e0e0e0;">' + s.count + '</b></span>';
          });
          html += '</div>';
        }
        // By assignee
        if (d.by_assignee && d.by_assignee.length > 0) {
          html += '<div style="border-top:1px solid #1e1e2e;padding-top:3px;margin-bottom:3px;">';
          d.by_assignee.forEach(function(a) {
            html += '<div style="display:flex;justify-content:space-between;font-size:0.55rem;"><span style="color:#8b8ba0;">' + (a.agent || 'unassigned') + '</span><span style="color:#e0e0e0;">' + a.count + '</span></div>';
          });
          html += '</div>';
        }
        // Recent tasks
        if (d.recent && d.recent.length > 0) {
          html += '<div style="border-top:1px solid #1e1e2e;padding-top:3px;">';
          html += '<div style="font-size:0.5rem;color:#6b6b80;margin-bottom:2px;">Recent:</div>';
          d.recent.slice(0, 5).forEach(function(t) {
            var stageColors = { 'PENDING': '#6b6b80', 'DISCUSS': '#fbbf24', 'PLAN': '#60a5fa', 'EXECUTE': '#a78bfa', 'VERIFY': '#4ade80', 'COMPLETED': '#34d399', 'BLOCKED': '#f87171' };
            var color = stageColors[t.stage] || '#6b6b80';
            var progress = t.progress_percentage != null ? ' [' + t.progress_percentage + '%]' : '';
            html += '<div style="font-size:0.5rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><span style="color:' + color + ';">●</span> <span style="color:#8b8ba0;">' + (t.assignee_agent_id || '?') + '</span> <span style="color:#e0e0e0;">' + (t.title || '').slice(0, 40) + '</span>' + progress + '</div>';
          });
          html += '</div>';
        }
        content.innerHTML = html;
      }).catch(function(){
        content.innerHTML = '<div class="stat"><span class="label" style="color:#f87171;">Task pipeline offline</span></div>';
      });
  }
  updateTaskPipeline();
  setInterval(updateTaskPipeline, 15000);

  const SUPABASE_URL = '${supabaseUrl}';
  let functions = [];
  let sortKey = 'name';
  let sortDir = 1;

  // Load edge function catalog
  apiFetch('/api/catalog')
    .then(r => r.json())
    .then(data => {
      functions = data.functions || [];
      document.getElementById('fnCount').textContent = '— ' + functions.length + ' total';
      renderFunctions();
    })
    .catch(e => {
      document.getElementById('fnBody').innerHTML = '<tr><td colspan="5" style="color:#f87171;text-align:center;padding:2rem;">Failed to load catalog: ' + e.message + '</td></tr>';
    });

  // Load pool stats for mining card
  function loadPoolStats() {
    apiFetch('/api/mining/pool-stats').then(function(r){return r.json();}).then(function(d){
      var e;
      if (e = document.getElementById('pool-hash')) e.textContent = (d.hash || 0).toFixed(0) + ' H/s';
      if (e = document.getElementById('pool-shares')) e.textContent = (d.validShares||0).toLocaleString() + ' valid / ' + (d.invalidShares||0) + ' invalid';
      if (e = document.getElementById('pool-xmr')) e.textContent = d.amtPaidXMR.toFixed(6) + ' / ' + d.amtDueXMR.toFixed(6) + ' XMR';
      // New fields: global pool stats, treasury, health
      if (e = document.getElementById('pool-global-hash')) {
        var mhs = d.pool_hashrate_mhs || 0;
        e.textContent = mhs > 0 ? mhs.toFixed(2) + ' MH/s' : (d.pool_hashrate || 0).toFixed(0) + ' H/s';
      }
      if (e = document.getElementById('pool-total-miners')) {
        e.textContent = (d.pool_total_miners || 0).toLocaleString() + ' miners \u00b7 ' + (d.pool_total_blocks || 0) + ' blocks';
      }
      if (e = document.getElementById('pool-treasury')) {
        var treas = d.treasury_allocation_xmr || 0;
        var ops = d.operational_allocation_xmr || 0;
        e.textContent = treas.toFixed(6) + ' / ' + ops.toFixed(6) + ' XMR';
      }
      if (e = document.getElementById('pool-health')) {
        var h = d.ecosystem_health || {};
        var parts = [];
        if (h.mining_active) parts.push('\u2705 Active'); else if (d.mining_status === 'offline') parts.push('\u274c Offline'); else parts.push('\u2753 Unknown');
        if (h.revenue_generating) parts.push('\u{1F4B0} Earning');
        if (h.pool_healthy) parts.push('\u{1F30D} Good');
        e.textContent = parts.join(' \u00b7 ');
        e.style.color = h.mining_active ? '#4ade80' : '#ef4444';
      }
    }).catch(function(){});
    apiFetch('/api/mining/pool-identifiers').then(function(r){return r.json();}).then(function(ids){
      var e = document.getElementById('pool-workers');
      if (e) e.textContent = ids && ids.length ? ids.join(', ') : 'none';
    }).catch(function(){});
  }
  loadPoolStats();
  setInterval(loadPoolStats, 30000);

  // Fleet Agent Registry
  function loadFleetAgents() {
    // Fetch pool identifiers to cross-reference agent status
    var ids = [];
    var trustMap = {};
    // Fetch trust scores in parallel
    apiFetch('/api/cuttlefishclaws/trust-network', { signal: AbortSignal.timeout(25000) }).then(function(r){return r.json();}).then(function(td){
      var agents = td.agents || td.nodes || [];
      if (Array.isArray(agents)) {
        agents.forEach(function(a){
          var name = a.name || a.agent_id || a.id;
          if (name) trustMap[name.toLowerCase()] = { score: a.trustScore || a.trust_score || 0, band: a.trustBand || a.trust_band || '?' };
        });
      }
    }).catch(function(){}).then(function(){
    apiFetch('/api/mining/pool-identifiers', { signal: AbortSignal.timeout(25000) }).then(function(r){return r.json();}).then(function(idData){
      ids = idData || [];
    }).catch(function(){}).then(function(){
    return apiFetch('/api/fleet/agents').then(function(r){return r.json();});
    }).then(function(data){
      var agents = data.agents || [];
      var list = document.getElementById('fleet-agents-list');
      var count = document.getElementById('fleet-count');
      if (!count) return;
      count.textContent = '\u2014 ' + agents.length + ' agent' + (agents.length !== 1 ? 's' : '');
      if (!agents.length) {
        list.innerHTML = '<div class="stat"><span class="label">No agents registered</span></div>';
        return;
      }
      list.innerHTML = agents.map(function(a){
        var status = a.status;
        var hashrate = a.hashrate && (status === 'ONLINE' || status === 'online') ? a.hashrate : 0;
        var sb = status === 'ONLINE' || status === 'online' ? 'badge-ok' : status === 'BUSY' ? 'badge-warn' : 'badge-err';
        var agentName = a.agent_id || a.name || '?';
        var agentRole = a.role || 'agent';
        var cleanRole = agentRole.replace(/-/g,' ').replace(/\b\w/g, function(l){return l.toUpperCase();});
        var me = agentName === 'vex' ? '\u2b50 ' : '';
        var tun = a.tunnel_url ? '<br><span style="font-size:0.65rem;color:#4a7cff;">' + a.tunnel_url + '</span>' : '';
        var h = a.hashrate ? ' \u00b7 ' + a.hashrate + ' H/s' : '';
        // Look up trust score
        var trustInfo = trustMap[agentName.toLowerCase()];
        var trustStr = trustInfo ? ' <span style="font-size:0.65rem;color:' + (trustInfo.score >= 90 ? '#4ade80' : trustInfo.score >= 70 ? '#60a5fa' : trustInfo.score >= 50 ? '#fbbf24' : trustInfo.score >= 20 ? '#f87171' : '#6b6b80') + ';">\u25cf ' + trustInfo.score.toFixed(1) + ' ' + trustInfo.band + '</span>' : '';
        return '<div class="stat"><span class="label">' + me + agentName + trustStr + '<br><span style="font-size:0.65rem;color:#6b6b80;">' + cleanRole + '</span>' + tun + '</span><span class="value"><span class="badge ' + sb + '">' + status + '</span>' + h + '</span></div>';
      }).join('');
      // Update heartbeat URL
      var hb = document.getElementById('heartbeat-url');
      var t = document.querySelector('a[href*="relay.mobilemonero"]');
      if (hb && t) hb.textContent = t.href + '/api/fleet/heartbeat';
    }).catch(function(){
      // Fleet agents unavailable — leave as Loading...
    });
    });
  };
  loadFleetAgents();
// -- XMRT University Status --
async function loadUniversityStatus() {
  var statusEl = document.getElementById('uni-status');
  var detailEl = document.getElementById('university-detail');
  var progressEl = document.getElementById('uni-progress');
  var certEl = document.getElementById('uni-cert');
  var tierEl = document.getElementById('uni-tier');
  var permsEl = document.getElementById('uni-perms');
  var sourceEl = document.getElementById('uni-curriculum-source');
  
  try {
    // Fetch curriculum info
    var coursesRes = await apiFetch('/api/ef-university', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'courses' })
    });
    var coursesData = await coursesRes.json();
    if (coursesData.success) {
      statusEl.textContent = coursesData.total_modules + ' modules available';
      statusEl.style.color = '#4ade80';
      if (sourceEl) sourceEl.textContent = 'database';
    } else {
      statusEl.textContent = 'offline';
      statusEl.style.color = '#ef4444';
    }
  } catch(e) {
    statusEl.textContent = 'unreachable';
    statusEl.style.color = '#ef4444';
  }
}
setInterval(loadUniversityStatus, 60000);
loadUniversityStatus();

// ── Agent Experience Card ──
async function loadAgentExperienceCard() {
  try {
    var r = await apiFetch('/api/fleet-chat/agents', { signal: AbortSignal.timeout(25000) });
    if (r.ok) { var d = await r.json(); document.getElementById('fleet-agent-count').textContent = (d.agents||[]).length + ' agents'; }
  } catch(e) {}
  try {
    var r = await apiFetch('/api/ef-university', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'courses'}), signal: AbortSignal.timeout(25000) });
    if (r.ok) { var d = await r.json(); document.getElementById('uni-module-count').textContent = (d.total_modules||'?') + ' modules'; }
  } catch(e) {}
  try {
    var r = await apiFetch('/api/bulletin/topics', { signal: AbortSignal.timeout(25000) });
    if (r.ok) { var d = await r.json(); document.getElementById('bulletin-count').textContent = (d.topics||[]).length + ' topics'; }
  } catch(e) {}
  try {
    var r = await apiFetch('/api/fleet-chat/messages', { signal: AbortSignal.timeout(25000) });
    if (r.ok) { var d = await r.json(); document.getElementById('chat-count').textContent = (d.messages||[]).length + ' msgs'; }
  } catch(e) {}
}
setInterval(loadAgentExperienceCard, 60000);
loadAgentExperienceCard();

  setInterval(loadFleetAgents, 15000);

  // Load mesh peers from peer connector
  function loadMeshPeers() {
    apiFetch('/api/mesh/peers', {
      signal: AbortSignal.timeout(25000)
    }).then(function(r){return r.json();}).then(function(data){
      var peers = data.peers || [];
      var list = document.getElementById('mesh-peers-list');
      var count = document.getElementById('mesh-count');
      if (!count) return;
      count.textContent = '\u2014 ' + peers.length + ' peer' + (peers.length !== 1 ? 's' : '');
      if (!peers.length) {
        list.innerHTML = '<div class="stat"><span class="label">No mesh peers registered</span></div>';
        return;
      }
      list.innerHTML = peers.map(function(p){
        var status = p.status || 'unknown';
        var sb = status === 'online' ? 'badge-ok' : 'badge-err';
        var me = p.agent_name === 'vex' ? '\u2b50 ' : '';
        var eps = p.endpoint ? '<br><span style="font-size:0.65rem;color:#4a7cff;">' + p.endpoint + '</span>' : '';
        var caps = p.capabilities ? '<br><span style="font-size:0.6rem;color:#6b6b80;">' + p.capabilities.slice(0,5).join(', ') + (p.capabilities.length > 5 ? ' +' + (p.capabilities.length-5) + ' more' : '') + '</span>' : '';
        var lastSeen = p.last_seen ? new Date(p.last_seen).toLocaleTimeString() : '';
        return '<div class="stat"><span class="label">' + me + p.agent_name + eps + caps + '</span><span class="value"><span class="badge ' + sb + '">' + status + '</span><br><span style="font-size:0.6rem;color:#6b6b80;">' + lastSeen + '</span></span></div>';
      }).join('');
    }).catch(function(){
      // Mesh peers unavailable
    });
  };
  loadMeshPeers();
  setInterval(loadMeshPeers, 30000);

  // Meshtastic bridge status (inline in Fleet Network)
  function updateMeshtasticBridge() {
    apiFetch('/api/mesh/bridge', { signal: AbortSignal.timeout(25000) }).then(function(r){return r.json();}).then(function(d){
      var status = document.getElementById('mt-bridge-status');
      var peers = document.getElementById('mt-peers');
      var messages = document.getElementById('mt-messages');
      var uptime = document.getElementById('mt-uptime');
      var nodesDiv = document.getElementById('meshtastic-nodes');
      var nodeList = document.getElementById('mt-node-list');
      if (!status) return;
      if (d.connected) {
        status.textContent = '🟢 Connected';
        status.style.color = '#4ade80';
        if (peers) peers.textContent = d.nodes + ' nodes';
        if (messages) messages.textContent = d.messageCount || 0;
        var u = d.uptime || 0;
        if (uptime) uptime.textContent = u > 3600 ? Math.floor(u/3600)+'h '+Math.floor((u%3600)/60)+'m' : u > 60 ? Math.floor(u/60)+'m '+u%60+'s' : u+'s';
        if (d.nodeList && d.nodeList.length > 0 && nodesDiv && nodeList) {
          nodesDiv.style.display = 'block';
          nodeList.innerHTML = d.nodeList.map(function(n){
            return '<div style="padding:1px 0;font-size:0.65rem;">🟢 ' + (n.name || n.id) +
              (n.rssi ? ' <span style="color:#6b6b80;">RSSI:'+n.rssi.toFixed(1)+'</span>' : '') +
              (n.snr ? ' <span style="color:#6b6b80;">SNR:'+n.snr.toFixed(1)+'</span>' : '') +
              '</div>';
          }).join('');
        } else if (nodesDiv) {
          nodesDiv.style.display = 'none';
        }
      } else {
        status.textContent = '○ Disconnected';
        status.style.color = '#6b6b80';
        if (peers) peers.textContent = (d.nodes || 0) + ' nodes tracked';
        if (messages) messages.textContent = d.messageCount || 0;
        if (uptime) uptime.textContent = '-';
        if (nodesDiv) nodesDiv.style.display = 'none';
      }
    }).catch(function(){
      var status = document.getElementById('mt-bridge-status');
      if (status) { status.textContent = '○ offline'; status.style.color = '#6b6b80'; }
    });
  }
  updateMeshtasticBridge();
  setInterval(updateMeshtasticBridge, 5000);

  // Mining Stats from pool + xmrig (proxied through relay)
  // Load mining leaderboard
  function loadMiningLeaderboard() {
    apiFetch('/mining/leaderboard').then(function(r){return r.json();}).then(function(d){
      var el = document.getElementById('miner-leaderboard');
      if (!el) return;
      if (!d.workers || d.workers.length === 0) {
        el.innerHTML = '<div class="stat"><span class="label">No contributors yet</span></div>';
        return;
      }
      var now = Date.now();
      el.innerHTML = d.workers.slice(0,10).map(function(w) {
        var lastSeen = new Date(w.last_seen).getTime();
        var minutesAgo = Math.round((now - lastSeen) / 60000);
        var isOnline = minutesAgo < 10;
        var statusDot = isOnline ? '<span style="color:#4ade80;">●</span>' : '<span style="color:#6b6b80;">○</span>';
        var hashDisplay = w.current_hash > 0 ? w.current_hash + ' H/s' : '-';
        var sharesDisplay = w.total_shares > 0 ? w.total_shares.toLocaleString() : '0';
        var timeAgo = minutesAgo < 1 ? 'just now' : minutesAgo + 'm ago';
        return '<div class="stat"><span class="label">' + statusDot + ' ' + w.worker.slice(0,16) + '<br><span style="font-size:0.65rem;color:#6b6b80;">' + hashDisplay + ' · ' + timeAgo + '</span></span><span class="value">' + sharesDisplay + ' shares<br><span style="font-size:0.65rem;color:#fbbf24;">' + w.xmrt_earned + ' XMRT</span></span></div>';
      }).join('');
    }).catch(function(){
      var el = document.getElementById('miner-leaderboard');
      if (el) el.innerHTML = '<div class="stat"><span class="label">Leaderboard unavailable</span></div>';
    });
  }
  loadMiningLeaderboard();
  setInterval(loadMiningLeaderboard, 15000);

  // Local XMRig heartbeat (vex-laptop auto-reports hashrate)
  function localMinerHeartbeat() {
    apiFetch('/api/mining/local-xmrig', { signal: AbortSignal.timeout(25000) })
      .then(function(r){return r.json();})
      .then(function(d){
        var h = d.hashrate || 0;
        if (h > 0) {
          apiFetch('/mining/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ worker: 'vex-laptop', hashrate: Math.round(h) })
          }).catch(function(){});
        }
      }).catch(function(){});
  }
  localMinerHeartbeat();
  setInterval(localMinerHeartbeat, 60000);

  // Party Favor Photo inbox refresh (brief — lightweight)
  function loadPfpInbox() {
    fetch('/resend/inbox/brief').then(function(r){return r.json();}).then(function(data){
      var card = document.getElementById('pfp-inbox');
      if (!card) return;
      var emails = data.emails || data.recent || [];
      if (!emails.length) {
        card.innerHTML = '<div class="stat"><span class="label">No emails yet</span></div>';
        return;
      }
      var html = '';
      // Group by recipient
      var groups = {};
      emails.slice(0,20).forEach(function(e){
        var addr = Array.isArray(e.to) ? (e.to[0] || 'unknown') : (e.to || 'unknown');
        if (!groups[addr]) groups[addr] = [];
        groups[addr].push(e);
      });
      var count = 0;
      Object.keys(groups).forEach(function(addr){
        var msgs = groups[addr];
        html += '<div class="stat" style="border-bottom:1px solid #2a2a3a;padding:0.4rem 0;">';
        html += '<span class="label" style="font-size:0.78rem;color:#60a5fa;">' + addr + '</span>';
        html += '<span class="value badge badge-info">' + msgs.length + '</span>';
        html += '</div>';
        msgs.forEach(function(m){
          count++;
          if (count > 10) return;
          html += '<div class="stat" style="padding:0.2rem 0 0.2rem 0.5rem;font-size:0.72rem;">';
          html += '<span class="label">' + (m.from||'').substring(0,28) + '</span>';
          html += '<span class="value" style="color:#a0a0b0;">' + (m.subject||'').substring(0,22) + '</span>';
          html += '</div>';
        });
      });
      if (!html) html = '<div class="stat"><span class="label">No emails yet</span></div>';
      card.innerHTML = html;
    }).catch(function(){
      var e = document.getElementById('pfp-inbox');
      if (e) e.innerHTML = '<div class="stat"><span class="label">Inbox unavailable</span></div>';
    });
  }
  loadPfpInbox();
  setInterval(loadPfpInbox, 15000);

  // MobileMonero inbox refresh (brief — lightweight)
  function loadMmInbox() {
    fetch('/resend/mobilemonero/inbox/brief').then(function(r){return r.json();}).then(function(data){
      var card = document.getElementById('mm-inbox');
      if (!card) return;
      var emails = data.emails || data.recent || [];
      if (!emails.length) {
        card.innerHTML = '<div class="stat"><span class="label">No emails yet</span></div>';
        return;
      }
      var html = '';
      var groups = {};
      emails.slice(0,15).forEach(function(e){
        var addr = Array.isArray(e.to) ? (e.to[0] || 'unknown') : (e.to || 'unknown');
        if (!groups[addr]) groups[addr] = [];
        groups[addr].push(e);
      });
      var count = 0;
      Object.keys(groups).forEach(function(addr){
        html += '<div class="stat" style="border-bottom:1px solid #2a2a3a;padding:0.3rem 0;">';
        html += '<span class="label" style="font-size:0.75rem;color:#60a5fa;">' + addr + '</span>';
        html += '<span class="value badge badge-info">' + groups[addr].length + '</span></div>';
        groups[addr].forEach(function(m){
          count++;
          if (count > 8) return;
          html += '<div class="stat" style="padding:0.15rem 0 0.15rem 0.4rem;font-size:0.7rem;">';
          html += '<span class="label">' + (m.from||'').substring(0,25) + '</span>';
          html += '<span class="value" style="color:#a0a0b0;">' + (m.subject||'').substring(0,20) + '</span></div>';
        });
      });
      if (!html) html = '<div class="stat"><span class="label">No emails yet</span></div>';
      card.innerHTML = html;
    }).catch(function(){
      var e = document.getElementById('mm-inbox');
      if (e) e.innerHTML = '<div class="stat"><span class="label">Inbox unavailable</span></div>';
    });
  }
  loadMmInbox();
  setInterval(loadMmInbox, 15000);

  // 31 Harbor inbox refresh (brief — lightweight)
  function loadHbInbox() {
    fetch('/resend/31harbor/inbox/brief').then(function(r){return r.json();}).then(function(data){
      var card = document.getElementById('hb-inbox');
      if (!card) return;
      var emails = data.emails || data.recent || [];
      if (!emails.length) {
        card.innerHTML = '<div class="stat"><span class="label">No emails yet</span></div>';
        return;
      }
      var html = '';
      var groups = {};
      emails.slice(0,15).forEach(function(e){
        var addr = Array.isArray(e.to) ? (e.to[0] || 'unknown') : (e.to || 'unknown');
        if (!groups[addr]) groups[addr] = [];
        groups[addr].push(e);
      });
      var count = 0;
      Object.keys(groups).forEach(function(addr){
        html += '<div class="stat" style="border-bottom:1px solid #2a2a3a;padding:0.3rem 0;">';
        html += '<span class="label" style="font-size:0.75rem;color:#60a5fa;">' + addr + '</span>';
        html += '<span class="value badge badge-info">' + groups[addr].length + '</span></div>';
        groups[addr].forEach(function(m){
          count++;
          if (count > 8) return;
          html += '<div class="stat" style="padding:0.15rem 0 0.15rem 0.4rem;font-size:0.7rem;">';
          html += '<span class="label">' + (m.from||'').substring(0,25) + '</span>';
          html += '<span class="value" style="color:#a0a0b0;">' + (m.subject||'').substring(0,20) + '</span></div>';
        });
      });
      if (!html) html = '<div class="stat"><span class="label">No emails yet</span></div>';
      card.innerHTML = html;
    }).catch(function(){
      var e = document.getElementById('hb-inbox');
      if (e) e.innerHTML = '<div class="stat"><span class="label">Inbox unavailable</span></div>';
    });
  }
  loadHbInbox();
  setInterval(loadHbInbox, 15000);

  // XMRT DAO Health — dynamic data from Supabase
  function loadDaoHealth() {
    apiFetch('/api/dao/health', { signal: AbortSignal.timeout(25000) })
      .then(function(r){return r.json();})
      .then(function(d){
        var statusEl = document.getElementById('dao-health-status');
        var fnEl = document.getElementById('dao-fn-count');
        var agentEl = document.getElementById('dao-agent-count');
        var taskEl = document.getElementById('dao-task-count');
        var gossipEl = document.getElementById('dao-gossip-status');
        var scoreEl = document.getElementById('dao-health-score');

        // The /api/dao/health endpoint returns: { health: <system-health>, status: <system-status> }
        // Each of those has its own nested structure: system-health returns { health: { overall_health: {...} } }
        // and system-status returns { status: { overall_status: '...', components: {...} } }.
        // The wrapper endpoint preserves those keys, so we end up with d.health.health.overall_health
        // and d.status.status.components. Tolerant code below handles both nesting depths.
        var h = (d.health && d.health.overall_health) ? d.health
             : (d.health && d.health.health)        ? d.health.health
             : null;
        var s = (d.status && d.status.components) ? d.status
             : (d.status && d.status.status)      ? d.status.status
             : null;
        if (!h && !s) {
          if (statusEl) statusEl.textContent = 'unavailable';
        }

        if (h && h.overall_health) {
          var score = h.overall_health.score || 0;
          var status = h.overall_health.status || 'unknown';
          var badgeClass = score >= 80 ? 'badge-ok' : score >= 50 ? 'badge-warn' : 'badge-err';
          if (statusEl) statusEl.innerHTML = '<span class="badge ' + badgeClass + '">' + status.toUpperCase() + ' (' + score + '/100)</span>';
          if (scoreEl) scoreEl.textContent = score + ' / 100 (' + status + ')';
        } else if (s && (s.overall_status || s.health_score !== undefined)) {
          var score2 = s.health_score || 0;
          var status2 = s.overall_status || 'unknown';
          var badgeClass2 = score2 >= 80 ? 'badge-ok' : score2 >= 50 ? 'badge-warn' : 'badge-err';
          if (statusEl) statusEl.innerHTML = '<span class="badge ' + badgeClass2 + '">' + status2.toUpperCase() + ' (' + score2 + '/100)</span>';
          if (scoreEl) scoreEl.textContent = score2 + ' / 100 (' + status2 + ')';
        }

        if (h && h.components) {
          if (fnEl && h.components.edge_functions && h.components.edge_functions.deployed) {
            fnEl.textContent = h.components.edge_functions.deployed + ' deployed';
          } else if (fnEl && s && s.components && s.components.edge_functions) {
            fnEl.textContent = (s.components.edge_functions.total_calls_24h || 0) + ' calls / 24h';
          }
          if (agentEl && h.components.agents) {
            var agents = h.components.agents;
            var total = (agents.IDLE || 0) + (agents.BUSY || 0) + (agents.OFFLINE || 0);
            agentEl.textContent = total + ' (' + (agents.BUSY || 0) + ' busy)';
          } else if (agentEl && s && s.components && s.components.agents && s.components.agents.stats) {
            var a2 = s.components.agents.stats;
            agentEl.textContent = (a2.total || 0) + ' (' + (a2.busy || 0) + ' busy)';
          }
          if (taskEl && s && s.components && s.components.tasks && s.components.tasks.stats) {
            var t = s.components.tasks.stats;
            taskEl.textContent = (t.total || 0) + ' (' + (t.completed || 0) + ' done)';
          } else if (taskEl && h.components.tasks) {
            var tt = h.components.tasks;
            taskEl.textContent = (tt.total || 0) + ' (' + (tt.COMPLETED || 0) + ' done)';
          }
        }

        // Render supervisor service statuses from d.services
        var svcEl = document.getElementById('dao-service-status');
        if (svcEl && d.services && typeof d.services === 'object') {
          var keys = Object.keys(d.services);
          if (keys.length === 0) {
            svcEl.innerHTML = '<span class="badge badge-warn">no services</span>';
          } else {
            var running = 0, down = 0;
            keys.forEach(function(k){
              if (d.services[k].uptimeSec > 0) running++; else down++;
            });
            var badgeClass = down === 0 ? 'badge-ok' : (running > 0 ? 'badge-warn' : 'badge-err');
            svcEl.innerHTML = '<span class="badge ' + badgeClass + '">' + running + ' up / ' + (running + down) + ' total</span>';
            // Also populate a small hover tooltip with individual service statuses
            svcEl.title = keys.map(function(k){
              var s = d.services[k];
              var uptime = s.uptimeSec > 0 ? Math.floor(s.uptimeSec / 60) + 'm' : 'down';
              return k + ' (pid ' + (s.childPid || '-') + ', ' + uptime + ', restarts: ' + s.restartCount + ')';
            }).join(' | ');
          }
        } else if (svcEl) {
          svcEl.textContent = 'unavailable';
        }

        // Check gossip hub separately
        apiFetch('/api/dao/gossip?topic=fleet-broadcast&limit=1', { signal: AbortSignal.timeout(25000) })
          .then(function(r){return r.json();})
          .then(function(g){
            if (gossipEl) {
              if (g.success && g.messages && g.messages.length > 0) {
                var lastMsg = g.messages[0];
                var minsAgo = Math.round((Date.now() - new Date(lastMsg.timestamp).getTime()) / 60000);
                gossipEl.innerHTML = '<span class="badge badge-ok">' + (minsAgo < 5 ? 'active' : minsAgo + 'm ago') + '</span>';
              } else {
                gossipEl.innerHTML = '<span class="badge badge-warn">quiet</span>';
              }
            }
          })
          .catch(function(){
            if (gossipEl) gossipEl.innerHTML = '<span class="badge badge-err">offline</span>';
          });
      })
      .catch(function(){
        var statusEl = document.getElementById('dao-health-status');
        if (statusEl) statusEl.textContent = 'offline';
      });
  }
  loadDaoHealth();
  setInterval(loadDaoHealth, 30000);

  // GitHub Activity — dynamic data from GitHub API
  function loadGithubActivity() {
    apiFetch('/api/dao/github', { signal: AbortSignal.timeout(25000) })
      .then(function(r){return r.json();})
      .then(function(d){
        var repoEl = document.getElementById('gh-repo-count');
        var commitEl = document.getElementById('gh-last-commit');
        var recentEl = document.getElementById('gh-recent-commits');

        if (d.total_repos) {
          if (repoEl) repoEl.textContent = d.total_repos + ' repos';
        }

        if (d.recent_commits && d.recent_commits.length > 0) {
          var last = d.recent_commits[0];
          var NL = String.fromCharCode(10);
          var lastMsg = (last.commit && last.commit.message) ? last.commit.message.split(NL)[0].slice(0, 35) : 'recent commit';
          var lastWhen = new Date(last.commit.author.date).toLocaleDateString();
          var lastRepo = last._repo ? ' [' + last._repo + ']' : '';
          if (commitEl) commitEl.textContent = lastMsg + lastRepo + ' (' + lastWhen + ')';

          // Show last 5 commits across all repos with repo tag
          if (recentEl) {
            recentEl.innerHTML = d.recent_commits.slice(0,5).map(function(c){
              var m = (c.commit && c.commit.message) ? c.commit.message.split(NL)[0].slice(0, 28) : '?';
              var dd = new Date(c.commit.author.date).toLocaleDateString();
              var repo = c._repo ? '<span style="color:#4ade80;">' + c._repo + '</span> ' : '';
              return '<div style="font-size:0.65rem;color:#a0a0b0;margin:2px 0;">' + repo + m + ' <span style="color:#6b6b80;">(' + dd + ')</span></div>';
            }).join('');
          }
        }
      })
      .catch(function(){
        var repoEl = document.getElementById('gh-repo-count');
        if (repoEl) repoEl.textContent = 'unavailable';
      });
  }
  loadGithubActivity();
  setInterval(loadGithubActivity, 60000);

  // PFP Campaign — live stats
  function loadPfpCampaign() {
    apiFetch('/api/campaign/pfp', { signal: AbortSignal.timeout(25000) })
      .then(function(r){return r.json();})
      .then(function(d){
        if (!d.success) return;
        var el = function(id){return document.getElementById(id);};
        if (el('pfp-pool')) el('pfp-pool').textContent = d.poolSize;
        if (el('pfp-sent-today')) el('pfp-sent-today').textContent = d.sentToday;
        if (el('pfp-sent-total')) el('pfp-sent-total').textContent = d.totalSent;
        if (el('pfp-fresh')) el('pfp-fresh').textContent = d.freshAvailable;
        if (el('pfp-last-run')) el('pfp-last-run').textContent = d.campaignLastRun;
      });
  }
  loadPfpCampaign();
  setInterval(loadPfpCampaign, 30000);

  // 31 Harbor Campaign — live stats
  function loadHarborCampaign() {
    apiFetch('/api/campaign/31harbor', { signal: AbortSignal.timeout(25000) })
      .then(function(r){return r.json();})
      .then(function(d){
        if (!d.success) return;
        var el = function(id){return document.getElementById(id);};
        if (el('harbor-pool')) el('harbor-pool').textContent = d.harborPoolSize;
        if (el('harbor-sent-today')) el('harbor-sent-today').textContent = d.harborSentToday;
        if (el('harbor-sent-total')) el('harbor-sent-total').textContent = d.harborSentTotal;
        if (el('harbor-fresh')) el('harbor-fresh').textContent = d.harborFresh;
        if (el('harbor-last-run')) el('harbor-last-run').textContent = d.harborLastRun;
      });
  }
  loadHarborCampaign();
  setInterval(loadHarborCampaign, 30000);

  // PFP Leads — live from pfp_leads table via local-sb
  function loadPfpLeads() {
    apiFetch('/api/leads/pfp', { signal: AbortSignal.timeout(25000) })
      .then(function(r){return r.json();})
      .then(function(d){
        if (!d.success) return;
        var el = function(id){return document.getElementById(id);};
        if (el('pfp-leads-total')) el('pfp-leads-total').textContent = d.total;
        if (el('pfp-leads-by-status')) {
          var parts = [];
          for (var k in d.byStatus) parts.push(k + ':' + d.byStatus[k]);
          el('pfp-leads-by-status').textContent = parts.join(' · ');
        }
        if (el('pfp-leads-by-source')) {
          var parts = [];
          for (var k in d.bySource) parts.push(k + ':' + d.bySource[k]);
          el('pfp-leads-by-source').textContent = parts.join(' · ');
        }
        if (el('pfp-leads-hot')) el('pfp-leads-hot').textContent = d.highRated.length;
        if (el('pfp-leads-newest') && d.newest) {
          var n = d.newest;
          el('pfp-leads-newest').textContent = (n.contact_name || '?') + ' — ' + (n.contact_email || '') + ' [' + (n.source || '?') + ']';
        }
      });
  }
  loadPfpLeads();
  setInterval(loadPfpLeads, 30000);

  function renderFunctions() {
    const search = document.getElementById('search').value.toLowerCase();
    const methodFilter = document.getElementById('methodFilter').value;
    const typeFilter = document.getElementById('typeFilter').value;

    let filtered = functions.filter(f => {
      if (search && !f.name.toLowerCase().includes(search) && !f.desc.toLowerCase().includes(search)) return false;
      if (methodFilter && !f.methods.includes(methodFilter)) return false;
      if (typeFilter === 'simple' && f.type !== 'simple endpoint') return false;
      if (typeFilter === 'workflow' && f.type !== 'multi-action workflow') return false;
      return true;
    });

    filtered.sort((a, b) => {
      let va = (a[sortKey] || '').toString().toLowerCase();
      let vb = (b[sortKey] || '').toString().toLowerCase();
      return va < vb ? -sortDir : va > vb ? sortDir : 0;
    });

    document.getElementById('resultCount').textContent = filtered.length + ' shown';

    document.getElementById('fnBody').innerHTML = filtered.map(f => {
      const methods = (f.methods || ['POST']).map(m =>
        '<span class="fn-method method-' + m + '">' + m + '</span>'
      ).join('');
      const typeTag = f.type === 'multi-action workflow'
        ? '<span class="tag-workflow">workflow</span>'
        : '<span class="tag-simple">simple</span>';
      
      // Estimate timeout based on function type and name
      var timeout = '10s';
      var name = (f.name || '').toLowerCase();
      if (name.includes('curiosity') || name.includes('explore')) timeout = '45s';
      else if (name.includes('search') || name.includes('exa')) timeout = '20s';
      else if (name.includes('research') || name.includes('intelligence')) timeout = '30s';
      else if (name.includes('python') || name.includes('jupyter')) timeout = '60s';
      else if (name.includes('browse') || name.includes('scrape') || name.includes('playwright')) timeout = '30s';
      else if (name.includes('chat') || name.includes('ai-')) timeout = '25s';
      else if (name.includes('booking') || name.includes('quote') || name.includes('template') || name.includes('pfp')) timeout = '30s';
      else if (name.includes('generate') || name.includes('stripe')) timeout = '15s';
      else if (f.type === 'multi-action workflow') timeout = '30s';
      
      const timeoutBadge = parseInt(timeout) > 20
        ? '<span class="badge badge-warn" style="font-size:0.65rem;">' + timeout + '</span>'
        : '<span class="badge badge-ok" style="font-size:0.65rem;">' + timeout + '</span>';
      
      const inputs = (f.inputs && f.inputs.length)
        ? f.inputs.map(i => '<span style="color:#fbbf24">' + i + '</span>').join(', ')
        : '<span style="color:#4a4a5a">(see source)</span>';
      const endpoint = SUPABASE_URL + '/functions/v1/' + f.name;
      
      return '<tr>' +
        '<td class="fn-name">' + f.name + '</td>' +
        '<td class="fn-method-cell">' + methods + ' ' + timeoutBadge + '</td>' +
        '<td>' + typeTag + '</td>' +
        '<td class="fn-desc">' + (f.desc || '') + '</td>' +
        '<td class="endpoint-url"><span>' + endpoint + '</span></td>' +
        '</tr>';
    }).join('');
  }

  function filterFunctions() { renderFunctions(); }
  function sortBy(key) {
    if (sortKey === key) sortDir *= -1;
    else { sortKey = key; sortDir = 1; }
    renderFunctions();
  }
  
  // ── Fleet Chat Attachment Support ──
  // Track pending file to attach to next message
  var pendingFile = null;
  function attachFleetFile(input) {
    var file = input.files[0];
    if (!file) return;
    pendingFile = file;
    document.getElementById('fleet-chat-attach-status').textContent = '📎 ' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB) — will attach with next message';
  }

  function sendFleetChat() {
    // Get or prompt for agent name (persisted in localStorage)
    var nameInput = document.getElementById('fleet-chat-name');
    var savedName = localStorage.getItem('fleet-chat-user-name');
    if (savedName && !nameInput.value) {
      nameInput.value = savedName;
    } else if (nameInput.value) {
      localStorage.setItem('fleet-chat-user-name', nameInput.value);
    }
    var agent = nameInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'user';
    // Prevent impersonating fleet agents — if name matches a reserved agent, suffix with -user
    var reservedAgents = ['vex','eliza','hermes','alice','trib','arch','builder','sovereign','trustgraph','dao','global-communicator','laura','community-manager','project-manager','devrel','liaison'];
    if (reservedAgents.indexOf(agent) !== -1) {
      agent = agent + '-user';
      nameInput.value = agent;
    }
    var displayName = nameInput.value.trim() || agent;
    var input = document.getElementById('fleet-chat-input');
    var msgs = document.getElementById('fleet-chat-msgs');
    var msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    var tempId = 'opt-' + Date.now();
    msgs.innerHTML += '<div style="margin-bottom:6px;text-align:right;" data-id="' + tempId + '"><span style="color:#8b8ba0;font-size:10px;display:block;">' + displayName.toUpperCase() + '</span><span style="background:#1a3a5c;color:#e0e0f0;padding:6px 10px;border-radius:6px;display:inline-block;font-size:13px;">' + msg.replace(/</g,'&lt;') + '</span></div>';
    document.getElementById('fleet-chat-status').textContent = '● sending...';
    document.getElementById('fleet-chat-status').style.color = '#fbbf24';
    msgs.scrollTop = msgs.scrollHeight;
    apiFetch('/api/fleet-chat/send', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent:agent,displayName:displayName,message:msg,channel:'all'})})
      .then(function(r){return r.json();})
      .then(function(d){
        document.getElementById('fleet-chat-status').textContent = '● connected';
        document.getElementById('fleet-chat-status').style.color = '#4ade80';
        // If there's a pending file, upload it as an attachment to this message
        if (pendingFile && d.message && d.message.id) {
          var file = pendingFile;
          pendingFile = null;
          document.getElementById('fleet-chat-attach-status').textContent = '📤 Uploading ' + file.name + '...';
          var reader = new FileReader();
          reader.onload = function(e) {
            var content = e.target.result;
            // For text files, send the content directly. For binary, send base64.
            var payload = {
              message_id: d.message.id,
              agent_id: agent,
              filename: file.name,
              file_type: file.type || 'application/octet-stream',
              content: content,
              content_preview: content.slice(0, 500),
            };
            apiFetch('/api/fleet-chat/attach', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify(payload),
            }).then(function(r){return r.json();}).then(function(ar){
              document.getElementById('fleet-chat-attach-status').textContent = '✅ Attached ' + file.name;
              fetchFleetMessages();
            }).catch(function(err){
              document.getElementById('fleet-chat-attach-status').textContent = '❌ Upload failed: ' + err.message;
            });
          };
          reader.readAsDataURL(file);
        }
        // Remove optimistic message, let poll re-add with real data-id
        var opt = msgs.querySelector('[data-id="' + tempId + '"]');
        if (opt) opt.remove();
        fetchFleetMessages();
      }).catch(function(e){
        document.getElementById('fleet-chat-status').textContent = '● error: ' + e.message;
        document.getElementById('fleet-chat-status').style.color = '#f87171';
      });
  }

  // Poll for new fleet messages
  var lastFleetTs = 0;
  function fetchFleetMessages() {
    var msgs = document.getElementById('fleet-chat-msgs');
    var url = '/api/fleet-chat/messages?limit=50';
    if (lastFleetTs > 0) url += '&since=' + lastFleetTs;
    apiFetch(url)
      .then(function(r){return r.json();})
      .then(function(d){
        if (d.messages && d.messages.length > 0) {
          for (var i = 0; i < d.messages.length; i++) {
            var m = d.messages[i];
            if (m.ts <= lastFleetTs) continue;
            var color = m.agent === 'vex' ? '#2a1a0a' : m.agent === 'eliza' ? '#1a3a2a' : '#2a1a3a';
            var label = m.agentLabel || m.agent;
            // Check if message already displayed
            var existing = msgs.querySelector('[data-id="' + m.id + '"]');
            if (existing) continue;
            var div = document.createElement('div');
            div.style.marginBottom = '6px';
            div.setAttribute('data-id', m.id);
            var msgHtml = '<span style="color:#8b8ba0;font-size:10px;display:block;">' + label + '</span><span class="fleet-msg-body" style="background:' + color + ';color:#e0e0f0;padding:6px 10px;border-radius:6px;display:inline-block;font-size:13px;max-width:100%;">' + renderMarkdown(m.message || '') + '</span>';
            // Check for attachments on this message
            if (m.id) {
              apiFetch('/api/fleet-chat/attachments/' + encodeURIComponent(m.id), { signal: AbortSignal.timeout(5000) })
                .then(function(r){return r.json();})
                .then(function(ad){
                  if (ad.attachments && ad.attachments.length > 0) {
                    var attHtml = '<div style="margin-top:4px;font-size:10px;">';
                    ad.attachments.forEach(function(a){
                      attHtml += '<span style="color:#a78bfa;cursor:pointer;" onclick="window.open(\'/api/fleet-chat/attachments/' + a.id + '/content\',\'_blank\')">📎 ' + a.filename + ' (' + (a.file_size / 1024).toFixed(1) + ' KB)</span> ';
                    });
                    attHtml += '</div>';
                    var attDiv = div.querySelector('.fleet-attachments');
                    if (!attDiv) {
                      attDiv = document.createElement('div');
                      attDiv.className = 'fleet-attachments';
                      div.appendChild(attDiv);
                    }
                    attDiv.innerHTML = attHtml;
                  }
                }).catch(function(){});
            }
            msgs.appendChild(div);
            lastFleetTs = Math.max(lastFleetTs, m.ts);
          }
          msgs.scrollTop = msgs.scrollHeight;
        }
        document.getElementById('fleet-chat-status').textContent = '● connected';
        document.getElementById('fleet-chat-status').style.color = '#4ade80';
      }).catch(function(e){
        document.getElementById('fleet-chat-status').textContent = '● polling error';
        document.getElementById('fleet-chat-status').style.color = '#f87171';
      });
  }

  // Markdown renderer is loaded from /static/markdown.js to keep the template literal escape-free.

  // ── Bulletin Board Functions ────────────────────────────────
  var boardData = { topics: [] };
  var boardCurrentTopic = null;
  var boardStatusFilter = "all"; // all, active, in-progress, completed, archived
  var boardLastPostCount = 0;
    var boardLoadSeq = 0;
    function loadBoard() {
      var seq = Date.now();
      boardLoadSeq = seq;
      apiFetch("/api/bulletin/topics", { signal: AbortSignal.timeout(25000) })
      .then(function(r){ return r.json(); })
      .then(function(d){
              if (seq !== boardLoadSeq) return; // stale
              var prevCount = boardData.topics ? boardData.topics.length : 0;
        var prevPosts = boardLastPostCount;
        boardData = d;
        renderBoardTopics();
        document.getElementById("board-status").textContent = "● loaded";
        document.getElementById("board-status").style.color = "#4ade80";
        var newCount = boardData.topics.length;
        var totalPosts = boardData.topics.reduce(function(sum, t) { return sum + (t.posts || []).length; }, 0);
        if (newCount !== prevCount || totalPosts !== prevPosts) {
          var ind = document.getElementById("board-updated-indicator");
          if (ind) { ind.style.display = "inline"; setTimeout(function(){ if(ind) ind.style.display = "none"; }, 10000); }
        }
        boardLastPostCount = totalPosts;
      })
      .catch(function(e){
        document.getElementById("board-status").textContent = "● error: " + e.message;
        document.getElementById("board-status").style.color = "#f87171";
      });
  }
  
  function setBoardFilter(filter) {
    boardStatusFilter = filter;
    // Update filter tab styling
    var filters = document.querySelectorAll('#board-filter-bar .board-filter');
    for (var i = 0; i < filters.length; i++) {
      var cls = filters[i].getAttribute('data-filter') === filter ? 'board-filter active' : 'board-filter';
      filters[i].className = cls;
    }
    renderBoardTopics();
  }
  
  function getStatusBadge(status) {
    var colors = {
      'active': 'background:#1a3a2a;color:#4ade80;',
      'in-progress': 'background:#3a2a1a;color:#fbbf24;',
      'completed': 'background:#1a2a3a;color:#60a5fa;',
      'archived': 'background:#2a2a2a;color:#6b6b80;'
    };
    var label = status === 'in-progress' ? 'in progress' : status;
    return '<span style="' + (colors[status] || colors.active) + 'padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;">' + label + '</span>';
  }
  
  function renderBoardTopics() {
    var list = document.getElementById('board-topics-list');
    var listFull = document.getElementById('board-topics-list-full');
    var filtered = boardData.topics;
    if (boardStatusFilter !== 'all') {
      filtered = filtered.filter(function(t) { return t.status === boardStatusFilter; });
    }
    if (!filtered || filtered.length === 0) {
      var emptyMsg = '<div style="color:#6b6b80;text-align:center;padding:20px 0;font-size:12px;">' +
        (boardStatusFilter !== 'all' ? 'No ' + boardStatusFilter + ' topics.' : 'No topics yet. Create one to start tracking progress.') +
        '</div>';
      if (list) list.innerHTML = emptyMsg;
      if (listFull) listFull.innerHTML = emptyMsg;
      return;
    }
    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      var t = filtered[i];
      var postCount = (t.posts || []).length;
      var lastPost = postCount > 0 ? t.posts[t.posts.length - 1] : null;
      var active = boardCurrentTopic && boardCurrentTopic.id === t.id ? ' active' : '';
      var pinIcon = t.pinned ? '<span style="color:#fbbf24;font-size:10px;">📌</span> ' : '';
      var assignBadge = t.assigned_agent ? '<span style="color:#60a5fa;font-size:9px;">@' + t.assigned_agent + '</span>' : '';
      html += '<div class="board-topic' + active + '" data-topic-id="' + t.id + '">';
      html += '<div class="board-topic-title">' + pinIcon + getStatusBadge(t.status) + ' ' + t.title.replace(/</g,'&lt;') + '</div>';
      html += '<div class="board-topic-meta">' + postCount + ' post' + (postCount !== 1 ? 's' : '') + ' \u2022 by ' + t.creator + ' \u2022 ' + (t.created_at || '').slice(0,10);
      if (assignBadge) html += ' \u2022 ' + assignBadge;
      if (lastPost) html += ' \u2022 Last: ' + lastPost.author + ' ' + timeAgo(lastPost.ts);
      html += '</div></div>';
    }
    if (list) list.innerHTML = html;
    if (listFull) listFull.innerHTML = html;
    
    // Attach click delegation for board topics (hero section)
    var topicsContainer = document.getElementById('board-topics-list');
    if (topicsContainer) {
      topicsContainer.onclick = function(e) {
        var target = e.target;
        while (target && target !== topicsContainer) {
          if (target.hasAttribute && target.hasAttribute('data-topic-id')) {
            openBoardTopic(target.getAttribute('data-topic-id'));
            return;
          }
          target = target.parentNode;
        }
      };
    }
    // Attach click delegation for board topics (full board)
    var topicsContainerFull = document.getElementById('board-topics-list-full');
    if (topicsContainerFull) {
      topicsContainerFull.onclick = function(e) {
        var target = e.target;
        while (target && target !== topicsContainerFull) {
          if (target.hasAttribute && target.hasAttribute('data-topic-id')) {
            openBoardTopic(target.getAttribute('data-topic-id'));
            return;
          }
          target = target.parentNode;
        }
      };
    }
  }
  
  function openBoardTopic(id) {
    boardCurrentTopic = null;
    for (var i = 0; i < boardData.topics.length; i++) {
      if (boardData.topics[i].id === id) {
        boardCurrentTopic = boardData.topics[i];
        break;
      }
    }
    if (!boardCurrentTopic) return;
    document.getElementById('board-topics-list').style.display = 'none';
    document.getElementById('board-topic-posts').style.display = 'block';
    document.getElementById('board-current-topic-title').textContent = boardCurrentTopic.title;
    
    // Update status badge in detail view
    document.getElementById('board-current-topic-status').innerHTML = getStatusBadge(boardCurrentTopic.status);
    document.getElementById('board-status-select').value = boardCurrentTopic.status;
    
    // Update assignment
    var assignEl = document.getElementById('board-current-topic-assignment');
    assignEl.textContent = boardCurrentTopic.assigned_agent ? '@' + boardCurrentTopic.assigned_agent : '';
    
    // Update pin button
    var pinBtn = document.getElementById('board-pin-btn');
    pinBtn.textContent = boardCurrentTopic.pinned ? 'Unpin' : 'Pin';
    pinBtn.style.borderColor = boardCurrentTopic.pinned ? '#fbbf24' : '#3a3a5a';
    
    renderBoardPosts();
  }
  
  function closeBoardTopic() {
    boardCurrentTopic = null;
    document.getElementById('board-topics-list').style.display = '';
    document.getElementById('board-topic-posts').style.display = 'none';
  }
  
  function renderBoardPosts() {
    var list = document.getElementById('board-posts-list');
    if (!boardCurrentTopic || !boardCurrentTopic.posts || boardCurrentTopic.posts.length === 0) {
      list.innerHTML = '<div style="color:#6b6b80;text-align:center;padding:15px 0;font-size:12px;">No posts yet. Be the first!</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < boardCurrentTopic.posts.length; i++) {
      var p = boardCurrentTopic.posts[i];
      var agentClass = 'board-agent-' + (p.agent || 'vex').toLowerCase();
      html += '<div class="board-post">';
      html += '<div class="board-post-header"><span class="board-agent-badge ' + agentClass + '">' + (p.agent || 'agent').toUpperCase() + '</span> ' + timeAgo(p.ts);
      html += '<span style="float:right;font-size:9px;color:#6b6b80;cursor:pointer;" onclick="deleteBoardPost(' + "'" + p.id + "'" + ')" title="Delete post">✕</span>';
      html += '</div>';
      html += '<div class="board-post-body">' + renderMarkdown(p.message) + '</div>';
      html += '</div>';
    }
    list.innerHTML = html;
    list.scrollTop = list.scrollHeight;
  }
  
  function createBoardTopic() {
    var input = document.getElementById('board-new-topic-input');
    var title = input.value.trim();
    if (!title) return;
    input.value = '';
    var agent = getBoardAgent();
    var statusSelect = document.getElementById('board-new-status');
    var status = statusSelect ? statusSelect.value : 'active';
    var assignInput = document.getElementById('board-new-assignment');
    var assigned_agent = assignInput ? assignInput.value.trim() || null : null;
    var pinnedCheck = document.getElementById('board-new-pinned');
    var pinned = pinnedCheck ? pinnedCheck.checked : false;
    apiFetch('/api/bulletin/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, creator: agent, status: status, assigned_agent: assigned_agent, pinned: pinned })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          if (assignInput) assignInput.value = '';
          if (pinnedCheck) pinnedCheck.checked = false;
          if (statusSelect) statusSelect.value = 'active';
          switchBoardView('topics');
          loadBoard();
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
        document.getElementById('board-status').style.color = '#f87171';
      });
  }
  
  function changeTopicStatus(newStatus) {
    if (!boardCurrentTopic) return;
    apiFetch('/api/bulletin/topics/' + boardCurrentTopic.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          boardCurrentTopic.status = newStatus;
          document.getElementById('board-current-topic-status').innerHTML = getStatusBadge(newStatus);
          loadBoard();
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
      });
  }

  // Rename current topic. Works for both humans (prompt) and agents (PATCH /api/bulletin/topics/:id with {title}).
  // The endpoint accepts arbitrary field updates so a single PATCH can set title + status + assigned_agent + pinned in one call.
  function renameBoardTopic() {
    if (!boardCurrentTopic) return;
    var current = boardCurrentTopic.title || '';
    var next = prompt('Rename topic:', current);
    if (next === null) return;
    next = next.trim();
    if (!next) { alert('Title cannot be empty.'); return; }
    if (next === current) return;
    apiFetch('/api/bulletin/topics/' + boardCurrentTopic.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: next })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          boardCurrentTopic.title = d.topic.title;
          document.getElementById('board-current-topic-title').textContent = d.topic.title;
          // Also update the in-memory list so the sidebar shows the new title after re-render
          for (var i = 0; i < boardData.topics.length; i++) {
            if (boardData.topics[i].id === d.topic.id) boardData.topics[i].title = d.topic.title;
          }
          loadBoard();
          document.getElementById('board-status').textContent = '\u2713 renamed';
          document.getElementById('board-status').style.color = '#4ade80';
        } else {
          document.getElementById('board-status').textContent = '\u2716 rename failed: ' + (d.error || 'unknown');
          document.getElementById('board-status').style.color = '#f87171';
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
        document.getElementById('board-status').style.color = '#f87171';
      });
  }

  function togglePinTopic() {
    if (!boardCurrentTopic) return;
    var newPinned = !boardCurrentTopic.pinned;
    apiFetch('/api/bulletin/topics/' + boardCurrentTopic.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: newPinned })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          boardCurrentTopic.pinned = newPinned;
          var pinBtn = document.getElementById('board-pin-btn');
          pinBtn.textContent = newPinned ? 'Unpin' : 'Pin';
          pinBtn.style.borderColor = newPinned ? '#fbbf24' : '#3a3a5a';
          loadBoard();
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
      });
  }
  
  function sendBoardPost() {
    if (!boardCurrentTopic) return;
    var input = document.getElementById('board-post-input');
    var msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    var agent = getBoardAgent();
    apiFetch('/api/bulletin/topics/' + boardCurrentTopic.id + '/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: agent, message: msg, agent: agent })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          loadBoard();
          // Re-open the current topic after reload
          setTimeout(function() { openBoardTopic(boardCurrentTopic.id); }, 100);
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
        document.getElementById('board-status').style.color = '#f87171';
      });
  }
  
  function deleteBoardPost(postId) {
    if (!boardCurrentTopic || !confirm('Delete this post?')) return;
    apiFetch('/api/bulletin/topics/' + boardCurrentTopic.id + '/posts/' + postId, {
      method: 'DELETE'
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          loadBoard();
          setTimeout(function() { openBoardTopic(boardCurrentTopic.id); }, 100);
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
      });
  }
  
  function switchBoardView(view) {
    document.getElementById('tab-topics').className = 'board-tab' + (view === 'topics' ? ' active' : '');
    document.getElementById('tab-newtopic').className = 'board-tab' + (view === 'new' ? ' active' : '');
    document.getElementById('board-topics-view').style.display = view === 'topics' ? '' : 'none';
    document.getElementById('board-new-topic-view').style.display = view === 'new' ? '' : 'none';
    if (view === 'topics') closeBoardTopic();
  }
  
  function deleteBoardTopic() {
    if (!boardCurrentTopic || !confirm('Delete this resolution permanently?')) return;
    apiFetch('/api/bulletin/topics/' + boardCurrentTopic.id, {
      method: 'DELETE'
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          boardCurrentTopic = null;
          switchBoardView('topics');
          loadBoard();
        }
      })
      .catch(function(e) {
        document.getElementById('board-status').textContent = '\u2716 error: ' + e.message;
        document.getElementById('board-status').style.color = '#f87171';
      });
  }

  function getBoardAgent() {
    var nameInput = document.getElementById('fleet-chat-name');
    return (nameInput ? nameInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') : 'vex') || 'vex';
  }
  
  function timeAgo(ts) {
    var diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  // Copy mining script to clipboard
  function copyMiningScript() {
    var el = document.getElementById('mining-script');
    var text = el.textContent || el.innerText;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        var orig = el.style.background;
        el.style.background = '#1a3a2a';
        el.style.transition = 'background 0.3s';
        setTimeout(function(){ el.style.background = orig; }, 1000);
      }).catch(function(){});
    } else {
      // Fallback
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  // Load initial fleet messages + poll every 5 seconds
  setTimeout(fetchFleetMessages, 500);
  setInterval(fetchFleetMessages, 5000);

  // Load bulletin board
  setTimeout(loadBoard, 1000);
  setInterval(loadBoard, 30000);

  // Next campaign drop calculation — Costa Rica time (UTC-6)
  (function() {
    var now = new Date();
    var hour = now.getUTCHours() - 6; // CR offset
    if (hour < 0) hour += 24;
    var min = now.getMinutes();
    var schedule = [8, 10, 12, 14, 16, 18]; // 8:30am, 10:30am, 12:30pm, 2:30pm, 4:30pm, 6:30pm CR
    var next = schedule.find(function(h) { return h > hour || (h === hour && min < 30); });
    var label;
    if (next === undefined) {
      label = 'Tomorrow 8:30AM CR';
    } else {
      var ampm = next >= 12 ? 'PM' : 'AM';
      var h12 = next > 12 ? next - 12 : (next === 0 ? 12 : next);
      label = h12 + ':30 ' + ampm + ' CR';
    }
    var el = document.getElementById('next-drop');
    if (el) el.textContent = label;
  })();

  // Next 31 Harbor drop — Eastern Time (UTC-4/UTC-5)
  (function() {
    var now = new Date();
    var etOffset = (now.getTimezoneOffset() === 240 || now.getTimezoneOffset() === 300)
      ? now.getTimezoneOffset() : 240;
    var hour = (now.getUTCHours() - etOffset / 60 + 24) % 24;
    var min = now.getMinutes();
    var schedule = [7, 9, 11]; // 7:00, 9:00, 11:00 AM ET send slots
    var next = schedule.find(function(h) { return h > hour || (h === hour && min < 1); });
    var label;
    if (next === undefined) {
      label = 'Tomorrow 7:00AM ET';
    } else {
      var ampm = next >= 12 ? 'PM' : 'AM';
      var h12 = next > 12 ? next - 12 : (next === 0 ? 12 : next);
      label = h12 + ':00 ' + ampm + ' ET';
    }
    var el = document.getElementById('harbor-next-drop');
    if (el) el.textContent = label;
  })();
  
// Mesh Network Particle Animation
(function(){
  const canvas = document.getElementById('mesh-bg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];
  function resize() { W = canvas.width = innerWidth; H = canvas.height = innerHeight; }
  resize(); addEventListener('resize', resize);
  
  class Particle {
    constructor() {
      this.x = Math.random() * W; this.y = Math.random() * H;
      this.vx = (Math.random() - 0.5) * 0.4; this.vy = (Math.random() - 0.5) * 0.4;
      this.r = Math.random() * 1.5 + 1; this.life = Math.random() * 100;
    }
    update() {
      this.x += this.vx; this.y += this.vy; this.life++;
      if (this.x < 0 || this.x > W) this.vx *= -1;
      if (this.y < 0 || this.y > H) this.vy *= -1;
    }
    draw() {
      const pulse = 0.5 + 0.5 * Math.sin(this.life * 0.03);
      ctx.beginPath(); ctx.arc(this.x, this.y, this.r * pulse, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,102,0,' + (0.4 * pulse) + ')'; ctx.fill();
    }
  }
  for (let i = 0; i < 60; i++) particles.push(new Particle());
  
  let mouse = { x: W / 2, y: H / 2 };
  document.addEventListener('mousemove', function(e) { mouse.x = e.clientX; mouse.y = e.clientY; });
  
  function animate() {
    ctx.fillStyle = 'rgba(10,10,15,0.15)'; ctx.fillRect(0, 0, W, H);
    particles.forEach(function(p) { p.update(); p.draw(); });
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x, dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 150) {
          ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y); ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = 'rgba(255,102,0,' + (0.12 * (1 - dist / 150)) + ')'; ctx.lineWidth = 0.6; ctx.stroke();
        }
      }
      const dx = particles[i].x - mouse.x, dy = particles[i].y - mouse.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 200) {
        ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y); ctx.lineTo(mouse.x, mouse.y);
        ctx.strokeStyle = 'rgba(255,102,0,' + (0.15 * (1 - dist / 200)) + ')'; ctx.lineWidth = 0.8; ctx.stroke();
      }
    }
    requestAnimationFrame(animate);
  }
  animate();
})();

// ── Obsidian Knowledge Graph ──────────────────────────────────────
(function() {
  const canvas = document.getElementById('obsidian-graph-canvas');
  if (!canvas) return;
  const tooltip = document.getElementById('graph-tooltip');
  const nodeCountEl = document.getElementById('graph-node-count');

  let nodes = [], edges = [];
  let simNodes = [];
  let selectedNode = null;
  let hoveredNode = null;
  let trustScores = {}; // agent name -> { score, band, color }
  let focusNode = null; // camera orbits around this
  let focusAnim = 0; // 0..1 transition
  let focusFrom = { x: 0, y: 0, z: 1 };
  let W, H;

  // Camera state
  let camX = 0, camY = 0, camZ = 0.3, camRot = 0; // 30% default — see the whole galaxy unexploded
  let dragCam = false;
  let dragCamStart = { x: 0, y: 0, cx: 0, cy: 0 };
  let dragNode = null;
  let dragOff = { x: 0, y: 0 };
  let camZTarget = 0.3; // for smooth zoom transitions

  // Effect toggles
  let effectExplode = false; // OFF by default — start unexploded, click Explode for galaxy view
  let effectOrbit = true;    // on by default — orbital physics
  let effectLabels = true;   // on by default
  let effectTrust = true;    // on by default — show trust score arcs on agent nodes
  let effectCluster = false; // off by default — group nodes by category
  let effectRadial = false;  // off by default — concentric circular layout like cuttlefishclaws.com
  let effectFilter = false;  // off by default — hide low-trust / unconnected nodes
  let effectDb = true;       // on by default — show/hide DB table nodes

  window.toggleGraphEffect = function(name) {
    const btn = document.getElementById('b-' + name);
    let newState;
    if (name === 'explode') { effectExplode = !effectExplode; newState = effectExplode;
      // Zoom to 100% when exploded, back to 30% when unexploded
      if (effectExplode) { camZ = 1.0; } else { camZ = 0.3; }
    }
    else if (name === 'orbit') { effectOrbit = !effectOrbit; newState = effectOrbit; }
    else if (name === 'labels') { effectLabels = !effectLabels; newState = effectLabels; }
    else if (name === 'trust') { effectTrust = !effectTrust; newState = effectTrust; }
    else if (name === 'cluster') { effectCluster = !effectCluster; newState = effectCluster; }
    else if (name === 'radial') { effectRadial = !effectRadial; newState = effectRadial; }
    else if (name === 'filter') { effectFilter = !effectFilter; newState = effectFilter; }
    else if (name === 'db') { effectDb = !effectDb; newState = effectDb; }
    if (btn) {
      btn.classList.toggle('on', newState);
      var isDb = name === 'db';
      btn.style.background = newState ? (isDb ? 'rgba(52,211,153,0.08)' : 'rgba(167,139,250,0.08)') : 'rgba(107,107,128,0.04)';
      btn.style.borderColor = newState ? (isDb ? 'rgba(52,211,153,0.22)' : 'rgba(167,139,250,0.22)') : 'rgba(107,107,128,0.12)';
      btn.style.color = newState ? (isDb ? 'rgba(52,211,153,0.65)' : 'rgba(167,139,250,0.65)') : 'rgba(107,107,128,0.4)';
    }
  };

  const CAT_COLORS = {
    spa: '#4ade80', backend: '#60a5fa', agent: '#a78bfa',
    infra: '#fbbf24', system: '#ff6b35', email: '#f87171',
    db: '#34d399', mining: '#818cf8', cert: '#f472b6',
    cron: '#2dd4bf', 'edge-function': '#67e8f9', endpoint: '#93c5fd',
    github: '#c084fc', tunnel: '#fcd34d', campaign: '#fdba74',
    other: '#6b6b80'
  };

  const TRUST_BAND_COLORS = {
    Trusted: '#4ade80', Standard: '#60a5fa', Monitored: '#fbbf24',
    Cautious: '#f87171', Suspended: '#6b6b80'
  };

  // ── Coordinate transforms ──
  function screenToWorld(sx, sy) {
    return { x: (sx - W/2) / camZ + camX, y: (sy - H/2) / camZ + camY };
  }
  function worldToScreen(wx, wy) {
    return { x: (wx - camX) * camZ + W/2, y: (wy - camY) * camZ + H/2 };
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    W = rect.width;
    H = rect.height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }

  function initSimulation() {
    const cx = 0, cy = 0;
    simNodes = nodes.map((n, i) => ({
      ...n,
      x: cx, y: cy,
      vx: 0, vy: 0,
      r: n.category === 'agent' ? 12 : n.id === 'Relay Server' || n.id === 'app' || n.id === 'public' || n.id === 'app Schema' || n.id === 'public Schema' ? 15 : n.category === 'spa' || n.category === 'backend' ? 8 : 4
    }));
    // Place stars at anchors
    var starPos = { 'Relay Server':[0,0], 'app':[-200,0], 'public':[200,0], 'app Schema':[-200,0], 'public Schema':[200,0] };
    simNodes.forEach(function(n){
      var p = starPos[n.id];
      if (p) { n.x = p[0]; n.y = p[1]; }
    });
    // Place agents at fixed positions
    var agentPos = {'Vex Agent':[-300,-200],'Alice Agent':[300,-200],'Hermes Agent':[-300,200],'Eliza Agent':[300,200],'CuttlefishClaws Agents':[0,-300],'Executive Persona Agents':[0,300],'Fleet Chat':[-400,0],'Isabella Rodriguez':[400,0],'Trib':[-200,-300],'Arch':[200,-300],'Kimi-AI-Agent':[-200,300],'GlobalCommunicator':[200,300],'TrustGraph':[-400,-200],'Sovereign Agent':[400,-200],'Builder Agent':[-400,200],'DAO Gov':[400,200]};
    simNodes.forEach(function(n){
      var p = agentPos[n.id];
      if (p) { n.x = p[0]; n.y = p[1]; }
    });
  }

  function getNodeAtScreen(sx, sy) {
    const w = screenToWorld(sx, sy);
    for (let i = simNodes.length - 1; i >= 0; i--) {
      const n = simNodes[i];
      const dx = w.x - n.x, dy = w.y - n.y;
      const hitR = (n.r + 8) / camZ;
      if (dx * dx + dy * dy < hitR * hitR) return n;
    }
    return null;
  }

  function focusOnNode(n) {
    if (!n) return;
    focusNode = n;
    focusFrom = { x: camX, y: camY, z: camZ };
    focusAnim = 0.001; // start transition
    // Don't animate zoom — preserve user's zoom level, only pan
  }

  function draw() {
    const ctx = canvas.getContext('2d');
    if (!W || !H || isNaN(W) || isNaN(H)) { requestAnimationFrame(draw); return; }
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ── Build lookup maps once per frame (avoids O(n²) simNodes.find()) ──
    var nodeById = {};
    for (var ni = 0; ni < simNodes.length; ni++) {
      var sn = simNodes[ni];
      nodeById[sn.id] = sn;
    }

    // ── Focus animation (PAN ONLY — preserves user zoom) ──
    if (focusNode && focusAnim < 1) {
      focusAnim = Math.min(1, focusAnim + 0.02);
      const t = focusAnim;
      // Smoothstep
      const s = t * t * (3 - 2 * t);
      camX = focusFrom.x + (focusNode.x - focusFrom.x) * s;
      camY = focusFrom.y + (focusNode.y - focusFrom.y) * s;
      // ZOOM PRESERVED — user controls zoom, not focus animation
    } else if (focusNode && focusAnim >= 1) {
      // Keep tracking the focused node so it doesn't drift away
      camX = focusNode.x;
      camY = focusNode.y;
    }

    // ── Galaxy Orbital Physics ──
    // Build parent-child hierarchy once
    if (!window._orbitHierarchy) {
      window._orbitHierarchy = { parents: {}, levels: {}, childCounts: {} };
      var oh = window._orbitHierarchy;
      // Level 0: Stars (fixed anchors)
      oh.levels['Relay Server'] = 0; oh.parents['Relay Server'] = null;
      oh.levels['app'] = 0; oh.parents['app'] = null;
      oh.levels['public'] = 0; oh.parents['public'] = null;
      oh.levels['app Schema'] = 0; oh.parents['app Schema'] = null;
      oh.levels['public Schema'] = 0; oh.parents['public Schema'] = null;
      // Level 1: Planets — orbit Relay Server
      var planetNames = ['CashDApp','CuttlefishClaws','31Harbor','HottieHouse','Suite Dashboard','Fleet Chat','Mesh Network','Ollama','Local Supabase','Postgres Database','Cloudflare Workers','Cron Engine'];
      planetNames.forEach(function(p){ oh.levels[p]=1; oh.parents[p]='Relay Server'; });
      // Level 2: Moons — children of planets or stars
      edges.forEach(function(e){
        var s=e.source, t=e.target;
        if (oh.levels[s]===1 && !oh.levels[t] && !isAgent(t)) { oh.levels[t]=2; oh.parents[t]=s; }
        if (oh.levels[t]===1 && !oh.levels[s] && !isAgent(s)) { oh.levels[s]=2; oh.parents[s]=t; }
        if (oh.levels[s]===0 && !oh.levels[t] && !isAgent(t) && t.indexOf('.')!==-1) { oh.levels[t]=2; oh.parents[t]=s; }
        if (oh.levels[t]===0 && !oh.levels[s] && !isAgent(s) && s.indexOf('.')!==-1) { oh.levels[s]=2; oh.parents[s]=t; }
        if (s==='Relay Server' && !oh.levels[t] && !isAgent(t)) { oh.levels[t]=2; oh.parents[t]='Relay Server'; }
        if (t==='Relay Server' && !oh.levels[s] && !isAgent(s)) { oh.levels[s]=2; oh.parents[s]='Relay Server'; }
      });
      // Catch-all: unassigned → moon of Relay Server
      simNodes.forEach(function(n){
        if (oh.levels[n.id]===undefined && n.id!=='Relay Server' && n.category!=='agent') {
          oh.levels[n.id]=2; oh.parents[n.id]='Relay Server';
        }
      });
      // Count children per parent
      simNodes.forEach(function(n){
        var pid = oh.parents[n.id];
        if (pid) oh.childCounts[pid] = (oh.childCounts[pid]||0)+1;
      });
    }
    var oh = window._orbitHierarchy;
    function isAgent(id) {
      var n = nodeById[id];
      return n && n.category==='agent';
    }
    function getParent(id) { return oh.parents[id] || null; }
    function getLevel(id) { return oh.levels[id] !== undefined ? oh.levels[id] : 3; }

    // Orbital radius: planets at 400-640, moons spread across wider concentric rings
    function orbitRadius(id) {
      var lvl = getLevel(id);
      if (lvl===0) return 0;
      if (lvl===1) return 400 + ((id.charCodeAt(0)||0)%240);
      if (lvl===2) {
        var pid = getParent(id);
        var siblings = (pid && oh.childCounts[pid]) ? oh.childCounts[pid] : 1;
        var baseR = (pid==='Relay Server') ? 240 : 160;
        var numRings = Math.min(Math.ceil(siblings/20), 6);
        var ringIdx = (id.charCodeAt(0)+id.charCodeAt(id.length-1)) % numRings;
        var factors = [0.5,0.7,0.9,1.1,1.3,1.5];
        return baseR * (factors[ringIdx]||1.0);
      }
      return 800 + Math.random()*320;
    }

    // Initialize orbital state once
    if (!window._orbitState) {
      window._orbitState = {};
      // Group children by parent+ring for even angle distribution
      var ringGroups = {};
      simNodes.forEach(function(n){
        var pid = oh.parents[n.id];
        if (!pid) return;
        var ringIdx = (n.id.charCodeAt(0)+n.id.charCodeAt(n.id.length-1)) % Math.min(Math.ceil((oh.childCounts[pid]||1)/30),5);
        var key = pid+':'+ringIdx;
        if (!ringGroups[key]) ringGroups[key]=[];
        ringGroups[key].push(n.id);
      });
      simNodes.forEach(function(n){
        var pid = oh.parents[n.id];
        var angle = Math.random()*Math.PI*2;
        var speed = 0.00005 + Math.random()*0.00015;
        if (pid) {
          var ringIdx = (n.id.charCodeAt(0)+n.id.charCodeAt(n.id.length-1)) % Math.min(Math.ceil((oh.childCounts[pid]||1)/30),5);
          var key = pid+':'+ringIdx;
          var group = ringGroups[key]||[];
          var idx = group.indexOf(n.id);
          angle = (idx / (group.length||1)) * Math.PI*2;
          var factors = [0.5,0.75,1.0,1.25,1.5];
          speed = 0.00008 / (factors[ringIdx]||1.0);
        }
        window._orbitState[n.id] = { angle:angle, speed:speed, eccentricity:0.2+Math.random()*0.6, phase:Math.random()*Math.PI*2, wobble:Math.random()*0.3, parentId:pid };
      });
    }

    var time = Date.now();

    // ── First frame: snap all nodes to their orbital positions ──
    if (!window._orbitInitialized) {
      window._orbitInitialized = true;
      for (const n of simNodes) {
        if (n.category === 'agent') continue;
        var lvl = getLevel(n.id);
        var parentId = getParent(n.id);
        var parent = parentId ? nodeById[parentId] : null;
        if (lvl === 0) {
          var anchors = { 'Relay Server':{x:0,y:0}, 'app':{x:-800,y:0}, 'public':{x:800,y:0}, 'app Schema':{x:-800,y:0}, 'public Schema':{x:800,y:0} };
          var a = anchors[n.id]||{x:0,y:0};
          n.x = a.x; n.y = a.y; n.vx = 0; n.vy = 0;
        } else if (parent) {
          var st = window._orbitState[n.id];
          var t = 0.001 * st.speed;
          var angle = st.angle + t;
          var radius = orbitRadius(n.id);
          var eFactor = 1 + st.eccentricity * Math.sin(angle*2 + st.phase);
          var r = radius * eFactor;
          var precessed = angle + t*0.01;
          var wobble = st.wobble * radius * 0.3 * Math.sin(t*1.5 + st.phase);
          var wx = -Math.sin(precessed)*wobble, wy = Math.cos(precessed)*wobble;
          n.x = parent.x + Math.cos(precessed)*r + wx;
          n.y = parent.y + Math.sin(precessed)*r + wy;
          n.vx = 0; n.vy = 0;
        }
      }
    }

    // ── Orbital physics loop — deterministic, no springs, no drift ──
    // First pass: compute all positions (stars + planets)
    for (const n of simNodes) {
      if (n.category === 'agent') continue;
      var lvl = getLevel(n.id);
      var parentId = getParent(n.id);

      if (lvl === 0) {
        var anchors = { 'Relay Server':{x:0,y:0}, 'app':{x:-800,y:0}, 'public':{x:800,y:0}, 'app Schema':{x:-800,y:0}, 'public Schema':{x:800,y:0} };
        var a = anchors[n.id]||{x:0,y:0};
        n.x = a.x; n.y = a.y;
      } else if (parentId && lvl === 1) {
        // Planets: orbit around their star's anchor
        var parentAnchors = { 'Relay Server':{x:0,y:0}, 'app':{x:-800,y:0}, 'public':{x:800,y:0}, 'app Schema':{x:-800,y:0}, 'public Schema':{x:800,y:0} };
        var pa = parentAnchors[parentId];
        var px = pa ? pa.x : 0;
        var py = pa ? pa.y : 0;
        var st = window._orbitState[n.id];
        var t = time * st.speed;
        var angle = st.angle + t;
        var radius = orbitRadius(n.id);
        var eFactor = 1 + st.eccentricity * Math.sin(angle*2 + st.phase);
        var r = radius * eFactor;
        var precessed = angle + t*0.01;
        var wobble = st.wobble * radius * 0.3 * Math.sin(t*1.5 + st.phase);
        var wx = -Math.sin(precessed)*wobble, wy = Math.cos(precessed)*wobble;
        n.x = px + Math.cos(precessed)*r + wx;
        n.y = py + Math.sin(precessed)*r + wy;
      }
    }
    // Second pass: compute moon positions (after planets are settled)
    for (const n of simNodes) {
      if (n.category === 'agent') continue;
      var lvl = getLevel(n.id);
      if (lvl !== 2) continue;
      var parentId = getParent(n.id);
      if (!parentId) continue;
      // Find parent's current position (now stable from first pass)
      var pn = nodeById[parentId];
      if (!pn) continue;
      var st = window._orbitState[n.id];
      var t = time * st.speed;
      var angle = st.angle + t;
      var radius = orbitRadius(n.id);
      var eFactor = 1 + st.eccentricity * Math.sin(angle*2 + st.phase);
      var r = radius * eFactor;
      var precessed = angle + t*0.01;
      var wobble = st.wobble * radius * 0.3 * Math.sin(t*1.5 + st.phase);
      var wx = -Math.sin(precessed)*wobble, wy = Math.cos(precessed)*wobble;
      n.x = pn.x + Math.cos(precessed)*r + wx;
      n.y = pn.y + Math.sin(precessed)*r + wy;
    }

    // ── Comet Agent Physics ──
    if (!window._agentState) {
      window._agentState = {};
      simNodes.forEach(function(n){
        if (n.category!=='agent') return;
        window._agentState[n.id] = { mode:'travel', orbitPlanet:null, orbitFrames:0, trail:[], targetPlanet:null };
        n.vx = (Math.random()-0.5)*0.2; n.vy = (Math.random()-0.5)*0.2;
      });
    }
    var planets = simNodes.filter(function(n){ return getLevel(n.id)===1; });
    simNodes.forEach(function(n){
      if (n.category!=='agent') return;
      var st = window._agentState[n.id];
      if (!st) return;
      st.trail.push({x:n.x,y:n.y});
      if (st.trail.length>25) st.trail.shift();
      var nearest=null, nearDist=Infinity;
      planets.forEach(function(p){
        var dx=p.x-n.x, dy=p.y-n.y, d=Math.sqrt(dx*dx+dy*dy);
        if (d<nearDist) { nearDist=d; nearest=p; }
      });
      if (st.mode==='travel') {
        if (nearest) {
          var pdx=nearest.x-n.x, pdy=nearest.y-n.y, pd=nearDist||1;
          n.vx += (pdx/pd)*200/(pd*pd); n.vy += (pdy/pd)*200/(pd*pd);
          var speed = Math.sqrt(n.vx*n.vx+n.vy*n.vy);
          if (pd<150 && speed<0.8) { st.mode='orbit'; st.orbitPlanet=nearest; st.orbitFrames=0; st.targetPlanet=null; }
        }
        n.vx *= 0.99; n.vy *= 0.99;
        n.vx += -n.x*0.0005; n.vy += -n.y*0.0005;
      } else if (st.mode==='orbit' && st.orbitPlanet) {
        var pl = st.orbitPlanet;
        var odx=pl.x-n.x, ody=pl.y-n.y, od=Math.sqrt(odx*odx+ody*ody)||1;
        var orbitR = 30 + (n.id.charCodeAt(0)%20);
        var tx=-ody/od, ty=odx/od;
        n.vx += tx*0.0005*od; n.vy += ty*0.0005*od;
        var re = od-orbitR;
        n.vx += (odx/od)*re*0.002; n.vy += (ody/od)*re*0.002;
        st.orbitFrames++;
        if (st.orbitFrames > 300 + (n.id.charCodeAt(2)||0)%400) {
          st.mode='travel'; st.orbitPlanet=null; st.orbitFrames=0;
          n.vx = tx*0.8 + (odx/od)*0.2; n.vy = ty*0.8 + (ody/od)*0.2;
          var others = planets.filter(function(p){ return p!==pl; });
          if (others.length) st.targetPlanet = others[Math.floor(Math.random()*others.length)];
        }
      }
      n.x += n.vx; n.y += n.vy;
      var ab=400;
      if (n.x<-ab) { n.x=-ab; n.vx*=-0.5; } if (n.x>ab) { n.x=ab; n.vx*=-0.5; }
      if (n.y<-ab) { n.y=-ab; n.vy*=-0.5; } if (n.y>ab) { n.y=ab; n.vy*=-0.5; }
    });

    // Smooth zoom transition toward target (only during active transition)
    // Disabled — direct zoom control via wheel/buttons
    // camZ += (camZTarget - camZ) * 0.03;

    // ── Render (camera transform) ──
    ctx.clearRect(0, 0, W, H);

    // ── Galaxy background: warm nebula + dense starfield ──
    // Cache starfield — compute once, reuse every frame
    if (!window._starCache) {
      window._starCache = [];
      var starSeed = 42;
      for (var si = 0; si < 120; si++) {
        var sx = ((si * 7919 + starSeed) % 3000) - 1500;
        var sy = ((si * 6271 + starSeed) % 3000) - 1500;
        var sb = 0.05 + ((si * 3571) % 100) / 400;
        var starSize = 0.3 + ((si * 1733) % 5) * 0.25;
        var warm = 220 + ((si * 3917) % 35);
        var isBright = si % 17 === 0;
        var flareLen = isBright ? starSize * 6 : 0;
        window._starCache.push({ sx: sx, sy: sy, sb: sb, starSize: starSize, warm: warm, isBright: isBright, flareLen: flareLen });
      }
    }
    var stars = window._starCache;
    // Subtle nebula glow at center
    var nebula = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, Math.max(W, H) * 0.6);
    nebula.addColorStop(0, 'rgba(180,120,60,0.03)');
    nebula.addColorStop(0.4, 'rgba(120,80,40,0.015)');
    nebula.addColorStop(1, 'transparent');
    ctx.fillStyle = nebula;
    ctx.fillRect(0, 0, W, H);

    // Dense starfield with warm golden stars (cached positions)
    for (var si = 0; si < stars.length; si++) {
      var s = stars[si];
      var sx = s.sx + camX * 0.05;
      var sy = s.sy + camY * 0.05;
      ctx.fillStyle = 'rgba(' + s.warm + ',' + (s.warm - 40) + ',' + (s.warm - 120) + ',' + s.sb + ')';
      ctx.beginPath();
      ctx.arc(sx, sy, s.starSize, 0, Math.PI * 2);
      ctx.fill();
      // Occasional bright star with lens flare cross
      if (s.isBright) {
        ctx.strokeStyle = 'rgba(' + s.warm + ',' + (s.warm - 40) + ',' + (s.warm - 120) + ',' + (s.sb * 0.5) + ')';
        ctx.lineWidth = 0.3;
        ctx.beginPath(); ctx.moveTo(sx - s.flareLen, sy); ctx.lineTo(sx + s.flareLen, sy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sx, sy - s.flareLen); ctx.lineTo(sx, sy + s.flareLen); ctx.stroke();
      }
    }

    ctx.save();
    ctx.translate(W/2, H/2);
    ctx.rotate(camRot);
    ctx.scale(camZ, camZ);
    ctx.translate(-camX, -camY);

    // ── Galaxy rings (golden concentric circles like cuttlefishclaws.com) — wide scale
    var ringRadii = [120, 220, 360, 540, 800];
    for (var ri = 0; ri < ringRadii.length; ri++) {
      var rr = ringRadii[ri];
      var ringAlpha = 0.03 + ri * 0.008;
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(200,160,80,' + ringAlpha + ')';
      ctx.lineWidth = 1 / camZ;
      ctx.stroke();
    }

    // ── Edges (golden glowing connections) ──
    for (const e of edges) {
      const a = nodeById[e.source];
      const b = nodeById[e.target];
      if (!a || !b) continue;
      const isHighlighted = selectedNode && (e.source === selectedNode.id || e.target === selectedNode.id);
      const isHovered = hoveredNode && (e.source === hoveredNode.id || e.target === hoveredNode.id);
      const pulse = 0.2 + 0.2 * Math.sin(Date.now() / 1500 + e.source.length + e.target.length);
      var edgeAlpha = isHighlighted ? 0.6 + pulse : isHovered ? 0.4 + pulse : 0.12 + pulse * 0.25;
      var edgeColor = isHighlighted ? 'rgba(220,180,100,' : isHovered ? 'rgba(200,160,80,' : 'rgba(160,120,60,';
      // Glow pass (wider, fainter)
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = edgeColor + (edgeAlpha * 0.3) + ')';
      ctx.lineWidth = (isHighlighted ? 5 : isHovered ? 4 : 2) / camZ;
      ctx.stroke();
      // Core pass (narrower, brighter)
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = edgeColor + edgeAlpha + ')';
      ctx.lineWidth = (isHighlighted ? 2 : isHovered ? 1.5 : 0.8) / camZ;
      ctx.stroke();
    }

    // ── Nodes (glowing golden orbs with lens flare) ──
    for (const n of simNodes) {
      // Filter effect: skip low-trust agents and unconnected nodes
      if (effectFilter) {
        var trustInfo = trustScores[n.label] || trustScores[n.id] || null;
        if (!trustInfo && n.category === 'agent') continue;
        if (trustInfo && trustInfo.score < 30) continue;
        if (n.category !== 'agent' && !edges.some(function(e){ return e.source === n.id || e.target === n.id; })) continue;
      }

      // DB toggle: hide DB table nodes when off (default: on, but user can toggle off to clean view)
      if (!effectDb && n.category === 'db') continue;

      var color = CAT_COLORS[n.category] || '#6b6b80';
      var trustInfo = null;
      if (n.category === 'agent') {
        trustInfo = trustScores[n.label] || trustScores[n.id] || trustScores[n.label.toLowerCase()] || trustScores[n.id.toLowerCase()] || null;
        if (!trustInfo) {
          var labelLower = n.label.toLowerCase();
          for (var tk in trustScores) {
            if (labelLower.indexOf(tk) !== -1 || tk.indexOf(labelLower) !== -1) {
              trustInfo = trustScores[tk];
              break;
            }
          }
        }
        if (trustInfo) color = trustInfo.color;
      }
      const isSelected = selectedNode && selectedNode.id === n.id;
      const isHovered = hoveredNode && hoveredNode.id === n.id;
      const r = isSelected ? n.r + 4 : isHovered ? n.r + 2 : n.r;

      // Warm up colors for galaxy effect
      var warmColor = color;
      // If it's a cool purple/blue, shift toward golden for agents
      if (n.category === 'agent') {
        warmColor = '#e8c060';
        if (trustInfo) {
          // Map trust bands to golden/warm spectrum
          if (trustInfo.band === 'Pioneer') warmColor = '#60d0e0';
          else if (trustInfo.band === 'Builder') warmColor = '#60e0a0';
          else if (trustInfo.band === 'Contributor') warmColor = '#e8c060';
          else if (trustInfo.band === 'Participant') warmColor = '#c08040';
          else warmColor = '#e0a040';
        }
      }

      // ── Outer glow (large, faint halo) — solid fill, no gradient (faster) ──
      var isStar = n.id === 'Relay Server' || n.id === 'app' || n.id === 'public' || n.id === 'app Schema' || n.id === 'public Schema';
      var glowSize = Math.max(1, n.category === 'agent' || isStar ? r * 5 : r * 3);
      ctx.beginPath();
      ctx.arc(n.x, n.y, glowSize, 0, Math.PI * 2);
      ctx.fillStyle = warmColor + '12';
      ctx.fill();

      // ── Inner glow (medium, visible aura) — solid fill ──
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(1, r * 2), 0, Math.PI * 2);
      ctx.fillStyle = warmColor + '25';
      ctx.fill();

      // ── Lens flare cross for agent nodes and star nodes ──
      if (n.category === 'agent' || n.id === 'Relay Server' || n.id === 'app' || n.id === 'public' || n.id === 'app Schema' || n.id === 'public Schema') {
        // Comet tail using trail history (agents only)
        if (n.category === 'agent') {
          var agentState = window._agentState ? window._agentState[n.id] : null;
          var trail = agentState ? agentState.trail : [];
          if (trail.length > 1) {
            // Draw fading tail
            for (var ti = 1; ti < trail.length; ti++) {
              var t1 = trail[ti - 1];
              var t2 = trail[ti];
              var tAlpha = (ti / trail.length) * 0.4;
              ctx.beginPath();
              ctx.moveTo(t1.x, t1.y);
              ctx.lineTo(t2.x, t2.y);
              ctx.strokeStyle = warmColor + Math.floor(tAlpha * 255).toString(16).padStart(2, '0');
              ctx.lineWidth = (2 + ti * 0.3) / camZ;
              ctx.stroke();
            }
          }
        }

        var flareLen = r * 3;
        var flareAlpha = 0.3;
        ctx.strokeStyle = warmColor;
        ctx.lineWidth = 1 / camZ;
        ctx.globalAlpha = flareAlpha;
        ctx.beginPath(); ctx.moveTo(n.x - flareLen, n.y); ctx.lineTo(n.x + flareLen, n.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(n.x, n.y - flareLen); ctx.lineTo(n.x, n.y + flareLen); ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      // ── Agent nodes: golden ring + score gauge ──
      if (n.category === 'agent' && trustInfo && trustInfo.score !== undefined && effectTrust) {
        const score = Math.max(0, Math.min(100, trustInfo.score));
        // Outer ring (glowing golden) — shadow only on hover/select to avoid GPU choke
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = warmColor + '15';
        ctx.fill();
        ctx.strokeStyle = warmColor;
        ctx.lineWidth = (isSelected ? 3 : isHovered ? 2.5 : 1.5) / camZ;
        if (isSelected || isHovered) {
          ctx.shadowColor = warmColor;
          ctx.shadowBlur = 8 / camZ;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Inner filled arc showing score — no shadow (too expensive per frame)
        var arcEnd = -Math.PI / 2 + (score / 100) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 0.6, -Math.PI / 2, arcEnd);
        ctx.strokeStyle = warmColor;
        ctx.lineWidth = 3 / camZ;
        ctx.stroke();

        // Bright golden center dot — no shadow
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 0.25, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.8;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1.0;

        // Score label — disabled: ctx.font setter is slow and causes freeze on hover
        // if (isSelected || isHovered) {
        //   ctx.font = Math.max(6, 8 * camZ) + 'px monospace';
        //   ctx.fillStyle = warmColor;
        //   ctx.textAlign = 'center';
        //   ctx.textBaseline = 'top';
        //   ctx.fillText(score.toFixed(1) + ' ' + (trustInfo.band || ''), n.x, n.y + r + 4 / camZ + (fontSize || 10) + 2);
        // }
      } else {
        // Non-agent nodes: warm glowing dot
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = warmColor;
        ctx.globalAlpha = 0.7;
        ctx.shadowColor = warmColor;
        ctx.shadowBlur = 10 / camZ;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1.0;
        ctx.strokeStyle = warmColor;
        ctx.lineWidth = (isSelected ? 2 : isHovered ? 1.5 : 0.8) / camZ;
        ctx.stroke();
      }

      // Labels — show when Idents is on (always visible, not just at high zoom)
      if (effectLabels) {
        const fontSize = Math.max(8, Math.min(14, 11 * camZ));
        ctx.fillStyle = isSelected ? '#ffffff' : isHovered ? '#e0e0f0' : '#c0c0d0';
        ctx.font = (isSelected ? 'bold ' : '') + fontSize + 'px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(n.label, n.x, n.y + r + 4 / camZ);
      }
    }

    ctx.restore();

    // ── Zoom indicator ──
    ctx.fillStyle = 'rgba(107,107,128,0.5)';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText((camZ * 100).toFixed(0) + '%', W - 8, H - 4);

    ctx.restore();
    requestAnimationFrame(draw);
  }

  // ── Load data ──
  var kgAbort = new AbortController(); var kgTimer = setTimeout(function() { kgAbort.abort(); }, 90000);
  // Fetch trust scores in parallel (don't block graph load)
  var trustPromise = apiFetch('/api/cuttlefishclaws/trust-network', { signal: AbortSignal.timeout(25000) })
    .then(r => r.json())
    .then(td => {
      var agents = td.agents || td.nodes || [];
      if (Array.isArray(agents)) {
        agents.forEach(function(a) {
          var name = a.name || a.agent_id || a.id;
          if (!name) return;
          var score = a.trust_score !== undefined ? a.trust_score : (a.score !== undefined ? a.score : 0.5);
          var band = a.trust_band || a.band || 'Standard';
          var color = TRUST_BAND_COLORS[band] || '#60a5fa';
          trustScores[name] = { score: score, band: band, color: color };
          trustScores[name.toLowerCase()] = trustScores[name];
          var firstWord = name.split(/[\s-]+/)[0].toLowerCase();
          if (firstWord && firstWord !== name.toLowerCase()) trustScores[firstWord] = trustScores[name];
        });
      } else if (typeof agents === 'object') {
        Object.keys(agents).forEach(function(k) {
          var a = agents[k];
          var score = a.trust_score !== undefined ? a.trust_score : (a.score !== undefined ? a.score : 0.5);
          var band = a.trust_band || a.band || 'Standard';
          var color = TRUST_BAND_COLORS[band] || '#60a5fa';
          trustScores[k] = { score: score, band: band, color: color };
          trustScores[k.toLowerCase()] = trustScores[k];
          var firstWord = k.split(/[\s-]+/)[0].toLowerCase();
          if (firstWord && firstWord !== k.toLowerCase()) trustScores[firstWord] = trustScores[k];
        });
      }
      // Map KG vault agent labels to trust names
      var kgToTrust = {
        'Vex Agent': 'Trib',
        'Alice Agent': 'Arch',
        'Hermes Agent': 'Kimi-AI-Agent',
        'Eliza Agent': 'GlobalCommunicator',
        'CuttlefishClaws Agents': 'TrustGraph',
        'Executive Persona Agents': 'Sovereign Agent',
        'Fleet Chat': 'DAO Gov',
        'Isabella Rodriguez': 'Builder Agent',
      };
      Object.keys(kgToTrust).forEach(function(kgLabel) {
        var trustName = kgToTrust[kgLabel];
        if (trustScores[trustName]) {
          trustScores[kgLabel] = trustScores[trustName];
          trustScores[kgLabel.toLowerCase()] = trustScores[trustName];
        }
      });
    })
    .catch(function() { /* trust scores unavailable */ });

  // Load graph data independently (not chained after trust scores)
  apiFetch('/api/obsidian-graph', { signal: kgAbort.signal })
    .then(r => r.json())
    .then(data => {
      clearTimeout(kgTimer);
      nodes = data.nodes || [];
      edges = data.edges || [];
      if (nodeCountEl) nodeCountEl.textContent = nodes.length + ' nodes · ' + edges.length + ' connections';
      resize();
      initSimulation();
      // Pre-select the Relay Server node ("You Are Here")
      const relayNode = nodes.find(n => n.id === 'Relay Server');
      if (relayNode) {
        selectedNode = relayNode;
        const relaySim = simNodes.find(n => n.id === relayNode.id);
        if (relaySim) focusOnNode(relaySim);
      }
      draw();
    })
    .catch(e => {
      clearTimeout(kgTimer);
      if (nodeCountEl) nodeCountEl.textContent = 'Failed to load graph';
      console.error('[KG] fetch error:', e.message);
      logShipsLog('kg_error', '🕸️ Knowledge Graph fetch failed', e.message, 'error', 'relay', {});
    });

  // ── Mouse events ──
  let mouseDownTime = 0;
  let mouseDownNode = null;
  let mouseMoved = false;
  canvas.addEventListener('mousedown', function(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const n = getNodeAtScreen(sx, sy);
    mouseDownTime = Date.now();
    mouseDownNode = n;
    mouseMoved = false;
    if (n) {
      // Don't select or focus yet — wait to see if it's a click or drag
      const w = screenToWorld(sx, sy);
      dragOff.x = w.x - n.x;
      dragOff.y = w.y - n.y;
      canvas.style.cursor = 'grabbing';
    } else {
      // Start camera drag — stop focus tracking so user can pan freely
      focusNode = null;
      focusAnim = 1;
      dragCam = true;
      dragCamStart = { x: sx, y: sy, cx: camX, cy: camY };
      canvas.style.cursor = 'grabbing';
    }
  });

  canvas.addEventListener('mousemove', function(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (mouseDownNode) {
      // If mouse moved more than 3px, it's a drag — start dragging
      const w = screenToWorld(sx, sy);
      const dx = w.x - (mouseDownNode.x);
      const dy = w.y - (mouseDownNode.y);
      if (Math.abs(dx) > 3/camZ || Math.abs(dy) > 3/camZ) {
        mouseMoved = true;
        dragNode = mouseDownNode;
        // Select on drag start
        selectedNode = mouseDownNode;
        focusOnNode(mouseDownNode);
      }
      if (dragNode) {
        dragNode.x = w.x - dragOff.x;
        dragNode.y = w.y - dragOff.y;
        dragNode.vx = 0; dragNode.vy = 0;
        return;
      }
    }
    if (dragCam) {
      const dx = (sx - dragCamStart.x) / camZ;
      const dy = (sy - dragCamStart.y) / camZ;
      camX = dragCamStart.cx - dx;
      camY = dragCamStart.cy - dy;
      return;
    }
    const n = getNodeAtScreen(sx, sy);
    hoveredNode = n;
    canvas.style.cursor = n ? 'pointer' : 'grab';
    if (n && tooltip) {
      tooltip.style.display = 'block';
      tooltip.style.left = (sx + 14) + 'px';
      tooltip.style.top = (sy - 10) + 'px';
      const connCount = edges.filter(e => e.source === n.id || e.target === n.id).length;
      tooltip.textContent = n.label + ' — ' + n.category + ' (' + connCount + ' connections)';
    } else if (tooltip) {
      tooltip.style.display = 'none';
    }
  });

  canvas.addEventListener('mouseup', function(e) {
    // If it was a click (not a drag), select/deselect the node
    if (mouseDownNode && !mouseMoved) {
      const wasSelected = selectedNode && selectedNode.id === mouseDownNode.id;
      if (wasSelected) {
        // Double-click detection: if already selected, zoom to fit
        if (Date.now() - mouseDownTime < 500) {
          selectedNode = null;
          resetGraphView();
        } else {
          selectedNode = null;
        }
      } else {
        selectedNode = mouseDownNode;
        focusOnNode(mouseDownNode);
      }
    } else if (!mouseDownNode && !mouseMoved) {
      // Click on empty space — deselect
      selectedNode = null;
    }
    dragNode = null;
    mouseDownNode = null;
    dragCam = false;
    canvas.style.cursor = 'grab';
  });
  canvas.addEventListener('mouseleave', function() {
    hoveredNode = null; dragNode = null; dragCam = false;
    if (tooltip) tooltip.style.display = 'none';
    canvas.style.cursor = 'grab';
  });

  // ── Mouse wheel zoom ──
  canvas.addEventListener('wheel', function(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    camZ = Math.max(0.05, Math.min(5, camZ * delta));
    camZTarget = camZ; // sync target so smooth transition doesn't fight wheel
    const newScreen = worldToScreen(world.x, world.y);
    camX += (sx - newScreen.x) / camZ;
    camY += (sy - newScreen.y) / camZ;
  }, { passive: false });

  // ── Touch events (mobile: pan, pinch-zoom, rotate, double-tap) ──
  let touchState = null; // { sx, sy, cx, cy, dist, angle, camX, camY, camZ, camRot, tapTime }
  canvas.addEventListener('touchstart', function(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const touches = e.touches;
    if (touches.length === 1) {
      const t = touches[0];
      const sx = t.clientX - rect.left, sy = t.clientY - rect.top;
      const n = getNodeAtScreen(sx, sy);
      if (n) {
        // Tap on node — select it
        selectedNode = selectedNode && selectedNode.id === n.id ? null : n;
        focusOnNode(n);
        dragNode = n;
        const w = screenToWorld(sx, sy);
        dragOff.x = w.x - n.x;
        dragOff.y = w.y - n.y;
        return;
      }
      // Pan start
      touchState = {
        sx, sy, cx: camX, cy: camY, camZ, camRot,
        dist: 0, angle: 0,
        tapTime: Date.now()
      };
    } else if (touches.length === 2) {
      // Pinch-zoom + rotate start
      const t1 = touches[0], t2 = touches[1];
      const x1 = t1.clientX - rect.left, y1 = t1.clientY - rect.top;
      const x2 = t2.clientX - rect.left, y2 = t2.clientY - rect.top;
      const dx = x2 - x1, dy = y2 - y1;
      touchState = {
        sx: 0, sy: 0, cx: camX, cy: camY, camZ, camRot,
        dist: Math.sqrt(dx * dx + dy * dy),
        angle: Math.atan2(dy, dx),
        tapTime: 0
      };
      dragNode = null;
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', function(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const touches = e.touches;
    if (!touchState) return;

    if (touches.length === 1 && !dragNode) {
      // Pan
      const t = touches[0];
      const sx = t.clientX - rect.left, sy = t.clientY - rect.top;
      const dx = (sx - touchState.sx) / camZ;
      const dy = (sy - touchState.sy) / camZ;
      camX = touchState.cx - dx;
      camY = touchState.cy - dy;
    } else if (touches.length === 1 && dragNode) {
      // Drag node
      const t = touches[0];
      const sx = t.clientX - rect.left, sy = t.clientY - rect.top;
      const w = screenToWorld(sx, sy);
      dragNode.x = w.x - dragOff.x;
      dragNode.y = w.y - dragOff.y;
      dragNode.vx = 0; dragNode.vy = 0;
    } else if (touches.length === 2) {
      // Pinch-zoom + rotate
      const t1 = touches[0], t2 = touches[1];
      const x1 = t1.clientX - rect.left, y1 = t1.clientY - rect.top;
      const x2 = t2.clientX - rect.left, y2 = t2.clientY - rect.top;
      const dx = x2 - x1, dy = y2 - y1;
      const newDist = Math.sqrt(dx * dx + dy * dy);
      const newAngle = Math.atan2(dy, dx);

      if (touchState.dist > 0) {
        const scale = newDist / touchState.dist;
        camZ = Math.max(0.05, Math.min(5, touchState.camZ * scale));
      }
      if (touchState.angle !== 0) {
        camRot = touchState.camRot + (newAngle - touchState.angle);
      }
    }
  }, { passive: false });

  canvas.addEventListener('touchend', function(e) {
    // Double-tap detection
    if (touchState && touchState.tapTime && Date.now() - touchState.tapTime < 300) {
      // Double-tap — zoom in on center (preserve existing zoom, don't reset)
      camX = 0; camY = 0; // center
      // camZ stays wherever user had it
      focusNode = null; focusAnim = 1;
    }
    dragNode = null;
    touchState = null;
    if (tooltip) tooltip.style.display = 'none';
  }, { passive: false });

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', function(e) {
    if (e.key === 'r' || e.key === 'R') {
      // Reset camera
      camX = 0; camY = 0; camZ = 1; camRot = 0;
      focusNode = null; focusAnim = 1;
    }
    if (e.key === 'f' || e.key === 'F') {
      // Fit all — zoom to show all nodes
      if (simNodes.length) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const n of simNodes) {
          if (n.x < minX) minX = n.x;
          if (n.x > maxX) maxX = n.x;
          if (n.y < minY) minY = n.y;
          if (n.y > maxY) maxY = n.y;
        }
        const ww = maxX - minX + 100, hh = maxY - minY + 100;
        const scale = Math.min(W / ww, H / hh) * 0.85;
        camX = (minX + maxX) / 2;
        camY = (minY + maxY) / 2;
        camZ = Math.max(0.05, Math.min(5, scale));
        focusNode = null; focusAnim = 1;
      }
    }
  });

  // ── Global reset function for the Reset button ──
  window.resetGraphView = function() {
    camX = 0; camY = 0; camZ = 1; camRot = 0;
    focusNode = null; focusAnim = 1;
  };

  window.zoomGraph = function(factor) {
    camZ = Math.max(0.05, Math.min(5, camZ * factor));
  };

  window.addEventListener('resize', function() { resize(); });
})();
