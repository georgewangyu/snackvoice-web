# snackvoice-web

Landing page and purchase flow for SnackVoice, a Mac speech-to-text app.

Live site: https://snackvoice.snackoverflowgeorge.com

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
- `S3_SIGNED_URL_TTL_SECONDS` (link lifetime, default 86400)

Optional CloudFront delivery. When all three are set, the DMG download links
and updater archive links the backend signs are CloudFront signed URLs, so they
do not expose the bucket, account, or access key id. When all are unset, links
fall back to S3 presigned URLs (preview and local dev). A partial or invalid
config also falls back, and logs a warning. Object metadata reads stay on S3.

- `CLOUDFRONT_DOWNLOAD_DOMAIN` (bare hostname, for example `downloads.example.com`)
- `CLOUDFRONT_KEY_PAIR_ID` (public key id in the distribution's trusted key group)
- `CLOUDFRONT_PRIVATE_KEY` (PEM; literal `\n` sequences are accepted)

The CloudFront distribution is configured outside this repo. It needs:

- A default behavior that requires signed URLs, does not cache (DMGs are
  overwritten at fixed keys), and forwards only the
  `response-content-disposition` and `response-content-type` query strings to S3
  so downloads keep their versioned filename.
- Any public behaviors (for example the stable updater archive prefix) must not
  forward query strings, so the extra signature parameters are ignored there.

```bash
npm run test:download-urls
```

## Status

This is the web purchase surface for the SnackVoice desktop app, not the app runtime itself. Product copy, checkout behavior, and download links should stay consistent with the release pipeline in the main app repo.
