-- Product deliveries use the same separation of public reference and private
-- QR proof as collection requests. One shared sequence prevents cross-type
-- six-digit reference collisions.
alter table public.gl_sales alter column order_code drop default;

create table groundloop_private.gl_sale_secrets (
  sale_id uuid primary key references public.gl_sales(id) on delete cascade,
  secret text not null unique check (secret ~ '^[0-9A-F]{16}$'),
  created_at timestamptz not null default now()
);
alter table groundloop_private.gl_sale_secrets enable row level security;
revoke all on groundloop_private.gl_sale_secrets from public, anon, authenticated;

create function groundloop_private.gl_issue_sale_secret()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  insert into groundloop_private.gl_sale_secrets(sale_id,secret)
  values(new.id,upper(encode(extensions.gen_random_bytes(8),'hex')));
  return new;
end;
$function$;
create trigger zz_gl_issue_sale_secret after insert on public.gl_sales
for each row execute function groundloop_private.gl_issue_sale_secret();

alter table public.gl_sales disable trigger gl_update_sale;
update public.gl_sales
set order_code=groundloop_private.gl_new_request_number(),
    pickup_code=case when pickup_code is null then null else 'verified' end;
alter table public.gl_sales enable trigger gl_update_sale;
insert into groundloop_private.gl_sale_secrets(sale_id,secret)
select id,upper(encode(extensions.gen_random_bytes(8),'hex')) from public.gl_sales;

update public.gl_events e set details=jsonb_set(e.details,'{code}',to_jsonb(s.order_code))
from public.gl_sales s where e.entity='gl_sales' and e.entity_id=s.id;

create function groundloop_private.gl_sale_secret(target_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $function$
declare result text; worker_role text := groundloop_private.gl_role();
begin
  if coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception 'Verified employee required'; end if;
  select q.secret into result from groundloop_private.gl_sale_secrets q
  join public.gl_sales s on s.id=q.sale_id
  where s.id=target_id and s.fulfillment='delivery' and (
    (worker_role='production' and s.delivery_status in ('ready','assigned'))
    or (worker_role='logistics' and s.delivery_driver_id=auth.uid() and s.delivery_status='out_for_delivery')
  );
  if result is null then raise exception 'QR is unavailable for this order'; end if;
  return result;
end;
$function$;
revoke all on function groundloop_private.gl_sale_secret(uuid) from public,anon;
grant execute on function groundloop_private.gl_sale_secret(uuid) to authenticated;

create function public.gl_get_sale_qr(target_id uuid)
returns text language sql stable security invoker set search_path = '' as $function$
  select groundloop_private.gl_sale_secret(target_id)
$function$;
revoke all on function public.gl_get_sale_qr(uuid) from public,anon;
grant execute on function public.gl_get_sale_qr(uuid) to authenticated;

create function groundloop_private.gl_matches_sale_secret(target_id uuid,candidate text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists(select 1 from groundloop_private.gl_sale_secrets q
    where q.sale_id=target_id and q.secret=upper(btrim(candidate)))
$function$;
revoke all on function groundloop_private.gl_matches_sale_secret(uuid,text) from public,anon;
grant execute on function groundloop_private.gl_matches_sale_secret(uuid,text) to authenticated;

create or replace function groundloop_private.gl_check_sale()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare available integer; output integer;
begin
  if groundloop_private.gl_role() <> 'manager' then raise exception 'Only management can create product orders'; end if;
  if length(btrim(new.customer_name)) < 2 then raise exception 'Customer name is required'; end if;
  if new.fulfillment='delivery' and length(btrim(coalesce(new.delivery_address,'')))<5 then
    raise exception 'Delivery address is required';
  end if;
  select produced_packs into output from public.gl_batches where id=new.batch_id and status='complete' for update;
  if not found then raise exception 'Batch is not ready for sale'; end if;
  select output-coalesce(sum(packs),0) into available from public.gl_sales
  where batch_id=new.batch_id and delivery_status<>'cancelled';
  if new.packs>available then raise exception 'Order exceeds available stock'; end if;
  new.order_code:=groundloop_private.gl_new_request_number();
  new.created_by:=auth.uid(); new.created_at:=now(); new.updated_at:=now();
  new.delivery_status:='ready'; new.delivery_driver_id:=null; new.delivery_driver_name:=null;
  new.delivery_trip_id:=null; new.pickup_code:=null; new.recipient_name:=null; new.delivered_at:=null;
  if new.fulfillment='pickup' then
    new.delivery_address:=null; new.latitude:=null; new.longitude:=null;
  end if;
  return new;
end;
$function$;

create or replace function groundloop_private.gl_update_sale()
returns trigger language plpgsql set search_path = '' as $function$
declare actor_role text := groundloop_private.gl_role();
begin
  if row(new.id,new.order_code,new.batch_id,new.packs,new.unit_price,new.channel,new.customer_name,
         new.fulfillment,new.delivery_address,new.latitude,new.longitude,new.created_by,new.created_at)
     is distinct from
     row(old.id,old.order_code,old.batch_id,old.packs,old.unit_price,old.channel,old.customer_name,
         old.fulfillment,old.delivery_address,old.latitude,old.longitude,old.created_by,old.created_at)
  then raise exception 'Order details cannot be changed after creation'; end if;
  if old.delivery_status='ready' and new.delivery_status='cancelled' and actor_role='manager' then
    null;
  elsif old.fulfillment='pickup' and old.delivery_status='ready' and new.delivery_status='delivered' and actor_role='manager' then
    if length(btrim(coalesce(new.recipient_name,'')))<2 then raise exception 'Enter recipient name'; end if;
    new.delivered_at:=now();
  elsif old.fulfillment='delivery' and old.delivery_status='ready' and new.delivery_status='assigned' and actor_role='logistics' then
    new.delivery_driver_id:=auth.uid(); new.delivery_driver_name:=groundloop_private.gl_name();
  elsif old.fulfillment='delivery' and old.delivery_driver_id=auth.uid() and actor_role='logistics' and
        old.delivery_status='assigned' and new.delivery_status='ready' then
    new.delivery_driver_id:=null; new.delivery_driver_name:=null;
  elsif old.fulfillment='delivery' and old.delivery_driver_id=auth.uid() and actor_role='logistics' and
        old.delivery_status='assigned' and new.delivery_status='out_for_delivery' then
    if not groundloop_private.gl_matches_sale_secret(old.id,new.pickup_code) then
      raise exception 'QR or product handoff code does not match';
    end if;
    new.pickup_code:='verified';
  elsif old.fulfillment='delivery' and old.delivery_driver_id=auth.uid() and actor_role='logistics' and
        old.delivery_status='out_for_delivery' and new.delivery_status='delivered' then
    if length(btrim(coalesce(new.recipient_name,'')))<2 then raise exception 'Enter recipient name'; end if;
    new.delivered_at:=now();
  else raise exception 'Invalid product handover'; end if;
  new.updated_at:=now();
  return new;
end;
$function$;
