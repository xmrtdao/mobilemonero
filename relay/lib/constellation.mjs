/**
 * relay/lib/constellation.mjs — one picture of the fleet.
 *
 * FOUR SIGNALS, FOUR PLACES, ONE PICTURE.
 *
 *   trust    — public.trust_events, scored by the TrustGraph engine
 *   burn     — app.token_usage: calls, tokens, cost
 *   activity — public.eliza_activity_log: events, errors
 *   graph    — the XMRT Galaxy: how connected an agent is
 *
 * The dashboard showed the first of these as a number on the Training &
 * Security tile and the other three on other tiles, which meant the reader
 * had to hold four tiles in their head to answer the only question that
 * matters: is this agent in trouble? An agent that burns a lot, trusts a
 * lot and errors a lot is a different animal from one that does the same
 * quietly, and the relationships between the signals are the data.
 *
 * So the constellation draws them together:
 *
 *   x  trust score          (0-100, left is bad)
 *   y  token burn           (log scale, up is expensive)
 *   r  activity volume      (how much it does)
 *   colour                  trust band, the same vocabulary as everywhere else
 *   links                   who talks to whom, and who breaks together
 *
 * The links are the part that cannot be read off a table of numbers: two
 * agents that keep failing on the same route are a shared problem, and two
 * agents that keep @-mentioning each other are a working relationship. Both
 * are measured here, not guessed.
 */

import { query } from './db.mjs';
import { computeScore, getBand } from './trustgraph-engine.mjs';

// The canonical agent names, and the DIDs that mean them. This mirrors the
// mapping the trust trajectory uses, because two charts that disagree about
// who "eliza" is are worse than one chart.
const SIMPLE_NAMES = [
  'vex', 'eliza', 'alice', 'hermes', 'arch', 'trib', 'builder', 'sovereign',
  'trustgraph', 'dao', 'global-communicator', 'hermes-agent', 'alice-sidecar',
  'fleet-cq', 'test-agent', 'jobby', 'pfp', 'announcer', 'alice-daemon',
];

const DID_OVERRIDES = {
  'did:key:eliza-cloud-001': 'eliza',
  'did:key:vex-relay-001': 'vex',
  'did:key:alice-memory-001': 'alice',
  'did:key:hermes-comms-001': 'hermes',
  'Eliza (Quartermaster)': 'eliza',
  'Vex (Captain, HMS Speedy)': 'vex',
  'alice-sidecar': 'alice',
  'did:xmrt:eliza': 'eliza',
  'did:xmrt:vex': 'vex',
  'did:xmrt:alice': 'alice',
  'did:xmrt:hermes': 'hermes',
  'did:xmrt:kimi-ai-agent': 'kimi',
  'did:xmrt:xmrt-aidy': 'xmrt-aidy',
  'did:xmrt:hermes-agent': 'hermes-agent',
  'did:ethr:arch-v1': 'arch',
  'did:ethr:trib-v3': 'trib',
  'did:ethr:global-communicator-v1': 'global-communicator',
  'did:ethr:builder-v1': 'builder',
  'did:ethr:sovereign-v1': 'sovereign',
  'did:ethr:dao-gov-v1': 'dao',
  'did:ethr:trustgraph-v1': 'trustgraph',
  'did:ethr:test-agent-v1': 'test-agent',
  'did:university:test-agent-hermes': 'test agent hermes',
  'did:university:test-grad-flow': 'test graduate flow',
  'did:test:fix-verification-agent': 'fix-verification-agent',
};

function canonicalName(raw) {
  if (!raw) return null;
  const key = String(raw).trim();
  if (DID_OVERRIDES[key]) return DID_OVERRIDES[key];
  if (SIMPLE_NAMES.includes(key.toLowerCase())) return key.toLowerCase();
  // A DID that is not in the override table: strip the method prefix so
  // 'did:xmrt:some-agent' reads as 'some-agent'.
  const stripped = key.replace(/^did:[^:]+:/, '').toLowerCase();
  return stripped;
}

// The same agent under a different name. The token logger writes "eliza-dev"
// where the registry says "eliza", and a picture that shows the same agent
// twice because two loggers spell it differently is a picture of the
// loggers, not of the fleet.
const ALIASES = {
  'eliza-dev': 'eliza',
  'eliza-cloud': 'eliza',
  'vex-001': 'vex',
  'builder-001': 'builder',
  'trustgraph-001': 'trustgraph',
  'trib-001': 'trib',
  'arch-001': 'arch',
  'sovereign-001': 'sovereign',
  'jobby-001': 'jobby',
};

/**
 * Fold a name onto the agent it belongs to, when we know it.
 *
 * The "-001" suffix is a deployment instance, not a different agent: an
 * agent with a "-001" instance and a bare name is one agent. But only when
 * the bare name is a name we already know — otherwise "job-001" would be
 * folded into a "job" that does not exist.
 */
