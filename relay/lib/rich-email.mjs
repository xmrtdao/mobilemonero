/**
 * relay/lib/rich-email.mjs — making email worth opening.
 *
 * WHY THIS EXISTS
 * ---------------
 * The fleet already writes rich HTML. When ai-chat pushes to the operator's
 * aside pane it can send a document, a chart, a rendered report - and it does
 * that well. But email was the one channel where all of that was flattened:
 * the sender had to hand a string to `body`, the string went out as
 * text/plain, and a two-column report became a wall of wrapped words.
 *
 * So the work here is not "can the agents write HTML" - they can, and they
 * already do. The work is that the EMAIL PATH WAS THROWING IT AWAY. Every
 * send went through one string field, and that field was the only thing the
 * transport carried.
 *
 * WHAT THIS DOES
 * --------------
 * It turns what an agent already wrote into an email that carries it:
 *
 *   - MARKDOWN BECOMES HTML. Headings, tables, code blocks, lists and
 *     links become the things they are, styled for a mail client rather
 *     than for a browser tab.
 *
 *   - CHARTS BECOME INLINE SVG. A ```chart block with JSON in it renders
 *     as a real bar chart, donut, sparkline or progress ring. SVG, because
 *     it scales, it animates, and it needs no image host and no script.
 *
 *   - STATS BECOME CARDS. A ```stats block becomes a row of figures.
 *
 *   - IT MOVES. The cards rise, the bars grow, the ring fills. All of it
 *     in a <style> block with a prefers-reduced-motion escape, so it is a
 *     flourish and never a barrier.
 *
 * HOW THE COLOURS WORK, AND WHY IT IS DONE THIS WAY
 * --------------------------------------------------
 * Two things pull against each other in email:
 *
 *   - OUTLOOK DESKTOP IGNORES <style> BLOCKS ENTIRELY. It renders with the
 *     Word engine, which takes the inline style and ignores the stylesheet.
 *     So anything that decides how the email LOOKS has to be inline.
 *
 *   - BUT A DARK EMAIL IN A LIGHT MAIL CLIENT IS A DESIGN CHOICE, NOT A
 *     BUG, and clients that support prefers-color-scheme will honour it.
 *
 * So: the DARK palette is inline (so every client, Outlook included, shows
 * the intended email), and the LIGHT palette lives in the stylesheet with
 * !important (which beats an inline style, unlike a plain declaration). A
 * client that reads the stylesheet flips to light; a client that does not
 * keeps the dark email it was given.
 *
 * Every element that carries a colour also carries a class, because the
 * light stylesheet can only override what it can name. An element with an
 * inline colour and no class is a colour that can never flip, and that is
 * how a card ends up white with white text on it.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It will not send anything the caller did not ask to send, it will not
 * choose a From address, and it will not run script. The sanitiser below
 * strips scripts, frames, forms and event handlers from any HTML that
 * passes through, because an email is a document that other people's
 * mail clients will open.
 *
 * THE TEXT VERSION MATTERS TOO
 * ----------------------------
 * Half the people reading an email are reading it in a client that shows
 * nothing but text. Every send therefore carries BOTH: the rich HTML and a
 * plain-text rendering of the same content, generated from the same source.
 * The text is not a summary - it is the content, with the markup removed.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Palette ─────────────────────────────────────────────────
//
// The palette is not chosen here. It comes from relay/lib/tenants.mjs,
// which holds each brand's OWN colours, and it is selected by the DOMAIN
// THE MAIL IS SENT FROM.
//
// Two palettes per tenant: the one that goes inline, and the one that
// takes over when the client prefers the other scheme. Which is which is
// the tenant's mode - three of the four brands are dark and one is light,
// and a light brand should not receive a dark email.
//
// The fleet palette is the fallback for a domain that is not one of ours,
// so a mail from an unregistered domain still looks like it came from this
// fleet.

import { TENANTS, tenantForAddress, paletteFor, FLEET_PALETTE } from './tenants.mjs';

/** The palette used when there is no tenant - the fleet's own look. */
const DEFAULT_PALETTE = paletteFor(null).inline;

// ── The house style ──────────────────────────────────────────
//
// Every email is the same shell: a gradient masthead that says who is
// writing, a body that can be anything, and a footer that says what
// happens when you reply. Consistency is what makes a fleet of agents
// look like one organisation instead of seven newsletters.
//
// The override block uses !important on purpose: it has to beat the
// inline colours, and a plain declaration loses to an inline style.
// Without !important on every one of these, a client in the other scheme
// renders white cards with near-white text on them - which is exactly what
// happened the first time this was written.
//
// The override is a MEDIA QUERY, and which query it is depends on the
// tenant's mode. A dark tenant is overridden by prefers-color-scheme:
// light. A light tenant is overridden by prefers-color-scheme: dark. The
// same rules, pointed the other way.

/**
 * The stylesheet for one tenant.
 *
 * @param {object} T   the palette that goes inline
 * @param {object} O   the palette that takes over in the other scheme
 * @param {boolean} overrideIsLight  true when O is the light palette
 * @returns {string}
 */
