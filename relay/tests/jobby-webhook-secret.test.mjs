// Prove the jobby inbound webhook verifies, using the real secret from relay/.env.
//
// The secret is never printed. What is asserted is the only thing that matters:
// a payload signed with the configured secret is accepted, and the same payload
// signed with anything else is rejected. A test that only checked the happy path
// would pass just as well with the wrong secret, because the relay has no way to
// tell a correct secret from a plausible one until a real signature arrives.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = readFileSync(join(RELAY_DIR, '.env'), 'utf8');
const SECRET = (env.match(/^RESEND_JOBBY_WEBHOOK_SECRET=(.*)$/m) || [])[1]?.trim();

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

section('the secret is configured');
{
  check('RESEND_JOBBY_WEBHOOK_SECRET is present', Boolean(SECRET), SECRET ? 'yes' : 'no');
  check('it has the Resend whsec_ shape', Boolean(SECRET?.startsWith('whsec_')),
    SECRET ? `${SECRET.length} chars` : '');
  // A 38-char string is a plausible-looking placeholder. The proof that it is real
  // is the signature test below, not its shape.
  check('and it is long enough to be a real secret', (SECRET?.length || 0) >= 20, SECRET?.length);
}

if (!SECRET) {
  console.log('\n  cannot test signature verification without the secret');
  process.exit(1);
}

// Build a payload shaped like a real Resend inbound event.
const payload = JSON.stringify({
  type: 'email.received',
  created_at: new Date().toISOString(),
  data: {
    email_id: 'test-' + Date.now(),
    from: 'recruiter@activision.com',
    to: ['joe.lee@jobbymcjobberson.com'],
    subject: 'Your application at Raven Software',
  },
});

function sign(id, timestamp, secret) {
  return createHmac('sha256', secret)
    .update(`${id}.${timestamp}.${payload}`)
    .digest('base64');
}

const NOW = Date.now();
const ID = 'msg_test_' + Date.now();
const TS = String(Math.floor(NOW / 1000));

section('a correctly signed payload is accepted');
{
  const sig = sign(ID, TS, SECRET);
  const res = await fetch('http://127.0.0.1:8080/webhook/resend-inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'svix-id': ID,
      'svix-timestamp': TS,
      'svix-signature': `v1,${sig}`,
    },
    body: payload,
  });
  const body = await res.text();
  // The interesting outcomes are 200 (accepted) and 401 (rejected as unsigned).
  // Anything else - 404, 500 - is a different fault and worth seeing.
  check('the relay accepted it', res.status === 200, `HTTP ${res.status} ${body.slice(0, 120)}`);
  if (res.status === 200) {
    console.log('        body: ' + body.slice(0, 200));
  }
}

section('a wrongly signed payload is rejected');
{
  const sig = sign(ID, TS, 'whsec_definitely_not_the_real_secret_000000');
  const res = await fetch('http://127.0.0.1:8080/webhook/resend-inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'svix-id': ID,
      'svix-timestamp': TS,
      'svix-signature': `v1,${sig}`,
    },
    body: payload,
  });
  const body = await res.text();
  check('the relay rejected it', res.status === 401, `HTTP ${res.status} ${body.slice(0, 120)}`);
  check('and the rejection names the signature, not something else',
    /signature|verif|secret/i.test(body), body.slice(0, 140));
}

section('a tampered payload is rejected');
{
  // Same signature, different body. This is the case that matters: without it, a
  // valid signature captured in transit could be replayed over altered content.
  const sig = sign(ID, TS, SECRET);
  const res = await fetch('http://127.0.0.1:8080/webhook/resend-inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'svix-id': ID,
      'svix-timestamp': TS,
      'svix-signature': `v1,${sig}`,
    },
    body: payload.replace('recruiter@activision.com', 'attacker@evil.example'),
  });
  const body = await res.text();
  check('the relay rejected the altered body', res.status === 401, `HTTP ${res.status} ${body.slice(0, 120)}`);
}

section('an unsigned payload is rejected');
{
  const res = await fetch('http://127.0.0.1:8080/webhook/resend-inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  const body = await res.text();
  check('no signature headers means 401', res.status === 401, `HTTP ${res.status} ${body.slice(0, 120)}`);
}

section('a replayed (stale) signature is rejected');
{
  // Five minutes is the tolerance. An hour-old signature is not a real delivery.
  const oldTs = String(Math.floor((NOW - 3600_000) / 1000));
  const sig = sign(ID, oldTs, SECRET);
  const res = await fetch('http://127.0.0.1:8080/webhook/resend-inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'svix-id': ID,
      'svix-timestamp': oldTs,
      'svix-signature': `v1,${sig}`,
    },
    body: payload,
  });
  const body = await res.text();
  check('an hour-old timestamp is refused', res.status === 401, `HTTP ${res.status} ${body.slice(0, 120)}`);
  // The response body is deliberately generic. The distinction is made server-side
  // and written to the log, not returned: an attacker probing the endpoint learns
  // nothing about which part of the check failed. So the reason is asserted against
  // the source and the log, not against this body - and this response body is
  // expected to be identical to the bad-signature one above, which is the point.
  check('and the client is told nothing about why',
    body === '{\"error\":\"signature verification failed\"}',
    body.slice(0, 140));
}

// The reason must still be recoverable by an operator, or "it stopped working"
// becomes undiagnosable. Asserted on the source because the log is only written
// at runtime.
{
  const server = readFileSync(join(RELAY_DIR, 'server.js'), 'utf8');
  check('the server logs the specific reason (stale vs bad signature)',
    /REJECTED \$\{toDomain\}/.test(server) && /verdict\.reason/.test(server));
  check('and the age of a stale request is logged',
    /verdict\.ageSeconds/.test(server));
  check('rejections are recorded for later, not only logged',
    /resend-inbound-rejected/.test(server));
  check('a missing secret is named explicitly rather than folded into a generic 401',
    /is not set in relay\/\.env/.test(server));
}

console.log(fails === 0
  ? '\n  the jobby inbound webhook verifies correctly and refuses everything else'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
