/**
 * Perception — turn a video or image into something an agent can actually judge.
 *
 * WHY THIS EXISTS
 *
 * video-editor.mjs cuts film it has never seen. Its nine operations are info,
 * trim, concat, text-overlay, thumbnail, audio-extract, watermark, speed, gif.
 * None of them looks at or listens to anything, and thumbnail takes one frame.
 * So an agent could trim a thirty-second spot to the millisecond while being
 * entirely blind to the fact that it is thirty seconds of one static frame.
 *
 * vex-vision had the same problem in a different place: for video it ran
 * `-frames:v 1`. One frame. It was a poster reader wearing a vision tool's
 * name.
 *
 * So the mechanical perception is done here, in ffmpeg, where it is exact and
 * free: what the file is, where the cuts are, what the frames look like laid
 * side by side, how loud it actually is, where the energy sits. One vision call
 * then interprets that evidence under a cinematographer's brief, and the result
 * comes back as text.
 *
 * Text on purpose. Jobby's brain is text, the relay's agents are text, and a
 * brief is cacheable, auditable and cheap to re-read - the same reason
 * extract_outstanding and verification.mjs return structure rather than noise.
 *
 * HONESTY
 *
 * Every field is either measured or labelled as inferred. If the vision call
 * fails, the brief says so and returns the measurements alone; it does not
 * invent a read on the picture. A brief that fabricates its own evidence is
 * worse than no brief, because it looks like one.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

// ── Binary resolution ──────────────────────────────────────────────
// The installed build is N-122942 (2026-02-22); the one bundled in node_modules
// via @ffmpeg-installer is a 2018 build. Prefer the installed one, fall back to
// the bundle so the relay still works on a machine that only has that.
// Note: Windows resolves "C:\tools\ffmpeg" to ffmpeg.exe, which is why the
// existing hardcoded path in server.js works even though Test-Path on the
// extensionless name returns false.
const FFMPEG_CANDIDATES = [
  'C:\\tools\\ffmpeg.exe',
  join(process.cwd(), 'relay', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
  'ffmpeg',
];
const FFPROBE_CANDIDATES = [
  'C:\\tools\\ffprobe.exe',
  join(process.cwd(), 'relay', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffprobe.exe'),
  'ffprobe',
];

function resolveBinary(candidates) {
  for (const c of candidates) {
    try {
      if (c === 'ffmpeg' || c === 'ffprobe') return c; // rely on PATH
      if (existsSync(c)) return c;
    } catch { /* keep looking */ }
  }
  return candidates[candidates.length - 1];
}

const FFMPEG = resolveBinary(FFMPEG_CANDIDATES);
const FFPROBE = resolveBinary(FFPROBE_CANDIDATES);

/** Run a binary and return both streams. FFmpeg reports most of its useful
 *  output on stderr, so neither stream can be discarded. */
async function run(bin, args, timeout = 120000) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout || '',
      stderr: e.stderr || e.message || '',
      code: e.code,
    };
  }
}

// ── 1. Technical facts ─────────────────────────────────────────────
export async function probe(input) {
  const r = await run(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', input,
  ], 60000);
  if (!r.ok) return { error: 'ffprobe failed: ' + (r.stderr || '').slice(0, 200) };
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { error: 'ffprobe returned unparseable JSON' }; }

  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const fps = v && v.avg_frame_rate && v.avg_frame_rate !== '0/0'
    ? (() => { const [n, d] = v.avg_frame_rate.split('/').map(Number); return d ? +(n / d).toFixed(3) : null; })()
    : null;

  return {
    durationSec: j.format?.duration ? +parseFloat(j.format.duration).toFixed(2) : null,
    bytes: j.format?.size ? +j.format.size : null,
    bitrate: j.format?.bit_rate ? +j.format.bit_rate : null,
    formatName: j.format?.format_name || null,
    video: v ? {
      codec: v.codec_name, width: v.width, height: v.height, fps,
      pixFmt: v.pix_fmt,
      // A still image delivered as "video" is the classic case: an agent trimming
      // it should know there is only ever going to be one shot.
      frameCount: v.nb_frames ? +v.nb_frames : null,
    } : null,
    audio: a ? {
      codec: a.codec_name,
      sampleRate: a.sample_rate ? +a.sample_rate : null,
      channels: a.channels || null,
      channelLayout: a.channel_layout || null,
    } : null,
    isStillImage: !!v && !a && (v.nb_frames === '1' || (fps !== null && fps < 0.5)),
  };
}

