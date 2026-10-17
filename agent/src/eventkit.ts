// 이 Mac 의 캘린더·미리알림(EventKit, #53). 앱에 든 Swift 도우미(desktop/native/usagi-eventkit.swift → Resources/bin/usagi-eventkit)를 부른다.
//   캘린더: connectors.calendar 의 local: true → calendar-sync 의 30분 동기화에 원천 하나로(ICS 주소와 합쳐진다)
//   미리알림: config appleReminders → 10분마다 안 끝난 것은 할 일로(reminder:<id>), 미리알림에서 끝낸 것은 할 일도 끝낸다(읽기 전용, 되쓰지 않음)
//   도우미가 맥 안 DB 를 읽기만 해서 네트워크를 쓰지 않는다. 한 번에 수십 ms
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
    ...(typeof r.url === "string" && /^https:\/\//.test(r.url) ? { link: r.url } : {}),
  } as Parameters<Store["upsertTodo"]>[0];
}

export type ReminderSync = { added: number; done: number; ok: boolean; error?: string };
// 한 번 맞추기: 안 끝난 것은 넣고(지운 것·사용자가 고친 우선순위는 store 가 지킨다), 7일 안에 미리알림에서 끝낸 것은 할 일도 끝낸다
export async function syncReminders(store: Store, run: EkRun = ekRun, now = new Date()): Promise<ReminderSync & { added_: Todo[] }> {
  const r = await run(["reminders", new Date(now.getTime() - 7 * 86400e3).toISOString()]).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  if (!r?.ok) return { added: 0, done: 0, ok: false, error: r?.error === "not-granted" ? "macOS 미리알림 권한이 없어요" : String(r?.error ?? "실패"), added_: [] };
  const added: Todo[] = [];
  for (const x of r.open ?? []) {
    const t = reminderTodo(x, now);
    if (t && store.upsertTodo(t, "briefing") === "added") { const got = store.getTodo(t.id); if (got) added.push(got); }
  }
  let done = 0;
  for (const x of r.completed ?? []) {
    if (x?.id && store.autoCompleteTodo(`reminder:${x.id}`, { reason: "미리알림에서 끝냄", evidence: { ids: [`reminder:${x.id}`] } })) done++;
  }
  return { added: added.length, done, ok: true, added_: added };
}

// config.json 에 켜고 끄기: calendar → connectors.calendar.local(ICS 주소는 그대로), reminders → appleReminders. 깨진 파일은 건드리지 않는다. 바꿨으면 true
export function setAppleFlags(configPath: string, f: { calendar?: boolean; reminders?: boolean }): boolean {
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
  if (f.reminders !== undefined) { if (f.reminders) next.appleReminders = true; else delete next.appleReminders; }
  if (JSON.stringify(next) === before) return false;
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, configPath);
  return true;
}
