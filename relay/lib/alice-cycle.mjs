/**
 * relay/lib/alice-cycle.mjs — the ledger that says when Alice last cycled.
 *
 * WHY THIS EXISTS
 *
 * Alice has two drivers in this system:
 *
 *   - the supervised daemon (relay/alice.mjs --daemon, started by the
 *     supervisor), which cycles every hour;
 *   - the relay's own in-process Alice loop (relay/lib/consolidate.mjs),
 *     which posts to POST /api/alice/tick every hour and at every relay
 *     restart.
 *
 * Before the tick route existed, the second driver's posts were 404s. The
 * moment the route exists and does the work, the second driver becomes a
 * SECOND copy of the same cycle — and the cycle dispatches tasks, parses
 * email, and mails humans when a service is down. Twice an hour is not the
 * same as once an hour.
 *
 * So the two drivers share one ledger. This file is that ledger: a small
 * record of the last cycle, and the one rule that decides whether a cycle is
 * due. Whoever gets there first runs it; the other one is told, plainly, why
 * it did not.
 *
 * THE RULE
 *
 * A cycle may run when:
 *
 *   - no cycle has run yet, or
 *   - the last cycle FAILED (a failure must never block the next attempt), or
 *   - the last cycle started more than the minimum gap ago.
 *
 * The minimum gap is 55 minutes by default — just under the daemon's own
 * hourly interval, so the pair of drivers produces one cycle an hour between
 * them rather than two. It is overridable with ALICE_CYCLE_MIN_GAP_MS.
 *
 * A cycle that is still RUNNING blocks a new one, so a relay that restarts
 * every few minutes cannot start a storm of cycles.
 *
 * THE MARK
 *
 * relay-data/alice-cycle.json. It is written when a cycle starts and updated
 * when it ends, so a reader can tell the difference between "a cycle ran at
 * 05:23" and "a cycle has been running since 05:23".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where the ledger lives: relay-data/alice-cycle.json */
export const CYCLE_MARK_PATH = join(__dirname, '..', '..', 'relay-data', 'alice-cycle.json');

/**
 * The smallest gap between two cycles, in milliseconds.
 *
 * 55 minutes: just under the daemon's hourly interval, so the two drivers
 * together cycle about once an hour. Zero (or a negative number) turns the
 * rule off, which is only sensible when a test or an operator wants a cycle
 * on demand.
 */
export const DEFAULT_MIN_GAP_MS = 55 * 60 * 1000;

/**
 * How long a cycle may be 'running' before the ledger stops believing it.
 * A cycle that died without writing its ending is not a cycle that is still
 * running, and it must not block the next one for ever.
 */
export const RUNNING_STALE_MS = 15 * 60 * 1000;

export function minGapMs() {
  const raw = process.env.ALICE_CYCLE_MIN_GAP_MS;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_GAP_MS;
}

/** The last cycle on record, or null if there has never been one. */
export function readCycleMark(path = CYCLE_MARK_PATH) {
  try {
    if (!existsSync(path)) return null;
    const mark = JSON.parse(readFileSync(path, 'utf8'));
    if (mark && typeof mark === 'object' && !Array.isArray(mark)) return mark;
  } catch { /* an unreadable mark is treated as no mark */ }
  return null;
}

export function writeCycleMark(mark, path = CYCLE_MARK_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(mark, null, 2));
    return true;
  } catch (e) {
    console.warn(`[alice-cycle] could not write ${path}: ${e.message}`);
    return false;
  }
}

function minutesBetween(fromMs, toMs) {
  return Math.max(0, Math.round((toMs - fromMs) / 60000));
}

/**
 * Is a cycle due?
 *
 * Returns { run, reason, last }. `reason` is written for humans: it is the
 * sentence the tick endpoint and Alice's own log will show, so nobody has to
 * guess why a cycle did or did not happen.
 */
export function decideCycle({ source = 'unknown', now = Date.now(), gapMs = minGapMs(), markPath = CYCLE_MARK_PATH } = {}) {
  const mark = readCycleMark(markPath);
  if (!mark || !mark.started_at) {
    return { run: true, reason: 'no cycle has run yet', last: mark };
  }

  const started = Date.parse(mark.started_at);
  if (!Number.isFinite(started)) {
    return { run: true, reason: 'the last cycle left an unreadable mark', last: mark };
  }

  const age = now - started;

  // A cycle that is still running blocks a new one — unless it has been
  // running long enough that it is more likely dead than working.
  if (mark.status === 'running') {
    if (age < RUNNING_STALE_MS) {
      return {
        run: false,
        reason: `a cycle started ${minutesBetween(started, now)} minutes ago and is still running`,
        last: mark,
      };
    }
    return { run: true, reason: 'the last cycle stopped reporting and is treated as dead', last: mark };
  }

  // A failed cycle must not block the next one. That is the difference
  // between a fault and a stop.
  if (mark.ok === false) {
    return { run: true, reason: 'the last cycle failed, so this one runs', last: mark };
  }

  if (age < gapMs) {
    const wait = minutesBetween(now, started + gapMs);
    return {
      run: false,
      reason: `a cycle ran ${minutesBetween(started, now)} minutes ago; the next one is not due for ${wait} more minute(s)`,
      last: mark,
    };
  }

  return { run: true, reason: `the last cycle started ${minutesBetween(started, now)} minutes ago`, last: mark };
}

/** Record that a cycle is starting. */
export function markCycleStart({ source = 'unknown', cycle = null, at = new Date().toISOString(), path = CYCLE_MARK_PATH } = {}) {
  const mark = {
    started_at: at,
    finished_at: null,
    source,
    cycle,
    status: 'running',
    ok: null,
    duration_ms: null,
    summary: null,
  };
  writeCycleMark(mark, path);
  return mark;
}

/** Record how a cycle ended. */
export function markCycleEnd({
  source = 'unknown', ok = false, duration_ms = null, cycle = null, summary = null, error = null,
  at = new Date().toISOString(), path = CYCLE_MARK_PATH,
} = {}) {
  const previous = readCycleMark(path) || {};
  const mark = {
    ...previous,
    started_at: previous.started_at || at,
    finished_at: at,
    source,
    cycle: cycle ?? previous.cycle ?? null,
    status: ok ? 'done' : 'failed',
    ok: !!ok,
    duration_ms,
    error: error || null,
    summary: summary || null,
  };
  writeCycleMark(mark, path);
  return mark;
}

/** When the next cycle is due, or null when one is due now. */
export function nextDueAt({ now = Date.now(), gapMs = minGapMs() } = {}) {
  const mark = readCycleMark();
  if (!mark || !mark.started_at || mark.ok === false) return null;
  const started = Date.parse(mark.started_at);
  if (!Number.isFinite(started)) return null;
  const due = started + gapMs;
  return due > now ? new Date(due).toISOString() : null;
}
