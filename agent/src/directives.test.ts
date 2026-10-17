import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { slackPlain, directiveCandidates, directivesSince, directivesView, directiveTodo, formatDirectives, markDirective, okSlackUserId } from "./directives.ts";
import { validatePatch } from "./settings.ts";
import { loadConfig } from "./config.ts";
import { Bus } from "./bus.ts";

const NOW = new Date("2026-10-17T03:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3600e3).toISOString();
function fixture() {
  const s = new Store(":memory:");
  s.db.exec("CREATE TABLE IF NOT EXISTS slack_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  s.db.prepare("INSERT INTO slack_meta VALUES ('teamUrl', 'https://lab.slack.com')").run();
  s.upsertNode("person:UPROF", "person", "김교수", { slackId: "UPROF" });
  s.upsertNode("channel:D1", "channel", "김교수", { isDM: true });
  s.upsertNode("channel:C1", "channel", "lab-general", {});
  const msg = (id: string, p: Record<string, unknown>, h: number) => s.upsertNode(id, "message", "x", p, ago(h));
  msg("message:D1:1.1", { channel: "D1", ts: "1.1", text: "논문 그림 3 축 라벨 고쳐 주세요\n그리고 표도", author: "UPROF", authorName: "김교수", isDM: true }, 1);
  msg("message:D1:1.2", { channel: "D1", ts: "1.2", text: "넵 :+1:", author: "UPROF", authorName: "김교수", isDM: true }, 0.9); // 맞장구
  msg("message:C1:2.1", { channel: "C1", ts: "2.1", thread_ts: "2.0", text: "<@UME> 이번 주 실험 결과 공유해 주세요", author: "UPROF", authorName: "김교수", mentionsMe: true }, 2);
  msg("message:C1:2.2", { channel: "C1", ts: "2.2", text: "모두 금요일 세미나 준비", author: "UPROF", authorName: "김교수" }, 2); // 멘션 아님
  msg("message:D2:3.1", { channel: "D2", ts: "3.1", text: "점심 먹어요", author: "UFRIEND", authorName: "친구", isDM: true }, 3);
  msg("message:D2:3.2", { channel: "D2", ts: "3.2", text: "점심 뭐 먹지", author: "UFRIEND", authorName: "친구", isDM: true }, 3.5);
  msg("message:D1:9.9", { channel: "D1", ts: "9.9", text: "내 답장", author: "UME", authorName: "나", isDM: true, fromMe: true }, 0.5);
  msg("message:D3:4.1", { channel: "D3", ts: "4.1", text: "알림 봇", author: "UBOT", authorName: "봇", isDM: true, bot: true }, 1);
  return s;
}

test("directivesSince: 지시자의 DM·멘션만, 맞장구·내 글은 빼고, 링크·상태", () => {
  const s = fixture();
  assert.deepEqual(directivesSince(s, [], ago(48)), []);
  const ds = directivesSince(s, ["UPROF"], ago(48));
  assert.deepEqual(ds.map((d) => [d.id, d.isDM, d.channelLabel, d.state]), [["message:D1:1.1", true, "김교수", "open"], ["message:C1:2.1", false, "lab-general", "open"]]);
  assert.equal(ds[0].permalink, "https://lab.slack.com/archives/D1/p11");
  assert.equal(ds[1].permalink, "https://lab.slack.com/archives/C1/p21?thread_ts=2.0&cid=C1");
  markDirective(s.db, "message:D1:1.1", "todo", "user:1");
  markDirective(s.db, "message:C1:2.1", "dismissed");
  assert.deepEqual(directivesSince(s, ["UPROF"], ago(48)).map((d) => [d.state, d.todoId]), [["todo", "user:1"], ["dismissed", undefined]]);
  assert.deepEqual(directivesSince(s, ["UPROF"], ago(48), { state: "open" }), []);
  assert.match(formatDirectives(directivesSince(s, ["UPROF"], ago(48))), /김교수 DM \(할 일로 넣음\): 논문 그림 3 축 라벨 고쳐 주세요 그리고 표도 <https/);
  assert.equal(directivesSince(new Store(":memory:"), ["UPROF"], ago(48)).length, 0); // 수집 전
});

test("directiveTodo·directiveCandidates·directivesView", () => {
  const s = fixture();
  const [d] = directivesSince(s, ["UPROF"], ago(48));
  assert.deepEqual(directiveTodo(d), { title: "논문 그림 3 축 라벨 고쳐 주세요", priority: 2, note: "김교수 지시(DM): 논문 그림 3 축 라벨 고쳐 주세요 그리고 표도", link: "https://lab.slack.com/archives/D1/p11", source: "slack" });
  assert.deepEqual(directiveCandidates(s, ago(24 * 30)).map((c) => [c.id, c.name, c.count]), [["UFRIEND", "친구", 2], ["UPROF", "김교수", 2]]); // 많이 보낸 순, 같으면 id 순
  assert.ok(!directiveCandidates(s, ago(24 * 30)).some((c) => c.id === "UBOT" || c.id === "UME"));
  const v = directivesView(s, ["UPROF"], NOW);
  assert.deepEqual(v.from, [{ id: "UPROF", name: "김교수" }]);
  assert.deepEqual(v.candidates.map((c) => c.id), ["UFRIEND"]);
  assert.equal(v.open.length, 2);
});

test("설정 directiveFrom: Slack 사용자 id 목록만", () => {
  const cfg = loadConfig();
  assert.deepEqual(validatePatch({ directiveFrom: ["UPROF", "UPROF", "W12345"] }, cfg).directiveFrom, ["UPROF", "W12345"]);
  for (const bad of [["prof"], "UPROF", ["U1"], Array(21).fill("UABCDE")]) assert.throws(() => validatePatch({ directiveFrom: bad }, cfg), /directiveFrom/);
  assert.ok(okSlackUserId("U0123ABCD") && !okSlackUserId("u0123"));
});

test("HTTP: POST /directives/<id>/todo|dismiss 는 헤더 필수, 모르는 지시는 404", async () => {
  const bus = new Bus();
  const got: unknown[] = [];
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c",
    directiveDecide: (id, decision) => { got.push([id, decision]); return id === "message:D1:1.1" ? { ok: true } : { ok: false }; },
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (p: string, headers: Record<string, string> = { "x-cy-agent": "1" }) => fetch(`${base}${p}`, { method: "POST", headers });
  try {
    assert.equal((await post("/directives/message:D1:1.1/todo", {})).status, 403);
    assert.equal((await post("/directives/message:D1:1.1/todo")).status, 200);
    assert.equal((await post("/directives/message:D1:1.1/dismiss")).status, 200);
    assert.equal((await post("/directives/message:X:9/todo")).status, 404);
    assert.equal((await post("/directives/../todo")).status, 404);
    assert.deepEqual(got, [["message:D1:1.1", "todo"], ["message:D1:1.1", "dismiss"], ["message:X:9", "todo"]]);
  } finally {
    bus.close();
  }
});

test("slackPlain: 멘션·채널·링크·엔티티를 읽는 글로", () => {
  const name = (id: string) => ({ UME: "나", UPROF: "김교수" } as Record<string, string>)[id] ?? id;
  assert.equal(slackPlain("<@UME> <#C1|lab> 보고 <https://arxiv.org/abs/1|논문> 과 <https://x.y> &lt;표&gt; &amp; <!here>", name), "@나 #lab 보고 논문 과 https://x.y <표> & @here");
});
