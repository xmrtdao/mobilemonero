# XMRT Mesh Node — Distributed Setup
# Each agent runs this locally, then they form a fault-tolerant mesh

---

## 1. Requirements

- Python 3.9+ with `requests` module
  ```bash
  python3 -m pip install requests
  ```
- Port open for chosen agent port

---

## 2. Quick Start Per Agent

### Hermes (Termux ARM64)
```bash
python3 mesh-node.py hermes 'vex-ip:4002,eliza-ip:4003'
```

### Vex (Windows/Linux/cloud)
```bash
python3 mesh-node.py vex 'hermes-ip:4001,eliza-ip:4003'
```

### Eliza (Cloud VM/container)
```bash
python3 mesh-node.py eliza 'hermes-ip:4001,vex-ip:4002'
```

---

## 3. Environment Variable Alternative

Instead of CLI peers, you can set:
```bash
export MESH_PEERS="hermes-ip:4001,vex-ip:4002"
python3 mesh-node.py eliza
```

---

## 4. Current Fleet IP Assignment

| Agent | Port | Expected IP/Host |
|-------|------|------------------|
| Hermes | 4001 | 127.0.0.1 (this device) / or public IP via CF tunnel |
| Vex | 4002 | Vex's relay host (PureTrek) |
| Eliza | 4003 | Eliza's cloud host |

**Note:** For now, all 3 nodes are running locally on Hermes device (`127.0.0.1`) for testing. In production, replace `127.0.0.1` with actual public IPs or use Cloudflare tunnel.

---

## 5. Test Connectivity

```bash
curl http://port:4001/health
curl -X POST http://port:4001/broadcast \
  -H "Content-Type: application/json" \
  -d '{"agent":"hermes","message":"hello mesh","type":"broadcast"}'
curl http://port:4002/messages
curl http://port:4003/messages
```

---

## 6. Start All 3 Nodes (on Hermes for testing)

```bash
chmod +x setup-mesh.sh
./setup-mesh.sh all
```

---

## 7. Mesh-Fleet Bridge

To bridge mesh messages to/from the cloud relay:
```bash
python3 mesh-fleet-bridge.py
```

This connects the mesh to `relay.mobilemonero.com` so messages flow both ways.

---

**Status:** Local test mesh running. Needs Vex + Eliza real IPs for production.
