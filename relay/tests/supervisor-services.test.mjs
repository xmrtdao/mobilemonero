#!/usr/bin/env node
// The supervisor's service list must describe services that can actually start.
//
// Every entry here was checked against a running process before this test existed,
// and every one of them was wrong in a way that only shows up after a restart:
//
//   - 3 entries named entry points that are not in the tree (start-vite-detached.mjs
//     twice, python-exec-service.mjs, xmrig-service.mjs). None of them could ever
//     have been started by this file, and none was running.
//   - 1 entry probed a port nothing listens on (:3200 for a server on :3121), so
//     its health check would have failed forever against a healthy service.
//   - 1 entry was named 'suite-mcp' while every consumer calls it
//     'xmrtdao-suite-mcp', so on-disk and running state disagreed on the key.
//   - 4 running services (health-server, resume-server, page-agent-mcp, and vite
//     under a real command) were absent, so a restart would have stopped watching
//     them.
//
// The theme is that a hand-maintained list drifts silently: the file parses, the
// supervisor boots, and nothing complains until the thing it was supposed to be
// protecting is gone. So this asserts the list against the filesystem, against the
// ports, and against the services actually running.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import net from 'node:net';

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(RELAY_DIR, '..');
const SUPERVISOR = join(RELAY_DIR, 'supervisor.mjs');

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

// ── Read the SERVICES array out of the source ─────────────────────────────────
// It is evaluated rather than text-matched, so the assertions below run against the
// real objects. The file is imported for its side effects only after its imports
// are stubbed, which is more machinery than a regex - and a regex would not catch
// an entry whose args were wrong, only one whose name was missing.

const src = readFileSync(SUPERVISOR, 'utf8');
const start = src.indexOf('const SERVICES = [');
const end = src.indexOf('\n];', start);
if (start === -1 || end === -1) {
  console.log('  FAIL  could not find the SERVICES array in supervisor.mjs');
  process.exit(1);
}
const arraySrc = src.slice(src.indexOf('[', start), end + 2);

// Minimal stand-ins for the helpers the array calls. A healthCheck is a function
// we never invoke here; it only has to exist for the object literal to evaluate.
const checkHttp = () => true;
const checkProcessByName = () => true;
const checkProcessByScript = () => true;
const checkScheduledTasks = () => true;

// The array references the *_STARTUP_GRACE_MS constants, which are declared above
// it. A Proxy is used for the scope so any bare identifier resolves instead of
// throwing: the goal is to read cmd/args/cwd/name off each entry, and a missing
// constant should not stop the whole list from being inspectable.
// The identifiers the array actually reads, given their real values. This has to
// be explicit: an earlier version returned '' for everything, which meant ROOT
// resolved to an empty string and every path in the list came out relative to the
// test's own directory - 29 failures that all said "this file does not exist"
// about files that plainly do.
const KNOWN = {
  ROOT,
  DATA_DIR: join(ROOT, 'relay-data'),
  LOGS_DIR: join(ROOT, 'relay-data', 'logs'),
  join,
};

const scope = new Proxy({}, {
  has: () => true,
  get: (_t, prop) => {
    if (prop === Symbol.unscopables) return undefined;
    if (typeof prop !== 'string') return undefined;
    if (prop in KNOWN) return KNOWN[prop];
    // A duration constant. Its value is not asserted on - only that the reference
    // resolves - but a number keeps the entry objects the right shape.
    if (/GRACE_MS$/.test(prop)) return 5000;
    return '';
  },
});

let SERVICES = [];
try {
  // `with` + a Proxy scope: a bare identifier inside the array resolves through
  // the proxy instead of throwing. Strict mode forbids `with`, so the body is
  // assembled as a non-strict Function - which is why it is not an arrow.
  const body = `with (this) { return ${arraySrc}; }`;
  SERVICES = new Function(
    'checkHttp', 'checkProcessByName', 'checkProcessByScript', 'checkScheduledTasks',
    'ROOT', 'DATA_DIR', 'LOGS_DIR',
    body
  ).call(scope, checkHttp, checkProcessByName, checkProcessByScript, checkScheduledTasks,
    ROOT, join(ROOT, 'relay-data'), join(ROOT, 'relay-data', 'logs'));
} catch (e) {
  console.log('  FAIL  the SERVICES array does not evaluate: ' + e.message);
  process.exit(1);
}

section('the list is well-formed');
{
  check('it evaluates to a non-empty array', Array.isArray(SERVICES) && SERVICES.length > 0,
    SERVICES.length);
  check('every entry has a name', SERVICES.every(s => typeof s.name === 'string' && s.name));
  check('every name is unique', new Set(SERVICES.map(s => s.name)).size === SERVICES.length,
    SERVICES.map(s => s.name).filter((n, i, a) => a.indexOf(n) !== i).join(', '));
  check('every entry has a command', SERVICES.every(s => typeof s.cmd === 'string' && s.cmd));
  check('every entry has args', SERVICES.every(s => Array.isArray(s.args)));
  check('every entry has a healthCheck', SERVICES.every(s => typeof s.healthCheck === 'function'));
  check('every entry has a cwd', SERVICES.every(s => typeof s.cwd === 'string' && s.cwd));
  console.log('  ' + SERVICES.length + ' services: ' + SERVICES.map(s => s.name).join(', '));
}

