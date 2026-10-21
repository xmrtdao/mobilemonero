/**
 * relay/lib/opencode-lock.mjs — ONE agent at a time on this machine.
 *
 * The OpenCode harness is the one part of the stack that is not just HTTP to
 * somewhere else: it is a node process, with a model provider behind it and
 * a tool-calling loop that will read files, run commands and hold a session
 * open for a minute at a time. This box has 8GB and the stack already has
 * most of it.
 *
 * So the rule is simple and it is enforced here, not hoped for: ONE agent
 * may use OpenCode at a time. A second caller does not queue behind the first
 * - queueing is how two sessions end up running at once anyway, one cycle
 * later - it says so and stands down, and the work is picked up next time.
 *
 * The lock is a file, taken with an exclusive create, so it works across
 * processes and across runtimes (the executor is Deno, the inbox daemon is
 * Node) without either of them having to trust the other's memory.
 *
 * It expires. A worker that dies holding the lock - killed, crashed, the
 * machine rebooted - must not keep every other agent out forever, so a lock
 * older than the stale window is taken over rather than obeyed.
 */
import {
  openSync, writeFileSync, closeSync, readFileSync, unlinkSync,
  mkdirSync, existsSync, statSync,
} from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_STALE_MS = 10 * 60 * 1000;

/** Who holds the lock, and for how long. */
export function opencodeLockState(lockPath) {
  try {
    if (!existsSync(lockPath)) return { held: false, holder: null, ageMs: 0 };
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    let holder = 'unknown';
    let startedAt = null;
    try {
      const j = JSON.parse(readFileSync(lockPath, 'utf8'));
      holder = j.holder || 'unknown';
      startedAt = j.at || null;
    } catch { /* a lock file we cannot read is still a lock */ }
    return { held: true, holder, startedAt, ageMs };
  } catch {
    return { held: false, holder: null, ageMs: 0 };
  }
}

/**
 * Take the lock, or say who has it.
 *
 * @returns {{ok:true, release:()=>void} | {ok:false, holder:string, ageMs:number}}
 */
export function acquireOpencodeLock(lockPath, { label = 'agent', staleMs = DEFAULT_STALE_MS } = {}) {
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* it exists */ }

  // Two attempts: one to take it, and one more in case the holder released
  // it between our attempt and our check.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');   // exclusive: fails if it exists
      writeFileSync(fd, JSON.stringify({
        holder: label,
        pid: typeof process !== 'undefined' ? process.pid : null,
        at: new Date().toISOString(),
      }));
      closeSync(fd);
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          try { unlinkSync(lockPath); } catch { /* already gone */ }
        },
      };
    } catch (e) {
      const state = opencodeLockState(lockPath);
      if (!state.held) continue;                 // it went away; try again
      if (state.ageMs > staleMs) {
        // The holder died without letting go. Take it over, and say so.
        try { unlinkSync(lockPath); } catch { /* someone else got there first */ }
        continue;
      }
      return { ok: false, holder: state.holder, ageMs: state.ageMs };
    }
  }
  return { ok: false, holder: 'unknown', ageMs: 0 };
}

export default { acquireOpencodeLock, opencodeLockState };
