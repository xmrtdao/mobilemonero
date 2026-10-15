/**
 * Paragraph Manager — Full CRUD toolset for @mobilemonero
 * 
 * This module provides complete editorial control over the Paragraph publication.
 * API Base: https://public.api.paragraph.com/api/v1
 */

const BASE_URL = 'https://public.api.paragraph.com/api/v1';

async function request(method, path, body = null) {
  const apiKey = process.env.PARAGRAPH_API_KEY || '';
  if (!apiKey) throw new Error('PARAGRAPH_API_KEY not configured in relay/.env');

  const url = `${BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(30000),
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({ raw: 'non-JSON response' }));

  if (!response.ok) {
    throw { status: response.status, details: data };
  }
  return data;
}

export const paragraphPostsList = async (args) => {
  const { status, limit = 20, offset = 0 } = args || {};
  let path = '/posts';
  if (status) path += `?status=${status}`;
  // Note: Alpha API pagination might vary; using standard query params.
  const data = await request('GET', path);
  return { success: true, posts: data };
};

export const paragraphPostGet = async (args) => {
  const { id } = args || {};
  if (!id) return { error: 'post id is required' };
  const data = await request('GET', `/posts/${id}`);
  return { success: true, post: data };
};

export const paragraphPostCreate = async (args) => {
  const { title, markdown, body, status = 'published', categories, subtitle, imageUrl, slug } = args || {};
  const content = markdown || body;
  if (!title || !content) return { error: 'title and markdown (or body) are required' };

  const coinSymbol = process.env.PARAGRAPH_COIN_SYMBOL;
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

  const data = await request('POST', '/posts', payload);
  
  const pubHandle = (process.env.PARAGRAPH_PUBLICATION_HANDLE || 'mobilemonero').replace(/^@/, '');
  const publishedSlug = data?.slug || slug;
  const publishedUrl = `https://paragraph.com/@${pubHandle}/${publishedSlug || data?.id || ''}`.replace(/\/+$/, '');

  return {
    success: true,
    message: 'Successfully created post',
    data,
    published_url: publishedUrl,
  };
};

export const paragraphPostUpdate = async (args) => {
  const { id, ...updates } = args || {};
  if (!id) return { error: 'post id is required' };
  
  // Filter updates to only allowed fields
  const payload = {};
  const allowed = ['title', 'markdown', 'subtitle', 'imageUrl', 'slug', 'categories'];
  for (const key of allowed) {
    if (updates[key] !== undefined) payload[key] = updates[key];
  }

  const data = await request('PATCH', `/posts/${id}`, payload);
  return { success: true, updated_post: data };
};

export const paragraphPostSetStatus = async (args) => {
  const { id, status } = args || {};
  if (!id || !status) return { error: 'id and status are required' };
  
  const data = await request('PATCH', `/posts/${id}`, { status });
  return { success: true, new_status: status, data };
};

export const paragraphPostDelete = async (args) => {
  const { id, confirm } = args || {};
  if (!id) return { error: 'post id is required' };

  // Safeguard: fetch current state before delete
  const current = await request('GET', `/posts/${id}`);
  
  if (!confirm) {
    return {
      action_required: 'CONFIRM_DELETE',
      message: 'Hard delete is irreversible. Please confirm you want to delete this post.',
      post_details: {
        title: current.title,
        status: current.status,
        slug: current.slug,
        published_at: current.published_at
      },
      confirmation_token: `${id}_${Date.now()}`
    };
  }

  await request('DELETE', `/posts/${id}`);
  
  // Verify absence
  try {
    await request('GET', `/posts/${id}`);
    return { error: 'Verification failed: post still exists after DELETE' };
  } catch (e) {
    // 404 is the expected success state
    if (e.status === 404) {
      return { success: true, message: 'Post permanently deleted and verified absent' };
    }
    throw e;
  }
};

export const paragraphPublicationGet = async () => {
  const data = await request('GET', '/publication');
  return { success: true, publication: data };
};

export const paragraphApiCapabilities = async () => {
  // Diagnostic: Check if we can list posts and get pub info
  try {
    await request('GET', '/publication');
    const posts = await request('GET', '/posts');
    return {
      success: true,
      api_version: 'v1',
      capabilities: {
        can_list_posts: true,
        can_get_publication: true,
        post_count: posts.length || 0,
      }
    };
  } catch (e) {
    return { error: `Capability check failed: ${e.message || e.status}`, details: e };
  }
};
