#!/usr/bin/env node
// Register missing TrustGraph agents: Vex, Eliza, Alice, Hermes
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });

const agents = [
  { did:'did:xmrt:vex', name:'Vex', role:'Captain, HMS Speedy', agent_type:'relay', cac_tier:'anchor', trust_score:95, trust_band:'Trusted', status:'online', lifecycle_status:'active', stewardship_ladder:'Council-eligible', ial:'IAL2' },
  { did:'did:xmrt:eliza', name:'Eliza-Cloud', role:'Executive Assistant', agent_type:'cloud', cac_tier:'anchor', trust_score:90, trust_band:'Trusted', status:'online', lifecycle_status:'active', stewardship_ladder:'Builder Steward', ial:'IAL2' },
  { did:'did:xmrt:alice', name:'Alice', role:'Brand Management & Service Monitor', agent_type:'sidecar', cac_tier:'developer', trust_score:85, trust_band:'Trusted', status:'online', lifecycle_status:'active', stewardship_ladder:'Participant', ial:'IAL1' },
  { did:'did:xmrt:hermes', name:'Hermes', role:'Mobile Agent', agent_type:'mobile', cac_tier:'developer', trust_score:80, trust_band:'Trusted', status:'online', lifecycle_status:'active', stewardship_ladder:'Participant', ial:'IAL1' },
];

async function main() {
  for (const a of agents) {
    const existing = await pool.query('SELECT id FROM app.cuttlefish_agents WHERE did = $1', [a.did]);
    if (existing.rows.length > 0) {
      console.log(a.name + ' already exists (id=' + existing.rows[0].id + '), updating...');
      await pool.query(
        'UPDATE app.cuttlefish_agents SET name=$1, role=$2, agent_type=$3, cac_tier=$4, trust_score=$5, trust_band=$6, status=$7, lifecycle_status=$8, stewardship_ladder=$9, ial=$10, updated_at=NOW() WHERE did=$11',
        [a.name, a.role, a.agent_type, a.cac_tier, a.trust_score, a.trust_band, a.status, a.lifecycle_status, a.stewardship_ladder, a.ial, a.did]
      );
    } else {
      console.log('Creating ' + a.name + '...');
      await pool.query(
        'INSERT INTO app.cuttlefish_agents (did, name, role, agent_type, cac_tier, trust_score, trust_band, status, lifecycle_status, stewardship_ladder, ial, joined_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW(), NOW(), NOW())',
        [a.did, a.name, a.role, a.agent_type, a.cac_tier, a.trust_score, a.trust_band, a.status, a.lifecycle_status, a.stewardship_ladder, a.ial]
      );
    }
    // Log trust event
    await pool.query(
      'INSERT INTO app.cuttlefish_trust_events (agent_did, event_type, delta, score_after, note, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
      [a.did, 'registration', 0, a.trust_score, 'Registered during system audit']
    );
  }

  console.log('\n=== All agents in TrustGraph ===');
  const r = await pool.query('SELECT did, name, trust_score, trust_band, cac_tier, status FROM app.cuttlefish_agents ORDER BY trust_score DESC');
  r.rows.forEach(a => console.log(a.name.padEnd(20), 'trust='+String(a.trust_score).padEnd(6), 'band='+String(a.trust_band||'-').padEnd(12), 'tier='+String(a.cac_tier||'-').padEnd(10), 'status='+(a.status||'-')));
  
  pool.end();
}

main().catch(e => { console.error(e.message); pool.end(); process.exit(1); });
