# System Requirements & Service Map

**Generated:** 2026-06-10 (sweep + tighten pass)
**Repo:** `C:\Users\PureTrek\Desktop\DevGruGold`
**Host:** PURETREK (Windows, single-machine stack)
**User:** Joe / PFP → mobilemonero.com / XMRT DAO

**Tighten pass (6/10):** cron-engine-v2 added to supervisor; 4 stale Windows tasks marked for deletion via `scripts/delete-stale-tasks.bat` (one admin run); 3 dead AI keys (Gemini/Kimi/OpenRouter) removed from `.env`; Alice dead-cloud URL fallback removed with fatal guard; supervisor has PID-reconciliation + legacy-state-prune. See §9 for the full resolution list.

This file is the canonical answer to **"what does our system need to be running to function correctly?"** Update it whenever services, ports, or supervisors change.

---

## 1. Runtime Stack (all required)

| Runtime | Version | Where | Why |
|---|---|---|---|
| Node.js | >= 18 (engines in `relay/package.json`) | `C:\Program Files\nodejs\node.exe` | Relay, Vite, all `.mjs` daemons, cron-engine-v2, alice, daily-campaign |
| Deno | bundled `1.x` | `bin\deno\deno.exe` | Edge function runtime used by local-sb at port 54321 |
| Postgres | bundled `18.x` (embedded) | `pg/` | Backing store for local-sb, fleet, tasks, etc. |
| PostgREST | bundled | `bin\postgrest\postgrest.exe` | Standby (currently not active; local-sb implements its own PostgREST-compatible router) |
| Ollama | `ollama.exe serve` | `C:\Users\PureTrek\AppData\Local\Programs\Ollama\` | Local LLM (14 models); primary AI provider |
| cloudflared | bundled | `cloudflared.exe` | Named tunnel `5d954e14-...` for `relay.mobilemonero.com`, `inbox.partyfavorphoto.com`, `inbox.mobilemonero.com` |
| LibreOffice/ImageMagick/etc. | optional | — | Only for `tools/` pdf/excel scripts — not on the critical path |

> **Anything else on this machine is noise.** If a service is not in §2, it does not need to be running.

---

## 2. Active Services & Ports

All services run on `localhost` only. Public access is via cloudflared tunnel.

| Port | Service | PID (as of sweep) | Started | Owner | Health |
|---|---|---|---|---|---|
| **5432** | `postgres.exe` (local PG) | 9604 | 6/9 21:18 | supervisor (pg slot, `wrapperExits:true`) | `pg_isready` |
| **8080** | `relay/server.js` (Eliza-Dev) | 3704 | 6/10 14:33 | supervisor | `GET /health` → `{"status":"ok",...}` |
| **5173** | Vite dev server (SupaClaw) | 476 | 6/9 20:45 | manual `npm run dev` | `GET /` → HTML |
| **54321** | `local-supabase/server.mjs` (drop-in Supabase) | 8608 | 6/10 15:04 | manual `node --watch` (NOT supervisor) | `GET /` → `{"name":"local-supabase"...}` |
| **11434** | `ollama.exe serve` | 10588 | 6/9 18:58 | background | `GET /api/tags` → 14 models |
| **20241** | cloudflared named tunnel (metrics port, `localhost`) | 10084 | 6/9 21:08 | supervisor (tunnel slot) | `GET /health` returns 404 (no metrics) — verify via public hostname instead |
| **42050** | OneDrive sync (system, ignore) | — | — | OS | — |
| **49722** | Ollama helper (system, ignore) | — | — | OS | — |
| **49963, 49956, 49957** | Node 11432 (orphan shell, empty `node.exe`) | 11432 | 6/9 (stale) | unknown wrapper | INERT — can be killed, will respawn only if something else spawns it |
| **61687** | llama-server (Ollama subprocess, ignore) | 5560 | 6/10 14:06 | Ollama | — |

### Public hostnames (via cloudflared tunnel)

| Hostname | Backend | Status (sweep) |
|---|---|---|
| `https://relay.mobilemonero.com` | relay `:8080` | 200 |
| `https://inbox.partyfavorphoto.com` | relay `:8080` | 200 |
| `https://inbox.mobilemonero.com` | relay `:8080` | 200 |
| `https://hermes.mobilemonero.com` | Hermes phone (off-host) | fleet:agents reports online |

