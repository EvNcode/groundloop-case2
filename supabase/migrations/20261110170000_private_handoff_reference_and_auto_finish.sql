-- A public six-digit request reference is never used as handoff proof.
-- The QR secret stays in an unexposed schema and is returned only to baristas
-- assigned to the request's store. Drivers and production prove physical
-- possession by scanning the label; no secret is sent in list responses.
create sequence groundloop_private.gl_request_number_seq minvalue 1 maxvalue 999999 no cycle;

create function groundloop_private.gl_new_request_number()
returns text language sql volatile set search_path = '' as $function$
  select lpad((((nextval('groundloop_private.gl_request_number_seq') * 48271 + 137) % 1000000)::integer)::text, 6, '0')
$function$;

alter table public.gl_containers alter column code drop default;

create table groundloop_private.gl_container_secrets (
  container_id uuid primary key references public.gl_containers(id) on delete cascade,
  secret text not null unique check (secret ~ '^[0-9A-F]{16}$'),
  created_at timestamptz not null default now()
);
alter table groundloop_private.gl_container_secrets enable row level security;
revoke all on groundloop_private.gl_container_secrets from public, anon, authenticated;

create function groundloop_private.gl_issue_container_secret()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  insert into groundloop_private.gl_container_secrets(container_id, secret)
  values (new.id, upper(encode(extensions.gen_random_bytes(8), 'hex')));
  return new;
end;
$function$;
create trigger zz_gl_issue_container_secret after insert on public.gl_containers
for each row execute function groundloop_private.gl_issue_container_secret();

-- Existing pilot references were also QR values. Replace them and invalidate
-- their old handoff values; no container is in transit during this migration.
alter table public.gl_containers disable trigger gl_prepare_container;
update public.gl_containers
set code = groundloop_private.gl_new_request_number(),
    pickup_code = case when pickup_code is null then null else 'verified' end,
    receipt_code = case when receipt_code is null then null else 'verified' end;
alter table public.gl_containers enable trigger gl_prepare_container;

insert into groundloop_private.gl_container_secrets(container_id, secret)
select id, upper(encode(extensions.gen_random_bytes(8), 'hex')) from public.gl_containers;

update public.gl_notifications n set container_code = c.code
from public.gl_containers c where n.container_id = c.id;
update public.gl_events e set details = jsonb_set(e.details, '{code}', to_jsonb(c.code))
from public.gl_containers c where e.entity = 'gl_containers' and e.entity_id = c.id;

