/**
 * relay/tests/inbound-email.test.mjs
 *
 * Tests for lib/inbound-email.mjs. No relay process, no database, no network for
 * most cases — every dependency is injected, which is the reason the logic was
 * worth extracting.
 *
 * Run: node --test tests/inbound-email.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchInboundBody, persistInboundEmail, syncOneDomainInbox,
  runInboundSyncPass, INBOUND_BODY_RETENTION_DAYS, INBOUND_BODY_FETCH_CAP,
} from '../lib/inbound-email.mjs';

// ── helpers ────────────────────────────────────────────────────────────────

/** A query() stand-in that records calls and returns a pg-shaped result. */
function fakeQuery(overrides = {}) {
  const calls = [];
  const fn = async (sql, params) => {
    calls.push({ sql, params });
    if (overrides.onQuery) {
      const r = await overrides.onQuery(sql, params, calls.length);
      if (r) return r;
    }
    return { rows: [{ id: 1 }] };
  };
  fn.calls = calls;
  return fn;
}

/** Replace global fetch with a scripted queue of responses. */
function stubFetch(responses) {
  const original = globalThis.fetch;
  const seen = [];
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), opts });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (typeof r === 'function') return r(url, opts);
    return r;
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// ── the four documented defects ────────────────────────────────────────────

test('DEFECT 1: unwraps the /emails/receiving envelope', async () => {
  // The API returns an envelope. The original code did Array.isArray() on it,
  // which is always false, so the sync silently did nothing forever.
  const stub = stubFetch([jsonRes({
    object: 'list', has_more: true,
    data: [
      { id: 'e1', to: ['a@pfp.example'], from: 'x@y.example', subject: 'One', created_at: new Date().toISOString() },
      { id: 'e2', to: ['b@pfp.example'], from: 'z@y.example', subject: 'Two', created_at: new Date().toISOString() },
    ],
  })]);
  try {
    const q = fakeQuery();
    const r = await syncOneDomainInbox({
      domain: 'pfp',
      spec: { domain: 'pfp.example', key: 'RESEND_API_KEY', key_scope: 'pfp.example' },
      apiKey: 'k', query: q, keyFor: () => 'pfp',
    });
    assert.equal(r.scanned, 2, 'both rows must be seen, not zero');
    assert.ok(r.persisted >= 1, 'rows must be persisted');
  } finally { stub.restore(); }
});

test('DEFECT 1b: still accepts a bare array, so a future flattening cannot break it', async () => {
  const stub = stubFetch([jsonRes([{ id: 'e1', to: ['a@x'], subject: 'S', created_at: new Date().toISOString() }])]);
  try {
    const r = await syncOneDomainInbox({
      domain: 'pfp', spec: { domain: 'pfp.example' }, apiKey: 'k',
      query: fakeQuery(), keyFor: () => 'pfp',
    });
    assert.equal(r.scanned, 1);
  } finally { stub.restore(); }
});

test('DEFECT 1c: an unreadable shape is reported, not swallowed', async () => {
  const stub = stubFetch([jsonRes({ unexpected: true })]);
  try {
    const r = await syncOneDomainInbox({
      domain: 'pfp', spec: { domain: 'pfp.example' }, apiKey: 'k',
      query: fakeQuery(), keyFor: () => 'pfp',
    });
    assert.equal(r.scanned, 0, 'nothing scanned from an unreadable shape');
  } finally { stub.restore(); }
});

test('DEFECT 2: a row is persisted even when no body is available', async () => {
  // Null body, not ''. An empty string asserts "an email with no content",
  // which is a different and wrong fact.
  const now = new Date().toISOString();
  const stub = stubFetch([jsonRes({ object: 'list', data: [{ id: 'e1', to: ['a@x'], subject: 'S', created_at: now }] })]);
  try {
    const q = fakeQuery();
    await syncOneDomainInbox({
      domain: 'pfp', spec: { domain: 'pfp.example' }, apiKey: 'k',
      query: q, keyFor: () => 'pfp',
    });
    const insert = q.calls.find(c => /INSERT INTO app\.inbox_emails/.test(c.sql));
    assert.ok(insert, 'an INSERT must happen');
    const bodyIdx = insert.sql.indexOf('body_text');
    assert.ok(bodyIdx > -1);
    // params order: id, from, to, subject, text, html, created, read, domain, metadata
    assert.equal(insert.params[4], null, 'body_text must be null, not empty string');
  } finally { stub.restore(); }
});

