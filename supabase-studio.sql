-- Additive migration. Does not modify existing workflows, generations or settings.
create table if not exists public.studio_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision integer not null default 0,
  document jsonb not null default '{"version":1,"avatars":[],"projects":[]}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.studio_takes (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  record jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);
-- These tables are accessed only through authenticated, user-scoped server routes.
alter table public.studio_workspaces enable row level security;
alter table public.studio_takes enable row level security;
revoke all on public.studio_workspaces from anon, authenticated;
revoke all on public.studio_takes from anon, authenticated;
grant all on public.studio_workspaces to service_role;
grant all on public.studio_takes to service_role;
