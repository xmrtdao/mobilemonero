/**
 * PFP Bookings API â€” REST endpoints for Party Favor Photo management platform.
 *
 * All routes are mounted under /api/pfp/ in relay/server.js.
 * Uses the shared pg Pool from localDb.mjs.
 */

import { query, queryOne } from '../lib/localDb.mjs';

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function json(res, data, status = 200) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(status).json(data);
}

function error(res, msg, status = 400) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(status).json({ error: msg });
}

/**
 * Money as it should reach a numeric column.
 *
 * A boolean reaching `total_fee` is a caller mistake, not a zero. It used to be
 * passed straight through, so a form that sent a checkbox produced `'false'::numeric`
 * and the request 500'd. Rejecting it says what actually went wrong; coercing it
 * to 0 would quietly bill a client nothing.
 */
function moneyField(v, field) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') throw new Error(`${field} must be a number, not a boolean`);
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`${field} is not a number: ${JSON.stringify(v)}`);
  return n.toFixed(2);
}

/** Whole numbers only. A float of hours is not a duration anyone can staff. */
function intField(v, field, dflt = null) {
  if (v === null || v === undefined || v === '') return dflt;
  if (typeof v === 'boolean') throw new Error(`${field} must be a number, not a boolean`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${field} is not a number: ${JSON.stringify(v)}`);
  return Math.trunc(n);
}

/** Build WHERE clause + params for lead filters. */
function leadWhere(filters) {
  const clauses = [];
  const params = [];
  if (filters.status && filters.status !== 'all') {
    clauses.push('status = $' + (params.length + 1));
    params.push(filters.status);
  }
  if (filters.source && filters.source !== 'all') {
    clauses.push('source = $' + (params.length + 1));
    params.push(filters.source);
  }
  if (filters.event_type && filters.event_type !== 'all') {
    clauses.push('event_type = $' + (params.length + 1));
    params.push(filters.event_type);
  }
  if (filters.search) {
    clauses.push('(name ILIKE $' + (params.length + 1) + ' OR email ILIKE $' + (params.length + 1) + ')');
    params.push(`%${filters.search}%`);
  }
  if (filters.date_from) {
    clauses.push('created_at >= $' + (params.length + 1) + '::timestamptz');
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    clauses.push('created_at <= $' + (params.length + 1) + '::timestamptz');
    params.push(filters.date_to);
  }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}

/** Build WHERE clause + params for calendar event filters. */
function calendarWhere(filters) {
  const clauses = [];
  const params = [];
  if (filters.date_from) {
    clauses.push('start_time >= $' + (params.length + 1) + '::timestamptz');
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    clauses.push('start_time <= $' + (params.length + 1) + '::timestamptz');
    params.push(filters.date_to);
  }
  if (filters.event_type && filters.event_type !== 'all') {
    clauses.push('event_type = $' + (params.length + 1));
    params.push(filters.event_type);
  }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}

// â”€â”€â”€ Route Registrations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default function register(app) {

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // LEADS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // GET /api/pfp/leads â€” list leads (with filters)
  app.get('/api/pfp/leads', async (req, res) => {
    try {
      const filters = {
        status: req.query.status,
        source: req.query.source,
        event_type: req.query.event_type,
        search: req.query.search,
        date_from: req.query.date_from,
        date_to: req.query.date_to,
      };
      const { where, params } = leadWhere(filters);
      const limit = req.query.limit ? parseInt(req.query.limit) : null;
      const sql = `SELECT * FROM pfp_leads ${where} ORDER BY created_at DESC` +
        (limit ? ' LIMIT ' + limit : '');
      const rows = await query(sql, params.length ? params : []);
      json(res, rows);
    } catch (e) { error(res, e.message, 500); }
  });

  // GET /api/pfp/leads/:id â€” get lead detail
  app.get('/api/pfp/leads/:id', async (req, res) => {
    try {
      const row = await queryOne('SELECT * FROM pfp_leads WHERE id = $1', [req.params.id]);
      if (!row) return error(res, 'Not found', 404);
      json(res, row);
    } catch (e) { error(res, e.message, 500); }
  });

  // POST /api/pfp/leads â€” create lead
  app.post('/api/pfp/leads', async (req, res) => {
    try {
      const b = req.body;
      const result = await query(
        `INSERT INTO pfp_leads (name, email, phone, event_type, event_date, venue, guest_count, source, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [b.name, b.email, b.phone ?? null, b.event_type ?? null, b.event_date ?? null,
         b.venue ?? null, b.guest_count ?? null, b.source ?? null, b.status ?? 'new', b.notes ?? null]
      );
      json(res, result[0], 201);
    } catch (e) { error(res, e.message, 500); }
  });

  // PUT /api/pfp/leads/:id â€” update lead
  app.put('/api/pfp/leads/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const sets = [];
      const params = [];
      const allowed = ['name','email','phone','event_type','event_date','venue','guest_count','source','status','notes'];
      for (const [k, v] of Object.entries(req.body)) {
        if (allowed.includes(k)) {
          sets.push(`${k} = $${params.length + 1}`);
          params.push(v);
        }
      }
      if (!sets.length) return error(res, 'No valid fields', 400);
      sets.push('updated_at = NOW()');
      params.push(id);
      const result = await query(
        `UPDATE pfp_leads SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!result.length) return error(res, 'Not found', 404);
      json(res, result[0]);
    } catch (e) { error(res, e.message, 500); }
  });

  // DELETE /api/pfp/leads/:id â€” delete lead
  app.delete('/api/pfp/leads/:id', async (req, res) => {
    try {
      const result = await query('DELETE FROM pfp_leads WHERE id = $1 RETURNING id', [req.params.id]);
      if (!result.length) return error(res, 'Not found', 404);
      json(res, { ok: true });
    } catch (e) { error(res, e.message, 500); }
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // BOOKINGS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // GET /api/pfp/bookings â€” list bookings
  app.get('/api/pfp/bookings', async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit) : null;
      const sql = 'SELECT * FROM pfp_bookings ORDER BY event_date DESC' +
        (limit ? ' LIMIT ' + limit : '');
      const rows = await query(sql);
      json(res, rows);
    } catch (e) { error(res, e.message, 500); }
  });

  // GET /api/pfp/bookings/:id â€” get booking detail
  app.get('/api/pfp/bookings/:id', async (req, res) => {
    try {
      const row = await queryOne('SELECT * FROM pfp_bookings WHERE id = $1', [req.params.id]);
      if (!row) return error(res, 'Not found', 404);
      json(res, row);
    } catch (e) { error(res, e.message, 500); }
  });

  // POST /api/pfp/bookings â€” create booking
  app.post('/api/pfp/bookings', async (req, res) => {
    try {
      const b = req.body;
      // Coerced by the shared helpers at the top of this file, so the create and
      // the update route cannot drift apart again.
      let totalFee, depositPaid;
      try {
        totalFee = moneyField(b.total_fee, 'total_fee');
        depositPaid = moneyField(b.deposit_paid, 'deposit_paid');
      } catch (e) { return error(res, e.message, 400); }
      if (!b.client_name || !b.client_email || !b.event_name) {
        return error(res, 'client_name, client_email and event_name are required', 400);
      }
      const result = await query(
        `INSERT INTO public.pfp_bookings (lead_id, client_name, client_email, client_phone, event_name, event_type,
          event_date, event_start_time, event_end_time, venue, address, package_type, hours,
          total_fee, deposit_paid, deposit_date, status, contract_sent, contract_signed,
          attendants, addons, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
        [b.lead_id ?? null, b.client_name, b.client_email, b.client_phone ?? null,
         b.event_name, b.event_type ?? null, b.event_date, b.event_start_time ?? null,
         b.event_end_time ?? null, b.venue ?? null, b.address ?? null, b.package_type ?? null,
         intField(b.hours, 'hours'), totalFee, depositPaid, b.deposit_date ?? null,
         b.status ?? 'confirmed', Boolean(b.contract_sent), Boolean(b.contract_signed),
         intField(b.attendants, 'attendants', 1), JSON.stringify(b.addons ?? []), b.notes ?? null]
      );
      json(res, result[0], 201);
    } catch (e) { error(res, e.message, 500); }
  });

  // PUT /api/pfp/bookings/:id â€” update booking
  app.put('/api/pfp/bookings/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return error(res, 'booking id must be a uuid', 400);
      }
      const sets = [];
      const params = [];
      const allowed = ['lead_id','client_name','client_email','client_phone','event_name','event_name_is_placeholder',
        'event_type','event_date','event_start_time','event_end_time','venue','address','package_type','hours',
        'total_fee','deposit_paid','deposit_date','status','contract_sent','contract_signed',
        'attendants','addons','notes'];
      // Money and counts are coerced here too. This route passed every value
      // straight through, so `total_fee: false` from a form checkbox reached a
      // numeric column and the update 500'd - the same defect the create route
      // had. It is also the route an agent or a dashboard edit uses, so a 500
      // here loses a real amendment.
      for (const [k, v] of Object.entries(req.body)) {
        if (!allowed.includes(k)) continue;
        let value = v;
        if (k === 'total_fee' || k === 'deposit_paid') value = moneyField(v, k);
        else if (k === 'hours' || k === 'attendants') value = intField(v, k);
        else if (k === 'contract_sent' || k === 'contract_signed' || k === 'event_name_is_placeholder') value = Boolean(v);
        else if (k === 'addons') {
          if (typeof v === 'string') {
            try { value = JSON.stringify(JSON.parse(v)); }
            catch { return error(res, 'addons must be a JSON array', 400); }
          } else if (Array.isArray(v)) value = JSON.stringify(v);
          else return error(res, 'addons must be a JSON array', 400);
        }
        sets.push(`${k} = $${params.length + 1}`);
        params.push(value);
      }
      if (!sets.length) return error(res, 'No valid fields', 400);
      sets.push('updated_at = NOW()');
      params.push(id);
      const result = await query(
        `UPDATE public.pfp_bookings SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!result.length) return error(res, 'Not found', 404);
      json(res, result[0]);
    } catch (e) {
      // A coercion failure is the caller's mistake, not a server fault.
      const status = /must be|not a number|not a boolean|uuid|JSON/.test(e.message) ? 400 : 500;
      error(res, e.message, status);
    }
  });

  // DELETE /api/pfp/bookings/:id â€” delete booking
  app.delete('/api/pfp/bookings/:id', async (req, res) => {
    try {
      const result = await query('DELETE FROM pfp_bookings WHERE id = $1 RETURNING id', [req.params.id]);
      if (!result.length) return error(res, 'Not found', 404);
      json(res, { ok: true });
    } catch (e) { error(res, e.message, 500); }
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // CAMPAIGNS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // GET /api/pfp/campaigns â€” list campaigns
  app.get('/api/pfp/campaigns', async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit) : null;
      const sql = 'SELECT * FROM pfp_campaigns ORDER BY created_at DESC' +
        (limit ? ' LIMIT ' + limit : '');
      const rows = await query(sql);
      json(res, rows);
    } catch (e) { error(res, e.message, 500); }
  });

  // GET /api/pfp/campaigns/:id â€” get campaign detail
  app.get('/api/pfp/campaigns/:id', async (req, res) => {
    try {
      const row = await queryOne('SELECT * FROM pfp_campaigns WHERE id = $1', [req.params.id]);
      if (!row) return error(res, 'Not found', 404);
      json(res, row);
    } catch (e) { error(res, e.message, 500); }
  });

  // POST /api/pfp/campaigns â€” create campaign
  app.post('/api/pfp/campaigns', async (req, res) => {
    try {
      const b = req.body;
      const result = await query(
        `INSERT INTO pfp_campaigns (name, description, target_audience, channel, status, scheduled_date, content)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.name, b.description ?? null, b.target_audience ?? null, b.channel ?? null,
         b.status ?? 'draft', b.scheduled_date ?? null, b.content ?? null]
      );
      json(res, result[0], 201);
    } catch (e) { error(res, e.message, 500); }
  });

  // PUT /api/pfp/campaigns/:id â€” update campaign
  app.put('/api/pfp/campaigns/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const sets = [];
      const params = [];
      const allowed = ['name','description','target_audience','channel','status','scheduled_date',
        'sent_count','open_count','click_count','reply_count','content'];
      for (const [k, v] of Object.entries(req.body)) {
        if (allowed.includes(k)) {
          sets.push(`${k} = $${params.length + 1}`);
          params.push(v);
        }
      }
      if (!sets.length) return error(res, 'No valid fields', 400);
      sets.push('updated_at = NOW()');
      params.push(id);
      const result = await query(
        `UPDATE pfp_campaigns SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!result.length) return error(res, 'Not found', 404);
      json(res, result[0]);
    } catch (e) { error(res, e.message, 500); }
  });

  // DELETE /api/pfp/campaigns/:id â€” delete campaign
  app.delete('/api/pfp/campaigns/:id', async (req, res) => {
    try {
      const result = await query('DELETE FROM pfp_campaigns WHERE id = $1 RETURNING id', [req.params.id]);
      if (!result.length) return error(res, 'Not found', 404);
      json(res, { ok: true });
    } catch (e) { error(res, e.message, 500); }
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // CONTACTS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // GET /api/pfp/contacts â€” list contacts
  app.get('/api/pfp/contacts', async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit) : null;
      const sql = 'SELECT * FROM pfp_contacts ORDER BY created_at DESC' +
        (limit ? ' LIMIT ' + limit : '');
      const rows = await query(sql);
      json(res, rows);
    } catch (e) { error(res, e.message, 500); }
  });

  // GET /api/pfp/contacts/:id â€” get contact detail
  app.get('/api/pfp/contacts/:id', async (req, res) => {
    try {
      const row = await queryOne('SELECT * FROM pfp_contacts WHERE id = $1', [req.params.id]);
      if (!row) return error(res, 'Not found', 404);
      json(res, row);
    } catch (e) { error(res, e.message, 500); }
  });

  // POST /api/pfp/contacts â€” create contact
  app.post('/api/pfp/contacts', async (req, res) => {
    try {
      const b = req.body;
      const result = await query(
        `INSERT INTO pfp_contacts (name, email, phone, organization, role, source, tags, notes, subscribed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [b.name, b.email, b.phone ?? null, b.organization ?? null, b.role ?? null,
         b.source ?? null, b.tags ?? [], b.notes ?? null, b.subscribed ?? true]
      );
      json(res, result[0], 201);
    } catch (e) { error(res, e.message, 500); }
  });

  // PUT /api/pfp/contacts/:id â€” update contact
  app.put('/api/pfp/contacts/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const sets = [];
      const params = [];
      const allowed = ['name','email','phone','organization','role','source','tags','notes','subscribed','last_contacted_at'];
      for (const [k, v] of Object.entries(req.body)) {
        if (allowed.includes(k)) {
          sets.push(`${k} = $${params.length + 1}`);
          params.push(v);
        }
      }
      if (!sets.length) return error(res, 'No valid fields', 400);
      sets.push('updated_at = NOW()');
      params.push(id);
      const result = await query(
        `UPDATE pfp_contacts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!result.length) return error(res, 'Not found', 404);
      json(res, result[0]);
    } catch (e) { error(res, e.message, 500); }
  });

  // DELETE /api/pfp/contacts/:id â€” delete contact
  app.delete('/api/pfp/contacts/:id', async (req, res) => {
    try {
      const result = await query('DELETE FROM pfp_contacts WHERE id = $1 RETURNING id', [req.params.id]);
      if (!result.length) return error(res, 'Not found', 404);
      json(res, { ok: true });
    } catch (e) { error(res, e.message, 500); }
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // CALENDAR EVENTS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // GET /api/pfp/calendar â€” list events (with date range filter)
  app.get('/api/pfp/calendar', async (req, res) => {
    try {
      const filters = {
        date_from: req.query.date_from,
        date_to: req.query.date_to,
        event_type: req.query.event_type,
      };
      const { where, params } = calendarWhere(filters);
      const limit = req.query.limit ? parseInt(req.query.limit) : null;
      const sql = `SELECT * FROM pfp_calendar_events ${where} ORDER BY start_time ASC` +
        (limit ? ' LIMIT ' + limit : '');
      const rows = await query(sql, params.length ? params : []);
      json(res, rows);
    } catch (e) { error(res, e.message, 500); }
  });

  // GET /api/pfp/calendar/:id â€” get event detail
  app.get('/api/pfp/calendar/:id', async (req, res) => {
    try {
      const row = await queryOne('SELECT * FROM pfp_calendar_events WHERE id = $1', [req.params.id]);
      if (!row) return error(res, 'Not found', 404);
      json(res, row);
    } catch (e) { error(res, e.message, 500); }
  });

  // POST /api/pfp/calendar â€” create event
  app.post('/api/pfp/calendar', async (req, res) => {
    try {
      const b = req.body;
      const result = await query(
        `INSERT INTO pfp_calendar_events (title, description, event_type, start_time, end_time, all_day, related_booking_id, color)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [b.title, b.description ?? null, b.event_type ?? null, b.start_time, b.end_time ?? null,
         b.all_day ?? false, b.related_booking_id ?? null, b.color ?? '#3b82f6']
      );
      json(res, result[0], 201);
    } catch (e) { error(res, e.message, 500); }
  });

  // PUT /api/pfp/calendar/:id â€” update event
  app.put('/api/pfp/calendar/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const sets = [];
      const params = [];
      const allowed = ['title','description','event_type','start_time','end_time','all_day','related_booking_id','color'];
      for (const [k, v] of Object.entries(req.body)) {
        if (allowed.includes(k)) {
          sets.push(`${k} = $${params.length + 1}`);
          params.push(v);
        }
      }
      if (!sets.length) return error(res, 'No valid fields', 400);
      sets.push('updated_at = NOW()');
      params.push(id);
      const result = await query(
        `UPDATE pfp_calendar_events SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!result.length) return error(res, 'Not found', 404);
      json(res, result[0]);
    } catch (e) { error(res, e.message, 500); }
  });

  // DELETE /api/pfp/calendar/:id â€” delete event
  app.delete('/api/pfp/calendar/:id', async (req, res) => {
    try {
      const result = await query('DELETE FROM pfp_calendar_events WHERE id = $1 RETURNING id', [req.params.id]);
      if (!result.length) return error(res, 'Not found', 404);
      json(res, { ok: true });
    } catch (e) { error(res, e.message, 500); }
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // STATS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // GET /api/pfp/stats â€” dashboard stats
  app.get('/api/pfp/stats', async (req, res) => {
    try {
      const leadsCount = (await queryOne("SELECT COUNT(*)::int AS count FROM pfp_leads WHERE status NOT IN ('lost')"))?.count ?? 0;
      const upcomingBookings = (await queryOne("SELECT COUNT(*)::int AS count FROM pfp_bookings WHERE status IN ('pending','confirmed') AND event_date >= CURRENT_DATE"))?.count ?? 0;
      const revenueMonth = (await queryOne(
        "SELECT COALESCE(SUM(total_fee), 0)::numeric AS total FROM pfp_bookings WHERE status IN ('confirmed','completed') AND EXTRACT(MONTH FROM event_date) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM event_date) = EXTRACT(YEAR FROM CURRENT_DATE)"
      ))?.total ?? 0;
      const campaignsActive = (await queryOne("SELECT COUNT(*)::int AS count FROM pfp_campaigns WHERE status = 'active'"))?.count ?? 0;
      const totalRevenue = (await queryOne("SELECT COALESCE(SUM(total_fee), 0)::numeric AS total FROM pfp_bookings WHERE status IN ('confirmed','completed')"))?.total ?? 0;
      const totalDeposits = (await queryOne("SELECT COALESCE(SUM(deposit_paid), 0)::numeric AS total FROM pfp_bookings"))?.total ?? 0;

      json(res, {
        activeLeads: leadsCount,
        upcomingBookings,
        revenueThisMonth: parseFloat(revenueMonth),
        campaignsActive,
        totalRevenue: parseFloat(totalRevenue),
        totalDeposits: parseFloat(totalDeposits),
      });
    } catch (e) { error(res, e.message, 500); }
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // ONBOARDING â€” post-sale client intake pipeline
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // GET /api/pfp/onboardings â€” list all onboardings (admin)
  app.get('/api/pfp/onboardings', async (req, res) => {
    try {
      const rows = await query(
        `SELECT o.*, d.color_theme, d.print_type, d.custom_message
         FROM pfp_onboardings o
         LEFT JOIN pfp_onboarding_designs d ON d.onboarding_id = o.id
         ORDER BY o.created_at DESC LIMIT 50`
      );
      json(res, { onboardings: rows });
    } catch (e) { error(res, e.message, 500); }
  });

  // GET /api/pfp/onboarding/:token â€” get onboarding by token (client-facing)
  app.get('/api/pfp/onboarding/:token', async (req, res) => {
    try {
      const onboarding = await queryOne(
        'SELECT * FROM pfp_onboardings WHERE onboarding_token = $1', [req.params.token]
      );
      if (!onboarding) return error(res, 'Onboarding not found', 404);
      const design = await queryOne(
        'SELECT * FROM pfp_onboarding_designs WHERE onboarding_id = $1', [onboarding.id]
      );
      const messages = await query(
        'SELECT * FROM pfp_onboarding_messages WHERE onboarding_id = $1 ORDER BY created_at ASC', [onboarding.id]
      );
      json(res, { ...onboarding, design, messages });
    } catch (e) { error(res, e.message, 500); }
  });

  // PUT /api/pfp/onboarding/:token/design â€” save design
  app.put('/api/pfp/onboarding/:token/design', async (req, res) => {
    try {
      const onboarding = await queryOne(
        'SELECT id FROM pfp_onboardings WHERE onboarding_token = $1', [req.params.token]
      );
      if (!onboarding) return error(res, 'Onboarding not found', 404);
      const { printType, colorTheme, backdropCurtain, cornerOrnaments, borderStyle,
              borderColor, backgroundFill, backgroundDesign, accentColor,
              customMessage, printSize } = req.body;
      await query(
        `INSERT INTO pfp_onboarding_designs (onboarding_id, print_type, color_theme,
          backdrop_curtain, corner_ornaments, border_style, border_color,
          background_fill, background_design, accent_color, custom_message, print_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (onboarding_id) DO UPDATE SET
          print_type=EXCLUDED.print_type, color_theme=EXCLUDED.color_theme,
          backdrop_curtain=EXCLUDED.backdrop_curtain, corner_ornaments=EXCLUDED.corner_ornaments,
          border_style=EXCLUDED.border_style, border_color=EXCLUDED.border_color,
          background_fill=EXCLUDED.background_fill, background_design=EXCLUDED.background_design,
          accent_color=EXCLUDED.accent_color, custom_message=EXCLUDED.custom_message,
          print_size=EXCLUDED.print_size, updated_at=NOW()`,
        [onboarding.id, printType, colorTheme, backdropCurtain, cornerOrnaments,
         borderStyle, borderColor, backgroundFill, backgroundDesign, accentColor,
         customMessage, printSize]
      );
      // Update onboarding status to in_progress
      await query('UPDATE pfp_onboardings SET status = $1, updated_at = NOW() WHERE id = $2',
        ['in_progress', onboarding.id]);
      json(res, { success: true });
    } catch (e) { error(res, e.message, 500); }
  });

  // POST /api/pfp/onboarding/:token/submit â€” submit final design
  app.post('/api/pfp/onboarding/:token/submit', async (req, res) => {
    try {
      const onboarding = await queryOne(
        'SELECT id, client_name, client_email FROM pfp_onboardings WHERE onboarding_token = $1', [req.params.token]
      );
      if (!onboarding) return error(res, 'Onboarding not found', 404);
      const { eventDate, eventType, guestCount, endTime, venue } = req.body;
      await query(
        `UPDATE pfp_onboardings SET
          event_date = $1, event_type = $2, guest_count = $3,
          event_end_time = $4, venue = $5,
          status = 'design_complete', completed_at = NOW(), updated_at = NOW()
         WHERE id = $6`,
        [eventDate, eventType, guestCount, endTime, venue, onboarding.id]
      );
      // Post to fleet chat
      try {
        const fetch = (await import('node-fetch')).default;
        await fetch('http://127.0.0.1:8080/api/fleet-chat/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent: 'system',
            message: `ðŸ“‹ ${onboarding.client_name} (${onboarding.client_email}) submitted their print design!`,
            channel: 'fleet'
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {}
      json(res, { success: true });
    } catch (e) { error(res, e.message, 500); }
  });

  // POST /api/pfp/onboarding/:token/chat â€” send chat message
  app.post('/api/pfp/onboarding/:token/chat', async (req, res) => {
    try {
      const onboarding = await queryOne(
        'SELECT id FROM pfp_onboardings WHERE onboarding_token = $1', [req.params.token]
      );
      if (!onboarding) return error(res, 'Onboarding not found', 404);
      const { sender, message } = req.body;
      await query(
        'INSERT INTO pfp_onboarding_messages (onboarding_id, sender, message) VALUES ($1,$2,$3)',
        [onboarding.id, sender || 'client', message]
      );
      // Sync to fleet chat
      try {
        const fetch = (await import('node-fetch')).default;
        await fetch('http://127.0.0.1:8080/api/fleet-chat/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent: 'system',
            message: `ðŸ’¬ ${onboarding.client_name}: ${message}`,
            channel: 'fleet'
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {}
      json(res, { success: true });
    } catch (e) { error(res, e.message, 500); }
  });

  // POST /api/pfp/stripe-webhook â€” receive Stripe payment confirmation
  app.post('/api/pfp/stripe-webhook', async (req, res) => {
    try {
      const { session_id, client_name, client_email, client_phone,
              event_name, event_type, event_date, package_type, hours,
              total_fee, deposit_paid } = req.body;
      if (!session_id || !client_email) return error(res, 'session_id and client_email required');
      // Create onboarding record
      const token = 'pfp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const result = await query(
        `INSERT INTO pfp_onboardings (stripe_session_id, client_name, client_email, client_phone,
          event_name, event_type, event_date, package_type, hours, total_fee, deposit_paid,
          onboarding_token, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')
         RETURNING id, onboarding_token`,
        [session_id, client_name, client_email, client_phone,
         event_name, event_type, event_date, package_type, hours, total_fee, deposit_paid, token]
      );
      // Post to fleet chat
      try {
        const fetch = (await import('node-fetch')).default;
        await fetch('http://127.0.0.1:8080/api/fleet-chat/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent: 'system',
            message: `ðŸŽ‰ New booking paid! ${client_name} (${client_email}) â€” ${package_type || 'standard'} ${hours || '?'}h. Onboarding link: /intake/${token}`,
            channel: 'fleet'
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {}
      json(res, { success: true, onboarding_id: result[0].id, token });
    } catch (e) { error(res, e.message, 500); }
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // OPTIONS handler for all PFP routes
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  app.options('/api/pfp/*path', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(200).end();
  });
}