test('DEFECT 3: the body fetch uses the key passed for THIS domain', async () => {
  const now = new Date().toISOString();
  const stub = stubFetch([
    jsonRes({ object: 'list', data: [{ id: 'e1', to: ['a@harbor.example'], subject: 'S', created_at: now }] }),
    jsonRes({ object: 'email', id: 'e1', text: 'the body', html: null }),
  ]);
  try {
    const q = fakeQuery();
    await syncOneDomainInbox({
      domain: '31harbor',
      spec: { domain: 'harbor.example', key: 'RESEND_31HARBOR_API_KEY', key_scope: 'harbor.example' },
      apiKey: 'HARBOR_KEY', query: q, keyFor: () => '31harbor',
    });
    const bodyFetch = stub.seen.find(s => /\/emails\/receiving\/e1$/.test(s.url));
    assert.ok(bodyFetch, 'the per-id body fetch must happen');
    assert.equal(bodyFetch.opts.headers.Authorization, 'Bearer HARBOR_KEY',
      'must use the domain-scoped key, not a shared one');
  } finally { stub.restore(); }
});

test('DEFECT 3b: a 404 is not recorded as expiry', async () => {
  const now = new Date().toISOString();
  const stub = stubFetch([
    jsonRes({ object: 'list', data: [{ id: 'e1', to: ['a@x'], subject: 'S', created_at: now }] }),
    { ok: false, status: 404, json: async () => ({}) },
  ]);
  try {
    const q = fakeQuery();
    const r = await syncOneDomainInbox({
      domain: 'pfp', spec: { domain: 'pfp.example' }, apiKey: 'k',
      query: q, keyFor: () => 'pfp',
    });
    assert.equal(r.bodiesCaptured, 0);
    const upd = q.calls.find(c => /body_unavailable/.test(c.sql));
    assert.ok(upd, 'must record why the body was unavailable');
    assert.equal(upd.params[1], 'wrong-key-or-expired',
      'the reason must not assert expiry a 404 cannot support');
  } finally { stub.restore(); }
});

// ── fetchInboundBody ───────────────────────────────────────────────────────

test('fetchInboundBody: refuses to call the provider without an id or key', async () => {
  const stub = stubFetch([jsonRes({})]);
  try {
    assert.equal((await fetchInboundBody(null, 'k')).fetched, false);
    assert.equal((await fetchInboundBody('', 'k')).fetched, false);
    assert.equal((await fetchInboundBody('id', null)).fetched, false);
    assert.equal(stub.seen.length, 0, 'no network call for a bad argument');
  } finally { stub.restore(); }
});

test('fetchInboundBody: separates 404, 429, empty body and success', async () => {
  const cases = [
    [{ ok: false, status: 404 }, 'wrong-key-or-expired'],
    [{ ok: false, status: 429 }, 'rate-limited'],
    [{ ok: false, status: 500 }, 'http-500'],
    [jsonRes({ object: 'email', text: null, html: null }), 'empty-body'],
  ];
  for (const [res, expected] of cases) {
    const stub = stubFetch([res]);
    try {
      const r = await fetchInboundBody('e1', 'k');
      assert.equal(r.fetched, false);
      assert.equal(r.reason, expected);
    } finally { stub.restore(); }
  }
});

test('fetchInboundBody: returns authentication but NOT the expiring raw URL', async () => {
  const stub = stubFetch([jsonRes({
    object: 'email', id: 'e1', text: 'hello', html: '<p>hi</p>',
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    attachments: [{ filename: 'a.pdf' }],
    raw: { download_url: 'https://signed.example/x', expires_at: '2026-10-05T20:00:00Z' },
  })]);
  try {
    const r = await fetchInboundBody('e1', 'k');
    assert.equal(r.fetched, true);
    assert.equal(r.text, 'hello');
    assert.equal(r.authentication.dkim, 'pass');
    assert.equal(r.attachmentCount, 1);
    assert.equal(r.rawExpiresAt, '2026-10-05T20:00:00Z', 'expiry is reported');
    assert.ok(!('download_url' in r),
      'the signed URL must not be carried for storage: it breaks an hour later');
  } finally { stub.restore(); }
});

