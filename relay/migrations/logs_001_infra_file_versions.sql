-- logs_001_infra_file_versions.sql
--
-- WHICH VERSION OF THE CODE THREW?
--
-- The Activity Log knows that a request failed. It does not know whether the
-- code that failed is the code you are looking at now. relay/server.js is
-- ~940KB and gets refactored; suite/supabase/functions/ai-chat/index.ts is
-- ~315KB and gets refactored more often than anything else in the stack. When
-- an error fires at 14:02 and you open the file at 14:20, the lines you are
-- reading may be the ones that caused it, or may have been rewritten twice
-- since. There was no way to tell the difference.
--
-- This table is the record that makes the difference possible. One row per
-- distinct version of a key file, written the moment the content changes.
-- "The version in effect at time T" is then the newest row captured at or
-- before T - an exact answer, not a guess.
--
-- The relay creates the table itself if it is missing (see
-- relay/lib/infra-files.mjs, ensureVersionTable) for the same reason it
-- creates app.inbox_emails at runtime: a migration that never ran must not
-- take the feature down with it. This file is the documented version of the
-- same schema.

CREATE TABLE IF NOT EXISTS app.infra_file_versions (
  id          BIGSERIAL PRIMARY KEY,
  path        TEXT NOT NULL,
  version     TEXT NOT NULL,          -- content fingerprint (sha256 prefix)
  lines       INTEGER,
  bytes       BIGINT,
  git_sha     TEXT,
  git_subject TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The lookup is always "the newest version of this path at or before a
-- moment", so the index is on (path, captured_at DESC).
CREATE INDEX IF NOT EXISTS idx_infra_file_versions_path
  ON app.infra_file_versions(path, captured_at DESC);
