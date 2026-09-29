#!/usr/bin/env node
// Tests for deriving a candidate's address.
//
// This function decides what a person is called in every job application they
// will ever send, so the rules are pinned down exhaustively rather than by a
// couple of happy paths. The accents, the apostrophes, the middle names and the
// collisions are where the real cases are.
//
// Every assertion about shape is backed by the shape rule itself: the output is
// either null or matches /^[a-z0-9]+(\.[a-z0-9]+)*$/.
import { execFileSync } from 'node:child_process';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

// Load the real module rather than a copy, so the test cannot drift from it.
const M = await import('../jobby/mailbox.mjs');
const {
  deriveLocalPart, candidateAddress, fallbackAddress, uniqueLocalPart,
  domainOf, localPartOf, displayNameFor, formatFrom, MAILBOX_DOMAIN,
} = M;

// A hyphen is permitted mid-token: it is legal in an email local part and in a
// DNS label, and the generated fallback uses one deliberately so that an address
// nobody chose is visibly nobody's. Names have theirs joined away.
const SHAPE = /^[a-z0-9]+([.-][a-z0-9]+)*$/;

section('the default user gets the address that was asked for');
{
  check('Joe Lee', deriveLocalPart('Joe Lee') === 'joe.lee', deriveLocalPart('Joe Lee'));
  check('Joe Lee, with punctuation', deriveLocalPart('Joe Lee,') === 'joe.lee', deriveLocalPart('Joe Lee,'));
  check('full address', candidateAddress('Joe Lee') === 'joe.lee@jobbymcjobberson.com',
    candidateAddress('Joe Lee'));
  check('the domain is the new one', MAILBOX_DOMAIN === 'jobbymcjobberson.com', MAILBOX_DOMAIN);
}

section('a middle name is dropped, so one person cannot get two addresses');
{
  // Joseph Andrew Lee and Joseph Lee are the same person. Two addresses would
  // split their inbox and their history.
  check('middle name dropped', deriveLocalPart('Joseph Andrew Lee') === 'joseph.lee',
    deriveLocalPart('Joseph Andrew Lee'));
  check('Joseph Lee', deriveLocalPart('Joseph Lee') === 'joseph.lee');
  check('three tokens uses first and last',
    deriveLocalPart('Ana Maria de la Cruz') === 'ana.cruz', deriveLocalPart('Ana Maria de la Cruz'));
}

section('accents are decomposed, not rejected');
{
  // A candidate with an accented name should get a real address, not a
  // generated one, which would be the visible failure.
  const cases = [
    ['José García', 'jose.garcia'],
    ['Müller', 'muller'],
    ['Renée Ångström', 'renee.angstrom'],
    ['Søren Kierkegaard', 'soren.kierkegaard'],
    ['François', 'francois'],
  ];
  for (const [name, expect] of cases) {
    const got = deriveLocalPart(name);
    check(`${name} -> ${expect}`, got === expect, got);
  }
}

section('apostrophes and hyphens are handled, not passed through');
{
  check("O'Brien", deriveLocalPart("Seamus O'Brien") === 'seamus.obrien', deriveLocalPart("Seamus O'Brien"));
  check('curly apostrophe', deriveLocalPart('Seamus O’Brien') === 'seamus.obrien',
    deriveLocalPart('Seamus O’Brien'));
  check('hyphen joins', deriveLocalPart('Mary-Jane Watson') === 'maryjane.watson',
    deriveLocalPart('Mary-Jane Watson'));
  check('hyphen does not become a dot', !String(deriveLocalPart('Anne-Marie Roy')).includes('..'));
}

section('a name that cannot be reduced returns null rather than a bad address');
{
  for (const name of ['', '   ', null, undefined, '???', '...', '@@@', '123', '数字', 'Ω']) {
    const got = deriveLocalPart(name);
    const ok = got === null || SHAPE.test(got);
    check(`${JSON.stringify(name)} -> ${JSON.stringify(got)} is null or well-shaped`, ok, got);
  }
  // A single token is usable; a wholly unusable name is not.
  check('a single name works', deriveLocalPart('Prince') === 'prince', deriveLocalPart('Prince'));
  check('no address for a non-latin name', candidateAddress('数字') === null, candidateAddress('数字'));
}

