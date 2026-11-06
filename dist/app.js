import {
  STORAGE_KEY,
  SCENARIOS,
  buildPickupRoute,
  calculateDryOutput,
  calculateEconomics,
  calculatePackOutput,
  estimateWetGroundsKg,
  formatMoney,
  formatNumber,
  normalizeImportedRows,
  parseCsv,
  round,
} from "./logic.js";

const TODAY = "2026-11-06";
const viewMeta = {
  overview: "Смена и задачи",
  collections: "Сбор на точках",
  logistics: "Логистика",
  production: "Производство",
  economics: "Экономика",
  traceability: "Паспорт партии",
  data: "Данные",
};

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
    ["COL-101", "GC-01", "2026-11-06", 238, 7.7, "ready", "good", "measured"],
    ["COL-102", "GC-02", "2026-11-06", 211, 6.8, "ready", "good", "measured"],
    ["COL-103", "GC-03", "2026-11-06", 326, 10.4, "ready", "pending", "estimated"],
    ["COL-104", "GC-04", "2026-11-05", 279, 8.9, "scheduled", "good", "measured"],
    ["COL-105", "GC-05", "2026-11-05", 187, 6.0, "collected", "good", "estimated"],
    ["COL-106", "GC-06", "2026-11-05", 301, 9.6, "collected", "good", "measured"],
    ["COL-107", "GC-01", "2026-11-04", 247, 7.9, "collected", "good", "measured"],
    ["COL-108", "GC-03", "2026-11-04", 319, 10.2, "collected", "good", "estimated"],
    ["COL-109", "GC-04", "2026-11-04", 291, 9.3, "collected", "good", "measured"],
    ["COL-110", "GC-02", "2026-11-03", 205, 6.6, "rejected", "rejected", "measured"],
  ].map(([id, storeId, date, cups, wetKg, status, quality, weightSource]) => ({
    id, storeId, date, cups, wetKg, status, quality, weightSource, source: "synthetic", note: "",
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
        date: "2026-11-05",
        status: "completed",
        collectionIds: ["COL-105", "COL-106", "COL-107", "COL-108", "COL-109"],
        distanceKm: 18.4,
        estimatedMinutes: 96,
      },
    ],
    batches: [
      {
        id: "GL-261104-A",
        createdAt: "2026-11-04",
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
        recipe: "R-01 / кофейный жмых + бумажное волокно + связующее",
      },
      {
        id: "GL-261105-B",
        createdAt: "2026-11-05",
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
        recipe: "R-01 / тестовая рецептура",
      },
    ],
    productionRuns: [
      { id: "PR-001", batchId: "GL-261104-A", date: "2026-11-05", producedPacks: 78, status: "complete" },
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
    return { ...seedState(), ...parsed };
  } catch {
    return seedState();
  }
}

let state = loadState();
let toastTimer;

const contentArea = document.querySelector("#contentArea");
const viewTitle = document.querySelector("#viewTitle");
const globalScenario = document.querySelector("#globalScenario");
const collectionDialog = document.querySelector("#collectionDialog");
const collectionForm = document.querySelector("#collectionForm");
const collectionStore = document.querySelector("#collectionStore");
const collectionDate = document.querySelector("#collectionDate");
const toast = document.querySelector("#toast");

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" }).format(new Date(`${value}T12:00:00`));
}

function syntheticNotice() {
  return `
    <div class="data-note">
      <span class="data-note-dot"></span>
      <strong>Демо · синтетические данные</strong>
    </div>`;
}

function renderKpis(metrics) {
  return `
    <div class="metrics-strip">
      <article class="metric"><div class="kpi-label">Точки в пилоте</div><div class="kpi-value">${metrics.activeStores}</div><div class="kpi-footer">из ${state.stores.length} точек сети</div></article>
      <article class="metric"><div class="kpi-label">Учтено за цикл</div><div class="kpi-value">${formatNumber(metrics.wetKg, 1)} <small>кг</small></div><div class="kpi-footer">${metrics.measuredPct}% взвешено</div></article>
      <article class="metric metric-attention"><div class="kpi-label">К вывозу</div><div class="kpi-value">${formatNumber(metrics.readyKg, 1)} <small>кг</small></div><div class="kpi-footer">${metrics.readyCount} готовых контейнера</div></article>
      <article class="metric"><div class="kpi-label">Модельная прибыль</div><div class="kpi-value">${formatMoney(metrics.economics.profit)}</div><div class="kpi-footer">${metrics.economics.marginPct}% · ${SCENARIOS[state.scenario].label.toLowerCase()} расчёт</div></article>
    </div>`;
}

