import pg from 'pg';
import crypto from 'node:crypto';
const { Client } = pg;
const c = new Client({ host: '127.0.0.1', port: 5432, database: 'xmrt_suite', user: 'postgres' });
await c.connect();

function uuid() {
  return crypto.randomUUID();
}

// 1. Populate cron.job
await c.query('DELETE FROM cron.job');
const jobs = [
  [1, 'sync-hermes-memory', '*/5 * * * *', 'python3 relay/cron-python/sync-hermes-memory.py', true],
  [2, 'pipeline-orchestrator', '*/5 * * * *', 'node relay/pipeline-orchestrator.mjs', true],
  [3, 'agent-workflow-engine', '*/15 * * * *', 'node relay/agent_workflow_engine_cron.mjs', true],
  [4, 'trustgraph-violation-scanner', '*/15 * * * *', 'node relay/trustgraph-scanner.mjs', true],
  [5, 'task-discussion-announcer', '*/15 * * * *', 'node relay/task-announcer.mjs', true],
  [6, 'fleet-chat-productivity-agent', '0 * * * *', 'node relay/fleet-productivity.mjs', true],
  [7, 'arch-ecosystem-scanner', '0 */6 * * *', 'python3 relay/cron-python/arch-ecosystem-scanner.py', true],
  [8, '31harbor-nightly-scraper', '0 20 * * *', 'cd ~/Desktop/xmrtdao/relay && node scripts/nightly-scraper.mjs', true],
  [9, '31harbor-morning-send', '0 11 * * *', 'cd ~/Desktop/xmrtdao/relay && node scripts/daily-sender.mjs', true],
  [10, '31harbor-midday-send', '0 13 * * *', 'cd ~/Desktop/xmrtdao/relay && node scripts/daily-sender.mjs', true],
  [11, '31harbor-afternoon-send', '0 15 * * *', 'cd ~/Desktop/xmrtdao/relay && node scripts/daily-sender.mjs', true],
  [12, 'hermes-comms', '* * * * *', 'node relay/hermes-comms.mjs', true],
];
for (const [id, name, schedule, command, enabled] of jobs) {
  await c.query('INSERT INTO cron.job (id, name, schedule, command, enabled, created_at) VALUES ($1, $2, $3, $4, $5, NOW())', [id, name, schedule, command, enabled]);
}
console.log('1. cron.job: ' + jobs.length + ' rows inserted');

// 2. Populate public.cron_registry
await c.query('DELETE FROM public.cron_registry');
for (const [id, name, schedule, command, enabled] of jobs) {
  await c.query('INSERT INTO public.cron_registry (id, job_name, function_name, platform, schedule, is_active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())', [uuid(), name, command, 'local', schedule, enabled]);
}
console.log('2. public.cron_registry: ' + jobs.length + ' rows inserted');

// 3. Populate public.scheduled_actions
await c.query('DELETE FROM public.scheduled_actions');
for (const [id, name, schedule, command, enabled] of jobs) {
  await c.query('INSERT INTO public.scheduled_actions (id, session_key, action_name, action_type, schedule_expression, action_data, is_active, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())', [uuid(), 'cron-engine', name, 'cron_job', schedule, JSON.stringify({ command: command }), enabled]);
}
console.log('3. public.scheduled_actions: ' + jobs.length + ' rows inserted');

// 4. Populate util.util_scheduled_tasks
await c.query('DELETE FROM util.util_scheduled_tasks');
const intervals = { '*/5 * * * *': 300000, '*/15 * * * *': 900000, '0 * * * *': 3600000, '0 */6 * * *': 21600000, '0 20 * * *': 86400000, '0 11 * * *': 86400000, '0 13 * * *': 86400000, '0 15 * * *': 86400000, '* * * * *': 60000 };
for (const [id, name, schedule, command, enabled] of jobs) {
  const ms = intervals[schedule] || 300000;
  await c.query('INSERT INTO util.util_scheduled_tasks (key, interval_ms, enabled, next_run_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())', [name, ms, enabled]);
}
console.log('4. util.util_scheduled_tasks: ' + jobs.length + ' rows inserted');

// Verify
const r1 = await c.query('SELECT count(*) as cnt FROM cron.job');
const r2 = await c.query('SELECT count(*) as cnt FROM public.cron_registry');
const r3 = await c.query('SELECT count(*) as cnt FROM public.scheduled_actions');
const r4 = await c.query('SELECT count(*) as cnt FROM util.util_scheduled_tasks');
console.log('\nVerification:');
console.log('  cron.job: ' + r1.rows[0].cnt + ' rows');
console.log('  public.cron_registry: ' + r2.rows[0].cnt + ' rows');
console.log('  public.scheduled_actions: ' + r3.rows[0].cnt + ' rows');
console.log('  util.util_scheduled_tasks: ' + r4.rows[0].cnt + ' rows');

const j = await c.query('SELECT id, name, schedule, enabled FROM cron.job ORDER BY id');
console.log('\ncron.job contents:');
j.rows.forEach(r => console.log('  ' + r.id + ': ' + r.name + ' [' + r.schedule + '] enabled=' + r.enabled));

await c.end();
