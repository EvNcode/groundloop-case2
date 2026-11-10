-- Four role accounts for the hackathon walkthrough. Credentials live only in
-- Supabase Auth and are not stored in this repository.
insert into public.gl_staff(email,full_name,role,store_id,can_manage_access) values
  ('barista@groundloop.test','Бариста Абая','barista','GC-01',false),
  ('logistics@groundloop.test','Логист смены','logistics',null,false),
  ('production@groundloop.test','Оператор цеха','production',null,false),
  ('manager@groundloop.test','Руководитель смены','manager',null,false)
on conflict (email) do nothing;
