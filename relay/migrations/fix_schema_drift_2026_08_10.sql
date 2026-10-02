
-- ═══════════════════════════════════════════════════════════
-- SCHEMA DRIFT FIX: Create missing cuttlefish tables
-- 2026-08-10 — identified by engine health check errors
-- ═══════════════════════════════════════════════════════════

-- 1. cuttlefish_standing_events
-- Used by: standing_event_write, standing_get_domain
-- Columns referenced: agent_did, domain, event_type, quality_score, delta, 
--   standing_after, reference, note, id, event_id, created_at
CREATE TABLE IF NOT EXISTS app.cuttlefish_standing_events (
    id SERIAL PRIMARY KEY,
    event_id TEXT DEFAULT gen_random_uuid()::text,
    agent_did TEXT NOT NULL,
    domain TEXT NOT NULL,
    event_type TEXT NOT NULL,
    quality_score NUMERIC DEFAULT 50,
    delta NUMERIC DEFAULT 0,
    standing_after NUMERIC DEFAULT 50,
    reference TEXT,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_standing_events_agent_domain ON app.cuttlefish_standing_events(agent_did, domain);
CREATE INDEX IF NOT EXISTS idx_standing_events_created ON app.cuttlefish_standing_events(created_at);

-- 2. cuttlefish_activity_registry
-- Used by: activity_event_write
-- Columns: actor_kya_id, agent_did, activity_type, domain, work_unit, evidence_hash,
--   section_404_category, reward_eligibility, signature, previous_hash, current_hash, id, event_id, created_at
CREATE TABLE IF NOT EXISTS app.cuttlefish_activity_registry (
    id SERIAL PRIMARY KEY,
    event_id TEXT DEFAULT gen_random_uuid()::text,
    actor_kya_id TEXT,
    agent_did TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    domain TEXT,
    work_unit JSONB DEFAULT '{}',
    evidence_hash TEXT,
    section_404_category TEXT,
    reward_eligibility JSONB DEFAULT '{}',
    signature TEXT DEFAULT '',
    previous_hash TEXT,
    current_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_registry_agent ON app.cuttlefish_activity_registry(agent_did);
CREATE INDEX IF NOT EXISTS idx_activity_registry_hash ON app.cuttlefish_activity_registry(current_hash);

-- 3. cuttlefish_gate_decisions
-- Used by: gate_evaluate
-- Columns: agent_did, activity_type, domain, cac_tier, ial, allowed,
--   trustgraph_score, trustgraph_status, standing_value, standing_ladder,
--   reasons, purpose
CREATE TABLE IF NOT EXISTS app.cuttlefish_gate_decisions (
    id SERIAL PRIMARY KEY,
    agent_did TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    domain TEXT NOT NULL,
    cac_tier TEXT,
    ial TEXT,
    allowed BOOLEAN DEFAULT false,
    trustgraph_score NUMERIC,
    trustgraph_status TEXT,
    standing_value NUMERIC,
    standing_ladder TEXT,
    reasons JSONB DEFAULT '[]',
    purpose TEXT DEFAULT 'write',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gate_decisions_agent ON app.cuttlefish_gate_decisions(agent_did);

-- 4. cuttlefish_kya_bindings
-- Referenced in health check table list
CREATE TABLE IF NOT EXISTS app.cuttlefish_kya_bindings (
    id SERIAL PRIMARY KEY,
    kya_id TEXT NOT NULL,
    agent_did TEXT NOT NULL,
    binding_type TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kya_bindings_kya ON app.cuttlefish_kya_bindings(kya_id);
CREATE INDEX IF NOT EXISTS idx_kya_bindings_agent ON app.cuttlefish_kya_bindings(agent_did);

-- 5. cuttlefish_kya_acknowledgements
CREATE TABLE IF NOT EXISTS app.cuttlefish_kya_acknowledgements (
    id SERIAL PRIMARY KEY,
    kya_id TEXT NOT NULL,
    ack_type TEXT,
    ack_data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kya_acks_kya ON app.cuttlefish_kya_acknowledgements(kya_id);

-- 6. cuttlefish_kya_successions
CREATE TABLE IF NOT EXISTS app.cuttlefish_kya_successions (
    id SERIAL PRIMARY KEY,
    from_kya_id TEXT NOT NULL,
    to_kya_id TEXT NOT NULL,
    succession_type TEXT,
    effective_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. cuttlefish_council
-- Used by: council_list
-- Columns: id, member_did, role, domain, seated_at, term_expires_at, status, metadata
CREATE TABLE IF NOT EXISTS app.cuttlefish_council (
    id SERIAL PRIMARY KEY,
    member_did TEXT NOT NULL,
    role TEXT,
    domain TEXT,
    seated_at TIMESTAMPTZ DEFAULT NOW(),
    term_expires_at TIMESTAMPTZ,
    status TEXT DEFAULT 'seated',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_council_status ON app.cuttlefish_council(status);

-- 8. cuttlefish_rate_card
-- Used by: rate_card
-- Columns: version, activity_type, base_rate, min_amount, per_event_cap,
--   quality_multiplier_default, section_404_category, effective_from,
--   effective_until, is_active
CREATE TABLE IF NOT EXISTS app.cuttlefish_rate_card (
    id SERIAL PRIMARY KEY,
    version TEXT DEFAULT '1.0.0',
    activity_type TEXT NOT NULL,
    base_rate NUMERIC DEFAULT 0,
    min_amount NUMERIC DEFAULT 0,
    per_event_cap NUMERIC,
    quality_multiplier_default NUMERIC DEFAULT 1.0,
    section_404_category TEXT,
    effective_from TIMESTAMPTZ DEFAULT NOW(),
    effective_until TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rate_card_active ON app.cuttlefish_rate_card(is_active);

-- 9. cuttlefish_reward_distributions
CREATE TABLE IF NOT EXISTS app.cuttlefish_reward_distributions (
    id SERIAL PRIMARY KEY,
    agent_did TEXT NOT NULL,
    activity_type TEXT,
    amount NUMERIC DEFAULT 0,
    quality_score NUMERIC,
    distribution_tx TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reward_dist_agent ON app.cuttlefish_reward_distributions(agent_did);

-- 10. cuttlefish_social_posts
-- Used by: social_posts_list, social_post_create
-- Columns: id, agent_did, platform, content_en, content_native, language,
--   hashtags, is_milestone, constitutional_score, flags,
--   operator_approved, trib_approved, status, posted_at, post_url, created_at
CREATE TABLE IF NOT EXISTS app.cuttlefish_social_posts (
    id SERIAL PRIMARY KEY,
    agent_did TEXT NOT NULL,
    platform TEXT NOT NULL,
    content_en TEXT NOT NULL,
    content_native TEXT,
    language TEXT,
    hashtags TEXT[],
    is_milestone BOOLEAN DEFAULT false,
    constitutional_score NUMERIC,
    flags JSONB DEFAULT '[]',
    operator_approved BOOLEAN DEFAULT false,
    trib_approved BOOLEAN DEFAULT false,
    status TEXT DEFAULT 'draft',
    posted_at TIMESTAMPTZ,
    post_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_posts_agent ON app.cuttlefish_social_posts(agent_did);
CREATE INDEX IF NOT EXISTS idx_social_posts_platform ON app.cuttlefish_social_posts(platform);
CREATE INDEX IF NOT EXISTS idx_social_posts_status ON app.cuttlefish_social_posts(status);

-- 11. cuttlefish_stewardship_reviews
CREATE TABLE IF NOT EXISTS app.cuttlefish_stewardship_reviews (
    id SERIAL PRIMARY KEY,
    agent_did TEXT NOT NULL,
    domain TEXT,
    review_type TEXT,
    quality_score NUMERIC,
    reviewer_did TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_steward_reviews_agent ON app.cuttlefish_stewardship_reviews(agent_did);

-- ═══════════════════════════════════════════════════════════
-- FIX SCHEMA DRIFT: cuttlefish_stewardship_standing
-- Existing columns: id, agent_did, standing, score, evaluated_at
-- MCP code expects: agent_did, domain, standing_value, ladder_tier, last_event_at, updated_at
-- Add missing columns (don't drop existing ones to preserve data)
-- ═══════════════════════════════════════════════════════════
ALTER TABLE app.cuttlefish_stewardship_standing 
    ADD COLUMN IF NOT EXISTS domain TEXT,
    ADD COLUMN IF NOT EXISTS standing_value NUMERIC DEFAULT 50,
    ADD COLUMN IF NOT EXISTS ladder_tier TEXT DEFAULT 'provisional',
    ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Create index for the commonly queried (agent_did, domain) pair
CREATE INDEX IF NOT EXISTS idx_stewardship_standing_agent_domain 
    ON app.cuttlefish_stewardship_standing(agent_did, domain);

-- ═══════════════════════════════════════════════════════════
-- Seed rate_card with default values for known activity types
-- ═══════════════════════════════════════════════════════════
INSERT INTO app.cuttlefish_rate_card (activity_type, base_rate, min_amount, per_event_cap, quality_multiplier_default, is_active)
SELECT * FROM (VALUES
    ('VALIDATION_COMPLETED', 5.00, 0.50, 50.00, 1.0, true),
    ('GOVERNANCE_VOTE', 2.00, 0.10, 20.00, 1.0, true),
    ('CODE_REVIEW', 8.00, 1.00, 100.00, 1.5, true),
    ('DOCUMENTATION', 3.00, 0.25, 30.00, 1.0, true),
    ('SUPPORT_PROVIDED', 4.00, 0.25, 40.00, 1.0, true),
    ('SECURITY_AUDIT', 10.00, 1.00, 200.00, 2.0, true),
    ('BUG_REPORT', 5.00, 0.50, 50.00, 1.0, true),
    ('FEATURE_DELIVERY', 15.00, 1.00, 300.00, 1.5, true)
) AS v(activity_type, base_rate, min_amount, per_event_cap, quality_multiplier_default, is_active)
WHERE NOT EXISTS (SELECT 1 FROM app.cuttlefish_rate_card WHERE activity_type = v.activity_type);
