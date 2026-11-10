create or replace function groundloop_private.validate_open_routes()
returns trigger language plpgsql set search_path = '' as $$
declare
  route jsonb;
  batch jsonb;
  route_count integer;
  listed_count integer;
  listed_kg numeric;
begin
  for route in select value from jsonb_array_elements(new.state->'routes') loop
    if jsonb_typeof(route->'collectionIds') <> 'array'
       or jsonb_array_length(route->'collectionIds') = 0 then
      raise exception 'Route needs at least one container';
    end if;
    select count(*), coalesce(sum((c->>'wetKg')::numeric), 0)
      into listed_count, listed_kg
      from jsonb_array_elements(new.state->'collections') c
      where c->>'id' in (select value from jsonb_array_elements_text(route->'collectionIds'));
    route_count := jsonb_array_length(route->'collectionIds');
    if listed_count <> route_count or listed_kg <= 0 then
      raise exception 'Route has missing or zero-weight containers';
    end if;
    if jsonb_typeof(route->'totalKg') = 'number'
       and abs((route->>'totalKg')::numeric - listed_kg) > 0.02 then
      raise exception 'Route weight differs from containers';
    end if;
    if exists (
      select 1 from jsonb_array_elements(new.state->'collections') c
      where c->>'id' in (select value from jsonb_array_elements_text(route->'collectionIds'))
        and (c->>'quality' <> 'good'
          or c->>'status' not in ('scheduled', 'collected')
          or (route->>'status' = 'completed' and c->>'status' <> 'collected'))
    ) then
      raise exception 'Route containers have invalid pickup status';
    end if;
  end loop;
  if exists (
    select 1
    from jsonb_array_elements(new.state->'routes') as route_row(route_data)
    cross join lateral jsonb_array_elements_text(route_row.route_data->'collectionIds') as assigned(collection_id)
    group by assigned.collection_id
    having count(*) > 1
  ) then
    raise exception 'Container is assigned to multiple routes';
  end if;
  for batch in select value from jsonb_array_elements(new.state->'batches') loop
    if exists (
      select 1 from jsonb_array_elements_text(batch->'collectionIds') as source(collection_id)
      where not exists (
        select 1 from jsonb_array_elements(new.state->'routes') route_data
        where route_data->>'status' = 'completed'
          and route_data->'collectionIds' ? source.collection_id
      )
    ) then
      raise exception 'Batch requires completed pickup routes';
    end if;
  end loop;
  return new;
end;
$$;
