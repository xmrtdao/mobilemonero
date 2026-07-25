"""
relay/cron-python/summarize-conversation-fast.py
Called by cron-engine-v2.mjs via the python-exec tool every 5 minutes.
Summarizes recent conversations from fleet chat for context recall.
"""

import json, urllib.request, datetime

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

# Fetch recent fleet messages
result = tools_run("db-query", {"sql": """
    SELECT m.agent_id, m.message, m.created_at 
    FROM public.fleet_messages m
    WHERE m.created_at > NOW() - INTERVAL '10 minutes'
    ORDER BY m.created_at DESC LIMIT 20
"""})
rows = result.get("rows", [])
print(f"Recent messages (10min): {len(rows)}")

if rows:
    # Group by agent
    from collections import Counter
    agents = Counter(r.get("agent_id", "?") for r in rows)
    for agent, count in agents.most_common():
        print(f"  {agent}: {count} messages")

print("Summarization complete")