test('fetchInboundBody: a network failure is retryable, not fatal', async () => {
  const stub = stubFetch([() => { throw new Error('socket hang up'); }]);
  try {
    const r = await fetchInboundBody('e1', 'k');
    assert.equal(r.fetched, false);
    assert.equal(r.reason, 'socket hang up');
  } finally { stub.restore(); }
});

// ── retention and cap ──────────────────────────────────────────────────────

test('retention window matches the documented 30 days, inside it', () => {
  assert.equal(INBOUND_BODY_RETENTION_DAYS, 28);
  assert.ok(INBOUND_BODY_RETENTION_DAYS <= 30,
    'must stay inside Resend\'s documented 30-day retention');
  assert.ok(INBOUND_BODY_RETENTION_DAYS >= 14,
    '3 days was derived from 404s caused by a wrong key, not a provider limit');
});

test('a row older than the window is not fetched', async () => {
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const stub = stubFetch([jsonRes({ object: 'list', data: [{ id: 'old', to: ['a@x'], subject: 'S', created_at: old }] })]);
  try {
    const q = fakeQuery();
    const r = await syncOneDomainInbox({
      domain: 'pfp', spec: { domain: 'pfp.example' }, apiKey: 'k',
      query: q, keyFor: () => 'pfp',
    });
    assert.equal(r.bodiesCaptured, 0);
    assert.ok(!stub.seen.some(s => /\/emails\/receiving\/old$/.test(s.url)),
      'a 40-day-old id is a guaranteed 404; do not spend a request on it');
  } finally { stub.restore(); }
});

test('the per-pass cap bounds a large backlog', async () => {
  const now = new Date().toISOString();
  const many = Array.from({ length: INBOUND_BODY_FETCH_CAP + 10 }, (_, i) => ({
    id: 'e' + i, to: ['a@x'], subject: 'S' + i, created_at: now,
  }));
  let n = 0;
  const stub = stubFetch([
    jsonRes({ object: 'list', data: many }),
    () => { n++; return jsonRes({ object: 'email', id: 'x', text: 'b' }); },
  ]);
  try {
    const r = await syncOneDomainInbox({
      domain: 'pfp', spec: { domain: 'pfp.example' }, apiKey: 'k',
      query: fakeQuery(), keyFor: () => 'pfp',
    });
    assert.ok(r.bodiesCaptured <= INBOUND_BODY_FETCH_CAP,
      'must not exceed the cap in one pass');
    assert.ok(n <= INBOUND_BODY_FETCH_CAP + 1,
      'body fetches must be bounded, got ' + n);
  } finally { stub.restore(); }
});

// ── labelling ──────────────────────────────────────────────────────────────

test('rows are labelled with the REGISTRY KEY, not the bare domain', async () => {
  const now = new Date().toISOString();
  const stub = stubFetch([jsonRes({ object: 'list', data: [{ id: 'e1', to: ['a@pfp.example'], subject: 'S', created_at: now }] })]);
  try {
    const q = fakeQuery();
    await syncOneDomainInbox({
      domain: 'pfp', spec: { domain: 'pfp.example' }, apiKey: 'k',
      query: q, keyFor: () => 'pfp',
    });
    const insert = q.calls.find(c => /INSERT INTO app\.inbox_emails/.test(c.sql));
    assert.equal(insert.params[8], 'pfp',
      'domain column must hold the registry key so GROUP BY does not split a mailbox');
    const meta = JSON.parse(insert.params[9]);
    assert.equal(meta.domain_name, 'pfp.example',
      'the readable domain is kept alongside');
  } finally { stub.restore(); }
});

test('persistInboundEmail: COALESCE and upsert, never a blanking overwrite', async () => {
  const q = fakeQuery();
  await persistInboundEmail({
    query: q, email_id: 'e1', domain: 'pfp',
    text: null, html: null, sender: '', subject: '',
  });
  const sql = q.calls[0].sql;
  assert.match(sql, /ON CONFLICT \(email_id\) DO UPDATE/);
  assert.match(sql, /COALESCE\(EXCLUDED\.body_text, app\.inbox_emails\.body_text\)/,
    'a source with no body must not erase a body another source stored');
  assert.match(sql, /NULLIF\(EXCLUDED\.sender,''\)/,
    'an empty sender must not overwrite a real one');
});

test('persistInboundEmail: refuses to run without a query function', async () => {
  await assert.rejects(
    () => persistInboundEmail({ email_id: 'e1', domain: 'pfp' }),
    /requires a query function/
  );
});