function dashboardMetrics() {
  const relevant = state.collections.filter((item) => item.status !== "rejected");
  const wetKg = relevant.reduce((sum, item) => sum + Number(item.wetKg || 0), 0);
  const ready = relevant.filter((item) => item.status === "ready");
  const measured = relevant.filter((item) => item.weightSource === "measured").length;
  const active = state.stores.filter((store) => store.active);
  const avgCups = active.length ? active.reduce((sum, store) => sum + store.avgCups, 0) / active.length : 0;
  const scenario = SCENARIOS[state.scenario];
  const economics = calculateEconomics({
    activeStores: active.length,
    cupsPerStoreDay: avgCups,
    daysPerMonth: 30,
    groundsPerPackG: 160,
    ...scenario,
  });
  return {
    activeStores: active.length,
    wetKg,
    readyKg: ready.reduce((sum, item) => sum + Number(item.wetKg || 0), 0),
    readyCount: ready.length,
    measuredPct: relevant.length ? Math.round((measured / relevant.length) * 100) : 0,
    economics,
  };
}

function renderOverview() {
  const metrics = dashboardMetrics();
  const recent = [...state.collections].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const workflowWet = round(state.collections.filter((x) => x.status !== "rejected").reduce((s, x) => s + x.wetKg, 0), 1);
  const workflowDry = calculateDryOutput(workflowWet, SCENARIOS[state.scenario].dryYieldPct, SCENARIOS[state.scenario].rejectPct);
  const packs = calculatePackOutput(workflowDry.acceptedKg, 160, 100);
  const pendingQuality = state.collections.filter((x) => x.quality === "pending").length;
  const activeRoutes = state.routes.filter((x) => x.status === "planned").length;
  const unbatched = state.collections.filter((x) => x.status === "collected" && !state.batches.some((b) => b.collectionIds.includes(x.id)));
  const activeStores = state.stores.filter((store) => store.active);
  return `
    <div class="view-stack">
      ${syntheticNotice()}
      ${renderKpis(metrics)}
      <section class="operations-grid">
        <article class="panel flow-panel">
          <div class="panel-header"><div><h2>Поток материала</h2></div><span class="panel-meta">23:10</span></div>
          <div class="material-flow">
            <div class="material-stage"><span class="stage-index">01</span><div><small>На точках</small><strong>${formatNumber(workflowWet, 1)} кг</strong><p>Мокрый жмых</p></div></div>
            <span class="route-connector"></span>
            <div class="material-stage"><span class="stage-index">02</span><div><small>После сушки</small><strong>${formatNumber(workflowDry.driedKg, 1)} кг</strong><p>${SCENARIOS[state.scenario].dryYieldPct}% выхода</p></div></div>
            <span class="route-connector"></span>
            <div class="material-stage"><span class="stage-index">03</span><div><small>Принято</small><strong>${formatNumber(workflowDry.acceptedKg, 1)} кг</strong><p>После контроля</p></div></div>
            <span class="route-connector"></span>
            <div class="material-stage material-stage-final"><span class="stage-index">04</span><div><small>Потенциал</small><strong>${packs.producedPacks} уп.</strong><p>По 160 г жмыха</p></div></div>
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
            ${recent.map((item) => `<tr><td><span class="table-title">${storeFor(item.storeId)?.name || item.storeName}</span><span class="table-sub">${item.id}</span></td><td>${formatDate(item.date)}</td><td>${formatNumber(item.cups)}</td><td>${formatNumber(item.wetKg, 1)} кг <span class="badge badge-${item.weightSource}">${sourceLabel(item.weightSource)}</span></td><td><span class="badge badge-${item.status}">${statusLabel(item.status)}</span></td></tr>`).join("")}
          </tbody></table></div>
        </article>
        <article class="panel stores-panel">
          <div class="panel-header"><div><h2>Точки</h2></div><span class="panel-meta">${activeStores.length}</span></div>
          <div class="store-list">
            ${activeStores.map((store) => {
              const expected = estimateWetGroundsKg(store.avgCups, SCENARIOS[state.scenario].wetGramsPerCup);
              const actual = state.collections.filter((x)=>x.storeId===store.id && x.date===TODAY && x.status!=="rejected").reduce((sum,x)=>sum+x.wetKg,0);
              const pct = Math.min(100, Math.round((actual / Math.max(expected, .1))*100));
              return `<div class="store-row"><div><strong>${store.name.replace("Global Coffee — ","")}</strong><small>${actual ? `${formatNumber(actual,1)} из ${formatNumber(expected,1)} кг` : `нет записи · ожидается ${formatNumber(expected,1)} кг`}</small></div><div class="store-progress"><span style="width:${pct}%"></span></div><span class="store-percent">${pct}%</span></div>`;
            }).join("")}
          </div>
        </article>
      </section>
    </div>`;
}

