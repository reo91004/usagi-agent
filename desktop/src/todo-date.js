// 할 일 글 속 날짜(「내일 3시」「금요일까지」「10/30」)를 마감으로 읽는다. 순수 로직. 할 일 추가 칸과 제목 고치기가 같이 쓴다.
// 날짜 하나·시각 하나까지 읽고 그 말은 제목에서 뺀다. 날짜는 이 맥 시간대.
const DOW = '일월화수목금토';
const B = '(?<=^|\\s)'; // 앞: 글 처음이나 띄어쓰기
const E = '(?:까지|에)?(?=$|\\s|[,.!?)])'; // 뒤: 조사(까지·에) 하나까지, 그다음 띄어쓰기·끝·문장부호(「오늘의 집」「3시간」은 아님)
const NEAR_DAYS = 62; // 「1/2 컵」「3/4 리뷰」 같은 분수·개수와 헷갈리지 않게, M/D 는 두 달 안이거나 「까지·에」가 붙을 때만

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const ymd = (y, m, d) => { const x = new Date(y, m - 1, d); return x.getMonth() === m - 1 ? x : null; };
const nextMd = (today, m, d) => { const x = ymd(today.getFullYear(), m, d); return x && x < today ? ymd(today.getFullYear() + 1, m, d) : x; }; // 지난 날짜면 내년
const weekOf = (today, weeks, dow) => addDays(today, weeks * 7 - ((today.getDay() + 6) % 7) + ((DOW.indexOf(dow) + 6) % 7)); // 월요일 시작 주

const DATES = [
  [/(다다음|다음|담|이번)\s?주\s?([일월화수목금토])요일/, (m, t) => weekOf(t, { 다다음: 2, 다음: 1, 담: 1, 이번: 0 }[m[1]], m[2])],
  [/([일월화수목금토])요일/, (m, t) => addDays(t, (DOW.indexOf(m[1]) - t.getDay() + 7) % 7)], // 오늘이 그 요일이면 오늘
  [/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/, (m) => ymd(+m[1], +m[2], +m[3])],
  [/(\d{1,2})월\s?(\d{1,2})일/, (m, t) => nextMd(t, +m[1], +m[2])],
  [/(\d{1,2})\/(\d{1,2})/, (m, t) => { const d = nextMd(t, +m[1], +m[2]); return d && (/(까지|에)$/.test(m[0]) || d - t <= NEAR_DAYS * 864e5) ? d : null; }],
  [/(오늘|내일|모레|글피)/, (m, t) => addDays(t, { 오늘: 0, 내일: 1, 모레: 2, 글피: 3 }[m[1]])], // 「낼」은 「세금 낼 것」과 헷갈려 뺌
  [/(\d{1,3})\s?일\s?(?:뒤|후)/, (m, t) => addDays(t, +m[1])],
  [/(일|\d{1,2})\s?주일?\s?(?:뒤|후)/, (m, t) => addDays(t, 7 * (m[1] === '일' ? 1 : +m[1]))],
];

// 오전·오후 없는 1~7시는 오후로 읽는다(「3시 회의」). 12시는 낮 12시, 「밤·저녁 12시」는 그날 끝(23:59)
function hour24(p, h) {
  if (h > 23) return null;
  if (!p) return h >= 1 && h <= 7 ? h + 12 : h;
  if (/오전|아침|새벽/.test(p)) return h === 12 ? 0 : h;
  if (/점심|낮/.test(p)) return h < 6 ? h + 12 : h;
  return h < 12 ? h + 12 : /오후/.test(p) ? 12 : 24; // 오후·저녁·밤
}
const TIMES = [
  [/(?:(오전|오후|아침|점심|낮|저녁|밤|새벽)\s?)?(\d{1,2})시(?:\s?(\d{1,2})분|\s?(반))?/, (m) => { const h = hour24(m[1], +m[2]); return h === 24 ? [23, 59] : [h, m[4] ? 30 : +(m[3] ?? 0)]; }],
  [/(\d{1,2}):(\d{2})/, (m) => [+m[1], +m[2]]],
];

// 목록에서 처음 맞는 것 하나: { value, text, rest(그 말을 뺀 글) } | null
function take(s, list, today) {
  for (const [re, fn] of list) {
    const m = new RegExp(B + re.source + E).exec(s);
    const value = m && fn(m, today);
    if (value && (!Array.isArray(value) || (value[0] !== null && value[0] <= 23 && value[1] <= 59))) {
      return { value, text: m[0], rest: s.slice(0, m.index) + s.slice(m.index + m[0].length) };
    }
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');

// → { due(ISO), title(날짜 말을 뺀 제목), label(「10/27 (화) 15:00」), words(읽은 말) } | null
// 시각만 있으면 오늘 그 시각(이미 지났으면 내일), 날짜만 있으면 그날 0시(날짜만 있는 마감 — dueChip 이 시각을 안 붙인다)
export function parseDue(text, now = new Date()) {
  const src = String(text ?? '');
  const today = addDays(now, 0);
  const date = take(src, DATES, today);
  const time = take(date ? date.rest : src, TIMES, today);
  if (!date && !time) return null;
  let d = date ? date.value : today;
  if (time) {
    const [h, m] = time.value;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (!date && new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m) <= now ? 1 : 0), h, m);
  }
  const title = (time ?? date).rest.replace(/\s+/g, ' ').trim() || src.replace(/\s+/g, ' ').trim();
  const hm = time ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
  return {
    due: d.toISOString(), title,
    label: `${d.getMonth() + 1}/${d.getDate()} (${DOW[d.getDay()]})${hm}`,
    words: [date?.text, time?.text].filter(Boolean).map((w) => w.trim()),
  };
}

// 마감으로 정하는 묶음(데몬 todos.ts duePriority 와 같은 기준): 오늘까지·지난 것 1, 7일 안 2, 그 뒤 3
export function dueBucket(due, now = new Date()) {
  const endToday = addDays(now, 1).getTime();
  const t = Date.parse(due);
  return t < endToday ? 1 : t < endToday + 6 * 86400e3 ? 2 : 3;
}
