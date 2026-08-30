// Публичная настройка. Секретов здесь нет и быть не должно:
// anon key Supabase публичен по замыслу, доступ ограничивают политики RLS.
// PIN администратора и ключи TTS живут только в переменных окружения Supabase.

export const CONFIG = {
  // Заполняется после создания проекта Supabase (см. docs/supabase-setup.md)
  supabaseUrl: "",
  supabaseAnonKey: "",

  // Имена Edge Functions
  ttsFunction: "tts",
  adminAuthFunction: "admin-auth",
  adminEditsFunction: "admin-edits",

  // Папка со статическим аудиопаком (генерируется tools/generate-audio.mjs)
  audioBase: "audio",

  appVersion: "20260830-1",
};

export function backendReady() {
  return Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
}

export function functionUrl(name) {
  if (!CONFIG.supabaseUrl) return "";
  return `${CONFIG.supabaseUrl.replace(/\/+$/, "")}/functions/v1/${name}`;
}
