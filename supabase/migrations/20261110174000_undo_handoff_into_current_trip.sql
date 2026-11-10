-- If production undoes a receipt after the driver started the next trip,
-- the container rejoins that driver's current trip rather than trying to
-- reopen a completed trip beside an active one.
create function groundloop_private.gl_transfer_undone_receipt()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare driver uuid; current_trip uuid;
begin
  if old.status='received' and new.status='picked_up' and old.trip_id is not null then
    select driver_id into driver from public.gl_trips where id=old.trip_id;
    select id into current_trip from public.gl_trips
    where driver_id=driver and status='active' order by started_at desc limit 1;
    if current_trip is not null then new.trip_id := current_trip; end if;
  end if;
  return new;
end;
$function$;
create trigger zy_gl_transfer_undone_receipt before update on public.gl_containers
for each row execute function groundloop_private.gl_transfer_undone_receipt();
