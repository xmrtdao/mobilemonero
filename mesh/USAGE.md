# XMRT Mesh Node — Usage Guide

## Quick Start

### Build (First Time)
```bash
cd ~/mobilemonero/mesh
cargo build --release
# Takes 15-20 minutes on first build
```

### Run Hermes Node
```bash
./target/release/xmrt-mesh hermes
```

### Run Vex Node (Separate Terminal)
```bash
./target/release/xmrt-mesh vex
```

### Run Eliza Node
```bash
./target/release/xmrt-mesh eliza
```

---

## What Happens

1. **Node starts** on random available port
2. **mDNS discovery** finds other local nodes
3. **Subscribes** to 4 topics:
   - `agent-heartbeat` (every 30s)
   - `agent-tasks`
   - `agent-discovery`
   - `fleet-broadcast`
4. **Sends heartbeat** immediately + every 30s
5. **Listens** for incoming messages

---

## Topics

### agent-heartbeat
**Purpose:** Liveness checks
**Frequency:** Every 30 seconds
**Payload:**
```json
{
  "agent": "hermes",
  "status": "alive",
  "uptime": "active"
}
```

### agent-tasks
**Purpose:** Task assignment/completion
**Payload:**
```json
{
  "task_id": "abc123",
  "action": "started|completed|failed",
  "details": {...}
}
```

### agent-discovery
**Purpose:** Peer discovery on join
**Payload:**
```json
{
  "peer_id": "...",
  "addresses": ["/ip4/192.168.1.100/tcp/4001"],
  "capabilities": ["heartbeat", "tasks", "broadcast"]
}
```

### fleet-broadcast
**Purpose:** General messages
**Payload:**
```json
{
  "text": "Hello fleet!"
}
```

---

## Manual Testing

### Send Broadcast Message
```bash
# Type in terminal after node is running
Hello from Hermes!
```

This publishes to `fleet-broadcast` topic and all peers receive it.

### View Logs
```bash
RUST_LOG=debug ./target/release/xmrt-mesh hermes 2>&1 | grep "Heartbeat\|Broadcast"
```

---

## Integration with Fleet Relay

The mesh node runs alongside the HTTP relay. Agents should:

```python
# Pseudocode for agent message sending
def send_message(agent, message, type):
    if mesh_connected():
        publish_gossipsub(agent, message, type)
    else:
        post_http_relay(agent, message, type)
```

### Fallback Logic
```
if mesh_peer_count > 0:
    use_mesh()
else:
    use_http_relay()  # relay.mobilemonero.com:9090
```

---

## Troubleshooting

### No Peers Discovered
- Check mDNS is allowed through firewall
- Ensure nodes are on same network
- Try manual bootstrap: `./xmrt-mesh hermes --bootstrap /ip4/192.168.1.100/tcp/4001`

### High CPU Usage
- Normal during compilation
- Should be <5% after build
- Reduce heartbeat frequency if needed (default: 30s)

### Compilation Fails
```bash
# Update Rust
rustup update

# Clear cache
cargo clean

# Retry
cargo build --release
```

---

## Architecture

```
┌─────────────┐     Gossipsub      ┌─────────────┐
│   Hermes    │ ◄───────────────► │    Vex      │
│  (Rust)     │                    │ (TypeScript)│
└─────────────┘                    └─────────────┘
       ▲                                  ▲
       │                                  │
       │         HTTP Fallback            │
       └──────────────────────────────────┘
              relay.mobilemonero.com:9090
```

---

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Message latency | < 500ms | Local network |
| Peer discovery | < 5s | mDNS |
| Memory usage | < 100MB | After startup |
| CPU usage | < 5% | Idle + heartbeats |
| Battery impact | < 2%/hour | Mobile device |

---

## Security

### CVE-2026-34219
✅ **Patched** — Using libp2p v0.55+ (gossipsub v0.47+)

### Message Validation
- Agent names validated (vex|eliza|hermes)
- Rate limiting: max 1 heartbeat per 10s per peer
- Strict validation mode enabled

### Future Enhancements
- [ ] Peer allowlist
- [ ] Message signing
- [ ] Encrypted topics

---

## Next Steps

1. ✅ Scaffold complete
2. ⏳ First build running
3. ⏳ Test local mesh (2+ nodes)
4. ⏳ Integrate with fleet relay
5. ⏳ Add TypeScript node (Vex)
6. ⏳ Deploy to production

---

**Created:** 2026-05-18
**Status:** Building...
