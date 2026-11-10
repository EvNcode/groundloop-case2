-- Transactional smoke test against a Supabase project. All QA data is rolled back.
begin;
insert into public.gl_staff(email,full_name,role,store_id) values
  ('qa-barista@groundloop.test','QA Barista','barista',(select id from public.gl_stores limit 1)),
  ('qa-driver@groundloop.test','QA Driver','logistics',null),
  ('qa-production@groundloop.test','QA Production','production',null),
  ('qa-manager@groundloop.test','QA Manager','manager',null);

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","email":"qa-barista@groundloop.test"}',true);
with c as (insert into public.gl_containers(wet_kg,cups,quality,note,status,store_id,created_by,created_by_email,barista_name)
  values(2.50,18,'good','Проверено','ready',(select id from public.gl_stores limit 1),'11111111-1111-4111-8111-111111111111','x','x') returning id,code)
select set_config('gl.qa_container',id::text,true),set_config('gl.qa_code',code,true) from c;
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
do $$ begin
  begin
    update public.gl_containers set status='picked_up',pickup_code='wrong' where id=current_setting('gl.qa_container')::uuid;
    raise exception 'Expected pickup scan guard';
  exception when others then
    if sqlerrm = 'Expected pickup scan guard' then raise; end if;
  end;
end $$;
update public.gl_containers set status='picked_up',pickup_code=current_setting('gl.qa_code') where id=current_setting('gl.qa_container')::uuid;
update public.gl_containers set status='assigned',pickup_code=null where id=current_setting('gl.qa_container')::uuid;
update public.gl_containers set status='picked_up',pickup_code=current_setting('gl.qa_code') where id=current_setting('gl.qa_container')::uuid;
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
update public.gl_containers set status='received',receipt_code=current_setting('gl.qa_code') where id=current_setting('gl.qa_container')::uuid;
update public.gl_containers set status='picked_up',receipt_code=null where id=current_setting('gl.qa_container')::uuid;
update public.gl_containers set status='received',receipt_code=current_setting('gl.qa_code') where id=current_setting('gl.qa_container')::uuid;
with b as (insert into public.gl_batches(container_ids,created_by,operator_name)
  values(array[current_setting('gl.qa_container')::uuid],'33333333-3333-4333-8333-333333333333','x') returning id)
select set_config('gl.qa_batch',id::text,true) from b;
update public.gl_batches set status='drying' where id=current_setting('gl.qa_batch')::uuid;
update public.gl_batches set status='production',dried_kg=1.30,accepted_kg=1.10 where id=current_setting('gl.qa_batch')::uuid;
update public.gl_batches set status='complete',produced_packs=6 where id=current_setting('gl.qa_batch')::uuid;

select set_config('request.jwt.claims','{"sub":"44444444-4444-4444-8444-444444444444","email":"qa-manager@groundloop.test"}',true);
insert into public.gl_sales(batch_id,packs,unit_price,channel,created_by)
values(current_setting('gl.qa_batch')::uuid,3,850,'Кофейня','44444444-4444-4444-8444-444444444444');
do $$ begin
  begin
    insert into public.gl_sales(batch_id,packs,unit_price,channel,created_by)
    values(current_setting('gl.qa_batch')::uuid,4,850,'Кофейня','44444444-4444-4444-8444-444444444444');
    raise exception 'Expected stock guard';
  exception when others then
    if sqlerrm = 'Expected stock guard' then raise; end if;
  end;
end $$;
select (select status from public.gl_containers where id=current_setting('gl.qa_container')::uuid) as container_status,
       (select status from public.gl_containers where id=current_setting('gl.qa_cancel')::uuid) as cancelled_status,
       (select status from public.gl_batches where id=current_setting('gl.qa_batch')::uuid) as batch_status,
       (select count(*) from public.gl_events where entity_id=current_setting('gl.qa_container')::uuid) as audit_events,
       (select sum(packs) from public.gl_sales where batch_id=current_setting('gl.qa_batch')::uuid) as sold_packs;
rollback;
