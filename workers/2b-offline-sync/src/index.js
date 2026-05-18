export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/mesh/buffer' && method === 'POST') {
      try {
        const body = await request.json();
        const recipient = body.recipient;
        if (!recipient) {
          return new Response(JSON.stringify({ error: 'recipient required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        const ts = Date.now();
        const msgId = `${recipient}:${ts}:${Math.random().toString(36).slice(2)}`;
        const payload = { ...body, msg_id: msgId, stored_at: ts };
        await env.KV.put(msgId, JSON.stringify(payload));
        return new Response(JSON.stringify({ msg_id: msgId, status: 'stored' }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/mesh/poll' && method === 'POST') {
      try {
        const body = await request.json();
        const recipient = body.recipient;
        if (!recipient) {
          return new Response(JSON.stringify({ error: 'recipient required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        const list = await env.KV.list({ prefix: `${recipient}:` });
        const msgs = [];
        for (const key of list.keys) {
          const val = await env.KV.get(key.name);
          if (val) msgs.push(JSON.parse(val));
        }
        return new Response(JSON.stringify({ recipient, messages: msgs }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path.startsWith('/mesh/buffer/') && method === 'DELETE') {
      try {
        const msgId = path.split('/')[3];
        if (!msgId) {
          return new Response(JSON.stringify({ error: 'msg_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        await env.KV.delete(msgId);
        return new Response(JSON.stringify({ msg_id: msgId, status: 'deleted' }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
