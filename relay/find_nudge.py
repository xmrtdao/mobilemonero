
import json
import sys

try:
    path = r"C:\Users\PureTrek\AppData\Local\hermes\cron\jobs.json"
    with open(path, 'r') as f:
        data = json.load(f)
    
    found = False
    for job in data.get('jobs', []):
        name = job.get('name', '')
        if 'nudge' in name.lower():
            print(f"FOUND:{job['id']}:{name}")
            found = True
    
    if not found:
        print("NOT_FOUND")
except Exception as e:
    print(f"ERROR:{e}")
    sys.exit(1)

