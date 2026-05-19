#!/usr/bin/env python3
"""
XMRT DAO Mesh Node - Simple HTTP-based P2P
Fallback when libp2p compilation fails on mobile
"""

import http.server
import socketserver
import json
import time
import threading
import requests
from datetime import datetime
from urllib.parse import urlparse

PORT = 4001
PEERS = []  # List of peer addresses
AGENT_NAME = "hermes"

# Use different ports for different agents
import sys
if len(sys.argv) > 1:
    AGENT_NAME = sys.argv[1]
    if AGENT_NAME == "vex":
        PORT = 4002
    elif AGENT_NAME == "eliza":
        PORT = 4003

class MeshHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_json({"status": "ok", "agent": AGENT_NAME, "peers": len(PEERS)})
        elif self.path == "/peers":
            self.send_json({"peers": PEERS})
        elif self.path == "/messages":
            self.send_json({"messages": message_log[-50:]})
        else:
            self.send_error(404)
    
    def do_POST(self):
        if self.path == "/broadcast":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode()
            try:
                data = json.loads(body)
                msg = {
                    "ts": datetime.utcnow().isoformat() + "Z",
                    "agent": data.get("agent", AGENT_NAME),
                    "message": data.get("message", ""),
                    "type": data.get("type", "broadcast")
                }
                message_log.append(msg)
                
                # Propagate to peers
                for peer in PEERS:
                    try:
                        requests.post(f"http://{peer}/broadcast", json=msg, timeout=2)
                    except:
                        pass
                
                self.send_json({"ok": True, "logged": True})
            except Exception as e:
                self.send_json({"error": str(e)}, 400)
        else:
            self.send_error(404)
    
    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def log_message(self, format, *args):
        print(f"[{datetime.utcnow().isoformat()}] {args[0]}")

message_log = []

def send_heartbeat():
    while True:
        msg = {
            "ts": datetime.utcnow().isoformat() + "Z",
            "agent": AGENT_NAME,
            "message": "heartbeat",
            "type": "heartbeat",
            "payload": {"status": "alive"}
        }
        message_log.append(msg)
        
        # Propagate to peers
        for peer in PEERS:
            try:
                requests.post(f"http://{peer}/broadcast", json=msg, timeout=2)
            except:
                pass
        
        time.sleep(30)

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        AGENT_NAME = sys.argv[1]
    if len(sys.argv) > 2:
        PEERS.extend(sys.argv[2].split(","))
    
    print(f"XMRT Mesh Node starting as: {AGENT_NAME}")
    print(f"Port: {PORT}")
    print(f"Peers: {PEERS}")
    
    # Start heartbeat thread
    threading.Thread(target=send_heartbeat, daemon=True).start()
    
    with socketserver.TCPServer(("", PORT), MeshHandler) as httpd:
        print(f"Listening on port {PORT}")
        httpd.serve_forever()
