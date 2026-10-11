/**
 * relay/lib/entity-sync-listener.mjs — drains app.entity_sync_outbox.
 *
 * The trigger from entity_sync_001_outbox.sql enqueues a row on any PFP lead
 * insert/correction and NOTIFYs 'entity_sync'. We keep a dedicated LISTEN
 * connection for the fast path and a 60s sweep for durability (a missed
 * NOTIFY — relay down at the time — is just processed late, never lost).
 *
 * Each pending row is run through tools/propagate-entity.mjs, which projects
 * the lead into knowledge_entities / fleet_memory / shared_context
 * idempotently. Failures bump attempts and record last_error; a row is
 * abandoned (left unprocessed) after 5 attempts and surfaces in the relay
 * log — one poisoned lead never blocks the queue.
 *
 * Logs are redacted: lead ids and store actions only, no names or emails
 * (per the propagation spec — contact data stays out of routine logs).
 */

import pg from 'pg';
import { query as dbQuery } from './db.mjs';
import { propagateLeadEntity } from '../tools/propagate-entity.mjs';

const { Client } = pg;
const MAX_ATTEMPTS = 5;
const SWEEP_MS = 60_000;

export function startEntitySyncListener({ logger = console } = {}) {
  let running = false;

  async function processPending() {
    if (running) return; // a NOTIFY while a batch is mid-flight
    running = true;
    try {
      const { rows } = await dbQuery(
        `SELECT id, lead_id, superseded_emails FROM app.entity_sync_outbox
          WHERE processed_at IS NULL AND attempts < $1
          ORDER BY created_at LIMIT 25`,
        [MAX_ATTEMPTS]
      );
      for (const row of rows) {
        try {
          const { rows: leads } = await dbQuery(
            'SELECT * FROM public.pfp_leads WHERE id = $1', [row.lead_id]
          );
          if (!leads[0]) {
            await dbQuery(
              `UPDATE app.entity_sync_outbox SET processed_at = now(), last_error = 'lead row gone' WHERE id = $1`,
              [row.id]
            );
            continue;
          }
          const lead = leads[0];
          const sup = Array.isArray(row.superseded_emails) ? row.superseded_emails : [];
          if (sup.length) lead.__superseded_emails = sup;
          const out = await propagateLeadEntity(dbQuery, lead, { by: 'entity-sync-listener' });
          await dbQuery(
            `UPDATE app.entity_sync_outbox SET processed_at = now(), last_error = NULL WHERE id = $1`,
            [row.id]
          );
          // Redacted: store actions + entity name only.
          const actions = Object.fromEntries(Object.entries(out.results).map(([k, v]) => [k, v.action]));
          logger.log?.(`[entity-sync] propagated ${out.entity} ← lead ${row.lead_id.slice(0, 8)}… : ${JSON.stringify(actions)}`);
        } catch (e) {
          await dbQuery(
            `UPDATE app.entity_sync_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
            [row.id, String(e?.message || e).slice(0, 500)]
          ).catch(() => {});
          logger.warn?.(`[entity-sync] propagation failed for lead ${row.lead_id.slice(0, 8)}… (attempt bumped): ${e?.message || e}`);
        }
      }
    } catch (e) {
      logger.warn?.(`[entity-sync] sweep failed: ${e?.message || e}`);
    } finally {
      running = false;
    }
  }

  // Fast path: LISTEN on a dedicated connection (never the shared pool —
  // a LISTEN client must not serve queries).
  const listener = new Client({ connectionString: process.env.LOCAL_DATABASE_URL });
  let listenReady = false;
  async function connectListen() {
    try {
      await listener.connect();
      await listener.query('LISTEN entity_sync');
      listenReady = true;
      logger.log?.('[entity-sync] LISTENing on channel entity_sync');
    } catch (e) {
      logger.warn?.(`[entity-sync] LISTEN connect failed (${e?.message || e}); sweep-only mode, retrying in 60s`);
      setTimeout(connectListen, SWEEP_MS);
    }
  }
  listener.on('notification', () => { processPending(); });
  listener.on('error', (e) => {
    logger.warn?.(`[entity-sync] LISTEN error: ${e?.message || e}`);
    listenReady = false;
    // pg does not auto-reconnect; the sweep keeps draining, and we try to
    // re-establish the fast path on the next sweep tick.
  });

  connectListen();
  const timer = setInterval(() => {
    if (!listenReady) connectListen();
    processPending();
  }, SWEEP_MS);
  timer.unref?.();

  // Process anything enqueued while the relay was down.
  processPending();

  return { processPending, stop: () => { clearInterval(timer); listener.end().catch(() => {}); } };
}
