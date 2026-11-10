-- Anonymous visitors get isolated, durable demo workspaces. The employee pilot stays private.
create policy "permanent accounts only" on public.groundloop_members
  as restrictive for all to authenticated
  using (coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false)
  with check (coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false);
create policy "permanent accounts only" on public.groundloop_access_requests
  as restrictive for all to authenticated
  using (coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false)
  with check (coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false);
create policy "permanent accounts only" on public.groundloop_workspace
  as restrictive for all to authenticated
  using (coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false)
  with check (coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false);
create policy "permanent accounts only" on public.groundloop_workspace_history
  as restrictive for all to authenticated
  using (coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false)
  with check (coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false);

create table public.groundloop_demo_workspace (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.groundloop_demo_workspace enable row level security;
revoke all on public.groundloop_demo_workspace from anon, authenticated;
grant select, insert, update on public.groundloop_demo_workspace to authenticated;

create policy "anonymous visitor reads own demo" on public.groundloop_demo_workspace
  for select to authenticated
  using (owner_id = (select auth.uid()) and (select auth.jwt()->>'is_anonymous') = 'true');
create policy "anonymous visitor creates own demo" on public.groundloop_demo_workspace
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select auth.jwt()->>'is_anonymous') = 'true');
create policy "anonymous visitor updates own demo" on public.groundloop_demo_workspace
  for update to authenticated
  using (owner_id = (select auth.uid()) and (select auth.jwt()->>'is_anonymous') = 'true')
  with check (owner_id = (select auth.uid()) and (select auth.jwt()->>'is_anonymous') = 'true');

create function groundloop_private.validate_demo_workspace()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  section text;
  entry jsonb;
  invalid_ids boolean;
begin
  if tg_op = 'UPDATE' and new.revision <> old.revision + 1 then
    raise exception 'Demo revision must increment by one';
  end if;
  if octet_length(new.state::text) > 2097152 then
    raise exception 'Demo workspace exceeds 2 MB';
  end if;
  if coalesce(new.state->>'scenario', '') not in ('conservative', 'base', 'optimistic') then
    raise exception 'Unknown demo scenario';
  end if;
  if jsonb_typeof(new.state->'economicsParams') <> 'object' then
    raise exception 'Economics parameters must be an object';
  end if;
  foreach section in array array['stores', 'collections', 'routes', 'batches', 'productionRuns', 'sales'] loop
    if jsonb_typeof(new.state->section) <> 'array' then
      raise exception 'Demo section % must be an array', section;
    end if;
    if jsonb_array_length(new.state->section) > 5000 then
      raise exception 'Demo section % exceeds 5000 records', section;
    end if;
    select count(*) <> count(distinct value->>'id') or count(*) <> count(value->>'id')
      into invalid_ids from jsonb_array_elements(new.state->section);
    if invalid_ids then
      raise exception 'Demo section % has missing or duplicate IDs', section;
    end if;
  end loop;

  for entry in select value from jsonb_array_elements(new.state->'sales') loop
    if jsonb_typeof(entry->'packs') <> 'number'
       or jsonb_typeof(entry->'unitPrice') <> 'number'
       or (entry->>'packs')::numeric <= 0
       or mod((entry->>'packs')::numeric, 1) <> 0
       or (entry->>'unitPrice')::numeric < 0 then
      raise exception 'Sale amount or price is invalid';
    end if;
    if not exists (
      select 1 from jsonb_array_elements(new.state->'batches') batch
      where batch->>'id' = entry->>'batchId' and (batch->>'producedPacks')::numeric > 0
    ) then
      raise exception 'Sale requires a produced batch';
    end if;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(new.state->'batches') batch
    where coalesce((
      select sum((sale->>'packs')::numeric)
      from jsonb_array_elements(new.state->'sales') sale
      where sale->>'batchId' = batch->>'id'
    ), 0) > (batch->>'producedPacks')::numeric
  ) then
    raise exception 'Sales exceed produced stock';
  end if;

  new.updated_at := now();
  return new;
end;
$$;
revoke all on function groundloop_private.validate_demo_workspace() from public, anon, authenticated;
create trigger groundloop_demo_integrity
  before insert or update on public.groundloop_demo_workspace
  for each row execute function groundloop_private.validate_demo_workspace();
create trigger groundloop_demo_business_rules
  before insert or update on public.groundloop_demo_workspace
  for each row execute function groundloop_private.validate_workspace_business_rules();
