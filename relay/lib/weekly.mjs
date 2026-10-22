/**
 * relay/lib/weekly.mjs — the weekly, for every tenant.
 *
 * ONE SHAPE, FOUR BRANDS
 * -----------------------
 * Every tenant's weekly has the same skeleton:
 *
 *   1. THE NUMBER      the one figure this issue is about, pinned to the top
 *   2. THE SECTIONS    what is happening, in the tenant's own order
 *   3. THE FOOTER      where every number came from, and what was missing
 *
 * The skeleton is shared so a reader who gets the MobileMonero weekly and
 * the 31 Harbor weekly finds the same mail in both - the same masthead, the
 * same card shapes, the same charts, the same footer. The CONTENT is the
 * tenant's own: different sections, different sources, different pinned
 * number, and the brand's own colours because the From domain decides them.
 *
 * WHAT A WEEKLY MAY NOT DO
 * -------------------------
 * It may not print a number it did not fetch, and it may not print a
 * section it could not fetch as though the section were empty. A source
 * that failed becomes a visible line saying so. A weekly that quietly drops
 * its price section reads as a week when the price did not move.
 *
 * It may not invent a date either. The project's start date is a fact
 * about the white paper, and the price on it is whatever the market
 * printed - both fetched, never remembered.
 *
 * WHY MARKDOWN
 * ------------
 * The body is markdown with chart and stats blocks, rendered by
 * relay/lib/rich-email.mjs. The body is CONTENT, not markup: it can be
 * quoted, read in a plain-text client, and re-rendered later without being
 * rewritten. Every send carries both the rich HTML and a plain-text
 * rendering of the same content.
 */

import { renderEmail } from './rich-email.mjs';
import { gatherWeeklyData } from './weekly-data.mjs';
import { TENANTS, tenantByKey, paletteFor } from './tenants.mjs';

const FENCE = '```';

// ── Formatting helpers ──────────────────────────────────────

function usd(n, dp = 2) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

function num(n) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  return Number(n).toLocaleString('en-US');
}

// A bare "YYYY-MM-DD" is parsed as UTC midnight by Date, which in any
// timezone west of Greenwich renders as the day before.
//
// The same trap applies to a TIMESTAMP: a daily close is stamped at exactly
// UTC midnight, so rendering it locally in a western timezone prints
// yesterday's date. A chart that starts one day before the project did is
// a lie with a date on it.
//
// So: anything sitting exactly on UTC midnight is a day bucket and is
// rendered in UTC. Everything else is a real moment and is rendered
// locally.
function isUtcMidnight(d) {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

function fmtDate(iso, opts) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const useUtc = isUtcMidnight(d);
  return d.toLocaleDateString('en-US', useUtc ? { ...opts, timeZone: 'UTC' } : opts);
}

function shortDate(iso) {
  return fmtDate(iso, { month: 'short', day: 'numeric' });
}

function longDate(iso) {
  return fmtDate(iso, { month: 'long', day: 'numeric', year: 'numeric' });
}

function pctChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !from) return null;
  return ((to - from) / from) * 100;
}

function hashrate(h) {
  if (!h) return '0 H/s';
  if (h >= 1e6) return `${(h / 1e6).toFixed(2)} MH/s`;
  if (h >= 1e3) return `${(h / 1e3).toFixed(1)} kH/s`;
  return `${Math.round(h)} H/s`;
}

/** A sentence, trimmed at a sentence and not at a character. */
function trimSummary(text, max = 320) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop > 80) return `${cut.slice(0, stop + 1).trim()}...`;
  const wordEnd = cut.lastIndexOf(' ');
  return `${cut.slice(0, wordEnd > 80 ? wordEnd : max).trim()}...`;
}

function statsBlock(title, data) {
  if (!data || !data.length) return [];
  return [FENCE + 'stats', JSON.stringify({ title, data }), FENCE, ''];
}

