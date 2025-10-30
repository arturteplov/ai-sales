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
  const { prompt = '', tone = 'low-tech', builder = 'Bubble' } = req.body || {};
  const files = req.files || [];

  if (!prompt.trim() && files.length === 0) {
    cleanupFiles(files);
    return res.status(400).json({ error: 'Please provide a description or at least one file.' });
  }

  try {
    const attachments = await Promise.all(
      files.map(async (file) => ({
        name: file.originalname,
        base64: await fileToBase64(file.path),
        mimeType: file.mimetype
      }))
    );

    const response = await callAdvisorModel({
      prompt,
      tone,
      builder,
      attachments
    });

    cleanupFiles(files);
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
  const { prompt = '', tone = 'low-tech', builder = 'No builder' } = req.body || {};
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
      attachments
    });

    cleanupFiles(files);

    session.buildsUsed = (session.buildsUsed || 0) + 1;
    session.lastBuild = { id: buildPlan.buildId, createdAt: Date.now(), summary: buildPlan.summary };

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
        product: 'AI Sales Phase 1 Builder',
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
  console.log(`AI Sales server running on http://localhost:${PORT}`);
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
        lastBuild: null
      });
      setCookie(res, SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: 'Lax', maxAge: 31536000 });
    }

    const session = SESSION_STORE.get(sessionId);
    session.updatedAt = Date.now();

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

