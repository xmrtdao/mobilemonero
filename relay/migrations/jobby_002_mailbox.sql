-- jobby-002: a per-candidate sending address
--
-- Until now Jobby sent job applications as the agent, and the code said so:
-- "sends as the agent, not as the candidate", with the consequence that the
-- candidate's replies landed in the agent's inbox rather than theirs. That is
-- the blocker on outreach this removes.
--
-- Two reasons this is a stored column rather than a derived value:
--
--  1. It is an identity, not a computation. A candidate's address must not
--     change because they corrected a typo in their name mid-search, or because
--     someone else joined with a similar one. The address they have already sent
--     applications from has to keep receiving replies.
--
--  2. Uniqueness can only be enforced by the database. Two people called Maria
--     Garcia both derive "maria.garcia"; this index is what makes the second one
--     fail rather than silently take the first one's mail.
--
-- The partial unique index ignores NULLs, so existing rows are untouched and
-- adoption is gradual: a client is given an address when its name is first known,
-- not when this runs.
--
-- Note on job_seen_replies: it already carries client_id and from_address, so
-- nothing is added there. An earlier draft of this file tried to and would have
-- failed on a duplicate column.

BEGIN;

ALTER TABLE app.job_clients
  ADD COLUMN IF NOT EXISTS mailbox text;

COMMENT ON COLUMN app.job_clients.mailbox IS
  'The address this candidate sends from and receives on, on jobbymcjobberson.com. Derived once from the name, then held: changing it would strand replies already sent to it.';

-- Unique, case-insensitively. A plain UNIQUE constraint would let "Joe.Lee" and
-- "joe.lee" both exist, and the second would never receive the first's mail.
CREATE UNIQUE INDEX IF NOT EXISTS job_clients_mailbox_uniq
  ON app.job_clients (lower(mailbox))
  WHERE mailbox IS NOT NULL;

-- Every inbound reply arrives addressed to this local part and is resolved to a
-- candidate on arrival, so this is looked up on every inbound message.
CREATE INDEX IF NOT EXISTS job_clients_mailbox_lookup
  ON app.job_clients (lower(mailbox));

-- The From a message actually went out as. Without it a reply cannot be tied to
-- the send that caused it, because the webhook sees only a recipient address.
ALTER TABLE app.job_outreach
  ADD COLUMN IF NOT EXISTS from_address text;

COMMENT ON COLUMN app.job_outreach.from_address IS
  'The From address this was sent as, so a later reply can be tied to this send even if the candidate is renamed.';

COMMIT;