function renderCollections() {
  const activeStores = state.stores.filter((store) => store.active);
  return `
    <div class="view-stack">
      ${syntheticNotice()}
      <section class="kpi-grid">
        <article class="kpi-card"><div class="kpi-label">Записей</div><div class="kpi-value">${state.collections.length}</div><div class="kpi-footer"><span>за демо-период</span></div></article>
        <article class="kpi-card"><div class="kpi-label">Измерено</div><div class="kpi-value">${state.collections.filter((x) => x.weightSource === "measured").length}</div><div class="kpi-footer"><span>реальный ввод оператора</span></div></article>
        <article class="kpi-card"><div class="kpi-label">Оценено</div><div class="kpi-value">${state.collections.filter((x) => x.weightSource === "estimated").length}</div><div class="kpi-footer"><span>по напиткам Coyote</span></div></article>
        <article class="kpi-card"><div class="kpi-label">Отклонено</div><div class="kpi-value">${state.collections.filter((x) => x.status === "rejected").length}</div><div class="kpi-footer"><span>не попадёт в партию</span></div></article>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>Журнал сбора</h2></div><button class="button button-primary" data-action="open-collection">Добавить</button></div>
        <div class="table-wrap"><table><thead><tr><th>ID</th><th>Точка</th><th>Дата</th><th>Продажи</th><th>Жмых</th><th>Качество</th><th>Статус</th></tr></thead><tbody>
          ${[...state.collections].sort((a,b) => b.date.localeCompare(a.date)).map((item) => `<tr><td>${item.id}</td><td><span class="table-title">${storeFor(item.storeId)?.name || item.storeName}</span><span class="table-sub">${storeFor(item.storeId)?.district || "Импорт"}</span></td><td>${formatDate(item.date)}</td><td>${formatNumber(item.cups)} напитков</td><td><strong>${formatNumber(item.wetKg,1)} кг</strong><span class="table-sub">${sourceLabel(item.weightSource)}</span></td><td><span class="badge badge-${item.quality}">${qualityLabel(item.quality)}</span></td><td><span class="badge badge-${item.status}">${statusLabel(item.status)}</span></td></tr>`).join("")}
        </tbody></table></div>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>Точки пилота</h2></div><span class="badge badge-good">${activeStores.length} активных</span></div>
        <div class="panel-pad triple-grid">
          ${activeStores.map((store) => {
            const entries = state.collections.filter((x) => x.storeId === store.id && x.status !== "rejected");
            const kg = entries.reduce((s,x) => s + x.wetKg,0);
            return `<article class="batch-card"><div class="batch-head"><div><h3>${store.name.replace("Global Coffee — ","")}</h3><span class="table-sub">${store.district}</span></div><span class="badge badge-good">в пилоте</span></div><div class="batch-meta"><div><span>чашек/день</span><strong>${store.avgCups}</strong></div><div><span>учтено</span><strong>${round(kg,1)} кг</strong></div><div><span>записей</span><strong>${entries.length}</strong></div></div></article>`;
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
      <section class="split-grid">
        <article class="route-card">
          <div class="route-top"><div><p class="eyebrow">Сборка маршрута</p><h3>Следующий маршрут</h3></div><span class="badge badge-${routePreview.stops.length ? "scheduled" : "complete"}">${routePreview.stops.length ? `${routePreview.stops.length} остановки` : "нет заявок"}</span></div>
          <div class="route-metrics"><div class="route-metric"><span>Сырьё</span><strong>${routePreview.totalKg} кг</strong></div><div class="route-metric"><span>Дистанция</span><strong>${routePreview.distanceKm} км</strong></div><div class="route-metric"><span>Время</span><strong>${routePreview.estimatedMinutes} мин</strong></div></div>
          <div class="route-path">${routePreview.stops.length ? routePreview.stops.map((item, index) => `<span class="route-stop">${index+1}. ${(storeFor(item.storeId)?.name || item.storeName).replace("Global Coffee — ","")}</span>`).join("<span class='flow-arrow'>→</span>") : "<span style='color:rgba(255,255,255,.55)'>Добавьте записи со статусом «Готов к вывозу».</span>"}</div>
          <div style="margin-top:20px"><button class="button button-primary" data-action="create-route" ${!routePreview.stops.length ? "disabled" : ""}>Создать маршрут</button></div>
        </article>
        <article class="panel panel-pad">
          <p class="eyebrow">Логика MVP</p><h2 style="margin:8px 0 14px">Как система решает, когда ехать</h2>
          <div class="assumption-list">
            <div class="assumption"><i></i><span>Контейнер отмечен готовым</span><strong>обязательно</strong></div>
            <div class="assumption"><i></i><span>Точки группируются по району</span><strong>автоматически</strong></div>
            <div class="assumption"><i></i><span>Масса партии</span><strong>из журнала</strong></div>
            <div class="assumption"><i></i><span>Оптимизация дорог</span><strong>демо-эвристика</strong></div>
          </div>
          <p style="color:var(--muted);font-size:11px;line-height:1.6;margin-bottom:0">В продакшене эвристику можно заменить картографическим API, не меняя процесс для бариста.</p>
        </article>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>Маршруты</h2></div></div>
        <div class="table-wrap"><table><thead><tr><th>Маршрут</th><th>Дата</th><th>Остановки</th><th>Вес</th><th>Дистанция</th><th>Статус</th><th></th></tr></thead><tbody>
          ${routes.map((route) => {
            const items = state.collections.filter((x) => route.collectionIds.includes(x.id));
            const kg = items.reduce((s,x) => s + x.wetKg,0);
            return `<tr><td><span class="table-title">${route.id}</span></td><td>${formatDate(route.date)}</td><td>${items.length}</td><td>${round(kg,1)} кг</td><td>${route.distanceKm} км</td><td><span class="badge badge-${route.status}">${statusLabel(route.status)}</span></td><td>${route.status === "planned" ? `<button class="button button-dark button-small" data-action="complete-route" data-id="${route.id}">Завершить</button>` : ""}</td></tr>`;
          }).join("") || `<tr><td colspan="7"><div class="empty-state"><strong>Маршрутов пока нет</strong>Создайте первый маршрут из готовых контейнеров.</div></td></tr>`}
        </tbody></table></div>
      </section>
    </div>`;
}

