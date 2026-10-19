// 이 Mac 의 캘린더·미리알림(EventKit, #53). 앱에 든 Swift 도우미(desktop/native/usagi-eventkit.swift → Resources/bin/usagi-eventkit)를 부른다.
//   캘린더: connectors.calendar 의 local: true → calendar-sync 의 30분 동기화에 원천 하나로(ICS 주소와 합쳐진다)
//   미리알림: config appleReminders → 10분마다 안 끝난 것은 할 일로(reminder:<id>), 미리알림에서 끝낸 것은 할 일도 끝낸다.
//     remindersTwoWay 를 켜면 양방향: 우사기 할 일도 미리알림 「우사기 비서」 목록에 쓰고, 이어 둔 짝(reminder_links)끼리 제목·끝냄·지움을 맞춘다
//   도우미가 맥 안 DB 만 다뤄서 네트워크를 쓰지 않는다. 한 번에 수십 ms(쓸 게 있으면 도우미를 한 번 더 부른다)
import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CalEvent, CalendarSource } from "./calendar-sync.ts";
import type { Store, Todo } from "./store.ts";

export const helperPath = () => process.env.CY_AGENT_EVENTKIT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "usagi-eventkit");
export const eventkitAvailable = () => process.platform === "darwin" && existsSync(helperPath());

export type EkRun = (args: string[], timeoutMs?: number) => Promise<any>;
export const ekRun: EkRun = (args, timeoutMs = 20e3) => new Promise((resolve, reject) => {
  execFile(helperPath(), args, { timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, stdout) => {
    try { resolve(JSON.parse(String(stdout).trim().split("\n").at(-1) || "")); }
    catch { reject(err ?? new Error("EventKit 도우미가 이상한 답을 했어요")); }
  });
});

export type AppleStatus = { available: boolean; calendar: string; reminders: string };
export async function appleStatus(run: EkRun = ekRun): Promise<AppleStatus> {
  if (!eventkitAvailable() && run === ekRun) return { available: false, calendar: "unavailable", reminders: "unavailable" };
  const r = await run(["status"]).catch(() => ({}));
  return { available: true, calendar: String(r.calendar ?? "unknown"), reminders: String(r.reminders ?? "unknown") };
}

