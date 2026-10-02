-- jobby-004: proving an email address, so one person is one person
--
-- The client table is keyed on a browser session. That makes a session, rather
-- than a person, the unit of identity: the same human on a laptop and a phone is
-- two records, and everything keyed to client_id - opportunities, outreach, chat,
-- the dossier - splits between them. One resume uploaded repeatedly produced
-- twenty-one client records for one human.
--
-- Keying on IP address instead is not an option. Carrier-grade NAT puts thousands
-- of phones behind one public address, so two job seekers in one city would share
-- an identity and their histories would be merged; mobile addresses also rotate
-- mid-session, and every device behind one router shares an address.
--
-- So the address is claimed and proved. A code goes to an inbox only its owner can
-- read, and the address is recorded on the client only once the code comes back.
--
-- Two properties this buys, and both are load-bearing:
--
--   1. An unproven address merges with nothing. Client reconciliation keys on a
--      CLAIMED address, not a typed one, so a mistyped or guessed email cannot pull
--      another person's record into this one. That is what closes the NAT hole.
--   2. Verification is per-address, not per-session. Verifying once on a laptop
--      verifies the phone, which is the entire point.

BEGIN;

-- The proved address, on the client it belongs to.
ALTER TABLE app.job_clients ADD COLUMN IF NOT EXISTS claimed_email text;
ALTER TABLE app.job_clients ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

COMMENT ON COLUMN app.job_clients.claimed_email IS
  'An email address the candidate proved by receiving a code at it. NULL means unproven, and an unproven address must never be used to match one client to another.';

-- Outstanding and spent claim codes.
--
-- The code itself is never stored. Only a peppered hash is, so a database dump
-- does not hand over live codes: without JOBBY_TOKEN_KEY a captured hash is still a
-- million guesses from the six digits it stands for.
CREATE TABLE IF NOT EXISTS app.job_claim_codes (
  id          serial PRIMARY KEY,
  client_id   integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  email       text NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  -- Wrong guesses so far. Three and the code is spent, which is what stops an
  -- unlimited-attempt endpoint from being a free oracle.
  attempts    integer NOT NULL DEFAULT 0,
  verified_at timestamptz,
  -- Set when the candidate asks for a replacement. The row is kept rather than
  -- deleted so the request history survives, which is what the hourly rate limit
  -- and any later abuse review are read from.
  superseded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Re-runnable. CREATE TABLE IF NOT EXISTS silently does nothing when the table is
-- already there, so a column added to the definition above never reaches an
-- existing database - which is how superseded_at went missing on the first re-run
-- and the migration failed on a table it had itself created minutes earlier.
ALTER TABLE app.job_claim_codes ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
ALTER TABLE app.job_claim_codes ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE app.job_claim_codes ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- One live code per client per address. Requesting a new one supersedes the old,
-- so an attacker cannot keep guessing a code the candidate has already replaced.
--
-- The predicate names both verified_at and superseded_at, not verified_at alone.
-- Expiring a superseded code does NOT satisfy a `verified_at IS NULL` index: the
-- row is still unverified, so the next insert for the same client and address
-- collides and the request fails outright. Marking the row is what actually
-- releases the slot, and it keeps the row for the audit.
DROP INDEX IF EXISTS app.job_claim_codes_one_live;
CREATE UNIQUE INDEX IF NOT EXISTS job_claim_codes_one_live
  ON app.job_claim_codes (client_id, LOWER(email))
  WHERE verified_at IS NULL AND superseded_at IS NULL;

-- The hourly request limit is enforced by counting, and this is the index that
-- makes counting cheap.
CREATE INDEX IF NOT EXISTS job_claim_codes_recent
  ON app.job_claim_codes (client_id, created_at DESC);

-- Reconciliation matches on the claimed address, so this is the index that keeps
-- "is anyone else this person" a lookup rather than a scan. Partial, because
-- unclaimed rows - the overwhelming majority, since almost nobody has verified -
-- have no reason to be in it at all.
CREATE INDEX IF NOT EXISTS job_clients_claimed_email
  ON app.job_clients (LOWER(claimed_email))
  WHERE claimed_email IS NOT NULL;

-- An address may be claimed by exactly one client. Without this, the same person
-- verifying from two devices before either has synced would create the very
-- duplicate this feature exists to remove.
CREATE UNIQUE INDEX IF NOT EXISTS job_clients_claimed_email_unique
  ON app.job_clients (LOWER(claimed_email))
  WHERE claimed_email IS NOT NULL;

COMMIT;
