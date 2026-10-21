/**
 * relay/lib/opencode-runner.mjs — run one prompt on the OpenCode harness.
 *
 * The harness is the agents' HANDS: it reads the repository, changes files,
 * runs commands and commits. Everything else in the relay asks somebody else
 * to do the work.
 *
 * One rule, enforced by relay/lib/opencode-lock.mjs: ONE agent at a time on
 * this machine. The harness is a node process with a tool-calling loop, and
 * this box has 8GB with most of it already in use.
 */
import http from 'http';

const HOST = '127.0.0.1';

function request(base, method, path, body, timeoutMs = 120000) {
  const url = new URL(path, base);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        try { resolve(text ? JSON.parse(text) : null); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('the harness did not answer in time')); });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Ask the harness to do something, and wait for the answer.
 *
 * @returns {Promise<{text:string, tools:string[], sessionId:string, seconds:number}>}
 */
export async function runOpencodePrompt(prompt, {
  base = 'http://127.0.0.1:4130',
  model = '',
  timeoutMs = 5 * 60 * 1000,
  title = '',
} = {}) {
  const b = base.replace(/\/$/, '');

  const created = await request(b, 'POST', '/api/session', {
    title: (title || String(prompt)).slice(0, 80),
  });
  const sessionId = created?.data?.id;
  if (!sessionId) {
    throw new Error(`could not create a session on ${b} (the OpenCode server may be down)`);
  }

  const sent = await request(b, 'POST', `/api/session/${sessionId}/prompt`, {
    text: prompt,
    ...(model ? { model: { providerID: 'opencode', modelID: model } } : {}),
    agent: 'build',
  });
  if (!sent) throw new Error('the OpenCode server did not accept the prompt');

  // The server answers in the background, so the reply is polled for. A
  // message that has not finished streaming has only the model's reasoning in
  // it, and reading it early is how a finished piece of work was once
  // recorded as "the worker replied with nothing".
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await request(b, 'GET', `/api/session/${sessionId}/message`);
    const arr = Array.isArray(msgs?.data) ? msgs.data : [];
    const assistant = arr.filter((m) => m.type === 'assistant').pop();
    if (assistant) {
      if (assistant.finish === 'error' || assistant.error) {
        throw new Error(`the worker failed: ${JSON.stringify(assistant.error).slice(0, 300)}`);
      }
      if (assistant.time?.completed === undefined && assistant.finish === undefined) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const parts = Array.isArray(assistant.content) ? assistant.content : [];
      const text = parts.filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
      const tools = [...new Set(parts
        .filter((c) => c.type === 'tool' || c.tool || c.name)
        .map((c) => c.name || c.tool || (c.state && c.state.title) || 'tool'))];
      if (!text && !tools.length) throw new Error('the worker replied with nothing');
      return {
        text,
        tools,
        sessionId,
        seconds: Math.round((Date.now() - started) / 1000),
      };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`the worker did not answer within ${Math.round(timeoutMs / 1000)}s`);
}

export default { runOpencodePrompt };
