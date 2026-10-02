#!/usr/bin/env node
/**
 * ef:docx-redline — Generate DOCX with tracked changes from redline data
 *
 * Takes the output from lease-analyzer (with redlines array + structured tables/images)
 * and produces a Word-compatible .docx file with revision marks, tables, and images.
 *
 * API:
 *   POST /api/v1/functions/docx-redline
 *   Body: {
 *     action: "redline" | "final",
 *     redlines: [...],
 *     metadata: { documentName, jurisdiction, grade },
 *     fullText: string,        // for final
 *     structuredData: { tables: [...], images: [...], rawText: string }  // optional but recommended
 *   }
 *   Returns: binary DOCX file
 */

const META = {
  description: 'Generate DOCX files with Word-compatible tracked changes, tables, and images',
  category: 'legal',
  version: '0.2.0',
};

import {
  Document, Paragraph, TextRun, DeletedTextRun, InsertedTextRun,
  HeadingLevel, AlignmentType, Packer, Footer, PageNumber,
  Table, TableRow, TableCell, TableBorders, WidthType, ImageRun,
  VerticalAlign
} from 'docx';
import * as fs from 'fs';
import * as path from 'path';

/* ─── helpers ─────────────────────────────────────────────── */

function severityColor(sev) {
  switch ((sev || '').toLowerCase()) {
    case 'critical': return 'EF4444';
    case 'high':     return 'F97316';
    case 'medium':   return 'EAB308';
    case 'suggestion': return '60A5FA';
    default:         return '94A3B8';
  }
}

function buildTableParagraphs(tables = []) {
  const paragraphs = [];
  for (const t of tables) {
    const headers = t.headers || [];
    const rows = t.rows || [];
    if (headers.length === 0 && rows.length === 0) continue;
    const tableRows = [];
    // Header row
    if (headers.length > 0) {
      tableRows.push(new TableRow({
        children: headers.map(h => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: String(h), bold: true })] })],
          shading: { fill: '0F3460' },
          verticalAlign: VerticalAlign.CENTER,
        })),
      }));
    }
    // Data rows
    for (const r of rows) {
      const cells = Array.isArray(r)
        ? r
        : headers.map(h => r[h] ?? r[String(h)] ?? '');
      tableRows.push(new TableRow({
        children: cells.map(c => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: String(c ?? '') })] })],
          verticalAlign: VerticalAlign.CENTER,
        })),
      }));
    }
    paragraphs.push(new Table({
      rows: tableRows,
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: TableBorders.NONE,
    }));
    paragraphs.push(new Paragraph({ text: '', spacing: { after: 200 } }));
  }
  return paragraphs;
}

function buildImageParagraphs(images = []) {
  const paragraphs = [];
  for (const img of images) {
    const mime = img.mimeType || 'image/png';
    const b64 = img.base64 || img.dataUrl?.replace(/^data:image\/\w+;base64,/, '');
    if (!b64) continue;
    try {
      const buf = Buffer.from(b64, 'base64');
      paragraphs.push(new Paragraph({
        children: [new ImageRun({
          data: buf,
          transformation: { width: 550, height: 400 },
          type: mime.replace('image/', '') || 'png',
        })],
        spacing: { after: 200 },
      }));
    } catch {
      paragraphs.push(new Paragraph({ text: `[Image: ${img.caption || 'embedded image'}]` }));
    }
  }
  return paragraphs;
}

/**
 * Build the native Word track-changes author string that attributes a single
 * redline to its playbook rule + VA statute. This is the "exceed Mixus"
 * differentiator: rather than tagging every revision with a generic "AI"
 * author, each change is attributed to the specific rule/statute that drove it
 * (e.g. "Elze · CL-004 · 55.1-1248").
 */