---

## 3. Daemons (long-running processes, NOT a port)

| Daemon | PID | Started | Supervised by | Restart policy |
|---|---|---|---|---|
| `node relay/supervisor.mjs --daemon` (Vex) | 2672 | 6/10 21:58 | **Windows logon task `Vex-Supervisor`** (script ready, awaits admin install — see §4) | n/a — supervises others |
| `node relay/campaign-scheduler.mjs --daemon` | 7480 | 6/10 22:03 | supervisor | max 4/hr |
| `node relay/alice.mjs --daemon` | 7040 | 6/10 22:01 | supervisor (alice slot) | max 4/hr |
| `node relay/cron-engine-v2.mjs` (cron loop) | 11184 | 6/10 21:58 | **supervisor (added 6/10)** | max 4/hr |
| `cloudflared tunnel run` | 10084 | 6/9 21:08 | supervisor (tunnel slot, `wrapperExits:true`) | max 3/hr |

> **Stale-PID reconciliation:** As of 6/10, the supervisor reconciles dead `childPid` entries in `relay-data/supervisor-state.json` on every pre-flight, and prunes legacy service entries from older supervisor versions (`db-manager`, `runtime` were observed in the previous state file and are now removed). One-shot script: `node scripts/reconcile-supervisor-state.mjs`.

---

## 4. Scheduled Tasks (Windows Task Scheduler)

### Active (legacy campaign slots; superseded by `campaign-scheduler.mjs` daemon but kept for backup)

| Task | Action | Last run | State |
|---|---|---|---|
| `XMRT-DAO-4PMCampaign` | `daily-campaign.mjs 50` | 6/9 16:00 | **Ready** (next 6/10 16:00) |
| `XMRT-DAO-DailyCampaign` | `daily-campaign.mjs 50` | 6/10 08:00 | Ready (next 6/11 08:00) |
| `XMRT-DAO-NoonCampaign` | `daily-campaign.mjs 50` | 6/10 12:00 | Ready (next 6/11 12:00) |
| `XMRT-DAO-SeasonalScraper` | `seasonal-scraper.mjs` | 6/9 23:00 | Ready (next tonight 23:00) |

### Disabled (already off)

`XMRT-DAO-2PMCampaign`, `XMRT-DAO-6PMCampaign`, `XMRT-DAO-8PMCampaign`, `XMRT-DAO-10PMCampaign`

### Stale — to be removed via `scripts/delete-stale-tasks.bat` (right-click → Run as admin, single self-elevating script)

| Task | Action | Last run | Days dead | Recommendation |
|---|---|---|---|---|
| `XMRT-DAO-HourlyTaskFetch` | `cron-fetch-tasks.mjs --once` | **2026-05-11 22:00** | **30** | **Delete** (superseded by `relay/alice.mjs --daemon` task-fetch) |
| `XMRT-DAO-HourlyTaskFetch-v2` | `cron-fetch-tasks.mjs --once` | **2026-06-02 23:10** | **8** | **Delete** (same) |
| `XMRT-Relay-Watchdog` | `relay-watchdog.mjs` | **2026-06-02 12:30** | **8** | **Delete** (superseded by `relay/supervisor.mjs`) |
| `VexSupervisor-Heartbeat` | `suite/runtime/supervisor/heartbeat.cmd` | **2026-06-08 23:50** | **2** | **Delete** (superseded; supervisor has its own logon task) |

> The same script also **installs** the `Vex-Supervisor` logon task so the supervisor survives reboot/login.

> **Why a one-time admin step?** Both deletion and `schtasks /create` require elevation (UAC). The `.bat` self-elevates via `Start-Process -Verb RunAs`, so a single right-click → "Run as administrator" executes both steps. Idempotent: safe to re-run.

---

## 5. External Dependencies

### Email (Resend)

