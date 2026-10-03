/**
 * Paragraph Publisher — Direct API tool for the relay
 *
 * Publishes posts to Paragraph.com via the REST API.
 * Bypasses local-sb's Deno edge function runner (which has spawn issues).
 *
 * Usage via /tools/run:
 *   { "tool": "paragraph-publish", "args": { "title": "...", "markdown": "...", "status": "published" } }
 */

export async function paragraphPublish(args) {
  const { title, markdown, body, status = 'published', categories, subtitle, imageUrl, slug } = args || {};
  const content = markdown || body;

  if (!title || !content) {
    return { error: 'title and markdown (or body) are required' };
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
  if (slug) payload.slug = slug;
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
  const publishedSlug = data?.slug || slug;
  const publishedUrl = `https://paragraph.com/@${pubHandle}/${publishedSlug || data?.id || ''}`.replace(/\/+$/, '');

  return {
    success: true,
    message: 'Successfully published to Paragraph.com',
    data,
    published_url: publishedUrl,
    publication: `@${pubHandle}`,
  };
}

export default paragraphPublish;
