#!/usr/bin/env node
/**
 * ef:elze-learnings — Elze AI-Learnings feedback capture + dashboard queries
 *
 * Foundation for the per-attorney learning loop (Mixus-moat).
 *
 * Capture (from the diff frontend):
 *   action: "feedback"  { attorney_id, matter_id, clause_id, playbook_rule_id,
 *                         action: accept|reject|edit, edited_text, document_id }
 *   -> INSERT into public.elze_redline_feedback and roll up elze_playbook_metrics
 *      (total_events, accepted, rejected, edited, acceptance_rate, over/under-correct)
 *
 * Dashboard queries:
 *   action: "dashboard"       -> acceptance by attorney / by rule / over-under-correct, totals
 *   action: "by_attorney"     -> { attorney_id } acceptance over time
 *   action: "preferences"     -> { attorney_id } inferred preferences from accepted edits
 *
 * Reads/writes the canonical public.elze_* tables via the relay's local PG.
 */

const META = {
  description: 'Elze AI-Learnings. Capture accept/reject/edit feedback (action: feedback) and query the learning dashboard (action: dashboard, by_attorney, preferences). Roll up per-rule acceptance metrics and infer per-attorney preferences.',
  category: 'legal',
  version: '0.1.0',
  author: 'hermes-agent',
  dependencies: [],
};

let queryFn = null;
export function setQueryFn(fn) { queryFn = fn; }

async function q(sql, params) {
  if (queryFn) return await queryFn(sql, params);
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });
  await c.connect();
  try { return await c.query(sql, params); }
  finally { await c.end(); }
}

