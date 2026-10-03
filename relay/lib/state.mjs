/**
 * relay/lib/state.mjs — Persistent key-value state management
 * 
 * Stores state in relay-data/state.json
 * Thread-safe for single-process relay
 * Uses async writes with debounce to avoid event loop blocking.
 */

import { readFileSync, writeFile, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'relay-data');
const STATE_FILE = join(DATA_DIR, 'state.json');

let _cache = null;
let _dirty = false;
let _writing = false;
let _saveTimer = null;

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

/**
 * Trim ephemeral keys to keep state.json small and saves fast.
 * Called before every write.
 */
function trimCache() {
  if (!_cache) return;
  // Keep fleet chat to last 2000 messages (was 50 — caused context loss on restart)
  if (Array.isArray(_cache['fleet-chat-history'])) {
    _cache['fleet-chat-history'] = _cache['fleet-chat-history'].slice(-2000);
  }
  // Trim activity log (was 50 — caused audit trail loss)
  if (Array.isArray(_cache.activityLog)) {
    _cache.activityLog = _cache.activityLog.slice(-500);
  }
  // Trim email inboxes — both flat arrays and nested object-of-arrays
  for (const key of Object.keys(_cache)) {
    if (key.includes('inbox') || key.includes('email')) {
      if (Array.isArray(_cache[key])) {
        // Flat array inbox: trim to 100, strip html to save space
        _cache[key] = _cache[key].slice(-100).map(stripEmailHtml);
      } else if (typeof _cache[key] === 'object' && _cache[key] !== null) {
        // Object-type inbox (e.g. {pfp: [...], mobilemonero: [...], ...}):
        // trim each sub-array to 100 items and strip html
        // Also handle deeper nesting: {inbox: {pfp: [...], ...}}
        const obj = _cache[key];
        for (const subKey of Object.keys(obj)) {
          if (Array.isArray(obj[subKey])) {
            obj[subKey] = obj[subKey].slice(-50).map(stripEmailHtml);
          } else if (typeof obj[subKey] === 'object' && obj[subKey] !== null) {
            // One more level (e.g. email.inbox.pfp)
            for (const subSubKey of Object.keys(obj[subKey])) {
              if (Array.isArray(obj[subKey][subSubKey])) {
                obj[subKey][subSubKey] = obj[subKey][subSubKey].slice(-50).map(stripEmailHtml);
              }
            }
          }
        }
      }
    }
  }
  // Hard cap: if JSON.stringify exceeds 500KB, strip all inbox/email keys
  const approxSize = JSON.stringify(_cache).length;
  if (approxSize > 500000) {
    for (const key of Object.keys(_cache)) {
      if (key.includes('inbox') || key.includes('email') || key.includes('history')) {
        delete _cache[key];
      }
    }
  }
}

/** Strip html field from email entries — saves ~80% space, text is sufficient for agents */
function stripEmailHtml(entry) {
  if (entry && typeof entry === 'object') {
    const { html, ...rest } = entry;
    return rest;
  }
  return entry;
}

/**
 * Debounced async save. Only one write at a time.
 * Trims cache before writing to keep file small.
 * Uses setImmediate to avoid blocking the event loop on JSON.stringify.
 */
async function save() {
  if (!_dirty || _writing) return;
  _writing = true;
  _dirty = false;
  ensureDir();
  trimCache();
  // Defer the heavy work to next tick so the current request can respond
  await new Promise(resolve => setImmediate(resolve));
  try {
    const data = JSON.stringify(_cache);
    await new Promise((resolve, reject) => {
      writeFile(STATE_FILE, data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (e) {
    console.error(`[state] Error saving state: ${e.message}`);
  } finally {
    _writing = false;
  }
}

// Debounced auto-save — coalesces rapid writes into one
function scheduleSave() {
  _dirty = true;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; save(); }, 2000);
}

// Auto-save every 30s as fallback
setInterval(() => { if (_dirty) save(); }, 30000);

// Save on exit (sync — must complete before process exits)
process.on('exit', () => { try { writeFileSync(STATE_FILE, JSON.stringify(_cache)); } catch {} });
process.on('SIGINT', () => { try { writeFileSync(STATE_FILE, JSON.stringify(_cache)); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { writeFileSync(STATE_FILE, JSON.stringify(_cache)); } catch {} process.exit(0); });

// ── Public API ──

export function get(key, def = null) {
  const c = load();
  return c[key] !== undefined ? c[key] : def;
}

export function set(key, val) {
  const c = load();
  c[key] = val;
  scheduleSave();
}

export function del(key) {
  const c = load();
  delete c[key];
  scheduleSave();
}

export function push(key, val) {
  const c = load();
  if (!Array.isArray(c[key])) c[key] = [];
  c[key].push(val);
  scheduleSave();
}

export function getAll() {
  return load();
}

export function keys() {
  return Object.keys(load());
}

export function flush() {
  return save();
}
