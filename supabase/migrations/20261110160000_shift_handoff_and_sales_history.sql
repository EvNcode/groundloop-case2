-- A barista on the same point may finish a held record left by the previous shift.
drop policy if exists gl_containers_update on public.gl_containers;
create policy gl_containers_update on public.gl_containers
  for update to authenticated
  using (
    (groundloop_private.gl_role() = 'barista' and store_id = groundloop_private.gl_store())
    or groundloop_private.gl_role() in ('logistics', 'production')
  )
  with check (
    (groundloop_private.gl_role() = 'barista' and store_id = groundloop_private.gl_store())
    or groundloop_private.gl_role() in ('logistics', 'production')
  );

create or replace function groundloop_private.gl_prepare_container()
returns trigger language plpgsql set search_path = '' as $function$
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
    if old.store_id is distinct from groundloop_private.gl_store() then raise exception 'Wrong store'; end if;
    if old.status in ('ready','hold','rejected') and new.status in ('ready','hold','rejected','cancelled') then
      if new.status <> 'cancelled' and new.status <> expected_status then raise exception 'Quality and status disagree'; end if;
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
       is distinct from row(old.cups,old.wet_kg,old.quality,old.note,old.batch_id) then raise exception 'Driver cannot change collection details'; end if;
    if old.status = 'ready' and new.status = 'assigned' then
      if not exists (select 1 from public.gl_trips t where t.id = new.trip_id and t.driver_id = auth.uid() and t.status = 'active') then raise exception 'Choose your active trip'; end if;
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
    else raise exception 'Invalid logistics transition'; end if;
  elsif actor_role = 'production' then
    if row(new.cups,new.wet_kg,new.quality,new.note,new.trip_id)
       is distinct from row(old.cups,old.wet_kg,old.quality,old.note,old.trip_id) then raise exception 'Production cannot change collection details'; end if;
    if old.status = 'picked_up' and new.status = 'received' then
      if new.receipt_code is distinct from old.code then raise exception 'Scan the matching container code'; end if;
      new.received_by := auth.uid(); new.received_at := now();
    elsif old.status = 'received' and new.status = 'picked_up' then
      if old.received_by <> auth.uid() or old.batch_id is not null then raise exception 'Receipt cannot be undone'; end if;
      new.receipt_code := null; new.received_by := null; new.received_at := null;
    elsif old.status = 'received' and new.status = 'batched' then
      if new.batch_id is null or not exists (select 1 from public.gl_batches b where b.id = new.batch_id and new.id = any(b.container_ids)) then raise exception 'Container is not in this batch'; end if;
    else raise exception 'Invalid production transition'; end if;
  else raise exception 'No operational role'; end if;
  new.updated_at := now(); new.version := old.version + 1;
  return new;
end;
$function$;

create index if not exists gl_sales_history_idx on public.gl_sales (created_at desc, id desc)
  where delivery_status in ('delivered','cancelled');

create or replace function public.gl_search_sales_history(
  search_text text default '', search_date date default null,
  oldest_first boolean default false, page_offset integer default 0, page_size integer default 26
)
returns setof public.gl_sales
language plpgsql stable security invoker set search_path = '' as $function$
begin
  if groundloop_private.gl_role() <> 'manager' then raise exception 'Manager access required'; end if;
  return query
    select s.* from public.gl_sales s
    where s.delivery_status in ('delivered','cancelled')
      and (nullif(btrim(search_text),'') is null
        or strpos(lower(s.customer_name), lower(btrim(search_text))) > 0
        or strpos(lower(s.order_code), lower(btrim(search_text))) > 0)
      and (search_date is null or (s.created_at at time zone 'Asia/Qyzylorda')::date = search_date)
    order by
      case when oldest_first then s.created_at end asc,
      case when not oldest_first then s.created_at end desc,
      s.id desc
    limit least(greatest(page_size,1),51) offset greatest(page_offset,0);
end;
$function$;
grant execute on function public.gl_search_sales_history(text,date,boolean,integer,integer) to authenticated;
