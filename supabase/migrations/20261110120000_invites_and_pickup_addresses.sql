-- A separate pickup address avoids treating a district as a navigable address.
alter table public.gl_stores add column if not exists address text;

-- Multiple baristas and drivers are independent Auth users. Access still comes
-- only from their own gl_staff row and the existing RLS policies.
insert into public.gl_staff(email,full_name,role,store_id,can_manage_access) values
  ('barista2@groundloop.test','Бариста Достык','barista','GC-02',false),
  ('logistics2@groundloop.test','Второй логист','logistics',null,false),
  ('manager2@groundloop.test','Второй руководитель','manager',null,false)
on conflict (email) do nothing;
