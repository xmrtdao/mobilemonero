/**
 * Price Ticker Worker
 * Converted to addEventListener syntax for API deployment.
 * Caches Monero price from CoinGecko.
 */

var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status) {
  status = status || 200;
  var h = { "Content-Type": "application/json" };
  for (var k in CORS) { h[k] = CORS[k]; }
  return new Response(JSON.stringify(data), { status: status, headers: h });
}

addEventListener("fetch", function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  var url = new URL(request.url);
  var path = url.pathname;

  if (path === "/price/xmr") {
    try {
      // KV binding required: env.KV
      // For now, fetch directly without cache
      var res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd");
      if (!res.ok) throw new Error("CoinGecko API error");
      var data = await res.json();
      return jsonResponse({ price_usd: data.monero.usd, updated: Date.now() });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  if (path === "/price/change") {
    try {
      var res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd&include_24hr_change=true");
      if (!res.ok) throw new Error("CoinGecko API error");
      var data = await res.json();
      return jsonResponse({ change_24h: data.monero.usd_24h_change, updated: Date.now() });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  return jsonResponse({ error: "Not Found", paths: ["/price/xmr", "/price/change"] }, 404);
}
