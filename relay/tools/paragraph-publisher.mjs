import crypto from 'node:crypto';
import { Client as PgClient } from 'pg';

async function getPgClient() {
  return new PgClient({ host: '127.0.0.1', port: 5432, user: 'postgres', password: process.env.PG_PASSWORD || 'postgres', database: 'xmrt_suite' });
}

/**
 * Paragraph Publisher — Direct API tool for the relay
 *
 * Publishes posts to Paragraph.com via the REST API.
 * Bypasses local-sb's Deno edge function runner (which has spawn issues).
 *
 * Usage via /tools/run:
 *   { "tool": "paragraph-publish", "args": { "title": "...", "markdown": "...", "status": "published" } }
 * */
export async function paragraphPublish(args) {
  const { title, markdown, body, status = 'published', categories, subtitle, imageUrl, slug: requestedSlug } = args || {};
  const content = markdown || body;

  if (!title || !content) {
    return { error: 'title and markdown (or body) are required' };
  }

  // ── Dedup Gate ─────────────────────────────────────────────────────
  const contentHash = crypto.createHash('sha256').update(title + content).digest('hex');
  const pg = await getPgClient();
  try {
    await pg.connect();
    const existing = await pg.query('SELECT url FROM app.publication_dedup WHERE content_hash = $1', [contentHash]);
    if (existing.rows.length > 0) {
      await pg.end();
      return {
        success: false,
        error: 'Duplicate content detected',
        published_url: existing.rows[0].url,
        message: 'This content has already been published to Paragraph.com'
      };
    }
  } catch (e) {
    console.warn('[Paragraph] Dedup check failed:', e.message);
  } finally {
    if (pg) await pg.end().catch(() => {});
  }

  const apiKey = process.env.PARAGRAPH_API_KEY || '';
  if (!apiKey) {
    return { error: 'PARAGRAPH_API_KEY not configured in relay/.env' };
  }

  const defaultAuthor = process.env.PARAGRAPH_DEFAULT_AUTHOR || undefined;
  const coinSymbol = process.env.PARAGRAPH_COIN_SYMBOL || undefined;

  const defaultCategories = coinSymbol
    ? ['News', `$${coinSymbol}`, 'XMRT Intelligence']
    : ['News', 'XMRT Intelligence'];

  const payload = {
    title: title.substring(0, 200),
    markdown: content,
    sendNewsletter: false,
    status,
    categories: categories || defaultCategories,
  };
  if (subtitle) payload.subtitle = subtitle.substring(0, 300);
  if (imageUrl) payload.imageUrl = imageUrl;
  
  // ── Slug Collision Prevention ──────────────────────────────────────
  let finalSlug = requestedSlug;
  if (finalSlug) {
    try {
      const pgCheck = await getPgClient();
      await pgCheck.connect();
      let count = 0;
      while (true) {
        const currentSlug = count === 0 ? finalSlug : `${requestedSlug}-${count}`;
        const res = await pgCheck.query('SELECT id FROM app.publication_dedup WHERE slug = $1', [currentSlug]);
        if (res.rows.length === 0) {
          finalSlug = currentSlug;
          break;
        }
        count++;
        if (count > 100) {
          finalSlug = `${requestedSlug}-${Date.now()}`;
          break;
        }
      }
      await pgCheck.end();
    } catch (e) {
      console.warn('[Paragraph] Slug check failed:', e.message);
    }
  }
  payload.slug = finalSlug;
  if (defaultAuthor && !payload.author) payload.author = defaultAuthor;

  const response = await fetch('https://public.api.paragraph.com/api/v1/posts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  const data = await response.json().catch(() => ({ raw: 'non-JSON response from Paragraph' }));

  if (!response.ok) {
    return {
      error: `Paragraph.com returned ${response.status}`,
      status: response.status,
      details: data,
    };
  }

  const pubHandle = (process.env.PARAGRAPH_PUBLICATION_HANDLE || 'mobilemonero').replace(/^@/, '');
  const publishedSlug = data?.slug || finalSlug;
  const publishedUrl = `https://paragraph.com/@${pubHandle}/${publishedSlug || data?.id || ''}`.replace(/\/+$/, '');

  // Record success for future dedup
  try {
    const pgRecord = await getPgClient();
    await pgRecord.connect();
    await pgRecord.query(
      'INSERT INTO app.publication_dedup (content_hash, slug, url) VALUES ($1, $2, $3)',
      [contentHash, publishedSlug, publishedUrl]
    );
    await pgRecord.end();
  } catch (e) {
    console.warn('[Paragraph] Failed to record publication:', e.message);
  }

  return {
    success: true,
    message: 'Successfully published to Paragraph.com',
    data,
    published_url: publishedUrl,
    publication: `@${pubHandle}`,
  };
}

export default paragraphPublish;