create function groundloop_private.validate_open_production()
returns trigger language plpgsql set search_path = '' as $$
declare
  batch jsonb;
  dried numeric;
  accepted numeric;
  wet numeric;
  produced numeric;
  run_packs numeric;
begin
  for batch in select value from jsonb_array_elements(new.state->'batches') loop
    if jsonb_typeof(batch->'driedKg') <> 'number'
       or jsonb_typeof(batch->'acceptedKg') <> 'number' then
      raise exception 'Batch weights must be numbers';
    end if;
    wet := (batch->>'wetKg')::numeric;
    dried := (batch->>'driedKg')::numeric;
    accepted := (batch->>'acceptedKg')::numeric;
    produced := (batch->>'producedPacks')::numeric;
    if wet <= 0 or dried <= 0 or accepted <= 0
       or accepted > dried or dried > wet then
      raise exception 'Batch mass balance is invalid';
    end if;
    if abs((batch->>'dryYieldPct')::numeric - dried / wet * 100) > 0.2
       or abs((batch->>'rejectPct')::numeric - (dried - accepted) / dried * 100) > 0.2 then
      raise exception 'Batch yield differs from recorded weights';
    end if;
    if (batch->>'status' = 'complete' and produced <= 0)
       or (batch->>'status' <> 'complete' and produced <> 0) then
      raise exception 'Batch production status disagrees with output';
    end if;
    select coalesce(sum((run->>'producedPacks')::numeric), 0) into run_packs
      from jsonb_array_elements(new.state->'productionRuns') run
      where run->>'batchId' = batch->>'id';
    if run_packs <> produced then
      raise exception 'Batch output differs from production runs';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function groundloop_private.validate_open_production() from public, anon, authenticated;
create trigger groundloop_open_production
  before insert or update on public.groundloop_open_workspace
  for each row execute function groundloop_private.validate_open_production();
