"""
relay/cron-python/extract-knowledge.py
Called by cron-engine-v2.mjs via the python-exec tool every 15 minutes.
Extracts knowledge from unprocessed fleet chat messages and stores them
in the knowledge base via the relay's tools.
"""

import json, urllib.request, sys

RELAY = "http://127.0.0.1:8080"
KEY = "3a02d6eecc89f1c700c097f9034479c24a56787acfbc996c5d17086ecd364602"

def tools_run(tool, args=None):
    data = json.dumps({"tool": tool, "args": args or {}}).encode()
    req = urllib.request.Request(
        f"{RELAY}/tools/run",
        data=data,
        headers={"Content-Type": "application/json", "x-api-key": KEY, "x-agent-id": "cron"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)}

# Step 1: Check if there are unprocessed fleet messages
result = tools_run("db-query", {"sql": """
    SELECT COUNT(*) as cnt FROM app.cuttlefish_messages 
    WHERE processed_for_knowledge IS NOT TRUE
"""})
total = result.get("rows", [{}])[0].get("cnt", 0)
print(f"Unprocessed messages: {total}")

if total == 0:
    sys.exit(0)

# Step 2: Fetch unprocessed messages
msgs = tools_run("db-query", {"sql": """
    SELECT id, agent, message, channel, created_at 
    FROM app.cuttlefish_messages 
    WHERE processed_for_knowledge IS NOT TRUE
    ORDER BY created_at ASC LIMIT 20
"""})
rows = msgs.get("rows", [])
print(f"Fetched {len(rows)} messages")

# Step 3: Extract knowledge from each message
import re
for row in rows:
    msg_id = row["id"]
    msg_text = row.get("message", "")
    agent = row.get("agent", "unknown")
    
    # Skip system messages and short messages
    if len(msg_text) < 30:
        continue
    
    # Extract key topics (capitalized phrases, technical terms)
    topics = re.findall(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b', msg_text)
    topics = [t for t in topics if len(t) > 5 and t not in ("This", "That", "What", "There", "Here" "Note")]
    
    if topics:
        # Store as shared context
        topic_key = f"knowledge_auto_{msg_id[:8]}"
        context_result = tools_run("shared-context", {
            "action": "write",
            "key": topic_key,
            "value": {
                "source": agent,
                "content": msg_text[:500],
                "topics": topics[:5],
                "extracted_at": None,
            }
        })
        print(f"  Stored knowledge from {agent}: {topics[:3]}")
    
    # Mark as processed
    tools_run("db-query", {"sql": f"""
        UPDATE app.cuttlefish_messages 
        SET processed_for_knowledge = TRUE 
        WHERE id = {msg_id}
    """})

print("Knowledge extraction complete")
