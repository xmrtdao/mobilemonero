#!/usr/bin/env python3
"""
Deploy inbox Worker via Cloudflare REST API (Termux compatible).
Usage: python3 deploy.py
Needs env vars: CF_ACCOUNT_ID, CF_API_TOKEN
"""
import base64, json, os, subprocess, sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
JS_PATH = os.path.join(SCRIPT_DIR, "src", "index.js")
ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "").strip()
TOKEN = os.environ.get("CF_API_TOKEN", "").strip()
ZONE_ID = "8710927c035b113b585b1d09403f7034"

def curl_json(method, url, headers=None, data=None):
    cmd = ["curl", "-s", "-X", method]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    if data:
        cmd += ["-d", data]
    cmd += [url]
    out = subprocess.check_output(cmd, encoding="utf-8")
    try:
        return json.loads(out)
    except Exception:
        return {"raw": out}

def deploy():
    if not ACCOUNT_ID or not TOKEN:
        print("ERROR: CF_ACCOUNT_ID and CF_API_TOKEN must be set", file=sys.stderr)
        sys.exit(1)

    with open(JS_PATH) as f:
        js_code = f.read()

    # Upload raw script (not multipart, not base64 wrapped in JSON)
    print("Uploading inbox Worker script...")
    res = curl_json(
        "PUT",
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/inbox",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/javascript"
        },
        data=js_code
    )
    if res.get("success") or res.get("result") is not None:
        print("Script uploaded OK")
    else:
        print("Script upload FAILED:", json.dumps(res, indent=2))
        sys.exit(1)

    # Add route
    print("Adding DNS route inbox.mobilemonero.com/* ...")
    route_payload = json.dumps({
        "pattern": "inbox.mobilemonero.com/*",
        "script": "inbox",
        "zone_id": ZONE_ID
    })
    res2 = curl_json(
        "POST",
        f"https://api.cloudflare.com/client/v4/zones/{ZONE_ID}/workers/routes",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json"
        },
        data=route_payload
    )
    print("Route response:", json.dumps(res2, indent=2))

if __name__ == "__main__":
    deploy()
