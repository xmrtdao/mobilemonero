#!/usr/bin/env node
/**
 * ef:lease-writer — Elze Law PLLC Lease Document Writer
 *
 * Completes the circular loop with ef:lease-analyzer:
 *   analyzer reads a lease → finds issues/redlines
 *   writer takes those redlines → generates a corrected lease document
 *
 * Accepts:
 *   - originalText: the original lease text
 *   - redlines: array of redline objects from lease-analyzer
 *   - documentType: lease type (commercial, residential, etc.)
 *   - documentName: optional document name
 *
 * Returns:
 *   - correctedText: the full corrected lease document
 *   - changes: summary of changes made
 *   - redlinedHtml: HTML with tracked changes
 */

const META = {
  description: 'Generate corrected lease documents from lease-analyzer redlines. Completes the analyze→write circular loop for Elze Contract Suite.',
  category: 'legal',
  version: '0.2.0',
  author: 'hermes-agent',
  dependencies: ['lease-analyzer'],
};

/**
 * Apply a single redline to produce corrected text.
 * Supports: insertion, deletion, deletion_insertion, replacement
 */
function applyRedline(text, redline) {
  const { original_text, suggested_text, type } = redline;
  if (!original_text) return text;

  let result = text;
  const idx = result.indexOf(original_text);

  if (idx === -1) {
    // No verbatim anchor. Missing-clause redlines (e.g. "No quiet enjoyment
    // clause detected") carry a synthetic original_text that never exists in
    // the document. For insertion / deletion_insertion types, treat as an
    // insertion: append the suggested clause text. Deletion-only cannot apply
    // without an anchor, so leave unchanged.
    if (type === 'insertion' || type === 'deletion_insertion') {
      if (suggested_text) {
        const sep = result.endsWith('\n') ? '' : '\n\n';
        result = result + sep + suggested_text.trim() + '\n';
      }
      return result;
    }
    // Try fuzzy match — find the closest line
    const lines = result.split('\n');
    const searchWords = original_text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    let bestLine = -1;
    let bestScore = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase();
      const matches = searchWords.filter(w => lineLower.includes(w)).length;
      if (matches > bestScore) {
        bestScore = matches;
        bestLine = i;
      }
    }

    if (bestLine >= 0 && bestScore >= Math.min(2, searchWords.length)) {
      // Replace the whole line
      if (type === 'deletion') {
        lines.splice(bestLine, 1);
      } else if (type === 'insertion' || type === 'deletion_insertion') {
        lines[bestLine] = suggested_text || '';
      } else {
        lines[bestLine] = suggested_text || lines[bestLine];
      }
      result = lines.join('\n');
    }
    return result;
  }

  switch (type) {
    case 'deletion':
      result = result.slice(0, idx) + result.slice(idx + original_text.length);
      break;
    case 'insertion':
      result = result.slice(0, idx) + (suggested_text || '') + result.slice(idx);
      break;
    case 'deletion_insertion':
    case 'replacement':
      result = result.slice(0, idx) + (suggested_text || '') + result.slice(idx + original_text.length);
      break;
    default:
      result = result.slice(0, idx) + (suggested_text || '') + result.slice(idx + original_text.length);
  }

  return result;
}

/**
 * Generate redlined HTML showing tracked changes.
 */
