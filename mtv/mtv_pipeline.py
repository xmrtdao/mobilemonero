#!/usr/bin/env python3
"""
XMRT DAO — AI MTV Pipeline
Fires MiniMax music generation for each track, downloads audio, optionally generates video/image,
and syncs to a deployment target (Hugging Face Spaces or GitHub Pages).

Usage:
    python3 mtv_pipeline.py --check-balance          # verify MiniMax plan first
    python3 mtv_pipeline.py --track meshfire         # generate one track
    python3 mtv_pipeline.py --tracks all             # generate all tracks
    python3 mtv_pipeline.py --tracks all --video     # also generate video clips
    python3 mtv_pipeline.py --sync                   # sync assets to HF Spaces

After MiniMax top-up: edit MINIMAX_API_KEY below or set env var.
"""

import os
import sys
import json
import time
import subprocess
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional

# ── Config ───────────────────────────────────────────────────────────────────
MINIMAX_API_KEY = os.environ.get(
    "MINIMAX_API_KEY",
    "sk-api-9AmCqBqZHHUO7LPlM-AWrjsPEIhWOzToga4p_2SHZCTk-s-G7u8ULu9y9z-V8dDvb-LCjGhBkyyfN9whRmGLk80T-r-7OyIaeTi5ijwsOnz9vdnAb-157qk",
)
API_BASE = "https://api.minimaxi.chat"
TRACKS_FILE = Path(__file__).with_name("mtv_tracks.json")
AUDIO_DIR = Path.home() / "mtt" / "audio"
VIDEO_DIR = Path.home() / "mtt" / "video"
IMAGES_DIR = Path.home() / "mtt" / "images"
POLL_INTERVAL = 5  # seconds between status polls

# ── Helpers ────────────────────────────────────────────────────────────────


def api_post(path: str, payload: dict) -> dict:
    url = f"{API_BASE}{path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {MINIMAX_API_KEY}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())


def api_get(path: str) -> dict:
    url = f"{API_BASE}{path}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {MINIMAX_API_KEY}"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def check_balance() -> bool:
    """Return True if the account has an active token plan."""
    try:
        r = api_get("/v1/token_plan/remains")
        if r.get("base_resp", {}).get("status_code") == 2062:
            print("❌ No active token plan.")
            return False
        if r.get("base_resp", {}).get("status_code") == 1008:
            print("❌ Insufficient balance.")
            return False
        remains = r.get("model_remains")
        if remains is None:
            print("⚠️  Token plan check inconclusive. Response:", r)
            return False
        print(f"✅ Token plan active. Remaining credits: {remains}")
        return True
    except urllib.error.HTTPError as e:
        body = json.loads(e.read().decode()) if e.fp else {}
        code = body.get("base_resp", {}).get("status_code", e.code)
        msg = body.get("base_resp", {}).get("status_msg", str(e))
        print(f"❌ HTTP {e.code}: [{code}] {msg}")
        return False
    except Exception as e:
        print(f"❌ Balance check failed: {e}")
        return False


def generate_music(track: dict, model: str = "music-2.6", dry_run: bool = False) -> Optional[str]:
    """Call MiniMax music generation. Return task_id or None."""
    payload = {
        "model": model,
        "prompt": track["musicPrompt"],
        "lyrics": track["lyrics"],
        "is_instrumental": track.get("instrumental", False),
        "audio_setting": {
            "format": "mp3",
            "sample_rate": 44100,
            "bitrate": 256000,
        },
        "output_format": "url",
        "stream": False,
    }
    if dry_run:
        print(f"📝 DRY RUN would POST /v1/music_generation with:\n{json.dumps(payload, indent=2)}")
        return "dry-run-task-001"

    print(f"🎵 Firing music generation for '{track['title']}' ...")
    r = api_post("/v1/music_generation", payload)
    base = r.get("base_resp", {})
    if base.get("status_code") != 0:
        print(f"❌ Error [{base.get('status_code')}]: {base.get('status_msg')}")
        return None
    # MiniMax music is synchronous with output_format=url; audio_url is in r.data.audio_url
    audio_url = r.get("data", {}).get("audio_url")
    if audio_url:
        print(f"✅ Audio ready: {audio_url}")
        return audio_url
    # If async task_id style ever appears:
    task_id = r.get("data", {}).get("task_id")
    if task_id:
        print(f"⏳ Task queued: {task_id}")
        return task_id
    print("⚠️  Unexpected response:", json.dumps(r, indent=2))
    return None


def download_audio(track_id: str, audio_url: str, out_dir: Path) -> Path:
    """Download MP3 from audio_url."""
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"{track_id}.mp3"
    print(f"⬇️  Downloading {audio_url} → {dest} ...")
    subprocess.run(["curl", "-s", "-L", "-o", str(dest), audio_url], check=True)
    print(f"✅ Saved {dest.stat().st_size} bytes")
    return dest


