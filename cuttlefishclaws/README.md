# Cuttlefishclaws — Tributary AI Campus

Constitutional AI infrastructure for the agent economy. A Vite + React SPA deployed to GitHub Pages.

**Live site:** https://xmrtdao.github.io/cuttlefishclaws/

## Overview

The Tributary AI Campus is a 420,460 SF former AT&T operations center in Birmingham, AL, governed by a constitutional DAO-REIT. This SPA serves as the public-facing site with:

- **CAC Protocol** — Compute Access Certificate system for agent identity
- **TrustGraph** — Real-time agent trust scoring visualization
- **Capital Stack** — DAO-REIT capital structure explorer
- **Agent Bank** — Agent provisioning and tier system
- **KYA Protocol** — Know Your Agent credential framework
- **Presale** — Founding member CAC card reservation (Stripe + USDC)

## Tech Stack

- **Framework:** React 19 + TypeScript
- **Build:** Vite 6
- **Routing:** React Router v7 (BrowserRouter with basename `/cuttlefishclaws`)
- **Styling:** Custom CSS with CSS variables (amber/cyan palettes)
- **Animation:** Canvas-based orbital viz engine (vizEngine.ts)
- **Hosting:** GitHub Pages via GH Actions deploy workflow

## Development

```bash
npm install
npm run dev     # Vite dev server on port 5173
npm run build   # TypeScript check + production build to dist/
```

## Deployment

Pushes to the `master` branch trigger the GH Actions workflow (`.github/workflows/deploy.yml`):

1. Checkout → `npm ci` → `npm run build`
2. Upload `dist/` as pages artifact
3. Deploy to GitHub Pages

The site is served at `https://xmrtdao.github.io/cuttlefishclaws/`.

## Architecture

- **Static SPA** — no backend required. Data sources:
  - `src/lib/trustGraphData.json` — 25 nodes, 144 edges parsed from Obsidian vault (powers TrustGraph canvas)
  - `src/lib/mockData.ts` — agent profiles, CAC tiers, contracts, stack layers, scenarios
- **Forms** — POST to `relay.mobilemonero.com/api/contact/cuttlefishclaws` with try/catch fallbacks
- **Canvas engines** — Three independent canvas renderers (vizEngine, CapitalStack, TrustGraphSection) each with their own `requestAnimationFrame` loop
- **Routes:** `/` (main), `/presale` (CAC reservation), `/vc` (VC access), `/investors` (investor portal)

## Project Structure

```
src/
├── components/
│   ├── sections/     # Page sections (CAC, Capital, TrustGraph, etc.)
│   ├── agents/       # Agent chat modal
│   ├── Nav.tsx       # Top navigation
│   ├── Hero.tsx      # Hero with canvas viz
│   └── Footer.tsx
├── hooks/            # usePalette, useScrollReveal
├── lib/
│   ├── vizEngine.ts  # Canvas orbital animation engine (1745 lines)
│   ├── trustGraphData.json  # 25 nodes, 144 edges from Obsidian vault
│   ├── mockData.ts   # Agent profiles, CAC tiers, contracts, scenarios
│   └── types.ts      # TypeScript interfaces
├── pages/            # Route pages (CACPresale, VCPage)
└── App.tsx           # Root component with routing
```
