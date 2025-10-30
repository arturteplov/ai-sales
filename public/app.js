const root = document.getElementById('app');

const dom = {
  toneSelects: [],
  builderSelects: [],
  chatTextarea: null,
  messagesBox: null,
  frictionBadge: null,
  toast: null,
  fileList: null
};

const state = {
  tone: 'low-tech',
  builder: 'No builder',
  files: [],
  conversation: [
    {
      sender: 'ai',
      text: [
        'I’m AI Sales. Share your current flow or screenshots and tell me what you’re aiming for.',
        'I will flag what creates trust, what risks scaring prospects away, and hand you builder-ready fixes.'
      ]
    }
  ],
  isConversing: false,
  lastPrompt: '',
  lastAttachments: []
};

const toneLabels = {
  'low-tech': {
    title: 'No tech vocabulary',
    subtitle: 'Everyday language only.'
  },
  'mid-tech': {
    title: 'Some tech vocabulary',
    subtitle: 'Plain language with light jargon.'
  },
  'high-tech': {
    title: 'Full tech vocabulary',
    subtitle: 'Maximum product + design vocabulary.'
  }
};

const builderPrompts = {
  'No builder':
    'Apply these changes directly in your stack: tighten the hero message, adjust spacing for clarity, restyle the primary CTA with a white background and black text, and add a short proof section below the fold to build trust.',
  Bubble:
    'In Bubble → open the hero group → enable Responsive gap 24px → replace heading with new copy → update primary button style (#FFFFFF text on #0B0B0B) → add testimonial repeating group under hero.',
  Base44:
    'In Base44 → open the landing canvas → drop in the refined hero block → adjust heading/subcopy → set primary action background to #ffffff with #030303 text → add a proof block directly beneath.',
  Webflow:
    'In Webflow → select the Hero Wrapper class → set max-width 640px & center → update copy → style CTA button with white background, black text, radius 32px → publish to staging.',
  Glide:
    'In Glide → edit Home tab → update title component → move features list above testimonials → change accent color to white button with black text under Settings → Theme.',
  Softr:
    'In Softr → swap hero block to “Modern Hero” → insert the updated copy → set primary CTA to white with black text → add client logos block below the fold.',
  Retool:
    'In Retool → open your layout → update top banner copy → adjust form label typography to 14px SemiBold → set submit button to white background, black text → add helper text per field.',
  FlutterFlow:
    'In FlutterFlow → edit Landing Screen → update AppBar text → tweak primary button style to white with black text in Theme → move KPI cards above-the-fold.',
  Adalo:
    'In Adalo → open Landing Screen → update hero headline & subcopy → style main button with white background + black text → add testimonials list below.',
  GlidePages:
    'In Glide Pages → adjust hero layout to new copy → keep CTA first with white background → add trust badges row directly beneath.'
};

function builderOptions() {
  const options = Object.keys(builderPrompts);
  return options.includes('No builder')
    ? ['No builder', ...options.filter((option) => option !== 'No builder')]
    : options;
}

renderApp();

