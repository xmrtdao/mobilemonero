# 2a MTT Metadata Registry (CF Worker)

Endpoints
- POST /track/register  → Store arbitrary JSON metadata, returns generated id
- GET  /track/:id       → Retrieve stored metadata by id

Storage
- Prefers R2 (bind as `R2`), falls back to KV (bind as `KV`)

Deployment
- Bind R2 bucket or KV namespace in wrangler.toml / dashboard
- Run ./deploy.sh
