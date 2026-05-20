#!/usr/bin/env python3
"""Deploy hermes Worker via Cloudflare REST API."""
import json, os, subprocess, sys, base64, textwrap

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
JS_PATH = os.path.join(SCRIPT_DIR, "src", "index.js")
ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "").strip()
TOKEN = os.environ.get("CF_API_TOKEN", "").strip()
ZONE_ID = "8710927c035b113b585b1d09403f7034"

def deploy():
    if not ACCOUNT_ID or not TOKEN:
        print("ERROR: CF_ACCOUNT_ID and CF_API_TOKEN must be set", file=sys.stderr)
        sys.exit(1)

    with open(JS_PATH) as f:
        js_code = f.read()

    print(f"Deploying hermes Worker ({len(js_code)} bytes)...")

    # Upload raw JS
    cmd = [
        "curl", "-s", "-X", "PUT",
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/hermes",
        "-H", f"Authorization: Bearer {TOKEN}",
        "-H", "Content-Type: application/javascript",
        "-d", js_code
    ]
    out = subprocess.check_output(cmd, encoding="utf-8")
    res = json.loads(out)
    if res.get("success") or res.get("result") is not None:
        print("Script uploaded OK")
    else:
        print("Script upload FAILED:", json.dumps(res, indent=2))
        sys.exit(1)

    # Ensure route exists
    print("Ensuring route hermes.mobilemonero.com/* ...")
    route_payload = json.dumps({
        "pattern": "hermes.mobilemonero.com/*",
        "script": "hermes",
        "zone_id": ZONE_ID
    })
    cmd2 = [
        "curl", "-s", "-X", "POST",
        f"https://api.cloudflare.com/client/v4/zones/{ZONE_ID}/workers/routes",
        "-H", f"Authorization: Bearer {TOKEN}",
        "-H", "Content-Type: application/json",
        "-d", route_payload
    ]
    out2 = subprocess.check_output(cmd2, encoding="utf-8")
    print("Route response:", out2[:500])

if __name__ == "__main__":
    deploy()
