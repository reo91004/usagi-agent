// 할 일 편집 입력 검증(버스·채팅·Slack 공용). 순수 함수만.
import type { TodoPatch } from "./store.ts";

export type TodoOp = {
  op: "add" | "edit" | "done" | "skip" | "reopen" | "delete"; // skip = 안 해도 돼서 닫기(상태는 done + 안 함 표시)
  id?: string; title?: string; priority?: number; link?: string | null; note?: string | null;
  description?: string; source_ref?: string; // add 전용: 설명·원본 참조(원문은 데몬이 찾는다)
};
export type NewTodo = { title: string; priority?: number; link?: string | null; note?: string | null; today?: boolean | string };


type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

// http(s)·slack 링크만. 빈 문자열은 지우기(null)
function cleanLink(v: unknown): Result<string | null> {
  if (v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return fail("link must be string or null");
  const s = v.trim();
  if (!s) return { ok: true, value: null };
  if (!/^(https?|slack):\/\/\S+$/i.test(s)) return fail("link must be http(s) or slack url");
  return { ok: true, value: s };
}

function cleanNote(v: unknown): Result<string | null> {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "string") return fail("note must be string or null");
  const s = v.trim();
  return { ok: true, value: s || null };
}

function cleanTitle(v: unknown): Result<string> {
  if (typeof v !== "string") return fail("title must be string");
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return fail("title required");
  return { ok: true, value: s };
}

function cleanPriority(v: unknown): Result<number> {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 4 ? { ok: true, value: v as number } : fail("priority must be 1..4");
}

// POST /todos/:id 본문. 모르는 키는 400
export function parsePatch(body: Record<string, unknown>): Result<TodoPatch> {
  const out: TodoPatch = {};
  for (const k of Object.keys(body)) if (!["title", "priority", "link", "note", "status", "skipped", "description", "doing", "today"].includes(k)) return fail(`unknown field: ${k}`);
  if (body.title !== undefined) { const r = cleanTitle(body.title); if (!r.ok) return r; out.title = r.value; }
  if (body.priority !== undefined) { const r = cleanPriority(body.priority); if (!r.ok) return r; out.priority = r.value; }
  if (body.link !== undefined) { const r = cleanLink(body.link); if (!r.ok) return r; out.link = r.value; }
  if (body.note !== undefined) { const r = cleanNote(body.note); if (!r.ok) return r; out.note = r.value; }
  if (body.description !== undefined) {
    // 설명(패널에서 직접 고침). 빈 값은 지우기(null) — 사용자 편집으로 기억돼서 다시 자동으로 채우지 않는다
    if (body.description !== null && typeof body.description !== "string") return fail("description must be string or null");
    const s = typeof body.description === "string" ? body.description.replace(/\r\n?/g, "\n").trim() : "";
    out.description = s || null;
  }
  if (body.doing !== undefined) {
    if (body.doing !== null && typeof body.doing !== "boolean") return fail("doing must be boolean or null");
    out.doing = body.doing as boolean | null;
  }
  if (body.today !== undefined) {
    // 오늘 할 일로 고르기(true)·빼기(false·null)
    if (body.today !== null && typeof body.today !== "boolean") return fail("today must be boolean or null");
    out.today = body.today === true;
  }
  if (body.skipped !== undefined) {
    if (typeof body.skipped !== "boolean") return fail("skipped must be boolean");
    out.skipped = body.skipped;
  }
  if (body.status !== undefined) {
    if (body.status !== "open" && body.status !== "done") return fail("status must be open or done");
    out.status = body.status;
  }
  return { ok: true, value: out };
}

// POST /todos 본문
export function parseNew(body: Record<string, unknown>): Result<NewTodo> {
  for (const k of Object.keys(body)) if (!["title", "priority", "link", "note", "today"].includes(k)) return fail(`unknown field: ${k}`);
  const p = parsePatch({ ...body, title: body.title ?? "" });
  if (!p.ok) return p;
  return { ok: true, value: { title: p.value.title!, priority: p.value.priority ?? 2, link: p.value.link ?? null, note: p.value.note ?? null, ...(p.value.today ? { today: true } : {}) } };
}

// 모델이 낸 op 한 개 → 패치. 모델은 안 쓰는 필드를 ""로 채우기도 하니 ""는 '안 바꿈', null만 '지우기'
export function opPatch(op: TodoOp): Result<TodoPatch> {
  const body: Record<string, unknown> = {};
  if (op.title) body.title = op.title;
  if (op.priority !== undefined && op.priority !== null) body.priority = op.priority;
  for (const k of ["link", "note"] as const) if (op[k] === null || (typeof op[k] === "string" && op[k] !== "")) body[k] = op[k];
  return parsePatch(body);
}

// 할 일 제목이 캘린더 일정을 그대로 옮긴 것인가(참석만 하는 일정). 공백·기호, 앞의 오늘·내일, 끝의 수업·학원·참석 같은 말을 빼고 비교한다.
// 「… 준비」처럼 할 일이 붙은 제목은 다르다
const eventKey = (s: string) => {
  const k = s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").replace(/^(?:오늘|내일)/u, "");
  return k.replace(/(?:수업|강의|학원|참석|회의|미팅|일정|세미나)+$/u, "") || k;
};
export const sameAsEvent = (title: string, events: string[]) => { const k = eventKey(title); return events.some((e) => eventKey(e) === k); };

// 우선순위 뜻(스키마·프롬프트 공용). 4 = 언젠가·백로그: 기한이 딱히 없고 별로 안 중요한 것
export const PRIORITY_DESC = "1=오늘 꼭, 2=이번 주, 3=나중에(마감이 일주일 넘게 남았거나 날짜 없음), 4=언젠가·백로그(기한 없고 별로 안 중요함)";

// 채팅·DM 구조화 출력의 todo_ops 스키마
export const TODO_OPS_SCHEMA = {
  type: "array",
  description: "사용자가 할 일을 추가·수정·완료·안 해도 돼서 닫기(skip)·되살리기·삭제해 달라고 할 때만. delete는 휴지통으로 옮긴다(패널에서 되살릴 수 있음). id는 '현재 열린 할 일'·'최근 끝낸 할 일' 목록의 id 그대로. 바꿀 필드만 넣는다.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["op"],
    properties: {
      op: { type: "string", enum: ["add", "edit", "done", "skip", "reopen", "delete"] },
      id: { type: "string", description: "add 외에는 필수" },
      title: { type: "string" },
      priority: { type: "integer", minimum: 1, maximum: 4, description: PRIORITY_DESC },
      link: { anyOf: [{ type: "string" }, { type: "null" }], description: "null이면 링크 지우기" },
      note: { anyOf: [{ type: "string" }, { type: "null" }], description: "메모. null이면 지우기" },
      description: { type: "string", description: "add일 때만: 무슨 일인지 한두 문장" },
      source_ref: { type: "string", description: "add일 때만: 원본 참조(slack:<channel>:<ts>, commit:<repo>@<sha>, mail:<id>, session:<id>)" },
    },
  },
} as const;

// 채팅·DM 답에 덧붙일 한 줄: 지우기는 휴지통으로 갔다는 것(답에 이미 '휴지통'이 있으면 생략)
export function trashedNote(titles: string[] | undefined, reply = ""): string {
  if (!titles?.length || reply.includes("휴지통")) return "";
  const names = titles.slice(0, 3).map((t) => `'${t.length > 40 ? `${t.slice(0, 39)}…` : t}'`).join(", ");
  return `🗑 ${names}${titles.length > 3 ? ` 외 ${titles.length - 3}개` : ""} 휴지통으로 옮겼어요`;
}
