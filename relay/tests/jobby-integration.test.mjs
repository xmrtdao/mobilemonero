#!/usr/bin/env node
// Integration test for Jobby: real Postgres, scripted model.
//
// The model is stubbed so the tool loop, the cap, the kill switch and the audit
// trail are all deterministic. What is being tested is Jobby's behaviour, not
// the model's.
import { chat, onboardFromDossier, parseToolCalls, looksLikeToolEcho } from '../jobby/chat.mjs';
import { createJobbyTools } from '../jobby/tools.mjs';
import { buildSystemPrompt, RAILS } from '../jobby/persona.mjs';
import * as store from '../jobby/store.mjs';
import { closeStore } from '../jobby/store.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 300)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const DOSSIER = {
  name: 'Jordan Ellis', current_title: 'Lead Platform Engineer', current_company: 'Acme Systems',
  email: 'john@example.com', phone: '(804) 555-0142', location: 'Richmond, VA',
  summary: 'Platform engineer with 9 years building distributed systems.',
  experience_years: 9, skills: ['Python', 'Go', 'Kubernetes', 'Terraform', 'AWS'],
  job_fields: ['Architecture', 'Cloud Engineering'],
  employment: [
    { company: 'Acme Systems', title: 'Lead Platform Engineer', start: 'March 2021', end: null, current: true, highlights: ['Reduced p99 latency 42%'] },
    { company: 'Beta Labs', title: 'Platform Engineer', start: 'June 2017', end: 'February 2021', current: false, highlights: ['Built event pipeline at 40k events/sec'] },
  ],
  education: [{ institution: 'State University', degree: 'B.S.', field: 'Computer Science', year: '2017' }],
  certifications: ['AWS Certified Solutions Architect - Professional'],
  not_stated: ['seniority'], verification_flags: [], confidence: 'high',
};

/** A model that replays a fixed script of replies, one per call. */
function scriptedModel(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async chat(messages) {
      calls.push(messages);
      const reply = script[Math.min(i, script.length - 1)];
      i++;
      return { content: reply, provider: 'test' };
    },
    async search() { return []; },
  };
}

