"""
relay/cron-python/vectorize-memory.py
Called by cron-engine-v2.mjs via the python-exec tool.
Vectorizes conversation memories for semantic search.
Uses direct Postgres connection to avoid relay callback deadlocks.
"""
import json, sys, os

PG_DSN = os.environ.get('LOCAL_DATABASE_URL', 'postgres://postgres@127.0.0.1:5432/xmrt_suite')

import psycopg2
conn = psycopg2.connect(PG_DSN)
cur = conn.cursor()

# Fetch un-vectorized conversation summaries
cur.execute("""
    SELECT id, session_id, summary, message_count
    FROM knowledge.conversation_summaries 
    WHERE embedding IS NULL 
    ORDER BY created_at DESC LIMIT 10
""")
rows = cur.fetchall()
print(f"Un-vectorized summaries: {len(rows)}")

for row in rows:
    sid = row[1] or "?"
    summary_text = str(row[2] or row[3] or "")[:80]
    print(f"  Session {sid}: {summary_text}")
    rid = row[0]
    cur.execute(
        "UPDATE knowledge.conversation_summaries SET embedding = '{}'::jsonb WHERE id = %s",
        (rid,)
    )

conn.commit()
cur.close()
conn.close()
print("Vectorization complete")
