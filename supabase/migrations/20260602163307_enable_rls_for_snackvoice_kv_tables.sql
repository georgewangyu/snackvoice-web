create table if not exists public.snackvoice_kv_desktop_auth_requests (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_snackvoice_kv_desktop_auth_requests_updated_at
  on public.snackvoice_kv_desktop_auth_requests (updated_at desc);

alter table public.snackvoice_kv_users enable row level security;
alter table public.snackvoice_kv_subscriptions enable row level security;
alter table public.snackvoice_kv_checkout_sessions enable row level security;
alter table public.snackvoice_kv_webhook_events enable row level security;
alter table public.snackvoice_kv_sessions enable row level security;
alter table public.snackvoice_kv_desktop_auth_requests enable row level security;
alter table public.snackvoice_kv_orders enable row level security;

revoke all on table public.snackvoice_kv_users from anon, authenticated;
revoke all on table public.snackvoice_kv_subscriptions from anon, authenticated;
revoke all on table public.snackvoice_kv_checkout_sessions from anon, authenticated;
revoke all on table public.snackvoice_kv_webhook_events from anon, authenticated;
revoke all on table public.snackvoice_kv_sessions from anon, authenticated;
revoke all on table public.snackvoice_kv_desktop_auth_requests from anon, authenticated;
revoke all on table public.snackvoice_kv_orders from anon, authenticated;
