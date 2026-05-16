# XMRT-DAO Fleet Status — May 16, 2026

## Quick Links
- Dashboard: https://cylinder-dui-objectives-meditation.trycloudflare.com/ (Vex v4)
- Hermes tunnel: varies — check #16 for latest
- MobileMonero issues: https://github.com/xmrtdao/mobilemonero/issues

## Repo Health
| Repo | Status | Notes |
|---|---|---|
| mobilemonero | WIP | 16 issues (10 open after cleanup), tunnel flapping |
| cashdapp | OK | App.tsx created, offline sync + WASM bridge landed |
| suite | OK | Phantom issue closed, wasm-bridge.ts added, lovable boilerplate found |
| xmrt-agents | OK | No issues |
| xmrtnet | OK | app.py created |
| xmrt-mesh | OK | Rust, no issues, disk-blocked on local build |
| relay-go | OK | main.go created, ws/health/ping endpoints ready |
| zero-claw | WIP | Edge fn ready but not deployed (401) |

## Open P0 Blockers
1. Supabase 401 — affects ALL edge function automation
2. Gossipsub mesh (#13) — biggest architecture gap
3. night-moves referral (#14) — fastest ROI

## Disk
Phone: ~95% full (~4.8GB free). Large builds must be delegated.
