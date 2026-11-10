-- Count every reserved sale in Postgres. The browser only loads a page of
-- operational rows, so its local list cannot be the stock authority.
create function public.gl_batch_stock()
returns table(batch_id uuid, available_packs integer)
language sql stable security invoker set search_path = '' as $function$
  select b.id,
         greatest(0,b.produced_packs-coalesce(sum(s.packs) filter (where s.delivery_status <> 'cancelled'),0))::integer
  from public.gl_batches b
  left join public.gl_sales s on s.batch_id=b.id
  where b.status='complete' and groundloop_private.gl_role()='manager'
  group by b.id,b.produced_packs
$function$;
revoke all on function public.gl_batch_stock() from public,anon;
grant execute on function public.gl_batch_stock() to authenticated;
