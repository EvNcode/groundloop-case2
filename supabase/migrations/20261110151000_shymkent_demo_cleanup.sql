-- Correct the two synthetic employee labels inherited from the original
-- Almaty mockup. These are demonstration accounts, not real employee names.
update public.gl_staff set full_name='Борис' where email='barista@groundloop.test' and full_name='Бариста Абая';
update public.gl_staff set full_name='Айдана' where email='barista2@groundloop.test' and full_name='Бариста Достык';

-- Align the synthetic container snapshots with those demonstration accounts.
-- No material state, weights or event timestamps are changed.
alter table public.gl_containers disable trigger gl_guard_container;
alter table public.gl_containers disable trigger gl_prepare_container;
alter table public.gl_containers disable trigger gl_log_container;
update public.gl_containers c set barista_name='Борис'
from auth.users u where c.created_by=u.id and u.email='barista@groundloop.test' and c.barista_name='Бариста Абая';
update public.gl_containers c set barista_name='Айдана'
from auth.users u where c.created_by=u.id and u.email='barista2@groundloop.test' and c.barista_name='Бариста Достык';
alter table public.gl_containers enable trigger gl_log_container;
alter table public.gl_containers enable trigger gl_prepare_container;
alter table public.gl_containers enable trigger gl_guard_container;

-- A delivered synthetic product order used an out-of-scope test address.
alter table public.gl_sales disable trigger gl_update_sale;
alter table public.gl_sales disable trigger gl_log_sale_transition;
update public.gl_sales set delivery_address='Шымкент, пр. Тауке хана, 62',
  latitude=42.316673, longitude=69.603079
where order_code='SO-8300641A' and delivery_address='Тестовый адрес доставки, Алматы';
alter table public.gl_sales enable trigger gl_log_sale_transition;
alter table public.gl_sales enable trigger gl_update_sale;
