#!/usr/bin/env node
// Guards POST /api/alice/tick.
//
// THE FAULT THIS EXISTS FOR
//
// The relay runs its own copy of Alice's loop (relay/lib/consolidate.mjs),
// and that loop posts to POST /api/alice/tick every hour — and at every relay
// restart, which is often. The route was never wired up, so every one of
// those posts was a 404 inside the relay's own namespace: a FAULT, not a
// refusal, by the relay's own definition. The Activity Intelligence board
// showed "POST /api/alice/tick → 404" sixteen times an hour, and Alice
// opened a task about it.
//
// WHAT IS ASSERTED HERE
//
//  1. The route exists, it is registered before the catch-all, and it has an
//     owner — so a 404 on it can never be a mystery again.
//  2. The tick runs the SAME cycle the daemon runs. One implementation, in
//     relay/alice.mjs, reached two ways: --daemon and --tick.
//  3. The two drivers cannot run the same cycle twice. relay/lib/alice-cycle.mjs
//     is the one ledger, and it is what decides whether a cycle is due.
//  4. A tick that did not run says so. "Ran nothing" and "ran the cycle" are
//     different answers and the caller is entitled to tell them apart.
//  5. Against the LIVE relay, the route answers. A 404 here is the fault
//     this file was written for.
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const { decideCycle, markCycleStart, markCycleEnd, readCycleMark, minGapMs, DEFAULT_MIN_GAP_MS }
  = await import('../lib/alice-cycle.mjs');
const { findRouteOwner } = await import('../lib/infra-files.mjs');

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const alice = readFileSync(new URL('../alice.mjs', import.meta.url), 'utf8');
const consolidate = readFileSync(new URL('../lib/consolidate.mjs', import.meta.url), 'utf8');

