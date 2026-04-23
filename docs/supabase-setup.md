# Supabase Setup (CLI-First)

This repo now supports two storage modes:
- default: local JSON files (`backend/data/*.json`)
- production-ready: Supabase Postgres (`SUPABASE_DB_URL` or `DATABASE_URL`)

For auth, this repo supports:
- production/default: Supabase Auth (`SUPABASE_URL` + `SUPABASE_ANON_KEY`)
- local fallback: backend-managed password/session (used when Supabase auth env vars are omitted)

## 1) Install + Login

```bash
brew install supabase/tap/supabase
supabase login
```

## 2) Link the Project

```bash
supabase link --project-ref YOUR_PROJECT_REF
```

## 3) Apply Repo Migration

The migration lives at:
- `supabase/migrations/20260419_000001_snackvoice_billing.sql`

Run:

```bash
supabase db push
```

## 4) Set Runtime Env Vars

In `backend/.env` set:

```bash
SUPABASE_DB_URL=postgresql://postgres:<password>@<host>:5432/postgres
SUPABASE_DB_SSL=true
SUPABASE_DB_POOL_MAX=8
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=ey...
SUPABASE_SIGNUP_AUTO_SIGNIN=false
```

Notes:
- `DATABASE_URL` is also supported as an alias for `SUPABASE_DB_URL`.
- If `SUPABASE_DB_URL`/`DATABASE_URL` is missing, backend automatically falls back to JSON file storage.
- Keep `SUPABASE_SIGNUP_AUTO_SIGNIN=false` in production to avoid doubling auth calls during signup spikes.

## Production Signup Throughput Checklist

For real-world volume, do this before launch:

1. Configure custom SMTP in Supabase Auth (do not rely on Supabase default mailer).
2. Keep email confirmation enabled unless you intentionally want password-only onboarding.
3. Set Auth URL config correctly in Supabase dashboard:
   - Site URL points to your production app domain.
   - Redirect URL allowlist includes your app callback URLs.
4. Use `SUPABASE_SIGNUP_AUTO_SIGNIN=false` so signup issues only one Supabase auth call.
5. Monitor Supabase Auth 429s and invalid-email errors after launch to tune onboarding UX.

## 5) Verify Storage Mode

Start server:

```bash
npm run dev
```

Create a test account once:

```bash
curl -s -X POST http://localhost:4200/api/auth/sign-up \
  -H 'Content-Type: application/json' \
  -d '{"email":"db-check@test.com","password":"password123"}'
```

Then verify records exist in Supabase tables:
- `snackvoice_kv_users`