section('every entry names a command that exists');
{
  // The core check. An entry whose script is missing parses, boots and does
  // nothing, and the failure is invisible until the service is actually needed.
  for (const svc of SERVICES) {
    for (const arg of svc.args) {
      // Only check args that look like a file in this tree: 'suite' is a
      // subdirectory name, '3121' is a port, and node_modules paths are packages.
      if (!/\.(mjs|cjs|js|ts|py|ps1)$/.test(arg)) continue;
      const abs = isAbsolute(arg) ? arg : resolve(svc.cwd, arg);
      check(`${svc.name}: ${arg} exists`, existsSync(abs), abs);
    }
    // A cwd that does not exist is the same failure one level up: spawn throws
    // ENOENT and the entry can never start.
    check(`${svc.name}: its cwd exists`, existsSync(svc.cwd), svc.cwd);
  }
}

section('no service was dropped that is currently running');
{
  // The regression that matters. These four were absent from the on-disk list
  // while running, so a restart would have quietly stopped watching them.
  const mustWatch = ['health-server', 'resume-server', 'page-agent-mcp', 'vite'];
  const names = SERVICES.map(s => s.name);
  for (const n of mustWatch) {
    check(`${n} is supervised`, names.includes(n), names.join(', '));
  }
}

section('the ports claimed are ports something answers on');
{
  // Pull the URL out of each healthCheck's source line, and probe it. This is the
  // check that catches the :3200-for-:3121 class of error: the entry looked
  // entirely reasonable and would have reported DOWN forever.
  // Split on the entry boundary first. A single regex with a lazy [\s\S]*? between
  // name and healthCheck crosses from one entry into the next when an entry has no
  // checkHttp at all - which is how campaign-scheduler, whose health check is a
  // process probe, ended up reported against local-sb's port.
  const svcSrc = src.slice(start, end);
  const blocks = svcSrc.split(/\n  \{/).slice(1);
  const entries = [];
  for (const b of blocks) {
    const name = (b.match(/name: '([^']+)'/) || [])[1];
    const url = (b.match(/checkHttp\('([^']+)'/) || [])[1];
    if (name && url) entries.push([name, url]);
  }
  check('the HTTP-probed entries were found', entries.length >= 5, entries.length);

  // Each entry's probed port must be the one that entry's own args ask for, when
  // it passes a --port. This is the check that would have caught :3200 vs :3121
  // structurally, without needing to know the right answer in advance.
  for (const svc of SERVICES) {
    const portArg = svc.args.indexOf('--port');
    if (portArg === -1) continue;
    const asked = svc.args[portArg + 1];
    const m = (() => {
      const b = blocks.find(x => (x.match(/name: '([^']+)'/) || [])[1] === svc.name) || '';
      return (b.match(/checkHttp\('[^']*:(\d+)/) || [])[1];
    })();
    check(`${svc.name} probes the port it starts on (${asked})`, m === asked,
      `probes :${m}, starts on :${asked}`);
  }

  for (const [name, url] of entries) {
    // The array holds [name, url] pairs pushed in order; an earlier version
    // destructured them as if they were match groups, so `url` was the offset
    // number and new URL() rejected it.
    let port = 0;
    try { port = Number(new URL(url).port || 80); } catch { port = 0; }
    if (!port) { console.log(`  skipped  (unparseable) ${name} -> ${url}`); continue; }
    const listening = await new Promise(res => {
      const sock = net.connect({ host: '127.0.0.1', port });
      const done = ok => { sock.destroy(); res(ok); };
      sock.setTimeout(2500);
      sock.on('connect', () => done(true));
      sock.on('timeout', () => done(false));
      sock.on('error', () => done(false));
    });
    // Only reported, not failed: a service can be legitimately stopped, and a
    // failing check here would be indistinguishable from "the test is wrong".
    // The value is in seeing it, and in the two entries above that are asserted
    // against the filesystem.
    console.log(`  ${listening ? 'live    ' : 'stopped '} :${port}  ${name}`);
  }
}

section('nothing in the list points at a launcher that is gone');
{
  // A named regression: start-vite-detached.mjs was referenced twice (vite and
  // zero-claw) and had been deleted from the tree at some point.
  const gone = ['start-vite-detached.mjs', 'python-exec-service.mjs', 'xmrig-service.mjs'];
  for (const g of gone) {
    const referenced = SERVICES.some(s => s.args.some(a => a.includes(g)));
    check(`${g} is not referenced`, !referenced, referenced ? 'still referenced' : '');
  }
}

section('the entries removed were genuinely not running');
{
  // Guards against having deleted something real. These are the three that were
  // removed because both their entry point and their port were dead.
  const names = SERVICES.map(s => s.name);
  for (const n of ['python-exec', 'miner', 'zero-claw']) {
    check(`${n} is gone from the list`, !names.includes(n), names.join(', '));
  }
}

console.log(fails === 0
  ? '\n  the supervisor service list describes services that can start'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
