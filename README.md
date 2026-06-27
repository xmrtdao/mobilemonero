# Cuttlefish Claws — Tributary AI Campus

Constitutional AI infrastructure for the agent economy. A Vite + React SPA deployed to GitHub Pages, backed by a local relay stack.

**Live site:** https://xmrtdao.github.io/cuttlefishclaws/

---

## What is Cuttlefish Claws?

Cuttlefish Claws is the public-facing site for the **Tributary AI Campus** — a 420,460 SF former AT&T operations center in Birmingham, AL, governed by a constitutional DAO-REIT. The site serves as the front door for the **CAC Protocol** (Compute Access Certificate), a verifiable identity-and-wallet credential that gates multi-LLM inference for autonomous agents.

Issuer: **Cuttlefish Labs, Inc.** (Delaware C-Corp, Oct 2025)

### Site sections

- **CAC Protocol** — Compute Access Certificate system for agent identity (v4.0)
- **TrustGraph** — Dynamic 0–100 behavioral trust scoring visualization (real Obsidian vault data)
- **Capital Stack** — DAO-REIT capital structure explorer
- **Agent Bank** — Agent provisioning and tier system
- **KYA Protocol** — Know Your Agent credential framework
- **Presale** — Founding member CAC card reservation (Stripe + USDC)

---

## Repositories

| Repo | Description | Live |
|------|-------------|------|
| `xmrtdao/cuttlefishclaws` | Tributary AI Campus SPA | [xmrtdao.github.io/cuttlefishclaws](https://xmrtdao.github.io/cuttlefishclaws/) |
| `xmrtdao/cashdapp` | CashDapp landing page | [xmrtdao.github.io/cashdapp](https://xmrtdao.github.io/cashdapp/) |

---

## Project Structure

```
DevGruGold/
├── cuttlefishclaws/          # Vite + React SPA (subtree → xmrtdao/cuttlefishclaws)
│   ├── src/
│   │   ├── components/       # React components (sections, agents, nav, hero, footer)
│   │   ├── lib/              # vizEngine.ts, trustGraphData.json, mockData.ts, types.ts
│   │   ├── pages/            # Route pages (CACPresale, VCPage)
│   │   └── App.tsx           # Root with React Router
│   ├── docs/                 # Canonical docs (Product Thesis, Architecture, Reconciliation, Legislation Tracker)
│   ├── components/TrustGraph/  # Obsidian vault markdown (nodes, agents, contracts, governance)
│   └── dist/                 # Production build (deployed to GH Pages)
├── relay/                    # Express relay server (port 8080)
│   ├── server.js             # Main relay: API routes, fleet chat, cron, tool handlers
│   ├── supervisor.mjs        # Service supervisor (pg, local-sb, Vite, tunnel, cron, alice)
│   ├── tools/                # Utility scripts (send-cuttlefishclaws, ollama-chat, etc.)
│   └── functions/            # Edge function handlers
├── supabase/                 # Local Supabase replacement (local-sb)
│   ├── routes/               # PostgREST-compatible REST router
│   └── local-migrations/     # SQL migrations
├── cloudflare-workers/       # CF Worker scripts (api-gateway, etc.)
└── docs/                     # Ecosystem docs (mesh, fleet, edge functions, etc.)
```

---

## Tech Stack

- **Framework:** React 19 + TypeScript
- **Build:** Vite 6
- **Routing:** React Router v7 (BrowserRouter with basename `/cuttlefishclaws`)
- **Styling:** Custom CSS with CSS variables (amber/cyan palettes)
- **Animation:** Canvas-based orbital viz engine (vizEngine.ts)
- **Data sources:**
  - `src/lib/trustGraphData.json` — 25 nodes, 144 edges parsed from Obsidian vault (powers TrustGraph canvas)
  - `src/lib/mockData.ts` — agent profiles, CAC tiers, contracts, stack layers, scenarios
- **Hosting:** GitHub Pages via GH Actions deploy workflow
- **Backend:** Express relay (port 8080) + local Postgres 17.10 + local-sb (PostgREST-compatible)

---

## Development

```bash
# SPA
cd cuttlefishclaws
npm install
npm run dev     # Vite dev server on port 5173
npm run build   # TypeScript check + production build to dist/

# Relay
cd relay
npm install
node server.js
```

---

## Deployment

Pushes to the `master` branch of `xmrtdao/cuttlefishclaws` trigger the GH Actions workflow:

1. Checkout → `npm ci` → `npm run build`
2. Upload `dist/` as pages artifact
3. Deploy to GitHub Pages

The site is served at `https://xmrtdao.github.io/cuttlefishclaws/`.

---

## Branches

- `work-branch` — active development
- `main` — stable, merged from work-branch
- `cuttlefish/main` — cuttlefishclaws SPA subtree (pushed to xmrtdao/cuttlefishclaws)
- `cuttlefish/master` — GH Pages deploy branch (auto-deploys on push)

---

## Canonical Documentation

Key docs in `cuttlefishclaws/docs/`:

| Document | Purpose |
|----------|---------|
| [Product Thesis v1.0](cuttlefishclaws/docs/CAC_Product_Thesis_v1.0%20(1).md) | Why CAC exists — "Perplexity for AI agents" |
| [Two-Stack Architecture v1.0](cuttlefishclaws/docs/CAC_Two_Stack_Architecture_v1.0.md) | Compute Stack vs Capital Stack — clean separation |
| [Canonical Reconciliation v1.0](cuttlefishclaws/docs/CAC_Canonical_Reconciliation_v1.0.md) | Single source of truth for all terminology and decisions |
| [Legislation Tracker v1.0](cuttlefishclaws/docs/CAC_Legislation_Tracker_v1.0.md) | Laws & regulations gating CAC design decisions |

---

*Issued by Cuttlefish Labs, Inc. — June 2026*