// ── 2. Shot boundaries ─────────────────────────────────────────────
/**
 * Real cut detection, via scdet + metadata=print. This is what turns "a video"
 * into a shot list, and it is the difference between a brief that says "opens on
 * a wide" and one that can say "four cuts in six seconds, all under a second".
 */
export async function detectShots(input, threshold = 12) {
  const r = await run(FFMPEG, [
    '-hide_banner', '-i', input,
    '-vf', `scdet=threshold=${threshold},metadata=print:file=-`,
    '-an', '-f', 'null', '-',
  ], 120000);
  if (!r.ok) return { error: 'scene detection failed: ' + (r.stderr || '').slice(0, 160) };

  const times = [];
  let pendingScore = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/lavfi\.scd\.(score|time)=([0-9.]+)/);
    if (!m) continue;
    if (m[1] === 'score') pendingScore = +m[2];
    else times.push({ time: +m[2], score: pendingScore });
  }
  const cutTimes = times.map((t) => t.time);
  const sorted = [...new Set(cutTimes)].sort((a, b) => a - b);
  const shotLengths = sorted.map((c, i) => +(c - (i === 0 ? 0 : sorted[i - 1])).toFixed(2));

  return {
    shotCount: sorted.length + 1,
    cuts: sorted,
    shotLengths,
    meanShotLength: shotLengths.length
      ? +(shotLengths.reduce((a, b) => a + b, 0) / shotLengths.length).toFixed(2) : null,
    shortestShot: shotLengths.length ? Math.min(...shotLengths) : null,
    longestShot: shotLengths.length ? Math.max(...shotLengths) : null,
  };
}

// ── 3. Contact sheet ───────────────────────────────────────────────
/**
 * The whole picture in one image. A contact sheet is what makes this affordable:
 * thirty seconds of spot becomes one PNG instead of nine hundred vision calls, and
 * a human or a model can read the edit as an edit.
 *
 * Frames are sampled evenly rather than at cuts, so a single long take still
 * shows its own shape. Use detectShots first if you want cut-accurate sampling.
 */
export async function contactSheet(input, {
  frames = 12, cols = 4, tileWidth = 320, outPath = null, from = null, to = null,
} = {}) {
  const n = Math.max(2, Math.min(48, frames | 0));
  const c = Math.max(1, Math.min(8, cols | 0));
  const rows = Math.ceil(n / c);
  const target = outPath || join(tmpdir(), `perception-sheet-${randomUUID().slice(0, 8)}.png`);

  // Sample by time so the sheet is evenly spaced regardless of source fps.
  const rate = `1/${Math.max(0.04, 1 / n)}`;
  const filter = `fps=${rate},scale=${tileWidth}:-2:flags=lanczos,tile=${c}x${rows}`;
  const args = ['-hide_banner', '-y'];
  if (from != null) args.push('-ss', String(from));
  args.push('-i', input);
  if (to != null) args.push('-t', String(+to - (+from || 0)));
  args.push('-vf', filter, '-frames:v', '1', target);

  const r = await run(FFMPEG, args, 180000);
  if (!r.ok || !existsSync(target)) {
    return { error: 'contact sheet failed: ' + (r.stderr || '').slice(-220) };
  }
  return {
    path: target,
    base64: readFileSync(target).toString('base64'),
    bytes: readFileSync(target).length,
    frames: n, cols: c, rows,
  };
}

// ── 4. Loudness ────────────────────────────────────────────────────
/**
 * Measured, not guessed. EBU R128 integrated loudness is the number a broadcaster
 * or an ad house actually checks, and "does it sound right" is not answerable
 * without it. Delivery targets sit near -14 LUFS for web, -23 for broadcast.
 */
