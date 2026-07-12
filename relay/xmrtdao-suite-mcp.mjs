#!/usr/bin/env node
/**
 * xmrtdao-suite-mcp.mjs — XMRT DAO Suite Cloud Redundancy MCP Server
 *
 * Provides cloud backup access to the XMRT DAO stack via Supabase Postgres.
 * Mirrors the local relay's database tables (port 5432 / Express 8080).
 *
 * Supabase project:  kpqtadxqxnhkpqbgelhf
 * Supabase URL:       https://kpqtadxqxnhkpqbgelhf.supabase.co
 * Connection string:  postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
 *
 * Usage:
 *   node xmrtdao-suite-mcp.mjs                    # stdio transport (default for MCP)
 *   node xmrtdao-suite-mcp.mjs --http             # HTTP transport on port 3200
 *   node xmrtdao-suite-mcp.mjs --http --port 3201 # custom port
 *
 * MCP config for Claude Desktop / Hermes:
 *   {
 *     "mcpServers": {
 *       "xmrtdao-suite": {
 *         "command": "node",
 *         "args": ["C:\\Users\\PureTrek\\Desktop\\xmrtdao\\relay\\xmrtdao-suite-mcp.mjs"]
 *       }
 *     }
 *   }
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env (relay/.env) ──────────────────────────────────────
function loadEnv() {
  const envPath = join(__dirname, '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
}
loadEnv();

// ── Supabase Configuration ──────────────────────────────────────
const SUPABASE_URL     = 'https://kpqtadxqxnhkpqbgelhf.supabase.co';
const SUPABASE_REF     = 'kpqtadxqxnhkpqbgelhf';
const SUPABASE_REGION  = 'aws-0-us-east-1';
const SUPABASE_DB_HOST = `${SUPABASE_REGION}.pooler.supabase.com`;
const SUPABASE_DB_PORT = process.env.SUPABASE_DB_PORT || 6543;
const SUPABASE_DB_USER = process.env.SUPABASE_DB_USER || `postgres.${SUPABASE_REF}`;
const SUPABASE_DB_NAME = process.env.SUPABASE_DB_NAME || 'postgres';
const SUPABASE_DB_PASS = process.env.SUPABASE_DB_PASS || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_aziEtQaD16O6l3W2Esl_YA_07LDlAMJ';

const SUPABASE_DB_PASS_REAL = process.env.SUPABASE_DB_PASS_REAL || 'XmrtDao2026Suite!Redundancy';
const CONNECTION_STRING = process.env.SUPABASE_DATABASE_URL ||
  `postgresql://${SUPABASE_DB_USER}:${encodeURIComponent(SUPABASE_DB_PASS_REAL)}@${SUPABASE_DB_HOST}:${SUPABASE_DB_PORT}/${SUPABASE_DB_NAME}`;

// ── DB Connection (pg Pool) ─────────────────────────────────────
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  max: 3,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: { rejectUnauthorized: false },
});

async function dbQuery(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

async function dbResult(sql, params = []) {
  const res = await pool.query(sql, params);
  return { rowCount: res.rowCount, rows: res.rows };
}

// ── MCP Protocol Helpers ────────────────────────────────────────
let requestId = 0;

function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function mcpResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

// ── Allowed suite tables for insert/update ─────────────────────
const SUITE_TABLES = [
  'suite_companies',
  'suite_leads',
  'suite_campaigns',
  'suite_email_activity',
  'suite_users',
  'suite_pipeline_stages',
  'suite_activity_log',
  'pfp_service_packages',
  'pfp_add_ons',
  'pfp_bookings',
  'pfp_booking_add_ons',
  'pfp_events',
  'pfp_payments',
  'hb_properties',
  'hb_contracts',
  'hb_showings',
  'hb_listings',
  'hb_offers',
  'suite_lead_sharing_rules',
];

// ── Tool Definitions ────────────────────────────────────────────
const TOOLS = {

  // ════════════════════════════════════════════════════════════
  // 1. suite_query — Read-only SQL
  // ════════════════════════════════════════════════════════════
  suite_query: {
    name: 'suite_query',
    description: 'Run a read-only SQL query against the cloud Supabase Postgres (XMRT DAO Suite). Only SELECT/WITH/EXPLAIN queries are allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL query (SELECT/WITH/EXPLAIN only)' },
        params: { type: 'array', items: {}, description: 'Parameter values for $1, $2, ...' },
        limit: { type: 'number', description: 'Max rows to return (default 100, max 500)' },
      },
      required: ['sql'],
    },
    handler: async (args) => {
      const { sql, params = [], limit = 100 } = args;
      const trimmed = sql.trim();
      const upper = trimmed.toUpperCase();
      if (!upper.startsWith('SELECT') && !upper.startsWith('WITH') && !upper.startsWith('EXPLAIN')) {
        return { error: 'Only SELECT / WITH / EXPLAIN queries are allowed for suite_query' };
      }
      const rowLimit = Math.min(limit, 500);
      const finalSql = upper.startsWith('SELECT') && !upper.includes('LIMIT')
        ? `${trimmed.replace(/;$/, '')} LIMIT ${rowLimit}`
        : trimmed.replace(/;$/, '');
      const rows = await dbQuery(finalSql, params);
      return { rows, rowCount: rows.length };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 2. suite_insert — Insert rows
  // ════════════════════════════════════════════════════════════
  suite_insert: {
    name: 'suite_insert',
    description: 'Insert a row into a suite table (suite_companies, suite_leads, suite_campaigns, suite_email_activity, suite_users, suite_pipeline_stages, suite_activity_log). Pass a columns object with column names → values.',
    inputSchema: {
      type: 'object',
      properties: {
        table:  { type: 'string', enum: SUITE_TABLES, description: 'Target table name' },
        values: { type: 'object', description: 'Column → value map (e.g. { "name": "Acme", "industry": "tech" })' },
      },
      required: ['table', 'values'],
    },
    handler: async (args) => {
      const { table, values } = args;
      if (!SUITE_TABLES.includes(table)) return { error: `Table "${table}" not in allowed list` };
      const cols = Object.keys(values);
      if (!cols.length) return { error: 'No columns provided' };
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `INSERT INTO public.${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`;
      const params = cols.map(c => {
        const v = values[c];
        if (v !== null && typeof v === 'object') return JSON.stringify(v);
        return v;
      });
      const rows = await dbQuery(sql, params);
      return { success: true, inserted: rows[0] || null };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 3. suite_update — Update rows by table + id
  // ════════════════════════════════════════════════════════════
  suite_update: {
    name: 'suite_update',
    description: 'Update rows in a suite table by table name + id (text or numeric). Pass a values object with column names → new values.',
    inputSchema: {
      type: 'object',
      properties: {
        table:   { type: 'string', enum: SUITE_TABLES, description: 'Target table name' },
        id:      { description: 'Row id (text for suite_companies, int for others)' },
        values:  { type: 'object', description: 'Column → new value map' },
      },
      required: ['table', 'id', 'values'],
    },
    handler: async (args) => {
      const { table, id, values } = args;
      if (!SUITE_TABLES.includes(table)) return { error: `Table "${table}" not in allowed list` };
      const cols = Object.keys(values);
      if (!cols.length) return { error: 'No columns provided' };
      const setClauses = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const params = cols.map(c => {
        const v = values[c];
        if (v !== null && typeof v === 'object') return JSON.stringify(v);
        return v;
      });
      params.push(id);
      const sql = `UPDATE public.${table} SET ${setClauses}, updated_at = now() WHERE id = $${params.length} RETURNING *`;
      const rows = await dbQuery(sql, params);
      return { success: true, updated: rows[0] || null };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 4. fleet_memory_write — Write fleet memory entry
  // ════════════════════════════════════════════════════════════
  fleet_memory_write: {
    name: 'fleet_memory_write',
    description: 'Write a memory entry to the fleet_memory table. Stores agent observations, decisions, and context for the fleet.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id:    { type: 'string', description: 'Agent identifier' },
        agent_role:  { type: 'string', description: 'Agent role (default: observer)' },
        memory_type: { type: 'string', description: 'Memory type (e.g., observation, decision, context, reflection)' },
        scope:       { type: 'string', description: 'Memory scope (default: fleet)' },
        title:       { type: 'string', description: 'Short title' },
        body:        { type: 'string', description: 'Memory body text' },
        payload:     { type: 'object', description: 'Structured payload (default: {})' },
        confidence:  { type: 'number', description: 'Confidence 0-1 (default: 1.0)' },
        refs:        { type: 'array', items: {}, description: 'References array (default: [])' },
        ttl_at:      { type: 'string', description: 'Optional TTL timestamp (ISO-8601)' },
      },
      required: ['agent_id', 'memory_type', 'title', 'body'],
    },
    handler: async (args) => {
      const { agent_id, agent_role = 'observer', memory_type, scope = 'fleet',
              title, body, payload = {}, confidence = 1.0, refs = [], ttl_at } = args;
      const rows = await dbQuery(
        `INSERT INTO public.fleet_memory
           (agent_id, agent_role, memory_type, scope, title, body, payload, refs, confidence, ttl_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, agent_id, title, created_at`,
        [agent_id, agent_role, memory_type, scope, title, body,
         JSON.stringify(payload), JSON.stringify(refs), confidence, ttl_at || null]
      );
      return { success: true, memory: rows[0] };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 5. fleet_memory_read — Read recent fleet memory
  // ════════════════════════════════════════════════════════════
  fleet_memory_read: {
    name: 'fleet_memory_read',
    description: 'Read recent fleet_memory entries. Optionally filter by agent_id, scope, or memory_type.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id:    { type: 'string', description: 'Filter by agent_id' },
        scope:       { type: 'string', description: 'Filter by scope (e.g., fleet, project)' },
        memory_type: { type: 'string', description: 'Filter by memory_type' },
        limit:       { type: 'number', description: 'Max rows (default 50, max 200)' },
      },
    },
    handler: async (args) => {
      const { agent_id, scope, memory_type, limit = 50 } = args;
      const rowLimit = Math.min(limit, 200);
      let sql = 'SELECT id, agent_id, agent_role, memory_type, scope, title, body, payload, refs, confidence, created_at, updated_at FROM public.fleet_memory WHERE 1=1';
      const params = [];
      let idx = 1;
      if (agent_id)    { sql += ` AND agent_id = $${idx++}`;   params.push(agent_id); }
      if (scope)       { sql += ` AND scope = $${idx++}`;      params.push(scope); }
      if (memory_type) { sql += ` AND memory_type = $${idx++}`; params.push(memory_type); }
      sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
      params.push(rowLimit);
      const rows = await dbQuery(sql, params);
      return { entries: rows, count: rows.length };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 6. inbox_messages — List inbox messages
  // ════════════════════════════════════════════════════════════
  inbox_messages: {
    name: 'inbox_messages',
    description: 'List inbox_messages. Filter by channel, is_read status, and limit.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Filter by channel (e.g., internal, email)' },
        is_read: { type: 'boolean', description: 'Filter by read status' },
        limit:   { type: 'number', description: 'Max rows (default 50, max 200)' },
      },
    },
    handler: async (args) => {
      const { channel, is_read, limit = 50 } = args;
      const rowLimit = Math.min(limit, 200);
      let sql = 'SELECT * FROM public.inbox_messages WHERE 1=1';
      const params = [];
      let idx = 1;
      if (channel)  { sql += ` AND channel = $${idx++}`;  params.push(channel); }
      if (is_read !== undefined && is_read !== null) { sql += ` AND is_read = $${idx++}`; params.push(is_read); }
      sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
      params.push(rowLimit);
      const rows = await dbQuery(sql, params);
      return { messages: rows, count: rows.length };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 7. inbox_write — Write inbox message
  // ════════════════════════════════════════════════════════════
  inbox_write: {
    name: 'inbox_write',
    description: 'Write a message to the inbox_messages table.',
    inputSchema: {
      type: 'object',
      properties: {
        user_id:    { type: 'string', description: 'User UUID (required)' },
        title:      { type: 'string', description: 'Message title' },
        content:    { type: 'string', description: 'Message content' },
        type:       { type: 'string', description: 'Message type (default: system)' },
        channel:    { type: 'string', description: 'Channel (default: internal)' },
        agent_name: { type: 'string', description: 'Agent name (optional)' },
        priority:   { type: 'number', description: 'Priority 0-5 (default: 2)' },
        action_url: { type: 'string', description: 'Action URL (optional)' },
        metadata:   { type: 'object', description: 'Metadata (default: {})' },
      },
      required: ['user_id', 'title', 'content'],
    },
    handler: async (args) => {
      const { user_id, title, content, type = 'system', channel = 'internal',
              agent_name, priority = 2, action_url, metadata = {} } = args;
      const rows = await dbQuery(
        `INSERT INTO public.inbox_messages
           (user_id, title, content, type, channel, agent_name, priority, action_url, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, title, created_at`,
        [user_id, title, content, type, channel, agent_name || null,
         priority, action_url || null, JSON.stringify(metadata)]
      );
      return { success: true, message: rows[0] };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 8. tasks_list — List tasks
  // ════════════════════════════════════════════════════════════
  tasks_list: {
    name: 'tasks_list',
    description: 'List tasks from the tasks table. Filter by status and/or assignee_agent_id.',
    inputSchema: {
      type: 'object',
      properties: {
        status:      { type: 'string', description: 'Filter by status (e.g., PENDING, IN_PROGRESS, DONE)' },
        assignee:    { type: 'string', description: 'Filter by assignee_agent_id' },
        limit:       { type: 'number', description: 'Max rows (default 50, max 200)' },
      },
    },
    handler: async (args) => {
      const { status, assignee, limit = 50 } = args;
      const rowLimit = Math.min(limit, 200);
      let sql = 'SELECT id, title, description, stage, status, priority, category, assignee_agent_id, blocking_reason, stage_started_at, progress_percentage, completed_checklist_items, created_at, updated_at FROM public.tasks WHERE 1=1';
      const params = [];
      let idx = 1;
      if (status)   { sql += ` AND status = $${idx++}`;         params.push(status); }
      if (assignee) { sql += ` AND assignee_agent_id = $${idx++}`; params.push(assignee); }
      sql += ` ORDER BY priority DESC, created_at DESC LIMIT $${idx}`;
      params.push(rowLimit);
      const rows = await dbQuery(sql, params);
      return { tasks: rows, count: rows.length };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 9. tasks_update — Update task status/stage
  // ════════════════════════════════════════════════════════════
  tasks_update: {
    name: 'tasks_update',
    description: 'Update a task status and/or stage by task id.',
    inputSchema: {
      type: 'object',
      properties: {
        id:            { type: 'string', description: 'Task id (text PK)' },
        status:        { type: 'string', description: 'New status (e.g., PENDING, IN_PROGRESS, DONE, CANCELLED)' },
        stage:         { type: 'string', description: 'New stage (e.g., PENDING, EXECUTING, REVIEWING, COMPLETED)' },
        priority:      { type: 'number', description: 'New priority' },
        blocking_reason: { type: 'string', description: 'Blocking reason' },
        progress_percentage: { type: 'number', description: 'Progress 0-100' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const { id, status, stage, priority, blocking_reason, progress_percentage } = args;
      const cols = [];
      const params = [];
      let idx = 1;
      if (status !== undefined)             { cols.push(`status = $${idx++}`);          params.push(status); }
      if (stage !== undefined)              { cols.push(`stage = $${idx++}`);           params.push(stage); }
      if (priority !== undefined)           { cols.push(`priority = $${idx++}`);        params.push(priority); }
      if (blocking_reason !== undefined)    { cols.push(`blocking_reason = $${idx++}`); params.push(blocking_reason); }
      if (progress_percentage !== undefined) { cols.push(`progress_percentage = $${idx++}`); params.push(progress_percentage); }
      if (!cols.length) return { error: 'No fields to update' };
      cols.push(`updated_at = now()`);
      params.push(id);
      const sql = `UPDATE public.tasks SET ${cols.join(', ')} WHERE id = $${params.length} RETURNING *`;
      const rows = await dbQuery(sql, params);
      return { success: true, task: rows[0] || null };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 10. pfp_bookings — List/create PFP bookings
  // ════════════════════════════════════════════════════════════
  pfp_bookings: {
    name: 'pfp_bookings',
    description: 'List or create PFP (Photo For Profit) bookings. Pass action="list" to query, action="create" to insert.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create'], default: 'list', description: 'Action to perform' },
        // list filters
        status:         { type: 'string', description: 'Filter by booking status (list)' },
        payment_status: { type: 'string', description: 'Filter by payment_status (list)' },
        limit:          { type: 'number', description: 'Max rows (list, default 50)' },
        // create fields
        client_name:    { type: 'string', description: 'Client name (create)' },
        client_email:   { type: 'string', description: 'Client email (create)' },
        client_phone:   { type: 'string', description: 'Client phone (create)' },
        lead_id:        { type: 'number', description: 'Associated lead id (create)' },
        package_id:     { type: 'number', description: 'Service package id (create)' },
        event_date:     { type: 'string', description: 'Event date YYYY-MM-DD (create)' },
        event_location: { type: 'string', description: 'Event location (create)' },
        duration_hours: { type: 'number', description: 'Duration in hours (create)' },
        total_price:    { type: 'number', description: 'Total price (create)' },
        notes:          { type: 'string', description: 'Booking notes (create)' },
      },
    },
    handler: async (args) => {
      const { action = 'list' } = args;

      if (action === 'create') {
        const { client_name, client_email, client_phone, lead_id, package_id,
                event_date, event_location, duration_hours, total_price, notes } = args;
        if (!client_name || !client_email || !event_date || !duration_hours || !total_price) {
          return { error: 'Required: client_name, client_email, event_date, duration_hours, total_price' };
        }
        const rows = await dbQuery(
          `INSERT INTO public.pfp_bookings
             (lead_id, client_name, client_email, client_phone, package_id, event_date,
              event_location, duration_hours, total_price, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [lead_id || null, client_name, client_email, client_phone || null,
           package_id || null, event_date, event_location || null,
           duration_hours, total_price, notes || null]
        );
        return { success: true, booking: rows[0] };
      }

      // list
      const { status, payment_status, limit = 50 } = args;
      const rowLimit = Math.min(limit, 200);
      let sql = 'SELECT * FROM public.pfp_bookings WHERE 1=1';
      const params = [];
      let idx = 1;
      if (status)         { sql += ` AND status = $${idx++}`;          params.push(status); }
      if (payment_status) { sql += ` AND payment_status = $${idx++}`;  params.push(payment_status); }
      sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
      params.push(rowLimit);
      const rows = await dbQuery(sql, params);
      return { bookings: rows, count: rows.length };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 11. hb_properties — List/create harbor properties
  // ════════════════════════════════════════════════════════════
  hb_properties: {
    name: 'hb_properties',
    description: 'List or create Harbor (31harbor.com) real estate properties. Pass action="list" to query, action="create" to insert.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create'], default: 'list', description: 'Action to perform' },
        // list filters
        status: { type: 'string', description: 'Filter by property status (list)' },
        city:    { type: 'string', description: 'Filter by city (list)' },
        limit:   { type: 'number', description: 'Max rows (list, default 50)' },
        // create fields
        address:       { type: 'string', description: 'Property address (create)' },
        city_field:     { type: 'string', description: 'City (create)' },
        state:          { type: 'string', description: 'State (create)' },
        zip:            { type: 'string', description: 'ZIP code (create)' },
        property_type:  { type: 'string', description: 'Property type (create)' },
        bedrooms:       { type: 'number', description: 'Bedrooms (create)' },
        bathrooms:      { type: 'number', description: 'Bathrooms (create)' },
        lot_size:       { type: 'string', description: 'Lot size (create)' },
        square_feet:    { type: 'number', description: 'Square feet (create)' },
        description_field: { type: 'string', description: 'Description (create)' },
        features:       { type: 'array', items: {}, description: 'Features JSON array (create)' },
        images:         { type: 'array', items: { type: 'string' }, description: 'Image URLs (create)' },
      },
    },
    handler: async (args) => {
      const { action = 'list' } = args;

      if (action === 'create') {
        const { address, city_field, state, zip, property_type, bedrooms, bathrooms,
                lot_size, square_feet, description_field, features, images } = args;
        if (!address || !property_type) {
          return { error: 'Required: address, property_type' };
        }
        const rows = await dbQuery(
          `INSERT INTO public.hb_properties
             (address, city, state, zip, property_type, bedrooms, bathrooms,
              lot_size, square_feet, description, features, images)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          [address, city_field || null, state || null, zip || null,
           property_type, bedrooms || null, bathrooms || null,
           lot_size || null, square_feet || null, description_field || null,
           JSON.stringify(features || []), images || null]
        );
        return { success: true, property: rows[0] };
      }

      // list
      const { status, city, limit = 50 } = args;
      const rowLimit = Math.min(limit, 200);
      let sql = 'SELECT * FROM public.hb_properties WHERE 1=1';
      const params = [];
      let idx = 1;
      if (status) { sql += ` AND status = $${idx++}`; params.push(status); }
      if (city)   { sql += ` AND city = $${idx++}`;   params.push(city); }
      sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
      params.push(rowLimit);
      const rows = await dbQuery(sql, params);
      return { properties: rows, count: rows.length };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 12. links_create — Create short link
  // ════════════════════════════════════════════════════════════
  links_create: {
    name: 'links_create',
    description: 'Create a branded short link in the links schema. Specify project_id, domain, key (slug), url, and optional title. Projects: party→pfp.foto, harbor→31harbor.com, xmrt→xmrtsolutions.com, cuttlefish→cuttlefishlabs.io, mobilemonero→mobilemonero.com.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', enum: ['party', 'harbor', 'xmrt', 'cuttlefish', 'mobilemonero'], description: 'Project identifier' },
        url:        { type: 'string', description: 'Destination URL' },
        key:        { type: 'string', description: 'Custom slug (auto-generated if omitted)' },
        title:      { type: 'string', description: 'Link title for previews' },
        qr_code:    { type: 'boolean', default: true, description: 'Generate QR code' },
        expires_at: { type: 'string', description: 'ISO-8601 expiration date' },
      },
      required: ['project_id', 'url'],
    },
    handler: async (args) => {
      const { project_id, url, key, title, qr_code = true, expires_at } = args;
      const PROJECT_DOMAINS = {
        party: 'pfp.foto',
        harbor: '31harbor.com',
        xmrt: 'xmrtsolutions.com',
        cuttlefish: 'cuttlefishlabs.io',
        mobilemonero: 'mobilemonero.com',
      };
      const domain = PROJECT_DOMAINS[project_id];
      if (!domain) return { error: `Unknown project_id: ${project_id}` };
      const slug = key || crypto.randomBytes(6).toString('base64url');
      const rows = await dbQuery(
        `INSERT INTO links.links (project_id, domain, key, url, title, qr_code, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (domain, key) DO UPDATE SET url = EXCLUDED.url, updated_at = now()
         RETURNING id, domain, key, url, title, created_at`,
        [project_id, domain, slug, url, title || null, qr_code, expires_at || null]
      );
      const link = rows[0];
      return {
        success: true,
        id: link.id,
        shortLink: `https://${link.domain}/${link.key}`,
        domain: link.domain,
        key: link.key,
        url: link.url,
        title: link.title,
        createdAt: link.created_at,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 13. links_list — List links for a project
  // ════════════════════════════════════════════════════════════
  links_list: {
    name: 'links_list',
    description: 'List short links for a project. Optionally search by URL/key/title.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', enum: ['party', 'harbor', 'xmrt', 'cuttlefish', 'mobilemonero'], description: 'Project identifier' },
        search:     { type: 'string', description: 'Search query (matches url, key, title)' },
        limit:      { type: 'number', description: 'Max results (default 50, max 100)' },
      },
      required: ['project_id'],
    },
    handler: async (args) => {
      const { project_id, search, limit = 50 } = args;
      const rowLimit = Math.min(limit, 100);
      let sql = `SELECT l.*, COALESCE(c.click_count, 0) AS clicks
                 FROM links.links l
                 LEFT JOIN (SELECT link_id, COUNT(*) AS click_count FROM links.clicks GROUP BY link_id) c
                   ON c.link_id = l.id
                 WHERE l.project_id = $1`;
      const params = [project_id];
      let idx = 2;
      if (search) {
        sql += ` AND (l.url ILIKE $${idx} OR l.key ILIKE $${idx} OR l.title ILIKE $${idx})`;
        params.push(`%${search}%`);
        idx++;
      }
      sql += ` ORDER BY l.created_at DESC LIMIT $${idx}`;
      params.push(rowLimit);
      const rows = await dbQuery(sql, params);
      return {
        links: (rows || []).map(l => ({
          id: l.id,
          shortLink: `https://${l.domain}/${l.key}`,
          domain: l.domain,
          key: l.key,
          url: l.url,
          title: l.title,
          clicks: Number(l.clicks || 0),
          createdAt: l.created_at,
        })),
        count: (rows || []).length,
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 14. links_analytics — Click analytics for a link
  // ════════════════════════════════════════════════════════════
  links_analytics: {
    name: 'links_analytics',
    description: 'Get click analytics for a short link by domain and key.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Link domain (e.g., pfp.foto, 31harbor.com)' },
        key:    { type: 'string', description: 'Link slug' },
        interval: { type: 'string', enum: ['24h', '7d', '30d', '90d', 'all'], default: '30d' },
      },
      required: ['domain', 'key'],
    },
    handler: async (args) => {
      const { domain, key, interval = '30d' } = args;
      const link = await dbQuery('SELECT id FROM links.links WHERE domain = $1 AND key = $2', [domain, key]);
      if (!link.length) return { error: 'Link not found' };
      const linkId = link[0].id;

      const days = interval === '24h' ? 1 : interval === '7d' ? 7 : interval === '30d' ? 30 : interval === '90d' ? 90 : null;
      let totalSql = 'SELECT COUNT(*) AS total FROM links.clicks WHERE link_id = $1';
      if (days) totalSql += ` AND clicked_at > now() - INTERVAL '${days} days'`;
      const totalRes = await dbQuery(totalSql, [linkId]);

      const dailyRes = await dbQuery(
        `SELECT DATE(clicked_at) AS date, COUNT(*) AS count
         FROM links.clicks WHERE link_id = $1
         GROUP BY DATE(clicked_at) ORDER BY date DESC LIMIT 30`,
        [linkId]
      );

      const geoRes = await dbQuery(
        `SELECT COALESCE(country, 'Unknown') AS country, COUNT(*) AS count
         FROM links.clicks WHERE link_id = $1
         GROUP BY country ORDER BY count DESC LIMIT 10`,
        [linkId]
      );

      const deviceRes = await dbQuery(
        `SELECT COALESCE(device_type, 'Unknown') AS device_type, COUNT(*) AS count
         FROM links.clicks WHERE link_id = $1
         GROUP BY device_type ORDER BY count DESC LIMIT 5`,
        [linkId]
      );

      return {
        link: `https://${domain}/${key}`,
        totalClicks: Number(totalRes[0]?.total || 0),
        clicksOverTime: (dailyRes || []).map(c => ({ date: c.date, count: Number(c.count) })),
        topCountries: (geoRes || []).map(c => ({ country: c.country, count: Number(c.count) })),
        topDevices: (deviceRes || []).map(d => ({ device: d.device_type, count: Number(d.count) })),
      };
    },
  },

  // ════════════════════════════════════════════════════════════
  // 15. health — Check Supabase connectivity + table counts
  // ════════════════════════════════════════════════════════════
  health: {
    name: 'health',
    description: 'Check if the cloud Supabase Postgres is reachable and get row counts for key tables.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const TABLES = [
        'suite_companies', 'suite_leads', 'suite_campaigns', 'suite_email_activity',
        'suite_users', 'suite_pipeline_stages', 'suite_activity_log',
        'tasks', 'fleet_memory', 'inbox_messages',
        'agents', 'conversations', 'messages',
        'pfp_bookings', 'hb_properties',
        'knowledge_documents', 'token_usage',
      ];
      const counts = {};
      let reachable = false;
      try {
        const testRes = await dbQuery('SELECT 1 AS ok');
        reachable = testRes[0]?.ok === 1;
      } catch (e) {
        return {
          status: 'error',
          reachable: false,
          error: e.message,
          supabaseUrl: SUPABASE_URL,
          timestamp: new Date().toISOString(),
        };
      }

      for (const table of TABLES) {
        try {
          const res = await dbQuery(`SELECT COUNT(*) AS cnt FROM public.${table}`, []);
          counts[table] = Number(res[0]?.cnt || 0);
        } catch {
          counts[table] = 'table_not_found';
        }
      }

      // Links schema counts
      try {
        const linkCount = await dbQuery('SELECT COUNT(*) AS cnt FROM links.links', []);
        counts['links.links'] = Number(linkCount[0]?.cnt || 0);
        const projectCount = await dbQuery('SELECT COUNT(*) AS cnt FROM links.projects', []);
        counts['links.projects'] = Number(projectCount[0]?.cnt || 0);
        const clickCount = await dbQuery('SELECT COUNT(*) AS cnt FROM links.clicks', []);
        counts['links.clicks'] = Number(clickCount[0]?.cnt || 0);
      } catch {
        counts['links.links'] = 'schema_not_found';
        counts['links.projects'] = 'schema_not_found';
        counts['links.clicks'] = 'schema_not_found';
      }

      return {
        status: 'ok',
        reachable,
        supabaseUrl: SUPABASE_URL,
        supabaseRef: SUPABASE_REF,
        tableCounts: counts,
        tools: Object.values(TOOLS).map(t => t.name),
        toolCount: Object.keys(TOOLS).length,
        timestamp: new Date().toISOString(),
      };
    },
  },
};

// ── MCP Request Handler ────────────────────────────────────────
async function handleRequest(req) {
  const { id, method, params } = req;

  switch (method) {

    // ── MCP Core: initialize ──
    case 'initialize':
      return mcpResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: {
          name: 'xmrtdao-suite-mcp',
          version: '1.0.0',
        },
      });

    // ── MCP Core: list tools ──
    case 'tools/list': {
      const tools = Object.values(TOOLS).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return mcpResult(id, { tools });
    }

    // ── MCP Core: call tool ──
    case 'tools/call': {
      const tool = Object.values(TOOLS).find(t => t.name === params.name);
      if (!tool) {
        return mcpError(id, -32601, `Unknown tool: ${params.name}`);
      }
      try {
        const result = await tool.handler(params.arguments || {});
        return mcpResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        return mcpError(id, -32603, err.message);
      }
    }

    // ── MCP Core: notifications ──
    case 'notifications/initialized':
      return null;

    // ── MCP Core: list resources ──
    case 'resources/list':
      return mcpResult(id, { resources: [] });

    default:
      return mcpError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Transport: stdio (default MCP transport) ──────────────────
let buffer = '';
function onStdioData(chunk) {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const req = JSON.parse(trimmed);
      handleRequest(req).then(response => {
        if (response) sendMessage(response);
      });
    } catch {
      // Ignore malformed JSON
    }
  }
}

function sendMessage(msg) {
  if (msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }
}

// ── Transport: HTTP (optional) ─────────────────────────────────
function startHttp(port) {
  import('http').then(http => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const jsonReq = JSON.parse(body);
            handleRequest(jsonReq).then(response => {
              if (response) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
              } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'ok' }] } }));
              }
            });
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>XMRT DAO Suite MCP</title>
<style>body{font-family:'Share Tech Mono',monospace;background:#0a0a0f;color:#34d399;max-width:600px;margin:40px auto;padding:20px}
h1{color:#34d399;border-bottom:1px solid #34d399;padding-bottom:8px}
pre{background:#1a1a2e;padding:12px;border-radius:6px;overflow-x:auto}
a{color:#60a5fa}</style></head><body>
<h1>📡 XMRT DAO Suite MCP Server</h1>
<p>Cloud Redundancy · Supabase: ${SUPABASE_REF}</p>
<p>This is an MCP server. Connect via an MCP client.</p>
<h2>Available Tools (${Object.keys(TOOLS).length})</h2>
<pre>${Object.values(TOOLS).map(t => t.name).join('\n')}</pre>
<h2>Connect</h2>
<p><b>Stdio:</b> <code>node xmrtdao-suite-mcp.mjs</code></p>
<p><b>HTTP:</b> <code>http://localhost:${port}/</code></p>
</body></html>`);
      }
    });
    server.listen(port, () => {
      console.error(`[XMRT Suite MCP] HTTP server listening on http://127.0.0.1:${port}`);
      console.error(`[XMRT Suite MCP] ${Object.keys(TOOLS).length} tools registered`);
    });
  });
}

// ── Entry Point ────────────────────────────────────────────────
const useHttp = process.argv.includes('--http');
const portIdx = process.argv.indexOf('--port');
const port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1]) : 3200;

console.error(`[XMRT Suite MCP] Starting XMRT DAO Suite Cloud Redundancy MCP Server v1.0.0`);
console.error(`[XMRT Suite MCP] Supabase: ${SUPABASE_URL}`);
console.error(`[XMRT Suite MCP] Transport: ${useHttp ? `HTTP on :${port}` : 'stdio'}`);
console.error(`[XMRT Suite MCP] ${Object.keys(TOOLS).length} tools registered`);

if (useHttp) {
  startHttp(port);
} else {
  process.stdin.on('data', onStdioData);
  process.stdin.on('end', () => {
    pool.end().then(() => process.exit(0));
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  pool.end().then(() => process.exit(0));
});
process.on('SIGINT', () => {
  pool.end().then(() => process.exit(0));
});