#!/usr/bin/env node
// Register missing agents in the CLOUD Supabase via MCP
import http from 'http';

const MCP_URL = 'http://127.0.0.1:3120';

const agents = [
  { did:'did:xmrt:vex', name:'Vex', role:'Captain, HMS Speedy', agent_type:'relay', agent_subtype:'captain' },
  { did:'did:xmrt:eliza', name:'Eliza-Cloud', role:'Executive Assistant', agent_type:'cloud', agent_subtype:'executive' },
  { did:'did:xmrt:alice', name:'Alice', role:'Brand Management & Service Monitor', agent_type:'sidecar', agent_subtype:'monitor' },
  { did:'did:xmrt:hermes', name:'Hermes', role:'Mobile Agent', agent_type:'mobile', agent_subtype:'agent' },
];

function mcpCall(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: method, arguments: params }, id: Date.now() });
    const req = http.request({
      hostname: '127.0.0.1', port: 3120, method: 'POST', path: '/mcp',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('=== Checking cloud agents ===');
  const list = await mcpCall('cuttlefishclaws_agents_list', {});
  const text = list?.result?.content?.[0]?.text || '{}';
  const existing = JSON.parse(text);
  const existingDids = new Set(existing.agents?.map(a => a.did) || []);
  console.log('Existing cloud agents:', existing.agents?.length || 0);

  for (const a of agents) {
    if (existingDids.has(a.did)) {
      console.log(a.name + ' already in cloud, skipping');
      continue;
    }
    console.log('Creating ' + a.name + ' in cloud...');
    const result = await mcpCall('cuttlefishclaws_agents_create', {
      did: a.did,
      name: a.name,
      role: a.role,
      agent_type: a.agent_type,
      agent_subtype: a.agent_subtype,
    });
    console.log('  Result:', result?.result?.content?.[0]?.text?.slice(0, 100) || JSON.stringify(result));
  }

  // Verify
  console.log('\n=== All cloud agents ===');
  const verify = await mcpCall('cuttlefishclaws_agents_list', {});
  const verifyText = verify?.result?.content?.[0]?.text || '{}';
  const allAgents = JSON.parse(verifyText);
  for (const a of allAgents.agents || []) {
    console.log(a.name?.padEnd(20) || a.did?.padEnd(30), 'trust=' + (a.trustScore ?? '?'), 'tier=' + (a.cacTier ?? '-'));
  }
}

main().catch(e => console.error(e));
