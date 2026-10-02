#!/usr/bin/env node
// Tests for the mail-domain registry.
//
// 31harbor.com was hardcoded in about twenty-five places: the inbound domain
// resolver, the signing-secret map, the Resend key maps, the inbox-key map, the
// boot-time key check, the dashboard node list. That is how a domain ends up
// sendable but not receivable, or receivable but missing from the dashboard,
// because somebody updated four of the twenty-five. 31harbor.com sat in every
// one; jobbymcjobberson.com sat in none.
//
// So the registry is the single source, and this asserts two things about it:
// that it resolves correctly, and that no hardcoded domain list has crept back in
// beside it. The second half is the half that matters, and it is why this file
// exists: the first attempt at the refactor dropped a helper function that two
// call sites used, and `node --check` passed the whole time.
//
// The registry lives inside server.js, which boots an entire stack on import, so
// it is extracted and evaluated - the same approach as jobby-sender.test.mjs.
import { execFileSync } from 'node:child_process';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const DOMAINS = {
  pfp: 'partyfavorphoto.com',
  mobilemonero: 'mobilemonero.com',
  '31harbor': '31harbor.com',
  jobby: 'jobbymcjobberson.com',
};

/** Load the real registry and its helpers out of server.js. */
function loadRegistry(env) {
  const src = execFileSync('node', ['-e', `
    const fs = require('fs');
    const text = fs.readFileSync('server.js', 'utf8');
    const start = text.indexOf('const EMAIL_DOMAINS = {');
    if (start === -1) { console.error('REGISTRY NOT FOUND'); process.exit(2); }
    // The registry ends where the handlers object begins. It used to end at a
    // marker inside the resend-get-email handler, and when the registry was lifted
    // to module scope that marker moved *behind* the start - so the slice came back
    // empty and the test failed on a syntax error rather than an assertion.
    const end = text.indexOf('const handlers = {', start);
    if (end === -1 || end < start) { console.error('END MARKER NOT FOUND OR BEFORE START'); process.exit(2); }
    process.stdout.write(text.slice(start, end));
  `], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const fn = new Function(
    'process', 'console',
    `${src}\nreturn { EMAIL_DOMAINS, EMAIL_INBOX_KEYS, emailDomainFor, emailDomainName, resendKeyFor, webhookSecretFor };`
  );
  return fn({ env }, { warn() {}, log() {}, error() {} });
}

const ENV = {
  RESEND_API_KEY: 're_pfp',
  RESEND_XMRT_API_KEY: 're_xmrt',
  RESEND_31HARBOR_API_KEY: 're_harbor',
  RESEND_JOBBY_API_KEY: 're_jobby',
  RESEND_WEBHOOK_SECRET: 'wh_pfp',
  RESEND_MM_WEBHOOK_SECRET: 'wh_xmrt',
  RESEND_31HARBOR_WEBHOOK_SECRET: 'wh_harbor',
  RESEND_JOBBY_WEBHOOK_SECRET: 'wh_jobby',
};

section('every registered domain resolves to its own key and secret');
{
  const r = loadRegistry(ENV);
  check('all four domains registered',
    r.EMAIL_INBOX_KEYS.length === 4, r.EMAIL_INBOX_KEYS);
  for (const [key, domain] of Object.entries(DOMAINS)) {
    check(`${key} is registered`, r.EMAIL_DOMAINS[key]?.domain === domain, r.EMAIL_DOMAINS[key]);
    check(`${domain} resolves by address`,
      r.emailDomainFor(`anything@${domain}`) === key, r.emailDomainFor(`anything@${domain}`));
    check(`${domain} resolves by name`, r.emailDomainName(`X <a@${domain}>`) === domain);
    check(`${key} has its own Resend key`, r.resendKeyFor(key) === ENV[r.EMAIL_DOMAINS[key].key]);
    check(`${key} has its own webhook secret`,
      r.webhookSecretFor(key) === ENV[r.EMAIL_DOMAINS[key].secret]);
    // Accepting either the inbox key or the domain name is deliberate: call
    // sites hold one or the other depending on where they are.
    check(`${domain} reachable by name for the key`, r.resendKeyFor(domain) === r.resendKeyFor(key));
  }
}

section('jobbymcjobberson.com is a first-class peer, not an afterthought');
{
  const r = loadRegistry(ENV);
  const j = r.EMAIL_DOMAINS.jobby;
  check('registered', !!j, r.EMAIL_DOMAINS);
  check('has a sending key of its own', j.key === 'RESEND_JOBBY_API_KEY', j.key);
  check('has a webhook secret of its own', j.secret === 'RESEND_JOBBY_WEBHOOK_SECRET', j.secret);
  check('has an agent name', j.agent === 'jobby', j.agent);
  check('a per-user address resolves to it',
    r.emailDomainFor('maria.garcia@jobbymcjobberson.com') === 'jobby');
  // The whole point of the per-user scheme: the same helper that files a
  // candidate's reply must file it under jobby, not under partyfavorphoto.
  // emailDomainFor returns the key, which is what is being compared here.
  const claiming = Object.keys(DOMAINS)
    .filter((k) => r.emailDomainFor(`a@${DOMAINS[k]}`) === 'jobby');
  check('exactly one domain resolves to jobby', claiming.length === 1, claiming);
}

section('an unknown domain is not silently claimed by a real one');
{
  const r = loadRegistry(ENV);
  // This is the specific failure being guarded: the old chain of includes() tests
  // had no branch for a new domain, so it fell through to a real one and the
  // mail was filed in the wrong inbox while appearing to be delivered.
  for (const address of [
    'someone@gmail.com', 'someone@example.com', 'a@localhost',
    'a@jobbymcjobberson.com.evil.test', 'a@31harbor.com.attacker.test',
  ]) {
    check(`"${address}" claims no registered domain`,
      r.emailDomainFor(address) === null, r.emailDomainFor(address));
  }
  check('case is ignored', r.emailDomainFor('A@JOBBYMCJOBBERSON.COM') === 'jobby');
  check('a bare domain name is accepted', r.emailDomainFor('31harbor.com') === '31harbor');
  check('no domain for empty input', r.emailDomainFor('') === null);
  check('no domain for null input', r.emailDomainFor(null) === null);
}

section('a missing key is null, not an inherited one from another domain');
{
  const r = loadRegistry({ ...ENV, RESEND_JOBBY_API_KEY: undefined });
  check('jobby key reads as absent', r.resendKeyFor('jobby') === null, r.resendKeyFor('jobby'));
  check('jobby secret still resolves',
    r.webhookSecretFor('jobby') === 'wh_jobby', r.webhookSecretFor('jobby'));
  // The dangerous shape is a truthy fallback: sending with the wrong account
  // looks like success. So this asserts null specifically, not just falsy.
  check('a missing secret is null, not the pfp one',
    r.webhookSecretFor('nosuchdomain') === null, r.webhookSecretFor('nosuchdomain'));
}

section('no hardcoded domain list has crept back in beside the registry');
{
  // Read the source, not the evaluated registry, so a literal is caught wherever
  // it is. Each of these was a real hardcoded list before the refactor.
  const src = execFileSync('node', ['-e', `
    const fs = require('fs');
    process.stdout.write(fs.readFileSync('server.js', 'utf8'));
  `], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const registry = src.slice(src.indexOf('const EMAIL_DOMAINS = {'));
  const outside = src.slice(0, src.indexOf('const EMAIL_DOMAINS = {'))
    + registry.slice(registry.indexOf('function emailDomainName'));

  // The chain of includes() tests that silently misfiled a new domain.
  check("no includes() chain resolving 31harbor to '31harbor.com'",
    !/includes\('31harbor'\)\s*\?\s*'31harbor\.com'/.test(outside),
    (outside.match(/includes\('31harbor'\)\s*\?\s*'31harbor\.com'/g) || []).slice(0, 3));
  check("no includes() chain resolving partyfavorphoto to 'partyfavorphoto.com'",
    !/includes\('partyfavorphoto'\)\s*\?\s*'partyfavorphoto\.com'/.test(outside));

  // A literal map of Resend keys, which had no entry for a new domain.
  const literalMaps = outside.match(
    /\{\s*'mobilemonero\.com':\s*process\.env\.RESEND/g);
  check('no literal Resend key map', !literalMaps, literalMaps);

  // An array of [domain, key] pairs, which is the boot-time check.
  check("no literal ['31harbor.com', process.env...] pair",
    !/\[\s*'31harbor\.com',\s*process\.env\.RESEND/.test(outside));

  // A list of domains for the graph or the target list.
  check("no ['pfp', 'mobilemonero', '31harbor'] literal list",
    !/\[\s*'pfp',\s*'mobilemonero',\s*'31harbor'\s*\]/.test(outside));
  check("no { pfp: [], mobilemonero: [], '31harbor': [] } literal default",
    !/pfp:\s*\[\],\s*mobilemonero:\s*\[\],\s*'31harbor':\s*\[\]/.test(outside));
}

section('every helper a call site uses is actually defined');
{
  // This is the check whose absence let the dropped emailDomainName through
  // node --check. It is nearly free, and it catches an undefined reference,
  // which is a runtime failure in a file that is 15k lines long and boots a
  // whole stack.
  const r = loadRegistry(ENV);
  for (const name of ['emailDomainFor', 'emailDomainName', 'resendKeyFor', 'webhookSecretFor']) {
    check(`${name} is a function`, typeof r[name] === 'function', typeof r[name]);
  }
  // And each one actually callable, which is what was not true before.
  check('emailDomainName returns a string', typeof r.emailDomainName('a@31harbor.com') === 'string');
  check('webhookSecretFor returns null for junk', r.webhookSecretFor({}) === null);
}

section('every registered domain gets its inbox routes, from one registrar');
{
  // The three original route blocks were near-identical copies. If a domain is
  // added to the registry but the routes are still hand-copied, it gets a
  // dashboard tile and no inbox - a tile that reads "no mail" forever. So this
  // checks the routes, not just the data.
  const src = execFileSync('node', ['-e', `
    const fs = require('fs');
    process.stdout.write(fs.readFileSync('server.js', 'utf8'));
  `], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

  check('the registrar exists', src.includes('function registerInboxRoutes(key)'));
  check('it is called for every registered domain',
    /for \(const key of EMAIL_INBOX_KEYS\) registerInboxRoutes\(key\);/.test(src));
  check('no hand-copied per-domain route block survives',
    !/app\.(?:get|post)\('\/resend\/(?:mobilemonero|31harbor|jobby)\//.test(src),
    (src.match(/app\.(?:get|post)\('\/resend\/[a-z0-9]+\//g) || []).slice(0, 4));

  // The path segment, since a wrong one means a route nothing calls. Read from
  // the evaluated registry rather than by regex: a regex for `path: '...'` inside
  // the registry block happily runs past the end of an entry and finds some
  // unrelated Express route several hundred lines later, which is how this check
  // reported 31harbor's segment as "/".
  const paths = Object.fromEntries(
    Object.entries(loadRegistry(ENV).EMAIL_DOMAINS).map(([k, v]) => [v.domain, v.path]));
  check('PFP keeps the original pathless shape', paths['partyfavorphoto.com'] === '', paths);
  check('mobilemonero keeps its segment', paths['mobilemonero.com'] === 'mobilemonero', paths);
  check('31harbor keeps its segment', paths['31harbor.com'] === '31harbor', paths);
  check('jobby has its own segment', paths['jobbymcjobberson.com'] === 'jobby', paths);

  // Every segment distinct, or two domains collide on one route and Express
  // silently answers with whichever was registered first.
  const segments = Object.values(paths);
  check('all path segments distinct', new Set(segments).size === segments.length, paths);
}

section('every registered domain gets a dashboard tile and a client loader');
{
  // The failure this guards is silent and looks like good news: a domain with a
  // tile that never loads sits on "Loading..." or "No emails yet" for ever, which
  // an operator reads as "nobody has written in".
  const src = execFileSync('node', ['-e', `
    const fs = require('fs');
    process.stdout.write(fs.readFileSync('server.js', 'utf8'));
  `], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const client = execFileSync('node', ['-e', `
    const fs = require('fs');
    process.stdout.write(fs.readFileSync('public/dashboard.js', 'utf8'));
  `], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

  // The tiles are generated, not written out three times.
  check('the tile generator exists', src.includes('function resendTileHtml()'));
  check('the template calls it rather than hardcoding tiles',
    src.includes('${resendTileHtml()}'), 'the three copied blocks should be gone');
  check('no tile id is written out in the template',
    !/id="(?:pfp|mm|hb|jobby)-inbox"/.test(src),
    (src.match(/id="(?:pfp|mm|hb|jobby)-inbox"/g) || []).slice(0, 3));

  // The client is driven by the endpoint, so the two lists cannot drift.
  check('the /resend/domains endpoint exists', src.includes("app.get('/resend/domains'"));
  check('the client reads that endpoint', client.includes("fetch('/resend/domains')"));
  check('the copied per-domain loaders are gone',
    !/function load(?:Pfp|Mm|Hb|Jobby)Inbox/.test(client));
  check('no per-domain brief URL is hardcoded in the client',
    !/fetch\(['"]\/resend\/(?:mobilemonero|31harbor|jobby)\//.test(client),
    (client.match(/fetch\(['"]\/resend\/[a-z0-9]+\//g) || []).slice(0, 3));

  // Every domain needs a distinct tile id, or two tiles overwrite one another and
  // one domain's mail appears under another's name.
  const r = loadRegistry(ENV);
  const tiles = Object.values(r.EMAIL_DOMAINS).map((e) => e.tile);
  check('every domain has a tile id', tiles.every(Boolean), tiles);
  check('tile ids distinct', new Set(tiles).size === tiles.length, tiles);
  check('tile ids are safe as element ids',
    tiles.every((t) => /^[a-zA-Z0-9_-]+$/.test(t)), tiles);

  // The shared inbox page must serve every domain, and it must not be routed to
  // a file that does not exist.
  const page = execFileSync('node', ['-e', `
    const fs = require('fs');
    process.stdout.write(fs.readFileSync('public/inbox-pfp.html', 'utf8'));
  `], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  check('the inbox page takes the domain as a parameter',
    /URLSearchParams\(location\.search\)\.get\('domain'\)/.test(page),
    'expected new URLSearchParams(location.search).get(\'domain\')');
  check('the inbox page builds its API base from the domain',
    page.includes("DOMAIN === 'pfp' ? '/resend/inbox'"), 'pfp must keep its pathless route');
  check('the inbox page no longer marks read against pfp only',
    !page.includes("domain: 'partyfavorphoto.com'"));
  check('the read call goes through the domain base', page.includes("fetch(API + '/read'"));

  const files = new Set(execFileSync('node', ['-e', `
    const fs = require('fs');
    process.stdout.write(fs.readdirSync('public').filter(f => /^inbox.*\\.html$/.test(f)).join('\\n'));
  `], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean));
  // Named in the source but never created, so those branches returned an error.
  for (const ghost of ['inbox-xmrt.html', 'inbox-31harbor.html', 'inbox-jobby.html']) {
    const named = new RegExp("inbox-" + ghost.split('-')[1].split('.')[0]).test(src);
    check(`${ghost} is not routed to`, !(named && !files.has(ghost) && !src.includes('existsSync')));
  }
  check('the dispatch checks the file exists',
    src.includes("if (key !== 'pfp' && existsSync(specific))"));
}

section('no identifier these patches touched is used without being declared');
{
  // node --check only catches syntax. A variable removed by one patch while
  // another line still reads it parses perfectly and throws ReferenceError at
  // request time. That happened twice here: the dropped emailDomainName, and
  // resendDomains, whose declaration went with the graph patch while the
  // vault-linking loop below it kept iterating it - the graph endpoint would have
  // thrown on every call and nothing would have said so.
  const src = execFileSync('node', ['-e', `
    const fs = require('fs');
    process.stdout.write(fs.readFileSync('server.js', 'utf8'));
  `], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

  const GONE = ['SIGNING_SECRETS', 'resendDomains'];
  for (const name of GONE) {
    check(`${name} is no longer referenced`,
      !new RegExp('\\b' + name + '\\b').test(src),
      (src.match(new RegExp('.{0,40}\\b' + name + '\\b.{0,40}')) || [])[0]);
  }

  const PRESENT = ['EMAIL_DOMAINS', 'EMAIL_INBOX_KEYS', 'emailDomainFor', 'emailDomainName',
    'resendKeyFor', 'webhookSecretFor', 'registerInboxRoutes', 'resendTileHtml', 'toDomainKey'];
  for (const name of PRESENT) {
    // Declaration forms: const/let/var/function, or a destructured binding.
    const declared = new RegExp(
      '(?:const|let|var|function)\\s+' + name + '\\b').test(src);
    const used = new RegExp('\\b' + name + '\\b').test(src);
    check(`${name} is declared if used`, !used || declared, 'used ' + used + ', declared ' + declared);
  }
}

console.log(fails === 0
  ? '\n  all email-domain registry checks passed'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
