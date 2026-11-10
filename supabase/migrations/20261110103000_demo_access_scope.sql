-- Operational managers can record sales; only a designated administrator can
-- change staff access and the store directory.
alter table public.gl_staff add column can_manage_access boolean not null default false;
update public.gl_staff set can_manage_access = true
where email = 'hairullanurlybakyt@gmail.com' and role = 'manager';

create function groundloop_private.gl_can_manage_access()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.gl_staff
    where email = lower(auth.jwt()->>'email')
      and active and role = 'manager' and can_manage_access
  )
$$;
revoke all on function groundloop_private.gl_can_manage_access() from public, anon;
grant execute on function groundloop_private.gl_can_manage_access() to authenticated;

drop policy gl_staff_read on public.gl_staff;
create policy gl_staff_read on public.gl_staff for select to authenticated using (
  email = lower(auth.jwt()->>'email') or groundloop_private.gl_can_manage_access()
);
drop policy gl_staff_write on public.gl_staff;
create policy gl_staff_write on public.gl_staff for all to authenticated
using (groundloop_private.gl_can_manage_access())
with check (groundloop_private.gl_can_manage_access());
drop policy gl_stores_write on public.gl_stores;
create policy gl_stores_write on public.gl_stores for all to authenticated
using (groundloop_private.gl_can_manage_access())
with check (groundloop_private.gl_can_manage_access());
