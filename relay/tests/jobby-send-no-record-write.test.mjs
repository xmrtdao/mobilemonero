/**
 * A turn that sends must not write the dossier.
 *
 * Observed in production: a turn whose whole subject was "send this email to
 * xmrtnet@gmail.com with this body" made six jobby_update_dossier calls and never
 * called jobby_send. The values it wrote were replayed out of earlier chat
 * messages in which a test had typed a fake diploma and a fake FIFO job, so
 * fabricated career history was recorded as though the candidate had said it.
 *
 * The guard is judged on the source, not on its intent: remove the
 * RECORD_WRITE_TOOLS check from chat.mjs and this test fails.
 */
import fs from 'node:fs';
import path from 'node:path';

// Anchored to this file, not to the working directory. `node --test` runs from the
// relay root, so resolving 'relay' from here produced relay/relay/jobby/chat.mjs
// and the test failed on ENOENT before checking a single assertion — which reads
// as a broken guard rather than a broken path.
const RELAY = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(RELAY, 'jobby', 'chat.mjs'), 'utf8');

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};

console.log('\n--- the guard exists ---');
check('the dispatch loop still refuses to run everything blindly',
  /if \(!handler\)/.test(src), 'unknown-tool branch gone');
check('a send turn is detected across the whole batch',
  /const turnSends =/.test(src) && /SEND_TOOLS\.has/.test(src),
  'turnSends detection missing');
check('the check is over the batch, not per call',
  /calls\.slice\(0, MAX_TOOL_ROUNDS\)\s*\n?\s*\.some\(/.test(src),
  'turnSends is computed per call, so tool order would decide the outcome');
check('record-writing tools are named',
  /jobby_update_dossier/.test(src) && /jobby_update_client/.test(src),
  'the record-write set is missing a tool');
check('a refused write is actually skipped',
  /RECORD_WRITE_TOOLS\.has\(name\)/.test(src) && /\bcontinue;/.test(src),
  'a blocked write would still fall through to the handler');

console.log('\n--- and it is stated as a turn-level rule, not a guess about intent ---');
check('the refusal tells the model why',
  /does not change the candidate's record/.test(src), 'no explanation returned to the model');
check('it warns against sourcing edits from chat history',
  /earlier messages in the conversation/.test(src), 'the history-replay hazard is not named');
check('it does not block the send itself',
  !/SEND_TOOLS\.has\(name\)/.test(src), 'sends are being blocked too');

console.log('\n--- the tools it guards are the real ones ---');
const tools = fs.readFileSync(path.join(RELAY, 'jobby', 'tools.mjs'), 'utf8');
['jobby_send', 'jobby_update_dossier', 'jobby_update_client'].forEach((t) => {
  check(`${t} is a real tool`, tools.includes(`${t}(args, ctx)`), 'not declared in tools.mjs');
});

console.log(failed ? `\n  ${failed} FAILED\n` : '\n  all passed\n');
process.exit(failed ? 1 : 0);