import { createClient } from '@supabase/supabase-js';
import { BrowserQRCodeReader } from '@zxing/browser';
import QRCode from 'qrcode';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../dist/supabase-config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
const app = document.querySelector('#app');
const rolePage = document.body.dataset.role;
const pageNames = { barista: 'Бариста', logistics: 'Логистика', production: 'Производство', manager: 'Управление' };
const statuses = {
  ready: ['Готов к вывозу', 'good'], hold: ['Удержан на точке', 'warn'], rejected: ['Не подходит', 'bad'],
  cancelled: ['Отменён', 'neutral'], assigned: ['В рейсе', 'warn'], picked_up: ['Забран', 'good'],
  received: ['Принят в цех', 'good'], batched: ['В партии', 'neutral'],
  drying: ['Сушка', 'warn'], production: ['Формование', 'warn'], complete: ['Готово', 'good'],
};
let user = null;
let staff = null;
let records = { stores: [], staff: [], trips: [], containers: [], batches: [], sales: [], positions: [], events: [] };
let activeTab = 'overview';
let refreshing = false;
let queuedRefresh = false;
let busy = false;
let channel = null;
let watchId = null;
let lastPositionAt = 0;
let toastTimer;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = n => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(n) || 0)} ₸`;
const number = (n, digits = 1) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(Number(n) || 0);
const dateTime = value => value ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Qyzylorda' }).format(new Date(value)) : '—';
const storeName = id => records.stores.find(s => s.id === id)?.name || id;
const byNewest = (a, b) => new Date(b.created_at) - new Date(a.created_at);
const badge = status => `<span class="badge ${statuses[status]?.[1] || 'neutral'}">${esc(statuses[status]?.[0] || status)}</span>`;
const empty = (title, text) => `<div class="card-empty"><strong>${esc(title)}</strong><span>${esc(text)}</span></div>`;
const button = (label, action, extra = '', kind = '') => `<button class="btn ${kind}" type="button" data-action="${action}" ${extra}>${esc(label)}</button>`;
const stat = (label, value, hint = '') => `<article class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</article>`;
const link = path => new URL(path, location.href).href;

function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4300);
}
function brand() { return `<a class="brand" href="./index.html"><span class="mark"></span>GroundLoop</a>`; }
function shell(title, subtitle, actions, body) {
  app.innerHTML = `<div class="shell"><header class="top">${brand()}<div class="top-right"><div class="top-user"><strong>${esc(staff.full_name)}</strong><small>${esc(user.email)}</small></div><button data-action="logout">Выйти</button></div></header><main class="container"><section class="hero"><div><div class="eyebrow">${esc(pageNames[staff.role])}${staff.store_id ? ` / ${esc(storeName(staff.store_id))}` : ''}</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div><div class="hero-actions">${actions || ''}</div></section>${body}</main></div>`;
}
function authScreen(title, description, content) {
  app.innerHTML = `<div class="auth-wrap"><div class="auth-card">${brand()}<h1>${esc(title)}</h1><p>${esc(description)}</p>${content}</div></div>`;
}
function loginScreen(mode = 'password') {
  if (mode === 'link') {
    authScreen('Вход по ссылке', 'Ссылка придёт на подтверждённую почту сотрудника.',
      `<form id="linkForm" class="form"><label class="field">Почта<input type="email" name="email" autocomplete="email" required placeholder="name@company.kz"></label><button class="btn btn-primary" type="submit">Получить ссылку</button><button class="btn-link" type="button" data-action="password-login">Войти с паролем</button></form>`);
    return;
  }
  authScreen('Вход в рабочее место', 'Введите почту и пароль сотрудника.',
    `<form id="loginForm" class="form"><label class="field">Почта<input type="email" name="email" autocomplete="username" required placeholder="name@company.kz"></label><label class="field">Пароль<input type="password" name="password" autocomplete="current-password" required></label><button class="btn btn-primary" type="submit">Войти</button><button class="btn-link" type="button" data-action="link-login">Войти по ссылке</button></form>`);
}
function modal(title, html) {
  closeModal();
  const dialog = document.createElement('dialog');
  dialog.id = 'activeDialog';
  dialog.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-close" type="button" data-action="close-modal" aria-label="Закрыть">×</button></div><div class="modal-body">${html}</div>`;
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  return dialog;
}
function closeModal() {
  const dialog = document.querySelector('#activeDialog');
  if (dialog) { dialog.close(); dialog.remove(); }
}
async function run(task, success) {
  if (busy) return;
  busy = true;
  try {
    await task();
    closeModal();
    await refresh();
    if (success) toast(success);
  } catch (error) {
    console.error(error);
    toast(error.message || 'Операция не выполнена');
  } finally { busy = false; }
}
function checked(result) { if (result.error) throw result.error; return result.data; }
async function refresh() {
  if (refreshing) { queuedRefresh = true; return; }
  refreshing = true;
  try {
    const currentStaff = checked(await supabase.from('gl_staff').select('*').eq('email', user.email.toLowerCase()).maybeSingle());
    if (!currentStaff?.active) {
      staff = null;
      authScreen('Доступ отключён', 'Руководитель может восстановить доступ к рабочему месту.', '<button class="btn" data-action="logout">Выйти</button>');
      return;
    }
    if (!staff || currentStaff.role !== staff.role) { location.replace(link(`${currentStaff.role}.html`)); return; }
    staff = currentStaff;
    const queries = [
      ['stores', 'gl_stores', 'id,name,district,active'],
      ['trips', 'gl_trips', '*'], ['containers', 'gl_containers', '*'],
      ['batches', 'gl_batches', '*'], ['sales', 'gl_sales', '*'],
      ['positions', 'gl_driver_positions', '*'], ['events', 'gl_events', '*'],
    ];
    if (staff.role === 'manager') queries.push(['staff', 'gl_staff', '*']);
    const results = await Promise.all(queries.map(async ([key, table, columns]) => [key, checked(await supabase.from(table).select(columns).limit(1000))]));
    for (const [key, value] of results) records[key] = value;
    render();
  } catch (error) { console.error(error); toast(`Не удалось обновить данные: ${error.message}`); }
  finally { refreshing = false; if (queuedRefresh) { queuedRefresh = false; void refresh(); } }
}
function subscribe() {
  channel = supabase.channel('groundloop-operations')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'gl_containers' }, () => void refresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'gl_trips' }, () => void refresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'gl_batches' }, () => void refresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'gl_sales' }, () => void refresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'gl_driver_positions' }, () => void refresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'gl_staff' }, () => void refresh())
    .subscribe();
  setInterval(() => { if (!document.hidden) void refresh(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
}
async function boot() {
  app.innerHTML = '<div class="loading"><div class="spinner" aria-label="Загрузка"></div></div>';
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) return authScreen('Нет подключения', 'Конфигурация Supabase не задана.', '');
  const session = checked(await supabase.auth.getSession())?.session;
  if (!session) return loginScreen();
  user = session.user;
  const email = user.email?.toLowerCase();
  if (!email) return loginScreen();
  staff = checked(await supabase.from('gl_staff').select('*').eq('email', email).maybeSingle());
  if (!staff || !staff.active) return authScreen('Доступ не назначен', `Учётная запись ${email} подтверждена. Руководитель должен добавить её в команду.`, '<button class="btn" data-action="logout">Выйти</button>');
  if (rolePage !== staff.role) { location.replace(link(`${staff.role}.html`)); return; }
  await refresh();
  subscribe();
}

async function qrDialog(item) {
  const image = await QRCode.toDataURL(item.code, { width: 320, margin: 1, color: { dark: '#17271d', light: '#ffffff' } });
  modal('Код контейнера', `<img class="qr-image" src="${image}" alt="QR-код ${esc(item.code)}"><div class="qr-code">${esc(item.code)}</div><p class="muted" style="text-align:center">Покажите код логисту при передаче контейнера. Он проверит его сканированием.</p><div class="form-actions"><button class="btn" data-action="print-code">Печать</button><button class="btn btn-primary" data-action="close-modal">Закрыть</button></div>`);
}
async function scanDialog(item, kind) {
  const isPickup = kind === 'pickup';
  const dialog = modal(isPickup ? 'Подтвердить вывоз' : 'Принять в цех',
    `<div class="notice">Ожидается контейнер <strong class="mono">${esc(item.code)}</strong> · ${esc(storeName(item.store_id))} · ${number(item.wet_kg)} кг</div><video class="scan-video" id="scanVideo" autoplay muted playsinline></video><p class="scan-hint" id="scanHint">Наведите камеру на QR-код. Если камеры нет, введите код с этикетки.</p><form id="scanForm" class="form"><label class="field">Код на контейнере<input name="code" class="scan-input mono" autocomplete="off" autocapitalize="characters" required placeholder="GC-XXXXXXXXXX"></label><div class="form-actions"><button class="btn" type="button" data-action="close-modal">Отмена</button><button class="btn btn-primary" type="submit">Подтвердить</button></div></form>`);
  let controls;
  dialog.addEventListener('close', () => controls?.stop(), { once: true });
  const form = dialog.querySelector('#scanForm');
  form.addEventListener('submit', event => { event.preventDefault(); void completeScan(item, kind, form.elements.code.value); });
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Камера недоступна');
    const reader = new BrowserQRCodeReader();
    controls = await reader.decodeFromVideoDevice(undefined, dialog.querySelector('#scanVideo'), (result) => {
      if (!result) return;
      const code = result.getText().trim().toUpperCase();
      form.elements.code.value = code;
      if (code === item.code) { controls?.stop(); void completeScan(item, kind, code); }
      else dialog.querySelector('#scanHint').textContent = `Считан ${code}. Это другой контейнер.`;
    });
  } catch { dialog.querySelector('#scanHint').textContent = 'Камера недоступна. Введите код с этикетки вручную.'; }
}
async function completeScan(item, kind, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (code !== item.code) return toast('Код не совпадает с выбранным контейнером');
  await run(async () => {
    const change = kind === 'pickup'
      ? { status: 'picked_up', pickup_code: code }
      : { status: 'received', receipt_code: code };
    checked(await supabase.from('gl_containers').update(change).eq('id', item.id).eq('status', kind === 'pickup' ? 'assigned' : 'picked_up').select().single());
  }, kind === 'pickup' ? 'Вывоз подтверждён' : 'Контейнер принят в цех');
}

