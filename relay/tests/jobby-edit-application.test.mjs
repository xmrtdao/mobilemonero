#!/usr/bin/env node
// End-to-end: a plain-language change request must reach the dossier.
//
// This reproduces the reported failure. A user told Jobby to update their phone
// number; Jobby said it had added it; the dossier still said the phone number
// was missing. Jobby had claimed a change nobody made.
//
// The stub model below behaves the way a real one does when asked something
// conversational: it answers in prose, says the work is done, and emits no
// TOOL_CALL line. That is not a contrived model - it is the normal case, and it
// is exactly the shape that took the `if (!calls.length) break` early exit while
// the dossier branch sat behind it.
//
// Real database, real store. The point is the end-to-end write, and a mock would
// assert the code's intention rather than the row it produces.
import pg from 'pg';
import { getOrCreateClient, getDossier, closeStore } from '../jobby/store.mjs';
import { chat } from '../jobby/chat.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 240)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const pool = new pg.Pool({
  connectionString: process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
});
const made = [];

/** A client with a dossier that is missing a phone number, like the real report. */
async function clientWithDossier(displayName) {
  const key = `editintent-${Math.random().toString(36).slice(2)}`;
  const c = await getOrCreateClient(key, displayName);
  made.push(c.id);
  const { saveDossier } = await import('../jobby/store.mjs');
  await saveDossier(c.id, {
    name: displayName, email: null, phone: null, location: null, summary: 'Test profile',
    skills: [], employment: [], education: [], not_stated: ['phone'],
  }, { updatedBy: 'test' });
  return c;
}

/**
 * A model that behaves like a real one here: prose in, no tool call, cheerful
 * confirmation. `say` is what it claims it did.
 */
function chattyModel(say) {
  return { chat: async () => ({ content: say }) };
}

async function dossierOf(id) {
  const row = await getDossier(id);
  return row?.dossier || null;
}

section('the reported failure: a phone number, claimed and not written');
{
  const c = await clientWithDossier('Test Person');
  check('the dossier starts with no phone number',
    (await dossierOf(c.id))?.phone === null, (await dossierOf(c.id))?.phone);

  const res = await chat(c.id, 'update my phone number to 804-555-0142', {
    llmChat: chattyModel("Done — I've added your phone number, 804-555-0142."),
  });

  const after = await dossierOf(c.id);
  check('the phone number is in the dossier', after?.phone === '804-555-0142', after?.phone);
  check('the missing-field note was cleared',
    !(after?.not_stated || []).includes('phone'), after?.not_stated);

  // The audit trail, which is the point of job_dossier_edits.
  const audit = await pool.query(
    `SELECT op, path, after_value, actor, confirmed_by_user
     FROM app.job_dossier_edits WHERE client_id = $1 ORDER BY id DESC LIMIT 1`, [c.id]);
  check('the change is recorded as an audit row', audit.rows.length === 1, audit.rows);
  check('it records the new value', audit.rows[0]?.after_value === '804-555-0142',
    audit.rows[0]?.after_value);
  check('the actor is jobby, not the user', audit.rows[0]?.actor === 'jobby', audit.rows[0]?.actor);
}

section('the reply does not contradict the dossier');
{
  const c = await clientWithDossier('Test Person');
  const res = await chat(c.id, 'change my email to joe.lee@example.com', {
    llmChat: chattyModel("All set, your email is updated."),
  });
  check('the change landed', (await dossierOf(c.id))?.email === 'joe.lee@example.com',
    (await dossierOf(c.id))?.email);
  check('the reply confirms it', /Saved to your dossier/i.test(res.reply), res.reply);
}

section('a claim with nothing behind it is corrected in the reply');
{
  // The important negative: if the change genuinely could not be made, the reply
  // must say so, whatever the model claimed.
  const c = await clientWithDossier('Test Person');
  const res = await chat(c.id, 'set my phone to banana', {
    llmChat: chattyModel("Done, your phone number is now banana."),
  });
  check('nothing invalid was written', (await dossierOf(c.id))?.phone === null,
    (await dossierOf(c.id))?.phone);
  check('the reply does not let a bad value stand unremarked',
    /did not change/i.test(res.reply), res.reply);
}

section('a model claiming a change in an unrelated turn is not taken at its word');
{
  // The reply is the model's sentence. The guard only speaks when the user's
  // message was actually about changing the dossier, so ordinary conversation
  // does not sprout a correction.
  const c = await clientWithDossier('Test Person');
  const res = await chat(c.id, 'what jobs have I applied to?', {
    llmChat: chattyModel("You have applied to three roles so far."),
  });
  check('no spurious correction is appended',
    !/Saved to your dossier|did not change/i.test(res.reply), res.reply);
  check('the model\'s answer is passed through',
    /three roles/.test(res.reply), res.reply);
}

section('the structured path still works for what phrasing cannot cover');
{
  // Employment history genuinely needs the model's understanding, so that route
  // is untouched - and it must still be reached on a tool call.
  const c = await clientWithDossier('Test Person');
  let turn = 0;
  const model = {
    chat: async () => {
      turn++;
      if (turn === 1) {
        return {
          content: 'TOOL_CALL: {"tool":"jobby_update_dossier","args":{"op":"add","path":"skills","value":"Kubernetes"}}',
        };
      }
      return { content: "Added Kubernetes to your skills." };
    },
  };
  const res = await chat(c.id, 'I also have Kubernetes experience', { llmChat: model });
  const after = await dossierOf(c.id);
  check('the skill was written by the tool path',
    (after?.skills || []).includes('Kubernetes'), after?.skills);
  check('no false correction was added', !/did not change/i.test(res.reply), res.reply);
}

async function cleanup() {
  if (made.length) {
    await pool.query('DELETE FROM app.job_clients WHERE id = ANY($1::int[])', [made]);
  }
  await pool.end();
}

await cleanup();
await closeStore();

console.log(fails === 0
  ? '\n  all edit-application checks passed'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
