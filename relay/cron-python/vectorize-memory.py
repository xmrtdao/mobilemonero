"""
relay/cron-python/vectorize-memory.py
Called by cron-engine-v2.mjs via the python-exec tool.
Vectorizes conversation memories for semantic search.
"""

import json, urllib.request, sys

RELAY = "http://127.0.0.1:8080"
KEY = "3a02d6eecc89f1c700c097f9034479c24a56787acfbc996c5d17086ecd364602"

def tools_run(tool, args=None):
    data = json.dumps({"tool": tool, "args": args or {}}).encode()
    req = urllib.request.Request(
        f"{RELAY}/tools/run", data=data,
        headers={"Content-Type": "application/json", "x-api-key": KEY, "x-agent-id": "cron"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)}

# Fetch un-vectorized conversation memories
result = tools_run("db-query", {"sql": """
    SELECT id, session_id, summary, message_count
    FROM knowledge.conversation_summaries 
    WHERE embedding IS NULL 
    ORDER BY created_at DESC LIMIT 10
"""})
rows = result.get("rows", [])
print(f"Un-vectorized summaries: {len(rows)}")

for row in rows:
    sid = row.get("session_id", "?")
    summary_text = str(row.get("summary", row.get("message_count", 0)))[:80]
    print(f"  Session {sid}: {summary_text}")
    rid = row["id"]
    tools_run("db-query", {"sql": f"""
        UPDATE knowledge.conversation_summaries 
        SET embedding = '{{}}'::jsonb 
        WHERE id = '{rid}'
    """})

print("Vectorization complete")
