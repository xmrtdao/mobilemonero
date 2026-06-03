-- Zero-Claw Encrypted Chat Rooms Table
-- Stores room credentials and participant information

CREATE TABLE IF NOT EXISTS zero_claw_rooms (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    room_id TEXT UNIQUE NOT NULL,
    room_name TEXT NOT NULL,
    room_password TEXT NOT NULL,
    attorney_email TEXT NOT NULL,
    client_email TEXT NOT NULL,
    participants TEXT[] NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
    message_count INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}'
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_zero_claw_rooms_room_id ON zero_claw_rooms(room_id);
CREATE INDEX IF NOT EXISTS idx_zero_claw_rooms_attorney_email ON zero_claw_rooms(attorney_email);
CREATE INDEX IF NOT EXISTS idx_zero_claw_rooms_client_email ON zero_claw_rooms(client_email);
CREATE INDEX IF NOT EXISTS idx_zero_claw_rooms_status ON zero_claw_rooms(status);
CREATE INDEX IF NOT EXISTS idx_zero_claw_rooms_created_at ON zero_claw_rooms(created_at DESC);

-- Row Level Security (RLS)
ALTER TABLE zero_claw_rooms ENABLE ROW LEVEL SECURITY;

-- Policy: Allow service role to do anything (for edge functions)
CREATE POLICY "Service role can do anything" ON zero_claw_rooms
    FOR ALL
    USING (auth.jwt() ->> 'role' = 'service_role')
    WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

-- Policy: Allow authenticated users to read their own rooms
CREATE POLICY "Users can view their rooms" ON zero_claw_rooms
    FOR SELECT
    USING (
        auth.jwt() ->> 'email' = attorney_email 
        OR auth.jwt() ->> 'email' = client_email
        OR auth.jwt() ->> 'email' = ANY(participants)
    );

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
DROP TRIGGER IF EXISTS update_zero_claw_rooms_updated_at ON zero_claw_rooms;
CREATE TRIGGER update_zero_claw_rooms_updated_at
    BEFORE UPDATE ON zero_claw_rooms
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Grant permissions
GRANT ALL ON zero_claw_rooms TO service_role;
GRANT SELECT ON zero_claw_rooms TO authenticated;

COMMENT ON TABLE zero_claw_rooms IS 'Zero-Claw encrypted chat rooms with attorney-client privilege';
COMMENT ON COLUMN zero_claw_rooms.room_id IS 'Unique room identifier (zero-claw-xxx-xxx)';
COMMENT ON COLUMN zero_claw_rooms.room_password IS 'SRP-6a authentication password';
COMMENT ON COLUMN zero_claw_rooms.participants IS 'Array of all participant email addresses';
COMMENT ON COLUMN zero_claw_rooms.status IS 'Room status: active, archived, or deleted';
