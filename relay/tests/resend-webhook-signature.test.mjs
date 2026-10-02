#!/usr/bin/env node
// Tests for Resend/Svix webhook signature verification.
//
// The version this replaces signed JSON.stringify(req.body). Resend signs the body
// as sent, and re-serialising changes key order and number formatting often enough
// that the check failed against real traffic - which is almost certainly why the
// caller logged the mismatch and processed the mail anyway. So the first thing
// worth proving is that a correctly signed request is ACCEPTED, not just that
// forged ones are rejected. A suite that only tested rejection would have passed
// against the broken version too.
import { execFileSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const SECRET = 'whsec_test_secret_value_0123456789';

/** Load the real verifyResendSignature and the registry out of server.js. */
function load(env = {}) {
  const src = execFileSync('node', ['-e', `
    const fs = require('fs');
    const text = fs.readFileSync('server.js', 'utf8');
    const regStart = text.indexOf('const EMAIL_DOMAINS = {');
    const regEnd = text.indexOf('const handlers = {', regStart);
    if (regStart === -1 || regEnd === -1) { console.error('REGISTRY NOT FOUND'); process.exit(2); }
    const fnStart = text.indexOf('function verifyResendSignature(');
    const fnEnd = text.indexOf('\\n}\\n', text.indexOf('signature-mismatch', fnStart)) + 3;
    if (fnStart === -1) { console.error('VERIFY NOT FOUND'); process.exit(2); }
    process.stdout.write(text.slice(regStart, regEnd) + '\\n' + text.slice(fnStart, fnEnd));
  `], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const fn = new Function('process', 'console', 'createHmac', 'timingSafeEqual', 'Buffer',
    `${src}\nreturn { verifyResendSignature, EMAIL_DOMAINS };`);
  return fn({ env }, { warn() {}, log() {}, error() {} }, createHmac, timingSafeEqual, Buffer);
}

/** Build a signed request the way Resend does: base64 HMAC over id.timestamp.body. */
function signed(body, { secret = SECRET, id = 'msg_abc', ts, headers = true } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = ts ?? String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret)
    .update(`${id}.${timestamp}.${payload}`).digest('base64');
  return {
    rawBody: Buffer.from(payload, 'utf8'),
    headers: headers ? {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    } : {},
  };
}

const BODY = { type: 'email.received', data: { from: 'a@example.com', to: ['joe.lee@jobbymcjobberson.com'] } };

section('a correctly signed request is accepted');
{
  const { verifyResendSignature: v } = load();
  const r = v({ ...signed(BODY), secret: SECRET });
  check('a valid signature passes', r.ok === true, r);
  check('the reason is ok', r.reason === 'ok', r.reason);
}

section('the raw bytes are what get signed, not a re-serialisation');
{
  // The whole bug in one test. The body arrives as a Buffer of the exact bytes
  // Resend sent; JSON.parse then JSON.stringify produces different bytes, because
  // parsing and re-serialising normalises whitespace and number formatting. Any
  // verification that signs the re-serialised form therefore fails against real
  // traffic - which is presumably why the caller used to log the mismatch and
  // process the mail anyway.
  const { verifyResendSignature: v } = load();
  const wire = '{\n  "type": "email.received",\n  "data": { "score": 1.50, "to": ["b@x.com"] }\n}';
  const req = signed(wire);
  const reserialised = JSON.stringify(JSON.parse(wire));

  check('re-serialising really does change the bytes',
    reserialised !== wire, { wire, reserialised });

  // Signed over the captured bytes, as the handler does: passes.
  check('signed over the captured bytes it passes',
    v({ ...req, secret: SECRET }).ok === true);

  // Same signature, but verified over the re-serialised form: must fail. If this
  // passed, the raw capture would not be in use.
  const viaReserialised = v({
    rawBody: Buffer.from(reserialised, 'utf8'),
    headers: req.headers,
    secret: SECRET,
  });
  check('verifying over the re-serialised form fails', viaReserialised.ok === false, viaReserialised);
}

section('forgeries are rejected, with a reason');
{
  const { verifyResendSignature: v } = load();
  const now = String(Math.floor(Date.now() / 1000));
  const cases = [
    ['wrong secret',
      { ...signed(BODY, { secret: 'a_different_secret_value' }), secret: SECRET },
      'signature-mismatch'],
    ['no secret configured',
      { rawBody: Buffer.from(JSON.stringify(BODY)), headers: signed(BODY).headers, secret: '' },
      'no-secret-configured'],
    ['no headers at all',
      { rawBody: Buffer.from(JSON.stringify(BODY)), headers: {}, secret: SECRET },
      'missing-signature-headers'],
    ['missing the id',
      { rawBody: Buffer.from(JSON.stringify(BODY)),
        headers: { 'svix-timestamp': now, 'svix-signature': 'v1,x' }, secret: SECRET },
      'missing-signature-headers'],
    ['malformed timestamp',
      { rawBody: Buffer.from(JSON.stringify(BODY)),
        headers: { 'svix-id': 'm', 'svix-timestamp': 'not-a-number', 'svix-signature': 'v1,x' },
        secret: SECRET },
      'malformed-timestamp'],
  ];
  for (const [label, input, expect] of cases) {
    const r = v(input);
    check(`${label} is rejected`, r.ok === false, r);
    check(`${label} reports ${expect}`, r.reason === expect, r.reason);
  }
}

section('a tampered body is rejected even with a genuine signature');
{
  const { verifyResendSignature: v } = load();
  const req = signed(BODY);
  // Same headers, different body: exactly what an attacker editing mail in
  // flight would produce.
  const tampered = Buffer.from(JSON.stringify({ ...BODY, data: { ...BODY.data, subject: 'Offer' } }));
  const r = v({ rawBody: tampered, headers: req.headers, secret: SECRET });
  check('a tampered body fails', r.ok === false, r);
  check('reported as a mismatch', r.reason === 'signature-mismatch', r.reason);
}

section('a captured request cannot be replayed forever');
{
  const { verifyResendSignature: v } = load();
  const old = Math.floor(Date.now() / 1000) - 4000;
  const req = signed(BODY, { ts: String(old) });
  const r = v({ ...req, secret: SECRET });
  check('a four-hour-old signature is rejected', r.ok === false, r);
  check('reported as stale', r.reason === 'stale', r.reason);
  check('the age is reported', typeof r.ageSeconds === 'number' && r.ageSeconds > 3000, r);

  // And one inside the window still works, so the tolerance is not simply off.
  const recent = Math.floor(Date.now() / 1000) - 60;
  check('a one-minute-old signature is still accepted',
    v({ ...signed(BODY, { ts: String(recent) }), secret: SECRET }).ok === true);
}

section('multiple v1 signatures are all accepted, as Svix sends during rotation');
{
  const { verifyResendSignature: v } = load();
  const req = signed(BODY);
  const good = req.headers['svix-signature'].replace(/^v1,/, '');
  const both = `v1,${good} v1,${createHmac('sha256', SECRET).update('nonsense').digest('base64')}`;
  const r = v({ ...req, headers: { ...req.headers, 'svix-signature': both }, secret: SECRET });
  check('one valid signature among several is enough', r.ok === true, r);
}

section('a strict domain never borrows another domain\'s secret');
{
  // jobbymcjobberson.com is strict and has no secret of its own yet. If it fell
  // back to the generic RESEND_WEBHOOK_SECRET - which is partyfavorphoto's - then
  // real jobby mail would be checked against the wrong secret, fail every time,
  // and be reported as a signature mismatch when the actual fault is a missing
  // setting. Failing closed is right; failing for the wrong stated reason is not.
  const src = execFileSync('node', ['-e', `
    const fs = require('fs');
    process.stdout.write(fs.readFileSync('server.js', 'utf8'));
  `], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const routeStart = src.indexOf("app.post('/webhook/resend-inbound'");
  const rest = src.slice(routeStart);
  const routeEnd = rest.search(/\napp\.(get|post|use)\(/);
  const handler = routeEnd === -1 ? rest : rest.slice(0, routeEnd);

  check('strictness is read into a local', /const strict = EMAIL_DOMAINS\[toDomainKey\]\.strict === true;/.test(handler));
  check('a strict domain uses only its own secret',
    /const signingSecret = strict\s*\?\s*webhookSecretFor\(toDomainKey\)\s*:\s*\(webhookSecretFor\(toDomainKey\) \|\| process\.env\.RESEND_WEBHOOK_SECRET\);/
      .test(handler.replace(/\s+/g, ' ')),
    handler.match(/const signingSecret[\s\S]{0,160}/)?.[0]);
  check('the generic fallback is not reachable for a strict domain',
    !/const signingSecret = webhookSecretFor\(toDomainKey\) \|\| process\.env\.RESEND_WEBHOOK_SECRET;/
      .test(handler));
  check('a missing secret on a strict domain names the env var',
    handler.includes('is not set in relay/.env'));
  check('the strict branch uses the local, not a second lookup',
    /if \(strict\) \{/.test(handler));
}

section('the parser captures the raw body for every JSON request');
{
  const src = execFileSync('node', ['-e', `
    const fs = require('fs');
    process.stdout.write(fs.readFileSync('server.js', 'utf8'));
  `], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  check('express.json has a verify callback',
    /express\.json\(\{[\s\S]{0,200}?verify:\s*\(req,\s*res,\s*buf\)\s*=>/.test(src));
  check('it stores the buffer on the request', src.includes('req.rawBody = buf'));
  check('the handler passes it to the verifier', src.includes('rawBody: req.rawBody'));
  // Scoped to the webhook route, and comments stripped first. Two things would
  // otherwise make a naive search fail: the verifier's own doc comment names
  // JSON.stringify(req.body) to explain why it does not use it, and a proxy
  // helper elsewhere in the file legitimately re-serialises a body to forward it.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  const routeStart = code.indexOf("app.post('/webhook/resend-inbound'");
  check('the webhook route was located', routeStart !== -1);
  // To the end of the handler: the next top-level app. route.
  const rest = code.slice(routeStart);
  const routeEnd = rest.search(/\napp\.(get|post|use)\(/);
  const handler = routeEnd === -1 ? rest : rest.slice(0, routeEnd);
  check('nothing in the webhook handler re-serialises the body for signing',
    !/JSON\.stringify\(req\.body\)/.test(handler),
    (handler.match(/.{0,70}JSON\.stringify\(req\.body\).{0,40}/) || [])[0]);
  check('the handler hands the raw body straight to the verifier',
    /rawBody:\s*req\.rawBody/.test(handler));
  check('the permissive path is gone', !src.includes('processing anyway'));
  check('a rejected forgery is recorded, not just logged',
    /logActivity\('resend-inbound-rejected'/.test(src));
  check('the no-secret warning is logged once per domain, not per email',
    src.includes('unverifiedDomainWarned'));
  check('a strict domain returns 401 on a bad signature',
    /if \(strict\) \{[\s\S]{0,1200}?res\.status\(401\)/.test(handler));
}

console.log(fails === 0
  ? '\n  all webhook signature checks passed'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
