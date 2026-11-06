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
});

test("route uses only ready collections", () => {
  const route = buildPickupRoute([
    { id: "1", storeId: "A", status: "ready", wetKg: 5 },
    { id: "2", storeId: "B", status: "collected", wetKg: 7 },
    { id: "3", storeId: "C", status: "ready", wetKg: 4 },
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
    { id: "1", storeId: "A", status: "ready", wetKg: 5 },
    { id: "2", storeId: "A", status: "ready", wetKg: 7 },
  ], [{ id: "A", district: "Центр" }]);
  assert.equal(route.stops.length, 1);
  assert.deepEqual(route.stops[0].collectionIds, ["1", "2"]);
  assert.equal(route.totalKg, 12);
});
