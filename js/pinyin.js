// Разбиение официального пиньиня на слоги — по одному на иероглиф.
// Порт tools/pinyin_split.py; равенство результатов проверяет tests/pinyin.parity.test.mjs.

const SYLLABLE_SOURCE = "a ai an ang ao ba bai ban bang bao bei ben beng bi bian biang biao bie bin bing bo bong bu ca cai can cang cao ce cei cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo da dai dan dang dao de dei den deng di dia dian diao die din ding diu dong dou du duan dui dun duo e ei en eng er fa fan fang fei fen feng fiao fo fou fu ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo ha hai han hang hao he hei hen heng hm hng hong hou hu hua huai huan huang hui hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei len leng li lia lian liang liao lie lin ling liu lo long lou lu luan lun luo lü lüe m ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu n na nai nan nang nao ne nei nen neng ng ni nia nian niang niao nie nin ning niu nong nou nu nuan nun nuo nü nüe o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo sa sai san sang sao se sen seng sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ta tai tan tang tao te tei teng ti tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo wong wu xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo";

export const SYLLABLES = new Set(SYLLABLE_SOURCE.split(" "));
const ERHUA = new Set(["r"]);
const SEPARATORS = new Set(["\u2019", "'", "\u00b7", "-", " "]);

const MARKS = { a: "\u0101\u00e1\u01ce\u00e0", e: "\u0113\u00e9\u011b\u00e8", i: "\u012b\u00ed\u01d0\u00ec", o: "\u014d\u00f3\u01d2\u00f2", u: "\u016b\u00fa\u01d4\u00f9", "\u00fc": "\u01d6\u01d8\u01da\u01dc" };
const TONE_MAP = new Map();
const REVERSE = new Map();
for (const [base, row] of Object.entries(MARKS)) {
  [...row].forEach((ch, index) => {
    TONE_MAP.set(ch, [base, index + 1]);
    REVERSE.set(base + (index + 1), ch);
  });
}
for (const [ch, pair] of [["\u0144", ["n", 2]], ["\u0148", ["n", 3]], ["\u01f9", ["n", 4]], ["\u1e3f", ["m", 2]]]) {
  TONE_MAP.set(ch, pair);
  REVERSE.set(pair[0] + pair[1], ch);
}

export const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

export function hanCharacters(word) {
  return [...String(word || "")].filter((ch) => HAN_RE.test(ch));
}

export function stripTones(text) {
  const out = [];
  const tones = [];
  for (const raw of String(text || "").normalize("NFC")) {
    const ch = raw.toLowerCase();
    const hit = TONE_MAP.get(ch);
    if (hit) {
      tones.push([out.length, hit[1]]);
      out.push(hit[0]);
    } else {
      out.push(ch);
    }
  }
  return { toneless: out.join(""), tones };
}

export function normalize(official) {
  const head = String(official || "").split(/[/,;\u3001]/)[0].trim();
  const breaks = new Set();
  const cleaned = [];
  for (const ch of head) {
    if (SEPARATORS.has(ch)) {
      if (cleaned.length) breaks.add(cleaned.length);
    } else {
      cleaned.push(ch);
    }
  }
  const { toneless, tones } = stripTones(cleaned.join(""));
  const latin = toneless.replace(/v/g, "\u00fc");
  const match = latin.match(/^[a-z\u00fc]+/);
  const kept = match ? match[0] : "";
  return {
    toneless: kept,
    tones: tones.filter(([index]) => index < kept.length),
    breaks: new Set([...breaks].filter((b) => b > 0 && b < kept.length)),
  };
}

function segment(toneless, count, breaks, strict) {
  const results = [];
  const length = toneless.length;
  const parts = [];
  const walk = (pos) => {
    if (parts.length === count) {
      if (pos === length) results.push(parts.slice());
      return;
    }
    if (results.length > 40) return;
    const remaining = count - parts.length;
    for (let end = Math.min(length, pos + 7); end > pos; end -= 1) {
      const piece = toneless.slice(pos, end);
      if (length - end < remaining - 1) continue;
      let crosses = false;
      for (const b of breaks) if (b > pos && b < end) { crosses = true; break; }
      if (crosses) continue;
      if (strict && pos > 0 && !breaks.has(pos) && "aeo".includes(piece[0])) continue;
      if (SYLLABLES.has(piece) || ERHUA.has(piece)) {
        parts.push(piece);
        walk(end);
        parts.pop();
      }
    }
  };
  walk(0);
  return results;
}

function reattach(parts, tones) {
  const toneAt = new Map(tones);
  const out = [];
  let cursor = 0;
  for (const part of parts) {
    let built = "";
    for (let i = 0; i < part.length; i += 1) {
      const tone = toneAt.get(cursor + i);
      built += tone ? (REVERSE.get(part[i] + tone) || part[i]) : part[i];
    }
    out.push(built);
    cursor += part.length;
  }
  return out;
}

function longestFirst(candidates) {
  return candidates.reduce((best, current) => {
    for (let i = 0; i < current.length; i += 1) {
      const a = current[i].length;
      const b = best[i].length;
      if (a !== b) return a > b ? current : best;
    }
    return best;
  });
}

/** Возвращает по одному слогу с тонами на каждый иероглиф, либо null. */
export function splitPinyin(word, official) {
  const hans = hanCharacters(word);
  if (!hans.length) return null;
  const { toneless, tones, breaks } = normalize(official);
  if (!/^[a-z\u00fc]+$/.test(toneless)) return null;
  let candidates = segment(toneless, hans.length, breaks, true);
  if (!candidates.length) candidates = segment(toneless, hans.length, breaks, false);
  if (!candidates.length) return null;
  return reattach(candidates.length > 1 ? longestFirst(candidates) : candidates[0], tones);
}

/** Разбор слова: [{ char, pinyin }] — чтение соответствует именно этому слову. */
export function analyseWord(word, official) {
  const hans = hanCharacters(word);
  const parts = splitPinyin(word, official) || [];
  return hans.map((char, index) => ({ char, pinyin: parts[index] || "" }));
}
