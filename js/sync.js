// Синхронизация прогресса между устройствами по принципу local-first.
//
// Порядок такой: результат написания мгновенно ложится в localStorage, интерфейс
// не ждёт сервер, а событие уходит в очередь. Очередь пробуется отправить при
// входе, возвращении на вкладку, восстановлении сети и после каждого упражнения.
// У каждого события собственный UUID, поэтому повторная отправка ничего не задваивает.

import { CONFIG, backendReady } from "./config.js";
import { KEYS, readJson, writeJson, uuid, deviceId } from "./storage.js";
import { merge, normalize, markServerSynced } from "./progress.js";

const STATES = ["idle", "saved", "syncing", "offline", "error"];
const FLUSH_DEBOUNCE = 1200;
const MAX_QUEUE = 500;

let client = null;
let clientPromise = null;

async function getClient() {
  if (!backendReady()) return null;
  if (client) return client;
  if (!clientPromise) {
    clientPromise = import("../assets/supabase.esm.js")
      .then(({ createClient }) => {
        client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
        });
        return client;
      })
      .catch((error) => {
        console.warn("Не удалось загрузить клиент Supabase", error);
        clientPromise = null;
        return null;
      });
  }
  return clientPromise;
}

class Emitter {
  constructor() { this.handlers = new Map(); }
  on(name, handler) {
    const list = this.handlers.get(name) || [];
    list.push(handler);
    this.handlers.set(name, list);
    return () => this.off(name, handler);
  }
  off(name, handler) {
    this.handlers.set(name, (this.handlers.get(name) || []).filter((h) => h !== handler));
  }
  emit(name, payload) {
    for (const handler of this.handlers.get(name) || []) {
      try { handler(payload); } catch (error) { console.error(error); }
    }
  }
}

export class SyncEngine extends Emitter {
  constructor({ getLocal, applyRemote }) {
    super();
    this.getLocal = getLocal;
    this.applyRemote = applyRemote;
    this.user = null;
    this.status = "idle";
    this.lastError = null;
    this.flushTimer = null;
    this.busy = false;
    this.started = false;
  }

  get enabled() { return backendReady(); }
  get signedIn() { return Boolean(this.user); }

  setStatus(status, error = null) {
    if (!STATES.includes(status)) return;
    this.status = status;
    this.lastError = error;
    this.emit("status", { status, error });
  }

  queue() {
    const list = readJson(KEYS.queue, []);
    return Array.isArray(list) ? list : [];
  }

  saveQueue(list) {
    writeJson(KEYS.queue, list.slice(-MAX_QUEUE));
  }

  /** Кладёт событие в очередь и планирует отправку. Интерфейс не ждёт. */
  enqueue(payload) {
    const event = {
      id: uuid(),
      at: new Date().toISOString(),
      device: deviceId(),
      payload,
    };
    const list = this.queue();
    list.push(event);
    this.saveQueue(list);
    this.emit("queue", list.length);
    this.scheduleFlush();
    return event;
  }

