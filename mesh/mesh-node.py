#!/usr/bin/env python3
"""
XMRT DAO Mesh Node v2.1 — HTTP-based P2P mesh with propagation deduplication.
Run: python3 mesh-node.py <agent> [peer1:port,peer2:port,...]
Example: python3 mesh-node.py hermes '1.2.3.4:4002,5.6.7.8:4003'
"""

import http.server, socketserver, json, time, threading, os, sys, hashlib
from datetime import datetime

try:
    import requests
except ImportError:
    print("ERROR: 'requests' not installed. Run: python3 -m pip install requests")
    sys.exit(1)

PORT = 4001
PEERS = []
AGENT_NAME = "hermes"
HEARTBEAT_INTERVAL = 30

if len(sys.argv) > 1:
    AGENT_NAME = sys.argv[1]
    if AGENT_NAME == "vex":       PORT = 4002
    elif AGENT_NAME == "eliza":  PORT = 4003

if len(sys.argv) > 2:
    PEERS = [p.strip() for p in sys.argv[2].split(",") if p.strip()]
if os.environ.get("MESH_PEERS"):
    PEERS = [p.strip() for p in os.environ["MESH_PEERS"].split(",") if p.strip()]

message_log = []
seen_ids = set()
seen_lock = threading.Lock()
log_lock = threading.Lock()

class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True

class MeshHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            with seen_lock:
                msg_count = len(message_log)
            self.send_json({"ok": True, "agent": AGENT_NAME, "port": PORT,
                            "peers": PEERS, "messages": msg_count})
        elif self.path == "/peers":
            self.send_json({"ok": True, "peers": PEERS, "agent": AGENT_NAME})
        elif self.path == "/messages":
            with seen_lock:
                msgs = message_log[-200:]
            self.send_json({"ok": True, "messages": msgs, "count": len(msgs),
                            "agent": AGENT_NAME})
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != "/broadcast":
            self.send_error(404)
            return

        cl = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(cl).decode()
        try:
            data = json.loads(body)
        except json.JSONDecodeError as e:
            self.send_json({"ok": False, "error": "bad json"}, 400)
            return

        # Normalize message fields
        ts     = data.get("ts", datetime.utcnow().isoformat() + "Z")
        agent  = data.get("agent", AGENT_NAME)
        msg    = data.get("message", "")
        mtype  = data.get("type", "broadcast")
        msg_id = data.get("id", _make_id(ts, agent, msg))
        hops   = data.get("hops", 0)

        if hops > 10:
            self.send_json({"ok": False, "error": "hop limit exceeded"}, 400)
            return

        # Deduplicate
        is_new = False
        with seen_lock:
            if msg_id not in seen_ids:
                seen_ids.add(msg_id)
                is_new = True

        if is_new:
            entry = {"id": msg_id, "ts": ts, "agent": agent,
                     "message": msg, "type": mtype, "hops": hops}
            with log_lock:
                message_log.append(entry)
                if len(message_log) > 1000:
                    message_log.pop(0)

            # Propagate to peers (fire-and-forget)
            payload = {"id": msg_id, "ts": ts, "agent": agent,
                       "message": msg, "type": mtype, "hops": hops + 1}
            for peer in PEERS:
                try:
                    requests.post(f"http://{peer}/broadcast", json=payload,
                                  timeout=2)
                except Exception:
                    pass

        self.send_json({"ok": True, "logged": is_new, "id": msg_id})

    def send_json(self, data, status=200):
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass  # client closed early; message still handled

    def log_message(self, fmt, *args):
        print(f"[{datetime.utcnow().isoformat()}] [{AGENT_NAME}] {args[0]}")

def _make_id(ts, agent, msg):
    """Deterministic ID so same content from different paths dedups."""
    return hashlib.sha256(f"{ts}:{agent}:{msg}".encode()).hexdigest()[:16]

def heartbeat():
    time.sleep(3)
    while True:
        time.sleep(HEARTBEAT_INTERVAL)
        ts = datetime.utcnow().isoformat() + "Z"
        msg_id = _make_id(ts, AGENT_NAME, "heartbeat")
        entry = {"id": msg_id, "ts": ts, "agent": AGENT_NAME,
                 "message": "heartbeat", "type": "heartbeat", "hops": 0}

        is_new = False
        with seen_lock:
            if msg_id not in seen_ids:
                seen_ids.add(msg_id)
                is_new = True
        if is_new:
            with log_lock:
                message_log.append(entry)
                if len(message_log) > 1000:
                    message_log.pop(0)

        for peer in PEERS:
            try:
                requests.post(f"http://{peer}/broadcast",
                              json={"id": msg_id, "ts": ts,
                                    "agent": AGENT_NAME, "message": "heartbeat",
                                    "type": "heartbeat", "hops": 1},
                              timeout=2)
            except Exception:
                pass

if __name__ == "__main__":
    print(f"[{AGENT_NAME}] Mesh Node v2.1 — port {PORT} — peers {PEERS}")
    threading.Thread(target=heartbeat, daemon=True).start()
    with ReusableTCPServer(("", PORT), MeshHandler) as httpd:
        print(f"[{AGENT_NAME}] listening on port {PORT}")
        httpd.serve_forever()
