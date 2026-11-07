-- GroundLoop team workspace. Apply in the Supabase SQL editor after creating a project.
create table if not exists public.groundloop_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'operator' check (role in ('admin', 'operator', 'viewer')),
  created_at timestamptz not null default now()
);

create table if not exists public.groundloop_workspace (
  id text primary key check (id = 'pilot'),
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create index if not exists groundloop_members_role_idx on public.groundloop_members(role);
alter table public.groundloop_members enable row level security;
alter table public.groundloop_workspace enable row level security;

revoke all on public.groundloop_members from anon, authenticated;
revoke all on public.groundloop_workspace from anon, authenticated;
grant select on public.groundloop_members to authenticated;
grant select, insert, update on public.groundloop_workspace to authenticated;

create policy "read own membership" on public.groundloop_members
  for select to authenticated using (user_id = (select auth.uid()));

create policy "members read pilot" on public.groundloop_workspace
  for select to authenticated
  using (exists (select 1 from public.groundloop_members m where m.user_id = (select auth.uid())));

create policy "operators create pilot" on public.groundloop_workspace
  for insert to authenticated
  with check (updated_by = (select auth.uid()) and exists (
    select 1 from public.groundloop_members m
    where m.user_id = (select auth.uid()) and m.role in ('admin', 'operator')
  ));

create policy "operators update pilot" on public.groundloop_workspace
  for update to authenticated
  using (exists (
    select 1 from public.groundloop_members m
    where m.user_id = (select auth.uid()) and m.role in ('admin', 'operator')
  ))
  with check (updated_by = (select auth.uid()) and exists (
    select 1 from public.groundloop_members m
    where m.user_id = (select auth.uid()) and m.role in ('admin', 'operator')
  ));

-- After the first employee signs up, add their auth.users UUID as admin:
-- insert into public.groundloop_members(user_id, role) values ('<auth-user-uuid>', 'admin');
