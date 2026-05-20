/**
 * Price Ticker Worker v2
 * Multi-source fallback: CoinGecko → Kraken → Binance
 * Handles rate limits via proper headers + retries
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

async function fetchCoinGecko() {
  var res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd&include_24hr_change=true",
    {
      headers: {
        "User-Agent": "MobileMonero-Worker/1.0",
        "Accept": "application/json",
      },
      cf: { cacheTtl: 30 },
    }
  );
  if (!res.ok) throw new Error("CG_HTTP_" + res.status);
  var data = await res.json();
  return {
    price_usd: data.monero.usd,
    change_24h: data.monero.usd_24h_change || null,
    source: "coingecko",
  };
}

async function fetchKraken() {
  var res = await fetch(
    "https://api.kraken.com/0/public/Ticker?pair=XMRUSD",
    {
      headers: { "Accept": "application/json" },
      cf: { cacheTtl: 30 },
    }
  );
  if (!res.ok) throw new Error("KR_HTTP_" + res.status);
  var data = await res.json();
  var pair = data.result.XXMRZUSD;
  if (!pair) throw new Error("KR_NO_PAIR");
  var price = parseFloat(pair.c[0]);
  var open = parseFloat(pair.o);
  var change = ((price - open) / open) * 100;
  return {
    price_usd: price,
    change_24h: parseFloat(change.toFixed(2)),
    source: "kraken",
    high_24h: parseFloat(pair.h[1]),
    low_24h: parseFloat(pair.l[1]),
    volume_24h: parseFloat(pair.v[1]),
  };
}

async function fetchBinance() {
  var res = await fetch(
    "https://api.binance.com/api/v3/ticker/price?symbol=XMRUSDT",
    {
      headers: { "Accept": "application/json" },
      cf: { cacheTtl: 30 },
    }
  );
  if (!res.ok) throw new Error("BN_HTTP_" + res.status);
  var data = await res.json();
  return {
    price_usd: parseFloat(data.price),
    change_24h: null,
    source: "binance",
  };
}

async function fetchPrice() {
  var errors = [];
  // Try CoinGecko first (most complete data)
  try { return await fetchCoinGecko(); }
  catch (e) { errors.push("cg:" + e.message); }
  // Fallback to Kraken
  try { return await fetchKraken(); }
  catch (e) { errors.push("kr:" + e.message); }
  // Fallback to Binance (price only, no 24h change)
  try { return await fetchBinance(); }
  catch (e) { errors.push("bn:" + e.message); }
  throw new Error("All sources failed: " + errors.join(", "));
}

addEventListener("fetch", function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  var url = new URL(request.url);
  var path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (path === "/price/xmr" || path === "/price/xmr/") {
    try {
      var data = await fetchPrice();
      return jsonResponse({
        price_usd: data.price_usd,
        change_24h: data.change_24h,
        source: data.source,
        updated: Date.now(),
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 502);
    }
  }

  if (path === "/price/change" || path === "/price/change/") {
    try {
      var data = await fetchPrice();
      return jsonResponse({
        change_24h: data.change_24h,
        price_usd: data.price_usd,
        source: data.source,
        updated: Date.now(),
      });
    } catch (e) {
      return jsonResponse({ error: e.message }, 502);
    }
  }

  if (path === "/health" || path === "/" || path === "") {
    return jsonResponse({
      ok: true,
      worker: "1d-price-ticker",
      ts: Date.now(),
      supported: ["/price/xmr", "/price/change"],
      sources: ["coingecko", "kraken", "binance"],
    });
  }

  return jsonResponse({ error: "Not Found", paths: ["/price/xmr", "/price/change", "/health"] }, 404);
}
