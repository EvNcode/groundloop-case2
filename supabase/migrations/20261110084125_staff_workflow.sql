-- Verified employee workflow. The older open board remains available only for
-- historical pilot data; these tables are the operational source of truth.
create table public.gl_stores (
  id text primary key,
  name text not null,
  district text,
  active boolean not null default true
);

insert into public.gl_stores (id, name, district, active)
select store->>'id', store->>'name', store->>'district', coalesce((store->>'active')::boolean, false)
from public.groundloop_open_workspace w
cross join lateral jsonb_array_elements(w.state->'stores') store
where w.id = 'pilot'
on conflict (id) do nothing;

create table public.gl_staff (
  email text primary key check (email = lower(email)),
  full_name text not null check (length(trim(full_name)) between 2 and 100),
  role text not null check (role in ('barista','logistics','production','manager')),
  store_id text references public.gl_stores(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (role <> 'barista' or store_id is not null)
);

insert into public.gl_staff (email, full_name, role)
select lower(m.email), coalesce(nullif(split_part(m.email, '@', 1), ''), 'Руководитель'), 'manager'
from public.groundloop_members m
where m.role = 'admin' and m.email is not null
on conflict (email) do nothing;

create function groundloop_private.gl_role()
returns text language sql stable security definer set search_path = '' as $$
  select role from public.gl_staff
  where email = lower(auth.jwt()->>'email') and active
  limit 1
$$;
create function groundloop_private.gl_store()
returns text language sql stable security definer set search_path = '' as $$
  select store_id from public.gl_staff
  where email = lower(auth.jwt()->>'email') and active
  limit 1
$$;
create function groundloop_private.gl_name()
returns text language sql stable security definer set search_path = '' as $$
  select full_name from public.gl_staff
  where email = lower(auth.jwt()->>'email') and active
  limit 1
$$;
revoke all on function groundloop_private.gl_role() from public, anon;
revoke all on function groundloop_private.gl_store() from public, anon;
revoke all on function groundloop_private.gl_name() from public, anon;
grant execute on function groundloop_private.gl_role() to authenticated;
grant execute on function groundloop_private.gl_store() to authenticated;
grant execute on function groundloop_private.gl_name() to authenticated;

create table public.gl_trips (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('RT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  driver_id uuid not null,
  driver_email text not null,
  driver_name text not null,
  status text not null default 'active' check (status in ('active','completed','cancelled')),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table public.gl_containers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('GC-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  store_id text not null references public.gl_stores(id),
  created_by uuid not null,
  created_by_email text not null,
  barista_name text not null,
  cups integer not null default 0 check (cups >= 0),
  wet_kg numeric(10,2) not null check (wet_kg > 0),
  quality text not null check (quality in ('good','hold','rejected')),
  note text not null default '',
  status text not null check (status in ('ready','hold','rejected','cancelled','assigned','picked_up','received','batched')),
  trip_id uuid references public.gl_trips(id),
  pickup_code text,
  picked_up_by uuid,
  picked_up_at timestamptz,
  receipt_code text,
  received_by uuid,
  received_at timestamptz,
  batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index gl_containers_store_created on public.gl_containers (store_id, created_at desc);
create index gl_containers_status_created on public.gl_containers (status, created_at desc);
create index gl_containers_trip on public.gl_containers (trip_id) where trip_id is not null;

create table public.gl_batches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('B-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  container_ids uuid[] not null,
  wet_kg numeric(10,2) not null default 0,
  dried_kg numeric(10,2),
  accepted_kg numeric(10,2),
  produced_packs integer not null default 0,
  status text not null default 'received' check (status in ('received','drying','production','complete')),
  created_by uuid not null,
  operator_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.gl_containers add constraint gl_containers_batch_fk foreign key (batch_id) references public.gl_batches(id);

create table public.gl_sales (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.gl_batches(id),
  packs integer not null check (packs > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  channel text not null default 'Кофейня',
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index gl_sales_batch on public.gl_sales (batch_id);

create table public.gl_driver_positions (
  trip_id uuid primary key references public.gl_trips(id) on delete cascade,
  driver_id uuid not null,
  latitude numeric(10,7) not null check (latitude between -90 and 90),
  longitude numeric(10,7) not null check (longitude between -180 and 180),
  accuracy_m numeric(9,1) not null check (accuracy_m >= 0),
  updated_at timestamptz not null default now()
);

create table public.gl_events (
  id bigint generated always as identity primary key,
  entity text not null,
  entity_id uuid not null,
  action text not null,
  actor_id uuid,
  actor_email text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index gl_events_entity on public.gl_events (entity, entity_id, created_at desc);

create function groundloop_private.gl_prepare_container()
returns trigger language plpgsql set search_path = '' as $$
declare actor_role text := groundloop_private.gl_role(); expected_status text;
begin
  expected_status := case new.quality when 'good' then 'ready' when 'hold' then 'hold' else 'rejected' end;
  if tg_op = 'INSERT' then
    if actor_role <> 'barista' then raise exception 'Only a barista can create a container'; end if;
    new.store_id := groundloop_private.gl_store();
    new.created_by := auth.uid();
    new.created_by_email := lower(auth.jwt()->>'email');
    new.barista_name := groundloop_private.gl_name();
    new.status := expected_status;
    if new.store_id is null then raise exception 'Barista has no assigned store'; end if;
    return new;
  end if;
  if row(new.id,new.code,new.store_id,new.created_by,new.created_by_email,new.barista_name,new.created_at)
     is distinct from row(old.id,old.code,old.store_id,old.created_by,old.created_by_email,old.barista_name,old.created_at) then
    raise exception 'Container identity cannot be changed';
  end if;
  if actor_role = 'barista' then
    if old.created_by <> auth.uid() then raise exception 'Only the creator can correct this container'; end if;
    if old.status in ('ready','hold','rejected') and new.status in ('ready','hold','rejected','cancelled') then
      if new.status <> 'cancelled' and new.status <> expected_status then
        raise exception 'Quality and status disagree';
      end if;
    elsif old.status = 'assigned' and new.status = 'cancelled' then
      new.trip_id := null;
    else raise exception 'Container already handed off';
    end if;
    if old.trip_id is distinct from new.trip_id and not (old.status = 'assigned' and new.status = 'cancelled') then
      raise exception 'Barista cannot change the trip';
    end if;
    if new.wet_kg <= 0 then raise exception 'Weight must be positive'; end if;
  elsif actor_role = 'logistics' then
    if row(new.cups,new.wet_kg,new.quality,new.note,new.batch_id)
       is distinct from row(old.cups,old.wet_kg,old.quality,old.note,old.batch_id) then
      raise exception 'Driver cannot change collection details';
    end if;
    if old.status = 'ready' and new.status = 'assigned' then
      if not exists (select 1 from public.gl_trips t where t.id = new.trip_id and t.driver_id = auth.uid() and t.status = 'active') then
        raise exception 'Choose your active trip';
      end if;
    elsif old.status = 'assigned' and new.status = 'ready' then
      if not exists (select 1 from public.gl_trips t where t.id = old.trip_id and t.driver_id = auth.uid()) then raise exception 'Wrong driver'; end if;
      new.trip_id := null;
    elsif old.status = 'assigned' and new.status = 'picked_up' then
      if not exists (select 1 from public.gl_trips t where t.id = old.trip_id and t.driver_id = auth.uid()) then raise exception 'Wrong driver'; end if;
      if new.pickup_code is distinct from old.code then raise exception 'Scan the matching container code'; end if;
      new.picked_up_by := auth.uid(); new.picked_up_at := now();
    elsif old.status = 'picked_up' and new.status = 'assigned' then
      if old.picked_up_by <> auth.uid() or old.received_at is not null then raise exception 'Pickup cannot be undone'; end if;
      new.pickup_code := null; new.picked_up_by := null; new.picked_up_at := null;
    else raise exception 'Invalid logistics transition';
    end if;
  elsif actor_role = 'production' then
    if row(new.cups,new.wet_kg,new.quality,new.note,new.trip_id)
       is distinct from row(old.cups,old.wet_kg,old.quality,old.note,old.trip_id) then
      raise exception 'Production cannot change collection details';
    end if;
    if old.status = 'picked_up' and new.status = 'received' then
      if new.receipt_code is distinct from old.code then raise exception 'Scan the matching container code'; end if;
      new.received_by := auth.uid(); new.received_at := now();
    elsif old.status = 'received' and new.status = 'picked_up' then
      if old.received_by <> auth.uid() or old.batch_id is not null then raise exception 'Receipt cannot be undone'; end if;
      new.receipt_code := null; new.received_by := null; new.received_at := null;
    elsif old.status = 'received' and new.status = 'batched' then
      if new.batch_id is null or not exists (
        select 1 from public.gl_batches b where b.id = new.batch_id and new.id = any(b.container_ids)
      ) then raise exception 'Container is not in this batch'; end if;
    else raise exception 'Invalid production transition';
    end if;
  else raise exception 'No operational role';
  end if;
  new.updated_at := now(); new.version := old.version + 1;
  return new;
end;
$$;
create trigger gl_prepare_container before insert or update on public.gl_containers
for each row execute function groundloop_private.gl_prepare_container();

create function groundloop_private.gl_prepare_trip()
returns trigger language plpgsql set search_path = '' as $$
begin
  if groundloop_private.gl_role() <> 'logistics' then raise exception 'Only logistics can manage trips'; end if;
  if tg_op = 'INSERT' then
    new.driver_id := auth.uid(); new.driver_email := lower(auth.jwt()->>'email');
    new.driver_name := groundloop_private.gl_name(); new.status := 'active';
  else
    if old.driver_id <> auth.uid() or old.status <> 'active' or new.status not in ('completed','cancelled') then raise exception 'Trip cannot be closed'; end if;
    if exists (select 1 from public.gl_containers c where c.trip_id = old.id and c.status in ('assigned','picked_up')) then
      raise exception 'Containers are still in transit';
    end if;
    if new.status = 'cancelled' and exists (select 1 from public.gl_containers c where c.trip_id = old.id) then
      raise exception 'Remove containers before cancelling';
    end if;
    new.finished_at := now();
  end if;
  return new;
end;
$$;
create trigger gl_prepare_trip before insert or update on public.gl_trips
for each row execute function groundloop_private.gl_prepare_trip();

create function groundloop_private.gl_prepare_batch()
returns trigger language plpgsql set search_path = '' as $$
declare source_count integer; source_kg numeric;
begin
  if groundloop_private.gl_role() <> 'production' then raise exception 'Only production can manage batches'; end if;
  if tg_op = 'INSERT' then
    if cardinality(new.container_ids) < 1 or cardinality(new.container_ids) <> (select count(distinct x) from unnest(new.container_ids) x) then
      raise exception 'Choose unique received containers';
    end if;
    select count(*), coalesce(sum(c.wet_kg),0) into source_count, source_kg
    from public.gl_containers c where c.id = any(new.container_ids) and c.status = 'received' and c.batch_id is null;
    if source_count <> cardinality(new.container_ids) then raise exception 'A container was already batched or not received'; end if;
    new.wet_kg := source_kg; new.created_by := auth.uid(); new.operator_name := groundloop_private.gl_name();
    new.status := 'received'; new.dried_kg := null; new.accepted_kg := null; new.produced_packs := 0;
  else
    if old.created_by <> auth.uid() then raise exception 'Only the batch operator can change stages'; end if;
    if new.container_ids is distinct from old.container_ids or new.wet_kg is distinct from old.wet_kg or new.created_by is distinct from old.created_by then
      raise exception 'Batch source cannot be changed';
    end if;
    if old.status = 'received' and new.status = 'drying' then null;
    elsif old.status = 'drying' and new.status = 'production' then
      if new.dried_kg is null or new.accepted_kg is null or new.accepted_kg <= 0 or new.accepted_kg > new.dried_kg or new.dried_kg > old.wet_kg then
        raise exception 'Check dried and accepted weights';
      end if;
    elsif old.status = 'production' and new.status = 'complete' then
      if new.produced_packs <= 0 or new.produced_packs * 0.16 > old.accepted_kg then raise exception 'Pack output exceeds material'; end if;
    else raise exception 'Invalid batch stage';
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;
create trigger gl_prepare_batch before insert or update on public.gl_batches
for each row execute function groundloop_private.gl_prepare_batch();

create function groundloop_private.gl_attach_batch()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.gl_containers set status = 'batched', batch_id = new.id
  where id = any(new.container_ids) and status = 'received' and batch_id is null;
  if not found then raise exception 'Batch has no received containers'; end if;
  return new;
end;
$$;
create trigger gl_attach_batch after insert on public.gl_batches
for each row execute function groundloop_private.gl_attach_batch();

create function groundloop_private.gl_check_sale()
returns trigger language plpgsql set search_path = '' as $$
declare available integer; output integer;
begin
  if groundloop_private.gl_role() <> 'manager' then raise exception 'Only management can record sales'; end if;
  select produced_packs into output from public.gl_batches where id = new.batch_id and status = 'complete' for update;
  if not found then raise exception 'Batch is not ready for sale'; end if;
  select output - coalesce(sum(packs),0) into available from public.gl_sales where batch_id = new.batch_id;
  if new.packs > available then raise exception 'Sale exceeds available stock'; end if;
  new.created_by := auth.uid(); return new;
end;
$$;
create trigger gl_check_sale before insert on public.gl_sales
for each row execute function groundloop_private.gl_check_sale();

create function groundloop_private.gl_check_position()
returns trigger language plpgsql set search_path = '' as $$
begin
  if groundloop_private.gl_role() <> 'logistics' or not exists (
    select 1 from public.gl_trips t where t.id = new.trip_id and t.driver_id = auth.uid() and t.status = 'active'
  ) then raise exception 'Only the active driver can share position'; end if;
  new.driver_id := auth.uid(); new.updated_at := now(); return new;
end;
$$;
create trigger gl_check_position before insert or update on public.gl_driver_positions
for each row execute function groundloop_private.gl_check_position();

create function groundloop_private.gl_log_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare item_id uuid; action_name text;
begin
  item_id := new.id;
  if tg_op = 'INSERT' then action_name := 'created';
  elsif tg_table_name = 'gl_containers' and to_jsonb(new)->>'status' is distinct from to_jsonb(old)->>'status' then action_name := to_jsonb(new)->>'status';
  elsif tg_table_name = 'gl_batches' and to_jsonb(new)->>'status' is distinct from to_jsonb(old)->>'status' then action_name := to_jsonb(new)->>'status';
  else action_name := 'updated'; end if;
  insert into public.gl_events(entity, entity_id, action, actor_id, actor_email, details)
  values (tg_table_name, item_id, action_name, auth.uid(), lower(auth.jwt()->>'email'),
    case when tg_table_name = 'gl_containers' then jsonb_build_object('code', to_jsonb(new)->>'code', 'store', to_jsonb(new)->>'store_id', 'kg', to_jsonb(new)->>'wet_kg')
         when tg_table_name = 'gl_batches' then jsonb_build_object('code', to_jsonb(new)->>'code', 'kg', to_jsonb(new)->>'wet_kg')
         else '{}'::jsonb end);
  return new;
end;
$$;
create trigger gl_log_container after insert or update on public.gl_containers
for each row execute function groundloop_private.gl_log_change();
create trigger gl_log_batch after insert or update on public.gl_batches
for each row execute function groundloop_private.gl_log_change();
create trigger gl_log_trip after insert or update on public.gl_trips
for each row execute function groundloop_private.gl_log_change();
create trigger gl_log_sale after insert on public.gl_sales
for each row execute function groundloop_private.gl_log_change();

alter table public.gl_stores enable row level security;
alter table public.gl_staff enable row level security;
alter table public.gl_trips enable row level security;
alter table public.gl_containers enable row level security;
alter table public.gl_batches enable row level security;
alter table public.gl_sales enable row level security;
alter table public.gl_driver_positions enable row level security;
alter table public.gl_events enable row level security;
revoke all on public.gl_stores,public.gl_staff,public.gl_trips,public.gl_containers,public.gl_batches,public.gl_sales,public.gl_driver_positions,public.gl_events from anon,authenticated;
grant select on public.gl_stores,public.gl_staff,public.gl_trips,public.gl_containers,public.gl_batches,public.gl_sales,public.gl_driver_positions,public.gl_events to authenticated;
grant insert,update on public.gl_stores,public.gl_staff,public.gl_trips,public.gl_containers,public.gl_batches,public.gl_driver_positions to authenticated;
grant insert on public.gl_sales to authenticated;
grant usage,select on sequence public.gl_events_id_seq to authenticated;

create policy gl_stores_read on public.gl_stores for select to authenticated using (groundloop_private.gl_role() is not null);
create policy gl_stores_write on public.gl_stores for all to authenticated using (groundloop_private.gl_role() = 'manager') with check (groundloop_private.gl_role() = 'manager');
create policy gl_staff_read on public.gl_staff for select to authenticated using (email = lower(auth.jwt()->>'email') or groundloop_private.gl_role() = 'manager');
create policy gl_staff_write on public.gl_staff for all to authenticated using (groundloop_private.gl_role() = 'manager') with check (groundloop_private.gl_role() = 'manager');
create policy gl_trips_read on public.gl_trips for select to authenticated using (groundloop_private.gl_role() is not null);
create policy gl_trips_insert on public.gl_trips for insert to authenticated with check (groundloop_private.gl_role() = 'logistics' and driver_id = auth.uid());
create policy gl_trips_update on public.gl_trips for update to authenticated using (groundloop_private.gl_role() = 'logistics' and driver_id = auth.uid()) with check (groundloop_private.gl_role() = 'logistics' and driver_id = auth.uid());
create policy gl_containers_read on public.gl_containers for select to authenticated using (groundloop_private.gl_role() is not null);
create policy gl_containers_insert on public.gl_containers for insert to authenticated with check (groundloop_private.gl_role() = 'barista' and created_by = auth.uid() and store_id = groundloop_private.gl_store());
create policy gl_containers_update on public.gl_containers for update to authenticated using (
  (groundloop_private.gl_role() = 'barista' and created_by = auth.uid()) or groundloop_private.gl_role() in ('logistics','production')
) with check (groundloop_private.gl_role() in ('barista','logistics','production'));
create policy gl_batches_read on public.gl_batches for select to authenticated using (groundloop_private.gl_role() is not null);
create policy gl_batches_insert on public.gl_batches for insert to authenticated with check (groundloop_private.gl_role() = 'production' and created_by = auth.uid());
create policy gl_batches_update on public.gl_batches for update to authenticated using (groundloop_private.gl_role() = 'production' and created_by = auth.uid()) with check (groundloop_private.gl_role() = 'production' and created_by = auth.uid());
create policy gl_sales_read on public.gl_sales for select to authenticated using (groundloop_private.gl_role() is not null);
create policy gl_sales_insert on public.gl_sales for insert to authenticated with check (groundloop_private.gl_role() = 'manager' and created_by = auth.uid());
create policy gl_positions_read on public.gl_driver_positions for select to authenticated using (groundloop_private.gl_role() is not null);
create policy gl_positions_insert on public.gl_driver_positions for insert to authenticated with check (groundloop_private.gl_role() = 'logistics' and driver_id = auth.uid());
create policy gl_positions_update on public.gl_driver_positions for update to authenticated using (groundloop_private.gl_role() = 'logistics' and driver_id = auth.uid()) with check (groundloop_private.gl_role() = 'logistics' and driver_id = auth.uid());
create policy gl_events_read on public.gl_events for select to authenticated using (groundloop_private.gl_role() is not null);

alter publication supabase_realtime add table public.gl_containers;
alter publication supabase_realtime add table public.gl_trips;
alter publication supabase_realtime add table public.gl_batches;
alter publication supabase_realtime add table public.gl_sales;
alter publication supabase_realtime add table public.gl_driver_positions;
alter publication supabase_realtime add table public.gl_events;
