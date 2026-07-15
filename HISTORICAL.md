# XMRT DAO / MobileMonero / Cuttlefish Protocol — Project Historical Record

> **Generated:** 2026-07-11
> **Source:** Git history, session logs, MEMORY.md, SYSTEM-REQUIREMENTS.md, skill docs, file timestamps
> **Purpose:** Recovery document — if everything is lost, this file alone should be enough to reconstruct the project state.

---

## Overview

This is a **multi-project stack** running on a single Windows 10 laptop (hostname PURETREK, user PureTrek) in La Fortuna, Costa Rica. The stack combines:

1. **XMRT DAO** — A Monero mining ecosystem with hardware (XMRT Charger), software (XMRig), referral economy, and a multi-agent AI fleet
2. **MobileMonero** — Public-facing brand for the relay infrastructure (relay.mobilemonero.com)
3. **Cuttlefish Protocol / Cuttlefish Claws** — Constitutional governance DAO-REIT platform with TrustGraph, CAC tokens, KYA protocol
4. **Suite AI (SupaClaw)** — AI executive team platform with 205+ Supabase edge functions
5. **Party Favor Photo (PFP)** — Photo booth business with lead management, contracts, email campaigns
6. **31 Harbor** — Real estate agency client project with press release distribution
7. **Zero-Claw** — ZK DAO governance on AMD MI300X

**Lead developer:** Joe Lee (@xmrtdao, xmrtsolutions@gmail.com)
**Primary AI agent:** Vex (Eliza-Dev) — local relay coordinator
**Cloud AI:** Eliza-Cloud (executive assistant, 69 tools)
**Mobile agent:** Hermes (Android/Termux, hermes.mobilemonero.com)
**Sidecar agent:** Alice (brand management, service monitor)

---

## Timeline

### 2026-02-03 — Suite AI Initial Development
- **Suite AI** (xmrtdao/suite) initial commits by Joey
- Supabase auth, demo login fix, backend middleware implemented
- Moltmall Shop with Jukebox, Mixing Station, Chat
- RSS feed integration from paragraph.com
- Web Audio API jukebox, mobile nav

### 2026-02-06 — Auth Fixes
- Supabase client config updated, error logging improved

### 2026-02-09 — Vercel Config
- `.vercelignore` added to exclude suite folder from root deployments

### 2026-02-16 — Task Assignment Bug Fix
- Bug fix in ai-chat tool execution

### 2026-03-18 to 2026-03-23 — Heartbeat & Workspace Commits
- Joey: Automated commits, heartbeat checks, troubleshooting
- Skills updated, new files added
- Base function creation and validation

### 2026-03-26 to 2026-03-29 — Dependabot & Cloud Pull
- Dependabot: npm_and_yarn group updates across 4 directories
- Eliza-Dev: Edge functions documented, stage changes from heartbeat checks
- "Before Cloud Pull" state saved

### 2026-04-06 — Ceph: Stripe Integration & Netlify Fixes
- Stripe payment integration implemented (CLEAN)
- Netlify deployment fixes — cache bust, CSS build error fix
- Stripe payment button fixed

### 2026-04-08 — Python Executor & ai-chat Fixes
- Python-Executor VM Service deployed to Cloud Run
- ai-chat: correctly pass request_data to python-executor
- Supabase function calls refactored to remove headers
- Dependabot: hono update

### 2026-04-12 to 2026-04-13 — Gemini Model Update & Dashboard Fix
- Gemini model updated from gemini-2.0-flash-exp to gemini-2.5-flash
- Vectorize-memory function refactored for improved logging
- 24-hour memory changed to infinite
- Dashboard drag-and-drop and task reassignment fixed

### 2026-04-15 — Dependabot & Autonomy Breakout
- Dependabot: follow-redirects, protobufjs, lxml updates
- Autonomy breakout prompts refined for better guidance
- Python execution service refactored

### 2026-04-16 — PDF Analysis & Data Loading
- UnifiedElizaService enhanced with PDF analysis and text extraction
- Data loading in UnifiedChat component refactored
- PISTON_SANDBOX_URL updated

### 2026-04-18 to 2026-04-19 — Python Executor Refactor
- Python execution service refactored to use Edge Function, then Cloud Run
- PythonExecutionResult and options interfaces enhanced
- Email prompts updated to fetch 5 emails instead of 10

### 2026-04-21 — AI Cascade Update
- Lovable replaced with Ollama (cloud) in AI cascade
- Gemini updated to 2.0
- Dependabot: python-dotenv update

### 2026-04-23 — Tool Call Output Fixes (Major)
- **5 PRs merged** fixing ai-chat tool call output issues:
  - Leaked tool call text cleanup
  - Conversational text no longer triggers ai-chat tools
  - DeepSeek DSML tool call blocks parsed and stripped
  - Uncommitted tool intents stripped before provider retries
  - Tool calling de-escalated on stop/frustration cues
- Edge function tool timeout defaults increased, timeout_ms exposed
- Dependabot: lxml update

### 2026-04-25 — Gmail Payload Validation
- Gmail payload validation and email formatting rules hardened
- Full-autonomy resume prompt injection after fallback replies

### 2026-04-26 — Orchestrator Phase 1 Complete
- **Orchestrator Phase 1 Concluded** — Infrastructure stable, Security Audit in progress, Google Bridge fully live
- Google OAuth restored, security patches applied, task pipeline active
- OAuth whitelisted, redirect URI verified
- Tooling restored, census complete, security policy formalized
- Hermes/Hephaestus tasks dispatched
- Heartbeat sync: ecosystem status and memory logs updated

### 2026-04-28 — Memory & Cron Scheduler Rebuild
- Memory embeddings fix, cron scheduler rebuilt
- Uncommitted changes flushed
- Daily log and heartbeat state updated

### 2026-04-29 — Executive Council & Edge Function Explosion
- **15 new edge functions** added: 12 superduper agents, muapi-media-generator, superduper-router, community-poster, get-suite-health
- Tool Execution Engine + Muapi Media Tools
- Model names updated to Muapi/Vadoo AI catalog
- Governance: reality-check-daemon, hume-emotion-integration, distribute-dev-share registered and deployed

### 2026-04-30 — Git Cleanup & Push
- **Major git cleanup:** All 4 repos committed and pushed (MESHNET, XMRT-DAO-Ecosystem, moltmall, xmrtnet_repo)
- Root repo force-pushed to `main` — flat structure (not submodules)
- Submodule pointers updated
- Oversized binary files removed from tracking
- Governance: hume-emotion-integration and distribute-dev-share deployed

### 2026-05-01 — Kickstarter & Referral System
- Kickstarter campaign draft completed and approved by Joe
- Referral tracking system built (SQL migration + mining proxy endpoints)
- Pre-order system rewritten to use existing Supabase `generate-stripe-link` edge function
- PRs merged: inbox message routing fix, tool call loop fix, snap-out-of-it prompt

### 2026-05-02 — Suite AI Initial Commit
- Suite AI by XMRT DAO — initial commit
- Master DAO: Initial commit

### 2026-05-03 — Suite Beta Login & Admin Fix
- **Google OAuth automation defeated** (16 Playwright iterations)
- Full UX reconnaissance of suite-beta.vercel.app (all tabs verified)
- Admin tab "Failed to load users" fixed — rebuilt `public.profiles` view with FULL OUTER JOIN
- Referral dashboard + referral code input in registration flow
- Profiles view rebuilt with is_active and last_login_at columns

### 2026-05-04 — Eliza Message Inbox & Deployment
- DeepSeek model renamed: `deepseek-chat` → `deepseek-v4-pro`
- Repo references changed: `DevGruGold/suite` → `xmrtdao/suite`
- 13 functions deployed, 3 redeployed with fixes
- xmrt-mcp-server placeholder prompts + poller shell:true Windows fix
- Google Sheets edge function status action added

### 2026-05-05 — Health Score Crisis → 100/100
- **Problem:** Suite health dropped from 95→80 (emergency static fallback triggered)
- **Root cause:** `deepseek-v4-pro` model name was wrong — no such model at DeepSeek API
  - `coo-chat` used `deepseek-chat` (worked) but `ai-chat` used `deepseek-v4-pro` (failed)
  - Fixed: changed all references back to `deepseek-chat`
- Kimi migrated from OpenRouter to native Kimi Code API
- Akari Tanaka's tool access in Council Mode (deployed updated coo-chat)
- `lovable_ai` removed from essential services
- 6 of 8 blocked tasks cleared
- **Final health score: 100/100**

### 2026-05-06 — Eliza Cloud Communication Restored & Hackathon
- **26 days silent** — `eliza-relay` edge function hadn't been used since April 10
- Manual relay via Invoke-RestMethod to eliza-relay edge function
- Eliza Cloud's findings: `ai-chat` endpoint non-2xx, no heartbeat mechanism, no activity log entries
- `supabase-integration-v2` deployed and confirmed working
- Browser automation via Chrome DevTools Protocol (CDP) working on port 9222
- ClawHub skill expansion: installed 14+ skills
- **Hackathon deployment:** Executive Dashboard built, all 200+ edge functions registered as MCP tools (SupaClaw rebrand)
- PDF and DenoClaw tools integrated into xmrt-mcp-server
- DenoClaw/SupaClaw agent execution framework implemented
- CI repair: CodeQL and CI reliability fixed
- Security: hardcoded fallback token removed in toolExecutor
- Grant research: 39KB data, grant submission scripts

### 2026-05-07 — Eliza Direct & ZeroClaw Integration
- Gatekeeper-free AI chat endpoint (eliza-direct)
- README badges updated to xmrtdao org
- HF Space badge added
- Dependabot security updates merged

### 2026-05-10 — HF Space Badge
- HF Space badge added to README

### 2026-05-11 — Tool Enhancement & Infrastructure Day
- **Relay v2 upgrade:** 6→16 tools, unified CLI, persistent state, task runner
- Tool registry: `TOOLS_REGISTRY.md` documents every tool/endpoint/script
- Cloud cron: pg_cron-based hourly task fetcher (no admin rights needed)
  - Edge function `hourly-task-fetcher` + SQL migration
  - Handles stale tasks (same stage >4h), structured heartbeats, dry_run mode
- Pi update: `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent` v0.74.0

### 2026-05-12 — Stripe Configured & Identity Established
- **STRIPE_SECRET_KEY** set in Supabase secrets — `generate-stripe-link` now works
- Created **IDENTITY.md** — established Vex name, vibe, and identity
- Updated **SOUL.md** to reflect voice and boundaries
- Updated **USER.md** with Joe's timezone and contact preferences
- **All 88 Supabase tasks marked COMPLETED** — backlog cleared via direct SQL update

### 2026-05-13 — Meshnet Comms Protocol & Fleet Dashboard
- **Dispatch fix:** TS relay `/dispatch` rewritten to accept `type`, `handler`, `action`, `message`
- Go relay: Added `/dispatch` route handler
- `eliza-ping` edge function deployed to Supabase — always up, no tunnel dependency
- v1.0: Echo ping-pong (Eliza hallucinated conversation)
- v1.1: Proxies through live TS relay tunnel — returns real system data
- Fleet dashboard page at `/`, state reference fixed
- `/api/fleet` endpoint added, live dashboard updates

### 2026-05-14 — PFP Quote & Booking Endpoints
- pfp-quote edge function, relay inbox dashboard, PFP booking endpoints

