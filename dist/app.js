import {
  STORAGE_KEY,
  SCENARIOS,
  buildPickupRoute,
  batchStock,
  calculateDryOutput,
  calculateEconomics,
  calculatePackOutput,
  estimateWetGroundsKg,
  formatMoney,
  formatNumber,
  normalizeImportedRows,
  mergeWorkspaceState,
  sameValue,
  parseCsv,
  round,
  validateSaleDraft,
} from "./logic.js";
import { cloudEnabled, openDemoSession, readWorkspace, createWorkspace, updateWorkspace } from "./cloud.js";

const TODAY = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Qyzylorda", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dayAgo = (days) => new Date(Date.parse(`${TODAY}T12:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
const viewMeta = {
  overview: "Смена и задачи",
  collections: "Сбор на точках",
  logistics: "Логистика",
  production: "Производство",
  economics: "Экономика",
  traceability: "Продукт и партия",
  data: "Данные",
};
const ROLE_VIEWS = {
  manager: ["overview", "collections", "logistics", "production", "economics", "traceability", "data"],
  barista: ["collections"],
  logistics: ["logistics", "collections"],
  production: ["production", "traceability"],
};
const ROLE_ACTIONS = {
  barista: new Set(["open-collection"]),
  logistics: new Set(["create-route", "pickup-stop"]),
  production: new Set(["create-batch", "advance-batch", "select-batch"]),
};
let activeRole = ROLE_VIEWS[localStorage.getItem("groundloop_role")] ? localStorage.getItem("groundloop_role") : "manager";
let activeStoreId = localStorage.getItem("groundloop_store") || "GC-01";
function may(action) { return activeRole === "manager" || ROLE_ACTIONS[activeRole]?.has(action); }
function canView(view) { return ROLE_VIEWS[activeRole]?.includes(view); }

function seedState() {
  const stores = [
    ["GC-01", "Global Coffee — Абая", "Центр", 245, true],
    ["GC-02", "Global Coffee — Достык", "Медеуский", 218, true],
    ["GC-03", "Global Coffee — Mega", "Бостандыкский", 332, true],
    ["GC-04", "Global Coffee — Арбат", "Центр", 286, true],
    ["GC-05", "Global Coffee — Назарбаева", "Медеуский", 194, true],
    ["GC-06", "Global Coffee — Esentai", "Бостандыкский", 308, true],
    ["GC-07", "Global Coffee — Forum", "Бостандыкский", 177, false],
    ["GC-08", "Global Coffee — Атакент", "Бостандыкский", 163, false],
    ["GC-09", "Global Coffee — Сейфуллина", "Алмалинский", 154, false],
    ["GC-10", "Global Coffee — Жарокова", "Бостандыкский", 149, false],
    ["GC-11", "Global Coffee — Орбита", "Бостандыкский", 137, false],
    ["GC-12", "Global Coffee — Самал", "Медеуский", 172, false],
    ["GC-13", "Global Coffee — Толе би", "Алмалинский", 158, false],
    ["GC-14", "Global Coffee — Розыбакиева", "Бостандыкский", 144, false],
    ["GC-15", "Global Coffee — Гагарина", "Бостандыкский", 151, false],
    ["GC-16", "Global Coffee — Навои", "Бостандыкский", 132, false],
    ["GC-17", "Global Coffee — Кок-Тобе", "Медеуский", 118, false],
    ["GC-18", "Global Coffee — Almaty Mall", "Алатауский", 129, false],
  ].map(([id, name, district, avgCups, active]) => ({ id, name, district, avgCups, active }));

  const records = [
    ["COL-101", "GC-01", TODAY, 238, 7.7, "ready", "good", "measured"],
    ["COL-102", "GC-02", TODAY, 211, 6.8, "ready", "good", "measured"],
    ["COL-103", "GC-03", TODAY, 326, 10.4, "review", "pending", "estimated"],
    ["COL-104", "GC-04", dayAgo(1), 279, 8.9, "ready", "good", "measured"],
    ["COL-105", "GC-05", dayAgo(1), 187, 6.0, "collected", "good", "estimated"],
    ["COL-106", "GC-06", dayAgo(1), 301, 9.6, "collected", "good", "measured"],
    ["COL-107", "GC-01", dayAgo(2), 247, 7.9, "collected", "good", "measured"],
    ["COL-108", "GC-03", dayAgo(2), 319, 10.2, "collected", "good", "estimated"],
    ["COL-109", "GC-04", dayAgo(2), 291, 9.3, "collected", "good", "measured"],
    ["COL-110", "GC-02", dayAgo(3), 205, 6.6, "rejected", "rejected", "measured"],
  ].map(([id, storeId, date, cups, wetKg, status, quality, weightSource]) => ({
    id, storeId, date, cups, wetKg, status, quality, weightSource, source: "synthetic", note: "",
    containerCode: `${storeId}-${date.replaceAll("-", "")}`,
    storedAt: `${date}T09:00:00+05:00`,
  }));

  return {
    version: 1,
    currentView: "overview",
    scenario: "base",
    dataMode: "synthetic",
    stores,
    collections: records,
    routes: [
      {
        id: "RT-2026-1105",
        date: dayAgo(1),
        status: "completed",
        collectionIds: ["COL-105", "COL-106", "COL-107", "COL-108", "COL-109"],
        distanceKm: 18.4,
        estimatedMinutes: 96,
      },
    ],
    batches: [
      {
        id: "GL-261104-A",
        createdAt: dayAgo(2),
        collectionIds: ["COL-107", "COL-108", "COL-109"],
        sourceStores: ["GC-01", "GC-03", "GC-04"],
        wetKg: 27.4,
        dryYieldPct: 50,
        rejectPct: 8,
        driedKg: 13.7,
        acceptedKg: 12.6,
        status: "complete",
        groundsPerPackG: 160,
        producedPacks: 78,
        recipe: "R-01 / жмых + бумажное волокно + связующее",
      },
      {
        id: "GL-261105-B",
        createdAt: dayAgo(1),
        collectionIds: ["COL-105", "COL-106"],
        sourceStores: ["GC-05", "GC-06"],
        wetKg: 15.6,
        dryYieldPct: 50,
        rejectPct: 8,
        driedKg: 7.8,
        acceptedKg: 7.18,
        status: "drying",
        groundsPerPackG: 160,
        producedPacks: 0,
        recipe: "R-01 / кофейный композит",
      },
    ],
    productionRuns: [
      { id: "PR-001", batchId: "GL-261104-A", date: dayAgo(1), producedPacks: 78, status: "complete" },
    ],
    sales: [
      { id: "SL-001", batchId: "GL-261104-A", date: TODAY, packs: 24, unitPrice: 1800, channel: "Кофейня", source: "synthetic" },
    ],
    selectedBatchId: "GL-261104-A",
    economicsParams: {
      activeStores: 6,
      cupsPerStoreDay: 247,
      daysPerMonth: 30,
      groundsPerPackG: 160,
      ...SCENARIOS.base,
    },
    lastImport: null,
  };
}

function loadState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return seedState();
    const parsed = JSON.parse(stored);
    return hydrateState(parsed);
  } catch {
    return seedState();
  }
}

function hydrateState(raw) {
  const baseline = seedState();
  const next = { ...baseline, ...raw, economicsParams: { ...baseline.economicsParams, ...(raw?.economicsParams || {}) } };
  for (const key of ["stores", "collections", "routes", "batches", "productionRuns", "sales"]) {
    if (!Array.isArray(next[key])) next[key] = baseline[key];
  }
  if (!SCENARIOS[next.scenario]) next.scenario = "base";
  if (!viewMeta[next.currentView]) next.currentView = "overview";
  return next;
}

let state = loadState();
let toastTimer;
let cloudUser = null;
let cloudRevision = 0;
let saveQueue = Promise.resolve();
let cloudSaveBlocked = false;
let cloudBaseState = null;
let lastQueuedState = null;
let refreshInFlight = false;

const contentArea = document.querySelector("#contentArea");
const viewTitle = document.querySelector("#viewTitle");
const collectionDialog = document.querySelector("#collectionDialog");
const collectionForm = document.querySelector("#collectionForm");
const collectionStore = document.querySelector("#collectionStore");
const collectionDate = document.querySelector("#collectionDate");
const saleDialog = document.querySelector("#saleDialog");
const saleForm = document.querySelector("#saleForm");
const saleBatch = document.querySelector("#saleBatch");
const stageDialog = document.querySelector("#stageDialog");
const stageForm = document.querySelector("#stageForm");
const toast = document.querySelector("#toast");

