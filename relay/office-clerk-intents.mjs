/**
 * Office Clerk — deterministic intent table.
 *
 * Pure data + formatters. No logic, no imports from the relay. Each intent:
 *   id       — stable name (logged with every match)
 *   patterns — ordered regexes; first match across all intents wins
 *   tool     — relay toolHandlers key, or null for a purely static reply
 *   args(m)  — build tool args from the regex match (default: {})
 *   format(r)— render the tool result as markdown for the operator
 *   confirm  — if true, the clerk requires the message to start with
 *              "confirm" before executing (for mutating actions)
 *
 * Add intents by appending here — order matters, most specific first.
 */

const fmtServices = (r) => {
  const svc = r?.supervisor?.services || r?.services || [];
  // Shape A: dict of name → {status, latency, ...} (connectivity checks)
  if (svc && !Array.isArray(svc) && typeof svc === 'object') {
    const entries = Object.entries(svc);
    if (!entries.length) return null;
    const lines = entries.map(([name, v]) => {
      const ok = v && typeof v === 'object' && /^(ok|up|running)/i.test(String(v.status || ''));
      const lat = v?.latency ? ` (${v.latency}${typeof v.latency === 'number' ? 'ms' : ''})` : '';
      return `- ${ok ? '🟢' : '🔴'} ${name} — ${v?.status || 'unknown'}${lat}`;
    });
    const up = entries.filter(([, v]) => /^(ok|up|running)/i.test(String(v?.status || ''))).length;
    return { up, total: entries.length, lines };
  }
  // Shape B: array of supervised services
  if (!Array.isArray(svc) || !svc.length) return null;
  const up = svc.filter(s => s.status === 'running' || s.alive).length;
  const lines = svc.map(s => {
    const name = s.name || s.id || '?';
    const ok = s.status === 'running' || s.alive;
    return `- ${ok ? '🟢' : '🔴'} ${name}${s.status ? ` — ${s.status}` : ''}`;
  });
  return { up, total: svc.length, lines };
};

