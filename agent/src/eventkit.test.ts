import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { resolveConnectors } from "./connectors.ts";
import { IMPORTANT_CAL, TWO_WAY_LIST, addReminderTodo, ekToCalEvent, eventkitSource, importantEvents, pushDone, reminderPriority, reminderTodo, setAppleFlags, syncReminders, urgentReminders, watchStore, type EkRun } from "./eventkit.ts";

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

test("importantEvents: 「중요」 캘린더만, 되풀이는 가장 가까운 한 번, 취소·끝난 것 빼고, 오늘 0시~1년을 묻고, 실패면 null", async () => {
  const ev = (id: string, start: string, end: string, more: Record<string, unknown> = {}) => ({ id, uid: `U-${id}`, title: id, start, end, allDay: false, cancelled: false, calendar: "중요 일정", ...more });
  const calls: string[][] = [];
  const run: EkRun = async (args) => {
    calls.push(args);
    return { ok: true, events: [
      ev("발표", "2026-10-30T05:00:00Z", "2026-10-30T06:00:00Z"),
      ev("생일", "2027-03-01T15:00:00Z", "2027-03-02T15:00:00Z", { uid: "BD", allDay: true }),
      ev("생일", "2026-11-01T15:00:00Z", "2026-11-02T15:00:00Z", { uid: "BD", allDay: true }), // 같은 되풀이 일정의 더 가까운 회차
      ev("취소", "2026-10-20T05:00:00Z", "2026-10-20T06:00:00Z", { cancelled: true }),
      ev("지남", "2026-10-17T00:00:00Z", "2026-10-17T01:00:00Z"),
      ev("랩 미팅", "2026-10-21T05:00:00Z", "2026-10-21T06:00:00Z", { calendar: "연구실" }), // 옛 도우미(이름 인자를 모름)가 준 다른 캘린더
    ] };
  };
  const got = await importantEvents(run, NOW);
  assert.deepEqual(got!.map((e) => [e.title, e.start, e.allDay]), [["발표", "2026-10-30T05:00:00.000Z", false], ["생일", "2026-11-01T15:00:00.000Z", true]]);
  assert.equal(got![0].id, "ek:발표");
  const [cmd, from, to, name] = calls[0];
  assert.deepEqual([cmd, name], ["events", IMPORTANT_CAL]);
  assert.equal(new Date(from).getTime(), new Date(2026, 9, 17).getTime()); // 이 맥의 오늘 0시
  assert.equal(new Date(to).getTime(), new Date(2027, 9, 17).getTime());
  await importantEvents(run, NOW, 30);
  assert.equal(new Date(calls[1][2]).getTime(), new Date(2026, 10, 16).getTime(), "범위(30일)");
  assert.equal(await importantEvents(async () => ({ ok: false, error: "not-granted" }), NOW), null);
  assert.equal(await importantEvents(async () => { throw new Error("x"); }, NOW), null);
});

test("urgentReminders·syncReminders: 우선순위 높음(1~4)이나 목록·제목의 「긴급」, 우사기 목록은 뺀다", async () => {
  const open = [
    { id: "A", title: "보고서", list: "연구", priority: 1 },
    { id: "B", title: "서버 연장 긴급", list: "할 일", priority: 0 },
    { id: "C", title: "장보기", list: "긴급", priority: 9 },
    { id: "D", title: "우유", list: "장보기", priority: 5 },
    { id: "E", title: "할 일 P1", list: TWO_WAY_LIST, priority: 1 },
  ];
  const want = [{ id: "reminder:A", list: "연구", high: true }, { id: "reminder:B", list: "할 일", high: false }, { id: "reminder:C", list: "긴급", high: false }];
  assert.deepEqual(urgentReminders(open), want);
  const r = await syncReminders(new Store(":memory:"), async () => ({ ok: true, open, completed: [] }), NOW);
  assert.deepEqual(r.urgent, want);
});

