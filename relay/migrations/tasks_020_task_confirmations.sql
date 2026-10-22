-- tasks_020_task_confirmations.sql
--
-- WHEN A PERSON CONFIRMS THE WORK, THAT CONFIRMATION IS EVIDENCE.
--
-- A task parked in REVIEW with terminal_reason
-- 'checklist_complete_awaiting_confirmation' is waiting for a person to look
-- at it and say whether it is good. The executor refuses to close those tasks
-- itself, because an agent marking its own homework as confirmed is the one
-- mistake worth avoiding. So the human is the only one who can release that
-- gate - and until the answer comes back, the task waits.
--
-- The answer comes back as email, and the reply is a real thing that happened:
-- a person read the question and wrote words. That is worth keeping as a
-- first-class record, not as a sentence stuffed into a metadata column.
--
-- So a confirmation is its own row here, and the artifact that carries it
-- points at a resolvable record of it. Three properties make that worth
-- trusting:
--
--   1. IT IS BOUND TO AN ESCALATION. A confirmation names the question it
--      answers, and that question names the task. There is no way to confirm
--      a task that was never put to anybody.
--
--   2. IT IS BOUND TO A REPLY. The escalation it answers must be ANSWERED -
--      still_open = false, answered_at set, answered_text non-empty. An
--      unanswered question has no confirmation, so a row cannot be invented
--      for a question nobody answered.
--
--   3. IT NAMES WHO ANSWERED, AND THE ADDRESS IS CHECKED. The confirmation
--      records the address that replied, and it has to be the address the
--      question was sent to. A reply from anybody else is not the answer to
--      that question - it is a different email.
--
-- WHY A TRIGGER AND NOT A CONVENTION
-- ----------------------------------
-- Because a convention is a comment, and a comment is not a rule. The
-- trigger below refuses a 'human-confirmation' artifact unless it points at a
-- confirmation that satisfies all three properties above. Without it, any
-- agent that can insert an artifact could satisfy the completion gate with
-- "the customer said it was fine" - which is exactly the hollow completion
-- that migration 016 was written to stop.
--
-- The URL on the artifact is what the completion guard checks: non-empty, and
-- not the task pointing at its own record. A confirmation points at the
-- record OF THE CONFIRMATION, which is a different thing from the task's own
-- page - it names the person, the time, and the words they wrote.

CREATE TABLE IF NOT EXISTS app.task_confirmations (
  id              bigserial PRIMARY KEY,
  task_id         text NOT NULL REFERENCES app.tasks(id) ON DELETE CASCADE,
  -- The question this answers. A confirmation without a question is a
  -- confirmation of nothing.
  escalation_id   bigint NOT NULL REFERENCES app.task_escalations(id) ON DELETE CASCADE,
  -- The address that answered, and the address the question went to. They are
  -- the same address, and the trigger below enforces it.
  confirmed_by    text NOT NULL,
  -- The person's words. Not a summary of them - the words.
  reply_text      text NOT NULL,
  -- What the answer means, as read by ai-chat. A READING, and labelled as
  -- one: the words above are the fact, this is the interpretation of them.
  reading_intent  text,
  reading_summary text,
  read_by         text,
  -- The public address of this record. It is what the completion artifact
  -- points at, so it has to resolve to something.
  source_url      text,
  confirmed_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- The words have to be words.
  CONSTRAINT task_confirmations_reply_not_empty
    CHECK (reply_text IS NOT NULL AND length(btrim(reply_text)) > 0),

  -- The address has to be an address.
  CONSTRAINT task_confirmations_address_is_an_address
    CHECK (confirmed_by LIKE '%@%'),

  -- The reading is one of the four things a person can mean, or it was not
  -- read properly. An unknown intent is not a confirmation.
  CONSTRAINT task_confirmations_intent_vocab
    CHECK (reading_intent IS NULL OR reading_intent IN (
      'confirmed_complete', 'more_work_requested', 'question_for_us', 'unclear'
    ))
);

CREATE INDEX IF NOT EXISTS task_confirmations_task_idx
  ON app.task_confirmations (task_id, confirmed_at DESC);

CREATE INDEX IF NOT EXISTS task_confirmations_escalation_idx
  ON app.task_confirmations (escalation_id);

-- One confirmation per question. The same answer is not recorded twice, and a
-- second reply to the same question becomes a follow-up rather than a second
-- confirmation of the same thing.
CREATE UNIQUE INDEX IF NOT EXISTS task_confirmations_one_per_escalation_idx
  ON app.task_confirmations (escalation_id);