export const CLERK_INTENTS = [
  {
    id: 'help',
    patterns: [/^(help|what can you do|capabilities|menu)\??$/i],
    tool: null,
    format: () => [
      '**Office Clerk — deterministic commands** (work fully offline):',
      '- `status` / `health` — supervised services up/down',
      '- `resources` — CPU, memory, disk',
      '- `tasks` — task runner pipeline stats',
      '- `external` — Supabase/Ollama/GitHub reachability',
      '- `mining` — cloud mining stats',
      '- `ollama` — local model runtime status',
      '- `remember <key> = <value>` / `recall <key>` — persistent state',
      '- `open <url>` / `show <url>` — push a page to the aside pane',
      '- `close aside` — clear the aside pane',
      '- `restart <service>` — restart a supervised service (asks to confirm)',
      '',
      'Anything else gets handed to the local model or the cloud cascade when online.',
    ].join('\n'),
  },
  {
    id: 'system-status',
    patterns: [
      /\b(status|health)\b.*\b(system|services?|stack|fleet|relay)\b/i,
      /\b(system|services?|stack|fleet|relay)\b.*\b(status|health|up|down)\b/i,
      /^(status|health)\??$/i,
      /\bwhat('s| is) (running|up|down)\b/i,
    ],
    tool: 'system-monitor',
    format: (r) => {
      const s = fmtServices(r);
      if (!s) return '**System status:** snapshot unavailable.\n\n```json\n' + JSON.stringify(r).slice(0, 400) + '\n```';
      return `**System status:** ${s.up}/${s.total} services up\n\n${s.lines.join('\n')}`;
    },
  },
  {
    id: 'resources',
    patterns: [/\b(cpu|memory|ram|disk|resources?|load)\b/i],
    tool: 'system-resources',
    format: (r) => {
      if (!r || r.error) return `**Resources:** unavailable (${r?.error || 'no data'})`;
      const parts = [];
      if (r.cpu != null) parts.push(`- CPU: ${typeof r.cpu === 'object' ? JSON.stringify(r.cpu) : r.cpu}`);
      if (r.memory) parts.push(`- Memory: ${typeof r.memory === 'object' ? JSON.stringify(r.memory) : r.memory}`);
      if (r.disk) parts.push(`- Disk: ${typeof r.disk === 'object' ? JSON.stringify(r.disk) : r.disk}`);
      if (!parts.length) return '```json\n' + JSON.stringify(r, null, 1).slice(0, 600) + '\n```';
      return `**System resources:**\n${parts.join('\n')}`;
    },
  },
  {
    id: 'tasks',
    patterns: [/\b(tasks?|pipeline|queue|jobs?)\b.*\b(status|stats|running|pending|list|show)?\b/i, /^(tasks|pipeline)\??$/i],
    tool: 'task-stats',
    format: (r) => {
      if (!r || r.error) return `**Task pipeline:** unavailable (${r?.error || 'no data'})`;
      const lines = Object.entries(r)
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => `- ${k}: ${v}`);
      return lines.length
        ? `**Task runner stats:**\n${lines.join('\n')}`
        : '```json\n' + JSON.stringify(r, null, 1).slice(0, 600) + '\n```';
    },
  },
  {
    id: 'external-services',
    patterns: [/\b(external|supabase|github|internet|online|connectivity|network)\b.*\b(status|check|up|reach|health)?\b/i, /^(external|connectivity)\??$/i],
    tool: 'external-services',
    format: (r) => {
      if (!r || r.error) return `**External services:** check failed (${r?.error || 'no data'})`;
      const entries = Object.entries(r).filter(([, v]) => v && typeof v === 'object');
      if (!entries.length) return '```json\n' + JSON.stringify(r, null, 1).slice(0, 600) + '\n```';
      const lines = entries.map(([k, v]) => `- ${v.ok || v.status === 'ok' || v.healthy ? '🟢' : '🔴'} ${k}${v.latency_ms != null ? ` (${v.latency_ms}ms)` : ''}`);
      return `**External services:**\n${lines.join('\n')}`;
    },
  },
  {
    id: 'mining',
    patterns: [/\b(mining|hashrate|hash rate|workers?|shares?)\b/i],
    tool: 'mining-dashboard',
    format: (r) => {
      const stats = r?.stats || r;
      if (!stats || stats.error) return `**Mining:** unavailable (${stats?.error || 'no data'})`;
      const hr = stats.hashRate ?? stats.hashrate ?? stats.hash_rate ?? 'N/A';
      const shares = stats.validShares ?? stats.valid_shares ?? 'N/A';
      const workers = stats.workerCount ?? stats.workers?.length ?? 'N/A';
      return `**Mining stats:**\n- Hash rate: ${hr}\n- Valid shares: ${shares}\n- Workers: ${workers}`;
    },
  },
  {
    id: 'ollama',
    patterns: [/\b(ollama|local model|local llm|models? installed)\b/i],
    tool: 'ollama-health',
    format: (r) => {
      if (!r) return '**Ollama:** no response';
      const ok = r.ok || r.status === 'ok' || r.running;
      const models = r.models ? `\n- Models: ${(Array.isArray(r.models) ? r.models.join(', ') : r.models)}` : '';
      return `**Ollama (local model runtime):** ${ok ? '🟢 running' : '🔴 not responding'}${models}`;
    },
  },
  {
    id: 'remember',
    patterns: [/^remember\s+([\w.-]+)\s*=\s*(.+)$/i, /^remember\s+that\s+([\w.-]+)\s+is\s+(.+)$/i],
    tool: 'state-set',
    args: (m) => ({ key: m[1], value: m[2].trim() }),
    format: (r) => r?.success ? `✅ Remembered **${r.key}** = ${JSON.stringify(r.value)}` : `⚠️ Could not store: ${r?.error || 'unknown'}`,
  },
  {
    id: 'recall',
    patterns: [/^recall\s+([\w.-]+)\??$/i, /^what did (?:i|we) (?:say about|store as)\s+([\w.-]+)\??$/i],
    tool: 'state-get',
    args: (m) => ({ key: m[1] }),
    format: (r) => r && r.value != null ? `**${r.key}** = ${JSON.stringify(r.value)}` : `Nothing stored under **${r?.key || 'that key'}**.`,
  },
  {
    id: 'aside-open',
    patterns: [/^(?:open|show|browse|display)\s+(https?:\/\/\S+)$/i],
    tool: 'aside-push',
    args: (m) => ({ kind: 'url', url: m[1], title: m[1], by: 'office-clerk' }),
    format: (r) => r?.success ? `📑 Opened in the aside pane: ${r.title}` : `⚠️ ${r?.error || 'aside push failed'}`,
  },
  {
    id: 'aside-close',
    patterns: [/^(close|hide|clear)\s+(the\s+)?(aside|panel|pane)$/i],
    tool: 'aside-close',
    format: (r) => r?.success ? '📑 Aside pane closed.' : `⚠️ ${r?.error || 'close failed'}`,
  },
  {
    id: 'restart-service',
    confirm: true,
    patterns: [/^(?:confirm\s+)?(?:restart|reboot|bounce)\s+([\w-]+)$/i],
    tool: 'service_control',
    args: (m) => ({ action: 'restart', service: m[1] }),
    format: (r) => r?.success !== false && !r?.error
      ? `🔄 Restart issued for **${r?.service || 'service'}**. Give it ~30–60s, then ask \`status\`.`
      : `⚠️ Restart failed: ${r?.error || 'unknown'}`,
  },
];

export const CLERK_MISS_RESPONSE = [
  '⚡ **Office Clerk (deterministic mode)** — I don\'t have a wired workflow for that.',
  '',
  'I can handle these offline: `status`, `resources`, `tasks`, `external`, `mining`, `ollama`, `remember k = v`, `recall k`, `open <url>`, `close aside`, `restart <service>`. Type `help` for details.',
  '',
  '_Anything more complex gets handed to the local model or the cloud cascade when online._',
].join('\n');
