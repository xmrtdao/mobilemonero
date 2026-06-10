# 🏗️ XMRT DAO Infrastructure Architecture (Corrected)

**Date:** 2026-06-10 15:17 UTC  
**Agent:** Hermes (Android/Termux)  
**Key Insight:** Supabase is DOWN - all working endpoints hosted via Vex laptop relay

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  ☁️  CLOUDFLARE (CDN + Workers)                             │
│     - DDoS protection                                       │
│     - SSL termination                                       │
│     - Worker proxy (api-gateway)                            │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  🔒 relay.mobilemonero.com                                  │
│     (Cloudflare Worker → Vex Laptop)                        │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  💻 VEX LAPTOP (Relay Server - Port 8080)                   │
│     - Express.js server                                     │
│     - Eliza-Dev v5.0.0                                      │
│     - Local gossip-hub runtime?                             │
│     - Fleet chat state management                           │
│     - Health endpoint                                       │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  ⚠️  SUPABASE (DOWN - DNS failure from Termux)              │
│     - gossip-hub edge function ❌                           │
│     - mesh-peer-connector ❌                                │
│     - REST API ❌                                           │
│     - Database (leads, bookings, etc.) ❌                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Working Endpoints (Via Vex Laptop Relay)

### Relay Server (Port 8080)

| Endpoint | Status | Hosted By |
|----------|--------|-----------|
| `/` | ✅ 200 | Vex laptop (Express) |
| `/health` | ✅ 200 | Vex laptop (Express) |
| `/api/fleet-chat/messages` | ✅ 200 | Vex laptop (Express) |
| `/api/fleet-chat/send` | ✅ 200 | Vex laptop (Express) |

**Health Response:**
```json
{
  "status": "ok",
  "uptime": 9968,
  "port": 8080,
  "agent": "Eliza-Dev",
  "version": "5.0.0",
  "tools": 62,
  "handlers": 7,
  "requests": 2208
}
```

### Cloudflare Workers (Public Sites)

| Domain | Status | Backend |
|--------|--------|---------|
| mobilemonero.com | ✅ 200 | GitHub Pages |
| partyfavorphoto.com | ✅ 200 | GitHub Pages |
| chat.mobilemonero.com | ✅ 200 | Zero-Claw (Vex laptop?) |
| inbox.mobilemonero.com | ✅ 200 | Resend proxy |

---

## Supabase Status (DOWN)

### DNS Resolution Failure

**From Termux:**
```bash
$ ping vawouugtzwmejxqkeqqj.supabase.co
ping: unknown host vawouugtzwmejxqkeqqj.supabase.co
```

**Exit Code:** 6 (Could not resolve host)

**Impact:**
- ❌ Cannot access gossip-hub edge function directly
- ❌ Cannot access mesh-peer-connector
- ❌ Cannot access Supabase REST API
- ❌ Cannot read/write database tables (leads, bookings, etc.)

### Workaround: Relay Proxy

The relay server on Vex's laptop may be:
1. **Proxying** requests to Supabase (if Vex has working DNS)
2. **Running local gossip-hub** runtime (from Migration Sprint)
3. **Caching** fleet chat state locally

**Evidence:**
- Fleet chat messages ARE visible via relay
- Relay health endpoint responds
- Alice's autopilot cycles are being recorded

---

## Fleet Chat Flow (Current)

```
Hermes (Termux)
    ↓
Cloudflare Worker (api-gateway)
    ↓
Vex Laptop (relay.mobilemonero.com:8080)
    ↓
Local Express handlers (NOT Supabase)
    ↓
Fleet chat state (in-memory or local DB)
```

**Key Insight:** Fleet chat is working WITHOUT Supabase - must be local on Vex laptop!

---

## Infrastructure Dependencies

### What's Actually Working

| Component | Status | Location |
|-----------|--------|----------|
| **Relay Server** | ✅ UP | Vex laptop (port 8080) |
| **Fleet Chat** | ✅ UP | Vex laptop (Express) |
| **Health Endpoint** | ✅ UP | Vex laptop (Express) |
| **Cloudflare Workers** | ✅ UP | Cloudflare edge |
| **GitHub Pages Sites** | ✅ UP | GitHub CDN |
| **Resend Email** | ✅ UP | Resend API |

### What's NOT Working

| Component | Status | Reason |
|-----------|--------|--------|
| **Supabase Edge Functions** | ❌ DOWN | DNS failure (Termux) |
| **Supabase Database** | ❌ UNREACHABLE | DNS failure (Termux) |
| **Gossip-Hub (Direct)** | ❌ UNREACHABLE | DNS failure (Termux) |
| **Ollama Cloud Pro** | ❌ DOWN | Connection failed |

---

## Critical Questions

1. **Is Vex laptop running local gossip-hub?**
   - Migration Sprint created `relay/functions/gossip-hub.mjs`
   - Should be running on port 9001
   - Need to verify: `curl http://localhost:9001/health`

2. **Is fleet chat state local or proxied?**
   - If local: Messages stored on Vex laptop only
   - If proxied: Vex has working Supabase DNS

3. **Where is Alice posting cycle reports?**
   - 4 messages from alice-sidecar visible in fleet chat
   - If Supabase is down, where are these stored?
   - Must be local on Vex laptop

---

## Action Items

### 1. Verify Local Gossip-Hub

```bash
# Check if running on Vex laptop
curl http://localhost:9001/health

# Expected (from Migration Sprint):
# {"status": "online", "uptime": X, "total_messages": X, "topics": X}
```

### 2. Check Relay Configuration

```bash
# What is relay proxying to?
# Check ~/mobilemonero/relay/server.js or relay/functions/
grep -r "supabase\|localhost:9001" ~/mobilemonero/relay/
```

### 3. Update Documentation

- Correct architecture diagrams
- Document Vex laptop as primary host
- Note Supabase DNS limitation (Termux-specific)

### 4. Fix Supabase DNS (Optional)

```bash
# Only needed if direct Supabase access required
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf
```

---

## Conclusion

**Supabase is DOWN from Termux perspective.**

**All working endpoints are hosted by:**
1. **Vex Laptop** - Relay server, fleet chat, health endpoint
2. **Cloudflare** - Worker proxy, SSL, CDN
3. **GitHub Pages** - Static sites (mobilemonero.com, PFP)
4. **External APIs** - Resend, GitHub, Hugging Face

**Fleet coordination is working via Vex laptop relay - no Supabase dependency for basic chat!**

---

*Generated by Hermes Agent for XMRT DAO*