function attributionAuthor(redline, idx) {
  const ruleId = (redline && redline.id) ? String(redline.id) : '';
  const clause = (redline && redline.clause) ? String(redline.clause).trim() : '';
  const statute = (redline && redline.statute) ? String(redline.statute).trim() : '';
  // Keep the author label tight so it reads cleanly in Word's review pane.
  const statuteShort = statute.startsWith('COMMON-LAW-') ? statute.replace('COMMON-LAW-', 'CL-') : statute;
  let author = `Elze`;
  if (ruleId) author += ` · ${ruleId}`;
  if (clause && clause !== ruleId) author += ` · ${clause}`;
  if (statuteShort) author += ` · ${statuteShort}`;
  return { author, initials: (ruleId || 'ELZ').slice(0, 8) };
}

// Global counter so every tracked-change revision gets a unique w:id (Word
// requires distinct ids; duplicate ids can corrupt the review stack).
let _revId = 0;
function nextRevId() { _revId += 1; return _revId; }

function parseRedlinedHtmlToRuns(html, redlinesById = {}) {
  const runs = [];
  // Remove UI-only tags (buttons, clause controls, severity marks, margin comments)
  let cleaned = html
    .replace(/<span class="clause-controls"[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<span class="severity-mark[^"]*"[^>]*><\/span>/gi, '')
    .replace(/<div class="margin-comment[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<button[^>]*>[\s\S]*?<\/button>/gi, '');
  // Convert statute-ref spans to bracketed text
  cleaned = cleaned.replace(/<span class="statute-ref"[^>]*>([\s\S]*?)<\/span>/gi, ' [$1] ');
  // Remove any remaining span tags
  cleaned = cleaned.replace(/(?:<\/?span[^>]*>)/gi, '');

  // Tokenize by structural tags — capture data-id so each ins/del can be
  // attributed back to its playbook rule.
  const tokens = cleaned.split(/(<\/?(?:del|ins|mark|strong)[^>]*>)/);
  let inDel = false, inIns = false, inMark = false, inStrong = false;
  let curRule = null; // data-id of the redline currently being rendered

  for (const token of tokens) {
    if (!token) continue;
    if (/^<del[^>]*>/.test(token)) {
      inDel = true;
      const m = token.match(/data-id="([^"]*)"/);
      curRule = m ? m[1] : curRule;
      continue;
    }
    if (token === '</del>') { inDel = false; continue; }
    if (/^<ins[^>]*>/.test(token)) {
      inIns = true;
      const m = token.match(/data-id="([^"]*)"/);
      curRule = m ? m[1] : curRule;
      continue;
    }
    if (token === '</ins>') { inIns = false; continue; }
    if (token.startsWith('<mark')) { inMark = true; continue; }
    if (token === '</mark>') { inMark = false; continue; }
    if (token === '<strong>') { inStrong = true; continue; }
    if (token === '</strong>') { inStrong = false; continue; }
    if (/^<\/(?:del|ins|mark|strong)>/.test(token)) continue;

    const text = token.replace(/<[^>]+>/g, '');
    if (!text) continue;

    const rl = (curRule && redlinesById[curRule]) || null;
    const att = attributionAuthor(rl);

    if (inDel) {
      runs.push(new DeletedTextRun({
        text,
        id: nextRevId(),
        author: att.author,
        date: new Date().toISOString(),
      }));
    } else if (inIns) {
      runs.push(new InsertedTextRun({
        text,
        id: nextRevId(),
        author: att.author,
        date: new Date().toISOString(),
      }));
    } else {
      const opts = { text };
      if (inMark) opts.highlight = 'yellow';
      if (inStrong) opts.bold = true;
      runs.push(new TextRun(opts));
    }
  }
  return runs;
}

function buildFullContractParagraphs(redlinedHtml, redlinesById = {}) {
  const paragraphs = [];
  if (!redlinedHtml) return paragraphs;
  // Split by double newlines (the analyzer output now uses \n\n as paragraph breaks)
  const blocks = redlinedHtml.split(/\n\n+/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) {
      paragraphs.push(new Paragraph({ text: '', spacing: { after: 200 } }));
      continue;
    }
    const runs = parseRedlinedHtmlToRuns(trimmed, redlinesById);
    if (runs.length > 0) {
      paragraphs.push(new Paragraph({ children: runs, spacing: { after: 100 } }));
    }
  }
  return paragraphs;
}

