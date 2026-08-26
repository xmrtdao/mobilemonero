import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'relay-data');
mkdirSync(DATA_DIR, { recursive: true });

const RELAY_URL = 'http://localhost:8080';
const PG_URL = process.env.PG_URL || 'postgresql://postgres@127.0.0.1:5432/xmrt_suite';

async function pgQuery(sql) {
  try {
    const res = await fetch(`${RELAY_URL}/tools/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-id': 'hermes-agent'
      },
      body: JSON.stringify({ tool: 'db-query', args: { sql } }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    return data.success ? data.rows || [] : [];
  } catch (e) {
    console.error(`[task-announcer] db query failed: ${e.message}`);
    return [];
  }
}

async function main() {
  try {
    // Get tasks updated in the last 30 minutes that are not terminal
    const tasks = await pgQuery(`
      SELECT id, title, status, stage, priority, assignee_agent_id, progress_percentage, updated_at
      FROM app.tasks
      WHERE status NOT IN ('DONE', 'CANCELLED', 'COMPLETED')
        AND updated_at > NOW() - INTERVAL '30 minutes'
      ORDER BY priority DESC, updated_at DESC
      LIMIT 5
    `);

    if (tasks.length === 0) {
      console.log('[task-announcer] no new or updated tasks to announce');
      return; // let the event loop drain naturally — no process.exit()
    }

    // Format announcement
    const lines = tasks.map(t => {
      const emoji = t.status === 'IN_PROGRESS' ? '🔄' : t.status === 'PENDING' ? '⏳' : '📋';
      const assignee = t.assignee_agent_id ? ` @${t.assignee_agent_id}` : '';
      const progress = t.progress_percentage ? ` (${t.progress_percentage}%)` : '';
      return `${emoji} **${t.title}**${assignee} — ${t.status}${progress}`;
    });

    const msg = `📢 **Fleet Task Update**\n\n${lines.join('\n')}\n\nReply to claim or discuss any task.`;

    // Post to fleet chat
    const res = await fetch(`${RELAY_URL}/api/fleet-chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'task-announcer',
        message: msg,
        channel: 'fleet'
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (res.ok) {
      console.log(`[task-announcer] announced ${tasks.length} tasks to fleet chat`);
    } else {
      console.error(`[task-announcer] fleet chat post failed: HTTP ${res.status}`);
    }

    return; // let the event loop drain naturally
  } catch (e) {
    console.error(`[task-announcer] FAIL: ${e.message}`);
    // no process.exit() — a bare exception on the top-level await already exits
  }
}

main();