function saveState() {
  if (!cloudEnabled) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return;
  }
  if (!cloudUser || cloudSaveBlocked) return;
  const snapshot = structuredClone(state);
  snapshot.currentView = "overview";
  snapshot.selectedBatchId = cloudBaseState?.selectedBatchId || snapshot.selectedBatchId;
  const before = lastQueuedState || cloudBaseState;
  if (sameValue(before, snapshot)) return;
  lastQueuedState = structuredClone(snapshot);
  document.querySelector("#syncStatus").textContent = "Сохранение…";
  saveQueue = saveQueue.then(async () => {
    if (cloudSaveBlocked) return;
    let merged = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = mergeWorkspaceState(before, snapshot, cloudBaseState);
      try {
        const revision = await updateWorkspace(candidate, cloudRevision, cloudUser.id);
        cloudRevision = revision;
        cloudBaseState = structuredClone(candidate);
        if (lastQueuedState === snapshot || sameValue(lastQueuedState, snapshot)) {
          const currentSnapshot = structuredClone(state);
          currentSnapshot.currentView = "overview";
          currentSnapshot.selectedBatchId = snapshot.selectedBatchId;
          if (sameValue(currentSnapshot, snapshot) && !sameValue(candidate, snapshot)) {
            const currentView = state.currentView;
            const selectedBatchId = state.selectedBatchId;
            state = hydrateState({ ...candidate, currentView, selectedBatchId });
            render();
          }
        }
        document.querySelector("#syncStatus").textContent = merged ? "Объединено и сохранено" : "Сохранено";
        return;
      } catch (error) {
        if (error.code !== "conflict" || attempt === 2) throw error;
        const remote = await readWorkspace(cloudUser.id);
        if (!remote) throw new Error("Рабочее пространство недоступно");
        cloudRevision = remote.revision;
        cloudBaseState = structuredClone(remote.state);
        cloudBaseState.currentView = "overview";
        cloudBaseState.selectedBatchId = before.selectedBatchId;
        merged = true;
      }
    }
  }).catch((error) => {
    cloudSaveBlocked = true;
    document.querySelector("#syncStatus").textContent = "Не сохранено · обновите данные";
    render();
    showToast(`${error.message}. Обновите данные перед продолжением.`);
  });
  return saveQueue;
}

