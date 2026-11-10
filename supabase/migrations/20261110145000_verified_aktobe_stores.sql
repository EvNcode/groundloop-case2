-- Replace the original synthetic Almaty labels with branches listed by
-- Global Coffee in Aktobe. Keep IDs and historical container references.
-- Coordinates below identify the published building/address, not a loading door.
update public.gl_stores set
  name = case id
    when 'GC-01' then 'Global Coffee — Коныс'
    when 'GC-02' then 'Global Coffee — Космос'
    when 'GC-03' then 'Global Coffee — Заречный'
    when 'GC-04' then 'Global Coffee — Жубанова'
    when 'GC-05' then 'Global Coffee — Батыс'
    when 'GC-06' then 'Global Coffee — Алия'
  end,
  district = 'Актобе',
  address = case id
    when 'GC-01' then 'Актобе, пр. Абилкайыр хана, 52Б'
    when 'GC-02' then 'Актобе, пр. Абилкайыр хана, 73А'
    when 'GC-03' then 'Актобе, жилой массив Коктем, 116А'
    when 'GC-04' then 'Актобе, ул. Братьев Жубановых, 282'
    when 'GC-05' then 'Актобе, микрорайон Алтын орда, 51В'
    when 'GC-06' then 'Актобе, пр. Алии Молдагуловой, 30А, ТЦ «Алия Center»'
  end,
  latitude = case id
    when 'GC-01' then 50.294094
    when 'GC-04' then 50.289093
    when 'GC-05' then 50.270851
    when 'GC-06' then 50.289815
    else null
  end,
  longitude = case id
    when 'GC-01' then 57.158604
    when 'GC-04' then 57.151294
    when 'GC-05' then 57.138458
    when 'GC-06' then 57.157035
    else null
  end
where id in ('GC-01','GC-02','GC-03','GC-04','GC-05','GC-06');

-- The remaining Almaty examples stay inactive and are not shown on maps.
