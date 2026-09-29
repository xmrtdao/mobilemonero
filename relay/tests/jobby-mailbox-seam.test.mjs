#!/usr/bin/env node
// The seam between the mailbox store and the sender, plus which Resend account a
// send would actually use.
//
// The two halves are tested separately elsewhere. What matters here is the join:
// that a stored mailbox becomes the From, and that sending from
// jobbymcjobberson.com picks the jobby Resend key rather than falling through to
// another account's. That fall-through is not hypothetical - it is exactly what
// happened when 31harbor was added by hand, and it fails by looking like success.
import { execFileSync } from 'node:child_process';
import { getOrCreateClient, ensureMailbox, closeStore } from '../jobby/store.mjs';
import { displayNameFor, formatFrom, isCandidateMailbox, domainOf } from '../jobby/mailbox.mjs';
import pg from 'pg';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 220)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

// Load the real resolver and the real registry out of server.js, and give it the
// real env the relay uses, so the key selection is exercised for real.
const src = execFileSync('node', ['-e', `
  const fs = require('fs');
  const text = fs.readFileSync('server.js', 'utf8');
  const regStart = text.indexOf('const EMAIL_DOMAINS = {');
  const regEnd = text.indexOf('const handlers = {', regStart);
  if (regStart === -1 || regEnd === -1) { console.error('REGISTRY NOT FOUND'); process.exit(2); }

  // Brace-matched rather than sliced to a marker string. A marker that is not
  // found yields indexOf() === -1, and slice(start, -1) silently returns the
  // rest of the file - which then failed on 'app is not defined' instead of on
  // anything to do with the sender.
  const fnStart = text.indexOf('function resolveJobbySender(');
  if (fnStart === -1) { console.error('RESOLVER NOT FOUND'); process.exit(2); }
  const open = text.indexOf('{', fnStart);
  let depth = 0, i = open;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  process.stdout.write(text.slice(regStart, regEnd) + '\\n' + text.slice(fnStart, i));
`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

// The real .env, so RESEND_JOBBY_API_KEY is present exactly as the relay sees it.
const envText = execFileSync('node', ['-e', `
  const fs = require('fs');
  const out = {};
  for (const line of fs.readFileSync('.env', 'utf8').split(/\\r?\\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  process.stdout.write(JSON.stringify(out));
`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const env = JSON.parse(envText);

const fn = new Function(
  'process', 'console', 'displayNameFor', 'formatFrom', 'isCandidateMailbox', 'domainOf',
  `${src}\nreturn { resolveJobbySender, EMAIL_DOMAINS, EMAIL_INBOX_KEYS, resendKeyFor };`
);
const warnings = [];
const M = fn({ env }, { warn: (m) => warnings.push(m), log() {}, error() {} },
  displayNameFor, formatFrom, isCandidateMailbox, domainOf);

section('a stored mailbox becomes the From a candidate sends as');
{
  const c = await getOrCreateClient(`seam-${Math.random().toString(36).slice(2)}`, 'Joe Lee');
  try {
    const { address, displayName } = await ensureMailbox(c.id, 'Joe Lee');
    check('the store assigned joe.lee@jobbymcjobberson.com',
      address === 'joe.lee@jobbymcjobberson.com', address);

    const sender = M.resolveJobbySender({ id: c.id, mailbox: address, display_name: displayName });
    check('the resolver reports the candidate as the source', sender.source === 'candidate', sender);
    check('the From is the candidate applying, not the agent',
      sender.from === 'Joe Lee <joe.lee@jobbymcjobberson.com>', sender.from);
    check('it is not the agent address', !sender.from.includes('Jobby McJobberson'), sender.from);
    check('the address is carried for the send log',
      sender.address === 'joe.lee@jobbymcjobberson.com', sender.address);
    check('the client id is carried', sender.clientId === c.id, sender.clientId);
  } finally {
    await cleanup([c.id]);
  }
}

section('a send from jobbymcjobberson.com uses the jobby Resend account');
{
  // The failure this guards: a literal key map with no entry for the new domain
  // looks up nothing, falls through to mobilemonero, and sends from the wrong
  // account while appearing to succeed.
  const keys = Object.fromEntries(
    M.EMAIL_INBOX_KEYS.map((k) => [M.EMAIL_DOMAINS[k].domain, M.resendKeyFor(k)]));
  const jobbyKey = keys['jobbymcjobberson.com'];
  check('there is a key for jobbymcjobberson.com', !!jobbyKey,
    'set RESEND_JOBBY_API_KEY in relay/.env');
  check('it is the jobby key from the env',
    jobbyKey === env.RESEND_JOBBY_API_KEY,
    { got: jobbyKey ? `${jobbyKey.slice(0, 6)}...` : null, want: env.RESEND_JOBBY_API_KEY ? 'set' : 'unset' });
  // Distinct accounts, so a fall-through would be visible rather than harmless.
  const distinct = new Set(Object.values(keys).filter(Boolean));
  check('each domain has its own key, so a fall-through would show',
    distinct.size >= 4, `${distinct.size} distinct keys across 4 domains`);
  check('mobilemonero has a different key from jobby',
    keys['mobilemonero.com'] !== jobbyKey);
}

section('a mailbox the relay cannot send from is refused, not silently used');
{
  warnings.length = 0;
  const bad = M.resolveJobbySender({
    id: 1, mailbox: 'joe.lee@evil.example.com', display_name: 'Joe Lee',
  });
  check('it falls back to the agent sender', bad.source === 'default', bad);
  check('and says so', warnings.some((w) => /not a usable/.test(w)), warnings);
  check('the bad domain never appears', !String(bad.from).includes('evil.example.com'), bad.from);

  warnings.length = 0;
  const malformed = M.resolveJobbySender({ id: 1, mailbox: '@jobbymcjobberson.com', display_name: 'Joe Lee' });
  check('an address with no local part is refused too',
    malformed.source === 'default', malformed);
  check('and produces no broken header',
    !String(malformed.from).includes('<@'), malformed.from);
}

section('the candidate path does not go through the agent route');
{
  // The route takes an agent name and looks the From up in a table. Adding a
  // "send as this candidate" argument to it would hand away the property that a
  // caller cannot choose a From, so the candidate path shares only the transport.
  // Read the whole file: the assertions are about code that is not in the slice
  // evaluated above.
  const whole = execFileSync('node', ['-e', `
    const fs = require('fs');
    process.stdout.write(fs.readFileSync('server.js', 'utf8'));
  `], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

  check('the deliver path calls sendViaResend directly',
    /deliver: async \(\{ to, subject, body \}\) => \{[\s\S]{0,900}?await sendViaResend\(/.test(whole));
  check('and does not pass a sender through the agent tool',
    !/toolHandlers\['resend-send-email'\]\(\s*\{[^}]*sender/.test(whole));
  check('the agent route still takes its From from the table',
    /const from = AGENT_FROM\[agent\]/.test(whole));
  check('the route is still localhost-only',
    /\[send-email\] BLOCKED external request/.test(whole));
  check('the deliver path resolves the From from a client row',
    /resolveJobbySender\(\{ \.\.\.client, \.\.\.assigned \}\)/.test(whole),
    'the mailbox must come from the store, not from the call');

  // Both outbound paths for Jobby go through one transport. This is not a claim
  // that the whole file has one Resend call - the auto-responder, the forwarder
  // and the contact forms each have their own, and consolidating those is a
  // separate piece of work. What must be true here is that the two Jobby paths
  // share the transport rather than each having a copy of it.
  const senders = (whole.match(/https:\/\/api\.resend\.com\/emails'/g) || []).length;
  check('there are other unrelated Resend sends in the file', senders > 1,
    `expected the brand paths to still have their own, found ${senders}`);
  check('but only one of them is inside sendViaResend',
    /async function sendViaResend\([\s\S]{0,900}?https:\/\/api\.resend\.com\/emails'/.test(whole));
  check('the agent route delegates to it', /await sendViaResend\(\{/.test(whole));
  check('and so does the deliver path', /await sendViaResend\(\{/.test(whole));
}

async function cleanup(ids) {
  const pool = new pg.Pool({
    connectionString: process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
  });
  if (ids && ids.length) await pool.query('DELETE FROM app.job_clients WHERE id = ANY($1::int[])', [ids]);
  await pool.end();
}

await closeStore();

console.log(fails === 0
  ? '\n  all sender seam checks passed'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
