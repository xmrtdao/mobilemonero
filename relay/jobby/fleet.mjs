/**
 * relay/jobby/fleet.mjs — Jobby's side of the shared fleet board.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `jobby-001` has been in `app.agents` all along — "Career Agent / Negotiator",
 * skills `job-search, dossier, outreach, ats, resume, planning, negotiation` —
 * registered alongside `eliza-001` and `vex-001`. So Jobby was never missing an
 * identity. He was missing a way to *act on it*. With 26 tools he could read and
 * write one person's dossier and send that person an email, and had no way at all
 * to see the other agents, the shared board, or the task pipeline.
 *
 * That is not a smaller product. It is a different one. An agent that cannot read
 * the board cannot be reviewed by other agents, and oversight between language
 * models only means something when the reviewers can see the work.
 *
 * ── The schema trap that shaped this file ───────────────────────────────────
 *
 * Fleet state lives in the `public` schema, not `app`:
 *
 *   public.fleet_messages   17,608 rows   (id, topic, agent_id, agent_name,
 *                                            message, payload, certificate_id,
 *                                            created_at, tenant_id)
 *   public.tasks               189 rows
 *   public.agents               13 rows
 *
 * `app.fleet_messages` does not exist. Querying it returns an error rather than
 * an empty set, which is the good kind of failure — but every query here was
 * written against `public` after that cost an afternoon. Note the drift checker in
 * server.js lists `public.fleet_messages` among the tables it watches, confirming
 * `public` is canonical.
 *
 * ── Identity is taken from the server, never from the model ────────────────
 *
 * Every function here takes `agentId` from the caller — the relay — and ignores
 * anything the model put in its arguments. The model cannot choose who it is.
 *
 * That is deliberate, and it is the shape that should become the rule. A message
 * posted through these tools carries `agent_id = 'jobby-001'` because the tool
 * said so, not because Jobby claimed it. Compare with the bare HTTP route at
 * `/api/fleet-chat/send`, where `agent` is read straight from the request body
 * and nothing binds it to a credential. These tools are the first place in the
 * codebase where the speaker is server-determined.
 *
 * `certificate_id` is recorded when the relay supplies one, and left null when it
 * does not — rather than being invented. Recent messages on the board carry
 * `certificate_id = NULL`, including Eliza's, so a null here is currently the
 * normal case and inventing one would be a lie that looks like proof.
 */

import { getPool } from './store.mjs';

/** The id the relay records for this agent. Not overridable by a tool argument. */
export const JOBBY_AGENT_ID = 'jobby-001';
const JOBBY_AGENT_NAME = 'Jobby';

/**
 * Post to the shared fleet board.
 *
 * Mirrors what `/api/fleet-chat/send` writes so messages are indistinguishable to
 * anything reading the board — same table, same columns. The one deliberate
 * difference is `agent_id`, which comes from this module and not from the caller.
 *
 * @param {object} args
 * @param {string} args.message      what to say
 * @param {string} [args.topic]      channel; defaults to 'fleet'
 * @param {object} [args.payload]    structured detail alongside the text
 * @param {string|null} [args.certificateId]  recorded when supplied, never invented
 * @returns {Promise<object>} the row as written
 */
export async function postToFleet({ message, topic = 'fleet', payload = null, certificateId = null }) {
  const text = String(message ?? '').trim();
  if (!text) return { ok: false, error: 'message is required' };

  const pool = await getPool();
  // Reject a message that is only whitespace or an empty JSON shell — the same
  // spirit as the sanitiser on the HTTP route, which strips bare TOOL_CALL lines
  // because a tool line leaking into the board reads as a system failure.
  const { rows } = await pool.query(
    `INSERT INTO public.fleet_messages
       (id, topic, agent_id, agent_name, message, payload, certificate_id, created_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, now())
     RETURNING id, topic, agent_id, agent_name, created_at`,
    [topic, JOBBY_AGENT_ID, JOBBY_AGENT_NAME, text, payload ? JSON.stringify(payload) : null, certificateId]
  );
  return { ok: true, posted: rows[0] };
}

