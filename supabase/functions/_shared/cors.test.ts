// Проверка вспомогательных функций Edge Functions.
// Запуск: deno test supabase/functions/_shared/cors.test.ts
import { sha256Hex, timingSafeEqual } from "./cors.ts";

function expect(condition: boolean, label: string) {
  if (!condition) throw new Error(`ПРОВАЛ: ${label}`);
}

Deno.test("хеш совпадает с результатом sha256sum", async () => {
  // printf '%s' "2007demo-salt" | sha256sum
  expect(
    await sha256Hex("2007demo-salt") === "5970f03f6139dabcce205f207636b4e25a3d392f1457254ef0753410245680ca",
    "хеш совпадает с posix sha256sum",
  );
});

Deno.test("другой пароль даёт другой хеш", async () => {
  expect(await sha256Hex("2008demo-salt") !== await sha256Hex("2007demo-salt"), "хеши различаются");
});

Deno.test("сравнение за постоянное время не пропускает чужой хеш", async () => {
  const right = await sha256Hex("2007salt");
  const wrong = await sha256Hex("1234salt");
  expect(timingSafeEqual(right, right), "верный хеш принимается");
  expect(!timingSafeEqual(right, wrong), "неверный хеш отклоняется");
  expect(!timingSafeEqual(right, right.slice(0, 10)), "обрезанный хеш отклоняется");
});

Deno.test("озвучиваются только иероглифы", () => {
  const onlyHan = (value: string) => /^[㐀-䶿一-鿿豈-﫿]+$/u.test(value);
  expect(onlyHan("汉语"), "иероглифы проходят");
  expect(!onlyHan("hello"), "латиница не проходит");
  expect(!onlyHan("汉 语"), "пробел не проходит");
  expect(!onlyHan("<speak>"), "разметка не проходит");
});
