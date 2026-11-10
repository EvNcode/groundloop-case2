-- Lock stock across concurrent sales without requiring managers to update batches.
create or replace function groundloop_private.gl_check_sale()
returns trigger language plpgsql security definer set search_path = '' as $$
declare available integer; output integer;
begin
  if groundloop_private.gl_role() <> 'manager' then raise exception 'Only management can record sales'; end if;
  select produced_packs into output from public.gl_batches where id = new.batch_id and status = 'complete' for update;
  if not found then raise exception 'Batch is not ready for sale'; end if;
  select output - coalesce(sum(packs),0) into available from public.gl_sales where batch_id = new.batch_id;
  if new.packs > available then raise exception 'Sale exceeds available stock'; end if;
  new.created_by := auth.uid(); return new;
end;
$$;
