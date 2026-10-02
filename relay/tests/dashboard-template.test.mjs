#!/usr/bin/env node
// Guards the dashboard template against destructive edits.
//
// A regex patch aimed at one route once removed 2,162 lines of this template,
// including a design-system stylesheet, four graph toggles, and a log viewer's
// filter and search controls. node --check passed, because none of that is a
// syntax error, and the file still parsed. The live site looked fine, because
// the running process had already read the file - so the damage was invisible
// until the next restart.
//
// What makes this testable is that the recovered content is knowable: the
// template must be tag-balanced, must carry the tokens and controls it is
// documented to have, and must generate its tiles rather than hardcode them.
// Those are the assertions whose absence let a 129KB deletion pass review.
import { execFileSync } from 'node:child_process';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const src = execFileSync('node', ['-e', `
  const fs = require('fs');
  process.stdout.write(fs.readFileSync('server.js', 'utf8'));
`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

/** The dashboard template: the largest res.send(`...`) literal in the file. */
function dashboardTemplate() {
  let best = null;
  for (const m of src.matchAll(/res\.send\(`/g)) {
    const start = m.index + m[0].length;
    const end = src.indexOf('`)', start);
    if (end === -1) continue;
    const body = src.slice(start, end);
    if (!best || body.length > best.length) best = body;
  }
  return best || '';
}

const tpl = dashboardTemplate();

section('the dashboard template is intact enough to render');
{
  check('the template was found', tpl.length > 50000, tpl.length);
  check('it ends the document', /<\/html>\s*$/.test(tpl.trim()),
    tpl.trim().slice(-60));

  // Balance is the check that catches a regex deleting a span: the deleted lines
  // took a <div> opening with them, so nesting went negative and the page would
  // have closed the wrong elements.
  const opens = (tpl.match(/<div\b/g) || []).length;
  const closes = (tpl.match(/<\/div>/g) || []).length;
  check('div tags are balanced', opens === closes, { opens, closes, delta: opens - closes });

  const sOpen = (tpl.match(/<script\b/g) || []).length;
  const sClose = (tpl.match(/<\/script>/g) || []).length;
  check('script tags are balanced', sOpen === sClose, { sOpen, sClose });
}

section('the Lumen design layer is present, not just the base theme');
{
  // The restore put back HEAD's pre-Lumen stylesheet. These tokens are what was
  // lost, and they are the reason the dashboard looked subtly wrong rather than
  // obviously broken.
  const TOKENS = [
    '--lumen-bg', '--lumen-bg-surface', '--lumen-bg-elevated', '--lumen-bg-hover',
    '--lumen-text', '--lumen-text-muted', '--lumen-text-dim',
    '--lumen-accent', '--lumen-accent-glow', '--lumen-accent-bg',
    '--lumen-border', '--lumen-border-strong',
    '--lumen-success', '--lumen-warning', '--lumen-danger', '--lumen-info',
    '--lumen-live', '--lumen-warn', '--lumen-danger-fg',
    '--lumen-radius-sm', '--lumen-radius-md', '--lumen-radius-lg',
    '--lumen-radius-xl', '--lumen-radius-pill',
    '--lumen-shadow-sm', '--lumen-shadow-md', '--lumen-shadow-lg', '--lumen-shadow-glow',
    '--lumen-transition',
    '--lumen-font-sans', '--lumen-font-display', '--lumen-font-mono',
  ];
  const missing = TOKENS.filter((t) => !src.includes(t));
  check(`all ${TOKENS.length} Lumen tokens are defined`, missing.length === 0, missing);

  for (const rule of ['lumen-fade-in', 'lumen-shimmer', 'lumen-pulse',
    '.lumen-animate-fade', '.lumen-animate-pulse', '::-webkit-scrollbar', ':focus-visible']) {
    check(`${rule} is in the stylesheet`, src.includes(rule));
  }
  check('the base theme still defines --font-mono', src.includes('--font-mono:'));
  check('the dashboard stylesheet is the larger of the two',
    (() => {
      const blocks = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1].length);
      return blocks.length === 2 && blocks[1] > blocks[0] && blocks[1] > 20000;
    })(), [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1].length));
}

section('the graph effect toggles are all present');
{
  // Ten buttons, in the order the live page had them. Four were the ones the
  // restore reverted.
  const EXPECTED = ['orbit', 'explode', 'labels', 'stream', 'tunnel', 'fly',
    'memory', 'sharedctx', 'catalog', 'knowledge'];
  const found = [...tpl.matchAll(/<button[^>]*id="b-([a-z]+)"/g)].map((m) => m[1]);
  check('all ten toggles are present',
    EXPECTED.every((e) => found.includes(e)), { expected: EXPECTED, found });
  check('they are in the documented order',
    EXPECTED.every((e, i) => found.indexOf(e) === i), found);
  check('each one has its handler',
    EXPECTED.every((e) => tpl.includes(`toggleGraphEffect('${e}')`)),
    EXPECTED.filter((e) => !tpl.includes(`toggleGraphEffect('${e}')`)));
}

section('the log viewer has its filter, search and refresh');
{
  // No visible text - a <select> and an <input> - so a text-based comparison
  // could not see this going missing.
  for (const id of ['qds-activity-log', 'log-search', 'log-filter-type']) {
    check(`${id} is present`, tpl.includes(`id="${id}"`));
  }
  check('the refresh button is wired', tpl.includes('refreshLogViewer()'));
  check('the log card is commented as the centralised viewer',
    tpl.includes('centralized log viewer'));
}

section('the inbox tiles are generated, not written out');
{
  check('the template calls the generator', tpl.includes('${resendTileHtml()}'));
  check('no tile id is hardcoded in the template',
    !/id="(?:pfp|mm|hb|jobby)-inbox"/.test(tpl),
    (tpl.match(/id="(?:pfp|mm|hb|jobby)-inbox"/g) || []));
  check('the generator escapes the label it interpolates',
    src.includes(".replace(/&/g, '&amp;')"), 'a label is config, so it is escaped');
  check('the generator sanitises the element id',
    src.includes("replace(/[^a-zA-Z0-9_-]/g, '')"));
  check('a jobby tile is defined in the registry', src.includes("tile: 'jobby-inbox'"));
}

console.log(fails === 0
  ? '\n  the dashboard template is intact'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
