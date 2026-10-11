/**
 * relay/test/entity-resolver.test.mjs — semantic acceptance tests for the
 * unified entity resolver (WS5).
 *
 * Run: node --test relay/test/entity-resolver.test.mjs
 *
 * Covers the six acceptance queries from the repair brief, plus exact-name,
 * alias, relationship, and organization lookups; current-vs-stale ranking;
 * duplicate merging; graph-timeout fallback; unrelated-Laura collision
 * safety; and read-after-write latency.
 *
 * Requires: local Postgres up, Laura Sosa entity already propagated
 * (propagate-entity.mjs), and the relay's lib/db.mjs env (LOCAL_DATABASE_URL
 * or the default local DSN).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createResolver } from '../lib/entity-resolver.mjs';
import { propagateLeadEntity } from '../tools/propagate-entity.mjs';

const { Client } = pg;
const DSN = process.env.LOCAL_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';
const LAURA_LEAD = '8bf36312-d261-4800-9de9-648b1b79a1cb';
const CURRENT = 'dclatinexperience@gmail.com';
const SUPERSEDED = 'laura@latin-experience.com';

let client;
let resolver;
const query = (t, p) => client.query(t, p);

before(async () => {
  client = new Client({ connectionString: DSN });
  await client.connect();
  resolver = createResolver({ query, logger: { warn() {}, log() {} } });
});

after(async () => { await client?.end(); });

function laura(res) {
  return res.matches.find(m => (m.display_name || '').toLowerCase() === 'laura sosa');
}

// The six acceptance queries must all resolve to the same canonical entity
// whose primary email is the current CRM address.
const ACCEPTANCE = ['Laura Sosa', 'Laura', 'Latin Experience', 'planner partner Laura', CURRENT, SUPERSEDED];
for (const q of ACCEPTANCE) {
  test(`acceptance: "${q}" resolves to canonical Laura Sosa`, async () => {
    const res = await resolver.resolveEntity(q);
    const m = laura(res);
    assert.ok(m, `no Laura Sosa match for "${q}" (got ${res.matches.length} clusters)`);
    assert.equal(m.current_email, CURRENT, `primary email must be the current CRM address for "${q}"`);
    assert.equal(m.conflict_state, 'resolved');
  });
}

test('superseded email query labels the old address as superseded', async () => {
  const res = await resolver.resolveEntity(SUPERSEDED);
  const m = laura(res);
  assert.ok(m);
  assert.ok(m.superseded_emails.includes(SUPERSEDED));
  assert.ok(!m.superseded_emails.includes(CURRENT));
});

test('exposes source, record id, and update time', async () => {
  const res = await resolver.resolveEntity('Laura Sosa');
  const m = laura(res);
  assert.ok(m);
  assert.equal(m.crm_record_id, LAURA_LEAD);
  assert.ok(m.updated_at);
  assert.ok(m.sources.some(s => s.source === 'pfp_leads'));
  assert.ok(m.provenance.email === 'pfp_leads', 'CRM must win email precedence');
});

test('duplicate merging: CRM + memory stores collapse into one cluster', async () => {
  const res = await resolver.resolveEntity('Laura Sosa');
  const m = laura(res);
  assert.ok(m);
  assert.ok(m.member_count >= 3, `expected CRM+KE+FM(+SC) members, got ${m.member_count}`);
  const sources = m.sources.map(s => s.source);
  for (const s of ['pfp_leads', 'knowledge_entities', 'fleet_memory', 'shared_context']) {
    assert.ok(sources.includes(s), `missing source ${s}`);
  }
});

test('no unrelated Laura collisions: a different Laura stays a separate cluster', async () => {
  // Synthetic second Laura with no shared identifiers.
  const { rows } = await client.query(
    `INSERT INTO public.pfp_leads (contact_name, contact_email, status, source, notes)
     VALUES ('Laura Testdouble', 'laura.testdouble@example.invalid', 'NEW', 'resolver-test', 'synthetic — resolver collision test')
     RETURNING id`
  );
  const id = rows[0].id;
  try {
    const res = await resolver.resolveEntity('Laura');
    const sosas = res.matches.filter(m => (m.display_name || '').toLowerCase() === 'laura sosa');
    const doubles = res.matches.filter(m => (m.display_name || '').toLowerCase() === 'laura testdouble');
    assert.equal(sosas.length, 1, 'Laura Sosa must remain exactly one cluster');
    assert.equal(doubles.length, 1, 'Laura Testdouble must be her own cluster, not merged');
    assert.notEqual(sosas[0].canonical_entity_id, doubles[0].canonical_entity_id);
    assert.ok(!sosas[0].superseded_emails.includes('laura.testdouble@example.invalid'), 'no cross-contamination of emails');
  } finally {
    await client.query('DELETE FROM public.pfp_leads WHERE id = $1', [id]);
    await client.query('DELETE FROM app.entity_sync_outbox WHERE lead_id = $1', [id]);
  }
});

test('graph timeout fallback: a dead source degrades visibly, never silently', async () => {
  // Wrap the real query so pfp_leads queries hang past the source timeout.
  const slowQuery = (text, params) => {
    if (/pfp_leads/.test(text)) return new Promise(() => {}); // never resolves
    return query(text, params);
  };
  const degradedResolver = createResolver({ query: slowQuery, logger: { warn() {}, log() {} } });
  const res = await degradedResolver.resolveEntity('Laura Sosa');
  assert.equal(res.partial, true, 'result must be marked partial');
  assert.ok(res.degraded.some(d => d.source === 'pfp_leads'), 'degraded[] must name the failed source');
  const m = laura(res);
  assert.ok(m, 'other sources must still answer');
  // CRM is gone, so the canonical knowledge entity's email wins instead.
  assert.equal(m.current_email, CURRENT);
  assert.equal(m.provenance.email, 'knowledge_entities');
});

test('read-after-write: a propagation is resolvable within the SLA (5s)', async () => {
  const { rows } = await client.query(
    `INSERT INTO public.pfp_leads (contact_name, contact_email, status, source, notes)
     VALUES ('Zzz Latency Probe', 'probe@example.invalid', 'NEW', 'resolver-test', 'synthetic — latency probe')
     RETURNING id, contact_name, contact_email, company_name, status, stage, source, updated_at`
  );
  const lead = rows[0];
  try {
    const t0 = Date.now();
    await propagateLeadEntity(query, lead, { by: 'resolver-test' });
    const res = await resolver.resolveEntity('Zzz Latency Probe');
    const dt = Date.now() - t0;
    assert.ok(res.matches.some(m => m.display_name === 'Zzz Latency Probe'), 'written entity must be resolvable');
    assert.ok(dt < 5000, `read-after-write took ${dt}ms (SLA 5000ms)`);
    console.log(`    read-after-write latency: ${dt}ms`);
  } finally {
    await client.query(`DELETE FROM app.knowledge_entities WHERE entity_name = 'Zzz Latency Probe'`);
    await client.query(`DELETE FROM app.fleet_memory WHERE title = 'CRM entity: Zzz Latency Probe'`);
    await client.query(`DELETE FROM knowledge.shared_context WHERE context_key = 'crm_entity_zzz_latency_probe'`);
    await client.query('DELETE FROM public.pfp_leads WHERE id = $1', [lead.id]);
  }
});

test('empty and stopword-only queries return no matches without touching the DB', async () => {
  const res = await resolver.resolveEntity('the and of');
  assert.deepEqual(res.matches, []);
  assert.equal(res.partial, false);
});
