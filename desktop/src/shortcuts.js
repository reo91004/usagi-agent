// 앱 단축키(순수 로직): 바꿀 수 있는 명령 · 키 입력 → Electron accelerator · 보일 글 · 저장값 고르기와 검사.
// 모두 앱 메뉴 단축키라 우사기 창이 앞에 있을 때만 동작한다(전역 등록 안 함). 저장은 바꾼 것만 { id: accelerator | '' }, '' 는 끔
import { WIN } from './os-hint.js';

export const SHORTCUTS = [
  { id: 'dashboard', label: '대시보드 열기', def: 'CmdOrCtrl+0' },
  { id: 'newChat', label: '새 대화', def: 'CmdOrCtrl+N' },
  { id: 'session', label: '작업 세션 열기', def: 'CmdOrCtrl+Shift+S' },
  { id: 'help', label: '도움 보내기', def: 'CmdOrCtrl+Shift+D' },
  { id: 'settings', label: '설정 열기', def: 'CmdOrCtrl+,' },
];
// 메뉴 「새 대화」가 패널에 넘기는 대화 id 자리 — 진짜 대화 id 와 겹치지 않는 값
export const NEW_CHAT = ':new';

// 바꿀 수 없는 단축키(편집 메뉴·끄기·가리기·창 닫기·패널 안 이동). 다른 명령에 주지 않는다
const FIXED = ['Q', 'W', 'H', 'Alt+H', 'C', 'V', 'X', 'A', 'Z', 'Shift+Z', 'O', 'Up', 'Down', '1', '2', '3', '4', '5'].map((k) => `CmdOrCtrl+${k}`);
// 설정에 안내로 보이는 것: [키, 키 뒤에 붙는 글, 하는 일]
export const FIXED_HINTS = [
  ['CmdOrCtrl+W', '', '창 닫기'], ['CmdOrCtrl+1', '~5', '사이드바 화면'], ['CmdOrCtrl+Up', '·↓', '이전·다음 대화'],
  ['CmdOrCtrl+Z', '', '지운 할 일 되돌리기'], ['CmdOrCtrl+O', '', '작업 세션에서 원래 화면'], ['Esc', '', '닫기'],
];

const MODS = ['CmdOrCtrl', 'Ctrl', 'Alt', 'Shift'];
const CODE_KEYS = {
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Minus: '-', Equal: '=', Backquote: '`', Space: 'Space', Enter: 'Return', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};
const KEYS = new Set(Object.values(CODE_KEYS));
const isFn = (k) => /^F([1-9]|1[0-9]|2[0-4])$/.test(k);
const isKey = (k) => /^[A-Z0-9]$/.test(k) || isFn(k) || KEYS.has(k);

// 한글 입력 중에도 같은 키가 되게 e.key 대신 e.code(자판 자리)로 본다. 수식 키만 누른 동안은 null
function keyOf(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (isFn(code)) return code;
  return CODE_KEYS[code] ?? null;
}

// KeyboardEvent → 'CmdOrCtrl+Shift+D'. 맥 ⌘ · 윈도우 Ctrl 이 CmdOrCtrl, 맥 ⌃ 는 Ctrl
export function fromEvent(e, win = WIN) {
  const key = keyOf(String(e?.code ?? ''));
  if (!key) return null;
  const on = { CmdOrCtrl: win ? e.ctrlKey : e.metaKey, Ctrl: !win && e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey };
  return [...MODS.filter((m) => on[m]), key].join('+');
}

// 저장값·받은 값을 정해진 순서의 accelerator 로. 모양이 틀리면 null
function canon(acc) {
  if (typeof acc !== 'string' || acc.length > 40) return null;
  const parts = acc.split('+');
  const key = parts.pop();
  if (!isKey(key) || parts.some((m) => !MODS.includes(m)) || new Set(parts).size !== parts.length) return null;
  return [...MODS.filter((m) => parts.includes(m)), key].join('+');
}

// 쓸 수 없으면 그 까닭. ⌘·⌃·⌥ 없이 누르면 입력창 타자를 가로채서 막는다(F 키는 혼자 써도 됨)
export function problem(acc, win = WIN) {
  const c = canon(acc);
  if (!c) return '이 키는 단축키로 쓸 수 없어요';
  const parts = c.split('+');
  if (!isFn(parts.at(-1)) && !parts.some((m) => m === 'CmdOrCtrl' || m === 'Ctrl' || m === 'Alt')) return '⌘·⌃·⌥ 중 하나와 같이 눌러 주세요';
  if (FIXED.includes(c)) return `${label(c, win)} 키는 늘 쓰는 단축키라 못 바꿔요`;
  return null;
}

// 저장값(바꾼 것만) → 명령마다 쓸 accelerator('' = 끔). 틀린 값은 기본값, 앞 명령과 겹치면 끔
export function resolveShortcuts(saved) {
  const out = {};
  const used = new Set();
  for (const s of SHORTCUTS) {
    const v = saved && Object.hasOwn(saved, s.id) ? saved[s.id] : s.def;
    const acc = v === '' ? '' : (canon(v) && !problem(v) ? canon(v) : s.def);
    out[s.id] = acc && !used.has(acc) ? acc : '';
    if (out[s.id]) used.add(out[s.id]);
  }
  return out;
}

// 한 명령의 단축키 바꾸기. value: accelerator · '' 끔 · null 기본값. → { ok, saved } | { ok: false, error }
export function applyShortcut(saved, id, value, win = WIN) {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (!s || !(value === null || typeof value === 'string')) return { ok: false, error: '앱이 이 요청을 받지 않았어요' };
  const acc = value === null ? s.def : value === '' ? '' : canon(value);
  if (acc !== '') {
    const why = problem(acc ?? value, win);
    if (why) return { ok: false, error: why };
    const now = resolveShortcuts(saved);
    const other = SHORTCUTS.find((x) => x.id !== id && now[x.id] === acc);
    if (other) return { ok: false, error: `${label(acc, win)} 키는 「${other.label}」가 쓰고 있어요` };
  }
  const next = { ...(saved && typeof saved === 'object' ? saved : {}) };
  if (acc === s.def) delete next[id];
  else next[id] = acc;
  return { ok: true, saved: next };
}

// 보일 글: 맥 ⌃⌥⇧⌘D · 윈도우 Ctrl+Shift+D. '' 는 없음
const MAC_MODS = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', CmdOrCtrl: '⌘' };
const MAC_KEYS = { Up: '↑', Down: '↓', Left: '←', Right: '→', Return: '↩', Space: 'Space' };
export function label(acc, win = WIN) {
  if (!acc) return '없음';
  const parts = acc.split('+');
  const key = parts.pop();
  if (win) return [...parts.map((m) => (m === 'CmdOrCtrl' ? 'Ctrl' : m)), key].join('+');
  return ['Ctrl', 'Alt', 'Shift', 'CmdOrCtrl'].filter((m) => parts.includes(m)).map((m) => MAC_MODS[m]).join('') + (MAC_KEYS[key] ?? key);
}
