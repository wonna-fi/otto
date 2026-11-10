// Listening check: compare what an independent transcription heard in a narration clip with what the voice was
// meant to say. Numbers get special care, because that is where voices go wrong:
//  - the transcriber writes a number in words: it must match the intended words exactly, case ending included
//    ("kahdeksantoista tuhannen" vs a wrong "kahdeksantoista tuhatta");
//  - the transcriber writes digits: it can't show the case, so the values must match (catches fifteen read as fifty).

type Tok = { word: string; value?: number; digits?: boolean };

// Finnish numeral morphemes, longest first so "kahdeksa" (8) wins over "kahde" (2). Case endings sit between them.
const FI: Array<[RegExp, (s: State) => void]> = [
  [/^miljoon/, (s) => { s.total += (s.group || 1) * 1e6; s.group = 0; s.last = 0; }],
  [/^tuha/, (s) => { s.total += (s.group || 1) * 1000; s.group = 0; s.last = 0; }],
  [/^sa[dt]/, (s) => { s.group = (s.group || 1) * 100; s.last = 0; }],
  [/^kymmen/, (s) => { if (s.last) { s.group += s.last * 9; s.last = 0; } else s.group += 10; }],
  [/^toist/, (s) => { s.group += 10; s.last = 0; }],
  [/^kahdeksa/, (s) => unit(s, 8)], [/^yhdeksä/, (s) => unit(s, 9)], [/^seitsemä/, (s) => unit(s, 7)],
  [/^(kaksi|kahde|kaht)/, (s) => unit(s, 2)], [/^(yksi|yhde|yhte|yht)/, (s) => unit(s, 1)],
  [/^(kolme|kolm)/, (s) => unit(s, 3)], [/^nelj/, (s) => unit(s, 4)],
  [/^(viisi|viide|viit)/, (s) => unit(s, 5)], [/^(kuusi|kuude|kuut)/, (s) => unit(s, 6)],
];
type State = { total: number; group: number; last: number };
// What may follow a numeral stem: a linking vowel, a stem consonant (tuhaNNen, tuhaNTeen, tuhaNSIa, tuhaTTa) and a
// case ending. Anything else is another word that only starts like a numeral ("yhteenveto", "yhteensä", "satama").
const FI_ENDING = /^[aeiouyäö]{0,2}(?:nn|nt|nsi|tt|n|t)?[aeiouyäö]{0,2}(?:ksi|ss[aä]|st[aä]|ll[aä]|lt[aä]|lle|[nj][aä]|n|t)?$/;
function unit(s: State, n: number) { s.group += n; s.last = n; }

/** Value of one Finnish numeral word in any case ("kolmeenkymmeneenviiteen" -> 35), or null. */
export function fiNumber(word: string): number | null {
  const s: State = { total: 0, group: 0, last: 0 };
  let rest = word.toLowerCase();
  let matched = false;
  while (rest) {
    const m = FI.find(([re]) => re.test(rest));
    if (!m) {
      // Case endings between morphemes: a few letters, then the next morpheme (or the end of the word).
      const next = rest.slice(1).search(/miljoon|tuha|sa[dt]|kymmen|toist|kahdeksa|yhdeksä|seitsemä|kaksi|kahde|kaht|yksi|yhde|yht|kolm|nelj|viisi|viide|viit|kuusi|kuude|kuut/);
      const ending = next < 0 ? rest : rest.slice(0, next + 1);
      if (!matched || !FI_ENDING.test(ending)) return null;
      rest = rest.slice(ending.length);
      continue;
    }
    const len = rest.match(m[0])![0].length;
    m[1](s);
    matched = true;
    rest = rest.slice(len);
  }
  return matched ? s.total + s.group : null;
}

const EN_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function enNumber(word: string): { value: number; scale?: number } | null {
  const w = word.toLowerCase();
  if (w in EN_UNITS) return { value: EN_UNITS[w] };
  if (w === 'hundred') return { value: 0, scale: 100 };
  if (w === 'thousand') return { value: 0, scale: 1000 };
  if (w === 'million') return { value: 0, scale: 1e6 };
  const parts = w.split('-');
  if (parts.length === 2 && parts.every((p) => p in EN_UNITS)) return { value: EN_UNITS[parts[0]] + EN_UNITS[parts[1]] };
  return null;
}

