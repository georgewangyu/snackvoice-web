create table if not exists public.snackvoice_kv_magic_links (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_snackvoice_kv_magic_links_updated_at
  on public.snackvoice_kv_magic_links (updated_at desc);

alter table public.snackvoice_kv_magic_links enable row level security;

revoke all on table public.snackvoice_kv_magic_links from anon, authenticated;
