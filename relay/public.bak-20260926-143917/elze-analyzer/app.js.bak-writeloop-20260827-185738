/* ═══════════════════════════════════════════════════════════════════════════
   Elze Contract Analyzer™ — Frontend Application
   © 2026 Cuttlefish Labs
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── API Configuration ── */
  // The relay serves the lease-analyzer at /api/v1/functions/lease-analyzer
  const API_URL = '/api/v1/functions/lease-analyzer';

  /* ── Severity Map ── */
  const SEV = {
    critical: { label: 'CRITICAL', icon: '🔴', color: 'var(--critical)', bg: 'var(--critical-bg)' },
    high:     { label: 'HIGH',     icon: '🟠', color: 'var(--high)',     bg: 'var(--high-bg)' },
    medium:   { label: 'MEDIUM',   icon: '🟡', color: 'var(--medium)',   bg: 'var(--medium-bg)' },
  };

  /* ── Demo Lease (Commercial) ── */
  const DEMO_LEASE = `COMMERCIAL LEASE AGREEMENT

THIS COMMERCIAL LEASE AGREEMENT (the "Lease") is made and entered into as of the 1st day of January, 2026 (the "Effective Date"), by and between ALEXANDRIA INDUSTRIAL PROPERTIES, LLC, a Virginia limited liability company ("Landlord"), and FAIRFAX TECH SOLUTIONS, INC., a Virginia corporation ("Tenant").

1. PREMISES. Landlord hereby leases to Tenant and Tenant hereby leases from Landlord approximately 12,500 rentable square feet of office and warehouse space located at 4400 Wheeler Avenue, Suite 200, Alexandria, Virginia 22304 (the "Premises"), within the building commonly known as The Port Center (the "Building").

2. TERM. The initial term of this Lease shall be five (5) years commencing on February 1, 2026 (the "Commencement Date") and expiring on January 31, 2031 (the "Expiration Date"), unless sooner terminated in accordance with the terms hereof.

3. BASE RENT. Tenant agrees to pay annual Base Rent as follows:
   Years 1–2: $18.50 per rentable square foot ($231,250 annually; $19,270.83 monthly)
   Years 3–4: $19.50 per rentable square foot ($243,750 annually; $20,312.50 monthly)
   Year 5: $20.50 per rentable square foot ($256,250 annually; $21,354.17 monthly)
   Base Rent shall be paid in advance on the first day of each calendar month.

4. SECURITY DEPOSIT. Tenant shall deposit with Landlord the sum of $57,812.50 (two and one-half months' Base Rent) as security for the faithful performance of all terms, covenants, and conditions of this Lease. Said deposit shall be returned to Tenant within ninety (90) days after the Expiration Date or earlier termination, less any sums applied to damages.

5. COMMON AREA MAINTENANCE (CAM). Tenant shall pay Tenant's Pro Rata Share (28.5%) of all Operating Expenses, including but not limited to: landscaping, parking lot maintenance, snow removal, utilities for common areas, property management fees (capped at 4% of gross collections), and capital improvements amortized over their useful life.

6. USE. The Premises shall be used solely for general office, light assembly, technology research and development, and warehousing of Tenant's products. Tenant shall not use the Premises for any unlawful purpose or any use that would increase insurance premiums.

7. ASSIGNMENT AND SUBLETTING. Tenant shall not assign this Lease or sublet the Premises or any part thereof without the prior written consent of Landlord, which consent may be withheld in Landlord's sole and absolute discretion. In the event of any assignment or sublease, Tenant shall remain fully liable for all obligations hereunder.

8. INSURANCE. Tenant shall maintain comprehensive general liability insurance with limits not less than $2,000,000 per occurrence, $4,000,000 aggregate, naming Landlord as additional insured. Tenant shall also maintain business interruption insurance, workers' compensation, and property insurance covering Tenant's personal property and leasehold improvements.

9. INDEMNIFICATION. Tenant agrees to indemnify, defend, and hold harmless Landlord, its members, managers, agents, and employees from and against any and all claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees) arising out of or in connection with Tenant's use and occupancy of the Premises, INCLUDING CLAIMS ARISING FROM LANDLORD'S NEGLIGENCE, to the fullest extent permitted by law.

10. LANDLORD'S ENTRY. Landlord and its agents shall have the right to enter the Premises at any reasonable time upon reasonable oral notice for the purpose of inspecting, repairing, altering, or showing the Premises for lease or sale.

11. ALTERATIONS. Tenant shall not make any alterations, additions, or improvements to the Premises without Landlord's prior written consent. All alterations shall become the property of Landlord upon installation and shall remain upon termination.

12. DEFAULT AND REMEDIES. In the event of any default by Tenant, Landlord may, at its option and without notice or demand, terminate this Lease, re-enter and take possession of the Premises, and remove all persons and property therefrom using self-help measures or otherwise, WITHOUT OBTAINING A COURT ORDER. Landlord shall have no duty to mitigate damages.

13. FORCE MAJEURE. Neither party shall be liable for failure to perform obligations (other than payment obligations) due to causes beyond its reasonable control, including acts of God, war, terrorism, labor disputes, pandemic, or governmental action.

14. ENVIRONMENTAL. Tenant shall comply with all applicable environmental laws and regulations. Tenant shall indemnify Landlord for any contamination caused by Tenant's operations, including hazardous materials storage, disposal, or release.

15. PARKING. Tenant shall have the non-exclusive right to use twenty-five (25) unreserved parking spaces in the Building's surface lot, subject to Landlord's parking rules and regulations.

16. SIGNAGE. Tenant shall have the right to install non-illuminated signage on the Building directory and suite entrance, subject to Landlord's sign criteria and applicable zoning laws.

17. QUIET ENJOYMENT. Landlord covenants that Tenant shall quietly enjoy the Premises during the Term, provided Tenant pays rent and performs all covenants.

18. WAIVER. No waiver by either party of any breach shall be deemed a waiver of any subsequent breach. No waiver shall be effective unless in writing signed by the waiving party.

19. ATTORNEYS' FEES. In the event of any litigation or arbitration arising out of this Lease, the prevailing party shall be entitled to recover reasonable attorneys' fees, costs, and expenses from the non-prevailing party.

20. GOVERNING LAW. This Lease shall be governed by and construed in accordance with the laws of the Commonwealth of Virginia, without regard to its conflicts of law principles.

21. ENTIRE AGREEMENT. This Lease contains the entire agreement between the parties and supersedes all prior negotiations, understandings, and agreements.

IN WITNESS WHEREOF, the parties have executed this Lease as of the date first written above.

LANDLORD:                                    TENANT:
Alexandria Industrial Properties, LLC          Fairfax Tech Solutions, Inc.
By: _______________________                  By: _______________________
Its: Authorized Signatory                     Its: Authorized Signatory`;

  /* ── State ── */
  let report = null;
  let activeTab = 'overview';
  let findingFilters = { critical: true, high: true, medium: true };
  let clauseFilters = { found: true, missing: true };

  /* ── DOM Refs ── */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const els = {
    sidebar: $('#sidebar'),
    sidebarToggle: $('#sidebarToggle'),
    fileInput: $('#fileInput'),
    uploadZone: $('#uploadZone'),
    fileInfo: $('#fileInfo'),
    fileName: $('#fileName'),
    fileSize: $('#fileSize'),
    fileRemove: $('#fileRemove'),
    pasteInput: $('#pasteInput'),
    btnDemo: $('#btnDemo'),
    btnAnalyze: $('#btnAnalyze'),
    analysisStatus: $('#analysisStatus'),
    pipelineProgressFill: $('#pipelineProgressFill'),
    pipelineProgressPct: $('#pipelineProgressPct'),
    pipelineProgressStage: $('#pipelineProgressStage'),
    sidebarStats: $('#sidebarStats'),
    statGrid: $('#statGrid'),
    results: $('#results'),
    welcome: $('#welcome'),
    complianceBanner: $('#complianceBanner'),
    tabNav: $('#tabNav'),
    scoreValue: $('#scoreValue'),
    scoreGrade: $('#scoreGrade'),
    severityBars: $('#severityBars'),
    clausesValue: $('#clausesValue'),
    clausesSub: $('#clausesSub'),
    summaryBanner: $('#summaryBanner'),
    topFindings: $('#topFindings'),
    missingClauses: $('#missingClauses'),
    allFindings: $('#allFindings'),
    findingsEmpty: $('#findingsEmpty'),
    clauseList: $('#clauseList'),
    statuteList: $('#statuteList'),
    footerMeta: $('#footerMeta'),
    btnDownloadReport: $('#btnDownloadReport'),
    btnDownloadMd: $('#btnDownloadMd'),
  };

  /* ═══════════════════════════════════════════════════════════════════════════
     LOGIN GATE — API Key Authentication (Protects IP)
     ═══════════════════════════════════════════════════════════════════════════ */
  const loginGate = document.getElementById('loginGate');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const btnLogin = document.getElementById('btnLogin');
  const loginError = document.getElementById('loginError');

  const SESSION_KEY = 'elze_auth_key';

  function checkSession() {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      loginGate.classList.add('hidden');
      return;
    }
    // Hide main app until authenticated
    document.body.style.overflow = 'hidden';
  }

  async function doLogin() {
    const key = apiKeyInput.value.trim();
    if (!key) { showLoginError('Please enter an API key.'); return; }

    btnLogin.disabled = true;
    btnLogin.textContent = 'Validating…';
    loginError.style.display = 'none';

    try {
      // Validate by hitting a protected relay endpoint
      const res = await fetch('/health', {
        headers: { 'x-api-key': key },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw new Error('Invalid API key or relay unreachable.');
      const data = await res.json();
      if (data.status !== 'ok') throw new Error('Relay returned unexpected status.');

      // Valid — store in session and unlock
      sessionStorage.setItem(SESSION_KEY, key);
      loginGate.classList.add('hidden');
      document.body.style.overflow = '';
    } catch (err) {
      showLoginError(err.message || 'Authentication failed. Please check your API key.');
    } finally {
      btnLogin.disabled = false;
      btnLogin.innerHTML = '<span class="btn-icon">🔐</span> Unlock Access';
    }
  }

  function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.style.display = 'block';
  }

  btnLogin.addEventListener('click', doLogin);
  apiKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  checkSession();

  /* ═══════════════════════════════════════════════════════════════════════════
     FILE HANDLING
     ═══════════════════════════════════════════════════════════════════════════ */

  let uploadedFile = null;
  let uploadedFileBase64 = null;

  function handleFile(file) {
    if (!file) return;
    els.fileName.textContent = file.name;
    els.fileSize.textContent = formatSize(file.size);
    els.fileInfo.style.display = 'flex';
    els.btnAnalyze.disabled = false;

    uploadedFile = file;

    // For text files, read as text and populate the paste area
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'txt' || file.type === 'text/plain') {
      const reader = new FileReader();
      reader.onload = (e) => {
        els.pasteInput.value = e.target.result;
        uploadedFileBase64 = null;
      };
      reader.readAsText(file);
    } else {
      // For PDF/DOCX, read as base64 for server-side extraction
      els.pasteInput.value = '';
      els.pasteInput.placeholder = `File "${file.name}" loaded. Click "Analyze Lease" to process.`;
      const reader = new FileReader();
      reader.onload = (e) => {
        // Convert ArrayBuffer to base64
        const bytes = new Uint8Array(e.target.result);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        uploadedFileBase64 = btoa(binary);
      };
      reader.readAsArrayBuffer(file);
    }
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function clearFile() {
    els.fileInput.value = '';
    els.fileInfo.style.display = 'none';
    els.pasteInput.value = '';
    els.pasteInput.placeholder = 'Paste lease text here...';
    els.btnAnalyze.disabled = true;
    uploadedFile = null;
    uploadedFileBase64 = null;
  }

  /* ── Upload Events ── */
  els.fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
  els.fileRemove.addEventListener('click', clearFile);

  ['dragover', 'dragenter'].forEach(ev => {
    els.uploadZone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.uploadZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    els.uploadZone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.uploadZone.classList.remove('dragover');
    });
  });
  els.uploadZone.addEventListener('drop', (e) => {
    handleFile(e.dataTransfer.files[0]);
  });

  els.pasteInput.addEventListener('input', () => {
    els.btnAnalyze.disabled = els.pasteInput.value.trim().length < 50;
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     ANALYSIS
     ═══════════════════════════════════════════════════════════════════════════ */

  els.btnDemo.addEventListener('click', () => {
    els.pasteInput.value = DEMO_LEASE;
    els.btnAnalyze.disabled = false;
    runAnalysis();
  });

  els.btnAnalyze.addEventListener('click', runAnalysis);

  async function runAnalysis() {
    const documentText = els.pasteInput.value.trim();
    const hasFile = uploadedFileBase64 && uploadedFile;

    // Need either pasted text (50+ chars) or an uploaded file
    if (!hasFile && documentText.length < 50) return;

    els.btnAnalyze.disabled = true;
    els.btnDemo.disabled = true;
    els.analysisStatus.style.display = 'block';

    // ── Progress bar helper ──
    const setProgress = (pct, stage) => {
      const p = Math.max(0, Math.min(100, Math.round(pct)));
      if (els.pipelineProgressFill) els.pipelineProgressFill.style.width = p + '%';
      if (els.pipelineProgressPct) els.pipelineProgressPct.textContent = p + '%';
      if (els.pipelineProgressStage) els.pipelineProgressStage.textContent = stage || '';
    };
    setProgress(2, 'Starting analysis…');

    // Animate pipeline steps
    const steps = ['extract', 'statute', 'redflag', 'compliance', 'report'];
    const stepLabels = {
      extract: 'Clause Extraction',
      statute: 'VA Statute Matching',
      redflag: 'Red Flag Detection',
      compliance: 'Compliance Scoring',
      report: 'Report Generation',
    };
    // Pipeline animation occupies 2% → 45% of the bar.
    const STEP_MIN = 2, STEP_MAX = 45;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const row = document.querySelector(`[data-step="${step}"]`);
      if (row) {
        row.classList.add('active');
        row.querySelector('.pipeline-status').textContent = '⏳';
        row.querySelector('.pipeline-status').className = 'pipeline-status running';
      }
      setProgress(STEP_MIN + ((i + 0.3) / steps.length) * (STEP_MAX - STEP_MIN), stepLabels[step] || step);

      // Simulate step delay for UX
      if (i < steps.length - 1) await sleep(250 + Math.random() * 300);

      if (row) {
        row.classList.remove('active');
        row.classList.add('done');
        row.querySelector('.pipeline-status').textContent = '✓';
        row.querySelector('.pipeline-status').className = 'pipeline-status done';
      }
    }
    setProgress(45, 'Submitting to analyzer…');

    try {
      // Build request body — use fileContent for PDF/DOCX, document for text
      const body = hasFile
        ? {
            fileContent: uploadedFileBase64,
            fileName: uploadedFile.name,
            mimeType: uploadedFile.type || 'application/octet-stream',
            documentType: 'lease',
            documentName: uploadedFile.name,
          }
        : {
            document: documentText,
            documentType: 'lease',
            documentName: els.fileName.textContent || 'Pasted Lease',
          };

      // Animate the bar 45% → 90% while the (potentially slow) request is in flight,
      // so the user sees progress instead of a frozen bar.
      let fetchProgress = 45;
      const fetchTimer = setInterval(() => {
        fetchProgress = Math.min(90, fetchProgress + 1 + Math.random() * 2);
        setProgress(fetchProgress, 'Analyzing document…');
      }, 300);

      let res;
      try {
        res = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': sessionStorage.getItem(SESSION_KEY) || '',
          },
          body: JSON.stringify(body),
        });
      } finally {
        clearInterval(fetchTimer);
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      setProgress(100, 'Complete');
      report = await res.json();
      renderResults();
    } catch (err) {
      alert('Analysis failed: ' + err.message);
      console.error('Analysis error:', err);
    } finally {
      els.btnAnalyze.disabled = false;
      els.btnDemo.disabled = false;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     RENDER RESULTS
     ═══════════════════════════════════════════════════════════════════════════ */

  function renderResults() {
    if (!report || !report.success) return;

    els.welcome.style.display = 'none';
    els.results.style.display = 'block';
    els.sidebarStats.style.display = 'block';

    const { compliance, clauses, findings, warnings, summary } = report;
    const docType = report.documentInfo?.detectedType || 'lease';
    const jurisdiction = report.documentInfo?.jurisdiction || 'Virginia Law';
    const typeLabels = {
      commercial_lease: 'Commercial Lease', residential_lease: 'Residential Lease',
      service_contract: 'Service Contract', partnership_agreement: 'Partnership Agreement',
      articles_of_incorporation: 'Articles of Incorporation', independent_contractor: 'Independent Contractor Agreement',
      non_disclosure: 'Non-Disclosure Agreement', employment: 'Employment Agreement',
    };
    const typeLabel = typeLabels[docType] || docType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Compliance Banner
    const grade = compliance.grade || 'D';
    const gradeText = {
      A: '✅ Compliant — Minor issues only',
      B: '⚠️ Mostly Compliant — Some issues found',
      C: '⚠️ Non-Compliant — Multiple violations',
      D: '🚨 Critical Violations — Document is not compliant',
    };
    els.complianceBanner.style.display = 'flex';
    els.complianceBanner.className = `compliance-banner grade-${grade.toLowerCase()}`;
    els.complianceBanner.innerHTML = `<span>${gradeText[grade] || gradeText['D']}</span><span style="font-size:12px;font-weight:400;opacity:0.7;">${typeLabel} · ${jurisdiction}</span>`;

    // Overview metrics
    els.scoreValue.textContent = Number(compliance.score) || 0;
    els.scoreValue.style.color = grade === 'A' ? 'var(--low)' : grade === 'B' ? 'var(--info)' : grade === 'C' ? 'var(--medium)' : 'var(--critical)';
    els.scoreGrade.textContent = `Grade ${grade}`;
    els.scoreGrade.className = `metric-grade ${grade.toLowerCase()}`;

    // Severity bars
    els.severityBars.innerHTML = `
      ${renderSevBar('Critical', compliance.critical, 'critical')}
      ${renderSevBar('High', compliance.high, 'high')}
      ${renderSevBar('Medium', compliance.medium, 'medium')}
    `;

    // Clauses
    els.clausesValue.textContent = `${Number(clauses.found) || 0}/${Number(clauses.total) || 0}`;
    els.clausesSub.textContent = `${Number(clauses.missing) || 0} missing`;

    // Summary
    els.summaryBanner.textContent = toDisplay(summary);

    // Top findings (critical + high only)
    const topF = findings.filter(f => f.severity === 'critical' || f.severity === 'high');
    els.topFindings.innerHTML = topF.length
      ? topF.map(renderFinding).join('')
      : '<div class="empty-state">No critical or high-severity findings.</div>';

    // Missing clauses
    const missing = warnings.filter(w => w.startsWith('Missing required'));
    els.missingClauses.innerHTML = missing.length
      ? missing.map(w => `<div class="warning-item"><span class="warning-icon">⚠️</span> ${w}</div>`).join('')
      : '<div class="empty-state">All required clauses detected.</div>';

    // All findings
    renderFilteredFindings();

    // Clauses
    renderFilteredClauses();

    // Statutes
    renderStatutes(findings, clauses);

    // Redlines
    renderRedlines(report.redlines || []);

    // Stats sidebar
    els.statGrid.innerHTML = `
      <div class="stat-item"><div class="stat-value critical">${Number(compliance.critical) || 0}</div><div class="stat-label">Critical</div></div>
      <div class="stat-item"><div class="stat-value high">${Number(compliance.high) || 0}</div><div class="stat-label">High</div></div>
      <div class="stat-item"><div class="stat-value medium">${Number(compliance.medium) || 0}</div><div class="stat-label">Medium</div></div>
      <div class="stat-item"><div class="stat-value">${Number(clauses.found) || 0}</div><div class="stat-label">Clauses</div></div>
    `;

    // Footer
    const now = new Date();
    els.footerMeta.textContent = `Analyzed: ${now.toLocaleString()} · ${report.documentInfo?.name || 'Unknown'}`;

    // Scroll to results
    els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderSevBar(label, count, cls) {
    const n = Number(count) || 0; // coerce object/string counts to a number
    const max = Math.max(
      Number(report.compliance.critical) || 0,
      Number(report.compliance.high) || 0,
      Number(report.compliance.medium) || 0,
      1
    );
    const pct = Math.min(100, Math.max(0, (n / max) * 100));
    return `
      <div class="sev-bar">
        <span class="sev-bar-label">${label}</span>
        <div class="sev-bar-track"><div class="sev-bar-fill ${cls}" style="width:${pct}%"></div></div>
        <span class="sev-bar-count">${n}</span>
      </div>`;
  }

  function renderFinding(f) {
    const s = SEV[f.severity] || SEV.medium;
    return `
      <div class="finding-card ${f.severity}">
        <div class="finding-header">
          <span class="finding-sev-badge ${f.severity}">${s.icon} ${s.label}</span>
          <span class="finding-title">${f.title}</span>
          <span class="finding-id">${f.id}</span>
        </div>
        <div class="finding-desc">${f.finding}</div>
        <div class="finding-cite">"${f.citation}"</div>
        <div class="finding-statute">
          <span>⚖️</span>
          <span class="finding-statute-code">VA § ${f.statute}</span>
          <span>—</span>
          <span>${f.statuteText || ''}</span>
        </div>
      </div>`;
  }

  function renderFilteredFindings() {
    if (!report) return;
    const findings = report.findings.filter(f => findingFilters[f.severity]);
    els.allFindings.innerHTML = findings.length
      ? findings.map(renderFinding).join('')
      : '';
    els.findingsEmpty.style.display = findings.length ? 'none' : 'block';
  }

  function renderFilteredClauses() {
    if (!report) return;
    const clauses = report.clauses.details.filter(c => {
      if (c.found && clauseFilters.found) return true;
      if (!c.found && clauseFilters.missing) return true;
      return false;
    });

    els.clauseList.innerHTML = clauses.map(c => `
      <div class="clause-card ${c.found ? '' : 'missing'}">
        <div class="clause-header">
          <span class="clause-name">${c.name.replace(/_/g, ' ')}</span>
          <span class="clause-status ${c.found ? 'found' : 'missing'}">${c.found ? '✓ Detected' : '✗ Missing'}</span>
        </div>
        <div class="clause-statute">VA § ${c.statute}</div>
        <div class="clause-statute-title">${c.statuteTitle || ''}</div>
        ${c.context ? `<div class="clause-context">${escapeHtml(c.context.substring(0, 200))}</div>` : ''}
      </div>`).join('');
  }

  function renderStatutes(findings, clauses) {
    // Collect all cited statutes from findings + clauses
    const statutes = new Map();
    (findings || []).forEach(f => {
      if (!f.statute) return; // guard: finding with no statute code
      statutes.set(f.statute, { code: f.statute, title: f.statuteText || '', relevant: true, summary: f.statuteText || '' });
    });
    (clauses?.details || []).forEach(c => {
      if (!c.statute) return; // guard: clause detail with no statute code
      if (!statutes.has(c.statute)) {
        statutes.set(c.statute, { code: c.statute, title: c.statuteTitle || '', relevant: c.found, summary: c.statuteTitle || '' });
      }
    });

    const sorted = Array.from(statutes.values()).sort((a, b) => String(a.code).localeCompare(String(b.code)));
    els.statuteList.innerHTML = sorted.map(s => `
      <div class="statute-card ${s.relevant ? 'relevant' : ''}">
        <div class="statute-code">§ ${s.code}</div>
        <div class="statute-info">
          <div class="statute-title">${s.title}</div>
          <div class="statute-summary">${s.summary}</div>
        </div>
      </div>`).join('');
  }

  /* ── Redline View — White Page Document ── */
  let redlineViewMode = 'redline'; // 'redline' | 'final'
  let acceptedRedlines = new Set();
  let rejectedRedlines = new Set();

  // Extract document title from the input text
  function getDocTitle() {
    // First try to extract from the document text itself (first heading line)
    if (report && report.documentInfo?.rawText) {
      const text = report.documentInfo.rawText;
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        // Match common contract title patterns
        if (/^(COMMERCIAL\s+LEASE|LEASE\s+AGREEMENT|RENTAL\s+AGREEMENT|RESIDENTIAL\s+LEASE|OFFICE\s+LEASE|INDUSTRIAL\s+LEASE|RETAIL\s+LEASE|TRIPLE\s+NET|GROUND\s+LEASE|SERVICE\s+(?:AGREEMENT|CONTRACT)|PARTNERSHIP\s+AGREEMENT|ARTICLES\s+OF\s+(?:INCORPORATION|ORGANIZATION)|NON.?DISCLOSURE\s+AGREEMENT|CONFIDENTIALITY\s+AGREEMENT|EMPLOYMENT\s+AGREEMENT|INDEPENDENT\s+CONTRACTOR\s+AGREEMENT|CONSULTING\s+AGREEMENT|MASTER\s+SERVICE\s+AGREEMENT)/i.test(trimmed)) {
          return trimmed.toUpperCase();
        }
      }
    }
    // Fallback: use document name from metadata
    if (report && report.documentInfo?.name) {
      const name = report.documentInfo.name;
      const clean = name.replace(/\.\w+$/, '').replace(/[_-]/g, ' ');
      if (clean.length >= 5 && clean !== clean.toLowerCase()) return clean.toUpperCase();
    }
    return 'REDLINED LEASE AGREEMENT';
  }

  // Render structured tables + images extracted from the uploaded file.
  // Returns HTML string (empty if no structured content). Tables render as
  // real <table> with headers; images render as <img> with base64 data URIs.
  function renderStructuredContent() {
    const ext = report?.documentInfo?.extraction;
    if (!ext) return '';
    const tables = ext.tables || [];
    const images = ext.images || [];
    if (tables.length === 0 && images.length === 0) return '';

    let html = '<div class="structured-content" style="margin:16px 0;">';
    for (const t of tables) {
      if (!t.headers || t.headers.length === 0) continue;
      html += '<table class="structured-table" style="width:100%;border-collapse:collapse;margin:8px 0;font-size:13px;">';
      html += '<thead><tr>' + t.headers.map(h => `<th style="border:1px solid #444;padding:6px 8px;background:#1a2233;text-align:left;">${escapeHtml(h)}</th>`).join('') + '</tr></thead>';
      html += '<tbody>';
      for (const row of t.rows) {
        html += '<tr>' + t.headers.map(h => `<td style="border:1px solid #444;padding:6px 8px;">${escapeHtml(row[h] ?? '')}</td>`).join('') + '</tr>';
      }
      html += '</tbody></table>';
    }
    for (const img of images) {
      const src = img.dataUrl || (img.base64 ? `data:${img.mimeType || 'image/png'};base64,${img.base64}` : '');
      if (src) {
        html += `<div class="structured-image" style="margin:8px 0;text-align:center;"><img src="${src}" alt="embedded image" style="max-width:100%;max-height:400px;border:1px solid #444;border-radius:4px;" /></div>`;
      }
    }
    html += '</div>';
    return html;
  }

  function renderRedlines(redlines) {
    const list = document.getElementById('redlineList');
    const empty = document.getElementById('redlineEmpty');
    if (!list) return;

    const docTitle = getDocTitle();
    const rawText = report?.documentInfo?.rawText || '';
    const redlinedHtml = report?.redlinedHtml || '';

    // Structured content (tables + images) from the extraction layer.
    // Rendered as real HTML tables and <img> tags so column-aware math
    // and visual content (floor plans, charts) survive to the redline/export.
    const structuredHtml = renderStructuredContent();

    // Always show the document, even if no redlines
    if (!redlines || redlines.length === 0) {
      list.style.display = 'flex';
      if (empty) empty.style.display = 'none';
      list.innerHTML = `
        <div class="redline-doc">
          <div class="redline-doc-title">${docTitle}</div>
          <div class="redline-doc-meta">Compliance Grade: ${report?.compliance?.grade || 'N/A'} · Score: ${report?.compliance?.score || '—'}/100 · No corrections needed · ${new Date().toLocaleDateString()}</div>
          ${structuredHtml}
          <div class="doc-full-text" contenteditable="true" spellcheck="true">${escapeHtml(rawText)}</div>
        </div>
      `;
      return;
    }

    if (empty) empty.style.display = 'none';
    list.style.display = 'flex';

    const acceptedCount = acceptedRedlines.size;
    const rejectedCount = rejectedRedlines.size;
    const pendingCount = redlines.length - acceptedCount - rejectedCount;

    // Status bar
    const statusBar = `
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px;padding:10px 16px;background:var(--bg-card,#141a28);border:1px solid var(--border-default,rgba(201,169,110,0.15));border-radius:8px;font-size:13px;">
        <span style="color:#22c55e;font-weight:600;">✓ ${acceptedCount} Accepted</span>
        <span style="color:#6b7280;">|</span>
        <span style="color:#ef4444;font-weight:600;">✗ ${rejectedCount} Rejected</span>
        <span style="color:#6b7280;">|</span>
        <span style="color:#9aa0ab;">⏳ ${pendingCount} Pending</span>
        <span style="flex:1;"></span>
        <span style="color:var(--text-dim);font-size:12px;">${redlines.length} total corrections</span>
      </div>
    `;

    if (redlineViewMode === 'final') {
      // Build the final document from the redlinedHtml
      let finalHtml = redlinedHtml || rawText;
      for (const r of redlines) {
        const suggested = r._editedText || r.suggested_text || '';
        const original = r.original_text || '';
        const sevClass = r.severity || 'medium';
        const comment = r.comment || '';
        const statute = r.statute || '';
        const escOrig = escapeHtml(original);
        const escSugg = escapeHtml(suggested);
        const escComment = escapeHtml(comment);
        const diffPattern = `<span class="severity-mark ${sevClass}"></span><del>${escOrig}</del><ins>${escSugg}</ins><span class="statute-ref">VA § ${statute}</span><span class="clause-controls"><button class="accept-btn" data-action="accept" data-id="${r.id}">✓ Accept</button><button class="reject-btn" data-action="reject" data-id="${r.id}">✗ Reject</button><button class="edit-btn" data-action="edit" data-id="${r.id}">✎ Edit</button></span>${comment ? `<div class="margin-comment"><strong>⚠️ VA ${statute}:</strong> ${escComment}</div>` : ''}`;

        const useSuggested = acceptedRedlines.has(r.id);
        const useOriginal = rejectedRedlines.has(r.id);
        const replacement = useSuggested ? suggested : (useOriginal ? original : suggested);

        if (finalHtml.includes(diffPattern)) {
          finalHtml = finalHtml.replace(diffPattern, replacement);
        } else {
          const idMarker = `data-id="${r.id}"`;
          const idIdx = finalHtml.indexOf(idMarker);
          if (idIdx === -1) continue;
          const blockStart = finalHtml.lastIndexOf('<span class="severity-mark', idIdx);
          if (blockStart === -1) continue;
          const controlsClose = finalHtml.indexOf('</span>', finalHtml.indexOf('</button></span>', idIdx));
          if (controlsClose === -1) continue;
          let blockEnd = controlsClose + 7;
          const afterBlock = finalHtml.substring(blockEnd, blockEnd + 100);
          if (afterBlock.startsWith('<div class="margin-comment">')) {
            blockEnd = finalHtml.indexOf('</div>', blockEnd) + 6;
          }
          const diffBlock = finalHtml.substring(blockStart, blockEnd);
          finalHtml = finalHtml.replace(diffBlock, replacement);
        }
      }

      const cleanText = finalHtml.replace(/<[^>]*>/g, '');
      list.innerHTML = `
        ${statusBar}
        <div class="redline-doc final-view">
          <div class="redline-doc-title">${docTitle}</div>
          <div class="redline-doc-meta">Final Version — ${acceptedCount} of ${redlines.length} corrections applied · ${new Date().toLocaleDateString()}</div>
          ${structuredHtml}
          <div class="doc-full-text">${escapeHtml(cleanText)}</div>
          <div style="text-align:center;margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb;">
            <button class="btn btn-secondary" id="btnDownloadFinalPdf" style="font-size:14px;padding:8px 20px;">📄 Download as PDF</button>
            <button class="btn btn-secondary" id="btnDownloadFinalTxt" style="font-size:14px;padding:8px 20px;margin-left:8px;">📥 Download as .txt</button>
          </div>
        </div>
      `;
      setTimeout(() => {
        const pdfBtn = document.getElementById('btnDownloadFinalPdf');
        if (pdfBtn) {
          pdfBtn.addEventListener('click', () => {
            const printWindow = window.open('', '_blank');
            const printStructured = renderStructuredContent();
            printWindow.document.write(`<!DOCTYPE html><html><head><title>${docTitle}</title>
              <style>
                body{font-family:'Times New Roman',serif;font-size:14pt;line-height:2;padding:2in;color:#000;max-width:8.5in;margin:0 auto;}
                h1{text-align:center;font-size:18pt;border-bottom:2px solid #000;padding-bottom:12pt;margin-bottom:24pt;}
                .meta{text-align:center;font-size:10pt;color:#666;margin-bottom:24pt;}
                pre{white-space:pre-wrap;font-family:'Times New Roman',serif;font-size:14pt;line-height:2;margin:0;}
                table.structured-table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12pt;}
                table.structured-table th,table.structured-table td{border:1px solid #333;padding:6px 8px;text-align:left;}
                table.structured-table th{background:#f0f0f0;font-weight:bold;}
                .structured-image{text-align:center;margin:12px 0;}
                .structured-image img{max-width:100%;max-height:500px;border:1px solid #ccc;}
                @media print{body{padding:0.5in;}h1{font-size:16pt;}pre{font-size:12pt;}}
              </style>
            </head><body>
              <h1>${docTitle}</h1>
              <div class="meta">Final Version — ${acceptedCount} of ${redlines.length} corrections applied · ${new Date().toLocaleDateString()}</div>
              ${printStructured || ''}
              <pre>${escapeHtml(cleanText)}</pre>
            </body></html>`);
            printWindow.document.close();
            printWindow.focus();
            printWindow.print();
          });
        }
        const txtBtn = document.getElementById('btnDownloadFinalTxt');
        if (txtBtn) {
          txtBtn.addEventListener('click', () => {
            const blob = new Blob([cleanText], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${docTitle.replace(/[^a-zA-Z0-9_-]/g, '_')}_final.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          });
        }
      }, 100);
      return;
    }

    // Redline view: use redlinedHtml with visibility toggling
    // The redlinedHtml has exact text from the document with diff markup
    // We wrap each diff block in a container with data-id for CSS toggling
    let displayHtml = redlinedHtml || rawText;
    
    if (redlinedHtml) {
      // Wrap each diff block in a span with data-id for visibility control
      let wrapped = redlinedHtml;
      for (const r of redlines) {
        const id = r.id;
        const isAccepted = acceptedRedlines.has(id);
        const isRejected = rejectedRedlines.has(id);
        
        // Find the diff block by looking for the data-id in the clause-controls
        const idMarker = `data-id="${id}"`;
        const idIdx = wrapped.indexOf(idMarker);
        if (idIdx === -1) continue;
        
        // Find the start of the diff block (the severity-mark span before the del)
        const blockStart = wrapped.lastIndexOf('<span class="severity-mark', idIdx);
        if (blockStart === -1) continue;
        
        // Find the end: after clause-controls </span>, possibly followed by margin-comment </div>
        const controlsClose = wrapped.indexOf('</span>', wrapped.indexOf('</button></span>', idIdx));
        if (controlsClose === -1) continue;
        let blockEnd = controlsClose + 7;
        const afterBlock = wrapped.substring(blockEnd, blockEnd + 100);
        if (afterBlock.startsWith('<div class="margin-comment">')) {
          blockEnd = wrapped.indexOf('</div>', blockEnd) + 6;
        }
        
        const diffBlock = wrapped.substring(blockStart, blockEnd);
        const displayStyle = isRejected ? 'display:none;' : '';
        const acceptedBadge = isAccepted ? '<span style="color:#22c55e;font-size:11px;font-weight:600;margin-left:8px;">✓ Accepted</span>' : '';
        const wrappedBlock = `<span class="diff-block" data-id="${id}" style="${displayStyle}">${diffBlock}${acceptedBadge}</span>`;
        wrapped = wrapped.replace(diffBlock, wrappedBlock);
      }
      displayHtml = wrapped;
    } else {
      // Fallback: build from rawText
      let docHtml = rawText;
      for (const r of redlines) {
        const isAccepted = acceptedRedlines.has(r.id);
        const isRejected = rejectedRedlines.has(r.id);
        if (isRejected) continue;

        const original = r.original_text || '';
        const suggested = r._editedText || r.suggested_text || '';
        const comment = r.comment || '';
        const statute = r.statute || '';
        const sevClass = r.severity || 'medium';

        const statusBadge = isAccepted ? '<span style="color:#22c55e;font-size:11px;font-weight:600;margin-left:8px;">✓ Accepted</span>' : '';
        const diffHtml = `<span class="severity-mark ${sevClass}"></span><del>${escapeHtml(original)}</del><ins>${escapeHtml(suggested)}</ins><span class="statute-ref">VA § ${statute}</span><span class="clause-controls"><button class="accept-btn" data-action="accept" data-id="${r.id}">✓ Accept</button><button class="reject-btn" data-action="reject" data-id="${r.id}">✗ Reject</button><button class="edit-btn" data-action="edit" data-id="${r.id}">✎ Edit</button></span>${statusBadge}${comment ? `<div class="margin-comment"><strong>⚠️ ${statute ? 'VA ' + statute : 'Note'}:</strong> ${escapeHtml(comment)}</div>` : ''}`;

        const idx = docHtml.indexOf(original);
        if (idx >= 0) {
          docHtml = docHtml.substring(0, idx) + diffHtml + docHtml.substring(idx + original.length);
        }
      }
      displayHtml = docHtml;
    }
    
    list.innerHTML = `
      ${statusBar}
      <div class="redline-doc">
        <div class="redline-doc-title">${docTitle}</div>
        <div class="redline-doc-meta">Compliance Grade: ${report?.compliance?.grade || 'N/A'} · Score: ${report?.compliance?.score || '—'}/100 · ${redlines.length} corrections needed · ${new Date().toLocaleDateString()}</div>
        ${structuredHtml}
        <div class="doc-full-text" contenteditable="true" spellcheck="true">${displayHtml}</div>
      </div>
    `;

    // Wire up button handlers
    list.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.dataset.id;
        const action = e.target.dataset.action;
        const idx = (report.redlines || []).findIndex(r => r.id === id);
        if (idx === -1) return;

        if (action === 'accept') {
          acceptedRedlines.add(id);
          rejectedRedlines.delete(id);
          renderRedlines(report.redlines);
        } else if (action === 'reject') {
          rejectedRedlines.add(id);
          acceptedRedlines.delete(id);
          renderRedlines(report.redlines);
        } else if (action === 'edit') {
          const insEl = e.target.closest('.doc-clause')?.querySelector('ins') || e.target.parentElement?.parentElement?.querySelector('ins');
          if (insEl) {
            insEl.setAttribute('contenteditable', 'true');
            insEl.focus();
            insEl.style.outline = '2px dashed #c9a96e';
            insEl.style.outlineOffset = '2px';
            insEl.addEventListener('blur', () => {
              insEl.removeAttribute('contenteditable');
              insEl.style.outline = '';
              report.redlines[idx]._editedText = insEl.textContent;
            }, { once: true });
          }
        }
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     TABS
     ═══════════════════════════════════════════════════════════════════════════ */
  els.tabNav.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    activeTab = btn.dataset.tab;
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    $$('.tab-content').forEach(t => t.classList.toggle('active', t.id === `tab-${activeTab}`));
  });

  /* ── Filter Events ── */
  $$('.filter-chip[data-sev]').forEach(chip => {
    chip.addEventListener('change', (e) => {
      const sev = e.target.closest('.filter-chip').dataset.sev.toLowerCase();
      findingFilters[sev] = e.target.checked;
      renderFilteredFindings();
    });
  });

  $$('.filter-chip[data-clause]').forEach(chip => {
    chip.addEventListener('change', (e) => {
      const type = e.target.closest('.filter-chip').dataset.clause;
      clauseFilters[type] = e.target.checked;
      renderFilteredClauses();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     DOWNLOAD
     ═══════════════════════════════════════════════════════════════════════════ */
  els.btnDownloadReport.addEventListener('click', () => {
    if (!report) return;
    download('lease-analysis-report.json', JSON.stringify(report, null, 2), 'application/json');
  });

  els.btnDownloadMd.addEventListener('click', () => {
    if (!report) return;
    download('lease-analysis-report.md', generateMd(report), 'text/markdown');
  });

  // DOCX Redline Export
  document.getElementById('btnExportRedlineDocx').addEventListener('click', async () => {
    if (!report || !report.redlines || !report.redlines.length) {
      alert('No redlines to export. Run an analysis with violations first.');
      return;
    }
    try {
      const resp = await fetch(`/api/v1/functions/docx-redline`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': sessionStorage.getItem(SESSION_KEY) || '',
        },
        body: JSON.stringify({
          redlines: report.redlines,
          redlinedHtml: report.redlinedHtml || '',
          metadata: {
            documentName: report.documentInfo?.name || 'redlined_lease',
            jurisdiction: 'Virginia',
            grade: report.compliance?.grade || 'N/A',
          },
          structuredData: {
            tables: report.documentInfo?.extraction?.tables || [],
            images: report.documentInfo?.extraction?.images || [],
            rawText: report.documentInfo?.rawText || '',
          },
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(report.documentInfo?.name || 'redlined_lease').replace(/[^a-zA-Z0-9_-]/g, '_')}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Failed to export DOCX: ' + e.message);
    }
  });

  // Final DOCX Export — clean document with accepted changes applied
  document.getElementById('btnExportFinalDocx').addEventListener('click', async () => {
    if (!report) return;
    const rawText = report?.documentInfo?.rawText || '';
    const redlines = report?.redlines || [];
    const accepted = new Set(acceptedRedlines);
    const rejected = new Set(rejectedRedlines);

    // Build the final text: for accepted/unactioned use suggested, for rejected keep original
    let finalText = rawText;
    for (const r of redlines) {
      const original = r.original_text || '';
      const suggested = r._editedText || r.suggested_text || '';
      if (rejected.has(r.id)) continue;
      finalText = finalText.split(original).join(suggested);
    }

    try {
      const resp = await fetch(`/api/v1/functions/docx-redline`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': sessionStorage.getItem(SESSION_KEY) || '',
        },
        body: JSON.stringify({
          action: 'final',
          fullText: finalText,
          metadata: {
            documentName: report.documentInfo?.name || 'final_document',
            acceptedCount: accepted.size,
            totalCount: redlines.length,
          },
          structuredData: {
            tables: report.documentInfo?.extraction?.tables || [],
            images: report.documentInfo?.extraction?.images || [],
            rawText: report.documentInfo?.rawText || '',
          },
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(report.documentInfo?.name || 'final_document').replace(/[^a-zA-Z0-9_-]/g, '_')}_final.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Failed to export Final DOCX: ' + e.message);
    }
  });

  // PDF Redline Export — opens print dialog for Save as PDF
  document.getElementById('btnExportRedlinePdf').addEventListener('click', () => {
    if (!report) return;
    const docTitle = getDocTitle();
    const rawText = report?.documentInfo?.rawText || '';
    const redlines = report?.redlines || [];
    const accepted = new Set(acceptedRedlines);
    const rejected = new Set(rejectedRedlines);

    // Build the final text: for accepted/unactioned use suggested, for rejected keep original
    let finalText = rawText;
    for (const r of redlines) {
      const original = r.original_text || '';
      const suggested = r._editedText || r.suggested_text || '';
      if (rejected.has(r.id)) continue; // keep original
      finalText = finalText.split(original).join(suggested);
    }

    const printWindow = window.open('', '_blank');
    const printStructured = renderStructuredContent();
    printWindow.document.write(`<!DOCTYPE html><html><head><title>${docTitle}</title>
      <style>
        body{font-family:'Times New Roman',serif;font-size:14pt;line-height:2;padding:2in;color:#000;max-width:8.5in;margin:0 auto;}
        h1{text-align:center;font-size:18pt;border-bottom:2px solid #000;padding-bottom:12pt;margin-bottom:24pt;}
        .meta{text-align:center;font-size:10pt;color:#666;margin-bottom:24pt;}
        pre{white-space:pre-wrap;font-family:'Times New Roman',serif;font-size:14pt;line-height:2;margin:0;}
        table.structured-table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12pt;}
        table.structured-table th,table.structured-table td{border:1px solid #333;padding:6px 8px;text-align:left;}
        table.structured-table th{background:#f0f0f0;font-weight:bold;}
        .structured-image{text-align:center;margin:12px 0;}
        .structured-image img{max-width:100%;max-height:500px;border:1px solid #ccc;}
        .redline-del{text-decoration:line-through;color:#c00;}
        .redline-ins{text-decoration:underline;color:#00c;}
        .redline-mark{background:#ff0;padding:0 2px;}
        @media print{body{padding:0.5in;}h1{font-size:16pt;}pre{font-size:12pt;}}
      </style>
    </head><body>
      <h1>${docTitle}</h1>
      <div class="meta">Compliance Grade: ${report?.compliance?.grade || 'N/A'} · Score: ${report?.compliance?.score || '—'}/100 · ${accepted.size} of ${redlines.length} corrections applied · ${new Date().toLocaleDateString()}</div>
      ${printStructured || ''}
      <pre>${report?.redlinedHtml ? report.redlinedHtml.replace(/\u003cspan class="clause-controls"[^\u003e]*\u003e[\s\S]*?\u003c\/span\u003e/gi, '').replace(/\u003cspan class="severity-mark[^"]*"[^\u003e]*\u003e\u003c\/span\u003e/gi, '').replace(/\u003cdiv class="margin-comment[^"]*"[^\u003e]*\u003e[\s\S]*?\u003c\/div\u003e/gi, '').replace(/\u003cbutton[^\u003e]*\u003e[\s\S]*?\u003c\/button\u003e/gi, '') : escapeHtml(finalText)}</pre>
    </body></html>`);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 500);
  });

  // JSON Redline Export
  document.getElementById('btnExportRedlineJson').addEventListener('click', () => {
    if (!report || !report.redlines) {
      alert('No redlines to export.');
      return;
    }
    download('redlines.json', JSON.stringify({
      document: report.documentInfo,
      compliance: report.compliance,
      redlines: report.redlines,
    }, null, 2), 'application/json');
  });

  // Toggle between redline view and final document view
  document.getElementById('btnRedlineToggle').addEventListener('click', (e) => {
    redlineViewMode = redlineViewMode === 'redline' ? 'final' : 'redline';
    e.target.textContent = redlineViewMode === 'redline' ? '👁️ Show Final' : '✏️ Show Redlines';
    if (report && report.redlines) {
      renderRedlines(report.redlines);
    }
  });

  // Apply All
  document.getElementById('btnApplyAll').addEventListener('click', () => {
    if (!report || !report.redlines) return;
    report.redlines.forEach(r => {
      acceptedRedlines.add(r.id);
      rejectedRedlines.delete(r.id);
    });
    renderRedlines(report.redlines);
  });

  // Reject All
  document.getElementById('btnRejectAll').addEventListener('click', () => {
    if (!report || !report.redlines) return;
    report.redlines.forEach(r => {
      rejectedRedlines.add(r.id);
      acceptedRedlines.delete(r.id);
    });
    renderRedlines(report.redlines);
  });

  function generateMd(r) {
    let md = `# Elze Contract Analyzer™ — Lease Compliance Report\n\n`;
    md += `**Document:** ${r.documentInfo?.name || 'Unknown'}\n`;
    md += `**Analyzed:** ${r.analyzedAt || new Date().toISOString()}\n`;
    md += `**Compliance Score:** ${r.compliance.score}/100 (Grade ${r.compliance.grade})\n\n`;
    md += `## Summary\n\n${toDisplay(r.summary)}\n\n`;
    md += `## Findings (${r.findings.length})\n\n`;
    r.findings.forEach(f => {
      md += `### [${f.severity.toUpperCase()}] ${f.title}\n\n`;
      md += `- **Rule:** ${f.id}\n`;
      md += `- **Statute:** VA § ${f.statute} — ${f.statuteText}\n`;
      md += `- **Finding:** ${f.finding}\n`;
      md += `- **Citation:** "${f.citation}"\n\n`;
    });
    md += `## Missing Clauses\n\n`;
    r.warnings.filter(w => w.startsWith('Missing')).forEach(w => {
      md += `- ${w}\n`;
    });
    md += `\n---\n© 2026 Cuttlefish Labs. All rights reserved.\n`;
    return md;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     UTILITIES
     ═══════════════════════════════════════════════════════════════════════════ */
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Coerce any value (string, number, object, array) to a safe display string.
  // Prevents "[object Object]" from leaking into the UI when the backend
  // returns an object where a plain string is expected (e.g. `summary`).
  function toDisplay(val, fallback = '') {
    if (val === null || val === undefined) return fallback;
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (Array.isArray(val)) return val.map(v => toDisplay(v, '')).join(', ');
    // object (including plain objects) — JSON-stringify if possible, else fallback
    try {
      const s = JSON.stringify(val);
      return (s && s !== '{}' && s !== '[]') ? s : fallback;
    } catch { return fallback; }
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ── Sidebar Toggle (mobile) ── */
  els.sidebarToggle.addEventListener('click', () => {
    els.sidebar.classList.toggle('mobile-open');
  });

})();