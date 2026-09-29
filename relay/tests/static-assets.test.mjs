#!/usr/bin/env node
// Every asset the dashboard references must actually be served.
//
// This exists because of a failure that looks like nothing is wrong. The
// dashboard's server-rendered HTML arrived, so the page looked correct: headings,
// tiles, the Galaxy canvas, all of it. What did not arrive was /static/dashboard.js
// - a 404 - so every panel that needs JavaScript stayed empty. The report was "the
// static content is visible, none of the dynamic JS is loading", which reads as a
// data problem and is entirely a missing route.
//
// The check is against the served page, not the source, because that is the only
// place the two can disagree: the HTML can reference a script that no route
// serves, and reading the source would happily pass.
//
// It also asserts against the running relay rather than a booted copy, because
// the failure was a route missing from a process that was otherwise healthy. A
// test that boots its own instance proves the code is right, not that the
// service is serving.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.RELAY_TEST_URL || 'http://127.0.0.1:8080';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

function apiKey() {
  const envPath = join(RELAY_DIR, '.env');
  if (!existsSync(envPath)) return '';
  const m = readFileSync(envPath, 'utf8').match(/^RELAY_API_KEY=(.*)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

async function probe(path, { withKey = false, binary = false } = {}) {
  try {
    const headers = withKey ? { 'x-api-key': apiKey() } : {};
    const res = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(20000) });
    if (binary) {
      // Binary assets must not go through text(). Decoding a PNG as UTF-8 replaces
      // every invalid byte, so the signature check below was reading a mangled
      // string and failing on a file that was served perfectly - the test asserting
      // its own fetch method, not the code under test.
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        status: res.status,
        type: res.headers.get('content-type') || '',
        buf,
        body: buf.toString('latin1'),
        len: buf.length,
      };
    }
    const body = await res.text();
    return {
      status: res.status,
      type: res.headers.get('content-type') || '',
      body,
      len: body.length,
    };
  } catch (e) {
    return { status: 0, type: '', body: String(e.message || e), len: 0 };
  }
}

section('the relay is serving at all');
{
  const health = await probe('/health');
  check('the relay answers /health', health.status === 200, `status ${health.status}`);
  if (health.status !== 200) {
    console.log('\n  the relay is not running, so the rest cannot be checked');
    process.exit(1);
  }
}

const page = await probe('/', { withKey: true });
const dashboardJs = await probe('/static/dashboard.js');

section('the dashboard itself renders');
{
  check('the page answers 200', page.status === 200, `status ${page.status}`);
  check('it is HTML', /text\/html/.test(page.type), page.type || '(no content-type)');
  check('it is the dashboard, not a login or error stub',
    /static\/dashboard\.js/.test(page.body), `${page.len} bytes`);
}

section('every asset the page references answers');
{
  const refs = [...page.body.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)=["']([^"']+)["']/g)]
    .map(m => m[1])
    .filter(u => u.startsWith('/'));
  const unique = [...new Set(refs)];
  check('the page references assets at all', unique.length > 0, unique.join(', '));
  check('it references dashboard.js', unique.some(u => u.includes('dashboard.js')),
    unique.join(', '));

  // Only /static/* is this relay's responsibility here. The rest are other
  // services' mounts (/suite/, /elze/, ...) and asserting on them would make this
  // test fail for reasons that have nothing to do with the dashboard.
  for (const ref of unique.filter(u => u.startsWith('/static/'))) {
    const r = await probe(ref);
    check(`${ref} answers 200`, r.status === 200, `status ${r.status}`);
    if (r.status === 200 && ref.endsWith('.js')) {
      check(`${ref} is served as JavaScript`, /javascript/.test(r.type),
        r.type || '(no content-type)');
    }
  }
}

