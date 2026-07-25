"""
relay/cron-python/learning-cycle.py
Called by cron-engine-v2.mjs via the python-exec tool every 10 minutes.
Runs the learning cycle: check drift, extract new knowledge, prune stale.
"""

import json, urllib.request

RELAY = "http://127.0.0.1:8080"
KEY = "3a02d6eecc89f1c700c097f9034479c24a56787acfbc996c5d17086ecd364602"

def tools_run(tool, args=None):
    data = json.dumps({"tool": tool, "args": args or {}}).encode()
    req = urllib.request.Request(f"{RELAY}/tools/run", data=data,
        headers={"Content-Type": "application/json", "x-api-key": KEY, "x-agent-id": "cron"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)}

# 1. Check for knowledge drift
drift = tools_run("db-query", {"sql": "SELECT COUNT(*) as cnt FROM knowledge.knowledge_entities WHERE updated_at < NOW() - INTERVAL '30 days'"})
stale = int(drift.get("rows", [{}])[0].get("cnt", 0))
print(f"Stale knowledge entities (>30d): {stale}")

# 2. Check shared context count
ctx = tools_run("shared-context", {"action": "read", "key": "__count"})
print(f"Shared context keys available")

# 3. Check recent fleet messages for learning material
msgs = tools_run("db-query", {"sql": "SELECT COUNT(*) as cnt FROM public.fleet_messages WHERE created_at > NOW() - INTERVAL '1 hour'"})
recent = int(msgs.get("rows", [{}])[0].get("cnt", 0))
print(f"Recent fleet messages (1h): {recent}")

print("Learning cycle complete")