test("reminderPriority·reminderTodo: 날짜가 있으면 날짜로(오늘·지남 P1, 7일 안 P2), 없으면 높음·보통 P2, 나머지 P3, 메모에 목록·마감", () => {
  const local = (d: number, h = 9) => new Date(2026, 9, d, h).toISOString();
  assert.equal(reminderPriority({ due: local(17, 23) }, NOW), 1);
  assert.equal(reminderPriority({ due: local(10) }, NOW), 1); // 지난 마감
  assert.equal(reminderPriority({ priority: 1 }, NOW), 2);
  assert.equal(reminderPriority({ priority: 1, due: local(30) }, NOW), 3); // 오늘 넣은 「높음」 미리알림이라도 마감이 먼 날이면 「오늘 꼭」이 아니다
  assert.equal(reminderPriority({ priority: 1, due: local(17, 18) }, NOW), 1);
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

test("syncReminders: 미리알림에서 고친 제목·마감이 메모까지 따라가고 패널에 알린다(edited), 내가 고친 제목·규칙 메모는 그대로", async () => {
  const store = new Store(":memory:");
  const due1 = new Date(2026, 9, 19, 14).toISOString(), due2 = new Date(2026, 9, 20, 14).toISOString();
  const run = (title: string, due: string): EkRun => async () => ({ ok: true, open: [{ id: "R7", title, list: "공부", due, dueHasTime: true }, { id: "R8", title: "세미나", list: "공부" }], completed: [] });
  await syncReminders(store, run("Asiacrypt 등록", due1), NOW);
  assert.equal((await syncReminders(store, run("Asiacrypt 등록", due1), NOW)).edited, 0, "바뀐 게 없으면 패널을 건드리지 않는다");
  const a = await syncReminders(store, run("Asiacrypt 참가 등록", due2), NOW);
  assert.equal(a.edited, 1);
  const t = store.getTodo("reminder:R7")!;
  assert.deepEqual([t.title, t.due, t.note, t.priority], ["Asiacrypt 참가 등록", due2, "미리알림 「공부」 · 마감 10월 20일 14:00", 2]);
  store.editTodo("reminder:R7", { title: "등록(내 제목)" });
  store.ruleUpdateTodo("reminder:R8", { note: "미리알림 「공부」 · 발표 준비" }); // 할 일 규칙이 덧붙인 메모
  await syncReminders(store, async () => ({ ok: true, open: [{ id: "R7", title: "또 바꾼 제목", list: "공부", due: due1, dueHasTime: true }, { id: "R8", title: "세미나", list: "연구" }], completed: [] }), NOW);
  assert.deepEqual([store.getTodo("reminder:R7")!.title, store.getTodo("reminder:R7")!.note], ["등록(내 제목)", "미리알림 「공부」 · 마감 10월 19일 14:00"]);
  assert.equal(store.getTodo("reminder:R8")!.note, "미리알림 「연구」 · 발표 준비");
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
// 진짜 도우미처럼 set 결과에 저장한 뒤 모습을 준다. repeats: 끝내면 원본은 열린 채 마감이 하루 뒤로, 끝낸 사본은 새 id(2026-10-20 실측)
const LIST_TITLES: Record<string, string> = { L1: "공부" }; // 사용자가 고른 목록(id)의 이름
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
      if (o.op === "add") { const id = `N${++n}`; state.set(id, { id, list: o.list ?? LIST_TITLES[o.listId], title: o.title, completed: false, ...(o.due ? { due: o.due, dueHasTime: !!o.dueHasTime } : {}) }); return { ok: true, ...state.get(id) }; } // 진짜 도우미처럼 저장한 모습까지
      const x = state.get(o.id);
      if (o.op === "delete") { state.delete(o.id); return { ok: true }; }
      if (!x) return { ok: false, missing: true };
      if (o.title !== undefined) x.title = o.title;
      if (o.done !== undefined) x.completed = o.done;
      if ("due" in o) { if (o.due) x.due = o.due; else delete x.due; }
      if (x.repeats && x.completed) {
        const { repeats: _r, ...copy } = x, id = `C${++n}`;
        state.set(id, { ...copy, id, completedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") });
        Object.assign(x, { completed: false, due: new Date(Date.parse(x.due) + 864e5).toISOString() });
      }
      return { ok: true, ...x };
    });
    return { ok: true, results };
  };
  return { state, calls, run, writes: () => calls.filter((c) => c[0] === "write").map((c) => JSON.parse(c[1])) };
}

test("syncReminders 한 방향: 미리알림에서 지운 것은 휴지통으로, 되살린 것·id 만 바뀐 것·한꺼번에 많이 사라진 것·옛 도우미면 그대로", async () => {
  const store = new Store(":memory:");
  const f = fakeReminders({ R1: { title: "논문" }, R2: { title: "장보기" } });
  assert.equal((await syncReminders(store, f.run, NOW)).added, 2);
  store.setTodoStatus("reminder:R2", "done");
  assert.deepEqual(f.calls.at(-1)!.slice(2), []);
  await syncReminders(store, f.run, NOW);
  assert.deepEqual(f.calls.at(-1)!.slice(2), ["R1"], "열린 미리알림 할 일의 id 만 넘긴다");
  f.state.delete("R1"); f.state.delete("R2");
  const r = await syncReminders(store, f.run, NOW);
  assert.equal(r.trashed, 1);
  assert.ok(store.trashedTodo("reminder:R1"));
  assert.equal(store.getTodo("reminder:R2")!.status, "done", "끝낸 할 일은 그대로");
  store.restoreTodo("reminder:R1");
  assert.equal((await syncReminders(store, f.run, NOW)).trashed, 0);
  assert.equal(store.getTodo("reminder:R1")!.status, "open", "되살린 것은 다시 버리지 않는다");
  // id 만 바뀐 같은 미리알림(iCloud 전체 동기화 뒤) → 버리지 않고 새 id 가 그 할 일로 합쳐진다
  f.state.set("R3", { id: "R3", title: "세미나", list: "개인", completed: false });
  await syncReminders(store, f.run, NOW);
  f.state.set("R4", { ...f.state.get("R3"), id: "R4" }); f.state.delete("R3");
  assert.equal((await syncReminders(store, f.run, NOW)).trashed, 0);
  assert.equal(store.getTodo("reminder:R3")!.status, "open");
  assert.equal(store.getTodo("reminder:R4"), undefined);

  const many = new Store(":memory:");
  const g = fakeReminders(Object.fromEntries(["A", "B", "C", "D", "E"].map((k) => [k, { title: `일 ${k}` }])));
  await syncReminders(many, g.run, NOW);
  for (const k of ["A", "B", "C", "D"]) g.state.delete(k);
  const old: EkRun = async (args) => { const x = await g.run(args); delete x.linked; return x; };
  assert.equal((await syncReminders(many, old, NOW)).trashed, 0);
  assert.equal((await syncReminders(many, g.run, NOW)).trashed, 0);
  assert.equal(many.openTodos().length, 5);
});

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
  // 우사기 휴지통 → 미리알림은 끝냄으로만(지우지 않음), 되살리면 다시 열림 / 미리알림에서 지움 → 우사기 휴지통
  store.trashTodo("reminder:R1");
  f.state.delete("R2");
  const c = await syncReminders(store, f.run, NOW, true);
  assert.deepEqual([f.state.has("R1"), f.state.get("R1").completed], [true, true]);
  assert.equal(c.trashed, 1);
  assert.ok(store.trashedTodo("reminder:R2"));
  store.restoreTodo("reminder:R1");
  await syncReminders(store, f.run, NOW, true);
  assert.equal(f.state.get("R1").completed, false);
  // 영구 삭제: 우사기가 넣은 것만 미리알림에서 지우고, 미리알림에서 온 것은 남긴다
  store.trashTodo("reminder:R1"); store.trashTodo(mine.id);
  await syncReminders(store, f.run, NOW, true);
  store.purgeTodo("reminder:R1"); store.purgeTodo(mine.id);
  await syncReminders(store, f.run, NOW, true);
  assert.deepEqual([f.state.has("R1"), f.state.has("N1")], [true, false]);
  assert.equal(store.db.prepare("SELECT count(*) n FROM reminder_links").get()!.n, 0);
});

