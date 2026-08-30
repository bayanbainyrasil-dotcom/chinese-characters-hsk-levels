// Озвучка путунхуа. Ключ провайдера живёт только здесь, во frontend его нет.
// Готовые записи складываются в Supabase Storage: повторная просьба того же
// слова обходится без обращения к провайдеру.
//
// Переменные окружения функции:
//   TTS_PROVIDER      azure | google | openai
//   TTS_VOICE         например zh-CN-XiaoxiaoNeural (azure) или alloy (openai)
//   TTS_BUCKET        имя публичного бакета, по умолчанию tts-audio
//   AZURE_SPEECH_KEY / AZURE_SPEECH_REGION
//   GOOGLE_TTS_KEY
//   OPENAI_API_KEY

import { createClient } from "jsr:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PROVIDER = (Deno.env.get("TTS_PROVIDER") ?? "azure").toLowerCase();
const BUCKET = Deno.env.get("TTS_BUCKET") ?? "tts-audio";
const VOICE = Deno.env.get("TTS_VOICE") ?? "zh-CN-XiaoxiaoNeural";
const MAX_CHARS = 24;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

Deno.serve(async (request) => {
  const early = preflight(request);
  if (early) return early;
  if (request.method !== "POST") return json(request, { error: "Только POST" }, 405);

  let body: { text?: string; rate?: string };
  try { body = await request.json(); } catch { return json(request, { error: "Некорректный запрос" }, 400); }

  const text = (body.text ?? "").trim();
  const slow = body.rate === "slow";
  if (!text) return json(request, { error: "Пустой текст" }, 400);
  if ([...text].length > MAX_CHARS) return json(request, { error: "Слишком длинный текст" }, 400);
  // Озвучиваем только китайский: функция не должна стать чужим TTS-прокси.
  if (!/^[㐀-䶿一-鿿豈-﫿]+$/u.test(text)) {
    return json(request, { error: "Ожидались только иероглифы" }, 400);
  }

  const key = `${slow ? "s" : "n"}/${hex(text)}.mp3`;
  const publicUrl = admin.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;

  const head = await fetch(publicUrl, { method: "HEAD" });
  if (head.ok) return json(request, { url: publicUrl, cached: true });

  let audio: ArrayBuffer;
  try {
    audio = await synthesize(text, slow);
  } catch (error) {
    return json(request, { error: `Провайдер озвучки недоступен: ${error}` }, 502);
  }

  const { error } = await admin.storage.from(BUCKET).upload(key, audio, {
    contentType: "audio/mpeg", upsert: true, cacheControl: "31536000",
  });
  if (error) return json(request, { error: error.message }, 500);

  return json(request, { url: publicUrl, cached: false });
});

function hex(text: string) {
  return [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function escapeXml(value: string) {
  return value.replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch]!));
}

async function synthesize(text: string, slow: boolean): Promise<ArrayBuffer> {
  if (PROVIDER === "azure") return azure(text, slow);
  if (PROVIDER === "google") return google(text, slow);
  if (PROVIDER === "openai") return openai(text, slow);
  throw new Error(`неизвестный провайдер ${PROVIDER}`);
}

async function azure(text: string, slow: boolean) {
  const key = Deno.env.get("AZURE_SPEECH_KEY");
  const region = Deno.env.get("AZURE_SPEECH_REGION");
  if (!key || !region) throw new Error("нет AZURE_SPEECH_KEY или AZURE_SPEECH_REGION");
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">
    <voice name="${VOICE}"><prosody rate="${slow ? "-40%" : "0%"}">${escapeXml(text)}</prosody></voice>
  </speak>`;
  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "chinese-characters-hsk-levels",
    },
    body: ssml,
  });
  if (!response.ok) throw new Error(`Azure ${response.status}`);
  return response.arrayBuffer();
}

async function google(text: string, slow: boolean) {
  const key = Deno.env.get("GOOGLE_TTS_KEY");
  if (!key) throw new Error("нет GOOGLE_TTS_KEY");
  const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: "cmn-CN", name: VOICE.startsWith("cmn") ? VOICE : "cmn-CN-Wavenet-A" },
      audioConfig: { audioEncoding: "MP3", speakingRate: slow ? 0.6 : 1.0 },
    }),
  });
  if (!response.ok) throw new Error(`Google ${response.status}`);
  const payload = await response.json();
  return Uint8Array.from(atob(payload.audioContent), (ch) => ch.charCodeAt(0)).buffer;
}

async function openai(text: string, slow: boolean) {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("нет OPENAI_API_KEY");
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_TTS_MODEL") ?? "gpt-4o-mini-tts",
      voice: VOICE.includes("-") ? "alloy" : VOICE,
      input: text,
      speed: slow ? 0.6 : 1.0,
      response_format: "mp3",
    }),
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}`);
  return response.arrayBuffer();
}
