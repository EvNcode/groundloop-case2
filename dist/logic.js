export const STORAGE_KEY = "groundloop-state-v1";

export const SCENARIOS = {
  conservative: {
    label: "Осторожный",
    wetGramsPerCup: 24,
    dryYieldPct: 46,
    rejectPct: 14,
    sellThroughPct: 58,
    pricePerPack: 1190,
    variableCostPerPack: 610,
    monthlyLogisticsCost: 540000,
    monthlyFixedCost: 420000,
  },
  base: {
    label: "Базовый",
    wetGramsPerCup: 32,
    dryYieldPct: 50,
    rejectPct: 8,
    sellThroughPct: 76,
    pricePerPack: 1490,
    variableCostPerPack: 550,
    monthlyLogisticsCost: 440000,
    monthlyFixedCost: 420000,
  },
  optimistic: {
    label: "Оптимистичный",
    wetGramsPerCup: 38,
    dryYieldPct: 54,
    rejectPct: 5,
    sellThroughPct: 90,
    pricePerPack: 1690,
    variableCostPerPack: 510,
    monthlyLogisticsCost: 390000,
    monthlyFixedCost: 420000,
  },
};

export function round(value, digits = 1) {
  const p = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * p) / p;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function estimateWetGroundsKg(cups, gramsPerCup) {
  return round((Number(cups) * Number(gramsPerCup)) / 1000, 2);
}

export function calculateDryOutput(wetKg, dryYieldPct, rejectPct) {
  const driedKg = Number(wetKg) * (clamp(dryYieldPct, 0, 100) / 100);
  const acceptedKg = driedKg * (1 - clamp(rejectPct, 0, 100) / 100);
  return {
    driedKg: round(driedKg, 2),
    acceptedKg: round(acceptedKg, 2),
    rejectedKg: round(driedKg - acceptedKg, 2),
  };
}

export function calculatePackOutput(acceptedDryKg, groundsPerPackG, sellThroughPct = 100) {
  const producedPacks = Math.max(0, Math.floor((Number(acceptedDryKg) * 1000) / Math.max(1, Number(groundsPerPackG))));
  const soldPacks = Math.floor(producedPacks * (clamp(sellThroughPct, 0, 100) / 100));
  return { producedPacks, soldPacks, unsoldPacks: producedPacks - soldPacks };
}

export function calculateEconomics(params) {
  const activeStores = Math.max(1, Number(params.activeStores) || 1);
  const cupsPerStoreDay = Math.max(0, Number(params.cupsPerStoreDay) || 0);
  const daysPerMonth = Math.max(1, Number(params.daysPerMonth) || 30);
  const wetKg = estimateWetGroundsKg(
    activeStores * cupsPerStoreDay * daysPerMonth,
    params.wetGramsPerCup,
  );
  const dry = calculateDryOutput(wetKg, params.dryYieldPct, params.rejectPct);
  const packs = calculatePackOutput(dry.acceptedKg, params.groundsPerPackG, params.sellThroughPct);
  const revenue = packs.soldPacks * Number(params.pricePerPack || 0);
  const variableCost = packs.producedPacks * Number(params.variableCostPerPack || 0);
  const operatingCost = variableCost + Number(params.monthlyLogisticsCost || 0) + Number(params.monthlyFixedCost || 0);
  const contribution = revenue - variableCost;
  const profit = revenue - operatingCost;
  const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;
  const breakEvenPacks = Number(params.pricePerPack || 0) > 0
    ? Math.ceil(operatingCost / Number(params.pricePerPack))
    : null;

  return {
    wetKg,
    driedKg: dry.driedKg,
    acceptedKg: dry.acceptedKg,
    rejectedKg: dry.rejectedKg,
    ...packs,
    revenue: round(revenue, 0),
    variableCost: round(variableCost, 0),
    operatingCost: round(operatingCost, 0),
    contribution: round(contribution, 0),
    profit: round(profit, 0),
    marginPct: round(marginPct, 1),
    breakEvenPacks,
  };
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '"' && quoted && next === '"') {
      field += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field.trim());
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field.trim());
  if (row.some((cell) => cell !== "")) rows.push(row);
  if (!rows.length) return [];

  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function normalizedKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function findValue(row, aliases) {
  const keys = Object.keys(row);
  const matched = keys.find((key) => aliases.includes(normalizedKey(key)));
  return matched ? row[matched] : undefined;
}

