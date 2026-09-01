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

/**
 * Штатный WebSocket браузера и Deno не даёт задать Origin и User-Agent, а без
 * них Microsoft рвёт соединение. Поэтому рукопожатие делаем руками поверх TLS:
 * это единственный способ получить нейронные голоса без ключа.
 */
async function edgeNeural(text: string, slow: boolean): Promise<ArrayBuffer> {
  const gec = await secMsGec();
  const path = "/consumer/speech/synthesize/readaloud/edge/v1"
    + `?TrustedClientToken=${EDGE_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${EDGE_VERSION}`;
  const conn = await Deno.connectTls({ hostname: "speech.platform.bing.com", port: 443 });
  const deadline = Date.now() + 20000;
  try {
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const handshake = [
      `GET ${path} HTTP/1.1`,
      "Host: speech.platform.bing.com",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${nonce}`,
      "Sec-WebSocket-Version: 13",
      "Origin: chrome-extension://jdiccldimpahbcfdikimhckbmoiedhbn",
      "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      "Accept-Language: en-US,en;q=0.9",
      "Pragma: no-cache",
      "Cache-Control: no-cache",
      "", "",
    ].join("\r\n");
    await writeAll(conn, new TextEncoder().encode(handshake));

    const reader = new FrameReader(conn, deadline);
    const head = await reader.readUntil("\r\n\r\n");
    if (!/^HTTP\/1\.1 101/.test(head)) throw new Error(`рукопожатие: ${head.split("\r\n")[0]}`);

    const stamp = new Date().toString();
    const requestId = crypto.randomUUID().replace(/-/g, "");
    await writeAll(conn, wsFrame(1,
      `X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
      + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false",'
      + '"wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}'));
    await writeAll(conn, wsFrame(1,
      `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}\r\nPath:ssml\r\n\r\n`
      + edgeSsml(text, slow)));

    const parts: Uint8Array[] = [];
    for (;;) {
      const frame = await reader.readFrame();
      if (frame.opcode === 8) throw new Error("сервер закрыл соединение");
      if (frame.opcode === 9) { await writeAll(conn, wsFrameBytes(10, frame.payload)); continue; }
      if (frame.opcode === 1) {
        if (new TextDecoder().decode(frame.payload).includes("Path:turn.end")) break;
        continue;
      }
      if (frame.opcode === 2 || frame.opcode === 0) {
        const view = frame.payload;
        const headerLength = (view[0] << 8) | view[1];
        const header = new TextDecoder().decode(view.subarray(2, 2 + headerLength));
        if (header.includes("Path:audio")) parts.push(view.subarray(2 + headerLength));
      }
    }
    if (!parts.length) throw new Error("сервер не прислал звук");
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { merged.set(part, offset); offset += part.length; }
    return merged.buffer;
  } finally {
    try { conn.close(); } catch { /* уже закрыт */ }
  }
}

async function writeAll(conn: Deno.Conn, data: Uint8Array) {
  let written = 0;
  while (written < data.length) written += await conn.write(data.subarray(written));
}

/** Кадр WebSocket от клиента обязан быть маскированным. */
function wsFrameBytes(opcode: number, payload: Uint8Array): Uint8Array {
  const length = payload.length;
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const frame = new Uint8Array(2 + extra + 4 + length);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | (extra === 0 ? length : extra === 2 ? 126 : 127);
  if (extra === 2) { frame[2] = (length >> 8) & 0xff; frame[3] = length & 0xff; }
  if (extra === 8) {
    let rest = BigInt(length);
    for (let i = 9; i >= 2; i -= 1) { frame[i] = Number(rest & 0xffn); rest >>= 8n; }
  }
  const mask = crypto.getRandomValues(new Uint8Array(4));
  frame.set(mask, 2 + extra);
  for (let i = 0; i < length; i += 1) frame[2 + extra + 4 + i] = payload[i] ^ mask[i % 4];
  return frame;
}

function wsFrame(opcode: number, text: string): Uint8Array {
  return wsFrameBytes(opcode, new TextEncoder().encode(text));
}

/** Буферизованное чтение кадров: TCP отдаёт данные кусками произвольного размера. */
class FrameReader {
  private buffer = new Uint8Array(0);
  constructor(private conn: Deno.Conn, private deadline: number) {}

  private async pull() {
    if (Date.now() > this.deadline) throw new Error("таймаут озвучки");
    const chunk = new Uint8Array(16384);
    const read = await this.conn.read(chunk);
    if (read === null) throw new Error("соединение закрылось");
    const next = new Uint8Array(this.buffer.length + read);
    next.set(this.buffer); next.set(chunk.subarray(0, read), this.buffer.length);
    this.buffer = next;
  }

  private async need(count: number) {
    while (this.buffer.length < count) await this.pull();
  }

  private take(count: number) {
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  async readUntil(marker: string): Promise<string> {
    const decoder = new TextDecoder();
    for (;;) {
      const text = decoder.decode(this.buffer);
      const at = text.indexOf(marker);
      if (at >= 0) {
        const bytes = new TextEncoder().encode(text.slice(0, at + marker.length)).length;
        return decoder.decode(this.take(bytes));
      }
      await this.pull();
    }
  }

  async readFrame(): Promise<{ opcode: number; payload: Uint8Array }> {
    await this.need(2);
    const opcode = this.buffer[0] & 0x0f;
    const short = this.buffer[1] & 0x7f;
    let offset = 2;
    let length = short;
    if (short === 126) { await this.need(4); length = (this.buffer[2] << 8) | this.buffer[3]; offset = 4; }
    else if (short === 127) {
      await this.need(10);
      length = 0;
      for (let i = 2; i < 10; i += 1) length = length * 256 + this.buffer[i];
      offset = 10;
    }
    await this.need(offset + length);
    this.take(offset);
    return { opcode, payload: this.take(length).slice() };
  }
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
