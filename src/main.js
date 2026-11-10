import { createClient } from '@supabase/supabase-js';
import { BrowserQRCodeReader } from '@zxing/browser';
import QRCode from 'qrcode';
import L from 'leaflet';
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
  out_for_delivery: ['В доставке', 'warn'], delivered: ['Передано', 'good'],
};
let user = null;
let staff = null;
let records = { stores: [], staff: [], trips: [], containers: [], batches: [], sales: [], positions: [], events: [], notifications: [] };
let activeTab = 'overview';
let selectedMapTrip = null;
let journalFilter = 'all';
let activeMap = null;
let activeBaseLayer = null;
let mapStyle = localStorage.getItem('gl_map_style') === 'imagery' ? 'imagery' : 'streets';
let gpsAttemptedTrip = null;
let lastNotificationId = null;
let refreshing = false;
let queuedRefresh = false;
let busy = false;
let channel = null;
let watchId = null;
let lastPositionAt = 0;
let toastTimer;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = n => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(n) || 0)} ₸`;
const number = (n, digits = 2) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(Number(n) || 0);
const word = (n, one, few, many) => { const x = Math.abs(Number(n)) % 100, last = x % 10; return x >= 11 && x <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many; };
const dateTime = value => value ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Qyzylorda' }).format(new Date(value)) : '—';
const storeName = id => records.stores.find(s => s.id === id)?.name || id;
const storeAddress = id => records.stores.find(s => s.id === id)?.address || '';
const byNewest = (a, b) => new Date(b.created_at) - new Date(a.created_at);
const badge = status => `<span class="badge ${statuses[status]?.[1] || 'neutral'}">${esc(statuses[status]?.[0] || status)}</span>`;
const empty = (title, text) => `<div class="card-empty"><strong>${esc(title)}</strong><span>${esc(text)}</span></div>`;
const button = (label, action, extra = '', kind = '') => `<button class="btn ${kind}" type="button" data-action="${action}" ${extra}>${esc(label)}</button>`;
const stat = (label, value, hint = '') => `<article class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</article>`;
const link = path => new URL(path, location.href).href;
const ageMs = value => Date.now() - Date.parse(value);
const archivedContainer = item => ageMs(item.created_at) > 86400000 && ['cancelled','rejected','received','batched'].includes(item.status);
const navPaths = {
  overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  requests:'M4 5h16 M4 12h16 M4 19h12 M2 5h.01 M2 12h.01 M2 19h.01',
  map:'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15 M15 6v15',
  archive:'M3 4h18v4H3z M5 8v12h14V8 M10 13h4',
  deliveries:'M3 7h12v10H3z M15 10h3l3 3v4h-6 M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4 M17 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  intake:'M4 3h16v18H4z M8 8h8 M8 12h8 M8 16h5',
  batches:'M3 7l9-4 9 4-9 4z M3 7v10l9 4 9-4V7 M12 11v10',
  dispatch:'M3 12h14 M13 8l4 4-4 4 M4 5h16v14H4z',
  sales:'M3 5h18v14H3z M3 9h18 M7 15h4',
  journal:'M4 4h16v16H4z M8 8h8 M8 12h8 M8 16h5',
  staff:'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M17 10h5 M19.5 7.5v5',
  stores:'M4 10l8-7 8 7v11H4z M9 21v-7h6v7',
};
const navIcon = id => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${navPaths[id]||navPaths.overview}"/></svg>`;
const tabs = items => `<nav class="tabs" aria-label="Разделы">${items.map(([id,label])=>`<button class="tab ${activeTab===id?'active':''}" data-action="tab" data-id="${id}" aria-current="${activeTab===id?'page':'false'}">${navIcon(id)}<span>${label}</span></button>`).join('')}</nav>`;
const basemap = (map, style = mapStyle) => L.tileLayer(style === 'imagery'
  ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
  : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 18, attribution: style === 'imagery'
    ? '&copy; Esri, Vantor, Earthstar Geographics and GIS User Community'
    : '&copy; Esri, HERE, Garmin, OpenStreetMap contributors and GIS User Community' }).addTo(map);