export function normalizeImportedRows(rows, defaults = {}) {
  const grams = Number(defaults.wetGramsPerCup || SCENARIOS.base.wetGramsPerCup);
  return rows.map((row, index) => {
    const store = findValue(row, ["точка", "магазин", "кофейня", "store", "point", "location", "филиал"]);
    const date = findValue(row, ["дата", "date", "day"]);
    const cupsRaw = findValue(row, ["напитки", "чашки", "количество", "cups", "drinks", "qty", "sales"]);
    const weightRaw = findValue(row, ["жмыхкг", "вескг", "вес", "grounds", "groundskg", "weight", "weightkg", "kg"]);
    const cupsText = String(cupsRaw ?? "").trim();
    const weightText = String(weightRaw ?? "").trim();
    const cups = cupsText ? Number(cupsText.replace(",", ".")) : 0;
    const suppliedWeight = weightText ? Number(weightText.replace(",", ".")) : 0;
    const dateText = date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : String(date ?? "").trim();
    const dateValue = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? new Date(`${dateText}T12:00:00Z`) : null;
    if (!String(store ?? "").trim()) throw new Error(`Строка ${index + 2}: укажите точку.`);
    if (!dateValue || Number.isNaN(dateValue.getTime()) || dateValue.toISOString().slice(0, 10) !== dateText) throw new Error(`Строка ${index + 2}: дата должна быть в формате ГГГГ-ММ-ДД.`);
    if (!Number.isInteger(cups) || cups < 0) throw new Error(`Строка ${index + 2}: число напитков должно быть целым и неотрицательным.`);
    if (!Number.isFinite(suppliedWeight) || suppliedWeight < 0) throw new Error(`Строка ${index + 2}: вес должен быть неотрицательным числом.`);
    if (!cups && !suppliedWeight) throw new Error(`Строка ${index + 2}: укажите напитки или вес.`);
    const wetKg = Number.isFinite(suppliedWeight) && suppliedWeight > 0
      ? round(suppliedWeight, 2)
      : estimateWetGroundsKg(cups, grams);
    if (wetKg <= 0) throw new Error(`Строка ${index + 2}: вес после округления должен быть больше нуля.`);
    return {
      id: `IMP-${Date.now()}-${index + 1}`,
      storeName: String(store || `Импортированная точка ${index + 1}`).trim(),
      date: dateText,
      cups,
      wetKg,
      weightSource: suppliedWeight > 0 ? "measured" : "estimated",
      status: "review",
      quality: "pending",
      source: "import",
    };
  });
}

export function buildPickupRoute(collections, stores) {
  const ready = collections.filter((item) => item.status === "ready" && item.quality === "good" && Number(item.wetKg) > 0);
  const storeById = new Map(stores.map((store) => [store.id, store]));
  const grouped = new Map();
  ready.forEach((item) => {
    const key = item.storeId || item.storeName;
    const current = grouped.get(key) || {
      id: item.id,
      storeId: item.storeId,
      storeName: item.storeName,
      wetKg: 0,
      collectionIds: [],
    };
    current.wetKg += Number(item.wetKg || 0);
    current.collectionIds.push(item.id);
    grouped.set(key, current);
  });
  const ordered = [...grouped.values()].sort((a, b) => {
    const sa = storeById.get(a.storeId) || {};
    const sb = storeById.get(b.storeId) || {};
    return String(sa.district || a.storeName).localeCompare(String(sb.district || b.storeName), "ru");
  });
  if (!ordered.length) return { stops: [], totalKg: 0, distanceKm: 0, estimatedMinutes: 0 };
  const totalKg = round(ordered.reduce((sum, item) => sum + Number(item.wetKg || 0), 0), 2);
  const distanceKm = round(5.8 + ordered.length * 2.35, 1);
  return {
    stops: ordered,
    totalKg,
    distanceKm,
    estimatedMinutes: Math.round(22 + ordered.length * 14 + distanceKm * 1.8),
  };
}

