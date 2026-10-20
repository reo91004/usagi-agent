import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePatch, sameAsEvent } from "./todos.ts";
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