function containerItem(item, role) {
  const owner = `${esc(item.barista_name)} · ${esc(storeName(item.store_id))}`;
  const note = item.note ? `<div class="item-note">${esc(item.note)}</div>` : '';
  let actions = '';
  if (role === 'barista') {
    actions = `${button('Показать QR', 'qr', `data-id="${item.id}"`, 'btn-sm')}`;
    if (item.created_by === user.id && ['ready','hold','rejected'].includes(item.status)) {
      actions += `${button('Исправить', 'edit-container', `data-id="${item.id}"`, 'btn-sm')}${button('Отменить запись', 'cancel-container', `data-id="${item.id}"`, 'btn-sm btn-danger')}`;
    } else if (item.created_by === user.id && item.status === 'assigned') {
      actions += button('Отменить до вывоза', 'cancel-container', `data-id="${item.id}"`, 'btn-sm btn-danger');
    }
  }
  if (role === 'logistics') {
    const trip = myTrip();
    if (item.status === 'ready' && trip) actions = button('Добавить в рейс', 'assign', `data-id="${item.id}"`, 'btn-sm btn-primary');
    if (item.status === 'assigned' && item.trip_id === trip?.id) actions = `${button('Сканировать и забрать', 'pickup', `data-id="${item.id}"`, 'btn-sm btn-primary')}${button('Убрать из рейса', 'unassign', `data-id="${item.id}"`, 'btn-sm')}`;
    if (item.status === 'picked_up' && item.trip_id === trip?.id) actions = button('Отменить вывоз', 'undo-pickup', `data-id="${item.id}"`, 'btn-sm btn-danger');
  }
  if (role === 'production') {
    if (item.status === 'picked_up') actions = button('Сканировать приёмку', 'receive', `data-id="${item.id}"`, 'btn-sm btn-primary');
    if (item.status === 'received') actions = button('Отменить приёмку', 'undo-receive', `data-id="${item.id}"`, 'btn-sm btn-danger');
  }
  return `<article class="item"><div class="item-top"><div><div class="item-title mono">${esc(item.code)}</div><div class="item-sub">${owner}</div></div>${badge(item.status)}</div><div class="item-meta"><span><strong>${number(item.wet_kg)} кг</strong></span><span>${item.cups ? `${number(item.cups,0)} напитков` : 'Вес измерен'}</span><span>${dateTime(item.created_at)}</span></div>${note}${actions ? `<div class="item-actions">${actions}</div>` : ''}</article>`;
}