section('every output matches the shape rule');
{
  // The value ends up in a DNS label and a URL path, so this is asserted over a
  // wide spread rather than assumed from the examples above.
  const names = [
    'Joe Lee', 'Joseph Andrew Lee', 'José García', "Seamus O'Brien", 'Mary-Jane Watson',
    'Prince', '  padded  name  ', 'UPPER CASE', 'MiXeD CaSe', 'Jean-Luc Picard Jr',
    'Anne-Marie de la Cruz', '李 明', 'O', 'A B', 'Xavier  Xavier', 'test@example.com',
    'Robert\'); DROP TABLE', 'a'.repeat(200), 'É'.repeat(30),
  ];
  let bad = [];
  for (const name of names) {
    const got = deriveLocalPart(name);
    if (got !== null && !SHAPE.test(got)) bad.push({ name, got });
    if (got !== null && got.length > 60) bad.push({ name, got, tooLong: got.length });
  }
  check('all of them are null or match the shape rule', bad.length === 0, bad);
  check('a very long name is clipped', deriveLocalPart('a'.repeat(200)).length <= 60,
    deriveLocalPart('a'.repeat(200)).length);
  check('SQL in a name cannot escape into a query', deriveLocalPart("Robert'); DROP TABLE") !== null
    && !deriveLocalPart("Robert'); DROP TABLE").includes("'"),
    deriveLocalPart("Robert'); DROP TABLE"));
  check('an address-looking name does not become an address',
    !String(deriveLocalPart('test@example.com')).includes('@'), deriveLocalPart('test@example.com'));
  // A name's own hyphens are joined away; only the generated fallback keeps one.
  check('a derived local part never contains a hyphen',
    ['Mary-Jane Watson', 'Jean-Luc Picard', 'Anne-Marie Roy'].every(
      (n) => !String(deriveLocalPart(n)).includes('-')),
    ['Mary-Jane Watson', 'Jean-Luc Picard', 'Anne-Marie Roy'].map(deriveLocalPart));
}

section('collisions get a suffix on the last name');
{
  const taken = new Set(['maria.garcia']);
  check('the first Maria Garcia is untouched', uniqueLocalPart('maria.garcia', new Set()) === 'maria.garcia');
  check('the second gets 2', uniqueLocalPart('maria.garcia', taken) === 'maria.garcia2',
    uniqueLocalPart('maria.garcia', taken));
  // The suffix goes last on purpose: "maria.garcia2" reads as a second Maria
  // Garcia; "maria2.garcia" reads as a different person.
  const many = new Set(['maria.garcia', 'maria.garcia2', 'maria.garcia3']);
  check('the fourth gets 4', uniqueLocalPart('maria.garcia', many) === 'maria.garcia4',
    uniqueLocalPart('maria.garcia', many));
  check('a null base yields null', uniqueLocalPart(null, taken) === null);
  // Exhaustion must end rather than loop. The base itself is in the taken set
  // here - otherwise 'x' is free and it returns immediately, which is correct
  // behaviour and not the case under test.
  const exhausted = new Set(['x', ...Array.from({ length: 1200 }, (_, i) => 'x' + (i + 2))]);
  check('exhaustion yields null rather than a loop',
    uniqueLocalPart('x', exhausted) === null, uniqueLocalPart('x', exhausted));
}

section('addresses are parsed by domain and local part, exactly');
{
  check('domain', domainOf('joe.lee@jobbymcjobberson.com') === 'jobbymcjobberson.com');
  check('local part', localPartOf('joe.lee@jobbymcjobberson.com') === 'joe.lee');
  check('case is ignored', localPartOf('JOE.LEE@JobbyMcJobberson.COM') === 'joe.lee');
  check('no domain', domainOf('joe.lee') === null);
  check('no local part', localPartOf('@jobbymcjobberson.com') === null);
  check('empty', domainOf('') === null);
}