def generate_video(track: dict, out_dir: Path, dry_run: bool = False) -> Optional[str]:
    """Call MiniMax video generation. Return task_id."""
    payload = {
        "model": "MiniMax-Video-01",  # adjust when docs confirm
        "prompt": track["videoPrompt"],
        "duration": 5,  # seconds; increase after top-up
    }
    if dry_run:
        print(f"📝 DRY RUN video:\n{json.dumps(payload, indent=2)}")
        return "dry-run-video-001"
    print(f"🎬 Firing video generation for '{track['title']}' ...")
    try:
        r = api_post("/v1/video_generation", payload)
    except urllib.error.HTTPError as e:
        body = json.loads(e.read().decode()) if e.fp else {}
        print(f"❌ Video gen failed [{body.get('base_resp',{}).get('status_code')}]: {body.get('base_resp',{}).get('status_msg')}")
        return None
    task_id = r.get("data", {}).get("task_id")
    if task_id:
        print(f"⏳ Video task: {task_id}")
    return task_id


def poll_video_task(task_id: str) -> Optional[str]:
    """Poll until video complete. Return download URL."""
    while True:
        r = api_get(f"/v1/query/video_generation?task_id={task_id}")
        status = r.get("status")
        if status == "Success":
            url = r.get("file", {}).get("download_url")
            print(f"✅ Video ready: {url}")
            return url
        if status in ("Fail", "Cancelled"):
            print(f"❌ Video task {status}")
            return None
        print(f"⏳ Video status: {status} ... sleeping {POLL_INTERVAL}s")
        time.sleep(POLL_INTERVAL)


def download_video(track_id: str, video_url: str, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"{track_id}.mp4"
    print(f"⬇️  Downloading video → {dest} ...")
    subprocess.run(["curl", "-s", "-L", "-o", str(dest), video_url], check=True)
    print(f"✅ Saved {dest.stat().st_size} bytes")
    return dest


def sync_hf_spaces():
    """Placeholder: sync audio/ dirs to HF Spaces via huggingface_hub CLI or git."""
    print("🚀 Sync to HF Spaces — run manually or wire hf hub CLI here.")
    # e.g., subprocess.run(["huggingface-cli", "upload", "--repo-type=space", "xmrtdao/xmrt-mtv", str(AUDIO_DIR)])


def main():
    import argparse
    ap = argparse.ArgumentParser(description="XMRT DAO AI MTV Pipeline")
    ap.add_argument("--check-balance", action="store_true", help="Verify MiniMax token plan")
    ap.add_argument("--track", type=str, help="Generate single track ID (meshfire|cryptonight|zeroclaw)")
    ap.add_argument("--tracks", type=str, help="Generate all tracks (use 'all')")
    ap.add_argument("--video", action="store_true", help="Also generate video clips")
    ap.add_argument("--sync", action="store_true", help="Sync assets to HF Spaces")
    ap.add_argument("--dry-run", action="store_true", help="Print payloads, skip API calls")
    ap.add_argument("--model", default="music-2.6", choices=["music-2.6","music-2.5+","music-2.5"], help="Music model")
    args = ap.parse_args()

    if not TRACKS_FILE.exists():
        print(f"❌ Tracks file not found: {TRACKS_FILE}")
        sys.exit(1)

    tracks = json.loads(TRACKS_FILE.read_text())["tracks"]
    tracks_by_id = {t["id"]: t for t in tracks}

    if args.check_balance:
        ok = check_balance()
        sys.exit(0 if ok else 1)

    selected = []
    if args.track:
        selected = [tracks_by_id.get(args.track)]
        if not selected[0]:
            print(f"❌ Unknown track: {args.track}")
            sys.exit(1)
    elif args.tracks == "all":
        selected = tracks

    if not selected:
        ap.print_help()
        sys.exit(0)

    for t in selected:
        print(f"\n=== 🎵 {t['title']} : {t['theme']} ===")
        audio_url = generate_music(t, model=args.model, dry_run=args.dry_run)
        if audio_url and not args.dry_run:
            if audio_url.startswith("http"):
                download_audio(t["id"], audio_url, AUDIO_DIR)
            else:
                # async path if ever needed
                pass

        if args.video:
            video_task = generate_video(t, VIDEO_DIR, dry_run=args.dry_run)
            if video_task and not args.dry_run and not video_task.startswith("dry"):
                video_url = poll_video_task(video_task)
                if video_url:
                    download_video(t["id"], video_url, VIDEO_DIR)

    if args.sync:
        sync_hf_spaces()

    print("\n🎬 Pipeline complete. Audio dir:", AUDIO_DIR)


if __name__ == "__main__":
    main()
