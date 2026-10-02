const RELAY_URL = process.env.RELAY_URL || 'http://127.0.0.1:8080';
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function postFleetChat(agent, message) {
  const res = await fetch(`${RELAY_URL}/api/fleet-chat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, message, channel: 'fleet' }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for fleet-chat/send`);
  return res.json();
}

function formatAgentMention(assignee) {
  if (!assignee) return '';
  const base = assignee.replace(/-001$/, '').toLowerCase();
  const known = ['hermes','eliza','alice','vex'];
  if (known.includes(base)) return `@${base}`;
  return `@${base}`;
}

async function main() {
  // 1. Fetch ALL tasks and filter client-side (API endpoint lacks stage param support)
  const tasks = await fetchJson(`${RELAY_URL}/api/suite/tasks?limit=200`);
  const taskList = Array.isArray(tasks) ? tasks : (tasks.tasks || []);
  const discussTasks = taskList.filter(t => t.stage === 'DISCUSS' || t.status === 'DISCUSS');
  console.log(`[announcer] Found ${discussTasks.length} tasks in DISCUSS stage (of ${taskList.length} total)`);

  if (discussTasks.length === 0) {
    console.log('[announcer] No DISCUSS tasks to announce.');
    return;
  }

  // 2. Fetch recent fleet chat messages
  const chat = await fetchJson(`${RELAY_URL}/api/fleet-chat/messages?limit=300`);
  const messages = chat.messages || [];
  const cutoff = Date.now() - TWENTY_FOUR_HOURS;
  const recentMessages = messages.filter(m => {
    const ts = new Date(m.ts).getTime();
    return ts >= cutoff;
  });
  console.log(`[announcer] Found ${recentMessages.length} fleet messages in last 24h (of ${messages.length} total)`);

  // 3. Build set of task IDs mentioned recently
  const mentionedIds = new Set();
  for (const m of recentMessages) {
    const body = m.message || '';
    const uuids = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
    const tids = body.match(/t-[a-z0-9]+-[a-z0-9]+/gi) || [];
    for (const id of [...uuids, ...tids]) mentionedIds.add(id);
  }
  console.log(`[announcer] ${mentionedIds.size} unique task IDs mentioned in last 24h`);

  // 4. Find tasks not yet announced
  const unannounced = discussTasks.filter(t => !mentionedIds.has(t.id));
  console.log(`[announcer] ${unannounced.length} DISCUSS tasks NOT yet announced`);

  // 5. Post announcements
  for (const t of unannounced) {
    const mention = formatAgentMention(t.assignee_agent_id);
    const desc = (t.description || '').slice(0, 200);
    const msg = `📋 DISCUSS stage task **${t.id}**: ${t.title}
${mention} — this task is waiting for fleet discussion.
${desc ? '> ' + desc + (t.description.length > 200 ? '...' : '') : ''}

Please review and share your approach. Once consensus is reached, use advance_task with task_id=\${t.id}\ to move to PLANNING.`;
    try {
      await postFleetChat('hermes-agent', msg);
      console.log(`[announcer] ✅ Posted for task ${t.id} (${t.title.slice(0,50)})`);
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`[announcer] ❌ Failed to post for ${t.id}: ${e.message}`);
    }
  }

  console.log('[announcer] Done.');
}

main().catch(e => {
  console.error('[announcer] Fatal:', e.message);
  process.exit(1);
});
