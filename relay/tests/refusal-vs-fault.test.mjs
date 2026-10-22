#!/usr/bin/env node
// Guards the difference between a REFUSAL and a FAULT.
//
// The Activity Intelligence board and Alice both read the activity feed. A
// request the relay correctly refused — a path that does not exist, a file
// that is not on an allowlist — is not a fault, and putting it in the same
// bucket as a broken route did two things:
//
//   1. the board's "most common errors" became a list of the internet's
//      curiosity and our own test suite's security probes;
//   2. Alice opened TASKS for them, because a recurring fault is exactly
//      what she is asked to announce and file.
//
// The whole thing was our own test suite. relay/tests/static-assets.test.mjs
// probes five traversal payloads against the LIVE relay to prove the
// /images allowlist holds, and every probe was logged as an http_error.
//
// These checks hold the three kinds of response apart.
import { readFileSync } from 'node:fs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const logIntel = readFileSync(new URL('../lib/log-intel.mjs', import.meta.url), 'utf8');
const dash = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
const staticAssets = readFileSync(new URL('../tests/static-assets.test.mjs', import.meta.url), 'utf8');

section('the relay tells a refusal from a fault');
{
  check('the logger knows about refusals',
    /const isRefusal = !!extra\.refusal && statusCode === 404/.test(server));
  check('a refusal is its own activity type',
    /activityType = 'refused'/.test(server));
  check('a self-test is its own activity type',
    /activityType = 'selftest'/.test(server));
  check('the refusal reason is recorded',
    /refusal_reason: isRefusal \? extra\.refusal : null/.test(server));
  check('the images allowlist marks what it refused',
    /req\.refusal = 'not-allowlisted'/.test(server));
  check('a file that is allowlisted but missing is NOT a refusal',
    /req\.refusal = null;[\s\S]{0,120}image not found/.test(server),
    'an allowlisted-but-missing file is a real fault');
}

section('a path that does not exist is a refusal, not a fault');
{
  check('there is a catch-all at the end of the stack',
    /req\.refusal = req\.refusal \|\| 'no-such-route'/.test(server));
  check('and it keeps the shape of the default 404',
    /res\.status\(404\)\.type\('html'\)\.send\('Cannot ' \+ req\.method/.test(server));
  check('it is registered after the university bridge',
    server.indexOf("req.refusal = req.refusal || 'no-such-route'")
      > server.indexOf('registerUniversityBridge(app, {'));
}

section('the self-test tag cannot be used by an attacker');
{
  check('the tag is read', /req\.headers\['x-relay-selftest'\] === '1'/.test(server));
  check('a tunnel request cannot be tagged',
    /!req\.headers\['cf-ray'\] && !req\.headers\['cf-connecting-ip'\]/.test(server));
  check('only a loopback request can be tagged',
    /isLoopbackAddress\(requestIp\(req\)\)/.test(server));
  check('the test sends the tag',
    /x-relay-selftest/.test(staticAssets));
  check('and the test still probes the real route',
    /for \(const attempt of \[/.test(staticAssets));
}

section('the intelligence keeps them apart');
{
  check('the error query excludes refusals and self-tests',
    /AND activity_type NOT IN \('refused','selftest'\)/.test(logIntel));
  check('refusals are counted on their own',
    /activity_type IN \('refused','selftest'\)/.test(logIntel));
  check('the bundle carries them',
    /refusals,/.test(logIntel));
  check('the board shows them as refusals, not faults',
    /refused \(not faults\)/.test(dash));
  check('the compact tile leaves the self-tests out',
    /a\.activity_type === 'selftest'/.test(dash));
}

console.log(fails === 0
  ? '\n  a refusal is not a fault, and the board says which is which'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
