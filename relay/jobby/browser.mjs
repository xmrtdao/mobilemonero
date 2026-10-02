// Keeping the page agent alive, so Jobby is not intermittently useless.
//
// The page agent drives the user's own Chrome through an extension. That is the
// right design - no credentials, the user can see and intervene - but it has a
// failure mode that a self-hosted headless browser would not have:
//
//   Chrome suspends an MV3 service worker after roughly thirty seconds idle,
//   which drops the extension's WebSocket to the hub. The worker wakes on its
//   own a moment later, so `connected` flips back to true by itself. A task
//   dispatched into that window failed with "Hub disconnected while task was
//   running" while the browser was open and perfectly healthy.
//
// So this module distinguishes three different things that all present to Jobby
// as "the browser is not available", and handles each differently:
//
//   1. The hub process is not listening      -> queue a supervisor restart
//   2. The hub is up, extension not attached -> wait, it reattaches on its own
//   3. Attached, but the socket dies mid-run -> the caller's problem; it retries
//
// The diagnosis is returned rather than swallowed, because "I could not reach the
// browser" and "your browser is closed" call for completely different actions
// from the person reading them.
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'relay-data');
const HUB_URL = 'http://127.0.0.1:38401';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One status read. Never throws; a dead hub is a status, not an exception. */
export async function hubStatus(timeoutMs = 6000) {
  try {
    const res = await fetch(`${HUB_URL}/api/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { reachable: false, connected: false, status: res.status, generation: null };
    }
    const body = await res.json();
    return {
      reachable: true,
      connected: body.connected === true,
      busy: body.busy === true,
      // Null when the hub predates the generation counter, which is treated as
      // "changed" so a stale-socket retry is still attempted.
      generation: typeof body.generation === 'number' ? body.generation : null,
    };
  } catch (err) {
    return { reachable: false, connected: false, error: String(err.message || err), generation: null };
  }
}

/**
 * Wait for a *different* connection to the one that just failed.
 *
 * Waiting for `connected` is not enough on its own. After Chrome suspends the
 * extension's service worker, the hub's socket can keep reporting OPEN while
 * nothing is on the other end, so a wait keyed on readiness returns instantly
 * and the retry goes into the same corpse. Keying on the connection generation
 * is what makes the wait mean something.
 *
 * Returns the fresh status, or the last one seen if none arrived in time.
 */
export async function waitForFreshConnection(previousGeneration, timeoutMs = 25000) {
  const until = Date.now() + timeoutMs;
  let last = await hubStatus();
  // A hub without the counter cannot prove freshness, so one poll is all we can do.
  if (last.generation === null) {
    await sleep(2000);
    return hubStatus();
  }
  while (Date.now() < until) {
    await sleep(1500);
    last = await hubStatus();
    if (last.connected && last.generation !== previousGeneration) return last;
  }
  return last;
}

/**
 * Open the Page Agent launcher in the user's default browser.
 *
 * This is the step that actually reconnects the extension, and it is also the
 * honest thing to do: a tab appears showing what the agent is, so the user can
 * see it happened and close it. Silent retries behind their back would be worse
 * than a visible window. Failure is not fatal - the caller falls back to
 * telling the user what to click.
 */
function openLauncher() {
  try {
    const url = HUB_URL.replace('127.0.0.1', 'localhost');
    if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', url], { timeout: 8000, windowsHide: true });
    } else if (process.platform === 'darwin') {
      execFile('open', [url], { timeout: 8000 });
    } else {
      execFile('xdg-open', [url], { timeout: 8000 });
    }
    return true;
  } catch {
    return false;
  }
}

/** Public alias: the apply path reopens the launcher when a socket turns out to be stale. */
export function reopenLauncher() {
  return openLauncher();
}

/** Ask the supervisor to restart a supervised service. */
function queueServiceAction(action, service, requestedBy) {  const queueFile = join(DATA_DIR, 'service-actions.json');
  let queue = [];
  try {
    if (existsSync(queueFile)) queue = JSON.parse(readFileSync(queueFile, 'utf8'));
    if (!Array.isArray(queue)) queue = [];
  } catch { queue = []; }
  // Do not stack duplicate restarts: the supervisor drains this file and a pile
  // of identical entries just restarts the same thing several times in a row.
  const already = queue.some(
    (item) => item && item.service === service && item.action === action
      && Date.now() - Number(item.requestedAt || 0) < 60000,
  );
  if (already) return false;
  queue.push({ action, service, requestedBy, requestedAt: Date.now() });
  writeFileSync(queueFile, JSON.stringify(queue, null, 2));
  return true;
}

/**
 * Get the page agent into a usable state, or explain precisely why it cannot.
 *
 * Returns `{ ok: true, recovered }` when a task can be dispatched, and
 * `{ ok: false, reason, advice }` when it cannot. `reason` is a stable token so
 * callers can branch on it and so the same condition is not described three
 * different ways in three different places.
 */
export async function ensurePageAgent({ requestedBy = 'jobby', restartWaitMs = 25000 } = {}) {
  let status = await hubStatus();

  if (!status.reachable) {
    // The hub process itself is gone. Nothing the extension does will help, so
    // the service has to come back before anything else is worth trying.
    const queued = queueServiceAction('restart', 'page-agent-mcp', requestedBy);
    const until = Date.now() + restartWaitMs;
    while (Date.now() < until) {
      await sleep(2500);
      status = await hubStatus();
      if (status.reachable) break;
    }
    if (status.reachable) {
      return { ok: true, recovered: 'restarted the page agent hub', status };
    }
    return {
      ok: false,
      reason: 'hub_not_running',
      advice: queued
        ? 'I asked the supervisor to restart the page agent and it did not come back. '
          + 'Check that the page-agent-mcp process is allowed to start.'
        : 'The page agent is not running and a restart is already queued. '
          + 'Give it a moment, then ask me again.',
    };
  }

  if (!status.connected) {
    // The hub is healthy but nothing is attached. The extension connects when
    // the launcher page loads - it does not retry on its own after the hub
    // restarts, because its socket simply points at a server that was gone. So
    // the fix is to open that page, which also gives the user visible
    // confirmation that something happened rather than a silent wait.
    const opened = openLauncher();
    const until = Date.now() + restartWaitMs;
    while (Date.now() < until) {
      await sleep(1500);
      status = await hubStatus();
      if (status.connected) {
        return {
          ok: true,
          recovered: opened
            ? 'reopened the Page Agent launcher in your browser to reconnect it'
            : 'waited for the browser extension to reattach',
          status,
        };
      }
    }
    return {
      ok: false,
      reason: 'extension_not_attached',
      advice: opened
        ? 'I reopened the Page Agent launcher in your browser but the extension still '
          + 'has not connected. Check that the Page Agent extension is enabled in '
          + 'Chrome, then ask me again. Nothing was submitted.'
        : 'Chrome is running but the Page Agent extension is not connected to it. '
          + 'Open the Page Agent launcher page in Chrome, or click the extension icon '
          + 'once, then ask me again. Nothing was submitted.',
    };
  }

  if (status.busy) {
    return {
      ok: false,
      reason: 'busy',
      advice: 'The page agent is already working on something. Wait for it to finish, '
        + 'then ask me again. Nothing was submitted.',
    };
  }

  return { ok: true, recovered: null, status };
}

/** A plain description of the current state, for the agent panel and for Jobby. */
export async function describePageAgent() {
  const status = await hubStatus();
  if (!status.reachable) {
    return {
      ready: false,
      reason: 'hub_not_running',
      detail: 'The page agent process is not running.',
      fix: 'I can restart it - say so and I will.',
    };
  }
  if (!status.connected) {
    return {
      ready: false,
      reason: 'extension_not_attached',
      detail: 'Chrome is up but the Page Agent extension has not connected.',
      fix: 'Open the Page Agent launcher in Chrome, then ask me again.',
    };
  }
  return {
    ready: true,
    busy: status.busy === true,
    detail: status.busy
      ? 'Connected, and working on a task right now.'
      : 'Connected and ready. I can fill in and submit applications in your browser.',
  };
}
