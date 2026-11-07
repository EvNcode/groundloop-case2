-- Team onboarding for the existing GroundLoop pilot database.
create schema if not exists groundloop_private;
grant usage on schema groundloop_private to authenticated;

create or replace function groundloop_private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1 from public.groundloop_members
      where user_id = (select auth.uid()) and role = 'admin'
    );
$$;
revoke all on function groundloop_private.is_admin() from public, anon;
grant execute on function groundloop_private.is_admin() to authenticated;

alter table public.groundloop_members add column if not exists email text;
update public.groundloop_members m
set email = u.email
from auth.users u
where m.user_id = u.id and m.email is null;
grant select, insert, update on public.groundloop_members to authenticated;

create policy "admins read team" on public.groundloop_members
  for select to authenticated
  using ((select groundloop_private.is_admin()));
create policy "admins add team members" on public.groundloop_members
  for insert to authenticated
  with check ((select groundloop_private.is_admin()));
create policy "admins change team roles" on public.groundloop_members
  for update to authenticated
  using ((select groundloop_private.is_admin()))
  with check ((select groundloop_private.is_admin()));

create table public.groundloop_access_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);
alter table public.groundloop_access_requests enable row level security;
revoke all on public.groundloop_access_requests from anon, authenticated;
grant select, insert, delete on public.groundloop_access_requests to authenticated;

create policy "employees request own access" on public.groundloop_access_requests
  for insert to authenticated
  with check (user_id = (select auth.uid()) and email = (select auth.jwt()->>'email'));
create policy "employees read own request" on public.groundloop_access_requests
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "admins read access requests" on public.groundloop_access_requests
  for select to authenticated
  using ((select groundloop_private.is_admin()));
create policy "admins clear access requests" on public.groundloop_access_requests
  for delete to authenticated
  using ((select groundloop_private.is_admin()));
