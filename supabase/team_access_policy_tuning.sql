-- Keep one SELECT policy per team table and cache JWT helpers per statement.
drop policy "read own membership" on public.groundloop_members;
drop policy "admins read team" on public.groundloop_members;
create policy "team reads permitted members" on public.groundloop_members
  for select to authenticated
  using (user_id = (select auth.uid()) or (select groundloop_private.is_admin()));

drop policy "employees read own request" on public.groundloop_access_requests;
drop policy "admins read access requests" on public.groundloop_access_requests;
create policy "team reads permitted requests" on public.groundloop_access_requests
  for select to authenticated
  using (user_id = (select auth.uid()) or (select groundloop_private.is_admin()));

drop policy "employees request own access" on public.groundloop_access_requests;
create policy "employees request own access" on public.groundloop_access_requests
  for insert to authenticated
  with check (user_id = (select auth.uid()) and email = (select auth.jwt())->>'email');

drop index if exists public.groundloop_workspace_updated_by_idx;
