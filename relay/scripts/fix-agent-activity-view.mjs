import pg from 'pg';
const { Client } = pg;
const c = new Client({ host: '127.0.0.1', port: 5432, database: 'xmrt_suite', user: 'postgres' });
await c.connect();

// Create the missing view that's spamming the log every 30s
await c.query(`CREATE OR REPLACE VIEW app.agent_activity_summary AS
  SELECT
    agent_id,
    COUNT(*) FILTER (WHERE activity_type LIKE 'trust_%') AS trust_events,
    COUNT(*) FILTER (WHERE activity_type LIKE 'token_%') AS token_calls,
    COUNT(*) FILTER (WHERE activity_type LIKE 'artifact_%') AS artifacts,
    COALESCE(SUM((metadata->>'token_cost')::numeric), 0) AS total_token_cost,
    MAX(created_at) AS last_activity
  FROM public.eliza_activity_log
  GROUP BY agent_id`);
console.log('Created app.agent_activity_summary view');

const r = await c.query('SELECT count(*) as cnt FROM app.agent_activity_summary');
console.log('View has ' + r.rows[0].cnt + ' rows');

await c.end();
