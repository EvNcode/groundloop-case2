-- The authenticated barista may call the trigger, but not the internal sequence.
alter function groundloop_private.gl_new_request_number() security definer;
revoke all on function groundloop_private.gl_new_request_number() from public, anon;
grant execute on function groundloop_private.gl_new_request_number() to authenticated;
