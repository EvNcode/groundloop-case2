-- Product deliveries use the same driver shift and GPS stream as collections.
alter table public.gl_sales add column delivery_trip_id uuid references public.gl_trips(id);
create index gl_sales_delivery_trip on public.gl_sales(delivery_trip_id) where delivery_trip_id is not null;

create function groundloop_private.gl_assign_delivery_trip()
returns trigger language plpgsql security definer set search_path = '' as $$
declare active_trip uuid;
begin
  if old.fulfillment = 'delivery' and old.delivery_status = 'ready' and new.delivery_status = 'assigned' then
    select id into active_trip from public.gl_trips
    where driver_id = auth.uid() and status = 'active' order by started_at desc limit 1;
    if active_trip is null then raise exception 'Start a trip before taking a delivery'; end if;
    new.delivery_trip_id := active_trip;
  elsif old.fulfillment = 'delivery' and old.delivery_status = 'assigned' and new.delivery_status = 'ready' then
    new.delivery_trip_id := null;
  elsif new.delivery_trip_id is distinct from old.delivery_trip_id then
    raise exception 'Delivery trip cannot be changed';
  end if;
  return new;
end;
$$;
create trigger aa_gl_assign_delivery_trip before update on public.gl_sales
for each row execute function groundloop_private.gl_assign_delivery_trip();

create function groundloop_private.gl_delivery_trip_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'active' and new.status in ('completed','cancelled') and exists (
    select 1 from public.gl_sales s
    where s.delivery_trip_id = old.id and s.delivery_status in ('assigned','out_for_delivery')
  ) then raise exception 'Deliver or release product orders before closing the trip'; end if;
  return new;
end;
$$;
create trigger aa_gl_delivery_trip_guard before update on public.gl_trips
for each row execute function groundloop_private.gl_delivery_trip_guard();
