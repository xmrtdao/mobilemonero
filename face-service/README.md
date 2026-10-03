# Face Service

Face detection + recognition over `insightface` + `onnxruntime`. CPU-first, with the
GPU path written and documented but **untested on this machine** (see *Hardware* below).

Standalone by design — no dependency on the relay, no existing project to fight.

---

## Hardware this was built and measured on

| | |
|---|---|
| CPU | Intel Core i5-8250U @ 1.60GHz, 8 logical cores |
| RAM | 6.3 GB total |
| GPU | **Intel UHD 620 integrated. No NVIDIA. No CUDA.** |
| `onnxruntime.get_available_providers()` | `['AzureExecutionProvider', 'CPUExecutionProvider']` |

This is a **CPU-only build**. `onnxruntime-gpu` cannot load here — there is no CUDA
device — so the brief's "GPU-first, buffalo_l on GPU" headline is not achievable on
this box, and the brief itself calls CPU "the fallback, not the headline". The GPU
path is documented below but **has not been executed or verified.** Treat it as a
guide, not a tested configuration.

Python **3.12.12** via `uv`. The brief specifies 3.10–3.12; note the default
interpreter on this machine is **3.13**, which is out of range and has no
insightface wheels.

---

## Install

```bash
uv venv --python 3.12
uv pip install insightface==0.7.3 onnxruntime==1.19.2 fastapi "uvicorn[standard]" numpy pillow python-multipart
```

Model pack downloads on first use into `./models/`. First load took **51.5s**,
almost entirely download. Subsequent loads are seconds.

---

## Run

**Exactly one worker.** This is the brief's stated #1 failure mode and it is
repeated here because it is easy to get wrong:

```bash
.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000 --workers 1
```

Each worker loads its own copy of the model. On a GPU, eight workers each holding
buffalo_l OOMs the card. On CPU it fails slower rather than less surely — eight
ONNX sessions contending for four physical cores.

Concurrency comes from the thread pool inside onnxruntime, not from workers.

```bash
curl http://127.0.0.1:8000/health
```

| Endpoint | Purpose |
|---|---|
| `GET /health` | model pack, det size, load time, identity count, active providers |
| `POST /detect` | detect + embed every face; optionally match against the index |
| `POST /register` | store one 512-d embedding under a name |
| `GET /identities` | list registered identities |
| `POST /identities/reload` | re-read identities from disk |

---

## Demo sources

Priority order from the brief: folder of stills → webcam → recorded clip → drone.

