import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { resolveConnectors } from "./connectors.ts";
import { ekToCalEvent, eventkitSource, reminderPriority, reminderTodo, setAppleFlags, syncReminders, type EkRun } from "./eventkit.ts";

const NOW = new Date("2026-10-17T03:00:00Z"); // KST 12:00

test("ekToCalEvent·eventkitSource: 응답·주최·회의 링크·참석자, 같은 초대는 하나로, 권한 없으면 ok:false", async () => {
  const e = { id: "E1", uid: "U1", title: "랩 미팅", start: "2026-10-17T05:00:00Z", end: "2026-10-17T06:00:00Z", allDay: false, cancelled: false, free: false, calendar: "Google", location: "공학관 301", join: "https://meet.google.com/abc", attendees: 3, response: "accepted" };
  assert.deepEqual(ekToCalEvent(e), { id: "ek:E1", subject: "랩 미팅", start: "2026-10-17T05:00:00.000Z", end: "2026-10-17T06:00:00.000Z", allDay: false, cancelled: false, showAs: "busy", response: "accepted", online: true, joinUrl: "https://meet.google.com/abc", attendees: 3, location: "공학관 301" });
  assert.equal(ekToCalEvent({ ...e, response: undefined, organizer: true })!.response, "organizer");
  assert.equal(ekToCalEvent({ ...e, join: "javascript:x" })!.online, false);
  const calls: string[][] = [];
  const run: EkRun = async (args) => { calls.push(args); return { ok: true, events: [e, { ...e, id: "E1-copy" }, { ...e, id: "E2", uid: "U2", title: "세미나" }] }; };
  const r = await eventkitSource(run)({} as any, { from: "2026-10-16T15:00:00Z", to: "2026-10-18T15:00:00Z" });
  assert.deepEqual(r.events.map((x) => x.id), ["ek:E1", "ek:E2"]);
  assert.deepEqual(calls[0], ["events", "2026-10-16T15:00:00Z", "2026-10-18T15:00:00Z"]);
  const no = await eventkitSource(async () => ({ ok: false, error: "not-granted" }))({} as any, { from: "a", to: "b" });
  assert.deepEqual([no.ok, no.errors], [false, 1]);
});

test("reminderPriority·reminderTodo: 마감 오늘·지남·높음은 P1, 7일 안·보통은 P2, 나머지 P3, 메모에 목록·마감", () => {
  const local = (d: number, h = 9) => new Date(2026, 9, d, h).toISOString();
  assert.equal(reminderPriority({ due: local(17, 23) }, NOW), 1);
  assert.equal(reminderPriority({ due: local(10) }, NOW), 1); // 지난 마감
  assert.equal(reminderPriority({ priority: 1 }, NOW), 1);
  assert.equal(reminderPriority({ due: local(20) }, NOW), 2);
  assert.equal(reminderPriority({ priority: 5 }, NOW), 2);
  assert.equal(reminderPriority({ due: local(30) }, NOW), 3);
  assert.equal(reminderPriority({ priority: 9 }, NOW), 3);
  assert.deepEqual(reminderTodo({ id: "R1", title: "  논문  그림 3 ", list: "연구", due: local(18, 14), dueHasTime: true, url: "https://arxiv.org/abs/1" }, NOW), {
    id: "reminder:R1", title: "논문 그림 3", source: "reminders", priority: 2, note: "미리알림 「연구」 · 마감 10월 18일 14:00", link: "https://arxiv.org/abs/1",
  });
  assert.equal(reminderTodo({ id: "R2", title: "우유", list: "장보기" }, NOW)!.note, "미리알림 「장보기」");
  assert.equal(reminderTodo({ id: "R3", title: " " }, NOW), null);
});

