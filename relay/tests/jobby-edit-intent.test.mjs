#!/usr/bin/env node
// Tests for reading a plain-language change request.
//
// This is the fix for a real failure: a user said "update my phone number", Jobby
// said it had added it, and the dossier still said the phone number was missing.
// Jobby claimed a change it had not made.
//
// The direction of every error matters more here than elsewhere. A false negative -
// missing an edit - costs the user one more sentence. A false positive writes to
// someone's professional identity without being asked. So the tests below are
// weighted towards the things that must NOT fire.
import { parseUserEditIntent, looksLikeEditRequest, describeOutcome } from '../jobby/edit-intent.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 200)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

/** The single edit a message yields, or null. */
function only(message) {
  const r = parseUserEditIntent(message);
  return r.edits.length === 1 ? r.edits[0] : null;
}
function paths(message) {
  return parseUserEditIntent(message).edits.map(e => e.path);
}

section('the message that failed in production is read');
{
  const e = only('update my phone number to 804-555-0142');
  check('the phone edit is found', e && e.path === 'phone', e);
  check('the value is the number, not the sentence', e?.value === '804-555-0142', e?.value);
  check('it is a set', e?.op === 'set', e?.op);
  check('the reason records where it came from',
    /user's own message/.test(e?.reason || ''), e?.reason);

  // The same request, phrased the several ways people actually phrase it, with
  // the value checked in full. A digit-count assertion passed while
  // "804.555.0142" was being stored as "804", which is the bug that made this
  // worth writing carefully.
  for (const [phrasing, want] of [
    ['set my phone to 804-555-0142', '804-555-0142'],
    ['change my phone number to 804-555-0142', '804-555-0142'],
    ['my phone number is 804-555-0142', '804-555-0142'],
    ['my phone is (804) 555-0142', '(804) 555-0142'],
    ['update my mobile number to +1 804 555 0142', '+1 804 555 0142'],
    ['Can you change my cell number to 804.555.0142?', '804.555.0142'],
    ['correct my phone to 804-555-0142 please', '804-555-0142'],
    ['replace my phone number with 804-555-0142', '804-555-0142'],
    ['fix my telephone number, it is 555-0199', '555-0199'],
  ]) {
    const got = only(phrasing);
    check(`"${phrasing}" -> ${want}`, got?.path === 'phone' && got?.value === want, got);
  }
}

section('the other contact fields work too');
{
  const e = only('my email is joe.lee@example.com');
  check('email, in full including the dot in the domain',
    e?.path === 'email' && e?.value === 'joe.lee@example.com', e);

  const loc = only('I live in Richmond, VA now');
  check('location from "I live in"', loc?.path === 'location' && /Richmond/.test(loc?.value || ''), loc);

  const based = only("I'm based in Austin");
  check('location from "I\'m based in"', based?.path === 'location' && /Austin/.test(based?.value || ''), based);

  // A name needs an explicit request, and then it is checked as a name.
  const name = only('change my name to Joseph Andrew Lee');
  check('an explicit name change is honoured',
    name?.path === 'name' && name?.value === 'Joseph Andrew Lee', name);
  check('a bare "my name is X" is treated as a statement, not an instruction',
    only('my name is Joseph Andrew Lee') === null, only('my name is Joseph Andrew Lee'));

  const two = parseUserEditIntent('set my phone to 555-0100 and my email to a@b.com');
  check('two changes in one message are both read',
    two.edits.length === 2 && two.edits.map(e => e.path).sort().join(',') === 'email,phone',
    two.edits.map(e => `${e.path}=${e.value}`));
}

section('a value that is not what it claims is refused, and said so');
{
  // The failure mode this must not repeat: quietly doing nothing while the reply
  // says it was done. An invalid value has to surface as "I did not change this".
  const bad = parseUserEditIntent('set my phone to banana');
  check('a nonsense phone yields no edit', bad.edits.length === 0, bad.edits);
  check('and is reported as unmatched', bad.unmatched.length === 1
    && bad.unmatched[0].field === 'phone', bad.unmatched);

  for (const m of ['set my email to notanemail',
    'my email is @',
    'set my phone to 1',
    'set my location to https://example.com/very/long']) {
    const r = parseUserEditIntent(m);
    check(`"${m}" yields no edit`, r.edits.length === 0, r.edits);
  }
}

section('ordinary conversation does not write to the dossier');
{
  // The false-positive direction. Each of these is something a person might say
  // while filling out a profile, and none of them is a request to store anything.
  for (const m of [
    'what is my phone number?',
    'do you have my email address?',
    'I applied to Acme last week, any replies?',
    'my resume is attached',
    'I live in Richmond but I might move',
    'thanks for adding that',
    'can you tell me what you know about my employment history?',
    'send more jobs my way',
    'stop contacting me',
    'my name is spelled wrong in the PDF',
    'the phone number you have is out of date',
  ]) {
    const r = parseUserEditIntent(m);
    check(`"${m}" writes nothing`, r.edits.length === 0, r.edits);
  }
}

section('a question is not a request to change');
{
  // "my phone number is 555" as a question, not an instruction.
  const q = parseUserEditIntent('is my phone number 555-0100?');
  check('a question with the same words does not write', q.edits.length === 0, q.edits);
  // It is still recognisable as being about the dossier, so Jobby is expected to
  // account for having changed nothing.
  check('but it is still flagged as edit-shaped', looksLikeEditRequest('is my phone number 555-0100?'));
}

section('edit-shaped messages are recognised for the honesty guard');
{
  for (const m of [
    'update my phone number',
    'change my email',
    'my location is wrong',
    "it’s not right, my name is Joe Lee",
    'my address is out of date',
    'I live in Denver now',
    'set my phone to 555-0100',
  ]) check(`"${m}" is edit-shaped`, looksLikeEditRequest(m) === true, m);

  for (const m of [
    'hello', 'what can you do?', 'find me a job', 'thanks', '',
    'show me my tracks', 'how many applications did I send?',
  ]) check(`"${m}" is not edit-shaped`, looksLikeEditRequest(m) === false, m);
}

section('the outcome is stated as fact, not as the model\'s sentence');
{
  const s1 = describeOutcome([{ path: 'phone' }], [], []);
  check('names what was saved', /Saved to your dossier: phone/.test(s1), s1);
  const s2 = describeOutcome([], ['phone'], []);
  check('names what failed', /Could not save: phone/.test(s2), s2);
  const s3 = describeOutcome([], [], [{ field: 'phone', value: 'banana' }]);
  check('says an unapplied value was NOT changed', /did not change/.test(s3) && /banana/.test(s3), s3);
  check('says nothing was saved when nothing was',
    !/Saved/.test(describeOutcome([], [], [])), describeOutcome([], [], []));
}

section('odd input does not throw');
{
  for (const m of [null, undefined, 0, false, {}, [], 42, 'x'.repeat(5000), '\n\n']) {
    let r;
    try { r = parseUserEditIntent(m); } catch (e) {
      check(`parseUserEditIntent(${JSON.stringify(m)}) threw`, false, e.message);
      continue;
    }
    check(`parseUserEditIntent(${JSON.stringify(m)}) is safe`, Array.isArray(r.edits), r);
  }
  let f;
  try { f = looksLikeEditRequest(null); } catch (e) { f = 'threw: ' + e.message; }
  check('looksLikeEditRequest(null) is false', f === false, f);
}

section('a filled field stops being reported as missing');
{
  // This is the second half of the reported failure. With the phone number
  // written but "phone" still listed in not_stated, anything that renders the
  // missing list goes on telling the candidate their phone number is missing -
  // so the change lands and still appears not to have.
  const { applyEdit } = await import('../jobby/dossier.mjs');
  const before = { phone: null, email: null, not_stated: ['phone', 'email'] };

  const set = applyEdit(before, { op: 'set', path: 'phone', value: '804-555-0142' });
  check('the value is written', set.ok && set.dossier.phone === '804-555-0142', set.dossier?.phone);
  check('and it leaves the missing list',
    !set.dossier.not_stated.includes('phone'), set.dossier.not_stated);
  check('the other gap is still listed',
    set.dossier.not_stated.includes('email'), set.dossier.not_stated);

  // Going back to "I have none" puts it back, because that is a statement too.
  const cleared = applyEdit(set.dossier, { op: 'set', path: 'phone', value: null });
  check('setting it back to nothing re-lists it',
    cleared.dossier.not_stated.includes('phone'), cleared.dossier.not_stated);

  // A nested path corresponds to nothing in the missing list and must not add to it.
  const nested = applyEdit({ employment: [], not_stated: [] },
    { op: 'add', path: 'employment', value: { company: 'Acme', title: 'Engineer', start: '2020' } });
  check('a nested change does not touch the missing list',
    Array.isArray(nested.dossier.not_stated) && nested.dossier.not_stated.length === 0,
    nested.dossier?.not_stated);

  // A dossier with no not_stated must not grow one.
  const none = applyEdit({ phone: null }, { op: 'set', path: 'phone', value: '555-0199' });
  check('a dossier with no missing list does not grow one',
    none.dossier.not_stated === undefined, none.dossier.not_stated);

  // Case-insensitive, so "Phone" is recognised.
  const cased = applyEdit({ phone: null, not_stated: ['Phone'] },
    { op: 'set', path: 'phone', value: '555-0199' });
  check('the match is case-insensitive',
    !cased.dossier.not_stated.some(e => String(e).toLowerCase() === 'phone'),
    cased.dossier.not_stated);
}

console.log(fails === 0
  ? '\n  all edit-intent checks passed'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
