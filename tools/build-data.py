#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Собирает data/characters.json — словарь отдельных иероглифов
(чтение + русское значение + источник) и дополняет data/writing.json.

Источники значений, в порядке приоритета:
  1. tools/data-sources/poly.tsv  — значения по чтениям для многозначных знаков
  2. официальный список HSK (однознаковые слова из data/vocabulary.json)
  3. data/writing.json (значения, уже проставленные в письменном минимуме)
  4. tools/data-sources/ru_*.tsv — переводы значений CC-CEDICT/Unihan на русский

Чтения берутся из разбиения официального пиньиня по слогам (tools/pinyin_split.py),
поэтому у многозначных знаков чтение соответствует конкретному слову.

Запуск:  python3 tools/build-data.py
"""
import json, re, sys, collections, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from pinyin_split import split_word, HAN

SRC = ROOT / 'tools' / 'data-sources'


def load_tsv(path):
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.strip():
            rows.append(line.split('\t'))
    return rows


def main():
    voc = json.loads((ROOT / 'data' / 'vocabulary.json').read_text(encoding='utf-8'))
    wri = json.loads((ROOT / 'data' / 'writing.json').read_text(encoding='utf-8'))

    # --- чтения из разбиения официального пиньиня -------------------------
    readings = collections.defaultdict(collections.Counter)
    splits = {}
    unresolved = []
    for num, lvl, word, py, pos, ru in voc['rows']:
        parts, info = split_word(word, py)
        if not parts:
            unresolved.append((word, py, info))
            continue
        splits[word] = parts
        for ch, p in zip([c for c in word if HAN.match(c)], parts):
            readings[ch][p] += 1
    for lvl, group in wri['groups'].items():
        for row in group:
            for ex in row.get('examples', []):
                parts, info = split_word(ex[0], ex[1])
                if parts:
                    splits.setdefault(ex[0], parts)
                    for ch, p in zip([c for c in ex[0] if HAN.match(c)], parts):
                        readings[ch][p] += 1

    chars = {}

    def default_reading(ch):
        # «r» — только след эризации, самостоятельным чтением его не показываем
        for value, _ in readings[ch].most_common():
            if value != 'r':
                return value
        return readings[ch].most_common(1)[0][0] if readings[ch] else ''

    def put(ch, meaning, source, variants=None, reading=None):
        entry = chars.setdefault(ch, {})
        if 'm' in entry:
            return
        entry['p'] = reading or default_reading(ch)
        entry['m'] = meaning
        entry['s'] = source
        if variants:
            entry['v'] = variants

    # 1. многозначные знаки — значение на каждое чтение
    for row in load_tsv(SRC / 'poly.tsv'):
        ch, pairs = row[0], row[1:]
        variants = {}
        for pair in pairs:
            reading, _, meaning = pair.partition('=')
            variants[reading.strip()] = meaning.strip()
        default = default_reading(ch) or next(iter(variants))
        if default not in variants:
            default = next(iter(variants))
        put(ch, variants[default], 'hsk+poly', variants, default)

    # 2. официальные однознаковые слова HSK
    for num, lvl, word, py, pos, ru in voc['rows']:
        if len(word) == 1 and HAN.match(word) and ru:
            put(word, ru, 'hsk')

    # 3. письменный минимум
    for lvl, group in wri['groups'].items():
        for row in group:
            if row.get('meaning'):
                put(row['char'], row['meaning'], 'writing', reading=row.get('pinyin') or None)

    # 4. переводы значений словаря
    for path in sorted(SRC.glob('ru*.tsv')):
        for row in load_tsv(path):
            ch, raw = row[0], row[1]
            if '|' in raw and '=' in raw:
                variants = {}
                for pair in raw.split('|'):
                    reading, _, meaning = pair.partition('=')
                    variants[reading.strip()] = meaning.strip()
                default = default_reading(ch) or next(iter(variants))
                if default not in variants:
                    default = next(iter(variants))
                put(ch, variants[default], 'dict-ru', variants, default)
            else:
                put(ch, raw.strip(), 'dict-ru')

    # --- дополняем письменный минимум ------------------------------------
    filled = 0
    for lvl, group in wri['groups'].items():
        for row in group:
            entry = chars.get(row['char'])
            if not entry:
                continue
            if not row.get('pinyin'):
                row['pinyin'] = entry['p']; filled += 1
            if not row.get('meaning'):
                row['meaning'] = entry['m']

    payload = {
        'version': 'characters-2026-1',
        'note': 'p — основное чтение, m — значение, v — значения по чтениям, s — источник',
        'chars': dict(sorted(chars.items())),
    }
    (ROOT / 'data' / 'characters.json').write_text(
        json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    (ROOT / 'data' / 'writing.json').write_text(
        json.dumps(wri, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

    by_source = collections.Counter(v['s'] for v in chars.values())
    print(f'characters.json: {len(chars)} знаков  {dict(by_source)}')
    print(f'writing.json: заполнено пустых чтений — {filled}')
    if unresolved:
        print(f'не разобрано слов: {len(unresolved)} -> {unresolved[:5]}')

if __name__ == '__main__':
    main()