function renderProduction() {
  const unbatched = state.collections.filter((x) => x.status === "collected" && !x.batchId && !state.batches.some((b) => b.collectionIds.includes(x.id)));
  return `
    <div class="view-stack">
      ${syntheticNotice()}
      <section class="kpi-grid">
        <article class="kpi-card"><div class="kpi-label">Собрано без партии</div><div class="kpi-value">${round(unbatched.reduce((s,x)=>s+x.wetKg,0),1)} кг</div><div class="kpi-footer"><span>${unbatched.length} записей</span></div></article>
        <article class="kpi-card"><div class="kpi-label">Партий</div><div class="kpi-value">${state.batches.length}</div><div class="kpi-footer"><span>полная прослеживаемость</span></div></article>
        <article class="kpi-card"><div class="kpi-label">Готовой продукции</div><div class="kpi-value">${state.productionRuns.reduce((s,x)=>s+x.producedPacks,0)}</div><div class="kpi-footer"><span>упаковок в демо</span></div></article>
        <article class="kpi-card"><div class="kpi-label">Базовый сухой выход</div><div class="kpi-value">${SCENARIOS[state.scenario].dryYieldPct}%</div><div class="kpi-footer"><span>редактируется в экономике</span></div></article>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>Партии</h2></div><button class="button button-primary" data-action="create-batch" ${!unbatched.length ? "disabled" : ""}>Новая партия</button></div>
        <div class="panel-pad triple-grid">
          ${state.batches.map((batch) => `<article class="batch-card ${batch.id === state.selectedBatchId ? "selected" : ""}">
            <div class="batch-head"><div><h3>${batch.id}</h3><span class="table-sub">${formatDate(batch.createdAt)} · ${batch.sourceStores.length} точки</span></div><span class="badge badge-${batch.status}">${statusLabel(batch.status)}</span></div>
            <div class="batch-meta"><div><span>мокрый вес</span><strong>${batch.wetKg} кг</strong></div><div><span>чистый сухой</span><strong>${batch.acceptedKg} кг</strong></div><div><span>упаковки</span><strong>${batch.producedPacks || "—"}</strong></div></div>
            <div style="display:flex;gap:8px;margin-top:14px"><button class="button button-ghost button-small" data-action="select-batch" data-id="${batch.id}">Открыть</button>${batch.status !== "complete" ? `<button class="button button-dark button-small" data-action="advance-batch" data-id="${batch.id}">Следующий этап</button>` : ""}</div>
          </article>`).join("")}
        </div>
      </section>
      ${renderSelectedBatch()}
    </div>`;
}

