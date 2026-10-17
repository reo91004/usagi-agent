// 설정 창 「캐릭터」 편집 — 순수 로직: 대사 칸 묶기·글 ↔ 값·자리표시 검사·고친 칸만 고르기·그림 칸·만들기 본문.
// 칸 목록(schema)·설명(help)·칸 이름(phrases.dance, flair.lead.happy …)은 데몬 GET /characters 가 준다(agent/src/character-store.ts).
import { MEDIA_SLOTS, REQUIRED_SLOTS, MEDIA_EXTS, clipKind } from './character.js';

// 묶음 순서·제목. 설명은 lines.json _help 의 같은 이름 글
export const SECTIONS = [
  ['name', '이름'],
  ['prompt', '말투(AI 프롬프트)'],
  ['flair', '말투 양념'],
  ['phrases', '고정 문구'],
  ['local', 'AI 없이 하는 말'],
  ['cheer', '응원해 줘 칩'],
  ['canned', '패널 정해진 답'],
  ['setup', '초기 설정 화면'],
  ['overlay', '캐릭터가 스스로 하는 짧은 말'],
  ['tour', '사용법 둘러보기'],
];
const FIELD_LABEL = { 'prompt.intro': '첫 문장(누구인지)', 'prompt.tone': '말투 줄(한 줄)', 'prompt.persona': 'AI 탭 말투 글(Gemini·GPT 등)' };
const MOOD_LABEL = { happy: '기쁠 때', excited: '신날 때', calm: '안심할 때', busy: '바쁠 때' };

// schema: [{ path, kind: 'text'|'list', vars, oneLine?, label? }] · help: lines.json _help
export function editorSections(schema, help = {}) {
  const out = SECTIONS.map(([key, title]) => ({ key, title, help: typeof help?.[key] === 'string' ? help[key] : '', fields: [] }));
  for (const d of Array.isArray(schema) ? schema : []) {
    if (!d || typeof d.path !== 'string') continue;
    const sec = out.find((s) => s.key === d.path.split('.')[0]);
    if (sec) sec.fields.push({ ...d, vars: Array.isArray(d.vars) ? d.vars : [], label: fieldLabel(d) });
  }
  return out.filter((s) => s.fields.length);
}
export function fieldLabel(d) {
  if (d.label) return `${d.path.split('.').slice(1).join('.')} · ${d.label}`;
  if (FIELD_LABEL[d.path]) return FIELD_LABEL[d.path];
  const p = d.path.split('.');
  if (p[0] === 'flair') return `${p[1] === 'lead' ? '앞에 붙이는 말' : '뒤에 붙이는 말'} · ${MOOD_LABEL[p[2]] ?? p[2]}`;
  return p.length > 1 ? p.slice(1).join('.') : '';
}

