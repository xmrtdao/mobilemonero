/**
 * relay/lib/share-log.mjs — Append-only heartbeat / share ledger.
 *
 * Why this exists
 * ---------------
 * The fleet heartbeat handler used to overwrite `fleet.agents[agent_id]` on
 * every beat, so at any moment there was exactly one record per agent and
 * history was unrecoverable (Hermes, xmrt-node 6d900e3: "no ledger exists
 * yet"). This is the same bug class as a stored `User.balance`: current state
 * kept, the events that produced it thrown away.
 *
 * This module appends every accepted heartbeat to relay-data/share-log.jsonl,
 * one JSON object per line. Nothing is ever rewritten or deleted.
 *
 * Durability
 * ----------
 * Writes are synchronous (appendFileSync). The supervisor stops this process
 * with `taskkill /F` — TerminateProcess, which delivers no signal and runs no
 * handlers — so a debounced or async write would lose everything buffered.
 * One synchronous append passes the line to the OS in a single call; a forced
 * kill can truncate the file mid-line but cannot lose an acknowledged line.
 * Readers therefore tolerate a torn final line: it is counted and reported,
 * not silently dropped and not fatal.
 *
 * The log records only what the agent actually sent, plus acceptance facts
 * (accepted_at, seq). Fields are allowlisted — request headers and anything
 * else in the request are never written. Credentials must never land here.
 */

import { appendFileSync, existsSync, renameSync, statSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'relay-data');
const SHARE_LOG_FILE = join(DATA_DIR, 'share-log.jsonl');

// Above this size, rotate to share-log-<timestamp>.jsonl and start fresh.
// Keeps the active file small enough that tail reads stay cheap.
const ROTATE_BYTES = 50 * 1024 * 1024;

// Allowlisted heartbeat fields. Everything else in the body is ignored.
const RECORD_FIELDS = [
  'agent_id', 'status', 'name', 'role', 'tunnel_url', 'version',
  'capabilities', 'hashrate', 'device_type', 'metadata',
];

let _seq = 0;            // monotonic, across rotations
let _lines = 0;          // lines in the ACTIVE file
let _bytes = 0;          // bytes in the ACTIVE file
let _lastAcceptedAt = null;
let _failedAppends = 0;  // disk refused a write — surfaced via health()
let _initialized = false;

function initCounters() {
  if (_initialized) return;
  _initialized = true;
  if (!existsSync(SHARE_LOG_FILE)) return;
  try {
    const raw = readFileSync(SHARE_LOG_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (typeof rec.seq === 'number' && rec.seq > _seq) _seq = rec.seq;
        _lines++;
        _lastAcceptedAt = rec.accepted_at || _lastAcceptedAt;
      } catch { /* torn line from a forced kill — counted via bytes only */ }
    }
    _bytes = statSync(SHARE_LOG_FILE).size;
  } catch { /* unreadable file: start from zero rather than refuse beats */ }
}

function rotateIfNeeded() {
  if (_bytes < ROTATE_BYTES) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    renameSync(SHARE_LOG_FILE, join(DATA_DIR, `share-log-${stamp}.jsonl`));
    _lines = 0;
    _bytes = 0;
  } catch {
    // Rotation is best-effort; if it fails keep appending to the same file.
  }
}

/**
 * Append one accepted heartbeat. Returns the acceptance record written.
 * Throws only if the disk write itself failed — callers decide whether a
 * heartbeat without a ledger entry still counts as accepted.
 */
export function appendHeartbeat(body) {
  initCounters();
  const rec = { seq: ++_seq, accepted_at: new Date().toISOString() };
  for (const f of RECORD_FIELDS) {
    if (body[f] !== undefined) rec[f] = body[f];
  }
  const line = JSON.stringify(rec) + '\n';
  rotateIfNeeded();
  appendFileSync(SHARE_LOG_FILE, line, 'utf8');
  _lines++;
  _bytes += Buffer.byteLength(line, 'utf8');
  _lastAcceptedAt = rec.accepted_at;
  return rec;
}

/**
 * Read accepted heartbeats, newest last. Tolerates a torn final line:
 * torn lines are reported in `torn`, never thrown, never silently dropped.
 */
export function readHeartbeats({ agentId = null, limit = 200 } = {}) {
  initCounters();
  if (!existsSync(SHARE_LOG_FILE)) return { records: [], torn: 0, truncated: false };
  const raw = readFileSync(SHARE_LOG_FILE, 'utf8');
  const lines = raw.split('\n');
  const torn = lines.length > 0 && lines[lines.length - 1].trim() !== '' ? 1 : 0;

  const records = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (agentId && rec.agent_id !== agentId) continue;
      records.push(rec);
    } catch { /* torn line — counted above */ }
  }
  const truncated = records.length > limit;
  return { records: records.slice(-limit), torn, truncated };
}

/**
 * Health signal. The log must be observable from the same process that
 * writes it: a ledger the health check cannot see is a ledger nobody can
 * prove exists.
 */
export function health() {
  initCounters();
  return {
    file: 'relay-data/share-log.jsonl',
    lines: _lines,
    bytes: _bytes,
    last_accepted_at: _lastAcceptedAt,
    failed_appends: _failedAppends,
  };
}

/** Record a failed append for the health signal, then rethrow. */
export function recordFailure() {
  _failedAppends++;
}
