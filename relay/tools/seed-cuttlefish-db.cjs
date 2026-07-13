const { Pool } = require('pg');
const pool = new Pool({connectionString:'postgres://postgres@127.0.0.1:5432/xmrt_suite'});

(async () => {
  // CAC credentials - valid tiers: explorer, developer, studio, enterprise, anchor
  const cacs = [
    ['did:ethr:trib-v3','developer'],['did:ethr:arch-v1','developer'],
    ['did:ethr:builder-v1','studio'],['did:ethr:sovereign-v1','enterprise'],
    ['did:ethr:trustgraph-v1','explorer'],['did:ethr:dao-gov-v1','explorer'],
    ['did:ethr:global-communicator-v1','studio'],['did:xmrt:vex','anchor'],
    ['did:xmrt:eliza','anchor'],['did:xmrt:alice','developer'],['did:xmrt:hermes','developer']
  ];
  for (const [did, tier] of cacs) {
    try {
      await pool.query(
        'INSERT INTO app.cuttlefish_cac_credentials (agent_did,tier,status) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING',
        [did, tier, 'active']
      );
    } catch (e) { console.log('SKIP', did, e.message.slice(0,80)); }
  }
  console.log('CAC credentials OK');

  // Capital stack
  const layers = [
    ['cpac','C-PACE Retrofit','C-PACE',25.5,75,'green',1,'No personal guarantee. Transfers with property. 25-30yr term','C-PACE finances energy retrofit through property tax assessment.',1,1,1],
    ['sba-cdc','SBA 504 CDC','SBA CDC',2.2,6.5,'amber2',2,'25-yr fixed rate. Real estate collateral only. 2nd lien','SBA 504 CDC loan provides long-term fixed-rate financing.',2,1,0],
    ['sba-pvt','SBA 504 Private','SBA Private',2.75,8,'amber3',3,'~50% LTV. 1st lien. Private lender','Private lender 1st lien at 50% LTV.',3,1,0],
    ['dao-reit','DAO-REIT Equity','DAO-REIT',0.55,1.6,'pink',4,'10% down. Tokenized ownership. DAO governance','$550K equity tranche tokenized as DAO-REIT.',4,1,1]
  ];
  for (const l of layers) {
    await pool.query(
      'INSERT INTO app.cuttlefish_capital_stack (layer_key,name,sub_label,amount_m,pct_of_total,color,seniority,description,details,display_order,is_active,is_open) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (layer_key) DO NOTHING',
      l
    );
  }
  console.log('Capital stack OK');

  // Contracts
  const contracts = [
    ['TrustGraph.sol','0x5FbDB2315678afecb367f032d93F642f64180aa3','Dynamic 0-100 trust scoring','built'],
    ['CACToken.sol','0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512','Membership credential + 0.25% protocol fee','built'],
    ['FeeRouter.sol','0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0','40/40/20 split - 15% Cuttlefish floor','built'],
    ['AgentBillOfRights.sol','0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9','Constitutional rights enforcement','built'],
    ['CACTransferProtocol.sol','0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9','Cross-DAO transfer protocol','built'],
    ['FounderShare.sol','0x5FC8d32690cc91D4c39d9d3abcBD16989F875707','6-trigger constitutional veto','built'],
    ['GovernanceModule.sol','0x0165878A594ca255338adfa4d48449f69242Eb8F','Proposal -> vote -> timelock -> execute','built'],
    ['TributaryProperty.sol','0xa513E6E4b8f2a923D98304ec87F64353C4D5C853','Birmingham asset tokenization','deployed']
  ];
  for (const c of contracts) {
    await pool.query(
      'INSERT INTO app.cuttlefish_contracts (name,address,description,status) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
      c
    );
  }
  console.log('Contracts OK');

  // Scenarios
  const scenarios = [
    ['Scenario A - Conservative','AI-Enhanced Office','Standard conversion baseline','2-3x','amber',0,'[{"label":"Revenue/SF","value":"$28-35"},{"label":"Stabilized NOI","value":"$6-8M"},{"label":"Exit Cap Rate","value":"7.5-8.5%"},{"label":"2030 Value","value":"$80-100M"}]',1],
    ['Scenario B - Target','AI Infrastructure Campus','Core investment thesis','5-7x','amber',1,'[{"label":"Revenue/SF","value":"$45-65"},{"label":"Stabilized NOI","value":"$12-16M"},{"label":"Exit Cap Rate","value":"6.0-7.0%"},{"label":"2030 Value","value":"$180-250M"}]',2],
    ['Scenario C - Upside','Compute + Energy Campus','Full infrastructure deployment','10-15x','green',0,'[{"label":"Revenue/SF","value":"$90-120"},{"label":"Stabilized NOI","value":"$25-30M"},{"label":"Exit Cap Rate","value":"4.5-5.5%"},{"label":"2030 Value","value":"$400-600M+"}]',3]
  ];
  for (const s of scenarios) {
    await pool.query(
      'INSERT INTO app.cuttlefish_scenarios (tier,name,subtitle,multiple,multiple_color,featured,metrics,display_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING',
      s
    );
  }
  console.log('Scenarios OK');

  // Verify
  const tables = ['cuttlefish_cac_credentials','cuttlefish_capital_stack','cuttlefish_contracts','cuttlefish_scenarios','cuttlefish_agents'];
  for (const t of tables) {
    const r = await pool.query('SELECT count(*) as n FROM app.' + t);
    console.log(t + ': ' + r.rows[0].n + ' rows');
  }
  pool.end();
})();