function renderSelectedBatch() {
  const batch = state.batches.find((b) => b.id === state.selectedBatchId) || state.batches[0];
  if (!batch) return "";
  const potential = calculatePackOutput(batch.acceptedKg, batch.groundsPerPackG || 160, 100);
  const sources = batch.sourceStores.map((id) => storeFor(id)?.name.replace("Global Coffee — ","") || id).join(", ");
  return `<section class="split-grid">
    <article class="panel panel-pad">
      <p class="eyebrow">Выбранная партия</p><h2 style="margin:7px 0 18px">${batch.id}</h2>
      <div class="form-grid">
        <label class="field">Сухой выход, %<input type="number" value="${batch.dryYieldPct}" disabled /></label>
        <label class="field">Брак, %<input type="number" value="${batch.rejectPct}" disabled /></label>
        <label class="field">Жмых на упаковку, г<input type="number" value="${batch.groundsPerPackG || 160}" disabled /></label>
        <label class="field">Потенциальный выпуск<input type="text" value="${potential.producedPacks} упаковок" disabled /></label>
        <label class="field field-wide">Источники<input type="text" value="${sources}" disabled /></label>
      </div>
      <div style="margin-top:16px;display:flex;gap:9px"><button class="button button-primary" data-action="create-run" data-id="${batch.id}" ${batch.status !== "complete" || batch.producedPacks ? "disabled" : ""}>Зафиксировать выпуск</button><button class="button button-ghost" data-view-link="traceability">Паспорт партии</button></div>
    </article>
    <article class="panel">
      <div class="panel-header"><div><h2>Этапы</h2></div></div>
      <div class="stepper">
        <div class="step-row"><span class="step-index">1</span><div><strong>Приёмка</strong><p>Вес и происхождение партии</p></div><span class="step-stat">${batch.wetKg} кг</span></div>
        <div class="step-row"><span class="step-index">2</span><div><strong>Сушка</strong><p>Контроль влажности партнёром</p></div><span class="step-stat">${batch.driedKg} кг</span></div>
        <div class="step-row"><span class="step-index">3</span><div><strong>Контроль</strong><p>Удаление загрязнённого сырья</p></div><span class="step-stat">${batch.acceptedKg} кг</span></div>
        <div class="step-row"><span class="step-index">4</span><div><strong>Формование и упаковка</strong><p>${batch.recipe}</p></div><span class="step-stat">${batch.producedPacks || potential.producedPacks} уп.</span></div>
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
      <article class="profit-card ${e.profit < 0 ? "negative" : ""}"><span>Операционная прибыль / месяц</span><strong>${formatMoney(e.profit)}</strong><small>${e.marginPct}% от выручки · при реализации ${p.sellThroughPct}% выпуска</small></article>
      <article class="breakdown"><div class="breakdown-row"><span>Выручка</span><strong>${formatMoney(e.revenue)}</strong></div><div class="breakdown-row"><span>Переменные расходы</span><strong>− ${formatMoney(e.variableCost)}</strong></div><div class="breakdown-row"><span>Логистика</span><strong>− ${formatMoney(p.monthlyLogisticsCost)}</strong></div><div class="breakdown-row"><span>Постоянные расходы</span><strong>− ${formatMoney(p.monthlyFixedCost)}</strong></div><div class="breakdown-row total"><span>Результат</span><strong>${formatMoney(e.profit)}</strong></div></article>
    </section>
    <section class="split-grid">
      <article class="panel panel-pad"><p class="eyebrow">Параметры расчёта</p><h2 style="margin:7px 0 18px">Проверьте любую гипотезу</h2>${ranges.map(([key,label,min,max,step,suffix]) => `<div class="range-field"><div class="range-head"><span>${label}</span><strong data-value-for="${key}">${formatNumber(p[key],0)}${suffix}</strong></div><input type="range" min="${min}" max="${max}" step="${step}" value="${p[key]}" data-economics-key="${key}" data-suffix="${suffix}" /></div>`).join("")}</article>
      <article class="panel">
        <div class="panel-header"><div><h2>Баланс за месяц</h2></div></div>
        <div class="stepper">
          <div class="step-row"><span class="step-index">1</span><div><strong>Проданные напитки</strong><p>${p.activeStores} точек × ${p.cupsPerStoreDay} × 30 дней</p></div><span class="step-stat">${formatNumber(p.activeStores*p.cupsPerStoreDay*30)}</span></div>
          <div class="step-row"><span class="step-index">2</span><div><strong>Мокрый жмых</strong><p>${p.wetGramsPerCup} г на напиток</p></div><span class="step-stat">${formatNumber(e.wetKg,0)} кг</span></div>
          <div class="step-row"><span class="step-index">3</span><div><strong>Принято после сушки</strong><p>Сухой выход ${p.dryYieldPct}%, брак ${p.rejectPct}%</p></div><span class="step-stat">${formatNumber(e.acceptedKg,0)} кг</span></div>
          <div class="step-row"><span class="step-index">4</span><div><strong>Произведено</strong><p>${p.groundsPerPackG} г жмыха на упаковку</p></div><span class="step-stat">${formatNumber(e.producedPacks)} уп.</span></div>
          <div class="step-row"><span class="step-index">5</span><div><strong>Продано</strong><p>Коэффициент реализации ${p.sellThroughPct}%</p></div><span class="step-stat">${formatNumber(e.soldPacks)} уп.</span></div>
        </div>
        <div class="panel-pad" style="padding-top:0"><div class="notice"><span class="notice-dot"></span><div><strong>Точка безубыточности</strong>${formatNumber(e.breakEvenPacks)} проданных упаковок в месяц при текущей цене и себестоимости.</div></div></div>
      </article>
    </section>
  </div>`;
}

