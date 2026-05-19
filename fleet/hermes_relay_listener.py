#!/usr/bin/env python3
"""
Hermes Relay Listener — XMRT DAO Fleet
Broadcasts messages between Vex, Eliza-Cloud, and Hermes agents.
Port 9090 (unified, replaces old 8443)
"""

import http.server
import socketserver
import json
import time
from datetime import datetime
from urllib.parse import urlparse, parse_qs

PORT = 9090
FLEET_AGENTS = ["vex", "eliza-cloud", "hermes"]
message_log = []

class FleetRelayHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        
        if path == "/health":
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.end_headers()
            response = {
                "ok": True,
                "worker": "hermes-relay",
                "ts": datetime.utcnow().isoformat() + "Z",
                "agents": FLEET_AGENTS,
                "messages_count": len(message_log)
            }
            self.wfile.write(json.dumps(response).encode())
            return
        
        if path == "/fleet/status":
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.end_headers()
            response = {
                "relay": "UP",
                "port": PORT,
                "agents": {agent: "connected" for agent in FLEET_AGENTS},
                "uptime": "active"
            }
            self.wfile.write(json.dumps(response).encode())
            return
        
        if path == "/fleet/messages":
            query = parse_qs(parsed.query)
            limit = int(query.get("limit", [50])[0])
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(message_log[-limit:]).encode())
            return
        
        if path == "/fleet/heartbeat":
            query = parse_qs(parsed.query)
            agent = query.get("agent", ["unknown"])[0]
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.end_headers()
            response = {
                "ok": True,
                "agent": agent,
                "status": "alive",
                "ts": datetime.utcnow().isoformat() + "Z",
                "fleet": FLEET_AGENTS
            }
            self.wfile.write(json.dumps(response).encode())
            return
        
        if path == "/" or path == "":
            self.send_response(200)
            self.send_header("Content-type", "text/html")
            self.end_headers()
            html = """<!DOCTYPE html>
<html><head><title>Fleet Relay</title>
<style>body{font-family:monospace;background:#0a0a0f;color:#c0c0d0;padding:2rem}
h1{color:#ff6b35}.stat{margin:1rem 0}.ok{color:#4ade80}</style></head>
<body><h1>XMRT DAO Fleet Relay</h1>
<div class="stat">Status: <span class="ok">UP</span></div>
<div class="stat">Port: """ + str(PORT) + """</div>
<div class="stat">Agents: """ + ", ".join(FLEET_AGENTS) + """</div>
<div class="stat">Messages: """ + str(len(message_log)) + """</div>
<div class="stat"><a href="/health" style="color:#4a7cff">/health</a> | <a href="/fleet/status" style="color:#4a7cff">/fleet/status</a> | <a href="/fleet/messages" style="color:#4a7cff">/fleet/messages</a></div>
</body></html>"""
            self.wfile.write(html.encode())
            return
        
        self.send_response(404)
        self.end_headers()
    
    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        
        if path == "/fleet/broadcast":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode()
            try:
                data = json.loads(body)
                msg = {
                    "ts": datetime.utcnow().isoformat() + "Z",
                    "agent": data.get("agent", "unknown"),
                    "message": data.get("message", ""),
                    "type": data.get("type", "broadcast")
                }
                message_log.append(msg)
                if len(message_log) > 1000:
                    message_log.pop(0)
                
                self.send_response(200)
                self.send_header("Content-type", "application/json")
                self.end_headers()
                response = {"ok": True, "logged": True, "msg_id": len(message_log)}
                self.wfile.write(json.dumps(response).encode())
            except Exception as e:
                self.send_response(400)
                self.send_header("Content-type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
            return
        
        self.send_response(404)
        self.end_headers()
    
    def log_message(self, format, *args):
        print(f"[{datetime.utcnow().isoformat()}] {args[0]}")

if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), FleetRelayHandler) as httpd:
        print(f"Fleet Relay listening on port {PORT}")
        print(f"Agents: {', '.join(FLEET_AGENTS)}")
        print(f"Endpoints: /health, /fleet/status, /fleet/messages, /fleet/broadcast")
        httpd.serve_forever()