function renderApp() {
  root.innerHTML = `
    ${state.isConversing ? conversationMarkup() : heroMarkup()}
    <div class="toast" id="toast">Copied to clipboard</div>
  `;

  dom.toast = root.querySelector('#toast');
  dom.chatTextarea = null;
  dom.messagesBox = root.querySelector('#messages');
  dom.frictionBadge = root.querySelector('#friction-badge');
  dom.fileList = root.querySelector('#file-list');
  dom.toneSelects = Array.from(root.querySelectorAll('[data-role="tone"]'));
  dom.builderSelects = Array.from(root.querySelectorAll('[data-role="builder"]'));

  const sendButtons = root.querySelectorAll('.send-button');
  sendButtons.forEach((btn) => btn.addEventListener('click', submitPrompt));

  const supportButtons = root.querySelectorAll('[data-action="support"]');
  supportButtons.forEach((btn) =>
    btn.addEventListener('click', () => showToast('support@aisales.com'))
  );

  const extensionsButtons = root.querySelectorAll('[data-action="extensions"]');
  extensionsButtons.forEach((btn) =>
    btn.addEventListener('click', () =>
      showToast('Extensions unlock builder exports and integrations · coming soon.')
    )
  );

  const copyButtons = root.querySelectorAll('[data-action="copy"]');
  copyButtons.forEach((btn) => btn.addEventListener('click', copyTailoredPrompt));

  const transcriptButtons = root.querySelectorAll('[data-action="transcript"]');
  transcriptButtons.forEach((btn) => btn.addEventListener('click', downloadTranscript));

  const buildButtons = root.querySelectorAll('[data-action="build"]');
  buildButtons.forEach((btn) => btn.addEventListener('click', requestBuild));

  dom.toneSelects.forEach((select) => {
    select.value = state.tone;
    select.addEventListener('change', (event) => setTone(event.target.value));
  });

  dom.builderSelects.forEach((select) => {
    select.value = state.builder;
    select.addEventListener('change', (event) => {
      state.builder = event.target.value;
      syncBuilderDisplay();
      showToast(`Builder set to ${state.builder}`);
    });
  });

  const attachButtons = root.querySelectorAll('.attach-button');
  attachButtons.forEach((button) => {
    const input = button.parentElement.querySelector('input[type="file"]');
    if (!input) return;
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', (event) => handleFiles(event.target.files));
  });

  const textareas = Array.from(root.querySelectorAll('.chat-textarea'));
  dom.chatTextarea = textareas[0] || null;
  textareas.forEach((textarea) => {
    textarea.addEventListener('focus', () => {
      dom.chatTextarea = textarea;
    });
    textarea.addEventListener('keydown', handleTextareaKeydown);
  });

  setupDragAndDrop();
  syncToneDisplay();
  syncBuilderDisplay();
  renderMessages();
  renderFilePreview();
}

function heroMarkup() {
  return `
    <div class="page-shell hero-mode">
      <header class="top-bar">
        <div class="top-brand">AI Sales</div>
      </header>
      <main class="hero-stack">
        <h1 class="hero-title">You can test if your app builds confidence or triggers red flags.</h1>
        <p class="hero-subtitle">Drop screenshots, describe the experience, and choose how technical you want the language. I’ll analyse and hand you ready-to-ship fixes.</p>
        <section class="input-area">
          <div class="input-shell drop-zone">
            <button type="button" class="attach-button">Drop screenshot</button>
            <textarea class="chat-textarea" rows="2" placeholder="Describe the app, audience, or paste a link..."></textarea>
            <button type="button" class="primary-button send-button">Send</button>
            <input type="file" accept="image/*,.pdf" multiple>
          </div>
          <div class="control-row">
            <div class="select-wrapper">
              <label for="builder-dropdown">Builder</label>
              <select id="builder-dropdown" data-role="builder">
                ${builderOptions()
                  .map((builder) => `<option value="${builder}" ${state.builder === builder ? 'selected' : ''}>${builder}</option>`)
                  .join('')}
              </select>
            </div>
            <div class="select-wrapper">
              <label for="tone-dropdown">Language style</label>
              <select id="tone-dropdown" data-role="tone">
                ${Object.entries(toneLabels)
                  .map(
                    ([value, meta]) => `<option value="${value}" ${state.tone === value ? 'selected' : ''}>${meta.title}</option>`
                  )
                  .join('')}
              </select>
            </div>
            <button type="button" class="secondary-button" data-action="build">Generate build plan</button>
          </div>
          <div class="file-preview" id="file-list"></div>
        </section>
      </main>
      <footer class="bottom-nav">
        <nav>
          <a href="/privacy" target="_blank" rel="noreferrer">Privacy</a>
          <button data-action="support">Support</button>
          <button data-action="extensions">Extensions</button>
        </nav>
      </footer>
    </div>
  `;
}

