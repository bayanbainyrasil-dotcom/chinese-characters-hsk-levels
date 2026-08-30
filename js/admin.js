// Административный раздел. PIN проверяется только на сервере: во frontend нет
// ни самого кода, ни его хеша, ни логики сравнения. Клиент отправляет введённый
// PIN в Edge Function, получает недолгую серверную сессию и работает по ней.

import { CONFIG, functionUrl, backendReady } from "./config.js";
import { KEYS, readJson, writeJson } from "./storage.js";

const SESSION_KEY = "bishun_hsk30_admin_session_v1";

function sessionStore() {
  try { return window.sessionStorage; } catch (_) { return null; }
}

export function adminSession() {
  try {
    const raw = sessionStore()?.getItem(SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.token && Date.parse(parsed.expiresAt) > Date.now()) return parsed;
  } catch (_) { /* нет сессии */ }
  return null;
}

function saveSession(session) {
  try {
    if (session) sessionStore()?.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStore()?.removeItem(SESSION_KEY);
  } catch (_) { /* приватный режим */ }
}

export function adminConfigured() { return backendReady(); }

async function call(name, body, { method = "POST" } = {}) {
  const response = await fetch(functionUrl(name), {
    method,
    headers: { "content-type": "application/json", apikey: CONFIG.supabaseAnonKey },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });
  let payload = null;
  try { payload = await response.json(); } catch (_) { payload = null; }
  if (!response.ok) {
    const error = new Error(payload?.error || `Ошибка сервера (${response.status})`);
    error.status = response.status;
    error.retryAfter = payload?.retryAfter ?? null;
    error.attemptsLeft = payload?.attemptsLeft ?? null;
    throw error;
  }
  return payload;
}

/** Возвращает серверную сессию администратора либо бросает понятную ошибку. */
export async function unlockAdmin(pin) {
  if (!adminConfigured()) {
    throw new Error("Проверка администратора выполняется на сервере. Заполните настройки Supabase в js/config.js.");
  }
  const payload = await call(CONFIG.adminAuthFunction, { action: "login", pin });
  const session = { token: payload.token, expiresAt: payload.expiresAt };
  saveSession(session);
  return session;
}

export function lockAdmin() { saveSession(null); }

export async function fetchServerEdits() {
  if (!adminConfigured()) return null;
  try {
    const payload = await call(CONFIG.adminEditsFunction, { action: "list" });
    return Array.isArray(payload?.edits) ? payload.edits : [];
  } catch (error) {
    console.warn("Правки словаря с сервера не загрузились", error);
    return null;
  }
}

export async function saveServerEdit(edit) {
  const session = adminSession();
  if (!session) throw new Error("Сессия администратора истекла");
  const payload = await call(CONFIG.adminEditsFunction, { action: "upsert", token: session.token, edit });
  return payload?.edit || edit;
}

export async function deleteServerEdit(id) {
  const session = adminSession();
  if (!session) throw new Error("Сессия администратора истекла");
  await call(CONFIG.adminEditsFunction, { action: "delete", token: session.token, id });
}

// --- локальный слой -------------------------------------------------------
// Правки продолжают жить в том же ключе, что и раньше: bishun_hsk30_admin_edits_v1.
// Серверные правки складываются поверх локальных, ничего не удаляя.

export function localEdits() {
  const edits = readJson(KEYS.adminEdits, []);
  return Array.isArray(edits) ? edits : [];
}

export function saveLocalEdits(edits) {
  writeJson(KEYS.adminEdits, edits);
  return edits;
}

export function mergeEdits(local, remote) {
  if (!Array.isArray(remote)) return local;
  const byId = new Map(local.map((edit) => [String(edit.id), edit]));
  for (const edit of remote) {
    const key = String(edit.id);
    const existing = byId.get(key);
    if (!existing || Date.parse(edit.updatedAt || 0) >= Date.parse(existing.updatedAt || 0)) {
      byId.set(key, edit);
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
}
