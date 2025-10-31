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
  const builderGuidance = getBuilderGuidance(builder);

  const flags = pickFlags(scores, builderGuidance, rng);
  const freeRewrite = pickRewrite(scores, builderGuidance, rng);
  const lockedInsights = pickLockedInsights(builderGuidance, rng);
  const builderActions = pickBuilderActions(builderGuidance, rng);
  const experiments = pickFromList(EXPERIMENT_TEMPLATES, rng, 2);
  const checklist = pickFromList(CHECKLIST_TEMPLATES, rng, 3);

  return {
    builder,
    tone,
    scores,
    flags,
    freeRewrite,
    lockedInsights,
    builderActions,
    experiments,
    checklist,
    metadata: {}
  };
}

function generateScores(rng) {
  const base = randomBetween(rng, 35, 80);
  const confidence = clampScore(base + randomBetween(rng, -5, 5));
  const pushiness = clampScore(confidence + randomBetween(rng, -5, 5));
  const clarity = clampScore(Math.round((confidence + pushiness) / 2) + randomBetween(rng, -4, 4));

  const scores = { confidence, pushiness, clarity };
  const values = Object.values(scores);
  const maxDiff = Math.max(...values) - Math.min(...values);
  if (maxDiff > 10) {
    const average = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    return {
      confidence: clampScore(average + randomBetween(rng, -4, 4)),
      pushiness: clampScore(average + randomBetween(rng, -4, 4)),
      clarity: clampScore(average + randomBetween(rng, -4, 4))
    };
  }

  return scores;
}

function pickFlags(scores, builderGuidance, rng) {
  const candidates = FLAG_TEMPLATES.filter((template) => template.condition(scores));
  const selected = [];

  const pool = candidates.length ? candidates : FLAG_TEMPLATES;
  const poolCopy = [...pool];
  while (selected.length < 3 && poolCopy.length) {
    const index = Math.floor(rng() * poolCopy.length);
    selected.push(poolCopy.splice(index, 1)[0]);
  }

  return selected.map((template) => template.build(scores, builderGuidance));
}

function pickRewrite(scores, builderGuidance, rng) {
  const candidates = REWRITE_TEMPLATES.filter((template) => template.condition(scores));
  const template = (candidates.length ? candidates : REWRITE_TEMPLATES)[Math.floor(rng() * (candidates.length || REWRITE_TEMPLATES.length))];

  return {
    before: template.before(builderGuidance),
    after: template.after(builderGuidance),
    rationale: template.rationale
  };
}

function pickLockedInsights(builderGuidance, rng) {
  const entries = pickFromList(LOCKED_INSIGHT_TEMPLATES, rng, 3);
  return entries.map((item) => ({
    title: item.title(builderGuidance),
    summary: item.summary(builderGuidance)
  }));
}

function pickBuilderActions(builderGuidance, rng) {
  const tips = Array.isArray(builderGuidance.tips) ? builderGuidance.tips : [];
  if (!tips.length) return [];
  const count = Math.min(2, tips.length);
  const chosen = pickFromList(tips, rng, count);
  return chosen.map((tip, idx) => ({
    title: idx === 0 ? `Start in ${builderGuidance.label}` : 'Polish the experience',
    detail: tip
  }));
}

