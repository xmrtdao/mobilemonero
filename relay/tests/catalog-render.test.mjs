// Render the real function table against the real live API, in a DOM stub.
//
// Extraction-based, but only of renderFunctions and its two inputs - the point is
// to run the actual filter/sort/map against the actual 252-entry payload, so a
// field rename or a missing property shows up as a thrown TypeError or a count of
// empty cells rather than as "the table looks a bit short".
import vm from 'node:vm';
import fs from 'node:fs';

const env = fs.readFileSync('.env', 'utf8');
const m = env.match(/^RELAY_API_KEY=(.*)$/m);
const key = m ? m[1].trim() : '';

// Every id renderFunctions reads is stubbed up front, so the search box can be
// driven by mutating els.search.value rather than by swapping the accessor.
const els = {
  fnBody: { innerHTML: '' },
  resultCount: { textContent: '' },
  search: { value: '' },
  methodFilter: { value: '' },
  typeFilter: { value: '' },
};
const ctx = {
  document: { getElementById: id => els[id] || { value: '', textContent: '', innerHTML: '' } },
  console,
};
vm.createContext(ctx);

const src = fs.readFileSync('public/dashboard.js', 'utf8');
const start = src.indexOf('function renderFunctions()');
const end = src.indexOf('function filterFunctions()');
if (start === -1 || end === -1) { console.log('  could not find renderFunctions'); process.exit(1); }
const body = src.slice(start, end);

vm.runInContext('var functions=[];var sortKey="name";var sortDir=1;var SUPABASE_URL="https://example.supabase.co";' + body, ctx);

const res = await fetch('http://127.0.0.1:8080/api/catalog', { headers: { 'x-api-key': key } });
const data = await res.json();
ctx.functions = data.functions || [];
console.log('  API returned %d functions', ctx.functions.length);
console.log('  keys: %s', [...new Set(ctx.functions.flatMap(f => Object.keys(f)))].sort().join(', '));

let failed = 0;
try {
  ctx.renderFunctions();
} catch (e) {
  console.log('  renderFunctions THREW: %s', e.message);
  process.exit(1);
}

const html = els.fnBody.innerHTML;
const rows = (html.match(/<tr>/g) || []).length;
const descCells = (html.match(/<td class="fn-desc">/g) || []).length;
const emptyDesc = (html.match(/<td class="fn-desc"><\/td>/g) || []).length;
const endpoints = (html.match(/class="endpoint-url"/g) || []).length;
const undef = (html.match(/undefined/g) || []).length;

console.log('');
console.log('  rows rendered        : %d', rows);
console.log('  description cells    : %d', descCells);
console.log('  EMPTY description    : %d  %s', emptyDesc, emptyDesc === 0 ? '(good)' : '(BUG)');
console.log('  endpoint cells       : %d', endpoints);
console.log('  literal "undefined"  : %d  %s', undef, undef === 0 ? '(good)' : '(BUG)');
console.log('  resultCount text     : %s', els.resultCount.textContent);
console.log('');

const expect = (label, cond) => { console.log('  %s  %s', cond ? 'PASS' : 'FAIL', label); if (!cond) failed++; };
expect('a row per function, with none cut off', rows === ctx.functions.length);
expect('every row has a description', descCells === ctx.functions.length && emptyDesc === 0);
expect('every row has an endpoint URL', endpoints === ctx.functions.length);
expect('nothing rendered the string "undefined"', undef === 0);

// The search path that used to throw. Mutated through the SAME element objects the
// stub already handed out, rather than by swapping getElementById: renderFunctions
// closes over the original stub, so replacing the function had no effect and the
// filter ran with an empty search box. That made the test report 252 rows for a
// search that should have matched a handful - a failure in the test, not the code.
els.search = { value: 'pdf' };
try {
  ctx.renderFunctions();
  const shown = (els.fnBody.innerHTML.match(/<tr>/g) || []).length;
  console.log('');
  console.log('  search for "pdf" -> %d rows, no throw', shown);
  expect('search narrows the list', shown > 0 && shown < ctx.functions.length);
  expect('and every surviving row still has a description',
    (els.fnBody.innerHTML.match(/<td class="fn-desc"><\/td>/g) || []).length === 0);
  els.search.value = '';
  ctx.renderFunctions();
  expect('clearing the search restores all rows',
    (els.fnBody.innerHTML.match(/<tr>/g) || []).length === ctx.functions.length);
} catch (e) {
  console.log('  search THREW: %s', e.message);
  failed++;
}

console.log('');
console.log(failed === 0
  ? '  every function renders with its description and URL'
  : `  ${failed} check(s) FAILED`);
// exitCode rather than process.exit: fetch leaves a handle open, and a hard exit
// races the teardown and trips a libuv assertion on Windows, reporting failure on
// a run that passed.
process.exitCode = failed === 0 ? 0 : 1;
