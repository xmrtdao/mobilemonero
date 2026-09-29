#!/usr/bin/env node
// renderMarkdown: the escaping property, and the markdown that has to keep working.
//
// The security assertions come first and are the reason this file exists.
// renderMarkdown's output goes into innerHTML on a page that is authenticated with
// a shared API key, so a post body that can inject markup is stored XSS against
// every operator who opens the board.
//
// The test loads the actual file that is served, not an import of a copy, because
// the served file is what runs in the browser and a test of a reimplementation
// proves nothing about it.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(RELAY_DIR, 'public', 'markdown.js');

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

if (!existsSync(FILE)) {
  console.log('  FAIL  public/markdown.js does not exist - renderMarkdown is undefined at runtime');
  process.exit(1);
}

const source = readFileSync(FILE, 'utf8');

// Evaluate the real file in a fresh context, exactly as a browser would, and take
// the global it sets. This also proves it defines the global the dashboard calls
// by bare name rather than a module export.
const sandbox = { window: {}, module: undefined };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'markdown.js' });
const renderMarkdown = sandbox.window.renderMarkdown;

section('it defines the global the dashboard actually calls');
{
  check('the file parses and runs', typeof renderMarkdown === 'function',
    typeof renderMarkdown);
  check('it sets window.renderMarkdown, not just a module export',
    sandbox.window && typeof sandbox.window.renderMarkdown === 'function');
  check('it handles null and undefined without throwing',
    renderMarkdown(null) === '' && renderMarkdown(undefined) === '');
  check('and empty input', renderMarkdown('') === '');
}

