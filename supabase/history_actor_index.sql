-- Protect auth.users deletion from scanning the full revision history.
create index groundloop_workspace_history_changed_by_idx
  on public.groundloop_workspace_history(changed_by);
