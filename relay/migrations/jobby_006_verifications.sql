-- jobby-006: independent verification of dossier claims
--
-- The idea is a good one and it is worth doing properly: a claim the candidate
-- made, checked against something outside their control, is worth more to a
-- recruiter than the same claim asserted. That is what a verified badge means on
-- any professional network, and it is genuinely more useful than another
-- paragraph of self-description.
--
-- The risk is that the badge itself becomes the false statement.
--
-- A mark reading "verified" is a claim ABOUT the verification, not about the
-- candidate. It tells an employer that something outside Jobby's and the
-- candidate's control was checked and agreed. If that mark is ever placed next
-- to something the candidate simply asserted, Jobby has not verified anything -
-- it has laundered a self-claim through a third-party name, which is a worse
-- failure than leaving the claim unverified, because it looks checked.
--
-- So the verdicts are four, not two, and exactly one earns a mark:
--
--   verified     an independent source was checked and agrees. Mark shown.
--   corroborated sources agree, but none of them is independent of the
--                candidate. No mark - it is a second unverified claim.
--   disputed     sources conflict with each other or with the claim. No mark,
--                and the item is flagged rather than quietly left alone.
--   unverifiable nothing was found either way. No mark.
--
-- `source_independent` is the load-bearing column and it is deliberately
-- pessimistic. A source the candidate can edit - their own site, their own
-- LinkedIn, their own repository, a wiki page they wrote - proves nothing about
-- their own claim, and is recorded as independent=false so it can never
-- produce a mark on its own. It can corroborate; it can never verify.
--
-- `evidence` stores what was actually compared, so the check can be audited and
-- re-run. A verification that cannot show its work is indistinguishable from a
-- guess, and an employer relying on it deserves better than that.
--
-- `path` is a pointer into the dossier - "achievements[3]", "employment[2].end"
-- - so a claim and its verdict stay attached when the dossier is edited. A
-- verdict about a claim that has since been rewritten is worse than no verdict,
-- so `claim` is stored alongside it and the two are compared on read.

BEGIN;

CREATE TABLE IF NOT EXISTS app.job_claim_verifications (
  id          serial PRIMARY KEY,
  client_id   integer NOT NULL REFERENCES app.job_clients(id) ON DELETE CASCADE,

  -- Where in the dossier this is about. Kept as text, not a foreign key: the
  -- dossier is one jsonb document and there is nothing to point at.
  path        text NOT NULL,
  -- The claim exactly as it stood when it was checked. Stored so a later edit
  -- to the dossier can be detected - a verdict must not silently outlive the
  -- text it was about.
  claim       text NOT NULL,
  -- A hash of the claim, so the staleness check is a comparison rather than a
  -- fuzzy string match that would drift.
  claim_hash  text NOT NULL,

  -- verified | corroborated | disputed | unverifiable
  verdict     text NOT NULL,
  CONSTRAINT verdict_is_known CHECK (verdict IN ('verified','corroborated','disputed','unverifiable')),

  -- Only 'verified' may produce a mark, and a mark REQUIRES an independent
  -- source. Both directions are constrained, not just the first.
  --
  -- The first constraint alone was in the first version of this migration, with
  -- a comment claiming the badge rule was enforced here as well as in code. It
  -- was not: a row with verdict='verified' and source_independent=false was
  -- accepted, which is precisely the row that would put a medal on a self-claim.
  -- The code refused it, but a comment is not a constraint, and the next caller
  -- would not have read the code.
  --
  -- The second is the mirror: if an independent source was genuinely used, the
  -- verdict cannot be anything weaker. Recording a real independent check as
  -- "unverifiable" would hide a verification the candidate paid nothing for.
  CONSTRAINT verified_needs_independent CHECK (verdict <> 'verified' OR source_independent),
  CONSTRAINT independent_is_verified CHECK (NOT source_independent OR verdict = 'verified'),

  -- How the check was made, in words a person can audit: "looked the photograph
  -- up on Wikimedia Commons and compared the author field and the EXIF timestamp".
  method      text,
  -- Whether the evidence came from outside the candidate's control. The single
  -- most important field in this table.
  source_independent boolean NOT NULL DEFAULT false,
  source_name text,
  source_url  text,
  -- What was compared and what came back. jsonb: {asserted, found, matched}.
  evidence    jsonb,

  -- A check has a shelf life. A photo credit does not expire, but a role at a
  -- company that has since been sold does, and an undated "verified" badge is a
  -- claim nobody can bound.
  checked_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  checked_by  text,

  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Re-runnable, for the same reason every migration here repeats its columns.
ALTER TABLE app.job_claim_verifications ADD COLUMN IF NOT EXISTS method text;
ALTER TABLE app.job_claim_verifications ADD COLUMN IF NOT EXISTS source_independent boolean NOT NULL DEFAULT false;
ALTER TABLE app.job_claim_verifications ADD COLUMN IF NOT EXISTS source_name text;
ALTER TABLE app.job_claim_verifications ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE app.job_claim_verifications ADD COLUMN IF NOT EXISTS evidence jsonb;
ALTER TABLE app.job_claim_verifications ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE app.job_claim_verifications ADD COLUMN IF NOT EXISTS checked_by text;
ALTER TABLE app.job_claim_verifications ADD COLUMN IF NOT EXISTS claim_hash text;

-- The two badge constraints, added separately so this file can be re-run against
-- a database that already has the table. ADD CONSTRAINT IF NOT EXISTS does not
-- exist, so each is attempted and an "already exists" notice is ignored - which
-- is the standard way to make a constraint addition re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verified_needs_independent') THEN
    ALTER TABLE app.job_claim_verifications
      ADD CONSTRAINT verified_needs_independent CHECK (verdict <> 'verified' OR source_independent);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'independent_is_verified') THEN
    ALTER TABLE app.job_claim_verifications
      ADD CONSTRAINT independent_is_verified CHECK (NOT source_independent OR verdict = 'verified');
  END IF;
END $$;

COMMENT ON TABLE app.job_claim_verifications IS
  'Independent checks of dossier claims. Exactly one verdict - verified - may be shown to an employer as a mark. A claim the candidate merely asserted is never verified by Jobby on its own authority.';
COMMENT ON COLUMN app.job_claim_verifications.source_independent IS
  'True only if the source is outside the candidate''s control. A site, profile, repository or wiki page they can edit is independent=false and can corroborate but never verify.';
COMMENT ON COLUMN app.job_claim_verifications.claim_hash IS
  'Hash of the claim text at the moment of checking, so a verdict cannot outlive the wording it was about.';

-- One live verdict per claim. Re-checking updates the row rather than stacking
-- history, because an employer reading the dossier should see the current state
-- of the claim, not an audit log.
DROP INDEX IF EXISTS app.job_claim_verifications_one_per_claim;
CREATE UNIQUE INDEX IF NOT EXISTS job_claim_verifications_one_per_claim
  ON app.job_claim_verifications (client_id, path);

-- Reading "show me the verified claims" is the only query the site makes, and
-- partial because the other three verdicts are the overwhelming majority and are
-- never displayed.
CREATE INDEX IF NOT EXISTS job_claim_verifications_verified
  ON app.job_claim_verifications (client_id, path)
  WHERE verdict = 'verified';

-- Finding the claims that still need checking, oldest first.
CREATE INDEX IF NOT EXISTS job_claim_verifications_open
  ON app.job_claim_verifications (client_id, checked_at)
  WHERE verdict IN ('unverifiable','disputed');

COMMIT;