function h(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function storeFor(id) {
  return state.stores.find((store) => store.id === id);
}

function statusLabel(status) {
  return ({
    ready: "Готов к вывозу",
    review: "На проверке",
    scheduled: "В маршруте",
    collected: "Собрано",
    rejected: "Отклонено",
    completed: "Завершён",
    planned: "Запланирован",
    received: "Принято",
    drying: "Сушка",
    production: "Формование",
    complete: "Готово",
  })[status] || status;
}

function qualityLabel(quality) {
  return ({ good: "Проверено", pending: "На проверке", rejected: "Брак" })[quality] || quality;
}

function sourceLabel(source) {
  return source === "measured" ? "Измерено" : "Оценка";
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" }).format(date);
}

function storageLabel(item) {
  if (!item.storedAt || ["collected", "rejected"].includes(item.status)) return "";
  const hours = Math.max(0, Math.floor((Date.now() - Date.parse(item.storedAt)) / 3600000));
  return `${h(item.containerCode || "контейнер без кода")} · ${hours} ч на точке${hours >= 24 ? " · нужен вывоз" : ""}`;
}

function syntheticNotice() {
  return "";
}

function renderKpis(metrics) {
  return `
    <div class="metrics-strip">
      <article class="metric"><div class="kpi-label">Активные точки</div><div class="kpi-value">${metrics.activeStores}</div><div class="kpi-footer">из ${state.stores.length} точек сети</div></article>
      <article class="metric"><div class="kpi-label">Учтено за цикл</div><div class="kpi-value">${formatNumber(metrics.wetKg, 1)} <small>кг</small></div><div class="kpi-footer">${metrics.measuredPct}% взвешено</div></article>
      <article class="metric metric-attention"><div class="kpi-label">К вывозу</div><div class="kpi-value">${formatNumber(metrics.readyKg, 1)} <small>кг</small></div><div class="kpi-footer">${metrics.readyCount} готовых контейнера</div></article>
      <article class="metric"><div class="kpi-label">Модельная прибыль</div><div class="kpi-value">${formatMoney(metrics.economics.profit)}</div><div class="kpi-footer">${metrics.economics.marginPct}% · ${SCENARIOS[state.scenario].label.toLowerCase()} расчёт</div></article>
    </div>`;
}

function dashboardMetrics() {
  const relevant = state.collections.filter((item) => item.status !== "rejected");
  const wetKg = relevant.reduce((sum, item) => sum + Number(item.wetKg || 0), 0);
  const ready = relevant.filter((item) => item.status === "ready" && item.quality === "good");
  const measured = relevant.filter((item) => item.weightSource === "measured").length;
  const active = state.stores.filter((store) => store.active);
  const economics = calculateEconomics(state.economicsParams);
  return {
    activeStores: active.length,
    wetKg,
    readyKg: ready.reduce((sum, item) => sum + Number(item.wetKg || 0), 0),
    readyCount: ready.length,
    measuredPct: relevant.length ? Math.round((measured / relevant.length) * 100) : 0,
    economics,
  };
}
function readyForBatch(item) {
  const route = state.routes.find((entry) => entry.collectionIds.includes(item.id));
  return item.status === "collected" && route?.status === "completed"
    && !item.batchId && !state.batches.some((batch) => batch.collectionIds.includes(item.id));
}

function renderOverview() {
  const metrics = dashboardMetrics();
  const recent = [...state.collections].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const workflowWet = round(state.collections.filter((x) => x.status !== "rejected" && x.quality === "good").reduce((s, x) => s + x.wetKg, 0), 1);
  const workflowDry = calculateDryOutput(workflowWet, state.economicsParams.dryYieldPct, state.economicsParams.rejectPct);
  const packs = calculatePackOutput(workflowDry.acceptedKg, state.economicsParams.groundsPerPackG, 100);
  const pendingQuality = state.collections.filter((x) => x.quality === "pending").length;
  const activeRoutes = state.routes.filter((x) => x.status === "planned").length;
  const unbatched = state.collections.filter(readyForBatch);
  const activeStores = state.stores.filter((store) => store.active);
  return `
    <div class="view-stack">
      ${syntheticNotice()}
      ${renderKpis(metrics)}
      <section class="operations-grid">
        <article class="panel flow-panel">
          <div class="panel-header"><div><h2>Поток материала</h2></div><span class="panel-meta">Оценка</span></div>
          <div class="material-flow">
            <div class="material-stage"><span class="stage-index">01</span><div><small>На точках</small><strong>${formatNumber(workflowWet, 1)} кг</strong><p>Мокрый жмых</p></div></div>
            <span class="route-connector"></span>
            <div class="material-stage"><span class="stage-index">02</span><div><small>После сушки</small><strong>${formatNumber(workflowDry.driedKg, 1)} кг</strong><p>${formatNumber(state.economicsParams.dryYieldPct)}% выхода</p></div></div>
            <span class="route-connector"></span>
            <div class="material-stage"><span class="stage-index">03</span><div><small>Принято</small><strong>${formatNumber(workflowDry.acceptedKg, 1)} кг</strong><p>После контроля</p></div></div>
            <span class="route-connector"></span>
            <div class="material-stage material-stage-final"><span class="stage-index">04</span><div><small>Потенциал</small><strong>${packs.producedPacks} уп.</strong><p>По ${formatNumber(state.economicsParams.groundsPerPackG)} г жмыха</p></div></div>
          </div>
        </article>
        <article class="panel attention-panel">
          <div class="panel-header"><div><h2>Задачи</h2></div><span class="attention-count">${metrics.readyCount + pendingQuality + activeRoutes}</span></div>
          <div class="action-list">
            <button class="action-row" data-view-link="logistics"><span class="action-mark urgent"></span><div><strong>Вывоз · ${metrics.readyCount}</strong><small>${formatNumber(metrics.readyKg, 1)} кг</small></div><span class="row-arrow">→</span></button>
            <button class="action-row" data-view-link="collections"><span class="action-mark review"></span><div><strong>Проверка · ${pendingQuality}</strong></div><span class="row-arrow">→</span></button>
            <button class="action-row" data-view-link="production"><span class="action-mark neutral"></span><div><strong>Без партии · ${unbatched.length}</strong></div><span class="row-arrow">→</span></button>
          </div>
        </article>
      </section>
      <section class="operations-grid lower-grid">
        <article class="panel">
          <div class="panel-header"><div><h2>Последние записи</h2></div><button class="button button-ghost button-small" data-view-link="collections">Все записи</button></div>
          <div class="table-wrap"><table><thead><tr><th>Точка</th><th>Дата</th><th>Напитки</th><th>Вес</th><th>Статус</th></tr></thead><tbody>
            ${recent.map((item) => `<tr><td><span class="table-title">${h(storeFor(item.storeId)?.name || item.storeName)}</span><span class="table-sub">${h(item.id)}</span></td><td>${formatDate(item.date)}</td><td>${formatNumber(item.cups)}</td><td>${formatNumber(item.wetKg, 1)} кг <span class="badge badge-${h(item.weightSource)}">${sourceLabel(item.weightSource)}</span></td><td><span class="badge badge-${h(item.status)}">${item.quality === "pending" ? "На проверке" : statusLabel(item.status)}</span></td></tr>`).join("")}
          </tbody></table></div>
        </article>
        <article class="panel stores-panel">
          <div class="panel-header"><div><h2>Точки</h2></div><span class="panel-meta">${activeStores.length}</span></div>
          <div class="store-list">
            ${activeStores.map((store) => {
              const expected = estimateWetGroundsKg(store.avgCups, state.economicsParams.wetGramsPerCup);
              const actual = state.collections.filter((x)=>x.storeId===store.id && x.date===TODAY && x.status!=="rejected").reduce((sum,x)=>sum+x.wetKg,0);
              const pct = Math.min(100, Math.round((actual / Math.max(expected, .1))*100));
              return `<div class="store-row"><div><strong>${h(store.name.replace("Global Coffee — ",""))}</strong><small>${actual ? `${formatNumber(actual,1)} из ${formatNumber(expected,1)} кг` : `нет записи · ожидается ${formatNumber(expected,1)} кг`}</small></div><div class="store-progress"><span style="width:${pct}%"></span></div><span class="store-percent">${pct}%</span></div>`;
            }).join("")}
          </div>
        </article>
      </section>
    </div>`;
}

function renderCollections() {
  const activeStores = state.stores.filter((store) => store.active && (activeRole !== "barista" || store.id === activeStoreId));
  const visibleCollections = state.collections.filter((item) => activeRole !== "barista" || item.storeId === activeStoreId);
  return `
    <div class="view-stack">
      ${syntheticNotice()}
      <section class="kpi-grid">
        <article class="kpi-card"><div class="kpi-label">Записей</div><div class="kpi-value">${visibleCollections.length}</div><div class="kpi-footer"><span>в журнале</span></div></article>
        <article class="kpi-card"><div class="kpi-label">Измерено</div><div class="kpi-value">${visibleCollections.filter((x) => x.weightSource === "measured").length}</div><div class="kpi-footer"><span>вес указан в записи</span></div></article>
        <article class="kpi-card"><div class="kpi-label">Оценено</div><div class="kpi-value">${visibleCollections.filter((x) => x.weightSource === "estimated").length}</div><div class="kpi-footer"><span>расчёт по числу напитков</span></div></article>
        <article class="kpi-card"><div class="kpi-label">Отклонено</div><div class="kpi-value">${visibleCollections.filter((x) => x.status === "rejected").length}</div><div class="kpi-footer"><span>не попадёт в партию</span></div></article>
      </section>
      <section class="panel panel-pad storage-note"><div><p class="eyebrow">Хранение на точке</p><h2>Код, время, качество</h2><p>После взвешивания поместите жмых в закрытый подписанный контейнер. Контейнеры старше 24 часов требуют проверки.</p></div><strong>Требуют внимания: ${visibleCollections.filter((item) => item.storedAt && !["collected", "rejected"].includes(item.status) && Date.now() - Date.parse(item.storedAt) >= 86400000).length}</strong></section>
      <section class="panel">
        <div class="panel-header"><div><h2>Журнал сбора</h2></div><button class="button button-primary" data-action="open-collection">Добавить запись</button></div>
        <div class="table-wrap"><table><thead><tr><th>ID</th><th>Точка</th><th>Дата</th><th>Продажи</th><th>Жмых</th><th>Качество</th><th>Статус / действие</th></tr></thead><tbody>
          ${[...visibleCollections].sort((a,b) => b.date.localeCompare(a.date)).map((item) => `<tr><td>${h(item.id)}</td><td><span class="table-title">${h(storeFor(item.storeId)?.name || item.storeName)}</span><span class="table-sub">${h(storeFor(item.storeId)?.district || "Импорт")}</span></td><td>${formatDate(item.date)}<span class="table-sub">${storageLabel(item)}</span></td><td>${formatNumber(item.cups)} напитков</td><td><strong>${formatNumber(item.wetKg,1)} кг</strong><span class="table-sub">${sourceLabel(item.weightSource)}</span></td><td><span class="badge badge-${h(item.quality)}">${qualityLabel(item.quality)}</span></td><td>${item.quality === "pending" && may("approve-collection") ? `<div class="review-actions"><button class="button button-dark button-small" data-action="approve-collection" data-id="${h(item.id)}">Принять</button><button class="button button-ghost button-small" data-action="reject-collection" data-id="${h(item.id)}">Отклонить</button></div>` : `<span class="badge badge-${h(item.status)}">${statusLabel(item.status)}</span>`}</td></tr>`).join("")}
        </tbody></table></div>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>${activeRole === "barista" ? "Моя точка" : "Точки сети"}</h2></div><span class="badge badge-good">${activeStores.length} активных</span></div>
        <div class="panel-pad triple-grid">
          ${activeStores.map((store) => {
            const entries = state.collections.filter((x) => x.storeId === store.id && x.status !== "rejected");
            const kg = entries.reduce((s,x) => s + x.wetKg,0);
            return `<article class="batch-card"><div class="batch-head"><div><h3>${h(store.name.replace("Global Coffee — ",""))}</h3><span class="table-sub">${h(store.district)}</span></div><span class="badge badge-good">активна</span></div><div class="batch-meta"><div><span>чашек/день</span><strong>${formatNumber(store.avgCups)}</strong></div><div><span>учтено</span><strong>${round(kg,1)} кг</strong></div><div><span>записей</span><strong>${entries.length}</strong></div></div></article>`;
          }).join("")}
        </div>
      </section>
    </div>`;
}

function renderLogistics() {
  const routePreview = buildPickupRoute(state.collections, state.stores);
  const routes = [...state.routes].sort((a,b) => b.date.localeCompare(a.date));
  return `
    <div class="view-stack">
      ${syntheticNotice()}
      ${routePreview.stops.length ? `<section class="split-grid">
        <article class="route-card">
          <div class="route-top"><div><p class="eyebrow">Сборка маршрута</p><h3>Следующий маршрут</h3></div><span class="badge badge-${routePreview.stops.length ? "scheduled" : "complete"}">${routePreview.stops.length ? `${routePreview.stops.length} остановки` : "нет заявок"}</span></div>
          <div class="route-metrics"><div class="route-metric"><span>Сырьё</span><strong>${routePreview.totalKg} кг</strong></div><div class="route-metric"><span>Дистанция</span><strong>${routePreview.distanceKm} км</strong></div><div class="route-metric"><span>Время</span><strong>${routePreview.estimatedMinutes} мин</strong></div></div>
          <div class="route-path">${routePreview.stops.length ? routePreview.stops.map((item, index) => `<span class="route-stop">${index+1}. ${h((storeFor(item.storeId)?.name || item.storeName).replace("Global Coffee — ",""))}</span>`).join("<span class='flow-arrow'>→</span>") : "<span style='color:rgba(255,255,255,.55)'>Подтвердите качество записей, готовых к вывозу.</span>"}</div>
          <div class="batch-actions"><button class="button button-primary" data-action="create-route" ${!routePreview.stops.length || routePreview.totalKg <= 0 ? "disabled" : ""}>Сформировать маршрут</button></div>
        </article>
        <article class="panel panel-pad">
          <p class="eyebrow">Перед вывозом</p><h2 style="margin:8px 0 14px">Проверьте контейнеры</h2>
          <div class="assumption-list">
            <div class="assumption"><i></i><span>Код и время хранения</span><strong>в журнале</strong></div>
            <div class="assumption"><i></i><span>Качество сырья</span><strong>проверено</strong></div>
            <div class="assumption"><i></i><span>Вес к вывозу</span><strong>${formatNumber(routePreview.totalKg, 1)} кг</strong></div>
            <div class="assumption"><i></i><span>Остановки</span><strong>${routePreview.stops.length}</strong></div>
          </div>
          <p class="table-sub">Расстояние и время — предварительная оценка.</p>
        </article>
      </section>` : `<section class="panel panel-pad"><h2 style="margin:0 0 8px">Нет контейнеров к вывозу</h2><p style="margin:0;color:var(--text-secondary)">Все готовые контейнеры уже распределены по маршрутам. Текущие маршруты показаны ниже.</p></section>`}
      <section class="panel">
        <div class="panel-header"><div><h2>Маршруты</h2></div></div>
        <div class="table-wrap"><table><thead><tr><th>Маршрут</th><th>Дата</th><th>Остановки</th><th>Вес</th><th>Дистанция</th><th>Статус</th><th></th></tr></thead><tbody>
          ${routes.map((route) => {
            const items = state.collections.filter((x) => route.collectionIds.includes(x.id));
            const kg = items.reduce((s,x) => s + Number(x.wetKg || 0),0);
            const stops = [...new Set(items.map((item) => item.storeId))];
            const picked = items.filter((item) => item.status === "collected").length;
            return `<tr><td><span class="table-title">${h(route.id)}</span></td><td>${formatDate(route.date)}</td><td>${stops.length}</td><td>${formatNumber(kg,1)} кг</td><td>${h(route.distanceKm)} км</td><td><span class="badge badge-${h(route.status)}">${statusLabel(route.status)}</span></td><td>${route.status === "planned" ? `${picked}/${items.length} забрано` : "Все забрано"}</td></tr>${route.status === "planned" ? `<tr><td colspan="7"><div class="pickup-list">${stops.map((storeId) => { const stopItems = items.filter((item) => item.storeId === storeId); const done = stopItems.every((item) => item.status === "collected"); return `<div class="pickup-row"><div><strong>${h(storeFor(storeId)?.name || storeId)}</strong><small>${stopItems.map((item) => h(item.containerCode || item.id)).join(", ")}</small></div><span>${formatNumber(stopItems.reduce((sum,item)=>sum+Number(item.wetKg||0),0),1)} кг</span>${done ? `<span class="badge badge-complete">Забрано</span>` : `<button class="button button-dark button-small" data-action="pickup-stop" data-id="${h(route.id)}" data-store-id="${h(storeId)}">Подтвердить вывоз</button>`}</div>`; }).join("")}</div></td></tr>` : ""}`;
          }).join("") || `<tr><td colspan="7"><div class="empty-state"><strong>Маршрутов пока нет</strong>Создайте первый маршрут из готовых контейнеров.</div></td></tr>`}
        </tbody></table></div>
      </section>
    </div>`;
}

function renderProduction() {
  const unbatched = state.collections.filter(readyForBatch);
  return `
    <div class="view-stack">
      ${syntheticNotice()}
      <section class="kpi-grid">
        <article class="kpi-card"><div class="kpi-label">Собрано без партии</div><div class="kpi-value">${round(unbatched.reduce((s,x)=>s+x.wetKg,0),1)} кг</div><div class="kpi-footer"><span>${unbatched.length} записей</span></div></article>
        <article class="kpi-card"><div class="kpi-label">Партий</div><div class="kpi-value">${state.batches.length}</div><div class="kpi-footer"><span>полная прослеживаемость</span></div></article>
        <article class="kpi-card"><div class="kpi-label">Готовой продукции</div><div class="kpi-value">${formatNumber(state.productionRuns.reduce((s,x)=>s+Number(x.producedPacks || 0),0))}</div><div class="kpi-footer"><span>упаковок</span></div></article>
        <article class="kpi-card"><div class="kpi-label">Продано / остаток</div><div class="kpi-value">${formatNumber(state.sales.reduce((sum, sale) => sum + sale.packs, 0))} / ${formatNumber(state.batches.reduce((sum, batch) => sum + batchStock(batch, state.sales).available, 0))}</div><div class="kpi-footer"><span>упаковок</span></div></article>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>Партии</h2></div><button class="button button-primary" data-action="create-batch" ${!unbatched.length ? "disabled" : ""}>Новая партия</button></div>
        <div class="panel-pad triple-grid">
          ${state.batches.map((batch) => `<article class="batch-card ${batch.id === state.selectedBatchId ? "selected" : ""}">
            <div class="batch-head"><div><h3>${h(batch.id)}</h3><span class="table-sub">${formatDate(batch.createdAt)} · ${batch.sourceStores.length} точки</span></div><span class="badge badge-${h(batch.status)}">${statusLabel(batch.status)}</span></div>
            <div class="batch-meta"><div><span>мокрый вес</span><strong>${h(batch.wetKg)} кг</strong></div><div><span>чистый сухой</span><strong>${h(batch.acceptedKg)} кг</strong></div><div><span>упаковки</span><strong>${h(batch.producedPacks || "—")}</strong></div></div>
            <div class="batch-actions"><button class="button button-ghost button-small" data-action="select-batch" data-id="${h(batch.id)}">Открыть</button>${batch.status !== "complete" ? `<button class="button button-dark button-small" data-action="advance-batch" data-id="${h(batch.id)}">${({received:"Начать сушку",drying:"Подтвердить сухой вес",production:"Зафиксировать выпуск"})[batch.status]}</button>` : ""}</div>
          </article>`).join("")}
        </div>
      </section>
      ${renderSelectedBatch()}
      <section class="panel"><div class="panel-header"><div><h2>Продажи</h2></div><button class="button button-primary" data-action="open-sale" ${state.batches.every((batch) => batchStock(batch, state.sales).available === 0) ? "disabled" : ""}>Зафиксировать продажу</button></div>
        <div class="table-wrap"><table><thead><tr><th>Дата</th><th>Партия</th><th>Канал</th><th>Продано</th><th>Цена</th><th>Выручка</th></tr></thead><tbody>${[...state.sales].reverse().map((sale) => `<tr><td>${formatDate(sale.date)}</td><td>${h(sale.batchId)}</td><td>${h(sale.channel)}</td><td>${formatNumber(sale.packs)} уп.</td><td>${formatMoney(sale.unitPrice)}</td><td>${formatMoney(sale.packs * sale.unitPrice)}</td></tr>`).join("") || `<tr><td colspan="6"><div class="empty-state"><strong>Продаж пока нет</strong>Зафиксируйте выпуск и первую продажу.</div></td></tr>`}</tbody></table></div>
      </section>
    </div>`;
}

function renderSelectedBatch() {
  const batch = state.batches.find((b) => b.id === state.selectedBatchId) || state.batches[0];
  if (!batch) return "";
  const potential = calculatePackOutput(batch.acceptedKg, batch.groundsPerPackG || 160, 100);
  const stock = batchStock(batch, state.sales);
  const sources = batch.sourceStores.map((id) => storeFor(id)?.name.replace("Global Coffee — ","") || id).join(", ");
  return `<section class="split-grid">
    <article class="panel panel-pad">
      <p class="eyebrow">Выбранная партия</p><h2 style="margin:7px 0 18px">${h(batch.id)}</h2>
      <div class="form-grid">
        <label class="field">Сухой выход, %<input type="number" value="${h(batch.dryYieldPct)}" disabled /></label>
        <label class="field">Брак, %<input type="number" value="${h(batch.rejectPct)}" disabled /></label>
        <label class="field">Жмых на упаковку, г<input type="number" value="${h(batch.groundsPerPackG || 160)}" disabled /></label>
        <label class="field">Потенциальный выпуск<input type="text" value="${potential.producedPacks} упаковок" disabled /></label>
        <label class="field">Продано<input type="text" value="${stock.sold} упаковок" disabled /></label>
        <label class="field">Остаток<input type="text" value="${stock.available} упаковок" disabled /></label>
        <label class="field field-wide">Источники<input type="text" value="${h(sources)}" disabled /></label>
      </div>
      <div class="batch-actions"><button class="button button-ghost" data-view-link="traceability">Продукт и паспорт</button></div>
    </article>
    <article class="panel">
      <div class="panel-header"><div><h2>Этапы</h2></div></div>
      <div class="stepper">
        <div class="step-row"><span class="step-index">1</span><div><strong>Приёмка</strong><p>Вес и происхождение партии</p></div><span class="step-stat">${h(batch.wetKg)} кг</span></div>
        <div class="step-row"><span class="step-index">2</span><div><strong>Сушка</strong><p>Контроль влажности партнёром</p></div><span class="step-stat">${h(batch.driedKg)} кг</span></div>
        <div class="step-row"><span class="step-index">3</span><div><strong>Контроль</strong><p>Удаление загрязнённого сырья</p></div><span class="step-stat">${h(batch.acceptedKg)} кг</span></div>
        <div class="step-row"><span class="step-index">4</span><div><strong>Формование и упаковка</strong><p>${h(batch.recipe)}</p></div><span class="step-stat">${h(batch.producedPacks || potential.producedPacks)} уп.</span></div>
      </div>
    </article>
  </section>`;
}

function renderEconomics() {
  const p = state.economicsParams;
  const e = calculateEconomics(p);
  const ranges = [
    ["activeStores", "Активные точки", 1, state.stores.length, 1, ""],
    ["cupsPerStoreDay", "Напитков на точку в день", 50, 600, 1, ""],
    ["wetGramsPerCup", "Мокрого жмыха на напиток", 15, 55, 1, " г"],
    ["dryYieldPct", "Сухой выход", 30, 70, 1, "%"],
    ["rejectPct", "Брак сырья", 0, 30, 1, "%"],
    ["groundsPerPackG", "Сухого жмыха на упаковку", 80, 300, 10, " г"],
    ["sellThroughPct", "Реализовано продукции", 30, 100, 1, "%"],
    ["pricePerPack", "Цена упаковки", 500, 2500, 10, " ₸"],
    ["variableCostPerPack", "Переменная себестоимость", 200, 1200, 10, " ₸"],
    ["monthlyLogisticsCost", "Логистика в месяц", 100000, 1200000, 10000, " ₸"],
  ];
  return `<div class="view-stack">
    ${syntheticNotice()}
    <div class="scenario-tabs">${Object.entries(SCENARIOS).map(([key, item]) => `<button class="scenario-tab ${state.scenario === key ? "active" : ""}" data-action="set-scenario" data-id="${key}">${item.label}</button>`).join("")}</div>
    <section class="economics-hero">
      <article class="profit-card ${e.profit < 0 ? "negative" : ""}"><span>Операционная прибыль / месяц</span><strong>${formatMoney(e.profit)}</strong><small>${e.marginPct}% от выручки · при реализации ${h(p.sellThroughPct)}% выпуска</small></article>
      <article class="breakdown"><div class="breakdown-row"><span>Выручка</span><strong>${formatMoney(e.revenue)}</strong></div><div class="breakdown-row"><span>Переменные расходы</span><strong>− ${formatMoney(e.variableCost)}</strong></div><div class="breakdown-row"><span>Логистика</span><strong>− ${formatMoney(p.monthlyLogisticsCost)}</strong></div><div class="breakdown-row"><span>Постоянные расходы</span><strong>− ${formatMoney(p.monthlyFixedCost)}</strong></div><div class="breakdown-row total"><span>Результат</span><strong>${formatMoney(e.profit)}</strong></div></article>
    </section>
    <section class="split-grid">
      <article class="panel panel-pad"><p class="eyebrow">Параметры расчёта</p><h2 style="margin:7px 0 18px">Проверьте любую гипотезу</h2>${ranges.map(([key,label,min,max,step,suffix]) => `<div class="range-field"><div class="range-head"><span>${label}</span><strong data-value-for="${key}">${formatNumber(p[key],0)}${suffix}</strong></div><input type="range" min="${min}" max="${max}" step="${step}" value="${h(p[key])}" data-economics-key="${key}" data-suffix="${suffix}" /></div>`).join("")}</article>
      <article class="panel">
        <div class="panel-header"><div><h2>Баланс за месяц</h2></div></div>
        <div class="stepper">
          <div class="step-row"><span class="step-index">1</span><div><strong>Проданные напитки</strong><p>${h(p.activeStores)} точек × ${h(p.cupsPerStoreDay)} × 30 дней</p></div><span class="step-stat">${formatNumber(p.activeStores*p.cupsPerStoreDay*30)}</span></div>
          <div class="step-row"><span class="step-index">2</span><div><strong>Мокрый жмых</strong><p>${h(p.wetGramsPerCup)} г на напиток</p></div><span class="step-stat">${formatNumber(e.wetKg,0)} кг</span></div>
          <div class="step-row"><span class="step-index">3</span><div><strong>Принято после сушки</strong><p>Сухой выход ${h(p.dryYieldPct)}%, брак ${h(p.rejectPct)}%</p></div><span class="step-stat">${formatNumber(e.acceptedKg,0)} кг</span></div>
          <div class="step-row"><span class="step-index">4</span><div><strong>Произведено</strong><p>${h(p.groundsPerPackG)} г жмыха на упаковку</p></div><span class="step-stat">${formatNumber(e.producedPacks)} уп.</span></div>
          <div class="step-row"><span class="step-index">5</span><div><strong>Продано</strong><p>Коэффициент реализации ${h(p.sellThroughPct)}%</p></div><span class="step-stat">${formatNumber(e.soldPacks)} уп.</span></div>
        </div>
        <div class="panel-pad" style="padding-top:0"><div class="notice"><span class="notice-dot"></span><div><strong>Точка безубыточности</strong>${e.breakEvenPacks === null ? "Недоступна при нулевой цене." : `${formatNumber(e.breakEvenPacks)} проданных упаковок из ${formatNumber(e.producedPacks)} произведённых.${e.breakEvenPacks > e.producedPacks ? " Текущего объёма недостаточно." : ""}`}</div></div></div>
      </article>
    </section>
  </div>`;
}

function renderTraceability() {
  const batch = state.batches.find((b) => b.id === state.selectedBatchId) || state.batches[0];
  if (!batch) return `<div class="empty-state"><strong>Нет партий</strong>Сначала создайте партию в разделе «Производство».</div>`;
  const stores = batch.sourceStores.map((id) => storeFor(id)).filter(Boolean);
  return `<div class="view-stack">
    ${syntheticNotice()}
    <section class="panel panel-pad product-brief">
      <div><p class="eyebrow">Продукт R-01 · гипотеза</p><h2>Набор подставок из кофейного композита</h2><p>Сухой кофейный жмых, бумажное волокно и связующее формуются в подставки для кофейни. Один набор использует ${formatNumber(batch.groundsPerPackG)} г сухого жмыха. Состав и прочность требуют испытаний на физическом образце.</p></div>
      <div class="product-facts"><div><span>Сырьё</span><strong>жмых + волокно</strong></div><div><span>Процесс</span><strong>сушка → прессование</strong></div><div><span>Продажа</span><strong>набор в упаковке</strong></div></div>
    </section>
    <div class="panel panel-pad" style="display:flex;align-items:end;justify-content:space-between;gap:15px;flex-wrap:wrap"><label class="field" style="min-width:280px">Выберите партию<select id="passportBatch">${state.batches.map((b)=>`<option value="${h(b.id)}" ${b.id===batch.id?"selected":""}>${h(b.id)} · ${statusLabel(b.status)}</option>`).join("")}</select></label><span class="badge badge-${h(batch.status)}">${statusLabel(batch.status)}</span></div>
    <section class="passport">
      <div class="passport-cover" data-batch="${h(batch.id)}"><p class="eyebrow">Паспорт партии</p><h2>${h(batch.id)}</h2></div>
      <div class="passport-grid">
        <div class="passport-section"><h3>Происхождение</h3>${stores.map((s)=>`<div class="passport-fact"><span>${h(s.name.replace("Global Coffee — ",""))}</span><strong>${h(s.district)}</strong></div>`).join("") || `<div class="passport-fact"><span>Источник</span><strong>не указан</strong></div>`}</div>
        <div class="passport-section"><h3>Материальный баланс</h3><div class="passport-fact"><span>Мокрый жмых</span><strong>${h(batch.wetKg)} кг</strong></div><div class="passport-fact"><span>После сушки</span><strong>${h(batch.driedKg)} кг</strong></div><div class="passport-fact"><span>Принято</span><strong>${h(batch.acceptedKg)} кг</strong></div><div class="passport-fact"><span>Выпуск</span><strong>${batch.producedPacks ? `${h(batch.producedPacks)} уп.` : "ожидается"}</strong></div></div>
        <div class="passport-section"><h3>Контроль партии</h3><div class="passport-fact"><span>Дата создания</span><strong>${formatDate(batch.createdAt)}</strong></div><div class="passport-fact"><span>Рецептура</span><strong>R-01</strong></div><div class="passport-fact"><span>Статус</span><strong>${statusLabel(batch.status)}</strong></div></div>
        <div class="passport-section"><h3>Выпуск и продажа</h3><div class="passport-fact"><span>Произведено</span><strong>${formatNumber(batch.producedPacks || 0)} уп.</strong></div><div class="passport-fact"><span>Продано</span><strong>${formatNumber(batchStock(batch, state.sales).sold)} уп.</strong></div><div class="passport-fact"><span>Остаток</span><strong>${formatNumber(batchStock(batch, state.sales).available)} уп.</strong></div></div>
      </div>
    </section>
  </div>`;
}

function renderData() {
  return `<div class="view-stack">
    ${syntheticNotice()}
    <section class="split-grid">
      <article class="panel panel-pad">
        <p class="eyebrow">Импорт отчёта</p><h2 style="margin:7px 0 16px">Загрузите CSV или Excel</h2>
        <div class="upload-zone" id="uploadZone"><div class="upload-icon">⇧</div><h3>Перетащите отчёт сюда</h3><p>Колонки: Точка, Дата, Напитки, Жмых кг. Вес можно не указывать — он будет рассчитан.</p><input type="file" id="fileInput" accept=".csv,.xlsx,.xls" hidden /><button class="button button-primary" data-action="choose-file">Выбрать файл</button></div>
        ${state.lastImport ? `<div class="notice" style="margin-top:15px"><span class="notice-dot"></span><div><strong>Последний импорт: ${h(state.lastImport.fileName)}</strong>${formatNumber(state.lastImport.rows)} строк · ${h(state.lastImport.at)}</div></div>` : ""}
      </article>
      <article class="panel panel-pad">
        <p class="eyebrow">Управление данными</p><h2 style="margin:7px 0 16px">Переносимые данные</h2>
        <div class="data-actions"><button class="button button-dark" data-action="download-template">Скачать шаблон CSV</button><button class="button button-ghost" data-action="export-json">Экспорт JSON</button></div>
        <div class="assumption-list" style="margin-top:22px"><div class="assumption"><i></i><span>Хранилище</span><strong>${cloudEnabled ? "Supabase" : "Браузер"}</strong></div><div class="assumption"><i></i><span>Импортированных записей</span><strong>${state.collections.filter((x)=>x.source==="import").length}</strong></div></div>
      </article>
    </section>
    <section class="panel">
      <div class="panel-header"><div><h2>Формат файла</h2></div></div>
      <div class="table-wrap"><table><thead><tr><th>Точка</th><th>Дата</th><th>Напитки</th><th>Жмых кг</th><th>Что произойдёт</th></tr></thead><tbody><tr><td>Global Coffee — Абая</td><td>2026-11-06</td><td>238</td><td>7.7</td><td>Вес отмечается как измеренный</td></tr><tr><td>Global Coffee — Mega</td><td>2026-11-06</td><td>326</td><td>пусто</td><td>Вес оценивается по сценарию</td></tr></tbody></table></div>
    </section>
  </div>`;
}

function render() {
  if (!canView(state.currentView)) state.currentView = ROLE_VIEWS[activeRole][0];
  viewTitle.textContent = viewMeta[state.currentView] || viewMeta.overview;
  document.querySelector("#roleSelect").value = activeRole;
  const storeSelect = document.querySelector("#storeSelect");
  storeSelect.hidden = activeRole !== "barista";
  storeSelect.innerHTML = state.stores.filter((store) => store.active).map((store) => `<option value="${h(store.id)}">${h(store.name.replace("Global Coffee — ", ""))}</option>`).join("");
  if (!state.stores.some((store) => store.id === activeStoreId && store.active)) activeStoreId = state.stores.find((store) => store.active)?.id || "";
  storeSelect.value = activeStoreId;
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.hidden = !canView(item.dataset.view);
    item.classList.toggle("active", item.dataset.view === state.currentView);
  });
  const renderers = { overview: renderOverview, collections: renderCollections, logistics: renderLogistics, production: renderProduction, economics: renderEconomics, traceability: renderTraceability, data: renderData };
  contentArea.innerHTML = (renderers[state.currentView] || renderOverview)();
  contentArea.querySelectorAll("button[data-action]").forEach((control) => { if (!may(control.dataset.action)) control.hidden = true; });
  if (cloudSaveBlocked) contentArea.querySelectorAll("button[data-action], input, textarea").forEach((control) => { control.disabled = true; });
  document.querySelectorAll(".topbar [data-action='open-collection']").forEach((control) => { control.hidden = activeRole !== "barista" || state.currentView === "collections"; control.disabled = cloudSaveBlocked; });
  bindViewSpecificEvents();
}