// ── resilience ─────────────────────────────────────────────────────────────

test('one unpersistable row does not stop the others', async () => {
  const now = new Date().toISOString();
  const stub = stubFetch([jsonRes({ object: 'list', data: [
    { id: 'bad', to: ['a@x'], subject: '1', created_at: now },
    { id: 'good', to: ['b@x'], subject: '2', created_at: now },
  ] })]);
  try {
    let calls = 0;
    const q = fakeQuery({
      onQuery: (sql) => {
        if (/INSERT/.test(sql)) {
          calls++;
          if (calls === 1) throw new Error('constraint violation');
        }
        return null;
      },
    });
    const r = await syncOneDomainInbox({
      domain: 'pfp', spec: { domain: 'pfp.example' }, apiKey: 'k',
      query: q, keyFor: () => 'pfp',
    });
    assert.equal(r.scanned, 2, 'the bad row must not end the pass');
  } finally { stub.restore(); }
});

test('a missing key or a non-OK listing is reported, not thrown', async () => {
  const r1 = await syncOneDomainInbox({
    domain: 'pfp', spec: { domain: 'pfp.example' }, apiKey: null, query: fakeQuery(),
  });
  assert.equal(r1.scanned, 0);

  const stub = stubFetch([{ ok: false, status: 503, json: async () => ({}) }]);
  try {
    const r2 = await syncOneDomainInbox({
      domain: 'pfp', spec: { domain: 'pfp.example' }, apiKey: 'k',
      query: fakeQuery(), keyFor: () => 'pfp',
    });
    assert.equal(r2.scanned, 0);
  } finally { stub.restore(); }
});

// ── the pass runner ────────────────────────────────────────────────────────

test('runInboundSyncPass: aggregates across domains', async () => {
  const now = new Date().toISOString();
  const stub = stubFetch([jsonRes({ object: 'list', data: [
    { id: 'a1', to: ['x@1'], subject: 'S', created_at: now },
    { id: 'a2', to: ['x@2'], subject: 'S', created_at: now },
  ] })]);
  try {
    const guard = { value: false };
    const t = await runInboundSyncPass({
      domains: [
        { key: 'pfp', spec: { domain: 'one' }, apiKey: 'k1' },
        { key: '31harbor', spec: { domain: 'two' }, apiKey: 'k2' },
      ],
      query: fakeQuery(), keyFor: () => 'pfp', isRunning: guard, trigger: 'test',
    });
    assert.equal(t.scanned, 4, 'two domains x two rows');
    assert.equal(guard.value, false, 'the guard must be released even on success');
  } finally { stub.restore(); }
});

test('runInboundSyncPass: one failing domain does not stop the rest', async () => {
  const now = new Date().toISOString();
  const stub = stubFetch([jsonRes({ object: 'list', data: [{ id: 'a', to: ['x@1'], subject: 'S', created_at: now }] })]);
  try {
    const t = await runInboundSyncPass({
      domains: [
        { key: 'broken', spec: { domain: 'x' }, apiKey: null },          // fails: no key
        { key: 'pfp', spec: { domain: 'one' }, apiKey: 'k1' },
      ],
      query: fakeQuery(), keyFor: () => 'pfp', isRunning: { value: false }, trigger: 'test',
    });
    assert.equal(t.failed, 1);
    assert.equal(t.scanned, 1, 'the healthy domain still ran');
  } finally { stub.restore(); }
});

test('runInboundSyncPass: the overlap guard refuses a concurrent pass', async () => {
  const t = await runInboundSyncPass({
    domains: [{ key: 'pfp', spec: { domain: 'x' }, apiKey: 'k' }],
    query: fakeQuery(), isRunning: true, trigger: 'test',
  });
  assert.equal(t.skipped, true,
    'a second concurrent pass would race on rows and double body-fetch requests');
});

test('runInboundSyncPass: the guard is released when a domain throws', async () => {
  const guard = { value: false };
  await runInboundSyncPass({
    domains: [{ key: 'pfp', spec: { domain: 'x' }, apiKey: 'k' }],
    query: () => { throw new Error('db down'); },
    keyFor: () => 'pfp', isRunning: guard, trigger: 'test',
  });
  assert.equal(guard.value, false, 'a crash must not wedge the timer off forever');
});