section('the From header names the candidate, not the agent');
{
  check('a real name', formatFrom('Joe Lee', 'joe.lee@jobbymcjobberson.com')
    === 'Joe Lee <joe.lee@jobbymcjobberson.com>', formatFrom('Joe Lee', 'joe.lee@jobbymcjobberson.com'));
  check('falls back to the local part when no name is stored',
    formatFrom(null, 'joe.lee@jobbymcjobberson.com') === 'joe.lee <joe.lee@jobbymcjobberson.com>',
    formatFrom(null, 'joe.lee@jobbymcjobberson.com'));
  // A display name is attacker-influenced only via the dossier, but header
  // injection through a quote or angle bracket is still not worth allowing.
  check('quotes and brackets are stripped from the name',
    displayNameFor('Ev"il <script>', 'a@b.com') === 'Evil script',
    displayNameFor('Ev"il <script>', 'a@b.com'));
  check('a name with a comma is quoted',
    formatFrom('Lee, Joe', 'joe.lee@x.com').startsWith('"Lee, Joe" <'),
    formatFrom('Lee, Joe', 'joe.lee@x.com'));
  check('no newline can reach the header',
    !/[\r\n]/.test(formatNameWithNewline()), 'header injection');
}

function formatNameWithNewline() {
  return formatFrom('Joe\r\nBcc: someone@else.com', 'joe.lee@x.com');
}

section('the fallback address is stable and obviously generated');
{
  check('by client id', fallbackAddress(7) === 'candidate-7@jobbymcjobberson.com', fallbackAddress(7));
  check('shaped correctly', SHAPE.test(localPartOf(fallbackAddress(7))), fallbackAddress(7));
  check('distinct per client', fallbackAddress(7) !== fallbackAddress(8));
  check('a string id works too', fallbackAddress('abc') === 'candidate-abc@jobbymcjobberson.com',
    fallbackAddress('abc'));
}

section('the shared validator is what both the sender and the reply lookup use');
{
  const { isCandidateMailbox } = M;
  const good = [
    'joe.lee@jobbymcjobberson.com', 'JOE.LEE@JOBBYMCJOBBERSON.COM',
    'candidate-7@jobbymcjobberson.com', 'maria.garcia2@jobbymcjobberson.com',
  ];
  for (const a of good) check(`${JSON.stringify(a)} is valid`, isCandidateMailbox(a) === true, a);

  // "@jobbymcjobberson.com" is the one that motivated this validator: a check
  // for "@" alone accepted it, and the header became
  // "Joe Lee <@jobbymcjobberson.com>".
  // Whitespace handling is asserted separately below.
  // Trailing and leading whitespace is stripped, so stray whitespace in stored
  // data does not break sending. An EMBEDDED newline is a different matter and
  // is rejected: that is the header-injection case, where
  // "joe\nBcc: someone@evil.test@jobbymcjobberson.com" would otherwise split the
  // header and add a recipient.
  for (const a of ['  joe.lee@jobbymcjobberson.com  ', 'joe.lee@jobbymcjobberson.com\n',
    '\tjoe.lee@jobbymcjobberson.com']) {
    check(`${JSON.stringify(a)} is tolerated`, isCandidateMailbox(a) === true, a);
  }
  for (const a of [
    '@jobbymcjobberson.com', 'no-at-sign', '', '   ', 'joe.lee@', 'joe.lee@evil.example.com',
    'joe.lee@jobbymcjobberson.com.evil.test', 'joe lee@jobbymcjobberson.com',
    'joe.lee@notjobbymcjobberson.com', 'joe..lee@jobbymcjobberson.com',
    '.joe.lee@jobbymcjobberson.com', 'joe.lee.@jobbymcjobberson.com',
    'joe.lee@jobbymcjobberson.com\nevil.test', 'joe\n.lee@jobbymcjobberson.com',
    'joe.lee@JOBBYMCJOBBERSON.COM.evil.test', null, undefined, 42, {},
  ]) check(`${JSON.stringify(a)} is rejected`, isCandidateMailbox(a) === false, a);

  check('another domain can be checked explicitly',
    isCandidateMailbox('a@31harbor.com', '31harbor.com') === true);
  check('and rejected against ours', isCandidateMailbox('a@31harbor.com') === false);
}

console.log(fails === 0
  ? '\n  all mailbox derivation checks passed'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
