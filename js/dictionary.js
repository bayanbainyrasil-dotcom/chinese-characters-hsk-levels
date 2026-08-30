// Словарь отдельных иероглифов и разбор слова по знакам.
// Чтения берутся из разбиения официального пиньиня, значения — из data/characters.json.

import { CONFIG } from "./config.js";
import { analyseWord, hanCharacters } from "./pinyin.js";

let charsPromise = null;
let chars = null;

export async function loadCharacters() {
  if (chars) return chars;
  if (!charsPromise) {
    charsPromise = fetch(`data/characters.json?v=${CONFIG.appVersion}`)
      .then((response) => {
        if (!response.ok) throw new Error("characters.json недоступен");
        return response.json();
      })
      .then((payload) => { chars = payload.chars || {}; return chars; })
      .catch((error) => { console.warn("Словарь знаков не загрузился", error); chars = {}; return chars; });
  }
  return charsPromise;
}

export function characterEntry(char) {
  return (chars || {})[char] || null;
}

/** Значение знака именно для того чтения, с которым он читается в слове. */
export function meaningFor(char, reading) {
  const entry = characterEntry(char);
  if (!entry) return "";
  if (reading && entry.v && entry.v[reading]) return entry.v[reading];
  return entry.m || "";
}

export function readingFor(char) {
  return characterEntry(char)?.p || "";
}

/**
 * Разбор слова: по одному иероглифу, с чтением из этого слова и значением.
 * [{ char, pinyin, meaning }]
 */
export function breakdown(word, officialPinyin) {
  return analyseWord(word, officialPinyin).map(({ char, pinyin }) => ({
    char,
    pinyin: pinyin || readingFor(char),
    meaning: meaningFor(char, pinyin),
  }));
}

export { hanCharacters };
