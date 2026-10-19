import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { resolveConnectors } from "./connectors.ts";
import { TWO_WAY_LIST, ekToCalEvent, eventkitSource, reminderPriority, reminderTodo, setAppleFlags, syncReminders, type EkRun } from "./eventkit.ts";

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
    id: "reminder:R1", title: "논문 그림 3", source: "reminders", priority: 2, note: "미리알림 「연구」 · 마감 10월 18일 14:00", due: local(18, 14), link: "https://arxiv.org/abs/1",
  });
  assert.equal(reminderTodo({ id: "R2", title: "우유" }, NOW)!.due, null);
  assert.equal(reminderTodo({ id: "R2", title: "우유", list: "장보기" }, NOW)!.note, "미리알림 「장보기」");
  assert.equal(reminderTodo({ id: "R3", title: " " }, NOW), null);
});

test("syncReminders: 마감이 바뀌면 열린 할 일의 due 도 맞춘다", async () => {
  const store = new Store(":memory:");
  const due1 = new Date(2026, 9, 21, 17).toISOString(), due2 = new Date(2026, 9, 25, 9).toISOString();
  const run = (due: string): EkRun => async () => ({ ok: true, open: [{ id: "R9", title: "해지", list: "할 일", due }], completed: [] });
  await syncReminders(store, run(due1), NOW);
  assert.equal(store.getTodo("reminder:R9")!.due, due1);
  await syncReminders(store, run(due2), NOW);
  assert.equal(store.getTodo("reminder:R9")!.due, due2);
  await syncReminders(store, async () => ({ ok: true, open: [{ id: "R9", title: "해지", list: "할 일" }], completed: [] }), NOW); // 미리알림에서 마감을 지움
  assert.equal(store.getTodo("reminder:R9")!.due, undefined);
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

// 가짜 미리알림 앱: reminders(linked 포함)·write 를 흉내 낸다
function fakeReminders(items: Record<string, any> = {}) {
  const state = new Map<string, any>(Object.entries(items).map(([id, x]) => [id, { id, list: "개인", completed: false, ...x }]));
  const calls: string[][] = [];
  let n = 0;
  const run: EkRun = async (args) => {
    calls.push(args);
    if (args[0] === "reminders") {
      const all = [...state.values()];
      return { ok: true, open: all.filter((x) => !x.completed), completed: all.filter((x) => x.completed), linked: args.slice(2).map((id) => state.get(id)).filter(Boolean) };
    }
    const results = (JSON.parse(args[1]) as any[]).map((o) => {
      if (o.op === "add") { const id = `N${++n}`; state.set(id, { id, list: o.list, title: o.title, completed: false, ...(o.due ? { due: o.due } : {}) }); return { ok: true, id }; }
      const x = state.get(o.id);
      if (o.op === "delete") { state.delete(o.id); return { ok: true }; }
      if (!x) return { ok: false, missing: true };
      if (o.title !== undefined) x.title = o.title;
      if (o.done !== undefined) x.completed = o.done;
      return { ok: true };
    });
    return { ok: true, results };
  };
  return { state, calls, run, writes: () => calls.filter((c) => c[0] === "write").map((c) => JSON.parse(c[1])) };
}

test("syncReminders 양방향: 가져온 것은 잇고, 우사기 할 일은 「우사기 비서」에 넣고, 바뀐 게 없으면 쓰지 않는다", async () => {
  const store = new Store(":memory:");
  const f = fakeReminders({ R1: { title: "논문 그림 3" } });
  const mine = store.addTodo({ title: "보고서 쓰기", priority: 1 });
  store.addTodo({ title: "끝낸 일" }); store.editTodo(store.openTodos().find((t) => t.title === "끝낸 일")!.id, { status: "done" });
  const a = await syncReminders(store, f.run, NOW, true);
  assert.deepEqual([a.ok, a.added, a.wrote], [true, 1, 1]);
  assert.deepEqual(f.writes()[0], [{ op: "add", list: TWO_WAY_LIST, title: "보고서 쓰기", priority: 1 }], "열린 우사기 할 일만, 미리알림에서 온 것은 다시 넣지 않는다");
  assert.equal(f.state.get("N1").title, "보고서 쓰기");
  // 두 번째: 이어 둔 id 를 넘겨 지금 모습을 받고, 바뀐 게 없으니 write 는 없다(도우미 한 번)
  f.calls.length = 0;
  const b = await syncReminders(store, f.run, NOW, true);
  assert.deepEqual([b.added, b.wrote], [0, 0]);
  assert.deepEqual(f.calls.map((c) => c[0]), ["reminders"]);
  assert.deepEqual(new Set(f.calls[0].slice(2)), new Set(["R1", "N1"]));
  assert.equal(store.openTodos().filter((t) => t.title === "보고서 쓰기").length, 1, "넣은 미리알림을 다시 할 일로 가져오지 않는다");
  assert.ok(mine);
});

test("syncReminders 양방향: 끝냄·다시 엶·제목·마감·지움이 서로 따라간다", async () => {
  const store = new Store(":memory:");
  const f = fakeReminders({ R1: { title: "논문 그림 3" }, R2: { title: "장보기" } });
  const mine = store.addTodo({ title: "보고서 쓰기" });
  await syncReminders(store, f.run, NOW, true);
  // 우사기에서 끝냄·제목 고침 → 미리알림
  store.editTodo("reminder:R1", { status: "done" });
  store.editTodo(mine.id, { title: "보고서 마감" });
  await syncReminders(store, f.run, NOW, true);
  assert.equal(f.state.get("R1").completed, true);
  assert.equal(f.state.get("N1").title, "보고서 마감");
  // 미리알림에서 다시 엶·제목·마감 → 우사기
  f.state.get("R1").completed = false;
  f.state.get("R2").title = "장보기 (우유)";
  const due = new Date(2026, 9, 21, 9).toISOString();
  f.state.get("N1").due = due;
  await syncReminders(store, f.run, NOW, true);
  assert.equal(store.getTodo("reminder:R1")!.status, "open");
  assert.equal(store.getTodo("reminder:R2")!.title, "장보기 (우유)");
  assert.equal(Date.parse(store.getTodo(mine.id)!.due!), Date.parse(due));
  // 미리알림에서 끝냄 → 우사기도 끝
  f.state.get("N1").completed = true;
  await syncReminders(store, f.run, NOW, true);
  assert.equal(store.getTodo(mine.id)!.status, "done");
  // 우사기에서 지움 → 미리알림도 지움 / 미리알림에서 지움 → 우사기 휴지통
  store.trashTodo("reminder:R1");
  f.state.delete("R2");
  const c = await syncReminders(store, f.run, NOW, true);
  assert.equal(f.state.has("R1"), false);
  assert.equal(c.trashed, 1);
  assert.ok(store.trashedTodo("reminder:R2"));
  assert.equal(store.db.prepare("SELECT count(*) n FROM reminder_links").get()!.n, 1, "남은 짝은 보고서 하나");
});

test("syncReminders 양방향: 한꺼번에 많이 사라지면(iCloud 로그아웃 등) 지우지 않고, id 만 바뀐 같은 미리알림은 다시 잇는다", async () => {
  const store = new Store(":memory:");
  const f = fakeReminders(Object.fromEntries(["A", "B", "C", "D", "E"].map((k) => [k, { title: `일 ${k}` }])));
  await syncReminders(store, f.run, NOW, true);
  const gone = ["A", "B", "C", "D"].map((k) => f.state.get(k));
  for (const k of ["A", "B", "C", "D"]) f.state.delete(k);
  const r = await syncReminders(store, f.run, NOW, true);
  assert.equal(r.trashed, 0);
  assert.equal(store.openTodos().length, 5);
  for (const x of gone) f.state.set(x.id, x); // 다시 로그인
  // E 의 id 가 E2 로 바뀜 → 새 할 일을 만들지 않고 이어 둔다
  f.state.set("E2", { ...f.state.get("E"), id: "E2" }); f.state.delete("E");
  await syncReminders(store, f.run, NOW, true);
  assert.equal(store.openTodos().length, 5);
  assert.equal((store.db.prepare("SELECT rid FROM reminder_links WHERE todo_id = 'reminder:E'").get() as any).rid, "E2");
});

test("syncReminders 양방향: 쓰기가 실패하면 짝을 바꾸지 않고 다음에 다시 한다", async () => {
  const store = new Store(":memory:");
  const f = fakeReminders();
  store.addTodo({ title: "보고서" });
  const fail: EkRun = async (args) => (args[0] === "write" ? { ok: false, error: "not-granted" } : f.run(args));
  const a = await syncReminders(store, fail, NOW, true);
  assert.equal(a.ok, false);
  assert.equal(store.db.prepare("SELECT count(*) n FROM reminder_links").get()!.n, 0);
  await syncReminders(store, f.run, NOW, true);
  assert.equal(f.state.size, 1);
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
  setAppleFlags(p, { reminders: true, twoWay: true });
  assert.equal(JSON.parse(readFileSync(p, "utf8")).remindersTwoWay, true);
  setAppleFlags(p, { reminders: false }); // 미리알림을 빼면 양방향도
  assert.equal(JSON.parse(readFileSync(p, "utf8")).remindersTwoWay, undefined);
  writeFileSync(p, "{ 깨짐");
  assert.throws(() => setAppleFlags(p, { reminders: true }), /그대로/);
});

test("HTTP: /apple/status·connect·disconnect 는 헤더 필수, 몸통은 calendar·reminders·twoWay 참/거짓만", async () => {
  const bus = new Bus();
  const got: unknown[] = [];
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c",
    apple: { status: async () => ({ calendar: "granted" }), connect: (o) => { got.push(["c", o]); return { ok: true, pending: true }; }, disconnect: (o) => { got.push(["d", o]); return { ok: true }; } },
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  try {
    assert.equal((await fetch(`${base}/apple/status`)).status, 403);
    assert.deepEqual(await (await fetch(`${base}/apple/status`, { headers: { "x-cy-agent": "1" } })).json(), { calendar: "granted" });
    assert.equal((await fetch(`${base}/apple/connect`, { method: "POST", body: "{}" })).status, 403);
    await fetch(`${base}/apple/connect`, { method: "POST", headers: { "x-cy-agent": "1", "content-type": "application/json" }, body: JSON.stringify({ calendar: true, reminders: "yes" }) });
    await fetch(`${base}/apple/disconnect`, { method: "POST", headers: { "x-cy-agent": "1", "content-type": "application/json" }, body: JSON.stringify({ reminders: true }) });
    await fetch(`${base}/apple/connect`, { method: "POST", headers: { "x-cy-agent": "1", "content-type": "application/json" }, body: JSON.stringify({ twoWay: true }) });
    assert.deepEqual(got, [["c", { calendar: true, reminders: false, twoWay: false }], ["d", { calendar: false, reminders: true, twoWay: false }], ["c", { calendar: false, reminders: false, twoWay: true }]]);
  } finally {
    bus.close();
  }
});