function chartBlock(spec) {
  return [FENCE + 'chart', JSON.stringify(spec), FENCE, ''];
}

// ── The pinned number ───────────────────────────────────────
//
// One figure per tenant, and it is the figure the issue is about. It is
// pinned to the top because a weekly that opens with seven sections and
// no headline is a report, and a report does not get read on a Sunday.

function pinnedNumber(tenant, data) {
  const s = data.sections || {};

  if (tenant.key === 'mobilemonero') {
    const h = s.history;
    if (h && h.ok && h.value.start) {
      const start = h.value.start;
      const now = s.price && s.price.ok ? s.price.value.usd : h.value.last?.value;
      const moved = pctChange(start.value, now);
      return {
        label: 'The price when we started',
        value: usd(start.value),
        note: `${longDate(start.at)} - the day the XMRT DAO white paper was published.`
          + (moved != null
            ? ` Monero is ${usd(now)} today, ${moved >= 0 ? 'up' : 'down'} ${Math.abs(moved).toFixed(0)}% since.`
            : ''),
      };
    }
    return {
      label: 'The price when we started',
      value: 'unavailable',
      note: h && h.note ? `The price history could not be fetched for this issue: ${h.note}` : 'The price history could not be fetched for this issue.',
    };
  }

  if (tenant.key === '31harbor') {
    const t = s.trust;
    if (t && t.ok) {
      const flagged = (t.value.byType || []).filter((x) => /FABRICAT|UNCITED|UNVERIFIABLE|OVERCONFIDENT/i.test(x.label || ''));
      const flaggedTotal = flagged.reduce((a, x) => a + x.value, 0);
      return {
        label: `Trust events in the last ${t.value.windowDays} days`,
        value: num(t.value.total),
        note: `Recorded against the ledger. ${num(flaggedTotal)} of them flagged a claim as overconfident, uncited, unverifiable or fabricated.`,
      };
    }
    return {
      label: 'Trust events',
      value: 'unavailable',
      note: t && t.note ? `The trust ledger could not be fetched for this issue: ${t.note}` : 'The trust ledger could not be fetched for this issue.',
    };
  }

  if (tenant.key === 'pfp') {
    const b = s.bookings;
    const l = s.leads;
    if (b && b.ok) {
      const ledger = b.value.bookings || [];
      const upcoming = ledger.filter((x) => x.eventDate && x.eventDate >= new Date().toISOString().slice(0, 10));
      const confirmed = ledger.filter((x) => String(x.status || '').toLowerCase() === 'confirmed');
      return {
        label: 'Bookings on the calendar',
        value: num(upcoming.length),
        note: `${num(upcoming.length)} shoot${upcoming.length === 1 ? '' : 's'} still to come.`
          + ` ${num(confirmed.length)} of ${num(ledger.length)} on the ledger ${confirmed.length === 1 ? 'is' : 'are'} confirmed.`
          + (l && l.ok ? ` ${num(l.value.newThisWeek)} new lead${l.value.newThisWeek === 1 ? '' : 's'} this week.` : ''),
      };
    }
    return {
      label: 'Bookings on the calendar',
      value: 'unavailable',
      note: b && b.note ? `The booking ledger could not be fetched for this issue: ${b.note}` : 'The booking ledger could not be fetched for this issue.',
    };
  }

  if (tenant.key === 'jobby') {
    const c = s.candidates;
    if (c && c.ok) {
      const pct = c.value.total ? Math.round((c.value.claimed / c.value.total) * 100) : 0;
      return {
        label: 'Mailboxes claimed',
        value: `${num(c.value.claimed)} of ${num(c.value.total)}`,
        note: `A candidate can only be written to once their own mailbox is claimed. ${pct}% of the mailboxes on the ledger are live.`,
      };
    }
    return {
      label: 'Mailboxes claimed',
      value: 'unavailable',
      note: c && c.note ? `The candidate ledger could not be fetched for this issue: ${c.note}` : 'The candidate ledger could not be fetched for this issue.',
    };
  }

  return { label: 'This week', value: 'unavailable', note: 'This tenant has no pinned number yet.' };
}