// ── 캘린더 ────────────────────────────────────────────────
export function ekToCalEvent(e: any): CalEvent | null {
  if (!e?.id || typeof e.start !== "string" || typeof e.end !== "string") return null;
  const ev: CalEvent = {
    id: `ek:${e.id}`, subject: String(e.title || "(제목 없음)"), start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString(),
    allDay: !!e.allDay, cancelled: !!e.cancelled, showAs: e.free ? "free" : "busy",
    response: typeof e.response === "string" ? e.response : e.organizer ? "organizer" : "none",
    online: typeof e.join === "string" && /^https:\/\//.test(e.join),
  };
  if (ev.online) ev.joinUrl = e.join;
  if (Number.isInteger(e.attendees)) ev.attendees = e.attendees;
  if (typeof e.location === "string" && e.location.trim() && !/^https?:\/\//i.test(e.location.trim())) ev.location = e.location.trim();
  return ev;
}

export function eventkitSource(run: EkRun = ekRun): CalendarSource {
  return async (_cfg, w) => {
    try {
      const r = await run(["events", w.from, w.to]);
      if (!r?.ok) { console.warn(`[calendar] 이 Mac 캘린더: ${r?.error === "not-granted" ? "macOS 권한이 없어요(시스템 설정 → 개인정보 보호 및 보안 → 캘린더)" : r?.error ?? "실패"}`); return { ok: false, events: [], calls: 1, errors: 1, costUsd: 0 }; }
      const seen = new Set<string>();
      const events: CalEvent[] = [];
      for (const e of r.events ?? []) {
        const ev = ekToCalEvent(e);
        const key = `${e.uid ?? e.id}|${ev?.start}`; // 같은 초대가 두 캘린더에 있으면 하나로
        if (ev && !seen.has(key)) { seen.add(key); events.push(ev); }
      }
      return { ok: true, events, calls: 1, errors: 0, costUsd: 0 };
    } catch (e: any) {
      console.warn("[calendar] 이 Mac 캘린더:", String(e?.message ?? e).slice(0, 120));
      return { ok: false, events: [], calls: 1, errors: 1, costUsd: 0 };
    }
  };
}

// ── 미리알림 → 할 일 ──────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, "0");
// 마감이 오늘까지(지난 것 포함)거나 「높음」이면 P1, 7일 안이거나 「보통」이면 P2, 나머지 P3
export function reminderPriority(r: { due?: string; priority?: number }, now = new Date()): number {
  const p = Number(r.priority) || 0; // Apple: 1~4 높음, 5 보통, 6~9 낮음, 0 없음
  const due = r.due ? Date.parse(r.due) : NaN;
  const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  if ((Number.isFinite(due) && due < endToday) || (p >= 1 && p <= 4)) return 1;
  if ((Number.isFinite(due) && due < endToday + 6 * 86400e3) || p === 5) return 2;
  return 3;
}
export function reminderTodo(r: any, now = new Date()): Parameters<Store["upsertTodo"]>[0] | null {
  const title = String(r?.title ?? "").replace(/\s+/g, " ").trim();
  if (!r?.id || !title) return null;
  const d = r.due ? new Date(r.due) : null;
  const due = d && !Number.isNaN(d.getTime()) ? ` · 마감 ${d.getMonth() + 1}월 ${d.getDate()}일${r.dueHasTime ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : ""}` : "";
  return {
    id: `reminder:${r.id}`, title: title.slice(0, 200), source: "reminders", priority: reminderPriority(r, now),
    note: `미리알림 「${String(r.list ?? "").slice(0, 60)}」${due}`,
    due: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null, // 마감을 지운 미리알림은 null 로 지운다
    ...(typeof r.url === "string" && /^https:\/\//.test(r.url) ? { link: r.url } : {}),
  } as Parameters<Store["upsertTodo"]>[0];
}

export type ReminderSync = { added: number; done: number; ok: boolean; error?: string; wrote?: number; trashed?: number };
export const TWO_WAY_LIST = "우사기 비서";
const PUSH_PER_RUN = 100; // 처음 켤 때 할 일이 많아도 도우미 인자 크기·한 번 걸리는 시간을 묶어 둔다(나머지는 다음 번에)
// 양방향 짝: 할 일 ↔ 미리알림 id, 마지막으로 맞춘 제목·끝냄·마감, 우사기가 넣은 미리알림인지(pushed). 지난번과 달라진 쪽을 다른 쪽에 옮긴다
type Link = { todo_id: string; rid: string; title: string; done: number; due: string | null; pushed: number };
const LINKS = "CREATE TABLE IF NOT EXISTS reminder_links (todo_id TEXT PRIMARY KEY, rid TEXT NOT NULL UNIQUE, title TEXT NOT NULL, done INTEGER NOT NULL, due TEXT, pushed INTEGER NOT NULL DEFAULT 0)";
const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
const sameTime = (a?: string | null, b?: string | null) => (a ? Date.parse(a) : NaN) === (b ? Date.parse(b) : NaN) || (!a && !b);
const iso = (s?: string | null) => (s ? new Date(s).toISOString() : null);
// 미리알림 마감 칸: 자정이면 날짜만
const dueOp = (due?: string | null) => { const d = due ? new Date(due) : null; return d ? { due: d.toISOString(), dueHasTime: !!(d.getHours() || d.getMinutes()) } : { due: null }; };

// 한 번 맞추기: 안 끝난 것은 넣고(지운 것·사용자가 고친 우선순위는 store 가 지킨다), 7일 안에 미리알림에서 끝낸 것은 할 일도 끝낸다.
// twoWay 면 그 앞에 이어 둔 짝을 맞추고(제목·끝냄·마감 모두 바뀐 쪽, 양쪽 다 바뀌었으면 우사기 쪽), 뒤에 아직 없는 우사기 할 일을 미리알림에 넣는다.
// 우사기 휴지통에 든 할 일의 미리알림은 끝냄으로만 두고(되살리면 다시 열린다), 영구 삭제되면 우사기가 넣은 것(pushed)만 지운다(사용자가 만든 미리알림은 메모·하위 항목이 있어 남긴다)
export async function syncReminders(store: Store, run: EkRun = ekRun, now = new Date(), twoWay = false): Promise<ReminderSync & { added_: Todo[] }> {
  if (twoWay) store.db.exec(LINKS);
  const links = twoWay ? store.db.prepare("SELECT * FROM reminder_links").all() as Link[] : [];
  const r = await run(["reminders", new Date(now.getTime() - 7 * 86400e3).toISOString(), ...links.map((l) => l.rid)]).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  if (!r?.ok) return { added: 0, done: 0, ok: false, error: r?.error === "not-granted" ? "macOS 미리알림 권한이 없어요" : String(r?.error ?? "실패"), added_: [] };
  if (twoWay && !Array.isArray(r.linked)) return { added: 0, done: 0, ok: false, error: "미리알림 도우미가 양방향을 몰라요(앱을 다시 설치해 주세요)", added_: [] }; // 짝이 모두 사라진 것으로 읽어 지우지 않게
  const linkedRid = new Set(links.map((l) => l.rid)), linkedTodo = new Set(links.map((l) => l.todo_id));
  const saveLink = (todo: string, rid: string, title: string, done: boolean, due: string | null, pushed = false) => {
    store.db.prepare("INSERT OR REPLACE INTO reminder_links (todo_id, rid, title, done, due, pushed) VALUES (?, ?, ?, ?, ?, ?)").run(todo, rid, title, done ? 1 : 0, iso(due), pushed ? 1 : 0);
    linkedRid.add(rid); linkedTodo.add(todo);
  };
  const dropLink = (todo: string) => store.db.prepare("DELETE FROM reminder_links WHERE todo_id = ?").run(todo);
  const ops: Record<string, unknown>[] = [], after: ((res: any) => void)[] = [];
  const op = (o: Record<string, unknown>, then: (res: any) => void) => { ops.push(o); after.push(then); };
  let trashed = 0;

  if (twoWay) {
    const byRid = new Map<string, any>((r.linked ?? []).map((x: any) => [x.id, x]));
    // 끝난 짝이 사라진 것(끝낸 미리알림 정리)은 조용히 놓는다. 열린 짝이 한꺼번에 많이 사라지면(iCloud 로그아웃 등) 지우지 않는다
    const missing = links.filter((l) => !l.done && !byRid.has(l.rid));
    const massMissing = missing.length > 3 && missing.length * 2 > links.filter((l) => !l.done).length;
    for (const l of links) {
      const t = store.getTodo(l.todo_id), x = byRid.get(l.rid);
      if (!x) {
        if (l.done || t?.status === "done") { dropLink(l.todo_id); continue; }
        if (massMissing) continue;
        // id 가 바뀐 같은 미리알림(iCloud 전체 동기화 뒤)이면 다시 잇는다
        const again = t && (r.open ?? []).find((y: any) => !linkedRid.has(y.id) && (norm(y.title) === l.title || norm(y.title) === norm(t.title)));
        if (again) { dropLink(l.todo_id); saveLink(l.todo_id, again.id, l.title, false, l.due, !!l.pushed); continue; }
        dropLink(l.todo_id);
        if (t) { store.trashTodo(t.id, now.toISOString(), "user"); trashed++; } // 미리알림에서 지움 → 휴지통(30일 동안 되살릴 수 있다)
        continue;
      }
      if (!t) {
        if (store.trashedTodo(l.todo_id)) { if (!l.done && !x.completed) op({ op: "set", id: l.rid, done: true }, () => saveLink(l.todo_id, l.rid, l.title, true, l.due, !!l.pushed)); }
        else if (l.pushed) op({ op: "delete", id: l.rid }, () => dropLink(l.todo_id));
        else dropLink(l.todo_id);
        continue;
      }
      const set: Record<string, unknown> = {};
      let title = l.title, done = !!l.done, due = l.due;
      const tt = norm(t.title), rt = norm(x.title), tDone = t.status === "done", rDone = !!x.completed;
      if (tt !== l.title) { if (rt !== tt) set.title = t.title; title = tt; }
      else if (rt && rt !== l.title) { store.editTodo(t.id, { title: rt }); title = rt; }
      if (tDone !== done) { if (rDone !== tDone) set.done = tDone; done = tDone; }
      else if (rDone !== done) { store.editTodo(t.id, { status: rDone ? "done" : "open" }); done = rDone; }
      if (!sameTime(t.due, l.due)) { if (!sameTime(x.due, t.due)) Object.assign(set, dueOp(t.due)); due = t.due ?? null; }
      else if (!sameTime(x.due, l.due)) { store.setTodoDue(t.id, iso(x.due)); due = x.due ?? null; }
      if (Object.keys(set).length) op({ op: "set", id: l.rid, ...set }, () => saveLink(l.todo_id, l.rid, title, done, due, !!l.pushed));
      else if (title !== l.title || done !== !!l.done || !sameTime(due, l.due)) saveLink(l.todo_id, l.rid, title, done, due, !!l.pushed);
    }
  }

  const added: Todo[] = [];
  for (const x of r.open ?? []) {
    if (linkedRid.has(x?.id) || (!twoWay && x?.list === TWO_WAY_LIST)) continue; // 양방향을 끄면 우사기가 넣은 목록은 다시 가져오지 않는다
    const t = reminderTodo(x, now);
    if (!t) continue;
    const res = store.upsertTodo(t, "briefing");
    if (res === "added") { const got = store.getTodo(t.id); if (got) added.push(got); }
    if (!twoWay) continue;
    if (store.getTodo(t.id) && !linkedTodo.has(t.id)) { saveLink(t.id, x.id, norm(x.title), false, iso(x.due)); continue; }
    // 같은 일이 이미 열린 할 일로 있어 합쳐졌으면 그 할 일과 잇는다(안 그러면 그 할 일을 미리알림에 또 넣는다).
    // 스냅숏은 그 할 일 쪽으로 — 다르면 다음 번에 미리알림 쪽 제목·마감을 가져온다(사용자가 쓴 미리알림을 덮지 않게)
    const into = res === "merged" ? store.getTodo(store.findDuplicate(t)?.id ?? "") : undefined;
    if (into && !linkedTodo.has(into.id)) saveLink(into.id, x.id, norm(into.title), into.status === "done", into.due ?? null);
  }
  let done = 0;
  for (const x of r.completed ?? []) {
    if (x?.id && !linkedRid.has(x.id) && store.autoCompleteTodo(`reminder:${x.id}`, { reason: "미리알림에서 끝냄", evidence: { ids: [`reminder:${x.id}`] } })) done++;
  }

  if (twoWay) {
    // 미리알림에서 온 할 일은 다시 넣지 않는다(원래 미리알림이 끝났거나 지워졌으면 중복이 된다)
    for (const t of store.openTodos().filter((t) => t.source !== "reminders" && !linkedTodo.has(t.id)).slice(0, PUSH_PER_RUN)) {
      op({
        op: "add", list: TWO_WAY_LIST, title: t.title, priority: ({ 1: 1, 2: 5, 3: 9 } as Record<number, number>)[t.priority] ?? 0,
        ...(t.due ? dueOp(t.due) : {}),
        ...(t.link?.startsWith("https://") ? { url: t.link } : {}),
      }, (res) => { if (res.id) saveLink(t.id, res.id, norm(t.title), false, t.due ?? null, true); });
    }
  }
  let wrote = 0;
  if (ops.length) {
    const w = await run(["write", JSON.stringify(ops)]).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (!w?.ok) return { added: added.length, done, ok: false, error: `미리알림에 쓰지 못했어요: ${String(w?.error ?? "실패")}`, trashed, added_: added };
    (w.results ?? []).forEach((res: any, i: number) => { if (res?.ok && after[i]) { after[i](res); wrote++; } });
    // 못 쓴 것(읽기 전용 목록 등)은 짝을 그대로 둬서 다음 번에 다시 한다. 하나도 못 썼으면 알린다(데몬은 한 번만 로그)
    const fail = (w.results ?? []).find((res: any) => res && !res.ok && !res.missing);
    if (fail && !wrote) return { added: added.length, done, ok: false, error: `미리알림에 쓰지 못했어요: ${String(fail.error ?? "실패")}`, trashed, added_: added };
  }
  return { added: added.length, done, ok: true, wrote, trashed, added_: added };
}

// config.json 에 켜고 끄기: calendar → connectors.calendar.local(ICS 주소는 그대로), reminders → appleReminders(끄면 양방향도), twoWay → remindersTwoWay.
// 깨진 파일은 건드리지 않는다. 바꿨으면 true
export function setAppleFlags(configPath: string, f: { calendar?: boolean; reminders?: boolean; twoWay?: boolean }): boolean {
  let cfg: any = {};
  try { cfg = JSON.parse(readFileSync(configPath, "utf8")); } catch (e: any) { if (e?.code !== "ENOENT") throw new Error("config.json 을 읽지 못해 그대로 둬요"); }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("config.json 이 { … } 모양이 아니에요");
  const before = JSON.stringify(cfg);
  const next: any = { ...cfg };
  if (f.calendar !== undefined) {
    const conns = next.connectors && typeof next.connectors === "object" ? { ...next.connectors } : {};
    const cal = conns.calendar && typeof conns.calendar === "object" ? { ...conns.calendar } : {};
    const hasIcs = !!(cal.icsUrl || (Array.isArray(cal.icsUrls) && cal.icsUrls.length));
    if (f.calendar) conns.calendar = cal.mode === "api" ? { ...cal, local: true } : { mode: "api", local: true };
    else { const { local: _l, ...rest } = cal; conns.calendar = rest.mode === "api" && !hasIcs ? { mode: "off" } : rest; }
    next.connectors = conns;
  }
  if (f.reminders !== undefined) { if (f.reminders) next.appleReminders = true; else { delete next.appleReminders; delete next.remindersTwoWay; } }
  if (f.twoWay !== undefined) { if (f.twoWay) next.remindersTwoWay = true; else delete next.remindersTwoWay; }
  if (JSON.stringify(next) === before) return false;
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, configPath);
  return true;
}
