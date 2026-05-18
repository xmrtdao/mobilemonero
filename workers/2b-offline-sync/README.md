# 2b Offline Sync Buffer (CF Worker)

Endpoints
- POST /mesh/buffer        → Store a message keyed by recipient+timestamp, returns msg_id
- POST /mesh/poll          → Retrieve all pending messages for a recipient
- DELETE /mesh/buffer/:msg_id → Acknowledge/delete a message

Storage
- Requires KV namespace bound as `KV`

Deployment
- Bind KV namespace in wrangler.toml / dashboard
- Run ./deploy.sh
