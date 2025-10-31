const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const dotenv = require('dotenv');
const Stripe = require('stripe');
const crypto = require('crypto');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.resolve(__dirname, '..', 'tmp_uploads');
const SESSION_COOKIE = 'ai_sales_session';
const FREE_BUILD_LIMIT = Number(process.env.FREE_BUILD_LIMIT || 1);
const SESSION_STORE = new Map();
const SESSION_INDEX_BY_CUSTOMER = new Map();

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safeName = `${Date.now()}-${file.originalname}`.replace(/\s+/g, '-');
      cb(null, safeName);
    }
  }),
  limits: {
    files: 6,
    fileSize: 10 * 1024 * 1024 // 10 MB per file
  }
});

const stripeSecret = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecret ? new Stripe(stripeSecret, { apiVersion: '2024-06-20' }) : null;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || null;

app.use(cors());
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      if (req.originalUrl === '/api/payments/webhook') {
        req.rawBody = buf;
      }
    }
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

const publicDir = path.resolve(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/session', (req, res) => {
  const session = req.session || {};
  const buildsUsed = session.buildsUsed || 0;
  const isSubscribed = Boolean(session.isSubscribed);
  const remainingFree = isSubscribed ? null : Math.max(FREE_BUILD_LIMIT - buildsUsed, 0);

  res.json({
    sessionId: req.sessionId,
    buildsUsed,
    freeBuildLimit: isSubscribed ? null : FREE_BUILD_LIMIT,
    remainingFreeBuilds: remainingFree,
    isSubscribed
  });
});

app.post('/api/analyze', upload.array('files'), async (req, res) => {
  const { tone = 'low-tech', builder = 'No builder' } = req.body || {};
  const files = req.files || [];
  const session = req.session || {};

  if (files.length === 0) {
    cleanupFiles(files);
    return res.status(400).json({ error: 'Please upload at least one screenshot.' });
  }

  try {
    appendSessionHistory(session, {
      role: 'user',
      channel: 'analyze',
      prompt: '[screenshots uploaded]',
      builder,
      tone,
      attachments: files.length
    });

    const response = await callAdvisorModel({ tone, builder });

    cleanupFiles(files);
    appendSessionHistory(session, {
      role: 'ai',
      channel: 'analyze',
      summary: `Confidence ${response.scores?.confidence ?? 0}/100 · Clarity ${response.scores?.clarity ?? 0}/100`,
      builder,
      tone,
      payload: response
    });
    res.json(response);
  } catch (error) {
    console.error('Advisor error:', error);
    cleanupFiles(files);
    res.status(500).json({
      error: 'Advisor is unavailable at the moment.',
      details: error.message
    });
  }
});

app.post('/api/build', upload.array('files'), async (req, res) => {
  const session = req.session || { buildsUsed: 0, isSubscribed: false };
  const { prompt = '', tone = 'low-tech', builder = 'No builder', context = '' } = req.body || {};
  const files = req.files || [];

  if (!prompt.trim()) {
    cleanupFiles(files);
    return res.status(400).json({ error: 'missing_prompt', message: 'Please describe what you want to build.' });
  }

  const used = session.buildsUsed || 0;
  if (!session.isSubscribed && used >= FREE_BUILD_LIMIT) {
    cleanupFiles(files);
    return res.status(402).json({
      error: 'limit_reached',
      message: 'You have used your free build. Upgrade to generate additional builds.',
      remainingFreeBuilds: 0
    });
  }

  try {
    appendSessionHistory(session, {
      role: 'user',
      channel: 'build',
      prompt,
      builder,
      tone,
      context,
      attachments: files.length
    });

    const sessionContext = buildSessionHistoryContext(session.history || []);
    const attachments = await Promise.all(
      files.map(async (file) => ({
        name: file.originalname,
        base64: await fileToBase64(file.path),
        mimeType: file.mimetype
      }))
    );

    const buildPlan = await callBuilderModel({
      prompt,
      tone,
      builder,
      attachments,
      context,
      sessionContext
    });

    cleanupFiles(files);

    session.buildsUsed = (session.buildsUsed || 0) + 1;
    session.lastBuild = { id: buildPlan.buildId, createdAt: Date.now(), summary: buildPlan.summary };

    appendSessionHistory(session, {
      role: 'ai',
      channel: 'build',
      headline: buildPlan.headline,
      summary: buildPlan.summary,
      builder,
      tone,
      payload: buildPlan
    });

    const remainingFree = session.isSubscribed
      ? null
      : Math.max(FREE_BUILD_LIMIT - session.buildsUsed, 0);

    res.json({
      ...buildPlan,
      buildsUsed: session.buildsUsed,
      remainingFreeBuilds: remainingFree,
      isSubscribed: Boolean(session.isSubscribed)
    });
  } catch (error) {
    console.error('Builder error:', error);
    cleanupFiles(files);
    res.status(500).json({
      error: 'builder_unavailable',
      message: error.message || 'The builder is unavailable at the moment.'
    });
  }
});

app.post('/api/payments/checkout', async (req, res) => {
  const { email } = req.body || {};

  if (!stripe) {
    return res.status(503).json({ error: 'Payments disabled. Provide STRIPE_SECRET_KEY to enable.' });
  }

  if (!process.env.STRIPE_PRICE_ID) {
    return res.status(500).json({ error: 'Missing STRIPE_PRICE_ID in server configuration.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email || undefined,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1
        }
      ],
      success_url: process.env.CHECKOUT_SUCCESS_URL || 'https://aisales.com/success',
      cancel_url: process.env.CHECKOUT_CANCEL_URL || 'https://aisales.com/cancel',
      billing_address_collection: 'auto',
      subscription_data: {
        trial_period_days: Number(process.env.TRIAL_DAYS || 0) || undefined
      },
      metadata: {
        product: 'AI Trust Phase 1 Builder',
        sessionId: req.sessionId || ''
      }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: 'Could not create checkout session.', details: error.message });
  }
});

if (stripe && stripeWebhookSecret) {
  app.post('/api/payments/webhook', (req, res) => {
    const signature = req.headers['stripe-signature'];
    let event;

    try {
      const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
      event = stripe.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret);
    } catch (err) {
      console.error('Stripe webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    handleStripeWebhook(event).catch((error) => {
      console.error('Stripe webhook handling error:', error.message);
    });

    res.json({ received: true });
  });
}

app.get('/success', (_req, res) => {
  res.sendFile(path.join(publicDir, 'success.html'));
});

app.get('/cancel', (_req, res) => {
  res.sendFile(path.join(publicDir, 'cancel.html'));
});

app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(publicDir, 'privacy.html'));
});

app.get('/terms', (_req, res) => {
  res.sendFile(path.join(publicDir, 'terms.html'));
});

app.use((_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AI Trust server running on http://localhost:${PORT}`);
});

