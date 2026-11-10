-- The UI and GPS both use a single active trip per driver.
create unique index gl_one_active_trip_per_driver on public.gl_trips(driver_id) where status = 'active';