  scheduleFlush(delay = FLUSH_DEBOUNCE) {
    if (!this.enabled) { this.setStatus(navigator.onLine ? "saved" : "offline"); return; }
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), delay);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    if (!this.enabled) { this.setStatus("saved"); return; }
    const supabase = await getClient();
    if (!supabase) { this.setStatus("error", "Бэкенд недоступен"); return; }
    const { data } = await supabase.auth.getSession();
    this.user = data?.session?.user || null;
    this.emit("auth", this.user);
    supabase.auth.onAuthStateChange((_event, session) => {
      const next = session?.user || null;
      const changed = next?.id !== this.user?.id;
      this.user = next;
      this.emit("auth", next);
      if (changed && next) this.syncNow({ uploadSnapshot: true });
      if (changed && !next) this.setStatus("saved");
    });
    if (this.user) await this.syncNow({ uploadSnapshot: true });
    else this.setStatus("saved");

    window.addEventListener("online", () => this.syncNow());
    window.addEventListener("offline", () => this.setStatus("offline"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.syncNow();
    });
  }

  async signInWithGoogle() {
    const supabase = await getClient();
    if (!supabase) throw new Error("Бэкенд не настроен");
    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo, queryParams: { prompt: "select_account" } },
    });
    if (error) throw error;
  }

  async signInWithPassword(email, password) {
    const supabase = await getClient();
    if (!supabase) throw new Error("Бэкенд не настроен");
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  }

  async signUpWithPassword(email, password) {
    const supabase = await getClient();
    if (!supabase) throw new Error("Бэкенд не настроен");
    const redirectTo = window.location.origin + window.location.pathname;
    const { data, error } = await supabase.auth.signUp({
      email, password, options: { emailRedirectTo: redirectTo },
    });
    if (error) throw error;
    return data.user;
  }

  async sendMagicLink(email) {
    const supabase = await getClient();
    if (!supabase) throw new Error("Бэкенд не настроен");
    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
    if (error) throw error;
  }

  async signOut() {
    const supabase = await getClient();
    if (supabase) await supabase.auth.signOut();
    this.user = null;
    this.emit("auth", null);
    this.setStatus("saved");   // локальные данные остаются на месте
  }

  /** Полный цикл: отправить очередь, забрать серверное состояние, слить с локальным. */
  async syncNow({ uploadSnapshot = false } = {}) {
    if (!this.enabled || !this.signedIn) {
      this.setStatus(navigator.onLine ? "saved" : "offline");
      return null;
    }
    if (!navigator.onLine) { this.setStatus("offline"); return null; }
    if (this.busy) return null;
    this.busy = true;
    this.setStatus("syncing");
    try {
      const supabase = await getClient();
      if (!supabase) throw new Error("Клиент недоступен");
      if (uploadSnapshot) this.enqueueSnapshotOnce();
      const pending = this.queue();
      const { data, error } = await supabase.rpc("apply_progress_events", {
        p_events: pending.map((event) => ({
          id: event.id, at: event.at, device: event.device, payload: event.payload,
        })),
      });
      if (error) throw error;
      const stillPending = this.queue().filter((event) => !pending.some((sent) => sent.id === event.id));
      this.saveQueue(stillPending);
      this.emit("queue", stillPending.length);
      if (data) {
        const remote = normalize(fromRow(data));
        const merged = merge(this.getLocal(), remote);
        this.applyRemote(merged);
      }
      markServerSynced();
      this.setStatus("saved");
      return data;
    } catch (error) {
      console.warn("Синхронизация не удалась", error);
      this.setStatus(navigator.onLine ? "error" : "offline", error?.message || String(error));
      return null;
    } finally {
      this.busy = false;
    }
  }

  async flush() { return this.syncNow(); }

  /** Один раз на устройство и аккаунт заливает весь локальный прогресс целиком. */
  enqueueSnapshotOnce() {
    if (!this.user) return;
    const flagKey = `bishun_hsk30_snapshot_${this.user.id}_${deviceId()}`;
    const mark = readJson(KEYS.migration, {}) || {};
    if (mark[flagKey]) return;
    const local = normalize(this.getLocal());
    this.enqueue({
      kind: "snapshot",
      completed: local.completed,
      attemptsTotal: local.attempts,
      cleanTotal: local.cleanAttempts,
      days: local.days,
      lastSession: local.lastSession,
      lastLevel: local.lastLevel,
      lastChar: local.lastChar,
      settings: local.settings,
    });
    mark[flagKey] = new Date().toISOString();
    writeJson(KEYS.migration, mark);
  }
}

function fromRow(row) {
  const source = Array.isArray(row) ? row[0] : row;
  if (!source) return {};
  return {
    completed: source.completed || {},
    attempts: source.attempts || 0,
    cleanAttempts: source.clean_attempts || 0,
    days: source.days || [],
    lastSession: source.last_session || null,
    lastLevel: source.last_level || null,
    lastChar: source.last_char || null,
    settings: source.settings || {},
    updatedAt: source.updated_at ? Date.parse(source.updated_at) : 0,
  };
}

export async function supabaseClient() { return getClient(); }