function sessionMiddleware(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    let sessionId = cookies[SESSION_COOKIE];

    if (!sessionId || !SESSION_STORE.has(sessionId)) {
      sessionId = crypto.randomUUID();
      SESSION_STORE.set(sessionId, {
        sessionId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        buildsUsed: 0,
        isSubscribed: false,
        stripeCustomerId: null,
        lastBuild: null,
        history: []
      });
      setCookie(res, SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: 'Lax', maxAge: 31536000 });
    }

    const session = SESSION_STORE.get(sessionId);
    session.updatedAt = Date.now();
    if (!Array.isArray(session.history)) {
      session.history = [];
    }

    req.sessionId = sessionId;
    req.session = session;
  } catch (error) {
    console.error('Session middleware error:', error);
  }

  next();
}

function cleanupFiles(files = []) {
  files.forEach((file) => {
    fs.unlink(file.path, (err) => {
      if (err) {
        console.warn('Failed to remove temp file', file.path, err.message);
      }
    });
  });
}

async function fileToBase64(filePath) {
  const data = await fs.promises.readFile(filePath);
  return data.toString('base64');
}

async function callAdvisorModel({ tone, builder }) {
  return generateScorecardVariant({ tone, builder });
}

async function callBuilderModel({ prompt, tone, builder, attachments, context = '', sessionContext = '' }) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return simulateBuilderPlan({ prompt, tone, builder, attachments });
  }

  const builderGuidance = getBuilderGuidance(builder);
  const toneGuidance = getToneGuidance(tone);
  const builderKnowledge = builderGuidance.knowledge?.join(' ') || '';
  const builderTips = builderGuidance.tips?.join('\n• ') || '';

  const systemPrompt = [
    'You are AI Trust — a senior product engineer and product designer hybrid.',
    'Given a product brief and optional visuals, produce a concise build-ready plan that contains screens, flows, data model, and builder-specific steps.',
    'Keep instructions technology-aware based on the provided builder, and surface actionable export hints.',
    'Respond using the JSON schema so the application can render the plan reliably.'
  ].join(' ');

  const mergedContext = [sessionContext, context].filter(Boolean).join('\n\n---\n\n');
  const contextSection = mergedContext
    ? [`Conversation context so far:\n${mergedContext.slice(0, 2000)}`]
    : [];

  const buildPromptSection = [
    `Preferred builder: ${builderGuidance.label}.`,
    `Tone: ${toneGuidance.label}.`,
    'Brief:',
    prompt
  ].join('\n');

  const userContent = [
    {
      type: 'input_text',
      text: [...contextSection, buildPromptSection].filter(Boolean).join('\n\n')
    },
    ...attachments.map((file) => ({
      type: 'input_image',
      image_base64: file.base64
    }))
  ];

  const responseFormat = {
    type: 'json_schema',
    name: 'ai_sales_build_plan',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['headline', 'summary', 'screens', 'builder_steps', 'export_plan', 'next_steps'],
      properties: {
        headline: { type: 'string' },
        summary: { type: 'string' },
        screens: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'goal', 'key_elements'],
            properties: {
              name: { type: 'string' },
              goal: { type: 'string' },
              key_elements: {
                type: 'array',
                items: { type: 'string' }
              }
            }
          }
        },
        flows: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'steps'],
            properties: {
              title: { type: 'string' },
              steps: {
                type: 'array',
                items: { type: 'string' }
              }
            }
          }
        },
        data_model: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['entity', 'fields'],
            properties: {
              entity: { type: 'string' },
              fields: {
                type: 'array',
                items: { type: 'string' }
              }
            }
          }
        },
        builder_steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'detail'],
            properties: {
              title: { type: 'string' },
              detail: { type: 'string' }
            }
          }
        },
        export_plan: {
          type: 'object',
          additionalProperties: false,
          required: ['description', 'files'],
          properties: {
            description: { type: 'string' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['filename', 'description'],
                properties: {
                  filename: { type: 'string' },
                  description: { type: 'string' }
                }
              }
            }
          }
        },
        next_steps: {
          type: 'array',
          items: { type: 'string' }
        },
        suggested_prompts: {
          type: 'array',
          items: { type: 'string' }
        }
      }
    }
  };

  const payload = {
    model: process.env.OPENAI_MODEL || 'gpt-4o-2024-08-06',
    input: [
      {
        role: 'system',
        content: [
          { type: 'input_text', text: systemPrompt },
          { type: 'input_text', text: toneGuidance.system },
          { type: 'input_text', text: builderGuidance.systemPrompt },
          builderKnowledge
            ? { type: 'input_text', text: `Builder knowledge base:\n${builderKnowledge}` }
            : null,
          builderTips
            ? { type: 'input_text', text: `Builder execution tips:\n• ${builderTips}` }
            : null
        ]
      },
      {
        role: 'user',
        content: userContent
      }
    ],
    text: {
      format: responseFormat
    }
  };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI build error: ${response.status} ${text}`);
  }

  const result = await response.json();
  const structured = extractStructuredPayload(result);
  if (!structured) {
    console.warn(
      'Builder response missing structured payload.',
      JSON.stringify(result).slice(0, 2000)
    );
    throw new Error('Model did not return build plan.');
  }

  return normalizeBuildPlan(structured, { builder });
}

function simulateAdvisorResponse({ tone, builder }) {
  return fallbackScorecard({ tone, builder });
}

function simulateBuilderPlan({ prompt, builder }) {
  const buildId = crypto.randomUUID();
  const builderGuidance = getBuilderGuidance(builder);
  const summary = `Starter build plan for ${builderGuidance.label}. Focus on clarifying the promise, showcasing proof, and guiding users through the primary action.`;

  return {
    buildId,
    headline: `Blueprint for ${builderGuidance.label}`,
    summary,
    screens: [
      {
        name: 'Landing hero',
        goal: 'Communicate the core value and primary action immediately.',
        key_elements: [
          'Headline clearly stating the outcome',
          'Support sentence with trust or metric',
          'Primary CTA button styled with white background and black text'
        ]
      },
      {
        name: 'Proof wall',
        goal: 'Reinforce credibility and reduce anxiety.',
        key_elements: ['Logos/testimonials', 'Short success metrics', 'Secondary CTA to learn more']
      }
    ],
    flows: [
      {
        title: 'Hero to signup flow',
        steps: ['User clicks primary CTA', 'Modal collects minimal fields', 'Confirmation screen outlines next steps']
      }
    ],
    dataModel: [
      {
        entity: 'Lead',
        fields: ['name', 'email', 'company', 'goal', 'source']
      }
    ],
    builderSteps: [
      {
        title: `Configure layout in ${builderGuidance.label}`,
        detail:
          builderGuidance.tips?.[0] ||
          'Adjust layout spacing, typography tokens, and CTA styling using the guidance above.'
      },
      {
        title: 'Apply styling system',
        detail: 'Set the brand palette (black, white, accent), apply consistent spacing (24px blocks), and ensure CTAs use white background with bold black copy.'
      }
    ],
    exportPlan: {
      description: 'Package hero + proof sections as reusable components.',
      files: [
        {
          filename: 'layout.json',
          description: 'JSON layout blueprint for hero + proof sections.',
          snippet: '{ "sections": ["hero", "proof"] }'
        }
      ]
    },
    nextSteps: [
      'Wire this plan into your builder, copying the CTA styling and proof layout.',
      'Add live customer quotes or pilot metrics before launching.',
      'Set up analytics tracking on the CTA to measure lift after changes.'
    ],
    suggestedPrompts: [
      'Show me copy variations for the hero headline.',
      `Generate ${builderGuidance.label === builder ? builder : 'my builder'} step-by-step instructions for the proof section.`
    ]
  };
}

function normalizeBuildPlan(structured, { builder }) {
  const buildId = crypto.randomUUID();
  const screens = Array.isArray(structured.screens) ? structured.screens : [];
  const flows = Array.isArray(structured.flows) ? structured.flows : [];
  const dataModel = Array.isArray(structured.data_model) ? structured.data_model : [];
  const builderSteps = Array.isArray(structured.builder_steps) ? structured.builder_steps : [];
  const nextSteps = Array.isArray(structured.next_steps) ? structured.next_steps : [];

  return {
    buildId,
    builder,
    headline: structured.headline || `Blueprint for ${builder}`,
    summary: structured.summary || 'Build plan summary unavailable.',
    screens: screens.map((screen) => ({
      name: screen.name || 'Screen',
      goal: screen.goal || '',
      key_elements: Array.isArray(screen.key_elements) ? screen.key_elements : []
    })),
    flows: flows.map((flow) => ({
      title: flow.title || 'Flow',
      steps: Array.isArray(flow.steps) ? flow.steps : []
    })),
    dataModel: dataModel.map((entity) => ({
      entity: entity.entity || 'Entity',
      fields: Array.isArray(entity.fields) ? entity.fields : []
    })),
    builderSteps: builderSteps.map((step, idx) => ({
      title: step.title || `Builder step ${idx + 1}`,
      detail: step.detail || (typeof step === 'string' ? step : JSON.stringify(step))
    })),
    exportPlan: structured.export_plan || null,
    nextSteps,
    suggestedPrompts: Array.isArray(structured.suggested_prompts) ? structured.suggested_prompts : []
  };
}

function normalizeScorecardResponse(payload, { tone, builder }) {
  const parsed = typeof payload === 'string' ? safeJsonParse(payload) : payload;
  if (!parsed || typeof parsed !== 'object') {
    return fallbackScorecard({ tone, builder });
  }

  const scores = parsed.scores || {};
  const flags = Array.isArray(parsed.flags) ? parsed.flags : [];
  const freeRewrite = parsed.free_rewrite || {};
  const lockedItems = Array.isArray(parsed.locked_items) ? parsed.locked_items : [];
  const metadata = parsed.metadata || {};

  const builderActions = Array.isArray(metadata.builder_actions)
    ? metadata.builder_actions
    : Array.isArray(metadata.builderSteps)
    ? metadata.builderSteps
    : [];
  const experiments = Array.isArray(metadata.experiments) ? metadata.experiments : [];
  const checklist = Array.isArray(metadata.checklist) ? metadata.checklist : [];

  const normalizedScores = {
    confidence: clampScore(scores.confidence ?? metadata.confidence ?? 52),
    pushiness: clampScore(scores.pushiness ?? metadata.pushiness ?? 58),
    clarity: clampScore(scores.clarity ?? metadata.clarity ?? 60)
  };

  return {
    builder,
    tone,
    scores: normalizedScores,
    flags: flags.slice(0, 3).map((flag) => ({
      title: flag.title || 'Issue',
      detail: flag.detail || 'Needs clarification.',
      evidence: flag.evidence || flag.quote || 'No evidence provided.'
    })),
    freeRewrite: {
      before: freeRewrite.before || 'Original copy unavailable.',
      after: freeRewrite.after || 'Rewrite unavailable.',
      rationale: freeRewrite.rationale || 'Refine your messaging for clarity and trust.'
    },
    lockedInsights: lockedItems.map((item) => ({
      title: item.title || 'Additional insight',
      summary: item.summary || 'Unlock the full plan to view this insight.'
    })),
    builderActions: builderActions.map((item, idx) => ({
      title: item.title || `Builder action ${idx + 1}`,
      detail: item.detail || item.summary || 'See builder guidance in the knowledge base.'
    })),
    experiments,
    checklist,
    metadata
  };
}

function getToneGuidance(tone) {
  const guides = {
    'low-tech': {
      label: 'No technical terminology',
      system: 'Rewrite every recommendation in everyday language. Never assume design or engineering jargon.',
      rewrite: (text) =>
        text
          .replace(/CTA/gi, 'main button')
          .replace(/conversion/gi, 'first action')
          .replace(/friction/gi, 'confusing moment')
          .replace(/onboarding/gi, 'getting started')
    },
    'mid-tech': {
      label: 'Some technical terminology',
      system:
        'Use approachable language with light terminology. Define any concept if it might be unfamiliar.',
      rewrite: (text) => text
    },
    'high-tech': {
      label: 'Full technical terminology',
      system:
        'Lean on product, UX, and engineering vocabulary. Reference frameworks and heuristics when relevant.',
      rewrite: (text) => `${text} (align with your analytics & design system guardrails.)`
    }
  };
  return guides[tone] || guides['mid-tech'];
}

function getBuilderGuidance(builder) {
  const cards = {
    'No builder': {
      label: 'No builder specified',
      systemPrompt: [
        'The user has not specified a builder. Keep implementation guidance technology-agnostic and focus on UX/UI patterns that can be applied to any stack.',
        'Offer HTML/CSS or product strategy actions when helpful.'
      ].join(' '),
      knowledge: [
        'Works across any custom stack, design tool, or slide deck.',
        'Emphasize visual hierarchy, copy clarity, trust builders, and friction removal.',
        'Surface metrics to watch (bounce, conversion, time on task) when proposing experiments.'
      ],
      tips: [
        'Call out sections to tighten (hero, navigation, pricing) and describe the exact copy/layout change.',
        'Suggest instrumentation or quick experiments the user can run to validate the change.'
      ]
    },
    Bubble: {
      label: 'Bubble',
      systemPrompt:
        'Reference Bubble Editor concepts: groups, responsive containers, data sources, workflows, and styles. Suggest changes in the exact panels users interact with.',
      knowledge: [
        'Responsive engine controls live under the Layout tab (row/column, gap, min width).',
        'Reusable elements and styles drive consistency; highlight which style to adjust.',
        'Workflow triggers run from buttons and inputs; call out where to add success messaging or tracking.'
      ],
      tips: [
        'Bubble → open the target group, adjust min width and gap to declutter.',
        'Update the Style for primary buttons and ensure states are used for hover/disabled.',
        'Add an analytics workflow step (e.g., Amplitude plugin) when the CTA fires.'
      ]
    },
    Base44: {
      label: 'Base44',
      systemPrompt:
        'Reference Base44’s block library, layout canvas, and exportable components. Highlight changes in terms of swapping blocks, editing typography tokens, and publishing exports.',
      knowledge: [
        'Blocks snap to the Base44 grid; spacing tokens (S, M, L) govern rhythm.',
        'Typography tokens (Display, Heading, Body) should be reused for consistent hierarchy.',
        'Export packages include HTML/CSS; note when a change impacts the exported bundle.'
      ],
      tips: [
        'In Base44 Canvas, replace the Hero block with “Hero · Clarity” and update Heading/Subheading tokens.',
        'Adjust CTA button token to “Action / Primary Inverse” for high contrast.',
        'Add a “Logos · Proof Row” block below hero to validate the offer.'
      ]
    },
    Webflow: {
      label: 'Webflow',
      systemPrompt:
        'Reference Webflow designer: classes, style panel, interactions, CMS collections, and publish workflow. Suggest exact class or element names when giving steps.',
      knowledge: [
        'Global classes (e.g., .container, .button) should be reused; propose new combo classes sparingly.',
        'Flex and grid controls live in the Layout panel; margin/padding adjustments keep boxes aligned.',
        'CMS collections power dynamic content—mention when to add fields or sort filters.'
      ],
      tips: [
        'Select `.hero-wrapper`, set max-width 680px, center with auto margins, and add gap 32px.',
        'Update `.button-primary` to use white background, black text, radius 14px.',
        'Add a CMS-powered testimonial slider beneath the hero using Collection Lists.'
      ]
    },
    Glide: {
      label: 'Glide',
      systemPrompt:
        'Reference Glide app builder: tabs, layout editor, component list, Theme > Brand settings, and data tables.',
      knowledge: [
        'Each tab maps to a data table; highlight when to restructure tables for clarity.',
        'Component list order defines hierarchy; drag components to prioritize proof before pricing.',
        'Theme settings control accent colors and typography globally.'
      ],
      tips: [
        'Glide → Home tab: move testimonials component above pricing, update rich text copy with a crisp promise.',
        'In Theme → Brand, set accent color to #111111 for buttons, with white text.',
        'Add a progress bar component to guide users through onboarding steps.'
      ]
    },
    Retool: {
      label: 'Retool',
      systemPrompt:
        'Reference Retool’s component tree, state management, transformers, and event handlers. Tailor suggestions to internal tool UX.',
      knowledge: [
        'Retool forms rely on JSON data; highlight where to enforce validation and helper text.',
        'Query editor wires to APIs/DB; mention logging or success toast best practices.',
        'App layout uses containers; instruct on alignment, spacing, and filter defaults.'
      ],
      tips: [
        'Retool → Adjust Form component: set label casing to Title Case, add placeholder examples.',
        'Add a Success toast in the submit event handler with clear next steps.',
        'Use a Tabs container to separate “Overview” vs “Advanced filters” to reduce clutter.'
      ]
    },
    Softr: {
      label: 'Softr',
      systemPrompt:
        'Reference Softr block library, global styles, and publishing. Suggest swapping blocks and adjusting content in the editor.',
      knowledge: [
        'Blocks snap to sections; swapping block presets is faster than manual styling.',
        'Global Styles control typography/colors across blocks—mention when to tweak them.',
        'Integrations (Airtable, HubSpot) often power dynamic sections—note connection points.'
      ],
      tips: [
        'Swap hero block to “Hero · Impact,” update heading/subheading, keep CTA high contrast.',
        'Insert “Logos · Trusted by” block below hero for social proof.',
        'Use a two-column block for pricing vs. FAQs to answer objections inline.'
      ]
    },
    FlutterFlow: {
      label: 'FlutterFlow',
      systemPrompt:
        'Reference FlutterFlow page editor, Theme overrides, Actions, and Firebase bindings. Tailor guidance to responsive layout and cross-platform output.',
      knowledge: [
        'Widget tree defines layout; propose reordering widgets for above-the-fold clarity.',
        'Theme controls button styles; note when to create a custom theme style.',
        'Actions define backend calls; mention validation, success states, and navigation flows.'
      ],
      tips: [
        'FlutterFlow → Landing Screen: edit AppBar text for clarity, move Summary cards above testimonials.',
        'In Theme → Buttons, create a “Primary Inverse” style (white background, black text) and apply to main CTA.',
        'Add a confirmation snackbar action after form submission with next steps.'
      ]
    },
    Adalo: {
      label: 'Adalo',
      systemPrompt:
        'Reference Adalo screens, lists, modal actions, and styles. Focus on mobile-first adjustments.',
      knowledge: [
        'Adalo lists derive from collections; mention when to sort/filter or add relationships.',
        'Styles panel adjusts button edges, shadows, and typography globally.',
        'Modals and actions handle flows; suggest conditional visibility or validation.'
      ],
      tips: [
        'Open Landing screen, update hero headline, increase button border radius to 12px, and add a list of testimonials below.',
        'Use a modal to collect lead info with minimal fields, display confirmation message afterward.'
      ]
    }
  };

  const fallback = {
    label: builder,
    systemPrompt:
      'Provide implementation guidance even if the builder is unknown. Offer HTML/CSS patterns, UX frameworks, and instrumentation tips.',
    knowledge: [
      'Focus on clarity of promise, hierarchy, social proof, and friction removal.',
      'Suggest copy edits, layout adjustments, and simple experiments to validate impact.'
    ],
    tips: [
      'Call out the highest-impact sections (hero, navigation, pricing) and describe precise fixes.',
      'Encourage adding trust indicators (logos, testimonials, guarantees).'
    ]
  };

  return cards[builder] || fallback;
}

function extractScore(text) {
  const match = text.match(/friction[:\s]+(very low|low|moderate|elevated|high)/i);
  if (!match) return 3;
  const index = ['very low', 'low', 'moderate', 'elevated', 'high'].indexOf(match[1].toLowerCase());
  return index === -1 ? 3 : index + 1;
}

function extractSuggestions(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const suggestions = [];
  lines.forEach((line) => {
    const match = line.match(/^\d+[\).\s-]+(.+)/);
    if (match) {
      suggestions.push({ title: `Step ${suggestions.length + 1}`, detail: match[1] });
    }
  });
  return suggestions.length > 0 ? suggestions : [{ title: 'Next steps', detail: text }];
}

function extractReassurance(text) {
  const reassurance = text
    .split('\n')
    .find((line) => /you can|feel free|ready when/i.test(line));
  return reassurance || 'Let me know when you want to dive deeper or have me draft the next version for you.';
}

function mockScore(prompt, fileCount) {
  let score = 3;
  const text = prompt.toLowerCase();

  if (fileCount === 0) score += 1;
  if (text.includes('confusing') || text.includes('drop')) score = Math.min(score + 1, 5);
  if (text.includes('simple') || text.includes('clean')) score = Math.max(score - 1, 1);

  return score;
}

function scoreLabel(score) {
  return ['Very Low', 'Low', 'Moderate', 'Elevated', 'High'][score - 1] || 'Moderate';
}

function extractStructuredPayload(result) {
  if (!result) return null;
  const outputs = Array.isArray(result.output) ? result.output : [];

  for (const item of outputs) {
    const contents = item?.content || [];
    for (const piece of contents) {
      if (piece.type === 'output_json_schema' && piece.json) {
        return piece.json;
      }
      if (piece.type === 'output_json_schema' && piece.schema) {
        return piece.schema;
      }
      if (piece.type === 'json_schema' && piece.schema) {
        return piece.schema;
      }
      if (piece.type === 'json_schema' && piece.json) {
        return piece.json;
      }
      if (piece.output_json_schema && piece.output_json_schema.json) {
        return piece.output_json_schema.json;
      }
      if (piece.output_json_schema && piece.output_json_schema.schema) {
        return piece.output_json_schema.schema;
      }
      if (piece.type === 'text' && piece.text) {
        const parsed = safeJsonParse(piece.text);
        if (parsed) return parsed;
      }
      if (piece.json && typeof piece.json === 'object') {
        return piece.json;
      }
      if (piece.schema && typeof piece.schema === 'object') {
        return piece.schema;
      }
      if (piece.type === 'output_text' && typeof piece.text === 'string') {
        const parsed = safeJsonParse(piece.text);
        if (parsed) return parsed;
      }
      if (piece.text && typeof piece.text === 'string') {
        const parsed = safeJsonParse(piece.text);
        if (parsed) return parsed;
      }
    }
  }

  if (typeof result.output_text === 'string') {
    const parsed = safeJsonParse(result.output_text);
    if (parsed) return parsed;
  }

  return null;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

const SESSION_HISTORY_LIMIT = 12;

function appendSessionHistory(session, entry = {}) {
  if (!session) return;
  if (!Array.isArray(session.history)) session.history = [];
  session.history.push({ ...entry, timestamp: Date.now() });
  if (session.history.length > SESSION_HISTORY_LIMIT) {
    session.history.splice(0, session.history.length - SESSION_HISTORY_LIMIT);
  }
}

function buildSessionHistoryContext(history = []) {
  if (!Array.isArray(history) || history.length === 0) return '';
  const sliceStart = Math.max(0, history.length - SESSION_HISTORY_LIMIT);
  const lines = [];
  history.slice(sliceStart).forEach((entry) => {
    if (!entry) return;
    const roleLabel = entry.role === 'ai' ? 'AI Trust' : 'User';
    const channel = entry.channel ? `·${entry.channel}` : '';
    const builder = entry.builder ? `·${entry.builder}` : '';

    if (entry.prompt) {
      lines.push(`${roleLabel}${channel}${builder}: ${entry.prompt}`);
    } else if (entry.summary) {
      lines.push(`${roleLabel}${channel}${builder}: ${entry.summary}`);
    }
  });

  return lines.join('\n');
}

const SCORE_VARIANT_SEEDS = Array.from({ length: 100 }, (_, i) => i + 1);
let scoreVariantCursor = 0;

function generateScorecardVariant({ tone, builder }) {
  const seed = SCORE_VARIANT_SEEDS[scoreVariantCursor];
  scoreVariantCursor = (scoreVariantCursor + 1) % SCORE_VARIANT_SEEDS.length;
  return buildVariantFromSeed(seed, { tone, builder });
}

function buildVariantFromSeed(seed, { tone, builder }) {
  const rng = mulberry32(seed * 9973 + 17);
  const scores = generateScores(rng);
  const guidance = getBuilderGuidance(builder);

  return {
    builder,
    tone,
    scores,
    flags: buildFlags(scores, guidance, rng),
    freeRewrite: buildRewrite(scores, guidance, rng),
    lockedInsights: buildLockedInsights(guidance, rng),
    builderActions: buildBuilderPointers(guidance, rng),
    experiments: buildExperiments(guidance, rng),
    checklist: buildChecklist(guidance, rng),
    metadata: {}
  };
}

function generateScores(rng) {
  const base = randomBetween(rng, 35, 82);
  const confidence = clampScore(base + randomBetween(rng, -5, 5));
  const pushiness = clampScore(confidence + randomBetween(rng, -6, 6));
  const clarity = clampScore(Math.round((confidence + pushiness) / 2) + randomBetween(rng, -4, 4));

  const values = [confidence, pushiness, clarity];
  const spread = Math.max(...values) - Math.min(...values);
  if (spread > 10) {
    const average = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    return {
      confidence: clampScore(average + randomBetween(rng, -4, 4)),
      pushiness: clampScore(average + randomBetween(rng, -4, 4)),
      clarity: clampScore(average + randomBetween(rng, -4, 4))
    };
  }

  return { confidence, pushiness, clarity };
}

function buildFlags(scores, guidance, rng) {
  const pools = FLAG_RULES.filter((rule) => rule.condition(scores))
    .map((rule) => rule.variants)
    .flat();
  const pool = pools.length ? pools : FLAG_RULES.flatMap((rule) => rule.variants);
  return pickDistinct(pool, rng, 3).map((variant) => ({
    title: variant.title,
    detail: substituteBuilder(variant.detail, guidance),
    evidence: substituteBuilder(variant.evidence, guidance)
  }));
}

function buildRewrite(scores, guidance, rng) {
  const pools = REWRITE_RULES.filter((rule) => rule.condition(scores))
    .map((rule) => rule.variants)
    .flat();
  const pool = pools.length ? pools : REWRITE_RULES.flatMap((rule) => rule.variants);
  const variant = randomFrom(pool, rng);
  return {
    before: substituteBuilder(variant.before, guidance),
    after: substituteBuilder(variant.after, guidance),
    rationale: variant.rationale
  };
}

function buildLockedInsights(guidance, rng) {
  return pickDistinct(LOCKED_INSIGHTS, rng, 3).map((variant) => ({
    title: substituteBuilder(variant.title, guidance),
    summary: substituteBuilder(variant.summary, guidance)
  }));
}

function buildBuilderPointers(guidance, rng) {
  return pickDistinct(BUILDER_POINTERS.map((variant) => variant(guidance)), rng, 2);
}

function buildExperiments(guidance, rng) {
  return pickDistinct(EXPERIMENT_LIB, rng, 3).map((item) => substituteBuilder(item, guidance));
}

function buildChecklist(guidance, rng) {
  return pickDistinct(CHECKLIST_LIB, rng, 3).map((item) => substituteBuilder(item, guidance));
}

function substituteBuilder(text, guidance) {
  return text.replace(/{{builder}}/g, friendlyBuilderName(guidance));
}

function friendlyBuilderName(guidance) {
  return guidance.label === 'No builder specified' ? 'your stack' : guidance.label;
}

function pickDistinct(pool, rng, count) {
  const copy = [...pool];
  const result = [];
  while (result.length < count && copy.length) {
    const index = Math.floor(rng() * copy.length);
    result.push(copy.splice(index, 1)[0]);
  }
  return result;
}

function randomFrom(pool, rng) {
  return pool[Math.floor(rng() * pool.length)];
}

function randomBetween(rng, min, max) {
  return Math.round(rng() * (max - min) + min);
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FLAG_RULES = [
  {
    condition: (scores) => scores.confidence < 55,
    variants: [
      { title: 'Trust feels thin', detail: 'Heroes promise the world but proof is missing.', evidence: 'Show one quantified win or a customer pull-quote above the CTA in {{builder}}.' },
      { title: 'Proof gap early on', detail: 'Prospects do not see evidence until much later.', evidence: 'Add a logos strip or metric tile near the hero CTA in {{builder}}.' },
      { title: 'Credibility undecided', detail: 'Nothing signals that teams like them already trust you.', evidence: 'Add a testimonial card adjacent to the hero in {{builder}}.' },
      { title: 'Outcome sounds aspirational', detail: 'Promises are bold without showing you can deliver.', evidence: 'Include a quick before/after snippet near the hero in {{builder}}.' },
      { title: 'Testimonials hidden', detail: 'Social proof lives too far down the flow to reassure the first impression.', evidence: 'Surface a customer quote or stat within the first viewport in {{builder}}.' },
      { title: 'Metrics feel vague', detail: 'Numbers are phrased as “fast” or “huge” instead of hard data.', evidence: 'Show one specific result with timeframe and audience in {{builder}}.' },
      { title: 'Risk reversal missing', detail: 'Buyers do not see guarantees or safety nets.', evidence: 'Add a short “Why it’s safe to try” block beside your CTA in {{builder}}.' },
      { title: 'Outcome lacks evidence', detail: 'Bold claims appear without an example or visual proof.', evidence: 'Pair the headline with an annotated screenshot or data callout in {{builder}}.' },
      { title: 'Signal mismatch', detail: 'Visual tone reads premium but copy feels unsubstantiated.', evidence: 'Anchor the hero with real customers, dates, or product milestones in {{builder}}.' },
      { title: 'Trust marker buried', detail: 'Security or compliance badges are hidden in the footer.', evidence: 'Raise trust badges near forms or pricing tables in {{builder}}.' },
      { title: 'Voice sounds hypey', detail: 'Superlatives sound like marketing rather than proof.', evidence: 'Swap in calm, specific language that references customer wins in {{builder}}.' },
      { title: 'Advisor missing', detail: 'There’s no named persona or team behind the promise.', evidence: 'Introduce a short founder/coach note with credentials in {{builder}}.' },
      { title: 'Proof cadence off', detail: 'You front-load features but leave proof for the end.', evidence: 'Interleave feature bullets with proof snippets throughout {{builder}}.' }
    ]
  },
  {
    condition: (scores) => scores.clarity < 52,
    variants: [
      { title: 'Flow feels ambiguous', detail: 'Multiple CTAs compete for attention.', evidence: 'Keep one bold CTA and demote others to text links in {{builder}}.' },
      { title: 'Messaging overload', detail: 'Paragraphs bury the core benefit.', evidence: 'Rewrite the hero into a single sentence plus two bullet points in {{builder}}.' },
      { title: 'Path is unclear', detail: 'Visitors cannot see what happens after clicking.', evidence: 'Add a “How it works” strip immediately under the hero CTA in {{builder}}.' },
      { title: 'Hierarchy is flat', detail: 'Headlines, body, and buttons look the same.', evidence: 'Increase typographic contrast and spacing in {{builder}}.' },
      { title: 'Screens feel crowded', detail: 'There is no breathing room between key ideas.', evidence: 'Introduce consistent padding blocks and simplify each row in {{builder}}.' },
      { title: 'Story jumps around', detail: 'Visitors hop between benefits without a sequence.', evidence: 'Use a left-to-right or top-to-bottom narrative with one idea per section in {{builder}}.' },
      { title: 'Jargon creeps in', detail: 'Industry terms appear before context is set.', evidence: 'Swap jargon for plain-language explanations in {{builder}}.' },
      { title: 'Value not explicit', detail: 'Headlines hint at outcomes but never state them plainly.', evidence: 'Rewrite copy to spell out the before/after in {{builder}}.' },
      { title: 'CTA labels vague', detail: 'Buttons say “Submit” or “Start” without context.', evidence: 'Rename CTAs so they describe the action that follows in {{builder}}.' },
      { title: 'Screens lack focus', detail: 'Hero combines navigation, feature, and social proof at once.', evidence: 'Break content into focused blocks with single intent in {{builder}}.' },
      { title: 'Sequence misses steps', detail: 'Users are asked to act before they see the workflow.', evidence: 'Add a three-step explainer or timeline ahead of the conversion CTA in {{builder}}.' },
      { title: 'Visual weight uneven', detail: 'Important sections look similar to fine print.', evidence: 'Use contrast and typography to spotlight the core insight in {{builder}}.' },
      { title: 'Copy repeats itself', detail: 'Benefits repeat without introducing new information.', evidence: 'Condense overlapping paragraphs into concise bullets in {{builder}}.' }
    ]
  },
  {
    condition: (scores) => scores.pushiness > 60,
    variants: [
      { title: 'Urgency overwhelms trust', detail: 'Scarcity language appears before evidence.', evidence: 'Swap hype copy for a calm reassurance sentence near the CTA in {{builder}}.' },
      { title: 'CTA feels aggressive', detail: 'Command-style language raises resistance.', evidence: 'Use outcome-driven CTA text like “See the AI Trust scorecard” in {{builder}}.' },
      { title: 'Pressure precedes clarity', detail: 'Visitors feel pushed without understanding value.', evidence: 'Insert a “what you get” checklist before pricing in {{builder}}.' },
      { title: 'Promo overload', detail: 'Stacked discounts make the page feel salesy.', evidence: 'Limit to one promotional cue and focus on value messaging in {{builder}}.' },
      { title: 'Countdown fatigue', detail: 'Timers and urgency widgets clutter the hero.', evidence: 'Remove countdowns unless tied to a real event in {{builder}}.' },
      { title: 'Pop-up pressure', detail: 'Entry pop-ups ask for commitment before context.', evidence: 'Delay modals until after proof and value are delivered in {{builder}}.' },
      { title: 'Discount dominates', detail: 'The first message is about price, not outcome.', evidence: 'Lead with transformation, bring pricing later in {{builder}}.' },
      { title: 'Scarcity without reason', detail: '“Only 5 left” language lacks evidence it is genuine.', evidence: 'Replace scarcity with clarity or explain the limit in {{builder}}.' },
      { title: 'CTA stack tall', detail: 'Users see multiple bold CTAs in a single viewport.', evidence: 'Keep one primary CTA and demote the rest to links in {{builder}}.' },
      { title: 'Caps lock commands', detail: 'All-caps CTAs feel like shouting.', evidence: 'Use sentence case CTA labels with a reassuring tone in {{builder}}.' },
      { title: 'Hero reads like pitch', detail: 'Lead copy sounds like a sales script.', evidence: 'Rewrite in second person with clear outcomes instead of hype in {{builder}}.' },
      { title: 'Pricing feels pushy', detail: 'Buy now messaging appears before benefit context.', evidence: 'Introduce pricing after explaining the journey and proof in {{builder}}.' },
      { title: 'Risk acknowledged late', detail: 'Visitors see urgency before hearing about safeguards.', evidence: 'Add a short safety net or guarantee near the first CTA in {{builder}}.' }
    ]
  },
  {
    condition: () => true,
    variants: [
      { title: 'Visual rhythm off', detail: 'Spacing inconsistencies make scanning harder.', evidence: 'Apply consistent 24px spacing blocks and align imagery with copy in {{builder}}.' },
      { title: 'Navigation competes', detail: 'Top links pull focus from the main CTA.', evidence: 'Collapse low-priority nav items into a menu in {{builder}}.' },
      { title: 'Support proof buried', detail: 'Important reassurance content sits below the fold.', evidence: 'Raise FAQs or security notes closer to the hero in {{builder}}.' },
      { title: 'Empty states ignored', detail: 'Logged-in views feel unfinished and erode trust.', evidence: 'Design empty states with guidance and quick wins inside {{builder}}.' },
      { title: 'Microcopy absent', detail: 'Forms lack helper text that eases friction.', evidence: 'Add short helper cues about time, requirements, or privacy in {{builder}}.' },
      { title: 'Motion not utilized', detail: 'Static screens miss subtle motion that signals polish.', evidence: 'Introduce lightweight hover states or transitions for CTAs in {{builder}}.' },
      { title: 'Information buried', detail: 'Critical onboarding details sit behind small links.', evidence: 'Promote onboarding overview into a card or stepper in {{builder}}.' },
      { title: 'Support response unclear', detail: 'Support options hide behind generic links.', evidence: 'State response times or add “We reply within X hrs” near support entry in {{builder}}.' },
      { title: 'Accessibility gaps', detail: 'Color contrast and focus states are inconsistent.', evidence: 'Audit contrast ratios and visible focus rings across {{builder}}.' },
      { title: 'Mobile polish lagging', detail: 'Mobile layout stacks elements awkwardly.', evidence: 'Preview key pages on mobile and rebalance spacing in {{builder}}.' },
      { title: 'Content lacks framing', detail: 'Sections begin abruptly without intro context.', evidence: 'Add short lead-in lines that frame why the section matters in {{builder}}.' },
      { title: 'Imagery mismatched', detail: 'Visuals don’t reinforce the promise being made.', evidence: 'Swap stock imagery for product or customer context in {{builder}}.' },
      { title: 'Settings feel tacked on', detail: 'Dashboard/secondary screens look like wireframes.', evidence: 'Bring dashboard styling in line with marketing polish inside {{builder}}.' }
    ]
  }
];

const REWRITE_RULES = [
  {
    condition: (scores) => scores.confidence < 55,
    variants: [
      { before: 'Your team will love this product.', after: 'Teams shipping in {{builder}} use AI Trust so buyers believe the experience before launch.', rationale: 'Pairs social proof with outcome.' },
      { before: 'Scale faster with us.', after: 'Let AI Trust reveal the exact screens eroding confidence, then patch them in {{builder}}.', rationale: 'Explains how the promise is delivered.' },
      { before: 'We unlock growth instantly.', after: 'Upload a screen, get a confidence score, and ship the fix the same day.', rationale: 'Spells out the path to value.' },
      { before: 'See why customers stay.', after: 'Show the exact moments AI Trust says build confidence, then reinforce them in {{builder}}.', rationale: 'Connects retention to specific moments.' },
      { before: 'We are the trusted choice.', after: 'Share the AI Trust scorecard that proves where buyers lean in and why.', rationale: 'Turns “trust” into a measurable asset.' },
      { before: 'Launch with certainty.', after: 'Run your flow through AI Trust and deliver every fix directly into {{builder}}.', rationale: 'Highlights the inspect → fix pipeline.' },
      { before: 'A better way to convert.', after: 'AI Trust spots the friction, your team patches it, and prospects feel ready to buy.', rationale: 'Clarifies the partnership dynamic.' },
      { before: 'Everything you need in one place.', after: 'Upload, score, and ship trust boosters without waiting on a full research cycle.', rationale: 'Reassures impatient teams.' }
    ]
  },
  {
    condition: (scores) => scores.clarity < 52,
    variants: [
      { before: 'One platform for everything.', after: 'AI Trust scores confidence, rewrites copy, and hands you CSS-ready tweaks.', rationale: 'Clarifies the workflow.' },
      { before: 'The easiest way to build trust.', after: 'See what reassures or scares buyers, then export fixes tailored to {{builder}}.', rationale: 'Connects the promise to the builder.' },
      { before: 'Improve UX with AI right now.', after: 'Upload, review the AI Trust scorecard, and copy the top fix into {{builder}}.', rationale: 'Gives a simple three-step process.' },
      { before: 'We simplify everything.', after: 'Explain what buyers feel, what to fix, and how to ship it inside {{builder}}—all in one pass.', rationale: 'Removes vague “simplify” language.' },
      { before: 'The best way to understand users.', after: 'AI Trust translates screenshots into a ranked list of clarity gaps to close.', rationale: 'Sets expectations about insight output.' },
      { before: 'Designed for product teams.', after: 'Product squads drop their latest screens in and get line-by-line fixes back.', rationale: 'Clarifies who it is for and what they receive.' },
      { before: 'Move faster with AI.', after: 'Use the scorecard to decide what to fix, then paste the rewrite and CSS tweak into {{builder}}.', rationale: 'Shows the entire motion.' },
      { before: 'Clarity without the guesswork.', after: 'Every scan highlights what confuses buyers and how to rewrite it in minutes.', rationale: 'Reinforces the clarity angle.' }
    ]
  },
  {
    condition: () => true,
    variants: [
      { before: 'Get started now.', after: 'Generate your AI Trust scorecard and copy the change buyers will feel immediately.', rationale: 'Describes the immediate payoff.' },
      { before: 'Join thousands of happy users.', after: 'Join teams that patch trust gaps before prospects ever feel them.', rationale: 'Adds context to social proof.' },
      { before: 'See the future of product building.', after: 'Know exactly where your flow loses confidence and fix it before launch.', rationale: 'Grounds futuristic language in outcome.' },
      { before: 'Ready when you are.', after: 'Whenever you need a gut-check, upload your latest flow and see how confident it feels.', rationale: 'Keeps tone approachable.' },
      { before: 'Ship with certainty.', after: 'Use the scorecard to align stakeholders on the next fix and why it matters.', rationale: 'Highlights stakeholder alignment.' },
      { before: 'Everything tuned for trust.', after: 'From copy to CSS, AI Trust points where to polish so buyers lean in.', rationale: 'Summarises overall value.' },
      { before: 'Confidence, on demand.', after: 'Drop your flow in, pull out focused fixes, and launch knowing what buyers will feel.', rationale: 'Highlights repeatable loops.' },
      { before: 'Make it feel right.', after: 'AI Trust catches the subtle friction so customers experience momentum, not doubt.', rationale: 'Touches on emotional payoff.' }
    ]
  }
];

const LOCKED_INSIGHTS = [
  { title: 'Pricing psychology teardown', summary: 'Highlights where prospects stall inside pricing and how to rebuild hierarchy.' },
  { title: 'Trust signal roadmap', summary: 'Lists credibility anchors (logos, quotes, guarantees) to add by section.' },
  { title: 'Conversion experiment kit', summary: 'Outlines three experiments with metrics, setup, and sample copy.' },
  { title: 'Messaging objection matrix', summary: 'Maps top objections to copy patterns that neutralise them.' },
  { title: 'Guided walkthrough critique', summary: 'Captures each step and marks where confusion spikes.' },
  { title: 'Activation rescue plan', summary: 'Details improvements for onboarding and empty states to keep momentum.' },
  { title: 'Hero heroics blueprint', summary: 'Breaks down headline, subhead, and CTA variants tested to lift first-click confidence.' },
  { title: 'Proof sequencing playbook', summary: 'Shows the order to introduce logos, metrics, and stories without overwhelming the flow.' },
  { title: 'Red flag detox', summary: 'Pinpoints anxiety-inducing phrases and proposes calmer replacements for each.' },
  { title: 'Retention cues audit', summary: 'Surface moments where long-term value is implied but not stated, with fixes.' },
  { title: 'International polish pack', summary: 'Flags localisation gaps and phrasing that may confuse non-native speakers.' },
  { title: 'Mobile-first tune-up', summary: 'Focuses on thumb zones, tap targets, and viewport-specific trust cues.' },
  { title: 'Nurture follow-up planner', summary: 'Outlines post-analysis email and in-product nudges to reinforce new messaging.' },
  { title: 'Experiment prioritisation board', summary: 'Ranks test ideas by confidence, impact, and effort with next-step owners.' },
  { title: 'Onboarding friction lens', summary: 'Finds the moments new users hesitate and offers microcopy to keep them moving.' },
  { title: 'Churn prevention kit', summary: 'Connects in-product trust cues to retention campaigns with messaging examples.' }
];

const BUILDER_AREAS = ['hero section', 'pricing grid', 'primary navigation', 'onboarding flow', 'dashboard layout', 'checkout form', 'feature comparison', 'testimonial row', 'empty states', 'mobile viewport'];
const BUILDER_VERBS = ['Tighten', 'Rework', 'Polish', 'Clarify', 'Re-sequence', 'Elevate'];
const BUILDER_DIRECTIVES = [
  'realign spacing tokens and remove duplicate CTAs',
  'add a proof row followed by a single decisive CTA',
  'introduce a short “How it works” ribbon to set expectations',
  'swap static imagery for product-in-action shots to ground the promise',
  'boost CTA contrast and microinteraction feedback',
  'break complex messaging into a headline plus two benefit bullets',
  'place inline reassurance about privacy or effort near forms',
  'layer customer quotes beside the primary action',
  'check mobile padding so touch targets stay at least 44px tall',
  'surface progress milestones to keep users confident'
];

const BUILDER_POINTERS = [];
for (const area of BUILDER_AREAS) {
  for (const verb of BUILDER_VERBS) {
    for (const directive of BUILDER_DIRECTIVES) {
      BUILDER_POINTERS.push((guidance) => ({
        title: `${verb} the ${area}`,
        detail: `In ${friendlyBuilderName(guidance)}, ${verb.toLowerCase()} the ${area} by ${directive}.`
      }));
    }
  }
}

const EXPERIMENT_LIB = [
  'Measure click-through after adding proof badges near the CTA in {{builder}}.',
  'Run a five-user interview to hear how they describe the offer back to you.',
  'A/B test a “What happens next” strip versus the current hero layout in {{builder}}.',
  'Track signup conversion after softening urgency copy to reassurance messaging.',
  'Add a secondary CTA that offers a low-friction tour and measure adoption.',
  'Enable session recording for the pricing page to observe hesitation points.',
  'Test an inline progress bar during signup and monitor completion rates.',
  'Swap the hero image for a product screencap and compare dwell time.',
  'Add a post-CTA reassurance tooltip and measure reduction in drop-off.',
  'Use exit-intent surveys to capture why visitors hesitate.',
  'Pilot a “Why teams choose us” carousel and track interaction depth.',
  'Set up a progressive disclosure test for pricing FAQs versus current layout.',
  'Prototype a lighter trial tier and measure completion of onboarding in {{builder}}.',
  'Invite power users to annotate uncertainty moments and compare against the scorecard.',
  'Introduce live chat on the pricing page for a week and log the top three questions.',
  'Send a follow-up survey after the new rewrite ships to gauge confidence shifts.',
  'Swap urgency copy for social proof in the hero and compare primary CTA clicks.',
  'Record moderated sessions where users narrate trust breakers across the flow.',
  'Bundle the CSS tweak into a launch note and monitor retention cohorts.'
];

const CHECKLIST_LIB = [
  'Confirm hero CTA maintains ≥3:1 contrast against its background.',
  'Add alt text to hero imagery to reinforce the promise.',
  'Place a short reassurance line near any pricing or signup ask.',
  'Ensure testimonials show full names, roles, and company logos.',
  'Run copy through a plain-language pass to remove jargon.',
  'Verify mobile spacing keeps sections scannable (min 24px blocks).',
  'Add context to form labels (e.g., “Team size — 5, 25, 100”).',
  'Check that error states explain how to recover.',
  'Provide a secondary “See how it works” path for skimmers.',
  'Confirm key screens load in under three seconds on mobile.',
  'Review navigation so only high-intent links remain in the hero.',
  'Add a short onboarding checklist for new users to build momentum.',
  'Audit keyboard navigation to ensure focus order follows visual hierarchy.',
  'Include a privacy or security assurance sentence near any data capture.',
  'Cross-check responsive typography to prevent oversized headings on mobile.',
  'Make sure pricing tables highlight the recommended plan with subtle contrast.',
  'Label uploaded screenshots with descriptive alt text when reused in marketing.',
  'Double-check that all CTAs describe the outcome (“View report”, not “Submit”).',
  'Ensure modals provide escape routes and do not trap focus.',
  'Note which sections lack supporting visuals and plan one contextual image each.'
];
function handleStripeWebhook(event) {
  const { type, data } = event;
  const object = data?.object || {};

  switch (type) {
    case 'checkout.session.completed': {
      const sessionId = object.metadata?.sessionId;
      const customerId = object.customer || null;
      if (sessionId) {
        markSessionSubscribed(sessionId, customerId);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const customerId = object.customer;
      const status = object.status;
      if (!customerId) break;
      if (['active', 'trialing', 'past_due'].includes(status)) {
        const sessionId = SESSION_INDEX_BY_CUSTOMER.get(customerId);
        if (sessionId) markSessionSubscribed(sessionId, customerId);
      } else if (['canceled', 'unpaid', 'incomplete_expired'].includes(status)) {
        markSessionUnsubscribed(customerId);
      }
      break;
    }
    case 'customer.subscription.deleted':
    case 'customer.subscription.expired': {
      const customerId = object.customer;
      if (customerId) {
        markSessionUnsubscribed(customerId);
      }
      break;
    }
    default:
      break;
  }
}

function markSessionSubscribed(sessionId, customerId) {
  const session = SESSION_STORE.get(sessionId);
  if (!session) return;
  session.isSubscribed = true;
  session.buildsUsed = 0;
  session.updatedAt = Date.now();
  if (customerId) {
    session.stripeCustomerId = customerId;
    SESSION_INDEX_BY_CUSTOMER.set(customerId, sessionId);
  }
}

function markSessionUnsubscribed(customerId) {
  const sessionId = SESSION_INDEX_BY_CUSTOMER.get(customerId);
  if (!sessionId) return;
  const session = SESSION_STORE.get(sessionId);
  if (!session) return;
  session.isSubscribed = false;
  session.updatedAt = Date.now();
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const key = decodeURIComponent(parts.shift().trim());
    const value = decodeURIComponent(parts.join('=') || '');
    cookies[key] = value;
  });
  return cookies;
}

function setCookie(res, name, value, options = {}) {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge) segments.push(`Max-Age=${options.maxAge}`);
  segments.push(`Path=${options.path || '/'}`);
  if (options.httpOnly) segments.push('HttpOnly');
  if (options.sameSite) segments.push(`SameSite=${options.sameSite}`);
  if (options.secure) segments.push('Secure');

  const cookie = segments.join('; ');
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie]);
  } else {
    res.setHeader('Set-Cookie', [existing, cookie]);
  }
}
