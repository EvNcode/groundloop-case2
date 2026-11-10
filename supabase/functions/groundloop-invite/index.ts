import { createClient } from 'npm:@supabase/supabase-js@2';

const siteUrl = 'https://evncode.github.io/groundloop-case2/';
const cors = {
  'Access-Control-Allow-Origin': 'https://evncode.github.io',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const reply = (status: number, message: string) => new Response(JSON.stringify({ message }), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, 'Метод недоступен');
  const origin = req.headers.get('origin');
  if (origin && origin !== 'https://evncode.github.io') return reply(403, 'Недопустимый источник');

  const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return reply(401, 'Войдите в систему');
  const url = Deno.env.get('SUPABASE_URL');
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !secret) return reply(500, 'Сервер не настроен');
  const admin = createClient(url, secret, { auth: { persistSession: false } });
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  const callerEmail = auth.user?.email?.toLowerCase();
  if (authError || !callerEmail || auth.user?.is_anonymous) return reply(401, 'Сессия недействительна');
  const { data: caller, error: callerError } = await admin.from('gl_staff')
    .select('role,active,can_manage_access').eq('email', callerEmail).maybeSingle();
  if (callerError) return reply(500, 'Не удалось проверить доступ');
  if (!caller?.active || caller.role !== 'manager' || !caller.can_manage_access) return reply(403, 'Нет права приглашать сотрудников');

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch { return reply(400, 'Неверный запрос'); }
  const email = String(input.email ?? '').trim().toLowerCase();
  const fullName = String(input.full_name ?? '').trim();
  const role = String(input.role ?? '');
  const storeId = input.store_id ? String(input.store_id) : null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return reply(400, 'Проверьте адрес почты');
  if (fullName.length < 2 || fullName.length > 100) return reply(400, 'Укажите имя сотрудника');
  if (!['barista', 'logistics', 'production', 'manager'].includes(role)) return reply(400, 'Неизвестная роль');
  if (role === 'barista') {
    if (!storeId) return reply(400, 'Выберите точку бариста');
    const { data: store } = await admin.from('gl_stores').select('id').eq('id', storeId).eq('active', true).maybeSingle();
    if (!store) return reply(400, 'Точка недоступна');
  } else if (storeId) return reply(400, 'Точка назначается только бариста');

  const { data: existing } = await admin.from('gl_staff').select('email').eq('email', email).maybeSingle();
  if (existing) return reply(409, 'Этот сотрудник уже есть в команде');
  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: siteUrl,
    data: { groundloop_needs_password: true },
  });
  if (inviteError || !invited.user) return reply(422, inviteError?.message || 'Приглашение не отправлено');

  const { error: staffError } = await admin.from('gl_staff').insert({
    email, full_name: fullName, role, store_id: role === 'barista' ? storeId : null,
    active: true, can_manage_access: false,
  });
  if (staffError) {
    await admin.auth.admin.deleteUser(invited.user.id);
    return reply(500, 'Приглашение не сохранено; попробуйте ещё раз');
  }
  return reply(200, `Приглашение отправлено на ${email}`);
});