async function freshClient(label) {
  const c = await store.getOrCreateClient(`test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return c;
}

// Sending is gated on a proved email address, so a client that is going to send
// has to be claimed. Verifying for real would mean reading a code out of an inbox
// mid-test, so the claim is issued and the plaintext code fed straight back - the
// same path the /api/jobby/claim routes take, minus the mail.
async function claimedClient(label) {
  const c = await freshClient(label);
  const email = `test-${label}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { requestClaim, verifyClaim } = await import('../jobby/claim.mjs');
  const issued = await requestClaim(c.id, email);
  if (issued.error) throw new Error(`claim issue failed: ${issued.error}`);
  const out = await verifyClaim(c.id, email, issued.code);
  if (out.error) throw new Error(`claim verify failed: ${out.error}`);
  return { ...c, email };
}

// ── Pure helpers ────────────────────────────────────────────────────────
section('tool-call parsing');
{
  const r = parseToolCalls('Sure thing.\nTOOL_CALL: {"tool":"jobby_update_dossier","args":{"edits":[{"op":"set","path":"phone","value":"555-1"}]}}\nDone.');
  check('one call found', r.calls.length === 1, r.calls);
  check('tool name', r.calls[0].tool === 'jobby_update_dossier', r.calls[0]);
  check('args parsed', r.calls[0].args.edits[0].path === 'phone', r.calls[0]);
  check('prose preserved, call stripped', !/TOOL_CALL/.test(r.text) && /Sure thing/.test(r.text), r.text);

  const two = parseToolCalls('TOOL_CALL: {"tool":"a","args":{}}\nTOOL_CALL: {"tool":"b","args":{}}');
  check('two calls', two.calls.length === 2, two.calls);

  const fenced = parseToolCalls('```\nTOOL_CALL: {"tool":"a","args":{}}\n```');
  check('fenced call detected', fenced.calls.length === 1, fenced.calls);

  const bold = parseToolCalls('**TOOL_CALL: {"tool":"a","args":{}}**');
  check('bold call detected', bold.calls.length === 1, bold.calls);

  const none = parseToolCalls('Just talking, no tools.');
  check('no calls', none.calls.length === 0 && none.text === 'Just talking, no tools.', none);

  const broken = parseToolCalls('TOOL_CALL: {not json');
  check('broken json kept as text', broken.calls.length === 0, broken.calls);

  const nested = parseToolCalls('TOOL_CALL: {"tool":"a","args":{"x":{"y":[1,2]}}}');
  check('nested args survive', nested.calls[0].args.x.y[1] === 2, nested.calls[0]);
}

section('raw tool output never becomes the answer');
{
  // The first two used to assert that a reply opening with "Error:" or "failed"
  // was discarded. That was the bug, not the intent: in a live session the user
  // asked why a dossier field had been rejected, the model replied with a plain
  // explanation beginning "Error -", and the entire answer was thrown away and
  // replaced with a canned apology. Telling a user "Error: connection refused"
  // is more use than telling them something went sideways, so the filter is now
  // structural and ordinary sentences pass through.
  check('a plain error sentence is allowed through', !looksLikeToolEcho('Error: connection refused'));
  check('"failed to send" is ordinary prose, allowed through', !looksLikeToolEcho('failed to send'));
  check('json result rejected', looksLikeToolEcho('{"ok":true}'));
  check('remaining tool call rejected', looksLikeToolEcho('TOOL_CALL: {"tool":"x"}'));
  check('edit object rejected', looksLikeToolEcho('{"op":"set","path":"phone"}'));
  check('empty rejected', looksLikeToolEcho('   '));
  check('normal prose accepted', !looksLikeToolEcho("You're all set — I updated your phone number."));
  check('prose mentioning an error word accepted', !looksLikeToolEcho('That error message was confusing, but I fixed it.'));
  check('a bare stack trace is still rejected', looksLikeToolEcho(
    'Traceback (most recent call last):\n  File "x.py", line 3, in y\n    boom()\nNameError'));
}

// ── Persona ─────────────────────────────────────────────────────────────
section('persona integrity rails');
{
  check('rails are present', Array.isArray(RAILS) && RAILS.length >= 6, RAILS?.length);
  check('forbids inventing experience', RAILS.some(r => /not in the dossier/.test(r)));
  check('forbids inventing references', RAILS.some(r => /reference/i.test(r)));
  check('forbids rounding up numbers', RAILS.some(r => /round up/i.test(r)));
  check('forbids false certainty', RAILS.some(r => /false certainty|until there is a record/i.test(r)));
  check('forbids manipulating the user', RAILS.some(r => /manipulative/i.test(r)));
  check('mission is stated as income', /income is the mission/.test(
    (await import('../jobby/persona.mjs')).MISSION));
  check('mission covers post-placement', /job is not the end/i.test(
    (await import('../jobby/persona.mjs')).MISSION));
}

section('system prompt reflects live state');
{
  const p = buildSystemPrompt({
    client: { display_name: 'Jordan', mission_state: 'seeking', autonomy: 'auto', daily_send_cap: 15, kill_switch: false },
    dossier: DOSSIER,
    plan: { actions: [{ priority: 1, track: 3, title: 'Lock the packet', status: 'pending' }], trackReasons: { 3: 'base' } },
    tracks: [3, 4],
    recentOutreach: [],
  });
  check('names the client', p.includes('Jordan Ellis'));
  check('shows mission state', /seeking/.test(p));
  check('lists active tracks', /Track 3/.test(p) && /Track 4/.test(p));
  check('explains closed tracks', /are closed/.test(p));
  check('includes the not-stated list', /NOT STATED/.test(p));
  check('includes work history', /Acme Systems/.test(p));
  check('includes the rails', p.includes('Non-negotiables'));
  check('kill switch changes instructions', buildSystemPrompt({
    client: { mission_state: 'seeking', autonomy: 'auto', daily_send_cap: 5, kill_switch: true }, tracks: [3],
  }).includes('KILL SWITCH IS ON'));
}

// ── Onboarding ──────────────────────────────────────────────────────────
let employeeClient, consultantClient;
section('onboarding from a parsed dossier');
{
  employeeClient = await freshClient('employee');
  const r = await onboardFromDossier(employeeClient.id, DOSSIER, { sourceFilename: 'cv.txt' });
  check('onboarded', r.ok, r);
  check('revision 1', r.revision === 1, r);
  check('employee gets tracks 3,4', JSON.stringify(r.tracks) === '[3,4]', r.tracks);
  check('plan generated', r.actions > 5, r.actions);
  check('summary produced', typeof r.summary === 'string' && r.summary.length > 40);

  const dossierRow = await store.getDossier(employeeClient.id);
  check('dossier persisted', dossierRow?.dossier?.name === 'Jordan Ellis', dossierRow?.dossier?.name);
  check('provenance recorded', dossierRow?.updated_by === 'resume-parse', dossierRow?.updated_by);
  check('filename recorded', dossierRow?.source_filename === 'cv.txt');
  const edits = await store.getDossierEdits(employeeClient.id);
  check('parse itself is audited', edits.length === 1 && edits[0].actor === 'resume-parse', edits);

  const actions = await store.listActions(employeeClient.id);
  check('actions persisted', actions.length === r.actions, actions.length);
  check('track 1 action absent for employee', !actions.some(a => a.track === 1));
}

section('a consultant gets all four tracks');
{
  consultantClient = await freshClient('consultant');
  const r = await onboardFromDossier(consultantClient.id, {
    ...DOSSIER, name: 'Dana Fox', current_title: 'Independent Consultant',
    summary: 'Independent consultant and founder of a consulting practice (LLC).',
  });
  check('four tracks', r.tracks.length === 4, r.tracks);
  check('sells services', r.sellsServices === true);
  check('consulting action present',
    (await store.listActions(consultantClient.id)).some(a => a.track === 1));
}

section('re-onboarding replaces the pending plan without touching done work');
{
  const before = await store.listActions(employeeClient.id);
  const done = before[0];
  await store.updateAction(employeeClient.id, done.id, { status: 'done', result: 'finished' });
  const r2 = await onboardFromDossier(employeeClient.id, { ...DOSSIER, skills: [...DOSSIER.skills, 'Rust'] });
  const after = await store.listActions(employeeClient.id);
  check('revision incremented', r2.revision === 2, r2.revision);
  check('done action preserved', after.some(a => a.id === done.id && a.status === 'done'), after.filter(a => a.id === done.id));
  check('plan regenerated', after.length > 5, after.length);
  check('new skill persisted', (await store.getDossier(employeeClient.id)).dossier.skills.includes('Rust'));
}

// ── Chat ────────────────────────────────────────────────────────────────
section('chat answers without tools');
{
  const m = scriptedModel(["Your phone is on file. I will use it on every application."]);
  const r = await chat(employeeClient.id, 'What phone number do you have for me?', { llmChat: m });
  check('replied', typeof r.reply === 'string' && r.reply.length > 10, r.reply);
  check('no tools called', r.toolCalls.length === 0, r.toolCalls);
  check('one model turn', r.turns === 1, r.turns);
  check('client state returned', r.client.tracks.length === 2, r.client);
  const hist = await store.history(employeeClient.id, 10);
  check('both turns stored', hist.some(h => h.role === 'user') && hist.some(h => h.role === 'jobby'));
}

section('chat applies a dossier edit the user asked for');
{
  const m = scriptedModel([
    'TOOL_CALL: {"tool":"jobby_update_dossier","args":{"edits":[{"op":"set","path":"phone","value":"(804) 555-0000","reason":"user gave the real number"}]}}',
    'Updated — your phone is now (804) 555-0000 and I will use it on every application.',
  ]);
  const r = await chat(employeeClient.id, 'My real phone is (804) 555-0000, please correct it.', { llmChat: m });
  check('two turns (tool then answer)', r.turns === 2, r.turns);
  check('dossier updated', (await store.getDossier(employeeClient.id)).dossier.phone === '(804) 555-0000',
    (await store.getDossier(employeeClient.id)).dossier.phone);
  check('tool recorded', r.toolCalls.some(t => t.tool === 'jobby_update_dossier'), r.toolCalls);
  check('reply is prose, not the tool line', !/TOOL_CALL/.test(r.reply), r.reply);
  const edits = await store.getDossierEdits(employeeClient.id, 5);
  const latest = edits[0];
  check('audit row written', latest.path === 'phone', latest);
  check('before value captured', latest.before_value === '(804) 555-0142', latest.before_value);
  check('marked user-confirmed', latest.confirmed_by_user === true, latest);
  check('actor is jobby', latest.actor === 'jobby', latest);
}

section('an unconfirmed edit is saved but flagged');
{
  const m = scriptedModel([
    'TOOL_CALL: {"tool":"jobby_update_dossier","args":{"edits":[{"op":"add","path":"skills","value":"Kubernetes"}]}}',
    'Noted.',
  ]);
  const r = await chat(employeeClient.id, 'how is the search going?', { llmChat: m });
  check('duplicate add refused by the dossier layer',
    r.toolCalls.some(t => /already present/i.test(JSON.stringify(t.result || t.error || ''))), r.toolCalls);
}

section('a model cannot invent a tool');
{
  const m = scriptedModel([
    'TOOL_CALL: {"tool":"jobby_delete_everything","args":{}}',
    'Sorry, that is not something I can do.',
  ]);
  const r = await chat(employeeClient.id, 'wipe everything', { llmChat: m });
  check('unknown tool reported as an error', r.toolCalls.some(t => t.error === 'unknown tool'), r.toolCalls);
  check('model told the valid names',
    m.calls[1].some(c => (c.content || '').includes('does not exist')), 'no tool list');
  check('dossier intact', (await store.getDossier(employeeClient.id)).dossier.name === 'Jordan Ellis');
}

section('a throwing tool becomes a message, not a crash');
{
  const m = scriptedModel([
    'TOOL_CALL: {"tool":"jobby_research","args":{}}',
    'Give me a query and I will search.',
  ]);
  const r = await chat(employeeClient.id, 'go find me jobs', { llmChat: m });
  check('did not throw', typeof r.reply === 'string' && r.reply.length > 0, r);
  check('error surfaced to the model',
    r.toolCalls.some(t => /query/.test(JSON.stringify(t.error || t.result || ''))), r.toolCalls);
}

section('the daily cap stops sends and explains itself');
{
  const c = await claimedClient('capped');
  await onboardFromDossier(c.id, DOSSIER);
  await store.updateClient(c.id, { daily_send_cap: 2 });
  for (let i = 0; i < 2; i++) {
    await store.recordOutreach(c.id, { recipient: `a${i}@x.com`, subject: 's', body: 'b', status: 'sent' });
  }
  const m = scriptedModel([
    'TOOL_CALL: {"tool":"jobby_send","args":{"recipient":"hr@corp.com","subject":"Hello","body":"Hi there"}}',
    'I hit the daily cap, so nothing went out today.',
  ]);
  const r = await chat(c.id, 'send that application to hr@corp.com', { llmChat: m });
  const res = r.toolCalls.find(t => t.tool === 'jobby_send');
  check('send blocked', res?.result?.ok === false, res);
  check('block reason is the cap', res?.result?.blocked === 'daily_cap', res?.result);
  check('cap numbers reported', res?.result?.reason?.includes('2/2') || /cap/i.test(res?.result?.reason || ''), res?.result?.reason);
  const queued = await store.recentOutreach(c.id, 10);
  check('blocked message still logged', queued.some(o => o.recipient === 'hr@corp.com'), queued.map(o => o.recipient));
  check('nothing marked sent', queued.every(o => o.recipient !== 'hr@corp.com' || o.status !== 'sent'), queued);
}

section('the kill switch overrides everything');
{
  const c = await claimedClient('killed');
  await onboardFromDossier(c.id, DOSSIER);
  await store.updateClient(c.id, { kill_switch: true });
  const m = scriptedModel([
    'TOOL_CALL: {"tool":"jobby_send","args":{"recipient":"hr@corp.com","subject":"Hello","body":"Hi"}}',
    'The kill switch is on, so I did not send that.',
  ]);
  const r = await chat(c.id, 'send it', { llmChat: m });
  const res = r.toolCalls.find(t => t.tool === 'jobby_send');
  check('send blocked by kill switch', res?.result?.blocked === 'kill_switch', res?.result);
  check('model told about the switch',
    m.calls[0].some(c => /KILL SWITCH IS ON/.test(c.content || '')), 'not in system prompt');
}

section('a send is delivered and logged');
{
  const c = await claimedClient('sending');
  await onboardFromDossier(c.id, DOSSIER);
  const sent = [];
  const m = scriptedModel([
    'TOOL_CALL: {"tool":"jobby_send","args":{"recipient":" hiring@corp.com","subject":"Platform role","body":"Hi, I lead platform at Acme."}}',
    'Sent to hiring@corp.com.',
  ]);
  const r = await chat(c.id, 'email them now', { llmChat: m, deliver: async msg => { sent.push(msg); return 'resend_abc123'; } });
  check('delivered', sent.length === 1, sent);
  check('recipient trimmed', sent[0]?.to === 'hiring@corp.com', sent[0]?.to);
  const log = await store.recentOutreach(c.id, 5);
  check('logged as sent', log.some(o => o.recipient === 'hiring@corp.com' && o.status === 'sent'), log);
  check('provider id stored', log.some(o => o.provider_id === 'resend_abc123'), log);
}

section('a non-address is rejected before it can be logged as sent');
{
  const c = await claimedClient('badaddr');
  await onboardFromDossier(c.id, DOSSIER);
  const m = scriptedModel([
    'TOOL_CALL: {"tool":"jobby_send","args":{"recipient":"The hiring manager","subject":"Hi","body":"Hello"}}',
    'I need an actual email address.',
  ]);
  const r = await chat(c.id, 'email the hiring manager', { llmChat: m });
  const res = r.toolCalls.find(t => t.tool === 'jobby_send');
  check('rejected', res?.result?.error?.includes('not an email address'), res?.result);
  const log = await store.recentOutreach(c.id, 5);
  check('nothing sent', log.every(o => o.status !== 'sent'), log);
}

section('the loop is bounded');
{
  const c = await freshClient('loop');
  await onboardFromDossier(c.id, DOSSIER);
  // A model that only ever emits a tool call.
  const m = scriptedModel(['TOOL_CALL: {"tool":"jobby_plan_status","args":{}}']);
  const r = await chat(c.id, 'what is the plan?', { llmChat: m });
  check('stopped at the turn limit', r.turns <= 4, r.turns);
  check('did not hang', typeof r.reply === 'string' && r.reply.length > 0);
  check('leftover tool line stripped', !/TOOL_CALL/.test(r.reply), r.reply);
  check('told the user it stopped', /stopped there/i.test(r.reply), r.reply);
}

section('bad input');
{
  const c = await freshClient('bad');
  await onboardFromDossier(c.id, DOSSIER);
  const m = scriptedModel(['ok']);
  check('empty message refused', (await chat(c.id, '   ', { llmChat: m })).error);
  check('null message refused', (await chat(c.id, null, { llmChat: m })).error);
  check('overlong message refused', (await chat(c.id, 'x'.repeat(9000), { llmChat: m })).error);
  check('missing llm dependency throws', await chat(c.id, 'hi', {}).then(() => false, () => true));
  check('unknown client errors', (await chat(99999999, 'hi', { llmChat: m })).error);
}

section('a provider outage is reported, not swallowed');
{
  const c = await freshClient('outage');
  await onboardFromDossier(c.id, DOSSIER);
  const before = (await store.getDossier(c.id)).dossier.phone;
  const broken = {
    async chat() { throw new Error('All cloud providers failed: OpenCodeZen: HTTP 429'); },
    async search() { return []; },
  };
  const r = await chat(c.id, 'are you there?', { llmChat: broken });
  check('did not throw', typeof r.reply === 'string' && r.reply.length > 10, r);
  check('names the cause', /could not reach the model/i.test(r.reply), r.reply);
  check('reassures nothing changed', /Nothing was changed/.test(r.reply), r.reply);
  check('dossier untouched', (await store.getDossier(c.id)).dossier.phone === before);

  // An adapter that returns the ollama-chat shape ({response}) must work too.
  const responseShape = {
    async chat() { return { response: 'Your phone is (804) 555-0142.', provider: 'opencode-zen' }; },
  };
  const ok = await chat(c.id, 'what phone do you have?', { llmChat: responseShape });
  check('{response} shape is accepted', /555-0142/.test(ok.reply), ok.reply);
}

section('multi-user isolation');
{
  const a = await claimedClient('iso-a');
  const b = await claimedClient('iso-b');
  await onboardFromDossier(a.id, { ...DOSSIER, name: 'Person A' });
  await onboardFromDossier(b.id, { ...DOSSIER, name: 'Person B' });
  const m = scriptedModel(['ok']);
  await chat(a.id, 'my name?', { llmChat: m });
  const ha = await store.history(a.id, 20);
  const hb = await store.history(b.id, 20);
  check('A has its own history', ha.length > 0);
  check('B history untouched by A', hb.length === 0, hb);
  check('dossiers differ', (await store.getDossier(a.id)).dossier.name !== (await store.getDossier(b.id)).dossier.name);
  check('edits do not leak', (await store.getDossierEdits(a.id)).every(e => e.client_id === a.id));
}

section('tool argument aliases the model actually uses');
{
  const c = await claimedClient('aliases');
  await onboardFromDossier(c.id, DOSSIER);
  const sent = [];
  const tools = createJobbyTools({ llmChat: { async search() { return []; } } });
// ── The send gate ───────────────────────────────────────────────────────
// Sending is a representation made in someone's name, so it needs a proved email
// address. Reading the portal does not: browsing works on any device with no
// setup, which is what makes the gate affordable rather than a tax on every visit.
section('an unverified client may not send');
{
  const c = await freshClient('unverified');
  await store.saveDossier(c.id, DOSSIER, { updatedBy: 'test' });
  const sent = [];
  const r = await tools.jobby_send(
    { recipient: 'hiring@corp.com', subject: 'Hello', body: 'Hi.' },
    { clientId: c.id, userMessage: '', deliver: async m => { sent.push(m); return 'id-x'; } });
  check('the send is refused', r.ok === false, JSON.stringify(r).slice(0, 160));
  check('with a code the model can act on', r.blocked === 'email_not_verified', r.blocked);
  check('and nothing reached the transport', sent.length === 0, sent.length);
  check('the message is kept rather than lost', !!r.queuedId, JSON.stringify(r).slice(0, 120));
  const rows = await store.recentOutreach(c.id, 5);
  check('and it is on record as queued, not sent',
    rows[0]?.status === 'queued' && !rows[0]?.sent_at, JSON.stringify(rows[0]).slice(0, 140));
}

section('once verified, the same client sends');
{
  const c = await claimedClient('verified');
  await store.saveDossier(c.id, DOSSIER, { updatedBy: 'test' });
  const sent = [];
  const r = await tools.jobby_send(
    { recipient: 'hiring@corp.com', subject: 'Hello', body: 'Hi.' },
    { clientId: c.id, userMessage: '', deliver: async m => { sent.push(m); return 'id-y'; } });
  check('the send goes through', r.ok === true && r.delivered === true, JSON.stringify(r).slice(0, 160));
  check('and the transport received it', sent.length === 1, sent.length);
  check('to the right recipient', sent[0]?.to === 'hiring@corp.com', JSON.stringify(sent[0]));
}



  // The model reaches for `to`, not `recipient`. Observed in the live run.
  const r1 = await tools.jobby_send(
    { to: 'a@b.test', subject: 'S', body: 'B' },
    { clientId: c.id, userMessage: '', deliver: async m => { sent.push(m); return 'id-1'; } });
  check('`to` accepted as recipient', r1.ok === true, r1);
  check('`to` mapped through', sent[0]?.to === 'a@b.test', sent[0]);

  const r2 = await tools.jobby_send(
    { email: 'c@d.test', title: 'S2', message: 'B2' },
    { clientId: c.id, userMessage: '', deliver: async m => { sent.push(m); return 'id-2'; } });
  check('`email`/`title`/`message` accepted', r2.ok === true, r2);

  const r3 = await tools.jobby_research({ q: 'risk consultant jobs' }, { clientId: c.id });
  check('`q` accepted for research', !r3.error, r3);

  const r4 = await tools.jobby_add_opportunity(
    { title: 'Head of Risk', employer: 'Acme', link: 'https://x.test' }, { clientId: c.id });
  check('`title`/`employer`/`link` accepted for an opportunity', r4.ok === true, r4);
  check('mapped to the right columns', r4.role === 'Head of Risk' && r4.company === 'Acme', r4);

  const r5 = await tools.jobby_send({ subject: 'S' }, { clientId: c.id, userMessage: '' });
  check('missing recipient still refused', /recipient/.test(r5.error || ''), r5);
}

await closeStore();
console.log('\n' + (fails === 0 ? 'all jobby integration tests passed' : fails + ' FAILED'));
process.exit(fails === 0 ? 0 : 1);
