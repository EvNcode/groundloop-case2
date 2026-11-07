-- Check operational and economic invariants before recording a new revision.
create function groundloop_private.validate_workspace_business_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  entry jsonb;
  param text;
  amount numeric;
  source_kg numeric;
begin
  foreach param in array array[
    'activeStores', 'cupsPerStoreDay', 'daysPerMonth', 'wetGramsPerCup',
    'dryYieldPct', 'rejectPct', 'groundsPerPackG', 'sellThroughPct',
    'pricePerPack', 'variableCostPerPack', 'monthlyLogisticsCost', 'monthlyFixedCost'
  ] loop
    if jsonb_typeof(new.state->'economicsParams'->param) <> 'number' then
      raise exception 'Economics parameter % must be numeric', param;
    end if;
    amount := (new.state->'economicsParams'->>param)::numeric;
    if amount < 0 then
      raise exception 'Economics parameter % cannot be negative', param;
    end if;
  end loop;
  if (new.state#>>'{economicsParams,activeStores}')::numeric < 1
     or (new.state#>>'{economicsParams,daysPerMonth}')::numeric not between 1 and 31
     or (new.state#>>'{economicsParams,wetGramsPerCup}')::numeric <= 0
     or (new.state#>>'{economicsParams,groundsPerPackG}')::numeric <= 0
     or (new.state#>>'{economicsParams,dryYieldPct}')::numeric > 100
     or (new.state#>>'{economicsParams,rejectPct}')::numeric > 100
     or (new.state#>>'{economicsParams,sellThroughPct}')::numeric > 100
     or (new.state#>>'{economicsParams,pricePerPack}')::numeric <= 0 then
    raise exception 'GroundLoop economics parameters are outside allowed ranges';
  end if;

  for entry in select value from jsonb_array_elements(new.state->'collections') loop
    if not exists (
      select 1 from jsonb_array_elements(new.state->'stores') store
      where store->>'id' = entry->>'storeId'
    ) then
      raise exception 'Collection references an unknown store';
    end if;
    if (entry->>'quality' = 'rejected' and entry->>'status' <> 'rejected')
       or (entry->>'status' = 'rejected' and entry->>'quality' <> 'rejected')
       or (entry->>'quality' = 'pending' and entry->>'status' not in ('ready', 'review')) then
      raise exception 'Collection quality and status disagree';
    end if;
  end loop;

  for entry in select value from jsonb_array_elements(new.state->'routes') loop
    if coalesce(entry->>'status', '') not in ('planned', 'completed')
       or jsonb_typeof(entry->'distanceKm') <> 'number'
       or jsonb_typeof(entry->'estimatedMinutes') <> 'number' then
      raise exception 'Route status or metrics are invalid';
    end if;
    if (entry->>'distanceKm')::numeric < 0 or (entry->>'estimatedMinutes')::numeric < 0 then
      raise exception 'Route metrics cannot be negative';
    end if;
  end loop;

  for entry in select value from jsonb_array_elements(new.state->'batches') loop
    if coalesce(entry->>'status', '') not in ('received', 'drying', 'production', 'complete')
       or jsonb_typeof(entry->'producedPacks') <> 'number'
       or jsonb_typeof(entry->'groundsPerPackG') <> 'number' then
      raise exception 'Batch production fields are invalid';
    end if;
    if (entry->>'producedPacks')::numeric < 0
       or mod((entry->>'producedPacks')::numeric, 1) <> 0
       or (entry->>'groundsPerPackG')::numeric <= 0
       or (entry->>'producedPacks')::numeric * (entry->>'groundsPerPackG')::numeric > (entry->>'acceptedKg')::numeric * 1000 then
      raise exception 'Batch output exceeds accepted material';
    end if;
    select coalesce(sum((collection->>'wetKg')::numeric), 0) into source_kg
    from jsonb_array_elements(new.state->'collections') collection
    where collection->>'id' in (
      select value from jsonb_array_elements_text(entry->'collectionIds')
    );
    if abs(source_kg - (entry->>'wetKg')::numeric) > 0.02 then
      raise exception 'Batch wet mass differs from its collections';
    end if;
  end loop;

  for entry in select value from jsonb_array_elements(new.state->'productionRuns') loop
    if jsonb_typeof(entry->'producedPacks') <> 'number'
       or (entry->>'producedPacks')::numeric < 0
       or mod((entry->>'producedPacks')::numeric, 1) <> 0 then
      raise exception 'Production run output must be a whole nonnegative number';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function groundloop_private.validate_workspace_business_rules() from public, anon, authenticated;
create trigger groundloop_workspace_business_rules
  before insert or update on public.groundloop_workspace
  for each row execute function groundloop_private.validate_workspace_business_rules();
