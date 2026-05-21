# XMRT DAO Relay — Mesh & Agent Runtime

This directory contains the **Gossipsub mesh node** and **health monitoring** for XMRT DAO agents. The full relay server (Express.js, 47+ tools) runs on Vex's Windows machine.

## Files

| File | Description |
|------|-------------|
| [`lib/mesh-router.mjs`](lib/mesh-router.mjs) | Gossipsub libp2p node — Phase 1 of Issue #13. 4 topics, message validation, 30s heartbeats, Express router. |
| [`node-health.sh`](node-health.sh) | 13-check health probe — relay, gossipsub, Python mesh, tunnel, CF workers, Ollama. |

## Quick Start

```bash
# Initialize gossipsub node
curl -X POST http://localhost:8080/mesh/init \
  -H "Content-Type: application/json" \
  -d '{"port":9000,"agentName":"vex"}'

# Check status
curl http://localhost:8080/mesh/status

# Publish to a topic
curl -X POST http://localhost:8080/mesh/publish \
  -H "Content-Type: application/json" \
  -d '{"topic":"fleet-broadcast","payload":{"message":"hello"}}'
```

For the full node architecture (deployment targets, port map, startup sequence), see [`docs/NODE_ARCHITECTURE.md`](../docs/NODE_ARCHITECTURE.md).