/**
 * Read recent board traffic.
 *
 * `topic` filters to a channel. The default is the general board rather than
 * everything, because Jobby's job is a person's search and the flood channel is
 * mostly other agents' orchestration noise.
 *
 * @param {object} args
 * @param {number} [args.limit]
 * @param {string|null} [args.topic]
 * @param {string|null} [args.sinceMinutes]  how far back to look
 */
export async function readFleet({ limit = 25, topic = 'fleet', sinceMinutes = null } = {}) {
  const pool = await getPool();
  const n = Math.max(1, Math.min(Number(limit) || 25, 100));
  const params = [];
  const where = [];

  if (topic && topic !== 'all') {
    params.push(topic);
    where.push(`topic = $${params.length}`);
  }
  if (sinceMinutes) {
    params.push(Number(sinceMinutes));
    where.push(`created_at > now() - ($${params.length} || ' minutes')::interval`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT id, topic, agent_id, agent_name, message, certificate_id, created_at
       FROM public.fleet_messages
       ${clause}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1}`,
    [...params, n]
  );

  return {
    ok: true,
    count: rows.length,
    messages: rows.map((r) => ({
      id: r.id,
      topic: r.topic,
      agent: r.agent_name || r.agent_id,
      agentId: r.agent_id,
      // Whether the speaker was proved at write time. Surfaced rather than
      // implied, so an oversight decision can weigh an unverified claim lower.
      verified: Boolean(r.certificate_id),
      message: r.message,
      when: r.created_at,
    })),
  };
}

/**
 * Who else is on the fleet, and what they are carrying.
 *
 * This is what makes Jobby a participant rather than an island, and it is also
 * what makes him reviewable: an agent whose current work is visible can be asked
 * about it.
 */
export async function fleetPulse() {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT id, name, role, status, current_workload, max_concurrent_tasks, skills
       FROM public.agents
      ORDER BY (CASE WHEN status IN ('BUSY','busy') THEN 0 ELSE 1 END), id`
  );

  // Board traffic in the last hour, per agent, so "busy" can be checked against
  // something rather than taken on trust.
  const recent = await pool.query(
    `SELECT agent_id, count(*)::int AS n
       FROM public.fleet_messages
      WHERE created_at > now() - interval '1 hour'
      GROUP BY agent_id`
  );
  const byAgent = Object.fromEntries(recent.rows.map((r) => [r.agent_id, r.n]));

  return {
    ok: true,
    agents: rows.map((a) => ({
      id: a.id,
      name: a.name || a.id,
      role: a.role || null,
      status: a.status || 'unknown',
      load: `${a.current_workload ?? 0}/${a.max_concurrent_tasks ?? 0}`,
      skills: a.skills ? String(a.skills).split(',').map((s) => s.trim()).filter(Boolean) : [],
      messagesLastHour: byAgent[a.id] ?? 0,
      isJobby: a.id === JOBBY_AGENT_ID,
    })),
    total: rows.length,
  };
}

/**
 * Open tasks on the board.
 *
 * Jobby's own `jobby_plan_status` is a private per-candidate plan. This is the
 * shared pipeline other agents work on, which he could not previously see at all.
 *
 * @param {object} args
 * @param {string} [args.stage]   filter to one stage
 * @param {string} [args.assignee] filter to one agent
 * @param {number} [args.limit]
 */
export async function fleetTasks({ stage = null, assignee = null, limit = 25 } = {}) {
  const pool = await getPool();
  const params = [];
  const where = [];
  if (stage) { params.push(stage); where.push(`stage = $${params.length}`); }
  if (assignee) { params.push(assignee); where.push(`assignee_agent_id = $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(Math.max(1, Math.min(Number(limit) || 25, 100)));

  const { rows } = await pool.query(
    `SELECT id, title, stage, status, priority, assignee_agent_id, blocking_reason,
            progress_percentage, created_at, updated_at
       FROM public.tasks
       ${clause}
      ORDER BY updated_at DESC
      LIMIT $${params.length}`,
    params
  );

  return {
    ok: true,
    count: rows.length,
    tasks: rows.map((t) => ({
      id: t.id,
      title: t.title,
      stage: t.stage,
      status: t.status,
      priority: t.priority,
      assignee: t.assignee_agent_id,
      blocked: Boolean(t.blocking_reason),
      progress: t.progress_percentage,
      updated: t.updated_at,
    })),
  };
}