-- Isolate the membership lookup from RLS to avoid a trips/containers policy cycle.
create function groundloop_private.gl_barista_trip(target_trip uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.gl_containers c
    where c.trip_id = target_trip
      and c.store_id = groundloop_private.gl_store()
      and c.status in ('assigned','picked_up')
  )
$$;
revoke all on function groundloop_private.gl_barista_trip(uuid) from public,anon;
grant execute on function groundloop_private.gl_barista_trip(uuid) to authenticated;

drop policy gl_positions_read on public.gl_driver_positions;
create policy gl_positions_read on public.gl_driver_positions for select to authenticated using (
  groundloop_private.gl_role() = 'manager' or
  (groundloop_private.gl_role() = 'logistics' and driver_id = auth.uid()) or
  (groundloop_private.gl_role() = 'barista' and groundloop_private.gl_barista_trip(trip_id))
);
drop policy gl_trips_read on public.gl_trips;
create policy gl_trips_read on public.gl_trips for select to authenticated using (
  groundloop_private.gl_role() in ('manager','production') or
  (groundloop_private.gl_role() = 'logistics' and driver_id = auth.uid()) or
  (groundloop_private.gl_role() = 'barista' and groundloop_private.gl_barista_trip(id))
);