section('the route is wired up');
{
  check('POST /api/alice/tick is registered', /app\.post\('\/api\/alice\/tick'/.test(server));
  check('GET /api/alice/tick is registered', /app\.get\('\/api\/alice\/tick'/.test(server));
  check('it is registered before the catch-all',
    server.indexOf("app.post('/api/alice/tick'") < server.indexOf("req.refusal = req.refusal || 'no-such-route'"));
  check('the route has an owner', findRouteOwner('/api/alice/tick')?.file === 'relay/server.js',
    findRouteOwner('/api/alice/tick'));
  check('the owner is the file the board watches', findRouteOwner('/api/alice/tick')?.file === 'relay/server.js');
}

section('the tick runs Alice\'s own cycle');
{
  // Not a stub, and not a second implementation: the tick is the daemon's
  // cycle, run once, in its own process.
  check('alice.mjs has a --tick mode', /args\.includes\('--tick'\)/.test(alice));
  check('a tick runs the same daemon loop, once',
    /daemonLoop\(\{ once: true, source: 'relay-tick' \}\)/.test(alice));
  check('the tick prints a result the caller can read',
    /__ALICE_TICK__/.test(alice) && /__ALICE_TICK__/.test(server));
  check('the tick runs in its own process', /spawn\(process\.execPath, \[ALICE_TICK_SCRIPT, '--tick'\]/.test(server));
  check('a tick that was not due says so',
    /ran: false/.test(alice) && /not-due/.test(server));
}

section('the two drivers share one ledger');
{
  check('the daemon asks the ledger too', /decideCycle\(\{ source \}\)/.test(alice));
  check('both drivers write to the same ledger', /markCycleStart\(\{ source \}\)/.test(alice));
  check('the relay asks the same ledger', /decideCycle\(\{ source: 'relay-tick' \}\)/.test(server));
  check('the ledger is a module of its own', existsSync(new URL('../lib/alice-cycle.mjs', import.meta.url)));
  check('the client posts to the route', /\/api\/alice\/tick/.test(consolidate));
  check('and it reads the answer, not just the status code',
    /body\.status === 'not-due'/.test(consolidate));
}

section('the ledger decides when a cycle is due');
{
  const dir = mkdtempSync(join(tmpdir(), 'alice-cycle-'));
  const markPath = join(dir, 'alice-cycle.json');
  const now = Date.parse('2026-10-22T05:00:00.000Z');
  const gap = 55 * 60 * 1000;

  try {
    // No mark at all: a cycle is due.
    let d = decideCycle({ now, gapMs: gap, markPath });
    check('with no history a cycle is due', d.run === true, d);

    // A successful cycle 10 minutes ago: NOT due.
    writeFileSync(markPath, JSON.stringify({
      started_at: new Date(now - 10 * 60 * 1000).toISOString(),
      finished_at: new Date(now - 9 * 60 * 1000).toISOString(),
      status: 'done', ok: true, source: 'daemon',
    }));
    d = decideCycle({ now, gapMs: gap, markPath });
    check('a cycle that ran 10 minutes ago is not due again', d.run === false, d);
    check('and it says why', /not due/i.test(d.reason || ''), d.reason);

    // A successful cycle 90 minutes ago: due.
    writeFileSync(markPath, JSON.stringify({
      started_at: new Date(now - 90 * 60 * 1000).toISOString(),
      finished_at: new Date(now - 89 * 60 * 1000).toISOString(),
      status: 'done', ok: true, source: 'daemon',
    }));
    d = decideCycle({ now, gapMs: gap, markPath });
    check('a cycle that ran 90 minutes ago is due again', d.run === true, d);

    // A FAILED cycle: due. A failure is not a stop.
    writeFileSync(markPath, JSON.stringify({
      started_at: new Date(now - 2 * 60 * 1000).toISOString(),
      finished_at: new Date(now - 2 * 60 * 1000).toISOString(),
      status: 'failed', ok: false, source: 'daemon',
    }));
    d = decideCycle({ now, gapMs: gap, markPath });
    check('a failed cycle does not block the next one', d.run === true, d);

    // A cycle that is still running: not due. A relay that restarts every
    // few minutes must not start a storm of cycles.
    markCycleStart({ source: 'daemon', at: new Date(now - 60 * 1000).toISOString(), path: markPath });
    d = decideCycle({ now, gapMs: gap, markPath });
    check('a cycle that is still running blocks another', d.run === false, d);
    check('and it says that too', /still running/i.test(d.reason || ''), d.reason);

    // The ledger records how a cycle ended.
    markCycleEnd({ source: 'relay-tick', ok: true, duration_ms: 1234, cycle: 3, path: markPath });
    const mark = readCycleMark(markPath);
    check('the ending is recorded', mark.status === 'done' && mark.ok === true && mark.duration_ms === 1234, mark);
    check('the source is recorded', mark.source === 'relay-tick', mark.source);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  check('the default gap is just under an hour', DEFAULT_MIN_GAP_MS === 55 * 60 * 1000, DEFAULT_MIN_GAP_MS);
  check('the gap can be set from the environment', minGapMs() === DEFAULT_MIN_GAP_MS, minGapMs());
}

section('against the live relay the route answers');
{
  const BASE = 'http://127.0.0.1:8080';
  let live = false;
  try {
    const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) });
    live = health.ok;
  } catch { live = false; }

  if (!live) {
    console.log('  SKIP  the live relay is not running here');
  } else {
    const post = await fetch(`${BASE}/api/alice/tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const body = await post.json().catch(() => ({}));
    check('POST /api/alice/tick is not a 404', post.status !== 404, post.status);
    check('and it is not a server error either', post.status < 500, post.status);
    check('it answers with a status', typeof body.status === 'string', body);
    check('it says whether a cycle ran', typeof body.ran === 'boolean', body);
    check('and it explains itself', !!(body.reason || body.status === 'started'), body);

    const get = await fetch(`${BASE}/api/alice/tick`, { signal: AbortSignal.timeout(10000) });
    const state = await get.json().catch(() => ({}));
    check('GET /api/alice/tick answers', get.status === 200, get.status);
    check('it carries the ledger', 'last_cycle' in state, Object.keys(state));
    check('and the next time a cycle is due', 'next_due_at' in state, Object.keys(state));
  }
}

console.log(fails === 0
  ? '\n  the tick is wired, it runs Alice\'s own cycle, and the two drivers cannot double-cycle'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