function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4300);
}
function brand() { return `<a class="brand" href="./index.html">GroundLoop<span class="brand-dot" aria-hidden="true">.</span></a>`; }
function shell(title, subtitle, actions, body) {
  if (activeMap) { activeMap.remove(); activeMap = null; activeBaseLayer = null; }
  app.innerHTML = `<div class="shell"><header class="top"><div class="top-inner">${brand()}<div class="top-context"><span class="top-divider"></span><span>Шымкент</span></div><div class="top-right"><div class="top-user"><strong>${esc(staff.full_name)}</strong><small>${esc(user.email)}</small></div><button data-action="logout">Выйти</button></div></div></header><main class="container"><section class="hero"><div><div class="eyebrow">${esc(pageNames[staff.role])}${staff.store_id ? ` / ${esc(storeName(staff.store_id))}` : ''}</div><h1>${esc(title)}</h1>${subtitle?`<p>${esc(subtitle)}</p>`:''}</div><div class="hero-actions">${actions || ''}</div></section><div class="workspace">${body}</div></main></div>`;
  const workspace=app.querySelector('.workspace');
  const nav=workspace.querySelector(':scope > .tabs');
  if(nav){const main=document.createElement('div');main.className='workspace-main';for(const child of [...workspace.children])if(child!==nav)main.append(child);workspace.append(main);}
  syncDeliveryField();
  if (document.querySelector('#operationsMap')) requestAnimationFrame(() => void drawOperationsMap());
}
function syncDeliveryField() {
  const form=document.querySelector('#saleForm');
  if(!form)return;
  const delivery=form.elements.fulfillment.value==='delivery';
  const field=form.elements.delivery_address.closest('label');
  field.hidden=!delivery;
  form.elements.delivery_address.required=delivery;
  form.querySelector('[data-action=delivery-pin]').hidden=!delivery;
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
function setPasswordScreen() {
  authScreen('Задайте пароль', 'Приглашение подтверждено. Создайте пароль для следующих входов.',
    `<form id="setPasswordForm" class="form"><label class="field">Новый пароль<input type="password" name="password" autocomplete="new-password" minlength="10" required></label><label class="field">Повторите пароль<input type="password" name="confirm" autocomplete="new-password" minlength="10" required></label><button class="btn btn-primary" type="submit">Сохранить пароль</button></form>`);
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
    await refresh();
    closeModal();
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
      ['stores', 'gl_stores', 'id,name,district,address,latitude,longitude,active'],
      ['trips', 'gl_trips', '*'], ['containers', 'gl_containers', '*'],
      ['batches', 'gl_batches', '*'], ['sales', 'gl_sales', '*'],
      ['positions', 'gl_driver_positions', '*'], ['events', 'gl_events', '*'],
      ['notifications', 'gl_notifications', '*'],
    ];
    if (staff.role === 'manager') queries.push(['staff', 'gl_staff', '*']);
    const results = await Promise.all(queries.map(async ([key, table, columns]) => [key, checked(await supabase.from(table).select(columns).limit(1000))]));
    for (const [key, value] of results) records[key] = value;
    if (staff.role === 'logistics') syncGps();
    if (!document.querySelector('#activeDialog') && !document.activeElement?.closest('#saleForm,#staffForm,#storeForm')) render();
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
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'gl_notifications' }, () => void refresh())
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
  if (user.user_metadata?.groundloop_needs_password) return setPasswordScreen();
  activeTab = ({ barista:'requests', logistics:'requests', production:'intake', manager:'overview' })[staff.role];
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
  const pickupStore = records.stores.find(s => s.id === item.store_id);
  const pickup = role === 'logistics' ? `<div class="item-sub pickup-address">Адрес вывоза: ${esc(storeAddress(item.store_id) || `${pickupStore?.district || 'район не указан'} · точный адрес уточняется`)}</div>` : '';
  const carrier = role === 'barista' && item.trip_id ? records.trips.find(t => t.id === item.trip_id) : null;
  const handoff = carrier ? `<div class="handoff-line">${item.status === 'assigned' ? 'Заявку взял' : 'Забрал'} ${esc(carrier.driver_name)} · ${esc(carrier.code)}</div>` : '';
  const note = role === 'barista' && item.note && item.status !== 'ready' ? `<div class="item-note">${esc(item.note)}</div>` : '';
  let actions = '';
  if (role === 'barista') {
    actions = `${button('Показать QR', 'qr', `data-id="${item.id}"`, 'btn-sm')}`;
    if (item.created_by === user.id && ['ready','hold','rejected'].includes(item.status)) {
      actions += `${button('Исправить', 'edit-container', `data-id="${item.id}"`, 'btn-sm')}${button('Отменить заявку', 'cancel-container', `data-id="${item.id}"`, 'btn-sm btn-danger')}`;
    } else if (item.created_by === user.id && item.status === 'assigned') {
      actions += button('Отменить заявку', 'cancel-container', `data-id="${item.id}"`, 'btn-sm btn-danger');
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
  return `<article class="item"><div class="item-top"><div><div class="item-title mono">${esc(item.code)}</div><div class="item-sub">${owner}</div>${pickup}${handoff}</div>${badge(item.status)}</div><div class="item-meta"><span><strong>${number(item.wet_kg)} кг</strong></span><span>${item.cups ? `${number(item.cups,0)} ${word(item.cups,'напиток','напитка','напитков')}` : 'Вес измерен'}</span><span>${dateTime(item.created_at)}</span></div>${note}${actions ? `<div class="item-actions">${actions}</div>` : ''}</article>`;
}

function renderBarista() {
  const own = records.containers.filter(x => x.store_id === staff.store_id).sort(byNewest);
  const ready = own.filter(x => x.status === 'ready');
  const current = own.filter(x => !archivedContainer(x));
  const archive = own.filter(archivedContainer);
  const nav = tabs([['requests','Заявки'],['map','Карта'],['archive','Архив']]);
  let body = nav;
  if (activeTab === 'map') body += mapWorkspace('barista');
  else if (activeTab === 'archive') body += `<section class="card"><div class="card-head"><h2>Архив заявок</h2></div>${archive.length ? archive.map(x=>containerItem(x,'barista')).join('') : empty('Архив пока пуст','Завершённые и отменённые заявки переходят сюда через 24 часа.')}</section>`;
  else body += `<section class="stats compact-stats">${stat('Готовы к вывозу',ready.length,`${number(ready.reduce((s,x)=>s+Number(x.wet_kg),0))} кг`)}${stat('У логиста',own.filter(x=>['assigned','picked_up'].includes(x.status)).length)}${stat('Заявки в работе',current.length)}</section><section class="card"><div class="card-head"><h2>Заявки точки</h2></div>${current.length ? current.map(x=>containerItem(x,'barista')).join('') : empty('Заявок нет','Новая заявка появится здесь после взвешивания.')}</section>`;
  shell('Сбор на точке', activeTab === 'map' ? 'Рейсы, которые забирают заявки вашей точки.' : '', activeTab === 'requests' ? button('Новая заявка','new-container','','btn-primary') : '', body);
}

function openContainerForm(item = null) {
  const quality = item?.quality || 'good';
  const dialog = modal(item ? 'Исправить запись' : 'Новый контейнер', `<form id="containerForm" class="form two">
    <label class="field">Вес жмыха, кг<input name="wet_kg" type="number" inputmode="decimal" min="0.01" step="0.01" required value="${esc(item?.wet_kg || '')}"></label>
    <label class="field">Напитков за смену<input name="cups" type="number" inputmode="numeric" min="0" step="1" value="${esc(item?.cups ?? 0)}"></label>
    <label class="field wide">Качество<select name="quality"><option value="good" ${quality==='good'?'selected':''}>Чистое, готово к вывозу</option><option value="hold" ${quality==='hold'?'selected':''}>Удержать, нужна повторная проверка</option><option value="rejected" ${quality==='rejected'?'selected':''}>Не подходит для переработки</option></select></label>
    <label class="field wide">Причина удержания или брака<textarea name="note" maxlength="600" placeholder="Заполняется только при проблеме с качеством">${quality === 'good' ? '' : esc(item?.note || '')}</textarea></label>
    <label class="checkrow wide"><input type="checkbox" name="checked" required><span>Я проверил контейнер и указал его фактическое состояние</span></label>
    <div class="form-actions wide"><button class="btn" type="button" data-action="close-modal">Отмена</button><button class="btn btn-primary" type="submit">${item?'Сохранить исправление':'Создать запись'}</button></div></form>`);
  dialog.querySelector('#containerForm').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const wet = Number(form.elements.wet_kg.value);
    const cups = Number(form.elements.cups.value);
    const qualityValue = form.elements.quality.value;
    if (!Number.isFinite(wet) || wet <= 0 || !Number.isInteger(cups) || cups < 0) return toast('Проверьте вес и число напитков');
    const note = qualityValue === 'good' ? '' : form.elements.note.value.trim();
    if (qualityValue !== 'good' && !note) return toast('Укажите причину удержания или брака');
    const payload = { wet_kg: wet, cups, quality: qualityValue, note };
    if (item) payload.status = { good:'ready', hold:'hold', rejected:'rejected' }[qualityValue];
    void run(async () => {
      if (item) checked(await supabase.from('gl_containers').update(payload).eq('id', item.id).eq('version', item.version).select().single());
      else checked(await supabase.from('gl_containers').insert(payload).select().single());
    }, item ? 'Запись исправлена' : 'Контейнер добавлен');
  });
}
function cancelContainer(item) {
  const dialog = modal('Отменить заявку', `<p class="muted" style="margin-bottom:18px">${esc(item.code)} будет исключён из вывоза. Если логист уже взял заявку, он получит уведомление.</p><form id="cancelForm" class="form"><label class="field">Причина отмены<textarea name="reason" required maxlength="300" placeholder="Например: ошибочный вес или контейнер повреждён"></textarea></label><div class="form-actions"><button class="btn" type="button" data-action="close-modal">Назад</button><button class="btn btn-danger" type="submit">Отменить заявку</button></div></form>`);
  dialog.querySelector('#cancelForm').addEventListener('submit', event => {
    event.preventDefault();
    const reason = event.currentTarget.elements.reason.value.trim();
    if (!reason) return;
    void run(async () => checked(await supabase.from('gl_containers').update({ status:'cancelled', note: `Отмена: ${reason}`, trip_id:null }).eq('id',item.id).eq('version',item.version).select().single()), 'Заявка отменена');
  });
}

