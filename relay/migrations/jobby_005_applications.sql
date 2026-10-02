-- jobby-005: one row per job listing Jobby tries to apply for
--
-- Jobby applies to real jobs unattended, so it will hit walls it cannot get
-- past on its own: a CAPTCHA, a login, a question the dossier cannot answer. The
-- old behaviour was to return a blob of text to the model and move on, which
-- loses three things that all matter:
--
--   1. Which listing it was. The report said "stopped" without saying where, so
--      a person coming back later had no way to say "carry on with that one".
--   2. What it was stuck on. The exact wording of the question is the whole
--      content of the email the candidate needs to read, and it is gone by the
--      time anyone looks.
--   3. That it had already notified them. Without a record, a retried run mails
--      the same blocker again, and the second one reads like a new problem.
--
-- So a listing becomes a durable object with an id, a status, and a blocker
-- recorded against it. The candidate can come back and say "continue on 41",
-- which is the sentence the whole feature is built to make possible.
--
-- One row per (client, url), not per attempt. A listing is the unit the user
-- thinks in - "the one at Acme" - and an agent that retries, or that is run
-- twice by an impatient user, must not turn one application into five rows
-- that all say blocked. Retries bump `attempts` instead.
--
-- The unique index is what enforces that. It is also why `status` is not the
-- only key: two roles at one careers page are two applications, and a careers
-- index is a common URL to be handed for several.

BEGIN;

CREATE TABLE IF NOT EXISTS app.job_applications (
  id          serial PRIMARY KEY,
  client_id   integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  -- Set when the listing came from a researched opportunity, so the application
  -- and the research record stay linked. SET NULL rather than CASCADE: losing
  -- the opportunity must not erase the fact that an application was attempted.
  opportunity_id integer REFERENCES app.job_opportunities(id) ON DELETE SET NULL,

  url         text NOT NULL,
  company     text,
  role        text,

  -- pending  -> queued, not started
  -- running  -> dispatched to the browser right now
  -- blocked  -> stopped on something only the candidate can clear
  -- submitted-> went through. The only status that means an employer has it.
  -- failed   -> the agent itself broke; retrying is reasonable
  -- skipped  -> deliberately not pursued
  status      text NOT NULL DEFAULT 'pending',

  -- Why it stopped, in a form that can be branched on. `blocker_detail` keeps
  -- the human-readable half, which is what actually goes in the email; without
  -- a separate machine-readable kind, deciding whether a resume is worth
  -- re-offering means matching English prose.
  blocker_kind   text,
  blocker_detail text,
  -- The specific field or step, so "continue" can aim at the blockage rather
  -- than restarting the form and losing everything already typed.
  blocker_step   text,

  -- What the agent managed before it stopped. Kept so the continue task can tell
  -- it what is already done instead of filling the same fields twice.
  filled      jsonb,
  outstanding jsonb,

  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  resume_filename text,

  -- When the candidate was told about the blocker. The email is sent once per
  -- blocking, not once per retry, and this is what makes that true.
  notified_at   timestamptz,
  -- When the candidate came back and cleared it. The gap between this and
  -- notified_at is how long a wall actually cost them.
  resumed_at    timestamptz,
  submitted_at  timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Re-runnable. CREATE TABLE IF NOT EXISTS is silent when the table exists, so a
-- column added after the first run never reaches an existing database. Every
-- later migration in this directory repeats its columns for the same reason.
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS opportunity_id integer;
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS blocker_kind text;
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS blocker_detail text;
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS blocker_step text;
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS filled jsonb;
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS outstanding jsonb;
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS resume_filename text;
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS notified_at timestamptz;
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS resumed_at timestamptz;
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS company text;
ALTER TABLE app.job_applications ADD COLUMN IF NOT EXISTS role text;

COMMENT ON TABLE app.job_applications IS
  'One row per job listing Jobby has attempted an application for. A blocked row is a promise the candidate can cash: "continue on <id>" resumes the live form rather than starting the listing over.';

COMMENT ON COLUMN app.job_applications.blocker_kind IS
  'Machine-readable blocker: unanswerable_question | login | captcha | browser_unavailable | file_upload | unknown. NULL when not blocked.';
COMMENT ON COLUMN app.job_applications.notified_at IS
  'Set once the candidate has been emailed about this blocker. Guards against mailing the same wall again on every retry.';
COMMENT ON COLUMN app.job_applications.attempts IS
  'How many times the browser has been dispatched for this listing. A retry bumps it; it never creates a second row.';

-- One application per listing per person.
--
-- ON CONFLICT is what makes startAttempt an upsert, so a repeated apply - the
-- agent retrying, the user asking twice, the portal being reloaded mid-run -
-- updates the row that already exists instead of scattering duplicates that all
-- claim to be the same blocked application.
DROP INDEX IF EXISTS app.job_applications_one_per_listing;
CREATE UNIQUE INDEX IF NOT EXISTS job_applications_one_per_listing
  ON app.job_applications (client_id, LOWER(url));

-- The dashboard lists a person's applications newest first, and filters by
-- status. Without this that is a sort over the whole table.
CREATE INDEX IF NOT EXISTS job_applications_client_recent
  ON app.job_applications (client_id, updated_at DESC);

-- "Which ones are stuck" is the query the site opens with, and the one that
-- decides whether the candidate needs to be emailed at all.
CREATE INDEX IF NOT EXISTS job_applications_client_blocked
  ON app.job_applications (client_id, status)
  WHERE status = 'blocked';

-- Roll the opportunity id into the listing when Jobby applied to something that
-- was already researched, so the research row's status can follow the
-- application rather than the other way round.
CREATE INDEX IF NOT EXISTS job_applications_opportunity
  ON app.job_applications (opportunity_id)
  WHERE opportunity_id IS NOT NULL;

COMMIT;
