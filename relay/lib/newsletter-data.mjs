/**
 * relay/lib/newsletter-data.mjs — the numbers a MobileMonero weekly carries.
 *
 * THE SOURCES ARE THE SITE'S
 * --------------------------
 * xmrtdao.github.io already streams this fleet's live state: the Monero price
 * from CoinGecko, the published corpus from Paragraph's RSS feed, and the
 * recent work from the GitHub commits API. A newsletter that fetched
 * different things from different places would eventually disagree with the
 * site about the same number, and a reader who checks both would find one of
 * them lying.
 *
 * So the newsletter reads the SAME sources the site reads. One price, one
 * corpus, one commit feed. The pool figures are the exception: the site does
 * not show the fleet's own mining operation, but the relay does, and the
 * weekly carries it because it is the fleet's business and not just the
 * market's.
 *
 * EVERY FIGURE IS FETCHED, AND EVERY SOURCE SAYS WHETHER IT ANSWERED
 * ------------------------------------------------------------------
 * A weekly that quotes a price from last Tuesday is worse than no weekly,
 * because it looks like a price. So each source returns
 * { ok, value, at, note } and a source that could not be reached returns
 * ok: false with the reason. The renderer is told which pieces are missing
 * and says so, because a weekly that quietly drops its price section reads
 * as a week when the price did not move.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

// The fleet's pool wallet - the same constant the dashboard uses, because the
// weekly and the dashboard are two views of one operation.
export const XMRT_POOL_WALLET = '46UxNFuGM2E3UwmZWWJicaRPoRwqwW4byQkaTHkX8yPcVihp91qAVtSFipWUGJJUyTXgzSqxzDQtNLf2bsp2DX2qCCgC5mg';

// The publication the weekly carries.
//
// Paragraph runs many publications under one account, and two of them are
// ours: @xmrt is the DAO journal ("XMRT.io"), and @mobilemonero is the
// publication MobileMonero itself publishes to - the one PARAGRAPH_PUBLICATION_HANDLE
// names, and the one whose posts carry author "mobilemonero".
//
// They are DIFFERENT FEEDS. @xmrt's most recent item is from June 2026 and is
// DAO governance; @mobilemonero's is the Monero-mining corpus this weekly is
// about. A weekly titled MobileMonero that carried the DAO journal's posts
// would be carrying someone else's newsletter, so it carries its own.
//
// The site's reader points at @xmrt for the DAO journal - which is correct
// there and is not the same job.
const PARAGRAPH_RSS = 'https://api.paragraph.com/blogs/rss/@mobilemonero';
const GITHUB_COMMITS = 'https://api.github.com/repos/xmrtdao/mobilemonero/commits?per_page=8';
const COINGECKO_PRICE = 'https://api.coingecko.com/api/v3/simple/price'
  + '?ids=monero&vs_currencies=usd,eur,btc&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true';
const COINGECKO_CHART = 'https://api.coingecko.com/api/v3/coins/monero/market_chart?vs_currency=usd&days=7';

// The daily-close history. CoinGecko's public market_chart caps free history
// at 365 days and rate-limits hard, so a series reaching back past the
// project's start has to come from an exchange. Kraken's daily OHLC reaches
// back ~720 days, which covers the start date; Binance's daily klines reach
// back ~1000 days and fill anything Kraken does not carry.
const KRAKEN_OHLC = 'https://api.kraken.com/0/public/OHLC?pair=XMRUSD&interval=1440';
const BINANCE_KLINES = 'https://api.binance.com/api/v3/klines?symbol=XMRUSDT&interval=1d&limit=1000';

/**
 * When the project started.
 *
 * 10 January 2025 - the publication date of the XMRT DAO white paper
 * ("XMRT DAO White Paper (Updated 1/10/2025)", josephandrewlee.medium.com),
 * which is also the date the first commit in this repository carries.
 *
 * This is the anchor the chart is pinned to, and it is a DATE, not a price:
 * the price is whatever the market actually did on that day, fetched at send
 * time. An earlier draft of this weekly carried a remembered "$245" instead,
 * which was the price Monero happened to be trading at in September 2021 -
 * a year before the project existed. A remembered number is not a fact.
 */
export const PROJECT_START_DATE = '2025-01-10';

const DAY_MS = 86400000;

function dayKey(at) {
  return new Date(at).toISOString().slice(0, 10);
}