| Account | Key prefix | Verified domain | From address | Used by |
|---|---|---|---|---|
| PFP (primary) | `re_BrGV9sSL_...` | `partyfavorphoto.com` (verified, sending+receiving) | `Party Favor Photo <bookings@partyfavorphoto.com>` → reply `joe@partyfavorphoto.com` | `daily-campaign.mjs` (fixed 6/10) |
| XMRT (secondary) | `re_8ypZddMZ_...` | `mobilemonero.com` (partially_failed) | various | NOT currently used by PFP code |

**Rate limit:** 5 req/s. `daily-campaign.mjs` now paces at 250ms with 429 retry.

### Stripe
No `STRIPE_SECRET_KEY` in `relay/.env` (PFP booking links in campaign template are hardcoded `https://buy.stripe.com/...` URLs). Stripe key is in `relay/tools/` scripts only — not on the critical path.

### GitHub
`GITHUB_TOKEN=github_pat_...` in `relay/.env`. Used by tools for repo operations and the gh-deploy workflows.

### Supabase
- **Cloud:** `vawouugtzwmejxqkeqqj.supabase.co` is **DEAD** (NXDOMAIN). Kept commented in `relay/.env` only for the free-tier-fallback shim — do not re-enable as a primary.
- **Local:** `local-supabase/server.mjs` on `:54321` is the canonical replacement. All `relay/server.js` endpoints route here.
- **Alice guard (6/10):** `relay/alice.mjs` now refuses to start if `SUPABASE_URL` is unset instead of falling back to the dead cloud URL. See `relay/alice.mjs:55-63` (fatal guard after `loadEnv()`).

### Cloudflare
- **Tunnel:** `5d954e14-ea46-48e4-bc50-9c3a2be1760c` (named tunnel, 3 hostnames — see §2).
- **Workers:** 17 workers in `cf-workers.json` (all routed).
- **Access service tokens:** 3 agents (Eliza, Vex, Hermes) in `relay/.env` as `CF_ACCESS_CLIENT_*`.

### AI providers (in fallback chain)
1. **Local Ollama** (priority 1) — `OLLAMA_HOST=http://localhost:11434`, `OLLAMA_MODEL=deepseek-v4-flash:cloud` (default; cloud-routed)
2. Ollama Pro — `OLLAMA_API_KEY=4eb2b53f...` (Pro cloud; used for Hermes agent)
3. DeepSeek — `DEEPSEEK_API_KEY=DEEPSEEK_API_KEY_REMOVED` (verified working 6/10)

> **Removed 6/10 (no consumers, dead keys):** Gemini, Kimi, OpenRouter — see §6.

### Other
- **Hermes endpoint** (Android phone agent): `HERMES_ENDPOINT=http://192.168.14.115:9090` — must be reachable on LAN for Alice/relay integrations.
- **MUAPI** (video gen): `MUAPI_API_KEY` — balance reported $10.012 by Alice.

---

## 6. .env Key Inventory (relay/.env)

All active keys verified as of 2026-06-10.

**Active:**
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` — point at local `:54321`
- `LOCAL_RUNTIME_URL` — same as `SUPABASE_URL`; used by cron-engine-v2 for edge function calls
- `LOCAL_DATABASE_URL` — Postgres on `:5432`
- `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_API_KEY`, `OLLAMA_HERMES_API_KEY` — local + Pro cloud
- `DEEPSEEK_API_KEY` — verified 6/10
- `HERMES_ENDPOINT`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_XMRT_API_KEY`, `RESEND_MM_WEBHOOK_SECRET`, `MUAPI_API_KEY`
- `CF_ACCESS_CLIENT_{ID,SECRET}_{ELIZA,VEX,HERMES}` — 3 agent service tokens
- `GITHUB_TOKEN`, `GITHUB_REPO`
- `RELAY_PORT`, `NODE_ENV`

**Removed 6/10 (commented out, no consumers):**
- `GEMINI_API_KEY` — `AQ.Ab8R...` is an OAuth/refresh token, not a Gemini API key. Direct probe: 403 from `generativelanguage.googleapis.com`. Zero consumers in `relay/*` and `local-supabase/*`.
- `KIMI_API_KEY` — `sk-kimi-...` was a placeholder. Direct probe: 401 from `api.moonshot.cn`. Zero consumers.
- `OPENROUTER_API_KEY` — was empty. Zero consumers.

