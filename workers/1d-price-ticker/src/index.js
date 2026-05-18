export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/price/xmr') {
      try {
        let cached = await env.KV.get('price_xmr');
        if (cached) {
          return new Response(cached, { headers: { 'Content-Type': 'application/json' } });
        }
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd');
        if (!res.ok) throw new Error('CoinGecko API error');
        const data = await res.json();
        const json = JSON.stringify({ price_usd: data.monero.usd, updated: Date.now() });
        await env.KV.put('price_xmr', json, { expirationTtl: 60 });
        return new Response(json, { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/price/change') {
      try {
        let cached = await env.KV.get('price_change');
        if (cached) {
          return new Response(cached, { headers: { 'Content-Type': 'application/json' } });
        }
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd&include_24hr_change=true');
        if (!res.ok) throw new Error('CoinGecko API error');
        const data = await res.json();
        const json = JSON.stringify({ change_24h: data.monero.usd_24h_change, updated: Date.now() });
        await env.KV.put('price_change', json, { expirationTtl: 60 });
        return new Response(json, { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
