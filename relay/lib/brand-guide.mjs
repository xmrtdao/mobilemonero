/**
 * relay/lib/brand-guide.mjs — the guide an agent reads before it writes.
 *
 * WHY A GUIDE AND NOT A README
 * ----------------------------
 * An agent drafting an email for Party Favor Photo needs to know what the
 * brand is, what it looks like, what it says and what it must never say.
 * If that lives in a README, an agent will not find it, and if it lives in
 * an agent's head, it will not be the same next time.
 *
 * So it is generated from relay/lib/tenants.mjs - the same file the mailer
 * reads - and written to docs/brands/<domain>.md. It cannot drift from the
 * mailer, because it is the mailer's own description of itself.
 *
 * The guide is deliberately concrete. "Be professional" tells an agent
 * nothing. "Do not promise earnings, returns or yields of any kind" tells
 * it exactly what to refuse to write, which is the part that actually
 * matters.
 *
 * HOW AN AGENT GETS IT
 * --------------------
 *   - by reading docs/brands/<domain>.md;
 *   - by calling the brand_style_guide tool, which returns the same text;
 *   - or by importing brandGuide() directly.
 */

import { TENANTS, TENANT_KEYS, tenantByKey, paletteFor } from './tenants.mjs';

/**
 * The brand guide for one tenant, as markdown.
 *
 * @param {object} tenant
 * @returns {string}
 */
export function brandGuide(tenant) {
  if (!tenant) return 'No tenant was named.';
  const { inline, override, mode } = paletteFor(tenant);
  const w = tenant.weekly || {};

  const lines = [];

  lines.push(`# ${tenant.brand} - brand and email style guide`, '');
  lines.push(`**Domain:** \`${tenant.domain}\`  `);
  lines.push(`**From address:** \`${tenant.from}\`  `);
  lines.push(`**Also called:** ${(tenant.aliases || []).join(', ')}  `);
  lines.push(`**Weekly subject line:** ${w.subject || '-'}`, '');

  lines.push('## What this brand is', '');
  lines.push(w.focus || '-', '');
  if (w.lede) lines.push(`The weekly opens with: *"${w.lede}"*`, '');

  lines.push('## How it looks', '');
  lines.push('The colours below are the brand\'s own, read out of its site. They are', 'not chosen for an email - the email uses the brand.', '');
  lines.push(`This brand is **${mode}-first**: the ${mode} palette is inline on every element, and the`, mode === 'dark'
    ? 'light palette takes over in a client that prefers a light scheme.'
    : 'dark palette takes over in a client that prefers a dark scheme.', '');
  lines.push('| Role | Colour |', '|---|---|');
  for (const role of ['bg', 'bgDeep', 'panel', 'panelAlt', 'border', 'text', 'muted', 'faint', 'accent', 'violet', 'ok', 'warn', 'crit', 'codeBg']) {
    lines.push(`| ${role} | \`${inline[role]}\` |`);
  }
  lines.push('');
  lines.push(`The other scheme uses: background \`${override.bgDeep}\`, panel \`${override.panel}\`, text \`${override.text}\`, accent \`${override.accent}\`.`, '');

  lines.push('## The shape of an email', '');
  lines.push('Every email from this brand has the same shell, and every tenant\'s is', 'the same shell - so a reader who gets one brand\'s mail knows what to', 'expect from the others.', '');
  lines.push('- A dark gradient masthead with the brand name, the agent, and its role.', '- The subject as the heading.', '- The body, as markdown rendered to styled HTML.', '- A quote block when something the agent wrote is being quoted back.', '- A footer that says where every number came from, and what could not be fetched.', '');
  lines.push('Charts are inline SVG, drawn from live data. A `chart` block takes JSON:', '');
  lines.push('```chart');
  lines.push(JSON.stringify({
    type: 'area',
    title: 'Monero since Jan 10, 2025',
    data: [{ at: Date.UTC(2025, 0, 10), value: 199.62 }],
    startLabel: '$199.62',
    endLabel: '$624.05',
    startDate: 'Jan 10, 2025',
    endDate: 'Oct 21, 2026',
    reference: { value: 199.62, label: 'where we started' },
  }, null, 0));
  lines.push('```');
  lines.push('');
  lines.push('The chart types are `area`, `callout`, `donut`, `ring`, `bar` and `spark`.', 'A `stats` block takes rows:', '');
  lines.push('```stats');
  lines.push(JSON.stringify({ title: 'The market', data: [{ label: 'Market cap', value: '$11.75B' }] }, null, 0));
  lines.push('```');
  lines.push('');
  lines.push('Every email also carries a plain-text version of the same content. Half', 'the people reading an email are reading it in a client that shows nothing but', 'text, and the text version is the content, not a summary of it.', '');

  lines.push('## How it writes', '');
  const voice = tenant.voice || {};
  if (voice.summary) lines.push(`**${voice.summary}**`, '');
  if ((voice.do || []).length) {
    lines.push('Always:', '');
    for (const d of voice.do) lines.push(`- ${d}`);
    lines.push('');
  }
  if ((voice.doNot || []).length) {
    lines.push('Never:', '');
    for (const d of voice.doNot) lines.push(`- ${d}`);
    lines.push('');
  }

  lines.push('## The weekly', '');
  lines.push(`The ${tenant.brand} weekly carries these sections, in this order:`, '');
  for (const s of (w.sections || [])) lines.push(`- ${s}`);
  lines.push('');
  lines.push('Each section names its own source. A source that could not be reached', 'becomes a visible line in the email - never a silent omission, and never a', 'number that was not fetched.', '');
  if (tenant.repo) {
    lines.push(`"What shipped" reads the commits of \`${tenant.repo}\`.`, '');
  }

  lines.push('## The rules that do not change', '');
  lines.push('- The From address decides the brand. Naming another brand does not move it.', '- A figure that was not fetched is never printed.', '- A gap is recorded as a gap. Nothing is filled in from memory.', '- Every send carries both the rich HTML and the plain text.', '- The email states what could not be fetched, in the email itself.', '');

  return lines.join('\n');
}

/**
 * The guide for every tenant, keyed by domain.
 *
 * @returns {Object<string,string>}
 */
export function allBrandGuides() {
  const out = {};
  for (const key of TENANT_KEYS) {
    const t = TENANTS[key];
    out[t.domain] = brandGuide(t);
  }
  return out;
}

/**
 * The guide for a tenant, found by key or by domain.
 *
 * @param {string} keyOrDomain
 * @returns {string}
 */
export function guideFor(keyOrDomain) {
  const t = tenantByKey(keyOrDomain);
  return t ? brandGuide(t) : `No tenant is named "${keyOrDomain}". Known: ${TENANT_KEYS.join(', ')}.`;
}

export default { brandGuide, allBrandGuides, guideFor };
