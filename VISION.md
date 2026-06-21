# SnackVoice Web Vision

SnackVoice Web should be the landing page, purchase flow, and download surface
for the SnackVoice Mac app.

## Product Thesis

The web repo is useful when it makes the paid Mac app easy to understand, buy,
and download while staying aligned with the desktop release pipeline. Stripe
owns payment, S3 owns downloadable artifacts, and the page should stay simple.

## Goals

- Keep the landing page fast, direct, and visually aligned with the app.
- Preserve Stripe Checkout as the payment boundary.
- Use S3 as the download source of truth shared with the desktop release flow.
- Keep QA focused on the purchase and download path.

## Non-Goals

- Do not turn the site into a full marketing CMS.
- Do not fork release artifact truth away from the desktop pipeline.
- Do not hide payment, webhook, or S3 configuration gaps behind local success
  states.
