-- Keep fields outside the current worker's responsibility immutable.
create function groundloop_private.gl_guard_container()
returns trigger language plpgsql set search_path = '' as $$
declare worker_role text := groundloop_private.gl_role();
begin
  if worker_role = 'barista' then
    if row(new.pickup_code,new.picked_up_by,new.picked_up_at,new.receipt_code,new.received_by,new.received_at,new.batch_id)
       is distinct from row(old.pickup_code,old.picked_up_by,old.picked_up_at,old.receipt_code,old.received_by,old.received_at,old.batch_id) then
      raise exception 'Barista cannot change handoff evidence';
    end if;
  elsif worker_role = 'logistics' then
    if row(new.receipt_code,new.received_by,new.received_at,new.batch_id)
       is distinct from row(old.receipt_code,old.received_by,old.received_at,old.batch_id) then
      raise exception 'Driver cannot change production evidence';
    end if;
    if old.status in ('assigned','picked_up') and new.status <> 'ready' and new.trip_id is distinct from old.trip_id then
      raise exception 'Driver cannot move a claimed container to another trip';
    end if;
  elsif worker_role = 'production' then
    if row(new.pickup_code,new.picked_up_by,new.picked_up_at)
       is distinct from row(old.pickup_code,old.picked_up_by,old.picked_up_at) then
      raise exception 'Production cannot change pickup evidence';
    end if;
  end if;
  return new;
end;
$$;
create trigger gl_guard_container before update on public.gl_containers
for each row execute function groundloop_private.gl_guard_container();

create function groundloop_private.gl_guard_trip()
returns trigger language plpgsql set search_path = '' as $$
begin
  if row(new.id,new.code,new.driver_id,new.driver_email,new.driver_name,new.started_at)
     is distinct from row(old.id,old.code,old.driver_id,old.driver_email,old.driver_name,old.started_at) then
    raise exception 'Trip identity cannot be changed';
  end if;
  return new;
end;
$$;
create trigger gl_guard_trip before update on public.gl_trips
for each row execute function groundloop_private.gl_guard_trip();

create function groundloop_private.gl_guard_batch()
returns trigger language plpgsql set search_path = '' as $$
begin
  if row(new.id,new.code,new.container_ids,new.wet_kg,new.created_by,new.operator_name,new.created_at)
     is distinct from row(old.id,old.code,old.container_ids,old.wet_kg,old.created_by,old.operator_name,old.created_at) then
    raise exception 'Batch identity and sources cannot be changed';
  end if;
  if new.status <> 'complete' and new.produced_packs <> 0 then
    raise exception 'Only completed batches can have output';
  end if;
  if old.status = 'production' and row(new.dried_kg,new.accepted_kg) is distinct from row(old.dried_kg,old.accepted_kg) then
    raise exception 'Confirmed weights cannot change during packaging';
  end if;
  return new;
end;
$$;
create trigger gl_guard_batch before update on public.gl_batches
for each row execute function groundloop_private.gl_guard_batch();

create or replace function groundloop_private.gl_log_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare item_id uuid; action_name text; details jsonb;
begin
  item_id := new.id;
  if tg_op = 'INSERT' then action_name := 'created';
  elsif to_jsonb(new)->>'status' is distinct from to_jsonb(old)->>'status' then action_name := to_jsonb(new)->>'status';
  else action_name := 'updated'; end if;
  details := jsonb_build_object('code',to_jsonb(new)->>'code');
  if tg_table_name = 'gl_containers' then
    details := details || jsonb_build_object('store',to_jsonb(new)->>'store_id','kg',to_jsonb(new)->>'wet_kg',
      'before',case when tg_op = 'UPDATE' then jsonb_build_object('status',to_jsonb(old)->>'status','kg',to_jsonb(old)->>'wet_kg','quality',to_jsonb(old)->>'quality','note',to_jsonb(old)->>'note') else null end,
      'after',jsonb_build_object('status',to_jsonb(new)->>'status','kg',to_jsonb(new)->>'wet_kg','quality',to_jsonb(new)->>'quality','note',to_jsonb(new)->>'note'));
  end if;
  insert into public.gl_events(entity,entity_id,action,actor_id,actor_email,details)
  values(tg_table_name,item_id,action_name,auth.uid(),lower(auth.jwt()->>'email'),details);
  return new;
end;
$$;

-- Anonymous sessions and unlisted email addresses cannot use the employee tables.
do $$ declare table_name text; begin
  foreach table_name in array array['gl_stores','gl_staff','gl_trips','gl_containers','gl_batches','gl_sales','gl_driver_positions','gl_events'] loop
    execute format('create policy gl_verified_only on public.%I as restrictive for all to authenticated using (coalesce((auth.jwt()->>''is_anonymous'')::boolean,false)=false) with check (coalesce((auth.jwt()->>''is_anonymous'')::boolean,false)=false)',table_name);
  end loop;
end $$;