function renderTraceability() {
  const batch = state.batches.find((b) => b.id === state.selectedBatchId) || state.batches[0];
  if (!batch) return `<div class="empty-state"><strong>Нет партий</strong>Сначала создайте партию в разделе «Производство».</div>`;
  const stores = batch.sourceStores.map((id) => storeFor(id)).filter(Boolean);
  return `<div class="view-stack">
    <div class="panel panel-pad" style="display:flex;align-items:end;justify-content:space-between;gap:15px;flex-wrap:wrap"><label class="field" style="min-width:280px">Выберите партию<select id="passportBatch">${state.batches.map((b)=>`<option value="${b.id}" ${b.id===batch.id?"selected":""}>${b.id} · ${statusLabel(b.status)}</option>`).join("")}</select></label><span class="badge badge-${batch.status}">${statusLabel(batch.status)}</span></div>
    <section class="passport">
      <div class="passport-cover" data-batch="${batch.id}"><p class="eyebrow">Паспорт партии</p><h2>${batch.id}</h2></div>
      <div class="passport-grid">
        <div class="passport-section"><h3>Происхождение</h3>${stores.map((s)=>`<div class="passport-fact"><span>${s.name.replace("Global Coffee — ","")}</span><strong>${s.district}</strong></div>`).join("") || `<div class="passport-fact"><span>Источник</span><strong>не указан</strong></div>`}</div>
        <div class="passport-section"><h3>Материальный баланс</h3><div class="passport-fact"><span>Мокрый жмых</span><strong>${batch.wetKg} кг</strong></div><div class="passport-fact"><span>После сушки</span><strong>${batch.driedKg} кг</strong></div><div class="passport-fact"><span>Принято</span><strong>${batch.acceptedKg} кг</strong></div><div class="passport-fact"><span>Выпуск</span><strong>${batch.producedPacks ? `${batch.producedPacks} уп.` : "ожидается"}</strong></div></div>
        <div class="passport-section"><h3>Контроль партии</h3><div class="passport-fact"><span>Дата создания</span><strong>${formatDate(batch.createdAt)}</strong></div><div class="passport-fact"><span>Рецептура</span><strong>R-01</strong></div><div class="passport-fact"><span>Статус</span><strong>${statusLabel(batch.status)}</strong></div></div>
        <div class="passport-section"><h3>QR-макет</h3><div style="display:flex;align-items:center;gap:18px"><div class="qr-placeholder">${Array.from({length:25},()=>"<i></i>").join("")}</div><p style="color:var(--muted);font-size:10px;line-height:1.55">В финальной упаковке код ведёт на эту страницу партии.</p></div></div>
      </div>
    </section>
  </div>`;
}

function renderData() {
  return `<div class="view-stack">
    ${syntheticNotice()}
    <section class="split-grid">
      <article class="panel panel-pad">
        <p class="eyebrow">Импорт Coyote</p><h2 style="margin:7px 0 16px">Загрузите CSV или Excel</h2>
        <div class="upload-zone" id="uploadZone"><div class="upload-icon">⇧</div><h3>Перетащите отчёт сюда</h3><p>Колонки: Точка, Дата, Напитки, Жмых кг. Вес можно не указывать — он будет рассчитан.</p><input type="file" id="fileInput" accept=".csv,.xlsx,.xls" hidden /><button class="button button-primary" data-action="choose-file">Выбрать файл</button></div>
        ${state.lastImport ? `<div class="notice" style="margin-top:15px"><span class="notice-dot"></span><div><strong>Последний импорт: ${state.lastImport.fileName}</strong>${state.lastImport.rows} строк · ${state.lastImport.at}</div></div>` : ""}
      </article>
      <article class="panel panel-pad">
        <p class="eyebrow">Управление данными</p><h2 style="margin:7px 0 16px">Переносимые данные</h2>
        <div class="data-actions"><button class="button button-dark" data-action="download-template">Скачать шаблон CSV</button><button class="button button-ghost" data-action="export-json">Экспорт JSON</button><button class="button button-ghost" data-action="reset-demo">Сбросить демо</button></div>
        <div class="assumption-list" style="margin-top:22px"><div class="assumption"><i></i><span>Текущий источник</span><strong>${state.dataMode === "synthetic" ? "Синтетика" : "Импорт"}</strong></div><div class="assumption"><i></i><span>Хранилище MVP</span><strong>Браузер</strong></div><div class="assumption"><i></i><span>Импортированных записей</span><strong>${state.collections.filter((x)=>x.source==="import").length}</strong></div><div class="assumption"><i></i><span>Готовность к API</span><strong>через адаптер</strong></div></div>
      </article>
    </section>
    <section class="panel">
      <div class="panel-header"><div><h2>Формат файла</h2></div></div>
      <div class="table-wrap"><table><thead><tr><th>Точка</th><th>Дата</th><th>Напитки</th><th>Жмых кг</th><th>Что произойдёт</th></tr></thead><tbody><tr><td>Global Coffee — Абая</td><td>2026-11-06</td><td>238</td><td>7.7</td><td>Вес отмечается как измеренный</td></tr><tr><td>Global Coffee — Mega</td><td>2026-11-06</td><td>326</td><td>пусто</td><td>Вес оценивается по сценарию</td></tr></tbody></table></div>
    </section>
  </div>`;
}

