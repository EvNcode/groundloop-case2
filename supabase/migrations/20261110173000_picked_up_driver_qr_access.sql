-- After a verified pickup, the assigned driver may show the QR at the plant.
-- Before pickup the driver cannot request the secret through the API.
create or replace function groundloop_private.gl_container_secret(target_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $function$
declare result text; worker_role text := groundloop_private.gl_role();
begin
  if coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception 'Verified employee required';
  end if;
  select s.secret into result
  from groundloop_private.gl_container_secrets s
  join public.gl_containers c on c.id = s.container_id
  where c.id = target_id and (
    (worker_role = 'barista' and c.store_id = groundloop_private.gl_store()
      and c.status in ('ready','assigned'))
    or (worker_role = 'logistics' and c.picked_up_by = auth.uid()
      and c.status = 'picked_up')
  );
  if result is null then raise exception 'QR is unavailable for this request'; end if;
  return result;
end;
$function$;