section('markup in a post body cannot survive');
{
  // The whole property. A script tag, an img onerror, and an iframe are the three
  // shapes that actually get used; all three must come out inert.
  const attacks = [
    ['a script tag', '<script>alert(1)</script>'],
    ['an img onerror', '<img src=x onerror=alert(1)>'],
    ['an iframe', '<iframe src="javascript:alert(1)"></iframe>'],
    ['a closing div to escape the panel', '</div><script>alert(1)</script><div>'],
    ['an svg onload', '<svg/onload=alert(1)>'],
    ['a body onload', '<body onload=alert(1)>'],
    ['an attribute break', '" onmouseover="alert(1)'],
    ['a javascript: link', '<a href="javascript:alert(1)">click</a>'],
    ['an uppercase script tag', '<SCRIPT>alert(1)</SCRIPT>'],
    ['a nested one', '<<script>script>alert(1)<</script>/script>'],
  ];
  // Everything here is checked against the raw output, with nothing decoded.
  //
  // That is the whole point: the output string is exactly what the browser's HTML
  // parser sees, and the parser does NOT turn `&lt;script&gt;` back into a tag. An
  // earlier version of this test decoded the entities first, on the theory that it
  // should judge the output "as if it had been interpreted" - which manufactured a
  // <script> that the browser would never construct and then failed on it. The
  // escaped string is the safe one, and it has to be judged as it stands.
  //
  // So: every "<" in the output begins a tag the parser will act on. Anything that
  // is not on the allowlist is an injection, and the event-handler check looks
  // only inside real tag strings, because "onerror=" inside escaped prose is
  // just words.
  const ALLOWED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'code',
    'pre', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'a', 'strong', 'em', 'br', 'del']);

  // Pull out the actual tag strings - "<...>" - which is what the parser will read.
  const realTags = html => [...html.matchAll(/<[^>]*>/g)].map(m => m[0]);

  for (const [label, payload] of attacks) {
    const out = renderMarkdown(payload);
    const tags = realTags(out);
    const names = tags.map(t => (t.match(/^<\/?([a-z][a-z0-9]*)/i) || [, '?'])[1].toLowerCase());
    const rogue = names.filter(n => !ALLOWED.has(n));
    check(`${label} produces no tag outside the allowlist`, rogue.length === 0,
      rogue.join(', ') || out);
    check(`${label} leaves no event handler on a real tag`,
      !tags.some(t => /\son[a-z]+\s*=/i.test(t)), tags.join(' '));
    check(`${label} has no javascript: URL in a real href`,
      !tags.some(t => /href\s*=\s*["']?\s*javascript:/i.test(t)), tags.join(' '));
    check(`${label} is escaped, not dropped`, out.includes('&lt;') || out.includes('&quot;'), out);
  }
}

section('a javascript: URL cannot become a link');
{
  const out = renderMarkdown('[click me](javascript:alert(1))');
  check('no href was produced', !/<a\b/i.test(out), out);
  check('the text is still shown', out.includes('click me'), out);

  const bare = renderMarkdown('see javascript:alert(1) here');
  check('a bare javascript: URL is not autolinked', !/javascript:/i.test(bare) || !/<a\b/i.test(bare), bare);
}

section('a real link still works, and cannot break out of the attribute');
{
  const out = renderMarkdown('[docs](https://example.com/a)');
  check('it becomes a link', /<a href="https:\/\/example\.com\/a"/.test(out), out);
  check('with noopener on the new tab', /rel="noopener noreferrer"/.test(out), out);
  check('and the label is preserved', />docs</.test(out), out);

  // A quote inside the URL is already &quot; after escaping, so it cannot break
  // the attribute - but a percent-encoded one has to be neutralised too.
  const quoted = renderMarkdown('[x](https://example.com/%22onmouseover=alert(1))');
  check('an encoded quote in the URL does not break the attribute',
    !/\son[a-z]+\s*=/i.test(quoted), quoted);
  check('and is percent-encoded in the href', /%22/.test(quoted), quoted);
}

section('the code stash cannot be forged from post content');
{
  // A readable placeholder could be typed into a post and would splice real code
  // into the middle of it. NUL-delimited indices cannot be typed.
  const forged = 'text 0 text';
  const out = renderMarkdown(forged);
  check('a bare index is not substituted', !out.includes('<code>') && !out.includes('<pre>'), out);

  // And the real thing still restores.
  const real = renderMarkdown('use `npm test` here');
  check('a code span does become a code element', real.includes('<code>npm test</code>'), real);
  check('and its content is not treated as markdown',
    !real.includes('<em>'), real);
}

section('the markdown the board actually uses');
{
  check('bold', renderMarkdown('**hi**').includes('<strong>hi</strong>'));
  check('italic', renderMarkdown('*hi*').includes('<em>hi</em>'));
  check('bold italic', renderMarkdown('***hi***').includes('<strong><em>hi</em></strong>'));
  check('strikethrough', renderMarkdown('~~hi~~').includes('<del>hi</del>'));
  check('inline code', renderMarkdown('`x`').includes('<code>x</code>'));
  check('a fenced block', renderMarkdown('```\nline\n```').includes('<pre><code>line</code></pre>'));  check('a heading', /<h2>Title<\/h2>/.test(renderMarkdown('## Title')));
  check('an unordered list', /<ul><li>one<\/li><li>two<\/li><\/ul>/.test(renderMarkdown('- one\n- two')));
  check('an ordered list', /<ol><li>one<\/li><li>two<\/li><\/ol>/.test(renderMarkdown('1. one\n2. two')));
  check('a blockquote', renderMarkdown('> quoted').includes('<blockquote>quoted</blockquote>'));
  check('a horizontal rule with dashes', /<hr>/.test(renderMarkdown('---')),
    JSON.stringify(renderMarkdown('---')));
  check('a horizontal rule with asterisks', /<hr>/.test(renderMarkdown('***')),
    JSON.stringify(renderMarkdown('***')));
  check('a horizontal rule with underscores', /<hr>/.test(renderMarkdown('___')),
    JSON.stringify(renderMarkdown('___')));
  check('a four-item list stays one list',
    (renderMarkdown('- a\n- b\n- c\n- d').match(/<ul>/g) || []).length === 1,
    JSON.stringify(renderMarkdown('- a\n- b\n- c\n- d')));
  check('a deep heading is clamped to a styled level',
    !renderMarkdown('##### five').includes('<h5>'), renderMarkdown('##### five'));
  check('a table',
    (() => {
      const out = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
      return out.includes('<table>') && out.includes('<th>a</th>') && out.includes('<td>1</td>');
    })());
  check('a bare URL is autolinked', renderMarkdown('see https://example.com').includes('<a href="https://example.com"'));
}

section('a single newline is a line break, because agents write in a chat box');
{
  const out = renderMarkdown('line one\nline two');
  check('it becomes a <br> inside a paragraph', out.includes('line one<br>line two'), out);
  check('inside a <p>', out.startsWith('<p>'), out);
}

section('a markdown marker inside code stays literal');
{
  const out = renderMarkdown('```\n# not a heading\n**not bold**\n```');
  check('the heading is not rendered', !out.includes('<h1>'), out);
  check('the bold is not rendered', !out.includes('<strong>'), out);
  check('both appear as text', out.includes('# not a heading') && out.includes('**not bold**'), out);
}

section('the output is well-formed, with no illegal nesting');
{
  // The bug this catches: a paragraph pass that wrapped runs of text, including
  // runs that already contained a list or a heading inserted by an earlier pass.
  // That produced <p><ul>...</ul></p> and a stray empty <p></p>. The browser
  // repairs it silently by closing the <p> early, so the visible symptom is "the
  // markdown didn't work" rather than anything that looks like a defect.
  const doc = [
    '## Heading',
    '',
    'A paragraph.',
    '',
    '- one',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '> quoted',
    '',
    '---',
    '',
    'Closing paragraph with **bold** and `code`.',
  ].join('\n');
  const out = renderMarkdown(doc);

  check('no paragraph wraps a list', !/<p>[^<]*(<ul|<ol)/.test(out), out);
  check('no paragraph wraps a table', !/<p>[^<]*<table/.test(out), out);
  check('no paragraph wraps a heading', !/<p>[^<]*<h[1-4]/.test(out), out);
  check('no paragraph wraps a blockquote', !/<p>[^<]*<blockquote/.test(out), out);
  check('no empty paragraph is emitted', !/<p>\s*<\/p>/.test(out), out);
  // Balance check: every element the renderer emits is closed, and in order.
  const stack = [];
  let balanced = true;
  const order = [];
  for (const m of out.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClose] = m;
    if (['br', 'hr', 'img', 'input'].includes(name) || selfClose) continue;
    if (closing) {
      if (stack.pop() !== name) { balanced = false; order.push('/' + name); }
    } else { stack.push(name); order.push(name); }
  }
  check('every element is closed in order', balanced && stack.length === 0,
    `unclosed: ${stack.join(',')}; order: ${order.join(' ')}`);

  // Only inline elements are allowed inside a paragraph. Anything else is the
  // nesting bug in its general form.
  const badNesting = [...out.matchAll(/<p>([\s\S]*?)<\/p>/g)]
    .map(m => m[1])
    .filter(inner => /<(ul|ol|table|blockquote|h[1-4]|pre)\b/.test(inner));
  check('a paragraph contains only inline elements', badNesting.length === 0,
    badNesting.join(' | '));
}

section('the stylesheet features it emits are the ones that are styled');
{
  // The .board-post-body rules style exactly this set. Emitting a tag with no rule
  // is a silent visual regression, so the two lists are compared rather than
  // assumed to match.
  const server = readFileSync(join(RELAY_DIR, 'server.js'), 'utf8');
  const css = (server.match(/\.board-post-body[^{]*\{[^}]*\}/g) || []).join('\n');
  const styled = new Set();
  for (const m of css.matchAll(/(\w[\w-]*)\s*[,{]/g)) styled.add(m[1]);
  // h5 and h6 are deliberately absent: the stylesheet stops at h4, and the
  // renderer clamps to match, so including them here would assert a tag the file
  // is not supposed to be able to produce.
  const emitted = ['p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'code',
    'pre', 'blockquote', 'hr', 'table', 'th', 'td', 'a', 'strong', 'em', 'br', 'del'];
  const unstyled = emitted.filter(t => !styled.has(t));
  check('every tag the renderer emits has a rule', unstyled.length === 0, unstyled.join(', '));
}

section('it does not choke on real-world post bodies');
{
  const bodies = [
    '',
    '   ',
    '\n\n\n',
    'a',
    '**unclosed bold',
    '`unclosed code',
    '```\nunclosed fence',
    '| broken | table\n| ---',
    '#'.repeat(9) + ' deep',
    'x'.repeat(20000),
    '- '.repeat(2000),
    '[link](',
    '> '.repeat(500),
    'https://' + 'a'.repeat(2000),
    '😀 emoji and 中文 and ünïcödé',
    '<>&"\'',
  ];
  for (const body of bodies) {
    let out = null;
    let threw = null;
    try { out = renderMarkdown(body); } catch (e) { threw = e; }
    check(`no throw on ${JSON.stringify(body.slice(0, 24))}${body.length > 24 ? '…' : ''}`,
      threw === null, threw && threw.message);
    if (out !== null) {
      check(`  and no live tag leaks from it`, !/<\s*script\b/i.test(out));
    }
  }
}

console.log(fails === 0
  ? '\n  renderMarkdown is safe and the markdown still works'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