/** Words, with each run of number words or a digit group collapsed into one token carrying its value. */
export function tokens(text: string, lang: 'fi' | 'en'): Tok[] {
  // Number words never run across a full stop or comma ("kriteeri kolme. Yhteenveto…").
  const parts = text.split(/[.,;:!?]+(?=\s|$)/);
  if (parts.length > 1) return parts.flatMap((p) => tokens(p, lang));
  const words = text
    .normalize('NFC')
    .replace(/(\d)[\s  ](?=\d{3}\b)/g, '$1') // 15 000 -> 15000
    .replace(/(\p{L})-?(?=\d)/gu, '$1 ') // TASK-7 and AB101 -> TASK 7, AB 101: the number in a code is a number
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .replace(/(^|\s)-+|-+(?=\s|$)/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const out: Tok[] = [];
  // spelled: a number said digit by digit ("one oh one" is 101, not 2).
  let run: { words: string[]; total: number; group: number; spelled: string | null } | null = null;
  const flush = () => {
    if (run) {
      const byDigit = run.spelled && run.spelled.length > 1;
      out.push(byDigit ? { word: run.words.join(''), value: Number(run.spelled), digits: true } : { word: run.words.join(''), value: run.total + run.group });
    }
    run = null;
  };
  for (const w of words) {
    if (/^\d+$/.test(w)) {
      flush();
      out.push({ word: w, value: Number(w), digits: true });
      continue;
    }
    if (lang === 'fi') {
      const v = w === 'ja' && run ? null : fiNumber(w);
      if (v != null) {
        run ??= { words: [], total: 0, group: 0, spelled: null };
        run.words.push(w);
        // "kolmeenkymmeneen viiteen tuhanteen": 30, 5, then x1000 for the run so far.
        if (/^tuha/.test(w) && v === 1000) { run.total += (run.group || 1) * 1000; run.group = 0; }
        else if (v >= 1000) { run.total += v; }
        else run.group += v;
        continue;
      }
    } else {
      const n = enNumber(w) ?? (run && (w === 'oh' || w === 'o') ? { value: 0 } : null);
      if (n) {
        run ??= { words: [], total: 0, group: 0, spelled: '' };
        run.words.push(w);
        run.spelled = !n.scale && n.value < 10 && run.spelled != null ? run.spelled + n.value : null;
        if (n.scale === 100) run.group = (run.group || 1) * 100;
        else if (n.scale) { run.total += (run.group || 1) * n.scale; run.group = 0; }
        else run.group += n.value;
        continue;
      }
      if (w === 'and' && run) continue; // "one hundred and five"
    }
    flush();
    out.push({ word: w });
  }
  flush();
  return out;
}

function same(a: Tok, b: Tok) {
  if (a.value != null && b.value != null) {
    // Either side in digits: only the value can be compared. Both in words: the exact form must match.
    if (a.digits || b.digits) return a.value === b.value;
    return a.word === b.word;
  }
  return a.word === b.word;
}

/** 0..1: how closely the heard text matches the intended text (token edit distance, number-aware). */
export function heardMatch(intended: string, heard: string, lang: 'fi' | 'en'): number {
  const x = tokens(intended, lang), y = tokens(heard, lang);
  if (!x.length && !y.length) return 1;
  const d: number[] = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (same(x[i - 1], y[j - 1]) ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - d[y.length] / Math.max(x.length, y.length);
}

/** caseUnchecked: Finnish numbers the transcriber wrote as digits. Their value was checked, but digits carry no case. */
export type HeardCheck = { ok: boolean; score: number; numbersOk: boolean; problems: string[]; caseUnchecked: string[] };

/**
 * Strict on numbers, tolerant on other words: every number the voice was given must be heard (exact form when the
 * transcriber wrote words, same value when it wrote digits), and the rest must broadly match (transcribers mishear
 * ordinary words now and then).
 */
export function checkHeard(intended: string, heard: string, lang: 'fi' | 'en'): HeardCheck {
  const want = tokens(intended, lang).filter((t) => t.value != null);
  const got = tokens(heard, lang).filter((t) => t.value != null);
  const problems: string[] = [];
  const pool = [...got];
  const caseUnchecked: string[] = [];
  for (const w of want) {
    const i = pool.findIndex((g) => same(w, g));
    if (i >= 0) {
      if (lang === 'fi' && !w.digits && pool[i].digits) caseUnchecked.push(w.word);
      pool.splice(i, 1);
    } else problems.push(`"${w.word}" (${w.value}) not heard${got.length ? `; heard ${got.map((g) => `"${g.word}"`).join(', ')}` : ''}`);
  }
  if (!problems.length) for (const g of pool) problems.push(`extra number heard: "${g.word}" (${g.value})`);
  // English names kept as they are on screen (letters Finnish spelling doesn't use) must be heard as written.
  // In Finnish mode the transcriber keeps English spelling for English speech, so a Finnish spelling of an English label
  // means the voice Finnicized it (it does when a Finnish ending is attached: "Customs-vaihe").
  if (lang === 'fi') {
    const heardLower = heard.toLowerCase();
    for (const w of new Set(intended.match(/[\p{L}]*[cqwxzCQWXZ][\p{L}]*/gu) ?? [])) {
      if (!heardLower.includes(w.toLowerCase())) problems.push(`"${w}" not heard as written (keep it in its original language)`);
    }
  }
  const score = heardMatch(intended, heard, lang);
  if (score < 0.7) problems.push(`words differ (${Math.round(score * 100)}% match)`);
  return { ok: problems.length === 0, score, numbersOk: problems.every((p) => !p.includes('heard')), problems, caseUnchecked };
}