test("syncReminders: 안 끝난 것은 할 일로(한 번만), 미리알림에서 끝내면 할 일도 끝, 지운 할 일은 되살리지 않고 내가 고친 우선순위는 그대로", async () => {
  const store = new Store(":memory:");
  let state = { open: [{ id: "R1", title: "논문 그림 3", list: "연구" }, { id: "R2", title: "장보기", list: "개인" }], completed: [] as any[] };
  const run: EkRun = async (args) => { assert.equal(args[0], "reminders"); return { ok: true, ...state }; };
  const a = await syncReminders(store, run, NOW);
  assert.deepEqual([a.ok, a.added, a.done], [true, 2, 0]);
  assert.equal(store.getTodo("reminder:R1")!.source, "reminders");
  assert.equal((await syncReminders(store, run, NOW)).added, 0);
  store.editTodo("reminder:R2", { priority: 4 });
  store.trashTodo("reminder:R1");
  state = { open: [{ id: "R1", title: "논문 그림 3", list: "연구" }, { id: "R2", title: "장보기", list: "개인", priority: 1 } as any, { id: "R3", title: "세미나 자료", list: "연구" }], completed: [] };
  const b = await syncReminders(store, run, NOW);
  assert.equal(b.added, 1);
  assert.equal(store.getTodo("reminder:R2")!.priority, 4, "사용자가 고친 우선순위");
  assert.ok(!store.openTodos().some((t) => t.id === "reminder:R1"), "지운 할 일은 되살리지 않는다");
  state = { open: [], completed: [{ id: "R3", completed: true }, { id: "R404", completed: true }] };
  const c = await syncReminders(store, run, NOW);
  assert.equal(c.done, 1);
  assert.equal(store.getTodo("reminder:R3")!.status, "done");
  assert.equal(store.getTodo("reminder:R3")!.doneBy, "auto");
  const no = await syncReminders(store, async () => ({ ok: false, error: "not-granted" }), NOW);
  assert.deepEqual([no.ok, no.error], [false, "macOS 미리알림 권한이 없어요"]);
});

test("setAppleFlags: 캘린더 local·appleReminders 켜고 끄기, ICS 는 그대로, 깨진 파일은 안 건드림", () => {
  const dir = mkdtempSync(join(tmpdir(), "ek-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ user: { name: "용성" } }));
  assert.equal(setAppleFlags(p, { calendar: true, reminders: true }), true);
  const on = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual([on.connectors.calendar, on.appleReminders, on.user.name], [{ mode: "api", local: true }, true, "용성"]);
  assert.deepEqual(resolveConnectors({}, on).calendar, { cap: "calendar", mode: "api", icsUrls: [], timeZone: "Asia/Seoul", local: true });
  assert.equal(setAppleFlags(p, { calendar: true }), false);
  setAppleFlags(p, { calendar: false, reminders: false });
  const off = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual([off.connectors.calendar, off.appleReminders], [{ mode: "off" }, undefined]);
  writeFileSync(p, JSON.stringify({ connectors: { calendar: { mode: "api", icsUrls: ["https://x/a.ics"] } } }));
  setAppleFlags(p, { calendar: true });
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).connectors.calendar, { mode: "api", icsUrls: ["https://x/a.ics"], local: true });
  writeFileSync(p, "{ 깨짐");
  assert.throws(() => setAppleFlags(p, { reminders: true }), /그대로/);
});

test("HTTP: /apple/status·connect·disconnect 는 헤더 필수, 몸통은 calendar·reminders 참/거짓만", async () => {
  const bus = new Bus();
  const got: unknown[] = [];
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [],
    apple: { status: async () => ({ calendar: "granted" }), connect: (o) => { got.push(["c", o]); return { ok: true, pending: true }; }, disconnect: (o) => { got.push(["d", o]); return { ok: true }; } },
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  try {
    assert.equal((await fetch(`${base}/apple/status`)).status, 403);
    assert.deepEqual(await (await fetch(`${base}/apple/status`, { headers: { "x-cy-agent": "1" } })).json(), { calendar: "granted" });
    assert.equal((await fetch(`${base}/apple/connect`, { method: "POST", body: "{}" })).status, 403);
    await fetch(`${base}/apple/connect`, { method: "POST", headers: { "x-cy-agent": "1", "content-type": "application/json" }, body: JSON.stringify({ calendar: true, reminders: "yes" }) });
    await fetch(`${base}/apple/disconnect`, { method: "POST", headers: { "x-cy-agent": "1", "content-type": "application/json" }, body: JSON.stringify({ reminders: true }) });
    assert.deepEqual(got, [["c", { calendar: true, reminders: false }], ["d", { calendar: false, reminders: true }]]);
  } finally {
    bus.close();
  }
});