function renderBarista() {
  const own = records.containers.filter(x => x.store_id === staff.store_id).sort(byNewest);
  const ready = own.filter(x => x.status === 'ready');
  const active = own.filter(x => !['cancelled','rejected'].includes(x.status));
  const body = `<section class="stats">${stat('Готово к вывозу', ready.length, `${number(ready.reduce((s,x)=>s+Number(x.wet_kg),0))} кг`)}${stat('В пути', own.filter(x => ['assigned','picked_up'].includes(x.status)).length)}${stat('Принято в цех', own.filter(x => ['received','batched'].includes(x.status)).length)}${stat('Записей точки', active.length)}</section>
    <div class="grid"><section class="card"><div class="card-head"><div><h2>Контейнеры точки</h2><p>Последние записи и передача в логистику</p></div></div>${own.length ? own.map(x=>containerItem(x,'barista')).join('') : empty('Записей пока нет','Создайте запись после взвешивания контейнера.')}</section>
    <aside class="stack"><section class="card"><div class="card-head"><h2>Проверка жмыха</h2></div><div class="card-body step-list"><div class="step"><span class="step-num">01</span><div><strong>Взвесьте контейнер</strong><small>Укажите фактический вес и число напитков</small></div></div><div class="step"><span class="step-num">02</span><div><strong>Оцените качество</strong><small>Чистый жмых готов к вывозу; сомнительный удержите на точке</small></div></div><div class="step"><span class="step-num">03</span><div><strong>Покажите код</strong><small>Логист сверит QR на контейнере при получении</small></div></div></div></section><div class="notice">Ошибочную запись можно исправить или отменить до передачи. Отмена остаётся в истории операций.</div></aside></div>`;
  shell('Сбор на точке', 'Зафиксируйте вес и качество. Логист увидит готовый контейнер сразу после сохранения.', button('Новый контейнер','new-container','','btn-primary'), body);
}

function openContainerForm(item = null) {
  const quality = item?.quality || 'good';
  const dialog = modal(item ? 'Исправить запись' : 'Новый контейнер', `<form id="containerForm" class="form two">
    <label class="field">Вес жмыха, кг<input name="wet_kg" type="number" inputmode="decimal" min="0.01" step="0.01" required value="${esc(item?.wet_kg || '')}"></label>
    <label class="field">Напитков за смену<input name="cups" type="number" inputmode="numeric" min="0" step="1" value="${esc(item?.cups ?? 0)}"></label>
    <label class="field wide">Качество<select name="quality"><option value="good" ${quality==='good'?'selected':''}>Чистое, готово к вывозу</option><option value="hold" ${quality==='hold'?'selected':''}>Удержать, нужна повторная проверка</option><option value="rejected" ${quality==='rejected'?'selected':''}>Не подходит для переработки</option></select></label>
    <label class="field wide">Комментарий для логиста и производства<textarea name="note" maxlength="600" placeholder="Например: влажный жмых, запах, примеси, контейнер заменён">${esc(item?.note || '')}</textarea></label>
    <label class="checkrow wide"><input type="checkbox" name="checked" required><span>Я проверил контейнер и указал его фактическое состояние</span></label>
    <div class="form-actions wide"><button class="btn" type="button" data-action="close-modal">Отмена</button><button class="btn btn-primary" type="submit">${item?'Сохранить исправление':'Создать запись'}</button></div></form>`);
  dialog.querySelector('#containerForm').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const wet = Number(form.elements.wet_kg.value);
    const cups = Number(form.elements.cups.value);
    const qualityValue = form.elements.quality.value;
    if (!Number.isFinite(wet) || wet <= 0 || !Number.isInteger(cups) || cups < 0) return toast('Проверьте вес и число напитков');
    const payload = { wet_kg: wet, cups, quality: qualityValue, note: form.elements.note.value.trim() };
    if (item) payload.status = { good:'ready', hold:'hold', rejected:'rejected' }[qualityValue];
    void run(async () => {
      if (item) checked(await supabase.from('gl_containers').update(payload).eq('id', item.id).eq('version', item.version).select().single());
      else checked(await supabase.from('gl_containers').insert(payload).select().single());
    }, item ? 'Запись исправлена' : 'Контейнер добавлен');
  });
}
function cancelContainer(item) {
  const dialog = modal('Отменить запись', `<p class="muted" style="margin-bottom:18px">${esc(item.code)} будет исключён из вывоза. История сохранится.</p><form id="cancelForm" class="form"><label class="field">Причина отмены<textarea name="reason" required maxlength="300" placeholder="Например: неверный вес или контейнер повреждён"></textarea></label><div class="form-actions"><button class="btn" type="button" data-action="close-modal">Назад</button><button class="btn btn-danger" type="submit">Отменить запись</button></div></form>`);
  dialog.querySelector('#cancelForm').addEventListener('submit', event => {
    event.preventDefault();
    const reason = event.currentTarget.elements.reason.value.trim();
    if (!reason) return;
    void run(async () => checked(await supabase.from('gl_containers').update({ status:'cancelled', note: `${item.note ? item.note+'\n' : ''}Отмена: ${reason}`, trip_id:null }).eq('id',item.id).eq('version',item.version).select().single()), 'Запись отменена');
  });
}

