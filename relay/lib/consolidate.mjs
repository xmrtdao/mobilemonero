/**
 * consolidate.mjs — In-process consolidation of MCP servers and Alice daemon
 * 
 * Registers MCP tool handlers by fetching them from the already-running MCP
 * HTTP servers (managed by supervisor), then wrapping them as relay tool handlers.
 * Does NOT import the MCP modules directly — that would trigger their side-effect
 * HTTP server startup and cause EADDRINUSE conflicts.
 */

const MCP_SERVERS = [
  { name: 'cuttlefishclaws-mcp', url: 'http://127.0.0.1:3120', rpc: true },
  { name: 'xmrtdao-suite-mcp', url: 'http://127.0.0.1:3121', rpc: true },
];

/**
 * Register all MCP tool handlers into the relay's toolHandlers object.
 * Uses JSON-RPC to list tools from each MCP server, then wraps them
 * as relay tool handlers that proxy to the MCP's tools/call endpoint.
 */
export async function registerMcpTools(toolHandlers) {
  let count = 0;

  for (const mcp of MCP_SERVERS) {
    try {
      // List tools via JSON-RPC
      const listRes = await fetch(mcp.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        signal: AbortSignal.timeout(5000),
      });
      if (!listRes.ok) {
        console.log(`[consolidate] ${mcp.name} returned HTTP ${listRes.status} — skipping`);
        continue;
      }
      const listData = await listRes.json();
      const tools = listData.result?.tools || [];
      
      for (const tool of tools) {
        const name = tool.name;
        if (!name) continue;
        
        // Wrap as a relay tool handler that proxies via JSON-RPC
        toolHandlers[name] = async (args) => {
          try {
            const callRes = await fetch(mcp.url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
              signal: AbortSignal.timeout(30000),
            });
            if (!callRes.ok) return { error: `MCP HTTP ${callRes.status}` };
            const callData = await callRes.json();
            if (callData.error) return { error: callData.error.message || JSON.stringify(callData.error) };
            // Extract text content from MCP result
            const content = callData.result?.content;
            if (Array.isArray(content)) {
              const textParts = content.filter(c => c.type === 'text').map(c => c.text);
              if (textParts.length > 0) return { success: true, result: textParts.join('\n') };
            }
            return { success: true, result: callData.result };
          } catch (e) {
            return { error: e.message };
          }
        };
        count++;
      }
      console.log(`[consolidate] ${mcp.name}: ${tools.length} tools registered via JSON-RPC proxy`);
    } catch (e) {
      console.log(`[consolidate] ${mcp.name} unavailable: ${e.message}`);
    }
  }

  console.log(`[consolidate] Registered ${count} MCP tools via HTTP proxy`);
  return count;
}

/**
 * Start Alice's daemon loop as a setInterval in the relay process.
 * Calls Alice's /api/alice/tick endpoint instead of importing alice.mjs directly.
 */
export function startAliceDaemon() {
  const ALICE_CYCLE_MS = 60 * 60 * 1000; // 60 min default

  async function aliceTick() {
    try {
      const res = await fetch('http://127.0.0.1:8080/api/alice/tick', {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        console.log(`[consolidate] Alice tick returned HTTP ${res.status}`);
      }
    } catch (e) {
      console.log('[consolidate] Alice tick error:', e.message);
    }
  }

  const interval = setInterval(aliceTick, ALICE_CYCLE_MS);
  setTimeout(aliceTick, 10000);
  console.log(`[consolidate] Alice daemon started (cycle: ${ALICE_CYCLE_MS/60000}min)`);
  return interval;
}
