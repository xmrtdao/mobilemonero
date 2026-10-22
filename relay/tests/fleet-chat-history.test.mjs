#!/usr/bin/env node
// Guards the fleet chat history against the bug that made the campus comms
// panel show a month-old scan as the newest message.
//
// The symptom: on every relay reload the panel showed a hermes-agent scan
// from July as the most recent thing anyone had said. The cause was one
// word in one query.
//
//   ORDER BY created_at ASC LIMIT 500
//
// on a table with 22,000 rows is the 500 OLDEST rows, not the newest 500.
// They were appended to the end of the in-memory buffer, and the buffer is
// read with slice(-limit) — so the oldest rows in the database became the
// newest rows on the bus.
//
// These checks read the source, because the failure is a source-level
// mistake: a query that is correct in isolation and wrong in context.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../hermes-bridge.mjs', import.meta.url), 'utf8');

section('the history loader takes the NEWEST rows');
{
  const loader = server.slice(
    server.indexOf('function loadFleetChatHistory()'),
    server.indexOf('loadFleetChatHistory();', server.indexOf('function loadFleetChatHistory()'))
  );
  check('the loader exists', loader.length > 0);
  check('it does not order ascending with a LIMIT',
    !/ORDER BY created_at ASC LIMIT/i.test(loader),
    (loader.match(/ORDER BY [^)]*LIMIT[^)]*\)/i) || [])[0]);
  check('it takes the newest rows',
    /ORDER BY created_at DESC LIMIT/i.test(loader),
    (loader.match(/ORDER BY created_at[^)]*\)/i) || [])[0]);
  check('it merges rather than appends',
    /merged\.set\(/.test(loader) && /fleetChatMessages\.length = 0/.test(loader));
  check('it sorts into one chronological list',
    /\.sort\(\(a, b\) => \(a\.ts \|\| 0\) - \(b\.ts \|\| 0\)\)/.test(loader));
  check('messages posted since startup survive the load',
    /for \(const m of fleetChatMessages\) add\(m\)/.test(loader));
}

section('the Hermes outbox delivers at most once');
{
  check('delivery is marked before the post, not after',
    /deliveryAttemptedAt/.test(bridge), 'no delivery marker');
  const marked = bridge.indexOf('deliveryAttemptedAt');
  const posted = bridge.indexOf("addFleetMessage('hermes'");
  check('the marker is written before the message goes out',
    marked >= 0 && posted >= 0 && marked < posted, { marked, posted });
  check('a file that was already attempted is removed, not re-posted',
    /if \(entry\.deliveryAttemptedAt\)[\s\S]{0,220}unlinkSync/.test(bridge));
  check('an old result is labelled as stale rather than posted as news',
    /STALE_RESULT_MS/.test(bridge) && /stale/.test(bridge));
}

section('the campus comms shows how old a message is');
{
  const dash = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  check('messages carry an age marker',
    /var ageMin = Math\.floor\(\(Date\.now\(\) - m\.ts\) \/ 60000\)/.test(dash));
  check('an old message is coloured differently from a fresh one',
    /ageColor = ageMin > 720 \? '#E4695A' : '#DC8A1E'/.test(dash));
}

console.log(fails === 0
  ? '\n  the fleet chat shows what was said, when it was said, and only once'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
