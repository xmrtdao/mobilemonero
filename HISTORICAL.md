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

*This document is a living record. Update it as the system evolves.*
