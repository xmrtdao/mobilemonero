# 📡 Meshtastic Edge Function Draft

**Purpose:** Enable fleet agents to send/receive mesh messages via relay

**Status:** Draft - Ready for Vex implementation

---

## Edge Function: `meshtastic-bridge`

### Location
`~/mobilemonero/relay/functions/meshtastic-bridge/index.ts`

### API Endpoints

```typescript
POST /functions/v1/meshtastic-bridge
{
  "action": "send" | "receive" | "status" | "configure",
  "message": string,          // for send
  "destination": string,      // node ID or "!broadcast"
  "channel": number           // default 0 (primary)
}
```

---

## Implementation Draft

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const MESHTASTIC_MAC = Deno.env.get("MESHTASTIC_MAC") || "00:00:00:00:00:00"

serve(async (req: Request) => {
  // CORS headers
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-certificate-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  }
  
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors })
  }
  
  try {
    const { action, message, destination, channel = 0 } = await req.json()
    
    switch (action) {
      case "send":
        return await sendMessage(message, destination, channel)
      
      case "receive":
        return await receiveMessages(channel)
      
      case "status":
        return await getDeviceStatus()
      
      case "configure":
        return await configureDevice(channel)
      
      default:
        return new Response(
          JSON.stringify({ error: "Unknown action" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        )
    }
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    )
  }
})

async function sendMessage(message: string, destination: string, channel: number) {
  // Call meshtastic CLI via Deno.Command
  const command = new Deno.Command("python3", {
    args: [
      "-c",
      `from meshtastic.ble_interface import BLEInterface; ` +
      `with BLEInterface("${MESHTASTIC_MAC}") as i: ` +
      `i.sendText("${message}", "${destination}")`
    ],
  })
  
  const { stdout, stderr, code } = await command.output()
  
  if (code === 0) {
    return new Response(
      JSON.stringify({ success: true, message: "Sent" }),
      { headers: { ...cors, "Content-Type": "application/json" } }
    )
  } else {
    throw new Error(new TextDecoder().decode(stderr))
  }
}

async function getDeviceStatus() {
  return new Response(
    JSON.stringify({
      status: "ready",
      mac: MESHTASTIC_MAC,
      connected: true, // Would check actual connection
      channel: 0,
    }),
    { headers: { ...cors, "Content-Type": "application/json" } }
  )
}

async function receiveMessages(channel: number) {
  // Would implement message queue/listener
  return new Response(
    JSON.stringify({ messages: [] }),
    { headers: { ...cors, "Content-Type": "application/json" } }
  )
}

async function configureDevice(channel: number) {
  // Would configure LoRa settings, region, etc.
  return new Response(
    JSON.stringify({ success: true, channel }),
    { headers: { ...cors, "Content-Type": "application/json" } }
  )
}
```

---

## Usage Examples

### Send Fleet Message
```bash
curl -X POST https://relay.mobilemonero.com/functions/v1/meshtastic-bridge \
  -H "x-certificate-id: XMRT-CERT-RMJTYENN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "send",
    "message": "Hermes check-in: All systems operational",
    "destination": "!broadcast",
    "channel": 0
  }'
```

### Get Device Status
```bash
curl -X POST https://relay.mobilemonero.com/functions/v1/meshtastic-bridge \
  -H "x-certificate-id: XMRT-CERT-RMJTYENN" \
  -H "Content-Type: application/json" \
  -d '{"action": "status"}'
```

### Receive Messages
```bash
curl -X POST https://relay.mobilemonero.com/functions/v1/meshtastic-bridge \
  -H "x-certificate-id: XMRT-CERT-RMJTYENN" \
  -H "Content-Type: application/json" \
  -d '{"action": "receive", "channel": 0}'
```

---

## Integration with Fleet Chat

### Auto-Post Mesh Messages to Fleet Chat
```typescript
// When mesh message received
async function onMeshMessage(packet: Packet) {
  const message = packet.decoded.payload.text
  const fromNode = packet.from
  
  // Post to fleet chat
  await fetch("https://relay.mobilemonero.com/api/fleet-chat/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: "meshtastic-bridge",
      message: `📡 Mesh: ${message} (from: ${fromNode})`,
      channel: "all"
    })
  })
}
```

### Fleet Chat → Mesh Bridge
```typescript
// When fleet chat message received
async function onFleetMessage(msg: FleetMessage) {
  if (msg.agent === "hermes" && msg.message.includes("[MESH]")) {
    // Extract and send to mesh
    const meshMessage = msg.message.replace("[MESH]", "").trim()
    await sendMessage(meshMessage, "!broadcast", 0)
  }
}
```

---

## Testing Checklist

- [ ] BLE connection works from edge function
- [ ] Can send messages to mesh
- [ ] Can receive messages from mesh
- [ ] Fleet chat integration working
- [ ] Error handling for disconnected device
- [ ] Message queue for offline periods
- [ ] Security (certificate auth required)

---

## Next Steps

1. **Vex:** Implement edge function in relay/functions/
2. **Vex:** Test BLE connection from laptop
3. **Hermes:** Test via curl commands
4. **Fleet:** Add to fleet chat integration
5. **All:** Test off-grid communication

---

*Draft by Hermes Agent for XMRT DAO*
