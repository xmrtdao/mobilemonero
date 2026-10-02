#!/usr/bin/env node
// Parse every changed file the way Node will actually parse it.
//
// `node --check server.js` reports success on a file that cannot boot. There is
// no "type": "module" in relay/package.json, so --check parses the file as
// CommonJS; at runtime Node detects the import statements and re-parses it as an
// ES module, and the two disagree. Two real faults - a stray `});` and an `await`
// in a non-async handler - sat in server.js through a whole session of "it
// parses" checks, and the relay would not start.
//
// Two things follow, and this file is both of them:
//
//   1. The check has to be an ES-module parse, or it is checking the wrong
//      language. --input-type=module --check does that.
//   2. The bytes have to reach node untouched. Piping through PowerShell
//      re-encodes UTF-8 as CP1252 and turns an em-dash into "?", which produced a
//      bogus "invalid regular expression" error on a file that was fine. The
//      input is passed as a Buffer here so no shell is in the path.
//
// The alternative - adding "type": "module" to package.json - would also make
// --check honest, but it changes how every other .js in the directory is loaded,
// so it is not a change to make inside a bug fix.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, '..');

/** Parse source as an ES module, with the bytes passed through untouched. */
function parseAsModule(absPath) {
  const bytes = readFileSync(absPath);
  const result = spawnSync(
    process.execPath, ['--input-type=module', '--check'],
    { input: bytes, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return { ok: result.status === 0, message: (result.stderr || '').trim() };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

section('server.js parses as the ES module it is');
{
  const { ok, message } = parseAsModule(join(RELAY, 'server.js'));
  check('server.js', ok, message.split('\n').slice(0, 6).join(' | '));

  // The two faults this exists for, asserted as present. If someone "fixes" the
  // file by removing them, this fails and says why they were there.
  const src = readFileSync(join(RELAY, 'server.js'), 'utf8');
  const lines = src.split('\n');
  const webhook = lines.findIndex(l => l.includes("app.post('/webhook/resend-inbound'"));
  check('the inbound webhook handler is async, because it awaits a lookup',
    webhook !== -1 && /async\s*\(req,\s*res\)/.test(lines[webhook]),
    webhook === -1 ? 'handler not found' : lines[webhook].trim());
  // The specific structure that broke. A regex for "an orphaned });" was tried
  // and was itself wrong - it matches the consecutive closings of nested
  // callbacks, which are perfectly valid, and the file parses. So this asserts
  // the thing that was actually wrong instead: the /inbox handler used to be
  // followed by the tail of the route it had replaced.
  const inbox = lines.findIndex(l => l.includes("app.get('/inbox',"));
  const after = inbox === -1 ? [] : lines.slice(inbox, inbox + 40);
  const closeAt = after.findIndex(l => /^\}\);\s*$/.test(l));
  check('the /inbox handler closes once, then the health check follows',
    inbox !== -1 && closeAt !== -1
      && /Health check|health check/.test(after.slice(closeAt, closeAt + 6).join('\n')),
    inbox === -1 ? 'route not found'
      : after.slice(Math.max(0, closeAt - 1), closeAt + 5).join(' | ').slice(0, 160));
  check('no leftover route tail right after it',
    !/\n\s*\}\);\s*\n\s*\n\s*\}\);/.test(lines.slice(inbox, inbox + 40).join('\n')));
}

section('every module the relay imports parses');
{
  // Not just jobby/: the boot failure came from routes/suite-dashboard.mjs, which
  // nothing in the jobby work touched. A file the relay imports cannot be
  // unparseable, whatever else is true about it, and the supervisor's log had been
  // sitting on that error since 08:43 without the relay ever coming back.
  const files = [
    ...walk(join(RELAY, 'jobby')),
    ...walk(join(RELAY, 'routes')),
    ...walk(join(RELAY, 'lib')),
    ...walk(join(RELAY, 'tools')),
  ].filter(f => !/[/\\]tests[/\\]/.test(f));

  check('found the modules', files.length >= 15, `${files.length} files`);
  const bad = [];
  for (const f of files) {
    const { ok, message } = parseAsModule(f);
    if (!ok) {
      const first = message.split('\n').find(l => l.includes('Error')) || message.split('\n')[0];
      bad.push(`${f.split(/[\\/]/).pop()}: ${first.trim()}`);
    }
  }
  check(`all ${files.length} modules parse`, bad.length === 0, bad);
}

