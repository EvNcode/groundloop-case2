import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../dist/supabase-config.js';

const accounts = [
  ['barista', 'barista2@groundloop.test', process.env.GL_DEMO_BARISTA2_PASSWORD],
  ['driver', 'logistics2@groundloop.test', process.env.GL_DEMO_LOGISTICS2_PASSWORD],
  ['production', 'production@groundloop.test', process.env.GL_DEMO_PRODUCTION_PASSWORD],
  ['manager', 'manager@groundloop.test', process.env.GL_DEMO_MANAGER_PASSWORD],
];
if (accounts.some(([, , password]) => !password)) throw new Error('Set demo password environment variables');
const checked = result => { if (result.error) throw result.error; return result.data; };
const clients = {};
for (const [role, email, password] of accounts) {
  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  checked(await client.auth.signInWithPassword({ email, password }));
  clients[role] = client;
}
const { barista, driver, production, manager } = clients;
const previous = checked(await barista.from('gl_containers').select('*').eq('code', 'GC-E2852417A4').single());
if (previous.status === 'assigned') {
  checked(await barista.from('gl_containers').update({ status: 'cancelled', trip_id: null, note: 'Отмена: ошибочная заявка' }).eq('id', previous.id).eq('version', previous.version).select().single());
}
const notice = checked(await driver.from('gl_notifications').select('*').eq('container_id', previous.id).maybeSingle());
assert.ok(notice, 'Assigned driver must receive cancellation notice');
assert.equal(notice.container_code, previous.code);
const gone = checked(await driver.from('gl_containers').select('id').eq('id', previous.id));
assert.equal(gone.length, 0, 'Cancelled request must disappear from driver queue');
const cancellation = checked(await manager.from('gl_events').select('*').eq('entity_id', previous.id).eq('action', 'cancelled').maybeSingle());
assert.ok(cancellation, 'Management must retain cancellation in journal');
console.log('Cancellation notice and manager journal: OK');

const marker = `Проверка партии ${Date.now()}`;
let item = checked(await barista.from('gl_containers').insert({ wet_kg: 2.4, cups: 28, quality: 'good', note: marker }).select().single());
let trip = checked(await driver.from('gl_trips').select('*').eq('status', 'active').maybeSingle());
if (!trip) trip = checked(await driver.from('gl_trips').insert({}).select().single());
if (item.status === 'ready') item = checked(await driver.from('gl_containers').update({ status:'assigned', trip_id:trip.id }).eq('id',item.id).eq('status','ready').select().single());
if (item.status === 'assigned') {
  const wrong = await driver.from('gl_containers').update({ status:'picked_up', pickup_code:'WRONG' }).eq('id',item.id).select();
  assert.ok(wrong.error, 'Wrong pickup scan must fail');
  item = checked(await driver.from('gl_containers').update({ status:'picked_up', pickup_code:item.code }).eq('id',item.id).select().single());
}
if (item.status === 'picked_up') item = checked(await production.from('gl_containers').update({ status:'received', receipt_code:item.code }).eq('id',item.id).select().single());
assert.equal(item.status, 'received');
const earlyBatch = await production.from('gl_batches').insert({container_ids:[item.id]});
assert.ok(earlyBatch.error, 'An active trip must block batch creation');
trip = checked(await driver.from('gl_trips').update({status:'completed'}).eq('id',trip.id).eq('status','active').select().single());
assert.equal(trip.status,'completed');
let batch = checked(await production.from('gl_batches').insert({container_ids:[item.id]}).select().single());
batch = checked(await production.from('gl_batches').update({status:'drying'}).eq('id',batch.id).select().single());
batch = checked(await production.from('gl_batches').update({status:'production',dried_kg:1.1,accepted_kg:.8}).eq('id',batch.id).select().single());
batch = checked(await production.from('gl_batches').update({status:'complete',produced_packs:4}).eq('id',batch.id).select().single());
assert.equal(batch.status,'complete');
console.log('Closed-trip batch and production output: OK');

let order = checked(await manager.from('gl_sales').insert({batch_id:batch.id,packs:2,unit_price:990,customer_name:'Проверка B2B',fulfillment:'delivery',delivery_address:'Шымкент, пр. Тауке хана, 62',latitude:42.316673,longitude:69.603079,channel:'Партнёрская точка'}).select().single());
assert.equal(order.delivery_status,'ready');
const deliveryTrip = checked(await driver.from('gl_trips').insert({}).select().single());
order = checked(await driver.from('gl_sales').update({delivery_status:'assigned'}).eq('id',order.id).select().single());
assert.equal(order.delivery_driver_name,'Второй логист');
assert.equal(order.delivery_trip_id,deliveryTrip.id);
const earlyClose = await driver.from('gl_trips').update({status:'completed'}).eq('id',deliveryTrip.id).select();
assert.ok(earlyClose.error, 'Trip must stay open until the product is delivered');
const wrongOrderScan = await driver.from('gl_sales').update({delivery_status:'out_for_delivery',pickup_code:'WRONG'}).eq('id',order.id).select();
assert.ok(wrongOrderScan.error, 'Wrong product scan must fail');
order = checked(await driver.from('gl_sales').update({delivery_status:'out_for_delivery',pickup_code:order.order_code}).eq('id',order.id).select().single());
order = checked(await driver.from('gl_sales').update({delivery_status:'delivered',recipient_name:'Получатель теста'}).eq('id',order.id).select().single());
assert.equal(order.delivery_status,'delivered');
assert.ok(order.delivered_at);
checked(await driver.from('gl_trips').update({status:'completed'}).eq('id',deliveryTrip.id).select().single());
console.log(JSON.stringify({container:item.code,collection_trip:trip.code,batch:batch.code,delivery_trip:deliveryTrip.code,order:order.order_code,delivered_to:order.recipient_name}));
