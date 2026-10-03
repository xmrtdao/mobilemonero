/**
 * relay/lib/pdf-layout.mjs — the drawing primitives every contract shares.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * The text engine was living inside `pfp-contract-pdf.mjs`, so the only way to
 * render a second kind of document was to copy the whole thing and hard-code a
 * second vendor's name into the copy. That is precisely how this project ended up
 * with two renderers that had drifted apart - section 5.6 read "Discounts" in one
 * and "Discount" in the other - and how Party Favor Photo's identity reached an
 * FCPS contract.
 *
 * So the primitives are here, and the two document types each supply only what is
 * genuinely theirs: their sections, their terms, their branding.
 *
 * The engine decides nothing. It draws what it is given, wraps text, tracks the
 * page cursor, and paginates. A fact it has not been handed cannot appear on the
 * page, because it has no vocabulary for it.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { readFileSync, existsSync } from 'fs';

/** Brand-neutral palette. Documents may override these. */
export const INK = Object.freeze({
  dark: rgb(0.15, 0.15, 0.15),
  gray: rgb(0.50, 0.50, 0.50),
  light: rgb(0.92, 0.92, 0.92),
  rule: rgb(0.82, 0.18, 0.20),
  accent: rgb(0.85, 0.65, 0.13),
});

export const PAGE = Object.freeze({
  width: 612,
  height: 950,
  margin: 50,
  content_width: 512,
  top: 880,
  bottom: 55,
});

/**
 * Open a document and return a drawing context.
 *
 * @param {{palette?: object, page_size?: {width:number,height:number}}} [opts]
 */
export async function createLayout(opts = {}) {
  const C = { ...INK, ...(opts.palette || {}) };
  const doc = await PDFDocument.create();
  const fonts = {
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    serif: await doc.embedFont(StandardFonts.TimesRoman),
    serifBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    sans: await doc.embedFont(StandardFonts.Helvetica),
  };

  let page = null;
  let y = 0;
  const width = opts.page_size?.width ?? PAGE.width;
  const height = opts.page_size?.height ?? PAGE.height;
  const M = opts.page_size?.margin ?? PAGE.margin;
  const W = width - M * 2;

  const layout = {
    doc, fonts, C, width, height, margin: M, content_width: W,
    get page() { return page; },
    get y() { return y; },
    page_count: 0,

    // `y` is both readable and writable: callers position the cursor directly
    // (`L.y -= 14`) to close gaps and restore it to a measured point after a
    // panel. A getter-only cursor made that impossible and threw at the first
    // use, which is why it is defined as an accessor pair rather than plain data.
    set y(v) { y = v; },

    newPage() {
      page = doc.addPage([width, height]);
      y = height - (height - PAGE.top);
      layout.page_count++;
      return page;
    },

    /** Break to a new page if `needed` points would not fit. */
    ensure(needed) {
      if (y - needed < PAGE.bottom) layout.newPage();
    },

    /**
     * Draw one wrapped line of text.
     *
     * @param {string} text
     * @param {{size?:number, color?:object, font?:object, indent?:number,
     *          after?:number, align?:'left'|'right', lead?:number}} [o]
     */
    text(text, o = {}) {
      if (text === null || text === undefined || text === '') return;
      const {
        size = 11, color = C.dark, font = fonts.serif, indent = 0,
        after = 0, align = 'left', lead: leadOverride = null,
      } = o;
      const lead = leadOverride ?? size + 5;
      const right = width - M;

      // One word longer than the content width still has to go somewhere;
      // pdf-lib cannot draw it at all, so it is emitted alone on its own line
      // rather than silently vanishing off the page edge.
      let line = '';
      for (const word of String(text).split(' ')) {
        const test = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(test, size) > W - indent && line) {
          layout.flushLine(line, { font, size, color, indent, align, lead, right });
          line = word;
        } else {
          line = test;
        }
      }
      if (line) layout.flushLine(line, { font, size, color, indent, align, lead, right });
      if (after) y -= after;
    },

    flushLine(line, { font, size, color, indent, align, lead, right }) {
      if (y < PAGE.bottom) layout.newPage();
      page.drawText(line, {
        x: align === 'right' ? right - font.widthOfTextAtSize(line, size) : M + indent,
        y, size, font, color,
      });
      y -= lead;
    },

    /** A horizontal rule. Used for section breaks and document footers. */
    rule(thickness = 1, color = C.rule) {
      if (y < 80) layout.newPage();
      page.drawLine({
        start: { x: M, y: y + 6 },
        end: { x: width - M, y: y + 6 },
        thickness, color,
      });
      y -= 18;
    },

    /** A shaded panel, for party blocks and signature areas. */
    panel(height, color = C.light) {
      if (y - height < PAGE.bottom) layout.newPage();
      page.drawRectangle({ x: M, y: y - height, width: W, height, color });
    },

    /**
     * A numbered section: heading, then a rule beneath.
     * The rule is the section break; without it a run of headings reads as a list.
     */
    section(num, title) {
      if (y < 180) layout.newPage();
      layout.text('', { after: 10 });
      layout.text(`${num}. ${title}`, { size: 14, font: fonts.bold, color: C.rule, after: 6 });
      layout.rule(1.5);
    },

    /** A label/value pair, value indented and greyed. */
    field(label, value) {
      layout.text(label, { size: 11, font: fonts.serifBold, after: 1 });
      layout.text(value, { size: 11, color: C.gray, after: 4 });
    },

    /**
     * A labelled block of text that returns the cursor to where it started,
     * so a caller can draw a background panel behind content it has measured.
     */
    measured(fn) {
      const start = y;
      fn();
      return start - y;
    },

    /** Embed and draw a logo if the path exists. Silent when absent. */
    async logo(path, { max_width = 140, max_height = 60 } = {}) {
      if (!path || !existsSync(path)) return false;
      const img = await doc.embedPng(readFileSync(path));
      const scale = Math.min(max_width / img.width, max_height / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      page.drawImage(img, { x: M, y: y - h, width: w, height: h });
      y -= h;
      return true;
    },

    /** Embed and draw a signature image. Silent when absent. */
    async signature(path, { max_width = 130, max_height = 50 } = {}) {
      if (!path || !existsSync(path)) return false;
      const img = await doc.embedPng(readFileSync(path));
      const scale = Math.min(max_width / img.width, max_height / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      page.drawImage(img, { x: M + 14, y: y - h, width: w, height: h });
      y -= h + 4;
      return true;
    },

    async save() { return doc.save(); },
  };

  layout.newPage();
  return layout;
}

/**
 * Cents to "$1,234.50". No floats anywhere in a money path.
 * Duplicated here rather than imported so a generic document has no dependency
 * on the PFP pricing module - the coupling would be the wrong direction.
 */
export function money(cents) {
  const n = Math.round(Number(cents));
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * A visibly empty field. Never a plausible-looking guess: a blank says "fill
 * this in", and a guess says "this is a fact" to whoever signs.
 */
export const BLANK = '____________________';

/** Reads a value or renders a blank. The only place that choice is made. */
export function fieldOrBlank(value, blank = BLANK) {
  if (value === null || value === undefined) return blank;
  const s = String(value).trim();
  return s === '' ? blank : s;
}

/**
 * A date formatted long, refusing anything it cannot parse rather than printing
 * "Invalid Date" on a legal document. Read in UTC to match how event dates are
 * read everywhere else in the estate.
 */
export function longDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(
      `expected a Date or an ISO date string; got ${JSON.stringify(value)}`
    );
  }
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

export default { createLayout, money, fieldOrBlank, longDate, BLANK, INK, PAGE };