section('the migration SQL is present and self-consistent');
{
  const fs = readFileSync(join(RELAY, 'migrations', 'jobby_002_mailbox.sql'), 'utf8');
  check('it opens and closes a transaction', /BEGIN;/.test(fs) && /COMMIT;/.test(fs));
  check('it is idempotent', (fs.match(/IF NOT EXISTS/g) || []).length >= 3,
    (fs.match(/IF NOT EXISTS/g) || []).length);
  check('the mailbox column is added', /ADD COLUMN IF NOT EXISTS mailbox/.test(fs));
  check('the unique index is case-insensitive', /lower\(mailbox\)/.test(fs));
}

section('every registry symbol is reachable from module scope');
{
  // The registry was anchored inside a handler body, so EMAIL_DOMAINS and its
  // helpers were function-local and the rest of the module could not see them.
  // The relay died at boot on "EMAIL_INBOX_KEYS is not defined" from a function
  // four thousand lines away. Six test suites had passed, because every one of
  // them extracted the registry text and evaluated it in a scope it built itself
  // - which checks the logic and is blind to where the code sits.
  //
  // So the assertion is about placement: each registry symbol is defined at
  // column zero, and above the first place that reads it.
  const lines = readFileSync(join(RELAY, 'server.js'), 'utf8').split('\n');
  const defined = (name) => lines.findIndex(l => l.startsWith(`const ${name} =`)
    || l.startsWith(`function ${name}(`));

  const SYMBOLS = ['EMAIL_DOMAINS', 'EMAIL_INBOX_KEYS', 'unverifiedDomainWarned',
    'emailDomainFor', 'emailDomainName', 'resendKeyFor', 'webhookSecretFor',
    'verifyResendSignature'];

  for (const name of SYMBOLS) {
    const at = defined(name);
    check(`${name} is declared at module scope`, at !== -1,
      at === -1 ? 'not found at column zero' : undefined);
  }

  // And above the earliest reader, so nothing can hit a temporal dead zone.
  const firstRead = (name) => lines.findIndex(
    (l, i) => l.includes(name) && i !== defined(name) && !l.trim().startsWith('*'));
  for (const name of ['EMAIL_DOMAINS', 'EMAIL_INBOX_KEYS']) {
    const d = defined(name), r = firstRead(name);
    check(`${name} is declared before it is read`, d !== -1 && (r === -1 || d < r),
      `declared at ${d + 1}, first read at ${r + 1}`);
  }

  // The specific consumption that broke: a map removed by the refactor and still
  // referenced by the inbox sync, which failed non-fatally on every boot.
  const src = readFileSync(join(RELAY, 'server.js'), 'utf8');
  check('nothing outside a function body reads a removed RESEND_KEYS map',
    !/Object\.entries\(RESEND_KEYS\)/.test(src),
    (src.match(/.{0,60}Object\.entries\(RESEND_KEYS\).{0,40}/) || [])[0]);
  check('the inbox sync iterates the registry',
    /for \(const domain of EMAIL_INBOX_KEYS\)/.test(src));
}

