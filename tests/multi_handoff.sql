-- Two containers in one trip: the first can enter production while the second
-- is still in transit. The trip closes only after the final receipt.
begin;
insert into public.gl_staff(email,full_name,role,store_id) values
  ('qa-multi-barista@groundloop.test','QA Barista','barista',(select id from public.gl_stores limit 1)),
  ('qa-multi-driver@groundloop.test','QA Driver','logistics',null),
  ('qa-multi-production@groundloop.test','QA Production','production',null);
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaa1111-1111-4111-8111-111111111111","email":"qa-multi-barista@groundloop.test"}',true);
with c as (insert into public.gl_containers(wet_kg,cups,quality,note)
  values(2.00,12,'good',''),(3.00,18,'good','') returning id,created_at)
select set_config('gl.qa_first',(select id::text from c order by id limit 1),true),
       set_config('gl.qa_second',(select id::text from c order by id desc limit 1),true);
select set_config('gl.qa_first_secret',public.gl_get_container_qr(current_setting('gl.qa_first')::uuid),true),
       set_config('gl.qa_second_secret',public.gl_get_container_qr(current_setting('gl.qa_second')::uuid),true);
select set_config('request.jwt.claims','{"sub":"bbbb2222-2222-4222-8222-222222222222","email":"qa-multi-driver@groundloop.test"}',true);
with t as (insert into public.gl_trips default values returning id)
select set_config('gl.qa_trip',id::text,true) from t;
update public.gl_containers set status='assigned',trip_id=current_setting('gl.qa_trip')::uuid
where id in (current_setting('gl.qa_first')::uuid,current_setting('gl.qa_second')::uuid);
update public.gl_containers set status='picked_up',pickup_code=current_setting('gl.qa_first_secret')
where id=current_setting('gl.qa_first')::uuid;
update public.gl_containers set status='picked_up',pickup_code=current_setting('gl.qa_second_secret')
where id=current_setting('gl.qa_second')::uuid;
select set_config('request.jwt.claims','{"sub":"cccc3333-3333-4333-8333-333333333333","email":"qa-multi-production@groundloop.test"}',true);
update public.gl_containers set status='received',receipt_code=current_setting('gl.qa_first_secret')
where id=current_setting('gl.qa_first')::uuid;
do $$ begin
  if (select status from public.gl_trips where id=current_setting('gl.qa_trip')::uuid)<>'active' then
    raise exception 'Trip closed before all containers arrived';
  end if;
end $$;
insert into public.gl_batches(container_ids) values(array[current_setting('gl.qa_first')::uuid]);
update public.gl_containers set status='received',receipt_code=current_setting('gl.qa_second_secret')
where id=current_setting('gl.qa_second')::uuid;
do $$ begin
  if (select status from public.gl_trips where id=current_setting('gl.qa_trip')::uuid)<>'completed' then
    raise exception 'Trip did not close after final receipt';
  end if;
end $$;
select (select status from public.gl_trips where id=current_setting('gl.qa_trip')::uuid) as trip_status,
       (select count(*) from public.gl_batches where current_setting('gl.qa_first')::uuid=any(container_ids)) as early_batches;
rollback;
