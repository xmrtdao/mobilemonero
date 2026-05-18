export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/track/register' && request.method === 'POST') {
      try {
        const body = await request.json();
        const id = crypto.randomUUID();
        const record = { ...body, id, registered_at: Date.now() };

        if (env.R2) {
          await env.R2.put(id, JSON.stringify(record));
        } else if (env.KV) {
          await env.KV.put(id, JSON.stringify(record));
        } else {
          return new Response(JSON.stringify({ error: 'No storage bound' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }

        return new Response(JSON.stringify({ id, status: 'registered' }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path.startsWith('/track/') && request.method === 'GET') {
      try {
        const id = path.split('/')[2];
        let data = null;

        if (env.R2) {
          const obj = await env.R2.get(id);
          if (obj) data = await obj.text();
        } else if (env.KV) {
          data = await env.KV.get(id);
        } else {
          return new Response(JSON.stringify({ error: 'No storage bound' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }

        if (!data) {
          return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }

        return new Response(data, { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
