-- Precise coordinates are entered by management; a district is not a pickup pin.
alter table public.gl_stores add column latitude numeric(10,7);
alter table public.gl_stores add column longitude numeric(10,7);
alter table public.gl_stores add constraint gl_store_coordinates check (
  (latitude is null and longitude is null) or
  (latitude between -90 and 90 and longitude between -180 and 180)
);

-- A cancelled assigned collection disappears from the driver's queue. Preserve
-- a small, driver-specific notice without exposing the barista's private note.
create table public.gl_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null,
  container_id uuid not null references public.gl_containers(id),
  container_code text not null,
  store_id text not null references public.gl_stores(id),
  created_at timestamptz not null default now()
);
create index gl_notifications_recipient_created on public.gl_notifications(recipient_id,created_at desc);
alter table public.gl_notifications enable row level security;
revoke all on public.gl_notifications from anon,authenticated;
grant select on public.gl_notifications to authenticated;
create policy gl_notifications_read on public.gl_notifications for select to authenticated
using (recipient_id = auth.uid() and groundloop_private.gl_role() = 'logistics');
alter publication supabase_realtime add table public.gl_notifications;

create function groundloop_private.gl_notify_cancel()
returns trigger language plpgsql security definer set search_path = '' as $$
declare driver uuid;
begin
  if old.status = 'assigned' and new.status = 'cancelled' and old.trip_id is not null then
    select driver_id into driver from public.gl_trips where id = old.trip_id;
    if driver is not null then
      insert into public.gl_notifications(recipient_id,container_id,container_code,store_id)
      values(driver,new.id,new.code,new.store_id);
    end if;
  end if;
  return new;
end;
$$;
create trigger gl_notify_cancel after update of status on public.gl_containers
for each row execute function groundloop_private.gl_notify_cancel();

-- Production may receive a container while a driver finishes other stops, but
-- cannot turn that material into a batch until its trip is closed.
drop policy gl_trips_read on public.gl_trips;
create policy gl_trips_read on public.gl_trips for select to authenticated using (
  groundloop_private.gl_role() in ('manager','production') or
  (groundloop_private.gl_role() = 'logistics' and driver_id = auth.uid())
);
create function groundloop_private.gl_batch_closed_trip()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.gl_containers c
    left join public.gl_trips t on t.id = c.trip_id
    where c.id = any(new.container_ids) and (t.id is null or t.status <> 'completed')
  ) then raise exception 'Close the collection trip before creating a batch'; end if;
  return new;
end;
$$;
create trigger gl_batch_closed_trip before insert on public.gl_batches
for each row execute function groundloop_private.gl_batch_closed_trip();

