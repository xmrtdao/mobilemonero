-- entity_sync_001_outbox.sql — CRM→memory propagation trigger + outbox
--
-- Any write to a PFP lead (relay tool, edge function, or hand SQL) enqueues
-- an outbox row and pings the 'entity_sync' channel. The relay's
-- entity-sync-listener drains the outbox through tools/propagate-entity.mjs,
-- so a corrected CRM record becomes recallable in knowledge_entities,
-- fleet_memory and shared_context without anyone running a CLI.
--
-- Idempotency: one pending row per lead — a second correction while one is
-- pending just refreshes the same row (and merges superseded emails).
-- Durability: rows survive relay restarts; the listener sweeps every 60s
-- even if a NOTIFY is missed.

CREATE TABLE IF NOT EXISTS app.entity_sync_outbox (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           uuid NOT NULL,
  superseded_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  attempts          int  NOT NULL DEFAULT 0,
  last_error        text
);

CREATE INDEX IF NOT EXISTS entity_sync_outbox_pending_idx
  ON app.entity_sync_outbox (created_at)
  WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION app.pfp_lead_entity_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sup jsonb := '[]'::jsonb;
BEGIN
  -- On UPDATE, an email that was replaced becomes a superseded alias.
  IF TG_OP = 'UPDATE'
     AND OLD.contact_email IS NOT NULL
     AND NEW.contact_email IS DISTINCT FROM OLD.contact_email THEN
    sup := jsonb_build_array(OLD.contact_email);
  END IF;

  -- One pending row per lead: refresh it if it exists, else insert.
  UPDATE app.entity_sync_outbox
     SET superseded_emails = (
           SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb)
           FROM (
             SELECT jsonb_array_elements_text(entity_sync_outbox.superseded_emails) AS e
             UNION ALL SELECT jsonb_array_elements_text(sup)
           ) merged
         ),
         created_at = now(),
         attempts = 0,
         last_error = NULL
   WHERE lead_id = COALESCE(NEW.id, OLD.id)
     AND processed_at IS NULL;

  IF NOT FOUND THEN
    INSERT INTO app.entity_sync_outbox (lead_id, superseded_emails)
    VALUES (COALESCE(NEW.id, OLD.id), sup);
  END IF;

  PERFORM pg_notify('entity_sync', COALESCE(NEW.id, OLD.id)::text);
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS pfp_leads_entity_sync ON public.pfp_leads;
CREATE TRIGGER pfp_leads_entity_sync
  AFTER INSERT OR UPDATE OF contact_name, contact_email, company_name, status, stage
  ON public.pfp_leads
  FOR EACH ROW EXECUTE FUNCTION app.pfp_lead_entity_sync();