create function groundloop_private.gl_container_secret(target_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $function$
declare result text;
begin
  if groundloop_private.gl_role() <> 'barista'
     or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception 'Barista access required';
  end if;
  select s.secret into result
  from groundloop_private.gl_container_secrets s
  join public.gl_containers c on c.id = s.container_id
  where c.id = target_id and c.store_id = groundloop_private.gl_store()
    and c.status in ('ready','assigned');
  if result is null then raise exception 'QR is unavailable for this request'; end if;
  return result;
end;
$function$;
revoke all on function groundloop_private.gl_container_secret(uuid) from public, anon;
grant execute on function groundloop_private.gl_container_secret(uuid) to authenticated;

create function public.gl_get_container_qr(target_id uuid)
returns text language sql stable security invoker set search_path = '' as $function$
  select groundloop_private.gl_container_secret(target_id)
$function$;
revoke all on function public.gl_get_container_qr(uuid) from public, anon;
grant execute on function public.gl_get_container_qr(uuid) to authenticated;

create function groundloop_private.gl_matches_container_secret(target_id uuid, candidate text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1 from groundloop_private.gl_container_secrets s
    where s.container_id = target_id and s.secret = upper(btrim(candidate))
  )
$function$;
revoke all on function groundloop_private.gl_matches_container_secret(uuid,text) from public, anon;
grant execute on function groundloop_private.gl_matches_container_secret(uuid,text) to authenticated;

create or replace function groundloop_private.gl_prepare_container()
returns trigger language plpgsql set search_path = '' as $function$
declare actor_role text := groundloop_private.gl_role(); expected_status text;
begin
  expected_status := case new.quality when 'good' then 'ready' when 'hold' then 'hold' else 'rejected' end;
  if tg_op = 'INSERT' then
    if actor_role <> 'barista' then raise exception 'Only a barista can create a container'; end if;
    new.code := groundloop_private.gl_new_request_number();
    new.store_id := groundloop_private.gl_store();
    new.created_by := auth.uid();
    new.created_by_email := lower(auth.jwt()->>'email');
    new.barista_name := groundloop_private.gl_name();
    new.status := expected_status;
    new.trip_id := null; new.pickup_code := null; new.picked_up_by := null; new.picked_up_at := null;
    new.receipt_code := null; new.received_by := null; new.received_at := null; new.batch_id := null;
    new.created_at := now(); new.updated_at := now(); new.version := 1;
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
    else raise exception 'Container already handed off'; end if;
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
      if not exists (select 1 from public.gl_trips t where t.id = old.trip_id and t.driver_id = auth.uid() and t.status = 'active') then raise exception 'Wrong driver'; end if;
      if not groundloop_private.gl_matches_container_secret(old.id,new.pickup_code) then raise exception 'QR or handoff code does not match'; end if;
      new.pickup_code := 'verified';
      new.picked_up_by := auth.uid(); new.picked_up_at := now();
    elsif old.status = 'picked_up' and new.status = 'assigned' then
      if old.picked_up_by <> auth.uid() or old.received_at is not null then raise exception 'Pickup cannot be undone'; end if;
      new.pickup_code := null; new.picked_up_by := null; new.picked_up_at := null;
    else raise exception 'Invalid logistics transition'; end if;
  elsif actor_role = 'production' then
    if row(new.cups,new.wet_kg,new.quality,new.note,new.trip_id)
       is distinct from row(old.cups,old.wet_kg,old.quality,old.note,old.trip_id) then raise exception 'Production cannot change collection details'; end if;
    if old.status = 'picked_up' and new.status = 'received' then
      if not groundloop_private.gl_matches_container_secret(old.id,new.receipt_code) then raise exception 'QR or handoff code does not match'; end if;
      new.receipt_code := 'verified';
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

-- Only internal handoff triggers can complete a trip. A driver may cancel an
-- empty trip, but cannot mark a loaded trip complete ahead of production.
create or replace function groundloop_private.gl_prepare_trip()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if tg_op = 'INSERT' then
    if groundloop_private.gl_role() <> 'logistics' then raise exception 'Only logistics can start trips'; end if;
    new.driver_id := auth.uid(); new.driver_email := lower(auth.jwt()->>'email');
    new.driver_name := groundloop_private.gl_name(); new.status := 'active';
  else
    if old.status <> 'active' then raise exception 'Trip is already closed'; end if;
    if new.status = 'completed' then
      if current_setting('groundloop.auto_finish_trip',true) is distinct from old.id::text then
        raise exception 'Trip completes after the final handoff';
      end if;
    elsif new.status = 'cancelled' then
      if groundloop_private.gl_role() <> 'logistics' or old.driver_id <> auth.uid() then raise exception 'Wrong driver'; end if;
      if exists (select 1 from public.gl_containers c where c.trip_id = old.id)
         or exists (select 1 from public.gl_sales s where s.delivery_trip_id = old.id) then
        raise exception 'Only an empty trip can be cancelled';
      end if;
    else raise exception 'Invalid trip transition'; end if;
    if exists (select 1 from public.gl_containers c where c.trip_id = old.id and c.status in ('assigned','picked_up'))
       or exists (select 1 from public.gl_sales s where s.delivery_trip_id = old.id and s.delivery_status in ('assigned','out_for_delivery')) then
      raise exception 'Trip still has pending handoffs';
    end if;
    new.finished_at := now();
  end if;
  return new;
end;
$function$;

create function groundloop_private.gl_finish_trip_if_ready(target_trip uuid)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  if target_trip is null then return; end if;
  if not exists (select 1 from public.gl_trips t where t.id=target_trip and t.status='active') then return; end if;
  if exists (select 1 from public.gl_containers c where c.trip_id=target_trip and c.status in ('assigned','picked_up'))
     or exists (select 1 from public.gl_sales s where s.delivery_trip_id=target_trip and s.delivery_status in ('assigned','out_for_delivery')) then return; end if;
  if not exists (select 1 from public.gl_containers c where c.trip_id=target_trip and c.status in ('received','batched'))
     and not exists (select 1 from public.gl_sales s where s.delivery_trip_id=target_trip and s.delivery_status='delivered') then return; end if;
  perform set_config('groundloop.auto_finish_trip',target_trip::text,true);
  update public.gl_trips set status='completed' where id=target_trip and status='active';
  perform set_config('groundloop.auto_finish_trip','',true);
end;
$function$;
revoke all on function groundloop_private.gl_finish_trip_if_ready(uuid) from public, anon, authenticated;

create function groundloop_private.gl_auto_finish_container_trip()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if old.status='picked_up' and new.status='received' then
    perform groundloop_private.gl_finish_trip_if_ready(new.trip_id);
  end if;
  return new;
end;
$function$;
create trigger zz_gl_auto_finish_container_trip after update on public.gl_containers
for each row execute function groundloop_private.gl_auto_finish_container_trip();

create function groundloop_private.gl_auto_finish_delivery_trip()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if old.delivery_status in ('assigned','out_for_delivery') and new.delivery_status in ('delivered','ready','cancelled') then
    perform groundloop_private.gl_finish_trip_if_ready(old.delivery_trip_id);
  end if;
  return new;
end;
$function$;
create trigger zz_gl_auto_finish_delivery_trip after update on public.gl_sales
for each row execute function groundloop_private.gl_auto_finish_delivery_trip();

-- A received container can enter a batch immediately; the rest of its trip
-- must not block production.
drop trigger if exists gl_batch_closed_trip on public.gl_batches;
drop function if exists groundloop_private.gl_batch_closed_trip();