function generateRedlinedHtml(originalText, redlines, changes) {
  let html = originalText;

  // Apply changes in reverse order (by position) to preserve indices
  const sorted = [...redlines].sort((a, b) => {
    const idxA = html.indexOf(a.original_text || '');
    const idxB = html.indexOf(b.original_text || '');
    return (idxB === -1 ? 0 : idxB) - (idxA === -1 ? 0 : idxA);
  });

  for (const r of sorted) {
    if (!r.original_text) continue;
    const idx = html.indexOf(r.original_text);
    if (idx === -1) continue;

    const severity = r.severity || 'medium';
    const colorMap = { critical: '#ef4444', high: '#f97316', medium: '#eab308', suggestion: '#c9a96e' };
    const color = colorMap[severity] || '#eab308';

    let replacement;
    if (r.type === 'deletion') {
      replacement = `<span style="background:rgba(239,68,68,0.15);color:#fca5a5;text-decoration:line-through;">${r.original_text}</span>`;
    } else if (r.type === 'insertion') {
      replacement = `${r.original_text}<span style="background:rgba(34,197,94,0.15);color:#86efac;">${r.suggested_text || ''}</span>`;
    } else {
      replacement = `<span style="background:rgba(239,68,68,0.15);color:#fca5a5;text-decoration:line-through;">${r.original_text}</span><span style="background:rgba(34,197,94,0.15);color:#86efac;">${r.suggested_text || ''}</span>`;
    }

    html = html.slice(0, idx) + replacement + html.slice(idx + r.original_text.length);
  }

  // Wrap in document HTML
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Corrected Lease Document</title>
<style>
  body { font-family: 'Inter', sans-serif; background: #0a0a14; color: #e4e4ef; padding: 40px; max-width: 900px; margin: 0 auto; line-height: 1.7; }
  .change-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; margin-right: 6px; }
  .badge-critical { background: rgba(239,68,68,0.2); color: #ef4444; }
  .badge-high { background: rgba(249,115,22,0.2); color: #f97316; }
  .badge-medium { background: rgba(234,179,8,0.2); color: #eab308; }
  .badge-suggestion { background: rgba(201,169,110,0.2); color: #c9a96e; }
  .changes-summary { background: #12121f; border: 1px solid rgba(201,169,110,0.15); border-radius: 8px; padding: 20px; margin-bottom: 24px; }
  .changes-summary h3 { color: #c9a96e; margin: 0 0 12px 0; font-family: 'Cormorant Garamond', serif; }
  .change-item { padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.9em; }
  .change-item:last-child { border-bottom: none; }
</style></head>
<body>
  <div class="changes-summary">
    <h3>Changes Applied (${changes.length})</h3>
    ${changes.map(c => `<div class="change-item"><span class="change-badge badge-${c.severity}">${c.severity}</span><strong>${c.clause || c.type}:</strong> ${c.comment || ''}</div>`).join('')}
  </div>
  <div>${html}</div>
</body></html>`;
}

export async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'POST only' });
  }

  try {
    const { originalText, redlines, documentType, documentName } = req.body || {};

    if (!originalText || originalText.length < 50) {
      return res.status(400).json({
        success: false,
        error: 'Original document text is required (minimum 50 characters).',
        meta: META,
      });
    }

    if (!redlines || !Array.isArray(redlines) || redlines.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Redlines array is required. Run lease-analyzer first to generate redlines.',
        meta: META,
      });
    }

    // Apply each redline to produce corrected text
    let correctedText = originalText;
    const changes = [];

    for (const r of redlines) {
      const before = correctedText;
      correctedText = applyRedline(correctedText, r);
      if (correctedText !== before) {
        changes.push({
          type: r.type || 'replacement',
          clause: r.clause || 'Unknown',
          severity: r.severity || 'medium',
          comment: r.comment || r.suggested_text || '',
          original: r.original_text,
          suggested: r.suggested_text,
        });
      }
    }

    // Generate redlined HTML
    const redlinedHtml = generateRedlinedHtml(originalText, redlines, changes);

    return res.json({
      success: true,
      status: 'complete',
      generatedAt: new Date().toISOString(),
      documentInfo: {
        type: documentType || 'lease',
        name: documentName || 'Corrected Lease',
        originalLength: originalText.length,
        correctedLength: correctedText.length,
        changesApplied: changes.length,
      },
      correctedText,
      redlinedHtml,
      changes,
      summary: `${changes.length} change(s) applied. Document length: ${originalText.length} → ${correctedText.length} characters.`,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message, meta: META });
  }
}

export const meta = META;
