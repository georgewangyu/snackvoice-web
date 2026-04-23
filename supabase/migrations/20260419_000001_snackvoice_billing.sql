create table if not exists public.snackvoice_kv_users (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.snackvoice_kv_subscriptions (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.snackvoice_kv_checkout_sessions (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.snackvoice_kv_webhook_events (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.snackvoice_kv_sessions (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.snackvoice_kv_orders (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_snackvoice_kv_users_updated_at
  on public.snackvoice_kv_users (updated_at desc);
create index if not exists idx_snackvoice_kv_subscriptions_updated_at
  on public.snackvoice_kv_subscriptions (updated_at desc);
create index if not exists idx_snackvoice_kv_checkout_sessions_updated_at
  on public.snackvoice_kv_checkout_sessions (updated_at desc);
create index if not exists idx_snackvoice_kv_webhook_events_updated_at
  on public.snackvoice_kv_webhook_events (updated_at desc);
create index if not exists idx_snackvoice_kv_sessions_updated_at
  on public.snackvoice_kv_sessions (updated_at desc);
create index if not exists idx_snackvoice_kv_orders_updated_at
  on public.snackvoice_kv_orders (updated_at desc);
