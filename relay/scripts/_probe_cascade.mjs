#!/usr/bin/env node
// Load relay/.env the way the server does, then vary one parameter at a time to
// find what makes the cascade fail.
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    process.env[key] = value;
  }
  console.log('loaded .env');
}
console.log('OPENCODE_API_KEY set:', !!process.env.OPENCODE_API_KEY);
console.log('OPENCODE_BASE_URL:', process.env.OPENCODE_BASE_URL);
console.log('OPENCODE_MODELS:', process.env.OPENCODE_MODELS);
console.log('LOCAL_OLLAMA_ONLY:', process.env.LOCAL_OLLAMA_ONLY);

const { ollamaChat } = await import('../tools/ollama-chat.mjs');

const cases = [
  ['short, no agent', 'Say hello in one short sentence.', {}],
  ['short, agent jobby', 'Say hello in one short sentence.', { agent: 'jobby' }],
  ['agent + sessionId', 'Say hello in one short sentence.', { agent: 'jobby', sessionId: 'p1' }],
  ['+ maxTokens + temp', 'Say hello in one short sentence.', { agent: 'jobby', temperature: 0.7, maxTokens: 1200, sessionId: 'p2' }],
  ['long system prompt', 'You are a career agent.\n'.repeat(120) + '\nClient: hi\n\nJobby:', { agent: 'jobby', temperature: 0.7, maxTokens: 1200, sessionId: 'p3' }],
];

for (const [label, prompt, opts] of cases) {
  const t0 = Date.now();
  let out;
  try { out = await ollamaChat(prompt, opts); }
  catch (e) { console.log(`${label.padEnd(22)} THREW ${e.message}`); continue; }
  const ms = Date.now() - t0;
  console.log(`${label.padEnd(22)} ${String(ms).padStart(6)}ms  ` +
    (out?.error ? `ERROR ${String(out.error).slice(0, 90)}` : `ok ${String(out?.content || '').length}b via ${out?.provider}`));
  if (out?.content) console.log(`    ${out.content.slice(0, 100).replace(/\n/g, ' ')}`);
}