-- The existing sales table becomes a fulfillment queue. A sale reserves stock
-- immediately, while revenue is counted only after product handover.
alter table public.gl_sales
  add column order_code text unique not null default ('SO-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))),
  add column customer_name text not null default '',
  add column fulfillment text not null default 'pickup' check (fulfillment in ('pickup','delivery')),
  add column delivery_address text,
  add column latitude numeric(10,7),
  add column longitude numeric(10,7),
  add column delivery_status text not null default 'delivered' check (delivery_status in ('ready','assigned','out_for_delivery','delivered','cancelled')),
  add column delivery_driver_id uuid,
  add column delivery_driver_name text,
  add column pickup_code text,
  add column recipient_name text,
  add column delivered_at timestamptz,
  add column updated_at timestamptz not null default now();
alter table public.gl_sales alter column delivery_status set default 'ready';
alter table public.gl_sales add constraint gl_sale_coordinates check (
  (latitude is null and longitude is null) or
  (latitude between -90 and 90 and longitude between -180 and 180)
);
create index gl_sales_delivery_queue on public.gl_sales(delivery_status,created_at desc)
where fulfillment = 'delivery';

drop policy gl_sales_read on public.gl_sales;
create policy gl_sales_read on public.gl_sales for select to authenticated using (
  groundloop_private.gl_role() in ('manager','production') or
  (groundloop_private.gl_role() = 'logistics' and fulfillment = 'delivery' and
    (delivery_status = 'ready' or delivery_driver_id = auth.uid()))
);
grant update on public.gl_sales to authenticated;
create policy gl_sales_update on public.gl_sales for update to authenticated
using (groundloop_private.gl_role() = 'manager' or
  (groundloop_private.gl_role() = 'logistics' and fulfillment = 'delivery' and
   (delivery_status = 'ready' or delivery_driver_id = auth.uid())))
with check (groundloop_private.gl_role() = 'manager' or
  (groundloop_private.gl_role() = 'logistics' and fulfillment = 'delivery' and
   (delivery_status = 'ready' or delivery_driver_id = auth.uid())));

create or replace function groundloop_private.gl_check_sale()
returns trigger language plpgsql set search_path = '' as $$
declare available integer; output integer;
begin
  if groundloop_private.gl_role() <> 'manager' then raise exception 'Only management can create product orders'; end if;
  if length(btrim(new.customer_name)) < 2 then raise exception 'Customer name is required'; end if;
  if new.fulfillment = 'delivery' and length(btrim(coalesce(new.delivery_address,''))) < 5 then
    raise exception 'Delivery address is required';
  end if;
  select produced_packs into output from public.gl_batches where id = new.batch_id and status = 'complete' for update;
  if not found then raise exception 'Batch is not ready for sale'; end if;
  select output - coalesce(sum(packs),0) into available from public.gl_sales
  where batch_id = new.batch_id and delivery_status <> 'cancelled';
  if new.packs > available then raise exception 'Order exceeds available stock'; end if;
  new.created_by := auth.uid();
  new.delivery_status := 'ready';
  new.delivery_driver_id := null; new.delivery_driver_name := null;
  new.pickup_code := null; new.recipient_name := null; new.delivered_at := null;
  if new.fulfillment = 'pickup' then
    new.delivery_address := null; new.latitude := null; new.longitude := null;
  end if;
  return new;
end;
$$;

create function groundloop_private.gl_update_sale()
returns trigger language plpgsql set search_path = '' as $$
declare actor_role text := groundloop_private.gl_role();
begin
  if row(new.id,new.order_code,new.batch_id,new.packs,new.unit_price,new.channel,new.customer_name,
         new.fulfillment,new.delivery_address,new.latitude,new.longitude,new.created_by,new.created_at)
     is distinct from
     row(old.id,old.order_code,old.batch_id,old.packs,old.unit_price,old.channel,old.customer_name,
         old.fulfillment,old.delivery_address,old.latitude,old.longitude,old.created_by,old.created_at)
  then raise exception 'Order details cannot be changed after creation'; end if;
  if old.delivery_status = 'ready' and new.delivery_status = 'cancelled' and actor_role = 'manager' then
    null;
  elsif old.fulfillment = 'pickup' and old.delivery_status = 'ready' and
        new.delivery_status = 'delivered' and actor_role = 'manager' then
    if length(btrim(coalesce(new.recipient_name,''))) < 2 then raise exception 'Enter recipient name'; end if;
    new.delivered_at := now();
  elsif old.fulfillment = 'delivery' and old.delivery_status = 'ready' and
        new.delivery_status = 'assigned' and actor_role = 'logistics' then
    new.delivery_driver_id := auth.uid(); new.delivery_driver_name := groundloop_private.gl_name();
  elsif old.fulfillment = 'delivery' and old.delivery_driver_id = auth.uid() and actor_role = 'logistics' and
        old.delivery_status = 'assigned' and new.delivery_status = 'ready' then
    new.delivery_driver_id := null; new.delivery_driver_name := null;
  elsif old.fulfillment = 'delivery' and old.delivery_driver_id = auth.uid() and actor_role = 'logistics' and
        old.delivery_status = 'assigned' and new.delivery_status = 'out_for_delivery' then
    if new.pickup_code is distinct from old.order_code then raise exception 'Scan the matching product order code'; end if;
  elsif old.fulfillment = 'delivery' and old.delivery_driver_id = auth.uid() and actor_role = 'logistics' and
        old.delivery_status = 'out_for_delivery' and new.delivery_status = 'delivered' then
    if length(btrim(coalesce(new.recipient_name,''))) < 2 then raise exception 'Enter recipient name'; end if;
    new.delivered_at := now();
  else raise exception 'Invalid product handover'; end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger gl_update_sale before update on public.gl_sales
for each row execute function groundloop_private.gl_update_sale();

create function groundloop_private.gl_log_sale_transition()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.gl_events(entity,entity_id,action,actor_id,actor_email,details)
  values ('gl_sales',new.id,new.delivery_status,auth.uid(),lower(auth.jwt()->>'email'),
    jsonb_build_object('code',new.order_code,'customer',new.customer_name,'packs',new.packs));
  return new;
end;
$$;
create trigger gl_log_sale_transition after update on public.gl_sales
for each row execute function groundloop_private.gl_log_sale_transition();
