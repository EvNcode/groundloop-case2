-- One openly editable pilot board. Anonymous sessions share operations.
-- This is intentionally an open coordination mode, not employee authorization.
create table public.groundloop_open_workspace (
  id text primary key default 'pilot' check (id = 'pilot'),
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.groundloop_open_workspace enable row level security;
revoke all on public.groundloop_open_workspace from anon, authenticated;
grant select, insert, update on public.groundloop_open_workspace to authenticated;

create policy "open pilot read" on public.groundloop_open_workspace
  for select to authenticated
  using ((select auth.jwt()->>'is_anonymous') = 'true');
create policy "open pilot create" on public.groundloop_open_workspace
  for insert to authenticated
  with check ((select auth.jwt()->>'is_anonymous') = 'true' and id = 'pilot');
create policy "open pilot update" on public.groundloop_open_workspace
  for update to authenticated
  using ((select auth.jwt()->>'is_anonymous') = 'true' and id = 'pilot')
  with check ((select auth.jwt()->>'is_anonymous') = 'true' and id = 'pilot');

create function groundloop_private.validate_open_routes()
returns trigger language plpgsql set search_path = '' as $$
declare
  route jsonb;
  route_count integer;
  listed_count integer;
  listed_kg numeric;
begin
  for route in select value from jsonb_array_elements(new.state->'routes') loop
    if jsonb_typeof(route->'collectionIds') <> 'array'
       or jsonb_array_length(route->'collectionIds') = 0 then
      raise exception 'Route needs at least one container';
    end if;
    select count(*), coalesce(sum((c->>'wetKg')::numeric), 0)
      into listed_count, listed_kg
      from jsonb_array_elements(new.state->'collections') c
      where c->>'id' in (select value from jsonb_array_elements_text(route->'collectionIds'));
    route_count := jsonb_array_length(route->'collectionIds');
    if listed_count <> route_count or listed_kg <= 0 then
      raise exception 'Route has missing or zero-weight containers';
    end if;
    if exists (
      select 1 from jsonb_array_elements(new.state->'collections') c
      where c->>'id' in (select value from jsonb_array_elements_text(route->'collectionIds'))
        and (c->>'quality' <> 'good'
          or c->>'status' not in ('scheduled', 'collected')
          or (route->>'status' = 'completed' and c->>'status' <> 'collected'))
    ) then
      raise exception 'Route containers have invalid pickup status';
    end if;
  end loop;
  if exists (
    select 1 from (
      select value as collection_id
      from jsonb_array_elements(new.state->'routes') r,
           jsonb_array_elements_text(r->'collectionIds')
    ) assigned group by collection_id having count(*) > 1
  ) then
    raise exception 'Container is assigned to multiple routes';
  end if;
  return new;
end;
$$;
revoke all on function groundloop_private.validate_open_routes() from public, anon, authenticated;
create trigger groundloop_open_integrity
  before insert or update on public.groundloop_open_workspace
  for each row execute function groundloop_private.validate_demo_workspace();
create trigger groundloop_open_business_rules
  before insert or update on public.groundloop_open_workspace
  for each row execute function groundloop_private.validate_workspace_business_rules();
create trigger groundloop_open_routes
  before insert or update on public.groundloop_open_workspace
  for each row execute function groundloop_private.validate_open_routes();

alter publication supabase_realtime add table public.groundloop_open_workspace;