/* ─── REDLINE export (tracked changes) ─────────────────────── */

export async function generateDocxRedline(redlines, metadata = {}, structuredData = {}, redlinedHtml = '') {
  const children = [];

  // Build a lookup so each inline <del>/<ins> can be attributed back to its
  // playbook rule + VA statute (the "exceed Mixus" differentiator).
  const redlinesById = {};
  for (const r of redlines || []) {
    if (r && (r.id || r.clause)) redlinesById[r.id || r.clause] = r;
  }

  // ── Contract content ONLY ──
  // The output is the original document's own structure: titles, section
  // headers, and numbered paragraphs from redlinedHtml, with the suggested
  // corrections rendered as native Word tracked changes (w:ins / w:del).
  // No score/grade/jurisdiction/branding chrome is printed — that "inside
  // baseball" stays in the platform, never on the generated contract.
  if (redlinedHtml) {
    children.push(...buildFullContractParagraphs(redlinedHtml, redlinesById));
  } else if (redlines.length) {
    // Fallback: isolated redline sections (old behaviour when no HTML available)
    children.push(new Paragraph({
      text: 'Redlined Changes',
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 400, after: 200 },
    }));

    for (let i = 0; i < redlines.length; i++) {
      const r = redlines[i];
      const num = i + 1;
      children.push(
        new Paragraph({ text: '', spacing: { before: 300, after: 0 } }),
        new Paragraph({
          children: [
            new TextRun({ text: `${num}. `, bold: true, color: 'C9A96E' }),
            new TextRun({ text: r.clause || 'Unknown Clause', bold: true }),
            new TextRun({ text: `    [${(r.severity || 'unknown').toUpperCase()}]`, bold: true, color: severityColor(r.severity) }),
          ],
          heading: HeadingLevel.HEADING_2,
          spacing: { after: 200 },
        }),
      );
      children.push(
        new Paragraph({ text: 'Original Text:', spacing: { after: 100 }, heading: HeadingLevel.HEADING_3 }),
        new Paragraph({ children: [new DeletedTextRun({ text: r.original_text || 'N/A', id: nextRevId(), author: attributionAuthor(r).author, date: new Date().toISOString() })], spacing: { after: 200 } }),
        new Paragraph({ text: 'Suggested Replacement:', spacing: { after: 100 }, heading: HeadingLevel.HEADING_3 }),
        new Paragraph({ children: [new InsertedTextRun({ text: r.suggested_text || 'N/A', id: nextRevId(), author: attributionAuthor(r).author, date: new Date().toISOString() })], spacing: { after: 200 } }),
      );
      if (r.rationale) {
        children.push(
          new Paragraph({ text: 'Rationale:', spacing: { after: 100 }, heading: HeadingLevel.HEADING_3 }),
          new Paragraph({ text: r.rationale, spacing: { after: 300 } }),
        );
      }
      if (r.citation) {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: 'Citation: ', italics: true }),
            new TextRun({ text: r.citation, italics: true, color: '94A3B8' }),
          ],
          spacing: { after: 400 },
        }));
      }
    }
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
      },
      children,
      footers: {
        default: new Footer({
          children: [new Paragraph({
            children: [
              new TextRun({ text: 'Page ', size: 20 }),
              new TextRun({ children: [PageNumber.CURRENT], size: 20 }),
              new TextRun({ text: ' of ', size: 20 }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 20 }),
            ],
            alignment: AlignmentType.CENTER,
          })],
        }),
      },
    }],
  });

  return await Packer.toBuffer(doc);
}

/* ─── FINAL export (clean document) ────────────────────────── */