function setView(view) {
  if (!canView(view)) return;
  state.currentView = view;
  if (!cloudEnabled) saveState();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
  document.querySelector("#sidebar").classList.remove("open");
}

function openCollectionDialog() {
  if (!may("open-collection")) return;
  collectionStore.innerHTML = state.stores.filter((x) => x.active && (activeRole !== "barista" || x.id === activeStoreId)).map((store) => `<option value="${h(store.id)}">${h(store.name)}</option>`).join("");
  collectionDate.value = TODAY;
  collectionDialog.showModal();
}

function openSaleDialog() {
  if (!may("open-sale")) return;
  const available = state.batches.filter((batch) => batchStock(batch, state.sales).available > 0);
  if (!available.length) return showToast("Нет готовой продукции для продажи.");
  saleBatch.innerHTML = available.map((batch) => `<option value="${h(batch.id)}">${h(batch.id)} · ${batchStock(batch, state.sales).available} уп.</option>`).join("");
  saleForm.elements.namedItem("unitPrice").value = state.economicsParams.pricePerPack;
  saleForm.elements.namedItem("packs").value = 1;
  saleDialog.showModal();
}

function applyScenario(key) {
  if (!SCENARIOS[key]) return;
  state.scenario = key;
  const active = state.stores.filter((x) => x.active);
  const avg = active.reduce((s,x)=>s+x.avgCups,0) / Math.max(1,active.length);
  state.economicsParams = {
    ...state.economicsParams,
    activeStores: active.length,
    cupsPerStoreDay: Math.round(avg),
    ...SCENARIOS[key],
  };
  saveState();
  render();
}

