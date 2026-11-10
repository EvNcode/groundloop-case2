-- Baristas can track only drivers carrying a container from their own store.
drop policy gl_positions_read on public.gl_driver_positions;
create policy gl_positions_read on public.gl_driver_positions for select to authenticated using (
  groundloop_private.gl_role() = 'manager' or
  (groundloop_private.gl_role() = 'logistics' and driver_id = auth.uid()) or
  (groundloop_private.gl_role() = 'barista' and exists (
    select 1 from public.gl_containers c
    where c.trip_id = gl_driver_positions.trip_id
      and c.store_id = groundloop_private.gl_store()
      and c.status in ('assigned','picked_up')
  ))
);

-- A barista needs the driver's name and trip code for the live map.
drop policy gl_trips_read on public.gl_trips;
create policy gl_trips_read on public.gl_trips for select to authenticated using (
  groundloop_private.gl_role() in ('manager','production') or
  (groundloop_private.gl_role() = 'logistics' and driver_id = auth.uid()) or
  (groundloop_private.gl_role() = 'barista' and exists (
    select 1 from public.gl_containers c
    where c.trip_id = gl_trips.id
      and c.store_id = groundloop_private.gl_store()
      and c.status in ('assigned','picked_up')
  ))
);