export async function generateFinalDocx(fullText, metadata = {}, structuredData = {}) {
  const children = [];

  // Title — keep the contract's OWN title (first line of the corrected text).
  // No "X of Y corrections applied" or other statistics are printed — scoring
  // and metadata stay in the platform, never on the generated contract.
  const title = (fullText || '').split('\n')[0] || 'FINAL DOCUMENT';
  children.push(
    new Paragraph({
      text: title,
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    }),
  );

  // Document body — the corrected contract text itself. Preserve the original
  // document's structure (titles, headers, numbered paragraphs) as-is.
  const lines = (fullText || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      children.push(new Paragraph({ text: '', spacing: { after: 200 } }));
      continue;
    }
    if (trimmed === trimmed.toUpperCase() && trimmed.length < 100 && trimmed.length > 3) {
      children.push(new Paragraph({
        text: trimmed,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 200 },
      }));
    } else {
      children.push(new Paragraph({
        children: [new TextRun({ text: trimmed })],
        spacing: { after: 100 },
      }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
      },
      children,
      footers: {
        default: new Footer({
          children: [new Paragraph({
            children: [
              new TextRun({ text: 'Page ', size: 20 }),
              new TextRun({ children: [PageNumber.CURRENT], size: 20 }),
              new TextRun({ text: ' of ', size: 20 }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 20 }),
            ],
            alignment: AlignmentType.CENTER,
          })],
        }),
      },
    }],
  });

  return await Packer.toBuffer(doc);
}

/* ─── Relay Edge Function Handler ───────────────────────────── */

export async function handler(req, res) {
  let redlines, metadata, action, fullText, structuredData, redlinedHtml;

  if (req.body) {
    action = req.body.action || 'redline';
    redlines = req.body.redlines || [];
    metadata = req.body.metadata || {};
    fullText = req.body.fullText || '';
    structuredData = req.body.structuredData || {};
    redlinedHtml = req.body.redlinedHtml || '';
  } else if (typeof req === 'object' && req.redlines) {
    action = req.action || 'redline';
    redlines = req.redlines || [];
    metadata = req.metadata || {};
    fullText = req.fullText || '';
    structuredData = req.structuredData || {};
    redlinedHtml = req.redlinedHtml || '';
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ error: 'Missing required fields. Send { action, redlines, metadata, structuredData } or { action: "final", fullText, metadata, structuredData }' });
    return;
  }

  try {
    let buf;
    let filename;

    if (action === 'final' && fullText) {
      buf = await generateFinalDocx(fullText, {
        ...metadata,
        acceptedCount: metadata.acceptedCount || 0,
        totalCount: metadata.totalCount || 0,
      }, structuredData);
      filename = `${(metadata.documentName || 'final_document').replace(/[^a-zA-Z0-9_-]/g, '_')}_final.docx`;
    } else {
      buf = await generateDocxRedline(redlines, metadata, structuredData, redlinedHtml);
      filename = `${(metadata.documentName || 'redlined_lease').replace(/[^a-zA-Z0-9_-]/g, '_')}.docx`;
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (e) {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: e.message || 'DOCX generation failed' });
  }
}

export const meta = META;

/* ─── Direct CLI execution ────────────────────────────────── */

if (process.argv[1] && process.argv[1].includes('docx-redline')) {
  const out = process.argv[2] || 'redlined.docx';
  generateDocxRedline([
    {
      clause: 'Waiver of Subrogation',
      severity: 'critical',
      statute: '54.1-1234',
      original_text: 'Tenant waives all claims against Landlord.',
      suggested_text: 'Tenant waives subrogation claims to the extent covered by insurance.',
      rationale: 'Standard practice to avoid circular liability.',
      citation: 'Lease § 12(b)',
    },
  ], {
    documentName: 'Sample Lease',
    jurisdiction: 'Virginia',
    grade: 'C',
  }).then(buf => {
    fs.writeFileSync(out, buf);
    console.log(`Generated: ${out} (${buf.length} bytes)`);
  }).catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}