section('images resolve, and cannot be used to read other files');
{
  // The logo was a 404 on every page: the markup asked for /images/xmrtdao.png
  // while the file sat at public/xmrtdao.png, and no route served either. It reads
  // as a broken image rather than a broken route, so nothing caught it.
  const logo = await probe('/images/xmrtdao.png', { binary: true });
  check('the dashboard logo serves', logo.status === 200, `status ${logo.status}`);
  check('it is served as a PNG', /image\/png/.test(logo.type), logo.type || '(none)');
  // Checked against raw bytes, not decoded text. The PNG signature is
  // 89 50 4E 47 0D 0A 1A 0A, and the last four are not valid UTF-8 - so reading
  // the response as text replaces them and the comparison fails on a file that
  // was served perfectly. The test was asserting its own fetch method.
  check('and it is a real PNG, not an error page',
    !!logo.buf && logo.buf.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    logo.buf ? [...logo.buf.subarray(0, 8)].map(b => b.toString(16)).join(' ') : 'no bytes');
  check('it is not a truncated stub', logo.len > 100000, `${logo.len} bytes`);

  // A path parameter joined onto a directory and read is directory traversal, and
  // relay/.env is the thing worth stealing. The allowlist is what prevents it.
  for (const attempt of [
    '/images/../.env',
    '/images/..%2F.env',
    '/images/%2e%2e%2f%2e%2e%2fserver.js',
    '/images/../../.cloudflared/config.yml',
    '/images/....//....//relay/.env',
  ]) {
    const r = await probe(attempt);
    const leaked = /RELAY_API_KEY|RESEND_API_KEY|JOBBY_TOKEN_KEY/.test(r.body);
    check(`${attempt} does not leak a secret`, !leaked, `status ${r.status}`);
    check(`  and is refused`, r.status === 404 || r.status === 400, `status ${r.status}`);
  }

  // An allowlisted name must still correspond to a real file, so a rename cannot
  // leave the dashboard pointing at nothing.
  const server = readFileSync(join(RELAY_DIR, 'server.js'), 'utf8');
  const m = server.match(/PUBLIC_IMAGES = new Set\(\[([^\]]*)\]\)/);
  check('the allowlist was found', m !== null);
  if (m) {
    const names = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    check('the allowlist is not empty', names.length > 0, names.join(', '));
    for (const n of names) {
      check(`  ${n} exists in public/`,
        existsSync(join(RELAY_DIR, 'public', n)), 'missing');
    }
    // Every /images/ reference in the markup must be on the list, or it 404s again.
    const refs = [...page.body.matchAll(/\/images\/([A-Za-z0-9._-]+)/g)].map(x => x[1]);
    for (const r of new Set(refs)) {
      check(`the page's /images/${r} is on the allowlist`, names.includes(r), names.join(', '));
    }
  }
}

section('the dashboard script is served whole, not truncated');
{
  check('dashboard.js answers 200', dashboardJs.status === 200, `status ${dashboardJs.status}`);
  check('it is served as JavaScript', /javascript/.test(dashboardJs.type),
    dashboardJs.type || '(none)');
  check('it is not an error page', !/^\s*(<!DOCTYPE|<html)/i.test(dashboardJs.body));
  // A truncated read serves 200 and looks plausible. The file on disk is ~157KB,
  // so anything an order of magnitude smaller is a partial send.
  const onDisk = existsSync(join(RELAY_DIR, 'public', 'dashboard.js'))
    ? readFileSync(join(RELAY_DIR, 'public', 'dashboard.js'), 'utf8').length
    : 0;
  check('it is not a stub or truncated', dashboardJs.len > 50000, `${dashboardJs.len} bytes`);
  check('it is not shorter than the file on disk', dashboardJs.len >= onDisk * 0.98,
    `served ${dashboardJs.len}, on disk ${onDisk}`);
  check('it does not leak an unsubstituted placeholder',
    !/\$\{supabaseUrl\}|\$\{supabaseKey\}/.test(dashboardJs.body));
}

section('the routes for these assets exist in the source');
{
  const server = readFileSync(join(RELAY_DIR, 'server.js'), 'utf8');
  check("the /static/dashboard.js route is present",
    /app\.get\('\/static\/dashboard\.js'/.test(server));
  check("the /static/markdown.js route is present",
    /app\.get\('\/static\/markdown\.js'/.test(server));
  check('both set an explicit JavaScript content-type',
    (server.match(/setHeader\('Content-Type', 'application\/javascript'\)/g) || []).length >= 2,
    (server.match(/setHeader\('Content-Type', 'application\/javascript'\)/g) || []).length);
  // A route registered after the catch-all or inside a handler body parses fine
  // and is still unreachable, which is exactly how the registry bug hid before.
  const routeAt = server.indexOf("app.get('/static/dashboard.js'");
  check('the route is not nested inside another handler', routeAt !== -1 && server[routeAt - 1] === '\n',
    routeAt === -1 ? 'not found' : `preceded by ${JSON.stringify(server.slice(routeAt - 3, routeAt))}`);
}

console.log(fails === 0
  ? '\n  every asset the dashboard needs is served'
  : `\n  ${fails} check(s) FAILED`);

// Set the code and let the loop drain, rather than calling process.exit() directly.
// This file makes live requests, so a hard exit races the socket teardown and
// trips a libuv assertion on Windows - which reported as a non-zero status on a
// run that had actually passed every check.
process.exitCode = fails === 0 ? 0 : 1;
