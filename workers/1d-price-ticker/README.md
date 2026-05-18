# 1d Monero Price Ticker (CF Worker)

Endpoints
- GET /price/xmr       → XMR/USD price from CoinGecko, cached in KV for 60s
- GET /price/change    → 24h percent change from CoinGecko, cached in KV for 60s

Deployment
- Bind a KV namespace as `KV` in wrangler.toml or via dashboard
- Run ./deploy.sh
