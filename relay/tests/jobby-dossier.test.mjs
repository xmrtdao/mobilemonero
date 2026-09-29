#!/usr/bin/env node
// Tests for dossier editing. The path whitelist and the audit trail are the
// two things standing between an LLM and someone's professional identity, so
// they get the most adversarial tests here.
import {
  applyEdit, applyEdits, parsePath, coerce, getAtPath,
  parseEditRequest, describeAudit, READ_ONLY_PATHS,
} from '../jobby/dossier.mjs';

let fails = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
}
const section = t => console.log('\n=== ' + t + ' ===');

const BASE = {
  name: 'Jordan Ellis',
  email: 'john@example.com',
  phone: '(804) 555-0142',
  skills: ['Python', 'Go', 'Kubernetes'],
  links: { linkedin: 'linkedin.com/in/jordanellis', github: 'github.com/jellis' },
  employment: [{ company: 'Acme Systems', title: 'Lead Platform Engineer', current: true, highlights: [] }],
  education: [{ institution: 'State University', degree: 'B.S.', field: 'Computer Science', year: '2017' }],
  not_stated: ['seniority'],
  confidence: 'high',
  verification_flags: ['phone is a 555 range number'],
};

// ── Path validation ─────────────────────────────────────────────────────
section('path whitelist blocks anything that is not a dossier field');
{
  for (const bad of ['__proto__', 'constructor', 'prototype', 'evil', 'toString', 'hasOwnProperty', 'valueOf']) {
    const r = parsePath(bad);
    check(`rejects root "${bad}"`, !r.ok, r);
  }
  check('accepts a real field', parsePath('skills').ok);
  check('accepts a real nested field', parsePath('links.github').ok);
  check('accepts an array index', parsePath('employment[0].title').ok);
  check('accepts a bare array index for delete', parsePath('employment[0]').ok);
  check('rejects unknown nested links', !parsePath('links.evil').ok);
  check('rejects unknown employment subfield', !parsePath('employment[0].evil').ok);
  check('rejects unknown subfield of a scalar', !parsePath('name.thing').ok);
  check('rejects empty path', !parsePath('').ok);
  check('rejects non-string path', !parsePath(42).ok);
  check('rejects absurdly long path', !parsePath('a'.repeat(300)).ok);
  check('rejects a forbidden key mid-path', !parsePath('skills.__proto__.x').ok);
}

section('prototype pollution is impossible, not merely unlikely');
{
  // `key in obj` walks the prototype chain. These are the exact shapes a
  // crafted model reply would use.
  for (const path of ['__proto__', 'constructor', 'prototype']) {
    const r = applyEdit(BASE, { op: 'set', path, value: { polluted: 'yes' } });
    check(`set "${path}" refused`, !r.ok, r);
    const d = applyEdit(BASE, { op: 'delete', path });
    check(`delete "${path}" refused`, !d.ok, d);
  }
  check('Object.prototype has no "polluted"', ({}).polluted === undefined);
  check('Object.prototype has no "admin"', ({}).admin === undefined);
  check('no dossier key named __proto__',
    !Object.getOwnPropertyNames(BASE).includes('__proto__'),
    Object.getOwnPropertyNames(BASE));
  const nested = parseEditRequest('{"op":"set","path":"skills.__proto__.x","value":"y"}');
  if (nested.ok) {
    check('nested injection refused', !applyEdits(BASE, nested.edits).ok);
  } else {
    check('nested injection not parsed as an edit', true);
  }
  check('still clean after all that', ({}).polluted === undefined && ({}).x === undefined);
}

section('read-only extraction fields cannot be written');
{
  for (const p of READ_ONLY_PATHS) {
    const r = applyEdit(BASE, { op: 'set', path: p, value: 'x' });
    check(`"${p}" is read-only`, !r.ok, r);
  }
  const r = applyEdit(BASE, { op: 'set', path: 'confidence', value: 'low' });
  check('confidence error explains why', /read-only/.test(r.error || ''), r.error);
}

