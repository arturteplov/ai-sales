# AI Trust – Confidence Scorecard App

AI Trust lets teams drop in the latest product screenshots, see instant confidence / pushiness / clarity scores, and—after upgrading—download a curated PDF playbook that matches their results. The earlier chat-centric prototype has been retired; Phase 1 is now a focused scorecard + report experience.

## Feature highlights

- **Scorecard-first UX** – Users upload up to six PNG/JPG/PDF files and get a three-metric scorecard with tailored guidance, rewrites, experiments, and checklists.
- **Builder-aware insights** – Extras reference the selected builder (Bubble, Webflow, Glide, etc.) so fixes feel native to each tool.
- **Deterministic fallbacks** – If `OPENAI_API_KEY` is missing, the server still returns seeded variants so the UI stays shareable.
- **Stripe upgrade flow** – `Generate full build plan ($7/mo)` launches a Stripe Checkout payment session; on return, the success page streams the matched PDF automatically.
- **PDF library routing** – Place `Confidence_Report_##.pdf` files in `reports/`; `/api/reports/download` finds the closest suffix to the user’s confidence score. A single `example_*.pdf` powers the “See an example” modal.

## Quickstart

```bash
npm install
npm run dev
```

The server runs on `http://localhost:3000` and serves the SPA from `public/`.

## Environment variables

Create a `.env` file (or set these in your deploy platform):

```bash
OPENAI_API_KEY=sk-...                       # optional; enables live LLM analysis
OPENAI_MODEL=gpt-4o-2024-08-06              # optional override
STRIPE_SECRET_KEY=sk_live_...               # required for live payments
STRIPE_PRICE_ID=price_123                   # required when Stripe is enabled
STRIPE_WEBHOOK_SECRET=whsec_...             # verify Checkout webhooks
STRIPE_MODE=payment                         # 'payment' (one-time) or 'subscription'; defaults to payment
CHECKOUT_SUCCESS_URL=https://ai-trust.onrender.com/success
CHECKOUT_CANCEL_URL=https://ai-trust.onrender.com/cancel
TRIAL_DAYS=0                                # optional Stripe trial length
PORT=3000                                   # optional server port
FREE_BUILD_LIMIT=1                          # free “build” allowance before paywall
```

- Missing `OPENAI_API_KEY` → responses are generated from seeded templates.
- Missing Stripe keys → `/api/payments/checkout` returns 503 and the UI shows the error.

## Storage and assets

- Temporary uploads live in `tmp_uploads/` and are deleted right after analysis.
- Curated reports live in `reports/` (gitignored). Use filenames like `Confidence_Report_45.pdf`. The suffix drives the score matching logic. Include `example_Confidence_Report_88.pdf` (or another `example_*.pdf`) for the modal preview.

## Payment flow

1. User clicks **Generate full build plan ($7/mo)**.  
2. `/api/payments/checkout` creates a Stripe Checkout session (`STRIPE_MODE` controls one-time vs subscription).  
3. Stripe redirects back to `/success`; the page immediately fetches `/api/reports/download`.  
4. The server looks up the last confidence score, selects the closest PDF, and streams it.

Use Stripe’s test cards while `sk_test_*` / `price_test_*` keys are set. To go live, flip the Stripe dashboard out of test mode, generate `sk_live_*` keys + a live price, and update Render env vars. Make sure your `/success` and `/cancel` URLs point at the public domain.

## Project structure

```
public/          # Front-end HTML, CSS, JS
public/app.js    # Main SPA logic (scorecard, checkout, example modal)
server/index.js  # Express app, LLM + Stripe integrations, report routing
reports/         # Curated PDF library (gitignored except .gitkeep)
tmp_uploads/     # Ephemeral uploads (gitignored)
.env             # Local secrets (gitignored)
```

## Deploy notes

- Node 18+ runtime required.  
- On Render, open the service → **Settings → Custom Domains** and add `https://ai-trust.onrender.com/` (or your own hostname). Remove the default name once the new host is active.
- Mirror the `.env` values in Render’s Environment tab and redeploy.  
- Before flipping Stripe to live mode, ensure `/privacy` and `/terms` reflect your actual policies.

## Roadmap ideas

- Persist sessions with magic links so users can revisit scorecards.  
- Store upload history + reports in S3 for longitudinal tracking.  
- Expand the PDF generator with branded templates and white-label options.  
- Hook in analytics (PostHog / Amplitude) and live support.  
- Reintroduce a chat or builder export once Phase 2 is scoped.

Ship the repo as-is to early testers: upload screenshots, review the scorecard, click **Generate full build plan** to test Stripe’s flow, or wire live keys when you’re ready to charge.
