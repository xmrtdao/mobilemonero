# DevGruGold

Local development workspace for the XMRT DAO ecosystem projects.

## Projects

| Directory | Repo | Description |
|-----------|------|-------------|
| `cuttlefishclaws/` | [xmrtdao/cuttlefishclaws](https://github.com/xmrtdao/cuttlefishclaws) | Tributary AI Campus SPA — Vite + React |
| `relay/` | (local) | Express relay server (port 8080) |
| `supabase/` | (local) | Local Supabase replacement (local-sb) |
| `cloudflare-workers/` | (local) | Cloudflare Worker scripts |

## Structure

```
DevGruGold/
├── cuttlefishclaws/          # Vite + React SPA (subtree → xmrtdao/cuttlefishclaws)
│   ├── src/                  # React components, lib, pages
│   ├── docs/                 # Canonical documentation
│   └── dist/                 # Production build (GH Pages)
├── relay/                    # Express relay (port 8080)
├── supabase/                 # Local-sb (PostgREST-compatible)
├── cloudflare-workers/       # CF Worker scripts
└── docs/                     # Ecosystem documentation
```

## Branches

- `work-branch` — active development
- `main` — stable
- `cuttlefish/main` — cuttlefishclaws SPA subtree
- `cuttlefish/master` — GH Pages deploy branch
