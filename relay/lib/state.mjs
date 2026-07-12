/**
 * relay/lib/state.mjs — Persistent key-value state management
 * 
 * Stores state in relay-data/state.json
 * Thread-safe for single-process relay
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'relay-data');
const STATE_FILE = join(DATA_DIR, 'state.json');

let _cache = null;
let _dirty = false;

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
  if (!_dirty) return;
  ensureDir();
  try {
    writeFileSync(STATE_FILE, JSON.stringify(_cache, null, 2));
    _dirty = false;
  } catch (e) {
    console.error(`[state] Error saving state: ${e.message}`);
  }
}

// Auto-save every 5 seconds if dirty
setInterval(() => save(), 5000);

// Save on exit
process.on('exit', () => save());
process.on('SIGINT', () => { save(); process.exit(0); });
process.on('SIGTERM', () => { save(); process.exit(0); });

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
