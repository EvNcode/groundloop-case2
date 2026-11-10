-- A production receipt can be undone before batching. Reopen the affected
-- trip so that the driver can correct the physical handoff if necessary.
create or replace function groundloop_private.gl_prepare_trip()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if tg_op = 'INSERT' then
    if groundloop_private.gl_role() <> 'logistics' then raise exception 'Only logistics can start trips'; end if;
    new.driver_id := auth.uid(); new.driver_email := lower(auth.jwt()->>'email');
    new.driver_name := groundloop_private.gl_name(); new.status := 'active';
  else
    if old.status = 'completed' and new.status = 'active' then
      if groundloop_private.gl_role() <> 'production'
         or current_setting('groundloop.auto_reopen_trip',true) is distinct from old.id::text then
        raise exception 'Trip cannot be reopened manually';
      end if;
      new.finished_at := null;
      return new;
    end if;
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

create or replace function groundloop_private.gl_auto_finish_container_trip()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if old.status='received' and new.status='picked_up' and new.trip_id is not null then
    if exists (select 1 from public.gl_trips t where t.id=new.trip_id and t.status='completed') then
      perform set_config('groundloop.auto_reopen_trip',new.trip_id::text,true);
      update public.gl_trips set status='active' where id=new.trip_id and status='completed';
      perform set_config('groundloop.auto_reopen_trip','',true);
    end if;
  elsif old.status in ('assigned','picked_up') and new.status not in ('assigned','picked_up') then
    perform groundloop_private.gl_finish_trip_if_ready(old.trip_id);
  end if;
  return new;
end;
$function$;