// ── The sections ────────────────────────────────────────────
//
// Each renderer returns markdown lines. Each one checks its own source and
// says so when the source did not answer.

function sectionPrice(s) {
  const lines = ['## The price', ''];
  const price = s.price;
  const history = s.history;

  if (!price || !price.ok) {
    lines.push(`_The price could not be fetched for this issue: ${price ? price.note : 'no price source was run'}_`, '');
    return lines;
  }
  const v = price.value;
  const up = (v.change24h ?? 0) >= 0;
  const change = v.change24h == null ? '' : `${up ? '+' : ''}${v.change24h.toFixed(2)}%`;
  lines.push(`**${usd(v.usd)}** per XMR${change ? ` - ${change} on the day` : ''}`, '');

  if (history && history.ok && history.value.points.length > 1) {
    const hv = history.value;
    const points = hv.points.map((p) => ({ at: p.at, value: Number(p.value.toFixed(2)) }));

    // Weekly sampling, with both ends and both extremes kept exactly. 650
    // daily points is a smear in a 600-unit-wide chart, and the shape of
    // the year is the same at any resolution.
    //
    // The extreme days are kept too. Dropping them would shrink the chart's
    // own range and make the low and the high wrong.
    const maxPoints = 120;
    const stride = Math.max(1, Math.ceil(points.length / maxPoints));
    const keep = new Set([0, points.length - 1]);
    points.forEach((p, i) => { if (i % stride === 0) keep.add(i); });
    if (hv.low) keep.add(points.findIndex((p) => p.at === hv.low.at));
    if (hv.high) keep.add(points.findIndex((p) => p.at === hv.high.at));
    const sampled = [...keep].filter((i) => i >= 0).sort((a, b) => a - b).map((i) => points[i]);

    lines.push(...chartBlock({
      type: 'area',
      title: `Monero since ${shortDate(hv.startDate)}`,
      data: sampled,
      valueFormat: 'usd',
      startLabel: hv.start ? usd(hv.start.value) : '',
      endLabel: usd(hv.last?.value ?? v.usd),
      startDate: shortDate(hv.startDate),
      endDate: shortDate(new Date().toISOString()),
      reference: hv.start ? { value: hv.start.value, label: 'where we started' } : null,
    }));

    const last = hv.last?.value ?? v.usd;
    const bits = [];
    if (hv.start) {
      const moved = pctChange(hv.start.value, last);
      if (moved != null) {
        bits.push(`That is ${usd(hv.start.value)} to ${usd(last)} - ${moved >= 0 ? 'up' : 'down'} ${Math.abs(moved).toFixed(0)}% since the white paper was published.`);
      }
    } else {
      bits.push(`There is no close for ${hv.startDate} in the history, so the starting price is missing rather than borrowed from a nearby day.`);
    }
    if (hv.low) bits.push(`The low was ${usd(hv.low.value)} in ${shortDate(hv.low.at)}.`);
    if (hv.high) bits.push(`The high was ${usd(hv.high.value)} in ${shortDate(hv.high.at)}.`);
    bits.push(`Daily closes, ${hv.sources.join(' and ')}.`);
    lines.push(bits.join(' '), '');
  } else if (history && !history.ok) {
    lines.push(`_The price history could not be fetched for this issue, so the chart from the start date is missing: ${history.note}_`, '');
  }

  const stats = [];
  if (v.marketCapUsd != null) stats.push({ label: 'Market cap', value: usd(v.marketCapUsd / 1e9, 2) + 'B' });
  if (v.volume24hUsd != null) stats.push({ label: '24h volume', value: usd(v.volume24hUsd / 1e6, 1) + 'M' });
  if (v.btc != null) stats.push({ label: 'In BTC', value: Number(v.btc).toFixed(5) });
  lines.push(...statsBlock('The market', stats));
  return lines;
}

