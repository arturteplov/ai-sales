# AI Trust – Phase 1 Advisor App

Full-stack implementation of the Phase 1 “Recommended advisor + follow-up builder” experience. The app serves a zero-login chat workspace, ingests screenshots, communicates with OpenAI (or a local simulator) for advice, and exposes a Stripe checkout entry point for the upcoming builder subscription.

## Features

- **Tone-aware advisor** — three selectable language modes that only change wording, not recommendation depth.
- **Screenshot upload + secure cleanup** — accepts up to six PNG/JPG/PDF files per session; temporary files removed after analysis.
- **LLM-backed insights** — server can call GPT‑4o (or any model via `OPENAI_*` env) with both text + image context. Fallback simulator keeps the UI responsive if no API key is present.
- **Builder-specific prompts** — tailored “copy & apply” instructions for Bubble, Webflow, Glide, Softr, Retool, FlutterFlow, Adalo, Glide Pages.
- **Monetisation hook** — `/api/payments/checkout` creates Stripe Checkout sessions for a subscription upgrade (disabled until keys are provided).
- **Transcripts & trust microcopy** — users can download the chat, get friction scoring, and receive reassurance/next-step messaging.

## Getting started

```bash
npm install
npm run dev
```

The server boots on `http://localhost:3000` and serves the SPA from `public/`.

### Environment variables

Create a `.env` file at the project root (or export these env vars):

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-2024-08-06        # optional override
STRIPE_SECRET_KEY=sk_live_...         # optional, enables payments
STRIPE_PRICE_ID=price_123             # required when Stripe is enabled
CHECKOUT_SUCCESS_URL=http://localhost:3000/success # use production URL after deploy
CHECKOUT_CANCEL_URL=http://localhost:3000/cancel   # use production URL after deploy
TRIAL_DAYS=7                          # optional, Stripe trial length
PORT=3000                             # optional server port
```

- If `OPENAI_API_KEY` is missing, the backend returns a deterministic mock response so the front end stays demo-ready.
- If `STRIPE_SECRET_KEY` or `STRIPE_PRICE_ID` are missing, `/api/payments/checkout` responds with a 503 and the client surfaces the error.

### File storage

Uploaded files are placed in `tmp_uploads/` and deleted immediately after each analysis request. Mount this directory to fast ephemeral storage if deploying on platforms like Render, Fly.io, or Railway.

### Payment integration

Once Stripe keys are present, clicking “Ask AI Trust to build it for you” issues a Checkout session using subscription mode (price defined by `STRIPE_PRICE_ID`). Adjust mode/line items to charge per build or per credit if preferred.

## Project structure

```
public/          # Front-end HTML, CSS, JS
server/index.js  # Express app, OpenAI + Stripe integrations
tmp_uploads/     # Runtime temp directory (ignored)
.env             # Secrets (ignored)
```

## Deployment checklist

- Provide the environment variables above (especially OpenAI & Stripe).
- Ensure the hosting platform can run a Node 18+ process and retain a temp folder.
- Configure your domain (e.g. https://aisales.com) to point at the Node service.
- Harden privacy notice & ToS in the UI before public release.

## Next steps / Phase 2 hooks

- Add authenticated sessions (email magic links or SSO) for saved workspaces.
- Store conversation history + uploaded assets in a database/S3 with signed URLs.
- Wire the builder CTA to the upcoming exportable builder service once ready.
- Instrument analytics (PostHog, Amplitude) around tone selection, friction scores, checkout conversions.
- Add customer support surface (Intercom/Chatwoot) for real-time help.

This codebase is ready to share with early testers or stakeholders; plug in keys, deploy, and you can collect real-world feedback today.