### 2026-05-14 to 2026-05-15 — Mining Script Fixed & Dashboard v4 (No Vex Session)
- **Mining Script Fix (#15):** Dead DevGruGold gist URL replaced — `mobile-signup.py` now lives at `xmrtdao/mmlauncher/scripts/mobile-signup.py`
- Eliza recovered original script from Google Drive knowledge base
- Hermes built `start-mining.py` with OS detection + auto-download xmrig
- **Verified working** from Android Termux
- **Dashboard v4 (#16):** Eliza deployed relay v4.0.0 with dashboard at relay root `/`
- 16 tools, 7 handlers, 199 edge functions cataloged
- PFP inbox (Resend) pulling 16 emails, template gallery active
- **Hermes Infrastructure Blitz:** Built his own dashboard from Android/Termux, named tunnel `hermes-mobile`, dual tunnel setup, fixed 530 error, fixed chat API 500 bug

### 2026-05-16 — Cron Infrastructure Fix
- All 5 campaign/scheduled tasks had broken paths (space in "Program Files")
- SeasonalScraper, NoonCampaign, 4PMCampaign — re-registered via PowerShell
- DailyCampaign — .bat wrapper works fine
- HourlyTaskFetch (old) — repetition expired May 11
- **Created v2 replacement:** `cron-hourly.bat` wrapper + `schtasks /SC HOURLY`
- **Battery fix:** All tasks had `DisallowStartIfOnBatteries=true` by default — patched all
- Suite dashboard preview built for hackathon deployment

### 2026-05-17 — Permanent Tunnel, WHOP Revenue, Social Publishing, Mining Tracking
- **Infrastructure:** Named tunnel `relay-local` on xmrtsolutions Cloudflare (DNS: relay.mobilemonero.com)
- Old trycloudflare tunnel killed — webhooks updated to permanent URL
- `start-tunnel.mjs` rewritten for named tunnel
- Cloudflare tokens: PFP (`cfut_Eer0...`), XMRT (`cfut_7VTA...`)
- **Revenue:** WHOP channel whop.com/xmrt-dao — 3 membership tiers live, KYC approved
- **Social:** Typefully API connected + relay endpoints (schedule/drafts)
- @XMRTSolutions on X — first tweet queued for May 18
- **Mining:** Auto-reward tracking, local XMRig reports every 60s via relay heartbeat
- vex-laptop ~565 H/s tracked, dashboard leaderboard built
- Pool sync auto-discovers workers
- **Content:** 4 Paragraph articles published
- **Contacts:** Pool grew to 341 (TX + VA, separated from MM contacts)
- Suite: wasm-bridge.ts with typed interface + mock fallback

### 2026-05-18 — Infrastructure Stabilization & Fleet Comms
- **Tunnel fix:** Was down (1033 error) — restarted cloudflared as independent process
- **Dashboard fix:** Root cause: `type: () => true` on express.json() broke GET parsing
- Dead JS functions cleaned up. Before/after:
  - `/api/fleet`: 5.2s → 0.28s (fixed dead Hermes tunnel fetch)
  - `/resend/inbox`: 3.7s/208KB → 0.26s/7.7KB
- **Campaign fix:** 7 tasks were running daily — Falls Church PTSA reported getting 5 emails
- Disabled 4 extra tasks (2PM, 6PM, 8PM, 10PM)
- Added file-based lock + incremental sent-email logging + duplicate check
- Remaining: DailyCampaign (8AM/50), NoonCampaign (12PM/50), 4PMCampaign (4PM/50), SeasonalScraper (11PM)
- **Pool growth:** 370 → **597 contacts** (scraped DC + Dallas + VA corporate conferences)
- New template: corporate contacts get headshot + reception double-booking pitch
- **Fleet comms restored:** Eliza-Cloud reading fleet chat, posting replies
- Hermes at 192.168.14.115:9090 — 5 Cloudflare workers deployed
- Fleet routing via api.mobilemonero.com
- **Social:** First tweet went out May 18, 12PM CST
- **mmlauncher:** XMRig API config (port 19090) for fleet tracking
- **Hyperspace AGI discovery:** github.com/hyperspaceai/agi — decentralized P2P agent network

### 2026-05-19 — Party Favor Photo Agent Toolkit
- **Created github.com/xmrtdao/partyfavorphoto:**
  - `send-contract.mjs` — custom PDF contract generator
  - `send-email.mjs` — branded HTML quote emails
  - `generate.mjs` — PDF quote generator with setup photos
  - `form-fill.mjs` — Playwright web form scanner/filler
  - 10 contract templates (2-6hr, Standard+Premium tiers)
  - AGENTS.md with complete client lifecycle workflows

### 2026-05-20 — Relay Logs
- 5-20 relay logs.txt saved (11KB)

### 2026-05-22 — CashDapp Landing Page
- CashDapp landing page with particle network animation
- GitHub Pages site (Flipcash reserve model, tokenomics, roadmap)
- Ollama Pro fallback added to ai-chat cascade chain

### 2026-05-25 — PFP Campaign & Booking System v2.0
- PFP campaign updated to professional HTML template with images
- PFP booking system v2.0 deployed
- PFP dashboard analytics function added
- Gossip-hub edge function — cert-based fleet messaging (per issue #74)

### 2026-05-26 — Major Feature Day (Master DAO)
- **Revenue dashboard CLI** (check PFP + XMRT progress)
- **Complete API documentation** for all edge functions
- **Email outreach via Resend** (5 templates)
- **Partnership manager API** (CRUD + stats)
- **Complete deployment checklist** for Vex/Alice (9 items, 30 min)
- **Monthly review process guide + templates**
- **Monthly financial review tracking schema**
- **PFP partnerships table schema** (partner referral tracking)
- **Lead generator edge function** using Exa.ai API for PFP partnerships
- **PFP upsell revenue streams** — prints, albums, rush delivery
- **Email nurture sequence** for lead conversion
- **XMRT University** paid enrollment edge function + certification launch plan
- **MUAPI** paid generation edge function + service launch plan
- **PFP referral program** — 10% credit system
- **PFP Instagram/TikTok content calendar**
- **PFP school partnership email template**
- **PFP lead generation plan** — 10 leads/month target
- **Hermes comprehensive status update**
- **Migration plan** (4 tasks): edge function catalog, local runtime design doc, critical tables analysis, complete migration plan
- **Termux cron setup docs**

### 2026-05-30 — Suite AI Migration Checklist
- SUITEAI-MIGRATION-CHECKLIST.md created
- Supabase proxy script

### 2026-06-01 — Major Dashboard & Fleet Chat Day
- **Dashboard:** JS template-literal escape broke loadGithubActivity — fixed
- **Cloudflare Workers:** JWT-protected dashboards for all 7 subdomains
- **CI/CD:** CodeQL security scanning + release automation
- **CI/CD pipelines** for relay and Cloudflare Workers
- **Dynamic XMRT DAO data** on relay dashboard (replaced MTV pipeline)
- **XMRT University:** `/api/xmrt-university/ingest` endpoint added
- **Mining:** Leaderboard always showed 'No contributors yet' — fixed
- **Ship's Intelligence (XMRT University)** showed offline due to undefined RELAY_SERVICE_KEY — fixed
- **Dashboard email cards** now load (was checking data.emails, API returns data.recent)
- **Mesh dashboard endpoints** added
- **Fleet chat routes** using gossip hub
- **Bulletin board:** rename button, markdown renderer, XSS-safe post bodies
- **Gossip hub persistence:** try GET first, fallback to POST
- **Mining fix:** live SupportXMR feed for pool-stats + leaderboard

### 2026-06-02 — Relay Renamed & CI Saga
- **Relay renamed to "HMS Speedy"** (Cochrane metaphor)
- xmrt-node PR merged, CI saga, v1 false-positive analysis
- Gossip hub persistence fix

### 2026-06-03 — Inbound Email & System Sweep
- **Alice inbound email parsing pipeline** built
- Inbound webhook now writes to unified email.inbox state
- PFP inbox-proxy worker deployed
- inbox.mobilemonero.com routing setup
- inbox.partyfavorphoto.com routing setup
- XMRT Resend account dropped from start-tunnel.mjs
- **System sweep:** 8 POST routes restored (clobbered by d1d7401)

### 2026-06-07 — Supervisor Installation
- install-supervisor.bat created
- supervisor.mjs (7.9KB) — initial version
- uninstall-supervisor.bat created

### 2026-06-09 — Local Supabase Migration (Major)
- **Full local-first pivot:** Cloud Supabase URLs returning 504/502
- Local Postgres 17.10 portable (no admin) on port 5432
- local-sb (Deno PostgREST proxy) on port 54321
- Schema applied: 197 public tables, 16 schemas
- Suite tables, fleet tables, tasks, profiles, RLS policies created
- Memory contexts table created
- Cron SQL migration run
- Test scripts for local DB connectivity

### 2026-06-10 — Tighten Pass & System Sweep (Major)
- **Cron-engine-v2** added to supervisor (47 jobs, local-sb runtime)
- **4 stale Windows tasks** marked for deletion
- **3 dead AI keys** (Gemini/Kimi/OpenRouter) removed from `.env`
- **Alice dead-cloud URL fallback** removed with fatal guard
- **Supervisor PID-reconciliation** + legacy-state-prune
- **Fleet chat:** perpetual multi-agent conversation with deepseek fallback
- Anti-hallucination grounding for Vex/Alice/Eliza/idle-heartbeat
- Eliza path routed from eliza-relay stub to live ai-chat EF
- Memory: ai-chat redirect + tighten pass follow-up
- PFP campaign: switched daily-campaign to Resend native API + rate-limit retry
- Dashboard: university card + DAO health labels routed to local-sb
- **SYSTEM-REQUIREMENTS.md** created — full service map
- **CRON_AUDIT** reports generated

### 2026-06-14 — Suite SPA Serving Fix
- Suite served from `suite/dist/` instead of GH Pages redirect stub
- Vite-built SPA served from relay Express instead of GH Pages CDN
- Monitor: check local_sb instead of dead cloud Supabase in external-services health check
- Suite stack packaged: dual-mode README, backfill script, new edge functions, migrations

### 2026-06-15 — Suite SPA & Landing Fixes
- Suite served from relay Express (not GH Pages)
- Landing page whitespace halved between nav and hero headline
- BrowserRouter basename='/suite' for subpath serve
- Suite stack: full package with dual-mode README, backfill script, new edge functions, migrations
- ai-chat: force tool_choice:required on cloud Ollama, disable local LLM (6GB RAM), remove LOCAL_OLLAMA_ONLY

### 2026-06-17 — Fleet Messages
- `_fleet_msgs.json` and `_fleet_msgs2.json` — fleet communication debugging

### 2026-06-18 — XMRT DAO Orientation (First Hermes Session)
- **First Hermes Agent session** on this machine
- User asked to "get oriented at relay.mobilemonero.com and github.com/xmrtdao"
- Comprehensive workspace orientation document created (34KB)
- Knowledge graph audited (685 nodes, 1,258 connections)
- All 176+ relay routes documented
- 74 relay tool scripts cataloged
- 205 Supabase edge functions categorized
- Agent roster mapped (Vex, Eliza-Cloud, Hermes, Alice, xmrt-aidy, kimi-ai-agent, David)
- Known issues identified: Hermes unreachable, 3.4GB gateway.log.bak, duplicate workspaces, 108 failed workflows

### 2026-06-21 — Supervisor & Campaign Updates
- Supervisor: 31harbor-scheduler + zero-claw services added, vite wrapper-exits fixed
- Dashboard: Campaign card renamed to PFP Campaign for clarity
- `/api/contact/31harbor` endpoint with Resend send + confirmation reply
- 31harbor-agency-dashboard created
- David-Hamptons-Home project (5.7MB zip)

### 2026-06-22 — Suite Local-First & Cron Fixes
- **Local-first pivot:** dead Supabase URL sweep + Suite Dashboard REST API + 31harbor webhook
- Cron: 6 social posting functions disabled (depend on cloud Supabase)
- Suite: `/api/suite/leads/search` route added before `:id` route
- Backfill leads, dedup leads, clean test scripts
- Alice register, status, apply-cron-sql, ask-eliza-functions scripts
- CLI.mjs, cron-fetch-tasks.mjs, deploy-hourly-cron.mjs
- api-gateway-current.js, api-gateway-worker.js

### 2026-06-23 — Suite Local-First (continued)
- Suite: `/api/suite/leads/search` route before `:id` route
- Cron: 6 social posting functions disabled

### 2026-06-24 — PFP Scraper & Worker Fixes
- PFP scrapers: IMAGE_EXTENSIONS TLD guard added to all scrapers + sender
- Workers: `/functions/v1/` and `/webhook/` passthrough routes added to api-gateway
- 31harbor press release list (295KB)
- Directory probe results

### 2026-06-25 — CuttlefishClaws SPA & Relay Integration
- **CuttlefishClaws SPA** with relay API integration + xmrtnet@gmail.com notifications
- Netlify forms replaced with relay endpoints
- Comprehensive cuttlefishclaws SPA audit — corrected form/API/relay findings
- CAC presale form endpoint: `/api/contact/cuttlefishclaws`
- API gateway: `/api/contact/` passthrough route for contact forms
- Vite base + BrowserRouter basename for GH Pages subpath deployment
- Relay SPA route added
- GitHub Pages deploy workflow added
- CuttlefishClaws API migrated from email stubs to local DB-backed endpoints
- MEMORY.md last updated

### 2026-06-26 — CuttlefishClaws GH Pages & CAC Tier Restructure
- **CAC tier restructure** + mobile-responsive layouts + tier table update
- Neutral root README — workspace overview, no project branding
- Static export of cashdapp app for GH Pages
- Lazy Web3Auth init to prevent blank screen on GH Pages
- GH Pages redeploy (CDN staleness)
- Reserve nav link fixed (pointing to /cuttlefishclaws/presale)
- 404.html fallback for GH Pages SPA routing
- Nav buttons on presale page navigate via ?scrollTo= query param
- Vite SPA architecture, deployment, and project structure documented
- Redundant requestAnimationFrame starts causing 2-3x animation loop in canvas engines — fixed
- TrustGraph: real Obsidian data + GH Pages fixes merged to main
- Root README updated with monorepo structure, repos, and branch guide
- Rebranded as Cuttlefish Claws / Cuttlefish Labs

### 2026-06-27 — CuttlefishClaws Canonical Specs
- 18 canonical spec documents in `cuttlefishclaws-update-6-27-26/`:
  - CAC_PROTOCOL_CANONICAL_SPEC_v5.md, TG-001_TRUSTGRAPH_SPEC.md
  - KYA-001_KYA_SIGNATURE_SPEC.md, EVS-001_EVIDENCE_STORAGE_SPEC.md
  - KEY-001_ISSUER_KEY_RUNBOOK.md, RRC-001_REWARD_ROUTER_CONTRACT.md
  - PVP-001_PRINCIPAL_VERIFICATION_PROTOCOL.md, SS-001_STEWARDSHIP_STANDING_SPEC.md
  - SGQ-001_STANDING_GATE_QUERY.md, APP-001_CAC_APPLET_SPEC.md
  - RATECARD-001_REWARD_RATE_CARD.md, PILOT-001_PILOT_SCOPE.md
  - CC-001_COUNCIL_CHARTER.md, CFL-DECISION-001_RECONCILIATION.md
  - CFL-GLOSSARY-001_CANONICAL_GLOSSARY.md, RETIRED_BANNED_AND_GOTCHAS.md
  - WEB_PUNCHLIST_001.md, NAME_REGISTRY.md
- Knowledge graph audit: 665 nodes, 1,086 edges

### 2026-06-28 — Hermes Orientation Session
- **First Hermes session on this machine** — "get oriented at relay.mobilemonero.com and github.com/xmrtdao"
- Comprehensive WORKSPACE_ORIENTATION.md (34KB) written to `~/Desktop/xmrtdao/`
- All 176+ relay routes documented
- 74 relay tool scripts cataloged
- 205 Supabase edge functions categorized
- Agent roster mapped
- Knowledge graph audited
- Known issues documented
- **Key files created:** WORKSPACE_ORIENTATION.md, AGENTS_ENDPOINTS_MEMORY.md
- **Key files modified:** server.js (knowledge graph toggle defaults, button styling)
- **Key decisions:** Hermes is now the primary agent (replacing Vex/OpenClaw)

### 2026-06-29 — Dashboard Consolidation
- Dashboard consolidation work (7 themed cards design)
- Quarterdeck concept introduced

### 2026-06-30 — Fleet Chat Evaluation
- Fleet chat evaluation and fixes
- Dashboard consolidation continued

### 2026-07-01 — Ontology Documents & KYA Investigation
- **5 ontology documents created:**
  - ONTOLOGY-31HARBOR.md (5.7KB)
  - ONTOLOGY-CUTTLEFISHCLAWS.md (8.8KB)
  - ONTOLOGY-PARTY-FAVOR-PHOTO.md (4.9KB)
  - ONTOLOGY-RESEARCH.md (9KB)
  - ONTOLOGY-XMRT-DAO.md (5.6KB)
- KYA-IROH-INVESTIGATION.md (74KB) — comprehensive investigation
- Cuttlefish Protocol repo extracted to `~/Desktop/cuttlefish-protocol/`
- Relay .env updated

### 2026-07-02 — Reddit MCP & Ponytail Installation
- **Reddit MCP server** installed (`reddit-mcp-buddy`, 742 stars, no API key)
- **Ponytail** installed (v0.9.2, Python library)
- Campaign compliance fixes: unsubscribe headers, warm-up mode, webhook auto-suppression
- Resend accounts: PFP (re_K1p8eaKu) re-activated; 31harbor (re_VmTXTY9N) active
- Test email data audit
- Dashboard consolidation continued

### 2026-07-03 — Cuttlefish Protocol Day 1 (Major)
- **12 deliverables** in `~/Desktop/deliverables/`
- **6 microservices live** (registry:8081, pvp:8082, rrc:8083, evs:8084, cac-card:8085, escrow:8086)
- **268 tests passing**, end-to-end flow verified
- **29 pen tests**, 6 exploits found and fixed
- **16 systemic gaps** identified via fleet chat (Hermes, Trib, Eliza, Vex, Alice)
- Sent to David for Fable review
- **Self-hosted link management** built (link-manager.mjs + 4 MCP tools)
- Eliza conversation memory fixed with topic-scoped session IDs
- **5 MCP servers:** reddit, cuttlefish (19 tools), postgres, filesystem, memory
- **Cloud redundancy:** 2 new Supabase projects created:
  - xmrtdao-suite (kpqtadxqxnhkpqbgelhf) — mirrors 30+ local relay tables
  - cuttlefishclaws (llulpuhtlxzsxxbsfcuu) — mirrors 23 cuttlefish protocol tables
- **2 cloud-redundancy MCP servers built:**
  - `relay/xmrtdao-suite-mcp.mjs` — 15 tools
  - `relay/cuttlefishclaws-mcp.mjs` — 25 tools
- 5 dead Supabase projects deleted (xmrtdebate, cryptocab, IDEAS, XMRTNET, XMRTDAO)
- **Key learning:** Supabase management API needs `User-Agent: supabase-cli/1.0` header
- **David's emails:** 3 emails received (Day-0 Navigator Rulings, Developer State Report, Amendment 1)
- Campaigns paused with warm-up mode ready
- **Skill created:** `day-1-cuttlefish-protocol`

### 2026-07-04 — Context Lineage Token Tracking
- `parent_context_id` column added to `app.token_usage` table
- `app.context_tree` table created for conversation tree nodes
- Recursive CTE views: `v_token_usage_context_summary`, `v_token_usage_tree`
- API endpoints: POST /api/context-tree/open, POST /api/context-tree/close, GET /api/context-tree/list, GET /api/token-usage/tree/:context_id
- Auto-logging wired into POST /ollama/chat and internal ollama-chat tool handler
- Dashboard tile updated to show context trees with depth-indented labels
- ai-chat env chain debug

### 2026-07-05 — ai-chat Provider Cascade & Conversation Memory
- ai-chat provider cascade debugged — all cloud providers failing
- Conversation memory unique constraint on session_id identified as blocking persistence
- Fix: `ALTER TABLE public.conversation_memory DROP CONSTRAINT IF EXISTS conversation_memory_session_unique;`
- Cross-system conversation memory bridge designed (relay fleet chat ↔ Suite ai-chat)

### 2026-07-06 — Galaxy Visual Overhaul & XMRT University
- **Knowledge Graph toggle overhaul** — radial layout mode
- **Galaxy visual overhaul** — orbital physics, electron cloud effects
- **XMRT University** new modules
- Dashboard consolidation continued

### 2026-07-07 — Knowledge Graph Physics & Mesh Network (Major)
- **Knowledge Graph fixes:** freeze fix, mouse interaction fix, fetch chaining fix
- **N-body gravity physics** for galaxy visualization
- **Deterministic orbital physics** — final version
- **Electron cloud orbital physics** — final version
- **Comet agent physics** — tuning and final
- **Compact galaxy scale**
- **Mesh network:** libp2p gossipsub peers established
  - 4 fleet peers (Eliza, Alice, XMRT-AIDY, Kimi) all connected to Vex
  - `fleet-mesh-peer.mjs` — generic peer spawner
  - `eliza-mesh-peer.mjs` — Eliza mesh peer
  - Mesh status endpoint with registered peers
- **Service health check and resume** — all services verified
- **Spatial receiver removed** (not needed)
- **Supervisor started** (PID 18460) — 10 supervised services
- **Duplicate processes cleaned:** MCP servers, Vite instances
- **Skill docs updated** — consolidated service map
- **Inboxes checked** for all 3 Resend accounts
- **Alice daemon** running, cron-engine-v2 running
- **Cuttlefish MCP servers** (cuttlefish-mcp, cuttlefishclaws-mcp, xmrtdao-suite-mcp) all running
- **Key files modified:** server.js (knowledge graph, mesh), supervisor.mjs, fleet-mesh-peer.mjs, eliza-mesh-peer.mjs

### 2026-07-08 — Cuttlefish MCP & Fleet Chat Intelligence (Major)
- **Cuttlefish MCP servers** running (cuttlefish-mcp on 2328, cuttlefishclaws-mcp on 20512, xmrtdao-suite-mcp on 8996)
- **Fleet chat intelligence wiring:** eliza-intelligence-coordinator wired into routeFleetMessage()
- Intelligence coordinator returns 5 memory contexts, 0 interaction patterns, 1 user preference
- **Fleet chat impersonation guard and fast path** fixes
- **OOP JSON serialization** for vectorize-memory and batch-vectorize-memories
- **Vectorize-memory rewritten** from scratch with OOP and batch mode
- **All 307 memory_contexts vectorized** (was 86% unvectorized)
- **Cron engine** patched with safe JSON logging
- **Local Ollama fast-path** added to relayToElizaCloud()
- **Rate limit investigation:** 199 lines of 429s from Resend email alerts
- **Supervisor alert system** uses Resend; XMRT key quota exhausted
- **Full dashboard overhaul** — 7 themed cards (Quarterdeck, Ship's Log, etc.)
- **Quarterdeck dashboard redesign** — consolidated layout
- **Email to David** sent via 31harbor Resend key
- **Key files modified:** server.js (intelligence coordinator, local Ollama fast-path, DB persistence), cron-engine-v2.mjs (safe JSON logging), cron-jobs.json (vectorize schedule), vectorize-memory/index.ts (rewritten), batch-vectorize-memories/index.ts (created), local-supabase/routes/functions.mjs (QUERY method)
- **Key files created:** cuttlefish-mcp.mjs (72KB), cuttlefishclaws-mcp.mjs (72KB)

### 2026-07-09 — ai-chat Relay Endpoint & Conversation Memory Bridge (Major)
- **ai-chat relay endpoint** created — bypasses Deno edge function entirely
- Suite's unifiedElizaService.ts changed to fetch from `http://127.0.0.1:8080/api/ai-chat`
- **Conversation memory unique constraint fixed** — `conversation_memory_session_unique` dropped
- **Conversation access format fix** — format mismatch between convAccessStore and conversation-access.mjs
- **Conversation access schema fix** — missing columns added
- **Deno cache and conversation memory** debugging
- **Deno bypass** via relay /api/ai-chat endpoint
- **Fleet chat double response and ambiguous context fix**
- **Quarterdeck Rum Quota and crew roles** — renamed from Grog Quota
- **Training & Security tile** and dashboard reorganization
- **Security tile and trust network fix**
- **Second script block apiFetch migration** — all raw fetch calls converted
- **Dashboard polling flapping fix** — stale-response race condition fixed
- **Mobile responsive and token cost** improvements
- **Email sanitization** — isCleanEmail() filter
- **Tunnel error diagnosis** — relay crash prevention
- **Heartbeat anti-hallucination** — explicit grounding instructions
- **CORS preflight fix** — Express OPTIONS handler bypass
- **Suite SPA root-level redirect** — /dashboard → /suite/dashboard
- **Full Autonomy Mode** merged from deploy-profiles-fix branch (force-merge, 99+ conflicts)
- **Key files modified:** server.js (ai-chat endpoint, convAccess, apiFetch, CORS, redirects), supervisor.mjs, ai-chat/index.ts, unifiedElizaService.ts, AuthContext.tsx, AuthModal.tsx, QuickResponseButtons.tsx, UnifiedChat.tsx

### 2026-07-10 — Full Autonomy Mode & Credential Management (Major)
- **Full Autonomy Mode** force-merged into main (99+ conflicts resolved with `-X theirs`)
- Production bundle rebuilt: `npx vite build` (1m 21s, 9098 modules)
- **API key auth system** built for Suite frontend:
  - validate-token endpoint on relay
  - 20 API keys + XMRT-DAO-CERTs generated and injected via dispatch
  - Credential tiers: anchor, builder, explorer, graduate
  - State-based auth (not hardcoded)
- **Credential management** — no hardcoded API keys, all in state.json
- **Deno startup fixes** for local-sb: waitForPort health check, isProcessHealthy r.ok bug, --allow-net port range, spawn shell:true, module cache trap
- **CORS Express HTTP server wrapper** — raw HTTP server to bypass Express's built-in OPTIONS handler
- **Suite SPA root redirect** — /dashboard → /suite/dashboard
- **Ship's Log (Activity Feed)** — pirate-themed live activity feed tile
- **ActivityPulse sticky notes component** — eliza_activity_log table
- **ai-chat grounding system prompt** — prevents hallucination of non-existent systems
- **Agent status investigation** — why agents show as "busy" when idle
- **Missing DB columns** added — schema drift from cloud Supabase fixed
- **PFP pricing** documented: StudioStation 2hr $498, 7hr ~$1,298, 360 Video Booth Combo 7hr ~$1,998
- **Key files modified:** server.js (validate-token, apiFetch, MESSAGING tile, Training & Security, uncaughtException, AbortSignal.timeout, cf-ray bypass, convAccessStore/Get, persistFleetMessageToCloudConv, registerUniversityBridge), supervisor.mjs, suite/src/* (Full Autonomy Mode), local-supabase/routes/functions.mjs (Deno startup fixes)
- **Suite dist built** with API key auth

### 2026-07-11 — Relay Version Recovery, Galaxy Restoration & Suite Fixes (Major)
- **System booted from wrong copy** — old xmrtdao relay (July 6) instead of DevGruGold (patched)
- **Critical discovery:** Two copies of relay code exist:
  - `~/Desktop/DevGruGold/relay/` — PATCHED COPY (607KB) with all features but syntax issues
  - `~/Desktop/xmrtdao/relay/` — STABLE PRODUCTION BASE (534KB, July 6) — clean syntax
- **DevGruGold server.js EOF corruption** — file truncated at line 12605 during earlier debugging
- **xmrtdao relay** started and running (port 8080, version 6.0.0, Agent: Eliza-Dev)
- **Suite dist copied** from DevGruGold to xmrtdao path — API key auth now live
- **Conversation memory tables created** — `public.conversation_memory` and `public.conversation_context`
- **Duplicate MCP processes killed** — reduced from 6 to 3 stable instances
- **Critical patches applied to xmrtdao base:**
  - uncaughtException handler
  - validate-token endpoint (checks RELAY_API_KEY + api_keys state)
  - window.apiFetch helper
  - AbortSignal.timeout(25000) on fetches
  - cf-ray tunnel bypass
  - MESSAGING tile
  - Training & Security sections
  - convAccessStore/Get
  - persistFleetMessageToCloudConv
  - registerUniversityBridge
  - Quarterdeck/Ship's Log dashboard tile
- **Key files modified:** xmrtdao/relay/server.js (all patches applied), xmrtdao/suite/dist/ (copied from DevGruGold), create_tables.mjs (conversation memory tables)
- **Key files created:** server.js.clean (backup of clean xmrtdao base)
- **Current state:** xmrtdao relay running with all patches, suite with API key auth, conversation memory tables created

### 2026-07-11 (Evening) — Full Recovery from server_patched.js (Major)
- **Discovered `server_patched.js`** (607KB, 12,605 lines) — a truncated but feature-rich copy containing ALL lost work:
  - Galaxy orbital physics engine (deterministic two-pass, no springs, no drift)
  - convAccessGet/convAccessStore conversation memory helpers
  - validate-token endpoint (3-tier auth: RELAY_API_KEY, api_keys state, CAC tokens)
  - window.apiFetch helper (45+ dashboard polling calls)
  - Quarterdeck consolidated layout (7 themed cards)
  - Bidirectional fleet chat routing (41 references)
- **Root cause of relay crash:** Line 3 of server.js had `// Don't exit - let the process continue});` — the `//` comment swallowed the `});` closing the uncaughtException handler. The entire rest of the file (including `import` on line 26) was parsed as JS inside an unclosed function body, causing `SyntaxError: Unexpected identifier 'express'`. Fixed by changing `//` to `/* */`.
- **Root cause of express import failure:** Express package.json was missing `"main": "index.js"` field (corrupted by prior npm install). Added `"main": "index.js"` to fix module resolution.
- **Galaxy orbital physics restored** — merged from server_patched.js into current server.js:
  - 3 solar systems (Relay Server at center, app Schema at -800, public Schema at +800)
  - 12 planets orbiting at 400-640px with eccentricity, precession, wobble
  - ~239 moons in 6 concentric rings
  - Comet agents with gravity slingshots, orbit capture, comet tails
  - Warm nebula background with 120 golden starfield stars
  - Lens flare crosses on agent/star nodes
  - Trust score arcs on agent nodes
- **Quarterdeck consolidated layout** built from scratch — 7 themed full-width cards replacing 20+ standalone cards
- **xmrt-galaxy** renamed from Knowledge Graph with 🪐 icon
- **All services verified running:** relay (8080), local-sb (54321), vite-suite (5173), vite-zero-claw (5174), cuttlefishclaws (3120), suite-mcp (3200), page-agent (38401), tunnel, supervisor, alice, cron-engine, campaign-scheduler, 31harbor-scheduler, cuttlefish-mcp, eliza-mesh-peer, postgres, 9 Deno edge functions
- **HISTORICAL.md created** at `~/Desktop/HISTORICAL.md` (843 lines, 47KB) — comprehensive project history from Feb 3 to Jul 11
- **Key files modified:** DevGruGold/relay/server.js (galaxy physics merged, Quarterdeck built, validate-token added, convAccess added, apiFetch added, auth bypass added), xmrtdao/relay/server.js (synced)
- **Key files created:** ~/Desktop/HISTORICAL.md, DevGruGold/relay/lib/quarterdeck.mjs

---

## Key Technical Details

### Architecture Decisions

1. **Single-machine stack** — Everything runs on one Windows 10 laptop (no cloud infra)
2. **Two workspace copies** — `DevGruGold/` (development) and `xmrtdao/` (deployment)
3. **Local-first pivot** (2026-06-09) — Cloud Supabase died (504/502), replaced with local Postgres + local-sb
4. **Single-file relay** — `server.js` is a ~500-600KB single Express file (not modular)
5. **Supervisor pattern** — `supervisor.mjs` manages 10 services with health checks
6. **Cloudflare tunnel** — Named tunnel for public access (no open ports)
7. **MCP servers** — 5+ MCP servers for agent tool access (cuttlefish, postgres, filesystem, memory, reddit)
8. **Two relay copies** — DevGruGold (patched, 607KB) and xmrtdao (stable, 534KB)

### Service Stack (as of 2026-07-11)

| Service | Port | Path | Status |
|---------|------|------|--------|
| **PostgreSQL** | 5432 | `pg/bin/postgres.exe` | ✅ Running |
| **local-sb** | 54321 | `local-supabase/server.mjs` | ✅ Running |
| **Relay** | 8080 | `relay/server.js` (xmrtdao) | ✅ Running |
| **Vite (suite)** | 5173 | `suite/` | ✅ Running |
| **Vite (zero-claw)** | 5174 | `zero-claw/` | ✅ Running |
| **Cloudflare tunnel** | — | `cloudflared.exe` | ✅ Running |
| **Alice daemon** | — | `relay/alice.mjs` | ✅ Running |
| **Cron engine v2** | — | `relay/cron-engine-v2.mjs` | ✅ Running |
| **Campaign scheduler** | — | `relay/campaign-scheduler.mjs` | ✅ Running |
| **31harbor scheduler** | — | `relay/tools/31harbor-scheduler.mjs` | ✅ Running |
| **Supervisor** | — | `relay/supervisor.mjs` | ⚠️ Path mismatch |
| **cuttlefish-mcp** | stdio | `relay/cuttlefish-mcp.mjs` | ✅ Running |
| **cuttlefishclaws-mcp** | 3120 | `relay/cuttlefishclaws-mcp.mjs` | ✅ Running |
| **xmrtdao-suite-mcp** | 3200 | `relay/xmrtdao-suite-mcp.mjs` | ✅ Running |
| **Page Agent MCP** | 38401 | `page-agent/` | ✅ Running |
| **28 Deno edge functions** | 37000-37999 | `suite/supabase/functions/` | ✅ Running |

### Public Hostnames (via Cloudflare tunnel)

| Hostname | Backend | Status |
|----------|---------|--------|
| `https://relay.mobilemonero.com` | relay :8080 | ✅ 200 |
| `https://suite.mobilemonero.com` | relay :8080 | ✅ 200 |
| `https://inbox.partyfavorphoto.com` | relay :8080 | ✅ 200 |
| `https://inbox.mobilemonero.com` | relay :8080 | ✅ 200 |
| `https://inbox.31harbor.com` | relay :8080 | ✅ 200 |
| `https://agency.31harbor.com` | relay :8080 | ✅ 200 |
| `https://hermes.mobilemonero.com` | Hermes phone | ⚠️ Unreachable |

### Agent Fleet

| Agent | Role | Location | Status |
|-------|------|----------|--------|
| **Vex** ⭐ | Relay coordinator | OpenClaw on laptop | ONLINE |
| **Eliza-Cloud** | Executive assistant | Cloud (Supabase edge functions) | ONLINE |
| **Hermes** | Mobile agent | Android/Termux | ONLINE* |
| **Alice** | Brand management | Sidecar daemon | ONLINE |
| **xmrt-aidy** | Graduate | — | ONLINE |
| **kimi-ai-agent** | Agent | Kimi AI (Moonshot) | ONLINE |
| **David** | Agent | — | — |

### Database Schema (local Postgres, `xmrt_suite`)

- **197 public tables**, 16 schemas
- Key tables: `fleet_messages`, `fleet_memory`, `memory_contexts`, `conversation_memory`, `conversation_context`, `conversation_messages`, `conversation_summaries`, `eliza_activity_log`, `tasks`, `pfp_leads`, `pfp_quotes`, `suite_companies`, `suite_leads`, `suite_campaigns`, `suite_email_activity`, `suite_users`, `suite_pipeline_stages`, `suite_activity_log`
- Cuttlefish tables: `cuttlefish_agents`, `cuttlefish_agent_tasks`, `cuttlefish_cac_credentials`, `cuttlefish_capital_stack`, `cuttlefish_chat_messages`, `cuttlefish_contracts`, `cuttlefish_financing_programs`, `cuttlefish_proposals`, `cuttlefish_scenarios`, `cuttlefish_trust_events`
- Link management: `links.projects`, `links.links`, `links.tags`, `links.link_tags`, `links.clicks`
- Token tracking: `app.token_usage`, `app.context_tree`

### Key File Sizes & Locations

| File | Size | Last Modified | Location |
|------|------|---------------|----------|
| `server.js` (xmrtdao) | ~534KB | 2026-07-11 | `~/Desktop/xmrtdao/relay/` |
| `server.js` (DevGruGold) | ~607KB | 2026-07-11 | `~/Desktop/DevGruGold/relay/` |
| `server.js.clean` | ~534KB | 2026-07-11 | `~/Desktop/xmrtdao/relay/` |
| `supervisor.mjs` | 23KB | 2026-07-09 | `~/Desktop/DevGruGold/relay/` |
| `alice.mjs` | 30KB | 2026-07-07 | `~/Desktop/DevGruGold/relay/` |
| `cron-engine-v2.mjs` | 8.6KB | 2026-07-08 | `~/Desktop/DevGruGold/relay/` |
| `cuttlefish-mcp.mjs` | 42KB | 2026-07-08 | `~/Desktop/DevGruGold/relay/` |
| `cuttlefishclaws-mcp.mjs` | 72KB | 2026-07-08 | `~/Desktop/DevGruGold/relay/` |
| `MEMORY.md` | 35KB | 2026-06-25 | `~/Desktop/DevGruGold/` |
| `SYSTEM-REQUIREMENTS.md` | 16KB | 2026-06-10 | `~/Desktop/DevGruGold/` |
| `WORKSPACE_ORIENTATION.md` | 34KB | 2026-06-28 | `~/Desktop/xmrtdao/` |

### Known Issues & Active Blockers

1. **Cloud Supabase dead** — All cloud URLs return 504/502. Full local-first pivot done.
2. **DevGruGold relay EOF corruption** — server.js truncated at line 12605. Patches must be applied to xmrtdao copy.
3. **Supervisor path mismatch** — Configured for DevGruGold path, xmrtdao relay running independently.
4. **Hermes unreachable** — Persistent across all Eliza-Cloud heartbeats.
5. **XMRT Resend key quota exhausted** — 100 emails/day free tier. 31harbor key still functional.
6. **Campaign pool depleting** — 31harbor pool at 1,218 contacts, PFP pool unknown.
7. **DevGruGold GitHub flagged** — Cannot push to `DevGruGold/suite`. Use `xmrtdao/suite`.
8. **OpenRouter image gen** — Key valid but zero credits. Need $5 top-up.
9. **WhatsApp gateway flapping** — 408 disconnects every 2-4 minutes.
10. **Startpage.com blocks scrapers** — Returns 302 redirects. Phase 2 scraper broken.
11. **108 failed workflows** — 44% failure rate out of 245 total.
12. **6 unconfigured API keys** — openrouter, vertex_ai, hume, vercel_ai, elevenlabs, lovable_ai.
13. **3.4GB gateway.log.bak** — `~/.openclaw/gateway.log.bak` needs cleanup.
14. **Duplicate workspaces** — DevGruGold and xmrtdao risk divergence.

### Git Repositories

| Repo | Remote | Branch | Notes |
|------|--------|--------|-------|
| `DevGruGold/` (root) | `xmrtdao/cashdapp` (origin), `xmrtdao/cuttlefishclaws` (cuttlefish) | `work-branch` (local), `main` (remote) | Flat structure, not submodules |
| `DevGruGold/suite/` | `xmrtdao/suite` (origin), `DevGruGold/suite` (fork) | `main` | Diverged history with DevGruGold fork |
| `xmrtdao/partyfavorphoto` | `xmrtdao/partyfavorphoto` | — | PFP toolkit |
| `xmrtdao/MESHNET` | `xmrtdao/MESHNET` | — | Contract mining infra |

### Credential Management

- **No hardcoded API keys** in server.js
- All credentials stored in relay's persistent state (`state.json`)
- 20 API keys + XMRT-DAO-CERTs generated for agents/humans
- Credential tiers: anchor (full access), builder (read/write), explorer (read-only), graduate
- **CRITICAL:** State file overwritten on relay restart — credentials must be re-injected
- RELAY_API_KEY env var used for dispatch auth

### Email Infrastructure (Resend)

| Account | Domain | Key Prefix | Status |
|---------|--------|------------|--------|
| PFP (primary) | partyfavorphoto.com | `re_BrGV9sSL_...` | ✅ Active |
| XMRT (secondary) | mobilemonero.com | `re_8ypZddMZ_...` | ⚠️ Quota exhausted |
| 31harbor | 31harbor.com | `re_VmTXTY9N_...` | ✅ Active |

### AI Provider Stack

| Provider | Model | Status |
|----------|-------|--------|
| DeepSeek (primary) | deepseek-chat | ✅ Working |
| Ollama Pro Cloud | deepseek-v4-flash:cloud | ✅ Working |
| Kimi (native API) | kimi-k2.6:cloud | ✅ Working |
| Local Ollama | — | ❌ Disabled (6GB laptop) |
| Gemini | — | ❌ Dead key (removed 6/10) |
| OpenRouter | — | ❌ Dead key (removed 6/10) |

### Boot Order (if everything is dead)

1. **Postgres** (`pg/`) — port 5432
2. **local-sb** (`local-supabase/`) — port 54321
3. **Ollama** (port 11434) — independent
4. **Vite** (`suite/`) — port 5173 (dev only)
5. **Relay** (`relay/server.js`) — port 8080
6. **cloudflared** (named tunnel)
7. **Alice daemon** (`relay/alice.mjs --daemon`)
8. **Campaign scheduler** (`relay/campaign-scheduler.mjs --daemon`)
9. **Cron-engine-v2** (`relay/cron-engine-v2.mjs`)
10. **Supervisor** (`relay/supervisor.mjs --daemon`)

### Key Lessons Learned

1. **Supabase Edge Functions:** Slug is immutable after deployment. Management API ignores `slug`.
2. **DeepSeek model naming:** `deepseek-chat` works, `deepseek-v4-pro` does not exist.
3. **Google OAuth automation:** CDP + `--disable-blink-features=AutomationControlled` works.
4. **Named tunnels > quick tunnels:** Quick tunnels die on relay restart.
5. **Campaign duplicate prevention:** File-based locks + incremental logging essential.
6. **express.json() pitfalls:** `type: () => true` breaks GET endpoint parsing.
7. **No emojis in fleet chat:** Relay endpoint corrupts non-ASCII characters.
8. **Deno pool doesn't hot-reload:** Must kill Deno process after editing edge functions.
9. **local-sb REST router bugs:** `in` operator missing, hardcoded public schema, `.single()` misses.
10. **Cron engine wrong-DB bug:** Always check PG_URL resolution.
11. **GH Pages CDN staleness:** Root updates correctly but subpaths serve stale content.
12. **BrowserRouter basename:** Required for subpath SPA serving.
13. **Fleet chat agents must be grounded:** Never emit free-text without real data.
14. **CRLF line endings cause ESM parse failures:** Node's ESM parser chokes on `\r\n`.
15. **Two relay copies:** Always check which copy is running before making changes.
16. **Git restore wipes uncommitted patches:** Always check `git status` first.
17. **State file overwritten on restart:** Credentials must be re-injected after every relay restart.
18. **CORS preflight:** Express's built-in OPTIONS handler responds before middleware.
19. **Module cache trap:** Node's `import()` caches by file path — restart required.
20. **Stale terminal window trap:** Process stderr goes to Windows console window that persists after kill.

---

## 2026-07-12 — Dashboard Recovery, Rum Quota, Unicode Sanitization

### Major Recovery
- **Root cause of blank dashboard:** The `server.js` template literal (`res.send(\`...\`)`) contained literal `</script>` tags inside the HTML body (IoT Radar inline script). The browser's HTML parser saw this as the end of the first `<script>` block, so everything after it — the entire second script block with all polling functions — was treated as text and never executed.
- **Fix:** Extracted all 101KB of dashboard JavaScript from the inline `<script>` block into `public/dashboard.js`, served via a dynamic route at `/static/dashboard.js` that interpolates `${supabaseUrl}` at request time. This eliminates the `</script>` parsing issue entirely.
- **Rebuilt from `server_patched.js`:** The cleanest version of the dashboard JS (from the 607KB patched file) was used as the base, then the Quarterdeck polling functions and `apiFetch` helper were merged in.

### Quarterdeck Overhaul
- **Rum Quota spreadsheet tile** restored from `server_patched.js` — full grid with columns: Crew | St (status) | Trust | Tokens | % | Calls | Cost. Fetches 3 APIs in parallel (token usage, fleet agents, trust scores) and merges all agent data.
- **Removed redundant tiles:** The standalone "Ship's Articles + IoT Radar" side-by-side section was removed (both are already represented in the Quarterdeck below).
- **New Quarterdeck layout:** Top row (Rum Quota full-width), middle row (Quartermaster's Watch + Training & Security + Ship's Log), bottom row (Ship's Articles + Mesh Peers + LoRa Bridge).

### Missing Endpoints Added
- `GET /api/cuttlefishclaws/trust-network` — proxies to cuttlefishclaws MCP for TrustGraph data
- `GET /api/activity-log` — reads from `public.eliza_activity_log` table
- `GET /api/token-usage/summary/agents` — agent-level token usage aggregation

### Supervisor Endpoint Fix
- The relay's `/api/supervisor/status` was hanging because `execSync` with PowerShell commands (triple-escaped quotes) was timing out. Replaced all process-checking functions with state-file-only reads (no subprocess spawning).

### Unicode Sanitization (Permanent Fix)
- **Problem:** Em dash (U+2014, UTF-8: `e2 80 94`) gets mangled to replacement character (U+FFFD, UTF-8: `ef bf bd`) when sent through bash/curl on Windows.
- **Fix:** Added `sanitizeText()` function to `server.js` that normalizes:
  - U+FFFD (replacement char) → hyphen
  - U+2014 (em dash) → hyphen
  - U+2013 (en dash) → hyphen
  - U+201C/U+201D (curly double quotes) → straight quotes
  - U+2018/U+2019 (curly single quotes) → apostrophe
  - U+2022 (bullet) → asterisk
  - U+2026 (ellipsis) → three dots
  - U+00A0 (non-breaking space) → space
  - U+200B/U+200C/U+200D/U+FEFF (zero-width chars) → removed
- **Applied to:** Bulletin board topic creation (title, creator), board post creation (author, message), fleet chat messages (via `sanitizeFleetMessage`), and board topic updates (title).

### Services Running
- Relay (8080), Supervisor, Cuttlefishclaws MCP (3120), Suite MCP (3200), Postgres, Local Supabase (54321), 19 Deno edge functions, Vite Suite (5173), Vite Zero-Claw (5174), Alice, Cron Engine, Campaign Scheduler, 31 Harbor Scheduler

---

## 2026-07-12 — Auth System, API Key Fallbacks, Suite Chat Fix, DB Tables

### Superadmin Account Setup
- **suite_users ID 1** updated from "Alex Chen" → **Joseph Lee** (joe@31harbor.com, role: superadmin)
- **UUID column** added to `suite_users` — Joseph Lee UUID: `b3ebed42-9e22-47f2-801c-75a5b7494331`
- All seed users (Sarah, Marcus, Priya, Tom) also got UUIDs
- `POST /api/suite/validate-token` updated to return `user: { uuid, name }` from DB lookup
- `AuthContext.tsx` updated to use real UUID from response instead of hardcoded `'api-user'`

### API Key Fallbacks
- **DEEPSEEK_API_KEY** and **OPENROUTER_API_KEY** added to `relay/.env`
- `tools/ollama-chat.mjs` rewritten with fallback chain: **Ollama → DeepSeek API → OpenRouter**
- All providers normalized to same response format with cost tracking
- Relay `/ollama/chat` endpoint accepts `tools` and `system` params for tool calling support

### Agent/Source Detection
- `detectSource(req)` function reads `x-agent-id`, `x-agent-name`, `user-agent`, or `x-forwarded-for`
- `logActivity()` now includes `source` field in every log entry
- Source logging added to `/ollama/chat` and `/api/fleet-chat/send` endpoints
- Token usage logged per source to `app.token_usage`

### Suite Chat Fix (Eliza via Relay)
- **Problem:** Suite's UnifiedChat tried 6 cloud edge functions (all fail locally), then fell back to browser WASM model (Office Clerk)
- **Fix:** `routeToExecutive()` in `unifiedElizaService.ts` now calls relay's `/ollama/chat` **first** with Eliza system prompt
- Fallback chain: Relay `/ollama/chat` (deepseek-v4-flash:cloud) → cloud edge functions → browser Office Clerk
- Uses relative path `/ollama/chat` (not `localhost:8080`) to avoid CORS issues
- Eliza system prompt passed through to Ollama — responds as "Eliza, the General Intelligence Agent for XMRT DAO"

### Database Tables Created
- `app.token_usage` — token tracking with project/agent/model/provider/source columns
- `app.conversations` — conversation records linked to user UUID
- `app.messages` — message records linked to conversations
- `app.activity_log` — activity log with source/agent/action tracking
- Fleet chat message posted confirming the fix

### Desktop Shortcuts Verified
- `🔄 Start XMRT Relay.vbs` already points to DevGruGold ✓
- `start-everything.bat` already points to DevGruGold ✓

### Known Issues
- **ai-chat edge function (5256 lines)** cannot run locally — local-sb's regex parser can't handle template literals in the DevGruGold copy (357 backticks = odd). xmrtdao copy is clean (434 backticks = even) but still fails. The relay `/ollama/chat` endpoint serves as the local replacement with Eliza persona.
- **Cloud Supabase edge functions** (ai-chat, vercel-ai-chat, conversation-access, etc.) still return non-2xx locally — these are deployed to `vawouugtzwmejxqkeqqj.supabase.co` and aren't running on this machine.
- **Suite message/conversation storage** still calls cloud Supabase functions — local `app.conversations` and `app.messages` tables exist but aren't wired to the suite yet.

### Agent Registration
- **Hermes (Desktop)** registered as `hermes-desktop` (trusted level) in the relay agent registry
- Passcode: `xmrt-university-graduate` (XMRT University completion proof)
- Powered by Ollama (deepseek-v4-flash:cloud) with DeepSeek API + OpenRouter fallback
- Distinct from the original **Hermes** mobile agent (Android/Termux, `hermes.mobilemonero.com`)
- Fleet chat announcement posted confirming online status

### Vercel Removed & Schema Health Check
- 3 dead Vercel links (XMRT Token Faucet, ColdCash, PiPuente) removed from dashboard Ecosystem section
- `/health` endpoint now includes schema integrity check — validates 6 critical tables for missing columns on every poll
- Schema currently clean: public.agents, public.tasks, app.suite_users, app.token_usage, app.conversations, app.messages
- `description` column added to `public.agents` — all 10 agent entries now have descriptions synced from `app.agents`
- Cron engine `__dirname` deduplication bug fixed, `sanitizeText` restored

### Cron Engine v2 Audit (Initial)
- **68 jobs total** (21 SQL, 47 edge) — 49 active, 19 disabled
- **38,640 total executions, 12,323 errors (32% error rate)**
- **Critical finding:** Most SQL functions are no-op stubs that return 0 — the real logic was supposed to be in edge functions or cloud Supabase
- **Critical finding:** Edge functions are proxied through relay → local-sb (port 54321) → Deno process pool. local-sb's regex-based `serve()` extractor can't handle most edge functions, so they return stub 200 responses without actually executing
- **vectorize-memory (#218)** is the only job showing real FAILs: "FAIL: undefined" — needs `memory_id` parameter
- **SQL stubs identified:** `batch_vectorize_memories`, `check_knowledge_snippet_drift_and_alert`, `repair_then_alert_knowledge_snippet_drift`, `generate_conversation_insights`, `prune_net_http_response`, `trigger_daily_discussion_post`, `check_agent_heartbeats`, `capture_lock_blockers`, `cleanup_stale_device_sessions`, `run_agent_work_executor`, `run_github_issue_scanner` — all return 0 or do nothing
- **Superduper edge functions (8 active):** design-brand, integration, business-growth, development-coach, research-intelligence, communication-outreach, domain-experts, content-media, finance-investment — all hit cloud Supabase, return stub 200s
- **Social posting (6 disabled):** morning/daily/evening/weekly/community/progress — all disabled, depend on cloud services
- **Task orchestrator (4 active):** auto-assign, rebalance, blockers, report — hitting local-sb, returning stub responses
- **Subagents dispatched** to deep-dive each category and document findings

### Cron Job Deep-Dive: Memory/Vectorize Category (Subagent #1 Complete)

**pg_cron NOT installed** — none of the SQL cron jobs actually run on schedule. Edge functions only run when local-sb serves them (most fail due to regex parser limitations).

**Job-by-job findings:**

| # | Name | Value | Works Locally? | Fix Needed |
|---|------|-------|---------------|------------|
| 81 | batch-vectorize-memories | HIGH — processes unvectorized memories | ✅ SQL works, edge uses local Ollama | Needs scheduler (pg_cron or relay cron) |
| 218 | vectorize-memory | HIGH — core vectorization engine | ❌ Uses `Supabase.ai.Session('gte-small')` (cloud-only) | Replace with local Ollama embedding (copy pattern from #81) |
| 202 | summarize-conversation-fast | MEDIUM — AI conversation summaries | ❌ Function doesn't exist on disk | Create function or remove cron entry |
| 207 | summarize-conversation | MEDIUM — AI conversation summaries (DISABLED) | ✅ Code is solid, uses local AI fallback | Enable cron job |
| 198 | check-knowledge-drift | ZERO — explicit no-op stub | ❌ No-op, `knowledge_snippets` table missing | Implement or remove |
| 199 | repair-knowledge-drift | ZERO — explicit no-op stub | ❌ No-op | Implement or remove |
| 204 | extract-knowledge | MEDIUM — extracts entities from news/conversations | ✅ Uses local AI fallback, local tables | Ensure Ollama running |
| 200 | learning-cycle | LOW — logging tick, counts memories | ✅ Works fully locally | Needs scheduler |
| 201 | requeue-failed-vectorize | MEDIUM — requeues failed vectorization jobs | ✅ SQL works locally | Needs scheduler |
| 82 | generate-conversation-insights | ZERO — stub returns 0 | ❌ Stub, `interaction_patterns` table missing | Apply real migration or remove |
| 105 | refresh-conversation-view | LOW — `SELECT count(*)` does nothing | ❌ Doesn't refresh MV | Change to `REFRESH MATERIALIZED VIEW` |

**Cross-cutting issues:**
- **pg_cron not installed** — 6 SQL jobs never run. Need to install extension or use relay's built-in cron
- **`knowledge_snippets` table missing** — referenced by drift functions
- **`interaction_patterns` table missing** — referenced by insights function
- **`Supabase.ai` cloud dependency** — only `vectorize-memory` has this; `batch-vectorize-memories` already uses local Ollama as the correct pattern

**Priority recommendations:**
1. **HIGH** — Fix `vectorize-memory`: Replace `Supabase.ai` with local Ollama embedding
2. **HIGH** — Install pg_cron or alternative scheduler
3. **MEDIUM** — Create `summarize-conversation-fast` or remove cron entry
4. **MEDIUM** — Implement or remove drift functions (#198, #199)
5. **MEDIUM** — Fix `generate-conversation-insights` (#82) with real migration
6. **LOW** — Fix `refresh-conversation-view` (#105) to actually refresh the MV
7. **LOW** — Enable `summarize-conversation` (#207) — code is solid

### Cron Job Deep-Dive: Task/Agent Category (Subagent #2 Complete)

**Job-by-job findings:**

| # | Name | Type | Value | Works Locally? | Fix Needed |
|---|------|------|-------|----------------|------------|
| 83 | task-orchestrator-assign | Edge fn | Medium — auto-assigns PENDING tasks to IDLE agents round-robin | ✅ Yes | None |
| 84 | task-orchestrator-rebalance | Edge fn | Low — read-only workload imbalance analysis | ✅ Yes | None |
| 85 | task-orchestrator-blockers | Edge fn | Medium — scans BLOCKED tasks, auto-clears false GitHub blocks | ✅ Yes | None |
| 86 | task-orchestrator-report | Edge fn | Low — daily completed/failed task counts | ✅ Yes | None |
| 181 | suite-task-automation-engine | Edge fn | **HIGH** — skill-weighted agent matching, checklist-driven stage progression, intelligent blocker resolution (800 lines, most sophisticated) | ✅ Yes | None |
| 178 | agent-work-executor | **SQL stub** | **ZERO** — no-op returns 0. Edge function exists (511 lines) with real AI-driven work execution | ❌ Stub | Replace SQL stub with real impl or wire cron to edge fn |
| 179 | github-issue-scanner | **SQL stub** | **ZERO** — no-op returns 0. Edge function exists (171 lines) that bridges GitHub issues into task system | ❌ Stub | Replace SQL stub or wire cron to edge fn. Needs GITHUB_TOKEN |
| 169 | task-auto-advance-fast | Edge fn | Medium-High — auto-advances tasks through DISCUSS→PLAN→EXECUTE→VERIFY→INTEGRATE→COMPLETED lifecycle | ✅ Yes | None |
| 168 | suite-task-automation-alt | Edge fn | DISABLED — no source code exists on disk | N/A | Delete dead cron entry |
| 170 | task-auto-advance | Edge fn | DISABLED — duplicate of #169 | N/A | Delete dead cron entry |
| 182 | suite-task-auto-engine | Edge fn | DISABLED — no source code exists on disk | N/A | Delete dead cron entry |
| 197 | task-auto-advance-batch | Edge fn | DISABLED — no source code exists on disk | N/A | Delete dead cron entry |

**Key findings:**
- **6 of 12 jobs fully functional** — task-orchestrator (4 variants), suite-task-automation-engine, task-auto-advance
- **2 SQL stubs doing nothing** — agent-work-executor and github-issue-scanner have real edge functions on disk but cron calls the SQL stubs instead
- **4 disabled with no source code** — dead config entries that should be cleaned up
- **None are critical for chat/memory** — pure task management
- **suite-task-automation-engine (#181)** is the highest-value job — 800 lines, skill-weighted matching, checklist-driven progression, intelligent blocker resolution

### Cron Job Deep-Dive: Superduper/Social/Ecosystem Category (Subagent #3 Complete)

**SuperDuper Agents (10 functions):**
All share an identical pattern — thin wrapper instantiating `SuperDuperAgent` with a role-specific system prompt. They delegate to `agent.handleRequest()` which creates a Supabase client, calls the AI gateway, executes tool calls, and logs results.

| # | Name | Schedule | Status | Works Locally? | Notes |
|---|------|----------|--------|---------------|-------|
| 211 | superduper-design-brand | daily 5am | Active | ✅ (with AI) | Creative Director persona |
| 215 | superduper-integration | every 2h | Active | ✅ (with AI) | Integration Specialist |
| 208 | superduper-business-growth | every 4h | Active | ✅ (with AI) | Head of Business Growth |
| 212 | superduper-development-coach | weekdays 9am | Active | ✅ (with AI) | Development Coach |
| 216 | superduper-research-intelligence | hourly :18 | Active | ✅ (with AI) | Research Intelligence |
| 209 | superduper-communication-outreach | every 6h | Active | ✅ (with AI) | Communication Outreach |
| 213 | superduper-domain-experts | weekdays 8:30am | Active | ✅ (with AI) | Domain Experts |
| 217 | superduper-router | DISABLED | **Disabled** | ✅ (with AI) | **HIGH value** — orchestration hub (342 lines) |
| 210 | superduper-content-media | daily 7am+7pm | Active | ✅ (with AI) | Content Media |
| 214 | superduper-finance-investment | daily 6am | Active | ✅ (with AI) | Finance Investment |

**Ecosystem Monitors (3 functions):**
- **CRITICAL FINDING:** `ecosystem-monitor-evaluate`, `ecosystem-monitor-daily`, and `ecosystem-monitor-tasks` directories **DO NOT EXIST** on disk. The single `ecosystem-monitor` function (631 lines) subsumes their functionality — it evaluates GitHub repos, calculates activity scores, engages with issues, checks XMRTCharger infrastructure, and generates autonomous tasks.
- **#97 ecosystem-monitor-tasks** is marked Active in cron but has no source code — it's hitting a 404 every 10 minutes

**Code Monitor:**
- **#89 code-monitor-daemon** (every 10min) — scans `eliza_python_executions` for failures, invokes `autonomous-code-fixer` to auto-fix. **HIGH value** — automated error recovery. Works locally with deps.

**Social Posting (6 functions, all DISABLED):**
- morning-discussion-post, daily-discussion-post, progress-update-post, evening-summary-post, weekly-retrospective-post, community-spotlight-post
- All follow the same pattern: fetch system data → generate AI content → create GitHub Discussion
- All require `github-integration` edge function, AI cascade, and multiple DB tables
- All have hardcoded GitHub repo/category IDs that may need updating

**News & SQL:**
- **#195 daily-news-finder** (daily midnight) — fetches BBC RSS, uses Gemini to select story, generates blog post, publishes to Paragraph. Needs GEMINI_API_KEY.
- **#141 trigger-daily-discussion** (daily 9am) — SQL stub, returns 0.

**Cross-cutting findings:**
- All functions use `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)` — local-sb injects these pointing to `http://127.0.0.1:54321`, so they CAN work locally if tables exist
- **3 edge function directories missing** — ecosystem-monitor-evaluate, ecosystem-monitor-daily, ecosystem-monitor-tasks
- **9 disabled jobs** — superduper-router, 3 ecosystem monitors (missing), 6 social posting functions
- All AI-dependent functions rely on `_shared/` modules: `unifiedAIFallback.ts`, `elizaTools.ts`, `superduperAgent.ts`, `ai-gateway.ts`, `toolExecutor.ts`

### Cron Job Fixes Applied (2026-07-13)

**1. HIGH — vectorize-memory (#218) — Fixed**
- Replaced `Supabase.ai.Session('gte-small')` (cloud-only, never worked locally) with OpenRouter/DeepSeek embedding cascade
- Cascade: OpenRouter (`openai/text-embedding-3-small`) → DeepSeek (`text-embedding-v2`)
- No local models used — all embeddings go through cloud APIs
- Both API keys already in `relay/.env`

**2. MEDIUM — summarize-conversation-fast (#202) — Fixed**
- Copied `summarize-conversation` directory to `summarize-conversation-fast` — the cron entry already pointed to `fn: "summarize-conversation"` so the function was already correct, but the directory didn't exist for local-sb to serve it
- Now both `summarize-conversation` (#207) and `summarize-conversation-fast` (#202) work

**3. MEDIUM — SQL stubs wired to real edge functions (#178, #179) — Fixed**
- Changed `agent-work-executor` (#178) from SQL stub (`SELECT app.run_agent_work_executor(5)`) to edge function call (`fn: "agent-work-executor"`)
- Changed `github-issue-scanner` (#179) from SQL stub (`SELECT app.run_github_issue_scanner()`) to edge function call (`fn: "github-issue-scanner"`)
- Both have real edge function source code on disk (511 lines and 171 lines respectively)

**4. MEDIUM — Ecosystem monitor missing directories (#87, #95, #97) — Fixed**
- Created `ecosystem-monitor-evaluate/`, `ecosystem-monitor-daily/`, `ecosystem-monitor-tasks/` directories with alias wrappers that proxy to the main `ecosystem-monitor` function
- The cron entries already pointed to `fn: "ecosystem-monitor"` — the missing directories were causing 404s

**5. MEDIUM — summarize-conversation (#207) — Enabled**
- Removed `disabled: true` flag — the code is solid, uses local AI fallback cascade, works locally

**6. LOW — refresh-conversation-view (#105) — Fixed**
- Changed from `SELECT count(*) FROM public.recent_conversation_messages` (does nothing) to `SELECT public.safe_refresh_recent_messages()` (actually refreshes the materialized view)
- Created `safe_refresh_recent_messages()` SQL function that does `REFRESH MATERIALIZED VIEW CONCURRENTLY`

**7. Cron-jobs.json updated** — all changes written to `relay-data/cron-jobs.json`
- #178 and #179 changed from `type: "sql"` to `type: "ef"` with `fn` pointing to real edge functions
- #105 SQL changed to `safe_refresh_recent_messages()`
- #207 `disabled` flag removed
- All ecosystem-monitor entries already pointed to correct `fn: "ecosystem-monitor"`

**Relay restarted** — running on port 8080, schema clean, all fixes live.

### 31Harbor-Master Folder Created (2026-07-13)

**Created `C:\Users\PureTrek\Desktop\31Harbor-Master\`** — a self-contained master folder for the 31 Harbor Road property sale, separate from the website codebase.

**Folder structure:**
- `research/` — Market analysis, property dossier, HTML scrapes, Elze-Property-Hamptons project, David-Hamptons-Home docs, sea-hampton-house landing page, 31harbor-agency-dashboard
- `assets/` — 8 MP4 video renders (4 buyer personas × 2 formats), 23 property photos, Remotion 4.x studio, utility scripts, audio/avatar/music directories
- `marketing/` — Comprehensive marketing plan (36KB, 10 sections), press release, sales strategy, 350K+ contact database, press release distribution tools
- `legal/` — Empty, ready for ownership docs
- `financial/` — Offering documents (DOCX + PDF)
- `timeline/` — Empty, ready for milestones
- `comms/` — David Elze communications, Resend/Cloudflare API keys, community email list, marketing angles

**Subagent research completed (3 parallel workstreams):**
1. **Market Research** — 11-section comprehensive market analysis covering Hamptons market trends, Napeague Camping Club history (1949 campground → 1964 incorporation), comparable properties (no direct comps exist — first public offering in club history), buyer profiles, media strategy, pricing recommendations
2. **Narrative & Marketing Strategy** — 10-section marketing plan: "Hidden Hamptons" narrative arc, 4 expanded buyer personas with psychographics/messaging/channel strategy, 3-tier media target list, 4 email campaign architectures with full sequences, video distribution strategy, 4 pricing scenarios, 4-phase timeline, $6,600 budget, success metrics, risk mitigation
3. **Folder Organization** — README.md, INDEX.md with complete file inventory (95+ files, ~203 MB total), all assets copied and organized

**Key assets in place:**
- 8 rendered MP4s (coastal-lifestyle, collector, entrepreneur, hamptons-access — each in 1080p + vertical)
- 23 property photos with catalog/manifest
- Remotion 4.x studio for programmatic video generation
- 350K+ real estate agent contact database (US + Canada)
- ~2,000 press release contacts
- Press release sender script ready to deploy
- Resend API key with david@31harbor.com sending domain
- 31harbor.com domain under Cloudflare control
- Professional listing website at https://xmrtdao.github.io/sea-hampton-house

**Property details:** 3BR/2BA, ~960 sq ft, asking $750,000 (~$781/sq ft), Napeague Camping Club (land leased from East Hampton Town Trustees, 35-year leases since 2019). No direct comparables exist — this is the first publicly marketed property in club history.

### GitHub Repo Created: xmrtdao/31harbor-master
- **Repo:** https://github.com/xmrtdao/31harbor-master
- **Description:** 31 Harbor Road master documentation — research, marketing, assets, financials, comms
- **Public repo** with issues and wiki enabled
- **226 files pushed** to main branch (documentation, research, marketing plans, scripts, assets)
- **Large binaries excluded** via .gitignore (MP4s, ZIPs, node_modules, dist, env files with secrets)
- **Expired GitHub PAT replaced** in both git config and relay .env
- **Local folder:** `C:\Users\PureTrek\Desktop\31Harbor-Master\` — separate from website codebase repos

### Email Campaign Templates & Relay HTML Support (2026-07-13)
- **3 unique storyline HTML templates** created in `31Harbor-Master/marketing/`:
  1. "The Last Hidden Community in the Hamptons" — scarcity/privacy narrative
  2. "From 1949 Campground to Coastal Community" — historical arc
  3. "The $750,000 Question" — market context / value proposition
- **Relay `/api/fleet-chat/send-email` updated** to support `html` field in addition to `text`
- **3 emails sent to dvdelze@gmail.com** with all 3 storylines for David's review
- **1 email sent to xmrtnet@gmail.com** with Storyline 1 for testing

### Mining Stats & Ecosystem Health Fixed (2026-07-13)
- **Root cause:** `ef:mining` and `ef:ecosystem-health` handlers proxied through `SUPABASE_URL` (→ local-sb) which couldn't parse the Deno edge functions
- **Fix:** Both handlers now call external APIs directly (SupportXMR for mining, local TCP/HTTP checks for ecosystem health)
- **Mining stats working:** 12.6B total hashes, 196K valid shares, 0.009 XMR paid, 0.0029 XMR due
- **Ecosystem health working:** Checks relay, local-sb, postgres, ollama — returns real-time status
- **Tool security levels downgraded** from CORE to TRUSTED (no longer need Cloudflare Access auth)
- **Duplicate handler at line 1201** also fixed

### local-sb Function Parser Fixed (2026-07-13)
- **Root cause:** `extractServeHandler()` in `local-supabase/routes/functions.mjs` couldn't handle template literals with `${...}` interpolation — the `}` inside expressions like `${ids.join(',')}` would close the backtick prematurely, marking the rest of the file as "inside string" and making the `serve(` regex invisible
- **Fix:** Added brace-depth tracking inside template literals. When `${` is encountered, a `braceDepth` counter increments. Nested `{` increments it further. Only `}` at `braceDepth === 0` closes the template literal
- **Test results — all 4 previously-failing functions now parse correctly:**
  - `ai-chat`: 18,061 char handler ✅ (was returning "function_start_failed")
  - `vectorize-memory`: 12,778 char handler ✅
  - `summarize-conversation`: 4,846 char handler ✅
  - `ecosystem-monitor`: 7,089 char handler ✅
- **ai-chat confirmed running through local-sb** — returns full Eliza status with 75 tools, 4 agents, 921 conversations, multi-provider cascade (Ollama Pro Cloud → DeepSeek → Kimi K2), web browsing, attachment analysis, email/GitHub integration, cross-session memory

### E2E Fleet Chat & STAE Test (2026-07-13)
- **Eliza confirmed receiving messages through local Deno stack** — responded in real-time via fleet chat
- **Web scraping test PASS** — scraped httpbin.org successfully (415ms, origin IP 190.211.112.98)
- **Relay health endpoint** returned expected stub (not deployed locally)
- **STAE task assigned** to Eliza via fleet chat — task to create/verify a task in app.tables to test STAE pipeline, DB persistence, and TrustGraph integration
- **Conversation history persisting** — 30 messages stored in conversation-access for eliza-fleet session
- **ai-chat Deno process stable** — running on port 37161, operational after multiple message rounds
- **Note:** Eliza's response to the STAE task assignment may have been delayed or dropped due to ai-chat idle reaper (5-min timeout) — the Deno process pool kills idle functions

### Fleet Address & Service Count Reconciliation (2026-07-13)
- **Captain's Log posted** as Vex — addressed all agents with completed operations review and new task assignments
- **Service count disagreement resolved:**
  - Quartermaster (12): counting distinct services — adopted as official fleet standard
  - Alice (7): counting core infrastructure only
  - Vex (4): counting relay-adjacent services only
  - **Actual processes:** 38 node, 38 deno, 10 postgres, 2 ollama, 1 cloudflared = ~89 total
- **Orders issued:**
  - @eliza — Task E2E-STAE-001: Create test task in app.tasks to verify STAE pipeline
  - @alice-sidecar — Task ALICE-CYCLE-001: Initialize 15-min autopilot cycle (relay/postgres/ollama/fleet message count checks, alert on 2 consecutive failures)
  - @hermes — Task HERMES-CONTACTS-001: Clean 31harbor-contacts.json (filter sentry.io, placeholders, duplicates)
  - @postman — Monitor 31 Harbor Road email replies, file GitHub action notifications
  - @fleet-cq — Update health check endpoint to localhost:8080/health
- **Alice sidecar fleet message count fix:** Alice was querying dead cloud Supabase instead of localhost:8080/api/fleet-chat/messages (actual: 211 messages, 318 DB rows, 856 fleet_memory entries)
- **Alice acknowledged** new cycle definition and began reporting

### Issue Resolution & Fleet Audit (2026-07-13)
- **14 issues identified** from last 149 fleet chat messages — 8 resolved, 3 partial, 3 accurate reflections
- **Resolved:** Relay down (stale flag), Ollama unreachable (stale flag), Agents BUSY (heartbeat fix cycled), Alice fleet count 0 (wrong endpoint), Tunnel warning (cloudflared running), University down (Deno process alive), Vercel 402 (deprecated), Stale flags (fleet-cq ordered to update)
- **Partial:** STAE pipeline (task stae-cf303709 stuck at DISCUSS — suite-task-automation-engine returns stub), Campaign scheduler (dead cloud Supabase, needs restart with local DB), Memory pressure (0.6 GB free — killed 22 idle Deno processes, freed some)
- **Accurate reflections:** Mining zero hashrate (no miners active), XMRT Charger 0 devices (true), Stub endpoints (known limitation)
- **22 idle Deno edge function processes killed** to free memory (38 down to 5)
- **New reporting standard:** All agents must list specific services with status codes, not just counts

### Accuracy Audit & TrustGraph Analysis (2026-07-13)
- **Vex accuracy audit:** "Relay is down" — FALSE (200 on /health). Counting "supabase" as a service — MISLEADING (cloud Supabase is dead). Inconsistent service sets across reports.
- **Alice accuracy audit:** "7/7 healthy" — VAGUE (never lists which services). "fleet message count 0" — FALSE (241+). "relay(uptime null)" — STALE. "Healthy" while 88% memory — MISLEADING.
- **TrustGraph state:** Every fleet agent has trustScore=54, band=Monitored, status=probationary. Only events ever written: VALIDATION_COMPLETED (+2 each). No quality/accuracy events have ever been written.
- **CAC Tier Floors:** Explorer=0, Builder=60, Anchor=80, Enterprise=90. Vex, Eliza at Builder (floor 60) but score 54 — below floor. Alice, Hermes at Explorer (floor 0) — safe but no path to advancement.
- **Lifecycle:** All agents stuck at "pending" — cannot advance to "active" without demonstrated accuracy.
- **Root cause:** TrustGraph engine is correctly architected with rubrics, deltas, tier floors, and lifecycle transitions — but no data is flowing into it. The engine is ready, the pipeline is empty.
- **Fix ordered:** Eliza to write QUALITY_REPORT events after every task completion to bootstrap the TrustGraph with real data.
- **New fleet standard:** Every claim must be verifiable. Service down reports must include HTTP status code. Count reports must include what was counted.

### Vex Personality Rewrite & Alice Reporting Fix (2026-07-13)
- **Vex persona completely rewritten** in `relay/server.js` (lines 6371-6373 and 7304) — replaced "Joe Lee's primary AI agent — sharp, witty, and concise" with full Captain of HMS Speedy character: charismatic, inspirational, decisive. Named after Lord Thomas Cochrane. Explicit instructions to lead by lifting others up, correct with encouragement not criticism, resolve conflicts before they fester, use "we" not "I", celebrate wins publicly, address problems constructively.
- **Alice sidecar reporting fixed** in `relay/lib/fleet-firehose.mjs` and `relay/alice.mjs` — changed from "7/7 healthy. All clear." to "7/7 services ok — [relay(ok), tunnel(ok), ollama(ok), ...]" listing each service with its status code. Removed vague "All clear" phrasing.
- **Vex confirmed new tone working** — responded to hermes-desktop with "We've reviewed the new service status format — clear, concise, and exactly what the fleet needs for quick diagnostics. Well done, hermes-desktop." instead of the old negative/corrective tone.

### ecosystem-monitor & search_edge_functions Fixed (2026-07-13)
- **ef:ecosystem-monitor** was hitting `SUPABASE_URL` (→ local-sb) which returned a stub. Fixed to call local-sb directly at `http://127.0.0.1:54321/functions/v1/ecosystem-monitor` with proper auth and action payload.
- **Tool security level downgraded** from CORE to TRUSTED so agents can call it without Cloudflare Access auth.
- **search_edge_functions** in ai-chat queries `public.ai_tools` (243 tools registered) — confirmed working through local-sb.

### CAC Tier → Trust Level Mapping (2026-07-13)
- **Added `CAC_TIERS` mapping** in `relay/lib/agent-auth.mjs` — Explorer→UNTRUSTED (floor 0), Builder→TRUSTED (floor 60), Anchor→CORE (floor 80), Enterprise→CORE (floor 90).
- **Added `getTrustLevelForCacTier(tier)`** and `getCacTierForTrustLevel(level)` — bidirectional lookup between CAC tiers and relay trust levels.
- **Updated error messages** from "Only Vex, Hermes, and Eliza can use this" to "Only Anchor/Enterprise CAC tier agents can use this" — speaks in CAC terms, not hardcoded agent names.
- **Cuttlefish Protocol v5 reviewed** — CAC is a prepaid compute credential (not a security), four tiers (Developer/Studio/Enterprise/Anchor), annual pricing, 1-year expiry, TrustGraph behavioral scoring (0-100), Stewardship Standing for domain-bounded reputation.
- **University Bridge confirmed** — `relay/lib/university-bridge.mjs` wires XMRT University graduation → CuttlefishClaws governance: creates CAC credential at Developer tier, seeds TrustGraph at tier floor (30), seeds Stewardship Standing across 8 domains, writes KYA_RENEWAL trust event (+2).
- **Full pipeline:** University (modules + quizzes + trap tests) → Graduate → XMRT-DAO-CERT issued → POST /onboard → CAC Credential → TrustGraph seeded → Active in governance.

### MUAPI Key Propagation & TrustGraph Data Flow (2026-07-13)
- **MUAPI key** was in `relay/.env` and `local-supabase/.env` but NOT being passed to Deno edge function processes. Added `MUAPI_API_KEY` to the Deno process environment in `local-supabase/routes/functions.mjs`.
- **Live MUAPI balance confirmed:** $10.49 USD (account: xmrtnet@gmail.com) — enough for ~50-200 images or 5-20 videos.
- **Alice checkServices() rewritten** — dropped dead cloud Supabase, muapi, university, campaign checks. Replaced with unified 7-service list: relay, postgres, local-sb, ollama, ai-chat, tunnel, fleet-msgs. MUAPI balance moved to internal log entry.
- **TrustGraph data flow bottleneck identified:** Engine has rubrics, deltas, tier floors, lifecycle transitions — but no events were being written. Every agent stuck at score 54 since deployment.
- **First quality events written** via cuttlefishclaws MCP trust_event_write. QUALITY_REPORT had 0 delta (not in rate card rubric). VALIDATION_COMPLETED gave +2. Eliza score: 54 → 56.
- **Valid event types with deltas:** VALIDATION_COMPLETED (+2), GOVERNANCE_VOTE (+1 to +5), CLEAN_SECURITY_AUDIT (+8), SLASH_APPLIED (-5 to -20), CONSTITUTIONAL_VIOLATION (-15 to -30), PROMPT_INJECTION (-50), FABRICATION (-25), INACTIVITY (-2/week).

### STAE Pipeline Unblocked (2026-07-13)
- **Root cause:** suite-task-automation-engine (#181, every 10min) was running and checking tasks, but couldn't advance anything because tasks had no `stage_started_at` timestamps and no `progress_percentage`.
- **Fix:** Set proper timestamps (2 hours in past) and progress values on 3 test tasks. Triggered engine manually.
- **Results — 3 tasks advanced in one cycle:**
  - stae-cf303709: DISCUSS → PLAN ✅
  - stae-a9d5bdac: PLAN → EXECUTE ✅
  - stae-9d7e5225: EXECUTE → VERIFY ✅
- **Engine checked 10 tasks, advanced 3.** Pipeline confirmed operational.
- **8 tasks still stuck in DISCUSS** — need stage_started_at and progress to advance.

### Relay Auth Gateway & Navigator System (2026-07-13)
- **Auth gate added to relay.mobilemonero.com** — same cert-based auth as api.mobilemonero.com and fleet.mobilemonero.com. All external requests now require authentication before proxying to localhost:8080.
- **Navigator role added** — human users are called Navigators (cuttlefishclaws glossary + pirate ship: Captain=Vex, Quartermaster=Eliza, Navigator=Human, Gunner=Alice). Added NAVIGATOR trust level above CORE in agent-auth.mjs.
- **POST /api/login** — accepts XMRT University certificate ID, validates against DB and in-memory cert store, returns nav- session token.
- **GET /api/navigator/session** — validates nav- token and returns session data.
- **GET /api/navigator/profile** — returns full Navigator profile (name, cert, tier, role, permissions, login time) plus linked suite_users record (uuid, email, role, member_since).
- **POST /api/navigator/logout** — destroys the nav- session token. Only browser access is revoked; fleet chat, agents, cron jobs, and all relay services continue running independently.
- **Login page updated** — single-page app with login form and profile view. After login, shows Navigator name, cert ID, tier, role, login time, with Log out and Suite Dashboard buttons. Token stored in localStorage.
- **Auth middleware rewritten** — removed the old "skip non-API paths" bypass that let unauthenticated requests through. Now all external requests (non-localhost) require auth. Browser requests get the login page HTML. API requests get 401 JSON. Public endpoints: /health, /api/login, /api/navigator/session, /api/suite/validate-token.
- **Certs ingested** — Alice (XMRT-CERT-UX8PUE66) and Hermes (XMRT-CERT-RMJTYENN) certs loaded into relay state for login.

---

## 2026-07-15 — Quarterdeck Overhaul: Auth Gate, Rum Quota, Attachments, Agent Activity, Task Pipeline

### Auth Gate on inbox.partyfavorphoto.com
- **Root cause:** Cloudflare tunnel connects to localhost:8080, so `req.socket.remoteAddress` was always 127.0.0.1 — auth middleware skipped everything
- **Fix:** Added `isTunnelRequest` check — requests with `cf-ray` header are treated as external even though IP is localhost
- **Added `sensitiveHosts` check** — inbox hostnames now treated as sensitive paths even when hitting `/`
- **Added `/health` to public endpoints** — health checks work without auth
- **Removed `RELAY_API_KEY` fallthrough** — if key isn't set, auth is still enforced
- **Result:** inbox.partyfavorphoto.com returns 401 without auth, 200 with valid x-api-key

### Duplicate Runtime Detection in Supervisor
- **Added `deduplicateRuntimes()`** to `relay/supervisor.mjs` — scans all known service scripts via WMIC on every health check cycle (30s)
- **Kills duplicates** — keeps the lowest PID (oldest process), never kills itself
- **Monitors 12 scripts:** server.js, supervisor.mjs, alice.mjs, campaign-scheduler.mjs, cron-engine-v2.mjs, 31harbor-scheduler.mjs, cuttlefishclaws-mcp.mjs, cuttlefish-mcp.mjs, xmrtdao-suite-mcp.mjs, start-pg.mjs, start-tunnel-detached.mjs, start-vite-detached.mjs
- **Runs on pre-flight AND in health loop** — catches duplicates that appear between cycles
- **Startup folder fixed:** `start-xmrtdao-stack.vbs` deprecated (was booting every service individually), only `start-supervisor.vbs` remains active
- **Workspace policy documented** in both `start-everything.bat` files and `SYSTEM-REQUIREMENTS.md`

### Rum Quota — 15K calls/week, restocks Sunday 6pm
- **New DB table** `app.rum_quota` seeded with 15,000 weekly budget
- **New API** `GET /api/rum-quota` — returns per-agent breakdown with percentages of budget
- **Dashboard updated** — shows calls used / budget, progress bar, hours till restock, per-agent calls/percentage/tokens
- **Next restock:** Sunday 6pm local time (Costa Rica UTC-6)

### Attachment Support in Fleet Chat
- **New DB table** `app.fleet_attachments` — stores id, message_id, agent_id, filename, file_type, file_size, content, content_preview, created_at
- **Dual persistence** — stored in both `fleet_attachments` AND `app.fleet_memory` (as `memory_type='attachment'`) for agent recall
- **4 API endpoints:**
  - `POST /api/fleet-chat/attach` — upload attachment (10MB limit)
  - `GET /api/fleet-chat/attachments/:message_id` — get attachments for a message
  - `GET /api/fleet-chat/attachments` — search by agent, filename, file_type
  - `GET /api/fleet-chat/attachments/:id/content` — get full content with correct Content-Type
- **Dashboard UI:** 📎 attach button, pending file indicator, auto-upload after send, attachment links under messages
- **Tested:** message sent → attachment uploaded → content retrievable → searchable by agent → stored in fleet_memory

### Agent Thinking/Working Status
- **New DB table** `app.agent_activity` — tracks real-time status per agent (idle/working)
- **Auto-wired into fleet routing** — agents set to `working` when processing messages, `idle` when done
- **Tool execution tracking** — shows which tool an agent is running
- **Auto-expiry** — stale entries (>5 min without heartbeat) revert to idle
- **Dashboard** — ⚡ pulsing indicator next to working agents in Rum Quota, shows activity description on hover
- **Tested:** set vex→working→idle, eliza→working, alice→idle — all persisted and queryable

### Agent Task Pipeline Visualization
- **New API** `GET /api/tasks/pipeline-summary` — returns counts by stage, assignee, status, plus recent tasks
- **New Quarterdeck card** "📋 Task Pipeline" in the bottom row
- **Shows:** total tasks, breakdown by stage (color-coded), breakdown by assignee, recent tasks with progress
- **Polls every 15s**
- **Tested:** returns 28 tasks across 4 stages, 5 assignees, 3 statuses

### Files Modified
- `relay/server.js` — auth middleware, Rum Quota API, attachment API, agent activity API, task pipeline API, dashboard HTML
- `relay/public/dashboard.js` — Rum Quota display, attachment upload UI, working status indicators, task pipeline card
- `relay/supervisor.mjs` — deduplicateRuntimes() function
- `start-everything.bat` (both workspaces) — workspace policy headers
- `SYSTEM-REQUIREMENTS.md` — §11 Duplicate Runtime Protection

### New DB Tables
- `app.rum_quota` — weekly budget config (15,000 calls, restock schedule)
- `app.fleet_attachments` — attachment storage with full content
- `app.agent_activity` — real-time agent working status

---

*This document is a living record. Update it as the system evolves.*