function relayEnv() {
  const out = {};
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * The price of Monero, and the week behind it.
 *
 * The headline number and the chart come from the same provider on purpose:
 * a spot price and a weekly series from two vendors disagree in the third
 * decimal, and a reader who does that arithmetic stops trusting the rest.
 */
export async function fetchPrice() {
  try {
    const [spotRes, chartRes] = await Promise.all([
      fetch(COINGECKO_PRICE, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'xmrt-newsletter/1.0' } }),
      fetch(COINGECKO_CHART, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'xmrt-newsletter/1.0' } }).catch(() => null),
    ]);
    if (!spotRes.ok) {
      return { ok: false, value: null, at: new Date().toISOString(), note: `CoinGecko answered ${spotRes.status}` };
    }
    const j = await spotRes.json();
    const m = j?.monero;
    if (!m || m.usd == null) {
      return { ok: false, value: null, at: new Date().toISOString(), note: 'CoinGecko returned no price for monero' };
    }

    // The chart series, if it came. It is a second request, so it is allowed
    // to be missing without the whole price being missing.
    let series = null;
    if (chartRes && chartRes.ok) {
      const cj = await chartRes.json().catch(() => ({}));
      const prices = Array.isArray(cj?.prices) ? cj.prices : [];
      if (prices.length > 1) {
        series = prices.map(([ts, v]) => ({ at: Number(ts), value: Number(v) }));
      }
    }

    return {
      ok: true,
      at: new Date().toISOString(),
      note: 'CoinGecko',
      value: {
        usd: Number(m.usd),
        eur: m.eur ?? null,
        btc: m.btc ?? null,
        change24h: m.usd_24h_change ?? null,
        marketCapUsd: m.usd_market_cap ?? null,
        volume24hUsd: m.usd_24h_vol ?? null,
        series,
      },
    };
  } catch (e) {
    return { ok: false, value: null, at: new Date().toISOString(), note: `CoinGecko unreachable: ${e.message}` };
  }
}

/**
 * The price of Monero since the project started.
 *
 * WHY THIS IS NOT COINGECKO
 * -------------------------
 * The site's headline price is CoinGecko's spot price, and the weekly keeps
 * that: the number a reader checks against the site is the same number.
 *
 * But CoinGecko's free history stops at 365 days, and the point of this chart
 * is to reach back to the project's start - so the HISTORY comes from the
 * exchanges, and it says so. A weekly that quietly stitched two providers
 * together and called it one number would be the exact failure this file
 * exists to prevent; the difference is that the difference is LABELLED.
 *
 * Every point is a daily close, and every point carries which exchange it
 * came from, so a reader who wants to check one can.
 */
export async function fetchPriceHistory(startDate = PROJECT_START_DATE) {
  const headers = { 'User-Agent': 'xmrt-newsletter/1.0' };
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(startMs)) {
    return { ok: false, value: null, at: new Date().toISOString(), note: `bad start date "${startDate}"` };
  }

  // Kraken first: it is the exchange whose daily close the start price comes
  // from, so the whole window should be one provider where possible.
  const byDay = new Map();
  const sources = new Set();
  const notes = [];

  const kraken = await fetch(KRAKEN_OHLC, { signal: AbortSignal.timeout(20000), headers })
    .catch((e) => { notes.push(`Kraken unreachable: ${e.message}`); return null; });
  if (kraken && kraken.ok) {
    const j = await kraken.json().catch(() => ({}));
    const key = Object.keys(j.result || {}).find((k) => k !== 'last');
    for (const c of (j.result?.[key] || [])) {
      const at = Number(c[0]) * 1000;
      const close = Number(c[4]);
      if (!Number.isFinite(at) || !Number.isFinite(close) || close <= 0) continue;
      byDay.set(dayKey(at), { at, value: close, src: 'Kraken' });
      sources.add('Kraken');
    }
  } else if (kraken) {
    notes.push(`Kraken answered ${kraken.status}`);
  }

  // Binance fills the days Kraken does not have - and stands in for it
  // entirely if Kraken is down.
  const binance = await fetch(BINANCE_KLINES, { signal: AbortSignal.timeout(20000), headers })
    .catch((e) => { notes.push(`Binance unreachable: ${e.message}`); return null; });
  if (binance && binance.ok) {
    for (const c of (await binance.json().catch(() => []))) {
      const at = Number(c[0]);
      const close = Number(c[4]);
      if (!Number.isFinite(at) || !Number.isFinite(close) || close <= 0) continue;
      const key = dayKey(at);
      if (byDay.has(key)) continue;
      byDay.set(key, { at, value: close, src: 'Binance' });
      sources.add('Binance');
    }
  } else if (binance) {
    notes.push(`Binance answered ${binance.status}`);
  }

  const points = [...byDay.values()]
    .filter((p) => p.at >= startMs)
    .sort((a, b) => a.at - b.at);

  if (points.length < 30) {
    return {
      ok: false, value: null, at: new Date().toISOString(),
      note: notes.length ? notes.join('; ') : 'price history came back empty',
    };
  }

  // Which exchanges the numbers actually came from - not which ones answered.
  // Saying "Kraken and Binance" when every point is a Kraken close is a
  // sentence about the fetching, not about the data.
  const used = [...new Set(points.map((p) => p.src))];

  // The start price is the close ON the start date. If that day is missing
  // there is no start price - and the weekly says so rather than borrowing
  // the nearest day's number.
  const exact = points.find((p) => dayKey(p.at) === startDate);
  const highs = points.reduce((best, p) => (best === null || p.value > best.value ? p : best), null);
  const lows = points.reduce((best, p) => (best === null || p.value < best.value ? p : best), null);

  return {
    ok: true,
    at: new Date().toISOString(),
    note: notes.length ? notes.join('; ') : `${used.join(' + ')} daily closes`,
    value: {
      sources: used,
      points: points.map((p) => ({ at: p.at, value: p.value, src: p.src })),
      start: exact ? { at: exact.at, value: exact.value, src: exact.src } : null,
      startDate,
      startDateExact: !!exact,
      high: highs ? { at: highs.at, value: highs.value } : null,
      low: lows ? { at: lows.at, value: lows.value } : null,
      last: points.length ? { at: points[points.length - 1].at, value: points[points.length - 1].value } : null,
      count: points.length,
    },
  };
}