function createRoute() {
  if (!may("create-route")) return;
  const preview = buildPickupRoute(state.collections, state.stores);
  if (!preview.stops.length || preview.totalKg <= 0) return showToast("Нет контейнеров с положительным весом для маршрута.");
  const route = {
    id: `RT-${TODAY.replaceAll("-","")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
    date: TODAY,
    status: "planned",
    collectionIds: preview.stops.flatMap((x)=>x.collectionIds || [x.id]),
    totalKg: preview.totalKg,
    distanceKm: preview.distanceKm,
    estimatedMinutes: preview.estimatedMinutes,
  };
  state.routes.push(route);
  state.collections = state.collections.map((item) => route.collectionIds.includes(item.id) ? { ...item, status: "scheduled", routeId: route.id } : item);
  saveState(); render(); showToast(`Маршрут ${route.id} создан.`);
}

function pickupStop(id, storeId) {
  if (!may("pickup-stop")) return;
  const route = state.routes.find((x) => x.id === id);
  if (!route || route.status !== "planned") return;
  const stopItems = state.collections.filter((item) => route.collectionIds.includes(item.id) && item.storeId === storeId && item.status === "scheduled");
  if (!stopItems.length) return showToast("На этой точке нет ожидающих контейнеров.");
  const ids = new Set(stopItems.map((item) => item.id));
  state.collections = state.collections.map((item) => ids.has(item.id) ? { ...item, status: "collected", pickedAt: new Date().toISOString() } : item);
  route.pickups = [...(route.pickups || []), { storeId, at: new Date().toISOString(), kg: round(stopItems.reduce((sum, item) => sum + item.wetKg, 0), 2) }];
  if (route.collectionIds.every((collectionId) => state.collections.find((item) => item.id === collectionId)?.status === "collected")) route.status = "completed";
  saveState(); render(); showToast(route.status === "completed" ? `Маршрут ${id} завершён.` : "Вывоз с точки подтверждён.");
}

function createBatch() {
  if (!may("create-batch")) return;
  const items = state.collections.filter(readyForBatch);
  if (!items.length) return showToast("Нет собранных записей без партии.");
  const wetKg = round(items.reduce((s,x)=>s+x.wetKg,0),2);
  const process = state.economicsParams;
  const dry = calculateDryOutput(wetKg, process.dryYieldPct, process.rejectPct);
  const id = `GL-${TODAY.slice(2).replaceAll("-","")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const batch = {
    id, createdAt: TODAY, collectionIds: items.map((x)=>x.id), sourceStores: [...new Set(items.map((x)=>x.storeId))], wetKg,
    dryYieldPct: process.dryYieldPct, rejectPct: process.rejectPct, driedKg: dry.driedKg, acceptedKg: dry.acceptedKg,
    status: "received", groundsPerPackG: process.groundsPerPackG, producedPacks: 0, recipe: "R-01 / кофейный композит",
  };
  state.batches.unshift(batch);
  state.collections = state.collections.map((x)=>items.some((i)=>i.id===x.id)?{...x,batchId:id}:x);
  state.selectedBatchId = id;
  saveState(); render(); showToast(`Партия ${id} сформирована.`);
}

function advanceBatch(id) {
  if (!may("advance-batch")) return;
  const batch = state.batches.find((x)=>x.id===id);
  if (!batch) return;
  if (batch.status === "received") {
    batch.status = "drying";
    batch.dryingStartedAt = new Date().toISOString();
    saveState(); render(); showToast(`${id}: сушка начата.`);
    return;
  }
  if (!["drying", "production"].includes(batch.status)) return;
  stageForm.elements.namedItem("batchId").value = id;
  stageForm.elements.namedItem("phase").value = batch.status;
  if (batch.status === "drying") {
    document.querySelector("#stageTitle").textContent = "Сухой вес и контроль";
    document.querySelector("#stageInputs").innerHTML = `<label class="field">После сушки, кг<input name="driedKg" type="number" min="0.01" max="${h(batch.wetKg)}" step="0.01" value="${h(batch.driedKg)}" required /></label><label class="field">Принято после контроля, кг<input name="acceptedKg" type="number" min="0.01" step="0.01" value="${h(batch.acceptedKg)}" required /></label>`;
    document.querySelector("#stageSubmit").textContent = "Подтвердить вес";
  } else {
    const maximum = calculatePackOutput(batch.acceptedKg, batch.groundsPerPackG, 100).producedPacks;
    document.querySelector("#stageTitle").textContent = "Выпуск продукции";
    document.querySelector("#stageInputs").innerHTML = `<label class="field field-wide">Произведено упаковок<input name="producedPacks" type="number" min="1" max="${maximum}" step="1" value="${maximum}" required /></label>`;
    document.querySelector("#stageSubmit").textContent = "Зафиксировать выпуск";
  }
  stageDialog.showModal();
}

function download(name, content, type="text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  URL.revokeObjectURL(url);
}

async function importFile(file) {
  try {
    if (!may("choose-file")) return;
    if (cloudSaveBlocked) return;
    if (!/\.(csv|xlsx|xls)$/i.test(file.name)) throw new Error("Поддерживаются только CSV и Excel.");
    if (file.size > 5 * 1024 * 1024) throw new Error("Файл больше 5 МБ. Разделите отчёт на части.");
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
    let rows;
    if (file.name.toLowerCase().endsWith(".csv")) {
      rows = parseCsv(new TextDecoder("utf-8").decode(bytes));
    } else {
      if (!window.XLSX) throw new Error("Модуль Excel ещё не загрузился. Попробуйте CSV или повторите через несколько секунд.");
      const workbook = window.XLSX.read(bytes, { type: "array", cellDates: true });
      rows = window.XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "", raw: true });
    }
    if (rows.length > 5000) throw new Error("В файле больше 5000 строк. Разделите отчёт на части.");
    const normalized = normalizeImportedRows(rows, { wetGramsPerCup: state.economicsParams.wetGramsPerCup });
    if (!normalized.length) throw new Error("Не найдены строки с количеством напитков или весом.");
    const existingIds = new Set(state.collections.map((item) => item.id));
    const fresh = normalized.map((item, index) => ({ ...item, id: `IMP-${fingerprint}-${index + 1}` })).filter((item) => !existingIds.has(item.id));
    if (!fresh.length) return showToast("Этот файл уже импортирован. Новых записей нет.");
    const next = structuredClone(state);
    fresh.forEach((item) => {
      let store = next.stores.find((s)=>s.name.trim().toLowerCase()===item.storeName.toLowerCase());
      if (!store) {
        store = { id:`IMP-S-${crypto.randomUUID().slice(0, 8)}`, name:item.storeName, district:"Импорт", avgCups:item.cups, active:true };
        next.stores.push(store);
      }
      next.collections.push({ ...item, storeId:store.id, containerCode: `${store.id}-${item.date.replaceAll("-", "")}-${item.id.slice(-4)}`, storedAt: `${item.date}T09:00:00+05:00` });
    });
    next.dataMode = "mixed";
    next.lastImport = { fileName:file.name, rows:fresh.length, at:new Intl.DateTimeFormat("ru-RU",{dateStyle:"short",timeStyle:"short",timeZone:"Asia/Qyzylorda"}).format(new Date()) };
    if (new TextEncoder().encode(JSON.stringify(next)).length > 2097152) throw new Error("Объём данных превысит 2 МБ. Разделите файл.");
    state = next;
    render();
    await saveState();
    if (!cloudSaveBlocked) showToast(`Импортировано ${fresh.length} строк. Проверьте качество перед вывозом.`);
  } catch (error) {
    showToast(error.message || "Не удалось импортировать файл.");
  }
}

