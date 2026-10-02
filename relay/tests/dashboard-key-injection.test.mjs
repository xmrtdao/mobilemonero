// Prove the API key is still reaching the browser after moving it out of the file.
//
// The failure this guards against is a real one from this project's past: a
// substitution that resolved to a redaction mask, so dashboard.js shipped
// '****' where the key belonged and every panel silently failed to authenticate.
// A missing key and a masked key look identical from the browser's side - both are
// "not the right string" - so the only reliable check is to compare the served
// bytes against the real value, and then to make a request with it.
import { readFileSync } from 'node:fs';

const env = readFileSync('.env', 'utf8');
const key = (env.match(/^RELAY_API_KEY=(.*)$/m) || [])[1]?.trim();

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};

const res = await fetch('http://127.0.0.1:8080/static/dashboard.js');
const js = await res.text();
console.log('\n  served HTTP %d, %d bytes\n', res.status, js.length);

check('the real key is present in the served file', js.includes(key),
  key ? 'not found in the served bytes' : 'no key in .env');

check('the placeholder was substituted away', !js.includes('${relayApiKey}'));

check('no redaction mask was substituted in', !/\*{4,}/.test(js),
  (js.match(/\*{4,}/) || [])[0]);

const line = js.split('\n').find(l => l.includes('const API_KEY')) || '';
check('the API_KEY line carries the real value',
  line.includes(key), line.trim().replace(key, key.slice(0, 8) + '…'));

// A file that is served correctly but authenticates wrongly still breaks the
// dashboard, so the request is made rather than assumed.
const withKey = await fetch('http://127.0.0.1:8080/', { headers: { 'x-api-key': key } });
const body = await withKey.text();
check('the dashboard accepts that key', withKey.status === 200 && body.includes('static/dashboard.js'),
  `HTTP ${withKey.status}`);

const without = await fetch('http://127.0.0.1:8080/');
check('and still refuses without it', without.status !== 200 || !(await without.text()).includes('static/dashboard.js'),
  `HTTP ${without.status}`);

// The other substitutions must still work, or the page loads and then fails on the
// Supabase calls.
check('the Supabase URL substitution still works', !js.includes('${supabaseUrl}'), '${supabaseUrl} left in the file');
check('the Supabase key substitution still works', !js.includes('${supabaseKey}'), '${supabaseKey} left in the file');
check('and the file is not empty of content', js.length > 50000, `${js.length} bytes`);

console.log(fails === 0
  ? '\n  the key reaches the browser, and the dashboard authenticates with it'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