/**
 * The mining pool.
 *
 * The fleet's own slice and the pool-wide figures, because "the fleet's
 * hashrate" and "the pool's hashrate" are different questions and a weekly
 * that mixes them up is lying by accident.
 */
export async function fetchPool() {
  const walletUrl = `https://www.supportxmr.com/api/miner/${XMRT_POOL_WALLET}/stats`;
  const poolUrl = 'https://www.supportxmr.com/api/pool/stats';
  try {
    const [walletRes, poolRes] = await Promise.all([
      fetch(walletUrl, { signal: AbortSignal.timeout(12000) }).catch(() => null),
      fetch(poolUrl, { signal: AbortSignal.timeout(12000) }).catch(() => null),
    ]);
    if (!walletRes || !walletRes.ok) {
      return {
        ok: false, value: null, at: new Date().toISOString(),
        note: `SupportXMR answered ${walletRes ? walletRes.status : 'nothing'}`,
      };
    }
    const wallet = await walletRes.json().catch(() => ({}));
    const pool = poolRes && poolRes.ok ? await poolRes.json().catch(() => ({})) : {};
    const poolStats = pool?.pool_statistics || {};

    // The pool reports 12-decimal atomic units. A weekly that shows
    // 12946785000000 XMR is showing atomic units by accident.
    const amtPaid = Number(wallet.amtPaid || 0) / 1e12;
    const amtDue = Number(wallet.amtDue || 0) / 1e12;

    const lastHash = Number(wallet.lastHash || 0);
    const minutesSince = lastHash ? (Date.now() / 1000 - lastHash) / 60 : null;

    return {
      ok: true,
      at: new Date().toISOString(),
      note: 'SupportXMR',
      value: {
        hashrate: Number(wallet.hash || 0),
        miners: wallet.workers ? wallet.workers.length : 0,
        activeWorkers: Number(wallet.active_workers || 0),
        totalRegisteredWorkers: Number(wallet.total_registered_workers || 0),
        validShares: Number(wallet.validShares || 0),
        invalidShares: Number(wallet.invalidShares || 0),
        totalHashes: Number(wallet.totalHashes || 0),
        amtPaidXmr: amtPaid,
        amtDueXmr: amtDue,
        minutesSinceLastHash: minutesSince !== null ? Math.round(minutesSince * 10) / 10 : null,
        miningStatus: minutesSince === null ? 'unknown' : (minutesSince <= 30 ? 'active' : 'offline'),
        poolHashrate: Number(poolStats.hashRate || 0),
        poolMiners: Number(poolStats.miners || 0),
        poolTotalBlocks: Number(poolStats.totalBlocksFound || 0),
        poolTotalPayments: Number(poolStats.totalPayments || 0),
        poolLastBlockTimestamp: poolStats.lastBlockFoundTime
          ? new Date(poolStats.lastBlockFoundTime * 1000).toISOString() : null,
      },
    };
  } catch (e) {
    return { ok: false, value: null, at: new Date().toISOString(), note: `SupportXMR unreachable: ${e.message}` };
  }
}

