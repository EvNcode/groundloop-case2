import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPickupRoute,
  calculateDryOutput,
  calculateEconomics,
  calculatePackOutput,
  estimateWetGroundsKg,
  normalizeImportedRows,
  parseCsv,
  mergeWorkspaceState,
  batchStock,
  validateSaleDraft,
} from "../dist/logic.js";

test("estimates wet grounds from drink count", () => {
  assert.equal(estimateWetGroundsKg(250, 32), 8);
});

test("calculates dry and accepted material without mixing rejected mass", () => {
  assert.deepEqual(calculateDryOutput(100, 50, 10), {
    driedKg: 50,
    acceptedKg: 45,
    rejectedKg: 5,
  });
});

test("pack output uses only accepted dry mass", () => {
  assert.deepEqual(calculatePackOutput(16, 160, 75), {
    producedPacks: 100,
    soldPacks: 75,
    unsoldPacks: 25,
  });
});

test("economics preserves material balance and profit formula", () => {
  const result = calculateEconomics({
    activeStores: 2,
    cupsPerStoreDay: 100,
    daysPerMonth: 30,
    wetGramsPerCup: 30,
    dryYieldPct: 50,
    rejectPct: 0,
    groundsPerPackG: 150,
    sellThroughPct: 100,
    pricePerPack: 1000,
    variableCostPerPack: 400,
    monthlyLogisticsCost: 10000,
    monthlyFixedCost: 20000,
  });
  assert.equal(result.wetKg, 180);
  assert.equal(result.acceptedKg, 90);
  assert.equal(result.producedPacks, 600);
  assert.equal(result.revenue, 600000);
  assert.equal(result.profit, 330000);
  assert.equal(result.breakEvenPacks, 270);
});

test("break-even includes the cost of unsold production", () => {
  const result = calculateEconomics({
    activeStores: 2, cupsPerStoreDay: 100, daysPerMonth: 30,
    wetGramsPerCup: 30, dryYieldPct: 50, rejectPct: 0,
    groundsPerPackG: 150, sellThroughPct: 50,
    pricePerPack: 1000, variableCostPerPack: 400,
    monthlyLogisticsCost: 10000, monthlyFixedCost: 20000,
  });
  assert.equal(result.producedPacks, 600);
  assert.equal(result.soldPacks, 300);
  assert.equal(result.breakEvenPacks, 270);
});

