#!/usr/bin/env python3
"""
XMRT DAO Meshtastic Bluetooth Bridge
Runs on Termux / Android / Linux as a local HTTP proxy to Meshtastic nodes.
Exposes REST API for the web app to talk to the mesh network.
Requirements: bleak (optional), meshtastic CLI (optional fallback)
"""

import os
import sys
import json
import time
import threading
import subprocess
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

CACHE_DIR = Path.home() / ".xmrtdao" / "mesh-bridge"
CACHE_FILE = CACHE_DIR / "nodes.json"

# ── Config ────────────────────────────────────────────────────────────────────
BRIDGE_PORT = int(os.environ.get("MESH_BRIDGE_PORT", "9001"))
MESH_DEVICE = os.environ.get("MESH_DEVICE", "")  # BLE MAC or serial port
USE_BLEAK = False
try:
    from bleak import BleakClient
    USE_BLEAK = True
except ImportError:
    pass

# ── State ───────────────────────────────────────────────────────────────────
nodes = {}
messages = []
connected = False
lock = threading.Lock()


def load_cache():
    global nodes
    try:
        if CACHE_FILE.exists():
            nodes = json.loads(CACHE_FILE.read_text())
    except Exception as e:
        print(f"[!] Cache load error: {e}")


def save_cache():
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        CACHE_FILE.write_text(json.dumps(nodes, indent=2))
    except Exception as e:
        print(f"[!] Cache save error: {e}")


def mesh_cli(args):
    """Run meshtastic CLI command and return JSON or text."""
    try:
        cmd = ["meshtastic", "--host" if MESH_DEVICE else ""] + args
        cmd = [c for c in cmd if c]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if res.returncode == 0:
            return res.stdout
    except Exception as e:
        return f"CLI error: {e}"
    return None


def poll_nodes():
    """Background thread: poll meshtastic for nodes and messages."""
    global connected
    while True:
        try:
            out = mesh_cli(["--nodes"])
            if out and not out.startswith("CLI error"):
                connected = True
                # meshtastic --nodes returns plain text; parse roughly
                lines = out.splitlines()
                for line in lines:
                    if line.strip() and line[0].isdigit() or line.startswith("!"):
                        parts = line.split()
                        if len(parts) >= 2:
                            node_id = parts[0]
                            nodes[node_id] = {
                                "id": node_id,
                                "lastHeard": time.time(),
                                "raw": line,
                            }
                save_cache()
            else:
                connected = False
        except Exception as e:
            connected = False
            print(f"[poll] error: {e}")
        time.sleep(10)


# ── HTTP Handler ────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # quiet

    def _json(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/nodes":
            with lock:
                self._json(200, {"nodes": nodes, "connected": connected})
        elif path == "/messages":
            self._json(200, {"messages": messages[-100:]})
        elif path == "/status":
            self._json(200, {"connected": connected, "nodes": len(nodes), "bridge": "meshtastic-bridge"})
        else:
            self._json(404, {"error": "unknown endpoint"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode() if length else "{}"
        try:
            data = json.loads(body)
        except:
            data = {}

        if path == "/send":
            text = data.get("text", "")
            channel = data.get("channel", 0)
            to = data.get("to", "^all")
            if not text:
                self._json(400, {"error": "missing text"})
                return
            res = mesh_cli(["--sendtext", text, "--ch-index", str(channel)])
            msg = {
                "from": "local",
                "to": to,
                "channel": channel,
                "text": text,
                "timestamp": time.time(),
                "status": "sent" if res and not res.startswith("CLI error") else "failed",
            }
            with lock:
                messages.append(msg)
            self._json(200, msg)
        else:
            self._json(404, {"error": "unknown endpoint"})


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    load_cache()
    threading.Thread(target=poll_nodes, daemon=True).start()
    server = HTTPServer(("127.0.0.1", BRIDGE_PORT), Handler)
    print(f"[MeshtasticBridge] Listening on http://127.0.0.1:{BRIDGE_PORT}")
    print(f"[MeshtasticBridge] Cached nodes: {len(nodes)}")
    print(f"[MeshtasticBridge] BLEAK: {USE_BLEAK}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[!] Stopping bridge.")
        save_cache()


if __name__ == "__main__":
    main()
