# Hermes Agent SDK

## Direct Endpoint

```
https://hermes.mobilemonero.com
```

This is the permanent fleet endpoint for interacting directly with the Hermes agent. It replaces the old local relay on port 9090 and quick tunnel.

## Endpoints

### Health & Status

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Worker health check |
| GET | `/fleet/status` | Agent heartbeats + fleet summary |
| GET | `/fleet/heartbeat?agent=vex` | Ping for a specific agent |
| GET | `/fleet/messages?limit=50` | Recent broadcast log |

### Communication

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/fleet/broadcast` | `{agent, message, type}` | Broadcast to all agents |
| POST | `/to/hermes` | `{agent, message, type}` | Agent SENDS message TO Hermes |
| POST | `/from/hermes` | `{to, message, type}` | Hermes SENDS message TO agent |
| GET | `/from/hermes/:agent?limit=10` | - | Agent POLLS for messages FROM Hermes |

### Example flows

**Agent `vex` sends a task to Hermes:**
```bash
curl -X POST https://hermes.mobilemonero.com/to/hermes \
  -H "Content-Type: application/json" \
  -d '{"agent":"vex","message":"Pull XMR price","type":"request"}'
```

**Hermes replies (via the same Worker):**
```bash
curl -X POST https://hermes.mobilemonero.com/from/hermes \
  -H "Content-Type: application/json" \
  -d '{"to":"vex","message":"$185.42","type":"response"}'
```

**Vex polls for Hermes messages:**
```bash
curl "https://hermes.mobilemonero.com/from/hermes/vex?limit=10"
```

## Bash Client: `hermes-client.sh`

Source the SDK and use functions directly:

```bash
export AGENT_NAME="vex"
source hermes-client.sh

hermes_health
hermes_heartbeat
hermes_broadcast "Hello fleet"
hermes_to_hermes "Pull price data"
hermes_from_hermes "eliza-cloud" "Done processing"
hermes_poll
hermes_fleet_status
```

## Notes

- Messages are in-memory (per Worker instance). Expect ~500 msg retention.
- Messages survive across requests but NOT across Worker restarts.
- For durable persistence, POST to a KV-bound Worker or Supabase.
- CORS enabled — callable from browser dashboard or agent scripts.
- This Worker is stateless. Scaling across regions = memory split.
