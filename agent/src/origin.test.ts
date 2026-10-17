// 작업 세션의 "원래 화면": run 마다 origin(대화·할 일 팝오버·제안) — 기록·물려받기·예전 기록 채우기,
// 호출 지점별 기록(채팅·호버·할 일 집어 들기·팝오버·제안), 세션 창에서 원래 대화로 이어 말하기(parentRunId),
// 팝오버 마지막 문답 다시 띄우기(GET /todos/:id/thread/last)
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { RunRegistry, cleanOrigin, inRunContext, asRoutine } from "./runs.ts";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { Agent } from "./core.ts";
import { Actions } from "./actions.ts";
import { loadConfig } from "./config.ts";
import type { Converse } from "./chat.ts";

// 채팅 제안이 쓸 레포: 레포 밖(압축 받은 소스 등)에서 돌려도 되게 임시 git 레포
const tmpRepo = (() => {
  const d = mkdtempSync(join(tmpdir(), "cy-origin-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: d });
  return realpathSync(d);
})();

const cfg = () => ({ ...loadConfig(), repoRoots: [], claudeProjectsDir: "/none", codexSessionsDir: "/none" });

test("runs: origin 기록·노출, 맥락·앞선 run 에서 물려받기, 정기 작업은 없음, 잘못된 모양은 버림", () => {
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const a = reg.startRun({ kind: "chat", title: "a", origin: { type: "thread", threadId: "t-1" } });
  assert.deepEqual(reg.summary(a.id)!.origin, { type: "thread", threadId: "t-1" });
  const b = inRunContext({ origin: { type: "todo", todoId: "mail:1", threadId: "t-2" } }, () => reg.startRun({ kind: "chat", title: "b" }));
  assert.deepEqual(reg.summary(b.id)!.origin, { type: "todo", todoId: "mail:1", threadId: "t-2" });
  const c = reg.startRun({ kind: "fix", title: "c", parentId: a.id }); // 이어서 한 run → 앞선 run 의 원래 화면
  assert.deepEqual(reg.summary(c.id)!.origin, { type: "thread", threadId: "t-1" });
  const d = asRoutine(() => inRunContext({ origin: { type: "thread", threadId: "t-1" } }, () => reg.startRun({ kind: "briefing", title: "d" })))();
  assert.equal(reg.summary(d.id)!.origin, undefined);
  const e = reg.startRun({ kind: "other", title: "e" });
  assert.equal(reg.summary(e.id)!.origin, undefined);
  assert.equal(reg.startRun({ kind: "chat", title: "f", origin: { type: "thread", threadId: "../x" } as any }) && reg.listRuns()[0].origin, undefined);
  assert.deepEqual(reg.getRun(b.id)!.run.origin, reg.summary(b.id)!.origin); // /runs/:id 와 /runs 같은 모양
  assert.ok(reg.listRuns().find((r) => r.id === b.id)!.origin);
  for (const bad of [null, "x", {}, { type: "thread" }, { type: "todo" }, { type: "todo", todoId: "" }, { type: "proposal", proposalId: "a b" }, { type: "nope", threadId: "t" }]) assert.equal(cleanOrigin(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(cleanOrigin({ type: "proposal", proposalId: "p1", threadId: "bad id", extra: 1 }), { type: "proposal", proposalId: "p1" });
});

test("runs: 예전 기록 채우기 — 채팅 ref=스레드, 수정 ref=제안(+그 대화), 확인한 실행 ref=카드(팝오버면 할 일). 모르는 ref·정기는 그대로", () => {
  const store = new Store(":memory:");
  new Actions(cfg(), store, { runs: new RunRegistry(new DatabaseSync(":memory:")) }); // pending_actions 표
  const chatT = store.createThread({ title: "대화" });
  const todoT = store.createThread({ title: "할 일: x", kind: "todo", todoId: "mail:1" });
  store.addProposal({ id: "p1", repo: "/r", title: "고치기", plan: "…", threadId: chatT.id });
  store.addProposal({ id: "p2", repo: "/r", title: "브리핑 제안", plan: "…" });
  const ins = store.db.prepare("INSERT INTO pending_actions (id, type, payload, summary, card, via, thread_id, created, expires, status) VALUES (?, 'calendar_respond', '{}', '', '{}', ?, ?, '', '', 'done')");
  ins.run("act1", "todo", todoT.id);
  ins.run("act2", "chat", chatT.id);
  const reg = new RunRegistry(store.db);
  const mk = (kind: any, ref: string, routine = false) => reg.startRun({ kind, title: kind, ref, routine }).id;
  const ids = { chat: mk("chat", chatT.id), chatGone: mk("chat", "gone-thread"), fix: mk("fix", "p1"), fix2: mk("fix", "p2"), a1: mk("action", "act1"), a2: mk("action", "act2"), routine: mk("chat", chatT.id, true) };
  store.db.exec("UPDATE runs SET origin = NULL"); // 예전 기록처럼
  reg.attach(store.db); // 데몬 재시작
  const o = (id: string) => reg.summary(id)!.origin;
  assert.deepEqual(o(ids.chat), { type: "thread", threadId: chatT.id });
  assert.equal(o(ids.chatGone), undefined);
  assert.deepEqual(o(ids.fix), { type: "proposal", proposalId: "p1", threadId: chatT.id });
  assert.deepEqual(o(ids.fix2), { type: "proposal", proposalId: "p2" });
  assert.deepEqual(o(ids.a1), { type: "todo", todoId: "mail:1", threadId: todoT.id });
  assert.deepEqual(o(ids.a2), { type: "thread", threadId: chatT.id });
  assert.equal(o(ids.routine), undefined);
  assert.equal(reg.backfillOrigins(), 0); // 두 번 돌아도 그대로
  // 대화·제안 표가 없는 DB(테스트용 메모리)에서도 괜찮다
  const bare = new RunRegistry(new DatabaseSync(":memory:"));
  bare.startRun({ kind: "chat", title: "x", ref: "t" });
  assert.equal(bare.backfillOrigins(), 0);
});

function setup(o: { converse?: Converse; runFix?: any } = {}) {
  const store = new Store(":memory:");
  const bus = new Bus();
  bus.setMood = () => {};
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  // 가짜 모델도 진짜처럼 run 하나를 띄운다(ask() 자리) — 맥락이 붙는지 본다
  const converse: Converse = o.converse ?? (async (_c, _s, _h, text) => { reg.startRun({ kind: "chat", title: `채팅: ${text}` }).end("done"); return { reply_md: `답:${text}`, bubble: "", show: null, proposals: [] }; });
  const agent = new Agent(cfg(), store, bus, undefined, { converse, git: async () => [], followUp: { runs: reg }, ...(o.runFix ? { runFix: o.runFix } : {}) });
  return { agent, store, bus, reg };
}
const lastRun = (reg: RunRegistry, title: string) => reg.listRuns({ limit: 200 }).find((r) => r.title === title)!;

test("호출 지점별 origin: 채팅·호버 → 그 스레드, 할 일 집어 든 채팅 → 그 할 일, 채팅 제안 → 그 대화", async () => {
  const s = setup();
  s.store.upsertTodo({ id: "mail:1", title: "견적 회신", source: "mail", priority: 2 });
  const c = s.agent.chat("안녕") as { threadId: string };
  const hv = s.agent.chat("호버", { kind: "hover" }) as { threadId: string };
  const tc = s.agent.chat("이거 뭐야", { todoId: "mail:1" }) as { threadId: string };
  await s.agent.chatIdle();
  assert.deepEqual(lastRun(s.reg, "채팅: 안녕").origin, { type: "thread", threadId: c.threadId });
  assert.deepEqual(lastRun(s.reg, "채팅: 호버").origin, { type: "thread", threadId: hv.threadId });
  assert.deepEqual(lastRun(s.reg, "채팅: 이거 뭐야").origin, { type: "todo", todoId: "mail:1", threadId: tc.threadId });
  // 채팅에서 나온 제안은 그 대화를 기억한다(수정 run 의 원래 화면)
  // 채팅 제안은 바로 실행된다 — 진짜 수정 run 이 돌지 않게 가짜
  const fixed: any[] = [];
  const s2 = setup({
    converse: async () => ({ reply_md: "작업 시작했어요", bubble: "", show: null, proposals: [{ repo: tmpRepo, title: "고치기", plan: "…" }] }),
    runFix: async (_c: unknown, p: any) => { fixed.push(p); return { ok: false, summary: "가짜", log: [] }; },
  });
  (s2.agent as any).cfg.repoRoots = [tmpRepo];
  const pc = s2.agent.chat("고쳐줘") as { threadId: string };
  await s2.agent.chatIdle();
  await s2.agent.fixIdle();
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].threadId, pc.threadId);
  assert.equal(s2.store.proposal(fixed[0].id)!.threadId, pc.threadId);
  // 맥락이 새지 않는다: 큐 밖에서 시작한 run 은 origin 없음
  assert.equal(s.reg.startRun({ kind: "other", title: "밖" }) && lastRun(s.reg, "밖").origin, undefined);
});

test("세션 창 → 원래 대화로 이어 말하기(parentRunId): 같은 스레드로, 새 채팅 run 은 그 run 에 연결, 물은 말·답이 그 run 기록에도", async () => {
  const s = setup();
  s.store.upsertTodo({ id: "mail:1", title: "견적 회신", source: "mail", priority: 2 });
  const first = s.agent.chat("그거 누가 줬어?", { todoId: "mail:1" }) as { threadId: string };
  await s.agent.chatIdle();
  const parent = lastRun(s.reg, "채팅: 그거 누가 줬어?");
  const sent = s.agent.chat("더 알려줘", { threadId: first.threadId, todoId: "mail:1", parentRunId: parent.id }) as { chatId: string; threadId: string };
  assert.equal(sent.threadId, first.threadId);
  await s.agent.chatIdle();
  const child = lastRun(s.reg, "채팅: 더 알려줘");
  assert.equal(child.parentId, parent.id);
  assert.deepEqual(child.origin, { type: "todo", todoId: "mail:1", threadId: first.threadId });
  assert.deepEqual(s.reg.summary(parent.id)!.childIds, [child.id]);
  const evs = s.reg.getRun(parent.id)!.events.filter((e) => e.followUp);
  assert.deepEqual(evs.map((e) => [e.type, e.text]), [["user", "더 알려줘"], ["assistant", "답:더 알려줘"]]);
  const msgs = s.agent.threadMessages(first.threadId)!.messages.map((m) => m.text);
  assert.deepEqual(msgs.slice(-2), ["더 알려줘", "답:더 알려줘"]); // 원래 대화에도
  // 없는 run 이면 그냥 보통 채팅
  const plain = s.agent.chat("그냥", { threadId: first.threadId, parentRunId: "nope" });
  assert.ok("chatId" in plain);
  await s.agent.chatIdle();
  assert.equal(lastRun(s.reg, "채팅: 그냥").parentId, undefined);
});

test("HTTP: GET /todos/:id/thread/last — 할 일·스레드 id, 없는/휴지통 할 일은 404+스레드", async () => {
  const s = setup();
  s.store.upsertTodo({ id: "mail:1", title: "견적 회신", source: "mail", priority: 2 });
  await s.bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true,
    chat: (text, o) => s.agent.chat(text, o ?? {}),
    todoLastAsk: (id) => s.agent.lastAsk(id), todoDelete: (id) => s.agent.deleteTodo(id),
    todoEdit: (id, p) => s.agent.editTodo(id, p),
  });
  const base = `http://127.0.0.1:${(s.bus.server!.address() as any).port}`;
  const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() as any }; };
  const post = async (path: string, body: unknown) => { const r = await fetch(base + path, { method: "POST", headers: { "x-cy-agent": "1", "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
  try {
    // 대화 전 → threadId null
    const none = await get("/todos/mail:1/thread/last");
    assert.equal(none.status, 200);
    assert.deepEqual([none.body.threadId, none.body.todo], [null, { id: "mail:1", title: "견적 회신", status: "open", priority: 2 }]);
    // 그 할 일을 집어 든 채팅 뒤 → 그 스레드
    const c = s.agent.chat("이거 뭐야", { todoId: "mail:1" }) as { threadId: string };
    await s.agent.chatIdle();
    assert.equal((await get("/todos/mail:1/thread/last")).body.threadId, c.threadId);
    // 휴지통 → 404 + 그 할 일의 스레드(채팅 탭으로 대신 연다)
    assert.equal((await post("/todos/mail:1/delete", {})).status, 200);
    const gone = await get("/todos/mail:1/thread/last");
    assert.equal(gone.status, 404);
    assert.deepEqual([gone.body.threadId, gone.body.trashed], [c.threadId, true]);
    const nope = await get("/todos/nope/thread/last");
    assert.deepEqual([nope.status, nope.body.trashed, nope.body.threadId], [404, false, undefined]);
    // /chat parentRunId 모양 검사
    for (const bad of [3, "../x", ""]) assert.equal((await post("/chat", { text: "x", parentRunId: bad })).status, 400, String(bad));
  } finally {
    s.bus.close();
  }
});