function bindViewSpecificEvents() {
  const fileInput = document.querySelector("#fileInput");
  if (fileInput) fileInput.addEventListener("change", (event)=>event.target.files[0] && importFile(event.target.files[0]));
  const zone = document.querySelector("#uploadZone");
  if (zone) {
    ["dragenter","dragover"].forEach((type)=>zone.addEventListener(type,(event)=>{event.preventDefault();zone.classList.add("drag");}));
    ["dragleave","drop"].forEach((type)=>zone.addEventListener(type,(event)=>{event.preventDefault();zone.classList.remove("drag");}));
    zone.addEventListener("drop",(event)=>event.dataTransfer.files[0] && importFile(event.dataTransfer.files[0]));
  }
  const passport = document.querySelector("#passportBatch");
  if (passport) passport.addEventListener("change",()=>{state.selectedBatchId=passport.value;saveState();render();});
  document.querySelectorAll("[data-economics-key]").forEach((input)=>input.addEventListener("input",()=>{
    state.economicsParams[input.dataset.economicsKey] = Number(input.value);
    const output = document.querySelector(`[data-value-for="${input.dataset.economicsKey}"]`);
    if (output) output.textContent = `${formatNumber(input.value, 0)}${input.dataset.suffix}`;
  }));
  document.querySelectorAll("[data-economics-key]").forEach((input)=>input.addEventListener("change",()=>{ saveState(); render(); }));
}