function render() {
  viewTitle.textContent = viewMeta[state.currentView] || viewMeta.overview;
  globalScenario.value = state.scenario;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === state.currentView));
  const renderers = { overview: renderOverview, collections: renderCollections, logistics: renderLogistics, production: renderProduction, economics: renderEconomics, traceability: renderTraceability, data: renderData };
  contentArea.innerHTML = (renderers[state.currentView] || renderOverview)();
  bindViewSpecificEvents();
}

function setView(view) {
  state.currentView = view;
  saveState();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
  document.querySelector("#sidebar").classList.remove("open");
}

function openCollectionDialog() {
  collectionStore.innerHTML = state.stores.filter((x) => x.active).map((store) => `<option value="${store.id}">${store.name}</option>`).join("");
  collectionDate.value = TODAY;
  collectionDialog.showModal();
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
    groundsPerPackG: 160,
    ...SCENARIOS[key],
  };
  saveState();
  render();
}

function createRoute() {
  const preview = buildPickupRoute(state.collections, state.stores);
  if (!preview.stops.length) return showToast("Нет готовых контейнеров для маршрута.");
  const route = {
    id: `RT-${TODAY.replaceAll("-","")}-${String(state.routes.length+1).padStart(2,"0")}`,
    date: TODAY,
    status: "planned",
    collectionIds: preview.stops.flatMap((x)=>x.collectionIds || [x.id]),
    distanceKm: preview.distanceKm,
    estimatedMinutes: preview.estimatedMinutes,
  };
  state.routes.push(route);
  state.collections = state.collections.map((item) => route.collectionIds.includes(item.id) ? { ...item, status: "scheduled", routeId: route.id } : item);
  saveState(); render(); showToast(`Маршрут ${route.id} создан.`);
}

function completeRoute(id) {
  const route = state.routes.find((x) => x.id === id);
  if (!route) return;
  route.status = "completed";
  state.collections = state.collections.map((item) => route.collectionIds.includes(item.id) ? { ...item, status: "collected" } : item);
  saveState(); render(); showToast(`Маршрут ${id} завершён, сырьё принято.`);
}

function createBatch() {
  const items = state.collections.filter((x) => x.status === "collected" && !x.batchId && !state.batches.some((b)=>b.collectionIds.includes(x.id)));
  if (!items.length) return showToast("Нет собранных записей без партии.");
  const wetKg = round(items.reduce((s,x)=>s+x.wetKg,0),2);
  const scenario = SCENARIOS[state.scenario];
  const dry = calculateDryOutput(wetKg, scenario.dryYieldPct, scenario.rejectPct);
  const id = `GL-${TODAY.slice(2).replaceAll("-","")}-${String.fromCharCode(65+state.batches.length)}`;
  const batch = {
    id, createdAt: TODAY, collectionIds: items.map((x)=>x.id), sourceStores: [...new Set(items.map((x)=>x.storeId))], wetKg,
    dryYieldPct: scenario.dryYieldPct, rejectPct: scenario.rejectPct, driedKg: dry.driedKg, acceptedKg: dry.acceptedKg,
    status: "received", groundsPerPackG: 160, producedPacks: 0, recipe: "R-01 / тестовая рецептура",
  };
  state.batches.unshift(batch);
  state.collections = state.collections.map((x)=>items.some((i)=>i.id===x.id)?{...x,batchId:id}:x);
  state.selectedBatchId = id;
  saveState(); render(); showToast(`Партия ${id} сформирована.`);
}

