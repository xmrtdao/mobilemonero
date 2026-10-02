/**
 * relay/tools/web-scrape.mjs — Web page content extraction
 * 
 * Extracts readable text content from any URL.
 * Uses direct fetch with retry logic and multiple User-Agent fallbacks.
 */

/**
 * Scrape a URL and extract text content
 *
 * `extractLinks` is opt-in because the text path is unchanged and callers that
 * only want prose should not pay for it. It exists because the text extraction
 * below deletes every tag, which deletes every href with it — so a page that
 * publishes `mailto:recruiting@example.com` gives a sourcing tool nothing to
 * work with. Adding this was the difference between "we cannot find contact
 * details" and "we could, and here is where".
 */
export async function webScrape(url, options = {}) {
  const { timeout = 20000, maxLength = 50000, extractLinks = false } = options;
  
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return { error: 'Invalid URL. Must start with http:// or https://' };
  }

  // Try with multiple User-Agents in case of blocking
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  ];

  let lastError = '';

  for (let attempt = 0; attempt < userAgents.length; attempt++) {
    let controller, timer;
    try {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeout);

      const res = await fetch(url, {
        headers: {
          'User-Agent': userAgents[attempt],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Cache-Control': 'no-cache',
        },
        signal: controller.signal,
        // Don't follow redirects manually — let fetch handle it
        redirect: 'follow',
      });

      clearTimeout(timer);

      if (!res.ok) {
        lastError = `HTTP ${res.status}: ${res.statusText}`;
        // Don't retry on 4xx (client errors) — they'll likely repeat
        if (res.status >= 400 && res.status < 500) break;
        continue;
      }

      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();
      
      // Extract readable content
      let content = '';
      let links = null;

      if (contentType.includes('text/html')) {
        content = extractHtmlText(text);
        if (extractLinks) links = extractHtmlLinks(text, url);
      } else if (contentType.includes('application/json')) {
        try {
          const json = JSON.parse(text);
          content = JSON.stringify(json, null, 2);
        } catch {
          content = text;
        }
      } else {
        content = text;
      }
      
      // Truncate if needed
      if (content.length > maxLength) {
        content = content.slice(0, maxLength) + `\n\n... (truncated, original ${text.length} chars)`;
      }
      
      return {
        url,
        title: extractTitle(text),
        contentLength: text.length,
        extractedLength: content.length,
        contentType: contentType.split(';')[0],
        content,
        // null rather than [] when not requested, so a caller can tell "no links
        // on the page" from "links were not extracted".
        links,
      };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        lastError = `Request timed out after ${timeout}ms`;
        // Timeout might be network issue — try next UA
        continue;
      }
      lastError = `Fetch failed: ${err.message}`;
      // DNS/connection errors — try next UA
      continue;
    }
  }

  return { error: lastError || 'All fetch attempts failed' };
}

/**
 * Extract readable text from HTML
 */
function extractHtmlText(html) {
  // Remove script, style, nav, footer, header, iframe, noscript tags
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  
  // Replace <br>, <p>, <div>, <li>, <h1-6> with newlines
  cleaned = cleaned
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/th>/gi, '\t')
    .replace(/<\/td>/gi, '\t');
  
  // Remove all remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  
  // Decode common HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
  
  // Collapse whitespace
  cleaned = cleaned
    .replace(/\t+/g, ' ')
    .replace(/ +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  
  return cleaned;
}

/**
 * Extract page title from HTML
 */
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : '';
}

/**
 * Extract anchors and mailto addresses, resolved to absolute URLs.
 *
 * This is the part extractHtmlText throws away. It reads the href attributes
 * before the tags are stripped, and resolves them against the page URL so a
 * relative "/team" link comes back as something that can actually be fetched.
 *
 * Tracking parameters are dropped rather than kept. They identify a click, not a
 * page, and a sourcing record that carries someone's utm campaign is a record
 * about a visitor rather than about a role.
 */
function extractHtmlLinks(html, pageUrl) {
  const out = [];
  const seen = new Set();
  const base = (() => {
    try { return new URL(pageUrl); } catch { return null; }
  })();

  const push = (raw, text, kind) => {
    if (!raw) return;
    let href = raw.trim();
    if (!href || href === '#' || /^javascript:/i.test(href)) return;

    if (kind === 'mailto') {
      // "Name <a@b.com>" is legal in a mailto and the name is not an address.
      const addr = href.replace(/^mailto:/i, '').split('?')[0].trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return;
      const key = 'mailto:' + addr.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ href: 'mailto:' + addr, text: cleanAnchorText(text), kind: 'mailto' });
      return;
    }

    if (base) {
      try { href = new URL(href, base).toString(); }
      catch { return; }
    } else if (!/^https?:\/\//i.test(href)) {
      return;
    }

    try {
      const u = new URL(href);
      for (const p of [...u.searchParams.keys()]) {
        if (/^utm_/i.test(p) || /^gclid$|^fbclid$|^mc_/i.test(p)) u.searchParams.delete(p);
      }
      u.hash = '';
      href = u.toString();
    } catch { return; }

    if (seen.has(href)) return;
    seen.add(href);
    out.push({ href, text: cleanAnchorText(text), kind: 'link' });
  };

  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const attrs = m[1];
    const hrefMatch = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = hrefMatch ? (hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? '') : '';
    push(href, m[2], /^mailto:/i.test(href) ? 'mailto' : 'link');
  }

  // Pages sometimes put the address in visible text with no anchor at all.
  const bare = html.replace(/<[^>]+>/g, ' ');
  const mailRe = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  let e;
  while ((e = mailRe.exec(bare))) {
    const key = 'mailto:' + e[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ href: key, text: e[0], kind: 'mailto' });
  }

  return out;
}

function cleanAnchorText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export default { webScrape };
