-- Retire the former role-switch pilot after the email-authenticated app is live.
-- Its historical rows stay in Postgres but are no longer exposed through the API.
revoke all on public.groundloop_open_workspace from authenticated;
