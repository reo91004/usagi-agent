import { test } from "node:test";
import assert from "node:assert/strict";
import { duePriority, parseNew, parsePatch, sameAsEvent } from "./todos.ts";
import { Store } from "./store.ts";

test("parsePatch description: 문자열·null, 다듬고 빈 값은 지우기, 4000자 초과·다른 타입은 오류", async () => {
  const { parsePatch } = await import("./todos.ts");
  assert.deepEqual(parsePatch({ description: "  줄1\r\n줄2  " }), { ok: true, value: { description: "줄1\n줄2" } });
  assert.deepEqual(parsePatch({ description: "   " }), { ok: true, value: { description: null } });
  assert.deepEqual(parsePatch({ description: null }), { ok: true, value: { description: null } });
  assert.equal(parsePatch({ description: "x".repeat(50000) }).ok, true);
  assert.equal(parsePatch({ description: 3 }).ok, false);
});

test("(진행중) 토글: doing 은 boolean|null, 저장·지우기, 사용자 수정 표시 안 함", () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "t1", title: "일", source: "user", priority: 2 });
  assert.deepEqual(parsePatch({ doing: true }), { ok: true, value: { doing: true } });
  assert.equal(parsePatch({ doing: "y" }).ok, false);
  assert.equal(s.editTodo("t1", { doing: true })!.doing, true);
  assert.deepEqual(s.getTodo("t1")!.userEdited, []);
  assert.equal(s.editTodo("t1", { doing: false })!.doing, false);
  assert.equal(s.editTodo("t1", { doing: null })!.doing, undefined);
});

test("sameAsEvent: 공백·기호, 앞의 오늘·내일, 끝의 수업·학원·참석 같은 말을 빼고 일정 제목과 비교(#293)", () => {
  const ev = ["디지털논리회로", "피아노 학원", "이동, 오송-동대구", "회의"];
  assert.equal(sameAsEvent("디지털논리회로 수업", ev), true);
  assert.equal(sameAsEvent("피아노 학원", ev), true);
  assert.equal(sameAsEvent("오늘 피아노 학원 참석", ev), true);
  assert.equal(sameAsEvent("이동(오송-동대구)", ev), true);
  assert.equal(sameAsEvent("회의", ev), true);
  assert.equal(sameAsEvent("내일 이동(오송-동대구) 및 피부과 일정 준비", ev), false); // 할 일이 붙으면 다르다
  assert.equal(sameAsEvent("피아노 학원 준비물 챙기기", ev), false);
  assert.equal(sameAsEvent("세미나", ev), false); // 일반 말만 남으면 그 말끼리만 같다
  assert.equal(sameAsEvent("피아노 학원", []), false);
});

test("마감(due, #316): 검증, 날짜로 묶음, 고치면 다시 묶음, 다가오면 올리기만(옮긴 것·언젠가·미리알림은 그대로)", () => {
  const at = (d: number, h = 0) => new Date(2026, 9, d, h); // 기준 10/26(월)
  const NOW = at(26, 9);
  assert.equal(duePriority(at(26, 23).toISOString(), NOW), 1);
  assert.equal(duePriority(at(20).toISOString(), NOW), 1); // 지난 것
  assert.equal(duePriority(at(27).toISOString(), NOW), 2);
  assert.equal(duePriority(at(32, 23).toISOString(), NOW), 2); // 11/1 = 6일 뒤까지 이번 주
  assert.equal(duePriority(at(33).toISOString(), NOW), 3);

  const iso = at(30, 16).toISOString();
  assert.deepEqual(parsePatch({ due: iso }), { ok: true, value: { due: iso } });
  assert.deepEqual(parsePatch({ due: "" }), { ok: true, value: { due: null } });
  assert.equal(parsePatch({ due: "내일" }).ok, false);
  assert.equal(parsePatch({ due: 3 }).ok, false);
  const far = new Date(Date.now() + 40 * 86400e3).toISOString();
  const n = parseNew({ title: "세금", due: far });
  assert.ok(n.ok && n.value.due === far && n.value.priority === 3); // 묶음을 안 주면 마감으로
  assert.ok(parseNew({ title: "x" }).ok);
  const rl = parseNew({ title: "x", reminderList: " 6C1F-공부 " });
  assert.ok(rl.ok && rl.value.reminderList === "6C1F-공부");
  assert.equal(parseNew({ title: "x", reminderList: "" }).ok, false);
  assert.equal(parseNew({ title: "x", reminderList: 3 }).ok, false);
  assert.equal(parsePatch({ reminderList: "공부" }).ok, false); // 고치기에는 없다

  const s = new Store(":memory:");
  const auto = s.addTodo({ title: "보고서", due: far });
  assert.equal(auto.priority, 3);
  assert.equal(auto.due, far);
  assert.deepEqual(auto.userEdited, []);
  const picked = s.addTodo({ title: "발표", priority: 1, today: true, due: far }); // 날짜와 다른 묶음을 고름
  assert.deepEqual(picked.userEdited, ["priority"]);
  const later = s.addTodo({ title: "언젠가", priority: 4, due: far });
  s.upsertTodo({ id: "reminder:R", title: "미리알림", source: "reminders", priority: 3, due: far });

  const soon = new Date(Date.parse(far) - 2 * 86400e3);
  assert.equal(s.rebucketDue(soon), 1);
  assert.equal(s.getTodo(auto.id)!.priority, 2);
  assert.deepEqual(s.getTodo(auto.id)!.userEdited, []);
  assert.equal(s.getTodo(picked.id)!.priority, 1);
  assert.equal(s.getTodo(later.id)!.priority, 4);
  assert.equal(s.getTodo("reminder:R")!.priority, 3);
  assert.equal(s.rebucketDue(new Date(Date.parse(far) - 40 * 86400e3)), 0); // 내리지는 않는다

  const e = s.editTodo(auto.id, { due: far })!; // 마감을 고치면 그 날짜로(사용자 편집은 due 만)
  assert.equal(e.priority, 3);
  assert.deepEqual(e.userEdited, ["due"]);
  const cleared = s.editTodo(auto.id, { due: null })!;
  assert.equal(cleared.due, undefined);
  assert.equal(cleared.priority, 3);
});
