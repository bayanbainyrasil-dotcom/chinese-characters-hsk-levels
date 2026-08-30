// Общие заголовки CORS: сайт живёт на GitHub Pages, функции — в Supabase.
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  const allow = ALLOWED.includes("*") ? "*" : (ALLOWED.includes(origin) ? origin : ALLOWED[0] ?? "");
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "vary": "origin",
  };
}

export function json(request: Request, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(request), ...extra },
  });
}

export function preflight(request: Request) {
  if (request.method !== "OPTIONS") return null;
  return new Response("ok", { headers: corsHeaders(request) });
}

/** Грубый отпечаток клиента для ограничения попыток входа. */
export function fingerprint(request: Request): string {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("cf-connecting-ip")
    ?? "unknown";
  return ip;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Сравнение за постоянное время: длина ответа не должна выдавать подсказку. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}
