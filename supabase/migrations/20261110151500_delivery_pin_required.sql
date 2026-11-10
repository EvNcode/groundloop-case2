-- A delivery without a mapped destination cannot appear in the driver's route.
alter table public.gl_sales add constraint gl_delivery_pin_required check (
  fulfillment <> 'delivery' or (latitude is not null and longitude is not null)
);
