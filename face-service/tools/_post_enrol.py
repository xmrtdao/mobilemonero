"""
Call the enrolment endpoint in-process, as a real user would - one HTTP request
carrying several photos - and print exactly what comes back.

Why this exists rather than curl: curl 7.55 on this machine stalls on the
multipart upload. The request leaves with `Expect: 100-continue`, uvicorn
answers 100 Continue, and the transfer never completes - curl reports HTTP 000,
or a bare 100, and no body. That hid the fact that the endpoint had never
actually been exercised against a real multi-file upload.

And neither httpx nor starlette's TestClient is available in this venv (httpx is
absent; TestClient depends on it). So this speaks ASGI directly: build the
scope, send the body, collect the response. Same multipart bytes, same parser,
same handler the browser hits. If the endpoint is broken, this shows it.
"""
from __future__ import annotations

import asyncio
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

FACES = Path(r"C:\Users\PureTrek\Desktop\Faces\Faces")


def build_multipart(paths: list[Path]) -> tuple[bytes, str]:
    """One real multipart/form-data body with N file parts, all named `files`."""
    boundary = f"----opencode{uuid.uuid4().hex}"
    out = bytearray()
    for p in paths:
        out += f"--{boundary}\r\n".encode()
        out += (f'Content-Disposition: form-data; name="files"; '
                f'filename="{p.name}"\r\n').encode()
        out += b"Content-Type: image/jpeg\r\n\r\n"
        out += p.read_bytes()
        out += b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


async def call(app, name: str, paths: list[Path]) -> tuple[int, dict]:
    body, ctype = build_multipart(paths)
    query = f"name={name.replace(' ', '%20')}".encode()
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1", "method": "POST", "scheme": "http",
        "path": "/api/enrol", "raw_path": b"/api/enrol", "query_string": query,
        "root_path": "", "headers": [
            (b"host", b"127.0.0.1:8090"),
            (b"content-type", ctype.encode()),
            (b"content-length", str(len(body)).encode()),
        ],
        "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 8090),
    }
    sent = {"done": False}
    status, chunks = 0, []

    async def receive() -> dict:
        if sent["done"]:
            return {"type": "http.disconnect"}
        sent["done"] = True
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(msg: dict) -> None:
        nonlocal status
        if msg["type"] == "http.response.start":
            status = msg["status"]
        elif msg["type"] == "http.response.body":
            chunks.append(msg.get("body", b""))

    await app(scope, receive, send)
    raw = b"".join(chunks).decode("utf-8", "replace")
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, {"raw": raw[:800]}


def show(status: int, j: dict) -> None:
    print(f"\n  HTTP {status}")
    for k in ("ok", "name", "key", "updated_existing", "enrolled", "spread",
              "shot_quality", "shot_note", "reason", "identities"):
        if k in j:
            print(f"  {k:<17} {j[k]}")
    for r in j.get("rejected") or []:
        print(f"  REJECTED {r.get('file')}: {r.get('why')}")
    for d in j.get("similar_to") or []:
        print(f"  similar_to {d.get('name')} @ {d.get('cosine')}")


async def main() -> int:
    import graytech.server as S
    from app import face

    # The recogniser's model handle is None until the lifespan startup runs. This
    # harness calls the ASGI app directly, so nothing has loaded it - and without
    # this every upload dies inside insightface with a message about get() on
    # None. Load it here so the endpoint is exercised the way the server runs it.
    if getattr(face, "app", None) is None:
        print("\n  (lifespan did not run - loading the model explicitly)")
        face.load()
        face.reload_identities()

    cases = [
        ("cory-gray", sorted(FACES.glob("cory-gray*"))),
        ("joe-lee", sorted(FACES.glob("joe-lee*"))),
    ]
    for name, paths in cases:
        if not paths:
            print(f"\n=== {name}: no photos found")
            continue
        print(f"\n=== {name}: {len(paths)} photo(s) -> {[p.name for p in paths]}")
        show(*await call(S.application, name, paths))

    print("\n=== gallery state after enrolment ===")
    lst = await get_identities(S.application)
    print(f"  identities={lst.get('count')}  thin={lst.get('thin')}"
          f"  unknown={lst.get('unknown')}")
    for r in lst.get("identities", []):
        if r["quality"] != "ok":
            print(f"    {r['name']:<20} shots={r['shots']} quality={r['quality']}")
    return 0


async def get_identities(app) -> dict:
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": "/api/identities", "raw_path": b"/api/identities",
        "query_string": b"", "root_path": "",
        "headers": [(b"host", b"127.0.0.1:8090")],
        "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 8090),
    }
    status, chunks = 0, []

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(msg: dict) -> None:
        nonlocal status
        if msg["type"] == "http.response.start":
            status = msg["status"]
        elif msg["type"] == "http.response.body":
            chunks.append(msg.get("body", b""))

    await app(scope, receive, send)
    try:
        return json.loads(b"".join(chunks).decode("utf-8", "replace"))
    except ValueError:
        return {}


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
