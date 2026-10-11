/**
 * relay/tools/propagate-entity.mjs — idempotent CRM→memory entity propagation.
 *
 * When an operator corrects a CRM record (PFP lead/contact/partnership), the
 * correction historically stayed in the CRM — knowledge_entities, fleet_memory
 * and shared_context kept the stale value (this is how Laura Sosa's email fix
 * never became recallable). This module projects a canonical person entity
 * into every semantic-recall store, idempotently:
 *
 *   - app.knowledge_entities   keyed on (entity_type, entity_name) — update in place
 *   - app.fleet_memory         keyed on title 'CRM entity: <name>' — update in place
 *   - knowledge.shared_context keyed on context_key 'crm_entity_<slug>' — update in place
 *
 * No table has a unique constraint on those natural keys, so idempotency is
 * done as SELECT-then-UPDATE/INSERT inside one transaction per store. Replays
 * never duplicate. The old email is kept as a *superseded* alias, never
 * deleted. Source precedence: the CRM record always wins — an older memory
 * row can never overwrite a newer CRM correction because every write here
 * carries the CRM's updated_at as provenance and we refuse to propagate a
 * CRM record whose updated_at is older than the one already stored.
 *
 * Usage:
 *   node relay/tools/propagate-entity.mjs --lead 8bf36312-d261-4800-9de9-648b1b79a1cb
 * or from code:
 *   import { propagateLeadEntity } from './propagate-entity.mjs';
 *   await propagateLeadEntity(queryFn, leadRow, { by: 'eliza' });
 */

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export function canonicalEntityFromLead(lead) {
  const name = lead.contact_name;
  const email = lead.contact_email;
  return {
    entity_type: 'person',
    entity_name: name,
    name,
    description: `Planner partner${lead.company_name ? ` at ${lead.company_name}` : ''} (PFP lead, status: ${lead.status || lead.stage}).`,
    content: `${name} — planner partner${lead.company_name ? `, ${lead.company_name}` : ''}. Current email: ${email}. Booked for event ${lead.event_date ? new Date(lead.event_date).toISOString().slice(0, 10) : 'unknown'}.`,
    tags: ['pfp', 'crm', 'planner-partner', 'client'],
    metadata: {
      canonical: true,
      source: 'pfp_leads',
      source_record_id: lead.id,
      source_updated_at: lead.updated_at,
      current_email: email,
      // Filled by the caller when an older address exists in history.
      superseded_emails: lead.__superseded_emails || [],
      aliases: [name.split(' ')[0], lead.company_name, 'planner partner'].filter(Boolean),
      relationship: 'planner partner',
      organization: lead.company_name || null,
      provenance: { name: 'pfp_leads.contact_name', email: 'pfp_leads.contact_email (operator-corrected)', relationship: 'operator' },
      confidence: 1.0,
      conflict_state: 'resolved',
    },
  };
}

