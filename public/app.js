const root = document.getElementById('app');

const state = {
  files: [],
  analysis: null,
  isAnalyzing: false,
  showExample: false
};

renderApp();

function renderApp() {
  root.innerHTML = `
    <div class="app-shell">
      ${uploadSectionMarkup()}
      ${state.analysis ? analysisSectionMarkup(state.analysis) : ''}
    </div>
    ${state.showExample ? exampleModalMarkup() : ''}
  `;

  bindUploadControls();
  bindAnalyzeControls();
  bindExampleControls();
}

function uploadSectionMarkup() {
  const hasFiles = state.files.length > 0;
  return `
    <section class="intake">
      <header class="hero-copy">
        <h1>See if your experience builds confidence or triggers red flags.</h1>
        <p class="hero-subtitle">I review your screens and return a scorecard with the top risks, one rewired hero rewrite, and a CSS tweak you can ship today.</p>
      </header>
      <ol class="progress-hint" aria-label="Upload progress">
        <li class="${hasFiles ? 'complete' : 'active'}">Upload</li>
        <li class="${state.isAnalyzing ? 'active' : hasFiles ? '' : ''}">Analyze</li>
        <li class="${state.analysis ? 'complete' : ''}">Fixes</li>
      </ol>
      <div class="intake-card drop-zone" data-role="dropzone">
        <div class="drop-inner">
          <button type="button" class="secondary-button" data-action="trigger-upload">Drop or select screenshots</button>
          <p class="drop-hint">PNG, JPG, or PDF. Up to 6 files.</p>
          <input type="file" accept="image/*,.pdf" multiple hidden data-role="file-input">
          <div class="file-preview" id="file-preview">${renderFileList()}</div>
        </div>
      </div>
      <div class="intake-actions">
        <button type="button" class="example-chip" data-action="open-example">See an example</button>
        <button type="button" id="analyze-btn" class="primary-button" ${hasFiles && !state.isAnalyzing ? '' : 'disabled'}>${state.isAnalyzing ? 'Analyzing…' : 'Analyze'}</button>
      </div>
      <p class="privacy-note">Screenshots analyzed once, not stored. Local OCR by default; AI analysis only if you opt in.</p>
    </section>
  `;
}

function analysisSectionMarkup(analysis) {
  const { scores, flags, freeRewrite, freeCss, lockedInsights, builderActions, experiments, checklist } = analysis;
  return `
    <section class="analysis" aria-live="polite">
      <div class="scorecard">
        ${renderScore('Confidence', scores.confidence)}
        ${renderScore('Pushiness', scores.pushiness)}
        ${renderScore('Clarity', scores.clarity)}
      </div>
      <div class="flags">
        <h2>Top risks</h2>
        <div class="flag-grid">
          ${flags.map(renderFlagCard).join('')}
        </div>
      </div>
      <div class="free-fixes">
        ${renderRewriteCard(freeRewrite)}
        ${renderCssCard(freeCss)}
      </div>
      ${lockedInsights && lockedInsights.length ? lockedBlockMarkup(lockedInsights) : ''}
      ${renderExtras(builderActions, experiments, checklist)}
    </section>
  `;
}

function lockedBlockMarkup(lockedInsights) {
  return `
    <div class="locked-block">
      <div class="locked-overlay"></div>
      <div class="locked-content">
        <h3>Unlock the full build plan</h3>
        <ul>${lockedInsights
          .map((item) => `<li><strong>${item.title}</strong><span>${item.summary}</span></li>`)
          .join('')}</ul>
        <button type="button" class="primary-button locked-cta" disabled>Generate full build plan ($7/mo)</button>
      </div>
    </div>
  `;
}

function renderScore(label, value) {
  const pct = clampScore(value);
  return `
    <div class="score">
      <div class="score-label">${label}</div>
      <div class="score-value">${pct}</div>
      <div class="score-bar"><span style="width:${pct}%"></span></div>
    </div>
  `;
}

function renderFlagCard(flag) {
  return `
    <article class="flag-card">
      <h3>${flag.title}</h3>
      <p>${flag.detail}</p>
      <footer>${flag.evidence}</footer>
    </article>
  `;
}