**Flagged (not removed — usage unclear):**
- `LOCAL_OLLAMA_ONLY=1` — name suggests "no cloud fallback" but value is `1`. Read consumers before changing semantics.
- `AI_CHAT_DEBUG_LOG=1` — debug-only, keep at 1 for now.

---

## 7. Boot Order (what depends on what)

If everything is dead, restart in this order:

1. **Postgres** (`pg/`) — must be up before local-sb. Verify: `pg_isready -h 127.0.0.1 -p 5432`
2. **local-sb** (`local-supabase/`, port 54321) — depends on Postgres. Verify: `curl http://127.0.0.1:54321/`
3. **Ollama** (port 11434) — independent, but relay + Alice depend on it. Verify: `curl http://127.0.0.1:11434/api/tags`
4. **Vite** (port 5173) — independent dev server. `cd suite && npm run dev` (only needed if Joe is editing the SupaClaw UI)
5. **Relay** (`relay/server.js`, port 8080) — depends on local-sb + Postgres. Verify: `curl http://localhost:8080/health`
6. **cloudflared** (named tunnel) — depends on Relay for `/health` to be reachable publicly. Verify: `curl https://relay.mobilemonero.com/health`
7. **Alice daemon** (`relay/alice.mjs --daemon`) — depends on Relay. Run via supervisor.
8. **Campaign scheduler** (`relay/campaign-scheduler.mjs --daemon`) — depends on Relay + Resend. Run via supervisor.
9. **Cron-engine-v2** (`relay/cron-engine-v2.mjs`) — depends on Postgres + local-sb. **Supervised** (added 6/10): `cron-engine-v2` slot in supervisor `SERVICES`, `healthCheck: checkProcessByScript('cron-engine-v2.mjs')`. Manual fallback: `node relay/cron-engine-v2.mjs`.
10. **Supervisor** (`relay/supervisor.mjs --daemon`) — should already be running at logon. If not: `node relay/supervisor.mjs --daemon`.

### One-liner health check (post-boot)

```bash
curl -sf http://localhost:8080/health && \
curl -sf http://127.0.0.1:54321/ && \
curl -sf -o /dev/null -w "%{http_code}\n" http://127.0.0.1:11434/api/tags && \
curl -sf -o /dev/null -w "%{http_code}\n" https://relay.mobilemonero.com/health
```

All four should return 200.

---

## 8. Quick-Reference Restart Commands

| Service | Restart |
|---|---|
| Postgres | `node relay/start-pg.mjs` (or supervisor does it) |
| local-sb | `cd local-supabase && node --watch server.mjs` (manual) |
| Relay | supervisor restarts; or `node relay/server.js` |
| Ollama | start from Start menu (system service) |
| Vite | `cd suite && npm run dev` |
| cloudflared | supervisor restarts; or `cloudflared tunnel --config C:\Users\PureTrek\.cloudflared\config.yml run` |
| Alice | supervisor restarts; or `node relay/alice.mjs --daemon` |
| Campaign scheduler | supervisor restarts; or `node relay/campaign-scheduler.mjs --daemon` |
| Cron-engine-v2 | supervisor restarts; or `node relay/cron-engine-v2.mjs` |

---

## 9. Known Issues / Follow-ups

### Resolved 6/10 (tighten pass)

