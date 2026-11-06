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
  const unitContribution = Number(params.pricePerPack || 0) - Number(params.variableCostPerPack || 0);
  const breakEvenPacks = unitContribution > 0
    ? Math.ceil((Number(params.monthlyLogisticsCost || 0) + Number(params.monthlyFixedCost || 0)) / unitContribution)
    : 0;

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
    const cups = Number(String(cupsRaw ?? "").replace(",", ".")) || 0;
    const suppliedWeight = Number(String(weightRaw ?? "").replace(",", "."));
    const wetKg = Number.isFinite(suppliedWeight) && suppliedWeight > 0
      ? round(suppliedWeight, 2)
      : estimateWetGroundsKg(cups, grams);
    return {
      id: `IMP-${Date.now()}-${index + 1}`,
      storeName: String(store || `Импортированная точка ${index + 1}`).trim(),
      date: String(date || new Date().toISOString().slice(0, 10)).trim(),
      cups,
      wetKg,
      weightSource: suppliedWeight > 0 ? "measured" : "estimated",
      status: "ready",
      quality: "pending",
      source: "import",
    };
  }).filter((row) => row.cups > 0 || row.wetKg > 0);
}

export function buildPickupRoute(collections, stores) {
  const ready = collections.filter((item) => item.status === "ready");
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
  const totalKg = round(ordered.reduce((sum, item) => sum + Number(item.wetKg || 0), 0), 2);
  const distanceKm = round(5.8 + ordered.length * 2.35, 1);
  return {
    stops: ordered,
    totalKg,
    distanceKm,
    estimatedMinutes: Math.round(22 + ordered.length * 14 + distanceKm * 1.8),
  };
}

export function formatMoney(value) {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Number(value) || 0)} ₸`;
}

export function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits }).format(Number(value) || 0);
}