function reviewCollection(id, approved) {
  if (!may("approve-collection")) return;
  const item = state.collections.find((entry) => entry.id === id);
  if (!item || item.quality !== "pending" || !["ready", "review"].includes(item.status)) return;
  item.quality = approved ? "good" : "rejected";
  item.status = approved ? "ready" : "rejected";
  saveState(); render(); showToast(approved ? "Качество подтверждено. Запись доступна для вывоза." : "Запись отклонена и исключена из вывоза.");
}

document.querySelectorAll(".nav-item").forEach((item)=>item.addEventListener("click",()=>setView(item.dataset.view)));
document.querySelector("#menuButton").addEventListener("click",()=>document.querySelector("#sidebar").classList.toggle("open"));
document.querySelectorAll("[data-action='open-collection']").forEach((button)=>button.addEventListener("click",openCollectionDialog));
document.querySelector("#roleSelect").addEventListener("change", (event) => {
  if (!ROLE_VIEWS[event.target.value]) return;
  activeRole = event.target.value;
  localStorage.setItem("groundloop_role", activeRole);
  state.currentView = ROLE_VIEWS[activeRole][0];
  render();
});
document.querySelector("#storeSelect").addEventListener("change", (event) => {
  activeStoreId = event.target.value;
  localStorage.setItem("groundloop_store", activeStoreId);
  render();
});

