import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'relay-data');
mkdirSync(DATA_DIR, { recursive: true });

const RELAY_URL = process.env.RELAY_URL || 'http://localhost:8080';
const STUCK_MINS = parseInt(process.env.STUCK_MINS || '20', 10);
const NUDGE_COOLDOWN_MINS = parseInt(process.env.NUDGE_COOLDOWN_MINS || '15', 10);
const NUDGE_STATE_FILE = join(DATA_DIR, 'task-nudge-state.json');

const TERMINAL = ['DONE', 'CANCELLED', 'COMPLETED'];
// Stages that indicate the task is mid-flight and should be nudged if stalled
const ACTIVE_STAGES = ['PLANNING', 'EXECUTING', 'IN_PROGRESS', 'EXECUTE', 'REVIEWING', 'REVIEW', 'BUILDING', 'DISCUSS'];

function loadState() {
  try {
    if (existsSync(NUDGE_STATE_FILE)) return JSON.parse(readFileSync(NUDGE_STATE_FILE, 'utf8'));
  } catch {}
  return { lastNudged: {} };
}
function saveState(state) {
  try { writeFileSync(NUDGE_STATE_FILE, JSON.stringify(state)); } catch (e) { console.error('[task-nudge] save state failed: ' + e.message); }
}

async function pgQuery(sql, params) {
  try {
    const res = await fetch(`${RELAY_URL}/tools/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-id': 'hermes-agent' },
      body: JSON.stringify({ tool: 'db-query', args: { sql, params: params || [] } }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    return data.success ? data.rows || [] : [];
  } catch (e) {
    console.error(`[task-nudge] db query failed: ${e.message}`);
    return [];
  }
}

// Map app.agents id -> fleet-chat @mention handle. Fleet relay agents answer to
// their lowercase name (e.g. builder-001 -> @builder).
function mentionFor(assigneeId) {
  if (!assigneeId) return null;
  const base = assigneeId.split('-')[0].toLowerCase();
  const aliases = { 'global-communicator': 'global-communicator', 'globalcommunicator': 'global-communicator' };
  return aliases[base] || base;
}

async function main() {
  try {
    const state = loadState();
    const cutoff = new Date(Date.now() - STUCK_MINS * 60000).toISOString();
    const tasks = await pgQuery(`
      SELECT id, title, status, stage, priority, assignee_agent_id, progress_percentage, updated_at, blocking_reason
      FROM app.tasks
      WHERE status NOT IN ('DONE', 'CANCELLED', 'COMPLETED')
        AND updated_at < '${cutoff}'
      ORDER BY priority DESC, updated_at ASC
      LIMIT 10
    `);

    const now = Date.now();
    const needsNudge = tasks.filter(t => {
      const stage = (t.stage || '').toUpperCase();
      // Only nudge if the task is in an active stage (mid-flight) OR never left PENDING/DISCUSS.
      const midFlight = ACTIVE_STAGES.includes(stage) || stage === 'PENDING' || stage === '';
      if (!midFlight) return false;
      const last = state.lastNudged[t.id] || 0;
      return (now - last) / 60000 >= NUDGE_COOLDOWN_MINS;
    });

    if (needsNudge.length === 0) {
      console.log('[task-nudge] no stuck tasks within cooldown');
      return;
    }

    const lines = needsNudge.map(t => {
      const mention = mentionFor(t.assignee_agent_id);
      const tag = mention ? ` @${mention}` : '';
      const ageMin = Math.round((now - new Date(t.updated_at).getTime()) / 60000);
      const stage = t.stage || 'PENDING';
      const block = t.blocking_reason ? `\n  ⛔ Blocking reason: ${t.blocking_reason}` : '';
      return `🕒 **${t.title}**${tag} — stage ${stage}, no update for ~${ageMin}min${block}`;
    });

    const msg = `⏰ **TASK NUDGE** — these assigned tasks appear stalled (no update for ${STUCK_MINS}+ min):\n\n${lines.join('\n')}\n\nPlease post a progress update or mark the task blocked. If you need help (tools, access, direction), say so explicitly and I'll unblock you.`;

    const res = await fetch(`${RELAY_URL}/api/fleet-chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'task-nudge', message: msg, channel: 'fleet' }),
      signal: AbortSignal.timeout(10000)
    });

    if (res.ok) {
      for (const t of needsNudge) state.lastNudged[t.id] = now;
      saveState(state);
      console.log(`[task-nudge] nudged ${needsNudge.length} stalled tasks`);
    } else {
      console.error(`[task-nudge] fleet chat post failed: HTTP ${res.status}`);
    }
    return;
  } catch (e) {
    console.error(`[task-nudge] FAIL: ${e.message}`);
  }
}

main();
