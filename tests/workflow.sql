-- Transactional smoke test against a Supabase project. All QA data is rolled back.
begin;
insert into public.gl_staff(email,full_name,role,store_id) values
  ('qa-barista@groundloop.test','QA Barista','barista',(select id from public.gl_stores limit 1)),
  ('qa-barista2@groundloop.test','QA Barista 2','barista',(select id from public.gl_stores where id <> (select id from public.gl_stores limit 1) limit 1)),
  ('qa-driver@groundloop.test','QA Driver','logistics',null),
  ('qa-driver2@groundloop.test','QA Driver 2','logistics',null),
  ('qa-production@groundloop.test','QA Production','production',null),
  ('qa-manager@groundloop.test','QA Manager','manager',null);

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","email":"qa-barista@groundloop.test"}',true);
with c as (insert into public.gl_containers(wet_kg,cups,quality,note,status,store_id,created_by,created_by_email,barista_name)
  values(2.50,18,'good','Проверено','ready',(select id from public.gl_stores limit 1),'11111111-1111-4111-8111-111111111111','x','x') returning id,code)
select set_config('gl.qa_container',id::text,true),set_config('gl.qa_reference',code,true) from c;
select set_config('gl.qa_secret',public.gl_get_container_qr(current_setting('gl.qa_container')::uuid),true);
do $$ begin
  if current_setting('gl.qa_reference') !~ '^[0-9]{6}$' then raise exception 'Request reference must be six digits'; end if;
  if current_setting('gl.qa_secret') !~ '^[0-9A-F]{16}$' then raise exception 'QR secret format is invalid'; end if;
  if current_setting('gl.qa_reference') = current_setting('gl.qa_secret') then raise exception 'Reference and QR secret are the same'; end if;
end $$;
select set_config('request.jwt.claims','{"sub":"55555555-5555-4555-8555-555555555555","email":"qa-barista2@groundloop.test"}',true);
do $$ begin
  begin
    perform public.gl_get_container_qr(current_setting('gl.qa_container')::uuid);
    raise exception 'Other store barista read QR';
  exception when others then
    if sqlerrm = 'Other store barista read QR' then raise; end if;
  end;
end $$;
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","email":"qa-barista@groundloop.test"}',true);
with c as (insert into public.gl_containers(wet_kg,cups,quality,note,status,store_id,created_by,created_by_email,barista_name)
  values(1.00,8,'hold','Повторная проверка','hold',(select id from public.gl_stores limit 1),'11111111-1111-4111-8111-111111111111','x','x') returning id)
select set_config('gl.qa_cancel',id::text,true) from c;
update public.gl_containers set status='cancelled' where id=current_setting('gl.qa_cancel')::uuid;
do $$ begin
  begin
    update public.gl_containers set pickup_code='forged' where id=current_setting('gl.qa_container')::uuid;
    raise exception 'Expected barista evidence guard';
  exception when others then
    if sqlerrm = 'Expected barista evidence guard' then raise; end if;
  end;
end $$;

select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222","email":"qa-driver@groundloop.test"}',true);
with t as (insert into public.gl_trips(driver_id,driver_email,driver_name) values('22222222-2222-4222-8222-222222222222','x','x') returning id)
select set_config('gl.qa_trip',id::text,true) from t;
update public.gl_containers set status='assigned',trip_id=current_setting('gl.qa_trip')::uuid where id=current_setting('gl.qa_container')::uuid;
select set_config('request.jwt.claims','{"sub":"66666666-6666-4666-8666-666666666666","email":"qa-driver2@groundloop.test"}',true);
do $$ begin
  begin
    perform public.gl_get_container_qr(current_setting('gl.qa_container')::uuid);
    raise exception 'Other driver read QR';
  exception when others then
    if sqlerrm = 'Other driver read QR' then raise; end if;
  end;
end $$;
select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222","email":"qa-driver@groundloop.test"}',true);
do $$ begin
  begin
    perform public.gl_get_container_qr(current_setting('gl.qa_container')::uuid);
    raise exception 'Driver must not read QR before pickup';
  exception when others then
    if sqlerrm = 'Driver must not read QR before pickup' then raise; end if;
  end;
