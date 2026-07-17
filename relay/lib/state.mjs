/**
 * relay/lib/state.mjs — Persistent key-value state management
 * 
 * Stores state in relay-data/state.json
 * Thread-safe for single-process relay
 */

import { readFileSync, writeFile, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'relay-data');
const STATE_FILE = join(DATA_DIR, 'state.json');

let _cache = null;
let _dirty = false;
let _writing = false;

function ensureDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (_cache) return _cache;
  ensureDir();
  try {
    if (existsSync(STATE_FILE)) {
      _cache = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error(`[state] Error loading state: ${e.message}`);
  }
  if (!_cache) _cache = {};
  return _cache;
}

function save() {
  if (!_dirty || _writing) return;
  _writing = true;
  _dirty = false;
  ensureDir();
  // Use compact JSON (no indentation) — much faster for 2.7MB
  // Pretty-printing with null,2 was adding ~40ms to the stringify
  let data;
  try { data = JSON.stringify(_cache); } catch (e) { _writing = false; console.error(`[state] JSON.stringify error: ${e.message}`); return; }
  writeFile(STATE_FILE, data, (err) => {
    _writing = false;
    if (err) console.error(`[state] Error saving state: ${err.message}`);
  });
}

// Auto-save every 30 seconds if dirty (was 5s — 2.7MB stringify was too frequent)
setInterval(() => save(), 30000);

// Save on exit (sync — must complete before process exits)
process.on('exit', () => { try { writeFileSync(STATE_FILE, JSON.stringify(_cache)); } catch {} });
process.on('SIGINT', () => { try { writeFileSync(STATE_FILE, JSON.stringify(_cache)); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { writeFileSync(STATE_FILE, JSON.stringify(_cache)); } catch {} process.exit(0); });

/**
 * Get a value from state
 */
export function get(key, defaultValue = undefined) {
  const state = load();
  const keys = key.split('.');
  let current = state;
  for (const k of keys) {
    if (current === undefined || current === null) return defaultValue;
    current = current[k];
  }
  return current !== undefined ? current : defaultValue;
}

/**
 * Set a value in state (deep key support: "mining.lastHashRate")
 */
export function set(key, value) {
  const state = load();
  const keys = key.split('.');
  let current = state;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
  _dirty = true;
}

/**
 * Delete a key from state
 */
export function del(key) {
  const state = load();
  const keys = key.split('.');
  let current = state;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]]) return;
    current = current[keys[i]];
  }
  delete current[keys[keys.length - 1]];
  _dirty = true;
}

/**
 * Check if a key exists
 */
export function has(key) {
  return get(key) !== undefined;
}

/**
 * Get all keys (top-level)
 */
export function keys() {
  return Object.keys(load());
}

/**
 * Get entire state snapshot
 */
export function all() {
  return { ...load() };
}

/**
 * Clear all state
 */
export function clear() {
  _cache = {};
  _dirty = true;
  save();
}

/**
 * Increment a numeric value
 */
export function incr(key, by = 1) {
  const current = get(key, 0);
  set(key, (typeof current === 'number' ? current : 0) + by);
  return get(key);
}

/**
 * Push to an array
 */
export function push(key, value) {
  const arr = get(key, []);
  if (!Array.isArray(arr)) throw new Error(`Key "${key}" is not an array`);
  arr.push(value);
  set(key, arr);
}

/**
 * Force save to disk immediately
 */
export function flush() {
  save();
}

export default { get, set, del, has, keys, all, clear, incr, push, flush };
