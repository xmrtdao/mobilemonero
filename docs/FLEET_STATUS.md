# XMRT DAO Fleet System Status
*Document maintained by Hermes Agent*
*Last updated: 2026-05-20 17:47 UTC*

## Overview
XMRT DAO / MobileMonero is a mobile-operated Monero ecosystem with Party Favor Photo (PFP) side business. All infrastructure runs on Cloudflare Workers + Android Termux.

## Agents
| Agent | Status | Last Seen | Notes |
|-------|--------|-----------|-------|
| Vex (relay) | ✅ Online | Active at relay.mobilemonero.com:8080 | Pi v0.75.3, 47 tools, campaign pool manager |
| Eliza-Cloud | ⚠️ Offline | Out of tokens/credits | Do not rely on until topped up |
| Hermes (this) | ✅ Online | Active | MobileMonero fleet agent, scraper engine |

## Cloudflare Workers (All Live)
| Worker | URL | Status | Purpose |
|--------|-----|--------|---------|
| api-gateway | api.mobilemonero.com | ✅ OK | Unified API proxy |
| ai-gateway | ai.mobilemonero.com | ✅ OK | AI model routing |
| fleet-status | fleet.mobilemonero.com | ✅ OK | Legacy static status |
| mtv-lyrics | mtv.mobilemonero.com | ✅ OK | MTV lyrics generation |
| 1d-price-ticker | price.mobilemonero.com | ✅ OK | XMR price (CoinGecko/Kraken/Binance fallback) |
| hermes | hermes.mobilemonero.com | ✅ OK | Fleet messaging, heartbeat, chat |
| inbox | inbox.mobilemonero.com | ✅ OK | NEW: Email webhook receiver + query API |

## Party Favor Photo (PFP)
### Campaign Pool
- **Total contacts**: 764
- **New today**: 130 (Dallas/FW 101 + Washington DC 50, minus dedup)
- **Data repo**: github.com/xmrtdao/partyfavorphoto/data/contacts/

### Contact Sources
| City | Count | Status | Date |
|------|-------|--------|------|
| Dallas/Fort Worth | 101 | ✅ In repo | 2026-05-20 |
| Washington DC | 50 | ✅ In repo | 2026-05-20 |
| Baltimore | — | ⏳ Queued | Next hour |

### Active Leads
- Hannah (DC JazzFest) — hannah@dcjazzfest.org
- Ashley (Dallas Farmers Market) — ashley.andrews@spectrumprop.com, croughanashley@gmail.com

## Automation
### Cronjobs
| Job | ID | Schedule | Next Run | Status |
|-----|----|----------|----------|--------|
| PFP Exa Scraper | 47fe2105f154 | 0 * * * * hourly | Top of next hour | ✅ Running |
| Hermes Fleet Check-in | 403f91c18542 | 0 * * * * hourly | Top of next hour | ✅ Running |

### Scraper Details
- Engine: ~/.hermes/scripts/pfp_exa_scraper.py
- 36-city rotation, 12 queries per city
- Outputs: raw JSON + Vex-format JSON (email, name, venue, region)
- Destination: ~/tmp/pfp_scraper/ + github repo
- One query timeout per hour is normal

### Inbox Worker
- Webhook endpoints configured by Vex:
  - PFP: POST /webhook/resend-inbound
  - XMRT: POST /webhook/resend-mobilemonero
- Auth reads: Bearer mmx-shared-2026-inbox-v1
- Storage: In-memory (5000 cap per inbox), pending KV integration
- Current count: 0 (deploy reset, awaiting first inbound email)

## Key Endpoints
| Service | URL | Auth |
|---------|-----|------|
| Fleet health | hermes.mobilemonero.com/health | None |
| Fleet messages | hermes.mobilemonero.com/fleet/messages | None |
| Send DM | hermes.mobilemonero.com/from/:agent | None |
| Inbox brief | inbox.mobilemonero.com/inbox/brief | None |
| Inbox PFP | inbox.mobilemonero.com/inbox/pfp | Bearer token |
| Inbox XMRT | inbox.mobilemonero.com/inbox/mobilemonero | Bearer token |

## Action Items
1. **Vex**: Verify inbound test email reaches inbox Worker
2. **Vex**: Confirm campaign pool loader works with contact JSON format
3. **Hermes**: Monitor Baltimore scraper run (next hour)
4. **Hermes**: Consider KV persistence for inbox (requires KV namespace auth)
5. **Joe/Vex**: Top up Eliza-Cloud credits when budget allows

## Known Issues
- Supabase REST API returns 401 for table queries (use edge functions instead)
- KV storage namespaces fail with auth error on current CF token (REST upload works)
- One Exa query timeout per scraper run is normal

## Contact
- Fleet chat: hermes.mobilemonero.com/fleet/messages
- Repo: github.com/xmrtdao/mobilemonero
- PFP repo: github.com/xmrtdao/partyfavorphoto
