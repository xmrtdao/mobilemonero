/**
 * relay/functions/code-monitor-daemon.mjs — Local replacement for the cloud edge function
 *
 * The cloud code-monitor-daemon tries to write to cloud Supabase's eliza_activity_log
 * table (dead, 504/502). This local version writes to the local Postgres instead.
 * Called by the relay's /functions/v1/code-monitor-daemon endpoint.
 */
import pg from 'pg';
const { Client } = pg;

const PG_URL = process.env.PG_URL || process.env.LOCAL_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/xmrt_suite';

async function query(sql, params = []) {
  const client = new Client(PG_URL);
  await client.connect();
  try {
    const r = await client.query(sql, params);
    return r;
  } finally {
    await client.end();
  }
}

export async function handler(req, res) {
  try {
    const body = typeof req.body === 'object' ? req.body : {};
    const { activity_type, description, metadata, status } = body;

    if (!activity_type || !description) {
      return res.status(400).json({ error: 'activity_type and description required' });
    }

    await query(
      `INSERT INTO public.eliza_activity_log (activity_type, title, description, metadata, status, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [activity_type, description.slice(0, 100), description, JSON.stringify(metadata || {}), status || 'completed']
    );

    res.json({ success: true, source: 'local' });
  } catch (e) {
    console.error('[code-monitor-daemon] error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
