const root = document.getElementById('app');

const state = {
  files: [],
  analysis: null,
  isAnalyzing: false,
  showExample: false,
  tone: 'low-tech', // preserved for future use
  builder: 'No builder',
  isCheckingOut: false
};

render();

function render() {
  root.innerHTML = `
    <div class="app-shell">
      ${heroMarkup()}
      ${intakeMarkup()}
      ${state.analysis ? analysisMarkup(state.analysis) : ''}
    </div>
    ${state.showExample ? exampleModalMarkup() : ''}
  `;

  bindIntakeEvents();
  bindExampleEvents();
  bindAnalysisEvents();
}

function heroMarkup() {
  return `
    <header class="hero">
      <h1>AI Trust checks if your experience builds confidence or triggers red flags.</h1>
      <p>Upload your key screens and I’ll hand back a scorecard with the riskiest friction, a rewritten headline, and a CSS tweak you can ship today.</p>
    </header>
  `;
}

function intakeMarkup() {
  const hasFiles = state.files.length > 0;
  return `
    <section class="intake" aria-label="Upload flow">
      <ol class="stepper">
        <li class="${hasFiles ? 'complete' : 'active'}">Upload</li>
        <li class="${state.isAnalyzing ? 'active' : state.analysis ? 'complete' : ''}">Analyze</li>
        <li class="${state.analysis ? 'complete' : ''}">Fixes</li>
      </ol>
      <div class="ellipse-shell drop-zone" data-role="dropzone">
        <button type="button" class="ghost-button" data-action="trigger-upload">Drop or select screenshots</button>
        <input type="file" accept="image/*,.pdf" multiple hidden data-role="file-input">
        <div class="placeholder">PNG, JPG, PDF · up to 6 files</div>
        <div class="file-preview" id="file-preview">${renderFilePreview()}</div>
      </div>
      <div class="intake-actions">
        <button type="button" class="example-chip" data-action="open-example">See an example</button>
        <button type="button" class="primary-button" id="analyze-btn" ${hasFiles && !state.isAnalyzing ? '' : 'disabled'}>${state.isAnalyzing ? 'Analyzing…' : 'Analyze'}</button>
      </div>
      <p class="privacy-note">Screenshots analyzed once, not stored. Local OCR by default; AI analysis only if you opt in.</p>
    </section>
  `;
}

function analysisMarkup(data) {
  const { scores, flags, freeRewrite, lockedInsights, builderActions, experiments, checklist } = data;
  return `
    <section class="analysis" aria-live="polite">
      <div class="scorecard">
        ${renderScore('Confidence', scores?.confidence)}
        ${renderScore('Pushiness', scores?.pushiness)}
        ${renderScore('Clarity', scores?.clarity)}
      </div>
      <div class="flags">
        <h2>Top risks</h2>
        <div class="flag-grid">
          ${Array.isArray(flags) && flags.length ? flags.map(renderFlag).join('') : '<p class="empty">No major risks detected.</p>'}
        </div>
      </div>
      <div class="free-fixes">
        ${renderRewrite(freeRewrite)}
      </div>
      ${lockedInsights && lockedInsights.length ? lockedOverlay(lockedInsights, state.isCheckingOut) : ''}
      ${renderExtras(builderActions, experiments, checklist)}
    </section>
  `;
}

function renderScore(label, value) {
  const pct = clampScore(value ?? 50);
  return `
    <article class="score">
      <header>
        <span class="score-label">${label}</span>
        <span class="score-value">${pct}</span>
      </header>
      <div class="score-bar"><span style="width:${pct}%"></span></div>
    </article>
  `;
}

function renderFlag(flag) {
  return `
    <article class="flag-card">
      <h3>${flag.title || 'Issue'}</h3>
      <p>${flag.detail || 'Needs clarification.'}</p>
      <footer>${flag.evidence || 'No evidence provided.'}</footer>
    </article>
  `;
}

function renderRewrite(rewrite = {}) {
  return `
    <article class="fix-card">
      <h3>Free rewrite</h3>
      <div class="rewrite-grid">
        <div>
          <span class="chip">Before</span>
          <p>${rewrite.before || 'Original copy unavailable.'}</p>
        </div>
        <div>
          <span class="chip">After</span>
          <p>${rewrite.after || 'Rewrite unavailable.'}</p>
        </div>
      </div>
      ${rewrite.rationale ? `<p class="rationale">${rewrite.rationale}</p>` : ''}
    </article>
  `;
}

function lockedOverlay(locked = [], isCheckingOut = false) {
  return `
    <aside class="locked-block">
      <div class="locked-overlay"></div>
      <div class="locked-content">
        <h3>Unlock the full build plan</h3>
        <ul class="locked-list">
          ${locked
            .map(
              (item) => `
                <li>
                  <span class="locked-bullet">•</span>
                  <div class="locked-text">
                    <strong>${item.title}</strong>
                    <p>${item.summary}</p>
                  </div>
                </li>
              `
            )
            .join('')}
        </ul>
        <div class="locked-actions">
          <button type="button" class="primary-button" data-action="start-checkout">
            ${isCheckingOut ? 'Redirecting…' : 'Generate full build plan ($7/mo)'}
          </button>
          <button type="button" class="secondary-button" data-action="start-test-checkout">
            Test pay (dev)
          </button>
        </div>
      </div>
    </aside>
  `;
}

