// Create unified tool/function registry view
// Task t-msbdeuo7-bpre — single queryable view of every tool/function
// across ai_tools, edge_function_proposals, proposed_edge_functions, function_proposals
import pg from 'pg';
const { Pool } = pg;

const DB_URL = process.env.LOCAL_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';

const pool = new Pool({ connectionString: DB_URL, max: 5 });

const DDL = `
CREATE OR REPLACE VIEW public.unified_tool_registry AS
-- ═══════════════════════════════════════════════════════════════
-- UNIFIED TOOL / FUNCTION REGISTRY VIEW
-- Task t-msbdeuo7-bpre (2026-08-11)
-- Single queryable view of every tool/function across the scattered
-- schemas: ai_tools (primary), edge_function_proposals,
-- proposed_edge_functions, function_proposals.
-- Columns: tool_name, description, category, status, source_schema_table,
--   source_type, ai_compatible, priority, usage_count, last_used,
--   created_at, updated_at, metadata, proposed_by, deployed_by
-- ═══════════════════════════════════════════════════════════════
-- 1. ai_tools — primary tool registry
SELECT
  name AS tool_name,
  description,
  category,
  CASE WHEN is_active THEN 'ACTIVE' ELSE 'INACTIVE' END AS status,
  'public.ai_tools' AS source_schema_table,
  'ai_tool' AS source_type,
  ai_compatible,
  priority,
  usage_count,
  last_used,
  created_at,
  updated_at,
  parameters AS metadata,
  NULL::text AS proposed_by,
  NULL::text AS deployed_by
FROM public.ai_tools

UNION ALL

-- 2. edge_function_proposals
SELECT
  function_name AS tool_name,
  description,
  category,
  COALESCE(status, 'PROPOSED') AS status,
  'public.edge_function_proposals' AS source_schema_table,
  'edge_function_proposal' AS source_type,
  NULL::boolean AS ai_compatible,
  NULL::integer AS priority,
  NULL::integer AS usage_count,
  NULL::timestamptz AS last_used,
  created_at,
  updated_at,
  parameters AS metadata,
  proposed_by,
  deployed_by
FROM public.edge_function_proposals

UNION ALL

-- 3. proposed_edge_functions
SELECT
  name AS tool_name,
  description,
  category,
  COALESCE(status, 'PROPOSED') AS status,
  'public.proposed_edge_functions' AS source_schema_table,
  'edge_function_proposal' AS source_type,
  NULL::boolean AS ai_compatible,
  NULL::integer AS priority,
  NULL::integer AS usage_count,
  NULL::timestamptz AS last_used,
  created_at,
  updated_at,
  parameters AS metadata,
  proposed_by,
  deployed_by
FROM public.proposed_edge_functions

UNION ALL

-- 4. function_proposals
SELECT
  function_name AS tool_name,
  NULL::text AS description,
  category,
  COALESCE(status, 'PROPOSED') AS status,
  'public.function_proposals' AS source_schema_table,
  'function_proposal' AS source_type,
  NULL::boolean AS ai_compatible,
  NULL::integer AS priority,
  NULL::integer AS usage_count,
  NULL::timestamptz AS last_used,
  created_at,
  NULL::timestamptz AS updated_at,
  NULL::jsonb AS metadata,
  NULL::text AS proposed_by,
  NULL::text AS deployed_by
FROM public.function_proposals;
`;

async function main() {
  const c = await pool.connect();
  try {
    await c.query(DDL);
    console.log('VIEW created: public.unified_tool_registry');
    // Verify
    const total = await c.query('SELECT COUNT(*)::int AS total FROM public.unified_tool_registry');
    const bySrc = await c.query(`SELECT source_schema_table, COUNT(*)::int AS n FROM public.unified_tool_registry GROUP BY source_schema_table ORDER BY n DESC`);
    const active = await c.query(`SELECT COUNT(*)::int AS n FROM public.unified_tool_registry WHERE status='ACTIVE'`);
    console.log('Total rows:', total.rows[0].total);
    console.log('By source:', JSON.stringify(bySrc.rows));
    console.log('Active:', active.rows[0].n);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
