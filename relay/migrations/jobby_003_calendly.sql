-- jobby-003: a candidate's own Calendly account
--
-- The reason this exists: a recruiter asks for a call, and the candidate has to
-- negotiate times in a chat thread. Connecting their own Calendly turns that into
-- a link. It is also the one place a job search touches a third party that the
-- candidate already pays for and already trusts.
--
-- Mirrors job_google_accounts deliberately, because it is the same shape of
-- problem - one connected account per client, tokens sealed at rest, a revoked
-- row kept for the audit trail - and two near-identical implementations of that
-- would drift the way the hand-maintained service list did.
--
-- Two Calendly-specific facts shape this file:
--
--  1. PKCE is required. The authorization code is bound to a challenge derived
--     from a verifier, so the verifier has to survive the redirect. job_oauth_states
--     gains a column for it, and that column is provider-neutral - any future
--     OAuth provider that wants PKCE uses the same one.
--
--  2. Refresh tokens are single-use and rotate. Every successful token exchange
--     returns a new refresh token and revokes the old one; reusing a spent token
--     fails with invalid_grant. There is deliberately no "last_used" bookkeeping
--     that could tempt a retry, because a retry with a spent token is exactly what
--     invalidates the account. The application layer must overwrite the stored
--     refresh token on every successful exchange.
--
--     Calendly's enforcement deadline for this was 2026-08-31, which has passed,
--     so this is current behaviour rather than a future migration.

BEGIN;

-- ── PKCE verifier, for any provider that requires it ───────────────────────
ALTER TABLE app.job_oauth_states
  ADD COLUMN IF NOT EXISTS code_verifier text;

COMMENT ON COLUMN app.job_oauth_states.code_verifier IS
  'PKCE verifier for the in-flight authorization. Consumed with the state row, so it does not outlive the code it protects.';

-- ── Connected Calendly accounts ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app.job_calendly_accounts (
  id                serial PRIMARY KEY,
  client_id         integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  -- Calendly's stable user URI, e.g. https://api.calendly.com/users/ABC123.
  calendly_user_uri text NOT NULL,
  -- The scheduling_url off the user record, which is what actually gets sent to
  -- a recruiter. Stored rather than derived, because it is the whole point of the
  -- connection and re-deriving it means another API call on every send.
  scheduling_url    text,
  timezone          text,
  email             text,
  -- AES-256-GCM, 12-byte IV || 16-byte tag || ciphertext. Never selected into a
  -- response; access goes through openToken(). Both are NULL on a revoked account,
  -- so disconnecting leaves no usable credential behind.
  access_token_enc  bytea,
  -- Rotated on every exchange. See the note at the top of this file: the most
  -- recently stored value is the only usable one.
  refresh_token_enc bytea,
  scopes            text[] NOT NULL DEFAULT '{}',
  expires_at        timestamptz,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  last_refreshed_at timestamptz,
  revoked_at        timestamptz,
  is_active         boolean NOT NULL DEFAULT true,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One active account per client, so there is never a question of which
-- scheduling link to send. A partial unique so a revoked row can remain.
CREATE UNIQUE INDEX IF NOT EXISTS job_calendly_accounts_one_active
  ON app.job_calendly_accounts (client_id) WHERE is_active;

CREATE INDEX IF NOT EXISTS job_calendly_accounts_client_idx
  ON app.job_calendly_accounts (client_id, id DESC);

-- ── A disconnect that failed to clear its tokens ────────────────────────────
-- An earlier shape of this table could leave a usable credential on a revoked
-- row, which is the worst outcome available: the integration looks disconnected
-- and the token still works. Repaired idempotently, and the constraint stops it
-- recurring.
UPDATE app.job_calendly_accounts
   SET access_token_enc = NULL, refresh_token_enc = NULL
 WHERE revoked_at IS NOT NULL
   AND (access_token_enc IS NOT NULL OR refresh_token_enc IS NOT NULL);

ALTER TABLE app.job_calendly_accounts
  DROP CONSTRAINT IF EXISTS job_calendly_revoked_has_no_token;
ALTER TABLE app.job_calendly_accounts
  ADD CONSTRAINT job_calendly_revoked_has_no_token
  CHECK (revoked_at IS NULL OR (access_token_enc IS NULL AND refresh_token_enc IS NULL));

COMMIT;