export function batchStock(batch, sales = []) {
  const produced = Number(batch?.producedPacks || 0);
  const sold = sales.filter((sale) => sale.batchId === batch?.id).reduce((sum, sale) => sum + Number(sale.packs || 0), 0);
  return { produced, sold, available: Math.max(0, produced - sold) };
}

export function validateSaleDraft(batch, sales, packs, unitPrice) {
  if (!batch || !Number.isInteger(packs) || packs <= 0) throw new Error("Укажите партию и целое число упаковок больше нуля.");
  if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error("Укажите неотрицательную цену.");
  const stock = batchStock(batch, sales);
  if (stock.produced <= 0) throw new Error("Сначала зафиксируйте выпуск партии.");
  if (packs > stock.available) throw new Error(`На складе осталось ${stock.available} упаковок.`);
  return stock;
}

export function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

function mergeRecordList(name, base, local, remote) {
  const original = new Map(base.map((item) => [item.id, item]));
  const edited = new Map(local.map((item) => [item.id, item]));
  const latest = new Map(remote.map((item) => [item.id, item]));
  const merged = remote.map((item) => structuredClone(item));
  for (const [id, before] of original) {
    const after = edited.get(id);
    if (sameValue(before, after)) continue;
    const remoteValue = latest.get(id);
    if (!sameValue(remoteValue, before) && !sameValue(remoteValue, after)) throw new Error(`Конфликт в ${name}: ${id}. Обновите данные.`);
    const index = merged.findIndex((item) => item.id === id);
    if (after === undefined) {
      if (index >= 0) merged.splice(index, 1);
    } else if (index >= 0) merged[index] = structuredClone(after);
    else merged.push(structuredClone(after));
  }
  for (const [id, after] of edited) {
    if (original.has(id)) continue;
    const remoteValue = latest.get(id);
    if (remoteValue !== undefined && !sameValue(remoteValue, after)) throw new Error(`Конфликт в ${name}: ${id}. Обновите данные.`);
    if (remoteValue === undefined) merged.push(structuredClone(after));
  }
  return merged;
}

export function mergeWorkspaceState(base, local, remote) {
  if (sameValue(base, remote)) return structuredClone(local);
  const merged = structuredClone(remote);
  const recordLists = new Set(["stores", "collections", "routes", "batches", "productionRuns", "sales"]);
  for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (sameValue(base[key], local[key])) continue;
    if (recordLists.has(key) && Array.isArray(base[key]) && Array.isArray(local[key]) && Array.isArray(remote[key])) {
      merged[key] = mergeRecordList(key, base[key], local[key], remote[key]);
      continue;
    }
    if (key === "economicsParams") {
      merged[key] = { ...remote[key] };
      for (const param of new Set([...Object.keys(base[key] || {}), ...Object.keys(local[key] || {})])) {
        if (sameValue(base[key]?.[param], local[key]?.[param])) continue;
        if (!sameValue(base[key]?.[param], remote[key]?.[param]) && !sameValue(local[key]?.[param], remote[key]?.[param])) throw new Error(`Конфликт параметра ${param}. Обновите данные.`);
        merged[key][param] = local[key][param];
      }
      continue;
    }
    if (key === "lastImport") {
      merged[key] = structuredClone(local[key]);
      continue;
    }
    if (!sameValue(base[key], remote[key]) && !sameValue(local[key], remote[key])) throw new Error(`Конфликт поля ${key}. Обновите данные.`);
    merged[key] = structuredClone(local[key]);
  }
  return merged;
}

export function formatMoney(value) {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Number(value) || 0)} ₸`;
}

export function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits }).format(Number(value) || 0);
}
