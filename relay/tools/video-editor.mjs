/**
 * Video Editor — FFmpeg-based video editing tool for the relay
 *
 * Provides agent-native video editing capabilities:
 * - trim: Cut a video segment
 * - concat: Merge multiple videos
 * - text-overlay: Add text to video
 * - thumbnail: Extract a frame as image
 * - audio-extract: Extract audio track
 * - watermark: Add image watermark
 * - speed: Change playback speed
 * - gif: Convert video to GIF
 * - info: Get video metadata
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'video-outputs');

// Ensure output directory exists
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

// Configure FFmpeg path
ffmpeg.setFfmpegPath(ffmpegPath.path);

/**
 * Run FFmpeg command and return result
 */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpegPath.path;
    execFile(cmd, args, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        // FFmpeg often exits non-zero but still produces output
        reject(new Error(stderr?.slice(-500) || error.message));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Generate output filename
 */
function outputName(prefix, ext = 'mp4') {
  return join(OUTPUT_DIR, `${prefix}-${Date.now()}.${ext}`);
}

/**
 * Get video metadata
 */
export async function videoInfo(args) {
  const input = args?.input || args?.i;
  if (!input) return { error: 'input is required' };

  return new Promise((resolve) => {
    ffmpeg.ffprobe(input, (err, metadata) => {
      if (err) return resolve({ error: err.message });
      const video = metadata.streams.find(s => s.codec_type === 'video');
      const audio = metadata.streams.find(s => s.codec_type === 'audio');
      resolve({
        success: true,
        duration: metadata.format.duration,
        size: metadata.format.size,
        bitrate: metadata.format.bit_rate,
        video: video ? {
          codec: video.codec_name,
          width: video.width,
          height: video.height,
          fps: video.r_frame_rate,
        } : null,
        audio: audio ? {
          codec: audio.codec_name,
          sample_rate: audio.sample_rate,
          channels: audio.channels,
        } : null,
      });
    });
  });
}

/**
 * Trim a video segment
 */
export async function videoTrim(args) {
  const input = args?.input || args?.i;
  const start = args?.start || args?.s || '0';
  const duration = args?.duration || args?.d;
  const output = args?.output || outputName('trimmed');

  if (!input) return { error: 'input is required' };
  if (!duration) return { error: 'duration is required' };

  const args_list = ['-i', input, '-ss', start, '-t', duration, '-c', 'copy', '-y', output];

  try {
    await runFfmpeg(args_list);
    return { success: true, output, operation: 'trim', start, duration };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Concatenate multiple videos
 */
export async function videoConcat(args) {
  const inputs = args?.inputs || args?.i;
  const output = args?.output || outputName('concatenated');

  if (!inputs || !Array.isArray(inputs) || inputs.length < 2) {
    return { error: 'inputs array (min 2) is required' };
  }

  // Create concat demuxer input
  const concatList = inputs.map(i => `file '${i}'`).join('\n');
  const listPath = join(OUTPUT_DIR, `concat-list-${Date.now()}.txt`);
  const { writeFileSync } = await import('fs');
  writeFileSync(listPath, concatList);

  const args_list = ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', output];

  try {
    await runFfmpeg(args_list);
    try { unlinkSync(listPath); } catch {}
    return { success: true, output, operation: 'concat', inputs: inputs.length };
  } catch (err) {
    try { unlinkSync(listPath); } catch {}
    return { error: err.message };
  }
}

/**
 * Add text overlay to video
 */
export async function videoTextOverlay(args) {
  const input = args?.input || args?.i;
  const text = args?.text || args?.t;
  const output = args?.output || outputName('text-overlay');
  const fontSize = args?.font_size || 24;
  const fontColor = args?.font_color || 'white';
  const x = args?.x || '(w-text_w)/2';
  const y = args?.y || '(h-text_h)/2';

  if (!input) return { error: 'input is required' };
  if (!text) return { error: 'text is required' };

  const filter = `drawtext=text='${text}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${x}:y=${y}:box=1:boxcolor=black@0.5:boxborderw=5`;
  const args_list = ['-i', input, '-vf', filter, '-c:a', 'copy', '-y', output];

  try {
    await runFfmpeg(args_list);
    return { success: true, output, operation: 'text-overlay', text };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Extract thumbnail from video
 */
export async function videoThumbnail(args) {
  const input = args?.input || args?.i;
  const time = args?.time || args?.t || '00:00:01';
  const output = args?.output || outputName('thumbnail', 'jpg');

  if (!input) return { error: 'input is required' };

  const args_list = ['-i', input, '-ss', time, '-vframes', '1', '-q:v', '2', '-y', output];

  try {
    await runFfmpeg(args_list);
    return { success: true, output, operation: 'thumbnail', time };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Extract audio from video
 */
export async function videoAudioExtract(args) {
  const input = args?.input || args?.i;
  const output = args?.output || outputName('audio', 'mp3');

  if (!input) return { error: 'input is required' };

  const args_list = ['-i', input, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', '-y', output];

  try {
    await runFfmpeg(args_list);
    return { success: true, output, operation: 'audio-extract' };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Add image watermark to video
 */
export async function videoWatermark(args) {
  const input = args?.input || args?.i;
  const watermark = args?.watermark || args?.w;
  const output = args?.output || outputName('watermarked');
  const position = args?.position || 'bottom-right'; // top-left, top-right, bottom-left, bottom-right, center
  const opacity = args?.opacity || 0.5;

  if (!input) return { error: 'input is required' };
  if (!watermark) return { error: 'watermark image path is required' };

  const positions = {
    'top-left': '10:10',
    'top-right': 'main_w-overlay_w-10:10',
    'bottom-left': '10:main_h-overlay_h-10',
    'bottom-right': 'main_w-overlay_w-10:main_h-overlay_h-10',
    'center': '(main_w-overlay_w)/2:(main_h-overlay_h)/2',
  };

  const pos = positions[position] || positions['bottom-right'];
  const filter = `overlay=${pos}:format=auto,format=yuv420p`;
  const args_list = ['-i', input, '-i', watermark, '-filter_complex', filter, '-c:a', 'copy', '-y', output];

  try {
    await runFfmpeg(args_list);
    return { success: true, output, operation: 'watermark', position };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Change video playback speed
 */
export async function videoSpeed(args) {
  const input = args?.input || args?.i;
  const speed = args?.speed || args?.s || '1.5';
  const output = args?.output || outputName('speed');

  if (!input) return { error: 'input is required' };

  const filter = `setpts=PTS/${speed}`;
  const audioFilter = `atempo=${speed}`;
  const args_list = ['-i', input, '-vf', filter, '-af', audioFilter, '-y', output];

  try {
    await runFfmpeg(args_list);
    return { success: true, output, operation: 'speed', speed };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Convert video to GIF
 */
export async function videoGif(args) {
  const input = args?.input || args?.i;
  const output = args?.output || outputName('animated', 'gif');
  const fps = args?.fps || 10;
  const width = args?.width || 480;

  if (!input) return { error: 'input is required' };

  const filter = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  const args_list = ['-i', input, '-vf', filter, '-y', output];

  try {
    await runFfmpeg(args_list);
    return { success: true, output, operation: 'gif', fps, width };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Main handler — routes to sub-operations
 */
export async function videoEditor(args) {
  const op = args?.op || args?.operation || 'info';

  switch (op) {
    case 'info': return videoInfo(args);
    case 'trim': return videoTrim(args);
    case 'concat': return videoConcat(args);
    case 'text-overlay': return videoTextOverlay(args);
    case 'thumbnail': return videoThumbnail(args);
    case 'audio-extract': return videoAudioExtract(args);
    case 'watermark': return videoWatermark(args);
    case 'speed': return videoSpeed(args);
    case 'gif': return videoGif(args);
    default:
      return {
        error: `Unknown operation: ${op}`,
        available: ['info', 'trim', 'concat', 'text-overlay', 'thumbnail', 'audio-extract', 'watermark', 'speed', 'gif'],
      };
  }
}

export default videoEditor;
