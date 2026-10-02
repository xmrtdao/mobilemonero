-- jobby_001_google: per-user Google Workspace connection
--
-- One Google account per Jobby client. Tokens are stored encrypted with
-- AES-256-GCM under JOBBY_TOKEN_KEY and are never returned to the browser.
--
-- This is deliberately a separate table from the suite's oauth_connections,
-- which stores refresh tokens in plaintext, requests maximal scopes, and
-- deactivates every connection globally when one account connects. None of
-- that is safe for a multi-user surface where the token authorises sending mail
-- as a real person.
--
-- Scopes requested (see relay/jobby/google.mjs SCOPES):
--   gmail.send      send applications from the candidate's own address
--   gmail.readonly  read replies so follow-up does not depend on the user
--   drive           read the candidate's existing documents; write Jobby's own
--   userinfo.email  identify the connected account
--
-- gmail.readonly and drive are RESTRICTED scopes. A public OAuth client using
-- them must pass Google's verification before real users can consent.

BEGIN;

CREATE TABLE IF NOT EXISTS app.job_google_accounts (
  id                serial PRIMARY KEY,
  client_id         integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  -- Google's stable subject id for the account.
  google_user_id    text,
  email             text NOT NULL,
  -- AES-256-GCM. Format: 12-byte IV || 16-byte auth tag || ciphertext.
  -- Never selected into a response; access goes through openToken().
  -- Both are NULL on a revoked account: a disconnected integration should not
  -- leave a usable credential sitting in the table.
  access_token_enc  bytea,
  refresh_token_enc bytea,
  scopes            text[] NOT NULL DEFAULT '{}',
  -- Google's access tokens last an hour; this drives refresh, not expiry logic.
  expires_at        timestamptz,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  last_refreshed_at timestamptz,
  -- Set on user disconnect. The row is kept so the audit trail survives;
  -- is_active is what the code checks.
  revoked_at        timestamptz,
  is_active         boolean NOT NULL DEFAULT true,
  -- Last error seen while refreshing or calling an API, for the status panel.
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One active account per client. Partial unique so a revoked row can remain.
CREATE UNIQUE INDEX IF NOT EXISTS job_google_accounts_one_active
  ON app.job_google_accounts (client_id) WHERE is_active;

-- Idempotent repair for anyone who applied an earlier version of this file
-- where refresh_token_enc was NOT NULL, which made disconnect fail.
ALTER TABLE app.job_google_accounts ALTER COLUMN refresh_token_enc DROP NOT NULL;
ALTER TABLE app.job_google_accounts ALTER COLUMN access_token_enc DROP NOT NULL;

CREATE INDEX IF NOT EXISTS job_google_accounts_client_idx
  ON app.job_google_accounts (client_id, id DESC);

-- Single-use CSRF state for the OAuth redirect. The callback consumes the row,
-- so a replayed code cannot bind a second account.
CREATE TABLE IF NOT EXISTS app.job_oauth_states (
  state       text PRIMARY KEY,
  client_id   integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  redirect_to text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

-- Housekeeping: states are worthless after ten minutes.
CREATE INDEX IF NOT EXISTS job_oauth_states_created_idx
  ON app.job_oauth_states (created_at);

-- Anything Jobby sends through the user's own Gmail, so the portal can show
-- what went out from their address as well as through Resend.
CREATE TABLE IF NOT EXISTS app.job_sent_messages (
  id          serial PRIMARY KEY,
  client_id   integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  account_id  integer REFERENCES app.job_google_accounts(id) ON DELETE SET NULL,
  channel     text NOT NULL DEFAULT 'gmail',
  to_address  text,
  subject     text,
  thread_id   text,
  message_id  text,
  status      text NOT NULL DEFAULT 'sent',
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_sent_messages_client_idx
  ON app.job_sent_messages (client_id, id DESC);

-- Replies Jobby has seen, so it does not re-read or re-reply to the same one.
CREATE TABLE IF NOT EXISTS app.job_seen_replies (
  id          serial PRIMARY KEY,
  client_id   integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  thread_id   text NOT NULL,
  message_id  text NOT NULL,
  from_address text,
  snippet     text,
  seen_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS job_seen_replies_uniq
  ON app.job_seen_replies (client_id, message_id);

COMMIT;