function renderExtras(actions = [], experiments = [], checklist = []) {
  const sections = [];
  if (actions.length) {
    sections.push(`
      <section class="extras">
        <h3>Builder pointers</h3>
        <ul>${actions.map((item) => `<li><strong>${item.title}</strong><span>${item.detail}</span></li>`).join('')}</ul>
      </section>
    `);
  }
  if (experiments.length) {
    sections.push(`
      <section class="extras">
        <h3>Experiments</h3>
        <ul>${experiments.map((item) => `<li>${item}</li>`).join('')}</ul>
      </section>
    `);
  }
  if (checklist.length) {
    sections.push(`
      <section class="extras">
        <h3>Checklist</h3>
        <ul>${checklist.map((item) => `<li>${item}</li>`).join('')}</ul>
      </section>
    `);
  }
  return sections.join('');
}

function renderFilePreview() {
  if (!state.files.length) return '<p class="empty">No files yet.</p>';
  return state.files
    .map(
      (file, index) => `
        <div class="file-item">
          <span>${file.name}</span>
          <span>${formatFileSize(file.size)}</span>
          <button type="button" data-action="remove-file" data-index="${index}">Remove</button>
        </div>
      `
    )
    .join('');
}

function exampleModalMarkup() {
  return `
    <div class="modal-backdrop" data-action="close-example">
      <div class="modal" role="dialog" aria-modal="true">
        <button type="button" class="modal-close" data-action="close-example" aria-label="Close">×</button>
        <h2>Sample scorecard preview</h2>
        <iframe src="/api/reports/example" title="Example AI Trust report" loading="lazy"></iframe>
        <a class="example-download" href="/api/reports/example" target="_blank" rel="noopener">Open example in new tab</a>
      </div>
    </div>
  `;
}

function bindIntakeEvents() {
  const dropzone = root.querySelector('[data-role="dropzone"]');
  const fileInput = root.querySelector('[data-role="file-input"]');
  const analyzeBtn = root.querySelector('#analyze-btn');

  if (fileInput) {
    fileInput.addEventListener('change', (event) => {
      handleFiles(event.target.files);
      render();
    });
  }

  if (dropzone) {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    ['dragenter', 'dragover'].forEach((eventName) => {
      dropzone.addEventListener(eventName, () => dropzone.classList.add('dragover'));
    });
    ['dragleave', 'drop'].forEach((eventName) => {
      dropzone.addEventListener(eventName, () => dropzone.classList.remove('dragover'));
    });
    dropzone.addEventListener('drop', (event) => {
      handleFiles(event.dataTransfer.files);
      render();
    });
    const triggerUpload = dropzone.querySelector('[data-action="trigger-upload"]');
    triggerUpload?.addEventListener('click', () => fileInput?.click());
  }

  root.querySelectorAll('[data-action="remove-file"]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.index);
      state.files.splice(index, 1);
      render();
    });
  });

  analyzeBtn?.addEventListener('click', analyze);
}

function bindExampleEvents() {
  root.querySelectorAll('[data-action="open-example"]').forEach((button) => {
    button.addEventListener('click', () => {
      state.showExample = true;
      render();
    });
  });

  root.querySelectorAll('[data-action="close-example"]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      state.showExample = false;
      render();
    });
  });

  const backdrop = root.querySelector('.modal-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        state.showExample = false;
        render();
      }
    });
  }
}

function bindAnalysisEvents() {
  const checkoutButton = root.querySelector('[data-action="start-checkout"]');
  if (checkoutButton) {
    checkoutButton.addEventListener('click', startCheckout);
  }
  const testCheckoutButton = root.querySelector('[data-action="start-test-checkout"]');
  if (testCheckoutButton) {
    testCheckoutButton.addEventListener('click', startTestCheckout);
  }
}

async function analyze() {
  if (!state.files.length || state.isAnalyzing) return;

  state.isAnalyzing = true;
  render();

  try {
    const formData = new FormData();
    state.files.forEach((file) => formData.append('files', file, file.name));
    formData.append('prompt', '');
    formData.append('tone', state.tone);
    formData.append('builder', state.builder);

    const response = await fetch('/api/analyze', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Analysis failed.');
    }

    state.analysis = await response.json();
    state.files = [];
    state.isCheckingOut = false;
  } catch (error) {
    console.error(error);
    alert(error.message || 'Analysis failed.');
  } finally {
    state.isAnalyzing = false;
    render();
  }
}

function handleFiles(fileList) {
  const accepted = Array.from(fileList || []).slice(0, 6);
  if (!accepted.length) return;
  state.files = accepted;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clampScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return Math.round(num);
}

async function startCheckout(event) {
  event.preventDefault();
  if (state.isCheckingOut) return;

  try {
    state.isCheckingOut = true;
    render();

    const response = await fetch('/api/payments/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Unable to start checkout.');
    }

    const data = await response.json();
    if (data?.url) {
      window.location.href = data.url;
    } else {
      throw new Error('Checkout link unavailable.');
    }
  } catch (error) {
    console.error(error);
    state.isCheckingOut = false;
    render();
    alert(error.message || 'Unable to start checkout.');
  }
}

async function startTestCheckout(event) {
  event.preventDefault();
  if (state.isCheckingOut) return;

  try {
    state.isCheckingOut = true;
    render();

    const response = await fetch('/api/payments/test-checkout', {
      method: 'POST'
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Unable to simulate checkout.');
    }

    const data = await response.json();
    if (data?.url) {
      window.location.href = data.url;
    } else {
      throw new Error('Test checkout link unavailable.');
    }
  } catch (error) {
    console.error(error);
    state.isCheckingOut = false;
    render();
    alert(error.message || 'Unable to simulate checkout.');
  }
}