function styleFor(T, O, overrideIsLight) {
  const scheme = overrideIsLight ? 'dark light' : 'light dark';
  const query = overrideIsLight ? 'light' : 'dark';
  // A bar keeps whatever colour it was given. When the scheme flips, the
  // bar has to be pushed the other way too - darkening a dark blue would
  // make it invisible.
  const barFilter = overrideIsLight
    ? 'brightness(.72) saturate(1.1)'
    : 'brightness(1.55) saturate(1.05)';
  return `
  :root { color-scheme: ${scheme}; }
  body { margin:0; padding:0; width:100% !important; }
  table { border-collapse: collapse; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  a { color:${T.accent}; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .txt   { color:${T.text}; }
  .muted { color:${T.muted}; }
  .faint { color:${T.faint}; }
  .icode { color:${T.accent}; background:${T.codeBg}; border:1px solid ${T.border}; }
  .card  { background:${T.panel}; border:1px solid ${T.border}; border-radius:14px;
           animation: riseIn .7s cubic-bezier(.22,1,.36,1) both; }
  .card:nth-of-type(2) { animation-delay:.07s; }
  .card:nth-of-type(3) { animation-delay:.14s; }
  .card:nth-of-type(4) { animation-delay:.21s; }
  .card:nth-of-type(5) { animation-delay:.28s; }
  .card:nth-of-type(6) { animation-delay:.35s; }
  .quote { color:${T.text}; }
  .svg-txt   { fill:${T.text}; }
  .svg-muted { fill:${T.muted}; }
  .svg-track { stroke:${T.bgDeep}; }
  /* The chart strokes and swatches are classed rather than inline, so the
     other scheme's stylesheet can darken or lighten them. An inline stroke
     beats a class declaration, so a class that is also given an inline
     stroke can never flip - which is how a cyan line ends up invisible on
     a white card. A caller-supplied colour is still honoured inline - it
     just does not flip, because the caller asked for that exact colour. */
  .svg-line  { stroke:${T.accent}; }
  .svg-area-1 { stop-color:${T.accent}; }
  .svg-area-2 { stop-color:${T.violet}; }
  .svg-dot   { fill:${T.accent}; }
  .svg-dot-2 { fill:${T.violet}; }
  .svg-grid  { stroke:${T.border}; }
  .svg-arc-1 { stroke:${T.accent}; }
  .svg-arc-2 { stroke:${T.violet}; }
  .svg-arc-3 { stroke:${T.ok}; }
  .svg-arc-4 { stroke:${T.warn}; }
  .svg-arc-5 { stroke:${T.crit}; }
  .swatch-1 { background:${T.accent}; }
  .swatch-2 { background:${T.violet}; }
  .swatch-3 { background:${T.ok}; }
  .swatch-4 { background:${T.warn}; }
  .swatch-5 { background:${T.crit}; }
  .svg-ring-1 { stroke:${T.accent}; }
  .svg-ring-2 { stroke:${T.ok}; }
  .svg-ring-3 { stroke:${T.warn}; }
  @keyframes riseIn {
    from { opacity:0; transform:translateY(14px); }
    to   { opacity:1; transform:translateY(0); }
  }
  @keyframes sweep { from { transform:translateX(-100%); } to { transform:translateX(320%); } }
  @keyframes pulse {
    0%,100% { opacity:.35; transform:scale(1); }
    50%     { opacity:1;   transform:scale(1.25); }
  }
  /* The bars grow by SCALE, not by width. Animating width needs a definite
     containing-block width, and a table cell does not have one - so the
     animation could not resolve, and the bar was left at zero. Both ends of
     every keyframe are written out: a from-only keyframe relies on the
     browser working out the implicit "to", which is how the bar ended up
     invisible in the first place. */
  @keyframes growBar { from { transform:scaleX(0); } to { transform:scaleX(1); } }
  @keyframes fillRing { from { stroke-dashoffset:var(--ring); } to { stroke-dashoffset:var(--dash); } }
  @keyframes drawLine { from { stroke-dashoffset:var(--len); } to { stroke-dashoffset:0; } }
  @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
  @media (prefers-reduced-motion: reduce) {
    .card, .bar-fill, .ring-fill, .line, .area-fill { animation:none !important; }
    .card { opacity:1 !important; transform:none !important; }
    .area-fill { opacity:1 !important; }
  }
  @media (prefers-color-scheme: ${query}) {
    body      { background:${O.bgDeep} !important; }
    .page     { background:${O.bgDeep} !important; }
    .wrap     { background:${O.bg} !important; border-color:${O.border} !important; }
    .txt      { color:${O.text} !important; }
    .muted    { color:${O.muted} !important; }
    .faint    { color:${O.faint} !important; }
    .icode    { color:${O.accent} !important; background:${O.codeBg} !important; border-color:${O.border} !important; }
    .card     { background:${O.panel} !important; border-color:${O.border} !important; }
    .code     { background:${O.codeBg} !important; border-color:${O.border} !important; }
    .code .k  { color:${O.violet} !important; }
    .code .s  { color:${O.accent} !important; }
    .code .c  { color:${O.faint} !important; }
    .quote    { background:${O.panelAlt} !important; border-color:${O.border} !important; color:${O.text} !important; }
    .rule     { background:${O.border} !important; }
    .foot     { color:${O.faint} !important; }
    .track    { background:${O.bgDeep} !important; }
    .masthead { background:${O.bgDeep} !important; }
    .statval  { color:${O.text} !important; }
    .delta-ok { color:${O.ok} !important; }
    .delta-bad{ color:${O.crit} !important; }
    .svg-txt   { fill:${O.text} !important; }
    .svg-muted { fill:${O.muted} !important; }
    .svg-track { stroke:${O.bgDeep} !important; }
    .svg-line  { stroke:${O.accent} !important; }
    .svg-area-1 { stop-color:${O.accent} !important; }
    .svg-area-2 { stop-color:${O.violet} !important; }
    .svg-dot   { fill:${O.accent} !important; }
    .svg-dot-2 { fill:${O.violet} !important; }
    .svg-grid  { stroke:${O.border} !important; }
    .svg-arc-1 { stroke:${O.accent} !important; }
    .svg-arc-2 { stroke:${O.violet} !important; }
    .svg-arc-3 { stroke:${O.ok} !important; }
    .svg-arc-4 { stroke:${O.warn} !important; }
    .svg-arc-5 { stroke:${O.crit} !important; }
    .swatch-1 { background:${O.accent} !important; }
    .swatch-2 { background:${O.violet} !important; }
    .swatch-3 { background:${O.ok} !important; }
    .swatch-4 { background:${O.warn} !important; }
    .swatch-5 { background:${O.crit} !important; }
    .svg-ring-1 { stroke:${O.accent} !important; }
    .svg-ring-2 { stroke:${O.ok} !important; }
    .svg-ring-3 { stroke:${O.warn} !important; }
    .bar-fill  { filter:${barFilter} !important; }
    a          { color:${O.accent} !important; }
  }
`;
}

// ── Tenants ─────────────────────────────────────────────────
//
// The brand on the masthead comes from the DOMAIN THE MAIL IS SENT FROM,
// not from whatever the caller says it is.
//
// The first version of this took the brand as a free string, and the sample
// that came out of it claimed to be Party Favor Photo while carrying
// MobileMonero's articles. That is not a cosmetic mistake: a mail that says
// it is from one business and carries another business's content is a
// misdirected message, and the brand on the masthead is the part a person
// reads first to decide whose mail they are looking at.
//
// So the domain decides. If a caller names a brand that disagrees with the
// domain it is sending from, the domain wins and the mismatch is reported
// back, because a caller that gets this wrong should hear about it rather
// than have its branding quietly rewritten.
//
// The brands themselves now live in relay/lib/tenants.mjs, next to their
// palettes, so there is ONE place to change a brand rather than two that
// can disagree. xmrtdao.org is not a tenant - it has no Resend domain and
// no inbox - so it is named here as a brand with no palette of its own.

const EXTRA_BRANDS = {
  'xmrtdao.org': 'XMRT-DAO',
};

/** The address part of a From header. */
function addressOf(from) {
  const s = String(from || '');
  const angled = s.match(/<([^>]+)>/);
  return (angled ? angled[1] : s).trim().toLowerCase();
}

/** The domain part of a From header. */
export function domainOf(from) {
  const a = addressOf(from);
  const at = a.lastIndexOf('@');
  return at === -1 ? '' : a.slice(at + 1);
}

/**
 * The brand that owns this email.
 *
 * @returns {{brand:string, mismatch:boolean, domain:string, tenant:object|null}}
 *   `mismatch` is true when the caller named a name that belongs to a
 *   different domain. The domain's brand is returned regardless, because the
 *   From address is what decides who the mail is from.
 */