contentArea.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.viewLink) return setView(button.dataset.viewLink);
  const { action, id } = button.dataset;
  if (action && !may(action)) return;
  if (action === "open-collection") openCollectionDialog();
  if (action === "create-route") createRoute();
  if (action === "approve-collection") reviewCollection(id, true);
  if (action === "reject-collection") reviewCollection(id, false);
  if (action === "open-sale") openSaleDialog();
  if (action === "pickup-stop") pickupStop(id, button.dataset.storeId);
  if (action === "create-batch") createBatch();
  if (action === "advance-batch") advanceBatch(id);
  if (action === "select-batch") { state.selectedBatchId=id; saveState(); render(); }
  if (action === "set-scenario") applyScenario(id);
  if (action === "choose-file") document.querySelector("#fileInput")?.click();
  if (action === "download-template") download("groundloop-template.csv", "Точка,Дата,Напитки,Жмых кг\nGlobal Coffee — Абая,2026-11-06,238,7.7\nGlobal Coffee — Mega,2026-11-06,326,\n", "text/csv;charset=utf-8");
  if (action === "export-json") download("groundloop-export.json", JSON.stringify(state,null,2), "application/json");
});

collectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (cloudSaveBlocked || !may("open-collection")) return;
  const data = new FormData(collectionForm);
  const storeId = data.get("storeId");
  const cups = Number(data.get("cups"));
  const enteredWeight = Number(data.get("wetKg"));
  if ((!cups && !enteredWeight) || cups < 0 || enteredWeight < 0 || !state.stores.some((store) => store.active && store.id === storeId) || (activeRole === "barista" && storeId !== activeStoreId)) return showToast("Укажите свою точку и количество напитков или вес больше нуля.");
  const estimated = !enteredWeight;
  const wetKg = enteredWeight || estimateWetGroundsKg(cups, state.economicsParams.wetGramsPerCup);
  const quality = data.get("quality");
  state.collections.push({
    id:`COL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, storeId, date:data.get("date"), cups, wetKg, quality,
    status: quality === "rejected" ? "rejected" : quality === "pending" ? "review" : "ready", weightSource: estimated ? "estimated" : "measured",
    source:"manual", note:data.get("note") || "",
    containerCode: `${storeId}-${String(data.get("date")).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
    storedAt: String(data.get("date")) === TODAY ? new Date().toISOString() : `${data.get("date")}T09:00:00+05:00`,
  });
  saveState(); collectionDialog.close(); collectionForm.reset(); render(); showToast("Сбор добавлен в журнал.");
});

saleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (cloudSaveBlocked || !may("open-sale")) return;
  const data = new FormData(saleForm);
  const batch = state.batches.find((item) => item.id === data.get("batchId"));
  const packs = Number(data.get("packs"));
  const unitPrice = Number(data.get("unitPrice"));
  try {
    validateSaleDraft(batch, state.sales, packs, unitPrice);
    state.sales.push({ id: `SL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, batchId: batch.id, date: TODAY, packs, unitPrice, channel: String(data.get("channel")), source: "manual" });
    saveState(); saleDialog.close(); saleForm.reset(); render(); showToast(`Продано ${packs} упаковок.`);
  } catch (error) { showToast(error.message); }
});

stageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (cloudSaveBlocked || !may("advance-batch")) return;
  const data = new FormData(stageForm);
  const batch = state.batches.find((item) => item.id === data.get("batchId"));
  if (!batch || batch.status !== data.get("phase")) return showToast("Этап партии изменился. Обновите данные.");
  if (batch.status === "drying") {
    const driedKg = Number(data.get("driedKg"));
    const acceptedKg = Number(data.get("acceptedKg"));
    if (!Number.isFinite(driedKg) || !Number.isFinite(acceptedKg) || acceptedKg <= 0 || acceptedKg > driedKg || driedKg > batch.wetKg || driedKg <= 0) return showToast("Проверьте вес: принятый ≤ сухого ≤ мокрого.");
    batch.driedKg = round(driedKg, 2);
    batch.acceptedKg = round(acceptedKg, 2);
    batch.dryYieldPct = round(driedKg / batch.wetKg * 100, 2);
    batch.rejectPct = round((driedKg - acceptedKg) / driedKg * 100, 2);
    batch.status = "production";
    batch.weightConfirmedAt = new Date().toISOString();
    showToast("Сухой вес подтверждён. Партия готова к формованию.");
  } else if (batch.status === "production") {
    const packs = Number(data.get("producedPacks"));
    const maximum = calculatePackOutput(batch.acceptedKg, batch.groundsPerPackG, 100).producedPacks;
    if (!Number.isInteger(packs) || packs < 1 || packs > maximum) return showToast(`Укажите от 1 до ${maximum} упаковок.`);
    batch.producedPacks = packs;
    batch.status = "complete";
    state.productionRuns.push({ id: `PR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, batchId: batch.id, date: TODAY, producedPacks: packs, status: "complete" });
    showToast(`Выпуск ${packs} упаковок зафиксирован.`);
  }
  saveState();
  stageDialog.close();
  render();
});

async function startCloud() {
  const app = document.querySelector(".app-shell");
  if (!cloudEnabled) {
    app.hidden = false;
    render();
    return;
  }
  app.hidden = true;
  document.querySelector("#syncStatus").textContent = "Подключение…";
  cloudUser = await openDemoSession();
  let remote = await readWorkspace(cloudUser.id);
  if (!remote) remote = await createWorkspace(seedState(), cloudUser.id);
  if (!remote) throw new Error("Рабочие данные недоступны");
  state = hydrateState({ ...remote.state, currentView: "overview" });
  cloudRevision = remote.revision;
  cloudBaseState = structuredClone(remote.state);
  cloudBaseState.currentView = "overview";
  lastQueuedState = structuredClone(cloudBaseState);
  cloudSaveBlocked = false;
  app.hidden = false;
  document.querySelector("#syncStatus").textContent = "Сохранено";
  document.querySelector("#reloadWorkspace").hidden = false;
  document.querySelector("#reloadWorkspace").textContent = "Обновить данные";
  render();
  setInterval(refreshWorkspace, 3500);
}

async function refreshWorkspace() {
  if (refreshInFlight || document.hidden || !cloudUser || cloudSaveBlocked || !sameValue(lastQueuedState, cloudBaseState)) return;
  refreshInFlight = true;
  try {
    const remote = await readWorkspace(cloudUser.id);
    if (remote && remote.revision > cloudRevision && sameValue(lastQueuedState, cloudBaseState)) {
      const currentView = state.currentView;
      const selectedBatchId = state.selectedBatchId;
      state = hydrateState({ ...remote.state, currentView, selectedBatchId });
      cloudRevision = remote.revision;
      cloudBaseState = structuredClone(remote.state);
      cloudBaseState.currentView = "overview";
      lastQueuedState = structuredClone(cloudBaseState);
      document.querySelector("#syncStatus").textContent = "Обновлено";
      render();
    }
  } catch {
    document.querySelector("#syncStatus").textContent = "Связь прервана";
  } finally {
    refreshInFlight = false;
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshWorkspace(); });

document.querySelector("#reloadWorkspace").addEventListener("click", () => location.reload());
startCloud().catch((error) => {
  document.querySelector(".app-shell").hidden = false;
  document.querySelector("#syncStatus").textContent = `Ошибка подключения: ${error.message}`;
  document.querySelector("#reloadWorkspace").hidden = false;
  cloudSaveBlocked = true;
  render();
});
