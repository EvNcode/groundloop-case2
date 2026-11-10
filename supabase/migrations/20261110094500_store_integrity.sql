create index gl_containers_batch on public.gl_containers(batch_id) where batch_id is not null;
create index gl_staff_store on public.gl_staff(store_id) where store_id is not null;

create function groundloop_private.gl_require_active_store()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.gl_stores where id = groundloop_private.gl_store() and active) then
    raise exception 'Store is inactive';
  end if;
  return new;
end;
$$;
create trigger gl_require_active_store before insert on public.gl_containers
for each row execute function groundloop_private.gl_require_active_store();
