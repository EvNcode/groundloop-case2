import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

export const cloudEnabled = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
const base = SUPABASE_URL.replace(/\/$/, "");
const sessionKey = "groundloop_demo_session";
let session = null;

function remember(value) {
  session = value;
  if (value) localStorage.setItem(sessionKey, JSON.stringify(value));
  else localStorage.removeItem(sessionKey);
}

async function request(path, options = {}, accessToken = null) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
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

function setSession(value) {
  const next = { ...value, expires_at: Number(value.expires_at) || Math.floor(Date.now() / 1000) + Number(value.expires_in || 3600) };
  remember(next);
  return next.user;
}

export async function openDemoSession() {
  if (!cloudEnabled) return null;
  try {
    const stored = JSON.parse(localStorage.getItem(sessionKey) || "null");
    if (stored?.user?.is_anonymous && stored.refresh_token) {
      if (stored.access_token && Date.now() < (Number(stored.expires_at) - 60) * 1000) {
        remember(stored);
        return stored.user;
      }
      const refreshed = await request("/auth/v1/token?grant_type=refresh_token", {
        method: "POST", body: JSON.stringify({ refresh_token: stored.refresh_token }),
      });
      if (refreshed.user?.is_anonymous) return setSession(refreshed);
    }
  } catch { remember(null); }
  const created = await request("/auth/v1/signup", { method: "POST", body: "{}" });
  if (!created.user?.is_anonymous || !created.access_token) throw new Error("Не удалось открыть демо-сессию");
  return setSession(created);
}

async function token() {
  if (!session?.user?.is_anonymous) throw new Error("Демо-сессия не открыта");
  if (Date.now() >= (Number(session.expires_at) - 60) * 1000) {
    const refreshed = await request("/auth/v1/token?grant_type=refresh_token", {
      method: "POST", body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    setSession(refreshed);
  }
  return session.access_token;
}

export async function readWorkspace(userId) {
  const rows = await request("/rest/v1/groundloop_open_workspace?id=eq.pilot&select=state,revision&limit=1", {}, await token());
  return rows[0] || null;
}

export async function createWorkspace(state, userId) {
  try {
    const rows = await request("/rest/v1/groundloop_open_workspace?select=state,revision", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ id: "pilot", state }),
    }, await token());
    return rows[0];
  } catch (error) {
    if (error.status === 409) return readWorkspace(userId);
    throw error;
  }
}

export async function updateWorkspace(state, revision, userId) {
  const rows = await request(`/rest/v1/groundloop_open_workspace?id=eq.pilot&revision=eq.${revision}&select=revision`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ state, revision: revision + 1 }),
  }, await token());
  if (!rows.length) {
    const error = new Error("Данные изменились на другом рабочем месте");
    error.code = "conflict";
    throw error;
  }
  return rows[0].revision;
}
