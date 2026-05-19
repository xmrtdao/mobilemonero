# Gossipsub Mesh Layer — Research & Implementation Plan

**Issue:** #13 — P0: Gossipsub Mesh Layer (UNASSIGNED)
**Priority:** P0 (Biggest architectural gap)
**Owner:** Hermes (Termux ARM64)

---

## Problem Statement

Current fleet communication relies on central relay at `relay.mobilemonero.com:9090`. This is a **single point of failure**. If the relay goes down, agents can't coordinate.

**Goal:** Decentralized P2P mesh using libp2p Gossipsub where each agent runs a node and messages propagate peer-to-peer.

---

## libp2p Gossipsub Options

### Option 1: Rust (Recommended for Hermes/Termux)
**Crate:** `libp2p-gossipsub`
**Repo:** https://github.com/libp2p/rust-libp2p

**Pros:**
- ✅ Native ARM64 support (compiles on Termux)
- ✅ Well-maintained (latest release: 2026-04)
- ✅ CVE-2026-34219 patched in v0.47.0+
- ✅ Low memory footprint (~50MB RAM)
- ✅ Async runtime (tokio)

**Cons:**
- ⚠️ Compilation time on mobile (~15-20 mins)
- ⚠️ Steep learning curve

**Version:** `libp2p = "0.55"` (includes gossipsub v0.47)

---

### Option 2: TypeScript (For Vex Relay)
**Package:** `@chainsafe/libp2p-gossipsub`
**Repo:** https://github.com/ChainSafe/js-libp2p-gossipsub

**Pros:**
- ✅ Easy integration with existing Vex relay (Node.js)
- ✅ Good documentation
- ✅ Active maintenance

**Cons:**
- ⚠️ Higher memory usage (~150MB RAM)
- ⚠️ Slower message propagation than Rust

**Version:** `@chainsafe/libp2p-gossipsub: ^11.0`

---

### Option 3: Go (Future: Dedicated Mesh Node)
**Package:** `github.com/libp2p/go-libp2p-pubsub`
**Repo:** https://github.com/libp2p/go-libp2p-pubsub

**Pros:**
- ✅ Fastest message propagation
- ✅ Production-tested (used by Filecoin, Ethereum 2.0)
- ✅ Can run as standalone mesh relay

**Cons:**
- ⚠️ Not needed yet (Rust covers Hermes, TS covers Vex)

---

## Architecture

### Topics (4 Core Channels)

| Topic | Purpose | Message Format | Frequency |
|-------|---------|----------------|-----------|
| `agent-heartbeat` | Liveness checks | `{agent, ts, status}` | Every 30s |
| `agent-tasks` | Task assignment/completion | `{agent, task_id, action, payload}` | On-demand |
| `agent-discovery` | Peer discovery | `{agent, peer_id, addresses[], capabilities}` | On join |
| `fleet-broadcast` | General messages | `{agent, message, type, ts}` | On-demand |

### Message Flow

```
1. Hermes publishes to `agent-heartbeat`
   ↓
2. Gossipsub propagates to Vex + Eliza
   ↓
3. Each agent receives + logs heartbeat
   ↓
4. If agent missing for 90s → mark as offline
```

### Fallback Strategy

```
if mesh_connected:
    send_via_gossipsub()
else:
    send_via_http_relay()  # Fallback to relay.mobilemonero.com
```

---

## Implementation Plan

### Phase 1: Rust Scaffold (Hermes)
**Time:** 2-3 hours
**Deliverable:** Basic node that can publish/subscribe

**Steps:**
1. Create Cargo project
2. Add libp2p dependencies
3. Implement TCP + mDNS transport
4. Implement gossipsub protocol
5. Test local publish/subscribe

**File Structure:**
```
~/mobilemonero/mesh/
├── Cargo.toml
├── src/
│   ├── main.rs
│   ├── config.rs
│   ├── topics.rs
│   └── messages.rs
```

---

### Phase 2: TypeScript Integration (Vex)
**Time:** 1-2 hours
**Deliverable:** Vex relay joins mesh

**Steps:**
1. Add `@chainsafe/libp2p-gossipsub` to Vex relay
2. Configure same topic validators
3. Test cross-language message propagation

---

### Phase 3: Fleet Integration
**Time:** 1 hour
**Deliverable:** Agents use mesh by default, HTTP as fallback

**Steps:**
1. Add mesh detection logic
2. Implement fallback to HTTP relay
3. Add mesh status to fleet dashboard

---

## Dependencies (Rust)

```toml
[dependencies]
libp2p = { version = "0.55", features = [
    "gossipsub",
    "tcp",
    "mdns",
    "dns",
    "tokio",
    "macros"
] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
```

---

## Security Considerations

### CVE-2026-34219
**Affected:** rust-libp2p < v0.54
**Fix:** Use libp2p v0.55+ (includes gossipsub v0.47+)
**Status:** ✅ Patched in our version

### Message Validation
- Validate agent names (vex|eliza|hermes)
- Rate limit heartbeats (max 1 per 10s per peer)
- Reject messages from unknown peers (optional, may want open mesh)

---

## Testing Plan

### Local Test (Single Device)
```bash
# Terminal 1: Hermes node
cd ~/mobilemonero/mesh
cargo run -- --port 4001

# Terminal 2: Vex node (simulated)
cargo run -- --port 4002
```

Expected: Nodes discover each other via mDNS, exchange heartbeats.

### Cross-Device Test (2+ Devices)
```bash
# Device 1 (Hermes):
cargo run -- --port 4001 --bootstrap /ip4/192.168.1.100/tcp/4002

# Device 2 (Vex):
cargo run -- --port 4002
```

Expected: Nodes connect via TCP, propagate messages.

---

## Success Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Message latency | < 500ms | N/A (relay: ~100ms) |
| Peer discovery time | < 5s | N/A |
| Memory usage | < 100MB | N/A |
| CPU usage | < 5% | N/A |
| Uptime | 99.9% | Relay: ~95% |

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Compilation fails on ARM64 | Low | High | Use pre-built binaries from GitHub Releases |
| High battery drain | Medium | Medium | Implement sleep mode when idle |
| Message flooding | Low | High | Rate limit + message validation |
| NAT traversal issues | Medium | Medium | Use relay nodes for public connectivity |

---

## Next Steps

1. ✅ Research complete (this doc)
2. ⏳ Scaffold Rust project
3. ⏳ Implement basic publish/subscribe
4. ⏳ Test local mesh
5. ⏳ Integrate with fleet relay
6. ⏳ Document for Vex + Eliza

---

**References:**
- https://docs.libp2p.io/concepts/publish-subscribe/
- https://github.com/libp2p/specs/tree/master/pubsub/gossipsub
- https://github.com/libp2p/rust-libp2p/tree/master/examples/gossipsub

---

**Created:** 2026-05-18
**Last Updated:** 2026-05-18
