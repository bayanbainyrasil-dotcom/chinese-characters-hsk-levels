// Правки словаря. Читать может любой посетитель — правки должны одинаково
// отображаться всем. Изменять может только держатель серверной сессии админа.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

type Edit = {
  id: string;
  baseNumber?: number | null;
  level?: string;
  word: string;
  pinyin?: string;
  partOfSpeech?: string;
  russian: string;
  deleted?: boolean;
  updatedAt?: string;
};

Deno.serve(async (request) => {
  const early = preflight(request);
  if (early) return early;
  if (request.method !== "POST") return json(request, { error: "Только POST" }, 405);

  let body: { action?: string; token?: string; edit?: Edit; id?: string };
  try { body = await request.json(); } catch { return json(request, { error: "Некорректный запрос" }, 400); }

  if (body.action === "list") {
    const { data, error } = await admin
      .from("dictionary_edits")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(2000);
    if (error) return json(request, { error: error.message }, 500);
    return json(request, { edits: (data ?? []).map(toClient) });
  }

  const session = await activeSession(body.token ?? "");
  if (!session) return json(request, { error: "Нужен вход администратора" }, 401);

  if (body.action === "upsert") {
    const edit = body.edit;
    if (!edit?.id || !edit.word || !edit.russian) {
      return json(request, { error: "Нужны идентификатор, иероглифы и перевод" }, 400);
    }
    const { data, error } = await admin
      .from("dictionary_edits")
      .upsert({
        id: String(edit.id).slice(0, 120),
        base_number: edit.baseNumber ?? null,
        level: (edit.level ?? "").slice(0, 8),
        word: edit.word.slice(0, 40),
        pinyin: (edit.pinyin ?? "").slice(0, 120),
        part_of_speech: (edit.partOfSpeech ?? "").slice(0, 60),
        russian: edit.russian.slice(0, 600),
        deleted: Boolean(edit.deleted),
        updated_at: new Date().toISOString(),
        updated_by: session.token,
      })
      .select("*")
      .single();
    if (error) return json(request, { error: error.message }, 500);
    return json(request, { edit: toClient(data) });
  }

  if (body.action === "delete") {
    if (!body.id) return json(request, { error: "Не указан идентификатор" }, 400);
    const { error } = await admin.from("dictionary_edits").delete().eq("id", body.id);
    if (error) return json(request, { error: error.message }, 500);
    return json(request, { ok: true });
  }

  return json(request, { error: "Неизвестное действие" }, 400);
});

function toClient(row: Record<string, unknown>) {
  return {
    id: row.id,
    baseNumber: row.base_number,
    level: row.level,
    word: row.word,
    pinyin: row.pinyin,
    partOfSpeech: row.part_of_speech,
    russian: row.russian,
    deleted: row.deleted,
    updatedAt: row.updated_at,
  };
}

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