function conversationMarkup() {
  return `
    <div class="page-shell conversation-mode">
      <header class="top-bar">
        <div class="top-brand">AI Sales</div>
      </header>
      <main class="conversation-layout">
        <aside class="filter-panel">
          <div class="filter-block">
            <span class="filter-label">Builder</span>
            <select id="builder-select" data-role="builder">
              ${builderOptions()
                .map((builder) => `<option value="${builder}">${builder}</option>`)
                .join('')}
            </select>
          </div>
          <div class="filter-block">
            <span class="filter-label">Language style</span>
            <select id="tone-select" data-role="tone">
              ${Object.entries(toneLabels)
                .map(([value, meta]) => `<option value="${value}">${meta.title}</option>`)
                .join('')}
            </select>
          </div>
        </aside>
        <section class="conversation-zone">
          <div class="conversation-top">
            <div class="friction-dial">
              <span class="dial-value" id="friction-badge">–</span>
              <div class="dial-meta">
                <span class="dial-label">Friction score</span>
                <span class="dial-context" id="friction-label">Awaiting review</span>
              </div>
            </div>
            <div class="conversation-actions">
              <button class="ghost-link primary-build" data-action="build">Generate build plan</button>
              <button class="ghost-link" data-action="transcript">Transcript</button>
              <button class="ghost-link" data-action="copy">Copy instructions</button>
            </div>
          </div>
          <div class="messages" id="messages"></div>
          <div class="composer">
            <div class="input-shell composer-shell drop-zone">
              <button type="button" class="attach-button">Drop screenshot</button>
              <textarea class="chat-textarea" rows="2" placeholder="Type your follow-up or paste another link..."></textarea>
              <button type="button" class="primary-button send-button">Send</button>
              <input type="file" accept="image/*,.pdf" multiple>
            </div>
            <div class="file-preview" id="file-list"></div>
          </div>
        </section>
      </main>
      <footer class="bottom-nav">
        <nav>
          <a href="/privacy" target="_blank" rel="noreferrer">Privacy</a>
          <button data-action="support">Support</button>
          <button data-action="extensions">Extensions</button>
        </nav>
      </footer>
    </div>
  `;
}

function submitPrompt(event) {
  if (event?.preventDefault) event.preventDefault();
  const shell = event?.target?.closest('.input-shell');
  const textarea = shell?.querySelector('.chat-textarea') || dom.chatTextarea;
  if (!textarea) return;
  submitPromptFromTextarea(textarea);
}

function handleTextareaKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitPromptFromTextarea(event.target);
  }
}

function submitPromptFromTextarea(textarea) {
  const text = textarea.value.trim();
  if (!text) return;

  const firstTransition = !state.isConversing;
  if (firstTransition) {
    state.isConversing = true;
  }

  state.lastPrompt = text;
  state.lastAttachments = [...state.files];
  addMessage('user', text);
  textarea.value = '';
  dom.chatTextarea = textarea;
  state.files = [];

  if (firstTransition) {
    renderApp();
  } else {
    renderFilePreview();
  }

  sendAdvisorRequest(text);
}

function setTone(tone) {
  state.tone = tone;
  syncToneDisplay();
  showToast(`Tone set to ${toneLabels[tone].title}`);
}

function addMessage(sender, text, extras = {}) {
  state.conversation.push({ sender, text, ...extras });
  renderMessages();
}

function renderMessages() {
  if (!dom.messagesBox) return;
  dom.messagesBox.innerHTML = '';
  state.conversation.forEach((message) => {
    const wrapper = document.createElement('div');
    wrapper.className = `message ${message.sender}`;

    const senderLabel = document.createElement('div');
    senderLabel.className = 'sender';
    senderLabel.textContent = message.sender === 'ai' ? 'AI Sales' : 'You';
    wrapper.appendChild(senderLabel);

    const paragraphs = [];
    if (message.headline) paragraphs.push(message.headline);
    if (message.summary) paragraphs.push(message.summary);

    if (Array.isArray(message.text)) {
      message.text.filter(Boolean).forEach((paragraph) => paragraphs.push(paragraph));
    } else if (typeof message.text === 'string' && message.text.trim()) {
      paragraphs.push(message.text);
    }

    paragraphs.forEach((paragraph) => {
      const p = document.createElement('div');
      p.textContent = paragraph;
      wrapper.appendChild(p);
    });

    const insights = message.insights || message.steps || [];
    if (insights.length) {
      wrapper.appendChild(renderStepSection('Key findings', insights));
    }

    const builderActions = message.builderActions || [];
    if (builderActions.length) {
      const builderTitle = message.builder ? `Builder actions · ${message.builder}` : 'Builder actions';
      wrapper.appendChild(renderStepSection(builderTitle, builderActions));
    }

    if (message.reassurance) {
      const reassurance = document.createElement('div');
      reassurance.className = 'helper-text reassurance';
      reassurance.textContent = message.reassurance;
      wrapper.appendChild(reassurance);
    }

    if (Array.isArray(message.suggestedPrompts) && message.suggestedPrompts.length > 0) {
      const promptRow = document.createElement('div');
      promptRow.className = 'prompt-chips';
      message.suggestedPrompts.forEach((prompt) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'prompt-chip';
        chip.textContent = prompt;
        chip.addEventListener('click', () => {
          const target = dom.chatTextarea || document.querySelector('.chat-textarea');
          if (target) {
            target.value = prompt;
            target.focus();
          }
        });
        promptRow.appendChild(chip);
      });
      wrapper.appendChild(promptRow);
    }

    dom.messagesBox.appendChild(wrapper);
  });

  dom.messagesBox.scrollTop = dom.messagesBox.scrollHeight;
}

