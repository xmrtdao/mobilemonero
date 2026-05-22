#!/usr/bin/env node
/**
 * publish-content.mjs — UTF-8 Safe Content Publisher
 * 
 * Writes content to any channel ensuring proper UTF-8 encoding.
 * Prevents the CP1252 emoji corruption issue on Windows.
 * 
 * Usage:
 *   node publish-content.mjs fleet "Your message with 🚀 emojis"
 *   node publish-content.mjs paragraph "Title" "Body text with ✨"
 *   node publish-content.mjs typefully "Tweet content with 🎉"
 * 
 * Or pipe content:
 *   cat article.md | node publish-content.mjs paragraph "My Title"
 */

import https from 'https';
import http from 'http';
import fs from 'fs';

const [,, channel, ...args] = process.argv;

function getStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve(null);
    process.stdin.on('data', (chunk) => data += chunk.toString('utf8'));
    process.stdin.on('end', () => resolve(data.trim() || null));
  });
}

async function main() {
  const stdin = await getStdin();
  const ROOT = new URL('..', import.meta.url).pathname;
  
  // Load env
  const envPath = ROOT + '.env';
  let SERVICE_KEY = '';
  try {
    const env = fs.readFileSync(envPath, 'utf8');
    const match = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/);
    if (match) SERVICE_KEY = match[1].trim();
  } catch {}

  switch (channel) {
    // ── Fleet Chat ──────────────────────────────────────
    case 'fleet': {
      const message = args[0] || stdin;
      if (!message) return console.error('Usage: publish fleet "message 🚀"');
      
      const payload = JSON.stringify({ agent: 'vex', message, channel: 'all' });
      const opts = {
        hostname: 'localhost', port: 8080,
        path: '/api/fleet-chat/send', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
        },
      };
      
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          const d = JSON.parse(data);
          console.log(`✅ Fleet: ${d.message?.id?.slice(0,16) || 'sent'}`);
        });
      });
      req.write(payload, 'utf8');
      req.end();
      break;
    }

    // ── Paragraph ───────────────────────────────────────
    case 'paragraph': {
      const title = args[0] || 'Untitled';
      const body = args[1] || stdin || '(empty)';
      
      if (!SERVICE_KEY) return console.error('No SERVICE_KEY found');
      
      const payload = JSON.stringify({
        title,
        body,
        sendNewsletter: false,
        tags: ['mesh', 'gossipsub', 'xmr-dao'],
      });
      
      const opts = {
        hostname: 'vawouugtzwmejxqkeqqj.supabase.co',
        path: '/functions/v1/paragraph-publisher',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + SERVICE_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
        },
      };
      
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          const d = JSON.parse(data);
          if (d.data?.id) console.log(`✅ Paragraph: published (id: ${d.data.id})`);
          else console.log('✅ Paragraph:', d.message || 'published');
        });
      });
      req.write(payload, 'utf8');
      req.end();
      break;
    }

    // ── Typefully ───────────────────────────────────────
    case 'typefully': {
      const content = args[0] || stdin;
      if (!content) return console.error('Usage: publish typefully "tweet 🚀"');
      
      const payload = JSON.stringify({ content, share: false });
      const opts = {
        hostname: 'localhost', port: 8080,
        path: '/api/typefully/schedule', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
        },
      };
      
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          const d = JSON.parse(data);
          console.log(`✅ Typefully: draft #${d.draft_id || 'created'}`);
        });
      });
      req.write(payload, 'utf8');
      req.end();
      break;
    }

    default:
      console.error('Usage: publish <fleet|paragraph|typefully> "content 🚀"');
      console.error('  Or pipe: echo "content" | publish paragraph "Title"');
  }
}

main().catch(e => console.error('Error:', e.message));