function pickFromList(list, rng, count) {
  const copy = [...list];
  const result = [];
  while (result.length < count && copy.length) {
    const index = Math.floor(rng() * copy.length);
    result.push(copy.splice(index, 1)[0]);
  }
  return result;
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

function randomBetween(rng, min, max) {
  return Math.round(rng() * (max - min) + min);
}

const FLAG_TEMPLATES = [
  {
    condition: (scores) => scores.confidence < 50,
    build: (_scores, guidance) => ({
      title: 'Confidence is shaky',
      detail: 'The hero promise lacks proof or clarity so prospects hesitate to trust it.',
      evidence: `Add logos or wins directly under the CTA in ${guidance.label}.`
    })
  },
  {
    condition: (scores) => scores.clarity < 48,
    build: () => ({
      title: 'Flow feels ambiguous',
      detail: 'The first screen mixes multiple asks, creating analysis paralysis.',
      evidence: 'Keep one primary CTA and place supporting links below the fold.'
    })
  },
  {
    condition: (scores) => scores.pushiness > 60,
    build: () => ({
      title: 'Pushiness overtakes trust',
      detail: 'Scarcity language and aggressive CTAs raise skepticism instead of urgency.',
      evidence: 'Soften the tone and add a brief “what happens after” explanation.'
    })
  },
  {
    condition: (scores) => Math.min(scores.confidence, scores.clarity) >= 55 && scores.pushiness <= 55,
    build: () => ({
      title: 'Great tone, thin proof',
      detail: 'The narrative is pleasant but lacks a reason to believe.',
      evidence: 'Introduce one quantified outcome or testimonial within the first viewport.'
    })
  },
  {
    condition: (scores) => scores.confidence <= scores.pushiness && scores.confidence <= scores.clarity,
    build: () => ({
      title: 'Trust gap at the top',
      detail: 'Visitors are unsure why your product wins versus alternatives.',
      evidence: 'Add a comparison micro-table or credibility marker near the hero CTA.'
    })
  },
  {
    condition: (scores) => scores.clarity <= scores.confidence && scores.clarity <= scores.pushiness,
    build: () => ({
      title: 'Messaging overload',
      detail: 'Multiple headlines and buttons compete for attention, diluting intent.',
      evidence: 'Collapse secondary CTAs into subtle text links and keep one bold action.'
    })
  },
  {
    condition: () => true,
    build: () => ({
      title: 'Visual hierarchy drifts',
      detail: 'Spacing and contrast make it hard to scan the main outcome quickly.',
      evidence: 'Increase vertical rhythm (24–32px gaps) and use one highlight color for CTAs.'
    })
  },
  {
    condition: (scores) => scores.pushiness < 45,
    build: () => ({
      title: 'CTA lacks urgency',
      detail: 'A friendly tone is good but prospects need a reason to act now.',
      evidence: 'Add a short line about what they gain in the first session or week.'
    })
  },
  {
    condition: (scores) => scores.confidence > 70,
    build: () => ({
      title: 'Great proof, missing next step',
      detail: 'The offer feels credible, yet the path to value is still hidden.',
      evidence: 'Include a simple “Step 1–2–3” ribbon directly beneath the fold.'
    })
  },
  {
    condition: (scores) => scores.pushiness >= 55 && scores.clarity >= 55,
    build: () => ({
      title: 'Tone balanced, polish layout',
      detail: 'Copy is persuasive but visual rhythm makes scanning harder than it should be.',
      evidence: 'Increase padding inside cards and ensure primary CTA has 3:1 contrast.'
    })
  }
];

const REWRITE_TEMPLATES = [
  {
    condition: (scores) => scores.confidence < 50,
    before: () => 'Build your ideas faster with our platform.',
    after: (guidance) => `Launch a ${guidance.label} demo that wins trust in under 48 hours.`,
    rationale: 'Narrows the promise to an outcome and timeframe that feels believable.'
  },
  {
    condition: (scores) => scores.clarity < 50,
    before: () => 'We do everything you need for growth.',
    after: (guidance) => `Give visitors a clear next step: preview, personalize, and publish in ${guidance.label}.`,
    rationale: 'Clarifies the journey and makes the CTA more explicit.'
  },
  {
    condition: () => true,
    before: () => 'Join thousands of happy users today!',
    after: (guidance) => `Trusted by teams shipping in ${guidance.label}: see if your flow builds confidence in minutes.`,
    rationale: 'Adds proof language and specifies what happens after clicking.'
  }
];

const LOCKED_INSIGHT_TEMPLATES = [
  {
    title: (guidance) => 'Full pricing teardown',
    summary: (guidance) => `Shows where ${guidance.label} page loses trust and how to restructure tiers.`
  },
  {
    title: () => 'Trust signal roadmap',
    summary: () => 'Lists credibility anchors (logos, metrics, objections) to add by section.'
  },
  {
    title: () => 'Conversion experiment kit',
    summary: () => 'Outlines three experiments with metrics, setup, and sample copy.'
  },
  {
    title: () => 'Hero visual recommendations',
    summary: () => 'Suggests layouts and imagery to boost first-glance comprehension.'
  },
  {
    title: () => 'Friction heatmap',
    summary: () => 'Highlights the most confusing UI elements and how to stage them.'
  }
];

const EXPERIMENT_TEMPLATES = [
  'A/B test the hero CTA label with a promise-oriented variant.',
  'Run a five-user interview to hear how they describe the offer back to you.',
  'Measure click-through after adding proof badges near the CTA.',
  'Try a two-step form to capture intent before asking for detailed info.'
];

const CHECKLIST_TEMPLATES = [
  'Confirm hero CTA maintains 3:1 contrast against its background.',
  'Ensure mobile spacing keeps sections scannable (min 24px blocks).',
  'Add alt text to hero imagery to reinforce the promise.',
  'Capitalize only the first word of headlines for readability.',
  'Place a short reassurance line near any pricing or signup ask.'
];

function clampScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 50;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return Math.round(num);
}

function fallbackScorecard({ tone, builder }) {
  const guidance = getBuilderGuidance(builder);
  const tipList = Array.isArray(guidance.tips) ? guidance.tips : [];

  return {
    builder,
    tone,
    scores: { confidence: 55, pushiness: 45, clarity: 60 },
    flags: [
      {
        title: 'Unclear promise',
        detail: 'Hero copy mixes multiple outcomes, making it unclear what happens next.',
        evidence: 'Headline and subheadline should focus on a single transformation and CTA.'
      },
      {
        title: 'Missing proof',
        detail: 'Trust anchors are buried, forcing visitors to guess whether you deliver.',
        evidence: 'Add quantified outcomes or testimonial snippets above the fold.'
      },
      {
        title: 'CTA uncertainty',
        detail: 'Button text does not explain what happens after clicking.',
        evidence: 'Clarify the next step (e.g., “Start a 7-day guided trial”).'
      }
    ],
    freeRewrite: {
      before: 'All-in-one platform that does everything for everyone.',
      after: `Launch high-converting demos in ${guidance.label} tailored to your buyers in under 48 hours.`,
      rationale: 'Sharpen the promise to a specific audience and timeframe.'
    },
    lockedInsights: [
      {
        title: 'Pricing page teardown',
        summary: 'Breaks down the friction points across tiers and proposes a simplified layout.'
      },
      {
        title: 'Trust signal roadmap',
        summary: 'Recommends proof anchors, testimonial placement, and social validation steps.'
      },
      {
        title: 'Conversion experiment kit',
        summary: 'Outlines three experiments with metrics, setup, and sample copy.'
      }
    ],
    builderActions: tipList.slice(0, 2).map((tip, idx) => ({
      title: idx === 0 ? `Start in ${guidance.label}` : 'Polish with design tokens',
      detail: tip
    })),
    experiments: ['Run a before/after usability test focusing on first-click success.'],
    checklist: ['Verify mobile spacing in hero section.', 'Add success metrics near primary CTA.'],
    metadata: {}
  };
}
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
