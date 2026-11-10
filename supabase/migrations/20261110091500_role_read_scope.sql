-- Each role reads only the records needed for its work.
drop policy gl_trips_read on public.gl_trips;
create policy gl_trips_read on public.gl_trips for select to authenticated using (
  groundloop_private.gl_role() = 'manager' or
  (groundloop_private.gl_role() = 'logistics' and driver_id = auth.uid())
);

drop policy gl_containers_read on public.gl_containers;
create policy gl_containers_read on public.gl_containers for select to authenticated using (
  groundloop_private.gl_role() = 'manager' or
  (groundloop_private.gl_role() = 'barista' and store_id = groundloop_private.gl_store()) or
  (groundloop_private.gl_role() = 'logistics' and
    (status = 'ready' or trip_id in (select id from public.gl_trips where driver_id = auth.uid()))) or
  (groundloop_private.gl_role() = 'production' and status in ('picked_up','received','batched'))
);

drop policy gl_batches_read on public.gl_batches;
create policy gl_batches_read on public.gl_batches for select to authenticated using (
  groundloop_private.gl_role() in ('production','manager')
);

drop policy gl_sales_read on public.gl_sales;
create policy gl_sales_read on public.gl_sales for select to authenticated using (
  groundloop_private.gl_role() in ('production','manager')
);

drop policy gl_positions_read on public.gl_driver_positions;
create policy gl_positions_read on public.gl_driver_positions for select to authenticated using (
  groundloop_private.gl_role() = 'manager' or
  (groundloop_private.gl_role() = 'logistics' and driver_id = auth.uid())
);

drop policy gl_events_read on public.gl_events;
create policy gl_events_read on public.gl_events for select to authenticated using (
  groundloop_private.gl_role() = 'manager'
);
