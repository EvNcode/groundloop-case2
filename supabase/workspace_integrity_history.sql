-- Keep a recoverable snapshot and reject structurally invalid pilot updates.
create table public.groundloop_workspace_history (
  workspace_id text not null references public.groundloop_workspace(id) on delete cascade,
  revision bigint not null,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id),
  actor_email text,
  changed_sections text[] not null default '{}',
  state jsonb not null,
  primary key (workspace_id, revision)
);
alter table public.groundloop_workspace_history enable row level security;
revoke all on public.groundloop_workspace_history from anon, authenticated;
grant select on public.groundloop_workspace_history to authenticated;
create policy "members read pilot history" on public.groundloop_workspace_history
  for select to authenticated
  using (exists (
    select 1 from public.groundloop_members m
    where m.user_id = (select auth.uid())
  ));

create function groundloop_private.record_workspace_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  section text;
  entry jsonb;
  invalid_ids boolean;
  sections text[] := '{}';
begin
  if new.id <> 'pilot' or new.revision < 1 then
    raise exception 'Invalid GroundLoop workspace identity or revision';
  end if;
  if tg_op = 'UPDATE' and new.revision <> old.revision + 1 then
    raise exception 'GroundLoop revision must increment by one';
  end if;
  if octet_length(new.state::text) > 2097152 then
    raise exception 'GroundLoop workspace exceeds 2 MB';
  end if;
  if coalesce(new.state->>'scenario', '') not in ('conservative', 'base', 'optimistic') then
    raise exception 'Unknown GroundLoop scenario';
  end if;
  if jsonb_typeof(new.state->'economicsParams') <> 'object' then
    raise exception 'Economics parameters must be an object';
  end if;

  foreach section in array array['stores', 'collections', 'routes', 'batches', 'productionRuns'] loop
    if jsonb_typeof(new.state->section) <> 'array' then
      raise exception 'GroundLoop section % must be an array', section;
    end if;
    if jsonb_array_length(new.state->section) > 5000 then
      raise exception 'GroundLoop section % exceeds 5000 records', section;
    end if;
    select count(*) <> count(distinct value->>'id') or count(*) <> count(value->>'id')
      into invalid_ids from jsonb_array_elements(new.state->section);
    if invalid_ids then
      raise exception 'GroundLoop section % has missing or duplicate IDs', section;
    end if;
    if tg_op = 'UPDATE' and (select auth.uid()) is not null and not groundloop_private.is_admin() then
      if exists (
        select 1 from jsonb_array_elements(old.state->section) previous
        where not exists (
          select 1 from jsonb_array_elements(new.state->section) current_item
          where current_item->>'id' = previous->>'id'
        )
      ) then
        raise exception 'Only an administrator can remove % records', section;
      end if;
    end if;
  end loop;

  for entry in select value from jsonb_array_elements(new.state->'collections') loop
    if jsonb_typeof(entry->'cups') <> 'number' or jsonb_typeof(entry->'wetKg') <> 'number' then
      raise exception 'Collection cups and wetKg must be numbers';
    end if;
    if (entry->>'cups')::numeric < 0 or mod((entry->>'cups')::numeric, 1) <> 0
       or (entry->>'wetKg')::numeric <= 0 then
      raise exception 'Collection amounts must be positive and cups whole';
    end if;
    if coalesce(entry->>'quality', '') not in ('good', 'pending', 'rejected')
       or coalesce(entry->>'status', '') not in ('ready', 'review', 'scheduled', 'collected', 'rejected') then
      raise exception 'Unknown collection quality or status';
    end if;
    if entry->>'status' in ('scheduled', 'collected') and entry->>'quality' <> 'good' then
      raise exception 'Unapproved material cannot enter logistics';
    end if;
  end loop;

  for entry in select value from jsonb_array_elements(new.state->'routes') loop
    if jsonb_typeof(entry->'collectionIds') <> 'array' then
      raise exception 'Route requires collectionIds';
    end if;
    if exists (
      select 1 from jsonb_array_elements_text(entry->'collectionIds') collection_id
      where not exists (
        select 1 from jsonb_array_elements(new.state->'collections') collection
        where collection->>'id' = collection_id
      )
    ) then
      raise exception 'Route references an unknown collection';
    end if;
  end loop;

  for entry in select value from jsonb_array_elements(new.state->'batches') loop
    if jsonb_typeof(entry->'collectionIds') <> 'array'
       or jsonb_typeof(entry->'wetKg') <> 'number'
       or jsonb_typeof(entry->'driedKg') <> 'number'
       or jsonb_typeof(entry->'acceptedKg') <> 'number' then
      raise exception 'Batch structure is invalid';
    end if;
    if (entry->>'wetKg')::numeric < 0 or (entry->>'driedKg')::numeric < 0
       or (entry->>'acceptedKg')::numeric < 0
       or (entry->>'driedKg')::numeric > (entry->>'wetKg')::numeric
       or (entry->>'acceptedKg')::numeric > (entry->>'driedKg')::numeric then
      raise exception 'Batch material balance is invalid';
    end if;
    if exists (
      select 1 from jsonb_array_elements_text(entry->'collectionIds') collection_id
      where not exists (
        select 1 from jsonb_array_elements(new.state->'collections') collection
        where collection->>'id' = collection_id
      )
    ) then
      raise exception 'Batch references an unknown collection';
    end if;
  end loop;

  for entry in select value from jsonb_array_elements(new.state->'productionRuns') loop
    if not exists (
      select 1 from jsonb_array_elements(new.state->'batches') batch
      where batch->>'id' = entry->>'batchId'
    ) then
      raise exception 'Production run references an unknown batch';
    end if;
  end loop;

  if tg_op = 'INSERT' then
    sections := array['created'];
  else
    select coalesce(array_agg(key_name), '{}') into sections
    from unnest(array['stores', 'collections', 'routes', 'batches', 'productionRuns', 'economicsParams', 'scenario', 'dataMode']) key_name
    where old.state->key_name is distinct from new.state->key_name;
  end if;

  insert into public.groundloop_workspace_history
    (workspace_id, revision, changed_at, changed_by, actor_email, changed_sections, state)
  select new.id, new.revision, now(), new.updated_by, u.email, sections, new.state
  from (select 1) marker
  left join auth.users u on u.id = new.updated_by;
  return new;
end;
$$;
revoke all on function groundloop_private.record_workspace_change() from public, anon, authenticated;
create trigger groundloop_workspace_integrity_history
  after insert or update on public.groundloop_workspace
  for each row execute function groundloop_private.record_workspace_change();

insert into public.groundloop_workspace_history
  (workspace_id, revision, changed_at, changed_by, actor_email, changed_sections, state)
select w.id, w.revision, w.updated_at, w.updated_by, u.email, array['baseline'], w.state
from public.groundloop_workspace w
left join auth.users u on u.id = w.updated_by
on conflict do nothing;