// ── Basic operations ────────────────────────────────────────────────────
section('set and update scalars');
{
  const r = applyEdit(BASE, { op: 'set', path: 'phone', value: '(804) 555-9999' });
  check('set works', r.ok, r);
  check('value applied', r.dossier.phone === '(804) 555-9999', r.dossier.phone);
  check('original untouched', BASE.phone === '(804) 555-0142');
  check('audit records before', r.audit.before_value === '(804) 555-0142', r.audit);
  check('audit records after', r.audit.after_value === '(804) 555-9999', r.audit);

  const u = applyEdit(r.dossier, { op: 'update', path: 'phone', value: '(804) 555-0000' });
  check('update works', u.ok, u);
  const bad = applyEdit(r.dossier, { op: 'update', path: 'seniority', value: 'Staff' });
  check('update on missing field is refused', !bad.ok, bad);
  check('refusal suggests "set"', /op "set"/.test(bad.error), bad.error);
  const same = applyEdit(r.dossier, { op: 'update', path: 'phone', value: '(804) 555-9999' });
  check('no-op update is refused', !same.ok, same);
}

section('add appends and dedupes');
{
  const r = applyEdit(BASE, { op: 'add', path: 'skills', value: 'Terraform' });
  check('skill added', r.dossier.skills.includes('Terraform'), r.dossier.skills);
  check('original order kept', r.dossier.skills.slice(0, 3).join() === 'Python,Go,Kubernetes', r.dossier.skills);
  const dup = applyEdit(r.dossier, { op: 'add', path: 'skills', value: 'python' });
  check('case-insensitive duplicate refused', !dup.ok, dup);
  check('duplicate error names the value', /already present/.test(dup.error), dup.error);

  const multi = applyEdit(BASE, { op: 'add', path: 'skills', value: 'Rust, Elixir , ,Go' });
  check('comma list split', multi.ok, multi);
  check('blank entries dropped', !multi.dossier.skills.includes(''), multi.dossier.skills);
  check('Go not duplicated', multi.dossier.skills.filter(s => s === 'Go').length === 1, multi.dossier.skills);
}

section('set replaces a whole list');
{
  const r = applyEdit(BASE, { op: 'set', path: 'skills', value: ['Rust'] });
  check('list replaced', JSON.stringify(r.dossier.skills) === '["Rust"]', r.dossier.skills);
  const bad = applyEdit(BASE, { op: 'set', path: 'skills', value: { a: 1 } });
  check('object rejected for a list field', !bad.ok, bad);
  check('no "[object Object]" leaks in', bad.ok !== true, bad);
}

section('nested object edits');
{
  const r = applyEdit(BASE, { op: 'set', path: 'links.portfolio', value: 'jellis.dev' });
  check('nested set works', r.dossier.links.portfolio === 'jellis.dev', r.dossier.links);
  check('siblings preserved', r.dossier.links.github === 'github.com/jellis');
  const del = applyEdit(r.dossier, { op: 'delete', path: 'links.github' });
  check('nested delete works', del.dossier.links.github === undefined, del.dossier.links);
  check('other links survive', del.dossier.links.linkedin === 'linkedin.com/in/jordanellis');
  check('missing delete refused', !applyEdit(BASE, { op: 'delete', path: 'links.nope' }).ok);
}

section('array element edits');
{
  const u = applyEdit(BASE, { op: 'update', path: 'employment[0].title', value: 'Staff Platform Engineer' });
  check('array element updated', u.dossier.employment[0].title === 'Staff Platform Engineer', u.dossier.employment[0]);
  check('other fields in the element survive', u.dossier.employment[0].company === 'Acme Systems');
  const c = applyEdit(BASE, { op: 'update', path: 'employment[0].current', value: 'no' });
  check('boolean coerced from text', c.dossier.employment[0].current === false, c.dossier.employment[0]);
  const bad = applyEdit(BASE, { op: 'update', path: 'employment[9].title', value: 'x' });
  check('out-of-range index does not create', !bad.ok && bad.dossier === undefined, bad);
  const e = applyEdit(BASE, { op: 'update', path: 'education[0].year', value: '2018' });
  check('education element updated', e.dossier.education[0].year === '2018');
}

section('adding an employment entry');
{
  const r = applyEdit(BASE, {
    op: 'add', path: 'employment',
    value: { company: 'Beta Labs', title: 'Platform Engineer', start: 'June 2017', end: 'February 2021', current: false },
  });
  check('entry appended', r.dossier.employment.length === 2, r.dossier.employment.length);
  check('entry content right', r.dossier.employment[1].company === 'Beta Labs', r.dossier.employment[1]);
  const notObj = applyEdit(BASE, { op: 'add', path: 'employment', value: 'Beta Labs' });
  check('string rejected where object needed', !notObj.ok, notObj);
  const badField = applyEdit(BASE, { op: 'add', path: 'employment', value: { evil: 'x' } });
  check('unknown subfield rejected on add', !badField.ok, badField);
  check('error lists valid subfields', /company/.test(badField.error), badField.error);
}

