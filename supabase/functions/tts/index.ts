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

/** Есть ли вообще ключ у выбранного провайдера озвучки. */
function providerConfigured(): boolean {
  if (PROVIDER === "edge" || PROVIDER === "gtranslate") return true; // бесплатные движки, ключ не нужен
  if (PROVIDER === "azure") return Boolean(Deno.env.get("AZURE_SPEECH_KEY") && Deno.env.get("AZURE_SPEECH_REGION"));
  if (PROVIDER === "google") return Boolean(Deno.env.get("GOOGLE_TTS_KEY"));
  if (PROVIDER === "openai") return Boolean(Deno.env.get("OPENAI_API_KEY"));
  return false;
}

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

  // Пока ключ провайдера не задан, это не ошибка: сайт просто читает голосом
  // браузера. Отвечаем честным 200 без ссылки, чтобы не сыпать 502 на каждый знак.
  if (!providerConfigured()) return json(request, { url: null, reason: "provider-not-configured" });

  let audio: ArrayBuffer;
  try {
    audio = await synthesize(text, slow);
  } catch (error) {
    console.error("Провайдер озвучки недоступен", error);
    return json(request, { url: null, reason: "provider-error" });
  }

  let { error } = await admin.storage.from(BUCKET).upload(key, audio, {
    contentType: "audio/mpeg", upsert: true, cacheControl: "31536000",
  });
  // Ведро может ещё не существовать: создаём на месте и повторяем загрузку,
  // чтобы развёртывание не зависело от ручных шагов в панели Supabase.
  if (error && /bucket not found/i.test(error.message)) {
    await admin.storage.createBucket(BUCKET, {
      public: true, fileSizeLimit: 2 * 1024 * 1024, allowedMimeTypes: ["audio/mpeg"],
    });
    ({ error } = await admin.storage.from(BUCKET).upload(key, audio, {
      contentType: "audio/mpeg", upsert: true, cacheControl: "31536000",
    }));
  }
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
  if (PROVIDER === "edge") {
    // Голоса Edge звучат заметно живее, но эндпоинт Microsoft капризен.
    // Если он отказал — не молчим, а озвучиваем запасным движком.
    try { return await edgeNeural(text, slow); }
    catch (error) { console.warn("Edge отказал, беру запасной движок", error); return translateTts(text, slow); }
  }
  if (PROVIDER === "gtranslate") return translateTts(text, slow);
  if (PROVIDER === "azure") return azure(text, slow);
  if (PROVIDER === "google") return google(text, slow);
  if (PROVIDER === "openai") return openai(text, slow);
  throw new Error(`неизвестный провайдер ${PROVIDER}`);
}

/**
 * Запасной движок: голосовой синтез Google Translate. Простой GET, ключа не
 * требует, тоны стандартные пекинские. Качество ниже нейронных голосов Edge,
 * но это несравнимо лучше тишины, а у пользователя в браузере нет ни одного
 * китайского голоса.
 */
async function translateTts(text: string, slow: boolean): Promise<ArrayBuffer> {
  const url = "https://translate.google.com/translate_tts"
    + `?ie=UTF-8&client=tw-ob&tl=zh-CN&ttsspeed=${slow ? "0.24" : "1"}`
    + `&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "referer": "https://translate.google.com/",
    },
  });
  if (!response.ok) throw new Error(`translate_tts вернул ${response.status}`);
  const audio = await response.arrayBuffer();
  if (audio.byteLength < 512) throw new Error("translate_tts вернул пустой ответ");
  return audio;
}

/* ===========================================================================
   Бесплатные нейронные голоса Microsoft Edge (те же, что в «Прочитать вслух»).
   Ключ не нужен, но нужен одноразовый токен Sec-MS-GEC: SHA-256 от времени
   Windows, округлённого вниз до пятиминутного окна, склеенного с публичным
   client token. Без него сервер отвечает 401.
   ======================================================================== */

const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_VERSION = "1-131.0.2903.63";

async function secMsGec(): Promise<string> {
  // Такты Windows FILETIME (100 нс с 1601 года), округлённые до 5 минут.
  let ticks = BigInt(Math.floor(Date.now() / 1000) + 11644473600) * 10000000n;
  ticks -= ticks % 3000000000n;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ticks}${EDGE_TOKEN}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function edgeSsml(text: string, slow: boolean) {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`
    + `<voice name='${VOICE}'>`
    + `<prosody pitch='+0Hz' rate='${slow ? "-40%" : "+0%"}' volume='+0%'>${escapeXml(text)}</prosody>`
    + `</voice></speak>`;
}

function edgeNeural(text: string, slow: boolean): Promise<ArrayBuffer> {
  return new Promise(async (resolve, reject) => {
    const gec = await secMsGec();
    const url = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
      + `?TrustedClientToken=${EDGE_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${EDGE_VERSION}`;
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    const chunks: Uint8Array[] = [];
    const requestId = crypto.randomUUID().replace(/-/g, "");
    const timer = setTimeout(() => { try { socket.close(); } catch { /* уже закрыт */ } reject(new Error("таймаут озвучки")); }, 20000);
    const fail = (error: unknown) => { clearTimeout(timer); try { socket.close(); } catch { /* уже закрыт */ } reject(error); };

    socket.onerror = () => fail(new Error("сокет озвучки не открылся"));

    socket.onopen = () => {
      const stamp = new Date().toString();
      socket.send(
        `X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},`
        + `"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`,
      );
      socket.send(
        `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}\r\nPath:ssml\r\n\r\n`
        + edgeSsml(text, slow),
      );
    };

    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        if (event.data.includes("Path:turn.end")) {
          clearTimeout(timer);
          try { socket.close(); } catch { /* уже закрыт */ }
          if (!chunks.length) return reject(new Error("сервер не прислал звук"));
          const total = chunks.reduce((sum, part) => sum + part.length, 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const part of chunks) { merged.set(part, offset); offset += part.length; }
          resolve(merged.buffer);
        }
        return;
      }
      // Двоичный кадр: 2 байта длины заголовка, сам заголовок, дальше mp3.
      const view = new Uint8Array(event.data as ArrayBuffer);
      const headerLength = (view[0] << 8) | view[1];
      const header = new TextDecoder().decode(view.subarray(2, 2 + headerLength));
      if (header.includes("Path:audio")) chunks.push(view.subarray(2 + headerLength));
    };
  });
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