function myTrip() { return records.trips.find(t => t.driver_id === user.id && t.status === 'active'); }
function positionFor(tripId) { return records.positions.find(x => x.trip_id === tripId); }
function mapFor(position) {
  if (!position) return '';
  const lat = Number(position.latitude), lon = Number(position.longitude);
  const bbox = [lon-.007,lat-.005,lon+.007,lat+.005].join('%2C');
  return `<iframe class="map" title="Положение логиста" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lon}"></iframe>`;
}
function locationCard(trip, manager = false) {
  const pos = positionFor(trip?.id);
  const fresh = pos && Date.now() - Date.parse(pos.updated_at) < 120000;
  return `<section class="card"><div class="card-head"><div><h2>Положение логиста</h2><p>${trip ? `${esc(trip.driver_name)} · ${esc(trip.code)}` : 'Нет активного рейса'}</p></div></div><div class="card-body location">${pos ? `<div class="coords">${number(pos.latitude,5)}, ${number(pos.longitude,5)}</div><small>${fresh?'GPS активен':'Последняя известная точка'} · точность ${number(pos.accuracy_m,0)} м · ${dateTime(pos.updated_at)}</small>${mapFor(pos)}` : `<p class="muted">${manager?'Логист ещё не включил GPS.':'Включите GPS на телефоне, чтобы команда видела положение рейса.'}</p>`}${!manager && trip ? `<div class="toolbar">${button(watchId===null?'Включить GPS':'Остановить GPS',watchId===null?'start-gps':'stop-gps','','btn-sm')}</div>` : ''}</div></section>`;
}
function renderLogistics() {
  const trip = myTrip();
  const ready = records.containers.filter(x => x.status === 'ready').sort(byNewest);
  const mine = trip ? records.containers.filter(x => x.trip_id === trip.id).sort(byNewest) : [];
  const inTransit = mine.filter(x => ['assigned','picked_up'].includes(x.status));
  const body = `<section class="stats">${stat('Готовы к вывозу',ready.length,`${number(ready.reduce((s,x)=>s+Number(x.wet_kg),0))} кг`)}${stat('В моём рейсе',mine.length)}${stat('Уже забрано',mine.filter(x=>['picked_up','received','batched'].includes(x.status)).length)}${stat('Рейс',trip?trip.code:'Не начат')}</section><div class="grid"><div class="stack"><section class="card"><div class="card-head"><div><h2>Мой рейс</h2><p>${trip?'Покажите ожидаемый код бариста и сканируйте этикетку при получении.':'Начните рейс, затем добавьте готовые контейнеры.'}</p></div>${trip && !inTransit.length ? button('Завершить рейс','finish-trip','','btn-sm') : ''}</div>${trip ? (mine.length?mine.map(x=>containerItem(x,'logistics')).join(''):empty('Рейс пуст','Добавьте контейнеры из очереди ниже.')):empty('Нет активного рейса','Создайте рейс, чтобы принять заказы.')}</section><section class="card"><div class="card-head"><div><h2>Готовы на точках</h2><p>Бариста уже проверил качество</p></div></div>${ready.length?ready.map(x=>containerItem(x,'logistics')).join(''):empty('Очередь пуста','Новые контейнеры появятся здесь сразу после записи.')}</section></div><aside class="stack">${locationCard(trip)}<div class="notice">Передача считается выполненной после сверки кода на контейнере. Ошибочный вывоз можно отменить до приёмки в цехе.</div></aside></div>`;
  shell('Вывоз с точек', 'Найдите готовый контейнер, добавьте его в рейс и подтвердите получение сканированием.', !trip ? button('Начать рейс','start-trip','','btn-primary') : '', body);
}

