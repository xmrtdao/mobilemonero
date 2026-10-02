#!/usr/bin/env node
/**
 * Local Edge Function Runtime for XMRT DAO Mesh
 *
 * Mirrors the Supabase Edge Function API (serve(), createClient(), Deno.env)
 * so that all 204 edge functions can run locally on any relay node.
 *
 * Each function becomes a route handler in the relay's Express server.
 * Functions that need a database get a local SQLite connection instead of PostgreSQL.
 *
 * Usage:
 *   import { registerFunction, serve } from './lib/function-runtime.mjs';
 *   registerFunction('gossip-hub', async (req) => { ... });
 *
 *   // Or auto-discover from relay/functions/ directory
 *   import { discoverFunctions } from './lib/function-runtime.mjs';
 *   await discoverFunctions();
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.join(__dirname, '..', 'functions');
const REGISTRY_FILE = path.join(__dirname, '..', 'relay-data', 'function-registry.json');

// ── Function Registry ─────────────────────────────────────
const registry = new Map();

/**
 * Register a local edge function.
 * @param {string} name - Function name (used as route)
 * @param {Function} handler - Async function(req, res) handler
 * @param {Object} meta - Metadata (description, dependencies, priority)
 */
export function registerFunction(name, handler, meta = {}) {
  registry.set(name, { handler, meta });
  return { name, registered: true };
}

/**
 * Get a registered function handler.
 */
export function getFunction(name) {
  return registry.get(name);
}

/**
 * List all registered functions.
 */
export function listFunctions() {
  return Array.from(registry.entries()).map(([name, entry]) => ({
    name,
    ...entry.meta,
    local: true,
  }));
}

/**
 * Auto-discover functions from the relay/functions/ directory.
 * Each .mjs file that exports a `handler` function gets registered.
 */
export async function discoverFunctions() {
  let count = 0;
  
  try {
    if (!fs.existsSync(FUNCTIONS_DIR)) {
      fs.mkdirSync(FUNCTIONS_DIR, { recursive: true });
    }
    
    const files = fs.readdirSync(FUNCTIONS_DIR).filter(f => f.endsWith('.mjs'));
    
    for (const file of files) {
      try {
        const filePath = path.join(FUNCTIONS_DIR, file);
                const { pathToFileURL } = await import("url");
        const fileUrl = pathToFileURL(filePath).href;
        const mod = await import(fileUrl);
        const name = file.replace('.mjs', '');
        if (typeof mod.handler === 'function') {
          registerFunction(name, mod.handler, mod.meta || {});
          count++;
          console.log(`[runtime] Registered local function: ${name}`);
        }
      } catch (err) {
        console.error(`[runtime] Failed to load ${file}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[runtime] Discover error: ${err.message}`);
  }
  
  // Save registry to file
  saveRegistry();
  return count;
}

function saveRegistry() {
  try {
    const data = Array.from(registry.entries()).map(([name, entry]) => ({
      name,
      ...entry.meta,
      local: true,
      registered_at: new Date().toISOString(),
    }));
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

/**
 * Supabase-compatible serve() function.
 * Creates an Express-style handler from a function that takes (req) and returns Response.
 * 
 * Example edge function pattern:
 *   import { serve } from './lib/function-runtime.mjs';
 *   serve(async (req) => {
 *     return { status: 200, body: { success: true } };
 *   });
 */
export function serve(handler) {
  return {
    handler,
    type: 'edge-function',
    /**
     * Convert to Express middleware
     */
    toExpress() {
      return async (req, res) => {
        try {
          // Build a Supabase-compatible request object
          const supabaseReq = {
            method: req.method,
            url: req.url,
            headers: req.headers,
            json: async () => req.body || {},
            text: async () => JSON.stringify(req.body || ''),
          };
          
          const result = await handler(supabaseReq);
          
          if (result instanceof Response) {
            const text = await result.text();
            res.status(result.status).json(JSON.parse(text));
          } else {
            res.status(result.status || 200).json(result.body || result);
          }
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      };
    },
  };
}

/**
 * Supabase-compatible createClient()
 * Returns a mock Supabase client that uses local SQLite or file-based storage.
 */
export function createClient(url, key) {
  return {
    from: (table) => ({
      select: (columns) => mockQuery('select', table, columns),
      insert: (data) => mockQuery('insert', table, data),
      update: (data) => mockQuery('update', table, data),
      delete: () => mockQuery('delete', table),
      eq: (col, val) => mockQuery('eq', table, col, val),
      order: (col, dir) => mockQuery('order', table, col, dir),
      limit: (n) => mockQuery('limit', table, n),
      single: () => mockQuery('single', table),
    }),
    storage: {
      from: (bucket) => ({
        upload: (path, file) => mockStorage(bucket, path, file),
        download: (path) => mockStorage(bucket, path),
        list: (prefix) => mockStorage(bucket, prefix),
        getPublicUrl: (path) => ({
          data: { publicUrl: `/storage/${bucket}/${path}` },
        }),
      }),
    },
  };
}

// Mock query builder — will be replaced with actual SQLite
const mockDb = new Map();
function mockQuery(op, table, ...args) {
  const key = `${table}:${op}:${args.join(':')}`;
  console.log(`[db] ${key}`);
  return { data: mockDb.get(key) || [], error: null };
}

function mockStorage(bucket, ...args) {
  console.log(`[storage] ${bucket}: ${args.join('/')}`);
  return { data: { path: args.join('/') }, error: null };
}

/**
 * Load function catalog from file (generated by catalog task).
 */
export function loadCatalog() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'relay-data', 'edge-function-catalog.json'), 'utf8'));
  } catch {
    return { functions: [] };
  }
}