-- ── The artifact has to point at a real confirmation ───────────────────────
--
-- The completion guard asks for an artifact carrying a non-empty URL. That
-- check is about SHAPE, and shape is not enough on its own: without this
-- trigger, the shape of an artifact is all that stands between an agent and a
-- completed task.
--
-- So this asks the SUBSTANCE question: does this artifact point at a
-- confirmation of THIS task, answering a question that WAS put to somebody
-- and WAS answered, by the person it was put to?
CREATE OR REPLACE FUNCTION app.enforce_human_confirmation_artifact()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  c_id   bigint;
  c_row  record;
  esc    record;
BEGIN
  -- Only this kind of artifact is checked. A work-log or a work-item points
  -- at the work, and that is the existing rule.
  IF NEW.artifact_type IS DISTINCT FROM 'human-confirmation' THEN
    RETURN NEW;
  END IF;

  -- It has to name a confirmation.
  c_id := (NEW.payload->>'confirmation_id')::bigint;
  IF c_id IS NULL THEN
    RAISE EXCEPTION
      'a human-confirmation artifact must name the confirmation it carries (payload.confirmation_id)'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO c_row FROM app.task_confirmations WHERE id = c_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'human-confirmation artifact names confirmation %, which does not exist', c_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The confirmation is about THIS task.
  IF c_row.task_id IS DISTINCT FROM NEW.task_id THEN
    RAISE EXCEPTION
      'human-confirmation artifact is on task % but its confirmation % is about task %',
      NEW.task_id, c_id, c_row.task_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The question it answers was put to somebody, and was answered.
  SELECT * INTO esc FROM app.task_escalations WHERE id = c_row.escalation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'confirmation % names escalation %, which does not exist', c_id, c_row.escalation_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF esc.task_id IS DISTINCT FROM NEW.task_id THEN
    RAISE EXCEPTION
      'confirmation % is on task % but the question it answers (%s) is about task %',
      c_id, NEW.task_id, esc.id, esc.task_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF esc.still_open THEN
    RAISE EXCEPTION
      'confirmation % answers escalation %, which has not been answered', c_id, esc.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF esc.answered_at IS NULL OR btrim(coalesce(esc.answered_text, '')) = '' THEN
    RAISE EXCEPTION
      'confirmation % answers escalation %, which has no answer recorded', c_id, esc.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- And the person who answered is the person the question went to. A reply
  -- from anybody else is a different email, not the answer to this question.
  IF lower(c_row.confirmed_by) IS DISTINCT FROM lower(esc.to_address) THEN
    RAISE EXCEPTION
      'confirmation % says it was answered by %, but the question went to %',
      c_id, c_row.confirmed_by, esc.to_address
      USING ERRCODE = 'check_violation';
  END IF;

  -- The words recorded are the words that were answered with.
  IF btrim(c_row.reply_text) IS DISTINCT FROM btrim(coalesce(esc.answered_text, '')) THEN
    RAISE EXCEPTION
      'confirmation % records different words from the answer recorded on escalation %',
      c_id, esc.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_human_confirmation_artifact ON app.task_artifacts;
CREATE TRIGGER trg_enforce_human_confirmation_artifact
  BEFORE INSERT ON app.task_artifacts
  FOR EACH ROW EXECUTE FUNCTION app.enforce_human_confirmation_artifact();

-- ── And a confirmation cannot be invented either ────────────────────────────
--
-- The same three properties, enforced on the confirmation itself, so a row
-- cannot be inserted with a made-up question or a made-up answerer and then
-- leaned on by an artifact.
CREATE OR REPLACE FUNCTION app.enforce_task_confirmation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  esc record;
BEGIN
  SELECT * INTO esc FROM app.task_escalations WHERE id = NEW.escalation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation names escalation %, which does not exist', NEW.escalation_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF esc.task_id IS DISTINCT FROM NEW.task_id THEN
    RAISE EXCEPTION
      'confirmation is on task % but the question it answers is about task %',
      NEW.task_id, esc.task_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF esc.still_open OR esc.answered_at IS NULL OR btrim(coalesce(esc.answered_text, '')) = '' THEN
    RAISE EXCEPTION
      'confirmation claims to answer escalation %, which has no recorded answer', NEW.escalation_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF lower(NEW.confirmed_by) IS DISTINCT FROM lower(esc.to_address) THEN
    RAISE EXCEPTION
      'confirmation says it was answered by %, but the question went to %',
      NEW.confirmed_by, esc.to_address
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_task_confirmation ON app.task_confirmations;
CREATE TRIGGER trg_enforce_task_confirmation
  BEFORE INSERT ON app.task_confirmations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_task_confirmation();
