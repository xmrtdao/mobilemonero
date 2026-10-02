/**
 * Media registry — refer to media by id, never by path.
 *
 * WHY
 *
 * The perception tools take an `input` path and hand it to ffmpeg. That is two
 * primitives in one argument: an arbitrary read of the host filesystem, and -
 * for video-brief - an outbound egress of whatever the file contains, because
 * the contact sheet goes to a cloud model. That is why the tools could only sit
 * at TRUSTED: not because the perception was dangerous, but because the addressing
 * was.
 *
 * So: media is ingested once into a directory this process owns, and from then on
 * it is addressed by an opaque id. A raw path is refused unless it already points
 * inside the managed root, which makes the arbitrary-read primitive unreachable
 * while leaving the capability intact.
 *
 * WHY A FILE, NOT A TABLE
 *
 * There is no DDL path from Node here: Postgres is not exposed on 54322, and
 * psql, Docker and the supabase CLI are all absent. So this uses the same shape
 * the relay already uses for campaign data - a JSON index beside the payloads
 * under relay-data/. It survives a restart, and it needs no migration.
 *
 * `task_artifacts` and `fleet_attachments` exist but are wrong for this: the
 * latter stores content inline in a column, and a 19MB video does not belong in
 * a row.
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  copyFileSync, linkSync, unlinkSync, statSync,
} from 'node:fs';
import { join, resolve, extname, basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const DATA_DIR = process.env.RELAY_DATA_DIR
  || 'C:/Users/PureTrek/Desktop/xmrtdao/relay-data';
export const MEDIA_ROOT = join(DATA_DIR, 'media');
const FILES_DIR = join(MEDIA_ROOT, 'files');
const INDEX = join(MEDIA_ROOT, 'registry.json');

// A video brief is not a file server. Anything larger than this is a mistake, or
// an attempt.
const MAX_BYTES = 600 * 1024 * 1024;

const EXT_BY_KIND = {
  video: ['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi'],
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg'],
};
const EXT_BY_CT = {
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
};

function ensureDirs() {
  for (const d of [MEDIA_ROOT, FILES_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function readIndex() {
  ensureDirs();
  if (!existsSync(INDEX)) return { version: 1, media: {} };
  try {
    const j = JSON.parse(readFileSync(INDEX, 'utf8'));
    if (!j || typeof j !== 'object' || !j.media) return { version: 1, media: {} };
    return j;
  } catch {
    // A corrupt index must not take the tool down, and must not silently look
    // empty - that would read as "no media registered" and hide the loss.
    return { version: 1, media: {}, corrupt: true };
  }
}

function writeIndex(idx) {
  ensureDirs();
  const tmp = INDEX + '.tmp-' + randomBytes(4).toString('hex');
  writeFileSync(tmp, JSON.stringify(idx, null, 1));
  renameSync(tmp, INDEX); // atomic on the same volume, so a crash cannot truncate it
}

function kindFromName(name, contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (EXT_BY_CT[ct]) return ct.startsWith('video') ? 'video' : ct.startsWith('audio') ? 'audio' : 'image';
  const ext = extname(name || '').toLowerCase();
  if (EXT_BY_KIND.video.includes(ext)) return 'video';
  if (EXT_BY_KIND.audio.includes(ext)) return 'audio';
  if (EXT_BY_KIND.image.includes(ext)) return 'image';
  return null;
}

/** True when `p` is inside the managed root. This is the whole security boundary. */
export function isManagedPath(p) {
  try {
    const full = resolve(p);
    const root = resolve(FILES_DIR);
    const rel = full.startsWith(root) ? full.slice(root.length) : null;
    // Reject the root itself and any traversal that escapes it.
    return !!rel && rel.length > 0 && !rel.includes('..') && !rel.includes(':');
  } catch {
    return false;
  }
}

/**
 * Ingest media and return its id.
 *
 * Accepts a URL or a local path. Either way the bytes are copied into the managed
 * root, so what a registered id points at cannot later be swapped out from under
 * a caller by replacing the original file.
 */
