# snackvoice-web

Landing page and purchase flow for SnackVoice, a Mac speech-to-text app.

This repo contains the public marketing page, Stripe Checkout handoff, post-purchase success page, and download delivery logic for the desktop app. It is intentionally small: vanilla HTML/CSS/JS on the frontend, a Node server for checkout and webhook handling, and Puppeteer checks for the main user flow.

## What is here

- `index.html` - landing page and primary call to action
- `success.html` - post-purchase download page
- `assets/styles.css` - design tokens and site styling
- `assets/main.js` - checkout button behavior
- `backend/server.js` - API routes, Stripe Checkout, webhook verification, and app download links
- `backend/.env.example` - required environment variables
- `scripts/qa.js` - Puppeteer smoke tests
- `docs/frontend-design-language/` - design token notes for keeping the site aligned with the app

## Local setup

```bash
npm install
cp backend/.env.example backend/.env
npm run dev
```

The server runs on `http://localhost:4200` by default.

Fill in the Stripe, app URL, and S3 delivery values in `backend/.env` before testing a real checkout flow. For local page work, placeholder values are enough to run the site.

## Verify the purchase flow

Start the server, then run:

```bash
npm run qa
```

The QA script opens the site with Puppeteer and checks the main landing-to-checkout path. For webhook and subscription checks, see:

```bash
npm run test:subscription:integration
npm run test:closed-loop
```

## Delivery model

SnackVoice app builds are delivered from S3. The backend reads the configured bucket/key values and signs the download URL for the success page.

Required S3 settings:

- `S3_BUCKET`
- `S3_KEY_ARM64`
- `S3_KEY_X64`
- `AWS_REGION`

## Status

This is the web purchase surface for the SnackVoice desktop app, not the app runtime itself. Product copy, checkout behavior, and download links should stay consistent with the release pipeline in the main app repo.
