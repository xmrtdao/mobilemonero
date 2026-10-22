-- tasks_019_task_escalations.sql
--
-- WHEN A TASK NEEDS A HUMAN, SOMEONE SHOULD BE TOLD.
--
-- The executor parks work in REVIEW when it cannot finish on its own. Nothing
-- told anybody: a task has sat in REVIEW for five days with a reason that
-- nothing writes ("checklist_complete_awaiting_confirmation"), waiting for a
-- person who was never told there was anything to wait for.
--
-- So an escalation is a record with a sender, a recipient, a question, and
-- whether it has been answered. One open escalation per task, because the
-- rule is "tell them once", not "tell them every cycle until they answer" -
-- and a task that emails its owner every ten minutes is a task nobody reads.
--
-- The recipient is never guessed. It is either a human this system already
-- knows how to reach - a profile, a contact, a proved address - or the
-- founder, who is the default for everything. An agent that wants to reach
-- somebody else and does not have an address asks the client.

CREATE TABLE IF NOT EXISTS app.task_escalations (
  id            bigserial PRIMARY KEY,
  task_id       text NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
  reason        text NOT NULL,
  question      text,
  -- The token that comes back in the reply. A reply keeps the subject, so the
  -- answer can be matched to the question it is answering without anybody
  -- having to remember which of forty emails it was.
  reply_token   text UNIQUE,
  -- who it went to, and how we know them
  to_address    text,
  to_user_id    uuid,
  to_source     text,          -- profile | contact | founder | explicit
  from_address  text NOT NULL,
  subject       text,
  body          text,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  answered_at   timestamptz,
  answered_text text,
  still_open    boolean NOT NULL DEFAULT true,
  -- An escalation without a question is a complaint, not a question.
  CONSTRAINT task_escalations_question_needed
    CHECK (question IS NOT NULL AND length(btrim(question)) > 0)
);

-- One open escalation per task: the point is to be told once.
CREATE UNIQUE INDEX IF NOT EXISTS task_escalations_one_open_idx
  ON app.task_escalations (task_id) WHERE still_open;

CREATE INDEX IF NOT EXISTS task_escalations_task_idx
  ON app.task_escalations (task_id, sent_at DESC);

-- The token, for sessions whose table predates it.
ALTER TABLE app.task_escalations
  ADD COLUMN IF NOT EXISTS reply_token text;
CREATE UNIQUE INDEX IF NOT EXISTS task_escalations_reply_token_idx
  ON app.task_escalations (reply_token) WHERE reply_token IS NOT NULL;

-- ── Who a person is, by the address they came from ───────────────────────────
--
-- This is a CONNECTION, not a merge. An address is the weakest identity
-- signal there is - two people behind one office or campus NAT share it - and
-- the rule this project already follows is that such a signal is reported as
-- context and never used to join two people's records into one.
--
-- So it is a table of suggestions, one row per address, pointing at the
-- profile that was last seen using it. It exists so that a task can work out
-- WHO to ask, and it is never used to decide that two records are the same
-- person.
CREATE TABLE IF NOT EXISTS app.user_address_book (
  id          bigserial PRIMARY KEY,
  ip_address  inet NOT NULL,
  -- The profile this address belongs to. Deliberately NOT a foreign key: the
  -- suite's profile table is a view in this database and is not where the
  -- identities live, and a column that cannot point at a real row is a
  -- constraint that will be broken the first time somebody signs up.
  user_id     uuid,
  email       text,             -- the address the profile was known by
  seen_count  integer NOT NULL DEFAULT 1,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  -- Nothing is merged here; the row records what was seen, and who it was
  -- attributed to at the time.
  note        text
);

CREATE UNIQUE INDEX IF NOT EXISTS user_address_book_ip_idx
  ON app.user_address_book (ip_address);

CREATE INDEX IF NOT EXISTS user_address_book_user_idx
  ON app.user_address_book (user_id);