export async function register(args = {}) {
  const source = args.source || args.url || args.path || args.input;
  if (!source) return { error: 'source is required: a URL or a local path' };
  const registeredBy = String(args.registeredBy || args.agent || 'unknown').slice(0, 60);
  const label = args.label ? String(args.label).slice(0, 120) : null;
  const note = args.note ? String(args.note).slice(0, 400) : null;

  const isUrl = /^https?:\/\//i.test(String(source));
  let bytes;
  let name;
  let contentType = null;

  try {
    if (isUrl) {
      const res = await fetch(String(source), { signal: AbortSignal.timeout(180000) });
      if (!res.ok) return { error: `fetch failed: HTTP ${res.status}` };
      contentType = res.headers.get('content-type');
      const buf = Buffer.from(await res.arrayBuffer());
      bytes = buf.length;
      if (bytes > MAX_BYTES) return { error: `file is ${Math.round(bytes / 1048576)}MB, over the ${Math.round(MAX_BYTES / 1048576)}MB cap` };
      ensureDirs();
      const id = 'md_' + randomBytes(6).toString('hex');
      const kind = kindFromName(new URL(String(source)).pathname, contentType);
      if (!kind) return { error: `unsupported content type: ${contentType || 'unknown'}` };
      const dest = join(FILES_DIR, id + EXT_BY_KIND[kind][0]);
      writeFileSync(dest, buf);
      return commit({ id, dest, kind, bytes, registeredBy, label, note, origin: String(source), contentType });
    }

    // Local file.
    const src = resolve(String(source));
    if (!existsSync(src)) return { error: `file not found: ${src}` };
    const st = statSync(src);
    if (!st.isFile()) return { error: 'not a file' };
    if (st.size > MAX_BYTES) return { error: `file is ${Math.round(st.size / 1048576)}MB, over the ${Math.round(MAX_BYTES / 1048576)}MB cap` };
    const kind = kindFromName(src, null);
    if (!kind) return { error: `unsupported file type: ${extname(src) || 'none'}` };
    ensureDirs();
    const id = 'md_' + randomBytes(6).toString('hex');
    const dest = join(FILES_DIR, id + extname(src).toLowerCase());
    // Hardlink when the volume allows it, so a 19MB video is not duplicated for
    // every registration. Copy when it does not.
    try { linkSync(src, dest); } catch { copyFileSync(src, dest); }
    return commit({ id, dest, kind, bytes: st.size, registeredBy, label, note, origin: src, contentType: null });
  } catch (e) {
    return { error: `registration failed: ${String(e.message || e).slice(0, 160)}` };
  }
}

function commit({ id, dest, kind, bytes, registeredBy, label, note, origin, contentType }) {
  const idx = readIndex();
  const entry = {
    id, kind, bytes,
    filename: basename(dest),
    path: dest,
    registeredBy, label, note, origin,
    contentType,
    registeredAt: new Date().toISOString(),
  };
  idx.media[id] = entry;
  writeIndex(idx);
  return {
    success: true,
    id, kind, bytes,
    filename: entry.filename,
    label, note,
    registeredBy,
    registeredAt: entry.registeredAt,
    contentType,
    // The resolved path is returned so the caller can show it to a human, but it
    // is not required for subsequent use - the id is.
    path: dest,
    hint: 'Use this id with the media tools. They no longer accept a raw path.',
  };
}

/**
 * Resolve a reference to a real path inside the managed root.
 *
 * An id always resolves. A path resolves only if it is already inside the managed
 * root - i.e. it came out of this registry in the first place. Everything else is
 * refused by name, so the refusal teaches the caller what to do instead.
 */
export function resolveRef(ref) {
  if (!ref) return { ok: false, error: 'no media reference given' };
  const s = String(ref).trim();
  const idx = readIndex();
  if (idx.corrupt) return { ok: false, error: 'the media registry is corrupt and was not trusted; inspect relay-data/media/registry.json' };

  if (idx.media[s]) {
    const e = idx.media[s];
    if (!existsSync(e.path)) {
      return { ok: false, error: `media ${s} is registered but its file is gone from ${e.filename}` };
    }
    return { ok: true, entry: e, managed: true };
  }

  if (isManagedPath(s)) {
    // A path we blessed earlier. Resolved by filename against the registry so the
    // entry - kind, who registered it - still comes back with it.
    const name = basename(resolve(s));
    const found = Object.values(idx.media).find((e) => e.filename === name);
    if (found) return { ok: true, entry: found, managed: true };
    return {
      ok: false,
      error: `that path is inside the media root but is not a registered file. Register it first: {"source": ${JSON.stringify(resolve(s))}}`,
    };
  }

  return {
    ok: false,
    error: 'media must be addressed by id, not by path. Register it once with media-register, then use the returned id. '
      + 'This is deliberate: a raw path would let any caller read arbitrary files on this machine.',
    suggestion: { tool: 'media-register', args: { source: String(s).slice(0, 200) } },
  };
}

export function get(id) {
  const idx = readIndex();
  const e = idx.media[String(id)];
  if (!e) return { error: `no media registered with id "${id}". Use media-list to see what there is.` };
  return { success: true, ...e, present: existsSync(e.path) };
}

export function list(filter = {}) {
  const idx = readIndex();
  let rows = Object.values(idx.media);
  if (filter.kind) rows = rows.filter((e) => e.kind === filter.kind);
  rows.sort((a, b) => String(b.registeredAt).localeCompare(String(a.registeredAt)));
  return {
    success: true,
    count: rows.length,
    corruptIndex: !!idx.corrupt,
    media: rows.map((e) => ({
      id: e.id, kind: e.kind, bytes: e.bytes, label: e.label, note: e.note,
      registeredBy: e.registeredBy, registeredAt: e.registeredAt,
      present: existsSync(e.path),
    })),
  };
}

export function remove(id, { purge = false } = {}) {
  const idx = readIndex();
  const e = idx.media[String(id)];
  if (!e) return { error: `no media registered with id "${id}"` };
  if (purge) { try { unlinkSync(e.path); } catch { /* already gone */ } }
  delete idx.media[String(id)];
  writeIndex(idx);
  return { success: true, id: String(id), fileDeleted: purge };
}

export default { register, resolveRef, get, list, remove, isManagedPath, MEDIA_ROOT };