import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

export const cloudEnabled = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
const base = SUPABASE_URL.replace(/\/$/, "");
const sessionKey = "groundloop_supabase_session";
let session = null;

function remember(value) {
  session = value;
  if (value) localStorage.setItem(sessionKey, JSON.stringify(value));
  else localStorage.removeItem(sessionKey);
}

async function request(path, options = {}, token = null) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.msg || body.message || body.error_description || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function restoreSession() {
  if (!cloudEnabled) return null;
  try {
    const stored = JSON.parse(localStorage.getItem(sessionKey) || "null");
    if (!stored?.refresh_token) return null;
    const refreshed = await request("/auth/v1/token?grant_type=refresh_token", {
      method: "POST", body: JSON.stringify({ refresh_token: stored.refresh_token }),
    });
    remember(refreshed);
    return refreshed.user;
  } catch {
    remember(null);
    return null;
  }
}

export async function signIn(email, password) {
  const result = await request("/auth/v1/token?grant_type=password", {
    method: "POST", body: JSON.stringify({ email, password }),
  });
  remember(result);
  return result.user;
}

export async function signUp(email, password) {
  return request("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password }) });
}

export async function signOut() {
  if (session?.access_token) {
    await request("/auth/v1/logout", { method: "POST" }, session.access_token).catch(() => {});
  }
  remember(null);
}

async function token() {
  if (!session) throw new Error("Войдите в систему");
  if (Date.now() >= (session.expires_at - 60) * 1000) {
    const refreshed = await request("/auth/v1/token?grant_type=refresh_token", {
      method: "POST", body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    remember(refreshed);
  }
  return session.access_token;
}

export async function getMembership() {
  const rows = await request("/rest/v1/groundloop_members?select=role&limit=1", {}, await token());
  return rows[0]?.role || null;
}

export async function readWorkspace() {
  const rows = await request("/rest/v1/groundloop_workspace?id=eq.pilot&select=state,revision", {}, await token());
  return rows[0] || null;
}

export async function createWorkspace(state, userId) {
  const rows = await request("/rest/v1/groundloop_workspace", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ id: "pilot", state, updated_by: userId }),
  }, await token());
  return rows[0];
}

export async function updateWorkspace(state, revision, userId) {
  const rows = await request(`/rest/v1/groundloop_workspace?id=eq.pilot&revision=eq.${revision}&select=revision`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ state, revision: revision + 1, updated_by: userId, updated_at: new Date().toISOString() }),
  }, await token());
  if (!rows.length) throw new Error("Данные изменились у другого сотрудника. Обновите страницу перед повтором");
  return rows[0].revision;
}