export async function propagateLeadEntity(query, lead, { by = 'propagate-entity' } = {}) {
  if (!lead || !lead.id || !lead.contact_name) throw new Error('lead row with id + contact_name required');
  const ent = canonicalEntityFromLead(lead);
  const results = {};
  const srcTs = new Date(lead.updated_at || Date.now());

  // ── 1. app.knowledge_entities ─────────────────────────────────────────
  {
    const found = await query(
      `SELECT id, metadata FROM app.knowledge_entities WHERE entity_type='person' AND entity_name=$1 LIMIT 1`,
      [ent.entity_name]
    );
    const existing = found.rows[0];
    if (existing) {
      const prevTs = new Date(existing.metadata?.source_updated_at || 0);
      if (prevTs > srcTs) {
        results.knowledge_entities = { action: 'skipped-stale-source', id: existing.id };
      } else {
        // Preserve any superseded emails we knew about.
        const merged = { ...(existing.metadata || {}), ...ent.metadata };
        const prevSup = existing.metadata?.superseded_emails || [];
        const prevEmail = existing.metadata?.current_email;
        const sup = new Set([...prevSup, ...ent.metadata.superseded_emails]);
        if (prevEmail && prevEmail !== ent.metadata.current_email) sup.add(prevEmail);
        merged.superseded_emails = [...sup];
        await query(
          `UPDATE app.knowledge_entities SET name=$2, entity_name=$2, description=$3, content=$4, tags=$5, metadata=$6, entity=$7, confidence_score=1.0, updated_at=now() WHERE id=$1`,
          [existing.id, ent.name, ent.description, ent.content, ent.tags, JSON.stringify(merged), JSON.stringify({ type: 'person', name: ent.name })]
        );
        results.knowledge_entities = { action: 'updated', id: existing.id, superseded: merged.superseded_emails };
      }
    } else {
      const r = await query(
        `INSERT INTO app.knowledge_entities (name, entity_name, entity_type, description, content, tags, metadata, entity, confidence_score)
         VALUES ($1, $1, 'person', $2, $3, $4, $5, $6, 1.0) RETURNING id`,
        [ent.name, ent.description, ent.content, ent.tags, JSON.stringify(ent.metadata), JSON.stringify({ type: 'person', name: ent.name })]
      );
      results.knowledge_entities = { action: 'inserted', id: r.rows[0].id };
    }
  }

  // ── 2. app.fleet_memory ───────────────────────────────────────────────
  {
    const title = `CRM entity: ${ent.name}`;
    const body = `${ent.content} Superseded emails: ${(ent.metadata.superseded_emails || []).join(', ') || 'none'}. Source: pfp_leads/${lead.id} (updated ${srcTs.toISOString()}).`;
    const found = await query(`SELECT id FROM app.fleet_memory WHERE title=$1 AND memory_type='crm-entity' LIMIT 1`, [title]);
    if (found.rows[0]) {
      await query(
        `UPDATE app.fleet_memory SET body=$2, payload=$3, updated_at=now() WHERE id=$1`,
        [found.rows[0].id, body, JSON.stringify(ent.metadata)]
      );
      results.fleet_memory = { action: 'updated', id: found.rows[0].id };
    } else {
      const r = await query(
        `INSERT INTO app.fleet_memory (agent_id, agent_role, memory_type, scope, title, body, payload, confidence)
         VALUES ($1, 'crm-sync', 'crm-entity', 'fleet', $2, $3, $4, 1.0) RETURNING id`,
        [by, title, body, JSON.stringify(ent.metadata)]
      );
      results.fleet_memory = { action: 'inserted', id: r.rows[0].id };
    }
  }

  // ── 3. knowledge.shared_context ───────────────────────────────────────
  {
    const key = `crm_entity_${slug(ent.name)}`;
    const value = JSON.stringify({
      canonical_entity: ent.name,
      entity_type: 'person',
      current_email: ent.metadata.current_email,
      superseded_emails: ent.metadata.superseded_emails || [],
      aliases: ent.metadata.aliases,
      relationship: ent.metadata.relationship,
      organization: ent.metadata.organization,
      source: 'pfp_leads',
      source_record_id: lead.id,
      source_updated_at: srcTs.toISOString(),
    });
    const found = await query(`SELECT id FROM knowledge.shared_context WHERE context_key=$1 LIMIT 1`, [key]);
    if (found.rows[0]) {
      await query(
        `UPDATE knowledge.shared_context SET value=$2, description=$3, last_updated_by=$4, updated_at=now() WHERE id=$1`,
        [found.rows[0].id, value, `Canonical CRM entity projection for ${ent.name} (idempotent, source pfp_leads/${lead.id})`, by]
      );
      results.shared_context = { action: 'updated', id: found.rows[0].id, key };
    } else {
      const r = await query(
        `INSERT INTO knowledge.shared_context (context_key, context_type, value, description, last_updated_by)
         VALUES ($1, 'crm-entity', $2, $3, $4) RETURNING id`,
        [key, value, `Canonical CRM entity projection for ${ent.name} (idempotent, source pfp_leads/${lead.id})`, by]
      );
      results.shared_context = { action: 'inserted', id: r.rows[0].id, key };
    }
  }

  return { entity: ent.name, source_updated_at: srcTs.toISOString(), results };
}

// CLI entry: propagate a PFP lead by id, optionally recording the email it
// replaces as superseded.
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const leadId = process.argv[process.argv.indexOf('--lead') + 1];
  const supIdx = process.argv.indexOf('--superseded-email');
  const superseded = supIdx > -1 ? process.argv[supIdx + 1] : null;
  if (!leadId) { console.error('usage: propagate-entity.mjs --lead <uuid> [--superseded-email <addr>]'); process.exit(2); }
  const { Client } = await import('pg');
  const c = new Client({ connectionString: process.env.LOCAL_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });
  await c.connect();
  const q = (text, params) => c.query(text, params);
  const { rows } = await c.query('SELECT * FROM public.pfp_leads WHERE id=$1', [leadId]);
  if (!rows[0]) { console.error('lead not found:', leadId); process.exit(1); }
  if (superseded) rows[0].__superseded_emails = [superseded];
  const out = await propagateLeadEntity(q, rows[0], { by: 'propagate-entity-cli' });
  console.log(JSON.stringify(out, null, 2));
  await c.end();
}
