#!/usr/bin/env python3
"""
Mesh-Fleet Bridge — XMRT DAO
Polls Hermes mesh node (port 4001) and forwards messages to fleet relay (port 9090).
Also forwards messages from cloud relay to mesh for cross-agent propagation.
"""

import requests
import time
import json
from datetime import datetime

MESH_URL = "http://127.0.0.1:4001"
LOCAL_RELAY_URL = "http://127.0.0.1:9090"
CLOUD_RELAY_URL = "https://relay.mobilemonero.com/api/fleet-chat"
POLL_INTERVAL = 5  # seconds
HEADERS = {"User-Agent": "Hermes-Agent/1.0", "Content-Type": "application/json"}

seen_ids = set()

def get_mesh_messages():
    try:
        r = requests.get(f"{MESH_URL}/messages", timeout=5)
        return r.json().get("messages", [])
    except Exception as e:
        print(f"[{datetime.utcnow().isoformat()}] Mesh error: {e}")
        return []

def post_to_local_relay(agent, message):
    try:
        payload = {"agent": agent, "message": message, "type": "mesh-bridge"}
        r = requests.post(f"{LOCAL_RELAY_URL}/fleet/broadcast", json=payload, timeout=5)
        return r.status_code == 200
    except Exception as e:
        print(f"[{datetime.utcnow().isoformat()}] Relay error: {e}")
        return False

def get_cloud_relay_messages(limit=10):
    try:
        r = requests.get(f"{CLOUD_RELAY_URL}/messages?limit={limit}", headers=HEADERS, timeout=10)
        return r.json().get("messages", [])
    except Exception as e:
        print(f"[{datetime.utcnow().isoformat()}] Cloud relay error: {e}")
        return []

def post_to_mesh(agent, message):
    try:
        payload = {"agent": agent, "message": message, "type": "cloud-bridge"}
        r = requests.post(f"{MESH_URL}/broadcast", json=payload, timeout=5)
        return r.status_code == 200
    except Exception as e:
        print(f"[{datetime.utcnow().isoformat()}] Mesh post error: {e}")
        return False

def main():
    print(f"[{datetime.utcnow().isoformat()}] Mesh-Fleet Bridge starting")
    print(f"  Mesh: {MESH_URL}")
    print(f"  Local relay: {LOCAL_RELAY_URL}")
    print(f"  Cloud relay: {CLOUD_RELAY_URL}")
    print(f"  Poll interval: {POLL_INTERVAL}s")
    print()

    while True:
        # 1. Mesh → Local Relay (bridge mesh messages to fleet)
        mesh_msgs = get_mesh_messages()
        for m in mesh_msgs:
            key = m.get("ts", "") + m.get("message", "")[:20]
            if key in seen_ids:
                continue
            seen_ids.add(key)
            agent = m.get("agent", "unknown")
            msg = m.get("message", "")
            topic = m.get("type", "mesh")
            if post_to_local_relay(agent, msg):
                print(f"[{datetime.utcnow().isoformat()}] Mesh→Relay [{agent}/{topic}] {msg[:60]}")

        # 2. Cloud Relay → Mesh (bridge cloud messages to mesh for offline fallback)
        cloud_msgs = get_cloud_relay_messages(limit=5)
        for m in cloud_msgs:
            key = m.get("id", "") + m.get("message", "")[:20]
            if key in seen_ids or m.get("agent") == "hermes":
                continue
            seen_ids.add(key)
            agent = m.get("agent", "unknown")
            msg = m.get("message", "")
            if post_to_mesh(agent, msg):
                print(f"[{datetime.utcnow().isoformat()}] Relay→Mesh [{agent}] {msg[:60]}")

        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    main()
