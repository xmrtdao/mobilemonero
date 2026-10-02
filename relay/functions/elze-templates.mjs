#!/usr/bin/env node
/**
 * ef:elze-templates — Elze Contract Suite template & clause retrieval
 *
 * Provides template retrieval for the Elze lease-writer system. Reads the
 * canonical source: the local DB tables (public.lease_templates,
 * public.clause_definitions, public.template_clauses) seeded by lease-builder
 * and the seed migrations. This is a READ-ONLY retrieval layer — it does NOT
 * redefine templates/clauses; it surfaces what's already in the DB.
 *
 * NAMING: prefix `elze-` — part of the Elze legal suite (lease_analyzer,
 * elze-templates, elze-lease-writer). Distinct from the warm-pool concurrency
 * lease-manager.
 *
 * Actions:
 *   templates                  -> all templates with metadata
 *   template  {id|template_id} -> single template + its ordered clauses
 *   clauses   {template_id?}   -> all clause definitions (optionally for a template)
 *   search    {q, category?}   -> search templates/clauses by keyword
 *
 * Filters (on templates action): category, jurisdiction, q
 *
 * Returns { success, ... }.
 */

const META = {
  description: 'Elze Contract Suite template & clause retrieval. Actions: templates (all with metadata), template {id} (single + clauses), clauses {template_id} (definitions), search {q, category}. Filters: category, jurisdiction. Reads canonical public.lease_templates / clause_definitions / template_clauses. Use to fetch template structure for the lease writer.',
  category: 'legal',
  version: '0.1.0',
  author: 'hermes-agent',
  dependencies: [],
};

// Use the relay's local PG (queryLocalPg) via an injected query fn.
// The handler receives an optional `_db` query function from the relay; if not
// provided, fall back to direct pg. We expose the query as a resolvable import
// so the relay can wire queryLocalPg in.
let queryFn = null;

export function setQueryFn(fn) { queryFn = fn; }

async function q(sql, params) {
  if (queryFn) return await queryFn(sql, params);
  // Fallback: direct pg (dev / standalone).
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });
  await client.connect();
  try { const r = await client.query(sql, params); return { rows: r.rows }; }
  finally { await client.end(); }
}

const ROW = (r) => r && r.rows ? r.rows : r;

// ── Queries ────────────────────────────────────────────────
async function getTemplates(filters = {}) {
  let sql = 'SELECT id, name, description, category, metadata FROM public.lease_templates';
  const conds = []; const params = [];
  if (filters.category) { params.push(filters.category); conds.push(`category ILIKE '%' || $${params.length} || '%'`); }
  if (filters.jurisdiction) { params.push(filters.jurisdiction); conds.push(`metadata->>'jurisdiction' ILIKE '%' || $${params.length} || '%'`); }
  if (filters.q) { params.push(filters.q); conds.push(`(name ILIKE '%' || $${params.length} || '%' OR description ILIKE '%' || $${params.length} || '%')`); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY name';
  return ROW(await q(sql, params));
}

async function getTemplate(id) {
  const t = ROW(await q('SELECT id, name, description, category, metadata FROM public.lease_templates WHERE id = $1', [id]));
  if (!t || !t.length) return null;
  const template = t[0];
  const clauses = ROW(await q(
    `SELECT cd.clause_key, cd.label, cd.description, cd.default_text, cd.is_required, cd.sort_order, cd.options
       FROM public.clause_definitions cd
       JOIN public.template_clauses tc ON tc.clause_id = cd.id
      WHERE tc.template_id = $1
      ORDER BY cd.sort_order`, [id]
  ));
  return { ...template, clauses: clauses || [] };
}

async function getClauses(templateId) {
  if (templateId) {
    return ROW(await q(
      `SELECT cd.clause_key, cd.label, cd.description, cd.default_text, cd.is_required, cd.sort_order, cd.options
         FROM public.clause_definitions cd
         JOIN public.template_clauses tc ON tc.clause_id = cd.id
        WHERE tc.template_id = $1
        ORDER BY cd.sort_order`, [templateId]
    ));
  }
  // All distinct clauses (dedupe by clause_key across templates)
  return ROW(await q(
    `SELECT DISTINCT ON (cd.clause_key) cd.clause_key, cd.label, cd.description, cd.default_text, cd.is_required, cd.sort_order, cd.options
       FROM public.clause_definitions cd
      ORDER BY cd.clause_key, cd.sort_order`
  ));
}

async function search(qt, category) {
  const results = { templates: [], clauses: [] };
  if (!category || category === 'template') {
    results.templates = await getTemplates({ q: qt });
  }
  if (!category || category === 'clause') {
    results.clauses = ROW(await q(
      `SELECT DISTINCT ON (cd.clause_key) cd.clause_key, cd.label, cd.description, cd.is_required, cd.sort_order
         FROM public.clause_definitions cd
        WHERE cd.label ILIKE '%' || $1 || '%' OR cd.description ILIKE '%' || $1 || '%' OR cd.clause_key ILIKE '%' || $1 || '%'
        ORDER BY cd.clause_key, cd.sort_order`, [qt]
    ));
  }
  return results;
}

// ── Handler ────────────────────────────────────────────────
async function run(args) {
  const action = args?.action || 'templates';
  switch (action) {
    case 'templates': {
      const templates = await getTemplates({ category: args.category, jurisdiction: args.jurisdiction, q: args.q });
      return { success: true, count: templates.length, templates, metadata: { source: 'public.lease_templates', version: META.version } };
    }
    case 'template': {
      const id = args?.id || args?.template_id;
      if (!id) return { success: false, error: 'template id required (id or template_id)' };
      const t = await getTemplate(id);
      if (!t) return { success: false, error: `template not found: ${id}` };
      return { success: true, template: t, clause_count: (t.clauses || []).length };
    }
    case 'clauses': {
      const clauses = await getClauses(args?.template_id);
      return { success: true, count: clauses.length, clauses };
    }
    case 'search': {
      if (!args?.q) return { success: false, error: 'search q required' };
      const res = await search(args.q, args.category);
      return { success: true, ...res };
    }
    default:
      return { success: false, error: `unknown action '${action}'. Actions: templates, template, clauses, search` };
  }
}

export async function handler(reqOrArgs, res) {
  let args;
  if (res) {
    try { args = reqOrArgs?.body || {}; } catch { args = {}; }
  } else {
    args = reqOrArgs || {};
  }
  // Allow the relay to inject queryLocalPg if present
  if (args?._db) setQueryFn(args._db);
  let result;
  try { result = await run(args); }
  catch (err) { result = { success: false, error: err.message }; }
  if (res) return res.json(result);
  return result;
}

export { META };

/* ── CLI execution ────────────────────────────────────────── */
if (process.argv[1] && (process.argv[1].includes('elze-templates') || process.argv[1].includes('_local_shim'))) {
  const args = { action: 'templates' };
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
