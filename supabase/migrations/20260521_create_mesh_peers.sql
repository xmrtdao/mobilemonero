-- Create mesh_peers table for agent discovery registry
-- Used by the mesh-peer-connector edge function

CREATE TABLE IF NOT EXISTS mesh_peers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  peer_id TEXT NOT NULL UNIQUE,
  endpoint TEXT,
  topics TEXT[] DEFAULT ARRAY['agent-heartbeat', 'agent-tasks', 'agent-discovery', 'fleet-broadcast'],
  capabilities TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'online' CHECK (status IN ('online', 'offline', 'away')),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast discovery queries
CREATE INDEX IF NOT EXISTS idx_mesh_peers_status ON mesh_peers(status);
CREATE INDEX IF NOT EXISTS idx_mesh_peers_last_seen ON mesh_peers(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_mesh_peers_agent_name ON mesh_peers(agent_name);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_mesh_peers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mesh_peers_updated_at ON mesh_peers;
CREATE TRIGGER trg_mesh_peers_updated_at
  BEFORE UPDATE ON mesh_peers
  FOR EACH ROW
  EXECUTE FUNCTION update_mesh_peers_updated_at();
