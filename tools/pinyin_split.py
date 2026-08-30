# -*- coding: utf-8 -*-
"""Разбиение официального пиньиня слова на слоги — по одному на иероглиф.

Опорный приём: количество слогов заранее известно (равно числу ханьцзи),
поэтому перебор допустимых разбиений почти всегда даёт единственный ответ.
Дополнительно используется правило орфографии пиньиня (GB/T 16159): слог,
начинающийся с a/e/o, внутри слова отделяется апострофом.

Эталон для JS-порта: js/pinyin.js. tests/test_pinyin_parity.py сверяет их.
"""
import re, unicodedata

HAN = re.compile(r'[㐀-䶿一-鿿豈-﫿]')

_MARKS = {
    'a': 'āáǎà', 'e': 'ēéěè', 'i': 'īíǐì', 'o': 'ōóǒò',
    'u': 'ūúǔù', 'ü': 'ǖǘǚǜ',
}
TONE_MAP = {}
for _base, _row in _MARKS.items():
    for _i, _ch in enumerate(_row):
        TONE_MAP[_ch] = (_base, _i + 1)
TONE_MAP.update({'ń': ('n', 2), 'ň': ('n', 3), 'ǹ': ('n', 4), 'ḿ': ('m', 2)})
REVERSE = {f'{b}{i + 1}': c for b, row in _MARKS.items() for i, c in enumerate(row)}
REVERSE.update({'n2': 'ń', 'n3': 'ň', 'n4': 'ǹ', 'm2': 'ḿ'})

SEPARATORS = "’'·- ’"


def strip_tones(text):
    out, tones = [], []
    for ch in unicodedata.normalize('NFC', text):
        low = ch.lower()
        if low in TONE_MAP:
            base, tone = TONE_MAP[low]
            tones.append((len(out), tone))
            out.append(base)
        else:
            out.append(low)
    return ''.join(out), tones


def _build_syllables():
    from pypinyin.constants import PINYIN_DICT
    syllables = set()
    for value in PINYIN_DICT.values():
        for reading in value.split(','):
            toneless, _ = strip_tones(reading)
            toneless = toneless.replace('v', 'ü')
            if toneless and re.fullmatch(r'[a-zü]+', toneless):
                syllables.add(toneless)
    return syllables


SYLLABLES = _build_syllables()
ERHUA = {'r'}          # 儿 в конце слова сливается со слогом и остаётся буквой r


def normalize(official):
    """Официальный пиньинь -> (латиница без тонов, тоны, обязательные границы)."""
    raw = re.split(r'[/,;、]', str(official or ''))[0].strip()
    breaks, cleaned = set(), []
    for ch in raw:
        if ch in SEPARATORS:
            if cleaned:
                breaks.add(len(cleaned))
        else:
            cleaned.append(ch)
    toneless, tones = strip_tones(''.join(cleaned))
    toneless = toneless.replace('v', 'ü')
    match = re.match(r'[a-zü]+', toneless)
    kept = match.group(0) if match else ''
    tones = [(i, t) for i, t in tones if i < len(kept)]
    return kept, tones, {b for b in breaks if 0 < b < len(kept)}


def _segment(toneless, count, breaks=frozenset(), strict=True):
    results = []
    length = len(toneless)

    def walk(pos, parts):
        if len(parts) == count:
            if pos == length:
                results.append(list(parts))
            return
        if len(results) > 40:
            return
        remaining = count - len(parts)
        for end in range(min(length, pos + 7), pos, -1):
            piece = toneless[pos:end]
            if length - end < remaining - 1:
                continue
            if any(pos < b < end for b in breaks):
                continue
            if strict and pos > 0 and pos not in breaks and piece[0] in 'aeo':
                continue
            if piece in SYLLABLES or piece in ERHUA:
                parts.append(piece)
                walk(end, parts)
                parts.pop()

    walk(0, [])
    return results


def _reattach(parts, tones):
    tone_at = dict(tones)
    out, cursor = [], 0
    for part in parts:
        chars = []
        for i, ch in enumerate(part):
            tone = tone_at.get(cursor + i)
            chars.append(REVERSE.get(f'{ch}{tone}', ch) if tone else ch)
        out.append(''.join(chars))
        cursor += len(part)
    return out


def split_word(word, official):
    """-> (список слогов с тонами, статус) либо (None, причина)."""
    hans = [c for c in str(word) if HAN.match(c)]
    if not hans:
        return None, 'nohan'
    toneless, tones, breaks = normalize(official)
    if not re.fullmatch(r'[a-zü]+', toneless or ''):
        return None, 'badpinyin'
    candidates = _segment(toneless, len(hans), breaks)
    status = 'exact'
    if not candidates:
        # в исходных данных иногда пропущен апостроф — ослабляем правило
        candidates = _segment(toneless, len(hans), breaks, strict=False)
        status = 'relaxed'
    if not candidates:
        return None, 'failed'
    if len(candidates) > 1:
        # детерминированный запасной ход: самый длинный первый слог
        candidates = [max(candidates, key=lambda c: [len(x) for x in c])]
        status = 'relaxed'
    return _reattach(candidates[0], tones), status