function sectionPool(s) {
  const pool = s.pool;
  if (!pool || !pool.ok) {
    return ['## The pool', '', `_The pool could not be reached for this issue: ${pool ? pool.note : 'no pool source was run'}_`];
  }
  const p = pool.value;
  const lines = [
    '## The pool',
    '',
    `The fleet's own mining: **${hashrate(p.hashrate)}** across ${num(p.miners)} registered worker${p.miners === 1 ? '' : 's'}${p.activeWorkers ? `, ${num(p.activeWorkers)} active` : ''}.`,
    '',
  ];
  lines.push(...statsBlock('The wallet', [
    { label: 'Paid out', value: Number(p.amtPaidXmr.toFixed(6)) },
    { label: 'Due', value: Number(p.amtDueXmr.toFixed(6)) },
    { label: 'Valid shares', value: num(p.validShares) },
    { label: 'Last hash', value: p.minutesSinceLastHash == null ? 'unknown' : `${p.minutesSinceLastHash} min ago` },
  ]));
  lines.push(
    `SupportXMR as a whole: ${hashrate(p.poolHashrate)} across ${num(p.poolMiners)} miners, ${num(p.poolTotalBlocks)} blocks found.`
    + (p.poolLastBlockTimestamp ? ` Last block ${shortDate(p.poolLastBlockTimestamp)}.` : ''),
    '',
  );
  // The treasury split, which is a policy number rather than a measurement.
  lines.push(...chartBlock({
    type: 'donut',
    title: 'Where the mining goes',
    centerLabel: 'XMR',
    data: [{ label: 'Treasury', value: 85 }, { label: 'Operations', value: 15 }],
  }));
  return lines;
}

function sectionArticles(s) {
  const articles = s.articles;
  if (!articles || !articles.ok) {
    return ['## What we published', '', `_The publication feed could not be fetched for this issue: ${articles ? articles.note : 'no publication source was run'}_`];
  }
  const lines = ['## What we published', ''];
  for (const a of articles.value) {
    lines.push(`### [${a.title}](${a.link})`);
    lines.push(`*${shortDate(a.pubDate)}*`);
    const summary = trimSummary(a.summary);
    if (summary) lines.push(summary);
    lines.push('');
  }
  return lines;
}

function sectionCommits(s) {
  const commits = s.commits;
  if (!commits || !commits.ok) {
    return ['## What shipped', '', `_The commit feed could not be fetched for this issue: ${commits ? commits.note : 'no commit source was run'}_`];
  }
  const lines = ['## What shipped', ''];
  for (const c of commits.value) {
    lines.push(`- \`${c.sha}\` ${c.message}${c.at ? ` - ${shortDate(c.at)}` : ''}`);
  }
  lines.push('');
  return lines;
}

function sectionTrust(s) {
  const t = s.trust;
  if (!t || !t.ok) {
    return ['## The trust ledger', '', `_The trust ledger could not be fetched for this issue: ${t ? t.note : 'no trust source was run'}_`];
  }
  const lines = ['## The trust ledger', ''];
  const v = t.value;
  lines.push(`**${num(v.total)}** trust events in the last ${v.windowDays} days.`, '');

  if (v.perDay && v.perDay.length > 1) {
    lines.push(...chartBlock({
      type: 'area',
      title: 'Trust events per day',
      data: v.perDay,
      startLabel: String(v.perDay[0].value),
      endLabel: String(v.perDay[v.perDay.length - 1].value),
      startDate: shortDate(new Date(v.perDay[0].at).toISOString()),
      endDate: shortDate(new Date(v.perDay[v.perDay.length - 1].at).toISOString()),
    }));
  }

  // The interesting types first, and only the ones a reader can act on.
  const notable = (v.byType || []).filter((x) => !/FLEET_REPLY/i.test(x.label || ''));
  if (notable.length) {
    lines.push(...chartBlock({
      type: 'bar',
      title: 'What the ledger recorded',
      data: notable.slice(0, 8),
    }));
  }
  lines.push(...statsBlock('The window', [
    { label: 'Events', value: num(v.total) },
    { label: 'Days covered', value: num(v.perDay ? v.perDay.length : 0) },
    { label: 'Kinds recorded', value: num((v.byType || []).length) },
  ]));
  return lines;
}

