/**
 * Every email must say a machine wrote it, and the shape of one is specified.
 *
 * Both exist because nothing specified either. The sends that prompted this came
 * out of a model that had been told, in the rails, "never send anything the user
 * would not be comfortable seeing sent under their own name" — and wrote as though
 * the candidate were typing, because no instruction anywhere said otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';

const RELAY = path.resolve(import.meta.dirname, '..');
const persona = fs.readFileSync(path.join(RELAY, 'jobby', 'persona.mjs'), 'utf8');
const tools = fs.readFileSync(path.join(RELAY, 'jobby', 'tools.mjs'), 'utf8');

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};

console.log('\n--- the rail exists and is non-negotiable in tone ---');
check('a rail demands disclosure',
  /ALWAYS identify yourself as Jobby/.test(persona), 'no disclosure rail');
check('it explains why, so it does not read as boilerplate',
  /deception/.test(persona) && /worthless/.test(persona), 'no reasoning on the rail');

console.log('\n--- the template is specified, and is a separate thing from the rails ---');
check('EMAIL_TEMPLATE is exported', /export const EMAIL_TEMPLATE/.test(persona), 'not exported');
check('it is its own section, not a rail',
  /## How you write an email/.test(persona), 'no email section');
check('it carries the required opening',
  /I'm Jobby, an assistant working on behalf of FIRSTNAME LASTNAME/.test(persona),
  'the opening line is missing');
check('it asks for the role and the link',
  /POSITION LISTING/.test(persona) && /LINK/.test(persona), 'no role/link placeholders');
check('it demands dossier-traceable reasons',
  /traceable to the dossier/.test(persona), 'reasons are not sourced');
check('it sets a length ceiling', /under 250 words/.test(persona), 'no length rule');
check('it requires plain text', /Plain text only/.test(persona), 'no plain-text rule');
check('it lands in the system prompt',
  /STYLE, '', EMAIL_TEMPLATE/.test(persona), 'EMAIL_TEMPLATE not appended to the prompt');

console.log('\n--- and the disclosure is enforced, not merely suggested ---');
// Behavioural, not a regex over tools.mjs. The first version of this file read the
// source and passed with the check disabled, because turning
// `if (!opensWithDisclosure)` into `if (false)` leaves every identifier it looked
// for still sitting in the file. This calls the real function instead.
const { passesDisclosure } = await import('../jobby/persona.mjs');

const ACCEPTED = [
  ["Hello! I'm Jobby, an assistant working on behalf of Joseph Andrew Lee.", 'the required opening'],
  ["Hi — I'm Jobby. I'm writing for Joseph Andrew Lee about the role.", 'names Jobby in the opening'],
  ['I am an AI assistant writing on behalf of Dana Okonkwo.', 'declares an assistant'],
  ['Hello, this is an agent working on behalf of the candidate.', 'declares an agent'],
];
const REFUSED = [
  ['Hi there,\n\nI am writing about the backend role you posted.', 'no disclosure at all'],
  ['', 'empty body'],
  [null, 'null'],
  [undefined, 'undefined'],
  ["Hi,\n\nI'd be great for this.\n\n" + 'x'.repeat(600) + "\n\nI'm Jobby, an assistant writing on behalf of Joseph.", 'disclosed only after 400 chars'],
];
ACCEPTED.forEach(([body, why]) =>
  check(`accepts: ${why}`, passesDisclosure(body) === true, 'refused a compliant email'));
REFUSED.forEach(([body, why]) =>
  check(`refuses: ${why}`, passesDisclosure(body) === false, 'accepted a concealed email'));

check('jobby_send calls it', /passesDisclosure\(BODY\)/.test(tools), 'the tool does not call the check');
check('it refuses rather than warns', /nothingWasSent: true/.test(tools), 'not treated as a stop');
check('the refusal is recoverable in one step',
  /requiredOpening/.test(tools) && /guidance/.test(tools), 'no template handed back');

console.log('\n--- and it cannot be quietly disabled ---');
check('the check sits before the send', tools.indexOf('opensWithDisclosure') < tools.indexOf('findRecentDuplicate'),
  'the check runs after the send');
check('the gate still runs too', /canSend\(ctx\.clientId\)/.test(tools), 'the send gate was removed');

console.log(failed ? `\n  ${failed} FAILED\n` : '\n  all passed\n');
process.exit(failed ? 1 : 0);