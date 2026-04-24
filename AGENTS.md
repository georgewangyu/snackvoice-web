# AGENTS.md — snackvoice-web

Landing page and purchase flow for SnackVoice (Mac speech-to-text app).

## Stack

- **Frontend**: Vanilla HTML/CSS/JS, no framework
- **Backend**: Node.js
- **Payments**: Stripe Checkout (hosted, one-time payment)
- **QA**: Puppeteer (`npm run qa`)

## Dev

```bash
npm install
cp backend/.env.example backend/.env   # fill in keys
npm run dev                            # starts server on :4200
npm run qa                             # run Puppeteer tests (server must be running)
```

## Purchase Flow

```
User clicks CTA
  → POST /api/create-checkout
  → Stripe Checkout session created
  → Redirect to Stripe hosted checkout
  → Payment succeeds
  → Stripe fires webhook to POST /api/webhook
  → Server verifies signature
  → Saves order to backend/data/orders.json
  → User lands on /success.html
```

## Mac App Delivery

- Use S3 as the download source of truth (same bucket path updated by SnackVoice release pipeline)
- Configure `S3_BUCKET`, `S3_KEY_ARM64`, `S3_KEY_X64`, and `AWS_REGION` in `.env`
- User downloads, drags to Applications, and launches

## Key Files

- `index.html` — landing page
- `success.html` — post-purchase page
- `assets/styles.css` — all design tokens + global styles
- `assets/main.js` — CTA → checkout redirect logic
- `backend/server.js` — API routes + webhook handler
- `backend/.env.example` — required environment variables
- `scripts/qa.js` — Puppeteer test suite
- `docs/frontend-design-language/01-tokens.md` — design token reference

## Design Language

Dark premium palette from the SnackVoice app:
- Background: `#2c2b29` (warm dark)
- Accent: `#7c6feb` (purple, from app's `--color-logo-primary`)
- Text: `#fbfbfb`
- Font: Inter
