CREATE TABLE IF NOT EXISTS app.inbox_emails (
  id SERIAL PRIMARY KEY,
  email_id TEXT UNIQUE,
  sender TEXT,
  recipient TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  read BOOLEAN DEFAULT FALSE,
  domain TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);