function sectionAgents(s) {
  const a = s.agents;
  if (!a || !a.ok) {
    return ['## The agents', '', `_The agent roster could not be fetched for this issue: ${a ? a.note : 'no roster source was run'}_`];
  }
  const v = a.value;
  const lines = ['## The agents', ''];
  const scored = (v.agents || []).filter((x) => x.trust != null);
  lines.push(...statsBlock('The roster', [
    { label: 'Agents', value: num(v.total) },
    { label: 'Credentials issued', value: num(v.credentials) },
    { label: 'Scored', value: num(v.scored) },
    { label: 'Median trust', value: v.median == null ? '-' : String(v.median) },
    { label: 'Highest', value: v.highest == null ? '-' : String(v.highest) },
    { label: 'Lowest', value: v.lowest == null ? '-' : String(v.lowest) },
  ]));
  if (scored.length) {
    lines.push('The roster, with each agent\'s most recent trust score:', '');
    for (const agent of (v.agents || [])) {
      lines.push(`- **${agent.name}**${agent.did ? ` (${agent.did})` : ''} - trust ${agent.trust == null ? 'not scored' : agent.trust}${agent.trustAt ? `, scored ${shortDate(agent.trustAt)}` : ''}`);
    }
    lines.push('');
  }
  return lines;
}

function sectionContracts(s) {
  const c = s.contracts;
  if (!c || !c.ok) {
    return ['## The contracts', '', `_The contract ledger could not be fetched for this issue: ${c ? c.note : 'no contract source was run'}_`];
  }
  const v = c.value;
  const lines = ['## The contracts', ''];
  lines.push(...statsBlock('The ledger', [
    { label: 'Contracts', value: num(v.contracts.length) },
    { label: 'Gate decisions', value: num(v.gateDecisions) },
  ]));
  for (const ct of (v.contracts || [])) {
    lines.push(`- **${ct.title}**${ct.createdAt ? ` - ${shortDate(ct.createdAt)}` : ''}${ct.status ? ` (${ct.status})` : ''}`);
  }
  lines.push('');
  return lines;
}

function sectionBookings(s) {
  const b = s.bookings;
  if (!b || !b.ok) {
    return ['## The bookings', '', `_The booking ledger could not be fetched for this issue: ${b ? b.note : 'no booking source was run'}_`];
  }
  const v = b.value;
  const lines = ['## The bookings', ''];
  const counts = {};
  for (const x of (v.bookings || [])) counts[x.status || 'unknown'] = (counts[x.status || 'unknown'] || 0) + 1;
  lines.push(...statsBlock('The calendar', [
    { label: 'On the ledger', value: num(v.bookings.length) },
    ...Object.entries(counts).map(([k, c]) => ({ label: k, value: num(c) })),
  ]));
  for (const x of (v.bookings || [])) {
    const fee = x.fee == null ? '' : ` - ${usd(x.fee, 0)}`;
    const signed = x.contractSigned ? ', contract signed' : '';
    lines.push(`- **${x.client || 'A client'}** - ${x.eventDate ? shortDate(x.eventDate) : 'date to confirm'}${x.startTime ? ` at ${x.startTime}` : ''}${x.status ? ` (${x.status})` : ''}${fee}${signed}`);
  }
  lines.push('');
  if (v.divergentRows) {
    // The other table, said plainly. Not the bookings themselves - their
    // dates disagree with these - but the fact that it disagrees.
    lines.push(`_Note: ${num(v.divergentRows)} rows also sit in the web funnel's booking table, with dates that do not agree with these. That divergence is being repaired; this weekly reports the ledger the agent tooling reads._`, '');
  }
  return lines;
}

