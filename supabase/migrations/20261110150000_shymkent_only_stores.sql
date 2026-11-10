-- The case presentation is scoped to Shymkent. Use six map-verified branches.
-- Keep IDs so existing demo applications and staff assignments remain intact.
update public.gl_stores set
  name = case id
    when 'GC-01' then 'Global Coffee — Тауке хана'
    when 'GC-02' then 'Global Coffee — Мамытова'
    when 'GC-03' then 'Global Coffee — Гани Иляева, 23'
    when 'GC-04' then 'Global Coffee — Рыскулова'
    when 'GC-05' then 'Global Coffee — Момышулы'
    when 'GC-06' then 'Global Coffee — Дулати'
  end,
  district = 'Шымкент',
  address = case id
    when 'GC-01' then 'Шымкент, пр. Тауке хана, 62'
    when 'GC-02' then 'Шымкент, ул. Мамытова, 58/1'
    when 'GC-03' then 'Шымкент, ул. Гани Иляева, 23'
    when 'GC-04' then 'Шымкент, ул. Рыскулова, 10/2'
    when 'GC-05' then 'Шымкент, пр. Бауыржан Момышулы, 109/2'
    when 'GC-06' then 'Шымкент, ул. Мухаммед Хайдар Дулати, 202'
  end,
  latitude = case id
    when 'GC-01' then 42.316673
    when 'GC-02' then 42.318209
    when 'GC-03' then 42.322658
    when 'GC-04' then 42.340222
    when 'GC-05' then 42.340131
    when 'GC-06' then 42.345840
  end,
  longitude = case id
    when 'GC-01' then 69.603079
    when 'GC-02' then 69.579135
    when 'GC-03' then 69.591824
    when 'GC-04' then 69.632118
    when 'GC-05' then 69.575662
    when 'GC-06' then 69.613659
  end
where id in ('GC-01','GC-02','GC-03','GC-04','GC-05','GC-06');

-- These unassigned, unused Almaty examples have no operational references.
delete from public.gl_stores s
where s.id in ('GC-07','GC-08','GC-09','GC-10','GC-11','GC-12','GC-13','GC-14','GC-15','GC-16','GC-17','GC-18')
  and not exists (select 1 from public.gl_staff st where st.store_id=s.id)
  and not exists (select 1 from public.gl_containers c where c.store_id=s.id)
  and not exists (select 1 from public.gl_notifications n where n.store_id=s.id);
