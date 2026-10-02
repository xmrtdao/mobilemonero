#!/usr/bin/env node
// Tests for Jobby's outbound sender resolution.
//
// The From address decides whose name a job application goes out under, so this
// is security-relevant: it must be operator configuration, never request input,
// and a typo must not silently produce a sender that fails at the provider.
import { execFileSync } from 'node:child_process';
// The real functions, not copies: resolveJobbySender imports them from
// jobby/mailbox.mjs, and the extraction below only pulls the function out of
// server.js. Passing the genuine ones keeps the test measuring the product
// rather than a reimplementation of it.
import { displayNameFor, formatFrom, isCandidateMailbox, domainOf }
  from '../jobby/mailbox.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

/**
 * resolveJobbySender lives inside server.js, which boots a whole stack on
 * import. Extract and evaluate just that function so it can be tested without
 * starting anything.
 *
 * The registry is extracted with it. resolveJobbySender builds its sendable-domain
 * set from EMAIL_DOMAINS, so slicing the function out alone left that reference
 * undefined and every check in the first section threw. A function that depends
 * on a registry cannot be tested without the registry - the extraction has to
 * follow the dependency, or the test is measuring a different program.
 */
function loadResolver(env) {
  const src = execFileSync('node', ['-e', `
    const fs = require('fs');
    const text = fs.readFileSync('server.js', 'utf8');

    // The domain registry, which resolveJobbySender reads to decide which
    // domains may be a sender.
    const regStart = text.indexOf('const EMAIL_DOMAINS = {');
    if (regStart === -1) { console.error('REGISTRY NOT FOUND'); process.exit(2); }
    const regEnd = text.indexOf('const handlers = {', regStart);
    if (regEnd === -1) { console.error('REGISTRY END NOT FOUND'); process.exit(2); }

    // Matched without the closing paren: the signature gained a client
    // parameter, so anchoring on '()' silently stopped matching and the whole
    // suite failed at the extraction step rather than at an assertion.
    const start = text.indexOf('function resolveJobbySender(');
    if (start === -1) { console.error('NOT FOUND'); process.exit(2); }
    const end = text.indexOf('\\nconst AGENT_NOTIFICATION_EMAILS', start);
    process.stdout.write(text.slice(regStart, regEnd) + '\\n' + text.slice(start, end));
  `], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const fn = new Function(
    'process', 'console', 'displayNameFor', 'formatFrom', 'isCandidateMailbox', 'domainOf',
    `${src}\nreturn resolveJobbySender;`
  );
  return fn({ env }, { warn() {}, log() {}, error() {} },
    displayNameFor, formatFrom, isCandidateMailbox, domainOf);
}

section('the default is the 31harbor brand');
{
  const resolve = loadResolver({});
  const r = resolve();
  check('defaults to jobby@31harbor.com', r.from.includes('jobby@31harbor.com'), r);
  check('domain is 31harbor.com', r.domain === '31harbor.com', r.domain);
  check('source is the default', r.source === 'default', r.source);
  check('carries a display name', /^Jobby McJobberson </.test(r.from), r.from);
  check('no longer points at mobilemonero', !r.from.includes('mobilemonero.com'), r.from);
}

section('the operator can move the sender by configuration alone');
{
  const resolve = loadResolver({ JOBBY_FROM_ADDRESS: 'Jobby McJobberson <jobby@mobilemonero.com>' });
  const r = resolve();
  check('env override honoured', r.from.includes('jobby@mobilemonero.com'), r.from);
  check('domain follows', r.domain === 'mobilemonero.com', r.domain);
  check('source is env', r.source === 'env', r.source);
}
{
  // A bare address with no display name should still work.
  const resolve = loadResolver({ JOBBY_FROM_ADDRESS: 'jobby@31harbor.com' });
  const r = resolve();
  check('bare address accepted', r.from === 'Jobby McJobberson <jobby@31harbor.com>', r.from);
}
{
  const resolve = loadResolver({ JOBBY_FROM_ADDRESS: '  Jobby Agent  <  jobby@31harbor.com >  ' });
  const r = resolve();
  check('whitespace tolerated', r.domain === '31harbor.com', r);
  check('name trimmed of quotes', !r.from.includes('"'), r.from);
}

section('an unsendable domain is refused, not attempted');
{
  const resolve = loadResolver({ JOBBY_FROM_ADDRESS: 'Jobby <jobby@evil.example.com>' });
  const r = resolve();
  check('falls back to the brand domain', r.domain === '31harbor.com', r.domain);
  check('falls back to the default From', r.from.includes('jobby@31harbor.com'), r.from);
  check('marked as a fallback', r.source === 'fallback', r.source);

  // A domain this relay has no key for must never become the sender.
  for (const bad of [
    'a@gmail.com', 'a@localhost', 'a', '', '   ',
    'a@31harbor.com.evil.test', 'a@mobilemonero.com.attacker.test',
  ]) {
    const rr = loadResolver({ JOBBY_FROM_ADDRESS: bad })();
    check(`"${bad}" does not become the sender`, rr.domain === '31harbor.com', rr);
  }
}

section('all three sendable domains are accepted');
{
  for (const [addr, domain] of [
    ['jobby@31harbor.com', '31harbor.com'],
    ['jobby@mobilemonero.com', 'mobilemonero.com'],
    ['jobby@partyfavorphoto.com', 'partyfavorphoto.com'],
  ]) {
    const r = loadResolver({ JOBBY_FROM_ADDRESS: `Jobby <${addr}>` })();
    check(`${domain} accepted`, r.domain === domain && r.source === 'env', r);
  }
}

section('case in the domain is normalised');
{
  const r = loadResolver({ JOBBY_FROM_ADDRESS: 'Jobby <Jobby@31Harbor.COM>' })();
  check('domain lowercased', r.domain === '31harbor.com', r.domain);
}

section('a candidate sends as themselves, not as the agent');
{
  const withMailbox = (mailbox, display_name, id = 42) => ({ id, mailbox, display_name });

  const noClient = loadResolver({})();
  check('with no client it is still the agent', noClient.source === 'default', noClient);

  const joe = loadResolver({})(withMailbox('joe.lee@jobbymcjobberson.com', 'Joe Lee'));
  check('a client with a mailbox sends as themselves', joe.source === 'candidate', joe);
  check('the From is the candidate',
    joe.from === 'Joe Lee <joe.lee@jobbymcjobberson.com>', joe.from);
  check('the domain is jobbymcjobberson.com', joe.domain === 'jobbymcjobberson.com', joe.domain);
  check('the address is carried for the send log', joe.address === 'joe.lee@jobbymcjobberson.com', joe);
  check('the client id is carried', joe.clientId === 42, joe.clientId);

  // A name with something awkward in it must not produce a broken header.
  const comma = loadResolver({})(withMailbox('lee.joe@jobbymcjobberson.com', 'Lee, Joe'));
  check('an awkward display name is quoted',
    comma.from === '"Lee, Joe" <lee.joe@jobbymcjobberson.com>', comma.from);

  // A client with no name still gets a usable From rather than an empty one.
  const anon = loadResolver({})(withMailbox('candidate-7@jobbymcjobberson.com', null, 7));
  check('a client with no name falls back to the local part',
    anon.from === 'candidate-7 <candidate-7@jobbymcjobberson.com>', anon.from);

  // Case and whitespace in stored data must not change the address.
  const messy = loadResolver({})(withMailbox('  Joe.Lee@JOBBYMCJOBBERSON.com ', 'Joe Lee'));
  check('stored case and padding are normalised',
    messy.from === 'Joe Lee <joe.lee@jobbymcjobberson.com>', messy.from);
}

section('a mailbox on an unsendable domain never becomes the From');
{
  const bad = loadResolver({})({ id: 9, mailbox: 'joe.lee@evil.example.com', display_name: 'Joe Lee' });
  check('it falls back to the agent sender', bad.source === 'default', bad);
  check('and does not use the mailbox', !String(bad.from).includes('evil.example.com'), bad.from);

  // A malformed stored value must not produce a From with a header break in it.
  for (const mailbox of ['', '   ', 'no-at-sign', '@jobbymcjobberson.com', null, undefined]) {
    const r = loadResolver({})({ id: 9, mailbox, display_name: 'Joe Lee' });
    check(`${JSON.stringify(mailbox)} does not become the From`,
      !String(r.from).includes('jobbymcjobberson.com'), r.from);
  }
}

section('a request still cannot choose its own From');
{
  // The property that made the original design safe. A per-candidate address
  // must not become a way for a caller to send as anyone, so the resolver takes
  // a client row and reads the address from there - never a string.
  const src = execFileSync('node', ['-e', `
    const fs = require('fs');
    process.stdout.write(fs.readFileSync('server.js', 'utf8'));
  `], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const start = src.indexOf('function resolveJobbySender(');
  const body = src.slice(start, src.indexOf('\nfunction ', start + 10));
  check('the resolver takes no address argument',
    !/function resolveJobbySender\(\s*(from|address|email)/.test(body));
  check('it reads the address off the client row',
    /client && client\.mailbox/.test(body));
  check('the send tool still refuses a from in its arguments',
    /const from = AGENT_FROM\[agent\]/.test(src),
    'the From must come from the agent table, not from args');
}

console.log('\n' + (fails === 0 ? 'all sender tests passed' : fails + ' FAILED'));
process.exit(fails === 0 ? 0 : 1);