async function callAdvisorModel({ prompt, tone, builder, attachments }) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (isSmallTalkPrompt(prompt, attachments)) {
    return buildSmallTalkAdvisorResponse({ prompt, tone, builder });
  }

  if (!apiKey) {
    return simulateAdvisorResponse({ prompt, tone, builder, attachments });
  }

  const toneGuidance = getToneGuidance(tone);
  const builderGuidance = getBuilderGuidance(builder);

  const systemPrompt = [
    'You are AI Sales — a senior product advisor and conversion-focused designer.',
    'You review web app screenshots and descriptions to spot friction that scares buyers and highlight trust builders.',
    'Always give direct, actionable steps.',
    'You must not change recommendation depth between tone modes; only adjust wording style.',
    'Tailor the final implementation tips to the user provided builder platform when available.',
    'Respond using the JSON schema provided so that the application can reliably render your feedback.'
  ].join(' ');

  const userContent = [
    {
      type: 'input_text',
      text: [
        `User tone preference: ${tone} (${toneGuidance.label}).`,
        `Preferred builder: ${builder}.`,
        'User brief:',
        prompt
      ].join('\n')
    },
    ...attachments.map((file) => ({
      type: 'input_image',
      image_base64: file.base64
    }))
  ];

  const responseFormat = {
    type: 'json_schema',
    name: 'ai_sales_review',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['headline', 'summary', 'friction_score', 'findings', 'builder_actions', 'reassurance', 'suggested_prompts'],
      properties: {
        headline: { type: 'string', description: 'Short sentence summarising the main issue or opportunity.' },
        summary: { type: 'string', description: 'Concise paragraph overviewing the current state and what matters most.' },
        friction_score: {
          type: 'object',
          additionalProperties: false,
          required: ['numeric', 'label', 'rationale'],
          properties: {
            numeric: { type: 'integer', minimum: 1, maximum: 5, description: '1 = very low friction, 5 = very high friction.' },
            label: { type: 'string', description: 'Label describing the numeric score (e.g., Very Low, Low, Moderate, Elevated, High).' },
            rationale: { type: 'string', description: 'Why the score was chosen.' }
          }
        },
        findings: {
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
        builder_actions: {
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
        reassurance: { type: 'string', description: 'Closing reassurance or guidance for next steps.' },
        suggested_prompts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional suggestions for what the user could ask next.'
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
          { type: 'input_text', text: builderGuidance.system }
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

  try {
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
      throw new Error(`OpenAI error: ${response.status} ${text}`);
    }

    const result = await response.json();
    const structured = extractStructuredPayload(result);
    if (!structured) {
      console.warn(
        'Advisor response missing structured payload.',
        JSON.stringify(result).slice(0, 2000)
      );
      throw new Error('Model did not return structured payload.');
    }

    return normalizeLLMResponse(structured, { tone, builder });
  } catch (error) {
    console.error('Falling back to simulated advisor output:', error.message);
    return simulateAdvisorResponse({ prompt, tone, builder, attachments });
  }
}

async function callBuilderModel({ prompt, tone, builder, attachments }) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return simulateBuilderPlan({ prompt, tone, builder, attachments });
  }

  const builderGuidance = getBuilderGuidance(builder);
  const toneGuidance = getToneGuidance(tone);

  const systemPrompt = [
    'You are AI Sales — a senior product engineer and product designer hybrid.',
    'Given a product brief and optional visuals, produce a concise build-ready plan that contains screens, flows, data model, and builder-specific steps.',
    'Keep instructions technology-aware based on the provided builder, and surface actionable export hints.',
    'Respond using the JSON schema so the application can render the plan reliably.'
  ].join(' ');

  const userContent = [
    {
      type: 'input_text',
      text: [
        `Preferred builder: ${builderGuidance.label}.`,
        `Tone: ${toneGuidance.label}.`,
        'Brief:',
        prompt
      ].join('\n')
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
        content: [{ type: 'input_text', text: systemPrompt }]
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

function simulateAdvisorResponse({ prompt, tone, builder, attachments }) {
  const toneGuidance = getToneGuidance(tone);
  const builderGuidance = getBuilderGuidance(builder);
  const visualNote = attachments.length
    ? `I reviewed ${attachments.length} visual asset${attachments.length > 1 ? 's' : ''}. `
    : 'I do not have visuals yet, so this read is based on your description. ';

  const headline =
    tone === 'low-tech'
      ? 'Here is what will make things smoother:'
      : tone === 'mid-tech'
      ? 'Here is a clear plan with light terminology:'
      : 'Detailed playbook with full terminology:';

  const frictionScore = mockScore(prompt, attachments.length);
  const suggestions = [
    {
      title: 'Tighten the hero narrative',
      detail: toneGuidance.rewrite(
        'State the problem, outcome, and credibility signal in one hero block, with the primary call-to-action visible without scrolling.'
      )
    },
    {
      title: 'De-risk the next click',
      detail: toneGuidance.rewrite(
        'Clarify pricing or onboarding time near the call-to-action so visitors feel safe proceeding.'
      )
    }
  ];

  const builderActions = [
    {
      title: `Implement inside ${builderGuidance.label}`,
      detail: toneGuidance.rewrite(builderGuidance.tip)
    }
  ];

  return {
    mode: tone,
    builder,
    frictionScore,
    frictionLabel: scoreLabel(frictionScore),
    frictionRationale: toneGuidance.rewrite(
      'Focus on clarity of promise, supportive evidence, and remove visual distractions so customers feel in control.'
    ),
    headline,
    summary: `${visualNote}Estimated client friction: ${scoreLabel(frictionScore)}.`,
    suggestions,
    builderActions,
    reassurance: toneGuidance.rewrite(
      'You can ask for more detail on any step, or let AI Sales draft the screens when you are ready.'
    ),
    suggestedPrompts: [
      'Show me a revised hero copy and hierarchy.',
      `Give me a checklist to update in ${builderGuidance.label === builder ? builder : 'my builder'}.`
    ],
    raw: {
      headline,
      summary: `${visualNote}Estimated client friction: ${scoreLabel(frictionScore)}.`,
      friction_score: {
        numeric: frictionScore,
        label: scoreLabel(frictionScore),
        rationale: 'Based on spacing, messaging, and proof signals described.'
      },
      findings: suggestions,
      builder_actions: builderActions,
      reassurance: toneGuidance.rewrite(
        'You can ask for more detail on any step, or let AI Sales draft the screens when you are ready.'
      )
    }
  };
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
        detail: builderGuidance.tip
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

function normalizeLLMResponse(payload, { tone, builder }) {
  const parsed = typeof payload === 'string' ? safeJsonParse(payload) : payload;
  const fallbackText = typeof payload === 'string' ? payload : JSON.stringify(payload || {});

  const frictionData = parsed?.friction_score || {};
  const frictionNumeric = Number.isFinite(frictionData.numeric) ? frictionData.numeric : extractScore(fallbackText);
  const frictionLabel = frictionData.label || scoreLabel(frictionNumeric);
  const frictionRationale = frictionData.rationale || extractReassurance(fallbackText);

  const findings = Array.isArray(parsed?.findings) && parsed.findings.length > 0 ? parsed.findings : extractSuggestions(fallbackText);
  const builderActions = Array.isArray(parsed?.builder_actions) && parsed.builder_actions.length > 0 ? parsed.builder_actions : findings;

  return {
    mode: tone,
    builder,
    raw: parsed,
    headline: parsed?.headline || findings?.[0]?.title || 'Here is what I noticed:',
    summary: parsed?.summary || fallbackText,
    frictionScore: frictionNumeric,
    frictionLabel,
    frictionRationale,
    suggestions: findings.map((item, idx) => ({
      title: item.title || `Insight ${idx + 1}`,
      detail: item.detail || (typeof item === 'string' ? item : JSON.stringify(item))
    })),
    builderActions: builderActions.map((item, idx) => ({
      title: item.title || `Builder step ${idx + 1}`,
      detail: item.detail || (typeof item === 'string' ? item : JSON.stringify(item))
    })),
    reassurance: parsed?.reassurance || frictionRationale,
    suggestedPrompts: parsed?.suggested_prompts || []
  };
}

function isSmallTalkPrompt(prompt = '', attachments = []) {
  if (!prompt || attachments.length > 0) return false;
  const text = prompt.trim().toLowerCase();
  if (!text) return false;

  if (text.length > 160) return false;

  const engagementKeywords = [
    'landing',
    'pricing',
    'signup',
    'checkout',
    'conversion',
    'hero',
    'button',
    'flow',
    'screen',
    'ui',
    'ux',
    'user'
  ];
  if (engagementKeywords.some((kw) => text.includes(kw))) {
    return false;
  }

  const smallTalkTriggers = [
    'how is it going',
    'how are you',
    'what is up',
    "what's up",
    'hello',
    'hi there',
    'hey there',
    'good morning',
    'good evening',
    'thanks',
    'thank you',
    'great job',
    'awesome',
    'cool'
  ];

  return smallTalkTriggers.some((phrase) => text.includes(phrase));
}

function buildSmallTalkAdvisorResponse({ prompt = '', tone, builder }) {
  const toneGuidance = getToneGuidance(tone);
  const builderGuidance = getBuilderGuidance(builder);
  const promptSnippet = prompt.trim() ? `You said “${prompt.trim()}.” ` : '';

  const headlineBase = 'Quick pulse check before we dive in.';
  const summaryBase = `${promptSnippet}I’m here to audit your product experience. Share a flow, screenshots, or your current challenge and I’ll pinpoint what builds trust and what creates friction.`;

  const insightDetail =
    'Tell me about a screen, funnel, or mindset you want prospects to have. The richer the context, the sharper the recommendations.';

  return {
    headline: toneGuidance.rewrite(headlineBase),
    summary: toneGuidance.rewrite(summaryBase),
    friction_score: {
      numeric: 3,
      label: 'Moderate',
      rationale: toneGuidance.rewrite(
        'I have not evaluated a specific experience yet—once you share it, I will score the friction and explain why.'
      )
    },
    findings: [
      {
        title: toneGuidance.rewrite('Point me at a specific moment.'),
        detail: toneGuidance.rewrite(insightDetail)
      }
    ],
    builder_actions: [
      {
        title: toneGuidance.rewrite(`Prep for ${builderGuidance.label}`),
        detail: toneGuidance.rewrite(
          `Jot down what feels clunky today, then share the screen or flow. I’ll translate improvements into ${builderGuidance.label} steps like: ${builderGuidance.tip}`
        )
      }
    ],
    reassurance: toneGuidance.rewrite(
      'Once you share the experience, I’ll respond immediately with a tailored teardown.'
    ),
    suggested_prompts: [
      'Audit my onboarding screen flow.',
      'Review the hero section copy.',
      `Show me how to improve the pricing experience in ${builderGuidance.label === builder ? builder : 'my builder'}.`
    ]
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
  const guides = {
    'No builder': {
      label: 'No builder specified',
      system:
        'When users do not specify a builder, keep implementation guidance technology-agnostic and focus on general UX/UI patterns.',
      tip: 'Apply the suggested hierarchy, spacing, and copy changes directly in your design or codebase; ensure your primary CTA uses a white background, bold black text, and has trust signals nearby.'
    },
    Bubble: {
      label: 'Bubble builder',
      system:
        'When users mention Bubble, map steps to Bubble editor workflows and reference responsive engine updates.',
      tip: 'Open the hero group, enable Responsive Engine gap of 24px, update the heading text, and align the primary button style to the brand color.'
    },
    Base44: {
      label: 'Base44',
      system:
        'Reference Base44’s block-based editor, canvas layout, and exportable components when guiding implementation.',
      tip: 'Open the target canvas, swap in the refined hero block copy, update the primary action color to #4E5CF0, and add a proof section beneath the hero using Base44 blocks.'
    },
    Webflow: {
      label: 'Webflow',
      system: 'Reference Webflow designer panels, style classes, and publish workflow.',
      tip: 'Edit the hero wrapper class, adjust the max-width to 640px, and update the CTA button class with padding 16px × 32px and radius 14px before you publish.'
    },
    Glide: {
      label: 'Glide',
      system: 'Provide guidance referencing Glide layout editor and theme settings.',
      tip: 'Change the inline list order so testimonials sit above pricing, and adjust the accent color under Theme → Brand to match the new call-to-action styling.'
    },
    Retool: {
      label: 'Retool',
      system:
        'Reference Retool component tree and the way workflows are configured for internal tools.',
      tip: 'Open the form container, adjust label typography to 14px SemiBold, add helper text for each input, and ensure the submit action posts analytics events.'
    },
    Softr: {
      label: 'Softr',
      system: 'Reference Softr blocks and the simple publish workflow.',
      tip: 'Switch the hero block to “Modern Hero”, update the copy, and add a trusted-by logos block directly under the hero using the library.'
    },
    FlutterFlow: {
      label: 'FlutterFlow',
      system: 'Tie instructions to FlutterFlow page editor and Theme overrides.',
      tip: 'Edit the Landing Screen, update the AppBar text, tweak the primary button style under Theme, and move the KPI cards above the fold.'
    },
    Adalo: {
      label: 'Adalo',
      system: 'Reference screens, components, and global styles in Adalo.',
      tip: 'Open the Landing Screen, update the headline, adjust the button style to “Primary Solid”, and add a simple social proof list below it.'
    }
  };

  return (
    guides[builder] || {
      label: builder,
      system:
        'Provide general implementation guidance without assuming a specific builder. Offer HTML/CSS actions if useful.',
      tip: 'Replicate these steps in your builder’s hero section, button styles, and trust indicators.'
    }
  );
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

async function handleStripeWebhook(event) {
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