test("CSV parser handles quoted commas", () => {
  const rows = parseCsv('Точка,Дата,Напитки\n"Global Coffee, Mega",2026-11-06,326\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["Точка"], "Global Coffee, Mega");
});

test("import marks supplied weight measured and absent weight estimated", () => {
  const rows = normalizeImportedRows([
    { Точка: "Абая", Дата: "2026-11-06", Напитки: "100", "Жмых кг": "3,4" },
    { Точка: "Mega", Дата: "2026-11-06", Напитки: "100", "Жмых кг": "" },
  ], { wetGramsPerCup: 32 });
  assert.equal(rows[0].weightSource, "measured");
  assert.equal(rows[0].wetKg, 3.4);
  assert.equal(rows[1].weightSource, "estimated");
  assert.equal(rows[1].wetKg, 3.2);
  assert.equal(rows[0].status, "review");
});

test("import rejects invalid dates and negative amounts before writing", () => {
  assert.throws(() => normalizeImportedRows([{ Точка: "Абая", Дата: "2026-02-30", Напитки: "5" }]), /дата/);
  assert.throws(() => normalizeImportedRows([{ Точка: "Абая", Дата: "2026-11-06", Напитки: "-5" }]), /напитков/);
});

test("import reads Excel date cells", () => {
  const rows = normalizeImportedRows([{ Точка: "Абая", Дата: new Date("2026-11-06T00:00:00Z"), Напитки: 100 }]);
  assert.equal(rows[0].date, "2026-11-06");
});

test("route uses only ready collections", () => {
  const route = buildPickupRoute([
    { id: "1", storeId: "A", status: "ready", quality: "good", wetKg: 5 },
    { id: "2", storeId: "B", status: "collected", quality: "good", wetKg: 7 },
    { id: "3", storeId: "C", status: "ready", quality: "good", wetKg: 4 },
    { id: "4", storeId: "D", status: "ready", quality: "pending", wetKg: 3 },
  ], [
    { id: "A", district: "Б" },
    { id: "B", district: "А" },
    { id: "C", district: "В" },
  ]);
  assert.deepEqual(route.stops.map((item) => item.id), ["1", "3"]);
  assert.equal(route.totalKg, 9);
});

test("route groups multiple ready records from one store into one stop", () => {
  const route = buildPickupRoute([
    { id: "1", storeId: "A", status: "ready", quality: "good", wetKg: 5 },
    { id: "2", storeId: "A", status: "ready", quality: "good", wetKg: 7 },
  ], [{ id: "A", district: "Центр" }]);
  assert.equal(route.stops.length, 1);
  assert.deepEqual(route.stops[0].collectionIds, ["1", "2"]);
  assert.equal(route.totalKg, 12);
});

test("empty route shows zero distance and time", () => {
  assert.deepEqual(buildPickupRoute([], []), { stops: [], totalKg: 0, distanceKm: 0, estimatedMinutes: 0 });
});

test("concurrent edits to separate collections are merged", () => {
  const base = { collections: [{ id: "A", status: "review" }, { id: "B", status: "ready" }], economicsParams: { pricePerPack: 1000 } };
  const local = { ...base, collections: [{ id: "A", status: "ready" }, base.collections[1]] };
  const remote = { ...base, collections: [base.collections[0], { id: "B", status: "collected" }] };
  assert.deepEqual(mergeWorkspaceState(base, local, remote).collections, [{ id: "A", status: "ready" }, { id: "B", status: "collected" }]);
});

test("concurrent edits to the same collection stay blocked", () => {
  const base = { collections: [{ id: "A", status: "review" }] };
  assert.throws(() => mergeWorkspaceState(base, { collections: [{ id: "A", status: "ready" }] }, { collections: [{ id: "A", status: "rejected" }] }), /Конфликт/);
});

test("concurrent additions and independent economics changes are preserved", () => {
  const base = { collections: [], economicsParams: { pricePerPack: 1000, dryYieldPct: 50 } };
  const local = { collections: [{ id: "A" }], economicsParams: { pricePerPack: 1200, dryYieldPct: 50 } };
  const remote = { collections: [{ id: "B" }], economicsParams: { pricePerPack: 1000, dryYieldPct: 55 } };
  assert.deepEqual(mergeWorkspaceState(base, local, remote), { collections: [{ id: "B" }, { id: "A" }], economicsParams: { pricePerPack: 1200, dryYieldPct: 55 } });
});

test("sales cannot exceed the produced stock", () => {
  const batch = { id: "B", producedPacks: 78 };
  const sales = [{ id: "S1", batchId: "B", packs: 24, unitPrice: 1800 }];
  assert.deepEqual(batchStock(batch, sales), { produced: 78, sold: 24, available: 54 });
  assert.doesNotThrow(() => validateSaleDraft(batch, sales, 54, 1800));
  assert.throws(() => validateSaleDraft(batch, sales, 55, 1800), /осталось 54/);
  assert.throws(() => validateSaleDraft(batch, sales, 1.5, 1800), /целое число/);
});

test("concurrent sales in separate tabs remain distinct", () => {
  const base = { sales: [], batches: [{ id: "B", producedPacks: 78 }] };
  const local = { ...base, sales: [{ id: "S1", batchId: "B", packs: 10 }] };
  const remote = { ...base, sales: [{ id: "S2", batchId: "B", packs: 20 }] };
  assert.deepEqual(mergeWorkspaceState(base, local, remote).sales.map((sale) => sale.id), ["S2", "S1"]);
});
