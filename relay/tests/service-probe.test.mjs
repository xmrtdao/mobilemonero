#!/usr/bin/env node
// The dashboard's service health must be able to answer "yes".
//
// This exists because of a probe that could only ever fail. checkProcessRunningAsync
// chose between two completely different searches based on whether its needle ended
// in '.mjs': the '.mjs' branch greps the wmic command-line listing, and every other
// string went to `tasklist /fi "imagename eq <needle>"`.
//
// Five of the six probes for node services were in that second group. 'page-agent'
// is not a Windows executable - it is `node.exe C:\...\page-agent\packages\mcp\
// src\index.js` - so tasklist reported no match and the probe returned false.
// Windows confirms it: "No tasks are running which match the specified criteria."
//
// A false probe result is believed, so page-agent-mcp showed DOWN on the dashboard
// while the supervisor recorded it healthy and its port was LISTENING. The
// dashboard contradicted the only authority it claims to defer to, on a service
// that was up. That is the specific failure this test exists to prevent.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(RELAY_DIR, 'server.js');

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

// ── The two real searches, run for real ──────────────────────────────────────
// Not a mock. The whole bug was that one of these does not work for the thing it
// was pointed at, and only running them shows that.
function byImage(name) {
  const out = execFileSync('tasklist', ['/nh', '/fi', `imagename eq ${name}`], { encoding: 'utf8' });
  return out.toLowerCase().includes(name.toLowerCase());
}
function byCmdline(needle) {
  const out = execFileSync('wmic',
    ['process', 'where', "name='node.exe'", 'get', 'processid,commandline', '/format:csv'],
    { encoding: 'utf8' });
  return out.toLowerCase().includes(needle.toLowerCase());
}

section('the two searches really are different');
{
  // Ground truth: page-agent is running as node.exe right now, and there is no
  // executable by that name. This is the distinction the old code conflated.
  const running = byCmdline('page-agent');
  check('the page-agent process is running (found by command line)', running === true, running);
  check('and Windows has no executable of that name', byImage('page-agent') === false);

  // And the two modes must disagree here, or the bug could not have happened.
  // The comparison is made only when both searches are meaningful for the needle.
  // cloudflared is a real executable but NOT a node.exe, so the cmdline search -
  // which is filtered to node.exe - cannot see it, and the two legitimately
  // disagree in both directions. Asserting they "agree" for it was wrong: an
  // earlier version of this test did, and it failed for a reason that had nothing
  // to do with the code under test.
  check('so the modes disagree for this needle', byCmdline('page-agent') !== byImage('page-agent'));

  // The useful asymmetry: each mode finds what only it can find.
  const cloudflared = byImage('cloudflared.exe');
  if (cloudflared) {
    check('the image search finds a real executable', byImage('cloudflared.exe') === true);
    check('the cmdline search cannot, because cloudflared is not node.exe',
      byCmdline('cloudflared.exe') === false,
      'cloudflared appeared in a node.exe command line - is something else matching?');
  } else {
    console.log('  note    cloudflared.exe is not running, so that pair is not asserted');
  }
}

section('the probe map: every needle is searched the right way');
{
  const src = readFileSync(SERVER, 'utf8');
  const start = src.indexOf('const procProbe = {');
  const end = src.indexOf('}[def.name]', start);
  check('the probe map was found', start !== -1 && end !== -1);
  const blk = src.slice(start, end);

  const entries = [...blk.matchAll(/'([^']+)':\s*\(\)\s*=>\s*checkProcessRunningAsync\('([^']+)',\s*'(\w+)'\)/g)];
  check('every probe entry passes an explicit mode', entries.length > 0, entries.length);
  check('and every entry is matched by that regex (none left un-rewritten)',
    entries.length === (blk.match(/checkProcessRunningAsync\(/g) || []).length,
    `${entries.length} matched vs ${(blk.match(/checkProcessRunningAsync\(/g) || []).length} calls`);

  for (const [, svc, needle, mode] of entries) {
    check(`${svc}: mode is 'image' or 'cmdline'`, mode === 'image' || mode === 'cmdline', mode);

    // The rule the old code got wrong, asserted per entry: a needle naming a
    // script must be searched in the command line, because scripts are arguments
    // to node.exe, not executables.
    if (/\.(mjs|cjs|js|py)$/.test(needle)) {
      check(`${svc}: '${needle}' is a script, so it must use 'cmdline'`, mode === 'cmdline', mode);
    }

    // And the probe must actually find the thing it is probing, right now.
    const hit = mode === 'image' ? byImage(needle) : byCmdline(needle);
    check(`${svc}: its probe finds a live process`, hit === true, `needle '${needle}' mode ${mode}`);
  }
}

section('the function itself has no silent default');
{
  const src = readFileSync(SERVER, 'utf8');
  const i = src.indexOf('function checkProcessRunningAsync');
  check('found the function', i !== -1);
  const sig = src.slice(i, src.indexOf(')', i) + 1);
  check('it takes a mode parameter', /checkProcessRunningAsync\(name,\s*mode\)/.test(sig), sig.trim());
  // Scoped to this function on purpose. A separate, unused checkProcessRunning()
  // still branches on a .mjs suffix, and a whole-file search flags it - which is
  // how this test first "failed" on code that cannot run. It has no call sites, so
  // it is left alone rather than rewritten for a caller that does not exist.
  const body = src.slice(i, src.indexOf('\nfunction ', i + 10) === -1
    ? src.length : src.indexOf('\nfunction ', i + 10));
  check('it no longer infers the mode from a .mjs suffix',
    !/endsWith\('\.mjs'\)/.test(body),
    "a 'name.endsWith(\".mjs\")' branch is still in this function");
  check('it branches on the explicit mode', /mode === 'cmdline'/.test(body));

  // The dead sibling is recorded rather than left as a trap for the next reader.
  const syncCallsites = (src.match(/checkProcessRunning\(/g) || []).length;
  check('the unused sync sibling is still unused (1 definition, 0 calls)',
    syncCallsites === 1, `${syncCallsites} occurrences`);
}

section('no probe is trusted over a false result by accident');
{
  // The supervisor fallback only applies when there is NO probe. So a probe that
  // cannot succeed is worse than no probe at all: it overrides the one authority
  // that was right. This asserts the fallback is still shaped that way, so the
  // distinction stays visible.
  const src = readFileSync(SERVER, 'utf8');
  check('a present probe result is used as-is',
    /healthy = procProbe \? await procProbe\(\) : /.test(src));
  check('the supervisor is consulted only when there is no probe',
    /svcState\.healthy === true/.test(src));
}

console.log(fails === 0
  ? '\n  every service probe searches for something that exists'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