function foldName(name, known) {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  const inst = lower.match(/^(.+)-001$/);
  if (inst && known.has(inst[1])) return inst[1];
  return lower;
}

async function safe(label, fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[constellation] ${label} failed: ${e.message}`);
    return fallback;
  }
}

/**
 * Build the constellation.
 *
 * Every part degrades on its own. A missing token table costs the burn
 * axis; a missing galaxy costs the connections. The picture is still worth
 * drawing with what is there.
 *
 * `queryFn` defaults to the shared pool, and exists so a caller can point
 * the picture at a specific database. The fleet picture is about LIVE data —
 * the throwaway database the test suite uses is schema-only and holds no
 * fleet at all, so a test that reads it sees an empty picture and learns
 * nothing.
 */
export async function buildConstellation({
  queryFn = query,
  burnDays = 30,
  activityHours = 24,
  trustWindowDays = 90,
  includeGraph = true,
  maxNodes = 30,
} = {}) {
  const now = new Date();

  const [registry, trustEvents, burn, activity, mentions, sharedFaults, galaxy] = await Promise.all([
    safe('registry', async () => {
      const r = await queryFn(
        `SELECT did, name, trust_score, cac_tier, status FROM public.registry_agents
         WHERE name IS NOT NULL AND name != ''`
      );
      return r.rows || [];
    }, []),
    safe('trust-events', async () => {
      const r = await queryFn(
        `SELECT agent_did, event_type, delta, score_after, created_at
         FROM public.trust_events WHERE created_at > NOW() - make_interval(days => $1::int)
         ORDER BY created_at ASC`,
        [trustWindowDays]
      );
      return r.rows || [];
    }, []),
    safe('burn', async () => {
      const r = await queryFn(
        `SELECT COALESCE(agent,'unknown') AS agent, COUNT(*)::int AS calls,
           COALESCE(SUM(total_tokens),0)::bigint AS tokens,
           COALESCE(SUM(estimated_cost_usd),0)::numeric AS cost,
           MAX(logged_at)::text AS last_at
         FROM app.token_usage WHERE logged_at > NOW() - make_interval(days => $1::int)
         GROUP BY 1`, [burnDays]
      );
      return r.rows || [];
    }, []),
    safe('activity', async () => {
      const r = await queryFn(
        `SELECT COALESCE(NULLIF(agent_id,''),'unknown') AS agent, COUNT(*)::int AS events,
           COUNT(*) FILTER (WHERE status IN ('error','failed'))::int AS errors,
           MAX(created_at)::text AS last_at
         FROM public.eliza_activity_log
         WHERE created_at > NOW() - make_interval(hours => $1::int)
         GROUP BY 1`, [activityHours]
      );
      return r.rows || [];
    }, []),
    safe('mentions', async () => {
      const r = await queryFn(
        `SELECT agent_id, message FROM public.fleet_messages
         WHERE created_at > NOW() - INTERVAL '24 hours' AND message LIKE '%@%'`
      );
      return r.rows || [];
    }, []),
    safe('shared-faults', async () => {
      const r = await queryFn(
        `SELECT metadata->>'path' AS path, COALESCE(NULLIF(agent_id,''),'unknown') AS agent, COUNT(*)::int AS hits
         FROM public.eliza_activity_log
         WHERE created_at > NOW() - INTERVAL '24 hours'
           AND status IN ('error','failed') AND metadata->>'path' IS NOT NULL
         GROUP BY 1,2 HAVING COUNT(*) >= 2`
      );
      return r.rows || [];
    }, []),
    includeGraph ? safe('galaxy', async () => {
      // The Galaxy is built by a big handler in server.js. Asking it over
      // loopback is cheaper and safer than duplicating its logic here.
      const res = await fetch('http://127.0.0.1:8080/api/obsidian-graph', {
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return { nodes: data.nodes || [], edges: data.edges || [] };
    }, null) : null,
  ]);

  // ── Trust ────────────────────────────────────────────────────────────────
  const didToAgent = {};
  const agentTiers = {};
  for (const row of registry) {
    const canon = canonicalName(row.name) || canonicalName(row.did);
    if (!canon) continue;
    didToAgent[row.did] = canon;
    agentTiers[canon] = row.trust_score || row.cac_tier || 'explorer';
  }
  for (const name of SIMPLE_NAMES) didToAgent[name] = name;

  const eventsByAgent = new Map();
  for (const row of trustEvents) {
    const canon = canonicalName(didToAgent[row.agent_did] || row.agent_did);
    if (!canon) continue;
    if (!eventsByAgent.has(canon)) eventsByAgent.set(canon, []);
    eventsByAgent.get(canon).push({
      event_type: row.event_type,
      delta: row.delta != null ? parseFloat(row.delta) : null,
      score_after: row.score_after != null ? parseFloat(row.score_after) : null,
      created_at: row.created_at,
    });
  }

  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const trust = new Map();
  for (const [canon, events] of eventsByAgent.entries()) {
    const tier = agentTiers[canon] || 'explorer';
    const current = computeScore(events, tier, now);
    const prior = computeScore(events, tier, weekAgo);
    trust.set(canon, {
      score: current.score,
      band: current.band || getBand(current.score),
      tier,
      events: events.length,
      // The slope is the interesting number: a score that is high but
      // falling is a different situation from one that is high and rising,
      // and a single number cannot tell them apart.
      slope: Math.round((current.score - prior.score) * 100) / 100,
      last_event: events.length ? events[events.length - 1].created_at : null,
    });
  }

  // ── Burn, activity ───────────────────────────────────────────────────────
  // Folded onto the agent they belong to. The token logger writes
  // "eliza-dev" where the registry says "eliza", and a picture that shows
  // one agent twice because two loggers spell it differently is a picture
  // of the loggers, not of the fleet.
  const knownAgents = new Set([
    ...trust.keys(),
    ...SIMPLE_NAMES,
    ...registry.map((r) => canonicalName(r.name)).filter(Boolean),
  ]);

  const burnBy = new Map();
  for (const b of burn) {
    const name = foldName(b.agent, knownAgents);
    if (!name || name === 'unknown') continue;
    const prev = burnBy.get(name) || { agent: name, calls: 0, tokens: 0, cost: 0, last_at: null };
    prev.calls += Number(b.calls || 0);
    prev.tokens += Number(b.tokens || 0);
    prev.cost += Number(b.cost || 0);
    if (b.last_at && (!prev.last_at || b.last_at > prev.last_at)) prev.last_at = b.last_at;
    burnBy.set(name, prev);
  }

  const activityBy = new Map();
  for (const a of activity) {
    const name = foldName(a.agent, knownAgents);
    if (!name || name === 'unknown') continue;
    const prev = activityBy.get(name) || { agent: name, events: 0, errors: 0, last_at: null };
    prev.events += Number(a.events || 0);
    prev.errors += Number(a.errors || 0);
    if (a.last_at && (!prev.last_at || a.last_at > prev.last_at)) prev.last_at = a.last_at;
    activityBy.set(name, prev);
  }

  // ── Galaxy degrees ───────────────────────────────────────────────────────
  const galaxyDegree = new Map();
  if (galaxy) {
    const labelById = new Map(galaxy.nodes.map((n) => [n.id, n.label || n.id]));
    for (const e of galaxy.edges) {
      const a = canonicalName(labelById.get(e.source));
      const b = canonicalName(labelById.get(e.target));
      for (const x of [a, b]) {
        if (!x) continue;
        galaxyDegree.set(x, (galaxyDegree.get(x) || 0) + 1);
      }
    }
  }

  // ── The agent set ────────────────────────────────────────────────────────
  // Every agent we know about from any of the four signals. An agent that
  // only appears in one of them is exactly the one worth seeing — it is
  // burning without being trusted, or trusted without doing anything.
  //
  // The set is bounded. The activity feed alone names 1,500 things in a
  // day (most of them clients, and a third of them literally "unknown"), and
  // a constellation of 1,500 dots is a smear, not a picture. So: keep the
  // agents that carry a real signal, and fold the rest away.
  const candidates = new Set([
    ...trust.keys(),
    ...burnBy.keys(),
    ...activityBy.keys(),
  ]);

  // Names that are not agents. "system" is the relay talking to itself and
  // "test" is a test that logged in; neither is a thing with a trust score
  // that anyone should read.
  const NOT_AGENTS = new Set(['system', 'test', 'unknown', 'null', 'none']);
  for (const name of [...candidates]) if (NOT_AGENTS.has(name)) candidates.delete(name);

  // An agent earns a place by having a signal, not by having a name.
  const scored = [...candidates].map((name) => {
    const t = trust.get(name) || null;
    const b = burnBy.get(name) || null;
    const a = activityBy.get(name) || null;
    const events = a ? a.events : 0;
    const calls = b ? b.calls : 0;
    const tokens = b ? b.tokens : 0;
    const weight = events + calls * 3 + (tokens > 0 ? 50 : 0) + (t ? 25 : 0);
    return { name, t, b, a, weight };
  }).filter((c) => c.weight > 0);

  // Keep the busiest, but never drop an agent that is trusted AND failing:
  // that combination is the whole reason to look.
  scored.sort((x, y) => y.weight - x.weight);
  const chosen = scored.slice(0, maxNodes);
  for (const c of scored.slice(maxNodes)) {
    if (c.t && c.a && c.a.errors > 0 && !chosen.find((k) => k.name === c.name)) chosen.push(c);
  }

  const nodes = [];
  for (const c of chosen) {
    const t = c.t, b = c.b, a = c.a;
    nodes.push({
      agent: c.name,
      // A client is a thing that calls the relay. An agent is a thing that
      // has a trust score. Drawing them the same would put "cron" and
      // "eliza" on the same axis, which is not a comparison.
      kind: t ? 'agent' : 'client',
      trust_score: t ? t.score : null,
      trust_band: t ? t.band : null,
      trust_slope: t ? t.slope : null,
      trust_events: t ? t.events : 0,
      last_trust_event: t ? t.last_event : null,
      calls: b ? b.calls : 0,
      tokens: b ? b.tokens : 0,
      cost: b ? Math.round(b.cost * 10000) / 10000 : 0,
      events: a ? a.events : 0,
      errors: a ? a.errors : 0,
      last_activity: a ? a.last_at : null,
      connections: galaxyDegree.get(c.name) || 0,
      // A missing trust score is not zero trust. It is unknown trust, and
      // the picture says so rather than pretending.
      unknown_trust: !t,
    });
  }
  const nodeNames = new Set(nodes.map((n) => n.agent));

  // ── Links ────────────────────────────────────────────────────────────────
  const linkMap = new Map();
  const addLink = (source, target, kind, weight) => {
    if (!source || !target || source === target) return;
    const key = [source, target, kind].sort().join('|');
    const prev = linkMap.get(key);
    if (prev) { prev.weight += weight; return; }
    linkMap.set(key, { source, target, kind, weight });
  };

  // Conversational: who @-mentions whom. The poster and the mentioned agent
  // are connected — this is how the fleet actually coordinates.
  //
  // Only to agents we can name. "@email" and "@mentions" are not people,
  // and a link to them would be a link to a word.
  for (const row of mentions) {
    const from = foldName(row.agent_id, knownAgents);
    if (!from) continue;
    const re = /@([a-z][a-z0-9_-]{2,30})/gi;
    let m;
    while ((m = re.exec(row.message || '')) !== null) {
      const to = foldName(m[1], knownAgents);
      if (to && to !== from && nodeNames.has(to) && nodeNames.has(from)) addLink(from, to, 'mentions', 1);
    }
  }

  // Shared faults: two agents hitting the same broken route. This is the
  // link that says "this is not two problems, it is one problem".
  const faultAgents = new Map();
  for (const row of sharedFaults) {
    const name = foldName(row.agent, knownAgents);
    if (!name || !nodeNames.has(name)) continue;
    if (!faultAgents.has(row.path)) faultAgents.set(row.path, []);
    faultAgents.get(row.path).push(name);
  }
  for (const [path, agents] of faultAgents.entries()) {
    const canonical = [...new Set(agents)];
    for (let i = 0; i < canonical.length; i++) {
      for (let j = i + 1; j < canonical.length; j++) {
        addLink(canonical[i], canonical[j], 'shared-fault', 2);
      }
    }
  }

  const links = [...linkMap.values()];

  // ── Scales and placement ─────────────────────────────────────────────────
  // The placement is done here, on the server, so that the client draws a
  // picture of the same shape every time and two operators looking at two
  // screens are looking at the same picture.
  const maxTokens = Math.max(1, ...nodes.map((n) => n.tokens));
  const maxEvents = Math.max(1, ...nodes.map((n) => n.events));
  const logMax = Math.log10(maxTokens + 1);

  for (const n of nodes) {
    const x = n.trust_score != null ? n.trust_score : 50;
    const burnNorm = n.tokens > 0 ? Math.log10(n.tokens + 1) / logMax : 0;
    n.x = Math.max(0, Math.min(1, x / 100));
    n.y = Math.max(0, Math.min(1, burnNorm));
    // Radius: how much it does. Square-rooted, because the difference
    // between 10 and 100 events matters more than between 1000 and 1100.
    n.r = 4 + Math.sqrt(n.events / maxEvents) * 16;
    n.error_rate = n.events > 0 ? Math.round((n.errors / n.events) * 1000) / 10 : 0;
  }

  return {
    generated_at: now.toISOString(),
    window: { burn_days: burnDays, activity_hours: activityHours, trust_days: trustWindowDays },
    nodes,
    links,
    totals: {
      agents: nodes.length,
      tracked_trust: nodes.filter((n) => !n.unknown_trust).length,
      burning: nodes.filter((n) => n.tokens > 0).length,
      active: nodes.filter((n) => n.events > 0).length,
      failing: nodes.filter((n) => n.errors > 0).length,
      linked: new Set(links.flatMap((l) => [l.source, l.target])).size,
    },
    galaxy: galaxy ? { nodes: galaxy.nodes.length, edges: galaxy.edges.length } : null,
  };
}
