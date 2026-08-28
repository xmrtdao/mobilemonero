-- ═══════════════════════════════════════════════════════════
-- SCHEMA DRIFT FIX: Edge function registry + interaction_patterns compat views
-- 2026-08-28 — identified by Vex/Eliza during XMRT University pipeline verification
--
-- The phantom `edge_function_registry` relation caused a recurring 500 class:
--   - Eliza hit "relation edge_function_registry does not exist" via db-query
--   - Vex confirmed via introspection it was a phantom (real registry = unified_tool_registry)
-- Fix: expose edge_function_registry as a view over the real unified_tool_registry
-- so agent db-query/REST reads stop 500ing and resolve to the actual catalog.
-- ═══════════════════════════════════════════════════════════

-- 1. edge_function_registry — compatibility view over the real unified_tool_registry
--    (which already holds edge functions like xmrt-university, search-edge-functions, etc.)
CREATE OR REPLACE VIEW public.edge_function_registry AS
SELECT
  tool_name AS name,
  description,
  category,
  status,
  source_schema_table,
  source_type,
  ai_compatible,
  priority,
  usage_count,
  last_used,
  created_at,
  updated_at,
  metadata
FROM public.unified_tool_registry;

-- 2. interaction_patterns compat view in knowledge schema (defensive: agents may
--    query schema-prefixed knowledge.interaction_patterns; canonical data is public)
CREATE OR REPLACE VIEW knowledge.interaction_patterns AS
SELECT * FROM public.interaction_patterns;