section('deleting entries');
{
  const d = applyEdit(BASE, { op: 'delete', path: 'employment[0]' });
  check('element removed', d.dossier.employment.length === 0, d.dossier.employment);
  const s = applyEdit(BASE, { op: 'delete', path: 'skills[0]' });
  check('list element removed', s.dossier.skills.length === 2, s.dossier.skills);
  const gone = applyEdit(BASE, { op: 'delete', path: 'seniority' });
  check('absent field delete refused', !gone.ok, gone);
  check('refusal is clear', /nothing at/.test(gone.error), gone.error);
}

section('writing a whole list element');
{
  const r = applyEdit(BASE, { op: 'update', path: 'employment[0]', value: { title: 'Staff Platform Engineer' } });
  check('partial object merges into the element', r.dossier.employment[0].title === 'Staff Platform Engineer', r.dossier.employment[0]);
  check('merge kept the company', r.dossier.employment[0].company === 'Acme Systems', r.dossier.employment[0]);
  const notObj = applyEdit(BASE, { op: 'set', path: 'employment[0]', value: 'Engineer' });
  check('text refused where an object is needed', !notObj.ok, notObj);
  const oob = applyEdit(BASE, { op: 'set', path: 'employment[5]', value: { title: 'X' } });
  check('out-of-range element refused', !oob.ok, oob);
  check('out-of-range error is explicit', /does not exist/.test(oob.error), oob.error);
  const addAt = applyEdit(BASE, { op: 'add', path: 'employment[0]', value: { title: 'X' } });
  check('add at an index is refused', !addAt.ok, addAt);
  check('add-at-index redirects to append', /append a new entry/.test(addAt.error), addAt.error);
  const listIdx = applyEdit(BASE, { op: 'set', path: 'skills[0]', value: 'Rust' });
  check('text allowed for a list-of-text index', listIdx.dossier.skills[0] === 'Rust', listIdx.dossier.skills);
}

section('numbers and coercion');
{
  const n = applyEdit(BASE, { op: 'set', path: 'experience_years', value: '9 years' });
  check('numeric string coerced', n.dossier.experience_years === 9, n.dossier.experience_years);
  const bad = coerce('experience_years', undefined, 'about a decade');
  check('non-numeric rejected', !bad.ok, bad);
  const nul = applyEdit(BASE, { op: 'set', path: 'experience_years', value: '' });
  check('empty clears to null', nul.dossier.experience_years === null);
  const blank = applyEdit(BASE, { op: 'set', path: 'phone', value: '   ' });
  check('whitespace-only clears to null', blank.dossier.phone === null);
}

// ── Batches ─────────────────────────────────────────────────────────────
section('batches apply in order and stop at the first failure');
{
  const r = applyEdits(BASE, [
    { op: 'set', path: 'phone', value: '(804) 555-0000', reason: 'user corrected it', confirmedByUser: true },
    { op: 'add', path: 'skills', value: 'Terraform' },
    { op: 'set', path: 'links.portfolio', value: 'jellis.dev' },
  ]);
  check('all applied', r.ok, r);
  check('three audits', r.audits.length === 3, r.audits.length);
  check('reason carried', r.audits[0].reason === 'user corrected it', r.audits[0]);
  check('confirmation carried', r.audits[0].confirmedByUser === true, r.audits[0]);
  check('confirmation defaults false', r.audits[1].confirmedByUser === false, r.audits[1]);
  check('actor recorded', r.audits[0].actor === 'jobby', r.audits[0]);
  check('all changes visible',
    r.dossier.phone === '(804) 555-0000' &&
    r.dossier.skills.includes('Terraform') &&
    r.dossier.links.portfolio === 'jellis.dev');

  const partial = applyEdits(BASE, [
    { op: 'set', path: 'phone', value: 'x' },
    { op: 'set', path: '__proto__', value: 'x' },
  ]);
  check('bad edit fails the batch', !partial.ok, partial);
  check('index reported', /edit 2/.test(partial.error), partial.error);
  check('earlier edits still audited', partial.applied.length === 1, partial.applied);
}