function myTrip() { return records.trips.find(t => t.driver_id === user.id && t.status === 'active'); }
function positionFor(tripId) { return records.positions.find(x => x.trip_id === tripId); }
function syncGps() {
  const trip = myTrip();
  if (!trip) { stopGpsOnLogout(); gpsAttemptedTrip = null; return; }
  if (watchId === null && gpsAttemptedTrip !== trip.id) {
    gpsAttemptedTrip = trip.id;
    void startGps(true);
  }
}
function visibleMapTrips() {
  if (staff.role === 'manager') return records.trips.filter(x=>x.status==='active');
  if (staff.role === 'logistics') return records.trips.filter(x=>x.driver_id===user.id&&x.status==='active');
  return records.trips.filter(t=>t.status==='active'&&records.containers.some(c=>c.trip_id===t.id&&c.store_id===staff.store_id&&['assigned','picked_up'].includes(c.status)));
}
function selectedTrip() {
  const trips = visibleMapTrips();
  return trips.find(x=>x.id===selectedMapTrip) || trips[0] || null;
}
function mapWorkspace(role) {
  const trips = visibleMapTrips();
  const chosen = selectedTrip();
  const collections = chosen ? records.containers.filter(x=>x.trip_id===chosen.id&&['assigned','picked_up'].includes(x.status)) : records.containers.filter(x=>x.status==='ready'&&(role!=='barista'||x.store_id===staff.store_id));
  const grouped = [...new Set(collections.map(x=>x.store_id))].map(id=>({store:records.stores.find(s=>s.id===id),items:collections.filter(x=>x.store_id===id)}));
  const gps = chosen ? positionFor(chosen.id) : null;
  const fresh = gps && ageMs(gps.updated_at)<120000;
  const choices = trips.length>1 ? `<div class="trip-choices">${trips.map(t=>`<button class="trip-choice ${chosen?.id===t.id?'selected':''}" data-action="select-map-trip" data-id="${t.id}"><strong>${esc(t.driver_name)}</strong><span>${esc(t.code)}</span></button>`).join('')}</div>` : '';
  const stops = grouped.map(({store,items},i)=>`<button class="map-stop" type="button" data-action="focus-map" data-lat="${store?.latitude??''}" data-lon="${store?.longitude??''}"><span class="stop-number">${i+1}</span><span class="map-stop-copy"><strong>${esc(store?.name||items[0].store_id)}</strong><small>${esc(store?.address||'Точный адрес не указан')} · ${chosen?`${items.filter(x=>x.status==='assigned').length} к вывозу · ${items.filter(x=>x.status==='picked_up').length} забрано`:`${items.length} ${word(items.length,'заявка','заявки','заявок')}`}</small></span><span class="stop-arrow" aria-hidden="true">↗</span></button>`).join('');
  const deliveries = role==='logistics' ? records.sales.filter(x=>x.fulfillment==='delivery'&&x.delivery_trip_id===chosen?.id&&['assigned','out_for_delivery'].includes(x.delivery_status)).map(x=>`<div class="map-stop"><span class="stop-number">↗</span><div><strong>${esc(x.customer_name)}</strong><small>${esc(x.delivery_address)}</small></div></div>`).join('') : '';
  return `<div class="map-layout"><section class="card map-card"><div class="map-toolbar"><div class="map-toolbar-main"><strong>${chosen?esc(chosen.driver_name+' · '+chosen.code):'Карта точек и рейсов'}</strong><span>${gps?`${fresh?'Геопозиция обновлена':'Последняя геопозиция'} · ${dateTime(gps.updated_at)}`:`Шымкент · ${records.stores.filter(s=>s.active).length} точек`}</span></div><div class="map-styles" role="group" aria-label="Вид карты"><button type="button" class="map-style ${mapStyle==='streets'?'selected':''}" data-action="map-style" data-id="streets">Улицы</button><button type="button" class="map-style ${mapStyle==='imagery'?'selected':''}" data-action="map-style" data-id="imagery">Спутник</button></div></div><div id="operationsMap" class="operations-map" role="img" aria-label="Карта заявок и рейсов"></div><div class="map-foot"><span id="routeMeta">${grouped.length?'Остановок: '+grouped.length:'Нет остановок с заявками'}</span><span class="map-legend"><i></i>Точка сбора <i></i>Логист</span></div></section><aside class="card route-panel"><div class="card-head"><div><h2>Остановки</h2><p>${chosen?esc(chosen.code):'Заявки к вывозу'}</p></div><span class="route-count">${grouped.length}</span></div><div class="card-body">${choices}${stops||empty('Остановок нет','Заявки появятся здесь автоматически.')}${deliveries}</div></aside></div>`;
}
function mapPoint(lat,lon) { return lat!==null&&lon!==null&&lat!==''&&lon!==''&&Number.isFinite(Number(lat))&&Number.isFinite(Number(lon)) ? [Number(lat),Number(lon)] : null; }
function routeStops(trip) {
  const ids = [...new Set(records.containers.filter(c=>c.trip_id===trip.id&&c.status==='assigned').map(c=>c.store_id))];
  const stores=ids.map(id=>records.stores.find(s=>s.id===id)).filter(s=>s&&mapPoint(s.latitude,s.longitude));
  const deliveries=records.sales.filter(x=>x.delivery_trip_id===trip.id&&['assigned','out_for_delivery'].includes(x.delivery_status)&&mapPoint(x.latitude,x.longitude));
  return [...stores,...deliveries];
}
async function drawOperationsMap() {
  const element = document.querySelector('#operationsMap');
  if (!element || !staff) return;
  const firstStore = records.stores.find(s=>s.active&&mapPoint(s.latitude,s.longitude));
  const map = L.map(element,{zoomControl:true,scrollWheelZoom:false}).setView(firstStore ? mapPoint(firstStore.latitude,firstStore.longitude) : [42.323,69.595],12);
  activeMap = map;
  activeBaseLayer = basemap(map);
  const bounds=[];
  const role=staff.role, chosen=selectedTrip();
  const visibleIds = role==='barista' ? [staff.store_id] : records.stores.filter(s=>s.active).map(s=>s.id);
  for (const store of records.stores.filter(s=>visibleIds.includes(s.id))) {
    const point=mapPoint(store.latitude,store.longitude);
    if (!point) continue;
    const count=records.containers.filter(c=>c.store_id===store.id&&['ready','assigned','picked_up'].includes(c.status)).length;
    L.marker(point,{icon:L.divIcon({className:'map-marker',html:`<span class="store-marker ${count?'has-work':''}">${visibleIds.indexOf(store.id)+1}</span>`,iconSize:[36,36],iconAnchor:[18,18]})})
      .bindPopup(`<strong>${esc(store.name)}</strong><br>${esc(store.address||'Адрес не указан')}<br>${count} ${word(count,'заявка','заявки','заявок')}`).addTo(map);
    bounds.push(point);
  }
  const trips=visibleMapTrips();
  for(const trip of trips){
    const pos=positionFor(trip.id),point=pos&&mapPoint(pos.latitude,pos.longitude);
    if(!point)continue;
    const current=ageMs(pos.updated_at)<120000;
    L.marker(point,{icon:L.divIcon({className:'map-marker',html:`<span class="driver-marker ${current?'online':''}">↗</span>`,iconSize:[40,40],iconAnchor:[20,20]})})
      .bindPopup(`<strong>${esc(trip.driver_name)}</strong><br>${current?'GPS сейчас':'Последнее положение'} · ${dateTime(pos.updated_at)}<br>${esc(trip.code)}`).addTo(map);
    bounds.push(point);
  }
  if(role==='logistics')for(const order of records.sales.filter(x=>x.fulfillment==='delivery'&&x.delivery_trip_id===chosen?.id&&['assigned','out_for_delivery'].includes(x.delivery_status))){
    const point=mapPoint(order.latitude,order.longitude);if(!point)continue;
    L.marker(point,{icon:L.divIcon({className:'map-marker',html:'<span class="delivery-marker">◆</span>',iconSize:[36,36],iconAnchor:[18,18]})})
      .bindPopup(`<strong>${esc(order.customer_name)}</strong><br>${esc(order.delivery_address)}`).addTo(map);bounds.push(point);
  }
  if(bounds.length)map.fitBounds(bounds,{padding:[36,36],maxZoom:14});
  setTimeout(()=>{if(activeMap===map)map.invalidateSize();},100);
  const position=chosen&&positionFor(chosen.id);
  const start=position&&mapPoint(position.latitude,position.longitude);
  const stops=chosen?routeStops(chosen):[];
  if(!start||!stops.length)return;
  const coordinates=[start,...stops.map(s=>mapPoint(s.latitude,s.longitude))];
  const url=`https://router.project-osrm.org/route/v1/driving/${coordinates.map(([lat,lon])=>`${lon},${lat}`).join(';')}?overview=full&geometries=geojson&steps=false`;
  try{
    const response=await fetch(url,{signal:AbortSignal.timeout(8000)});
    const data=await response.json();
    if(!response.ok||data.code!=='Ok'||!data.routes?.[0])throw Error('Маршрут не найден');
    if(activeMap!==map)return;
    const line=L.geoJSON(data.routes[0].geometry,{style:{color:'#176944',weight:5,opacity:.8}}).addTo(map);
    map.fitBounds(line.getBounds(),{padding:[34,34]});
    const meta=document.querySelector('#routeMeta');
    if(meta)meta.textContent=`По дорогам: ${number(data.routes[0].distance/1000,1)} км · около ${Math.round(data.routes[0].duration/60)} мин`;
  }catch{
    if(activeMap!==map)return;
    L.polyline(coordinates,{color:'#176944',weight:3,dashArray:'7 7',opacity:.7}).addTo(map);
    const meta=document.querySelector('#routeMeta');if(meta)meta.textContent='Показан порядок остановок; дорожный маршрут сейчас недоступен';
  }
}
function renderLogistics() {
  const trip = myTrip();
  const ready = records.containers.filter(x => x.status === 'ready').sort(byNewest);
  const mine = trip ? records.containers.filter(x => x.trip_id === trip.id).sort(byNewest) : [];
  const inTransit = mine.filter(x => ['assigned','picked_up'].includes(x.status));
  const pendingDeliveries = trip ? records.sales.filter(x=>x.delivery_trip_id===trip.id&&['assigned','out_for_delivery'].includes(x.delivery_status)) : [];
  const seen = new Set(JSON.parse(localStorage.getItem(`gl_seen_notices_${user.id}`) || '[]'));
  const notices = records.notifications.filter(n => !seen.has(n.id)).sort(byNewest);
  if (notices[0] && lastNotificationId && notices[0].id !== lastNotificationId) toast(`Заявка ${notices[0].container_code} отменена`);
  lastNotificationId = notices[0]?.id || null;
  const notice = notices.length ? `<div class="cancel-alert"><strong>Заявка ${esc(notices[0].container_code)} отменена</strong><span>${esc(storeName(notices[0].store_id))} · удалена из вашего рейса</span>${button('Понятно','dismiss-notice',`data-id="${notices[0].id}"`,'btn-sm')}</div>` : '';
  const nav = tabs([['requests','Заявки'],['map','Карта'],['deliveries','Доставка'],['archive','Архив']]);
  let body = `${notice}${nav}`;
  if (activeTab === 'map') body += mapWorkspace('logistics');
  else if (activeTab === 'deliveries') {
    const queue = records.sales.filter(x=>x.fulfillment==='delivery'&&x.delivery_status==='ready').sort(byNewest);
    const assigned = records.sales.filter(x=>x.fulfillment==='delivery'&&x.delivery_driver_id===user.id&&['assigned','out_for_delivery'].includes(x.delivery_status)).sort(byNewest);
    body += `<div class="grid"><section class="card"><div class="card-head"><h2>Мои доставки</h2></div>${assigned.length?assigned.map(x=>productOrderItem(x,'logistics')).join(''):empty('Доставок нет','Возьмите готовую заявку из очереди.')}</section><section class="card"><div class="card-head"><h2>Готовы к отправке</h2></div>${queue.length?queue.map(x=>productOrderItem(x,'logistics')).join(''):empty('Очередь пуста','Новые заявки появятся после выпуска партии.')}</section></div>`;
  } else if (activeTab === 'archive') {
    const archive = records.containers.filter(x=>x.trip_id&&records.trips.some(t=>t.id===x.trip_id&&t.driver_id===user.id)&&archivedContainer(x)).sort(byNewest);
    body += `<section class="card"><div class="card-head"><h2>Архив вывоза</h2></div>${archive.length?archive.map(x=>containerItem(x,'logistics')).join(''):empty('Архив пока пуст','Завершённые заявки переходят сюда через 24 часа.')}</section>`;
  } else {
    body += `<div class="shift-strip"><span><strong>${ready.length}</strong> готово к вывозу</span><span><strong>${inTransit.length}</strong> в рейсе</span><span><strong>${mine.filter(x=>x.status==='picked_up').length}</strong> забрано</span></div><div class="grid logistics-grid"><section class="card"><div class="card-head"><div><h2>Мой рейс</h2><p>${esc(trip?.code||'Рейс не начат')}</p></div>${trip && !inTransit.length && !pendingDeliveries.length ? button('Завершить рейс','finish-trip','','btn-sm') : ''}</div>${mine.length?mine.filter(x=>!archivedContainer(x)).map(x=>containerItem(x,'logistics')).join(''):empty('Рейс пуст','Добавьте заявку из очереди.')}</section><section class="card"><div class="card-head"><h2>Новые заявки</h2></div>${ready.length?ready.map(x=>containerItem(x,'logistics')).join(''):empty('Новых заявок нет','Очередь обновится автоматически.')}</section></div>`;
  }
  const heroAction = !trip && ['requests','deliveries'].includes(activeTab) ? button('Начать рейс','start-trip','','btn-primary') : trip && watchId===null ? button('Включить GPS','start-gps','','btn-primary') : '';
  shell(({requests:'Вывоз заявок',map:'Карта рейса',deliveries:'Доставка продукта',archive:'История вывоза'})[activeTab], '', heroAction, body);
}