test("syncReminders 양방향: 마감은 바뀐 쪽, 긴 제목은 잘리지 않고, 끝낸 짝이 사라지면 조용히 놓고, 합쳐진 미리알림은 그 할 일과 잇는다", async () => {
  const store = new Store(":memory:");
  const f = fakeReminders();
  const long = "가".repeat(230);
  const a = store.addTodo({ title: long });
  const b = store.addTodo({ title: "세미나 발표" });
  await syncReminders(store, f.run, NOW, true);
  await syncReminders(store, f.run, NOW, true);
  assert.equal(store.getTodo(a.id)!.title, long, "200자 넘는 제목을 미리알림 쪽으로 자르지 않는다");
  assert.ok(!store.getTodo(a.id)!.userEdited?.includes("title"));
  // 우사기 쪽 마감(원본이 바꿈) → 미리알림, 미리알림 쪽 마감 → 우사기
  const d1 = new Date(2026, 9, 22, 0, 0).toISOString(), d2 = new Date(2026, 9, 23, 15, 30).toISOString();
  store.setTodoDue(a.id, d1);
  await syncReminders(store, f.run, NOW, true);
  assert.equal(Date.parse(f.state.get("N1").due), Date.parse(d1));
  f.state.get("N2").due = d2;
  await syncReminders(store, f.run, NOW, true);
  assert.equal(Date.parse(store.getTodo(b.id)!.due!), Date.parse(d2));
  assert.equal(Date.parse(f.state.get("N1").due), Date.parse(d1), "핑퐁 없음");
  // 끝낸 짝: 미리알림에서 끝낸 것을 정리해도 우사기 할 일은 휴지통으로 가지 않는다
  store.editTodo(b.id, { status: "done" });
  await syncReminders(store, f.run, NOW, true);
  f.state.delete("N2");
  const r = await syncReminders(store, f.run, NOW, true);
  assert.equal(r.trashed, 0);
  assert.equal(store.getTodo(b.id)!.status, "done");
  // 휴대폰에서 같은 제목으로 만든 미리알림 → 열린 할 일로 합쳐지고 그 할 일과 이어진다(또 넣지 않음)
  const c = store.addTodo({ title: "장보기" });
  f.state.set("P1", { id: "P1", title: "장보기", list: "개인", completed: false });
  const before = f.state.size;
  await syncReminders(store, f.run, NOW, true);
  assert.equal(f.state.size, before, "합쳐진 할 일을 미리알림에 또 넣지 않는다");
  assert.equal((store.db.prepare("SELECT rid FROM reminder_links WHERE todo_id = ?").get(c.id) as any).rid, "P1");
  // 그렇게 이어진 미리알림은 사용자 것이라 할 일을 영구 삭제해도 지우지 않는다(끝냄까지만)
  store.trashTodo(c.id);
  await syncReminders(store, f.run, NOW, true);
  store.purgeTodo(c.id);
  await syncReminders(store, f.run, NOW, true);
  assert.deepEqual([f.state.has("P1"), f.state.get("P1").completed], [true, true]);
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

test("syncReminders 양방향: linked 를 모르는 옛 도우미면 아무것도 지우지 않고 멈춘다", async () => {
  const store = new Store(":memory:");
  const f = fakeReminders({ R1: { title: "논문" } });
  await syncReminders(store, f.run, NOW, true);
  const old: EkRun = async (args) => { const r = await f.run(args); delete r.linked; return r; };
  const r = await syncReminders(store, old, NOW, true);
  assert.equal(r.ok, false);
  assert.ok(store.getTodo("reminder:R1"));
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

test("pushDone 한 방향: 미리알림에서 온 할 일을 체크·다시 열면 그 미리알림에 바로, 그 뒤 미리알림에서 끝낸 것도 따르고, 우사기 할 일은 쓰지 않는다", async () => {
  const store = new Store(":memory:");
  const f = fakeReminders({ R1: { title: "논문 그림 3" } });
  await syncReminders(store, f.run, NOW);
  const mine = store.addTodo({ title: "보고서 쓰기" });
  store.editTodo("reminder:R1", { status: "done" });
  assert.equal(await pushDone(store, "reminder:R1", false, f.run), true);
  assert.equal(f.state.get("R1").completed, true);
  const a = await syncReminders(store, f.run, NOW);
  assert.deepEqual([a.done, a.wrote, store.getTodo("reminder:R1")!.status], [0, 0, "done"], "끝낸 미리알림을 다시 끝내지 않는다");
  store.editTodo("reminder:R1", { status: "open" });
  assert.equal(await pushDone(store, "reminder:R1", false, f.run), true);
  assert.equal(f.state.get("R1").completed, false);
  // 우사기에서 체크했다 푼 뒤(사용자가 정한 상태) 미리알림에서 끝내도 따라간다. 끝낸 시각이 마지막으로 고친 때보다 앞이면(맞추는 사이 다시 엶) 그대로
  f.state.get("R1").completed = true;
  f.state.get("R1").completedAt = new Date(Date.now() - 60e3).toISOString().replace(/\.\d+Z$/, "Z");
  assert.deepEqual([(await syncReminders(store, f.run, NOW)).done, store.getTodo("reminder:R1")!.status], [0, "open"]);
  f.state.get("R1").completedAt = new Date(Date.now() + 1e3).toISOString().replace(/\.\d+Z$/, "Z");
  const c = await syncReminders(store, f.run, NOW);
  assert.deepEqual([c.done, store.getTodo("reminder:R1")!.status, store.getTodo("reminder:R1")!.doneBy], [1, "done", "user"]);
  store.editTodo(mine.id, { status: "done" });
  f.calls.length = 0;
  assert.equal(await pushDone(store, mine.id, false, f.run), false);
  assert.equal(await pushDone(store, "nope", false, f.run), false);
  assert.deepEqual(f.calls, [], "이어진 미리알림이 없으면 도우미를 부르지 않는다");
  f.state.delete("R1");
  assert.equal(await pushDone(store, "reminder:R1", false, f.run), false, "지워진 미리알림");
});

test("pushDone 양방향: 짝의 미리알림(우사기가 넣은 것·id 가 바뀐 것)에 쓰고, 다음 맞추기는 쓰지 않는다", async () => {
  const store = new Store(":memory:");
  const f = fakeReminders({ R1: { title: "논문 그림 3" } });
  const mine = store.addTodo({ title: "보고서 쓰기" });
  assert.equal(await pushDone(store, mine.id, true, f.run), false, "짝이 생기기 전");
  await syncReminders(store, f.run, NOW, true);
  store.editTodo(mine.id, { status: "done" });
  assert.equal(await pushDone(store, mine.id, true, f.run), true);
  assert.equal(f.state.get("N1").completed, true);
  // iCloud 전체 동기화로 id 가 바뀌어 다시 이은 미리알림
  f.state.set("R9", { ...f.state.get("R1"), id: "R9" }); f.state.delete("R1");
  await syncReminders(store, f.run, NOW, true);
  store.editTodo("reminder:R1", { status: "done" });
  assert.equal(await pushDone(store, "reminder:R1", true, f.run), true);
  assert.equal(f.state.get("R9").completed, true);
  f.calls.length = 0;
  const b = await syncReminders(store, f.run, NOW, true);
  assert.deepEqual([b.ok, b.wrote, b.edited], [true, 0, 0]);
});

test("pushDone 반복 미리알림: 끝내도 열린 채 다음 회차면 할 일도 다시 열고 마감·메모를 옮긴다. 쓰기 실패·옛 도우미·반복 아님은 그대로", async () => {
  const store = new Store(":memory:");
  const due = new Date(2026, 9, 17, 9).toISOString(), next = new Date(2026, 9, 18, 9).toISOString();
  const f = fakeReminders({ R1: { title: "약 먹기", due, dueHasTime: true, repeats: true }, R2: { title: "논문 그림 3" } });
  await syncReminders(store, f.run, NOW);
  store.editTodo("reminder:R1", { status: "done" });
  assert.equal(await pushDone(store, "reminder:R1", false, async () => ({ ok: false, error: "not-granted" })), false);
  const old: EkRun = async (args) => (args[0] === "write" ? { ok: true, results: [{ ok: true }] } : f.run(args)); // set 결과에 모습을 안 주는 옛 도우미
  assert.equal(await pushDone(store, "reminder:R1", false, old), true);
  assert.equal(store.getTodo("reminder:R1")!.status, "done");
  assert.equal(await pushDone(store, "reminder:R1", false, f.run), "reopened");
  const t = store.getTodo("reminder:R1")!;
  assert.deepEqual([t.status, t.due, t.note], ["open", next, "미리알림 「개인」 · 마감 10월 18일 09:00"]);
  assert.deepEqual([f.state.get("R1").completed, f.state.get("R1").due], [false, next]);
  const a = await syncReminders(store, f.run, NOW);
  assert.deepEqual([a.done, a.wrote, store.getTodo("reminder:R1")!.status, store.openTodos().length], [0, 0, "open", 2], "끝낸 사본은 할 일이 되지 않는다");
  store.editTodo("reminder:R2", { status: "done" });
  assert.equal(await pushDone(store, "reminder:R2", false, f.run), true);
  assert.equal(store.getTodo("reminder:R2")!.status, "done", "반복이 아니면 끝낸 채");
  store.editTodo("reminder:R1", { status: "open" });
  assert.equal(await pushDone(store, "reminder:R1", false, f.run), true, "다시 열면 그대로 씀");
});

test("pushDone 반복 미리알림 양방향: 다시 연 할 일을 다음 맞추기가 또 끝내지 않는다(다음 회차를 건너뛰지 않게)", async () => {
  const store = new Store(":memory:");
  const f = fakeReminders({ R1: { title: "약 먹기", due: new Date(2026, 9, 17, 9).toISOString(), dueHasTime: true, repeats: true } });
  await syncReminders(store, f.run, NOW, true);
  store.editTodo("reminder:R1", { status: "done" });
  assert.equal(await pushDone(store, "reminder:R1", true, f.run), "reopened");
  f.calls.length = 0;
  const b = await syncReminders(store, f.run, NOW, true);
  assert.deepEqual([b.ok, b.wrote, f.writes(), store.getTodo("reminder:R1")!.status], [true, 0, [], "open"]);
  assert.equal(f.state.get("R1").due, new Date(2026, 9, 18, 9).toISOString());
});

test("watchStore: 도우미가 바뀜을 알리면 onChange, 끄면 onExit, 도우미가 없어도 onExit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-ekwatch-"));
  const helper = join(dir, "usagi-eventkit");
  writeFileSync(helper, '#!/bin/sh\n[ "$1" = watch ] || exit 2\necho \'{"changed":true}\'\ncat > /dev/null\n');
  chmodSync(helper, 0o755);
  const prev = process.env.CY_AGENT_EVENTKIT;
  try {
    process.env.CY_AGENT_EVENTKIT = helper;
    let changed = 0;
    let exited!: () => void;
    const gone = new Promise<void>((r) => { exited = r; });
    const stop = watchStore(() => changed++, () => exited());
    while (!changed) await new Promise((r) => setTimeout(r, 10));
    stop();
    await gone;
    assert.equal(changed, 1);
    process.env.CY_AGENT_EVENTKIT = join(dir, "없음");
    await new Promise<void>((r) => watchStore(() => assert.fail("바뀜 없음"), r));
  } finally {
    if (prev === undefined) delete process.env.CY_AGENT_EVENTKIT; else process.env.CY_AGENT_EVENTKIT = prev;
    rmSync(dir, { recursive: true, force: true });
  }
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

test("addReminderTodo(#316): 고른 목록(id)에 미리알림을 만들고(시각이 있으면 그 시각 알림) 미리알림 할 일로, 고른 묶음·오늘은 맞추기가 안 덮음, 목록, 실패는 오류", async () => {
  const store = new Store(":memory:");
  const f = fakeReminders();
  const due = new Date(2026, 9, 18, 15).toISOString(); // NOW(10/17 12시) 다음 날 15시
  const t = await addReminderTodo(store, { title: "선형대수 과제", listId: "L1", due, priority: 2 }, f.run, NOW);
  assert.deepEqual(f.writes()[0], [{ op: "add", listId: "L1", title: "선형대수 과제", due, dueHasTime: true, alarm: true }]);
  assert.deepEqual([t.id, t.source, t.priority, t.due, t.userEdited], ["reminder:N1", "reminders", 2, due, []]);
  assert.match(t.note!, /^미리알림 「공부」 · 마감 10월 18일 15:00/);
  const day = new Date(2026, 9, 18).toISOString();
  const u = await addReminderTodo(store, { title: "단어 외우기", listId: "L1", due: day, priority: 1, today: true }, f.run, NOW);
  assert.deepEqual(f.writes()[1], [{ op: "add", listId: "L1", title: "단어 외우기", due: day, dueHasTime: false }], "날짜만이면 알림 없이(미리알림의 하루 알림 시각을 따름)");
  assert.deepEqual([u.priority, u.userEdited, !!u.today], [1, ["priority"], true]);
  const plain = await addReminderTodo(store, { title: "복습", listId: "L1" }, f.run, NOW);
  assert.deepEqual([plain.priority, plain.due], [3, undefined]);
  const lists = [{ id: "L0", title: "개인", source: "iCloud", color: "#FF9500" }, { id: "L1", title: "공부", source: "iCloud", color: "" }];
  const withLists: EkRun = async (a) => (a[0] === "reminders" ? { ...(await f.run(a)), lists: [lists[0], { ...lists[1], color: "red; x" }, { id: "L9", title: TWO_WAY_LIST, source: "iCloud" }, "옛 모양", { id: "L8" }] } : f.run(a));
  const r = await syncReminders(store, withLists, NOW);
  assert.deepEqual([r.added, r.lists], [0, lists]);
  assert.equal(store.getTodo(u.id)!.priority, 1, "고른 묶음은 맞추기가 덮지 않는다");
  assert.equal(store.openTodos().filter((x) => x.source === "reminders").length, 3);
  await assert.rejects(addReminderTodo(store, { title: "x", listId: "L1" }, async () => ({ ok: false, error: "not-granted" }), NOW), /권한/);
  await assert.rejects(addReminderTodo(store, { title: "x", listId: "gone" }, async () => ({ ok: true, results: [{ ok: false, error: "그 미리알림 목록을 찾지 못했어요" }] }), NOW), /찾지 못했어요/);
});