function renderRewriteCard(rewrite) {
  return `
    <article class="fix-card">
      <header>Free rewrite</header>
      <div class="rewrite-block">
        <div>
          <span class="fix-label">Before</span>
          <p>${rewrite.before}</p>
        </div>
        <div>
          <span class="fix-label">After</span>
          <p>${rewrite.after}</p>
        </div>
      </div>
      ${rewrite.rationale ? `<p class="rationale">${rewrite.rationale}</p>` : ''}
    </article>
  `;
}

function renderCssCard(css) {
  return `
    <article class="fix-card">
      <header>Free CSS tweak</header>
      <div class="css-block">
        <code>${css.selector}</code>
        <pre>${css.change}</pre>
      </div>
      ${css.rationale ? `<p class="rationale">${css.rationale}</p>` : ''}
    </article>
  `;
}

function renderExtras(builderActions, experiments, checklist) {
  const sections = [];
  if (builderActions && builderActions.length) {
    sections.push(`
      <section class="extras">
        <h3>Builder pointers</h3>
        <ul>${builderActions.map((item) => `<li><strong>${item.title}</strong><span>${item.detail}</span></li>`).join('')}</ul>
      </section>
    `);
  }
  if (experiments && experiments.length) {
    sections.push(`
      <section class="extras">
        <h3>Experiments</h3>
        <ul>${experiments.map((item) => `<li>${item}</li>`).join('')}</ul>
      </section>
    `);
  }
  if (checklist && checklist.length) {
    sections.push(`
      <section class="extras">
        <h3>Checklist</h3>
        <ul>${checklist.map((item) => `<li>${item}</li>`).join('')}</ul>
      </section>
    `);
  }
  return sections.join('');
}

function renderFileList() {
  if (state.files.length === 0) {
    return '<p class="empty">No files yet.</p>';
  }
  return state.files
    .map(
      (file, index) => `
        <div class="file-item">
          <strong>${file.name}</strong>
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
      <div class="modal" role="dialog" aria-modal="true" aria-label="Example report" data-role="modal">
        <button type="button" class="modal-close" data-action="close-example">×</button>
        <h2>Sample scorecard preview</h2>
        <img src="/example-report.png" alt="Sample AI Trust report" />
      </div>
    </div>
  `;
}

function bindUploadControls() {
  const dropzone = root.querySelector('.drop-zone');
  const fileInput = root.querySelector('[data-role="file-input"]');
  const triggerBtn = root.querySelector('[data-action="trigger-upload"]');
  const preview = root.querySelector('#file-preview');

  if (!dropzone || !fileInput) return;

  triggerBtn?.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (event) => {
    handleFiles(event.target.files);
    renderApp();
  });

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
    renderApp();
  });

  preview?.querySelectorAll('[data-action="remove-file"]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.index);
      state.files.splice(index, 1);
      renderApp();
    });
  });
}

function bindAnalyzeControls() {
  const analyzeButton = root.querySelector('#analyze-btn');
  if (analyzeButton) {
    analyzeButton.addEventListener('click', handleAnalyzeClick);
  }
}

function bindExampleControls() {
  root.querySelectorAll('[data-action="open-example"]').forEach((button) => {
    button.addEventListener('click', () => {
      state.showExample = true;
      renderApp();
    });
  });

  root.querySelectorAll('[data-action="close-example"]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      state.showExample = false;
      renderApp();
    });
  });

  const modalBackdrop = root.querySelector('.modal-backdrop');
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', (event) => {
      if (event.target === modalBackdrop) {
        state.showExample = false;
        renderApp();
      }
    });
  }
}

async function handleAnalyzeClick() {
  if (state.files.length === 0 || state.isAnalyzing) return;
  state.isAnalyzing = true;
  renderApp();

  try {
    const formData = new FormData();
    state.files.forEach((file) => formData.append('files', file, file.name));
    formData.append('prompt', '');
    formData.append('tone', 'low-tech');
    formData.append('builder', 'No builder');

    const response = await fetch('/api/analyze', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Analysis failed.');
    }

    const data = await response.json();
    state.analysis = data;
    state.files = [];
  } catch (error) {
    console.error(error);
    alert(error.message || 'Analysis failed.');
  } finally {
    state.isAnalyzing = false;
    renderApp();
  }
}

function handleFiles(fileList) {
  const accepted = Array.from(fileList || []).slice(0, 6);
  if (accepted.length === 0) return;
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
