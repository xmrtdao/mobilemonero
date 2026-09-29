// Verify the fix for the failure in client 496: three wrong key names, only one
// reported, whole entry discarded, and a follow-up question answered with a
// canned non-answer.
import { applyEdit, applyEdits } from '../jobby/dossier.mjs';
import { looksLikeToolEcho } from '../jobby/chat.mjs';
import { looksLikeUserAssertion } from '../jobby/tools.mjs';

let fails = 0;
function check(label, cond, detail = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : `  -> ${JSON.stringify(detail)}`));
  if (!cond) fails++;
}

console.log('--- the edit that failed in production now lands ---');
const role = {
  title: 'LVS Operator',
  company: '1st Surveillance, Reconnaissance and Intelligence Group',
  end_date: '2004',
  location: 'Okinawa, Japan',
  start_date: '1997',
};
const res = applyEdits({ employment: [] }, [{ op: 'add', path: 'employment', value: role }]);
check('accepted', res.ok, res.error);
const entry = res.dossier?.employment?.[0];
check('stored under canonical keys, not the model\'s names',
  entry && entry.start === '1997' && entry.end === '2004', entry);
check('no leftover start_date key', entry && !('start_date' in entry), entry);
check('per-role location kept', entry?.location === 'Okinawa, Japan', entry?.location);
check('title and company kept',
  entry?.title === 'LVS Operator' && /1st Surveillance/.test(entry?.company || ''), entry);

console.log('\n--- genuinely unknown keys: all reported, not just the first ---');
const bad = applyEdit({}, {
  op: 'add', path: 'employment',
  value: { company: 'A', salary: '100k', bonus_type: 'equity', reports_to: 'someone' },
});
check('rejected', !bad.ok);
check('names every bad key',
  ['salary', 'bonus_type', 'reports_to'].every(k => bad.error.includes(k)), bad.error);
check('lists the valid fields so the model can self-correct',
  /Valid fields:.*company.*title.*start.*end/.test(bad.error), bad.error);

console.log('\n--- a mix of good and bad keys is still refused, not half-written ---');
const mixed = applyEdit({ employment: [] }, {
  op: 'add', path: 'employment', value: { company: 'Acme', title: 'Engineer', salary: '100k' },
});
check('refused rather than partially applied', !mixed.ok, mixed);
check('reports the offending key', mixed.error.includes('salary'), mixed.error);

console.log('\n--- update path gets the same alias tolerance ---');
const base = { employment: [{ company: 'Acme', title: 'Engineer', start: '2020', end: '2022' }] };
const upd = applyEdits(base, [{
  op: 'update', path: 'employment[0]', value: { end_date: '2024', location: 'Remote' },
}]);
check('accepted', upd.ok, upd.error);
check('end updated via alias', upd.dossier?.employment?.[0]?.end === '2024', upd.dossier?.employment?.[0]);
check('location added', upd.dossier?.employment?.[0]?.location === 'Remote', upd.dossier?.employment?.[0]);

console.log('\n--- aliases do not create fields that do not exist ---');
const bogus = applyEdit({ employment: [] }, {
  op: 'add', path: 'employment', value: { salary: '100k' },
});
check('salary still rejected', !bogus.ok && bogus.error.includes('salary'), bogus.error);
// Edits arrive as JSON, and JSON.parse is what makes __proto__ an own
// property. An object literal cannot reproduce that, so the literal form would
// pass here for the wrong reason.
const protoEdit = JSON.parse(
  '{"op":"add","path":"employment","value":{"__proto__":{"polluted":true},"company":"Acme"}}',
);
const proto = applyEdit({ employment: [] }, protoEdit);
check('prototype key still refused', !proto.ok, proto.error);
check('Object.prototype not polluted', !{}.polluted);

console.log('\n--- prose that merely starts with a failure word is not discarded ---');
// This is the reply that got thrown away: the user asked why a field was
// rejected and the model opened with "Error -", which the old test matched.
check('"Error - the field was rejected" survives',
  !looksLikeToolEcho('Error - employment.location is not a field, and start_date should be start. Nothing was written.'));
check('"Failed to save" survives', !looksLikeToolEcho('Failed to save that one. The dossier is unchanged.'));
check('a real explanation with a stack trace word survives',
  !looksLikeToolEcho('The write failed. The traceback said a key was unknown.'));

console.log('\n--- but actual machinery is still caught ---');
check('bare TOOL_CALL caught', looksLikeToolEcho('TOOL_CALL: {"tool":"jobby_send","args":{}}'));
check('raw JSON object caught', looksLikeToolEcho('{"path":"skills","op":"add"}'));
check('raw JSON result caught', looksLikeToolEcho('{"ok":false,"error":"nope"}'));
check('bare stack trace caught',
  looksLikeToolEcho('Traceback (most recent call last):\n  File "x.py", line 3\n    boom()\nNameError'));
check('empty still caught', looksLikeToolEcho('   '));

console.log('\n--- a plainly stated entry is recorded as confirmed ---');
// Jobby added the user's role and then asked them to confirm the company and
// city they had just typed, because an object value was never inspected: the
// candidate list skipped it and the write was logged unconfirmed.
const stated = 'Add a role: LVS Operator at 1st Surveillance Reconnaissance Group in Okinawa Japan, 1997 to 2004.';
check('object value the user spelled out is confirmed',
  looksLikeUserAssertion(stated, {
    title: 'LVS Operator',
    company: '1st Surveillance Reconnaissance Group',
    location: 'Okinawa, Japan',
    start: '1997',
    end: '2004',
  }));
check('object value with nothing in the message is not confirmed',
  !looksLikeUserAssertion('what is the weather today', {
    title: 'LVS Operator', company: 'Nowhere Inc', location: 'Okinawa, Japan',
  }));
check('nested objects are walked too',
  looksLikeUserAssertion(stated, { employment: [{ company: '1st Surveillance Reconnaissance Group' }] }));
check('scalars still work', looksLikeUserAssertion('my rate floor is 150 an hour', '150'));
check('an unstated scalar is still not confirmed', !looksLikeUserAssertion('hello', 'Rust'));
check('a first-person message still counts', looksLikeUserAssertion('actually I moved to Berlin', 'Berlin'));

console.log('\n' + (fails ? `${fails} FAILED` : 'all dossier-edit reliability checks passed'));
process.exit(fails ? 1 : 0);