end $$;
do $$ begin
  begin
    update public.gl_containers set status='picked_up',pickup_code='wrong' where id=current_setting('gl.qa_container')::uuid;
    raise exception 'Expected pickup scan guard';
  exception when others then
    if sqlerrm = 'Expected pickup scan guard' then raise; end if;
  end;
end $$;
do $$ begin
  begin
    update public.gl_containers set status='picked_up',pickup_code=current_setting('gl.qa_reference') where id=current_setting('gl.qa_container')::uuid;
    raise exception 'Public number was accepted as QR';
  exception when others then
    if sqlerrm = 'Public number was accepted as QR' then raise; end if;
  end;
end $$;
update public.gl_containers set status='picked_up',pickup_code=current_setting('gl.qa_secret') where id=current_setting('gl.qa_container')::uuid;
do $$ begin
  if public.gl_get_container_qr(current_setting('gl.qa_container')::uuid) <> current_setting('gl.qa_secret') then
    raise exception 'Driver cannot show QR after pickup';
  end if;
end $$;
update public.gl_containers set status='assigned',pickup_code=null where id=current_setting('gl.qa_container')::uuid;
update public.gl_containers set status='picked_up',pickup_code=current_setting('gl.qa_secret') where id=current_setting('gl.qa_container')::uuid;
insert into public.gl_driver_positions(trip_id,driver_id,latitude,longitude,accuracy_m)
values(current_setting('gl.qa_trip')::uuid,'22222222-2222-4222-8222-222222222222',43.2361,76.9457,12);

select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333333","email":"qa-production@groundloop.test"}',true);
do $$ begin
  begin
    update public.gl_containers set status='received',receipt_code='wrong' where id=current_setting('gl.qa_container')::uuid;
    raise exception 'Expected receipt scan guard';
  exception when others then
    if sqlerrm = 'Expected receipt scan guard' then raise; end if;
  end;
end $$;
update public.gl_containers set status='received',receipt_code=current_setting('gl.qa_secret') where id=current_setting('gl.qa_container')::uuid;
do $$ begin
  if (select status from public.gl_trips where id=current_setting('gl.qa_trip')::uuid) <> 'completed' then
    raise exception 'Trip was not completed automatically after receipt';
  end if;
  if (select pickup_code from public.gl_containers where id=current_setting('gl.qa_container')::uuid) <> 'verified' then
    raise exception 'Pickup secret leaked into the public row';
  end if;
end $$;
select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222","email":"qa-driver@groundloop.test"}',true);
with t as (insert into public.gl_trips(driver_id,driver_email,driver_name)
  values('22222222-2222-4222-8222-222222222222','x','x') returning id)
select set_config('gl.qa_trip2',id::text,true) from t;
select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333333","email":"qa-production@groundloop.test"}',true);
update public.gl_containers set status='picked_up',receipt_code=null where id=current_setting('gl.qa_container')::uuid;
do $$ begin
  if (select trip_id from public.gl_containers where id=current_setting('gl.qa_container')::uuid) <> current_setting('gl.qa_trip2')::uuid then
    raise exception 'Undo did not move the container to the active driver trip';
  end if;
end $$;
update public.gl_containers set status='received',receipt_code=current_setting('gl.qa_secret') where id=current_setting('gl.qa_container')::uuid;
with b as (insert into public.gl_batches(container_ids,created_by,operator_name)
  values(array[current_setting('gl.qa_container')::uuid],'33333333-3333-4333-8333-333333333333','x') returning id)
select set_config('gl.qa_batch',id::text,true) from b;
update public.gl_batches set status='drying' where id=current_setting('gl.qa_batch')::uuid;
update public.gl_batches set status='production',dried_kg=1.30,accepted_kg=1.10 where id=current_setting('gl.qa_batch')::uuid;
update public.gl_batches set status='complete',produced_packs=6 where id=current_setting('gl.qa_batch')::uuid;