function renderStepSection(title, steps) {
  const section = document.createElement('div');
  section.className = 'message-section';
  const heading = document.createElement('div');
  heading.className = 'section-title';
  heading.textContent = title;
  section.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'steps';
  steps.forEach((step, index) => {
    const stepItem = document.createElement('div');
    stepItem.className = 'step';
    stepItem.innerHTML = `
      <div class="step-number">${index + 1}</div>
      <div>
        <strong>${step.title || `Step ${index + 1}`}</strong>
        <p>${step.detail || (typeof step === 'string' ? step : JSON.stringify(step))}</p>
      </div>
    `;
    list.appendChild(stepItem);
  });

  section.appendChild(list);
  return section;
}

function setupDragAndDrop() {
  const zones = Array.from(document.querySelectorAll('.drop-zone'));
  if (zones.length === 0) return;

  const preventDefaults = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  zones.forEach((zone) => {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
      zone.addEventListener(eventName, preventDefaults, false);
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      zone.addEventListener(
        eventName,
        () => zone.classList.add('dragover'),
        false
      );
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      zone.addEventListener(
        eventName,
        () => zone.classList.remove('dragover'),
        false
      );
    });

    zone.addEventListener('drop', (event) => {
      const dt = event.dataTransfer;
      handleFiles(dt.files);
    });
  });
}

function handleFiles(fileList) {
  const accepted = Array.from(fileList || []).slice(0, 6);
  if (accepted.length === 0) return;
  state.files = accepted;
  renderFilePreview();
  showToast(`${accepted.length} file(s) attached for review.`);
}