function advanceBatch(id) {
  const batch = state.batches.find((x)=>x.id===id);
  if (!batch) return;
  const flow = ["received","drying","production","complete"];
  batch.status = flow[Math.min(flow.length-1, flow.indexOf(batch.status)+1)];
  saveState(); render(); showToast(`${id}: ${statusLabel(batch.status)}.`);
}

function createRun(id) {
  const batch = state.batches.find((x)=>x.id===id);
  if (!batch || batch.status !== "complete" || batch.producedPacks) return;
  const output = calculatePackOutput(batch.acceptedKg, batch.groundsPerPackG, 100);
  batch.producedPacks = output.producedPacks;
  state.productionRuns.push({ id:`PR-${String(state.productionRuns.length+1).padStart(3,"0")}`, batchId:id, date:TODAY, producedPacks:output.producedPacks, status:"complete" });
  saveState(); render(); showToast(`Выпуск ${output.producedPacks} упаковок зафиксирован.`);
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
    let rows;
    if (file.name.toLowerCase().endsWith(".csv")) {
      rows = parseCsv(await file.text());
    } else {
      if (!window.XLSX) throw new Error("Модуль Excel ещё не загрузился. Попробуйте CSV или повторите через несколько секунд.");
      const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
      rows = window.XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
    }
    const normalized = normalizeImportedRows(rows, { wetGramsPerCup: SCENARIOS[state.scenario].wetGramsPerCup });
    if (!normalized.length) throw new Error("Не найдены строки с количеством напитков или весом.");
    normalized.forEach((item) => {
      let store = state.stores.find((s)=>s.name.toLowerCase()===item.storeName.toLowerCase());
      if (!store) {
        store = { id:`IMP-S-${state.stores.length+1}`, name:item.storeName, district:"Импорт", avgCups:item.cups, active:true };
        state.stores.push(store);
      }
      state.collections.push({ ...item, storeId:store.id });
    });
    state.dataMode = "mixed";
    state.lastImport = { fileName:file.name, rows:normalized.length, at:new Intl.DateTimeFormat("ru-RU",{dateStyle:"short",timeStyle:"short"}).format(new Date()) };
    saveState(); render(); showToast(`Импортировано ${normalized.length} строк.`);
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
    saveState(); render();
  }));
}

document.querySelectorAll(".nav-item").forEach((item)=>item.addEventListener("click",()=>setView(item.dataset.view)));
document.querySelector("#menuButton").addEventListener("click",()=>document.querySelector("#sidebar").classList.toggle("open"));
document.querySelectorAll("[data-action='open-collection']").forEach((button)=>button.addEventListener("click",openCollectionDialog));
globalScenario.addEventListener("change",()=>applyScenario(globalScenario.value));

contentArea.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.viewLink) return setView(button.dataset.viewLink);
  const { action, id } = button.dataset;
  if (action === "open-collection") openCollectionDialog();
  if (action === "create-route") createRoute();
  if (action === "complete-route") completeRoute(id);
  if (action === "create-batch") createBatch();
  if (action === "advance-batch") advanceBatch(id);
  if (action === "select-batch") { state.selectedBatchId=id; saveState(); render(); }
  if (action === "create-run") createRun(id);
  if (action === "set-scenario") applyScenario(id);
  if (action === "choose-file") document.querySelector("#fileInput")?.click();
  if (action === "download-template") download("groundloop-template.csv", "Точка,Дата,Напитки,Жмых кг\nGlobal Coffee — Абая,2026-11-06,238,7.7\nGlobal Coffee — Mega,2026-11-06,326,\n", "text/csv;charset=utf-8");
  if (action === "export-json") download("groundloop-export.json", JSON.stringify(state,null,2), "application/json");
  if (action === "reset-demo") {
    if (window.confirm("Сбросить все изменения и вернуть исходные синтетические данные?")) { state=seedState(); saveState(); render(); showToast("Демо-данные восстановлены."); }
  }
});

collectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(collectionForm);
  const storeId = data.get("storeId");
  const cups = Number(data.get("cups"));
  const enteredWeight = Number(data.get("wetKg"));
  const estimated = !enteredWeight;
  const wetKg = enteredWeight || estimateWetGroundsKg(cups, SCENARIOS[state.scenario].wetGramsPerCup);
  const quality = data.get("quality");
  state.collections.push({
    id:`COL-${Date.now().toString().slice(-6)}`, storeId, date:data.get("date"), cups, wetKg, quality,
    status: quality === "rejected" ? "rejected" : "ready", weightSource: estimated ? "estimated" : "measured",
    source:"manual", note:data.get("note") || "",
  });
  saveState(); collectionDialog.close(); collectionForm.reset(); render(); showToast("Сбор добавлен в журнал.");
});

render();
