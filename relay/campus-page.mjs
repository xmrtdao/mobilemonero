// ═══════════════════════════════════════════════════════════════
// XMRT Nexus command center (formerly "XMRT Nexus").
// Extracted from server.js (2026-10-10) — the ~1,400-line inline page
// template made the relay's core file unmaintainable. Everything the
// dashboard needs arrives via the deps object; client logic stays in
// public/dashboard.js and public/markdown.js.
// ═══════════════════════════════════════════════════════════════
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export function createCampusHandler(deps) {
  const {
    RELAY_API_KEY, trackRequest, osHostname, state, SUPABASE_URL,
    toolHandlers, handlers, taskRunner, DATA_DIR, requestCounts,
    resendTileHtml, localFunctions, dashboardJsVersion,
  } = deps;

  return (req, res) => {
  // Check if user is already authenticated
  const apiKey = (req.headers['x-api-key'] || req.query.api_key || req.cookies?.relay_api_key || '').trim();
  const isAuthed = apiKey && apiKey === RELAY_API_KEY;
  if (!isAuthed) {
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>XMRT Nexus — Sign in</title>
  <style>
    :root{--bg:#0D0F0C;--card:#111310;--border:#2A2E25;--accent:#C9A227;--text:#ECEDE6;--muted:#9AA091;--err:#E4695A}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Barlow',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
    .box{background:var(--card);border:1px solid var(--border);border-radius:1rem;padding:1.6rem;max-width:420px;width:100%}
    h1{font-family:'Saira Condensed',sans-serif;font-size:1.3rem;margin-bottom:.3rem;letter-spacing:.02em}
    h1 small{color:var(--accent);font-size:.8rem;display:block;margin-top:.2rem;font-family:'Space Mono',monospace;letter-spacing:.14em;text-transform:uppercase}
    p{color:var(--muted);font-size:.85rem;margin-bottom:1rem}
    input{width:100%;background:#0D0F0C;border:1px solid var(--border);color:var(--text);padding:.6rem .8rem;border-radius:.5rem;font-family:'Space Mono',monospace;font-size:.85rem;margin-bottom:.6rem}
    button{width:100%;background:var(--accent);color:#0D0F0C;border:0;padding:.6rem;border-radius:.5rem;font-weight:600;cursor:pointer;font-size:.9rem;font-family:'Saira Condensed',sans-serif;letter-spacing:.05em;text-transform:uppercase}
    button:hover{background:#E4BB3A}
    a{color:var(--accent);font-size:.8rem;text-decoration:none}
    .status{font-size:.75rem;margin-top:.6rem;min-height:1.2em}
  </style>
</head>
<body>
  <div class="box">
    <h1>XMRT Nexus <small>Command Center</small></h1>
    <p>Enter your API key or XMRT-DAO-CERT JWT to access the campus dashboard. Graduates can use their cert JWT from XMRT University.</p>
    <form id="loginForm">
      <input id="keyInput" type="password" placeholder="API key or XMRT-DAO-CERT JWT" autocomplete="off" required>
      <button type="submit">Sign in</button>
    </form>
    <div id="status" class="status"></div>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', function(e) {
      e.preventDefault();
      const key = document.getElementById('keyInput').value.trim();
      const status = document.getElementById('status');
      if (!key) { status.style.color='var(--err)'; status.textContent='Please enter an API key or XMRT-DAO-CERT JWT.'; return; }
      // Detect if this looks like a JWT (starts with "local-" or has dots like a real JWT)
      if (key.startsWith('local-') || (key.includes('.') && key.split('.').length === 3)) {
        // This is an XMRT-DAO-CERT JWT — verify it server-side
        status.style.color='var(--muted)'; status.textContent='Verifying XMRT-DAO-CERT...';
        fetch('/api/auth/cert-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jwt: key }),
        }).then(r => r.json()).then(data => {
          if (data.success) {
            status.style.color='var(--accent)'; status.textContent='Welcome, ' + (data.agent?.agent_name || 'Graduate') + '! Redirecting...';
            setTimeout(() => { window.location.href = '/'; }, 500);
          } else {
            status.style.color='var(--err)'; status.textContent = data.error || 'Invalid XMRT-DAO-CERT. Please graduate from XMRT University first.';
          }
        }).catch(err => {
          status.style.color='var(--err)'; status.textContent = 'Verification failed: ' + err.message;
        });
      } else {
        // Regular API key — set cookie directly
        document.cookie = 'relay_api_key=' + encodeURIComponent(key) + '; path=/; max-age=86400; sameSite=lax';
        window.location.href = '/';
      }
    });
  </script>
</body>
</html>`);
  }
  trackRequest('/');
  const hostname = osHostname();
  const tunnelUrl = state.get('tunnel-url') || 'https://relay.mobilemonero.com';
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const mins = Math.floor((uptime % 3600) / 60);
  const uptimeStr = `${days}d ${hours}h ${mins}m`;
  const supabaseUrl = SUPABASE_URL;
  
  const tools = Object.keys(toolHandlers);
  const toolCount = tools.length;
  const handlerCount = Object.keys(handlers).length;
  const stats = taskRunner.getStats();

  // ── Campaign stats ────────────────────────────────────
  const CAMPAIGN_SENT = join(DATA_DIR, 'campaign-sent.json');
  const CAMPAIGN_CONTACTS = join(DATA_DIR, 'campaign-contacts.json');
  const CAMPAIGN_LOG = join(DATA_DIR, 'campaign.log');
  
  let campaignSent = [];
  let campaignContacts = [];
  let campaignLastRun = 'never';
  try {
    if (existsSync(CAMPAIGN_SENT)) campaignSent = JSON.parse(readFileSync(CAMPAIGN_SENT, 'utf8'));
    if (existsSync(CAMPAIGN_CONTACTS)) campaignContacts = JSON.parse(readFileSync(CAMPAIGN_CONTACTS, 'utf8'));
    if (existsSync(CAMPAIGN_LOG)) {
      const logLines = readFileSync(CAMPAIGN_LOG, 'utf8').trim().split('\n').filter(Boolean);
      if (logLines.length > 0) {
        const lastLine = logLines[logLines.length - 1];
        const tsMatch = lastLine.match(/\[(.*?)\]/);
        campaignLastRun = tsMatch ? tsMatch[1].slice(0, 16) : 'recent';
      }
    }
  } catch (e) { /* stats unavailable */ }
  
  const totalSent = campaignSent.length;
  const poolSize = campaignContacts.length;
  const now = Date.now();
  const cutoff30 = now - 30 * 24 * 60 * 60 * 1000;
  const recentSent = new Set(campaignSent.filter(s => s.ts > cutoff30).map(s => s.email));
  const freshAvailable = campaignContacts.filter(c => !recentSent.has(c.email) && c.email?.includes('@')).length;
  
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const sentToday = campaignSent.filter(s => s.ts > todayStart.getTime()).length;


  // ── Campaign stats (31harbor) ──────────────────────────
  const HARBOR_CONTACTS = join(DATA_DIR, '31harbor-contacts.json');
  const HARBOR_SENT = join(DATA_DIR, '31harbor-sent.json');
  const HARBOR_LOG = join(DATA_DIR, '31harbor-campaign.log');

  let harborSent = [];
  let harborContacts = [];
  let harborLastRun = 'never';
  try {
    if (existsSync(HARBOR_SENT)) harborSent = JSON.parse(readFileSync(HARBOR_SENT, 'utf8'));
    if (existsSync(HARBOR_CONTACTS)) harborContacts = JSON.parse(readFileSync(HARBOR_CONTACTS, 'utf8'));
    if (existsSync(HARBOR_LOG)) {
      const logLines = readFileSync(HARBOR_LOG, 'utf8').trim().split('\n    \x27task-dedup\x27: \x27Find and merge duplicate tasks by exact title match or trigram similarity. Dry-run by default (dry_run:true). Set dry_run:false to merge. Keeps the task with the most progress.\x27,\n    \n').filter(Boolean);
      if (logLines.length > 0) {
        const lastLine = logLines[logLines.length - 1];
        const tsMatch = lastLine.match(/\[(.*?)\]/);
        harborLastRun = tsMatch ? tsMatch[1].slice(0, 16) : 'recent';
      }
    }
  } catch (e) { /* stats unavailable */ }

  const harborSentTotal = harborSent.length;
  const harborPoolSize = harborContacts.length;
  const harborCutoff30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentHarborSent = new Set(harborSent.filter(s => s.ts > harborCutoff30).map(s => s.email));
  const harborFresh = harborContacts.filter(c => !recentHarborSent.has(c.email) && c.email?.includes('@')).length;
  const harborSentToday = harborSent.filter(s => s.ts > todayStart.getTime()).length;

  // ── Scheduled Tasks ───────────────────────────────────
  const taskSchedule = [
    { time: '08:00', name: 'DailyCampaign', desc: '500 emails' },
    { time: '12:00', name: 'NoonCampaign', desc: '500 emails' },
    { time: '16:00', name: '4PMCampaign', desc: '500 emails' },
    { time: '23:00', name: 'SeasonalScraper', desc: 'contact scrape' },
    { time: 'Every hr', name: 'HourlyTaskFetch', desc: 'cron proxy' },
  ];
  const currentHour = new Date().getHours() - 6; // CST offset
  
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>XMRT Nexus — Command Center</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@400;500;600;700;800&family=Barlow:wght@300;400;500;600&family=Space+Mono:wght@400;700&display=swap');
    :root {
      /* ── XMRT Nexus palette — borrowed from the Gray Tech design system
         (graytech/relay/public/graytech-offline): ink greens, paper text,
         brass-gold accents. The orange "Tributary" theme is retired. ── */
      --bg-primary: #0D0F0C;   /* ink */
      --bg-card: #111310;      /* ink-2 */
      --bg-card-hover: #171A15;/* ink-3 */
      --border: #2A2E25;       /* line */
      --border-hover: #3A3F31; /* line-2 */
      --text-primary: #ECEDE6; /* paper */
      --text-secondary: #B9BEB0;
      --text-muted: #9AA091;   /* mute */
      --text-dim:   #6C7263;   /* mute-2 */
      --text-ghost: #565B4E;   /* borders and rules only, never text */
      --accent-orange: #C9A227;              /* gold — legacy var name, kept so the page's ~200 uses all flip at once */
      --accent-orange-glow: rgba(201,162,39,0.15);
      --accent-teal: #63C7D4;  /* cyn */
      --accent-blue: #63C7D4;
      --accent-purple: #E4BB3A; /* gold-bright */
      --accent-yellow: #E4BB3A;
      --accent-red: #E4695A;
      --font-sans: 'Barlow', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      --font-display: 'Saira Condensed', 'Barlow', sans-serif;
      --font-mono: 'Space Mono', ui-monospace, 'Cascadia Code', Consolas, monospace;
      /* ── Lumen Design Tokens (retinted to the Nexus gold) ── */
      --lumen-bg: #0D0F0C;
      --lumen-bg-surface: #111310;
      --lumen-bg-elevated: #171A15;
      --lumen-bg-hover: #1E211A;
      --lumen-text: #ECEDE6;
      --lumen-text-muted: #9AA091;
      --lumen-text-dim: #6C7263;
      --lumen-accent: #C9A227;
      --lumen-accent-glow: rgba(201, 162, 39, 0.15);
      --lumen-accent-bg: rgba(201, 162, 39, 0.1);
      --lumen-border: rgba(236, 234, 228, 0.06);
      --lumen-border-strong: rgba(236, 234, 228, 0.12);
      --lumen-success: #22c55e;
      --lumen-warning: #f59e0b;
      --lumen-danger: #ef4444;
      --lumen-info: #3b82f6;
      --lumen-live: #8fad96;
      --lumen-live-fg: #0c0d0b;
      --lumen-warn: #c4a574;
      --lumen-danger-fg: #1a0f0d;
      --lumen-radius-sm: 4px;
      --lumen-radius-md: 6px;
      --lumen-radius-lg: 8px;
      --lumen-radius-xl: 12px;
      --lumen-radius-pill: 9999px;
      --lumen-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.30);
      --lumen-shadow-md: 0 4px 12px rgba(0, 0, 0, 0.40);
      --lumen-shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.50);
      --lumen-shadow-glow: 0 0 20px var(--lumen-accent-glow);
      --lumen-transition: 200ms ease;
      --lumen-font-sans: 'Barlow', system-ui, 'Segoe UI', Roboto, sans-serif;
      --lumen-font-display: 'Saira Condensed', 'Barlow', sans-serif;
      --lumen-font-mono: 'Space Mono', ui-monospace, Consolas, monospace;
    }
    /* Scanline effect (XMRT Nexus signature — gold on ink) */
    .scanline { position: fixed; top: 0; left: 0; width: 100%; height: 1px; background: linear-gradient(90deg, transparent, rgba(201,162,39,0.10), transparent); animation: scan 14s linear infinite; pointer-events: none; z-index: 999; }
    @keyframes scan { 0% { top: 0; } 100% { top: 100%; } }
    /* Corner brackets */
    .bracket { position: relative; }
    .bracket::before, .bracket::after { content: ''; position: absolute; width: 10px; height: 10px; border-color: var(--accent-orange); border-style: solid; opacity: 0.5; }
    .bracket::before { top: 0; left: 0; border-width: 1px 0 0 1px; }
    .bracket::after { top: 0; right: 0; border-width: 1px 1px 0 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: var(--font-sans); background: var(--bg-primary); color: var(--text-secondary); padding: 0.5rem; }
    @media (min-width: 640px) { body { padding: 1.5rem; } }
    h1 { color: var(--accent-orange); font-size: 1.05rem; margin-bottom: 0.25rem; display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; font-weight: 700; letter-spacing: 0.01em; font-family: var(--font-display); }
    @media (min-width: 640px) { h1 { font-size: 1.6rem; gap: 0.75rem; } }
    h1 span { font-size: 0.65rem; color: var(--text-dim); font-weight: 400; letter-spacing: 0; }
    @media (min-width: 640px) { h1 span { font-size: 0.9rem; } }
    .subtitle { color: var(--text-muted); font-size: 0.7rem; margin-bottom: 0.75rem; line-height: 1.4; }
    @media (min-width: 640px) { .subtitle { font-size: 0.9rem; margin-bottom: 1.5rem; } }
    .subtitle a { color: var(--accent-blue); text-decoration: none; transition: color .15s; }
    .subtitle a:hover { color: var(--accent-orange); text-decoration: underline; }
    /* ── Grid ────────────────────────────────────────────────────────────────
       MOBILE-FIRST, and the direction is load-bearing rather than stylistic.

       The old rules declared 4 columns at 1200px, but every one of the nine
       tiles carried an INLINE 'grid-column:1/-1'. An inline style beats any
       class, so the grid rendered as a single full-bleed column at every
       width. That is the entire reason nothing on this page had visual rank:
       the layout had columns and never used them.

       Spans below are opt-in from the breakpoint where the grid actually has
       that many columns. This matters more than it looks: 'grid-column: span 2'
       inside a ONE-column grid does not clamp to full width, it creates an
       implicit second column and the page grows a horizontal scrollbar. So
       every tile is full width on mobile by default and only earns a span once
       there are columns to span.

       minmax(0, 1fr) rather than 1fr: a 1fr track has an automatic minimum
       sized to its content, so one long unbroken string in a log line is
       enough to push a column wider than its share and break the row. */
    .grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.5rem; margin-bottom: 1rem; }
    .grid > .full, .tile-full { grid-column: 1 / -1; }
    .tile, .tile-wide { grid-column: 1 / -1; }

    /* Two columns. Natural phone-landscape / small tablet. */
    @media (min-width: 560px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
      .tile { grid-column: span 1; }
      .tile-wide { grid-column: span 2; }
    }
    /* Three columns: the point at which a tile is worth spanning. */
    @media (min-width: 900px) {
      .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
      .tile { grid-column: span 1; }
    }
    /* Four columns for wide desktops. */
    @media (min-width: 1280px) {
      .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; }
    }

    /* Priority order. Set with 'order' on the grid children rather than by
       rearranging the HTML, so the source still reads top-to-bottom in
       priority order AND the rendered order can change without touching
       markup. Grid honours 'order'; it is flexbox's property and it applies
       to grid items too.

       Deliberately NOT inside a min-width query. Priority order that only
       applies above a breakpoint means a phone gets a different sequence from
       a desktop, and "what matters first" should not depend on the screen.
       Campus Command leads on both because it carries the supervisor panel -
       the thing you most want to see when something has broken - and its
       Agent Vault is collapsed for the same reason. */
    .tile-p1 { order: 1; } .tile-p2 { order: 2; } .tile-p3 { order: 3; }
    .tile-p4 { order: 4; } .tile-p5 { order: 5; } .tile-p6 { order: 6; }
    .tile-p7 { order: 7; } .tile-p8 { order: 8; } .tile-p9 { order: 9; }

    /* ── Collapsed archives ────────────────────────────────────────────────
       Agent Vault (1,810px of completed artifacts) and Edge Functions
       (11,888px, 70% of the page) were full-bleed tables competing with live
       status for the same attention. Both are <details>, collapsed, with the
       summary styled as a row rather than a browser default.

       The marker is hidden and replaced with a chevron because the default
       disclosure triangle is small, low-contrast, and sits far from the text.
       min-height 44px on the summary is deliberate: it is a touch target. */
    .archive { display: block; width: 100%; box-sizing: border-box;
               border: 1px solid var(--border); border-radius: 8px;
               background: var(--bg-card); margin-bottom: 0.75rem; overflow: hidden; }
    .archive > summary {
      display: flex; align-items: center; gap: 0.5rem;
      min-height: 44px; padding: 0.5rem 0.9rem;
      font-family: var(--font-display); font-size: 0.85rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-orange);
      cursor: pointer; list-style: none; user-select: none;
    }
    .archive > summary::-webkit-details-marker { display: none; }
    .archive > summary::before {
      content: '▸'; display: inline-block; color: var(--accent-orange);
      transition: transform 160ms ease; font-size: 0.9em;
    }
    .archive[open] > summary::before { transform: rotate(90deg); }
    .archive > summary:hover { background: var(--bg-card-hover); }
    .archive > summary:focus-visible { outline: 2px solid var(--accent-orange); outline-offset: -2px; }
    .archive > summary span {
      font-family: var(--font-sans); font-weight: 400; text-transform: none;
      letter-spacing: 0; color: var(--text-muted); font-size: 0.8rem;
    }
    /* The body of an archive sits inside a card already, so give it room. */
    .archive > .card { border: none; background: transparent; }

    /* ── Status strip ──────────────────────────────────────────────────────
       The one question this page is opened to answer is "is anything broken".
       Before this, the answer (services up, health score, restart control) was
       at y=1,141, below the chat transcript and the trust chart. */
    .status-strip {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1.25rem;
      padding: 0.6rem 0.9rem; margin-bottom: 0.75rem;
      border: 1px solid var(--border); border-radius: 8px;
      background: linear-gradient(180deg, rgba(255,107,53,0.07), rgba(255,107,53,0.02));
    }
    .status-strip .ss-item { display: flex; align-items: baseline; gap: 0.4rem; min-width: 0; }
    .status-strip .ss-label {
      color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;
      letter-spacing: 0.05em; white-space: nowrap;
    }
    .status-strip .ss-value {
      color: var(--text-primary); font-family: var(--font-mono);
      font-variant-numeric: tabular-nums; font-size: 1rem; font-weight: 500;
    }
    .status-strip .ss-cta {
      margin-left: auto; display: inline-flex; align-items: center; gap: 0.35rem;
      padding: 0.35rem 0.7rem; min-height: 32px; border-radius: 5px;
      border: 1px solid var(--border-hover); color: var(--accent-orange);
      font-size: 0.75rem; text-decoration: none; white-space: nowrap;
    }
    .status-strip .ss-cta:hover { background: var(--accent-orange-glow); }
    /* On a phone the CTA should not be pushed to a lonely right edge. */
    @media (max-width: 560px) {
      .status-strip { gap: 0.4rem 0.9rem; }
      .status-strip .ss-cta { margin-left: 0; width: 100%; justify-content: center; }
      .status-strip .ss-value { font-size: 0.95rem; }
    }

    /* ── Mobile ────────────────────────────────────────────────────────────
       Everything above is fine at 360px except the restart rows, which are a
       6-column grid and collapse to unreadable slivers. They stack instead:
       name on its own line, pid and button beneath. */
    @media (max-width: 560px) {
      body { padding: 0.6rem; }
      /* The restart-row overrides live further down, next to the base .qd-svc
         rule, so that they win the cascade. Duplicating them here is what
         produced a half-applied layout the first time. */
      .side-by-side > * { min-width: 0; }
      .stat { flex-wrap: wrap; }
      .value { max-width: 100%; }
      /* Anything that is intrinsically wide scrolls inside its own box rather
         than widening the page. */
      .card pre, .card table { max-width: 100%; overflow-x: auto; }
      .board-post-body pre { max-width: 100%; overflow-x: auto; }
    }
    .side-by-side { display: flex; flex-wrap: wrap; gap: 8px; grid-column: 1 / -1; }
    @media (min-width: 640px) { .side-by-side { gap: 12px; } }
    .side-by-side > * { flex: 1; min-width: 260px; }
    /* The per-service chips are generated with .join(''), so the spans form one
         unbreakable text run: there is no whitespace between them for the
         browser to break at, and a 299px container produced 934px of content,
         giving the page a horizontal scrollbar at every width. As flex items
         each chip wraps on its own. */
    #qds-services-tracker { display: flex; flex-wrap: wrap; gap: 2px 8px; }
    /* RSSI signal strength colors */
    .rssi-strong { color: #4ade80; }
    .rssi-fair { color: #fbbf24; }
    .rssi-weak { color: #f87171; }
    .rssi-poor { color: #ef4444; }
    .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem; transition: border-color .2s, transform .15s;
           /* overflow-wrap INHERITS, so this one declaration reaches every
              descendant. It only engages for a word that would otherwise
              overflow its line, which is exactly the Tools list's
              "http://127.0.0.1:54321/functions/..." - a 523px unbreakable
              string that was the last remaining source of horizontal
              scroll. No effect on ordinary prose. */
           overflow-wrap: break-word; }
    @media (min-width: 640px) { .card { border-radius: 10px; padding: 1rem; } }
    .card:hover { border-color: var(--accent-orange-glow); }
    /* Card and sub-card headings keep Rajdhani: at 12-15px a condensed display
       face is a deliberate choice and reads as a heading, not as body copy. */
    .card h3 { color: var(--accent-orange); font-family: var(--font-display); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.4rem; font-weight: 700; }
    @media (min-width: 640px) { .card h3 { font-size: 0.95rem; margin-bottom: 0.6rem; } }
    /* Floor raised from 0.65rem. 0.65rem is 10.4px, which is below the point
       where a dense ops table stops being readable, and it applied to every
       label and value in the UI. 0.75rem = 12px. */
    /* flex-wrap so that when a label and its value cannot share a line the VALUE
       drops to its own line, rather than the label being crushed into a
       one-character-per-line column. Pairs with overflow-wrap:normal on
       .label: labels break at spaces, and whole words are never split.
       Without both, "Last Commit" rendered as "Last / Commi / t". */
    .stat { display: flex; flex-wrap: wrap; justify-content: space-between; padding: 0.25rem 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 0.75rem; gap: 0.4rem; line-height: 1.45; }
    @media (min-width: 640px) { .stat { padding: 0.32rem 0; font-size: 0.9rem; gap: 0.6rem; } }
    .stat:last-child { border-bottom: none; }
    /* 'white-space: nowrap' + 'flex-shrink: 0' together meant a label could never
       shrink: "XMRT Token Faucet" in the DAO tile was 137px wide inside a 155px
       column and pushed the row past the right edge of the viewport, giving the
       whole page a horizontal scrollbar at every width. Measured 934px of
       content in a 360px viewport. Labels now wrap, and are allowed to shrink;
       min-width:0 lets them do it inside a flex row. Wrapping is preferred to
       ellipsis here because a truncated label hides which metric it names. */
    .label { color: var(--text-muted); flex-shrink: 1; min-width: 0; overflow-wrap: normal; }
    /* Tabular figures so columns of numbers align vertically down a dense panel.
       Without it, Inter's proportional digits make a wall of pids and scores
       shimmer as values change. */
    .value { color: var(--text-primary); font-family: var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; word-break: break-word; min-width: 0; overflow-wrap: break-word; hyphens: auto; max-width: 60%; }
    @media (min-width: 480px) { .value { max-width: 70%; } }
    @media (min-width: 640px) { .value { max-width: none; } }
    .badge { display: inline-block; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.6rem; font-weight: 600; }
    @media (min-width: 640px) { .badge { font-size: 0.7rem; padding: 0.1rem 0.4rem; } }
    .badge-ok { background: rgba(74,222,128,0.12); color: var(--accent-teal); }
    .badge-warn { background: rgba(251,191,36,0.12); color: var(--accent-yellow); }
    .badge-err { background: rgba(248,113,113,0.12); color: var(--accent-red); }
    .badge-info { background: rgba(96,165,250,0.12); color: var(--accent-blue); }

    @media (min-width: 640px) { .chat-card { grid-column: 1 / -1; } }

    .board-topics { max-height: 200px; overflow-y: auto; margin-bottom: 6px; }
    @media (min-width: 640px) { .board-topics { max-height: 300px; } }
    .board-topic { padding: 6px; border-radius: 6px; background: #0d0d15; margin-bottom: 4px; cursor: pointer; transition: background .15s; border: 1px solid transparent; }
    @media (min-width: 640px) { .board-topic { padding: 8px; } }
    .board-topic:hover { background: #1a1a2a; border-color: rgba(255,107,53,0.2); }
    .board-topic.active { border-color: var(--accent-orange); background: #1a1a2a; }
    .board-topic-title { color: var(--text-primary); font-size: 12px; font-weight: 600; }
    @media (min-width: 640px) { .board-topic-title { font-size: 13px; } }
    .board-topic-title > span { display: inline-block; }
    .board-topic-meta { color: #948d9e; font-size: 9px; margin-top: 2px; }
    @media (min-width: 640px) { .board-topic-meta { font-size: 10px; } }
    .board-filter { padding: 2px 8px; border-radius: 10px; font-size: 9px; cursor: pointer; color: #948d9e; border: 1px solid #2a2a3a; background: transparent; transition: all .15s; }
    @media (min-width: 640px) { .board-filter { font-size: 10px; padding: 2px 10px; } }
    .board-filter:hover { color: var(--text-secondary); border-color: #3a3a5a; }
    .board-filter.active { color: var(--accent-orange); border-color: var(--accent-orange); background: rgba(255,107,53,0.1); }
    .board-posts { max-height: 200px; overflow-y: auto; margin-bottom: 6px; }
    @media (min-width: 640px) { .board-posts { max-height: 250px; } }
    .board-post { padding: 4px 6px; border-radius: 6px; background: #0d0d15; margin-bottom: 4px; }
    @media (min-width: 640px) { .board-post { padding: 6px 8px; } }
    .board-post-header { color: #948d9e; font-size: 9px; display: flex; gap: 6px; flex-wrap: wrap; }
    @media (min-width: 640px) { .board-post-header { font-size: 10px; gap: 8px; } }
    .board-post-body { color: var(--text-secondary); font-size: 11px; margin-top: 2px; line-height: 1.4; }
    @media (min-width: 640px) { .board-post-body { font-size: 12px; } }
    .board-post-body p { margin: 0 0 4px 0; }
    .board-post-body p:last-child { margin-bottom: 0; }
    .board-post-body h1, .board-post-body h2, .board-post-body h3, .board-post-body h4 { color: var(--text-primary); margin: 6px 0 3px 0; font-weight: 600; }
    .board-post-body h1 { font-size: 13px; }
    .board-post-body h2 { font-size: 12px; }
    .board-post-body h3 { font-size: 11px; }
    .board-post-body h4 { font-size: 11px; color: var(--text-secondary); }
    .board-post-body ul, .board-post-body ol { margin: 3px 0 4px 0; padding-left: 16px; }
    .board-post-body li { margin: 2px 0; }
    .board-post-body code { background: #1a1a25; color: #e0e0f0; padding: 1px 3px; border-radius: 3px; font-family: monospace; font-size: 10px; }
    @media (min-width: 640px) { .board-post-body code { font-size: 11px; padding: 1px 4px; } }
    .board-post-body pre { background: #0a0a12; color: #c0c0d0; padding: 4px 6px; border-radius: 4px; overflow-x: auto; margin: 4px 0; }
    @media (min-width: 640px) { .board-post-body pre { padding: 6px 8px; } }
    .board-post-body pre code { background: transparent; padding: 0; }
    .board-post-body blockquote { border-left: 3px solid var(--accent-orange); padding-left: 6px; margin: 4px 0; color: var(--text-secondary); font-style: italic; }
    @media (min-width: 640px) { .board-post-body blockquote { padding-left: 8px; } }
    .board-post-body hr { border: none; border-top: 1px solid #2a2a3a; margin: 6px 0; }
    .board-post-body table { border-collapse: collapse; margin: 4px 0; font-size: 10px; width: 100%; }
    @media (min-width: 640px) { .board-post-body table { font-size: 11px; } }
    .board-post-body th, .board-post-body td { border: 1px solid #2a2a3a; padding: 2px 4px; text-align: left; }
    @media (min-width: 640px) { .board-post-body th, .board-post-body td { padding: 3px 6px; } }
    .board-post-body th { background: #1a1a25; color: var(--text-primary); font-weight: 600; }
    .board-post-body a { color: var(--accent-teal); text-decoration: underline; }
    .board-post-body strong { color: var(--text-primary); font-weight: 600; }
    .board-post-body em { color: var(--text-primary); font-style: italic; }
    .board-post-body br { line-height: 1.4; }
    .board-post-body del { color: #948d9e; }
    .fleet-msg-body { color: #e0e0f0; font-size: 11px; line-height: 1.4; }
    @media (min-width: 640px) { .fleet-msg-body { font-size: 12px; } }
    .fleet-msg-body p { margin: 0 0 3px 0; }
    .fleet-msg-body p:last-child { margin-bottom: 0; }
    .fleet-msg-body h1, .fleet-msg-body h2, .fleet-msg-body h3 { color: #ffffff; margin: 4px 0 2px 0; font-weight: 600; }
    .fleet-msg-body h1 { font-size: 12px; }
    .fleet-msg-body h2 { font-size: 11px; }
    .fleet-msg-body h3 { font-size: 11px; color: #c0c0d0; }
    .fleet-msg-body ul, .fleet-msg-body ol { margin: 2px 0 3px 0; padding-left: 14px; }
    .fleet-msg-body li { margin: 1px 0; }
    .fleet-msg-body code { background: rgba(255,255,255,0.08); padding: 0 2px; border-radius: 2px; font-family: monospace; font-size: 10px; }
    .fleet-msg-body pre { background: rgba(0,0,0,0.3); padding: 3px 4px; border-radius: 3px; margin: 2px 0; overflow-x: auto; }
    .fleet-msg-body pre code { background: transparent; padding: 0; }
    .fleet-msg-body strong { color: #ffffff; font-weight: 600; }
    .fleet-msg-body a { color: #4ade80; text-decoration: underline; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .fleet-msg-body br { line-height: 1.4; }
    .board-agent-badge { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 8px; font-weight: 600; }
    @media (min-width: 640px) { .board-agent-badge { font-size: 9px; padding: 1px 6px; } }
    .board-agent-vex { background: rgba(255,107,53,0.15); color: var(--accent-orange); }
    .board-agent-eliza { background: rgba(74,222,128,0.15); color: var(--accent-teal); }
    .board-agent-hermes { background: rgba(167,139,250,0.15); color: var(--accent-purple); }
    .board-agent-alice { background: rgba(96,165,250,0.15); color: var(--accent-blue); }
    .board-agent-kimi { background: rgba(251,191,36,0.15); color: var(--accent-yellow); }
    .board-input-wrap { display: flex; gap: 4px; }
    .board-input-wrap input { min-width: 0; width: 100%; padding: 5px 8px; border-radius: 6px; border: 1px solid #2a2a3a; background: #1a1a2a; color: var(--text-primary); font-size: 11px; outline: none; }
    @media (min-width: 640px) { .board-input-wrap input { padding: 6px 10px; font-size: 12px; } }
    .board-input-wrap input:focus { border-color: var(--accent-orange); }
    .board-tabs { display: flex; gap: 3px; margin-bottom: 6px; flex-wrap: wrap; }
    @media (min-width: 640px) { .board-tabs { gap: 4px; } }
    .board-tab { padding: 3px 8px; border-radius: 4px; font-size: 10px; cursor: pointer; background: #1a1a2a; color: #8b8ba0; border: 1px solid transparent; transition: all .15s; }
    @media (min-width: 640px) { .board-tab { padding: 4px 12px; font-size: 11px; } }
    .board-tab:hover { border-color: rgba(255,107,53,0.3); color: var(--text-primary); }
    .board-tab.active { background: rgba(255,107,53,0.15); color: var(--accent-orange); border-color: var(--accent-orange); }
    .board-new-topic { display: flex; gap: 4px; margin-bottom: 6px; }
    .board-new-topic input { flex: 1; padding: 5px 8px; border-radius: 6px; border: 1px solid #2a2a3a; background: #1a1a2a; color: var(--text-primary); font-size: 11px; outline: none; }
    @media (min-width: 640px) { .board-new-topic input { padding: 6px 10px; font-size: 12px; } }
    .board-new-topic input:focus { border-color: var(--accent-orange); }

    /* Campus Logo */
    .campus-logo { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 6px; overflow: hidden; flex-shrink: 0; }
    @media (min-width: 640px) { .campus-logo { width: 52px; height: 52px; border-radius: 8px; } }
    .campus-logo img { width: 100%; height: 100%; object-fit: cover; }
    .campus-logo svg { width: 100%; height: 100%; display: block; }

    /* Chat card */
    .chat-card { grid-column: 1 / -1; }
    .chat-input-wrap { display: flex; gap: 4px; flex-wrap: nowrap; }
    .chat-input-wrap input { min-width: 0; width: 100%; }
    @media (max-width: 480px) {
      .chat-input-wrap { flex-wrap: wrap; }
      .chat-input-wrap input#fleet-chat-name { width: 100%; flex-shrink: 0; }
      .chat-input-wrap input#fleet-chat-input { order: 3; width: 100%; }
    }

    /* Search & Filter */
    .controls { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.5rem; align-items: center; }
    @media (min-width: 640px) { .controls { gap: 0.75rem; margin-bottom: 1rem; } }
    .controls input { flex: 1; min-width: 0; padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: #0d0d15; color: var(--text-primary); font-size: 0.75rem; outline: none; transition: border-color .15s; }
    @media (min-width: 640px) { .controls input { min-width: 200px; padding: 0.6rem 1rem; font-size: 0.9rem; border-radius: 8px; } }
    .controls input:focus { border-color: var(--accent-orange); box-shadow: 0 0 0 3px var(--accent-orange-glow); }
    .controls select { padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: #0d0d15; color: var(--text-primary); font-size: 0.7rem; outline: none; cursor: pointer; transition: border-color .15s; }
    @media (min-width: 640px) { .controls select { padding: 0.6rem 1rem; font-size: 0.85rem; border-radius: 8px; } }
    .controls select:focus { border-color: var(--accent-orange); }
    .count { color: var(--text-dim); font-size: 0.7rem; white-space: nowrap; }
    @media (min-width: 640px) { .count { font-size: 0.85rem; } }

    /* Table */
    .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-card); -webkit-overflow-scrolling: touch; }
    @media (min-width: 640px) { .table-wrap { border-radius: 10px; } }
    table { width: 100%; border-collapse: collapse; font-size: 0.65rem; }
    @media (min-width: 640px) { table { font-size: 0.82rem; } }
    th { text-align: left; padding: 0.3rem 0.4rem; background: var(--bg-card-hover); color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.6rem; border-bottom: 1px solid var(--border); cursor: pointer; white-space: nowrap; }
    @media (min-width: 640px) { th { padding: 0.6rem 0.8rem; font-size: 0.72rem; } }
    th:hover { color: var(--text-secondary); }
    td { padding: 0.3rem 0.4rem; border-bottom: 1px solid rgba(255,255,255,0.03); vertical-align: top; }
    @media (min-width: 640px) { td { padding: 0.5rem 0.8rem; } }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .fn-name { color: var(--accent-blue); font-family: var(--font-mono); font-weight: 500; }
    .fn-method { display: inline-block; padding: 0.1rem 0.25rem; border-radius: 3px; font-size: 0.6rem; font-weight: 700; margin-right: 0.2rem; }
    @media (min-width: 640px) { .fn-method { font-size: 0.7rem; padding: 0.1rem 0.35rem; margin-right: 0.25rem; } }
    .method-GET { background: rgba(96,165,250,0.12); color: var(--accent-blue); }
    .method-POST { background: rgba(74,222,128,0.12); color: var(--accent-teal); }
    .method-PATCH { background: rgba(251,191,36,0.12); color: var(--accent-yellow); }
    .method-DELETE { background: rgba(248,113,113,0.12); color: var(--accent-red); }
    .tag-workflow { background: rgba(251,191,36,0.12); color: var(--accent-yellow); font-size: 0.6rem; padding: 0.1rem 0.25rem; border-radius: 3px; white-space: nowrap; }
    @media (min-width: 640px) { .tag-workflow { font-size: 0.65rem; padding: 0.1rem 0.35rem; } }
    .tag-simple { background: rgba(96,165,250,0.12); color: var(--accent-blue); font-size: 0.6rem; padding: 0.1rem 0.25rem; border-radius: 3px; white-space: nowrap; }
    @media (min-width: 640px) { .tag-simple { font-size: 0.65rem; padding: 0.1rem 0.35rem; } }
    .fn-inputs { color: #948d9e; font-size: 0.65rem; font-family: 'SF Mono', monospace; }
    @media (min-width: 640px) { .fn-inputs { font-size: 0.75rem; } }
    .fn-desc { color: #a0a0b0; font-size: 0.7rem; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (min-width: 480px) { .fn-desc { max-width: 180px; } }
    @media (min-width: 768px) { .fn-desc { max-width: 350px; } }
    .footer { margin-top: 1rem; text-align: center; color: #4a4a5a; font-size: 0.7rem; }
    @media (min-width: 640px) { .footer { margin-top: 1.5rem; font-size: 0.78rem; } }
    .loading { text-align: center; padding: 2rem; color: #948d9e; }
    @media (min-width: 640px) { .loading { padding: 3rem; } }
    .endpoint-url { color: #948d9e; font-size: 0.6rem; font-family: 'SF Mono', monospace; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (min-width: 480px) { .endpoint-url { max-width: 120px; font-size: 0.65rem; } }
    @media (min-width: 640px) { .endpoint-url { max-width: 200px; font-size: 0.7rem; } }
    .endpoint-url span { color: #a0a0b0; }
    .fn-method-cell { white-space: nowrap; }
    /* Mobile-first: hide less important columns on small screens */
    @media (max-width: 480px) {
      .fn-desc { display: none; }
      .endpoint-url { max-width: 60px; }
      .fn-inputs { display: none; }
      th:nth-child(4), td:nth-child(4) { display: none; } /* hide Description column */
      th:nth-child(5), td:nth-child(5) { display: none; } /* hide Endpoint column */
    }
    @media (max-width: 640px) {
      .hide-mobile { display: none; }
    }
    /* Collapse tools list on mobile — show count only */
    @media (max-width: 480px) {
      .tools-list-mobile { display: none; }
      .tools-count-mobile { display: inline; }
    }
    @media (min-width: 481px) {
      .tools-count-mobile { display: none; }
    }
    /* Quarterdeck responsive layout */
    /* minmax(0, 1fr), not 1fr.
       A '1fr' track's automatic minimum is 'min-content', so one nowrap log
       line or wide table inside Campus Watch was enough to push the column to
       924px inside a 360px viewport and give the whole page a horizontal
       scrollbar. minmax(0,1fr) removes that floor and lets the panel clip
       instead. Measured: the two sub-panels were 924px wide at 360px. */
    .quarterdeck-mid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-bottom: 10px; }
    .quarterdeck-mid > * { min-width: 0; }
    @media (min-width: 640px) { .quarterdeck-mid { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 10px; } }
    .quarterdeck-security { display: grid; grid-template-columns: 1fr; gap: 8px; margin-bottom: 10px; }
    @media (min-width: 640px) { .quarterdeck-security { grid-template-columns: 1fr; gap: 10px; } }
    .quarterdeck-bottom { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-bottom: 10px; }
    .quarterdeck-bottom > * { min-width: 0; }
    @media (min-width: 640px) { .quarterdeck-bottom { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr); gap: 10px; } }
    /* Responsive sub-grids for sections below the knowledge graph */
    /* Sub-grids respond to their CONTAINER, not the viewport.
       These used to be stepped by viewport media queries (1 col, then 2 at
       480px, then 3 or 4 at 768px). That was fine while every tile was
       full-bleed. It stopped being fine the moment the tiles became real grid
       columns: Campus Intelligence is now one column of four, roughly 330px
       wide inside a 1440px viewport, so at 768px+ the sub-grid still demanded
       THREE columns and crushed XMRT University to about 100px - its labels
       wrapped one character per line ("St at us", "14 modules availabl e")
       and Incoming Mail spilled over the tile edge.

       A viewport query cannot know how wide its container is. repeat(auto-fit,
       minmax(Npx, 1fr)) can, with no query at all: it fits as many Npx columns
       as the parent can actually hold. min-width:0 on the children stops a
       wide child re-inflating its own track. */
    /* Containment for content that is intrinsically wider than its column.

       Measured at an 800px viewport: three 170px inbox columns (EXECUTION,
       REVIEW, COMPLETION - built in dashboard.js) reaching x=924, 1100 and
       1276, and the Edge Functions table at 883px reaching x=925. All four
       stick out past the viewport, and because they are painted in document
       order they cover whatever sits beside them - which is how a neighbour
       ends up looking like it vanished when it is really underneath.

       overflow-x:auto makes the overflow scroll INSIDE its own box instead of
       escaping, so it can no longer paint over a sibling tile. */
    /* ── Email inbox columns ───────────────────────────────────────────────────
       resendTileHtml() emitted bare <div>s into a flex column. A flex item's
       automatic minimum is min-content, so each one sized itself to its content
       and sat at a fixed 170px no matter how narrow the tile became - measured
       reaching x=924, 1100 and 1276 in an 800px viewport, painting over their
       neighbours.

       Now a wrapping grid with minmax(0,1fr). minmax(0,...) rather than a bare
       1fr so the floor really is zero: a bare 1fr track's automatic minimum is
       min-content, which is the same trap one level down. No fixed width
       anywhere, so the columns reflow at every viewport. */
    .inbox-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
      gap: 8px;
    }
    .inbox-col { min-width: 0; }
    .inbox-list { max-height: 80px; overflow-y: auto; overflow-x: hidden; font-size: 0.75rem; min-width: 0; }
    .inbox-col .stat { flex-wrap: wrap; }
    .inbox-col .label, .inbox-col .value { min-width: 0; overflow-wrap: anywhere; }

    /* ── Page-level containment guard ───────────────────────────────────────
       Last line of defence, and the reason the layout is now width-independent
       rather than merely tested at a few widths: overflow-x:clip stops ANY
       descendant from painting outside the page box, so a future fixed-width
       element cannot hide a neighbouring tile or create a horizontal
       scrollbar. 'clip' rather than 'hidden' on purpose - it does not create a
       scroll container, so position:sticky keeps working. */
    html, body { overflow-x: clip; max-width: 100%; }
    .card, .card > div, .grid > * { min-width: 0; }

    #fn-catalog table { display: block; overflow-x: auto; max-width: 100%; }

    /* Campus Intelligence splits by CONTENT rather than by count: XMRT University
       and GitHub Activity are short fixed-height readouts and stack in the left
       column, Incoming Mail is a long scrolling list and gets the right column
       to itself. Laid out as three equal columns the tile was one tall narrow
       stack with dead space beside a very tall mail list. */
    .intel-split { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px; align-items: start; }
    .intel-split > * { min-width: 0; }
    .intel-left { display: grid; grid-template-rows: auto auto; gap: 8px; align-content: start; min-width: 0; }

    .subgrid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
    .subgrid-3 > * { min-width: 0; }
    .subgrid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
    .subgrid-4 > * { min-width: 0; }
    @media (min-width: 768px) { .subgrid-3, .subgrid-4 { gap: 12px; } }
    .sec-grid { display: grid; grid-template-columns: 1fr; gap: 4px; }
    @media (min-width: 480px) { .sec-grid { grid-template-columns: 1fr 1fr; } }
  
    /* The mesh canvas is the BACKGROUND, so it gets a negative z-index rather than
       being kept underneath by a whitelist.

       It used to be z-index:0 with body at z-index:0, which meant every piece
       of content had to be explicitly listed at z-index:10 to paint above it.
       That is a whitelist that has to be maintained forever, and it had already
       drifted: .status-strip was missed, so the canvas painted over it. Because
       the canvas is drawn progressively - filled opaque first, mesh lines after
       - the region looked right for a moment after load and then went black,
       while the mesh animation stayed visible on top of the black. That reads
       as "the card disappeared" rather than "something is painted over it".

       At z-index:-1 the canvas sits behind ALL in-flow content automatically,
       because body establishes the stacking context. New tiles cannot be missed
       because there is no list to add them to.

       body { position: relative; z-index: 0 } below is what makes this work: it
       creates the stacking context that -1 is relative to. */
    canvas#mesh-bg { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; }
    body { position: relative; z-index: 0; }
    /* Everything that must sit ABOVE the fixed mesh canvas.
       This is an explicit whitelist, not a rule of thumb, and that is the
       whole bug: canvas#mesh-bg is position:fixed with z-index:0, so any
       in-flow content that is not listed here paints BELOW it. A positioned
       element with z-index:0 paints above non-positioned content in the same
       stacking context.

       .status-strip and the Edge Functions link line were missing, so the mesh
       canvas drew over them. Because the canvas is painted progressively by
       JS, the region looked correct for a moment after load and then went
       black - which read as "the tile disappeared" rather than "something is
       painted on top of it".

       Anything added to the top level of <body> must be added here too. */
    .grid, h1, .subtitle, .table-wrap, .footer, .controls,
    .status-strip, .archive, .status-strip ~ div { position: relative; z-index: 10; }

    /* Kept even though the canvas is now at z-index:-1 and none of this is
       strictly required. It costs nothing, it keeps the existing tooltips and
       overlays explicitly above content, and it means a future change to the
       canvas cannot silently reintroduce the same class of bug. Every direct
       child of <body> is listed, including .status-strip and .archive, which
       is what the whitelist got wrong before. */
    body > *:not(.scanline):not(canvas#mesh-bg):not(script) { position: relative; z-index: 10; }

    /* ── Lumen Component Enhancements ── */
    /* Typography */
    h1, h2, h3 { font-family: var(--lumen-font-display); letter-spacing: -0.01em; }
    .card h3 { font-family: var(--lumen-font-display); }
    
    /* Card enhancements */
    .card { transition: border-color var(--lumen-transition), box-shadow var(--lumen-transition), transform var(--lumen-transition); }
    .card:hover { box-shadow: var(--lumen-shadow-md); }
    
    /* Button enhancements */
    button, .btn { font-family: var(--lumen-font-sans); transition: all var(--lumen-transition); }
    button:hover { box-shadow: var(--lumen-shadow-sm); }
    
    /* Badge enhancements */
    .badge { font-family: var(--lumen-font-mono); transition: all var(--lumen-transition); }
    
    /* Stat enhancements */
    .stat { transition: background var(--lumen-transition); }
    .stat:hover { background: var(--lumen-bg-hover); }
    
    /* Table enhancements */
    th { font-family: var(--lumen-font-sans); }
    td { font-family: var(--lumen-font-mono); }
    
    /* Animations */
    @keyframes lumen-fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes lumen-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    @keyframes lumen-shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    .lumen-animate-fade { animation: lumen-fade-in 0.3s ease forwards; }
    .lumen-animate-pulse { animation: lumen-pulse 2s ease-in-out infinite; }
    
    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--lumen-border-strong); border-radius: var(--lumen-radius-pill); }
    ::-webkit-scrollbar-thumb:hover { background: var(--lumen-text-muted); }
    
    /* Focus styles */
    :focus-visible { outline: 2px solid var(--lumen-accent); outline-offset: 2px; }
    
    /* Selection */
    ::selection { background: var(--lumen-accent-bg); color: var(--lumen-text); }

    /* ── Owner restart control ──────────────────────────────────────────────
       One row per supervised service, with the button the owner did not have
       until now.

       Deliberately NOT inside #qds-services-tracker. updateQDSupervisor
       rewrites that element's innerHTML every 10 seconds, which would wipe a
       button out from under a click and destroy any in-flight progress bar.
       These rows are built once per service and mutated in place.

       The bar uses visibility rather than display so the row does not reflow
       when progress starts — a bar appearing should not move the button the
       pointer is already travelling toward. */
    .qd-svc { display: grid; grid-template-columns: 8px minmax(0,1fr) auto 56px auto auto;
              align-items: center; gap: 5px; padding: 2px 3px; border-radius: 4px;
              font-size: 0.62rem; line-height: 1.5; }
    .qd-svc.danger { background: rgba(248,113,113,0.07); box-shadow: inset 2px 0 0 rgba(248,113,113,0.45); }
    .qd-svc.busy { background: rgba(251,191,36,0.08); }
    .qd-dot { width: 6px; height: 6px; border-radius: 50%; background: #4a4a5e; }
    .qd-dot.ok { background: #4ade80; box-shadow: 0 0 5px rgba(74,222,128,0.7); }
    .qd-dot.bad { background: #f87171; box-shadow: 0 0 5px rgba(248,113,113,0.7); }
    .qd-name { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qd-pid { color: var(--text-dim); font-family: var(--font-mono); font-size: 0.55rem; }
    .qd-bar { visibility: hidden; width: 56px; height: 3px; border-radius: 2px;
              background: rgba(255,255,255,0.09); overflow: hidden; }
    .qd-bar.show { visibility: visible; }
    .qd-bar i { display: block; height: 100%; width: 4%; border-radius: 2px;
                background: #fbbf24; animation: qd-fill 1.1s ease-in-out infinite; }
    /* A resolved bar stops animating and sits full. Full is not decoration: it
       is the only visual that distinguishes "confirmed" from "still trying". */
    .qd-svc.done .qd-bar i { background: #4ade80; animation: none; width: 100%; }
    .qd-svc.fail .qd-bar i { background: #f87171; animation: none; width: 100%; }
    @keyframes qd-fill { 0% { width: 4%; } 50% { width: 62%; } 100% { width: 4%; } }
    .qd-state { color: #948d9e; font-size: 0.55rem; white-space: nowrap; }
    .qd-state.work { color: #fbbf24; }
    .qd-state.done { color: #4ade80; }
    .qd-state.fail { color: #f87171; }
    .qd-btn { background: transparent; border: 1px solid #3a3a5a; color: #a1a1b5;
              border-radius: 3px; font-size: 0.55rem; padding: 1px 6px; cursor: pointer;
              white-space: nowrap; font-family: inherit; }
    .qd-btn:hover:not(:disabled) { border-color: var(--accent-orange); color: var(--accent-orange); }
    .qd-btn:disabled { opacity: 0.35; cursor: default; }

    /* ── The restart rows on a phone ────────────────────────────────────────
       Placed HERE, after the base .qd-svc rule, and that position is the whole
       point. The first version of this block sat up in the grid section, above
       .qd-svc. Equal specificity, so the LATER rule wins — which meant the
       desktop grid-template-columns kept applying while the areas from this
       block did land, giving six tracks laid out by three named areas. It
       looked half-applied because it was half-applied.

       Verified at 360px: two rows, 63px tall, 36px button (the 44px figure is
       a guideline for standalone controls; 36px is a defensible minimum for a
       dense list row and still clears the 24px floor comfortably). */
    @media (max-width: 560px) {
      .qd-svc {
        grid-template-columns: 8px minmax(0, 1fr) auto;
        grid-template-areas: "dot name btn" ". pid pid";
        row-gap: 2px;
        padding: 6px;
      }
      .qd-dot { grid-area: dot; }
      .qd-name { grid-area: name; font-size: 0.8rem; }
      .qd-pid { grid-area: pid; font-size: 0.7rem; }
      .qd-btn { grid-area: btn; min-height: 36px; padding: 4px 12px; font-size: 0.72rem; }
      .qd-bar { grid-area: pid; justify-self: start; width: 100%; margin-top: 3px; }
      .qd-state { grid-column: 1 / -1; font-size: 0.7rem; white-space: normal; }
    }

    .nexus-nav { display: flex; flex-wrap: wrap; justify-content: center; gap: 2px 16px;
      margin: 0.4rem auto 0.9rem; font-family: 'Space Mono', monospace; font-size: 0.68rem;
      letter-spacing: 0.12em; text-transform: uppercase; }
    .nexus-nav a { color: var(--text-muted); text-decoration: none; padding-bottom: 1px;
      border-bottom: 1px solid transparent; transition: color .15s, border-color .15s; }
    .nexus-nav a:hover { color: var(--text-primary); border-bottom: 1px solid var(--accent-orange); }

    /* Dynamic aside: hidden until an agent pushes content via the aside-push
       tool (loopback). 33% document/web/media pane, grid keeps the rest. */
    .main-split { display: flex; gap: 12px; align-items: flex-start; }
    .main-split > .grid { flex: 1 1 auto; min-width: 0; }
    #nexus-aside { display: none; }
    body.aside-open #nexus-aside { display: flex; flex-direction: column; flex: 0 0 33%; max-width: 33%;
      position: sticky; top: 10px; height: calc(100vh - 20px);
      background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    #nexus-aside .aside-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      border-bottom: 1px solid var(--border); font-family: 'Space Mono', monospace; font-size: 0.7rem;
      letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent-orange); }
    #nexus-aside .aside-head #aside-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #nexus-aside .aside-head #aside-by { color: var(--text-dim); font-size: 0.6rem; }
    #nexus-aside .aside-head button { background: transparent; border: 1px solid var(--border); color: var(--text-muted);
      border-radius: 4px; cursor: pointer; padding: 0 6px; font-size: 0.75rem; line-height: 1.4; }
    #nexus-aside .aside-head button:hover { color: var(--text-primary); border-color: var(--border-hover); }
    #nexus-aside .aside-body { flex: 1; overflow: auto; }
    #nexus-aside .aside-body iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
    #nexus-aside .aside-body img, #nexus-aside .aside-body video { width: 100%; height: 100%; object-fit: contain; display: block; background: #000; }
    #nexus-aside .aside-text { padding: 12px; font-size: 0.85rem; line-height: 1.5; color: var(--text-primary); }
    #nexus-aside .aside-text pre { white-space: pre-wrap; word-break: break-word; font-family: 'Space Mono', monospace; font-size: 0.75rem; }
    @media (max-width: 900px) {
      .main-split { flex-direction: column; }
      body.aside-open #nexus-aside { flex: none; max-width: 100%; width: 100%; height: 60vh; position: static; order: -1; }
    }

</style>
</head>
<body>
<div class="scanline"></div>
<canvas id="mesh-bg"></canvas>
  <h1><span class="campus-logo"><img src="/images/xmrtdao.png" alt="XMRT DAO"></span> XMRT Nexus <span>Command Center</span></h1>
  <div class="subtitle">
    <span style="color:var(--accent-orange);font-weight:600;">XMRT DAO</span> · <span title="XMRT Nexus — the Cuttlefish Protocol command center. Constitutional AI agents, TrustGraph scoring, and the Tributary AI Campus." style="cursor:help;border-bottom:1px dotted #ff8800;">XMRT Nexus</span> v11.0.0 · 
    <a href="https://relay.mobilemonero.com">relay.mobilemonero.com</a> ·
    <a href="https://github.com/xmrtdao/mobilemonero" target="_blank">GitHub</a>
  </div>
  <div style="text-align:center;margin-top:4px;font-size:0.75rem;color:var(--text-dim);">
    <a href="#fn-catalog" style="color:var(--accent-teal);">⚡ Edge Functions Catalog</a> &mdash; <span id="fn-catalog-count">checking&hellip;</span>
  </div>

  <nav class="nexus-nav">
    <a href="#command">Command</a>
    <a href="#comms">Comms</a>
    <a href="#trust">Trust</a>
    <a href="#galaxy">Galaxy</a>
    <a href="#dao">DAO</a>
    <a href="#mining">Mining</a>
    <a href="#campaigns">Campaigns</a>
    <a href="#mail">Mail</a>
    <a href="#board-full">Forum</a>
    <a href="#fn-catalog">Functions</a>
  </nav>

  <!-- Status strip. The question this page exists to answer is "is anything
       broken", and before this strip the answer was at y=1,141 — under the
       chat transcript and the trust chart. These four readouts are the same
       values the Campus Watch panel shows, mirrored up here rather than moved,
       so both stay live and neither becomes a second stale copy.

       The ids are ss-* so they cannot collide with the qds-* ids
       updateQDSupervisor() writes; it fills those in parallel. -->
  <div class="status-strip">
    <div class="ss-item">
      <span class="ss-label">Services</span>
      <span class="ss-value" id="ss-up" style="color:var(--accent-orange);">-</span>
    </div>
    <div class="ss-item">
      <span class="ss-label">Stack health</span>
      <span class="ss-value" id="ss-health">-</span>
    </div>
    <div class="ss-item">
      <span class="ss-label">Down</span>
      <span class="ss-value" id="ss-down">-</span>
    </div>
    <div class="ss-item">
      <span class="ss-label">Checked</span>
      <span class="ss-value" id="ss-checked">-</span>
    </div>
    <a class="ss-cta" href="#restart-control">⟳ Restart a service</a>
  </div>
  
  <div class="main-split">
  <div class="grid">
<div class="card chat-card tile-wide tile-p2" id="comms">
      <h3 style="color:var(--accent-orange);">Campus Comms <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Vex · Eliza-Cloud · Hermes</span></h3>
      <div id="fleet-chat-msgs" style="height:180px;overflow-y:auto;background:#0a0400;border-radius:6px;padding:8px;margin-bottom:6px;font-size:12px;line-height:1.5;">
        <div style="color:var(--text-dim);text-align:center;padding:20px 0;font-size:12px;">Campus comms active. All agents hear every broadcast.</div>
      </div>
      <div class="chat-input-wrap" style="gap:4px;">
        <input id="fleet-chat-name" type="text" placeholder="Your name..." style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:#0e0600;color:var(--text-primary);font-size:12px;outline:none;width:100px;flex-shrink:0;" maxlength="20"/>
        <input id="fleet-chat-agent" type="hidden" value=""/>
        <input id="fleet-chat-input" type="text" placeholder="Broadcast to the campus..." 
          style="flex:1;min-width:0;padding:6px 10px;border-radius:6px;border:1px solid #2a2a3a;background:#1a1a2a;color:#e0e0f0;font-size:12px;outline:none;"
          onkeypress="if(event.key==='Enter')sendFleetChat()">
        <label for="fleet-chat-file" title="Attach a file" style="padding:6px 10px;border-radius:6px;border:1px solid #2a2a3a;background:#1a1a2a;color:#a78bfa;cursor:pointer;font-size:14px;flex-shrink:0;display:flex;align-items:center;">📎</label>
        <input id="fleet-chat-file" type="file" style="display:none;" onchange="attachFleetFile(this)"/>
        <button onclick="sendFleetChat()" style="padding:6px 14px;border-radius:6px;border:none;background:#ff6b35;color:white;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;">Send</button>
      </div>
      <div id="fleet-chat-attach-status" style="font-size:10px;color:#a78bfa;margin-top:2px;min-height:14px;"></div>
      <div style="margin-top:4px;display:flex;gap:8px;font-size:11px;color:#948d9e;">
        <span>Campus broadcast — all agents hear your message</span>
        <span id="fleet-chat-status" style="color:#4ade80;">● connected</span>
      </div>
    </div>

<!-- 📈 Trust Trajectory — Full-width chart -->
<div class="card tile-wide tile-p3" id="trust">
  <h3 style="color:#a78bfa;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📈 Trust Trajectory
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Real-time TrustGraph scores over time · Hover any point for details</span>
  </h3>
  <div style="position:relative;">
    <canvas id="trust-trajectory-canvas" style="width:100%;height:200px;border-radius:6px;background:#08080e;cursor:default;"></canvas>
    <div id="trust-trajectory-tooltip" style="display:none;position:absolute;background:#1a1a2a;border:1px solid #3a3a5a;border-radius:6px;padding:8px 12px;font-size:11px;color:#e0e0f0;pointer-events:none;white-space:nowrap;z-index:100;max-width:400px;line-height:1.5;"></div>
  </div>
  <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center;font-size:0.6rem;color:#948d9e;">
    <span>● <span id="trajectory-agent-count">-</span> agents tracked</span>
    <span>● <span id="trajectory-event-count">-</span> total events</span>
    <span>● <span id="trajectory-range"></span></span>
    <span style="margin-left:auto;color:#4ade80;">● live</span>
    <span id="trajectory-toggle-btn" style="cursor:pointer;color:#60a5fa;font-size:0.6rem;margin-left:6px;padding:1px 6px;border:1px solid #3a3a5a;border-radius:3px;" onclick="toggleTrajectoryView()">🔍 Full View</span>
  </div>
</div>

<!-- ⚓ Quarterdeck — Consolidated Command Center -->
<div class="card tile-full tile-p1" id="command" style="border-color:rgba(255,107,53,0.2);">
  <h3 style="color:var(--accent-orange);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    🏛️ Campus Command
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— The Campus domain: rations, watch, bulletin, and vessels</span>
  </h3>

  <!-- Top row: Campus Rations (combined with Agent Experience) — full width -->
  <div style="margin-bottom:10px;">
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;border:1px solid var(--border);">
      <h4 style="color:var(--accent-purple);font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">🍺 Campus Rations <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Agent Rations · Trust Scores · Status · Experience</span></h4>
      <div id="rum-quota-content" style="display:flex;flex-direction:column;gap:2px;max-height:260px;overflow-y:auto;padding-right:8px;">
        <div class="stat"><span class="label">Loading agent ledger...</span></div>
      </div>
    </div>
  </div>

  <!-- Middle row: Campus Watch + Activity Log -->
  <div class="quarterdeck-mid">
    <!-- Campus Watch -->
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;border:1px solid var(--border);">
      <h4 style="color:var(--accent-yellow);font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">🔭 Campus Watch <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Eliza's Topside Watchdog</span></h4>
      <div id="quarterdeck-supervisor">
        <div class="stat"><span class="label">Supervisor</span><span class="value" id="qds-supervisor" style="color:#948d9e;">checking...</span></div>
        <div class="stat"><span class="label">Stack Health</span><span class="value" id="qds-health-score" style="color:#948d9e;">-</span></div>
        <div class="stat"><span class="label">Services Up</span><span class="value" id="qds-services-up" style="color:#948d9e;">-</span></div>
        <div class="stat"><span class="label">Services Down</span><span class="value" id="qds-services-down" style="color:#948d9e;">-</span></div>
        <div class="stat"><span class="label">Flapping</span><span class="value" id="qds-flapping" style="color:#948d9e;">-</span></div>
        <div class="stat"><span class="label">Task Issues</span><span class="value" id="qds-task-issues" style="color:#948d9e;">-</span></div>
        <div class="stat"><span class="label">Last Check</span><span class="value" id="qds-last-check" style="color:#948d9e;">-</span></div>
        <div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.6rem;color:var(--text-dim);">
          <div style="margin-bottom:2px;color:#8b8ba0;">Consolidated Services</div>
          <div id="qds-services-tracker" style="line-height:1.6;">-</div>
        </div>
        <!-- Owner restart control. Rows are built by dashboard.js from the same
             /api/supervisor/status payload as the chips above, so this list can
             never name a service the supervisor is not actually watching. -->
        <div id="restart-control" style="margin-top:6px;padding-top:6px;border-top:1px solid #1e1e2e;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span style="color:#8b8ba0;font-size:0.6rem;letter-spacing:0.05em;">RESTART CONTROL</span>
            <span style="color:#4a4a5e;font-size:0.55rem;">owner</span>
            <span style="margin-left:auto;font-size:0.55rem;color:#948d9e;">3/hour/service</span>
          </div>
          <div id="qds-restart-list" style="display:flex;flex-direction:column;gap:1px;">
            <div style="color:#948d9e;font-size:0.6rem;">loading services&hellip;</div>
          </div>
        </div>
        <div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.65rem;color:var(--text-dim);">
          <span style="color:#60a5fa;">⚡ relay</span> v7.0.0 · <span id="qds-relay-uptime">${uptimeStr}</span> · <span id="qds-tools">${toolCount}</span> tools · <span id="qds-handlers">${handlerCount}</span> handlers · <span id="qds-requests">${requestCounts.total}</span> req
        </div>
      </div>
      <div style="margin-top:4px;font-size:0.6rem;color:#948d9e;">
        <a href="/api/supervisor/status" style="color:#60a5fa;">API</a> · <span id="qds-refresh" style="color:#4ade80;">● polling</span>
      </div>
    </div>
    <!-- Activity Log (centralized log viewer) -->
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;border:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <h4 style="color:var(--accent-yellow);font-size:0.75rem;margin:0;text-transform:uppercase;letter-spacing:0.05em;">📡 Activity Log</h4>
        <div style="display:flex;gap:4px;align-items:center;">
          <select id="log-filter-type" style="background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border);border-radius:4px;padding:2px 4px;font-size:0.6rem;">
            <option value="">All Types</option>
            <option value="fleet_message">Fleet Msg</option>
            <option value="ai_chat">AI Chat</option>
            <option value="system_health_check">Health</option>
            <option value="tool_execution">Tool</option>
            <option value="edge_function">Edge Fn</option>
            <option value="cron_execution">Cron</option>
            <option value="email">Email</option>
            <option value="http_error">HTTP Error</option>
            <option value="db_error">DB Error</option>
            <option value="auth_failure">Auth</option>
          </select>
          <input id="log-search" type="text" placeholder="Search..." style="background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:0.6rem;width:100px;">
          <button onclick="refreshLogViewer()" style="background:var(--bg-card);color:var(--accent-blue);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:0.6rem;cursor:pointer;">↻</button>
        </div>
      </div>
      <div id="qds-activity-log" style="font-size:0.6rem;max-height:400px;overflow-y:auto;">
        <div class="stat"><span class="label">Loading activity...</span></div>
      </div>
    </div>
  </div>

  <!-- Training & Security row (own row) -->
  <div class="quarterdeck-security">
    <!-- TRAINING & SECURITY — TrustGraph · CAC Tiers · XMRT-DAO-CERT · Access Control -->
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;border:1px solid var(--border);">
      <h4 style="color:var(--accent-red);font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">🛡️ Training & Security <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— TrustGraph · CAC Tiers · XMRT-DAO-CERT · Access Control</span></h4>
      <div id="qds-security" style="font-size:0.6rem;">
        <div class="sec-grid">
          <div>
            <div class="stat"><span class="label">TrustGraph</span><span class="value" id="sec-tg-status" style="color:#4ade80;font-size:0.65rem;">● online</span></div>
            <div class="stat"><span class="label">Agents</span><span class="value" id="sec-agent-count" style="font-size:0.65rem;">19</span></div>
            <div class="stat"><span class="label">CAC Anchor</span><span class="value" id="sec-cac-anchor" style="color:#a78bfa;font-size:0.65rem;">2</span></div>
            <div class="stat"><span class="label">CAC Builder</span><span class="value" id="sec-cac-builder" style="color:#60a5fa;font-size:0.65rem;">7</span></div>
            <div class="stat"><span class="label">CAC Explorer</span><span class="value" id="sec-cac-explorer" style="color:#34d399;font-size:0.65rem;">7</span></div>
          </div>
          <div>
            <div class="stat"><span class="label">IAL Level</span><span class="value" id="sec-ial" style="color:#fbbf24;font-size:0.65rem;">IAL2</span></div>
            <div class="stat"><span class="label">Activity Events</span><span class="value" id="sec-activity-count" style="font-size:0.65rem;">-</span></div>
            <div class="stat"><span class="label">Trusted (≥80)</span><span class="value" id="sec-trusted" style="color:#4ade80;font-size:0.65rem;">2</span></div>
            <div class="stat"><span class="label">Cautious (40-79)</span><span class="value" id="sec-cautious" style="color:#fbbf24;font-size:0.65rem;">17</span></div>
            <div class="stat"><span class="label">Banned (&lt;40)</span><span class="value" id="sec-banned" style="color:#f87171;font-size:0.65rem;">0</span></div>
          </div>
        </div>
        <div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;">
          <div class="stat"><span class="label">Top Trust</span><span class="value" id="sec-top-agent" style="color:#4ade80;font-size:0.65rem;">loading...</span></div>
          <div class="stat"><span class="label">Lowest Trust</span><span class="value" id="sec-low-agent" style="color:#f87171;font-size:0.65rem;">loading...</span></div>
          <div class="stat"><span class="label">XMRT-DAO-CERT</span><span class="value" id="sec-cert-count" style="color:#fbbf24;font-size:0.65rem;">checking...</span></div>
          <div class="stat"><span class="label">🎓 University</span><span class="value" id="sec-uni-status" style="color:#a78bfa;font-size:0.65rem;">checking...</span></div>
          <div class="stat"><span class="label">Gate</span><span class="value" id="sec-gate" style="color:#4ade80;font-size:0.65rem;">● fail-closed</span></div>
        </div>
      </div>
    </div>
  </div>

    <!-- Full-width kanban task board row -->
    <div style="grid-column:1/-1;margin-bottom:10px;">
      <div style="background:#0a0a14;border-radius:6px;padding:8px;border:1px solid #1e1e2e;max-height:340px;overflow:hidden;">
        <h4 style="color:#60a5fa;font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">📋 Task Pipeline <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Fleet Task Board</span></h4>
        <div id="task-pipeline-content" style="height:290px;overflow-y:auto;font-size:0.55rem;"></div>
      </div>
    </div>

    <!-- Agent Vault — Agent Chests -->
    <!-- Collapsed by default. This rendered 1,810px — more than every other
         sub-tile in Campus Command combined — and it holds COMPLETED task
         artifacts. That is reference material, not a status readout, and it
         was pushing the things you actually watch further down the page.
         <details> is used rather than a JS toggle so it still works if
         dashboard.js fails to load, which on this page is not hypothetical. -->
    <details class="archive">
      <summary>📦 Agent Vault <span>— Agent Chests · Completed Task Artifacts</span></summary>
      <div style="margin-bottom:10px;">
        <div style="background:var(--bg-card);border-radius:6px;padding:8px;border:1px solid var(--border);">
          <div id="footlocker-content" style="font-size:0.75rem;">
            <div class="stat"><span class="label">Loading chests...</span></div>
          </div>
        </div>
      </div>
    </details>

    <!-- Bottom row: Campus Forum + Mesh Peers + LoRa Bridge -->
  <div class="quarterdeck-bottom">
    <!-- Campus Forum (bulletin board) -->
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;border:1px solid var(--border);max-height:160px;overflow-y:auto;">
      <h4 style="color:var(--accent-orange);font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;display:flex;justify-content:space-between;align-items:center;">
        <span>📜 Campus Forum <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Agent Resolutions &amp; Progress</span></span>
        <a href="javascript:void(0)" onclick="quickCreateBoardTopic()" style="color:var(--accent-teal);font-size:0.7rem;text-decoration:none;font-weight:700;cursor:pointer;" title="Create a new resolution">+ new</a>
      </h4>
      <div id="board-topics-list" style="font-size:0.65rem;"></div>
      <div style="margin-top:4px;padding-top:4px;border-top:1px solid var(--border);font-size:0.6rem;color:var(--text-dim);">
        <span id="qds-articles-count">-</span> resolutions · <a href="javascript:void(0)" onclick="loadBoard();renderBoardTopics();" style="color:var(--accent-blue);">Full Board</a>
      </div>
    </div>
        <!-- Mesh Peers -->
    <div style="background:#0a0a14;border-radius:6px;padding:8px;border:1px solid #1e1e2e;">
      <h4 style="color:#4ade80;font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">🌐 Mesh Peers <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Gossipsub Network</span></h4>
      <div id="qds-mesh-peers" style="font-size:0.6rem;max-height:80px;overflow-y:auto;">
        <div class="stat"><span class="label">Loading mesh...</span></div>
      </div>
    </div>
    <div style="background:#0a0a14;border-radius:6px;padding:8px;border:1px solid #1e1e2e;">
      <h4 style="color:#4ade80;font-size:0.75rem;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.05em;">📡 LoRa Bridge <span style="color:var(--text-dim);font-weight:400;font-size:0.6rem;">— Meshtastic Radio Link</span></h4>
      <div id="qds-lora" style="font-size:0.6rem;">
        <span>Bridge: <span id="qds-mt-bridge" style="color:#948d9e;">checking...</span></span><br>
        <span>Peers: <span id="qds-mt-peers" style="color:#948d9e;">-</span></span><br>
        <span>Msgs: <span id="qds-mt-msgs" style="color:#948d9e;">-</span></span>
      </div>
    </div>
  </div>
</div>

<!-- 🏛️ DAO & Ecosystem -->
<div class="card tile tile-p5" id="dao">
  <h3 style="color:var(--accent-teal);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    🏛️ DAO & Ecosystem
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Health · Membership · Ecosystem · Tools</span>
  </h3>
  <div class="subgrid-4">
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">❤️‍🔥 Health</div>
      <div class="stat"><span class="label">Local DB</span><span class="value" id="dao-health-status">checking...</span></div>
      <div class="stat"><span class="label">Health Score</span><span class="value" id="dao-health-score">-</span></div>
      <div class="stat"><span class="label">Fn Calls / 24h</span><span class="value" id="dao-fn-calls">-</span></div>
      <div class="stat"><span class="label">Agents</span><span class="value" id="dao-agent-count">-</span></div>
      <div class="stat"><span class="label">Tasks</span><span class="value" id="dao-task-count">-</span></div>
      <div class="stat"><span class="label">Services</span><span class="value" id="dao-service-status">-</span></div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🎫 Membership</div>
      <div class="stat"><span class="label"><a href="https://whop.com/xmrt-dao" target="_blank" style="color:#4ade80;text-decoration:none;">Free Tier</a></span><span class="value">free</span></div>
      <div class="stat"><span class="label"><a href="https://whop.com/checkout/plan_W6r4uqGWNaKHp" target="_blank" style="color:#ff6b35;text-decoration:none;">Premium</a></span><span class="value">$9.99/mo</span></div>
      <div class="stat"><span class="label"><a href="https://whop.com/checkout/plan_Wj1nh8AJhdsLN" target="_blank" style="color:#ff6b35;text-decoration:none;">Premium Yearly</a></span><span class="value">$99.99/yr</span></div>
      <div class="stat"><span class="label"><a href="https://whop.com/checkout/plan_n853GD3f5IXm0" target="_blank" style="color:#60a5fa;text-decoration:none;">Supporter</a></span><span class="value">$19.99</span></div>
      <div style="margin-top:4px;font-size:0.6rem;color:#948d9e;">Premium: 2x rewards · governance · early hardware</div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🌐 Ecosystem</div>
      <div class="stat"><span class="label"><a href="https://xmrtsolutions.vercel.app" target="_blank" style="color:#60a5fa;text-decoration:none;">XMRT Token Faucet</a></span><span class="value">testnet</span></div>
      <div class="stat"><span class="label"><a href="https://coldcash.vercel.app" target="_blank" style="color:#60a5fa;text-decoration:none;">ColdCash</a></span><span class="value">private payments</span></div>
      <div class="stat"><span class="label"><a href="https://pipuente.vercel.app" target="_blank" style="color:#60a5fa;text-decoration:none;">PiPuente</a></span><span class="value">cross-chain bridge</span></div>
      <div class="stat"><span class="label"><a href="https://paragraph.com/@xmrt" target="_blank" style="color:#60a5fa;text-decoration:none;">Paragraph Blog</a></span><span class="value">DAO journal</span></div>
      <div class="stat"><span class="label"><a href="https://sepolia.etherscan.io/token/0x77307DFbc436224d5e6f2048d2b6bDfA66998a15" target="_blank" style="color:#60a5fa;text-decoration:none;">XMRT Token</a></span><span class="value">0x7730...8a15</span></div>
      <div class="stat"><span class="label"><a href="https://github.com/xmrtdao" target="_blank" style="color:#60a5fa;text-decoration:none;">GitHub Org</a></span><span class="value">59 repos</span></div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🔧 Tools</div>
      <div class="stat"><span class="label">Relay Tools</span><span class="value" id="dao-tool-count">${toolCount}</span></div>
      <div class="stat"><span class="label">Edge Functions</span><span class="value" id="dao-fn-count">-</span></div>
      ${localFunctions.length > 0 ? '<div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.6rem;color:#4ade80;">Local: ' + localFunctions.map(f => f.name).join(', ') + '</div>' : ''}
      <div style="margin-top:4px;padding-top:4px;border-top:1px solid #1e1e2e;font-size:0.6rem;color:#948d9e;">
        <a href="/health" style="color:#4ade80;">Health</a> · <a href="/status" style="color:#60a5fa;">Status</a> · <a href="/tools" style="color:#60a5fa;">Tools</a> · <a href="/monitor" style="color:#60a5fa;">Monitor</a>
      </div>
    </div>
  </div>
</div>

<!-- 🪐 xmrt-galaxy — Knowledge Graph -->
<div class="card tile tile-p4" id="galaxy">
  <h3 style="color:var(--accent-purple);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    🪐 xmrt-galaxy
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— ecosystem map with live trust scores</span>
  </h3>
  <div style="position:relative;">
    <canvas id="obsidian-graph-canvas" style="width:100%;height:50vh;min-height:240px;max-height:500px;border-radius:6px;background:#08080e;cursor:grab;touch-action:none;"></canvas>
    <div id="graph-tooltip" style="display:none;position:absolute;background:#1a1a2a;border:1px solid #3a3a5a;border-radius:6px;padding:6px 10px;font-size:11px;color:#e0e0f0;pointer-events:none;white-space:nowrap;z-index:100;"></div>
  </div>
  <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center;">
    <button class="gc" id="b-orbit" style="background:rgba(107,107,128,0.04);border:0.5px solid rgba(107,107,128,0.12);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.4);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('orbit')">Orbit</button>
    <button class="gc" id="b-explode" style="background:rgba(107,107,128,0.04);border:0.5px solid rgba(107,107,128,0.12);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.4);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('explode')">Explode</button>
    <button class="gc on" id="b-labels" style="background:rgba(167,139,250,0.08);border:0.5px solid rgba(167,139,250,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(167,139,250,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('labels')">Idents</button>
    <button class="gc on" id="b-stream" style="background:rgba(167,139,250,0.08);border:0.5px solid rgba(167,139,250,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(167,139,250,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('stream')">Signal</button>
    <button class="gc on" id="b-tunnel" style="background:rgba(167,139,250,0.08);border:0.5px solid rgba(167,139,250,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(167,139,250,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('tunnel')">Tunnel</button>
    <button class="gc" id="b-fly" style="background:rgba(107,107,128,0.04);border:0.5px solid rgba(107,107,128,0.12);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.4);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('fly')">Free Fly</button> <button class="gc on" id="b-memory" style="background:rgba(244,114,182,0.08);border:0.5px solid rgba(244,114,182,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(244,114,182,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('memory')">Memory</button> <button class="gc on" id="b-sharedctx" style="background:rgba(45,212,191,0.08);border:0.5px solid rgba(45,212,191,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(45,212,191,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('sharedctx')">Shared</button> <button class="gc on" id="b-catalog" style="background:rgba(252,211,77,0.08);border:0.5px solid rgba(252,211,77,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(252,211,77,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('catalog')">Catalog</button> <button class="gc on" id="b-knowledge" style="background:rgba(163,230,53,0.08);border:0.5px solid rgba(163,230,53,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(163,230,53,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.toggleGraphEffect('knowledge')">Knowledge</button>
    <span style="color:#948d9e;font-size:9px;margin:0 4px;">|</span>
    <button style="background:rgba(107,107,128,0.08);border:0.5px solid rgba(107,107,128,0.22);padding:3px 10px;font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(107,107,128,0.65);cursor:pointer;font-family:monospace;transition:all 0.15s;border-radius:3px;" onclick="window.resetGraphView()">Reset</button>
    <span style="color:#948d9e;font-size:9px;margin:0 4px;">|</span>
    <span style="color:#4ade80;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">SPA</span>
    <span style="color:#60a5fa;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Back</span>
    <span style="color:#948d9e;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Agent</span>
    <span style="color:#4ade80;font-size:6px;">●</span><span style="color:#60a5fa;font-size:6px;">●</span><span style="color:#fbbf24;font-size:6px;">●</span><span style="color:#f87171;font-size:6px;">●</span><span style="color:#948d9e;font-size:6px;">●</span><span style="color:#948d9e;font-size:7px;">Trust</span>
    <span style="color:#fbbf24;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Infra</span>
    <span style="color:#ff6b35;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Sys</span>
    <span style="color:#f87171;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Email</span>
    <span style="color:#34d399;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">DB</span>
    <span style="color:#818cf8;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Mine</span>
    <span style="color:#f472b6;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Cert</span>
    <span style="color:#2dd4bf;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Cron</span>
    <span style="color:#67e8f9;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Edge</span>
    <span style="color:#93c5fd;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">EP</span>
    <span style="color:#c084fc;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">GH</span>
    <span style="color:#fcd34d;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Tun</span>
    <span style="color:#fdba74;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Camp</span>
    <span style="color:#948d9e;font-size:9px;">●</span><span style="color:#948d9e;font-size:8px;">Other</span>
    <span id="graph-node-count" style="color:var(--text-dim);font-size:9px;margin-left:auto;">-</span>
  </div>
</div>

<!-- 💰 Mining & Rewards -->
<div class="card tile tile-p6" id="mining">
  <h3 style="color:var(--accent-yellow);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    💰 Mining & Rewards
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Pool Stats · Leaderboard · Heartbeat</span>
  </h3>
  <div class="subgrid-3">
    <div style="background:var(--bg-card);border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:var(--accent-yellow);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">📒 Mining Ledger</div>
      <div class="stat"><span class="label">Pool Hashrate</span><span class="value" id="pool-hash">checking...</span></div>
      <div class="stat"><span class="label">Valid Shares</span><span class="value" id="pool-shares">-</span></div>
      <div class="stat"><span class="label">XMR Paid / Due</span><span class="value" id="pool-xmr">-</span></div>
      <div class="stat"><span class="label">Pool Global Hashrate</span><span class="value" id="pool-global-hash" style="color:#818cf8;">-</span></div>
      <div class="stat"><span class="label">Pool Miners</span><span class="value" id="pool-total-miners" style="color:#818cf8;">-</span></div>
      <div class="stat"><span class="label">Treasury (85%) / Ops (15%)</span><span class="value" id="pool-treasury" style="color:#fbbf24;">-</span></div>
      <div class="stat"><span class="label">Status</span><span class="value" id="pool-health" style="color:#818cf8;">-</span></div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🏆 Leaderboard</div>
      <div style="margin-bottom:4px;font-size:10px;color:#948d9e;">Live hashrate · shares · XMRT rewards</div>
      <div id="miner-leaderboard"><div class="stat"><span class="label">Loading...</span></div></div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#fbbf24;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">💓 Heartbeat</div>
      <div style="background:#0d0d15;padding:0.4rem 0.6rem;border-radius:4px;font-family:monospace;font-size:0.7rem;color:#60a5fa;word-break:break-all;" id="heartbeat-url">loading...</div>
      <div style="color:#948d9e;font-size:0.65rem;margin-top:0.3rem;">POST: {"agent_id":"...","status":"ONLINE","tunnel_url":"...","hashrate":0}</div>
      <div style="margin-top:6px;padding-top:6px;border-top:1px solid #1e1e2e;">
        <pre style="background:#0d0d15;padding:0.4rem;border-radius:4px;font-size:0.65rem;overflow-x:auto;color:#a0a0b0;white-space:pre-wrap;word-break:break-all;margin:0;cursor:pointer;" id="mining-script" onclick="copyMiningScript()">curl -o signup.py -L https://raw.githubusercontent.com/xmrtdao/mmlauncher/main/scripts/mobile-signup.py && sha256sum signup.py && python3 signup.py</pre>
      </div>
    </div>
  </div>
</div>

<!-- 📯 Campaigns & Leads -->
<div class="card tile tile-p7" id="campaigns">
  <h3 style="color:#60a5fa;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📯 Campaigns & Leads
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— PFP Campaign · PFP Leads · 31 Harbor</span>
  </h3>
  <div class="subgrid-3">
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#60a5fa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">📸 PFP Campaign</div>
      <div class="stat"><span class="label">Contact Pool</span><span class="value" id="pfp-pool">${poolSize}</span></div>
      <div class="stat"><span class="label">Sent Today</span><span class="value" id="pfp-sent-today">${sentToday}</span></div>
      <div class="stat"><span class="label">Sent Total</span><span class="value" id="pfp-sent-total">${campaignSent.length}</span></div>
      <div class="stat"><span class="label">Fresh Avail</span><span class="value" id="pfp-fresh">${freshAvailable}</span></div>
      <div class="stat"><span class="label">Last Run</span><span class="value" id="pfp-last-run">${campaignLastRun}</span></div>
      <div class="stat"><span class="label">Next Drop</span><span class="value" id="next-drop">-</span></div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#60a5fa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🎯 PFP Leads</div>
      <div class="stat"><span class="label">Total</span><span class="value" id="pfp-leads-total">-</span></div>
      <div class="stat"><span class="label">By Status</span><span class="value" id="pfp-leads-by-status" style="font-size:0.65rem;">-</span></div>
      <div class="stat"><span class="label">By Source</span><span class="value" id="pfp-leads-by-source" style="font-size:0.65rem;">-</span></div>
      <div class="stat"><span class="label">Hot (≥7)</span><span class="value" id="pfp-leads-hot">-</span></div>
      <div class="stat"><span class="label">Newest</span><span class="value" id="pfp-leads-newest" style="font-size:0.65rem;">-</span></div>
    </div>
    <div style="background:#0d0d15;border-radius:6px;padding:8px;">
      <div style="font-size:0.65rem;color:#60a5fa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🏠 31 Harbor</div>
      <div class="stat"><span class="label">Contact Pool</span><span class="value" id="harbor-pool">${harborPoolSize}</span></div>
      <div class="stat"><span class="label">Sent Today</span><span class="value" id="harbor-sent-today">${harborSentToday}</span></div>
      <div class="stat"><span class="label">Sent Total</span><span class="value" id="harbor-sent-total">${harborSentTotal}</span></div>
      <div class="stat"><span class="label">Fresh Avail</span><span class="value" id="harbor-fresh">${harborFresh}</span></div>
      <div class="stat"><span class="label">Last Run</span><span class="value" id="harbor-last-run">${harborLastRun}</span></div>
      <div class="stat"><span class="label">Next Drop</span><span class="value" id="harbor-next-drop">-</span></div>
    </div>
  </div>
</div>

<!-- 📬 Incoming Mail -->
<div class="card tile tile-p8" id="mail">
  <h3 style="color:var(--accent-red);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📬 Incoming Mail
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Resend inboxes</span>
  </h3>
  <div class="intel-split">
    <div class="intel-left" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">
      ${resendTileHtml()}
    </div>
  </div>
</div>

<!-- Browser tile — summons the dynamic aside pane with the browser chrome.
     The pane itself is not new (aside-push loopback below); what this adds
     is the manual on-demand entry point and the harness shortcuts. -->
<div class="card tile tile-p8" id="browser">
  <h3 style="color:var(--accent-orange);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    🌐 Browser
    <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— contained pane · drives the harnesses</span>
  </h3>
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
    <button onclick="openBrowserPane()" style="padding:6px 14px;border-radius:6px;border:none;background:#ff6b35;color:white;cursor:pointer;font-size:12px;font-weight:600;">Open Browser</button>
    <button onclick="openBrowserPane('http://127.0.0.1:4130/','OpenCode')" title="OpenCode coding agent, embedded via the loopback auth proxy" style="padding:6px 14px;border-radius:6px;border:1px solid #3a3a5a;background:transparent;color:#ff6b35;cursor:pointer;font-size:12px;">⌨️ opencode</button>
    <button onclick="openBrowserPane('http://127.0.0.1:4131/','DSH')" title="DeepSeek harness, embedded via the loopback auth proxy" style="padding:6px 14px;border-radius:6px;border:1px solid #3a3a5a;background:transparent;color:#ff6b35;cursor:pointer;font-size:12px;">🌊 dsh</button>
  </div>
  <div style="margin-top:6px;font-size:10px;color:#948d9e;">
    Agents push pages here with <code>aside-push</code> → <code>/browser?u=…</code> · harnesses are loopback, view from the host laptop
  </div>
</div>

<!-- Campus Forum Full Board -->
<div id="board-full" class="card tile-wide tile-p9" style="margin-top:0.5rem;">
  <h3 style="color:var(--accent-yellow);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    📜 Campus Forum <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem;">— Full Bulletin Board</span>
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
          <span id="board-current-topic-assignment" style="font-size:10px;color:#948d9e;"></span>
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
      <div style="margin-top:4px;font-size:10px;color:#948d9e;">
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
  <div style="margin-top:4px;display:flex;gap:8px;font-size:10px;color:#948d9e;">
    <span>Agents can post to any resolution — persistent across sessions</span>
    <span id="board-updated-indicator" style="color:#fbbf24;display:none;">* new activity</span>
    <span id="board-status-full" style="color:#4ade80;">● loaded</span>
  </div>
</div>
  </div>
  <aside id="nexus-aside" aria-label="Aside panel">
    <div class="aside-head">
      <span id="aside-title">Aside</span>
      <span id="aside-by"></span>
      <button onclick="asideClose()" title="Close aside">✕</button>
    </div>
    <div class="aside-body" id="aside-body"></div>
  </aside>
  </div><!-- /main-split -->
<!-- Edge Function Catalog -->
  <!-- Collapsed by default. This was 11,888px of table — 70% of the entire
       page — sitting below the fold, so the page was 17,034px long and the
       answer to "is anything broken" was somewhere above the midpoint. It is
       a lookup table for 252 endpoints, not a status readout; the link at the
       top of the page still jumps straight here and opens it. -->
  <details class="archive" id="fn-catalog" style="margin-top:1.5rem;width:100%;box-sizing:border-box;">
    <summary>☁️ Edge Functions <span>— 252 endpoints · lookup table</span></summary>
    <div class="card" style="width:100%;box-sizing:border-box;margin-top:0.75rem;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;flex-wrap:wrap;gap:0.5rem;">
      <h2 style="color:#ff6b35;font-size:1.1rem;">☁️ Edge Functions <span id="fnCount" style="color:#948d9e;font-weight:400;"></span></h2>
      <div class="controls">
      <input type="text" id="search" placeholder="Search functions…" oninput="filterFunctions()">
      <select id="methodFilter" onchange="filterFunctions()">
        <option value="">All Methods</option>
        <option value="GET">GET</option>
        <option value="POST">POST</option>
        <option value="PATCH">PATCH</option>
        <option value="DELETE">DELETE</option>
      </select>
      <select id="typeFilter" onchange="filterFunctions()">
        <option value="">All Types</option>
        <option value="simple">Simple</option>
        <option value="workflow">Workflow</option>
      </select>
      <span class="count" id="resultCount"></span>
    </div>
  
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th onclick="sortBy('name')">Function ↕</th>
            <th onclick="sortBy('methods')">Method</th>
            <th onclick="sortBy('type')">Type ↕</th>
            <th onclick="sortBy('desc')">Description ↕</th>
            <th>Endpoint</th>
          </tr>
        </thead>
        <tbody id="fnBody">
          <tr><td colspan="5" class="loading">Loading function catalog…</td></tr>
        </tbody>
      </table>
    </div>
  </div>
  </div>
  
            <div class="footer">
              <span style="color:var(--accent-orange);font-weight:600;">XMRT DAO</span> &middot; <span style="color:var(--accent-teal);">&#x26a1;</span> Vex &middot; ${new Date().toISOString()} &middot;
              <a href="https://github.com/xmrtdao" target="_blank" style="color:var(--text-dim);">GitHub</a> &middot;
              <a href="${tunnelUrl}" target="_blank" style="color:var(--text-dim);">Relay</a> &middot;
              Functions: ${supabaseUrl}/functions/v1/{name}
            </div>
            </div><!-- /card -->
  </details><!-- /fn-catalog -->

            <script src="/static/dashboard.js?v=${dashboardJsVersion()}"></script>

            <script src="/static/markdown.js"></script>
  
  
            </body>
            </html>`);
  };
}