function sectionLeads(s) {
  const l = s.leads;
  if (!l || !l.ok) {
    return ['## The leads', '', `_The lead ledger could not be fetched for this issue: ${l ? l.note : 'no lead source was run'}_`];
  }
  const v = l.value;
  const lines = ['## The leads', ''];
  lines.push(...statsBlock('The pipeline', [
    { label: 'Leads on file', value: num(v.total) },
    { label: 'New this week', value: num(v.newThisWeek) },
  ]));
  if ((v.byStatus || []).length) {
    lines.push(...chartBlock({
      type: 'bar',
      title: 'Where the leads are',
      data: v.byStatus,
    }));
  }
  for (const lead of (v.recent || [])) {
    const who = lead.company || lead.contact || (lead.source ? `an enquiry from ${lead.source}` : 'an enquiry');
    lines.push(`- ${who}${lead.eventType ? ` - ${lead.eventType}` : ''}${lead.status ? ` (${lead.status})` : ''}${lead.at ? ` - ${shortDate(lead.at)}` : ''}`);
  }
  lines.push('');
  return lines;
}

function sectionCandidates(s) {
  const c = s.candidates;
  if (!c || !c.ok) {
    return ['## The mailboxes', '', `_The candidate ledger could not be fetched for this issue: ${c ? c.note : 'no candidate source was run'}_`];
  }
  const v = c.value;
  const unclaimed = Math.max(0, v.total - v.claimed);
  const lines = ['## The mailboxes', ''];
  lines.push(...statsBlock('The ledger', [
    { label: 'Candidates', value: num(v.total) },
    { label: 'Claimed', value: num(v.claimed) },
    { label: 'Unclaimed', value: num(unclaimed) },
    { label: 'New this month', value: num(v.newThisMonth) },
  ]));
  lines.push('A candidate can only be written to once their own mailbox is claimed, so the claimed count is the number of addresses that can actually receive a reply.', '');
  return lines;
}

function sectionApplications(s) {
  const a = s.applications;
  if (!a || !a.ok) {
    return ['## The applications', '', `_The application ledger could not be fetched for this issue: ${a ? a.note : 'no application source was run'}_`];
  }
  const v = a.value;
  const lines = ['## The applications', ''];
  lines.push(...statsBlock('The ledger', [
    { label: 'Applications', value: num(v.total || 0) },
    ...(v.byStatus || []).slice(0, 3).map((x) => ({ label: x.label || 'unknown', value: num(x.value) })),
  ]));
  for (const app of (v.applications || [])) {
    lines.push(`- **${app.company || 'A company'}** - ${app.role || 'a role'}${app.status ? ` (${app.status})` : ''}${app.submittedAt ? ` - sent ${shortDate(app.submittedAt)}` : ''}${app.blocker ? ` - blocked: ${app.blockerDetail || app.blocker}` : ''}`);
  }
  lines.push('');
  return lines;
}

function sectionWork(s) {
  const w = s.work;
  if (!w || !w.ok) {
    return ['## The work', '', `_The task board could not be read for this issue: ${w ? w.note : 'no task source was run'}_`];
  }
  const v = w.value;
  const lines = ['## The work', ''];
  lines.push(`**${num(v.count)}** tasks in the last ${v.windowDays} days mention this business.`, '');
  const stats = Object.entries(v.byStatus || {}).map(([k, c]) => ({ label: k, value: num(c) }));
  lines.push(...statsBlock('Where they are', stats));
  for (const t of (v.rows || []).slice(0, 8)) {
    lines.push(`- ${t.title}${t.status ? ` (${t.status})` : ''}${t.blocking_reason ? ` - blocked: ${String(t.blocking_reason).slice(0, 90)}` : ''}`);
  }
  lines.push('');
  lines.push('_Tasks are attributed to a business by what their TITLE says about it; the board has no column that names a business._', '');
  return lines;
}

