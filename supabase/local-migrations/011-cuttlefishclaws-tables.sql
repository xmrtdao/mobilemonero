-- CuttlefishClaws tables for the Tributary AI Campus multi-agent system.
-- Mirrors the schema used by the 10 Netlify functions (agent-onboard, agent-chat,
-- trust-score, cac-status, proposal-submit, capital-stack, financing-programs,
-- agent-x-post, chat, inquiry) but lives in the app schema.
-- All CREATE TABLEs are IF NOT EXISTS for idempotent re-runs.

-- Agents (agent profiles with trust scores and CAC membership)
CREATE TABLE IF NOT EXISTS app.cuttlefish_agents (
    id SERIAL PRIMARY KEY,
    did TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    agent_type TEXT NOT NULL DEFAULT 'constitutional',
    agent_subtype TEXT,
    status TEXT DEFAULT 'active',
    version TEXT,
    trust_score NUMERIC DEFAULT 50,
    trust_score_updated_at TIMESTAMPTZ,
    cac_id TEXT,
    color TEXT,
    description TEXT,
    greeting TEXT,
    responses TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- CAC credentials (membership tiers: explorer, developer, studio, enterprise)
CREATE TABLE IF NOT EXISTS app.cuttlefish_cac_credentials (
    id SERIAL PRIMARY KEY,
    agent_did TEXT NOT NULL REFERENCES app.cuttlefish_agents(did),
    tier TEXT NOT NULL DEFAULT 'explorer',
    usdc_prepaid NUMERIC DEFAULT 0,
    token_balance NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'pending',
    issued_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trust events (score change audit log)
CREATE TABLE IF NOT EXISTS app.cuttlefish_trust_events (
    id SERIAL PRIMARY KEY,
    agent_did TEXT NOT NULL,
    event_type TEXT NOT NULL,
    delta NUMERIC DEFAULT 0,
    score_after NUMERIC,
    reference TEXT,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent tasks (task queue for agent orchestration)
CREATE TABLE IF NOT EXISTS app.cuttlefish_agent_tasks (
    id SERIAL PRIMARY KEY,
    task_type TEXT NOT NULL,
    assigned_to TEXT NOT NULL,
    payload JSONB DEFAULT '{}',
    priority INTEGER DEFAULT 5,
    status TEXT DEFAULT 'pending',
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Proposals (governance proposals with versioning)
CREATE TABLE IF NOT EXISTS app.cuttlefish_proposals (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'general',
    submitter_did TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    parent_id INTEGER,
    status TEXT DEFAULT 'submitted',
    ipfs_cid TEXT,
    chain_anchor_tx TEXT,
    combined_hash TEXT,
    routed_to TEXT[],
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Capital stack (investment layers for the Tributary campus)
CREATE TABLE IF NOT EXISTS app.cuttlefish_capital_stack (
    layer_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sub_label TEXT,
    amount_m NUMERIC DEFAULT 0,
    pct_of_total NUMERIC DEFAULT 0,
    color TEXT,
    seniority INTEGER DEFAULT 0,
    yield_score NUMERIC DEFAULT 0,
    coverage NUMERIC DEFAULT 0,
    description TEXT,
    details TEXT,
    display_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    is_open INTEGER DEFAULT 0
);

-- Financing programs (SBA, C-PACE, etc.)
CREATE TABLE IF NOT EXISTS app.cuttlefish_financing_programs (
    program_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    administering_entity TEXT,
    applies_to TEXT[],
    headline TEXT,
    amount_range TEXT,
    rate_or_credit TEXT,
    term_years TEXT,
    eligibility TEXT,
    application_url TEXT,
    contact TEXT,
    notes TEXT,
    display_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
);

-- Contracts (smart contracts registry)
CREATE TABLE IF NOT EXISTS app.cuttlefish_contracts (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT,
    description TEXT,
    status TEXT DEFAULT 'built',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scenarios (investment return scenarios)
CREATE TABLE IF NOT EXISTS app.cuttlefish_scenarios (
    id SERIAL PRIMARY KEY,
    tier TEXT NOT NULL,
    name TEXT NOT NULL,
    subtitle TEXT,
    multiple TEXT,
    multiple_color TEXT,
    featured INTEGER DEFAULT 0,
    metrics JSONB DEFAULT '[]',
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat messages (conversation history for agent chat)
CREATE TABLE IF NOT EXISTS app.cuttlefish_chat_messages (
    id SERIAL PRIMARY KEY,
    agent_id TEXT NOT NULL,
    conversation_id TEXT,
    user_message TEXT NOT NULL,
    agent_response TEXT,
    simulated INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_cuttlefish_agents_did ON app.cuttlefish_agents(did);
CREATE INDEX IF NOT EXISTS idx_cuttlefish_agents_status ON app.cuttlefish_agents(status);
CREATE INDEX IF NOT EXISTS idx_cuttlefish_cac_agent_did ON app.cuttlefish_cac_credentials(agent_did);
CREATE INDEX IF NOT EXISTS idx_cuttlefish_trust_events_agent ON app.cuttlefish_trust_events(agent_did);
CREATE INDEX IF NOT EXISTS idx_cuttlefish_trust_events_created ON app.cuttlefish_trust_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cuttlefish_tasks_assigned ON app.cuttlefish_agent_tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_cuttlefish_proposals_submitter ON app.cuttlefish_proposals(submitter_did);
CREATE INDEX IF NOT EXISTS idx_cuttlefish_proposals_status ON app.cuttlefish_proposals(status);
CREATE INDEX IF NOT EXISTS idx_cuttlefish_chat_agent ON app.cuttlefish_chat_messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_cuttlefish_chat_conversation ON app.cuttlefish_chat_messages(conversation_id);
