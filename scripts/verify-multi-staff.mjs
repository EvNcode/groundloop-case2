import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../dist/supabase-config.js';

const accounts = [
  ['barista', 'barista2@groundloop.test', process.env.GL_DEMO_BARISTA2_PASSWORD],
  ['logistics', 'logistics2@groundloop.test', process.env.GL_DEMO_LOGISTICS2_PASSWORD],
  ['manager', 'manager2@groundloop.test', process.env.GL_DEMO_MANAGER2_PASSWORD],
];
if (accounts.some(([, , password]) => !password)) throw new Error('Set all three GL_DEMO_*2_PASSWORD variables');
const checked = result => { if (result.error) throw result.error; return result.data; };
const clients = {};
for (const [role, email, password] of accounts) {
  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const auth = checked(await client.auth.signInWithPassword({ email, password }));
  assert.equal(auth.user.email, email);
  const member = checked(await client.from('gl_staff').select('*').eq('email', email).single());
  assert.equal(member.role, role);
  clients[role] = client;
}

const { barista, logistics, manager } = clients;
const baristaStaff = checked(await barista.from('gl_staff').select('*').single());
assert.equal(baristaStaff.store_id, 'GC-02');
const visible = checked(await barista.from('gl_containers').select('store_id'));
assert.ok(visible.every(item => item.store_id === 'GC-02'));
const managerStaff = checked(await manager.from('gl_staff').select('email'));
assert.deepEqual(managerStaff.map(x => x.email), ['manager2@groundloop.test']);

const marker = 'Проверка работы второго бариста';
let item = checked(await barista.from('gl_containers').select('*').eq('note', marker).maybeSingle());
if (!item) item = checked(await barista.from('gl_containers').insert({ wet_kg: 1.25, cups: 16, quality: 'good', note: marker }).select().single());
assert.equal(item.store_id, 'GC-02');
assert.equal(item.barista_name, baristaStaff.full_name);
const ready = checked(await logistics.from('gl_containers').select('*').eq('id', item.id).single());
assert.equal(ready.status === 'ready' || ready.trip_id !== null, true);

let trip = checked(await logistics.from('gl_trips').select('*').eq('status', 'active').maybeSingle());
if (!trip) trip = checked(await logistics.from('gl_trips').insert({}).select().single());
if (item.status === 'ready') item = checked(await logistics.from('gl_containers').update({ status: 'assigned', trip_id: trip.id }).eq('id', item.id).eq('status', 'ready').select().single());
assert.equal(item.trip_id, trip.id);
const others = checked(await logistics.from('gl_trips').select('id'));
assert.ok(others.every(t => t.id === trip.id));
const stores = checked(await logistics.from('gl_stores').select('id,name,address').eq('id', item.store_id).single());
assert.equal(stores.id, 'GC-02');
console.log(JSON.stringify({ barista: baristaStaff.full_name, pickup_branch: stores.name, pickup_address: stores.address, driver: trip.driver_name, container: item.code, trip: trip.code }));

const unauthorized = await manager.functions.invoke('groundloop-invite', { body: { email: 'unauthorized@groundloop.test', full_name: 'Без доступа', role: 'manager' } });
assert.ok(unauthorized.error, 'Ordinary manager must not be allowed to invite employees');
assert.equal(unauthorized.error.context?.status, 403, 'Invite function must authenticate and reject the non-admin role');
console.log('Separate staff accounts, branch scope, driver trip and invite denial: OK');
