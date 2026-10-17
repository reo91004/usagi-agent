// 할 일 편집 — 순수 로직. 낙관적 반영(대기 중인 변경을 서버 목록 위에 겹쳐 보기)과 입력 검증.
import { reorderLocal } from './todo-rows.js';


// 화면에 보이는 우선순위 이름(데이터는 1~4 그대로 — 모델 프롬프트는 P1~P4 로 쓴다)
// hint = 묶음 이름 옆에 보이는 기준 한 줄(데몬의 PRIORITY_DESC 와 같은 뜻)
export const PRIORITIES = [
  { value: 1, label: '오늘 꼭', hint: '오늘 마감이거나 중요한 일' },
  { value: 2, label: '이번 주', hint: '일주일 안에 마감' },
  { value: 3, label: '나중에', hint: '마감이 일주일 넘게 남았거나 날짜가 없는 일' },
  { value: 4, label: '언젠가', hint: '규칙으로 미뤄 둔 일' }, // 기한 없고 안 중요(예전 「백로그」)
];
// 맨 위 묶음: 오늘로 고른 일(우선순위와 별개라 값 0, 끌어 놓을 칸이 아님)
export const TODAY_GROUP = { value: 0, label: '오늘', hint: '내가 오늘 하려고 고른 일' };

const str = (v) => (typeof v === 'string' ? v : '');

// 제목: 공백 정리, 비었으면 null
export function cleanTitle(v) {
  const s = str(v).replace(/\s+/g, ' ').trim();
  return s || null;
}


export function clampPriority(p) {
  const n = Math.round(Number(p));
  return Number.isFinite(n) ? Math.min(4, Math.max(1, n)) : 2;
}

// 새 할 일 입력 → POST /todos 본문. 제목이 없으면 null
export function newTodoBody(title, priority) {
  const t = cleanTitle(title);
  return t ? { title: t, priority: clampPriority(priority) } : null;
}

// 서버 목록(raw todos) 위에 아직 응답 안 온 변경을 겹친다.
// op: { kind: 'add', tempId, body } | { kind: 'edit', id, patch } | { kind: 'remove', id } (remove = 완료·삭제)
//   | { kind: 'reorder', id, priority, beforeId } (끌어서 순서·우선순위)
export function overlayTodos(todos, ops) {
  let out = Array.isArray(todos) ? todos.filter((t) => t && typeof t === 'object') : [];
  for (const op of ops ?? []) {
    if (op.kind === 'add') {
      if (!out.some((t) => t.id === op.tempId)) out = [{ id: op.tempId, source: 'user', priority: 2, ...op.body, userEdited: false, pending: true }, ...out];
    } else if (op.kind === 'edit') {
      // 규칙이 바꾸는 건(op.rule) 사용자 편집 표시를 달지 않는다
      out = out.map((t) => (t.id === op.id ? { ...applyPatch(t, op.patch), userEdited: op.rule ? t.userEdited : true, pending: true } : t));
    } else if (op.kind === 'remove') {
      out = out.filter((t) => t.id !== op.id);
    } else if (op.kind === 'reorder') {
      out = reorderLocal(out, op.id, op.priority, op.beforeId).map((t) => (t.id === op.id ? { ...t, pending: true } : t));
    }
  }
  return out;
}

function applyPatch(t, patch) {
  const next = { ...t };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

// IPC 로 넘어온 값 거르기(메인 프로세스): 아는 키·타입만 남긴다. 쓸 게 없으면 null
export function sanitizeTodoPatch(v, { allowStatus = true } = {}) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  if (typeof v.title === 'string') out.title = v.title;
  if ([1, 2, 3, 4].includes(v.priority)) out.priority = v.priority;
  for (const k of ['link', 'note']) if (v[k] === null || typeof v[k] === 'string') out[k] = v[k] === null ? null : v[k];
  if (v.description === null || typeof v.description === 'string') out.description = v.description === null ? null : v.description;
  if (v.doing === null || typeof v.doing === 'boolean') out.doing = v.doing; // (진행중) 토글: true·false·null(자동)
  if (v.today === null || typeof v.today === 'boolean') out.today = v.today; // 오늘 할 일로 고르기(true)·빼기(false·null)
  if (v.skipped === true) out.skipped = true; // 안 해도 돼서 닫기(status 'done' 과 함께)
  if (allowStatus && (v.status === 'open' || v.status === 'done')) out.status = v.status;
  return Object.keys(out).length ? out : null;
}

// 패널 '최근 완료': 이 창에서 방금 끝낸 것(local) + 서버가 알려준 최근 3일 완료(직접·자동 모두 — 앱을 다시 켜도 남게).
// 같은 id는 하나만(방금 끝낸 것 먼저), 되돌리는 중인 건 뺀다
export function mergeRecentDone(local, server, hidden = [], limit = 8) {
  const hide = new Set(hidden);
  const out = [];
  const seen = new Set();
  for (const t of [...(Array.isArray(local) ? local : []), ...(Array.isArray(server) ? server : [])]) {
    if (!t || typeof t.id !== 'string' || seen.has(t.id) || hide.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out.slice(0, limit);
}

// 설명 직접 고치기(펼친 상세에서 더블클릭) → POST /todos/:id 패치. 안 바뀌면 { patch: null }
export function descriptionPatch(current, draft) {
  const s = String(draft ?? '').replace(/\r\n?/g, '\n').trim();
  const next = s || null;
  return { patch: next === (current || null) ? null : { description: next } };
}

// (진행중)인가: 사용자가 누른 토글(doing)이 먼저, 없으면 비서가 작업 세션에서 본 진척(progress)이 있을 때
export const isDoing = (t) => (t?.doing === true || t?.doing === false ? t.doing : !!t?.progress);

// 대시보드 today(오늘 할 일)를 응답 전에 맞춰 둔다: change 가 null 이면 뺀다, 객체면 있는 줄에 합치고 없으면(제목이 있을 때) 덧붙인다
export function patchToday(today, id, change) {
  if (!today || typeof today !== 'object' || !Array.isArray(today.items)) return today;
  if (change === null) return { ...today, items: today.items.filter((x) => x?.id !== id) };
  if (!change || typeof change !== 'object') return today;
  if (today.items.some((x) => x?.id === id)) return { ...today, items: today.items.map((x) => (x?.id === id ? { ...x, ...change } : x)) };
  return typeof change.title === 'string' && change.title ? { ...today, items: [...today.items, { id, done: false, priority: 2, ...change }] } : today;
}

// 이 줄이 오늘 할 일인가(오늘 날짜로 골랐나)
export const isToday = (t, date) => !!date && t?.today === date;
