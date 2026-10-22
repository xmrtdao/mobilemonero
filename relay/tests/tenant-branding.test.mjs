#!/usr/bin/env node
/**
 * tests/tenant-branding.test.mjs — the brand, and the weekly that carries it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Four brands now send email through one mailer. Three ways that goes
 * wrong, all of which look fine in a unit test of the thing that changed:
 *
 *   1. A MAIL TAKES THE WRONG BRAND. A caller names "MobileMonero" and
 *      the mail goes out from partyfavorphoto.com carrying MobileMonero's
 *      content. The masthead is the first thing a person reads.
 *
 *   2. A CHART RENDERS AS A CODE BLOCK. The renderer is handed a chart it
 *      does not recognise, the fence falls through to the code branch, and
 *      the reader gets a wall of JSON where a chart should be. This
 *      happened twice: once to the callout, once to a chart with no data
 *      array.
 *
 *   3. A FIGURE APPEARS THAT WAS NOT FETCHED. The worst one, because
 *      nothing about it looks wrong.
 *
 * These tests use synthetic data on purpose: a test that reaches the live
 * database proves the database was up that day, not that the code is
 * right.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
// A Windows path is not a URL. The dynamic import has to be given one.
const load = (rel) => import(pathToFileURL(join(RELAY_DIR, rel)).href);

const { renderEmail, renderChart, brandFor, markdownToText } = await load('lib/rich-email.mjs');
const { TENANTS, TENANT_KEYS, paletteFor, tenantForAddress } = await load('lib/tenants.mjs');
const { brandGuide, allBrandGuides } = await load('lib/brand-guide.mjs');
const { buildWeeklyBody } = await load('lib/weekly.mjs');

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = (t) => console.log('\n=== ' + t + ' ===');

// ── The registry ──────────────────────────────────────────────

section('every tenant is registered with its own brand');
{
  check('four tenants', TENANT_KEYS.length === 4, TENANT_KEYS.join(', '));
  for (const key of TENANT_KEYS) {
    const t = TENANTS[key];
    check(`${key} has a domain, a brand, a From and a palette`,
      !!(t.domain && t.brand && t.from && t.palette), JSON.stringify(Object.keys(t)));
    check(`${key} has a weekly with sections and a focus`,
      !!(t.weekly && t.weekly.sections?.length && t.weekly.focus));
    check(`${key} has a repository to read commits from`, !!t.repo, t.repo);
    check(`${key} has a voice, with something it must not do`,
      !!(t.voice?.summary && t.voice.doNot?.length));
  }
}

section('the palettes are the brands\' own, and they are different');
{
  const accents = TENANT_KEYS.map((k) => TENANTS[k].palette.dark.accent);
  check('no two tenants share an accent colour',
    new Set(accents).size === accents.length, accents.join(' '));
  for (const key of TENANT_KEYS) {
    const p = paletteFor(TENANTS[key]);
    check(`${key} has both a palette and an override`,
      !!(p.inline && p.override && p.inline.accent && p.override.accent));
    check(`${key}'s inline and override palettes differ`,
      p.inline.bg !== p.override.bg);
  }
}

section('Jobby is a light brand and the others are dark');
{
  check('jobby is light-first', TENANTS.jobby.palette.mode === 'light');
  for (const key of ['mobilemonero', '31harbor', 'pfp']) {
    check(`${key} is dark-first`, TENANTS[key].palette.mode === 'dark');
  }
}

// ── The brand comes from the domain ───────────────────────────

section('the From address decides the brand');
{
  for (const key of TENANT_KEYS) {
    const t = TENANTS[key];
    // A caller naming a DIFFERENT TENANT's brand. That is the mix: a mail
    // from Party Favor Photo claiming to be MobileMonero.
    const other = Object.values(TENANTS).find((x) => x.key !== key);
    const b = brandFor(t.from, other.brand);
    check(`${key}: the brand is ${t.brand}, whatever the caller said`,
      b.brand === t.brand, b.brand);
    check(`${key}: another tenant's brand is reported as a mismatch`,
      b.mismatch === true, `mismatch=${b.mismatch}`);

    // A name that belongs to nobody in particular is not a mix. It is
    // still not allowed to rename the brand.
    const odd = brandFor(t.from, 'Somebody Else');
    check(`${key}: an unfamiliar name is not a mix`, odd.mismatch === false);
    check(`${key}: and it still does not rename the brand`, odd.brand === t.brand, odd.brand);
  }
  const ok = brandFor('hello@31harbor.com', '31 Harbor');
  check('a brand that belongs to the domain is not a mismatch', ok.mismatch === false);
  const own = brandFor('hello@mobilemonero.com', 'XMRT-DAO');
  check('an alias of the same domain is not a mismatch', own.mismatch === false);
  const unknown = brandFor('someone@example.com', 'Somebody');
  check('an unknown domain keeps the caller\'s brand and reports no tenant',
    unknown.brand === 'Somebody' && unknown.tenant === null);
  check('an address resolves to its tenant', tenantForAddress('x@pfp.com') === null
    && tenantForAddress('x@partyfavorphoto.com')?.key === 'pfp');
}

// ── The mail is branded ───────────────────────────────────────

section('each tenant\'s mail carries that tenant\'s colours');
{
  for (const key of TENANT_KEYS) {
    const t = TENANTS[key];
    const html = renderEmail({
      subject: `${t.brand} Weekly`,
      body: '## A section\n\nSome prose.',
      agentName: 'Eliza',
      agentRole: t.role,
      fromAddress: t.from,
    }).html;
    const p = paletteFor(t);
    check(`${key}: the masthead carries the brand's accent`,
      html.includes(p.inline.accent), p.inline.accent);
    check(`${key}: the page background is the brand's background`,
      html.includes(`background:${p.inline.bgDeep}`), p.inline.bgDeep);
    check(`${key}: the masthead names the brand`,
      html.includes(`>${t.brand}<`) || html.includes(`${t.brand} <span`), t.brand);
    const query = p.mode === 'dark' ? 'light' : 'dark';
    check(`${key}: the other scheme is a prefers-color-scheme: ${query} override`,
      html.includes(`@media (prefers-color-scheme: ${query})`));
    check(`${key}: the colour-scheme meta follows the mode`,
      html.includes(`content="${p.mode === 'light' ? 'light dark' : 'dark light'}"`));
  }
}

section('a mail from a domain that is not ours still looks like the fleet');
{
  const html = renderEmail({
    subject: 'x', body: 'hi', agentName: 'Hermes', fromAddress: 'a@example.com',
  }).html;
  check('it renders', html.includes('<!doctype html>'));
  check('with the fleet palette', html.includes('#5ee0ff'), 'fleet accent');
}

// ── Charts render as charts ───────────────────────────────────

section('every chart type renders as a chart, not as code');
{
  // A chart is whatever the type says it is: the ring and the area are
  // SVG, the bar is a table of bars, the callout is a card. What matters
  // is that none of them fall through to the code branch.
  const specs = {
    callout: { type: 'callout', label: 'L', value: '$1', note: 'n' },
    area: { type: 'area', data: [{ at: 1, value: 2 }, { at: 2, value: 3 }] },
    donut: { type: 'donut', data: [{ label: 'a', value: 1 }] },
    bar: { type: 'bar', data: [{ label: 'a', value: 1 }] },
    ring: { type: 'ring', value: 50 },
    spark: { type: 'spark', data: [{ value: 1 }, { value: 2 }] },
  };
  for (const [name, spec] of Object.entries(specs)) {
    const html = renderChart(spec);
    check(`${name} renders`, !!html && html.includes('class="card"'), String(html).slice(0, 60));
    check(`${name} is not a code block`, !String(html).includes('class="code"'));
  }
  // The ones that are drawn rather than listed have to be drawn.
  for (const name of ['area', 'donut', 'ring', 'spark']) {
    check(`${name} is drawn as SVG`, renderChart(specs[name]).includes('<svg'));
  }
  check('bar is drawn as a table of bars',
    renderChart(specs.bar).includes('class="bar-fill"'));
}

section('the area chart does not put a dollar sign on a count');
{
  const plain = renderChart({ type: 'area', data: [{ at: 1, value: 149 }, { at: 2, value: 76 }] });
  check('a count has no currency symbol', !plain.includes('$149'), '$149');
  const money = renderChart({
    type: 'area', valueFormat: 'usd', data: [{ at: 1, value: 149 }, { at: 2, value: 76 }],
  });
  check('a price does', money.includes('$149'), 'missing $149');
}

section('the bar chart cannot collapse to nothing');
{
  const html = renderChart({ type: 'bar', data: [{ label: 'a', value: 100 }] });
  check('the table is fixed-layout', html.includes('table-layout:fixed'), 'no table-layout');
  check('the bar column has a width', html.includes('width:44%'), 'no width');
  check('the fill has a width', html.includes('width:100%'), 'no fill width');
}

section('the sparkline uses the range of the data');
{
  // A series that never goes near zero must not be drawn against zero.
  const html = renderChart({ type: 'spark', data: [{ value: 600 }, { value: 620 }, { value: 610 }] });
  check('the sparkline renders', !!html && html.includes('<svg'));
  const polyline = (html.match(/points="([^"]+)"/) || [])[1] || '';
  const ys = polyline.split(' ').map((p) => Number(p.split(',')[1])).filter((n) => Number.isFinite(n));
  const spread = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  check('the line uses the vertical space it has', spread > 20, `spread ${spread}`);
}

// ── The text version ──────────────────────────────────────────

section('the plain-text version carries the content, not the JSON');
{
  const body = [
    '## A section',
    '',
    '```chart',
    JSON.stringify({ type: 'callout', label: 'The price', value: '$199.62', note: 'a note' }),
    '```',
    '',
    '```chart',
    JSON.stringify({ type: 'area', data: [{ at: 1, value: 5 }, { at: 2, value: 9 }] }),
    '```',
    '',
    '```stats',
    JSON.stringify({ title: 'The market', data: [{ label: 'Cap', value: '$1B' }] }),
    '```',
  ].join('\n');
  const text = markdownToText(body);
  check('no raw JSON in the text', !/\{\s*"type"\s*:/.test(text), text.slice(0, 120));
  check('the callout survives', text.includes('THE PRICE') && text.includes('$199.62'));
  check('the stats survive', text.includes('Cap') && text.includes('$1B'));
}

// ── The brand guide ───────────────────────────────────────────

section('every tenant has a guide, and it describes that tenant');
{
  const guides = allBrandGuides();
  for (const key of TENANT_KEYS) {
    const t = TENANTS[key];
    check(`${key} has a guide`, !!guides[t.domain], 'missing');
    const g = guides[t.domain] || '';
    check(`${key}'s guide names the brand`, g.includes(t.brand));
    check(`${key}'s guide names the domain`, g.includes(t.domain));
    check(`${key}'s guide carries the brand's accent`,
      g.includes(t.palette.dark.accent) || g.includes(t.palette.light.accent));
    check(`${key}'s guide says what the brand must not do`, g.includes('Never:'));
    check(`${key}'s guide names the repository`, g.includes(t.repo));
  }
  check('guideFor finds a tenant by key', brandGuide(TENANTS.pfp).includes('Party Favor Photo'));
}

// ── The weekly ────────────────────────────────────────────────

section('a weekly whose source failed says so, and does not print a number');
{
  const tenant = TENANTS.mobilemonero;
  const { body } = buildWeeklyBody({
    tenant,
    sections: {
      price: { ok: false, value: null, note: 'CoinGecko answered 429' },
      history: { ok: false, value: null, note: 'Kraken unreachable' },
      pool: { ok: true, value: { hashrate: 0, miners: 0, activeWorkers: 0, amtPaidXmr: 0, amtDueXmr: 0, validShares: 0, minutesSinceLastHash: null, poolHashrate: 1850, poolMiners: 5280, poolTotalBlocks: 564000, poolLastBlockTimestamp: null }, note: 'SupportXMR' },
      articles: { ok: true, value: [], note: 'Paragraph' },
      commits: { ok: true, value: [], note: 'GitHub' },
      work: { ok: true, value: { rows: [], byStatus: {}, count: 0, blocked: 0, windowDays: 30 }, note: 'the board' },
    },
    missing: ['price: CoinGecko answered 429'],
    gatheredAt: new Date().toISOString(),
  });
  check('the failure is in the body', body.includes('CoinGecko answered 429'), 'no note');
  check('and the missing history too', body.includes('Kraken unreachable'));
  check('the pinned number admits it has none',
    body.includes('unavailable'), 'the pinned number claimed a value');
  check('no price was invented', !body.includes('$199.62'));
}

section('a weekly with data prints the data it fetched');
{
  const tenant = TENANTS.mobilemonero;
  const start = Date.UTC(2025, 0, 10);
  const { body, pinned } = buildWeeklyBody({
    tenant,
    sections: {
      price: { ok: true, value: { usd: 624.09, change24h: 0.65, marketCapUsd: 11.75e9, volume24hUsd: 272e6, btc: 0.00737 }, note: 'CoinGecko' },
      history: {
        ok: true,
        value: {
          sources: ['Kraken'],
          startDate: '2025-01-10',
          start: { at: start, value: 199.62 },
          last: { at: Date.UTC(2026, 9, 21), value: 624.05 },
          low: { at: Date.UTC(2025, 3, 8), value: 194.6 },
          high: { at: Date.UTC(2026, 0, 14), value: 711.53 },
          points: [
            { at: start, value: 199.62 },
            { at: Date.UTC(2025, 3, 8), value: 194.6 },
            { at: Date.UTC(2026, 0, 14), value: 711.53 },
            { at: Date.UTC(2026, 9, 21), value: 624.05 },
          ],
        },
        note: 'Kraken daily closes',
      },
      pool: { ok: false, value: null, note: 'SupportXMR unreachable' },
      articles: { ok: true, value: [], note: 'Paragraph' },
      commits: { ok: true, value: [], note: 'GitHub' },
      work: { ok: true, value: { rows: [], byStatus: {}, count: 0, blocked: 0, windowDays: 30 }, note: 'the board' },
    },
    missing: [],
    gatheredAt: new Date().toISOString(),
  });
  check('the pinned number is the fetched start price', pinned.value === '$199.62', pinned.value);
  check('the pinned number names the date it is from', pinned.note.includes('January 10, 2025'), pinned.note);
  check('the chart runs from the start date', body.includes('Monero since Jan 10'), 'no chart title');
  check('the body says what the price is now', body.includes('$624.09'));
  check('the pool failure is disclosed', body.includes('SupportXMR unreachable'));
  check('the extremes are stated', body.includes('The low was $194.60'), 'no low');
  check('the source of the closes is stated', body.includes('Kraken'), 'no source');
}

section('each tenant\'s weekly carries its own pinned number');
{
  const cases = [
    ['pfp', 'Bookings on the calendar', {
      bookings: { ok: true, value: { bookings: [{ client: 'A', eventDate: '2099-01-01', status: 'confirmed' }], divergentRows: 0 }, note: 'the ledger' },
      leads: { ok: true, value: { newThisWeek: 2 }, note: 'the ledger' },
      work: { ok: true, value: { rows: [], byStatus: {}, count: 0 }, note: 'the board' },
    }],
    ['jobby', 'Mailboxes claimed', {
      candidates: { ok: true, value: { total: 10, claimed: 3, newThisMonth: 1 }, note: 'the ledger' },
      applications: { ok: true, value: { applications: [], byStatus: [], total: 0 }, note: 'the ledger' },
      work: { ok: true, value: { rows: [], byStatus: {}, count: 0 }, note: 'the board' },
    }],
    ['31harbor', 'Trust events in the last 30 days', {
      trust: { ok: true, value: { total: 42, windowDays: 30, perDay: [], byType: [{ label: 'OVERCONFIDENT', value: 4 }] }, note: 'the ledger' },
      agents: { ok: false, value: null, note: 'no roster' },
      contracts: { ok: false, value: null, note: 'no contracts' },
      commits: { ok: true, value: [], note: 'GitHub' },
      work: { ok: true, value: { rows: [], byStatus: {}, count: 0 }, note: 'the board' },
    }],
  ];
  for (const [key, label, sections] of cases) {
    const tenant = TENANTS[key];
    const { body } = buildWeeklyBody({
      tenant, sections, missing: [], gatheredAt: new Date().toISOString(),
    });
    check(`${key} pins "${label}"`, body.includes(label), 'label not found');
  }

  // And a tenant whose source could not be reached says so instead.
  const failed = buildWeeklyBody({
    tenant: TENANTS['31harbor'],
    sections: {
      trust: { ok: false, value: null, note: 'the trust ledger could not be read' },
      agents: { ok: false, value: null, note: 'no roster' },
      contracts: { ok: false, value: null, note: 'no contracts' },
      commits: { ok: true, value: [], note: 'GitHub' },
      work: { ok: true, value: { rows: [], byStatus: {}, count: 0 }, note: 'the board' },
    },
    missing: ['trust: the trust ledger could not be read'],
    gatheredAt: new Date().toISOString(),
  });
  check('a failed source pins "unavailable", not a number',
    failed.body.includes('unavailable') && !failed.body.includes('42'));
}

console.log('');
if (fails) {
  console.log(`${fails} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
process.exit(0);