const SECTION_RENDERERS = {
  price: sectionPrice,
  pool: sectionPool,
  articles: sectionArticles,
  commits: sectionCommits,
  trust: sectionTrust,
  agents: sectionAgents,
  contracts: sectionContracts,
  bookings: sectionBookings,
  leads: sectionLeads,
  candidates: sectionCandidates,
  applications: sectionApplications,
  work: sectionWork,
};

// ── The body ────────────────────────────────────────────────

/**
 * Build one tenant's weekly body as markdown.
 *
 * @param {object} data  the gathered data, from gatherWeeklyData()
 * @returns {{body:string, issue:string, pinned:object}}
 */
export function buildWeeklyBody(data, opts = {}) {
  const tenant = data.tenant;
  const lines = [];
  const issue = opts.issue || new Date().toISOString().slice(0, 10);

  const pinned = pinnedNumber(tenant, data);
  lines.push(...chartBlock({ type: 'callout', ...pinned }));

  if (tenant.weekly && tenant.weekly.lede) {
    lines.push(tenant.weekly.lede, '');
  }

  for (const name of (tenant.weekly && tenant.weekly.sections) || []) {
    const render = SECTION_RENDERERS[name];
    if (!render) {
      lines.push(`## ${name}`, '', `_There is no renderer for the "${name}" section._`, '');
      continue;
    }
    lines.push(...render(data.sections || {}));
  }

  return { body: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), issue, pinned };
}

/**
 * Gather, build and render one tenant's weekly.
 *
 * @param {object} opts
 * @param {string} opts.tenant     the tenant key or domain
 * @param {string} [opts.subject]
 * @param {string} [opts.from]     overrides the tenant's From address
 * @param {object} [opts.data]     pre-gathered data, for tests and dry runs
 * @returns {Promise<{html:string, text:string, tenant:object, missing:string[]}>}
 */
export async function buildWeekly(opts = {}) {
  const tenant = tenantByKey(opts.tenant);
  if (!tenant) {
    throw new Error(`no tenant named "${opts.tenant}". Known: ${Object.keys(TENANTS).join(', ')}`);
  }
  const data = opts.data || await gatherWeeklyData(tenant);
  const { body, issue, pinned } = buildWeeklyBody(data, opts);

  const subject = opts.subject || `${tenant.weekly.subject} - ${issue}`;

  // What the weekly could not fetch is stated in the email, not swallowed.
  const missing = data.missing || [];
  const held = (data.sections?.articles?.heldBack) || [];
  const heldNote = held.length
    ? ` ${held.length} draft post${held.length === 1 ? '' : 's'} (${held.map((h) => `"${h.title}"`).join(', ')}) ${held.length === 1 ? 'was' : 'were'} held back from this issue.`
    : '';
  const fetchedAt = new Date(data.gatheredAt).toUTCString().slice(0, 22);
  const footerNote = (missing.length
    ? `This issue is missing ${missing.length} live section${missing.length === 1 ? '' : 's'}: ${missing.join('; ')}.`
    : 'Every figure above was fetched live.') + heldNote
    + ` Everything above was fetched at ${fetchedAt} UTC.`;

  const rendered = renderEmail({
    subject,
    body,
    agentName: opts.agentName || tenant.brand,
    agentRole: opts.agentRole || tenant.role,
    fromAddress: opts.from || tenant.from,
    footerNote,
    preheader: opts.preheader || (tenant.weekly && tenant.weekly.focus) || subject,
  });

  return { ...rendered, tenant, data, missing, issue, subject, pinned };
}

export default { buildWeekly, buildWeeklyBody };
