
CREATE TABLE IF NOT EXISTS public.relay_tools (
    tool_name text PRIMARY KEY,
    description text,
    category text,
    status text DEFAULT 'active',
    source_schema_table text,
    source_type text DEFAULT 'relay_tool',
    ai_compatible boolean DEFAULT true,
    usage_count integer DEFAULT 0,
    last_used timestamptz,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE OR REPLACE VIEW public.vw_tool_function_registry AS
SELECT tool_name, description, category, status, source_schema_table, source_type, ai_compatible,
       priority, usage_count, last_used, created_at, updated_at, metadata, proposed_by, deployed_by
FROM public.unified_tool_registry
UNION ALL
SELECT tool_name, description, category, status, source_schema_table, source_type, ai_compatible,
       NULL::integer AS priority, usage_count, last_used, created_at, updated_at,
       NULL::jsonb AS metadata, NULL::text AS proposed_by, NULL::text AS deployed_by
FROM public.relay_tools;
