// Проверка пароля администратора. Ни сам пароль, ни его хеш во frontend не
// попадают: браузер отправляет введённую строку, всё сравнение здесь.
//
// Переменные окружения функции:
//   ADMIN_PIN_HASH — sha256(пароль + ADMIN_PIN_SALT), 64 hex-символа
//   ADMIN_PIN_SALT — произвольная строка, хранится только здесь
//   ADMIN_SESSION_HOURS — срок жизни сессии, по умолчанию 4
//   ADMIN_MAX_ATTEMPTS — неверных попыток до блокировки, по умолчанию 5
//   ADMIN_LOCK_MINUTES — длительность блокировки, по умолчанию 15

import { createClient } from "jsr:@supabase/supabase-js@2";
import { json, preflight, fingerprint, sha256Hex, timingSafeEqual } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PIN_HASH = (Deno.env.get("ADMIN_PIN_HASH") ?? "").toLowerCase();
const PIN_SALT = Deno.env.get("ADMIN_PIN_SALT") ?? "";
const SESSION_HOURS = Number(Deno.env.get("ADMIN_SESSION_HOURS") ?? 4);
const MAX_ATTEMPTS = Number(Deno.env.get("ADMIN_MAX_ATTEMPTS") ?? 5);
const LOCK_MINUTES = Number(Deno.env.get("ADMIN_LOCK_MINUTES") ?? 15);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

Deno.serve(async (request) => {
  const early = preflight(request);
  if (early) return early;
  if (request.method !== "POST") return json(request, { error: "Только POST" }, 405);

  let body: { action?: string; pin?: string; token?: string };
  try { body = await request.json(); } catch { return json(request, { error: "Некорректный запрос" }, 400); }

  if (body.action === "verify") {
    const session = await activeSession(body.token ?? "");
    return session
      ? json(request, { ok: true, expiresAt: session.expires_at })
      : json(request, { error: "Сессия недействительна" }, 401);
  }

  if (body.action !== "login") return json(request, { error: "Неизвестное действие" }, 400);
  if (!PIN_HASH || !PIN_SALT) {
    return json(request, { error: "На сервере не заданы ADMIN_PIN_HASH и ADMIN_PIN_SALT" }, 500);
  }

  const client = fingerprint(request);
  await admin.rpc("prune_admin_records");

  const since = new Date(Date.now() - LOCK_MINUTES * 60_000).toISOString();
  const { count } = await admin
    .from("admin_attempts")
    .select("id", { count: "exact", head: true })
    .eq("fingerprint", client)
    .eq("success", false)
    .gte("at", since);

  if ((count ?? 0) >= MAX_ATTEMPTS) {
    return json(request, {
      error: "Слишком много неудачных попыток",
      retryAfter: LOCK_MINUTES * 60,
    }, 429, { "retry-after": String(LOCK_MINUTES * 60) });
  }

  const supplied = await sha256Hex(`${body.pin ?? ""}${PIN_SALT}`);
  const ok = timingSafeEqual(supplied, PIN_HASH);
  await admin.from("admin_attempts").insert({ fingerprint: client, success: ok });

  if (!ok) {
    const attemptsLeft = Math.max(0, MAX_ATTEMPTS - ((count ?? 0) + 1));
    // Небольшая задержка гасит быстрый перебор четырёхзначных паролей.
    await new Promise((resolve) => setTimeout(resolve, 350));
    return json(request, { error: "Неверный пароль", attemptsLeft }, 401);
  }

  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  const { data, error } = await admin
    .from("admin_sessions")
    .insert({ expires_at: expiresAt, fingerprint: client })
    .select("token, expires_at")
    .single();

  if (error) return json(request, { error: "Не удалось создать сессию" }, 500);
  return json(request, { token: data.token, expiresAt: data.expires_at });
});

async function activeSession(token: string) {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return null;
  const { data } = await admin
    .from("admin_sessions")
    .select("token, expires_at")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return data ?? null;
}
