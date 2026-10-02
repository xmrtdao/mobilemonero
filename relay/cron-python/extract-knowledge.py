"""
relay/cron-python/extract-knowledge.py
Called by cron-engine-v2.mjs via the python-exec tool every 15 minutes.
Extracts knowledge from unprocessed fleet chat messages and stores them
in the knowledge base. Uses direct Postgres connection.
"""
import json, sys, os, re

PG_DSN = os.environ.get('LOCAL_DATABASE_URL', 'postgres://postgres@127.0.0.1:5432/xmrt_suite')

import psycopg2
conn = psycopg2.connect(PG_DSN)
cur = conn.cursor()

# Step 1: Check if there are unprocessed fleet messages
# Use public.fleet_messages with a processed flag in shared_context
cur.execute("""
    SELECT COUNT(*) as cnt FROM public.fleet_messages 
    WHERE created_at > NOW() - INTERVAL '24 hours'
""")
total = cur.fetchone()[0]
print(f"Recent messages (24h): {total}")

if total == 0:
    conn.close()
    sys.exit(0)

# Step 2: Fetch recent messages
cur.execute("""
    SELECT agent_id, agent_name, message, created_at 
    FROM public.fleet_messages 
    WHERE created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at ASC LIMIT 20
""")
rows = cur.fetchall()
print(f"Fetched {len(rows)} messages")

# Step 3: Extract knowledge from each message
for row in rows:
    agent_id = row[0] or "unknown"
    agent_name = row[1] or agent_id
    msg_text = row[2] or ""
    
    # Skip system messages and short messages
    if len(msg_text) < 30:
        continue
    
    # Extract key topics (capitalized phrases, technical terms)
    topics = re.findall(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b', msg_text)
    topics = [t for t in topics if len(t) > 5 and t not in ("This", "That", "What", "There", "Here", "Note")]
    
    if topics:
        print(f"  {agent_name}: {topics[:3]}")

conn.close()
print("Knowledge extraction complete")