export function brandFor(from, claimedBrand) {
  const domain = domainOf(from);
  const tenant = tenantForAddress(from);
  const brand = (tenant && tenant.brand) || EXTRA_BRANDS[domain] || null;
  if (!brand) {
    return { brand: claimedBrand || 'The fleet', mismatch: false, domain, tenant: null };
  }
  if (!claimedBrand) return { brand, mismatch: false, domain, tenant };

  const claimed = String(claimedBrand).trim().toLowerCase();
  // A domain can carry more than one name. XMRT-DAO is the project and
  // MobileMonero is the brand the mail comes from; both belong to
  // mobilemonero.com, so neither is a tenant mix. Only a name that belongs
  // to a DIFFERENT domain is a mix.
  const mine = (tenant && tenant.aliases) || [brand.toLowerCase()];
  const ok = mine.some((a) => claimed === a.toLowerCase() || claimed.includes(a.toLowerCase()));

  const others = Object.values(TENANTS)
    .filter((t) => t.domain !== domain)
    .flatMap((t) => (t.aliases || []).map((n) => n.toLowerCase()));

  const belongsElsewhere = !ok && others.some((n) => claimed.includes(n));

  return { brand, mismatch: belongsElsewhere, domain, tenant };
}

// ── Small helpers ───────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escape for an HTML attribute value that is already inside quotes. */
function escAttr(s) {
  return esc(s).replace(/'/g, '&#39;');
}

/**
 * Strip everything dangerous from HTML that a caller supplied.
 *
 * An email is a document that other people's mail clients will open, so the
 * sanitiser is not optional. Scripts, frames, forms, embedded objects and
 * event handlers all go; so do javascript: URLs. What is left is markup
 * that can only describe itself.
 */
export function sanitizeHtml(input) {
  let html = String(input || '');

  // Whole elements whose CONTENT is also dangerous.
  html = html.replace(/<\s*(script|iframe|object|embed|applet|form|input|button|select|textarea|link|meta|base|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  // Self-closing or unclosed variants of the same.
  html = html.replace(/<\s*(script|iframe|object|embed|applet|form|input|button|select|textarea|link|meta|base|style)\b[^>]*\/?>/gi, '');

  // Event handlers: onclick=, onerror=, onload=, and every other on*.
  html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // javascript: and data: URLs in href/src.
  html = html.replace(/(href|src)\s*=\s*("|')?\s*(javascript|vbscript|data:text\/html)[^"'>\s]*/gi, '$1="#"');

  return html;
}

/** Turn a markdown-ish string into HTML. */
export function inlineMarkdown(text, palette) {
  const T = palette || DEFAULT_PALETTE;
  let s = esc(text);

  // Inline code first, so its contents are not treated as emphasis.
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `CODE${codes.length - 1}`;
  });

  // Images before links, because the syntax overlaps.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, url, title) => {
    if (!/^https?:\/\//i.test(url)) return alt;
    return `<img src="${escAttr(url)}" alt="${escAttr(alt)}" width="100%" style="max-width:100%;height:auto;border-radius:10px;border:1px solid ${T.border};display:block;margin:14px 0;" />`;
  });

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, label, url, title) => {
    const safe = /^https?:\/\//i.test(url) ? url : '#';
    return `<a href="${escAttr(safe)}"${title ? ` title="${escAttr(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // Bare URLs.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, lead, url) => `${lead}<a href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`);

  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');

  // Put the inline code back, now that nothing else can touch it.
  s = s.replace(/CODE(\d+)/g, (_, i) => `<code class="icode" style="background:${T.codeBg};border:1px solid ${T.border};border-radius:5px;padding:2px 6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;color:${T.accent};">${codes[Number(i)]}</code>`);

  return s;
}

/**
 * Markdown to HTML.
 *
 * A deliberately small subset - the subset that actually appears in agent
 * output: headings, emphasis, code, lists, quotes, rules, tables and
 * links. It is not CommonMark and does not pretend to be; it is the part
 * that reads well in a mail client.
 *
 * Fenced blocks with an info string are passed to the caller, because
 * ```chart and ```stats are not code - they are instructions to render
 * something else, and only the caller knows what.
 */
export function markdownToHtml(markdown, options = {}) {
  const T = (options && options.palette) || DEFAULT_PALETTE;
  const src = String(markdown == null ? '' : markdown).replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let i = 0;

  const flushParagraph = (buf) => {
    if (!buf.length) return;
    out.push(`<p class="txt" style="margin:0 0 14px;font-size:16px;line-height:1.62;color:${T.text};">${inlineMarkdown(buf.join('<br />'), T)}</p>`);
  };

  let para = [];
  let listStack = [];   // 'ul' | 'ol'

  const closeLists = (toDepth = 0) => {
    while (listStack.length > toDepth) {
      const tag = listStack.pop();
      out.push(`</${tag}>`);
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced block ──────────────────────────────────────
    const fence = line.match(/^\s*```\s*([A-Za-z0-9_+-]*)\s*$/);
    if (fence) {
      const lang = (fence[1] || '').toLowerCase();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      flushParagraph(para); para = [];
      closeLists();
      out.push(renderFence(lang, buf.join('\n'), options));
      continue;
    }

    // ── Heading ───────────────────────────────────────────
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      flushParagraph(para); para = [];
      closeLists();
      const level = head[1].length;
      const size = [26, 21, 18, 16.5, 15, 14.5][level - 1] || 15;
      const pad = [0, 22, 18, 14, 11, 8][level - 1] || 8;
      out.push(`<h${level} class="txt" style="margin:${pad}px 0 ${Math.round(pad * 0.5)}px;font-size:${size}px;line-height:1.3;font-weight:700;color:${T.text};letter-spacing:-.2px;">${inlineMarkdown(head[2], T)}</h${level}>`);
      i++;
      continue;
    }

    // ── Horizontal rule ────────────────────────────────────
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushParagraph(para); para = [];
      closeLists();
      out.push(`<div class="rule" style="height:1px;background:${T.border};margin:22px 0;border:0;"></div>`);
      i++;
      continue;
    }

    // ── Blockquote ─────────────────────────────────────────
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(para); para = [];
      closeLists();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote class="quote" style="margin:0 0 16px;padding:12px 16px;border-left:3px solid ${T.violet};background:${T.panelAlt};border-radius:0 10px 10px 0;color:${T.text};">${inlineMarkdown(buf.join('<br />'), T)}</blockquote>`);      continue;
    }

    // ── Table ──────────────────────────────────────────────
    // A table is a header row, a separator row, then body rows.
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      flushParagraph(para); para = [];
      closeLists();
      const header = splitRow(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        body.push(splitRow(lines[i]));
        i++;
      }
      out.push(renderTable(header, body, T));
      continue;
    }

    // ── Lists ──────────────────────────────────────────────
    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const ol = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ul || ol) {
      flushParagraph(para); para = [];
      const tag = ul ? 'ul' : 'ol';
      const depth = Math.floor(((ul || ol)[1] || '').length / 2);
      while (listStack.length > depth + 1) closeLists(listStack.length - 1);
      if (listStack.length === 0 || listStack[listStack.length - 1] !== tag) {
        closeLists();
        listStack.push(tag);
        out.push(`<${tag} class="txt" style="margin:0 0 14px;padding-left:22px;color:${T.text};font-size:16px;line-height:1.6;">`);
      }
      const itemText = ul ? ul[2] : ol[3];
      out.push(`<li style="margin:0 0 7px;padding-left:3px;">${inlineMarkdown(itemText, T)}</li>`);
      i++;
      continue;
    }

    // ── Blank line ─────────────────────────────────────────
    if (!line.trim()) {
      flushParagraph(para); para = [];
      closeLists();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }

  flushParagraph(para);
  closeLists();
  return out.join('\n');
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function renderTable(header, body, palette) {
  const T = palette || DEFAULT_PALETTE;
  const th = header.map((h) =>
    `<th class="muted" style="text-align:left;padding:10px 12px;font-size:12.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:${T.muted};border-bottom:1px solid ${T.border};white-space:nowrap;">${inlineMarkdown(h, T)}</th>`).join('');
  const trs = body.map((row) => {
    const cells = row.map((c) =>
      `<td class="txt" style="padding:10px 12px;font-size:14.5px;color:${T.text};border-bottom:1px solid ${T.border};vertical-align:top;">${inlineMarkdown(c, T)}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table role="presentation" style="width:100%;margin:0 0 18px;border-collapse:collapse;"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

/**
 * Render a fenced block.
 *
 * chart and stats are not code - they are a request for something else. The
 * renderer asks for them by name and, when the payload does not parse,
 * falls back to showing the block as code rather than losing it.
 */
function renderFence(lang, body, options) {
  const T = (options && options.palette) || DEFAULT_PALETTE;
  if (lang === 'chart') {
    const chart = renderChart(body, options.palette);
    if (chart) return chart;
  }
  if (lang === 'stats') {
    const stats = renderStats(body, options.palette);
    if (stats) return stats;
  }
  if (lang === 'html') {
    // A deliberate HTML block. Sanitised, because it is still email.
    return `<div style="margin:0 0 18px;">${sanitizeHtml(body)}</div>`;
  }

  const label = lang ? `<div class="faint" style="margin:0 0 6px;font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:${T.faint};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(lang)}</div>` : '';
  const code = esc(body)
    .replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g, '<span class="s">$1</span>')
    .replace(/(\/\/.*$|#.*$)/gm, '<span class="c">$1</span>')
    .replace(/\b(\d+)\b/g, '<span class="k">$1</span>');

  return `<div class="code" style="margin:0 0 18px;border:1px solid ${T.border};border-radius:12px;overflow:hidden;background:${T.codeBg};">
    ${label}
    <pre class="txt" style="margin:0;padding:16px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.55;color:${T.text};white-space:pre-wrap;word-break:break-word;">${code}</pre>
  </div>`;
}

// ── Charts ──────────────────────────────────────────────────
//
// Inline SVG, because it needs no image host, no script, and no tracking
// pixel, and because it can be animated with CSS alone.

/**
 * A chart from JSON.
 *
 * The shape is deliberately obvious:
 *
 *   {"type":"bar","title":"...","data":[{"label":"Mon","value":12}]}
 *
 * types: bar, donut, spark, ring, list
 */
export function renderChart(payload, palette) {
  const T = palette || DEFAULT_PALETTE;
  let spec;
  try {
    spec = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    return null;
  }
  if (!spec || typeof spec !== 'object') return null;

  const type = String(spec.type || 'bar').toLowerCase();
  const title = spec.title ? `<div class="txt" style="margin:0 0 12px;font-size:15px;font-weight:700;color:${T.text};">${esc(spec.title)}</div>` : '';
  const data = Array.isArray(spec.data) ? spec.data : [];

  // A ring is one number, not a list - so it must not be rejected for
  // having no data array. It fell back to a code block when it was.
  // A callout is the same: a label, a value and a note, and no series.
  // It fell back to a code block too, which put the pinned price at the top
  // of the weekly as raw JSON.
  if (type !== 'ring' && type !== 'callout' && !data.length) return null;

  const wrap = (inner) => `<div class="card" style="margin:0 0 18px;padding:18px 20px;">${title}${inner}</div>`;

  /**
   * A callout: one number that matters more than the others.
   *
   *   {"type":"callout","label":"The price when we started","value":"$199.62",
   *    "note":"January 10, 2025 — the day the white paper was published"}
   *
   * It is a card like any other, but it is not a chart: it is the number a
   * reader is meant to remember, given room to be read.
   */
  if (type === 'callout') {
    const label = spec.label
      ? `<div class="faint" style="font-size:11.5px;letter-spacing:.7px;text-transform:uppercase;color:${T.faint};margin:0 0 8px;">${esc(spec.label)}</div>`
      : '';
    const value = `<div class="statval txt" style="font-size:36px;font-weight:800;color:${T.text};line-height:1.05;letter-spacing:-.6px;">${esc(String(spec.value ?? ''))}</div>`;
    const note = spec.note
      ? `<div class="muted" style="margin:9px 0 0;font-size:13.5px;line-height:1.55;color:${T.muted};">${esc(spec.note)}</div>`
      : '';
    return wrap(`${label}${value}${note}`);
  }

  /**
   * An area chart over TIME - the shape of a price, from a start to an end.
   *
   *   {"type":"area","data":[{"at":1736467200000,"value":199.62}],
   *    "reference":{"value":199.62,"label":"where we started"}}
   *
   * A sparkline answers "which way, lately". This answers "how far", which
   * is the question a reader asks about a project that started at some
   * remembered price and is now at another one. So it carries what a
   * sparkline cannot: a y axis with numbers on it, the date at each end,
   * the starting point marked, and the starting level drawn across as a
   * line to measure the rest against.
   */
  if (type === 'area') {
    const pts = data
      .map((d) => ({ at: Number(d.at), value: Number(d.value) }))
      .filter((d) => Number.isFinite(d.at) && Number.isFinite(d.value))
      .sort((a, b) => a.at - b.at);
    if (pts.length < 2) return null;

    const W = 600, H = 208;
    const PL = 54, PR = 16, PT = 18, PB = 30;
    const plotW = W - PL - PR;
    const plotH = H - PT - PB;

    const values = pts.map((p) => p.value);
    const dataLo = Math.min(...values);
    const dataHi = Math.max(...values);
    // The plot gets a little headroom above and below, so the line is not
    // welded to the frame - but the LABELS are the real extremes, because a
    // chart whose top line reads $795 when the year's high was $711 is
    // describing its own padding rather than the data.
    const pad = ((dataHi - dataLo) || Math.abs(dataHi) || 1) * 0.08;
    const lo = Math.max(0, dataLo - pad);
    const hi = dataHi + pad;

    const t0 = pts[0].at;
    const t1 = pts[pts.length - 1].at;
    const tSpan = (t1 - t0) || 1;
    const x = (at) => PL + ((at - t0) / tSpan) * plotW;
    const y = (v) => PT + (1 - (v - lo) / (hi - lo)) * plotH;

    // The axis numbers. A dollar sign is a claim about what is being counted,
// so it is opt-in: the trust ledger's chart is a count of events, and an
// axis reading "$149" for a hundred and forty-nine events is a wrong
// number wearing a currency symbol.
const usd = (v) => {
  const n = Math.round(v);
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n}`;
};
const plain = (v) => String(Math.round(v));
const axisFormat = spec.valueFormat === 'usd' ? usd : plain;
const money = axisFormat;

    // Three gridlines: the high, the middle, the low - each with its number.
    const gridVals = [dataHi, (dataHi + dataLo) / 2, dataLo];
    const grid = gridVals.map((v) => {
      const gy = y(v).toFixed(1);
      return `<line class="svg-grid" x1="${PL}" y1="${gy}" x2="${W - PR}" y2="${gy}" stroke-width="1" stroke-dasharray="2 4" opacity=".55" />
        <text class="svg-muted" x="${PL - 9}" y="${gy}" text-anchor="end" fill="${T.muted}" style="font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(money(v))}</text>`;
    }).join('');

    const linePts = pts.map((p) => `${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`);
    const areaPath = `M ${x(t0).toFixed(1)},${(PT + plotH).toFixed(1)} L `
      + linePts.join(' L ')
      + ` L ${x(t1).toFixed(1)},${(PT + plotH).toFixed(1)} Z`;
    const linePath = `M ${linePts.join(' L ')}`;

    // The level we started from, drawn across, so "where it is now" is
    // measured against something rather than against the bottom of the chart.
    let reference = '';
    if (spec.reference && Number.isFinite(Number(spec.reference.value))) {
      const rv = Number(spec.reference.value);
      if (rv >= lo && rv <= hi) {
        const ry = y(rv).toFixed(1);
        reference = `<line x1="${PL}" y1="${ry}" x2="${W - PR}" y2="${ry}" stroke="${T.violet}" stroke-width="1.5" stroke-dasharray="5 5" opacity=".75" />
          <text class="svg-muted" x="${W - PR}" y="${(Number(ry) - 6).toFixed(1)}" text-anchor="end" fill="${T.muted}" style="font-size:10.5px;font-family:ui-sans-serif,system-ui,sans-serif;">${esc(spec.reference.label || money(rv))}</text>`;
      }
    }

    const first = pts[0];
    const last = pts[pts.length - 1];
    const startLabel = spec.startLabel || '';
    const endLabel = spec.endLabel || '';

    // A label above its point when there is room, below it when there is not,
    // so neither end of the chart can push a caption off the canvas.
    const labelY = (yv) => {
      const inTop = yv < PT + plotH * 0.38;
      const y = inTop ? yv + 16 : yv - 10;
      return Math.max(PT + 10, Math.min(PT + plotH - 2, y)).toFixed(1);
    };

    const markers = `
      <circle class="svg-dot" cx="${x(first.at).toFixed(1)}" cy="${y(first.value).toFixed(1)}" r="4.5" fill="${T.accent}" stroke="${T.bgDeep}" stroke-width="2" />
      <text class="svg-txt" x="${(x(first.at) + 11).toFixed(1)}" y="${labelY(y(first.value))}" fill="${T.text}" style="font-size:11.5px;font-weight:700;font-family:ui-sans-serif,system-ui,sans-serif;">${esc(startLabel)}</text>
      <circle class="svg-dot-2" cx="${x(last.at).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="4.5" fill="${T.violet}" stroke="${T.bgDeep}" stroke-width="2" />
      <text class="svg-txt" x="${(x(last.at) - 13).toFixed(1)}" y="${labelY(y(last.value))}" text-anchor="end" fill="${T.text}" style="font-size:11.5px;font-weight:700;font-family:ui-sans-serif,system-ui,sans-serif;">${esc(endLabel)}</text>`;

    const xLabels = `
      <text class="svg-muted" x="${PL}" y="${H - 9}" fill="${T.muted}" style="font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(spec.startDate || '')}</text>
      <text class="svg-muted" x="${W - PR}" y="${H - 9}" text-anchor="end" fill="${T.muted}" style="font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(spec.endDate || '')}</text>`;

    const gid = `area${(renderChart.areaSeq = (renderChart.areaSeq || 0) + 1)}`;
    const len = Math.round(1200);

    return wrap(`<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" style="display:block;max-width:100%;height:auto;">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop class="svg-area-1" offset="0%" stop-color="${T.accent}" stop-opacity=".34" />
          <stop class="svg-area-2" offset="100%" stop-color="${T.violet}" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${grid}
      ${reference}
      <path class="area-fill" d="${areaPath}" fill="url(#${gid})" style="animation:fadeIn 1.2s ease-out both;" />
      <path class="line svg-line" d="${linePath}" fill="none" stroke="${T.accent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${len}" style="--len:${len};animation:drawLine 1.6s ease-out both;" />
      ${markers}
      ${xLabels}
    </svg>`);
  }

  if (type === 'bar' || type === 'bars') {
    const max = Math.max(...data.map((d) => Number(d.value) || 0), 1);
    const rows = data.map((d) => {
      const v = Number(d.value) || 0;
      const pct = Math.max(1.5, Math.round((v / max) * 100));
      const color = d.color || T.accent;
      const suffix = d.unit ? ` ${esc(d.unit)}` : '';
      return `<tr>
        <td class="muted" style="padding:4px 12px 4px 0;font-size:13.5px;color:${T.muted};white-space:nowrap;vertical-align:middle;width:38%;">${esc(d.label)}</td>
        <td style="padding:4px 0;vertical-align:middle;width:44%;">
          <div class="track" style="height:9px;border-radius:99px;background:${T.bgDeep};overflow:hidden;">
            <div class="bar-fill" style="height:9px;border-radius:99px;width:${pct}%;background:linear-gradient(90deg,${color},${color}bb);transform-origin:left center;animation:growBar .9s cubic-bezier(.22,1,.36,1) both;"></div>
          </div>
        </td>
        <td class="txt" style="padding:4px 0 4px 12px;font-size:13.5px;font-weight:700;color:${T.text};white-space:nowrap;vertical-align:middle;text-align:right;width:18%;">${esc(String(v))}${suffix}</td>
      </tr>`;
    }).join('');
    // table-layout:fixed is not a refinement here, it is the fix. The bar
    // column's content is a percentage-width div inside a percentage-width
    // cell, which contributes NO intrinsic width - so under automatic table
    // layout the browser resolved that column to zero and drew no bar at
    // all. Fixed layout takes the widths from the first row instead.
    return wrap(`<table role="presentation" style="width:100%;border-collapse:collapse;table-layout:fixed;">${rows}</table>`);
  }

  if (type === 'donut') {
    const values = data.map((d) => Number(d.value) || 0);
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const R = 54;
    const C = 2 * Math.PI * R;
    let offset = 0;
    const palette = [T.accent, T.violet, T.ok, T.warn, T.crit];
    // A colour the caller chose is used inline and does not flip; the
    // default palette is a class, so it does.
    const paint = (d, i) => (d.color
      ? `stroke="${d.color}"`
      : `class="svg-arc svg-arc-${(i % palette.length) + 1}"`);
    const swatch = (d, i) => (d.color
      ? `style="background:${d.color}"`
      : `class="swatch swatch-${(i % palette.length) + 1}"`);
    const arcs = values.map((v, i) => {
      const len = (v / total) * C;
      const seg = `<circle r="${R}" cx="70" cy="70" fill="none" ${paint(data[i], i)} stroke-width="18" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 70 70)" />`;
      offset += len;
      return seg;
    }).join('');
    const legend = data.map((d, i) =>
      `<div class="muted" style="display:inline-block;margin:0 14px 6px 0;font-size:13px;color:${T.muted};">
        <span ${swatch(d, i)} style="display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:7px;vertical-align:middle;"></span>${esc(d.label)} <span class="txt" style="color:${T.text};font-weight:700;">${esc(String(d.value ?? ''))}</span>
      </div>`).join('');
    return wrap(`<div style="text-align:center;">
      <svg width="140" height="140" viewBox="0 0 140 140" role="img" style="max-width:100%;height:auto;">
        <circle class="svg-track" r="${R}" cx="70" cy="70" fill="none" stroke="${T.bgDeep}" stroke-width="18" />
        ${arcs}
        <text class="svg-txt" x="70" y="66" text-anchor="middle" fill="${T.text}" style="font-size:26px;font-weight:700;font-family:ui-sans-serif,system-ui,sans-serif;">${esc(String(spec.center ?? total))}</text>
        <text class="svg-muted" x="70" y="86" text-anchor="middle" fill="${T.muted}" style="font-size:11px;font-family:ui-sans-serif,system-ui,sans-serif;">${esc(spec.centerLabel || 'total')}</text>
      </svg>
      <div style="margin-top:8px;">${legend}</div>
    </div>`);
  }

  if (type === 'spark') {
    const values = data.map((d) => (typeof d === 'object' ? Number(d.value) || 0 : Number(d) || 0));
    if (values.length < 2) return null;
    // The range is the range of the data. Including zero in the minimum
    // squashed every real series against the top of the chart, because a
    // series that never goes near zero has no business being drawn against
    // zero - a 7% move looked like a flat line.
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = (max - min) || Math.max(1, Math.abs(max) * 0.02);
    const W = 320, H = 64;
    const pts = values.map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = H - ((v - min) / span) * (H - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const len = Math.round(W * 1.25);
    return wrap(`<svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" style="display:block;max-width:100%;height:auto;">
      <polyline class="line svg-line" points="${pts}" fill="none" stroke="${T.accent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${len}" style="--len:${len};animation:drawLine 1.4s ease-out both;" />
    </svg>`);
  }

  if (type === 'ring') {
    const pct = Math.max(0, Math.min(100, Number(spec.value) || 0));
    const R = 54;
    const C = 2 * Math.PI * R;
    const dash = (pct / 100) * C;
    const tone = spec.color ? '' : (pct >= 100 ? 2 : pct >= 50 ? 1 : 3);
    const paint = spec.color
      ? `class="ring-fill" stroke="${spec.color}"`
      : `class="ring-fill svg-ring svg-ring-${tone}"`;
    return wrap(`<div style="text-align:center;">
      <svg width="140" height="140" viewBox="0 0 140 140" role="img" style="max-width:100%;height:auto;">
        <circle class="svg-track" r="${R}" cx="70" cy="70" fill="none" stroke="${T.bgDeep}" stroke-width="16" />
        <circle ${paint} r="${R}" cx="70" cy="70" fill="none" stroke-width="16" stroke-linecap="round"
          stroke-dasharray="${dash.toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 70 70)" style="--ring:${C.toFixed(2)};--dash:0;animation:fillRing 1.2s cubic-bezier(.22,1,.36,1) both;" />
        <text class="svg-txt" x="70" y="70" text-anchor="middle" fill="${T.text}" style="font-size:28px;font-weight:700;font-family:ui-sans-serif,system-ui,sans-serif;">${esc(String(spec.value ?? pct))}${spec.unit ? esc(spec.unit) : '%'}</text>
        ${spec.label ? `<text class="svg-muted" x="70" y="92" text-anchor="middle" fill="${T.muted}" style="font-size:11px;font-family:ui-sans-serif,system-ui,sans-serif;">${esc(spec.label)}</text>` : ''}
      </svg>
    </div>`);
  }

  // 'list' - a labelled breakdown that is not really a chart.
  const rows = data.map((d) =>
    `<tr><td class="muted" style="padding:6px 12px 6px 0;font-size:14px;color:${T.muted};">${esc(d.label)}</td>
        <td class="txt" style="padding:6px 0;font-size:14px;font-weight:700;color:${T.text};text-align:right;">${esc(String(d.value ?? ''))}${d.unit ? ` ${esc(d.unit)}` : ''}</td></tr>`).join('');
  return wrap(`<table role="presentation" style="width:100%;border-collapse:collapse;">${rows}</table>`);
}

/**
 * A row of figures.
 *
 *   [{"label":"Open","value":12,"delta":"+3"}]
 */
export function renderStats(payload, palette) {
  const T = palette || DEFAULT_PALETTE;
  let spec;
  try {
    spec = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    return null;
  }
  const items = Array.isArray(spec) ? spec : (Array.isArray(spec?.data) ? spec.data : null);
  if (!items || !items.length) return null;

  const title = spec?.title ? `<div class="txt" style="margin:0 0 12px;font-size:15px;font-weight:700;color:${T.text};">${esc(spec.title)}</div>` : '';
  const cards = items.map((s) => {
    const delta = s.delta ? String(s.delta) : '';
    const good = /^\s*[+-]/.test(delta) && !delta.trim().startsWith('-');
    const deltaClass = !delta ? '' : (good ? 'delta-ok' : 'delta-bad');
    const deltaColor = !delta ? 'transparent' : (good ? T.ok : T.crit);
    return `<td style="padding:0 8px;width:${Math.floor(100 / items.length)}%;vertical-align:top;">
      <div class="card" style="padding:14px 16px;">
        <div class="faint" style="font-size:11.5px;letter-spacing:.5px;text-transform:uppercase;color:${T.faint};margin-bottom:6px;">${esc(s.label ?? '')}</div>
        <div class="statval txt" style="font-size:26px;font-weight:700;color:${T.text};line-height:1.1;">${esc(String(s.value ?? ''))}</div>
        ${delta ? `<div class="${deltaClass}" style="margin-top:4px;font-size:12.5px;font-weight:600;color:${deltaColor};">${esc(delta)}</div>` : ''}
      </div>
    </td>`;
  }).join('');

  return `<div class="card" style="margin:0 0 18px;padding:18px 12px;">
    ${title}
    <table role="presentation" style="width:100%;border-collapse:collapse;"><tr>${cards}</tr></table>
  </div>`;
}

// ── The shell ───────────────────────────────────────────────

/**
 * Build the email.
 *
 * @param {object} opts
 * @param {string} opts.subject
 * @param {string} [opts.body]        plain or markdown body
 * @param {string} [opts.html]        explicit HTML, for a caller that already has some
 * @param {string} [opts.agentName]   who is writing
 * @param {string} [opts.agentRole]
 * @param {string} [opts.preheader]   the line shown in the inbox list
 * @param {string} [opts.footerNote]  what to do when you reply
 * @param {Array}  [opts.blocks]      extra rendered blocks (charts, stats)
 * @returns {{html:string, text:string}}
 */
export function renderEmail(opts = {}) {
  // The brand and the palette are the DOMAIN's, not the caller's. A mail
  // sent from partyfavorphoto.com is red because that is Party Favor
  // Photo's brand, not because anybody asked for red.
  const from = opts.fromAddress || '';
  const { brand, mismatch, tenant } = brandFor(from, opts.agentName);
  const { inline: T, override: O, mode } = paletteFor(tenant);
  const overrideIsLight = mode === 'dark';
  const style = styleFor(T, O, overrideIsLight);
  const subject = String(opts.subject || '');
  const preheader = opts.preheader || subject;
  const accent = opts.accent || T.accent;

  // The brand comes from the sending domain, never from the caller's word.
  //
  // An email that says it is from one business and carries another's content
  // is a misdirected message, and the masthead is the first thing a person
  // reads to decide whose mail they are looking at. So the From address
  // decides, and a caller that names a different brand is reported rather
  // than obeyed.
  if (mismatch) {
    console.warn(
      `[rich-email] the brand "${opts.agentName}" does not belong to ${domainOf(from) || 'that domain'}; `
      + `using "${brand}" instead`);
  }
  // The agent is the signer; the brand is the tenant. They are different
  // things and both belong on the masthead.
  const agentName = opts.agentName && !mismatch ? opts.agentName : brand;
  const agentRole = opts.agentRole || '';

  const bodyHtml = opts.html
    ? sanitizeHtml(opts.html)
    : markdownToHtml(opts.body || '', { ...opts, palette: T });

  const extra = (opts.blocks || []).filter(Boolean).join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="${mode === 'light' ? 'light dark' : 'dark light'}" />
<meta name="x-apple-disable-message-reformatting" />
<title>${esc(subject)}</title>
<style>${style}</style>
</head>
<body style="margin:0;padding:0;background:${T.bgDeep};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="page" style="background:${T.bgDeep};margin:0;padding:24px 0;">
  <tr>
    <td align="center" style="padding:0 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="wrap" style="max-width:680px;width:100%;background:${T.bg};border-radius:18px;overflow:hidden;border:1px solid ${T.border};">

        <tr>
          <td class="masthead" style="padding:22px 26px;background:linear-gradient(120deg,${accent}1f 0%,${T.violet}2e 55%,${T.bgDeep} 100%);">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:#eaf4ff;font-weight:700;">
                  ${esc(brand)}${agentName && agentName !== brand ? ` <span style="font-weight:500;opacity:.8;">· ${esc(agentName)}</span>` : ''}${agentRole ? ` <span style="font-weight:500;opacity:.8;">· ${esc(agentRole)}</span>` : ''}
                </td>
                <td align="right" style="font-size:12px;color:#eaf4ff;opacity:.85;white-space:nowrap;">
                  <span style="display:inline-block;width:7px;height:7px;border-radius:99px;background:${T.ok};margin-right:7px;vertical-align:middle;animation:pulse 2.4s ease-in-out infinite;"></span>${esc(new Date().toUTCString().slice(0, 16))}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 26px 8px;">
            <h1 class="txt" style="margin:0 0 20px;font-size:24px;line-height:1.28;font-weight:700;color:${T.text};letter-spacing:-.3px;">${esc(subject)}</h1>
            ${bodyHtml}
            ${extra}
          </td>
        </tr>

        <tr>
          <td style="padding:14px 26px 28px;">
            <div class="rule" style="height:1px;background:${T.border};margin:0 0 16px;"></div>
            <div class="foot" style="font-size:12.5px;line-height:1.6;color:${T.faint};">
              ${opts.footerNote ? `<div style="margin-bottom:8px;">${esc(opts.footerNote)}</div>` : ''}
              <div>${esc(brand)}${agentName && agentName !== brand ? ` · ${esc(agentName)}` : ''} · sent from ${esc(from || 'the relay')}</div>
            </div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = opts.text || textVersion(opts);

  return { html, text };
}

/**
 * The plain-text version.
 *
 * Built from the same source as the HTML, not by stripping tags out of it:
 * stripping loses the shape of a table and mangles a code block. The plain
 * text is what a person sees in a text-only client, so it has to read like
 * a letter, not like the debris of one.
 *
 * So the markdown is converted to TEXT here - headings become short rules,
 * tables become aligned columns, emphasis markers come off, code blocks keep
 * their indentation, and a chart or stats block becomes its numbers in a
 * readable line rather than a wall of JSON.
 */
export function textVersion(opts = {}) {
  const lines = [];
  const subject = String(opts.subject || '').trim();
  const { brand } = brandFor(opts.fromAddress || '', opts.agentName);
  if (subject) {
    lines.push(subject);
    lines.push('='.repeat(Math.min(72, subject.length)));
    lines.push('');
  }

  lines.push(markdownToText(opts.body || ''));

  if (opts.footerNote) {
    lines.push('');
    lines.push('—');
    lines.push(String(opts.footerNote).trim());
  }
  lines.push('');
  lines.push(`${brand}${opts.agentRole ? ` · ${opts.agentRole}` : ''}`);
  return lines.join('\n');
}

/**
 * A chart or stats block, as plain text.
 *
 * A reader whose client shows no markup still has to be able to read the
 * chart. The first version of this printed the raw JSON payload, which is
 * technically the data and practically useless - 120 lines of
 * {"at":1736467200000,"value":199.62} is not a chart in any sense a reader
 * would accept.
 *
 * So each chart type has a text shape of its own:
 *   - a callout is its label, its number and its note;
 *   - an area chart is its two ends, its extremes, and a plot of the shape
 *     drawn in ASCII, because the shape is the point of the chart;
 *   - everything else falls back to its labelled rows.
 *
 * The characters used for the plot are plain ASCII on purpose. A text part
 * can land in a client with a narrow code page, and a chart that turns into
 * mojibake is worse than no chart.
 */
function chartSpecToText(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const type = String(spec.type || '').toLowerCase();
  const out = [];

  if (type === 'callout') {
    if (spec.label) out.push(String(spec.label).toUpperCase());
    if (spec.value != null && String(spec.value) !== '') out.push(String(spec.value));
    if (spec.note) out.push(String(spec.note));
    out.push('');
    return out;
  }

  if (type === 'area') {
    const pts = (Array.isArray(spec.data) ? spec.data : [])
      .map((d) => ({ at: Number(d.at), value: Number(d.value) }))
      .filter((d) => Number.isFinite(d.at) && Number.isFinite(d.value))
      .sort((a, b) => a.at - b.at);
    if (pts.length < 2) return null;

    // The dollar sign is a claim about what is being counted, so it is
    // opt-in here too. The text version and the HTML version have to agree
    // about which one they are showing.
    const money = spec.valueFormat === 'usd'
      ? (v) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`)
      : (v) => String(Math.round(v));
    const day = (at) => new Date(at).toISOString().slice(0, 10);
    const first = pts[0];
    const last = pts[pts.length - 1];
    const lo = pts.reduce((b, p) => (b === null || p.value < b.value ? p : b), null);
    const hi = pts.reduce((b, p) => (b === null || p.value > b.value ? p : b), null);

    if (spec.title) out.push(String(spec.title).toUpperCase());
    out.push(`  ${day(first.at).padEnd(12)} ${money(first.value).padStart(8)}   start`);
    out.push(`  ${day(last.at).padEnd(12)} ${money(last.value).padStart(8)}   now`);
    if (lo) out.push(`  ${day(lo.at).padEnd(12)} ${money(lo.value).padStart(8)}   low`);
    if (hi) out.push(`  ${day(hi.at).padEnd(12)} ${money(hi.value).padStart(8)}   high`);

    // The shape, in ASCII. Sixty columns is what a plain-text reader can
    // actually see across without scrolling sideways.
    const BLOCKS = ' .:-=+*#%@';
    const cols = 60;
    const stride = Math.max(1, Math.ceil(pts.length / cols));
    const sample = pts.filter((p, i) => i % stride === 0 || i === pts.length - 1);
    // The scale comes from the WHOLE series, not from the thinned one:
    // re-striding can drop the very days that set the extremes, and then
    // the plot is drawn to a range the chart never had.
    const lo2 = lo ? lo.value : Math.min(...pts.map((p) => p.value));
    const hi2 = hi ? hi.value : Math.max(...pts.map((p) => p.value));
    const span = (hi2 - lo2) || 1;
    const plot = sample.map((p) => {
      const idx = Math.round(((p.value - lo2) / span) * (BLOCKS.length - 1));
      return BLOCKS[Math.max(0, Math.min(BLOCKS.length - 1, idx))];
    }).join('');
    out.push(`  ${money(lo2).padStart(8)} |${plot}| ${money(hi2)}`);
    out.push('');
    return out;
  }

  return null;
}

/**
 * Markdown to plain text.
 *
 * The counterpart of markdownToHtml, for the reader whose client shows no
 * markup at all. A table becomes columns a monospace reader can line up; a
 * chart becomes its own numbers; a link keeps its words AND its address,
 * because a bare URL in the middle of a sentence helps nobody.
 */
export function markdownToText(markdown) {
  const src = String(markdown == null ? '' : markdown).replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let i = 0;

  const plain = (t) => String(t)
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => (alt ? `${alt} (${url})` : url))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1$2')
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1');

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```\s*([A-Za-z0-9_+-]*)\s*$/);
    if (fence) {
      const lang = (fence[1] || '').toLowerCase();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;

      if (lang === 'chart' || lang === 'stats') {
        // The numbers, not the JSON.
        let spec = null;
        try { spec = JSON.parse(buf.join('\n')); } catch { spec = null; }
        if (spec) {
          const asText = chartSpecToText(spec);
          if (asText) {
            out.push(...asText);
            continue;
          }
          const items = Array.isArray(spec) ? spec : (Array.isArray(spec.data) ? spec.data : []);
          if (spec.title) out.push(spec.title.toUpperCase());
          for (const it of items) {
            const label = it.label ?? '';
            const value = it.value ?? '';
            const unit = it.unit ? ` ${it.unit}` : '';
            out.push(`  ${String(label).padEnd(22).slice(0, 22)} ${value}${unit}`);
          }
          out.push('');
          continue;
        }
      }
      if (buf.length) {
        out.push(buf.join('\n'));
        out.push('');
      }
      continue;
    }

    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      // A heading that is a link keeps its words in the heading and gives
      // its address on the next line. "TITLE (HTTPS://PARAGRAPH.COM/...)"
      // with a hundred-character rule under it is not a heading, it is a
      // wall.
      const raw = head[2];
      const link = raw.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
      const title = plain(link ? link[1] : raw);
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(title.toUpperCase());
      out.push('-'.repeat(Math.min(72, title.length)));
      out.push('');
      if (link) {
        out.push(link[2]);
        out.push('');
      }
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push('-'.repeat(40));
      out.push('');
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      for (const b of buf) out.push(`  | ${plain(b)}`);
      out.push('');
      continue;
    }

    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { body.push(splitRow(lines[i])); i++; }
      const widths = header.map((h, idx) => Math.max(
        h.length,
        ...body.map((r) => String(r[idx] ?? '').length),
      ));
      out.push(header.map((h, idx) => h.padEnd(widths[idx])).join('  ').trimEnd());
      out.push(widths.map((w) => '-'.repeat(w)).join('  '));
      for (const row of body) {
        out.push(row.map((c, idx) => String(c ?? '').padEnd(widths[idx])).join('  ').trimEnd());
      }
      out.push('');
      continue;
    }

    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const ol = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ul || ol) {
      const indent = Math.floor(((ul || ol)[1] || '').length / 2);
      const marker = ul ? '- ' : `${(ol || [])[2]}. `;
      out.push(`${'  '.repeat(indent)}${marker}${plain(ul ? ul[2] : ol[3])}`);
      i++;
      continue;
    }

    if (!line.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      i++;
      continue;
    }

    out.push(plain(line));
    i++;
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The fleet palette, for anything that wants the tokens without a tenant.
// A tenant's own tokens come from relay/lib/tenants.mjs.
export const RICH_EMAIL_TOKENS = DEFAULT_PALETTE;