// ── Feedback capture ────────────────────────────────────────
async function captureFeedback(f) {
  const attorney = f.attorney_id || 'unknown';
  const rule = f.playbook_rule_id || f.clause_id || 'unknown';
  const action = ['accept','reject','edit'].includes(f.action) ? f.action : 'accept';

  await q(
    `INSERT INTO public.elze_redline_feedback
      (attorney_id, matter_id, clause_id, playbook_rule_id, action, edited_text, document_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [attorney, f.matter_id || null, f.clause_id || null, f.playbook_rule_id || null,
     action, f.edited_text || null, f.document_id || null]
  );

  // Roll up playbook metrics (upsert)
  const col = action === 'accept' ? 'accepted' : (action === 'reject' ? 'rejected' : 'edited');
  await q(
    `INSERT INTO public.elze_playbook_metrics (rule_id, total_events, ${col}, acceptance_rate, last_updated)
     VALUES ($1, 1, 1, 0, now())
     ON CONFLICT (rule_id) DO UPDATE SET
       total_events = public.elze_playbook_metrics.total_events + 1,
       ${col} = public.elze_playbook_metrics.${col} + 1,
       last_updated = now()`,
    [rule]
  );
  // Recompute acceptance rate for the rule
  await q(
    `UPDATE public.elze_playbook_metrics
        SET acceptance_rate = CASE WHEN total_events > 0
             THEN ROUND(100.0 * accepted / total_events, 2) ELSE 0 END
      WHERE rule_id = $1`, [rule]
  );

  // Update attorney profile last-used
  await q(
    `INSERT INTO public.elze_attorney_profiles (attorney_id, attorney_name)
     VALUES ($1, $2) ON CONFLICT (attorney_id) DO UPDATE SET updated_at = now()`,
    [attorney, f.attorney_name || attorney]
  );

  return { success: true, recorded: { attorney, rule, action } };
}

// ── Dashboard queries ───────────────────────────────────────
async function dashboard() {
  const byRule = (await q(
    `SELECT playbook_rule_id AS rule_id, count(*) AS events,
            count(*) FILTER (WHERE action='accept') AS accepted,
            count(*) FILTER (WHERE action='reject') AS rejected,
            count(*) FILTER (WHERE action='edit') AS edited,
            ROUND(100.0 * count(*) FILTER (WHERE action='accept') / NULLIF(count(*),0), 1) AS acceptance_rate
       FROM public.elze_redline_feedback
      GROUP BY playbook_rule_id ORDER BY events DESC`
  )).rows;

  const byAttorney = (await q(
    `SELECT attorney_id, count(*) AS events,
            count(*) FILTER (WHERE action='accept') AS accepted,
            count(*) FILTER (WHERE action='reject') AS rejected,
            ROUND(100.0 * count(*) FILTER (WHERE action='accept') / NULLIF(count(*),0), 1) AS acceptance_rate
       FROM public.elze_redline_feedback
      GROUP BY attorney_id ORDER BY events DESC`
  )).rows;

  const totals = (await q(
    `SELECT count(*) AS total_events,
            count(*) FILTER (WHERE action='accept') AS accepted,
            count(*) FILTER (WHERE action='reject') AS rejected,
            count(*) FILTER (WHERE action='edit') AS edited
       FROM public.elze_redline_feedback`
  )).rows[0] || {};

  // Over/under-correct: rules with very high (>=85%) acceptance = possibly under-correcting
  // (could tighten); rules with very low (<=40%) acceptance = over-correcting.
  const overUnder = (await q(
    `SELECT rule_id, total_events, accepted, acceptance_rate,
            CASE WHEN acceptance_rate >= 85 THEN 'under-correct' 
                 WHEN acceptance_rate <= 40 THEN 'over-correct'
                 ELSE 'balanced' END AS signal
       FROM public.elze_playbook_metrics
      WHERE total_events >= 3
      ORDER BY acceptance_rate`
  )).rows;

  return { success: true, totals, byRule, byAttorney, overUnder };
}

async function byAttorney(attorneyId) {
  const series = (await q(
    `SELECT date_trunc('day', created_at) AS day, count(*) AS events,
            count(*) FILTER (WHERE action='accept') AS accepted
       FROM public.elze_redline_feedback
      WHERE attorney_id = $1
      GROUP BY day ORDER BY day`, [attorneyId]
  )).rows;
  const prefs = (await q(
    `SELECT action, edited_text, playbook_rule_id, count(*) AS n
       FROM public.elze_redline_feedback
      WHERE attorney_id = $1 AND action = 'accept' AND edited_text IS NOT NULL
      GROUP BY action, edited_text, playbook_rule_id ORDER BY n DESC LIMIT 20`, [attorneyId]
  )).rows;
  return { success: true, attorney_id: attorneyId, series, accepted_preferences: prefs };
}

async function preferences(attorneyId) {
  const profile = (await q(
    `SELECT * FROM public.elze_attorney_profiles WHERE attorney_id = $1`, [attorneyId]
  )).rows[0] || null;
  // Infer from accepted edits: most-common accepted suggested clauses
  const inferred = (await q(
    `SELECT playbook_rule_id, count(*) AS n
       FROM public.elze_redline_feedback
      WHERE attorney_id = $1 AND action = 'accept'
      GROUP BY playbook_rule_id ORDER BY n DESC LIMIT 10`, [attorneyId]
  )).rows;
  return { success: true, attorney_id: attorneyId, profile, inferred_preferences: inferred };
}

async function run(args) {
  // Auto-detect feedback: a capture call carries accept|reject|edit as `action`
  // plus at least one of playbook_rule_id/clause_id. The dashboard queries use
  // action = dashboard|by_attorney|preferences.
  const decision = ['accept','reject','edit'];
  const isFeedback = decision.includes(args?.action) &&
    (args?.playbook_rule_id || args?.clause_id || args?.attorney_id);
  if (isFeedback) return await captureFeedback(args);

  switch (args?.action) {
    case 'feedback': return await captureFeedback(args);
    case 'dashboard': return await dashboard();
    case 'by_attorney':
      if (!args.attorney_id) return { success: false, error: 'attorney_id required' };
      return await byAttorney(args.attorney_id);
    case 'preferences':
      if (!args.attorney_id) return { success: false, error: 'attorney_id required' };
      return await preferences(args.attorney_id);
    default:
      return { success: false, error: `unknown action '${args?.action}'. Actions: feedback, dashboard, by_attorney, preferences` };
  }
}

export async function handler(reqOrArgs, res) {
  let args;
  if (res) {
    try { args = reqOrArgs?.body || {}; } catch { args = {}; }
  } else {
    args = reqOrArgs || {};
  }
  if (args?._db) setQueryFn(args._db);
  let result;
  try { result = await run(args); }
  catch (err) { result = { success: false, error: err.message }; }
  if (res) return res.json(result);
  return result;
}

export { META };

if (process.argv[1] && (process.argv[1].includes('elze-learnings') || process.argv[1].includes('_local_shim'))) {
  const args = { action: 'dashboard' };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = process.argv[i + 1];
      if (val && !val.startsWith('--')) { args[key] = val; i++; } else { args[key] = true; }
    }
  }
  handler(args).then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); });
}
