-- The manager must lock a finished batch to reserve packs atomically. RLS
-- grants management read access, while batch updates belong to production.
alter function groundloop_private.gl_check_sale() security definer;
