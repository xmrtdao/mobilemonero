/**
 * relay/scripts/_repair_mojibake.mjs
 *
 * Undo a botched re-encode of UTF-8 source as cp1252.
 *
 * WHAT HAPPENED
 * -------------
 * A bulk rename rewrote source files with PowerShell's Get-Content -Raw and
 * [System.IO.File]::WriteAllText. On Windows PowerShell 5.1, Get-Content on a
 * file with no BOM decodes as the system ANSI code page (cp1252), not UTF-8.
 * So every em dash (E2 80 94) was read as the three characters "â€”", and
 * WriteAllText then saved those three characters as UTF-8. The file parsed
 * perfectly, every test passed, and 537 sequences across 11 files were wrong.
 *
 * Nothing visible broke, which is why it went unnoticed: the damage is in
 * comments and string decorations, not in logic. It is still real — `—` became
 * `â€”` in the relay's own header text, in a browser tab, and in the box-drawing
 * rules that separate sections of these files.
 *
 * HOW THE REPAIR WORKS
 * --------------------
 * The damage is exactly reversible. For each run of characters in the mojibake
 * range, map back to the cp1252 byte it came from, then decode those bytes as
 * UTF-8. A run that does not decode as valid UTF-8 is left exactly as it was,
 * so genuine text in a comment is never mangled by the repair.
 *
 * The cp1252 range 0x80-0x9F is the part that is not identity-mapped, so it is
 * spelled out below. Everything else is the Latin-1 range and maps to itself.
 *
 * Usage:  node scripts/_repair_mojibake.mjs [--check]
 *         --check reports without writing
 */

import { readFileSync, writeFileSync } from 'node:fs';

// cp1252 0x80-0x9F -> Unicode. This is the only part of the table that is not
// the identity map, and getting it wrong would corrupt the repair.
const CP1252_HIGH = {
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160',
  0x8B: '\u2039', 0x8C: '\u0152', 0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A', 0x9C: '\u0153',
  0x9E: '\u017E', 0x9F: '\u0178',
};
const UNICODE_TO_CP1252 = new Map();
for (const [byte, ch] of Object.entries(CP1252_HIGH)) UNICODE_TO_CP1252.set(ch, Number(byte));

function cp1252Byte(ch) {
  const mapped = UNICODE_TO_CP1252.get(ch);
  if (mapped !== undefined) return mapped;
  const cp = ch.codePointAt(0);
  if (cp >= 0x00a0 && cp <= 0x00ff) return cp;   // Latin-1 range: identity
  // C1 controls. cp1252 leaves 0x81/0x8D/0x8F/0x90/0x9D undefined, and a
  // double-encoded string carries them as identity-mapped code points instead.
  // A single mis-decode never produces these, so accepting them cannot damage
  // text that was correct to begin with.
  if (cp >= 0x0080 && cp <= 0x009f) return cp;
  if (cp >= 0x0100 && cp <= 0x017f) {
    // Latin Extended-A, which is what a second pass through a Latin-1-ish
    // decoder produces for bytes 0x80-0x9F. Only the ones with a plausible
    // origin are accepted; anything else is genuine text.
    const LATIN_EXT = { 0x178: 0x9d, 0x17d: 0x8e, 0x17e: 0x9e, 0x192: 0x83,
      0x2c6: 0x88, 0x2dc: 0x98, 0x160: 0x8a, 0x161: 0x9a, 0x152: 0x8c, 0x153: 0x9c };
    return LATIN_EXT[cp] ?? null;
  }
  return null;
}

// A run of two or more non-ASCII characters is a candidate for having come from
// mis-decoded UTF-8. Character *ranges* are deliberately not used here: a
// double-encoded emoji contains code points like U+9D and U+178 that no sensible
// range would include, and missing them left a mangled hospital emoji in the
// relay's own HTML. decodeRun below is the real filter — it only accepts a run
// whose bytes are valid UTF-8, so genuine text is left alone.
const CANDIDATE = /[^\x00-\x7F]{2,}/g;

function decodeRun(run) {
  const bytes = [];
  for (const ch of run) {
    const b = cp1252Byte(ch);
    if (b === null) return null;   // contains genuine text - do not touch
    bytes.push(b);
  }
  const buf = Buffer.from(bytes);
  const decoded = buf.toString('utf8');
  // Round-trip check: if the bytes are not valid UTF-8, Node substitutes U+FFFD.
  if (decoded.includes('\uFFFD')) return null;
  return decoded;
}

export function repair(text) {
  let repaired = 0;
  const out = text.replace(CANDIDATE, (run) => {
    const fixed = decodeRun(run);
    if (fixed === null || fixed === run) return run;
    repaired++;
    return fixed;
  });
  return { text: out, repaired };
}

// Only act as a command-line tool when invoked directly. Importing this file
// (to use repair() on a string) must not start touching files.
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => a.endsWith('.mjs') || a.endsWith('.js'));
  if (!files.length) {
    console.error('usage: node scripts/_repair_mojibake.mjs <file...>   (--check to report only)');
    process.exit(1);
  }
  const check = args.includes('--check');
  let totalRun = 0;
  for (const f of files) {
    const before = readFileSync(f, 'utf8');
    const { text: after, repaired } = repair(before);
    if (repaired) {
      totalRun += repaired;
      console.log(`  ${check ? 'would fix' : 'fixed'} ${String(repaired).padStart(4)} run(s)  ${f}`);
      if (!check) writeFileSync(f, after, 'utf8');
    } else {
      console.log(`  clean                   0 run(s)  ${f}`);
    }
  }
  console.log(`\n  ${check ? 'would repair' : 'repaired'} ${totalRun} run(s) across ${files.length} file(s)`);
}