**1. Folder of stills** (source #1, needs no camera and no permissions):

```bash
.venv\Scripts\python.exe -m demo.stills --folder path/to/stills
.venv\Scripts\python.exe -m demo.stills --folder path/to/stills --repeat 20
.venv\Scripts\python.exe -m demo.stills --folder path/to/stills --enroll
```

**2. Webcam live** (source #2):

```bash
.venv\Scripts\python.exe -m demo.webcam --count 30 --fps
```

Camera access deliberately mirrors the relay's `vex-vision` tool handler
(`toolHandlers['vex-vision']` in `relay/server.js`) exactly:

```
C:\tools\ffmpeg\ffmpeg.exe -f dshow -i video="HP TrueVision HD Camera" \
    -frames:v 1 -q:v 2 -update 1 <out> -y
```

Two reasons for routing it this way rather than using `cv2.VideoCapture`:

* **One convention, one device handle.** A different device string or backend
  means a second competing handle on the same webcam, which on Windows usually
  fails outright rather than sharing.
* `cv2.VideoCapture` on Windows builds its own capture graph and ignores
  DirectShow device naming, so passing `"HP TrueVision HD Camera"` there means
  nothing.

Each `grab_frame()` opens and closes the device (~200–400ms on Windows). That is
a property of this capture path, not of the model — the demo reports model-only
latency separately from end-to-end so the two are not conflated.

---

## Model pack rationale

| | |
|---|---|
| **buffalo_s** (this build) | Small detection net + mobilefacenet-style recognition. ~20MB. Chosen because identity count is small and the box is CPU-only with 6.3GB RAM. |
| buffalo_l | Large pack, ~300MB, noticeably slower on CPU. Worth it only when small/far faces must be found, or on a GPU. |

`allowed_modules=['detection','recognition']` drops the **genderage** and the
106-point landmark heads. Verified at load:

```
find model: det_500m.onnx     detection
model ignore: genderage.onnx  genderage      <- dropped as intended
find model: w600k_mbf.onnx    recognition
```

Only detection + recognition are instantiated. This is roughly a 40% compute
saving and nothing in this service consumes the dropped outputs.

### Why `det_size=320`

`det_size` is the primary CPU throughput lever. 320 is the fastest useful
setting; 640 finds small faces materially better at roughly 4× the detect cost.
Raise it only if small or distant faces are being missed — it is
`FACE_DET_SIZE` in the environment, no code change needed.

### Why numpy cosine, not FAISS

Identity count is <5k, so the index is a few megabytes and a single
`(n_faces × 512) @ (512 × n_ids)` matmul is faster than FAISS's call overhead.
Both sides are L2-normalised, so the dot product *is* cosine similarity.
Revisit past ~50k identities.

---

## Configuration

All via environment variables — no code edits.

| Variable | Default | Notes |
|---|---|---|
| `FACE_MODEL_PACK` | `buffalo_s` | `buffalo_l` for the large pack |
| `FACE_DET_SIZE` | `320` | 640 finds small faces, ~4× cost |
| `FACE_ORT_THREADS` | `1` | **Leave at 1.** See below |
| `FACE_MATCH_THRESHOLD` | `0.45` | cosine floor for a "match" |
| `FACE_MODEL_ROOT` | `./models` | downloaded pack lives here |
| `FACE_IDENTITY_DIR` | `./identities` | `*.npy`, 512-d |
| `FACE_MAX_UPLOAD_BYTES` | `12582912` | 12MB |

**On threading:** `FACE_ORT_THREADS=1` is deliberate. onnxruntime sizes its own
intra-op pool from core count by default; letting it do that *while* a thread
pool also runs oversubscribes the CPU and is slower than either alone. One pool,
configured once.

---

## Gotchas, including the CUDA ones

**onnxruntime-gpu must replace onnxruntime, not sit beside it.** They ship the
same `onnxruntime` import path; installing both silently clobbers whichever came
last and produces an `ImportError` or a mysterious CPU-only fallback far from the
cause. Uninstall first:

```bash
.venv\Scripts\python.exe -m pip uninstall -y onnxruntime
uv pip install onnxruntime-gpu==1.19.2
```

**The CUDA/onnxruntime-gpu pairing is version-sensitive and this is where it bites.**
`onnxruntime-gpu` is built against a specific CUDA major version and cuDNN major
version, declared in its own package metadata. A mismatch surfaces as
`Failed to create inference session` or `libonnxruntime_providers_cuda.so: not
found` (on Windows: a missing `cudnn64_9.dll` / `cublas64_12.dll`) — an error
that says nothing about versions unless you know to look. Match the CUDA and
cuDNN majors your driver actually supports, and check them before upgrading
onnxruntime, not after.

**Also unset on CPU-only boxes:** a stray `onnxruntime-gpu` will import and then
fall back to CPU with a warning rather than failing loudly. Check
`/health` — it reports the active providers, which is the fastest way to confirm
which runtime you actually got.

**insightface has no 3.13 wheels.** Use 3.10–3.12.

**Windows note:** insightface needs a C++ toolchain if pip attempts to build from
source. The pinned versions here ship wheels for cp312 on win_amd64, so this only
bites on an unsupplied Python version.

---

## Not done

- **The GPU path is untested.** No CUDA device on this machine.
- **Live demo throughput not yet measured.** Model load is verified; a demo source
  has not been run end to end, so no fps figure is claimed. The definition of done
  in the brief asks for one, and it is outstanding.
- `vectorize`/bulk enrolment is out of scope; registration is one embedding at a
  time via `POST /register`.