select set_config('request.jwt.claims','{"sub":"44444444-4444-4444-8444-444444444444","email":"qa-manager@groundloop.test"}',true);
insert into public.gl_sales(batch_id,packs,unit_price,channel,customer_name,created_by)
values(current_setting('gl.qa_batch')::uuid,3,850,'Кофейня','QA buyer','44444444-4444-4444-8444-444444444444');
do $$ begin
  begin
    insert into public.gl_sales(batch_id,packs,unit_price,channel,customer_name,created_by)
    values(current_setting('gl.qa_batch')::uuid,4,850,'Кофейня','QA buyer','44444444-4444-4444-8444-444444444444');
    raise exception 'Expected stock guard';
  exception when others then
    if sqlerrm = 'Expected stock guard' then raise; end if;
  end;
end $$;
with s as (insert into public.gl_sales(batch_id,packs,unit_price,channel,customer_name,fulfillment,delivery_address,latitude,longitude,created_by)
  values(current_setting('gl.qa_batch')::uuid,1,900,'Прямой заказ','QA delivery buyer','delivery','Шымкент, ул. Тестовая, 5',42.323,69.595,'44444444-4444-4444-8444-444444444444') returning id,order_code)
select set_config('gl.qa_sale',id::text,true),set_config('gl.qa_sale_reference',order_code,true) from s;
do $$ begin
  if current_setting('gl.qa_sale_reference') !~ '^[0-9]{6}$' then raise exception 'Product reference must be six digits'; end if;
  begin
    perform public.gl_get_sale_qr(current_setting('gl.qa_sale')::uuid);
    raise exception 'Manager read product QR';
  exception when others then
    if sqlerrm='Manager read product QR' then raise; end if;
  end;
end $$;
select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333333","email":"qa-production@groundloop.test"}',true);
select set_config('gl.qa_sale_secret',public.gl_get_sale_qr(current_setting('gl.qa_sale')::uuid),true);
select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222","email":"qa-driver@groundloop.test"}',true);
with t as (insert into public.gl_trips(driver_id,driver_email,driver_name)
  values('22222222-2222-4222-8222-222222222222','x','x') returning id)
select set_config('gl.qa_trip3',id::text,true) from t;
update public.gl_sales set delivery_status='assigned' where id=current_setting('gl.qa_sale')::uuid;
do $$ begin
  begin
    perform public.gl_get_sale_qr(current_setting('gl.qa_sale')::uuid);
    raise exception 'Driver read product QR before pickup';
  exception when others then
    if sqlerrm='Driver read product QR before pickup' then raise; end if;
  end;
  begin
    update public.gl_sales set delivery_status='out_for_delivery',pickup_code=current_setting('gl.qa_sale_reference') where id=current_setting('gl.qa_sale')::uuid;
    raise exception 'Product reference was accepted as QR';
  exception when others then
    if sqlerrm='Product reference was accepted as QR' then raise; end if;
  end;
end $$;
update public.gl_sales set delivery_status='out_for_delivery',pickup_code=current_setting('gl.qa_sale_secret') where id=current_setting('gl.qa_sale')::uuid;
do $$ begin
  if public.gl_get_sale_qr(current_setting('gl.qa_sale')::uuid)<>current_setting('gl.qa_sale_secret') then
    raise exception 'Driver cannot show product QR after pickup';
  end if;
  if (select pickup_code from public.gl_sales where id=current_setting('gl.qa_sale')::uuid)<>'verified' then
    raise exception 'Product QR leaked into public row';
  end if;
end $$;
update public.gl_sales set delivery_status='delivered',recipient_name='QA recipient' where id=current_setting('gl.qa_sale')::uuid;
do $$ begin
  if (select status from public.gl_trips where id=current_setting('gl.qa_trip3')::uuid)<>'completed' then
    raise exception 'Delivery trip did not close automatically';
  end if;
end $$;
select set_config('request.jwt.claims','{"sub":"44444444-4444-4444-8444-444444444444","email":"qa-manager@groundloop.test"}',true);
select (select status from public.gl_containers where id=current_setting('gl.qa_container')::uuid) as container_status,
       (select status from public.gl_containers where id=current_setting('gl.qa_cancel')::uuid) as cancelled_status,
       (select status from public.gl_batches where id=current_setting('gl.qa_batch')::uuid) as batch_status,
       (select count(*) from public.gl_events where entity_id=current_setting('gl.qa_container')::uuid) as audit_events,
       (select sum(packs) from public.gl_sales where batch_id=current_setting('gl.qa_batch')::uuid) as sold_packs;
rollback;