// ── Model reply parsing ─────────────────────────────────────────────────
section('edit requests parsed out of messy model replies');
{
  const clean = parseEditRequest('{"op":"add","path":"skills","value":"Rust"}');
  check('bare object', clean.ok && clean.edits.length === 1, clean);

  const fenced = parseEditRequest('Here you go:\n```json\n{"op":"set","path":"phone","value":"555-1234"}\n```\nHope that helps!');
  check('fenced with preamble', fenced.ok, fenced);
  check('value extracted', fenced.edits[0].value === '555-1234', fenced.edits);

  const arr = parseEditRequest('[{"op":"add","path":"skills","value":"A"},{"op":"set","path":"phone","value":"B"}]');
  check('array of edits', arr.ok && arr.edits.length === 2, arr);

  const wrapped = parseEditRequest('{"edits":[{"op":"add","path":"skills","value":"C"}]}');
  check('edits wrapper', wrapped.ok && wrapped.edits.length === 1, wrapped);

  const trailing = parseEditRequest('{"op":"add","path":"skills","value":"D",}');
  check('trailing comma tolerated', trailing.ok, trailing);

  const fieldKey = parseEditRequest('{"field":"phone","value":"555","op":"set"}');
  check('"field" accepted as an alias for "path"', fieldKey.ok && fieldKey.edits[0].path === 'phone', fieldKey);

  check('prose is not JSON', !parseEditRequest('I would be happy to help!').ok);
  check('empty is not JSON', !parseEditRequest('').ok);
  check('null is not JSON', !parseEditRequest(null).ok);
  check('json without a path is not an edit', !parseEditRequest('{"hello":"world"}').ok);
}

section('a model cannot self-certify its own edits');
{
  const r = parseEditRequest('{"op":"set","path":"employment[0].title","value":"CEO","confirmedByUser":true}');
  check('model-supplied confirmation is dropped', r.edits[0].confirmedByUser === false, r.edits[0]);
}

section('prompt injection in a model reply cannot reach the prototype');
{
  const r = parseEditRequest('{"op":"set","path":"__proto__.polluted","value":"yes"}');
  if (r.ok) {
    const res = applyEdits(BASE, r.edits);
    check('injected path rejected by the whitelist', !res.ok, res);
  } else {
    check('injected path not even parsed as an edit', true);
  }
  check('Object.prototype untouched', ({}).polluted === undefined);
}

// ── Robustness ──────────────────────────────────────────────────────────
section('robustness');
{
  check('null dossier is tolerated', applyEdit(null, { op: 'set', path: 'name', value: 'X' }).ok);
  check('garbage dossier is tolerated', applyEdit('nope', { op: 'set', path: 'name', value: 'X' }).ok);
  check('missing edit is refused', !applyEdit(BASE, {}).ok);
  check('bad op is refused', !applyEdit(BASE, { op: 'destroy', path: 'name', value: 'x' }).ok);
  check('getAtPath on a missing path is undefined', getAtPath(BASE, ['nope', 'deeper']) === undefined);
  check('empty batch succeeds', applyEdits(BASE, []).ok);
  const e = applyEdit(BASE, { op: 'set', path: 'email', value: 'x' });
  check('audit describes a set', /set/.test(describeAudit(e.audit)), describeAudit(e.audit));

  // An "add" must report what was added, not reprint the whole list.
  const added = applyEdit(BASE, { op: 'add', path: 'skills', value: 'Rust' });
  const described = describeAudit(added.audit);
  check('add reports only the new item', described.includes('Rust') && !described.includes('Kubernetes'), described);
  check('add names the field', described.includes('skills'), described);
  const addedMany = applyEdit(BASE, { op: 'add', path: 'skills', value: 'Rust, Elixir' });
  check('multi-add lists both new items',
    /Rust/.test(describeAudit(addedMany.audit)) && /Elixir/.test(describeAudit(addedMany.audit)),
    describeAudit(addedMany.audit));
  const removed = describeAudit(applyEdit(BASE, { op: 'delete', path: 'skills[0]' }).audit);
  check('delete reports the old value', /Python/.test(removed), removed);
  const changed = describeAudit(applyEdit(BASE, { op: 'update', path: 'phone', value: '555-9' }).audit);
  check('update reports the new value', /555-9/.test(changed), changed);
}

console.log('\n' + (fails === 0 ? 'all dossier tests passed' : fails + ' FAILED'));
process.exit(fails === 0 ? 0 : 1);