/**
 * The published corpus.
 *
 * From the same RSS feed the site's reader uses. The feed carries the title,
 * the link, the date and a description, which is exactly what a digest needs,
 * and the description is the author's own summary of their own piece.
 */
export async function fetchArticles(limit = 6) {
  try {
    const res = await fetch(PARAGRAPH_RSS, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      return { ok: false, value: [], heldBack: [], at: new Date().toISOString(), note: `Paragraph answered ${res.status}` };
    }
    const xml = await res.text();
    const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
    const grab = (b, re) => (b.match(re) || [])[1] || '';
    const items = blocks.map((b) => {
      const title = grab(b, /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)
        || grab(b, /<title>([\s\S]*?)<\/title>/);
      const desc = grab(b, /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)
        || grab(b, /<description>([\s\S]*?)<\/description>/);
      return {
        title: (title || '').trim(),
        link: (grab(b, /<link>([\s\S]*?)<\/link>/) || '').trim(),
        pubDate: (grab(b, /<pubDate>([\s\S]*?)<\/pubDate>/) || '').trim(),
        summary: (desc || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      };
    }).filter((x) => x.title && x.link);

    // Posts whose whole title is "test" are drafts that were published by
    // accident. The weekly is a publication, not a feed mirror - but it does
    // not simply swallow them either: they are counted and reported, so the
    // channel owner can see that the weekly is still finding them.
    const heldBack = items.filter((x) => /^(test|draft)$/i.test(x.title));
    const publishable = items.filter((x) => !/^(test|draft)$/i.test(x.title));

    return {
      ok: true,
      value: publishable.slice(0, limit),
      heldBack: heldBack.map((x) => ({ title: x.title, link: x.link, pubDate: x.pubDate })),
      at: new Date().toISOString(),
      note: 'Paragraph · @mobilemonero',
    };
  } catch (e) {
    return { ok: false, value: [], heldBack: [], at: new Date().toISOString(), note: `Paragraph unreachable: ${e.message}` };
  }
}

/**
 * What shipped.
 *
 * The same commits feed the site reads, so "shipped this week" and the site's
 * commit list are the same list.
 */
export async function fetchCommits(limit = 8) {
  try {
    const res = await fetch(GITHUB_COMMITS, {
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'xmrt-newsletter/1.0' },
    });
    if (!res.ok) {
      return { ok: false, value: [], at: new Date().toISOString(), note: `GitHub answered ${res.status}` };
    }
    const j = await res.json().catch(() => []);
    const list = Array.isArray(j) ? j : [];
    return {
      ok: true,
      at: new Date().toISOString(),
      note: 'GitHub · xmrtdao/mobilemonero',
      value: list.slice(0, limit).map((c) => ({
        sha: String(c.sha || '').slice(0, 7),
        message: String(c?.commit?.message || '').split('\n')[0].slice(0, 160),
        at: c?.commit?.committer?.date || c?.commit?.author?.date || null,
        url: c?.html_url || null,
      })).filter((c) => c.sha),
    };
  } catch (e) {
    return { ok: false, value: [], at: new Date().toISOString(), note: `GitHub unreachable: ${e.message}` };
  }
}

/**
 * Everything the weekly needs, fetched together.
 *
 * Each source stands or falls on its own: a price that will not load does
 * not stop the articles, and the caller is told which pieces are missing.
 */
export async function gatherNewsletterData() {
  const [price, history, pool, articles, commits] = await Promise.all([
    fetchPrice(),
    fetchPriceHistory(),
    fetchPool(),
    fetchArticles(),
    fetchCommits(),
  ]);
  return {
    price, history, pool, articles, commits,
    missing: [price, history, pool, articles, commits].filter((s) => !s.ok).map((s) => s.note),
    gatheredAt: new Date().toISOString(),
  };
}

export default {
  fetchPrice,
  fetchPriceHistory,
  fetchPool,
  fetchArticles,
  fetchCommits,
  gatherNewsletterData,
  XMRT_POOL_WALLET,
  PROJECT_START_DATE,
};
