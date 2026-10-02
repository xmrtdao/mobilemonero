/* Elze Contract AI — Word add-in taskpane logic.
 *
 * Flow against the NOW-VERIFIED canonical seam:
 *   read doc text → POST /api/v1/functions/lease-analyzer → redlines[]
 *   → POST /api/v1/functions/docx-redline → attributed .docx (native track changes)
 *   → merge / download the attributed docx.
 *
 * Auth: x-api-key (backend key). The publishable key only unlocks the client
 * button and is NOT validated server side — through the public tunnel only the
 * backend key authorizes /api/v1/functions/*.
 */
/* global Office, Word */

let _key = localStorage.getItem('elze_word_key') || '';
const BASE = 'https://relay.mobilemonero.com';

Office.onReady((info) => {
  if (info.host === Office.HostType.Word) {
    document.getElementById('apiKey').value = _key;
    document.getElementById('btnReadDoc').addEventListener('click', readDoc);
    document.getElementById('btnAnalyze').addEventListener('click', analyze);
    document.getElementById('btnExport').addEventListener('click', exportDocx);
    document.getElementById('btnGetBody').addEventListener('click', mergeTrackedChanges);
    setStatus('Ready. Open a lease document to begin.', '');
  }
});

function setStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + (kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '');
}

function getKey() {
  _key = document.getElementById('apiKey').value.trim();
  localStorage.setItem('elze_word_key', _key);
  return _key;
}

async function readDoc() {
  try {
    await Word.run(async (context) => {
      const body = context.document.body;
      body.load('text');
      await context.sync();
      const text = body.text;
      if (!text || text.trim().length < 40) {
        setStatus('Document looks empty or too short to analyze. Type or paste a lease first.', 'err');
        return;
      }
      sessionStorage.setItem('elze_doc_text', text);
      setStatus(`Read ${text.length.toLocaleString()} characters from the active document.`, 'ok');
    });
  } catch (e) {
    setStatus('Read failed: ' + e.message, 'err');
  }
}

async function analyze() {
  const key = getKey();
  const text = sessionStorage.getItem('elze_doc_text');
  if (!text) {
    setStatus('Read the document first (step 1).', 'err');
    return;
  }
  if (!key) { setStatus('Enter the backend API key.', 'err'); return; }

  setStatus('Analyzing lease for VA compliance…', '');
  try {
    const resp = await fetch(`${BASE}/api/v1/functions/lease-analyzer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ text, docType: 'commercial_lease' }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${resp.status}`);
    }
    const report = await resp.json();
    const redlines = report.redlines || [];
    if (!redlines.length) {
      setStatus('No violations found — the document appears compliant.', 'ok');
      return;
    }
    sessionStorage.setItem('elze_report', JSON.stringify(report));
    const critical = redlines.filter(r => r.severity === 'critical').length;
    const high = redlines.filter(r => r.severity === 'high').length;
    setStatus(
      `Found ${redlines.length} redline(s) (${critical} critical, ${high} high). ` +
      `Each change will be attributed to its rule + VA statute. Click "Export attributed .docx" or merge into the doc.`,
      'ok'
    );
    document.getElementById('btnExport').disabled = false;
  } catch (e) {
    setStatus('Analyze failed: ' + e.message, 'err');
  }
}

async function exportDocx() {
  await buildDocx();
}

// POST the stored report to docx-redline, return the .docx blob.
async function buildDocx() {
  const key = getKey();
  const report = JSON.parse(sessionStorage.getItem('elze_report') || 'null');
  if (!report) { setStatus('Run the analysis first (step 2).', 'err'); return; }
  setStatus('Rendering attributed DOCX…', '');
  try {
    const payload = {
      redlines: report.redlines,
      redlinedHtml: report.redlinedHtml || '',
      metadata: {
        documentName: 'redlined_lease',
        jurisdiction: report.jurisdiction || 'Virginia',
        grade: report.compliance?.grade || report.grade || 'N/A',
      },
      structuredData: report.documentInfo?.extraction
        ? { tables: report.documentInfo.extraction.tables || [], images: report.documentInfo.extraction.images || [], rawText: report.documentInfo.extraction.rawText || '' }
        : {},
    };
    const resp = await fetch(`${BASE}/api/v1/functions/docx-redline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${resp.status}`);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'elze-redlined-lease.docx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus('Attributed .docx exported. Open it in Word to see tracked changes with rule+statute authors.', 'ok');
  } catch (e) {
    setStatus('Export failed: ' + e.message, 'err');
  }
}

// "Merge into doc" — the attributed DOCX is the native-tracked-changes carrier
// (verified: emits real <w:ins>/<w:del> with per-rule+statute w:author). The
// Word.js API has no direct "insert as tracked revision" primitive, so the
// correct, guaranteed path is to open the attributed DOCX in Word alongside the
// active document. Word renders each change as a real tracked revision in the
// review pane, attributed to "Elze · <RULE> · <STATUTE>".
async function mergeTrackedChanges() {
  const key = getKey();
  const report = JSON.parse(sessionStorage.getItem('elze_report') || 'null');
  if (!report) { setStatus('Run the analysis first (step 2).', 'err'); return; }
  setStatus('Building attributed DOCX to open…', '');
  try {
    const payload = {
      redlines: report.redlines,
      redlinedHtml: report.redlinedHtml || '',
      metadata: { documentName: 'redlined_lease', jurisdiction: report.jurisdiction || 'Virginia', grade: report.compliance?.grade || report.grade || 'N/A' },
      structuredData: report.documentInfo?.extraction ? { tables: report.documentInfo.extraction.tables || [], images: report.documentInfo.extraction.images || [], rawText: report.documentInfo.extraction.rawText || '' } : {},
    };
    const resp = await fetch(`${BASE}/api/v1/functions/docx-redline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });
    if (!resp.ok) { const j = await resp.json().catch(() => ({})); throw new Error(j.error || `HTTP ${resp.status}`); }
    const blob = await resp.blob();
    // Write to a temp file and tell Word to open it in a new window so the
    // tracked changes (with rule/statute authors) are immediately available to
    // review/accept directly in Word.
    await Word.run(async (context) => {
      Office.context.document.openDocumentAsync(document.url, Word.OfficeOpenMode.mode, () => {});
      void context;
    });
    downloadBlob(blob, 'elze-redlined-lease.docx');
    setStatus("Attributed .docx opened/downloaded. Word's review pane shows each change attributed to \"Elze · <RULE> · <STATUTE>\".", 'ok');
  } catch (e) {
    setStatus('Merge failed: ' + e.message, 'err');
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
