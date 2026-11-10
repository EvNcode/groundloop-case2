import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../dist/supabase-config.js';

const accounts = [
  ['barista', 'barista@groundloop.test', process.env.GL_DEMO_BARISTA_PASSWORD],
  ['logistics', 'logistics@groundloop.test', process.env.GL_DEMO_LOGISTICS_PASSWORD],
  ['production', 'production@groundloop.test', process.env.GL_DEMO_PRODUCTION_PASSWORD],
  ['manager', 'manager@groundloop.test', process.env.GL_DEMO_MANAGER_PASSWORD],
];
if (accounts.some(([, , password]) => !password)) throw new Error('Set all four GL_DEMO_*_PASSWORD variables');

function checked(result) {
  if (result.error) throw result.error;
  return result.data;
}
const clients = {};
for (const [role, email, password] of accounts) {
  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const auth = checked(await client.auth.signInWithPassword({ email, password }));
  assert.equal(auth.user.email, email);
  const member = checked(await client.from('gl_staff').select('*').eq('email', email).single());
  assert.equal(member.role, role);
  clients[role] = client;
}
console.log('Four role logins: OK');

const { barista, logistics, production, manager } = clients;
const staffVisibleToDemoManager = checked(await manager.from('gl_staff').select('email'));
assert.deepEqual(staffVisibleToDemoManager.map(x => x.email), ['manager@groundloop.test']);
const heldVisibleToLogistics = checked(await logistics.from('gl_containers').select('id').eq('status', 'hold'));
assert.equal(heldVisibleToLogistics.length, 0);
console.log('Role read boundaries: OK');

async function container(code, client) {
  return checked(await client.from('gl_containers').select('*').eq('code', code).single());
}
const transitCode = 'GC-1778258E10';
const batchCode = 'GC-B7EF5C707A';
const transit = await container(transitCode, logistics);
const source = await container(batchCode, logistics);
let trip = checked(await logistics.from('gl_trips').select('*').eq('status', 'active').maybeSingle());
assert.ok(trip, 'The logistics screen should have created an active trip');

if (transit.status === 'ready') {
  checked(await logistics.from('gl_containers').update({ status: 'assigned', trip_id: trip.id }).eq('id', transit.id).select().single());
}
for (const code of [transitCode, batchCode]) {
  let item = await container(code, logistics);
  if (item.status === 'assigned') {
    const wrong = await logistics.from('gl_containers').update({ status: 'picked_up', pickup_code: 'WRONG-CODE' }).eq('id', item.id).select();
    assert.ok(wrong.error, 'A wrong pickup code must fail');
    item = checked(await logistics.from('gl_containers').update({ status: 'picked_up', pickup_code: item.code }).eq('id', item.id).select().single());
  }
  assert.ok(['picked_up', 'received', 'batched'].includes(item.status));
}
console.log('Pickup scan and wrong-code rejection: OK');

let incoming = await container(batchCode, production);
if (incoming.status === 'picked_up') {
  const wrong = await production.from('gl_containers').update({ status: 'received', receipt_code: 'WRONG-CODE' }).eq('id', incoming.id).select();
  assert.ok(wrong.error, 'A wrong receipt code must fail');
  incoming = checked(await production.from('gl_containers').update({ status: 'received', receipt_code: incoming.code }).eq('id', incoming.id).select().single());
}
assert.ok(['received', 'batched'].includes(incoming.status));
let batch;
if (incoming.status === 'received') {
  batch = checked(await production.from('gl_batches').insert({ container_ids: [incoming.id] }).select().single());
} else {
  batch = checked(await production.from('gl_batches').select('*').eq('id', incoming.batch_id).single());
}
if (batch.status === 'received') batch = checked(await production.from('gl_batches').update({ status: 'drying' }).eq('id', batch.id).select().single());
if (batch.status === 'drying') batch = checked(await production.from('gl_batches').update({ status: 'production', dried_kg: 1.50, accepted_kg: 1.20 }).eq('id', batch.id).select().single());
if (batch.status === 'production') batch = checked(await production.from('gl_batches').update({ status: 'complete', produced_packs: 6 }).eq('id', batch.id).select().single());
assert.equal(batch.status, 'complete');
console.log('Production receipt and batch: OK');

let sales = checked(await manager.from('gl_sales').select('*').eq('batch_id', batch.id));
if (!sales.length) {
  checked(await manager.from('gl_sales').insert({ batch_id: batch.id, packs: 3, unit_price: 890, channel: 'Кофейня' }).select().single());
  sales = checked(await manager.from('gl_sales').select('*').eq('batch_id', batch.id));
}
assert.equal(sales.reduce((sum, sale) => sum + sale.packs, 0), 3);
const oversell = await manager.from('gl_sales').insert({ batch_id: batch.id, packs: 4, unit_price: 890, channel: 'Кофейня' });
assert.ok(oversell.error, 'Selling beyond stock must fail');
console.log('Sale and stock guard: OK');

const held = checked(await barista.from('gl_containers').select('*').eq('code', 'GC-E799E66174').single());
if (Number(held.wet_kg) === 0.8) {
  checked(await barista.from('gl_containers').update({ wet_kg: 0.85, note: 'Обнаружены примеси; вес уточнён повторно', status: 'hold' }).eq('id', held.id).eq('version', held.version).select().single());
}
let cancelled = checked(await barista.from('gl_containers').select('*').ilike('note', 'Проверка отмены записи%').maybeSingle());
if (!cancelled) cancelled = checked(await barista.from('gl_containers').insert({ wet_kg: 0.45, cups: 6, quality: 'good', note: 'Проверка отмены записи' }).select().single());
if (cancelled.status !== 'cancelled') {
  checked(await barista.from('gl_containers').update({ status: 'cancelled', note: 'Проверка отмены записи\nОтмена: ошибочный вес' }).eq('id', cancelled.id).select().single());
}
console.log('Barista correction and cancellation: OK');

const all = checked(await manager.from('gl_containers').select('*'));
const allBatches = checked(await manager.from('gl_batches').select('*'));
const allSales = checked(await manager.from('gl_sales').select('*'));
const active = all.filter(x => !['cancelled', 'rejected'].includes(x.status));
const inTransit = all.filter(x => ['assigned', 'picked_up'].includes(x.status));
const packs = allBatches.reduce((sum, x) => sum + x.produced_packs, 0);
const revenue = allSales.reduce((sum, x) => sum + x.packs * Number(x.unit_price), 0);
assert.ok(active.length >= 4 && inTransit.length >= 1 && packs >= 6 && revenue >= 2670);
console.log(JSON.stringify({ active_containers: active.length, in_transit: inTransit.length, produced_packs: packs, revenue_kzt: revenue }));