// 중첩 대사 ↔ { 칸 이름: 값 } (데몬 flattenLines·unflattenLines 와 같다)
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export function flattenLines(e) {
  const out = {};
  const walk = (v, path, depth) => {
    if (typeof v === 'string' || Array.isArray(v)) { if (path) out[path] = v; return; }
    if (!isObj(v)) return;
    if (depth >= (path.startsWith('flair') || path === '' ? 3 : 2)) return;
    for (const [k, x] of Object.entries(v)) if (!['__proto__', 'constructor', 'prototype'].includes(k)) walk(x, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(e, '', 0);
  return out;
}
export function unflattenLines(flat) {
  const out = {};
  for (const [path, v] of Object.entries(flat)) {
    const parts = path.split('.');
    let o = out;
    for (const p of parts.slice(0, -1)) o = o[p] ??= {};
    o[parts.at(-1)] = v;
  }
  return out;
}

// 화면 글: 글 칸은 그대로(줄바꿈 그대로), 줄 칸은 한 줄에 하나 — 한 줄 안의 줄바꿈은 \n 두 글자로
export function fieldText(d, v) {
  if (d.kind === 'list') return (Array.isArray(v) ? v : []).map((x) => String(x).replace(/\n/g, '\\n')).join('\n');
  return typeof v === 'string' ? v : '';
}
export function fieldValue(d, text) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n');
  if (d.kind === 'list') {
    const keep = d.path.startsWith('flair.'); // 「우와, 」끝 빈칸은 뜻이 있다
    return t.split('\n').filter((l) => l.trim()).map((l) => (keep ? l : l.trim()).replace(/\\n/g, '\n'));
  }
  return d.oneLine ? t.replace(/\s+/g, ' ').trim() : t;
}
const isEmpty = (v) => (Array.isArray(v) ? !v.length : !String(v ?? '').trim());

// 저장 전 검사(데몬도 다시 본다): 모르는 자리표시 → 이유, 괜찮으면 ''
export function fieldProblem(d, text) {
  const v = fieldValue(d, text);
  const vars = d.vars ?? [];
  const found = [...new Set((Array.isArray(v) ? v : [v]).flatMap((x) => [...String(x).matchAll(/\{([^{}\s]*)\}/g)].map((m) => m[1])))];
  const bad = found.filter((x) => !vars.includes(x));
  if (bad.length) return `모르는 자리표시 ${bad.map((x) => `{${x}}`).join(' ')}${vars.length ? ` · 쓸 수 있는 것: ${vars.map((x) => `{${x}}`).join(' ')}` : ' · 이 칸은 자리표시를 못 써요'}`;
  return '';
}

// 화면 글 모음 { 칸: 글 } → 대사(빈 칸은 빠진다 — 기본값·시사 말이 받는다)
export function linesFromTexts(fields, texts) {
  const flat = {};
  for (const d of fields) {
    if (!Object.hasOwn(texts, d.path)) continue;
    const v = fieldValue(d, texts[d.path]);
    if (!isEmpty(v)) flat[d.path] = v;
  }
  return unflattenLines(flat);
}
// 기본값과 다른 칸만(기본 캐릭터 덮어쓰기)
export function diffLines(base, edited) {
  const a = flattenLines(base), b = flattenLines(edited);
  const out = {};
  for (const [p, v] of Object.entries(b)) if (JSON.stringify(a[p]) !== JSON.stringify(v)) out[p] = v;
  return unflattenLines(out);
}

// ---- 그림 칸 ----
const SLOT_LABEL = { eyes_open: '눈 뜬 모습', eyes_closed: '눈 감은 모습', cheer: '응원', dance: '춤', study: '집중', plan: '일정 알림' };
const SLOT_HINT = {
  eyes_open: '평소 모습. 정사각형이 아니어도 돼요',
  eyes_closed: '깜빡일 때 잠깐 보여요. 없으면 깜빡이지 않아요',
  cheer: '「응원해 줘」 때. 없으면 춤을 써요',
  dance: '「춤춰 줘」 때. 없으면 응원을 써요',
  study: '집중하기·작업 중일 때. 없으면 평소 모습 그대로',
  plan: '일정 몇 분 전 알림 때. 없으면 춤을 써요',
};
export const ACCEPT = MEDIA_EXTS.map((x) => `.${x}`).join(',');
export function slotRows(media = {}) {
  return MEDIA_SLOTS.map((slot) => ({ slot, label: SLOT_LABEL[slot], hint: SLOT_HINT[slot], required: REQUIRED_SLOTS.includes(slot), file: typeof media?.[slot] === 'string' ? media[slot] : null }));
}
// 고른 파일 이름이 받는 종류인가(내용은 데몬이 다시 본다)
export const okMediaName = (name) => MEDIA_EXTS.includes(String(name ?? '').toLowerCase().split('.').pop() ?? '') && /\./.test(String(name ?? ''));
export const previewKind = (name) => clipKind(name);
// 만들 때 꼭 넣을 것 중 빠진 것(라벨)
export function missingRequired(chosen) {
  return REQUIRED_SLOTS.filter((s) => !chosen?.[s]).map((s) => SLOT_LABEL[s]);
}

// 「말투 가져오기」 고를 것: 기본 다섯 + 만든 캐릭터
export function sourceOptions(list) {
  return (Array.isArray(list) ? list : []).filter((c) => c && typeof c.id === 'string').map((c) => ({ id: c.id, name: c.name ?? c.id, custom: !!c.custom }));
}