async function startGps(automatic = false) {
  const trip = myTrip();
  if (!trip || !navigator.geolocation) return toast('GPS недоступен на этом устройстве');
  if (watchId !== null) return;
  gpsAttemptedTrip = trip.id;
  watchId = navigator.geolocation.watchPosition(async position => {
    if (Date.now() - lastPositionAt < 10000) return;
    lastPositionAt = Date.now();
    const result = await supabase.from('gl_driver_positions').upsert({
      trip_id: trip.id, driver_id: user.id, latitude: position.coords.latitude,
      longitude: position.coords.longitude, accuracy_m: position.coords.accuracy,
    }, { onConflict: 'trip_id' });
    if (result.error) toast(`GPS не сохранён: ${result.error.message}`);
  }, error => { watchId = null; toast(`GPS: ${error.message}`); render(); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  if (!automatic) toast('GPS включён');
}
function stopGps() { if (watchId !== null) navigator.geolocation.clearWatch(watchId); watchId = null; render(); toast('GPS остановлен'); }

function productOrderItem(order, role) {
  const legacy = !order.customer_name;
  let actions = '';
  if (role === 'logistics' && order.fulfillment === 'delivery') {
    if (order.delivery_status === 'ready') actions = myTrip() ? button('Взять доставку','claim-delivery',`data-id="${order.id}"`,'btn-sm btn-primary') : '<span class="muted">Начните рейс, чтобы взять доставку</span>';
    if (order.delivery_driver_id === user.id && order.delivery_status === 'assigned') actions = `${button('Сканировать выдачу','scan-product',`data-id="${order.id}"`,'btn-sm btn-primary')}${button('Вернуть в очередь','release-delivery',`data-id="${order.id}"`,'btn-sm')}`;
    if (order.delivery_driver_id === user.id && order.delivery_status === 'out_for_delivery') actions = button('Передать покупателю','complete-delivery',`data-id="${order.id}"`,'btn-sm btn-primary');
  }
  if (role === 'production' && order.fulfillment === 'delivery' && ['ready','assigned'].includes(order.delivery_status)) actions = button('Показать QR','product-qr',`data-id="${order.id}"`,'btn-sm');
  if (role === 'manager') {
    if (order.delivery_status === 'ready' && order.fulfillment === 'pickup') actions = button('Подтвердить самовывоз','complete-pickup',`data-id="${order.id}"`,'btn-sm btn-primary');
    if (order.delivery_status === 'ready') actions += button('Отменить','cancel-product-order',`data-id="${order.id}"`,'btn-sm btn-danger');
  }
  return `<article class="item"><div class="item-top"><div><div class="item-title mono">${esc(order.order_code||'Продажа')} · ${esc(order.customer_name||order.channel)}</div><div class="item-sub">${esc(records.batches.find(b=>b.id===order.batch_id)?.code||'Партия')} · ${order.packs} уп. · ${money(order.unit_price)}</div></div>${badge(order.delivery_status)}</div><div class="item-meta"><span>${order.fulfillment==='delivery'?'Доставка':'Самовывоз'}</span>${order.delivery_address?`<span>${esc(order.delivery_address)}</span>`:''}${order.delivery_driver_name?`<span>${esc(order.delivery_driver_name)}</span>`:''}${order.recipient_name?`<span>Получил: ${esc(order.recipient_name)}</span>`:''}<span>${dateTime(order.created_at)}</span></div>${legacy?'':actions?`<div class="item-actions">${actions}</div>`:''}</article>`;
}
async function productQrDialog(order) {
  const image = await QRCode.toDataURL(order.order_code, { width: 320, margin: 1, color: { dark: '#17271d', light: '#ffffff' } });
  modal('Выдача продукта',`<img class="qr-image" src="${image}" alt="QR-код ${esc(order.order_code)}"><div class="qr-code">${esc(order.order_code)}</div><p class="muted" style="text-align:center">Логист сканирует код при получении партии.</p><div class="form-actions"><button class="btn" data-action="print-code">Печать</button><button class="btn btn-primary" data-action="close-modal">Закрыть</button></div>`);
}
async function productScanDialog(order) {
  const dialog=modal('Получить продукт',`<div class="notice">${esc(order.order_code)} · ${esc(order.customer_name)} · ${order.packs} уп.</div><video class="scan-video" id="scanVideo" autoplay muted playsinline></video><p class="scan-hint" id="scanHint">Сканируйте код на партии или введите его с этикетки.</p><form id="scanProductForm" class="form"><label class="field">Код выдачи<input name="code" class="scan-input mono" required autocomplete="off"></label><div class="form-actions"><button class="btn" data-action="close-modal" type="button">Отмена</button><button class="btn btn-primary" type="submit">Подтвердить выдачу</button></div></form>`);
  let controls;
  dialog.addEventListener('close',()=>controls?.stop(),{once:true});
  const form=dialog.querySelector('#scanProductForm');
  const submit=code=>{const normalized=String(code||'').trim().toUpperCase();if(normalized!==order.order_code)return toast('Код не совпадает');void run(async()=>checked(await supabase.from('gl_sales').update({delivery_status:'out_for_delivery',pickup_code:normalized}).eq('id',order.id).eq('delivery_status','assigned').select().single()),'Продукт получен');};
  form.addEventListener('submit',event=>{event.preventDefault();submit(form.elements.code.value);});
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw Error('Нет камеры');
    const reader=new BrowserQRCodeReader();
    controls=await reader.decodeFromVideoDevice(undefined,dialog.querySelector('#scanVideo'),result=>{if(!result)return;const code=result.getText().trim().toUpperCase();form.elements.code.value=code;if(code===order.order_code){controls?.stop();submit(code);}else dialog.querySelector('#scanHint').textContent=`Считан ${code}. Это другая заявка.`;});
  }catch{dialog.querySelector('#scanHint').textContent='Камера недоступна. Введите код с этикетки.';}
}
function productHandoverDialog(order, pickup=false) {
  const dialog=modal(pickup?'Подтвердить самовывоз':'Передать покупателю',`<form id="productHandoverForm" class="form"><div class="notice">${esc(order.order_code)} · ${esc(order.customer_name)} · ${order.packs} уп.</div><label class="field">Кто получил продукт<input name="recipient" required minlength="2" maxlength="100" autocomplete="name"></label><div class="form-actions"><button class="btn" type="button" data-action="close-modal">Отмена</button><button class="btn btn-primary" type="submit">Передано</button></div></form>`);
  dialog.querySelector('#productHandoverForm').addEventListener('submit',event=>{event.preventDefault();const recipient=event.currentTarget.elements.recipient.value.trim();if(recipient.length<2)return;void run(async()=>checked(await supabase.from('gl_sales').update({delivery_status:'delivered',recipient_name:recipient}).eq('id',order.id).eq('delivery_status',pickup?'ready':'out_for_delivery').select().single()),'Передача подтверждена');});
}

function batchItem(batch) {
  const sold = records.sales.filter(x => x.batch_id === batch.id && x.delivery_status !== 'cancelled').reduce((s,x)=>s+x.packs,0);
  const available = batch.produced_packs - sold;
  let actions = '';
  if (batch.created_by === user.id && staff.role === 'production') {
    if (batch.status === 'received') actions = button('Начать сушку','start-drying',`data-id="${batch.id}"`,'btn-sm btn-primary');
    if (batch.status === 'drying') actions = button('Подтвердить сухой вес','dry-weight',`data-id="${batch.id}"`,'btn-sm btn-primary');
    if (batch.status === 'production') actions = button('Зафиксировать выпуск','pack-output',`data-id="${batch.id}"`,'btn-sm btn-primary');
  }
  return `<article class="item"><div class="item-top"><div><div class="item-title mono">${esc(batch.code)}</div><div class="item-sub">${esc(batch.operator_name)} · ${dateTime(batch.created_at)}</div></div>${badge(batch.status)}</div><div class="item-meta"><span>${number(batch.wet_kg)} кг принято</span><span>${batch.container_ids.length} ${word(batch.container_ids.length,'контейнер','контейнера','контейнеров')}</span>${batch.accepted_kg!=null?`<span>${number(batch.accepted_kg)} кг после контроля</span>`:''}</div>${batch.status==='complete'?`<div class="split-values"><div><span>Произведено</span><strong>${batch.produced_packs} уп.</strong></div><div><span>Остаток</span><strong>${available} уп.</strong></div></div>`:''}${actions?`<div class="item-actions">${actions}</div>`:''}</article>`;
}
function renderProduction() {
  const incoming = records.containers.filter(x => x.status === 'picked_up').sort(byNewest);
  const received = records.containers.filter(x => x.status === 'received').sort(byNewest);
  const batches = [...records.batches].sort(byNewest);
  const eligible=received.filter(x=>records.trips.find(t=>t.id===x.trip_id)?.status==='completed');
  let body=tabs([['intake','Приёмка'],['batches','Партии'],['dispatch','Выдача'],['archive','Архив']]);
  if(activeTab==='batches')body+=`<section class="stats compact-stats">${stat('В работе',batches.filter(x=>x.status!=='complete').length)}${stat('Готово упаковок',batches.reduce((s,x)=>s+x.produced_packs,0))}${stat('Принято сырья',`${number(batches.reduce((s,x)=>s+Number(x.wet_kg),0))} кг`)}</section><section class="card"><div class="card-head"><h2>Партии</h2></div>${batches.filter(x=>x.status!=='complete'||ageMs(x.created_at)<86400000).length?batches.filter(x=>x.status!=='complete'||ageMs(x.created_at)<86400000).map(batchItem).join(''):empty('Партий пока нет','Принятые контейнеры появятся после закрытия рейса.')}</section>`;
  else if(activeTab==='dispatch'){
    const orders=records.sales.filter(x=>x.fulfillment==='delivery'&&['ready','assigned'].includes(x.delivery_status)).sort(byNewest);
    body+=`<section class="card"><div class="card-head"><h2>Выдача логисту</h2></div>${orders.length?orders.map(x=>productOrderItem(x,'production')).join(''):empty('Выдач нет','После оформления доставки появится код выдачи.')}</section>`;
  }else if(activeTab==='archive'){
    const old=batches.filter(x=>x.status==='complete'&&ageMs(x.created_at)>=86400000);
    body+=`<section class="card"><div class="card-head"><h2>Архив партий</h2></div>${old.length?old.map(batchItem).join(''):empty('Архив пока пуст','Завершённые партии переходят сюда через 24 часа.')}</section>`;
  }else body+=`<section class="stats compact-stats">${stat('Ожидают приёмки',incoming.length)}${stat('Принято',received.length,`${number(received.reduce((s,x)=>s+Number(x.wet_kg),0))} кг`)}${stat('Готово к партии',eligible.length)}</section><div class="grid"><section class="card"><div class="card-head"><h2>Ожидают приёмки</h2></div>${incoming.length?incoming.map(x=>containerItem(x,'production')).join(''):empty('Контейнеров нет','Очередь обновится автоматически.')}</section><section class="card"><div class="card-head"><h2>Принято в цех</h2>${eligible.length?button('Создать партию','new-batch','','btn-sm btn-primary'):''}</div>${received.length?received.map(x=>`<div class="production-intake">${containerItem(x,'production')}${records.trips.find(t=>t.id===x.trip_id)?.status==='completed'?'':`<small>Рейс ещё открыт · партия доступна после его закрытия</small>`}</div>`).join(''):empty('Принятых контейнеров нет','Сканируйте первый контейнер.')}</section></div>`;
  shell(({intake:'Приёмка контейнеров',batches:'Производственные партии',dispatch:'Выдача продукта',archive:'История партий'})[activeTab], '', '', body);
}
function newBatchDialog() {
  const received = records.containers.filter(x=>x.status==='received'&&records.trips.find(t=>t.id===x.trip_id)?.status==='completed').sort(byNewest);
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
    ? [['overview','Обзор'],['map','Карта'],['sales','Заказы продукта'],['journal','Журнал'],['staff','Команда'],['stores','Точки']]
    : [['overview','Обзор'],['map','Карта'],['sales','Заказы продукта'],['journal','Журнал']];
  return tabs(items);
}
function renderManagement() {
  if (!staff.can_manage_access && ['staff','stores'].includes(activeTab)) activeTab = 'overview';
  const activeContainers=records.containers.filter(x=>!['cancelled','rejected'].includes(x.status));
  const produced=records.batches.reduce((s,x)=>s+x.produced_packs,0);
  const sold=records.sales.filter(x=>x.delivery_status==='delivered').reduce((s,x)=>s+x.packs,0);
  const reserved=records.sales.filter(x=>x.delivery_status!=='cancelled').reduce((s,x)=>s+x.packs,0);
  const revenue=records.sales.filter(x=>x.delivery_status==='delivered').reduce((s,x)=>s+x.packs*Number(x.unit_price),0);
  let body = managerTabs();
  if (activeTab==='overview') {
    const liveTrip=records.trips.filter(x=>x.status==='active');
    body += `<section class="stats">${stat('Сырьё в системе',`${number(activeContainers.reduce((s,x)=>s+Number(x.wet_kg),0))} кг`,`${activeContainers.length} контейнеров`)}${stat('В пути',records.containers.filter(x=>['assigned','picked_up'].includes(x.status)).length)}${stat('Произведено',`${produced} уп.`)}${stat('Выручка',money(revenue),`${sold} уп. передано`)}</section><div class="overview-grid"><section class="card"><div class="card-head"><h2>Работа сегодня</h2></div><div class="flow-list"><div><span>Готово на точках</span><strong>${records.containers.filter(x=>x.status==='ready').length}</strong></div><div><span>Рейсы в работе</span><strong>${liveTrip.length}</strong></div><div><span>Ожидает приёмки</span><strong>${records.containers.filter(x=>x.status==='picked_up').length}</strong></div><div><span>Партии в производстве</span><strong>${records.batches.filter(x=>x.status!=='complete').length}</strong></div><div><span>Заказы продукта</span><strong>${records.sales.filter(x=>!['delivered','cancelled'].includes(x.delivery_status)).length}</strong></div></div></section><section class="card"><div class="card-head"><h2>Активные рейсы</h2>${button('Открыть карту','tab',`data-id="map"`,'btn-sm')}</div>${liveTrip.length?liveTrip.map(t=>`<div class="item"><div class="item-title">${esc(t.driver_name)}</div><div class="item-sub mono">${esc(t.code)} · ${records.containers.filter(c=>c.trip_id===t.id&&['assigned','picked_up'].includes(c.status)).length} заявок</div><div class="item-sub">${positionFor(t.id)?`GPS · ${dateTime(positionFor(t.id).updated_at)}`:'GPS не передан'}</div></div>`).join(''):empty('Рейсов нет','Новые рейсы появятся здесь.')}</section></div>`;
    body += mapWorkspace('manager');
  } else if (activeTab==='map') {
    body += mapWorkspace('manager');
  } else if (activeTab==='journal') {
    const allEvents=[...records.events].sort(byNewest);
    const events=journalFilter==='cancelled'?allEvents.filter(e=>e.entity==='gl_containers'&&e.action==='cancelled'):allEvents;
    body += `<section class="card"><div class="card-head"><h2>Журнал операций</h2><div class="journal-filters"><button class="tab ${journalFilter==='all'?'active':''}" data-action="journal-filter" data-id="all">Все</button><button class="tab ${journalFilter==='cancelled'?'active':''}" data-action="journal-filter" data-id="cancelled">Отмены</button></div></div>${events.length?events.slice(0,150).map(e=>`<div class="item"><div class="item-top"><div><div class="item-title">${esc(eventLabel(e.action,e.entity))}</div><div class="item-sub">${esc(e.actor_email||'Система')} · ${dateTime(e.created_at)}</div>${e.entity==='gl_containers'&&e.action==='cancelled'?`<div class="item-note">${esc(e.details?.after?.note||'Причина не указана')}</div>`:''}</div><span class="mono muted">${esc(e.details?.code||records.containers.find(x=>x.id===e.entity_id)?.code||records.trips.find(x=>x.id===e.entity_id)?.code||records.batches.find(x=>x.id===e.entity_id)?.code||'')}</span></div></div>`).join(''):empty('Записей нет','События появятся здесь.')}</section>`;
  } else if (activeTab==='staff') {
    body += `<div class="grid"><section class="card"><div class="card-head"><div><h2>Сотрудники</h2><p>Роль и точка определяют доступные действия</p></div></div>${[...records.staff].sort((a,b)=>a.full_name.localeCompare(b.full_name,'ru')).map(s=>`<div class="item"><div class="item-top"><div><div class="item-title">${esc(s.full_name)}</div><div class="item-sub">${esc(s.email)} · ${esc(pageNames[s.role])}${s.store_id?` · ${esc(storeName(s.store_id))}`:''}</div></div>${s.active?'<span class="badge">Активен</span>':'<span class="badge neutral">Отключён</span>'}</div><div class="item-actions">${button('Изменить','edit-staff',`data-id="${esc(s.email)}"`,'btn-sm')}</div></div>`).join('')||empty('Команда пуста','Пригласите первого сотрудника.')}</section><aside class="stack"><section class="card"><div class="card-head"><h2>Пригласить сотрудника</h2></div><div class="card-body"><form id="staffForm" class="form"><label class="field">Рабочая почта<input name="email" type="email" required autocomplete="off"></label><label class="field">Имя и фамилия<input name="full_name" required minlength="2" maxlength="100"></label><label class="field">Роль<select name="role"><option value="barista">Бариста</option><option value="logistics">Логистика</option><option value="production">Производство</option><option value="manager">Управление</option></select></label><label class="field">Точка бариста<select name="store_id"><option value="">Выберите точку</option>${records.stores.filter(x=>x.active).map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label><button class="btn btn-primary" type="submit">Отправить приглашение</button></form></div></section><div class="notice">Только администратор приглашает сотрудников. После подтверждения почты сотрудник задаёт собственный пароль.</div></aside></div>`;
  } else if (activeTab==='stores') {
    body += `<div class="grid"><section class="card"><div class="card-head"><div><h2>Точки сбора</h2><p>Адреса вывоза и назначение бариста</p></div></div>${[...records.stores].sort((a,b)=>a.name.localeCompare(b.name,'ru')).map(s=>`<div class="item"><div class="item-top"><div><div class="item-title">${esc(s.name)}</div><div class="item-sub">${esc(s.address||'Адрес вывоза не указан')}${s.district?` · ${esc(s.district)}`:''}</div></div>${s.active?'<span class="badge">Активна</span>':'<span class="badge neutral">Отключена</span>'}</div><div class="item-actions">${button('Изменить','edit-store',`data-id="${esc(s.id)}"`,'btn-sm')}</div></div>`).join('')||empty('Точек пока нет','Добавьте первую точку.')}</section><aside class="stack"><section class="card"><div class="card-head"><h2>Добавить точку</h2></div><div class="card-body"><form id="storeForm" class="form"><label class="field">Название точки<input name="name" required maxlength="120" placeholder="Global Coffee — название"></label><label class="field">Адрес вывоза<input name="address" required maxlength="200" placeholder="Город, улица, дом"></label><label class="field">Район<input name="district" maxlength="160"></label><button class="btn btn-primary" type="submit">Добавить точку</button></form></div></section></aside></div>`;
  } else if (activeTab==='sales') {
    const available=records.batches.filter(b=>b.status==='complete'&&b.produced_packs-records.sales.filter(s=>s.batch_id===b.id&&s.delivery_status!=='cancelled').reduce((sum,s)=>sum+s.packs,0)>0);
    const current=records.sales.filter(x=>!['delivered','cancelled'].includes(x.delivery_status)).sort(byNewest);
    const history=records.sales.filter(x=>['delivered','cancelled'].includes(x.delivery_status)).sort(byNewest);
    body += `<section class="stats compact-stats">${stat('Готово',`${produced} уп.`)}${stat('Зарезервировано',`${reserved-sold} уп.`)}${stat('Передано',`${sold} уп.`)}${stat('Выручка',money(revenue))}</section><div class="grid"><section class="card"><div class="card-head"><h2>Заявки на продукт</h2></div>${current.length?current.map(x=>productOrderItem(x,'manager')).join(''):empty('Активных заявок нет','Создайте заявку из готовой партии.')}<div class="card-head"><h2>История передач</h2></div>${history.length?history.slice(0,25).map(x=>productOrderItem(x,'manager')).join(''):empty('Передач пока нет','Подтверждённые передачи появятся здесь.')}</section><aside class="card"><div class="card-head"><h2>Новая заявка</h2></div><div class="card-body"><form id="saleForm" class="form"><label class="field">Покупатель<input name="customer_name" required minlength="2" maxlength="120" placeholder="Компания или имя"></label><label class="field">Готовая партия<select name="batch_id" required>${available.map(b=>`<option value="${b.id}">${esc(b.code)} · ${b.produced_packs-records.sales.filter(s=>s.batch_id===b.id&&s.delivery_status!=='cancelled').reduce((sum,s)=>sum+s.packs,0)} уп.</option>`).join('')}</select></label><label class="field">Упаковок<input name="packs" type="number" min="1" step="1" inputmode="numeric" required></label><label class="field">Цена за упаковку, ₸<input name="unit_price" type="number" min="0" step="1" inputmode="numeric" required></label><label class="field">Передача<select name="fulfillment"><option value="pickup">Самовывоз</option><option value="delivery">Доставка логистом</option></select></label><label class="field">Адрес доставки<input name="delivery_address" maxlength="200" placeholder="Город, улица, дом"></label><input type="hidden" name="latitude"><input type="hidden" name="longitude"><button class="btn" type="button" data-action="delivery-pin">Указать точку доставки на карте</button><label class="field">Канал<select name="channel"><option>Кофейня</option><option>Партнёрская точка</option><option>Прямой заказ</option></select></label><button class="btn btn-primary" type="submit" ${available.length?'':'disabled'}>Создать заявку</button></form></div></aside></div>`;
  }
  shell(({overview:'Операционный обзор',map:'Карта рейсов',sales:'Заказы продукта',journal:'Журнал операций',staff:'Команда',stores:'Точки сбора'})[activeTab], '', '', body);
  if(activeTab==='overview'){
    const main=app.querySelector('.workspace-main');
    const stats=main?.querySelector(':scope > .stats');
    const map=main?.querySelector(':scope > .map-layout');
    if(stats&&map)stats.after(map);
  }
}
function eventLabel(action, entity) { const subject=({gl_containers:'Заявка',gl_trips:'Рейс',gl_batches:'Партия',gl_sales:'Продукт'})[entity]||'Операция'; return `${subject}: ${({created:'создано',updated:'исправлено',ready:'готово',hold:'удержано',rejected:'отклонено',cancelled:'отменено',assigned:'назначено',picked_up:'вывоз подтверждён',received:'принято в цех',batched:'включено в партию',drying:'сушка начата',production:'вес подтверждён',complete:'выпуск завершён',completed:'завершён',out_for_delivery:'в доставке',delivered:'передано покупателю'})[action]||action}`; }
function render() { if (!staff) return; if (staff.role==='barista') renderBarista(); else if (staff.role==='logistics') renderLogistics(); else if (staff.role==='production') renderProduction(); else renderManagement(); }

function staffEditDialog(member) {
  const dialog=modal('Изменить доступ',`<form id="editStaffForm" class="form"><div class="notice">${esc(member.email)}</div><label class="field">Имя и фамилия<input name="full_name" required minlength="2" maxlength="100" value="${esc(member.full_name)}"></label><label class="field">Роль<select name="role">${Object.entries(pageNames).map(([id,name])=>`<option value="${id}" ${member.role===id?'selected':''}>${name}</option>`).join('')}</select></label><label class="field">Точка<select name="store_id"><option value="">Без точки</option>${records.stores.map(s=>`<option value="${esc(s.id)}" ${member.store_id===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><label class="checkrow"><input name="active" type="checkbox" ${member.active?'checked':''}><span>Доступ активен</span></label><div class="form-actions"><button class="btn" type="button" data-action="close-modal">Отмена</button><button class="btn btn-primary" type="submit">Сохранить</button></div></form>`);
  dialog.querySelector('#editStaffForm').addEventListener('submit',event=>{
    event.preventDefault();const f=event.currentTarget;const role=f.elements.role.value,store=role==='barista'?f.elements.store_id.value||null:null;
    if(role==='barista'&&!store)return toast('Бариста нужна точка');
    void run(async()=>checked(await supabase.from('gl_staff').update({full_name:f.elements.full_name.value.trim(),role,store_id:store,active:f.elements.active.checked}).eq('email',member.email).select().single()),'Доступ обновлён');
  });
}
function storeEditDialog(store) {
  const dialog=modal('Изменить точку',`<form id="editStoreForm" class="form"><label class="field">Название точки<input name="name" required maxlength="120" value="${esc(store.name)}"></label><label class="field">Адрес вывоза<input name="address" required maxlength="200" value="${esc(store.address||'')}"></label><label class="field">Район<input name="district" maxlength="160" value="${esc(store.district||'')}"></label><div class="field"><span>Точка на карте</span><div id="storePickMap" class="store-pick-map"></div><small>Нажмите на место входа в кофейню</small></div><input name="latitude" type="hidden" value="${esc(store.latitude??'')}"><input name="longitude" type="hidden" value="${esc(store.longitude??'')}"><label class="checkrow"><input name="active" type="checkbox" ${store.active?'checked':''}><span>Точка активна</span></label><div class="form-actions"><button class="btn" type="button" data-action="close-modal">Отмена</button><button class="btn btn-primary" type="submit">Сохранить</button></div></form>`);
  mountStorePicker(dialog,store.latitude,store.longitude);
  dialog.querySelector('#editStoreForm').addEventListener('submit',event=>{
    event.preventDefault();const f=event.currentTarget;
    void run(async()=>checked(await supabase.from('gl_stores').update({name:f.elements.name.value.trim(),address:f.elements.address.value.trim(),district:f.elements.district.value.trim(),latitude:f.elements.latitude.value?Number(f.elements.latitude.value):null,longitude:f.elements.longitude.value?Number(f.elements.longitude.value):null,active:f.elements.active.checked}).eq('id',store.id).select().single()),'Точка обновлена');
  });
}
function mountStorePicker(dialog,latitude,longitude) {
  requestAnimationFrame(()=>{
    if(!dialog.open)return;
    const point=mapPoint(latitude,longitude);
    const map=L.map(dialog.querySelector('#storePickMap'),{scrollWheelZoom:false}).setView(point||[42.323,69.595],point?16:12);
    basemap(map);
    let pin=point?L.circleMarker(point,{radius:9,color:'#176944',fillColor:'#56a87b',fillOpacity:1}).addTo(map):null;
    map.on('click',event=>{
      const {lat,lng}=event.latlng;
      dialog.querySelector('[name=latitude]').value=lat.toFixed(7);
      dialog.querySelector('[name=longitude]').value=lng.toFixed(7);
      if(pin)pin.setLatLng([lat,lng]);else pin=L.circleMarker([lat,lng],{radius:9,color:'#176944',fillColor:'#56a87b',fillOpacity:1}).addTo(map);
    });
    setTimeout(()=>map.invalidateSize(),100);
    dialog.addEventListener('close',()=>map.remove(),{once:true});
  });
}
function deliveryPinDialog() {
  const form=document.querySelector('#saleForm');
  if(!form)return;
  const current=mapPoint(form.elements.latitude.value||null,form.elements.longitude.value||null);
  const dialog=modal('Точка доставки',`<div id="deliveryPickMap" class="store-pick-map"></div><p class="scan-hint">Отметьте вход или место передачи товара на карте.</p><div class="form-actions"><button class="btn" type="button" data-action="close-modal">Отмена</button><button class="btn btn-primary" id="saveDeliveryPin" type="button" disabled>Сохранить точку</button></div>`);
  requestAnimationFrame(()=>{
    if(!dialog.open)return;
    const map=L.map(dialog.querySelector('#deliveryPickMap'),{scrollWheelZoom:false}).setView(current||[42.323,69.595],current?16:12);
    basemap(map);
    let point=current;
    let pin=point?L.circleMarker(point,{radius:9,color:'#176944',fillColor:'#56a87b',fillOpacity:1}).addTo(map):null;
    if(point)dialog.querySelector('#saveDeliveryPin').disabled=false;
    map.on('click',event=>{
      point=[event.latlng.lat,event.latlng.lng];
      if(pin)pin.setLatLng(point);else pin=L.circleMarker(point,{radius:9,color:'#176944',fillColor:'#56a87b',fillOpacity:1}).addTo(map);
      dialog.querySelector('#saveDeliveryPin').disabled=false;
    });
    dialog.querySelector('#saveDeliveryPin').addEventListener('click',()=>{
      if(!point)return;
      form.elements.latitude.value=point[0].toFixed(7);
      form.elements.longitude.value=point[1].toFixed(7);
      form.querySelector('[data-action=delivery-pin]').textContent='Точка доставки отмечена';
      closeModal();
    });
    setTimeout(()=>map.invalidateSize(),100);
    dialog.addEventListener('close',()=>map.remove(),{once:true});
  });
}
async function action(event) {
  const el=event.target.closest('[data-action]');
  if (!el) return;
  const {action: name,id}=el.dataset;
  if (name==='close-modal') return closeModal();
  if (name==='map-style' && ['streets','imagery'].includes(id) && activeMap) { mapStyle=id; localStorage.setItem('gl_map_style',id); if(activeBaseLayer)activeMap.removeLayer(activeBaseLayer); activeBaseLayer=basemap(activeMap,id); document.querySelectorAll('.map-style').forEach(x=>x.classList.toggle('selected',x.dataset.id===id)); return; }
  if (name==='focus-map' && activeMap) { const point=mapPoint(el.dataset.lat,el.dataset.lon); if(point)activeMap.flyTo(point,16,{duration:.35}); return; }
  if (name==='reload') return location.reload();
  if (name==='link-login') return loginScreen('link');
  if (name==='password-login') return loginScreen();
  if (name==='logout') { stopGpsOnLogout(); await supabase.auth.signOut(); location.replace(link('index.html')); return; }
  if (!staff) return;
  if (name==='delivery-pin' && staff.role==='manager') return deliveryPinDialog();
  if (name==='journal-filter' && staff.role==='manager' && ['all','cancelled'].includes(id)) { journalFilter=id; render(); return; }
  if (name==='tab') {
    const allowed={barista:['requests','map','archive'],logistics:['requests','map','deliveries','archive'],production:['intake','batches','dispatch','archive'],manager:['overview','map','sales','journal','staff','stores']}[staff.role];
    if(allowed.includes(id)&&(staff.role!=='manager'||staff.can_manage_access||!['staff','stores'].includes(id))){activeTab=id;render();}
    return;
  }
  if(name==='select-map-trip'){selectedMapTrip=id;render();return;}
  if(name==='dismiss-notice'&&staff.role==='logistics'){
    const key=`gl_seen_notices_${user.id}`,seen=new Set(JSON.parse(localStorage.getItem(key)||'[]'));
    seen.add(id);localStorage.setItem(key,JSON.stringify([...seen].slice(-100)));render();return;
  }
  if (name==='print-code') { window.print(); return; }
  const item=records.containers.find(x=>x.id===id);
  const batch=records.batches.find(x=>x.id===id);
  const order=records.sales.find(x=>x.id===id);
  if (staff.role==='barista') {
    if (name==='new-container') return openContainerForm();
    if (name==='qr'&&item) return void qrDialog(item);
    if (name==='edit-container'&&item&&item.created_by===user.id) return openContainerForm(item);
    if (name==='cancel-container'&&item&&item.created_by===user.id) return cancelContainer(item);
  }
  if (staff.role==='logistics') {
    if (name==='start-trip') return void run(async()=>checked(await supabase.from('gl_trips').insert({}).select().single()),'Рейс начат');
    if (name==='finish-trip') {const trip=myTrip();if(!trip)return;return void run(async()=>{checked(await supabase.from('gl_trips').update({status:'completed'}).eq('id',trip.id).eq('status','active').select().single());stopGpsOnLogout();},'Рейс завершён');}
    if (name==='start-gps') return void startGps();
    if (name==='stop-gps') return stopGps();
    if (name==='assign'&&item&&myTrip()) return void run(async()=>checked(await supabase.from('gl_containers').update({status:'assigned',trip_id:myTrip().id}).eq('id',item.id).eq('status','ready').select().single()),'Контейнер добавлен в рейс');
    if (name==='unassign'&&item) return void run(async()=>checked(await supabase.from('gl_containers').update({status:'ready',trip_id:null}).eq('id',item.id).eq('status','assigned').select().single()),'Контейнер убран из рейса');
    if (name==='pickup'&&item) return void scanDialog(item,'pickup');
    if (name==='undo-pickup'&&item) return void run(async()=>checked(await supabase.from('gl_containers').update({status:'assigned',pickup_code:null}).eq('id',item.id).eq('status','picked_up').select().single()),'Вывоз отменён');
    if (name==='claim-delivery'&&order) return void run(async()=>checked(await supabase.from('gl_sales').update({delivery_status:'assigned'}).eq('id',order.id).eq('delivery_status','ready').select().single()),'Доставка взята');
    if (name==='release-delivery'&&order) return void run(async()=>checked(await supabase.from('gl_sales').update({delivery_status:'ready'}).eq('id',order.id).eq('delivery_status','assigned').select().single()),'Доставка возвращена в очередь');
    if (name==='scan-product'&&order) return void productScanDialog(order);
    if (name==='complete-delivery'&&order) return productHandoverDialog(order);
  }
  if (staff.role==='production') {
    if (name==='receive'&&item) return void scanDialog(item,'receive');
    if (name==='undo-receive'&&item) return void run(async()=>checked(await supabase.from('gl_containers').update({status:'picked_up',receipt_code:null}).eq('id',item.id).eq('status','received').select().single()),'Приёмка отменена');
    if (name==='new-batch') return newBatchDialog();
    if (name==='start-drying'&&batch) return void run(async()=>checked(await supabase.from('gl_batches').update({status:'drying'}).eq('id',batch.id).eq('status','received').select().single()),'Сушка начата');
    if (name==='dry-weight'&&batch) return stageDialog(batch,'dry-weight');
    if (name==='pack-output'&&batch) return stageDialog(batch,'pack-output');
    if (name==='product-qr'&&order) return void productQrDialog(order);
  }
  if (staff.role==='manager'&&order) {
    if(name==='complete-pickup')return productHandoverDialog(order,true);
    if(name==='cancel-product-order')return void run(async()=>checked(await supabase.from('gl_sales').update({delivery_status:'cancelled'}).eq('id',order.id).eq('delivery_status','ready').select().single()),'Заявка отменена');
  }
  if (staff.role==='manager'&&staff.can_manage_access&&name==='edit-staff') {const member=records.staff.find(x=>x.email===id);if(member)return staffEditDialog(member);}
  if (staff.role==='manager'&&staff.can_manage_access&&name==='edit-store') {const store=records.stores.find(x=>x.id===id);if(store)return storeEditDialog(store);}
}
function stopGpsOnLogout() { if (watchId!==null&&navigator.geolocation) navigator.geolocation.clearWatch(watchId); watchId=null; }
document.addEventListener('click',event=>{void action(event);});
document.addEventListener('change',event=>{if(event.target.name==='fulfillment')syncDeliveryField();});
document.addEventListener('submit',event=>{
  if (event.target.id==='loginForm') {
    event.preventDefault();
    const email=event.target.elements.email.value.trim().toLowerCase();
    const password=event.target.elements.password.value;
    if(!email||!password)return;
    void (async()=>{try{checked(await supabase.auth.signInWithPassword({email,password}));await boot();}catch(error){toast(error.message||'Неверная почта или пароль');}})();
  }
  if (event.target.id==='setPasswordForm') {
    event.preventDefault();const f=event.target;
    const password=f.elements.password.value;
    if(password.length<10||password!==f.elements.confirm.value)return toast('Пароли должны совпадать и содержать не меньше 10 символов');
    void (async()=>{try{checked(await supabase.auth.updateUser({password,data:{groundloop_needs_password:false}}));await boot();}catch(error){toast(error.message||'Пароль не сохранён');}})();
  }
  if (event.target.id==='linkForm') {
    event.preventDefault();const email=event.target.elements.email.value.trim().toLowerCase();
    if(!email)return;
    void (async()=>{try{checked(await supabase.auth.signInWithOtp({email,options:{shouldCreateUser:false,emailRedirectTo:new URL('./',location.href).href}}));authScreen('Проверьте почту',`Если адрес есть в команде, ссылка для входа отправлена на ${email}.`,`<button class="btn" data-action="reload">Ввести другую почту</button>`);}catch(error){toast(error.message);}})();
  }
  if (event.target.id==='staffForm'&&staff?.role==='manager'&&staff.can_manage_access) {
    event.preventDefault();const f=event.target;const role=f.elements.role.value,store=f.elements.store_id.value||null;
    if(role==='barista'&&!store)return toast('Для бариста выберите точку');
    void run(async()=>{const {data,error}=await supabase.functions.invoke('groundloop-invite',{body:{email:f.elements.email.value.trim().toLowerCase(),full_name:f.elements.full_name.value.trim(),role,store_id:role==='barista'?store:null}});if(error){let message=error.message;try{message=(await error.context.json()).message||message;}catch{}throw new Error(message);}if(!data?.message)throw new Error('Сервер не подтвердил приглашение');},'Приглашение отправлено');
  }
  if (event.target.id==='storeForm'&&staff?.role==='manager'&&staff.can_manage_access) {
    event.preventDefault();const f=event.target;
    void run(async()=>checked(await supabase.from('gl_stores').insert({id:crypto.randomUUID(),name:f.elements.name.value.trim(),address:f.elements.address.value.trim(),district:f.elements.district.value.trim(),active:true}).select().single()),'Точка добавлена');
  }
  if (event.target.id==='saleForm'&&staff?.role==='manager') {
    event.preventDefault();const f=event.target;
    const fulfillment=f.elements.fulfillment.value;
    const address=f.elements.delivery_address.value.trim();
    if(fulfillment==='delivery'&&address.length<5)return toast('Укажите адрес доставки');
    if(fulfillment==='delivery'&&(!f.elements.latitude.value||!f.elements.longitude.value))return toast('Отметьте точку доставки на карте');
    void run(async()=>checked(await supabase.from('gl_sales').insert({batch_id:f.elements.batch_id.value,packs:Number(f.elements.packs.value),unit_price:Number(f.elements.unit_price.value),customer_name:f.elements.customer_name.value.trim(),fulfillment,delivery_address:fulfillment==='delivery'?address:null,latitude:fulfillment==='delivery'?Number(f.elements.latitude.value):null,longitude:fulfillment==='delivery'?Number(f.elements.longitude.value):null,channel:f.elements.channel.value}).select().single()),'Заявка на продукт создана');
  }
});
void boot().catch(error=>{console.error(error);authScreen('Не удалось открыть сайт',error.message,'<button class="btn" data-action="reload">Повторить</button>');});
