"""
Is Joe_Lee's prototype real, or did I just match the photo it was built from?

The earlier probe reported cosine=0.9964 for joe-lee.jpg. That number is close to
circular: `joe-lee.jpg` is the ONLY photo of Joe in the dataset, so it is the one
image that produced the prototype. Of course it matches itself. It says nothing
about whether the system will recognise him from a webcam.

A webcam frame differs from a gallery photo in every way that matters:
different sensor, different lens, 30-60x less face resolution, different colour
temperature, JPEG artefacts from the browser's canvas encode, and often a
different expression. A prototype built from a single reference cannot cover that
spread; a prototype built from 15 shots of the same person can.

So this harness does the only honest test available without a webcam: hold the
reference out, degrade it the way the camera path degrades it, and re-query the
gallery. It reports the cosine of the SAME person under each degradation, so the
drop tells us how much headroom there is above the live threshold.

Read it as a margin, not as an accuracy figure:
  * a number far above threshold means the identity is robust
  * a number near or below it means the live match is a coin flip
"""
from __future__ import annotations

import json
import sys
import urllib.request
import uuid
from pathlib import Path

import cv2
import numpy as np

BASE = "http://127.0.0.1:8090"
ROOT = Path(__file__).resolve().parent.parent
REF = Path(r"C:\Users\PureTrek\Desktop\Faces\Faces\joe-lee.jpg")
TMP = ROOT / "tools" / "_probe_frame.jpg"


def post_frame(img: np.ndarray) -> dict:
    """Send a frame through the same endpoint the browser camera uses."""
    cv2.imwrite(str(TMP), img)
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n".encode()
        + b'Content-Disposition: form-data; name="file"; filename="f.jpg"\r\n'
        + b"Content-Type: image/jpeg\r\n\r\n"
        + TMP.read_bytes()
        + f"\r\n--{boundary}--\r\n".encode()
    )
    req = urllib.request.Request(
        BASE + "/api/live/frame?session=robust-" + uuid.uuid4().hex[:8],
        data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def fit(img: np.ndarray, face_px: float) -> np.ndarray:
    """Resize so the face is about face_px wide - the live path's own budget."""
    h, w = img.shape[:2]
    det = max(1, int(np.hypot(w, h)))
    scale = (face_px / det) * (h / max(h, 1)) if det else 1.0
    # Approximate: face_px is roughly h/8 on a typical portrait, so scale on h.
    scale = (face_px * 8.0) / max(h, 1)
    if scale >= 1.0:
        return img
    return cv2.resize(img, (max(32, int(w * scale)), max(32, int(h * scale))),
                      interpolation=cv2.INTER_AREA)


def variants(img: np.ndarray) -> list[tuple[str, np.ndarray]]:
    h, w = img.shape[:2]
    out: list[tuple[str, np.ndarray]] = [("original", img)]
    for px in (240, 120, 70):
        out.append((f"face {px}px (webcam-ish)", fit(img, px)))
    # Cooler, flatter sensor, as a cheap laptop webcam under office light.
    cool = img.astype(np.float32)
    cool[:, :, 0] *= 0.88
    cool[:, :, 2] *= 1.10
    cool = np.clip(cool, 0, 255).astype(np.uint8)
    out.append(("cool/flat sensor", fit(cool, 120)))
    # Heavy JPEG, which is what the browser's canvas encode produces.
    ok, enc = cv2.imencode(".jpg", fit(img, 120), [int(cv2.IMWRITE_JPEG_QUALITY), 45])
    out.append(("jpeg q45 @120px", enc if ok else fit(img, 120)))
    return out


def main() -> int:
    if not REF.exists():
        print("reference photo missing:", REF)
        return 1
    try:
        urllib.request.urlopen(BASE + "/health", timeout=10)
    except Exception as exc:                            # noqa: BLE001
        print("service not reachable:", exc)
        return 1

    img = cv2.imread(str(REF))
    if img is None:
        print("reference photo did not decode:", REF)
        return 1

    thr = 0.0
    print(f"reference: {REF.name}  {img.shape[1]}x{img.shape[0]}")
    print(f"{'condition':<26} {'named':<7} {'name':<12} {'cosine':>8}  verdict")
    print("-" * 72)

    for label, frame in variants(img):
        d = post_frame(frame)
        ident = d.get("identify") or {}
        people = ident.get("people") or []
        best = None
        for p in people:
            f = p.get("face") or {}
            if f or p.get("cosine") is not None:
                best = p
                break
        if best is None:
            print(f"{label:<26} {'-':<7} {'-':<12} {'-':>8}  no face detected")
            continue
        cos = best.get("cosine")
        named = best.get("stage") == "named"
        print(f"{label:<26} {str(named):<7} {str(best.get('name') or '-'):<12} "
              f"{cos if cos is not None else '-':>8}  "
              f"{'MATCHED' if named else 'UNKNOWN'}")

    if TMP.exists():
        TMP.unlink()
    print()
    print("Compare against the live threshold - GET /api/calibration reports it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