- ✅ **Cron-engine-v2 not in supervisor** — added as `cron-engine-v2` slot in `relay/supervisor.mjs` SERVICES; `healthCheck: checkProcessByScript('cron-engine-v2.mjs')`. Orphan PID 12172 (started by 8am Windows task) was killed; supervisor now owns it (PID 11184).
- ✅ **local-sb PID mismatch** — supervisor now reconciles dead PIDs on every pre-flight via `pidAlive()` + `reconcileStalePids()`. The local-sb slot's stale childPid is nulled; HTTP probe continues to work regardless of which PID owns :54321.
- ✅ **Stale Windows tasks** — `scripts/delete-stale-tasks.bat` is ready; awaits one admin run. Self-elevates via `Start-Process -Verb RunAs`. Idempotent.
- ✅ **Alice dead-cloud fallback** — `relay/alice.mjs:55` no longer defaults to the dead cloud URL. Added fatal guard (alice.mjs:58-63): if `SUPABASE_URL` is unset, log `[FATAL]` and `process.exit(1)`.
- ✅ **Suspicious API keys** — `GEMINI_API_KEY`, `KIMI_API_KEY`, `OPENROUTER_API_KEY` removed (commented out with explanation in `relay/.env`). Verified zero consumers via grep + direct HTTP probe (403/401).
- ✅ **State file legacy entries** — `pruneLegacyState()` removes `db-manager`, `runtime`, and any other services that are no longer in the SERVICES list. Runs every pre-flight.
- ✅ **Supervisor logon task** — `relay-data/supervisor-task.xml` exists; `delete-stale-tasks.bat` installs it as `Vex-Supervisor`.

### Open

- **Admin run pending.** Joe needs to right-click `scripts/delete-stale-tasks.bat` → "Run as administrator" once. After that, `schtasks /query /fo table | findstr /i "XMRT Vex"` should show only the 5 active campaign tasks + `Vex-Supervisor`.
- **`doorman-worker/src/index.js:9` and `cloudflare-workers/*` still reference the dead cloud Supabase URL** — out of scope for relay, but they will 502 if hit. Update during Dockerize pass.
- **Vite dev server is up but not in supervisor.** Will not auto-restart on crash. Acceptable — Vite is dev-only.
- **PostgREST** (`bin/postgrest/`) is bundled but inactive. local-sb implements its own. Leave as-is.
- **Stale `node.exe` PID 11432** (port 49963 etc.) — orphan shell, inert. Kill if it bothers you; it won't respawn.

---

## 10. Files That MUST Exist (kill-switch map)

If any of these files are missing or empty, the corresponding service will silently fail:

| File | Required for |
|------|-------------|
| `relay/.env` | Relay, Alice, daily-campaign, cron-engine-v2 |
| `local-supabase/server.mjs` | local-sb |
| `bin/deno/deno.exe` | local-sb edge functions |
| `bin/postgrest/postgrest.exe` | (optional, not active) |
| `~/.cloudflared/5d954e14-...json` | named tunnel credentials |
| `~/.cloudflared/config.yml` | named tunnel config (3 hostnames) |
| `relay-data/campaign-contacts.json` | daily-campaign (8796 contacts as of sweep) |
| `relay-data/campaign-sent.json` | dedup + 30-day window |
| `relay-data/suppression-list.json` | do-not-contact list |
| `pg/data/` (postgres cluster) | everything that touches local DB |

---

## 11. Duplicate Runtime Protection

The supervisor (`relay/supervisor.mjs`) includes automatic duplicate runtime detection:

- **On pre-flight:** Scans all known service scripts via WMIC, kills duplicate instances, keeps the oldest PID
- **Every health check cycle (30s):** Re-scans and kills any new duplicates that appeared
- **Known scripts monitored:** `server.js`, `supervisor.mjs`, `alice.mjs`, `campaign-scheduler.mjs`, `cron-engine-v2.mjs`, `31harbor-scheduler.mjs`, `cuttlefishclaws-mcp.mjs`, `cuttlefish-mcp.mjs`, `xmrtdao-suite-mcp.mjs`, `start-pg.mjs`, `start-tunnel-detached.mjs`, `start-vite-detached.mjs`
- **Strategy:** Keeps the lowest PID (oldest process), kills all others with `taskkill /F`

### Workspace Policy

- **Canonical workspace:** `~/Desktop/DevGruGold/` — all services start from here
- **Stable base:** `~/Desktop/xmrtdao/` — receives patches from DevGruGold, not for direct service startup
- **Do NOT start services from both workspaces** — the dedup will clean up duplicates, but it's wasteful
- **start-everything.bat** in both workspaces now documents this policy in their headers
