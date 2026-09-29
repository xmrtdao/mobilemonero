-- jobby-001: first-class job-search agent
--
-- Multi-user from the start. Each job seeker is a job_clients row keyed by an
-- opaque session cookie rather than an account, so the second person needs no
-- migration — but nothing is hard-coded to a single client anywhere.
--
-- Every dossier mutation is recorded in job_dossier_edits. That table is the
-- point: Jobby edits a candidate's professional identity on the user's
-- confirmed word, and "what did the AI change about my profile and when" has to
-- be answerable without trusting anyone's memory.
--
-- job_outreach is the same idea for outbound mail. Jobby sends autonomously,
-- so the send log is the only durable record of what went out under this
-- person's name.

BEGIN;

-- ── Clients ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app.job_clients (
  id              serial PRIMARY KEY,
  session_key     text NOT NULL UNIQUE,
  display_name    text,
  email           text,
  phone           text,
  location        text,
  -- 1 contract consulting, 2 temporary/contract, 3 full-time, 4 ATS automation
  tracks          integer[] NOT NULL DEFAULT '{3,4}',
  -- why each track is on: {"3": "primary target is full-time employment"}
  track_reasons   jsonb NOT NULL DEFAULT '{}'::jsonb,
  daily_send_cap  integer NOT NULL DEFAULT 15,
  -- seeking (no income) -> placed (income secured) -> advancing (keep growing)
  mission_state   text NOT NULL DEFAULT 'seeking',
  -- 'auto' lets Jobby send without approval; 'draft' stages for review
  autonomy        text NOT NULL DEFAULT 'auto',
  -- Emergency stop. Checked before every outbound send.
  kill_switch     boolean NOT NULL DEFAULT false,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Dossier (current state + provenance) ───────────────────────────────
CREATE TABLE IF NOT EXISTS app.job_dossiers (
  id              serial PRIMARY KEY,
  client_id       integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  dossier         jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision        integer NOT NULL DEFAULT 1,
  updated_by      text NOT NULL DEFAULT 'resume-parse',
  source_filename text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS job_dossiers_client_uniq
  ON app.job_dossiers (client_id);

-- Append-only audit of every add / change / delete to the dossier.
CREATE TABLE IF NOT EXISTS app.job_dossier_edits (
  id                serial PRIMARY KEY,
  client_id         integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  revision          integer NOT NULL,
  -- set | add | update | delete
  op                text NOT NULL,
  -- dotted path into the dossier, e.g. 'skills' or 'employment[0].title'
  path              text NOT NULL,
  before_value      jsonb,
  after_value       jsonb,
  reason            text,
  -- 'user' | 'resume-parse' | 'jobby'
  actor             text NOT NULL DEFAULT 'jobby',
  -- The user stated or confirmed this. Jobby must never self-authorise a
  -- change to someone's professional identity.
  confirmed_by_user boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_dossier_edits_client_idx
  ON app.job_dossier_edits (client_id, id DESC);

-- ── The plan ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app.job_actions (
  id           serial PRIMARY KEY,
  client_id    integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  track        integer,
  title        text NOT NULL,
  detail       text,
  -- pending | active | done | skipped | blocked
  status       text NOT NULL DEFAULT 'pending',
  priority     integer NOT NULL DEFAULT 3,
  due_at       timestamptz,
  result       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_actions_client_status_idx
  ON app.job_actions (client_id, status, priority, id);

-- ── Opportunities being pursued ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app.job_opportunities (
  id             serial PRIMARY KEY,
  client_id      integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  action_id      integer REFERENCES app.job_actions(id) ON DELETE SET NULL,
  company        text,
  role           text NOT NULL,
  url            text,
  source         text,
  track          integer,
  -- new | researched | applied | interviewing | offered | rejected | withdrawn
  status         text NOT NULL DEFAULT 'new',
  -- 0-100 match against the dossier. Never a claim about the candidate.
  match_score    integer,
  match_notes    text,
  -- Which dossier fields the application leaned on, for audit.
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_opportunities_client_status_idx
  ON app.job_opportunities (client_id, status);

-- ── Outbound log ───────────────────────────────────────────────────────
-- The only durable record of what was sent under this person's name.
CREATE TABLE IF NOT EXISTS app.job_outreach (
  id             serial PRIMARY KEY,
  client_id      integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  opportunity_id integer REFERENCES app.job_opportunities(id) ON DELETE SET NULL,
  action_id      integer REFERENCES app.job_actions(id) ON DELETE SET NULL,
  -- email | ats | linkedin | referral
  channel        text NOT NULL DEFAULT 'email',
  recipient      text,
  subject        text,
  body           text,
  -- queued | sent | failed | opened | bounced
  status         text NOT NULL DEFAULT 'queued',
  provider_id    text,
  error          text,
  -- Approved by a human before sending, if it was.
  approved_by    text,
  sent_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_outreach_client_created_idx
  ON app.job_outreach (client_id, created_at DESC);
-- Supports the daily cap check without scanning a client's whole history.
CREATE INDEX IF NOT EXISTS job_outreach_cap_idx
  ON app.job_outreach (client_id, status, created_at DESC)
  WHERE status = 'sent';

-- ── Chat ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app.job_chat_messages (
  id         serial PRIMARY KEY,
  client_id  integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,
  role       text NOT NULL,          -- user | jobby | system
  content    text NOT NULL,
  -- Tool calls Jobby made while producing this reply, for the sticky-note
  -- display and for auditing what it actually did.
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_chat_client_idx
  ON app.job_chat_messages (client_id, id);

-- ── Register jobby-001 as a first-class agent ──────────────────────────
-- app.agents is the suite-facing roster; app.cuttlefish_agents is the
-- TrustGraph registry that trust scoring reads.
INSERT INTO app.agents
  (id, owner_id, name, description, locale, skills, role, status, current_workload, max_concurrent_tasks, updated_at)
VALUES
  ('jobby-001', '00000000-0000-0000-0000-000000000000', 'Jobby McJobberson',
   'Job-search agent. Builds a dossier from a resume, decides tracks, and works the search until income is secured.',
   'es-CR',
   '["job-search","dossier","outreach","ats","resume","planning","negotiation"]'::jsonb,
   'Career Agent / Negotiator', 'IDLE', 0, 5, now())
ON CONFLICT (id) DO UPDATE SET
  name        = EXCLUDED.name,
  description = EXCLUDED.description,
  skills      = EXCLUDED.skills,
  role        = EXCLUDED.role,
  updated_at  = now();

INSERT INTO app.cuttlefish_agents
  (did, name, role, agent_type, agent_subtype, status, trust_score, trust_band,
   cac_tier, ial, stewardship_ladder, description, metadata, created_at, updated_at)
VALUES
  ('did:xmrt:jobby', 'jobby', 'Career Agent & Negotiator', 'relay', 'advisor', 'active',
   90, 'Trusted', 'studio', 'IAL2', 'Builder Steward',
   'Runs a job search end to end: dossier, tracks, outreach, negotiation.',
   '{"tools":"broad-no-shell","autonomy":"capped-auto-send","portal":"jobby.mobilemonero.com"}'::jsonb,
   now(), now())
ON CONFLICT (did) DO UPDATE SET
  name        = EXCLUDED.name,
  role        = EXCLUDED.role,
  description = EXCLUDED.description,
  metadata    = EXCLUDED.metadata,
  status      = 'active',
  updated_at  = now();

INSERT INTO app.cuttlefish_trust_events (agent_did, event_type, delta, score_after, note, created_at)
VALUES
  ('did:xmrt:jobby', 'registration', 0, 90, 'Registered as first-class career agent (jobby-001)', now());

COMMIT;