function renderFilePreview() {
  if (!dom.fileList) return;
  dom.fileList.innerHTML = '';
  if (state.files.length === 0) return;
  state.files.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
      <div>
        <strong>${file.name}</strong>
        <div class="helper-text">${formatFileSize(file.size)}</div>
      </div>
      <button type="button" aria-label="Remove file">✕</button>
    `;
    item.querySelector('button').addEventListener('click', () => {
      state.files.splice(index, 1);
      renderFilePreview();
      showToast('Removed attachment.');
    });
    dom.fileList.appendChild(item);
  });
}

async function sendAdvisorRequest(promptText) {
  showToast('AI Sales is analysing…');

  const tempId = Date.now();
  const pendingMessage = {
    id: tempId,
    sender: 'ai',
    text: ['Analysing your experience…'],
    pending: true
  };
  state.conversation.push(pendingMessage);
  renderMessages();

  try {
    const payload = await buildFormData(promptText);
    const response = await fetch('/api/analyze', {
      method: 'POST',
      body: payload
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || 'Advisor request failed.');
    }

    const data = await response.json();
    const formatted = formatAdvisorResponse(data);

    replacePendingMessage(tempId);
    if (dom.frictionBadge) dom.frictionBadge.textContent = formatted.frictionScore ?? '–';
    const frictionLabelEl = document.getElementById('friction-label');
    if (frictionLabelEl) {
      frictionLabelEl.textContent = formatted.frictionLabel
        ? formatted.frictionRationale
          ? `${formatted.frictionLabel} · ${formatted.frictionRationale}`
          : formatted.frictionLabel
        : 'Updated';
    }

    addMessage('ai', formatted.summary, {
      headline: formatted.headline,
      summary: formatted.summary,
      insights: formatted.insights,
      builderActions: formatted.builderSteps,
      reassurance: formatted.reassurance,
      suggestedPrompts: formatted.suggestedPrompts,
      builder: state.builder
    });

    state.files = [];
    renderFilePreview();
  } catch (error) {
    console.error(error);
    replacePendingMessage(tempId);
    addMessage('ai', [
      'I could not complete that review right now.',
      error.message || 'Please try again in a moment.'
    ]);
  }
}

async function requestBuild(event) {
  if (event?.preventDefault) event.preventDefault();

  if (!state.lastPrompt) {
    showToast('Run an advisor review first so I know what to build.');
    return;
  }

  showToast('AI Sales is preparing a build plan…');

  try {
    const payload = await buildFormData(state.lastPrompt);
    const response = await fetch('/api/build', {
      method: 'POST',
      body: payload
    });

    if (response.status === 402) {
      const body = await response.json().catch(() => ({ message: 'Upgrade to continue.' }));
      showToast(body.message || 'Upgrade to continue.');
      addMessage('ai', body.message || 'You have used your free build. Upgrade to generate additional builds.');
      return;
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.message || 'Builder request failed.');
    }

    const data = await response.json();
    const formatted = formatBuildResponse(data);

    if (typeof data.remainingFreeBuilds === 'number') {
      showToast(
        data.remainingFreeBuilds > 0
          ? `Build plan ready. Free builds remaining: ${data.remainingFreeBuilds}`
          : 'Build plan ready. Upgrade to generate more builds.'
      );
    } else {
      showToast('Build plan ready.');
    }

    addMessage('ai', formatted.summary, {
      headline: formatted.headline,
      summary: formatted.summary,
      insights: formatted.insights,
      builderActions: formatted.builderSteps,
      reassurance: formatted.reassurance,
      suggestedPrompts: formatted.suggestedPrompts,
      builder: state.builder
    });
  } catch (error) {
    console.error(error);
    addMessage('ai', [
      'I could not generate a full build plan right now.',
      error.message || 'Please try again in a moment.'
    ]);
    showToast('Build plan unavailable.');
  }
}

function replacePendingMessage(id) {
  const index = state.conversation.findIndex((msg) => msg.id === id);
  if (index !== -1) {
    state.conversation.splice(index, 1);
    renderMessages();
  }
}

async function buildFormData(promptText) {
  const payload = new FormData();
  payload.append('prompt', promptText);
  payload.append('tone', state.tone);
  payload.append('builder', state.builder);
  const filesToSend = state.files.length ? state.files : state.lastAttachments || [];
  filesToSend.forEach((file) => payload.append('files', file, file.name));
  return payload;
}

function formatAdvisorResponse(data) {
  const headline =
    data.headline ||
    (state.tone === 'low-tech'
      ? 'Here is what will make things smoother:'
      : state.tone === 'mid-tech'
      ? 'Here is a clear plan with light terminology:'
      : 'Detailed playbook with full terminology:');

  const summary =
    data.summary ||
    'Summary not provided. Ask AI Sales to expand on any section you need more detail for.';

  return {
    headline,
    summary,
    frictionScore: data.frictionScore || '–',
    frictionLabel: data.frictionLabel || null,
    frictionRationale: data.frictionRationale || null,
    insights: Array.isArray(data.suggestions) ? data.suggestions : [],
    builderActions: Array.isArray(data.builderActions) ? data.builderActions : [],
    reassurance:
      data.reassurance ||
      'Let me know if you want deeper breakdowns, more examples, or to draft the next flow.',
    suggestedPrompts: Array.isArray(data.suggestedPrompts) ? data.suggestedPrompts : []
  };
}

function formatBuildResponse(data) {
  const screens = Array.isArray(data.screens)
    ? data.screens.map((screen, idx) => ({
        title: screen.name || `Screen ${idx + 1}`,
        detail: [screen.goal, ...(Array.isArray(screen.key_elements) ? screen.key_elements : [])]
          .filter(Boolean)
          .join('\n• ')
      }))
    : [];

  const flows = Array.isArray(data.flows)
    ? data.flows.map((flow, idx) => ({
        title: flow.title || `Flow ${idx + 1}`,
        detail: Array.isArray(flow.steps) ? flow.steps.join(' → ') : ''
      }))
    : [];

  const dataModel = Array.isArray(data.dataModel)
    ? data.dataModel.map((entity, idx) => ({
        title: entity.entity || `Entity ${idx + 1}`,
        detail: Array.isArray(entity.fields) ? entity.fields.join(', ') : ''
      }))
    : [];

  const builderSteps = Array.isArray(data.builderSteps)
    ? data.builderSteps.map((step, idx) => ({
        title: step.title || `Builder step ${idx + 1}`,
        detail: step.detail || (typeof step === 'string' ? step : JSON.stringify(step))
      }))
    : [];

  if (data.exportPlan) {
    const exportDescription = [
      data.exportPlan.description,
      Array.isArray(data.exportPlan.files)
        ? data.exportPlan.files.map((file) => `${file.filename}: ${file.description}`).join('\n')
        : null
    ]
      .filter(Boolean)
      .join('\n');

    if (exportDescription) {
      builderSteps.push({ title: 'Export plan', detail: exportDescription });
    }
  }

  const nextSteps = Array.isArray(data.nextSteps) ? data.nextSteps : [];
  const reassurance = nextSteps.length
    ? `Next steps: ${nextSteps.join(' · ')}`
    : 'Let me know if you want deeper breakdowns, more examples, or to draft another flow.';

  const summaryLines = [data.summary || 'Build plan ready.'];
  if (data.exportPlan?.description) {
    summaryLines.push(`Export plan: ${data.exportPlan.description}`);
  }

  return {
    headline: data.headline || 'Builder-ready plan',
    summary: summaryLines.join('\n\n'),
    insights: [...screens, ...flows, ...dataModel],
    builderSteps,
    reassurance,
    suggestedPrompts: Array.isArray(data.suggestedPrompts) ? data.suggestedPrompts : []
  };
}

function copyTailoredPrompt() {
  const builder = state.builder;
  const promptText = builderPrompts[builder] || builderPrompts.Bubble;
  navigator.clipboard
    .writeText(promptText)
    .then(() => showToast(`Instructions for ${builder} copied.`))
    .catch(() => showToast('Could not access clipboard. Copy manually.'));
}

function downloadTranscript() {
  const lines = state.conversation.map((item) => {
    const transcript = [`${item.sender.toUpperCase()}:`];

    if (item.headline) transcript.push(item.headline);
    if (item.summary) transcript.push(item.summary);

    if (Array.isArray(item.text)) transcript.push(...item.text);
    else if (typeof item.text === 'string' && item.text.trim()) transcript.push(item.text);

    const insights = item.insights || item.steps || [];
    insights.forEach((step, idx) =>
      transcript.push(`Insight ${idx + 1}: ${(step.title || '').trim()} - ${(step.detail || step).toString()}`)
    );

    const builderActions = item.builderActions || [];
    builderActions.forEach((step, idx) =>
      transcript.push(
        `Builder action ${idx + 1}: ${(step.title || '').trim()} - ${(step.detail || step).toString()}`
      )
    );

    if (item.reassurance) transcript.push(`Reassurance: ${item.reassurance}`);
    if (Array.isArray(item.suggestedPrompts) && item.suggestedPrompts.length) {
      transcript.push(`Suggested prompts: ${item.suggestedPrompts.join(' | ')}`);
    }

    transcript.push('');
    return transcript.join('\n');
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ai-sales-session-${Date.now()}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function showToast(message) {
  if (!dom.toast) return;
  dom.toast.textContent = message;
  dom.toast.classList.add('show');
  setTimeout(() => {
    dom.toast.classList.remove('show');
  }, 2200);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function syncToneDisplay() {
  if (!dom.toneSelects) return;
  dom.toneSelects.forEach((select) => {
    if (select) select.value = state.tone;
  });
}

function syncBuilderDisplay() {
  if (!dom.builderSelects) return;
  dom.builderSelects.forEach((select) => {
    if (select) select.value = state.builder;
  });
}
