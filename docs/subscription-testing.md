# Subscription Testing Checklist

This checklist validates the full v1 billing + entitlement + quota backend flow.

Quick automated pass:

```bash
npm run test:subscription:integration
```

Full closed-loop pass (integration + auto-start server + QA):

```bash
npm run test:closed-loop
```

## 0) Preconditions

1. Fill `backend/.env` with valid Stripe test keys.
2. Set both recurring prices:
   - `STRIPE_PRICE_ID_MONTHLY`
   - `STRIPE_PRICE_ID_ANNUAL`
3. Optional: for Supabase-backed storage set:
   - `SUPABASE_DB_URL` (or `DATABASE_URL`)
   - `SUPABASE_DB_SSL=true`
4. Start local API:
   - `npm run dev`
5. Start Stripe webhook forwarding in a second shell:
   - `stripe listen --forward-to http://localhost:4200/api/webhook`
   - copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET`

## 1) Sign in First (Required for Checkout)

1. Create an account:

```bash
curl -s -X POST http://localhost:4200/api/auth/sign-up \
  -H 'Content-Type: application/json' \
  -d '{"email":"you+monthly@test.com","password":"password123"}'
```

2. For an existing account, sign in:

```bash
curl -s -X POST http://localhost:4200/api/auth/sign-in \
  -H 'Content-Type: application/json' \
  -d '{"email":"you+monthly@test.com","password":"password123"}'
```

3. Copy returned `token` as `SESSION_TOKEN`.

## 2) Checkout and Subscription Lifecycle

1. Create monthly checkout:

```bash
curl -s -X POST http://localhost:4200/api/create-checkout \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer SESSION_TOKEN" \
  -d '{"plan":"monthly"}'
```

2. Create annual checkout:

```bash
curl -s -X POST http://localhost:4200/api/create-checkout \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer SESSION_TOKEN" \
  -d '{"plan":"annual"}'
```

3. Open returned Stripe URL(s), complete checkout with test card, then verify:
   - For JSON storage: `backend/data/orders.json` has fulfilled order row.
   - For JSON storage: `backend/data/billing.json` has:
     - user (`users[]`)
     - checkout session (`checkoutSessions[]`)
     - subscription (`subscriptions[]`)
     - processed webhook event IDs (`webhookEvents[]`).
   - For Supabase storage: same records exist in `snackvoice_kv_*` tables.

4. Billing portal:

```bash
curl -s -X POST http://localhost:4200/api/manage-subscription \
  -H "Authorization: Bearer SESSION_TOKEN"
```

Open returned URL, modify/cancel subscription, verify `subscriptions[].status`
and `currentPeriodEnd` update after webhooks.

## 3) Auth + Entitlement

Fetch entitlement with session token:

```bash
curl -s http://localhost:4200/api/entitlement \
  -H "Authorization: Bearer SESSION_TOKEN"
```

Expect for paid account:
- `accountStatus = paid_active`
- `isUnlimited = true`

## 4) Free-Tier Quota + Thresholds

Sign in a free-tier account and capture its token as `FREE_TOKEN`:

```bash
curl -s -X POST http://localhost:4200/api/auth/sign-up \
  -H 'Content-Type: application/json' \
  -d '{"email":"free-user@test.com","password":"password123"}'
```

Then consume words:

```bash
curl -s -X POST http://localhost:4200/api/usage/consume-words \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer FREE_TOKEN" \
  -d '{"words":850}'

curl -s -X POST http://localhost:4200/api/usage/consume-words \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer FREE_TOKEN" \
  -d '{"words":100}'

curl -s -X POST http://localhost:4200/api/usage/consume-words \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer FREE_TOKEN" \
  -d '{"words":100}'
```

Expected behavior:
- Warning levels progress as quota drops:
  - `warn_20` around <=20%
  - `low_10` around <=10%
  - `critical_5` around <=5%
  - `exhausted` at 0
- When exhausted, endpoint returns `402` and `blocked=true`.
- Counters are account-level, shared by all clients/devices using same email.

## 5) Idempotency Safety

Replay the same webhook event payload twice (Stripe CLI can resend).  
Expected:
- second process returns duplicate acknowledgement
- no duplicate subscription/order corruption
- `webhookEvents[]` dedupes by `eventId`
