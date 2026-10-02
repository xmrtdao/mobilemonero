#!/usr/bin/env node
// Isolate the Jobby chat adapter: what does the model actually return for the
// prompt the relay builds, and does looksLikeToolEcho reject it?
import { ollamaChat } from '../tools/ollama-chat.mjs';
import { buildSystemPrompt } from '../jobby/persona.mjs';
import { looksLikeToolEcho, parseToolCalls } from '../jobby/chat.mjs';
import * as store from '../jobby/store.mjs';

const DOSSIER = {
  name: 'Dana Whitfield', current_title: 'Independent Consultant',
  email: 'dana@example.com', phone: '(415) 555-0188', location: 'San Francisco, CA',
  summary: 'Independent consultant advising fintech companies on risk and compliance. Founder of Whitfield Advisory LLC, nine years in the domain.',
  experience_years: 9, skills: ['Risk', 'Compliance', 'AML', 'Python', 'SQL'],
  employment: [{ company: 'Whitfield Advisory LLC', title: 'Founder & Principal Consultant', current: true, highlights: [] }],
  not_stated: ['seniority'], confidence: 'high',
};

const client = await store.getOrCreateClient(`probe-chat-${Date.now()}`);
const system = buildSystemPrompt({
  client: { mission_state: 'seeking', autonomy: 'auto', daily_send_cap: 15, kill_switch: false },
  dossier: DOSSIER,
  plan: { actions: [{ priority: 1, track: 1, title: 'Build the consulting offer', status: 'pending' }], trackReasons: { 1: 'founder', 3: 'base', 4: 'base' } },
  tracks: [1, 2, 3, 4],
  recentOutreach: [],
});

const full = `${system}\n\n---\n\nClient: What tracks am I running and why?\n\nJobby:`;
console.log('prompt length:', full.length);

const out = await ollamaChat(full, { agent: 'jobby', temperature: 0.7, maxTokens: 1200, sessionId: `jobby-${client.id}` });
console.log('=== full ollamaChat result ===');
console.log(JSON.stringify(out, null, 1).slice(0, 2000));
console.log('provider:', out?.provider, 'model:', out?.model);
const content = out?.content || '';
console.log('content length:', content.length);
console.log('\n=== RAW MODEL OUTPUT ===');
console.log(content);
console.log('=== END ===\n');

const { calls, text } = parseToolCalls(content);
console.log('tool calls parsed:', calls.length);
console.log('text after stripping:', JSON.stringify(text.slice(0, 300)));
console.log('looksLikeToolEcho(text):', looksLikeToolEcho(text));
console.log('  -> which rule?');
if (looksLikeToolEcho(text)) {
  const t = String(text).trim();
  console.log('   empty:', !t);
  console.log('   starts with error/failed:', /^(error|failed|exception|traceback)\b/i.test(t));
  console.log('   looks like a result json:', /\{\s*"(error|ok)"\s*:/.test(t) && t.length < 400);
  console.log('   starts with TOOL_CALL:', /^TOOL_CALL:/.test(t));
  console.log('   is an object with path/op/tool:', /^\{[\s\S]*\}$/.test(t) && /"(path|op|tool)"\s*:/.test(t));
}

await store.closeStore();