section('no short identifier is used without being declared anywhere');
{
  // A parsing check is not a resolving check. `d.domain` inside a loop that
  // iterated EMAIL_INBOX_KEYS parses perfectly, ran on the first vault node, and
  // threw ReferenceError - which took down the whole /api/obsidian-graph
  // aggregation, 1,799 nodes and all, over one character. The endpoint had been
  // answering 500 for a while and the tile just looked empty.
  //
  // The check is deliberately narrow: only one and two character names, and only
  // names that are declared nowhere in the file at all. A name that is declared
  // somewhere is a scope question for a human; a name that is declared nowhere is
  // a fault.
  const src = readFileSync(join(RELAY, 'server.js'), 'utf8');
  const declared = new Set();
  for (const m of src.matchAll(
    /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const n of m[1].split(',')) {
      const t = n.trim().split(/\s+as\s+/).pop();
      if (t) declared.add(t);
    }
  }
  for (const m of src.matchAll(/\(\s*([^)]*)\)\s*=>/g)) {
    for (const n of m[1].split(',')) {
      const t = n.trim().replace(/[^\w$].*$/, '').replace(/^\.\.\./, '');
      if (t) declared.add(t);
    }
  }
  for (const m of src.matchAll(/(?:^|[^.\w$])([a-z]{1,2})(?=\s*[.,)\]\[?]|=)/g)) {
    declared.add(m[1]);   // any name that appears as a binding anywhere
  }

  // Re-scan for value-position uses.
  //
  // Strings are stripped BEFORE comments, not after. A "POST ... application/json"
  // string contains "//", and stripping comments first cuts the line at that
  // point, which leaves the string unterminated so the string stripper cannot
  // match it - and then every fragment of application/json is reported as an
  // undeclared identifier. That produced 40-odd false positives before the order
  // was corrected.
  const code = src
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Trailing comments too, and without requiring the comment to start the line.
    // A "//" inside a regex literal will truncate the line it is on, which loses
    // coverage; it cannot invent an undeclared identifier. A check that cries wolf
    // gets ignored, and this one is worth keeping.
    .replace(/\/\/.*$/gm, ' ');

  const suspects = new Map();
  code.split('\n').forEach((line, i) => {
    // Lines carrying a regex literal are skipped. Nothing above handles regex
    // literals, so their contents survive string-stripping and every two-letter
    // fragment of "application/json" is reported as an undeclared identifier.
    // Skipping a line costs coverage; carrying a false positive costs the whole
    // check, because a check that always fires is one that gets ignored.
    if (/\.replace\(\/|\/RegExp|\(\/|=\s*\/|\|\s*\/|\/\s*[a-z]/.test(line)) return;
    // A short name in value position: followed by member access, a closing
    // bracket or comma, an arithmetic operator, or an assignment that is not
    // part of => or ==.
    const re = /(?:^|[^\w$.])([a-z]{1,2})(?=\s*\.\w|\s*[,)\]]|\s*[-+*/%]|\s*=(?![=>]))/g;
    for (const m of line.matchAll(re)) {
      const name = m[1];
      if (declared.has(name)) continue;
      if (!suspects.has(name)) suspects.set(name, i + 1);
    }
  });

  check('every short identifier used in a value position is declared somewhere',
    suspects.size === 0,
    [...suspects].map(([n, l]) => `${n} near: ${code.split('\n')[l - 1].trim().slice(0, 80)}`));

  // What the check above cannot do, stated so nobody assumes it can: `d` IS
  // declared twice elsewhere in this file, so a file-wide "is it declared
  // anywhere" test cannot tell "declared in another function" from "declared in
  // mine". It catches names declared nowhere and nothing finer.
  //
  // The fault it is aimed at is therefore asserted directly. `d.domain` only ever
  // meant "the current registry entry's domain", and the registry loop is the only
  // place that makes sense - so the two vault-linking loops must both reach the
  // domain through their own loop binding. One of them kept `d.domain` after its
  // header was converted, which is what returned 500 from /api/obsidian-graph and
  // emptied the Galaxy tile.
  check('no loop body reaches a registry domain through a bare `d`',
    !/(?<![.\w$])d\s*\.\s*domain/.test(src),
    (src.match(/.{0,60}(?<![.\w$])d\s*\.\s*domain.{0,40}/) || [])[0]);

  // An earlier version of this also demanded that every registry loop bind its
  // own `entry`. Six loops match, and the ones that do not bind it are correct -
  // they index EMAIL_DOMAINS[k] directly. Demanding one shape made the check
  // fail on working code, which is how a check gets deleted instead of fixed. The
  // invariant that actually matters is the one above.

  const loopCount = (src.match(/for \(const key of EMAIL_INBOX_KEYS\)/g) || []).length;
  check('the registry loops are still there', loopCount >= 2, `${loopCount} found`);
}

console.log(fails === 0
  ? '\n  every file parses as Node will parse it'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