export async function loudness(input) {
  const r = await run(FFMPEG, [
    '-hide_banner', '-i', input, '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], 180000);
  if (!r.ok) return { error: 'loudness analysis failed: ' + (r.stderr || '').slice(-200) };

  const tail = r.stderr.slice(-3000);
  const grab = (label) => {
    const m = tail.match(new RegExp(label + '\\s*:\\s*(-?[0-9.]+|-inf)'));
    return m ? (m[1] === '-inf' ? null : +m[1]) : null;
  };
  const integrated = grab('I');
  const range = grab('LRA');
  const truePeak = (() => {
    const m = tail.match(/Peak:\s*(-?[0-9.]+)\s*dBFS/);
    return m ? +m[1] : null;
  })();

  let verdict = null;
  if (integrated != null) {
    if (integrated > -10) verdict = 'very loud - will sound compressed and fatiguing';
    else if (integrated > -12) verdict = 'loud, roughly a music-master level';
    else if (integrated >= -16) verdict = 'in the normal range for web delivery';
    else if (integrated >= -24) verdict = 'quiet, closer to a broadcast target';
    else verdict = 'very quiet - likely to be turned up by the viewer';
  }
  return { integratedLufs: integrated, loudnessRange: range, truePeakDb: truePeak, verdict };
}

// ── 5. Waveform ────────────────────────────────────────────────────
export async function waveform(input, { width = 1200, height = 240, outPath = null } = {}) {
  const target = outPath || join(tmpdir(), `perception-wave-${randomUUID().slice(0, 8)}.png`);
  const r = await run(FFMPEG, [
    '-hide_banner', '-y', '-i', input,
    '-filter_complex', `showwavespic=s=${width}x${height}:colors=white`,
    '-frames:v', '1', target,
  ], 120000);
  if (!r.ok || !existsSync(target)) return { error: 'waveform failed: ' + (r.stderr || '').slice(-200) };
  return { path: target, base64: readFileSync(target).toString('base64') };
}

// ── 6. The brief ───────────────────────────────────────────────────
const BRIEF_PROMPT = [
  'You are a director and a New York creative reviewing a spot. Below is a contact',
  'sheet: frames sampled evenly left-to-right, top-to-bottom, from one video, in',
  'chronological order.',
  '',
  'Measured facts about this cut, for grounding. Treat them as true:',
  '{{FACTS}}',
  '',
  'Answer in this shape, and be specific rather than flattering:',
  'SHOTS: how many distinct setups you can actually see, and what changes between them.',
  'PACE: does the cutting suit the material, and where does it drag or rush.',
  'FRAMING: what the camera is doing - scale, angle, movement, composition.',
  'LOOK: colour, contrast, exposure, and whether it is consistent across shots.',
  'CONTINUITY: anything that breaks between shots - a jump in colour, light, or subject.',
  'VERDICT: the single most useful note for whoever has to cut this next.',
  '',
  'If the frames do not support one of these, say "not evident from the frames". Do not',
  'invent a detail you cannot see.',
].join('\n');

/**
 * Build a perceptual brief for a video or an image.
 *
 * Returns measurements plus, when a vision model was reachable, its read. The
 * two are kept separate on purpose: `measured` is what ffmpeg knows, `read` is a
 * model's opinion about it, and a caller can trust them to different degrees.
 */
export async function videoBrief(args) {
  // Media is addressed by id, never by path. resolveRef refuses any path that is
  // not already inside the managed root, which is what removes the arbitrary-file
  // read from these tools - an `input` path that used to go straight to ffmpeg
  // would have let any caller hand this process a file off the disk.
  const { resolveRef } = await import('./media-registry.mjs');
  const ref = args?.media_id || args?.mediaId || args?.input || args?.file || args?.path;
  const resolved = resolveRef(ref);
  if (!resolved.ok) return { success: false, error: resolved.error, suggestion: resolved.suggestion || null };
  const input = resolved.entry.path;
  const mediaId = resolved.entry.id;

  const want = {
    shots: args?.shots !== false,
    loudness: args?.loudness !== false,
    waveform: args?.waveform === true,
    transcript: args?.transcript || null,
  };

  const measured = {
    media: { id: mediaId, kind: resolved.entry.kind, label: resolved.entry.label || null },
    binary: { ffmpeg: FFMPEG, ffprobe: FFPROBE },
  };
  const warnings = [];

  measured.technical = await probe(input);
  if (measured.technical.error) return { success: false, error: measured.technical.error };

  if (want.shots) {
    const s = await detectShots(input, args?.scene_threshold ?? 12);
    if (s.error) warnings.push('shot detection: ' + s.error);
    else measured.shots = s;
  }
  if (want.loudness && measured.technical.audio) {
    const l = await loudness(input);
    if (l.error) warnings.push('loudness: ' + l.error);
    else measured.loudness = l;
  } else if (!measured.technical.audio) {
    warnings.push('no audio stream, so loudness was not measured');
  }
  if (want.waveform && measured.technical.audio) {
    const w = await waveform(input);
    if (w.error) warnings.push('waveform: ' + w.error);
    else measured.waveform = { path: w.path };
  }

  // The contact sheet is the evidence for the read, so a failure here is a
  // failure of the brief, not a footnote.
  const sheet = await contactSheet(input, {
    frames: args?.frames ?? 12,
    cols: args?.cols ?? 4,
    from: args?.from ?? null,
    to: args?.to ?? null,
  });
  if (sheet.error) {
    return { success: false, error: sheet.error, measured, warnings };
  }

  const facts = {
    durationSec: measured.technical.durationSec,
    resolution: measured.technical.video
      ? `${measured.technical.video.width}x${measured.technical.video.height}` : null,
    fps: measured.technical.video?.fps ?? null,
    codec: measured.technical.video?.codec ?? null,
    shotCount: measured.shots?.shotCount ?? null,
    meanShotLengthSec: measured.shots?.meanShotLength ?? null,
    shortestShotSec: measured.shots?.shortestShot ?? null,
    integratedLufs: measured.loudness?.integratedLufs ?? null,
    truePeakDb: measured.loudness?.truePeakDb ?? null,
    contactSheetFrames: sheet.frames,
    contactSheetLayout: `${sheet.cols}x${sheet.rows} in reading order`,
  };

  let read = null;
  try {
    const { ollamaChat } = await import('./ollama-chat.mjs');
    const r = await ollamaChat(BRIEF_PROMPT.replace('{{FACTS}}', JSON.stringify(facts, null, 1)), {
      model: args?.model || 'space-bunny-free',
      agent: 'perception',
      source: 'video-brief',
      images: [sheet.base64],
      temperature: 0.2,
      maxTokens: 900,
      timeout: 180000,
    });
    if (r.error) {
      warnings.push('vision read unavailable: ' + r.error);
    } else {
      read = {
        text: r.response,
        // Recorded truthfully, because the chain may serve a different model than
        // the one requested - only space-bunny-free is reachable from the relay.
        modelRequested: args?.model || 'space-bunny-free',
        modelServed: r.model || null,
        provider: r.provider || null,
      };
    }
  } catch (e) {
    warnings.push('vision read unavailable: ' + String(e.message || e).slice(0, 120));
  }

  if (want.transcript) {
    measured.transcript = { supplied: true, text: String(want.transcript).slice(0, 8000) };
  }

  // Housekeeping: the sheet and waveform are temp artefacts. The base64 goes
  // back to the caller inside `measured.sheet`; the files do not need to live on.
  const out = {
    success: true,
    mediaId,
    kind: resolved.entry.kind,
    measured,
    read,
    contactSheet: { base64: sheet.base64, bytes: sheet.bytes, path: sheet.path, layout: `${sheet.cols}x${sheet.rows}` },
    transcript: measured.transcript || null,
    warnings,
  };
  return out;
}

export default videoBrief;
