// Публичная настройка. Секретов здесь нет и быть не должно:
// publishable key Supabase публичен по замыслу, доступ ограничивают политики RLS.
// PIN администратора и ключи TTS живут только в переменных окружения Supabase.

export const CONFIG = {
  // Заполняется после создания проекта Supabase (см. docs/supabase-setup.md)
  supabaseUrl: "https://rnrjvgheyehywarjrwsf.supabase.co",
  supabaseAnonKey: "sb_publishable_u-6eezoElzTALx8FIhcpnA_NrK-y0DC",

  // Имена Edge Functions
  ttsFunction: "tts",
  adminAuthFunction: "admin-auth",
  adminEditsFunction: "admin-edits",

  // Папка со статическим аудиопаком (генерируется tools/generate-audio.mjs)
  audioBase: "audio",

  // Ведро Supabase Storage с готовыми записями озвучки.
  // Адрес файла предсказуем, поэтому его берут напрямую, без вызова функции.
  ttsBucket: "tts-audio",

  appVersion: "20260901-3",
};

export function backendReady() {
  return Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
}

export function functionUrl(name) {
  if (!CONFIG.supabaseUrl) return "";
  return `${CONFIG.supabaseUrl.replace(/\/+$/, "")}/functions/v1/${name}`;
}