async function startGps() {
  const trip = myTrip();
  if (!trip || !navigator.geolocation) return toast('GPS недоступен на этом устройстве');
  if (watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(async position => {
    if (Date.now() - lastPositionAt < 10000) return;
    lastPositionAt = Date.now();
    const result = await supabase.from('gl_driver_positions').upsert({
      trip_id: trip.id, driver_id: user.id, latitude: position.coords.latitude,
      longitude: position.coords.longitude, accuracy_m: position.coords.accuracy,
    }, { onConflict: 'trip_id' });
    if (result.error) toast(`GPS не сохранён: ${result.error.message}`);
  }, error => toast(`GPS: ${error.message}`), { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  render(); toast('Передача GPS включена');
}
function stopGps() { if (watchId !== null) navigator.geolocation.clearWatch(watchId); watchId = null; render(); toast('Передача GPS остановлена'); }

function batchItem(batch) {
  const sold = records.sales.filter(x => x.batch_id === batch.id).reduce((s,x)=>s+x.packs,0);
  const available = batch.produced_packs - sold;
  let actions = '';
  if (batch.created_by === user.id && staff.role === 'production') {
    if (batch.status === 'received') actions = button('Начать сушку','start-drying',`data-id="${batch.id}"`,'btn-sm btn-primary');
    if (batch.status === 'drying') actions = button('Подтвердить сухой вес','dry-weight',`data-id="${batch.id}"`,'btn-sm btn-primary');
    if (batch.status === 'production') actions = button('Зафиксировать выпуск','pack-output',`data-id="${batch.id}"`,'btn-sm btn-primary');
  }
  return `<article class="item"><div class="item-top"><div><div class="item-title mono">${esc(batch.code)}</div><div class="item-sub">${esc(batch.operator_name)} · ${dateTime(batch.created_at)}</div></div>${badge(batch.status)}</div><div class="item-meta"><span>${number(batch.wet_kg)} кг принято</span><span>${batch.container_ids.length} контейнеров</span>${batch.accepted_kg!=null?`<span>${number(batch.accepted_kg)} кг после контроля</span>`:''}</div>${batch.status==='complete'?`<div class="split-values"><div><span>Произведено</span><strong>${batch.produced_packs} уп.</strong></div><div><span>Остаток</span><strong>${available} уп.</strong></div></div>`:''}${actions?`<div class="item-actions">${actions}</div>`:''}</article>`;
}
function renderProduction() {
  const incoming = records.containers.filter(x => x.status === 'picked_up').sort(byNewest);
  const received = records.containers.filter(x => x.status === 'received').sort(byNewest);
  const batches = [...records.batches].sort(byNewest);
  const body = `<section class="stats">${stat('Ожидают приёмки',incoming.length)}${stat('Принято без партии',received.length,`${number(received.reduce((s,x)=>s+Number(x.wet_kg),0))} кг`)}${stat('Партий в работе',batches.filter(x=>x.status!=='complete').length)}${stat('Готово упаковок',batches.reduce((s,x)=>s+x.produced_packs,0))}</section><div class="grid"><div class="stack"><section class="card"><div class="card-head"><div><h2>Приёмка</h2><p>Сверьте QR на контейнере с записью логиста</p></div></div>${incoming.length?incoming.map(x=>containerItem(x,'production')).join(''):empty('Ожидающих контейнеров нет','Они появятся после подтверждения вывоза логистом.')}</section><section class="card"><div class="card-head"><div><h2>Принято без партии</h2><p>Контейнеры можно объединить в производственную партию</p></div>${received.length?button('Создать партию','new-batch','','btn-sm btn-primary'):''}</div>${received.length?received.map(x=>containerItem(x,'production')).join(''):empty('Все принятые контейнеры распределены','Новая партия создаётся только из прошедших приёмку.')}</section><section class="card"><div class="card-head"><h2>Партии</h2></div>${batches.length?batches.map(batchItem).join(''):empty('Партий пока нет','Создайте партию из принятых контейнеров.')}</section></div><aside class="stack"><div class="notice">Сканирование подтверждает, что в цех приехал именно тот контейнер, который логист забрал на точке.</div><section class="card"><div class="card-head"><h2>Этапы партии</h2></div><div class="card-body step-list"><div class="step"><span class="step-num">01</span><div><strong>Приёмка</strong><small>Скан кода и фактический мокрый вес</small></div></div><div class="step"><span class="step-num">02</span><div><strong>Сушка и контроль</strong><small>Ввод сухого и пригодного веса</small></div></div><div class="step"><span class="step-num">03</span><div><strong>Выпуск</strong><small>Фактическое число упаковок</small></div></div></div></section></aside></div>`;
  shell('Производство', 'Примите контейнер по коду, затем фиксируйте фактический выход партии.', '', body);
}
function newBatchDialog() {
  const received = records.containers.filter(x=>x.status==='received').sort(byNewest);
  if (!received.length) return toast('Нет контейнеров для партии');
  const dialog = modal('Создать партию', `<form id="batchForm" class="form"><p class="muted">Выберите контейнеры, которые физически переданы в производство.</p>${received.map(x=>`<label class="checkrow"><input type="checkbox" name="container" value="${x.id}" checked><span><strong class="mono">${esc(x.code)}</strong> · ${esc(storeName(x.store_id))} · ${number(x.wet_kg)} кг</span></label>`).join('')}<div class="form-actions"><button class="btn" type="button" data-action="close-modal">Отмена</button><button class="btn btn-primary" type="submit">Сформировать партию</button></div></form>`);
  dialog.querySelector('#batchForm').addEventListener('submit', event=>{
    event.preventDefault();
    const ids = [...event.currentTarget.querySelectorAll('input[name=container]:checked')].map(x=>x.value);
    if (!ids.length) return toast('Выберите хотя бы один контейнер');
    void run(async()=>checked(await supabase.from('gl_batches').insert({ container_ids:ids }).select().single()),'Партия создана');
  });
}
function stageDialog(batch, stage) {
  if (stage === 'dry-weight') {
    const dialog = modal('Сухой вес и контроль', `<form id="stageForm" class="form two"><div class="notice wide" style="grid-column:1/-1">Мокрый вес партии: ${number(batch.wet_kg)} кг. Укажите реальные результаты обработки.</div><label class="field">После сушки, кг<input name="dried" type="number" min="0.01" max="${batch.wet_kg}" step="0.01" required inputmode="decimal"></label><label class="field">Принято после контроля, кг<input name="accepted" type="number" min="0.01" step="0.01" required inputmode="decimal"></label><div class="form-actions wide"><button class="btn" type="button" data-action="close-modal">Отмена</button><button class="btn btn-primary" type="submit">Подтвердить вес</button></div></form>`);
    dialog.querySelector('#stageForm').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;const dried=Number(f.elements.dried.value),accepted=Number(f.elements.accepted.value);if(!(accepted>0&&accepted<=dried&&dried<=batch.wet_kg))return toast('Принятый вес не может превышать сухой и мокрый');void run(async()=>checked(await supabase.from('gl_batches').update({status:'production',dried_kg:dried,accepted_kg:accepted}).eq('id',batch.id).eq('status','drying').select().single()),'Сухой вес сохранён');});
  } else {
    const max = Math.floor(Number(batch.accepted_kg) / .16);
    const dialog = modal('Выпуск продукции', `<form id="stageForm" class="form"><div class="notice">После контроля принято ${number(batch.accepted_kg)} кг. Максимум при 160 г жмыха на упаковку: ${max} уп.</div><label class="field">Произведено упаковок<input name="packs" type="number" min="1" max="${max}" step="1" inputmode="numeric" required></label><div class="form-actions"><button class="btn" type="button" data-action="close-modal">Отмена</button><button class="btn btn-primary" type="submit">Зафиксировать выпуск</button></div></form>`);
    dialog.querySelector('#stageForm').addEventListener('submit',event=>{event.preventDefault();const packs=Number(event.currentTarget.elements.packs.value);if(!Number.isInteger(packs)||packs<1||packs>max)return toast('Проверьте число упаковок');void run(async()=>checked(await supabase.from('gl_batches').update({status:'complete',produced_packs:packs}).eq('id',batch.id).eq('status','production').select().single()),'Выпуск сохранён');});
  }
}

function managerTabs() {
  const items = staff.can_manage_access
    ? [['overview','Сводка'],['staff','Команда'],['stores','Точки'],['sales','Продажи']]
    : [['overview','Сводка'],['sales','Продажи']];
  return `<nav class="tabs" aria-label="Разделы управления">${items.map(([id,label])=>`<button class="tab ${activeTab===id?'active':''}" data-action="tab" data-id="${id}">${label}</button>`).join('')}</nav>`;
}
function renderManagement() {
  if (!staff.can_manage_access && ['staff','stores'].includes(activeTab)) activeTab = 'overview';
  const activeContainers=records.containers.filter(x=>!['cancelled','rejected'].includes(x.status));
  const produced=records.batches.reduce((s,x)=>s+x.produced_packs,0);
  const sold=records.sales.reduce((s,x)=>s+x.packs,0);
  const revenue=records.sales.reduce((s,x)=>s+x.packs*Number(x.unit_price),0);
  let body = managerTabs();
  if (activeTab==='overview') {
    const liveTrip=records.trips.filter(x=>x.status==='active');
    body += `<section class="stats">${stat('Контейнеров',activeContainers.length,`${number(activeContainers.reduce((s,x)=>s+Number(x.wet_kg),0))} кг`)}${stat('В пути',records.containers.filter(x=>['assigned','picked_up'].includes(x.status)).length)}${stat('Выпущено',`${produced} уп.`)}${stat('Выручка',money(revenue),`${sold} уп. продано`)}</section><div class="grid"><div class="stack"><section class="card"><div class="card-head"><div><h2>Поток материала</h2><p>По фактическим операциям команды</p></div></div><div class="card-body split-values"><div><span>Готово на точках</span><strong>${records.containers.filter(x=>x.status==='ready').length}</strong></div><div><span>У логиста</span><strong>${records.containers.filter(x=>['assigned','picked_up'].includes(x.status)).length}</strong></div><div><span>Принято в цех</span><strong>${records.containers.filter(x=>['received','batched'].includes(x.status)).length}</strong></div><div><span>Остаток упаковок</span><strong>${produced-sold}</strong></div></div></section><section class="card"><div class="card-head"><h2>Последние действия</h2></div>${[...records.events].sort(byNewest).slice(0,18).map(e=>`<div class="item"><div class="item-top"><div><div class="item-title">${esc(eventLabel(e.action,e.entity))}</div><div class="item-sub">${esc(e.actor_email||'Система')} · ${dateTime(e.created_at)}</div></div><span class="mono muted">${esc(e.details?.code||records.containers.find(x=>x.id===e.entity_id)?.code||records.trips.find(x=>x.id===e.entity_id)?.code||records.batches.find(x=>x.id===e.entity_id)?.code||'')}</span></div></div>`).join('')||empty('История пуста','Действия сотрудников появятся здесь.')}</section></div><aside class="stack">${liveTrip.length?liveTrip.map(x=>locationCard(x,true)).join(''):locationCard(null,true)}<div class="notice">Экономика здесь основана на зарегистрированных продажах. Расходы и прибыль появятся после ввода фактических затрат.</div></aside></div>`;
  } else if (activeTab==='staff') {
    body += `<div class="grid"><section class="card"><div class="card-head"><div><h2>Сотрудники</h2><p>Роль и точка определяют доступные действия</p></div></div>${[...records.staff].sort((a,b)=>a.full_name.localeCompare(b.full_name,'ru')).map(s=>`<div class="item"><div class="item-top"><div><div class="item-title">${esc(s.full_name)}</div><div class="item-sub">${esc(s.email)} · ${esc(pageNames[s.role])}${s.store_id?` · ${esc(storeName(s.store_id))}`:''}</div></div>${s.active?'<span class="badge">Активен</span>':'<span class="badge neutral">Отключён</span>'}</div><div class="item-actions">${button('Изменить','edit-staff',`data-id="${esc(s.email)}"`,'btn-sm')}</div></div>`).join('')||empty('Команда пуста','Добавьте сотрудников.')}</section><aside class="stack"><section class="card"><div class="card-head"><h2>Назначить доступ</h2></div><div class="card-body"><form id="staffForm" class="form"><label class="field">Рабочая почта<input name="email" type="email" required autocomplete="off"></label><label class="field">Имя и фамилия<input name="full_name" required minlength="2" maxlength="100"></label><label class="field">Роль<select name="role"><option value="barista">Бариста</option><option value="logistics">Логистика</option><option value="production">Производство</option><option value="manager">Управление</option></select></label><label class="field">Точка<select name="store_id"><option value="">Без точки</option>${records.stores.filter(x=>x.active).map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label><button class="btn btn-primary" type="submit">Добавить сотрудника</button></form></div></section><div class="notice">Сотрудник открывает сайт по ссылке из письма. Доступ включится только после подтверждения этой почты.</div></aside></div>`;
  } else if (activeTab==='stores') {
    body += `<div class="grid"><section class="card"><div class="card-head"><div><h2>Точки сбора</h2><p>Адреса и доступность для назначения бариста</p></div></div>${[...records.stores].sort((a,b)=>a.name.localeCompare(b.name,'ru')).map(s=>`<div class="item"><div class="item-top"><div><div class="item-title">${esc(s.name)}</div><div class="item-sub">${esc(s.district||'Адрес не указан')}</div></div>${s.active?'<span class="badge">Активна</span>':'<span class="badge neutral">Отключена</span>'}</div><div class="item-actions">${button('Изменить','edit-store',`data-id="${esc(s.id)}"`,'btn-sm')}</div></div>`).join('')||empty('Точек пока нет','Добавьте первую точку.')}</section><aside class="stack"><section class="card"><div class="card-head"><h2>Добавить точку</h2></div><div class="card-body"><form id="storeForm" class="form"><label class="field">Название точки<input name="name" required maxlength="120" placeholder="Global Coffee — название"></label><label class="field">Адрес или район<input name="district" maxlength="160" placeholder="Город, улица, дом"></label><button class="btn btn-primary" type="submit">Добавить точку</button></form></div></section></aside></div>`;
  } else {
    const available=records.batches.filter(b=>b.status==='complete'&&b.produced_packs-records.sales.filter(s=>s.batch_id===b.id).reduce((sum,s)=>sum+s.packs,0)>0);
    body += `<section class="stats">${stat('Произведено',`${produced} уп.`)}${stat('Продано',`${sold} уп.`)}${stat('Остаток',`${produced-sold} уп.`)}${stat('Выручка',money(revenue))}</section><div class="grid"><section class="card"><div class="card-head"><div><h2>Операции продаж</h2><p>Партия, количество и выручка</p></div></div>${[...records.sales].sort(byNewest).map(s=>`<div class="item"><div class="item-top"><div><div class="item-title mono">${esc(records.batches.find(b=>b.id===s.batch_id)?.code||s.batch_id)}</div><div class="item-sub">${esc(s.channel)} · ${dateTime(s.created_at)}</div></div><strong>${money(s.packs*Number(s.unit_price))}</strong></div><div class="item-meta"><span>${s.packs} уп.</span><span>${money(s.unit_price)} за упаковку</span></div></div>`).join('')||empty('Продаж ещё нет','Зафиксируйте первую выдачу готового продукта.')}</section><aside class="stack"><section class="card"><div class="card-head"><h2>Новая продажа</h2></div><div class="card-body"><form id="saleForm" class="form"><label class="field">Партия<select name="batch_id" required>${available.map(b=>`<option value="${b.id}">${esc(b.code)} · ${b.produced_packs-records.sales.filter(s=>s.batch_id===b.id).reduce((sum,s)=>sum+s.packs,0)} уп.</option>`).join('')}</select></label><label class="field">Упаковок<input name="packs" type="number" min="1" step="1" inputmode="numeric" required></label><label class="field">Цена за упаковку, ₸<input name="unit_price" type="number" min="0" step="1" inputmode="numeric" required></label><label class="field">Канал<select name="channel"><option>Кофейня</option><option>Партнёрская точка</option><option>Прямой заказ</option></select></label><button class="btn btn-primary" type="submit" ${available.length?'':'disabled'}>Зафиксировать продажу</button></form></div></section></aside></div>`;
  }
  shell('Управление', 'Сотрудники выполняют свои операции, здесь виден их результат и доступ команды.', '', body);
}
function eventLabel(action, entity) { const subject=({gl_containers:'Контейнер',gl_trips:'Рейс',gl_batches:'Партия',gl_sales:'Продажа'})[entity]||'Операция'; return `${subject}: ${({created:'создано',updated:'исправлено',ready:'готово к вывозу',hold:'удержано',rejected:'отклонено',cancelled:'отменено',assigned:'добавлено в рейс',picked_up:'вывоз подтверждён',received:'принято в цех',batched:'включено в партию',drying:'сушка начата',production:'вес подтверждён',complete:'выпуск завершён'})[action]||action}`; }
function render() { if (!staff) return; if (staff.role==='barista') renderBarista(); else if (staff.role==='logistics') renderLogistics(); else if (staff.role==='production') renderProduction(); else renderManagement(); }

function staffEditDialog(member) {
  const dialog=modal('Изменить доступ',`<form id="editStaffForm" class="form"><div class="notice">${esc(member.email)}</div><label class="field">Имя и фамилия<input name="full_name" required minlength="2" maxlength="100" value="${esc(member.full_name)}"></label><label class="field">Роль<select name="role">${Object.entries(pageNames).map(([id,name])=>`<option value="${id}" ${member.role===id?'selected':''}>${name}</option>`).join('')}</select></label><label class="field">Точка<select name="store_id"><option value="">Без точки</option>${records.stores.map(s=>`<option value="${esc(s.id)}" ${member.store_id===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><label class="checkrow"><input name="active" type="checkbox" ${member.active?'checked':''}><span>Доступ активен</span></label><div class="form-actions"><button class="btn" type="button" data-action="close-modal">Отмена</button><button class="btn btn-primary" type="submit">Сохранить</button></div></form>`);
  dialog.querySelector('#editStaffForm').addEventListener('submit',event=>{
    event.preventDefault();const f=event.currentTarget;const role=f.elements.role.value,store=f.elements.store_id.value||null;
    if(role==='barista'&&!store)return toast('Бариста нужна точка');
    void run(async()=>checked(await supabase.from('gl_staff').update({full_name:f.elements.full_name.value.trim(),role,store_id:store,active:f.elements.active.checked}).eq('email',member.email).select().single()),'Доступ обновлён');
  });
}
function storeEditDialog(store) {
  const dialog=modal('Изменить точку',`<form id="editStoreForm" class="form"><label class="field">Название точки<input name="name" required maxlength="120" value="${esc(store.name)}"></label><label class="field">Адрес или район<input name="district" maxlength="160" value="${esc(store.district||'')}"></label><label class="checkrow"><input name="active" type="checkbox" ${store.active?'checked':''}><span>Точка активна</span></label><div class="form-actions"><button class="btn" type="button" data-action="close-modal">Отмена</button><button class="btn btn-primary" type="submit">Сохранить</button></div></form>`);
  dialog.querySelector('#editStoreForm').addEventListener('submit',event=>{
    event.preventDefault();const f=event.currentTarget;
    void run(async()=>checked(await supabase.from('gl_stores').update({name:f.elements.name.value.trim(),district:f.elements.district.value.trim(),active:f.elements.active.checked}).eq('id',store.id).select().single()),'Точка обновлена');
  });
}
async function action(event) {
  const el=event.target.closest('[data-action]');
  if (!el) return;
  const {action: name,id}=el.dataset;
  if (name==='close-modal') return closeModal();
  if (name==='reload') return location.reload();
  if (name==='link-login') return loginScreen('link');
  if (name==='password-login') return loginScreen();
  if (name==='logout') { stopGpsOnLogout(); await supabase.auth.signOut(); location.replace(link('index.html')); return; }
  if (!staff) return;
  if (name==='tab'&&staff.role==='manager'&&(staff.can_manage_access||!['staff','stores'].includes(id))) {activeTab=id;render();return;}
  if (name==='print-code') { window.print(); return; }
  const item=records.containers.find(x=>x.id===id);
  const batch=records.batches.find(x=>x.id===id);
  if (staff.role==='barista') {
    if (name==='new-container') return openContainerForm();
    if (name==='qr'&&item) return void qrDialog(item);
    if (name==='edit-container'&&item&&item.created_by===user.id) return openContainerForm(item);
    if (name==='cancel-container'&&item&&item.created_by===user.id) return cancelContainer(item);
  }
  if (staff.role==='logistics') {
    if (name==='start-trip') return void run(async()=>checked(await supabase.from('gl_trips').insert({}).select().single()),'Рейс начат');
    if (name==='finish-trip') {const trip=myTrip();if(!trip)return;stopGpsOnLogout();return void run(async()=>checked(await supabase.from('gl_trips').update({status:'completed'}).eq('id',trip.id).eq('status','active').select().single()),'Рейс завершён');}
    if (name==='start-gps') return void startGps();
    if (name==='stop-gps') return stopGps();
    if (name==='assign'&&item&&myTrip()) return void run(async()=>checked(await supabase.from('gl_containers').update({status:'assigned',trip_id:myTrip().id}).eq('id',item.id).eq('status','ready').select().single()),'Контейнер добавлен в рейс');
    if (name==='unassign'&&item) return void run(async()=>checked(await supabase.from('gl_containers').update({status:'ready',trip_id:null}).eq('id',item.id).eq('status','assigned').select().single()),'Контейнер убран из рейса');
    if (name==='pickup'&&item) return void scanDialog(item,'pickup');
    if (name==='undo-pickup'&&item) return void run(async()=>checked(await supabase.from('gl_containers').update({status:'assigned',pickup_code:null}).eq('id',item.id).eq('status','picked_up').select().single()),'Вывоз отменён');
  }
  if (staff.role==='production') {
    if (name==='receive'&&item) return void scanDialog(item,'receive');
    if (name==='undo-receive'&&item) return void run(async()=>checked(await supabase.from('gl_containers').update({status:'picked_up',receipt_code:null}).eq('id',item.id).eq('status','received').select().single()),'Приёмка отменена');
    if (name==='new-batch') return newBatchDialog();
    if (name==='start-drying'&&batch) return void run(async()=>checked(await supabase.from('gl_batches').update({status:'drying'}).eq('id',batch.id).eq('status','received').select().single()),'Сушка начата');
    if (name==='dry-weight'&&batch) return stageDialog(batch,'dry-weight');
    if (name==='pack-output'&&batch) return stageDialog(batch,'pack-output');
  }
  if (staff.role==='manager'&&staff.can_manage_access&&name==='edit-staff') {const member=records.staff.find(x=>x.email===id);if(member)return staffEditDialog(member);}
  if (staff.role==='manager'&&staff.can_manage_access&&name==='edit-store') {const store=records.stores.find(x=>x.id===id);if(store)return storeEditDialog(store);}
}
function stopGpsOnLogout() { if (watchId!==null&&navigator.geolocation) navigator.geolocation.clearWatch(watchId); watchId=null; }
document.addEventListener('click',event=>{void action(event);});
document.addEventListener('submit',event=>{
  if (event.target.id==='loginForm') {
    event.preventDefault();
    const email=event.target.elements.email.value.trim().toLowerCase();
    const password=event.target.elements.password.value;
    if(!email||!password)return;
    void (async()=>{try{checked(await supabase.auth.signInWithPassword({email,password}));await boot();}catch(error){toast(error.message||'Неверная почта или пароль');}})();
  }
  if (event.target.id==='linkForm') {
    event.preventDefault();const email=event.target.elements.email.value.trim().toLowerCase();
    if(!email)return;
    void (async()=>{try{checked(await supabase.auth.signInWithOtp({email,options:{emailRedirectTo:new URL('./',location.href).href}}));authScreen('Проверьте почту',`Ссылка для входа отправлена на ${email}. Откройте письмо и вернитесь на сайт.`,`<button class="btn" data-action="reload">Ввести другую почту</button>`);}catch(error){toast(error.message);}})();
  }
  if (event.target.id==='staffForm'&&staff?.role==='manager'&&staff.can_manage_access) {
    event.preventDefault();const f=event.target;const role=f.elements.role.value,store=f.elements.store_id.value||null;
    if(role==='barista'&&!store)return toast('Для бариста выберите точку');
    void run(async()=>checked(await supabase.from('gl_staff').insert({email:f.elements.email.value.trim().toLowerCase(),full_name:f.elements.full_name.value.trim(),role,store_id:store}).select().single()),'Сотрудник добавлен');
  }
  if (event.target.id==='storeForm'&&staff?.role==='manager'&&staff.can_manage_access) {
    event.preventDefault();const f=event.target;
    void run(async()=>checked(await supabase.from('gl_stores').insert({id:crypto.randomUUID(),name:f.elements.name.value.trim(),district:f.elements.district.value.trim(),active:true}).select().single()),'Точка добавлена');
  }
  if (event.target.id==='saleForm'&&staff?.role==='manager') {
    event.preventDefault();const f=event.target;
    void run(async()=>checked(await supabase.from('gl_sales').insert({batch_id:f.elements.batch_id.value,packs:Number(f.elements.packs.value),unit_price:Number(f.elements.unit_price.value),channel:f.elements.channel.value}).select().single()),'Продажа сохранена');
  }
});
void boot().catch(error=>{console.error(error);authScreen('Не удалось открыть сайт',error.message,'<button class="btn" data-action="reload">Повторить</button>');});
